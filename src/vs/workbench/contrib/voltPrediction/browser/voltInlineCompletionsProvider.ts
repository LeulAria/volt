/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { match as matchGlob } from '../../../../base/common/glob.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import {
	InlineCompletion,
	InlineCompletionContext,
	InlineCompletionDisplayLocationKind,
	InlineCompletionEndOfLifeReasonKind,
	InlineCompletionEndOfLifeReason,
	InlineCompletions,
	InlineCompletionsProvider,
	InlineCompletionTriggerKind,
} from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { IEditPrediction, IPredictedEdit, IPredictionContext, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { AGENT_COMPOSER_SCHEME } from '../../../services/voltRuntime/common/prediction/composerContext.js';
import { INLINE_EXCERPT_BUDGET } from '../../../services/voltRuntime/common/prediction/contextWindow.js';
import { shiftRangeAfterAccept } from '../../../services/voltRuntime/common/prediction/editGraph.js';
import { fromClipboard } from '../../../services/voltRuntime/common/prediction/localPredictor.js';
import { inlineEditForLine, postProcessInline } from '../../../services/voltRuntime/common/prediction/postProcess.js';
import { inlineWritingKind } from '../../../services/voltRuntime/common/prediction/predictionPrompt.js';
import { buildPredictionContext } from '../../../services/voltRuntime/browser/prediction/predictionContextBuilder.js';
import { resolveEditInModel, sortByPosition } from '../../../services/voltRuntime/browser/prediction/predictedEditResolver.js';
import { RecentEditsTracker } from '../../../services/voltRuntime/browser/prediction/recentEditsTracker.js';

type VoltItemKind = 'inline' | 'queued' | 'jump';

interface IVoltInlineItem extends InlineCompletion {
	readonly voltKind: VoltItemKind;
	readonly voltEdit?: IPredictedEdit;
}

interface IVoltCompletionList extends InlineCompletions<IVoltInlineItem> {
	readonly sourceModel: ITextModel;
	readonly sourcePosition: Position;
	readonly sourceVersionId: number;
}

/** After an accepted ghost text, this long: the next one is asked for while the current one shows. */
const TAB_STREAK_MS = 30_000;

/**
 * Editors that get no code ghost text: the agent composers have their own natural-language
 * provider, and output or debug views are not typed into.
 */
const NO_CODE_PREDICTION_SCHEMES = new Set<string>([AGENT_COMPOSER_SCHEME, Schemas.inMemory, 'output', 'debug']);

/**
 * VOLT's single inline-completion provider (D23). Serves three item shapes through the
 * stock editor UI:
 *  - ghost text at the cursor (`kind: inline`),
 *  - next-edit diffs (`isInlineEdit: true`) from the queued prediction chain,
 *  - cross-file jump items using the upstream `vscode.open` / `nextEditUri` convention.
 */
export class VoltInlineCompletionsProvider extends Disposable implements InlineCompletionsProvider<IVoltCompletionList> {

	readonly groupId = 'volt';
	readonly displayName = 'Volt';
	/**
	 * Short: typing into a suggestion is answered from the service's typed-through cache, and a
	 * request still running for an earlier keystroke is reused rather than cancelled.
	 */
	readonly debounceDelayMs = 75;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChangeInlineCompletions: Event<void> = this._onDidChange.event;

	/** Follow-up edits awaiting acceptance, ordered: current file first, then per-file. */
	private queue: IPredictedEdit[] = [];
	private chainCts: CancellationTokenSource | undefined;
	private clipboardCache = '';
	private clipboardReadAt = 0;
	private warned = false;
	/** The last accepted ghost text: while the user keeps pressing Tab, the next answer is fetched ahead. */
	private lastAccept: { readonly uri: string; readonly at: number } | undefined;

	constructor(
		private readonly recentEdits: RecentEditsTracker,
		@IVoltPredictionService private readonly predictionService: IVoltPredictionService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IModelService private readonly modelService: IModelService,
		@ILogService private readonly logService: ILogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		void this.refreshClipboard();
	}

	async provideInlineCompletions(model: ITextModel, position: Position, context: InlineCompletionContext, token: CancellationToken): Promise<IVoltCompletionList | undefined> {
		const settings = this.predictionService.getSettings();
		if (!settings.enabled) {
			return undefined;
		}
		// Any editor that is typed into: files, untitled, notebooks, settings, remote files.
		if (NO_CODE_PREDICTION_SCHEMES.has(model.uri.scheme)) {
			return undefined;
		}
		if (settings.disabledGlobs.some(pattern => matchGlob(pattern, model.uri.path))) {
			return undefined;
		}

		// 1. Queued chain edits win: no model call, instant.
		const queuedItems = this.serveQueue(model, position);
		if (queuedItems) {
			return this.list(model, position, queuedItems);
		}

		if (settings.mode === 'subtle' && context.triggerKind !== InlineCompletionTriggerKind.Explicit) {
			return undefined;
		}

		void this.refreshClipboard();
		const inlineOnly = context.includeInlineCompletions || !context.includeInlineEdits;
		const ctx = buildPredictionContext(model, position, this.markerService, this.modelService, this.recentEdits.list(), this.clipboardCache, inlineOnly ? INLINE_EXCERPT_BUDGET : undefined);

		if (!this.predictionService.resolveTabModelRef()) {
			this.warnOnce(localize(
				'voltPrediction.noModel',
				"Volt Tab has no model. Choose a prediction model in Volt Settings > Tab & Prediction, or a model in the composer."
			));
			return undefined;
		}

		// 2. Explicit NES trigger (inline edits requested without inline completions).
		if (!context.includeInlineCompletions && context.includeInlineEdits) {
			const prediction = await this.predictionService.predictNextEdit(ctx, token);
			if (!prediction || token.isCancellationRequested) {
				return undefined;
			}
			this.queue = [prediction.primary, ...prediction.next];
			const served = this.serveQueue(model, position);
			return served ? this.list(model, position, served) : undefined;
		}

		// 3. Ghost text. Instant when already known: typed through, or this spot answered before.
		const known = this.predictionService.peekInline(ctx);
		if (known) {
			return this.inlineList(model, position, known.primary.replacement);
		}
		// Otherwise wait for the model; the service times it out. Typing cancels the wait, and the
		// answer stays cached for this spot.
		const answer = this.predictionService.predictInline(ctx, CancellationToken.None);
		const prediction = await raceCancellation(answer, token);
		const failure = this.predictionService.consumeLastFailure();
		if (failure) {
			this.warnOnce(localize('voltPrediction.failed', "Volt Tab: {0}", failure));
		}
		if (token.isCancellationRequested || model.getVersionId() !== ctx.modelVersionId) {
			return undefined;
		}
		if (prediction) {
			return this.inlineList(model, position, prediction.primary.replacement);
		}
		// Nothing from the model: what the line starts of the clipboard.
		const local = clipboardSuggestion(ctx);
		return local ? this.inlineList(model, position, local) : undefined;
	}

	/** Builds the ghost-text item for `completion` at `position`, fitted to the rest of the line. */
	private inlineList(model: ITextModel, position: Position, completion: string): IVoltCompletionList {
		// Re-read the line: the cursor's line may have changed while the model was answering.
		const lineContent = model.getLineContent(position.lineNumber);
		const edit = inlineEditForLine(completion, lineContent.slice(0, position.column - 1), lineContent.slice(position.column - 1));
		const item: IVoltInlineItem = {
			voltKind: 'inline',
			insertText: edit.insertText,
			range: edit.replacesLineSuffix
				? new Range(position.lineNumber, position.column, position.lineNumber, model.getLineMaxColumn(position.lineNumber))
				: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
		};
		return this.list(model, position, [item]);
	}

	/**
	 * In a run of accepted suggestions (Tab, Tab, Tab), asks for the one after this suggestion while
	 * it is read, so it is there when Tab is pressed. Outside a run nothing is spent ahead.
	 */
	handleItemDidShow(completions: IVoltCompletionList, item: IVoltInlineItem): void {
		const model = completions.sourceModel;
		const streak = this.lastAccept?.uri === model.uri.toString() && Date.now() - this.lastAccept.at < TAB_STREAK_MS;
		const range = Range.lift(item.range);
		if (!streak || item.voltKind !== 'inline' || typeof item.insertText !== 'string' || !range?.isEmpty()
			|| model.isDisposed() || model.getVersionId() !== completions.sourceVersionId) {
			return;
		}
		const ctx = buildPredictionContext(model, range.getStartPosition(), this.markerService, this.modelService, this.recentEdits.list(), this.clipboardCache, INLINE_EXCERPT_BUDGET);
		const linePrefix = ctx.linePrefix + item.insertText;
		this.predictionService.prefetchInline({ ...ctx, prefix: ctx.prefix + item.insertText, linePrefix: linePrefix.slice(linePrefix.lastIndexOf('\n') + 1) });
	}

	handleEndOfLifetime(completions: IVoltCompletionList, item: IVoltInlineItem, reason: InlineCompletionEndOfLifeReason<IVoltInlineItem>): void {
		if (reason.kind === InlineCompletionEndOfLifeReasonKind.Accepted) {
			if (item.voltKind === 'inline') {
				this.lastAccept = { uri: completions.sourceModel.uri.toString(), at: Date.now() };
			}
			if (item.voltKind === 'queued' && item.voltEdit) {
				this.dropAccepted(item.voltEdit);
				// Retrigger so the next edit in the chain shows immediately.
				this._onDidChange.fire();
			} else if (item.voltKind === 'inline' && this.canChain()) {
				this.chainNextEdit(completions.sourceModel, completions.sourcePosition);
			}
			// 'jump': core ran vscode.open; the queue is served when NES retriggers there.
		} else if (reason.kind === InlineCompletionEndOfLifeReasonKind.Rejected && item.voltKind !== 'inline') {
			// The user dismissed the chain - do not keep nagging with stale edits.
			this.queue = [];
		}
	}

	disposeInlineCompletions(): void {
		// Nothing retained per list.
	}

	override dispose(): void {
		this.chainCts?.dispose(true);
		super.dispose();
	}

	private warnOnce(message: string): void {
		if (this.warned) {
			return;
		}
		this.warned = true;
		this.notificationService.warn(message);
	}

	private async refreshClipboard(): Promise<void> {
		if (Date.now() - this.clipboardReadAt < 400) {
			return;
		}
		this.clipboardReadAt = Date.now();
		try {
			this.clipboardCache = (await this.clipboardService.readText()).slice(0, 2_000);
		} catch {
			// Permissions / empty clipboard - the model prompt just omits it.
		}
	}

	// --- queue -----------------------------------------------------------------------------

	/**
	 * The next queued edit for this file, placed in the file as it is now (text-anchored edits
	 * are found again; an edit whose text is gone is dropped as stale), else a jump to the next
	 * file that has one.
	 */
	private serveQueue(model: ITextModel, position: Position): IVoltInlineItem[] | undefined {
		if (!this.queue.length) {
			return undefined;
		}
		const uri = model.uri.toString();
		const local: IPredictedEdit[] = [];
		const remote: IPredictedEdit[] = [];
		for (const edit of this.queue) {
			if (edit.uri.toString() !== uri) {
				remote.push(edit);
				continue;
			}
			const placed = resolveEditInModel(edit, model, position);
			if (placed) {
				local.push(placed);
			}
		}
		this.queue = [...sortByPosition(local), ...remote];
		if (local.length) {
			return [this.editItem(this.queue[0])];
		}
		// All remaining edits live in other files -> offer the jump.
		return remote.length ? [this.jumpItem(remote[0].uri, position)] : undefined;
	}

	/** Chained next-edit requests cost a full structured round trip: fast HTTP models only. */
	private canChain(): boolean {
		const ref = this.predictionService.resolveTabModelRef();
		return !!ref && !ref.startsWith('agent:');
	}

	private dropAccepted(accepted: IPredictedEdit): void {
		const uri = accepted.uri.toString();
		this.queue = this.queue
			.filter(edit => edit !== accepted)
			// Text-anchored edits are found again when served; positional ones shift.
			.map(edit => edit.uri.toString() === uri && edit.find === undefined
				? { ...edit, range: shiftRangeAfterAccept(edit.range, accepted) }
				: edit);
	}

	// --- chaining --------------------------------------------------------------------------

	/** After an accepted ghost completion, speculatively ask for the user's next edit. */
	private chainNextEdit(model: ITextModel, near: Position): void {
		this.chainCts?.dispose(true);
		const cts = new CancellationTokenSource();
		this.chainCts = cts;
		void (async () => {
			try {
				if (model.isDisposed()) {
					return;
				}
				// The cursor ends up after the accepted text; `near` is where the completion started.
				const position = model.validatePosition(near);
				const ctx = buildPredictionContext(model, position, this.markerService, this.modelService, this.recentEdits.list(), this.clipboardCache);
				const prediction = await this.predictionService.predictNextEdit(ctx, cts.token);
				if (!prediction || cts.token.isCancellationRequested) {
					return;
				}
				this.queue = [prediction.primary, ...prediction.next];
				this._onDidChange.fire();
			} catch (err) {
				this.logService.trace(`[volt prediction] chain failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				if (this.chainCts === cts) {
					this.chainCts = undefined;
				}
				cts.dispose();
			}
		})();
	}

	/** Feeds an external prediction (the one-shot command) into the Tab chain. */
	queuePrediction(prediction: IEditPrediction): void {
		this.queue = [prediction.primary, ...prediction.next];
		this._onDidChange.fire();
	}

	// --- item shapes -----------------------------------------------------------------------

	private editItem(edit: IPredictedEdit): IVoltInlineItem {
		return {
			voltKind: 'queued',
			voltEdit: edit,
			insertText: edit.replacement,
			range: edit.range,
			isInlineEdit: true,
			showInlineEditMenu: true,
		};
	}

	private jumpItem(target: URI, position: Position): IVoltInlineItem {
		const collapsed = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		return {
			voltKind: 'jump',
			insertText: '',
			range: collapsed,
			isInlineEdit: true,
			command: { id: 'vscode.open', title: 'Jump to next edit', arguments: [target] },
			displayLocation: {
				range: collapsed,
				kind: InlineCompletionDisplayLocationKind.Label,
				label: `Jump to ${basename(target)}`,
			},
		};
	}

	private list(model: ITextModel, position: Position, items: IVoltInlineItem[]): IVoltCompletionList {
		return {
			items,
			enableForwardStability: true,
			sourceModel: model,
			sourcePosition: position,
			sourceVersionId: model.getVersionId(),
		};
	}
}

/**
 * Instant ghost text with no model call: the rest of the clipboard when the line is being typed
 * as its start (or a keyword before it), the "I just copied this" case.
 */
function clipboardSuggestion(ctx: IPredictionContext): string | undefined {
	if (ctx.linePrefix.trim().length < 2) {
		return undefined;
	}
	const raw = fromClipboard(ctx.linePrefix, ctx.clipboard);
	return raw ? postProcessInline({ raw, linePrefix: ctx.linePrefix, lineSuffix: ctx.lineSuffix, prefix: ctx.prefix, suffix: ctx.suffix, writing: inlineWritingKind(ctx.languageId, ctx.linePrefix) }) : undefined;
}
