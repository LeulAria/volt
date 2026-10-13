/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CodeActionTriggerType } from '../../../../editor/common/languages.js';
import { ITextModel, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { applyCodeAction, ApplyCodeActionReason, getCodeActions } from '../../../../editor/contrib/codeAction/browser/codeAction.js';
import { CodeActionKind, CodeActionTriggerSource } from '../../../../editor/contrib/codeAction/common/types.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';

const TYPESCRIPT_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const PYTHON_LANGUAGES = new Set(['python']);
/** TypeScript's "Cannot find name", "...namespace", "...Did you mean" and "No value exists in scope for the shorthand property". */
const TYPESCRIPT_UNRESOLVED = new Set(['2304', '2503', '2552', '18004']);
/**
 * Quick fixes that add an import, by title: TypeScript's "Add import from" / "Update import from"
 * (and older "Import 'x' from module"), Pylance's and Pyright's `Add "import x"` / `Add "from x import y"`.
 */
const IMPORT_FIX = /^(Add|Update) import from\b|^Import '|existing import declaration|^Add "(import|from) /;
/** How long after the suggestion is taken the language server may still report what it left undefined. */
const WATCH_MS = 6_000;

/**
 * Settings > Tab > Imports: a taken suggestion that uses a name the file does not import yet
 * gets the import, as Cursor Tab does. The language server says which names are undefined and
 * how to import them; Volt applies its fix only when there is exactly one, so it never guesses
 * between two modules exporting the same name.
 */
export class TabAutoImports extends Disposable {

	private readonly sessions = new Set<DisposableStore>();

	constructor(
		@IVoltPredictionService private readonly predictionService: IVoltPredictionService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const session of this.sessions) {
				session.dispose();
			}
		}));
	}

	/** `text` was just inserted at `start` by a taken suggestion. */
	afterAccept(model: ITextModel, start: Position, text: string): void {
		const settings = this.predictionService.getSettings();
		const language = model.getLanguageId();
		const python = PYTHON_LANGUAGES.has(language);
		const enabled = TYPESCRIPT_LANGUAGES.has(language) ? settings.autoImport : python && settings.autoImportPython;
		if (!enabled || !/[A-Za-z_$]/.test(text) || model.isDisposed()) {
			return;
		}

		const session = new DisposableStore();
		this.sessions.add(session);
		const cts = session.add(new CancellationTokenSource());
		session.add(toDisposable(() => {
			cts.cancel();
			this.sessions.delete(session);
		}));
		// The inserted text, kept in place while imports above it move it down.
		const [decoration] = model.deltaDecorations([], [{ range: insertedRange(start, text), options: { description: 'volt-tab-auto-import', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
		session.add(toDisposable(() => {
			if (!model.isDisposed()) {
				model.deltaDecorations([decoration], []);
			}
		}));
		session.add(model.onWillDispose(() => session.dispose()));
		session.add(disposableTimeout(() => session.dispose(), WATCH_MS));

		const tried = new Set<string>();
		let running = false;
		let again = false;
		const check = async () => {
			if (running) {
				again = true;
				return;
			}
			running = true;
			try {
				do {
					again = false;
					const range = model.isDisposed() ? null : model.getDecorationRange(decoration);
					if (!range) {
						return;
					}
					for (const marker of this.markerService.read({ resource: model.uri, severities: MarkerSeverity.Error | MarkerSeverity.Warning })) {
						// By message (it names the name), so an import that moves the marker down does not make it new.
						const key = marker.message;
						if (cts.token.isCancellationRequested) {
							return;
						}
						if (tried.has(key) || !unresolvedName(marker, python) || !Range.areIntersectingOrTouching(range, markerRange(marker))) {
							continue;
						}
						tried.add(key);
						// One import at a time: the next one waits for diagnostics that know about this one.
						if (await this.importFor(model, marker, cts)) {
							break;
						}
					}
				} while (again && !cts.token.isCancellationRequested);
			} catch (err) {
				this.logService.trace(`[volt tab] auto import failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				running = false;
			}
		};
		session.add(this.markerService.onMarkerChanged(uris => {
			if (uris.some(uri => uri.toString() === model.uri.toString())) {
				void check();
			}
		}));
	}

	/** Applies the single import fix the language server offers for `marker`. True when one was applied. */
	private async importFor(model: ITextModel, marker: IMarker, cts: CancellationTokenSource): Promise<boolean> {
		const version = model.getVersionId();
		const set = await getCodeActions(this.languageFeaturesService.codeActionProvider, model, markerRange(marker), {
			type: CodeActionTriggerType.Invoke,
			triggerAction: CodeActionTriggerSource.QuickFix,
			filter: { include: CodeActionKind.QuickFix, includeSourceActions: false },
		}, Progress.None, cts.token);
		try {
			const fixes = new Map(set.validActions.filter(item => IMPORT_FIX.test(item.action.title)).map(item => [item.action.title, item]));
			// Two modules export the name: the user picks, not Volt.
			if (fixes.size !== 1 || cts.token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) {
				return false;
			}
			const [fix] = fixes.values();
			await this.instantiationService.invokeFunction(applyCodeAction, fix, ApplyCodeActionReason.FromCodeActions, {}, cts.token);
			return true;
		} finally {
			set.dispose();
		}
	}
}

function unresolvedName(marker: IMarker, python: boolean): boolean {
	const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
	if (python) {
		// Pyright and Pylance, pyflakes (F821), and their messages when the code is missing.
		return code === 'reportUndefinedVariable' || code === 'F821' || /is not defined|undefined name/i.test(marker.message);
	}
	return !!code && TYPESCRIPT_UNRESOLVED.has(code);
}

function markerRange(marker: IMarker): Range {
	return new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
}

function insertedRange(start: Position, text: string): Range {
	const lines = text.split(/\r\n|\r|\n/);
	const last = lines[lines.length - 1];
	return new Range(start.lineNumber, start.column, start.lineNumber + lines.length - 1, lines.length === 1 ? start.column + last.length : last.length + 1);
}
