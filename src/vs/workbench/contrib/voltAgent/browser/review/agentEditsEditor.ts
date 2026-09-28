/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentEdits.css';
import { $, addDisposableListener, append, getTotalWidth } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { themeColorFromId } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition, IViewZone, MouseTargetType } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { LineSource, renderLines, RenderOptions } from '../../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { diffAddDecoration, diffDeleteDecoration, diffWholeLineAddDecoration } from '../../../../../editor/browser/widget/diffEditor/registrations.contribution.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { IModelDeltaDecoration, MinimapPosition, OverviewRulerLane, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../../editor/common/model/textModel.js';
import { InlineDecoration, InlineDecorationType } from '../../../../../editor/common/viewModel/inlineDecorations.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../services/editor/common/editorService.js';
import { minimapGutterAddedBackground, minimapGutterDeletedBackground, minimapGutterModifiedBackground, overviewRulerAddedForeground, overviewRulerDeletedForeground, overviewRulerModifiedForeground } from '../../../scm/common/quickDiff.js';
import { IAgentEditsService, IAgentPendingFile } from './agentEditsService.js';

/** The focused editor shows a file with agent edits the user has not kept or undone. */
export const CTX_AGENT_EDITS_PENDING = new RawContextKey<boolean>('voltAgent.editorHasPendingEdits', false, localize('voltAgent.editorHasPendingEdits', "Whether the editor shows agent edits waiting for Keep or Undo"));

registerColor('voltAgentEdits.keepBackground', { dark: '#3f7d4a', light: '#2f7d3b', hcDark: '#3f7d4a', hcLight: '#2f7d3b' }, localize('voltAgentEdits.keepBackground', "Background of the Keep button on a pending agent change."));
registerColor('voltAgentEdits.keepHoverBackground', { dark: '#4a8f56', light: '#3a8f47', hcDark: '#4a8f56', hcLight: '#3a8f47' }, localize('voltAgentEdits.keepHoverBackground', "Background of the Keep button on a pending agent change when hovered."));

export const KEEP_HUNK_ID = 'voltAgent.edits.keepHunk';
export const UNDO_HUNK_ID = 'voltAgent.edits.undoHunk';
export const KEEP_FILE_ID = 'voltAgent.edits.keepFile';
export const UNDO_FILE_ID = 'voltAgent.edits.undoFile';
export const NEXT_HUNK_ID = 'voltAgent.edits.nextHunk';
export const PREVIOUS_HUNK_ID = 'voltAgent.edits.previousHunk';

const hunkRangeDecoration = ModelDecorationOptions.register({
	description: 'volt-agent-edit-hunk',
	stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
});

/**
 * Draws an agent's pending edits inside the normal editor, the way a reviewer reads them:
 * added lines tinted, removed lines shown above them, and Undo / Keep on the hunk under the
 * cursor or mouse. A bar in the top right walks hunks and files and settles the whole file.
 */
export class AgentEditsEditorController extends Disposable implements IEditorContribution {

	static readonly ID = 'editor.contrib.voltAgentEdits';

	static get(editor: ICodeEditor): AgentEditsEditorController | null {
		return editor.getContribution<AgentEditsEditorController>(AgentEditsEditorController.ID);
	}

	private readonly renderStore = this._register(new DisposableStore());
	private readonly hunkRanges: IEditorDecorationsCollection;
	private readonly visuals: IEditorDecorationsCollection;
	private viewZones: string[] = [];
	private zoneHeights: number[] = [];
	private file: IAgentPendingFile | undefined;
	private readonly pendingKey: IContextKey<boolean>;
	private hunkWidget: HunkWidget | undefined;
	private fileBar: FileBarWidget | undefined;
	private activeIndex = -1;
	private hoverIndex = -1;

	constructor(
		private readonly editor: ICodeEditor,
		@IAgentEditsService private readonly edits: IAgentEditsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
		this.pendingKey = CTX_AGENT_EDITS_PENDING.bindTo(contextKeyService);
		this.hunkRanges = editor.createDecorationsCollection();
		this.visuals = editor.createDecorationsCollection();
		this._register(editor.onDidChangeModel(() => this.update()));
		this._register(this.edits.onDidChange(uri => {
			if (isEqual(uri, this.editor.getModel()?.uri)) {
				this.update();
			} else if (this.file) {
				this.fileBar?.render();
			}
		}));
		this._register(editor.onDidChangeCursorPosition(() => this.syncActive()));
		this._register(editor.onMouseMove(e => {
			if (!this.file) {
				return;
			}
			let index = -1;
			if (e.target.type === MouseTargetType.OVERLAY_WIDGET && e.target.detail === HunkWidget.ID) {
				index = this.hoverIndex;
			} else if (e.target.type === MouseTargetType.CONTENT_VIEW_ZONE) {
				index = this.viewZones.indexOf(e.target.detail.viewZoneId);
			} else if (e.target.position) {
				index = this.indexAt(e.target.position);
			}
			if (index !== this.hoverIndex) {
				this.hoverIndex = index;
				this.layoutHunkWidget();
			}
		}));
		this._register(editor.onMouseLeave(() => {
			this.hoverIndex = -1;
			this.layoutHunkWidget();
		}));
		this._register(Event.any(editor.onDidScrollChange, editor.onDidLayoutChange)(() => {
			this.layoutHunkWidget();
			this.fileBar?.layout();
		}));
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.hunkWidget?.refreshLabels()));
		this.update();
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}

	get pendingFile(): IAgentPendingFile | undefined {
		return this.file;
	}

	/** Index of the hunk the actions apply to: the hovered one, else the one at the cursor, else the nearest below it. */
	currentIndex(): number {
		if (this.hoverIndex >= 0) {
			return this.hoverIndex;
		}
		return this.activeIndex;
	}

	hunkCount(): number {
		return this.hunkRanges.length;
	}

	async keepHunk(index = this.currentIndex()): Promise<void> {
		const change = this.changeAt(index);
		if (change && this.file) {
			const uri = this.file.uri;
			await this.edits.keepHunk(uri, change);
			this.revealAfterSettle(index);
		}
	}

	async undoHunk(index = this.currentIndex()): Promise<void> {
		const change = this.changeAt(index);
		if (change && this.file) {
			const uri = this.file.uri;
			await this.edits.undoHunk(uri, change);
			this.revealAfterSettle(index);
		}
	}

	async keepFile(): Promise<void> {
		const file = this.file;
		if (file) {
			const next = this.neighbourFile(1);
			await this.edits.keepFile(file.uri);
			await this.openFile(next);
		}
	}

	async undoFile(): Promise<void> {
		const file = this.file;
		if (file) {
			const next = this.neighbourFile(1);
			await this.edits.undoFile(file.uri);
			await this.openFile(next);
		}
	}

	revealHunk(delta: 1 | -1): void {
		const ranges = this.sortedRanges();
		if (!ranges.length) {
			return;
		}
		const position = this.editor.getPosition() ?? new Position(1, 1);
		let index = ranges.findIndex(range => range.containsPosition(position) || range.startLineNumber === position.lineNumber);
		if (index >= 0) {
			index += delta;
		} else if (delta > 0) {
			index = ranges.findIndex(range => range.startLineNumber > position.lineNumber);
		} else {
			index = ranges.findLastIndex(range => range.endLineNumber < position.lineNumber);
		}
		if (index < 0 && delta < 0) {
			index = ranges.length - 1;
		}
		index = ((Math.max(index, 0) % ranges.length) + ranges.length) % ranges.length;
		this.goToHunk(index);
	}

	goToHunk(index: number): void {
		const range = this.sortedRanges()[index];
		if (!range) {
			return;
		}
		this.hoverIndex = -1;
		this.editor.setPosition(range.getStartPosition());
		this.editor.revealLinesInCenterIfOutsideViewport(range.startLineNumber, range.endLineNumber);
		this.editor.focus();
		this.activeIndex = index;
		this.layoutHunkWidget();
		this.fileBar?.render();
	}

	async revealFile(delta: 1 | -1): Promise<void> {
		await this.openFile(this.neighbourFile(delta));
	}

	fileIndex(): { index: number; total: number } {
		const files = this.sessionFiles();
		const index = this.file ? files.findIndex(file => isEqual(file.uri, this.file!.uri)) : -1;
		return { index, total: files.length };
	}

	private sessionFiles(): readonly IAgentPendingFile[] {
		return this.file ? this.edits.getPendingFiles(this.file.sessionId).filter(file => file.kind !== 'deleted') : [];
	}

	private neighbourFile(delta: 1 | -1): URI | undefined {
		const files = this.sessionFiles();
		const { index } = this.fileIndex();
		if (files.length <= 1 || index < 0) {
			return undefined;
		}
		return files[(index + delta + files.length) % files.length].uri;
	}

	private async openFile(uri: URI | undefined): Promise<void> {
		if (!uri) {
			return;
		}
		const file = this.edits.getPendingFile(uri);
		const first = file?.changes[0];
		const line = first ? Math.max(1, first.modified.startLineNumber) : 1;
		await this.editorService.openEditor({
			resource: uri,
			options: { selection: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, pinned: true },
		}, ACTIVE_GROUP);
	}

	private revealAfterSettle(index: number): void {
		void this.edits.whenSettled().then(() => {
			const count = this.hunkCount();
			if (count) {
				this.goToHunk(Math.min(index, count - 1));
			}
		});
	}

	private changeAt(index: number): DetailedLineRangeMapping | undefined {
		if (!this.file || index < 0) {
			return undefined;
		}
		// The diff's hunks are in file order, like the tracked ranges.
		return this.file.changes[index];
	}

	private sortedRanges(): Range[] {
		return this.hunkRanges.getRanges().sort(Range.compareRangesUsingStarts);
	}

	private indexAt(position: Position): number {
		return this.sortedRanges().findIndex(range => range.containsPosition(position)
			|| (range.startLineNumber === position.lineNumber));
	}

	private syncActive(): void {
		if (!this.file) {
			return;
		}
		const position = this.editor.getPosition();
		if (!position) {
			return;
		}
		const inside = this.indexAt(position);
		const next = inside >= 0 ? inside : Math.max(0, this.sortedRanges().findIndex(range => range.startLineNumber > position.lineNumber));
		if (next !== this.activeIndex) {
			this.activeIndex = next;
			this.layoutHunkWidget();
			this.fileBar?.render();
		}
	}

	private update(): void {
		const model = this.editor.getModel();
		const file = model && !this.editor.getOption(EditorOption.inDiffEditor) && !this.editor.getOption(EditorOption.readOnly)
			? this.edits.getPendingFile(model.uri)
			: undefined;
		if (!file || file.kind === 'deleted' || !file.changes.length) {
			this.clear();
			return;
		}
		this.file = file;
		this.pendingKey.set(true);
		this.render(file);
	}

	private clear(): void {
		this.file = undefined;
		this.pendingKey.set(false);
		this.renderStore.clear();
		this.editor.changeViewZones(accessor => {
			for (const id of this.viewZones) {
				accessor.removeZone(id);
			}
		});
		this.viewZones = [];
		this.zoneHeights = [];
		this.hunkRanges.clear();
		this.visuals.clear();
		this.hunkWidget = undefined;
		this.fileBar = undefined;
		this.activeIndex = -1;
		this.hoverIndex = -1;
	}

	private render(file: IAgentPendingFile): void {
		const baseline = this.edits.getBaselineModel(file.uri);
		const model = this.editor.getModel();
		if (!baseline || !model) {
			this.clear();
			return;
		}
		const createdFile = file.kind === 'added';
		const overview = (ruler: string, minimap: string) => ModelDecorationOptions.createDynamic({
			description: 'volt-agent-edit-overview',
			overviewRuler: { color: themeColorFromId(ruler), position: OverviewRulerLane.Left },
			minimap: { color: themeColorFromId(minimap), position: MinimapPosition.Gutter },
		});
		const added = overview(overviewRulerAddedForeground, minimapGutterAddedBackground);
		const modifiedDeco = overview(overviewRulerModifiedForeground, minimapGutterModifiedBackground);
		const deleted = overview(overviewRulerDeletedForeground, minimapGutterDeletedBackground);
		const charAdd = ModelDecorationOptions.createDynamic({ ...diffAddDecoration, stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges });
		const lineAdd = ModelDecorationOptions.createDynamic({ ...diffWholeLineAddDecoration, stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges });

		const ranges: IModelDeltaDecoration[] = [];
		const visuals: IModelDeltaDecoration[] = [];
		const lineCount = model.getLineCount();
		this.zoneHeights = [];
		this.editor.changeViewZones(accessor => {
			for (const id of this.viewZones) {
				accessor.removeZone(id);
			}
			this.viewZones = [];
			const renderOptions = RenderOptions.fromEditor(this.editor);
			for (const change of file.changes) {
				ranges.push({
					range: change.modified.toInclusiveRange() ?? new Range(change.modified.startLineNumber, 1, change.modified.startLineNumber, Number.MAX_SAFE_INTEGER),
					options: hunkRangeDecoration,
				});
				if (!change.modified.isEmpty) {
					visuals.push({ range: change.modified.toInclusiveRange()!, options: lineAdd });
					for (const inner of change.innerChanges ?? []) {
						if (!inner.modifiedRange.isEmpty() && !(createdFile && inner.modifiedRange.endLineNumber >= lineCount)) {
							visuals.push({ range: inner.modifiedRange, options: charAdd });
						}
					}
				}
				visuals.push(change.original.isEmpty
					? { range: change.modified.toInclusiveRange()!, options: added }
					: change.modified.isEmpty
						? { range: new Range(Math.max(1, change.modified.startLineNumber - 1), 1, change.modified.startLineNumber, 1), options: deleted }
						: { range: change.modified.toInclusiveRange()!, options: modifiedDeco });

				let height = 0;
				if (!change.original.isEmpty && !createdFile) {
					const original = change.original;
					baseline.tokenization.forceTokenization(Math.max(1, original.endLineNumberExclusive - 1));
					const source = new LineSource(
						original.mapToLineArray(line => baseline.tokenization.getLineTokens(line)),
						[],
						baseline.mightContainNonBasicASCII(),
						baseline.mightContainRTL(),
					);
					const decorations = (change.innerChanges ?? []).map(inner => new InlineDecoration(
						inner.originalRange.delta(-(original.startLineNumber - 1)),
						diffDeleteDecoration.className!,
						InlineDecorationType.Regular,
					));
					const domNode = document.createElement('div');
					domNode.className = 'volt-agent-edit-removed view-lines line-delete monaco-mouse-cursor-text';
					const result = renderLines(source, renderOptions, decorations, domNode);
					height = result.heightInLines;
					const zone: IViewZone = {
						afterLineNumber: change.modified.startLineNumber - 1,
						heightInLines: result.heightInLines,
						domNode,
						ordinal: 50002,
					};
					this.viewZones.push(accessor.addZone(zone));
				}
				this.zoneHeights.push(height);
			}
		});
		this.hunkRanges.set(ranges);
		this.visuals.set(visuals);

		this.renderStore.clear();
		this.hunkWidget = this.renderStore.add(new HunkWidget(this.editor, this, this.keybindingService));
		this.fileBar = this.renderStore.add(new FileBarWidget(this.editor, this, this.keybindingService));
		this.activeIndex = -1;
		this.syncActive();
		if (this.activeIndex < 0) {
			this.activeIndex = 0;
		}
		this.layoutHunkWidget();
		this.fileBar.render();
	}

	private layoutHunkWidget(): void {
		const widget = this.hunkWidget;
		if (!widget) {
			return;
		}
		const index = this.currentIndex();
		const range = this.sortedRanges()[index];
		if (!range) {
			widget.hide();
			return;
		}
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		// Sit on the first line of the hunk, above the removed lines when there are any.
		const top = this.editor.getTopForLineNumber(range.startLineNumber) - this.editor.getScrollTop() - (this.zoneHeights[index] ?? 0) * lineHeight;
		widget.show(index, this.hunkCount(), top);
	}
}

class HunkWidget extends Disposable implements IOverlayWidget {

	static readonly ID = 'volt.agentEdits.hunk';

	private readonly domNode: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly undoKeys: HTMLElement;
	private readonly keepKeys: HTMLElement;
	private position: IOverlayWidgetPosition | null = null;

	constructor(
		private readonly editor: ICodeEditor,
		controller: AgentEditsEditorController,
		private readonly keybindingService: IKeybindingService,
	) {
		super();
		this.domNode = $('.volt-agent-edit-hunk');
		const nav = append(this.domNode, $('.volt-agent-edit-nav'));
		const up = append(nav, $('button.volt-agent-edit-icon')) as HTMLButtonElement;
		up.appendChild(renderIcon(Codicon.chevronUp));
		up.title = localize('voltAgent.edits.previousChange', "Previous change");
		this.countEl = append(nav, $('span.volt-agent-edit-count'));
		const down = append(nav, $('button.volt-agent-edit-icon')) as HTMLButtonElement;
		down.appendChild(renderIcon(Codicon.chevronDown));
		down.title = localize('voltAgent.edits.nextChange', "Next change");
		const undo = append(this.domNode, $('button.volt-agent-edit-button.undo')) as HTMLButtonElement;
		append(undo, $('span')).textContent = localize('voltAgent.edits.undo', "Undo");
		this.undoKeys = append(undo, $('span.volt-agent-edit-keys'));
		const keep = append(this.domNode, $('button.volt-agent-edit-button.keep')) as HTMLButtonElement;
		append(keep, $('span')).textContent = localize('voltAgent.edits.keep', "Keep");
		this.keepKeys = append(keep, $('span.volt-agent-edit-keys'));
		this.refreshLabels();
		const click = (el: HTMLElement, run: () => void) => this._register(addDisposableListener(el, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
		click(up, () => controller.revealHunk(-1));
		click(down, () => controller.revealHunk(1));
		click(undo, () => void controller.undoHunk());
		click(keep, () => void controller.keepHunk());
		this.editor.addOverlayWidget(this);
	}

	override dispose(): void {
		this.editor.removeOverlayWidget(this);
		super.dispose();
	}

	refreshLabels(): void {
		this.undoKeys.textContent = keyLabel(this.keybindingService, UNDO_HUNK_ID);
		this.keepKeys.textContent = keyLabel(this.keybindingService, KEEP_HUNK_ID);
	}

	getId(): string {
		return HunkWidget.ID;
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this.position;
	}

	show(index: number, total: number, top: number): void {
		this.countEl.textContent = localize('voltAgent.edits.hunkCount', "{0} of {1}", index + 1, total);
		this.domNode.classList.add('visible');
		const { contentLeft, contentWidth, verticalScrollbarWidth } = this.editor.getLayoutInfo();
		const height = this.editor.getOption(EditorOption.lineHeight);
		const left = contentLeft + contentWidth - verticalScrollbarWidth - getTotalWidth(this.domNode) - 12;
		this.position = { preference: { top: Math.max(0, top - height - 4), left: Math.max(contentLeft, left) }, stackOridinal: 1 };
		this.editor.layoutOverlayWidget(this);
	}

	hide(): void {
		this.domNode.classList.remove('visible');
		this.position = null;
		this.editor.layoutOverlayWidget(this);
	}
}

class FileBarWidget extends Disposable implements IOverlayWidget {

	static readonly ID = 'volt.agentEdits.fileBar';

	private readonly domNode: HTMLElement;
	private readonly hunkCountEl: HTMLElement;
	private readonly fileCountEl: HTMLElement;
	private readonly fileNav: HTMLElement;
	private readonly keepKeys: HTMLElement;
	private position: IOverlayWidgetPosition | null = null;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly controller: AgentEditsEditorController,
		private readonly keybindingService: IKeybindingService,
	) {
		super();
		this.domNode = $('.volt-agent-edit-filebar');
		const hunkNav = append(this.domNode, $('.volt-agent-edit-nav'));
		const up = append(hunkNav, $('button.volt-agent-edit-icon')) as HTMLButtonElement;
		up.appendChild(renderIcon(Codicon.chevronUp));
		up.title = localize('voltAgent.edits.previousChange', "Previous change");
		this.hunkCountEl = append(hunkNav, $('span.volt-agent-edit-count'));
		const down = append(hunkNav, $('button.volt-agent-edit-icon')) as HTMLButtonElement;
		down.appendChild(renderIcon(Codicon.chevronDown));
		down.title = localize('voltAgent.edits.nextChange', "Next change");
		append(this.domNode, $('span.volt-agent-edit-divider'));
		this.fileNav = append(this.domNode, $('.volt-agent-edit-nav.files'));
		const prev = append(this.fileNav, $('button.volt-agent-edit-icon')) as HTMLButtonElement;
		prev.appendChild(renderIcon(Codicon.chevronLeft));
		prev.title = localize('voltAgent.edits.previousFile', "Previous file");
		this.fileCountEl = append(this.fileNav, $('span.volt-agent-edit-count'));
		const next = append(this.fileNav, $('button.volt-agent-edit-icon')) as HTMLButtonElement;
		next.appendChild(renderIcon(Codicon.chevronRight));
		next.title = localize('voltAgent.edits.nextFile', "Next file");
		const undo = append(this.domNode, $('button.volt-agent-edit-button.undo')) as HTMLButtonElement;
		append(undo, $('span')).textContent = localize('voltAgent.edits.undoFile', "Undo File");
		const keep = append(this.domNode, $('button.volt-agent-edit-button.keep')) as HTMLButtonElement;
		append(keep, $('span')).textContent = localize('voltAgent.edits.keepFile', "Keep File");
		this.keepKeys = append(keep, $('span.volt-agent-edit-keys'));
		const click = (el: HTMLElement, run: () => void) => this._register(addDisposableListener(el, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
		click(up, () => controller.revealHunk(-1));
		click(down, () => controller.revealHunk(1));
		click(prev, () => void controller.revealFile(-1));
		click(next, () => void controller.revealFile(1));
		click(undo, () => void controller.undoFile());
		click(keep, () => void controller.keepFile());
		this.editor.addOverlayWidget(this);
	}

	override dispose(): void {
		this.editor.removeOverlayWidget(this);
		super.dispose();
	}

	getId(): string {
		return FileBarWidget.ID;
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this.position;
	}

	render(): void {
		const total = this.controller.hunkCount();
		const index = Math.max(0, this.controller.currentIndex());
		this.hunkCountEl.textContent = localize('voltAgent.edits.hunkCount', "{0} of {1}", Math.min(index + 1, total), total);
		const files = this.controller.fileIndex();
		this.fileNav.classList.toggle('hidden', files.total <= 1);
		this.fileCountEl.textContent = localize('voltAgent.edits.fileCount', "{0} of {1} Files", files.index + 1, files.total);
		this.keepKeys.textContent = keyLabel(this.keybindingService, KEEP_FILE_ID);
		this.layout();
	}

	layout(): void {
		const { contentLeft, contentWidth, verticalScrollbarWidth } = this.editor.getLayoutInfo();
		const left = contentLeft + contentWidth - verticalScrollbarWidth - getTotalWidth(this.domNode) - 12;
		this.position = { preference: { top: 6, left: Math.max(contentLeft, left) }, stackOridinal: 2 };
		this.editor.layoutOverlayWidget(this);
	}
}

/** Compact shortcut text for a button, e.g. "⌘⏎" rather than "⌘Enter". */
function keyLabel(keybindingService: IKeybindingService, commandId: string): string {
	const label = keybindingService.lookupKeybinding(commandId)?.getLabel() ?? '';
	// allow-any-unicode-next-line
	return isMacintosh ? label.replace(/Enter$/, '⏎') : label;
}

registerEditorContribution(AgentEditsEditorController.ID, AgentEditsEditorController, EditorContributionInstantiation.AfterFirstRender);

function controllerFor(accessor: ServicesAccessor): AgentEditsEditorController | null {
	const codeEditorService = accessor.get(ICodeEditorService);
	const editor = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
	return editor ? AgentEditsEditorController.get(editor) : null;
}

const WHEN_PENDING = ContextKeyExpr.and(CTX_AGENT_EDITS_PENDING, EditorContextKeys.focus);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: KEEP_HUNK_ID,
			title: localize2('voltAgent.edits.keepHunk', "Keep Agent Change"),
			f1: true,
			precondition: CTX_AGENT_EDITS_PENDING,
			keybinding: { when: WHEN_PENDING, weight: KeybindingWeight.WorkbenchContrib + 2, primary: KeyMod.CtrlCmd | KeyCode.KeyY },
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> | void {
		return controllerFor(accessor)?.keepHunk();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: UNDO_HUNK_ID,
			title: localize2('voltAgent.edits.undoHunk', "Undo Agent Change"),
			f1: true,
			precondition: CTX_AGENT_EDITS_PENDING,
			keybinding: { when: WHEN_PENDING, weight: KeybindingWeight.WorkbenchContrib + 2, primary: KeyMod.CtrlCmd | KeyCode.KeyN },
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> | void {
		return controllerFor(accessor)?.undoHunk();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: KEEP_FILE_ID,
			title: localize2('voltAgent.edits.keepFileTitle', "Keep Agent Changes in File"),
			f1: true,
			precondition: CTX_AGENT_EDITS_PENDING,
			keybinding: { when: WHEN_PENDING, weight: KeybindingWeight.WorkbenchContrib + 2, primary: KeyMod.CtrlCmd | KeyCode.Enter },
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> | void {
		return controllerFor(accessor)?.keepFile();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: UNDO_FILE_ID,
			title: localize2('voltAgent.edits.undoFileTitle', "Undo Agent Changes in File"),
			f1: true,
			precondition: CTX_AGENT_EDITS_PENDING,
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> | void {
		return controllerFor(accessor)?.undoFile();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: NEXT_HUNK_ID,
			title: localize2('voltAgent.edits.nextHunk', "Go to Next Agent Change"),
			f1: true,
			precondition: CTX_AGENT_EDITS_PENDING,
			keybinding: { when: WHEN_PENDING, weight: KeybindingWeight.WorkbenchContrib + 2, primary: KeyMod.Alt | KeyCode.F5 },
		});
	}
	override run(accessor: ServicesAccessor): void {
		controllerFor(accessor)?.revealHunk(1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PREVIOUS_HUNK_ID,
			title: localize2('voltAgent.edits.previousHunk', "Go to Previous Agent Change"),
			f1: true,
			precondition: CTX_AGENT_EDITS_PENDING,
			keybinding: { when: WHEN_PENDING, weight: KeybindingWeight.WorkbenchContrib + 2, primary: KeyMod.Alt | KeyMod.Shift | KeyCode.F5 },
		});
	}
	override run(accessor: ServicesAccessor): void {
		controllerFor(accessor)?.revealHunk(-1);
	}
});
