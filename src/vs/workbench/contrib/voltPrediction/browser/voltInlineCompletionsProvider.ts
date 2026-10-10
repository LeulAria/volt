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
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { IEditPrediction, IPredictedEdit, IPredictionContext, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { AGENT_COMPOSER_SCHEME } from '../../../services/voltRuntime/common/prediction/composerContext.js';
import { DEFAULT_EXCERPT_BUDGET, INLINE_EXCERPT_BUDGET, KEYWORDS } from '../../../services/voltRuntime/common/prediction/contextWindow.js';
import { shiftRangeAfterAccept } from '../../../services/voltRuntime/common/prediction/editGraph.js';
import { LOCAL_PLAUSIBLE, LOCAL_SURE, predictLocalScored } from '../../../services/voltRuntime/common/prediction/localPredictor.js';
import { inlineEditForLine } from '../../../services/voltRuntime/common/prediction/postProcess.js';
import { inlineWritingKind } from '../../../services/voltRuntime/common/prediction/predictionPrompt.js';
import { gateFeatures, IGateState, TabGate } from '../../../services/voltRuntime/common/prediction/tabGate.js';
import { buildExcerptContext, enrichPredictionContext } from '../../../services/voltRuntime/browser/prediction/predictionContextBuilder.js';
import { resolveEditInModel, sortByPosition } from '../../../services/voltRuntime/browser/prediction/predictedEditResolver.js';
import { ITypingState, RecentEditsTracker } from '../../../services/voltRuntime/browser/prediction/recentEditsTracker.js';
import { WorkspaceContextIndex } from '../../../services/voltRuntime/browser/prediction/workspaceContextIndex.js';
import { ClipboardWatch } from './clipboardWatch.js';
import { TerminalCommandTracker } from './terminalCommandTracker.js';

type VoltItemKind = 'inline' | 'queued' | 'jump';

interface IVoltInlineItem extends InlineCompletion {
	readonly voltKind: VoltItemKind;
	readonly voltEdit?: IPredictedEdit;
	/** Ghost text from the model (or its caches), with the gate's view of the spot: what Tab teaches the gate. */
	readonly voltFeatures?: readonly number[];
}

interface IVoltCompletionList extends InlineCompletions<IVoltInlineItem> {
	readonly sourceModel: ITextModel;
	readonly sourcePosition: Position;
	readonly sourceVersionId: number;
}

/** After an accepted ghost text, this long: the next one is asked for while the current one shows. */
const TAB_STREAK_MS = 30_000;
/** Mid-word while typing fast, the request waits this much longer for the pause (a key meanwhile replaces it for free). */
const MID_WORD_PAUSE_MS = 90;
/** A clipboard copied this recently rides along in prompts; an older one only when it names code near the cursor. */
const CLIPBOARD_FRESH_MS = 3 * 60_000;
/** A clipboard copied this recently is offered as the rest of a line that types out its start (no model call). */
const CLIPBOARD_LOCAL_MS = 10 * 60_000;
/** Terminal failures this recent are offered to prompts (when their output names code near the cursor). */
const TERMINAL_RECENT_MS = 10 * 60_000;
const GATE_STORAGE_KEY = 'volt.prediction.gate';
/** Gate steps between saves. */
const GATE_SAVE_EVERY = 25;

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
 *
 * Ghost text is answered cheapest first: what is already known (typed through, asked before),
 * then the local predictor when it is sure, then (if the gate rates the spot worth it) the model
 * with the codebase context, its first lines shown while the rest streams in.
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
	private warned = false;
	/** The last accepted ghost text: while the user keeps pressing Tab, the next answer is fetched ahead. */
	private lastAccept: { readonly uri: string; readonly at: number } | undefined;
	/** Decides which spots are worth a model request; learns from Tab and Escape. */
	private readonly gate: TabGate;
	/** Model suggestions dismissed or typed over since the last one taken. */
	private dismissedInRow = 0;

	constructor(
		private readonly recentEdits: RecentEditsTracker,
		private readonly index: WorkspaceContextIndex,
		private readonly terminals: TerminalCommandTracker,
		private readonly clipboard: ClipboardWatch,
		@IVoltPredictionService private readonly predictionService: IVoltPredictionService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IModelService private readonly modelService: IModelService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.gate = new TabGate(loadGate(storageService));
		// The rest of a streamed answer arrived: ask again, and the longer text is known.
		this._register(predictionService.onDidExtendInline(() => this._onDidChange.fire()));
		this._register(storageService.onWillSaveState(() => this.saveGate()));
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

		const explicit = context.triggerKind === InlineCompletionTriggerKind.Explicit;
		if (settings.mode === 'subtle' && !explicit) {
			return undefined;
		}

		this.clipboard.refresh();
		const modelRef = this.predictionService.resolveTabModelRef();
		const stats = this.predictionService.stats;

		// 2. Explicit NES trigger (inline edits requested without inline completions).
		if (!context.includeInlineCompletions && context.includeInlineEdits) {
			if (!modelRef) {
				this.warnNoModel();
				return undefined;
			}
			const prediction = await this.predictionService.predictNextEdit(this.fullContext(model, position), token);
			if (!prediction || token.isCancellationRequested) {
				return undefined;
			}
			this.queue = [prediction.primary, ...prediction.next];
			const served = this.serveQueue(model, position);
			return served ? this.list(model, position, served) : undefined;
		}

		// 3. Ghost text, cheapest answer first. The excerpt alone answers from the caches and the
		// local predictor; files, diagnostics and the index are read only for a model request.
		const light = buildExcerptContext(model, position, this.recentEdits.list(), this.clipboard.recent(CLIPBOARD_LOCAL_MS), INLINE_EXCERPT_BUDGET);
		const typing = this.recentEdits.typing(model.uri.toString());
		const features = gateFeatures({
			linePrefix: light.linePrefix,
			lineSuffix: light.lineSuffix,
			writing: inlineWritingKind(light.languageId, light.linePrefix) !== 'code',
			keysLastSecond: typing.keysLastSecond,
			deleting: typing.deleting,
			streak: this.inStreak(model),
			dismissedInRow: this.dismissedInRow,
		});

		// Typed through a suggestion, or this spot answered before.
		const known = modelRef ? this.predictionService.peekInline(light) : undefined;
		if (known) {
			stats.bump('instant');
			return this.inlineList(model, position, known.primary.replacement, features);
		}
		// A counting run of lines, the clipboard being typed out: sure enough to need no model.
		const local = predictLocalScored(light);
		if (local && local.confidence >= LOCAL_SURE) {
			return this.localList(model, position, local.text);
		}
		const plausible = local && local.confidence >= LOCAL_PLAUSIBLE ? local.text : undefined;
		if (!modelRef) {
			this.warnNoModel();
			return plausible !== undefined ? this.localList(model, position, plausible) : undefined;
		}
		// Spots where suggestions are rarely taken (mid-word, fast typing, deleting) are not worth a request.
		if (!explicit && !this.gate.shouldRequest(features)) {
			stats.bump('gated');
			return plausible !== undefined ? this.localList(model, position, plausible) : undefined;
		}

		// The model; the service times it out. Typing cancels the wait, and the answer stays cached
		// for this spot.
		const ctx: IPredictionContext = { ...this.enrich(light, model, position, true), delayMs: pauseFor(light, typing) };
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
			return this.inlineList(model, position, prediction.primary.replacement, features);
		}
		return plausible !== undefined ? this.localList(model, position, plausible) : undefined;
	}

	/** A local guess, shown with no model call. */
	private localList(model: ITextModel, position: Position, completion: string): IVoltCompletionList {
		this.predictionService.stats.bump('local');
		return this.inlineList(model, position, completion);
	}

	/**
	 * Builds the ghost-text item for `completion` at `position`, fitted to the rest of the line.
	 * `features`: the suggestion came from the model, and what Tab or Escape does with it trains the gate.
	 */
	private inlineList(model: ITextModel, position: Position, completion: string, features?: readonly number[]): IVoltCompletionList {
		// Re-read the line: the cursor's line may have changed while the model was answering.
		const lineContent = model.getLineContent(position.lineNumber);
		const edit = inlineEditForLine(completion, lineContent.slice(0, position.column - 1), lineContent.slice(position.column - 1));
		const item: IVoltInlineItem = {
			voltKind: 'inline',
			voltFeatures: features,
			insertText: edit.insertText,
			range: edit.replacesLineSuffix
				? new Range(position.lineNumber, position.column, position.lineNumber, model.getLineMaxColumn(position.lineNumber))
				: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
		};
		return this.list(model, position, [item]);
	}

	/**
	 * The excerpt plus what a model request draws on: diagnostics, imports the excerpt does not
	 * show, related code and definitions from the workspace index, terminal failures that name code
	 * near the cursor, and the clipboard when it is fresh or bears on that code.
	 */
	private enrich(ctx: IPredictionContext, model: ITextModel, position: Position, inline: boolean): IPredictionContext {
		const enriched = enrichPredictionContext(ctx, model, position, this.markerService, this.modelService, {
			index: this.index,
			inline,
			excludedGlobs: this.predictionService.getSettings().disabledGlobs,
			running: terms => this.terminals.failuresMentioning(terms, TERMINAL_RECENT_MS),
		});
		return { ...enriched, clipboard: this.clipboard.recent(CLIPBOARD_FRESH_MS, text => clipboardBearsOn(text, ctx)) };
	}

	/** The wide context next-edit prediction works from. */
	private fullContext(model: ITextModel, position: Position): IPredictionContext {
		return this.enrich(buildExcerptContext(model, position, this.recentEdits.list(), this.clipboard.recent(CLIPBOARD_LOCAL_MS), DEFAULT_EXCERPT_BUDGET), model, position, false);
	}

	private inStreak(model: ITextModel): boolean {
		return this.lastAccept?.uri === model.uri.toString() && Date.now() - this.lastAccept.at < TAB_STREAK_MS;
	}

	/**
	 * In a run of accepted suggestions (Tab, Tab, Tab), asks for the one after this suggestion while
	 * it is read, so it is there when Tab is pressed. Outside a run nothing is spent ahead.
	 */
	handleItemDidShow(completions: IVoltCompletionList, item: IVoltInlineItem): void {
		if (item.voltFeatures) {
			this.predictionService.stats.bump('shown');
		}
		const model = completions.sourceModel;
		const range = Range.lift(item.range);
		if (!this.inStreak(model) || item.voltKind !== 'inline' || typeof item.insertText !== 'string' || !range?.isEmpty()
			|| model.isDisposed() || model.getVersionId() !== completions.sourceVersionId) {
			return;
		}
		const position = range.getStartPosition();
		const ctx = this.enrich(buildExcerptContext(model, position, this.recentEdits.list(), this.clipboard.recent(CLIPBOARD_LOCAL_MS), INLINE_EXCERPT_BUDGET), model, position, true);
		const linePrefix = ctx.linePrefix + item.insertText;
		this.predictionService.prefetchInline({ ...ctx, prefix: ctx.prefix + item.insertText, linePrefix: linePrefix.slice(linePrefix.lastIndexOf('\n') + 1) });
	}

	handleEndOfLifetime(completions: IVoltCompletionList, item: IVoltInlineItem, reason: InlineCompletionEndOfLifeReason<IVoltInlineItem>): void {
		if (item.voltKind === 'inline' && item.voltFeatures) {
			// Taken, dismissed, or typed over with something else: what the gate learns from. Typing
			// along with it (or a newer answer replacing it) says nothing either way.
			if (reason.kind === InlineCompletionEndOfLifeReasonKind.Accepted) {
				this.predictionService.stats.bump('accepted');
				this.learn(item.voltFeatures, true);
			} else if (reason.kind === InlineCompletionEndOfLifeReasonKind.Rejected || reason.userTypingDisagreed) {
				this.learn(item.voltFeatures, false);
			}
		}
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
		this.saveGate();
		super.dispose();
	}

	private warnOnce(message: string): void {
		if (this.warned) {
			return;
		}
		this.warned = true;
		this.notificationService.warn(message);
	}

	private warnNoModel(): void {
		this.warnOnce(localize(
			'voltPrediction.noModel',
			"Volt Tab has no model. Choose a prediction model in Volt Settings > Tab & Prediction, or a model in the composer."
		));
	}

	private learn(features: readonly number[], taken: boolean): void {
		this.gate.learn(features, taken);
		this.dismissedInRow = taken ? 0 : this.dismissedInRow + 1;
		if (this.gate.unsaved >= GATE_SAVE_EVERY) {
			this.saveGate();
		}
	}

	private saveGate(): void {
		if (this.gate.unsaved) {
			this.storageService.store(GATE_STORAGE_KEY, JSON.stringify(this.gate.save()), StorageScope.APPLICATION, StorageTarget.MACHINE);
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
				const prediction = await this.predictionService.predictNextEdit(this.fullContext(model, position), cts.token);
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
 * Mid-word while typing fast, the word is not finished: the request waits a little longer for the
 * pause. At a word's end, a space or punctuation it goes at once.
 */
function pauseFor(ctx: IPredictionContext, typing: ITypingState): number {
	return /[\p{L}\p{N}_$]$/u.test(ctx.linePrefix) && typing.keysLastSecond >= 3 ? MID_WORD_PAUSE_MS : 0;
}

/** An old clipboard still matters when it names code around the cursor. */
function clipboardBearsOn(text: string, ctx: IPredictionContext): boolean {
	const near = new Set(`${ctx.prefix.slice(-600)}\n${ctx.suffix.slice(0, 300)}`.match(/[A-Za-z_$][\w$]{3,}/g) ?? []);
	let checked = 0;
	for (const name of new Set(text.match(/[A-Za-z_$][\w$]{3,}/g) ?? [])) {
		if (++checked > 60) {
			break;
		}
		if (near.has(name) && !KEYWORDS.has(name.toLowerCase())) {
			return true;
		}
	}
	return false;
}

function loadGate(storageService: IStorageService): IGateState | undefined {
	try {
		const raw = storageService.get(GATE_STORAGE_KEY, StorageScope.APPLICATION);
		return raw ? JSON.parse(raw) as IGateState : undefined;
	} catch {
		return undefined;
	}
}
