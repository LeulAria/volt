/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/inlineComment.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget } from '../../../../../editor/browser/editorBrowser.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IModelDeltaDecoration, ITextModel, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { localize } from '../../../../../nls.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { AGENT_SIDE_PANEL_VIEW_ID } from '../editor/agentEditorInput.js';
import { AgentSidePanel } from '../chrome/agentSidePanel.js';
import {
	CONTEXT_INLINE_COMMENT_HAS_PREVIEW,
	CONTEXT_INLINE_COMMENT_VISIBLE,
	INLINE_COMMENT_KEEP_COMMAND_ID,
	INLINE_COMMENT_UNDO_COMMAND_ID,
} from './inlineCommentActions.js';
import {
	buildInlineAskPrompt,
	buildInlineEditPrompt,
	collectRuntimeText,
	extractReplacementCode,
	fullLineRange,
	ILineRange,
	selectedSource,
	selectionLineRange,
} from './inlineCommentModel.js';
import { InlineCommentZoneWidget } from './inlineCommentWidget.js';

export class InlineCommentController extends Disposable implements IEditorContribution {

	static readonly ID = 'volt.agent.inlineComment';

	static get(editor: ICodeEditor): InlineCommentController | undefined {
		return editor.getContribution<InlineCommentController>(InlineCommentController.ID) ?? undefined;
	}

	private readonly widget: InlineCommentZoneWidget;
	private readonly review: InlineEditReviewOverlay;
	private readonly preview = this._register(new MutableDisposable<InlineEditPreview>());
	private readonly request = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly visibleKey: IContextKey<boolean>;
	private readonly previewKey: IContextKey<boolean>;
	private selection: ILineRange | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this.visibleKey = CONTEXT_INLINE_COMMENT_VISIBLE.bindTo(contextKeyService);
		this.previewKey = CONTEXT_INLINE_COMMENT_HAS_PREVIEW.bindTo(contextKeyService);
		this.widget = this._register(instantiationService.createInstance(InlineCommentZoneWidget, editor));
		this.review = this._register(instantiationService.createInstance(InlineEditReviewOverlay));
		this.review.attach(editor);
		this._register(this.widget.onDidSubmit(e => void this.handleSubmit(e.mode, e.text)));
		this._register(this.widget.onDidClose(() => this.hide()));
		this._register(this.widget.onDidAccept(() => this.keep()));
		this._register(this.widget.onDidReject(() => this.undo()));
		this._register(this.review.onKeep(() => this.keep()));
		this._register(this.review.onUndo(() => this.undo()));
		this._register(this.editor.onDidChangeModel(() => this.hide()));
	}

	get isVisible(): boolean {
		return !!this.visibleKey.get();
	}

	open(): void {
		const model = this.editor.getModel();
		const selection = this.editor.getSelection();
		if (!model || !selection || selection.isEmpty()) {
			return;
		}
		this.selection = selectionLineRange(selection);
		this.request.value?.cancel();
		this.request.clear();
		this.clearPreview();
		this.widget.resetForOpen();
		this.widget.show(this.anchorPosition());
		this.visibleKey.set(true);
		this.highlightSelection(true);
		this.widget.focusInput();
	}

	hide(): void {
		this.request.value?.cancel();
		this.request.clear();
		if (this.preview.value) {
			this.preview.value.undo();
		}
		this.clearPreview();
		this.highlightSelection(false);
		this.widget.hide();
		this.visibleKey.set(false);
		this.selection = undefined;
	}

	keep(): void {
		this.preview.value?.keep();
		this.clearPreview();
		this.widget.setPreviewPrompt('', false);
		this.widget.focusInput();
	}

	undo(): void {
		this.preview.value?.undo();
		this.clearPreview();
		this.widget.setPreviewPrompt('', false);
		this.widget.focusInput();
	}

	private anchorPosition(): Position {
		const start = this.selection?.startLineNumber ?? 1;
		return new Position(Math.max(1, start - 1) || 1, 1);
	}

	private highlightIds: string[] = [];

	private highlightSelection(on: boolean): void {
		const model = this.editor.getModel();
		if (!model) {
			this.highlightIds = [];
			return;
		}
		this.highlightIds = model.deltaDecorations(this.highlightIds, on && this.selection ? [{
			range: fullLineRange(model, this.selection),
			options: {
				description: 'volt-inline-comment-selection',
				isWholeLine: true,
				className: 'volt-inline-comment-selection',
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			}
		}] : []);
	}

	private async handleSubmit(mode: ReturnType<InlineCommentZoneWidget['getMode']>, text: string): Promise<void> {
		const model = this.editor.getModel();
		if (!model || !this.selection) {
			return;
		}
		if (mode === 'chat') {
			await this.sendToChat(model.uri, this.selection, text);
			this.hide();
			return;
		}
		if (mode === 'ask') {
			await this.ask(model, this.selection, text);
			return;
		}
		await this.edit(model, this.selection, text);
	}

	private async sendToChat(resource: URI, lines: ILineRange, comment: string): Promise<void> {
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		const view = await this.viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, true);
		if (!view) {
			return;
		}
		if (!view.getActiveAgentEditor()) {
			await view.openNewAgent();
		}
		view.getActiveAgentEditor()?.sendSelectionToChat(resource, {
			startLineNumber: lines.startLineNumber,
			startColumn: 1,
			endLineNumber: lines.endLineNumber,
			endColumn: Number.MAX_SAFE_INTEGER,
		}, comment);
	}

	private async ask(model: ITextModel, lines: ILineRange, question: string): Promise<void> {
		this.widget.setBusy(true);
		this.widget.setAnswer(question, '', true);
		try {
			const answer = await this.runAsk(buildInlineAskPrompt(this.fileLabel(model.uri), lines, selectedSource(model, lines), question), text => {
				this.widget.setAnswer(question, text, true);
			});
			this.widget.setAnswer(question, answer || localize('voltInlineComment.emptyAnswer', "No answer returned."));
		} catch (err) {
			if (isCancelled(err)) {
				this.widget.setAnswer(question, localize('voltInlineComment.cancelled', "Cancelled."));
			} else {
				this.widget.setAnswer(question, err instanceof Error ? err.message : String(err));
			}
		} finally {
			this.widget.setBusy(false);
			this.widget.focusInput();
		}
	}

	private async edit(model: ITextModel, lines: ILineRange, request: string): Promise<void> {
		this.widget.setBusy(true);
		this.widget.setAnswer(request, localize('voltInlineComment.generating', "Generating..."), true);
		try {
			const raw = await this.runAsk(buildInlineEditPrompt(this.fileLabel(model.uri), lines, selectedSource(model, lines), request));
			const next = extractReplacementCode(raw);
			if (!next) {
				throw new Error(localize('voltInlineComment.emptyEdit', "The model did not return replacement code."));
			}
			this.applyPreview(model, lines, next, request);
			this.widget.hideThread();
			this.widget.setPreviewPrompt(request, true);
		} catch (err) {
			if (isCancelled(err)) {
				this.notificationService.info(localize('voltInlineComment.cancelled', "Cancelled."));
			} else {
				this.widget.setAnswer(request, err instanceof Error ? err.message : String(err));
			}
		} finally {
			this.widget.setBusy(false);
			this.widget.focusInput();
		}
	}

	private applyPreview(model: ITextModel, lines: ILineRange, next: string, prompt: string): void {
		this.preview.value?.undo();
		this.preview.value = new InlineEditPreview(this.editor, model, lines, next);
		this.preview.value.apply();
		this.selection = this.preview.value.currentLines;
		this.previewKey.set(true);
		this.review.show(this.preview.value.currentLines);
		this.widget.setPreviewPrompt(prompt, true);
		this.highlightSelection(false);
	}

	private async runAsk(prompt: string, onDelta?: (text: string) => void): Promise<string> {
		this.request.value?.cancel();
		const cts = new CancellationTokenSource();
		this.request.value = cts;
		const session = this.runtime.getOrCreateSession(`volt-inline-${generateUuid()}`);
		const runId = await this.runtime.send(session.sessionId, { text: prompt, mode: 'ask' });
		return collectRuntimeText(this.runtime, session.sessionId, runId, text => onDelta?.(text), cts.token);
	}

	private fileLabel(resource: URI): string {
		return this.labelService.getUriLabel(resource, { relative: true, noPrefix: true, separator: '/' }) || resource.path;
	}

	private clearPreview(): void {
		this.preview.clear();
		this.review.hide();
		this.previewKey.set(false);
	}
}

class InlineEditPreview {

	private readonly original: string;
	private tracked: string[] = [];
	private zoneId: string | undefined;
	private applied = false;
	currentLines: ILineRange;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly model: ITextModel,
		private readonly lines: ILineRange,
		private readonly next: string,
	) {
		this.original = selectedSource(model, lines);
		this.currentLines = { ...lines };
	}

	apply(): void {
		if (this.applied) {
			return;
		}
		const range = fullLineRange(this.model, this.lines);
		this.model.pushStackElement();
		this.model.pushEditOperations(null, [{ range, text: this.next }], () => null);
		this.model.pushStackElement();
		const newLineCount = Math.max(1, this.next.split(/\r?\n/).length);
		this.currentLines = {
			startLineNumber: this.lines.startLineNumber,
			endLineNumber: this.lines.startLineNumber + newLineCount - 1,
		};
		this.tracked = this.model.deltaDecorations([], this.decorations());
		this.addDeletedZone();
		this.applied = true;
	}

	dispose(): void {
		this.removeDecorations();
	}

	keep(): void {
		this.removeDecorations();
		this.applied = false;
	}

	undo(): void {
		if (!this.applied) {
			this.removeDecorations();
			return;
		}
		const range = this.trackedRange() ?? fullLineRange(this.model, this.currentLines);
		this.model.pushStackElement();
		this.model.pushEditOperations(null, [{ range, text: this.original }], () => null);
		this.model.pushStackElement();
		this.removeDecorations();
		this.applied = false;
	}

	private decorations(): IModelDeltaDecoration[] {
		return [{
			range: fullLineRange(this.model, this.currentLines),
			options: {
				description: 'volt-inline-comment-insert',
				isWholeLine: true,
				className: 'volt-inline-comment-insert',
				linesDecorationsClassName: 'volt-inline-comment-insert-margin',
				stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
			}
		}];
	}

	private trackedRange(): Range | undefined {
		const id = this.tracked[0];
		return id ? this.model.getDecorationRange(id) ?? undefined : undefined;
	}

	private addDeletedZone(): void {
		const font = this.editor.getOption(EditorOption.fontInfo);
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const node = $('div.volt-inline-comment-deleted');
		node.style.fontFamily = font.fontFamily;
		node.style.fontSize = `${font.fontSize}px`;
		node.style.lineHeight = `${lineHeight}px`;
		for (const line of this.original.split(/\r?\n/)) {
			const row = append(node, $('div.volt-inline-comment-deleted-line'));
			row.textContent = line.length ? line : ' ';
			row.style.height = `${lineHeight}px`;
		}
		this.editor.changeViewZones(accessor => {
			this.zoneId = accessor.addZone({
				afterLineNumber: this.currentLines.startLineNumber - 1,
				heightInLines: Math.max(1, this.original.split(/\r?\n/).length),
				domNode: node,
				suppressMouseDown: true,
				ordinal: 50001,
			});
		});
	}

	private removeDecorations(): void {
		if (this.tracked.length) {
			this.model.deltaDecorations(this.tracked, []);
			this.tracked = [];
		}
		if (this.zoneId) {
			const id = this.zoneId;
			this.editor.changeViewZones(accessor => accessor.removeZone(id));
			this.zoneId = undefined;
		}
	}
}

class InlineEditReviewOverlay extends Disposable implements IOverlayWidget {

	private editor: ICodeEditor | undefined;
	private readonly domNode: HTMLElement;
	private readonly _onKeep = this._register(new Emitter<void>());
	readonly onKeep = this._onKeep.event;
	private readonly _onUndo = this._register(new Emitter<void>());
	readonly onUndo = this._onUndo.event;
	private lines: ILineRange | undefined;

	constructor(@IKeybindingService keybindingService: IKeybindingService) {
		super();
		this.domNode = $('span.volt-inline-comment-review');
		this.domNode.style.visibility = 'hidden';
		const undo = append(this.domNode, $('button.volt-inline-comment-review-btn'));
		undo.appendChild(document.createTextNode(localize('voltInlineComment.undo', "Undo")));
		const undoKey = keybindingService?.lookupKeybinding(INLINE_COMMENT_UNDO_COMMAND_ID)?.getLabel();
		if (undoKey) {
			append(undo, $('span.volt-agent-selection-action-key')).textContent = undoKey;
		}
		const keep = append(this.domNode, $('button.volt-inline-comment-review-btn.keep'));
		keep.appendChild(document.createTextNode(localize('voltInlineComment.keep', "Keep")));
		const keepKey = keybindingService?.lookupKeybinding(INLINE_COMMENT_KEEP_COMMAND_ID)?.getLabel();
		if (keepKey) {
			append(keep, $('span.volt-agent-selection-action-key')).textContent = keepKey;
		}
		this._register(addDisposableListener(undo, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			this._onUndo.fire();
		}));
		this._register(addDisposableListener(keep, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			this._onKeep.fire();
		}));
	}

	attach(editor: ICodeEditor): void {
		this.editor = editor;
		editor.addOverlayWidget(this);
		this._register(editor.onDidScrollChange(() => this.layout()));
		this._register(editor.onDidLayoutChange(() => this.layout()));
		this._register({ dispose: () => editor.removeOverlayWidget(this) });
	}

	getId(): string {
		return 'volt.agent.inlineCommentReview';
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition() {
		return null;
	}

	show(lines: ILineRange): void {
		this.lines = lines;
		this.domNode.style.visibility = 'visible';
		this.layout();
	}

	hide(): void {
		this.lines = undefined;
		this.domNode.style.visibility = 'hidden';
	}

	private layout(): void {
		const editor = this.editor;
		const model = editor?.getModel();
		const editorDom = editor?.getDomNode();
		if (!editor || !model || !editorDom || !this.lines) {
			this.domNode.style.visibility = 'hidden';
			return;
		}
		const position = new Position(this.lines.endLineNumber, model.getLineMaxColumn(this.lines.endLineNumber));
		const visible = editor.getScrolledVisiblePosition(position);
		if (!visible || visible.top + visible.height < 0 || visible.top > editorDom.clientHeight) {
			this.domNode.style.visibility = 'hidden';
			return;
		}
		this.domNode.style.visibility = 'visible';
		this.domNode.style.left = `${Math.round(visible.left + 12)}px`;
		this.domNode.style.top = `${Math.round(visible.top + Math.max(0, (visible.height - this.domNode.offsetHeight) / 2))}px`;
	}
}

function isCancelled(err: unknown): boolean {
	return err instanceof Error && /cancel/i.test(err.message);
}
