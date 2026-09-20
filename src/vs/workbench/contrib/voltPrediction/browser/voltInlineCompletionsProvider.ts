/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { match as matchGlob } from '../../../../base/common/glob.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
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
import { IEditPrediction, IPredictedEdit, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { shiftRangeAfterAccept } from '../../../services/voltRuntime/common/prediction/editGraph.js';
import { buildPredictionContext } from '../../../services/voltRuntime/browser/prediction/predictionContextBuilder.js';
import { RecentEditsTracker } from '../../../services/voltRuntime/browser/prediction/recentEditsTracker.js';

type VoltItemKind = 'inline' | 'queued' | 'jump';

interface IVoltInlineItem extends InlineCompletion {
	readonly voltKind: VoltItemKind;
	readonly voltEdit?: IPredictedEdit;
}

interface IVoltCompletionList extends InlineCompletions<IVoltInlineItem> {
	readonly sourceModel: ITextModel;
	readonly sourcePosition: Position;
}

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
	/** Wait for typing to settle so we do not cancel the LLM on every key. */
	readonly debounceDelayMs = 160;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChangeInlineCompletions: Event<void> = this._onDidChange.event;

	/** Follow-up edits awaiting acceptance, ordered: current file first, then per-file. */
	private queue: IPredictedEdit[] = [];
	private chainCts: CancellationTokenSource | undefined;
	private clipboardCache = '';
	private clipboardReadAt = 0;
	private warned = false;

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
		if (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.untitled) {
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
		const ctx = buildPredictionContext(model, position, this.markerService, this.modelService, this.recentEdits.list(), this.clipboardCache);

		if (!this.predictionService.resolveTabModelRef()) {
			this.warnOnce(localize(
				'voltPrediction.noModel',
				"Volt Tab follows the agent composer. Pick Cursor (or any agent/model) there."
			));
			return undefined;
		}

		// 2. Explicit NES trigger (inline edits requested without inline completions).
		if (!context.includeInlineCompletions && context.includeInlineEdits) {
			const prediction = await this.predictionService.predictNextEdit(ctx, token);
			if (!prediction || token.isCancellationRequested) {
				return undefined;
			}
			this.queue = prediction.next.slice();
			return this.list(model, position, [this.editItem(prediction.primary)]);
		}

		// 3. Ghost text from the selected chat model - not nearby-line echo, not LSP.
		const prediction = await this.predictionService.predictInline(ctx, token);
		const failure = this.predictionService.consumeLastFailure();
		if (failure) {
			this.warnOnce(localize('voltPrediction.failed', "Volt Tab: {0}", failure));
		}
		if (!prediction || token.isCancellationRequested || model.getVersionId() !== ctx.modelVersionId) {
			return undefined;
		}
		const item: IVoltInlineItem = {
			voltKind: 'inline',
			insertText: prediction.primary.replacement,
			range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
		};
		return this.list(model, position, [item]);
	}

	handleEndOfLifetime(completions: IVoltCompletionList, item: IVoltInlineItem, reason: InlineCompletionEndOfLifeReason<IVoltInlineItem>): void {
		if (reason.kind === InlineCompletionEndOfLifeReasonKind.Accepted) {
			if (item.voltKind === 'queued' && item.voltEdit) {
				this.dropAccepted(item.voltEdit);
				// Retrigger so the next edit in the chain shows immediately.
				this._onDidChange.fire();
			} else if (item.voltKind === 'inline') {
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

	private serveQueue(model: ITextModel, position: Position): IVoltInlineItem[] | undefined {
		if (!this.queue.length) {
			return undefined;
		}
		const uri = model.uri.toString();
		while (this.queue.length) {
			const local = this.queue.find(edit => edit.uri.toString() === uri);
			if (local) {
				if (!this.rangeIsValid(model, local.range)) {
					this.queue = this.queue.filter(edit => edit !== local);
					continue;
				}
				return [this.editItem(local)];
			}
			// All remaining edits live in other files -> offer the jump.
			return [this.jumpItem(this.queue[0].uri, position)];
		}
		return undefined;
	}

	private dropAccepted(accepted: IPredictedEdit): void {
		const uri = accepted.uri.toString();
		this.queue = this.queue
			.filter(edit => edit !== accepted)
			.map(edit => edit.uri.toString() === uri
				? { ...edit, range: shiftRangeAfterAccept(edit.range, accepted) }
				: edit);
	}

	private rangeIsValid(model: ITextModel, range: IRange): boolean {
		if (range.endLineNumber > model.getLineCount()) {
			return false;
		}
		return range.startColumn <= model.getLineMaxColumn(range.startLineNumber)
			&& range.endColumn <= model.getLineMaxColumn(range.endLineNumber);
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
		};
	}
}
