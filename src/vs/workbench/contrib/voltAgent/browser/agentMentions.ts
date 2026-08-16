/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, DragAndDropObserver, getDomNodePagePosition, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { extractEditorsDropData } from '../../../../platform/dnd/browser/dnd.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { searchFilesAndFolders } from '../../search/browser/searchChatContext.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { appendAgentScrollableList } from './agentScrollable.js';

export type AgentMentionKind = 'file' | 'folder' | 'terminal' | 'chat' | 'branch' | 'browser' | 'image';

export interface IAgentImagePayload {
	id: string;
	mime: string;
	bytes: Uint8Array;
}

export interface IAgentMention {
	id: string;
	kind: AgentMentionKind;
	label: string;
	decorationId?: string;
	resource?: URI;
	range?: { startLineNumber: number; endLineNumber: number };
	image?: IAgentImagePayload;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function chipText(label: string): string {
	return label;
}

function truncateLabel(name: string, max = 22): string {
	return name.length <= max ? name : `${name.slice(0, Math.max(0, max - 3))}...`;
}

function isImageUri(resource: URI): boolean {
	const ext = basename(resource.path).split('.').pop()?.toLowerCase() ?? '';
	return IMAGE_EXTS.has(ext);
}

export class AgentMentionController extends Disposable {

	private readonly mentions: IAgentMention[] = [];
	private readonly mentionCatalog: IAgentMention[] = [];
	private imageCount = 0;
	private mentionMenuOpen = false;
	private searchCts: CancellationTokenSource | undefined;
	private lastDropAt = 0;
	private hoveredMentionId: string | undefined;
	private insertingMention = false;

	constructor(
		private readonly editor: ICodeEditor,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHistoryService private readonly historyService: IHistoryService,
		@ILabelService private readonly labelService: ILabelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();
		this.registerListeners();
	}

	bindDropTarget(target: HTMLElement): void {
		this._register(new DragAndDropObserver(target, {
			onDragEnter: e => this.onDragHover(e, target, true),
			onDragOver: e => this.onDragHover(e, target, true),
			onDragLeave: () => target.classList.remove('drop-target'),
			onDrop: e => {
				e.preventDefault();
				e.stopPropagation();
				target.classList.remove('drop-target');
				void this.handleExternalDrop(e);
			}
		}));
	}

	handleExternalDrop(e: DragEvent): Promise<void> {
		return this.handleDrop(e, this.editor.getTargetAtClientPoint(e.clientX, e.clientY)?.position ?? this.editor.getPosition() ?? undefined);
	}

	getImages(): IAgentImagePayload[] {
		return this.mentions.filter(m => m.image).map(m => m.image!);
	}

	clear(): void {
		const model = this.editor.getModel();
		const oldIds = this.mentions.map(mention => mention.decorationId).filter((id): id is string => !!id);
		this.mentions.length = 0;
		this.mentionCatalog.length = 0;
		this.imageCount = 0;
		if (model && oldIds.length) {
			model.deltaDecorations(oldIds, []);
		}
	}

	addResourceMention(resource: URI, range?: { startLineNumber: number; endLineNumber: number }): void {
		const insertRange = this.cursorRangeAfterSpacer();
		if (!insertRange) {
			return;
		}
		const start = range?.startLineNumber;
		const end = range?.endLineNumber;
		const rangeLabel = start && end
			? (start === end ? `${start}` : `${start}-${end}`)
			: undefined;
		const name = basename(resource.path) || resource.path;
		this.insertMention({
			id: `${resource.toString()}:${rangeLabel ?? 'file'}:${generateUuid()}`,
			kind: 'file',
			label: rangeLabel ? `${truncateLabel(name)} (${rangeLabel})` : truncateLabel(name),
			resource,
			range: start && end ? { startLineNumber: start, endLineNumber: end } : undefined,
		}, insertRange);
	}

	async addResourceMentions(resources: readonly URI[]): Promise<void> {
		for (const resource of resources) {
			if (this.hasWholeResourceMention(resource)) {
				continue;
			}
			const insertRange = this.cursorRangeAfterSpacer();
			if (!insertRange) {
				return;
			}
			await this.insertResource(resource, insertRange);
		}
	}

	private hasWholeResourceMention(resource: URI): boolean {
		return this.mentions.some(mention => !mention.range && mention.resource?.toString() === resource.toString());
	}

	/**
	 * Chips must not be glued to preceding text, so pad the cursor with a space when needed.
	 */
	private cursorRangeAfterSpacer(): IRange | undefined {
		const model = this.editor.getModel();
		if (!model) {
			return undefined;
		}
		const position = this.editor.getPosition() ?? model.getFullModelRange().getEndPosition();
		let startColumn = position.column;
		if (startColumn > 1) {
			const before = model.getValueInRange({
				startLineNumber: position.lineNumber,
				startColumn: startColumn - 1,
				endLineNumber: position.lineNumber,
				endColumn: startColumn,
			});
			if (before && before !== ' ' && before !== '\t') {
				this.editor.executeEdits('volt-agent-mention-space', [{
					range: {
						startLineNumber: position.lineNumber,
						startColumn,
						endLineNumber: position.lineNumber,
						endColumn: startColumn,
					},
					text: ' ',
				}]);
				startColumn += 1;
			}
		}
		return {
			startLineNumber: position.lineNumber,
			startColumn,
			endLineNumber: position.lineNumber,
			endColumn: startColumn,
		};
	}

	get isMenuOpen(): boolean {
		return this.mentionMenuOpen;
	}

	openFilePicker(): void {
		const range = this.getAtQuery()?.range ?? this.cursorRange();
		this.showMentionMenu(range, '', 'files');
	}

	private registerListeners(): void {
		const domNode = this.editor.getDomNode();
		if (domNode) {
			domNode.classList.add('show-file-icons');
			this._register(addDisposableListener(domNode, 'paste', e => this.handlePaste(e)));
			this._register(addDisposableListener(domNode, 'copy', e => this.handleCopy(e)));
			this._register(addDisposableListener(domNode, 'cut', e => this.handleCopy(e)));
		}

		this._register(this.editor.onDropIntoEditor(e => {
			e.event.preventDefault();
			e.event.stopPropagation();
			void this.handleDrop(e.event, e.position);
		}));

		this._register(this.editor.onMouseMove(e => this.setHoveredMention(this.mentionFromMouse(e))));
		this._register(this.editor.onMouseLeave(() => this.setHoveredMention(undefined)));

		this._register(this.editor.onMouseDown(e => {
			if (!e.event.leftButton) {
				return;
			}
			const mention = this.mentionFromMouse(e);
			if (mention && this.isMentionIconTarget(e)) {
				e.event.preventDefault();
				e.event.stopPropagation();
				this.removeMention(mention);
			}
		}));

		this._register(this.editor.onMouseUp(e => {
			if (!e.event.leftButton || e.event.detail > 1) {
				return;
			}
			const mention = this.mentionFromMouse(e);
			if (!mention || this.isMentionIconTarget(e)) {
				return;
			}
			if (this.editor.getSelection() && !this.editor.getSelection()?.isEmpty()) {
				return;
			}
			if (mention.kind === 'file' || mention.kind === 'folder' || mention.kind === 'image') {
				void this.openMention(mention);
			}
		}));

		this._register(this.editor.onDidChangeModelContent(() => {
			this.syncMentionRanges();
			this.maybeShowMentionMenu();
		}));

		this._register(this.editor.onKeyDown(e => {
			if (e.keyCode === KeyCode.Backspace || e.keyCode === KeyCode.Delete) {
				this.tryDeleteMention(e, e.keyCode === KeyCode.Delete);
			}
		}));
	}

	private onDragHover(e: DragEvent, target: HTMLElement, hovering: boolean): void {
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'copy';
		}
		target.classList.toggle('drop-target', hovering);
	}

	private findMentionAt(position: IPosition): IAgentMention | undefined {
		const model = this.editor.getModel();
		if (!model) {
			return undefined;
		}
		for (const mention of this.mentions) {
			if (!mention.decorationId) {
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (range && Range.containsPosition(range, position)) {
				return mention;
			}
		}
		return undefined;
	}

	private async openMention(mention: IAgentMention): Promise<void> {
		let resource = mention.resource;
		if (!resource && mention.image) {
			const subtype = mention.image.mime.split('/')[1] || 'png';
			const ext = subtype === 'jpeg' ? 'jpg' : subtype;
			resource = joinPath(this.environmentService.cacheHome, 'volt-agent-images', `${mention.image.id}.${ext}`);
			await this.fileService.writeFile(resource, VSBuffer.wrap(mention.image.bytes));
			mention.resource = resource;
		}
		if (!resource) {
			return;
		}
		if (mention.kind === 'folder') {
			await this.commandService.executeCommand('revealInExplorer', resource);
			return;
		}
		await this.editorService.openEditor({ resource, options: { pinned: true, revealIfOpened: true } });
	}

	private cursorRange(): IRange {
		const pos = this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
		return { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column };
	}

	private getAtQuery(): { query: string; range: IRange } | undefined {
		const model = this.editor.getModel();
		const pos = this.editor.getPosition();
		if (!model || !pos) {
			return undefined;
		}
		const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
		const match = before.match(/(^|[\s])(@[^\s]*)$/);
		if (!match) {
			return undefined;
		}
		const token = match[2];
		const startColumn = pos.column - token.length;
		return {
			query: token.slice(1),
			range: { startLineNumber: pos.lineNumber, startColumn, endLineNumber: pos.lineNumber, endColumn: pos.column }
		};
	}

	private maybeShowMentionMenu(): void {
		const at = this.getAtQuery();
		if (!at) {
			if (this.mentionMenuOpen) {
				this.contextViewService.hideContextView();
				this.mentionMenuOpen = false;
			}
			return;
		}
		this.showMentionMenu(at.range, at.query, at.query ? 'files' : 'root');
	}

	private showMentionMenu(replaceRange: IRange, query: string, view: 'root' | 'files' | 'terminals' | 'chats'): void {
		this.mentionMenuOpen = true;
		this.contextViewService.showContextView({
			getAnchor: () => this.getCursorAnchor(),
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: this.mentionMenuAnchorPosition(),
			onDOMEvent: (e: Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const viewEl = this.contextViewService.getContextViewElement();
				if (viewEl.contains(e.target)) {
					return;
				}
				this.mentionMenuOpen = false;
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-agent-dropdown.mentions.show-file-icons'));
				if (view === 'root') {
					this.renderRootMenu(store, menu, replaceRange);
				} else if (view === 'files') {
					this.renderFileMenu(store, menu, replaceRange, query);
				} else if (view === 'terminals') {
					this.renderTerminalMenu(store, menu, replaceRange);
				} else {
					this.renderChatMenu(store, menu, replaceRange);
				}
				store.add(addDisposableListener(getWindow(menu).document, 'mousedown', e => {
					if (e.target instanceof Node && !menu.contains(e.target)) {
						this.mentionMenuOpen = false;
						this.contextViewService.hideContextView();
					}
				}, true));
				store.add(toDisposable(() => {
					menu.remove();
					this.mentionMenuOpen = false;
				}));
				return store;
			}
		});
	}

	private getCursorAnchor(): { x: number; y: number; width: number; height: number } {
		const pos = this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
		const visible = this.editor.getScrolledVisiblePosition(pos);
		const node = this.editor.getDomNode();
		if (!visible || !node) {
			return { x: 0, y: 0, width: 1, height: 1 };
		}
		const page = getDomNodePagePosition(node);
		return {
			x: page.left + visible.left,
			y: page.top + visible.top,
			width: 1,
			height: visible.height
		};
	}

	private mentionMenuAnchorPosition(): AnchorPosition {
		const anchor = this.getCursorAnchor();
		const node = this.editor.getDomNode();
		const spaceBelow = node ? getWindow(node).innerHeight - (anchor.y + anchor.height) : 0;
		return spaceBelow < 320 ? AnchorPosition.ABOVE : AnchorPosition.BELOW;
	}

	private renderRootMenu(store: DisposableStore, menu: HTMLElement, replaceRange: IRange): void {
		const items: { label: string; icon: typeof Codicon.folder; view?: 'files' | 'terminals' | 'chats'; kind?: AgentMentionKind }[] = [
			{ label: localize('voltAgent.mention.files', "Files & Folders"), icon: Codicon.folder, view: 'files' },
			{ label: localize('voltAgent.mention.terminals', "Terminals"), icon: Codicon.terminal, view: 'terminals' },
			{ label: localize('voltAgent.mention.chats', "Past Chats"), icon: Codicon.commentDiscussion, view: 'chats' },
			{ label: localize('voltAgent.mention.branch', "Branch (Diff with Main)"), icon: Codicon.gitBranch, kind: 'branch' },
			{ label: localize('voltAgent.mention.browser', "Browser"), icon: Codicon.globe, kind: 'browser' },
		];
		const { list, scroll } = appendAgentScrollableList(menu);
		store.add(scroll);
		for (const item of items) {
			const button = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
			const icon = append(button, $('span.icon'));
			icon.appendChild(renderIcon(item.icon));
			append(button, $('span.label')).textContent = item.label;
			if (item.view) {
				// allow-any-unicode-next-line
				append(button, $('span.meta')).textContent = '›';
			}
			store.add(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				if (item.view) {
					this.showMentionMenu(replaceRange, '', item.view);
					return;
				}
				this.insertMention({
					id: generateUuid(),
					kind: item.kind ?? 'browser',
					label: item.kind === 'branch' ? 'Branch' : 'Browser',
				}, replaceRange);
				this.contextViewService.hideContextView();
			}));
		}
		scroll.scanDomNode();
	}

	private renderFileMenu(store: DisposableStore, menu: HTMLElement, replaceRange: IRange, query: string): void {
		const searchRow = append(menu, $('.volt-agent-dropdown-search-row'));
		const search = append(searchRow, $('input.volt-agent-dropdown-search')) as HTMLInputElement;
		search.placeholder = localize('voltAgent.mention.searchFiles', "Search files and folders");
		search.value = query;
		const { list, scroll } = appendAgentScrollableList(menu);
		store.add(scroll);
		const render = async (needle: string) => {
			list.replaceChildren();
			const results = await this.collectFiles(needle);
			if (!results.length) {
				append(list, $('.volt-agent-dropdown-empty')).textContent = localize('voltAgent.mention.noFiles', "No matching files");
				scroll.scanDomNode();
				return;
			}
			for (const result of results) {
				const button = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
				const icon = append(button, $('span.icon.file-icon'));
				icon.classList.add(...getIconClasses(this.modelService, this.languageService, result.resource, result.kind));
				append(button, $('span.label')).textContent = result.label;
				append(button, $('span.qualifier')).textContent = result.detail;
				store.add(addDisposableListener(button, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.insertResource(result.resource, replaceRange);
					this.contextViewService.hideContextView();
				}));
			}
			scroll.scanDomNode();
		};
		void render(query).then(() => {
			scroll.scanDomNode();
			this.contextViewService.layout();
		});
		store.add(addDisposableListener(search, 'input', () => void render(search.value).then(() => {
			scroll.scanDomNode();
			this.contextViewService.layout();
		})));
		store.add(addDisposableListener(search, 'mousedown', e => e.stopPropagation()));
		setTimeout(() => search.focus(), 0);
	}

	private renderTerminalMenu(store: DisposableStore, menu: HTMLElement, replaceRange: IRange): void {
		const instances = this.terminalService.instances;
		if (!instances.length) {
			append(menu, $('.volt-agent-dropdown-empty')).textContent = localize('voltAgent.mention.noTerminals', "No open terminals");
			return;
		}
		const { list, scroll } = appendAgentScrollableList(menu);
		store.add(scroll);
		for (const instance of instances) {
			const button = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
			append(button, $('span.icon')).appendChild(renderIcon(Codicon.terminal));
			append(button, $('span.label')).textContent = truncateLabel(instance.title);
			store.add(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.insertMention({
					id: generateUuid(),
					kind: 'terminal',
					label: truncateLabel(instance.title),
					resource: instance.resource,
				}, replaceRange);
				this.contextViewService.hideContextView();
			}));
		}
		scroll.scanDomNode();
	}

	private renderChatMenu(store: DisposableStore, menu: HTMLElement, replaceRange: IRange): void {
		append(menu, $('.volt-agent-dropdown-empty')).textContent = localize('voltAgent.mention.noChats', "No past chats yet");
	}

	private async collectFiles(query: string): Promise<{ resource: URI; label: string; detail: string; kind: FileKind }[]> {
		const seen = new Set<string>();
		const out: { resource: URI; label: string; detail: string; kind: FileKind }[] = [];
		const add = (resource: URI, kind: FileKind) => {
			const key = resource.toString();
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			out.push({
				resource,
				label: basename(resource.path) || resource.path,
				detail: this.labelService.getUriLabel(resource, { relative: true }),
				kind
			});
		};

		for (const item of this.historyService.getHistory()) {
			const resource = EditorResourceAccessor.getOriginalUri(item);
			if (resource && (!query || basename(resource.path).toLowerCase().includes(query.toLowerCase()))) {
				add(resource, FileKind.FILE);
			}
		}

		this.searchCts?.cancel();
		this.searchCts = new CancellationTokenSource();
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (query && folders.length) {
			try {
				const result = await searchFilesAndFolders(folders[0].uri, query, true, this.searchCts.token, undefined, this.configurationService, this.searchService);
				for (const folder of result.folders) {
					add(folder, FileKind.FOLDER);
				}
				for (const file of result.files) {
					add(file, FileKind.FILE);
				}
			} catch {
				// ignore cancelled / failed search
			}
		}

		return out.slice(0, 30);
	}

	private async insertResource(resource: URI, replaceRange: IRange): Promise<void> {
		if (isImageUri(resource)) {
			await this.insertImageFromUri(resource, replaceRange);
			return;
		}
		let kind: AgentMentionKind = 'file';
		try {
			const stat = await this.fileService.stat(resource);
			kind = stat.isDirectory ? 'folder' : 'file';
		} catch {
			kind = 'file';
		}
		this.insertMention({
			id: resource.toString(),
			kind,
			label: truncateLabel(basename(resource.path) || resource.path),
			resource,
		}, replaceRange);
	}

	private async insertImageFromUri(resource: URI, replaceRange: IRange): Promise<void> {
		try {
			const file = await this.fileService.readFile(resource);
			this.insertImage(file.value.buffer, this.mimeFor(resource), replaceRange, resource);
		} catch {
			this.insertMention({
				id: resource.toString(),
				kind: 'file',
				label: truncateLabel(basename(resource.path)),
				resource,
			}, replaceRange);
		}
	}

	private insertImage(bytes: Uint8Array, mime: string, replaceRange: IRange, resource?: URI): void {
		this.imageCount += 1;
		const id = `Image${this.imageCount}`;
		this.insertMention({
			id,
			kind: 'image',
			label: resource ? truncateLabel(basename(resource.path)) : id,
			resource,
			image: { id, mime, bytes },
		}, replaceRange);
	}

	private mimeFor(resource: URI): string {
		const ext = basename(resource.path).split('.').pop()?.toLowerCase();
		if (ext === 'jpg' || ext === 'jpeg') {
			return 'image/jpeg';
		}
		if (ext === 'svg') {
			return 'image/svg+xml';
		}
		return ext ? `image/${ext}` : 'image/png';
	}

	private insertMention(mention: IAgentMention, replaceRange: IRange): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const text = `${chipText(mention.label)} `;
		this.insertingMention = true;
		try {
			this.editor.executeEdits('volt-agent-mention', [{
				range: Range.lift(replaceRange),
				text,
			}]);
			const start = { lineNumber: replaceRange.startLineNumber, column: replaceRange.startColumn };
			const endColumn = start.column + chipText(mention.label).length;
			this.addDecoration(mention, {
				startLineNumber: start.lineNumber,
				startColumn: start.column,
				endLineNumber: start.lineNumber,
				endColumn
			});
			this.mentions.push(mention);
			this.mentionCatalog.push(mention);
			this.editor.setPosition({ lineNumber: start.lineNumber, column: endColumn + 1 });
			this.editor.focus();
		} finally {
			this.insertingMention = false;
		}
	}

	private addDecoration(mention: IAgentMention, range: IRange): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const oldIds = mention.decorationId ? [mention.decorationId] : [];
		const [pillId] = model.deltaDecorations(oldIds, this.decorationsFor(mention, range));
		mention.decorationId = pillId;
	}

	private decorationsFor(mention: IAgentMention, range: IRange): IModelDeltaDecoration[] {
		const hovered = this.hoveredMentionId === mention.id;
		const hoverClass = hovered ? ' hovered' : '';
		return [
			{
				range,
				options: {
					description: 'volt-agent-mention',
					inlineClassName: `volt-agent-mention-pill ${mention.kind}${hoverClass}`,
					inlineClassNameAffectsLetterSpacing: true,
					before: {
						content: '\u00a0',
						inlineClassName: `volt-agent-mention-icon ${mention.kind}${hoverClass} ${this.iconClassesFor(mention).join(' ')}`,
						inlineClassNameAffectsLetterSpacing: true,
						attachedData: { mentionId: mention.id },
					},
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					hoverMessage: this.hoverFor(mention),
				}
			}
		];
	}

	private iconClassesFor(mention: IAgentMention): string[] {
		if (mention.kind === 'folder') {
			return getIconClasses(this.modelService, this.languageService, mention.resource, FileKind.FOLDER);
		}
		if (mention.kind === 'file' || (mention.kind === 'image' && mention.resource)) {
			return getIconClasses(this.modelService, this.languageService, mention.resource, FileKind.FILE);
		}
		const icon = mention.kind === 'image' ? Codicon.fileMedia
			: mention.kind === 'terminal' ? Codicon.terminal
				: mention.kind === 'chat' ? Codicon.commentDiscussion
					: mention.kind === 'branch' ? Codicon.gitBranch
						: Codicon.globe;
		return ['codicon', `codicon-${icon.id}`];
	}

	private mentionFromMouse(e: IEditorMouseEvent): IAgentMention | undefined {
		const attached = e.target.type === MouseTargetType.CONTENT_TEXT
			? (e.target.detail.injectedText?.options.attachedData as { mentionId?: string } | undefined)?.mentionId
			: undefined;
		if (attached) {
			const fromData = this.mentions.find(mention => mention.id === attached);
			if (fromData) {
				return fromData;
			}
		}
		if (e.target.element && this.elementHasMentionIcon(e.target.element)) {
			return this.mentions.find(mention => mention.id === this.hoveredMentionId)
				?? (e.target.position ? this.findMentionAt(e.target.position) : undefined);
		}
		if (e.target.position) {
			return this.findMentionAt(e.target.position);
		}
		return this.mentions.find(mention => mention.id === this.hoveredMentionId);
	}

	private isMentionIconTarget(e: IEditorMouseEvent): boolean {
		return !!e.target.element && this.elementHasMentionIcon(e.target.element);
	}

	private elementHasMentionIcon(element: HTMLElement): boolean {
		let current: HTMLElement | null = element;
		while (current) {
			if (current.classList.contains('volt-agent-mention-icon')) {
				return true;
			}
			current = current.parentElement;
		}
		return false;
	}

	private setHoveredMention(mention: IAgentMention | undefined): void {
		const next = mention?.id;
		if (this.hoveredMentionId === next) {
			return;
		}
		const previous = this.mentions.find(item => item.id === this.hoveredMentionId);
		this.hoveredMentionId = next;
		if (previous) {
			this.refreshMentionDecoration(previous);
		}
		if (mention) {
			this.refreshMentionDecoration(mention);
		}
	}

	private refreshMentionDecoration(mention: IAgentMention): void {
		const model = this.editor.getModel();
		if (!model || !mention.decorationId) {
			return;
		}
		const range = model.getDecorationRange(mention.decorationId);
		if (!range) {
			return;
		}
		this.addDecoration(mention, range);
	}

	private removeMention(mention: IAgentMention): void {
		const model = this.editor.getModel();
		if (!model || !mention.decorationId) {
			return;
		}
		const range = model.getDecorationRange(mention.decorationId);
		if (!range) {
			return;
		}
		let deleteRange: IRange = range;
		if (model.getValueInRange({
			startLineNumber: range.endLineNumber,
			startColumn: range.endColumn,
			endLineNumber: range.endLineNumber,
			endColumn: range.endColumn + 1
		}) === ' ') {
			deleteRange = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn + 1);
		}
		this.editor.executeEdits('volt-agent-mention-delete', [{ range: deleteRange, text: '' }]);
		model.deltaDecorations([mention.decorationId], []);
		mention.decorationId = undefined;
		const index = this.mentions.indexOf(mention);
		if (index >= 0) {
			this.mentions.splice(index, 1);
		}
		const catalogIndex = this.mentionCatalog.indexOf(mention);
		if (catalogIndex >= 0) {
			this.mentionCatalog.splice(catalogIndex, 1);
		}
		if (this.hoveredMentionId === mention.id) {
			this.hoveredMentionId = undefined;
		}
	}

	private tagValueFor(mention: IAgentMention): string {
		if (mention.resource) {
			const relative = this.labelService.getUriLabel(mention.resource, { relative: true, noPrefix: true, separator: '/' });
			const path = relative.startsWith('/') ? relative : `/${relative}`;
			if (mention.range) {
				const { startLineNumber, endLineNumber } = mention.range;
				const lines = startLineNumber === endLineNumber ? `${startLineNumber}` : `${startLineNumber}-${endLineNumber}`;
				return `@${path}:${lines}`;
			}
			return `@${path}`;
		}
		return `@${mention.label}`;
	}

	private hoverFor(mention: IAgentMention): MarkdownString {
		if (mention.kind === 'image' && mention.image) {
			const markdown = new MarkdownString(undefined, { supportHtml: true, isTrusted: true });
			const base64 = this.toBase64(mention.image.bytes);
			markdown.appendMarkdown(`![${mention.label}](data:${mention.image.mime};base64,${base64})\n\n${this.tagValueFor(mention)}`);
			return markdown;
		}
		return new MarkdownString(this.tagValueFor(mention));
	}

	private handleCopy(e: ClipboardEvent): void {
		const model = this.editor.getModel();
		const selection = this.editor.getSelection();
		if (!model || !selection || selection.isEmpty() || !e.clipboardData) {
			return;
		}
		const selected = model.getValueInRange(selection);
		const selectionStart = model.getOffsetAt(selection.getStartPosition());
		const replacements = this.mentions
			.map(mention => {
				const range = mention.decorationId ? model.getDecorationRange(mention.decorationId) : undefined;
				return range && Range.areIntersecting(range, selection) ? { mention, range } : undefined;
			})
			.filter((item): item is { mention: IAgentMention; range: Range } => !!item)
			.sort((a, b) => model.getOffsetAt(b.range.getStartPosition()) - model.getOffsetAt(a.range.getStartPosition()));
		if (!replacements.length) {
			return;
		}
		let text = selected;
		for (const { mention, range } of replacements) {
			const start = Math.max(0, model.getOffsetAt(range.getStartPosition()) - selectionStart);
			const end = Math.min(selected.length, model.getOffsetAt(range.getEndPosition()) - selectionStart);
			if (end <= start) {
				continue;
			}
			text = `${text.slice(0, start)}${this.tagValueFor(mention)}${text.slice(end)}`;
		}
		e.preventDefault();
		e.stopPropagation();
		e.clipboardData.setData('text/plain', text);
	}

	private toBase64(bytes: Uint8Array): string {
		let binary = '';
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary);
	}

	private syncMentionRanges(): void {
		if (this.insertingMention) {
			return;
		}
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		for (let i = this.mentions.length - 1; i >= 0; i--) {
			const mention = this.mentions[i];
			if (!mention.decorationId) {
				this.mentions.splice(i, 1);
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (!range || model.getValueInRange(range) !== chipText(mention.label)) {
				model.deltaDecorations([mention.decorationId], []);
				mention.decorationId = undefined;
				this.mentions.splice(i, 1);
			}
		}
		this.reattachMentions();
	}

	private reattachMentions(): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const used: IRange[] = [];
		for (const mention of this.mentions) {
			if (!mention.decorationId) {
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (range) {
				used.push(range);
			}
		}
		for (const mention of this.mentionCatalog) {
			if (this.mentions.includes(mention) && mention.decorationId) {
				continue;
			}
			const range = this.findUnusedLabelRange(chipText(mention.label), used);
			if (!range || used.some(existing => Range.areIntersecting(existing, range))) {
				continue;
			}
			this.addDecoration(mention, range);
			if (!this.mentions.includes(mention)) {
				this.mentions.push(mention);
			}
			used.push(range);
		}
	}

	private findUnusedLabelRange(label: string, used: IRange[]): IRange | undefined {
		const model = this.editor.getModel();
		if (!model || !label) {
			return undefined;
		}
		const lineCount = model.getLineCount();
		for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
			const line = model.getLineContent(lineNumber);
			let from = 0;
			while (from <= line.length - label.length) {
				const index = line.indexOf(label, from);
				if (index < 0) {
					break;
				}
				const range = new Range(lineNumber, index + 1, lineNumber, index + 1 + label.length);
				if (!used.some(existing => Range.areIntersecting(existing, range))) {
					return range;
				}
				from = index + label.length;
			}
		}
		return undefined;
	}

	private tryDeleteMention(e: { preventDefault(): void }, forward: boolean): void {
		const model = this.editor.getModel();
		const pos = this.editor.getPosition();
		const selection = this.editor.getSelection();
		if (!model || !pos) {
			return;
		}
		if (selection && !selection.isEmpty()) {
			const overlapping = this.mentions.find(mention => {
				if (!mention.decorationId) {
					return false;
				}
				const range = model.getDecorationRange(mention.decorationId);
				return !!range && Range.areIntersecting(range, selection);
			});
			if (overlapping) {
				e.preventDefault();
				this.removeMention(overlapping);
			}
			return;
		}
		for (const mention of this.mentions) {
			if (!mention.decorationId) {
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (!range || range.startLineNumber !== pos.lineNumber) {
				continue;
			}
			const hasTrailingSpace = model.getValueInRange({
				startLineNumber: range.endLineNumber,
				startColumn: range.endColumn,
				endLineNumber: range.endLineNumber,
				endColumn: range.endColumn + 1
			}) === ' ';
			const inside = pos.column > range.startColumn && pos.column < range.endColumn;
			const atStart = pos.column === range.startColumn;
			const atEnd = pos.column === range.endColumn;
			const afterSpace = hasTrailingSpace && pos.column === range.endColumn + 1;
			const shouldDelete = forward
				? atStart || inside
				: inside || atEnd || afterSpace;
			if (shouldDelete) {
				e.preventDefault();
				this.removeMention(mention);
				return;
			}
		}
	}

	private async handleDrop(e: DragEvent, position: IPosition | undefined): Promise<void> {
		const now = Date.now();
		if (now - this.lastDropAt < 80) {
			return;
		}
		this.lastDropAt = now;
		const insertAt = position ?? this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
		const range: IRange = { startLineNumber: insertAt.lineNumber, startColumn: insertAt.column, endLineNumber: insertAt.lineNumber, endColumn: insertAt.column };
		const editors = extractEditorsDropData(e);
		if (editors.length) {
			for (const editor of editors) {
				if (editor.resource) {
					await this.insertResource(editor.resource, range);
				}
			}
			return;
		}
		const files = e.dataTransfer?.files;
		if (!files?.length) {
			return;
		}
		for (const file of Array.from(files)) {
			if (file.type.startsWith('image/')) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				this.insertImage(bytes, file.type || 'image/png', range);
				continue;
			}
			const path = (file as File & { path?: string }).path;
			if (path) {
				await this.insertResource(URI.file(path), range);
			}
		}
	}

	private handlePaste(e: ClipboardEvent): void {
		const items = e.clipboardData?.items;
		if (!items) {
			return;
		}
		for (const item of Array.from(items)) {
			if (!item.type.startsWith('image/')) {
				continue;
			}
			const file = item.getAsFile();
			if (!file) {
				continue;
			}
			e.preventDefault();
			void file.arrayBuffer().then(buffer => {
				this.insertImage(new Uint8Array(buffer), file.type || 'image/png', this.cursorRange());
			});
		}
	}
}
