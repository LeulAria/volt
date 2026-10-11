/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getActiveElement, getDomNodePagePosition, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { AnchorAlignment, AnchorPosition, IAnchor } from '../../../../../base/browser/ui/contextview/contextview.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { List } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { AsyncDataTree } from '../../../../../base/browser/ui/tree/asyncDataTree.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer, TreeMouseEventTarget } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IMatch } from '../../../../../base/common/filters.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { getListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabel, ResourceLabels } from '../../../../browser/labels.js';

/** Space between the composer and the panel. */
const ANCHOR_GAP = 6;
/** Width when there is no composer to line up with (menu at the cursor). */
const CURSOR_MENU_WIDTH = 360;
const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 22;
const SEPARATOR_HEIGHT = 1;
const MAX_HEIGHT = 320;

/** A row that runs something: a category, a chat, a terminal, an MCP server, Back. */
export interface IAgentMentionItemRow {
	readonly kind: 'item';
	readonly id: string;
	readonly label: string;
	readonly labelMatches?: readonly IMatch[];
	readonly description?: string;
	readonly icon?: ThemeIcon;
	/** Right-aligned muted text: a key ("Esc"), an age ("3d") or a status ("Ready"). */
	readonly trailing?: string;
	readonly trailingTone?: 'error' | 'warning';
	/** Opens another list in place instead of adding context. */
	readonly submenu?: boolean;
	/** Not focused when the list opens (Back, Add this folder): Enter starts on the content. */
	readonly passive?: boolean;
	readonly run: () => void;
}

/** A file or folder, drawn like the explorer: icon theme glyph, name, git colors. */
export interface IAgentMentionFileRow {
	readonly kind: 'file';
	readonly id: string;
	readonly resource: URI;
	readonly fileKind: FileKind;
	readonly labelMatches?: readonly IMatch[];
	readonly description?: string;
	/** A folder that opens in place (This Mac): a chevron at the end. */
	readonly submenu?: boolean;
	/** The hover button, in place of "Open to the Side" (files only). */
	readonly action?: { readonly icon: ThemeIcon; readonly title: string; readonly run: () => void };
	readonly run: () => void;
}

export type AgentMentionRow =
	| IAgentMentionItemRow
	| IAgentMentionFileRow
	| { readonly kind: 'header'; readonly id: string; readonly title: string }
	| { readonly kind: 'separator'; readonly id: string }
	| { readonly kind: 'message'; readonly id: string; readonly text: string };

export interface IAgentMentionTreeEntry {
	readonly resource: URI;
	readonly isDirectory: boolean;
}

/** The project as an explorer tree, with fixed rows above (Back) and below (Recent). */
export interface IAgentMentionTreeContent {
	readonly root: URI;
	readonly top: readonly AgentMentionRow[];
	readonly bottom: readonly AgentMentionRow[];
	readonly children: (folder: URI) => Promise<readonly IAgentMentionTreeEntry[]>;
	readonly pick: (entry: IAgentMentionTreeEntry) => void;
}

/**
 * A search field over the rows (Files & Folders). Unlike the rest of the panel it takes focus;
 * its keys go to `onKeyDown` so arrows, Enter and Esc work as they do from the composer.
 */
export interface IAgentMentionSearch {
	readonly value: string;
	readonly placeholder: string;
	/** Focus the field with this content: the view just opened. */
	readonly focus: boolean;
	readonly onInput: (value: string) => void;
	readonly onKeyDown: (e: StandardKeyboardEvent) => void;
	readonly onBlur: () => void;
}

export type AgentMentionMenuContent =
	| { readonly kind: 'list'; readonly rows: readonly AgentMentionRow[]; readonly search?: IAgentMentionSearch }
	| { readonly kind: 'tree'; readonly tree: IAgentMentionTreeContent; readonly search?: IAgentMentionSearch };

export interface IAgentMentionMenuOptions {
	/** The composer box; the panel spans its width. Absent: the panel opens at the cursor. */
	readonly anchor: () => HTMLElement | undefined;
	readonly cursor: () => IAnchor;
	/** The hover button on a file row: open it beside the chat. */
	readonly open: (resource: URI) => void;
	readonly onDidHide: () => void;
}

/** A project entry in the tree; its id is the resource. */
interface ITreeEntryElement extends IAgentMentionTreeEntry {
	readonly kind: 'entry';
	readonly id: string;
}

type TreeElement = AgentMentionRow | ITreeEntryElement;

const TREE_ROOT = { kind: 'root' } as const;
type TreeInput = typeof TREE_ROOT;

function isNavigable(element: TreeElement | undefined): boolean {
	return !!element && (element.kind === 'item' || element.kind === 'file' || element.kind === 'entry');
}

/** The row Enter picks first: the first file or entry rather than Back, which Esc already does. */
function firstPick(rows: readonly TreeElement[]): number {
	const pick = rows.findIndex(row => isNavigable(row) && !(row.kind === 'item' && row.passive));
	return pick >= 0 ? pick : rows.findIndex(row => isNavigable(row));
}

function heightOf(element: TreeElement): number {
	switch (element.kind) {
		case 'header': return HEADER_HEIGHT;
		case 'separator': return SEPARATOR_HEIGHT;
		default: return ROW_HEIGHT;
	}
}

/**
 * The @ panel of the agent composer: a VS Code list (or, for Files & Folders, an explorer tree)
 * under or over the composer, like Cursor. Only its search field (Files & Folders) takes focus;
 * otherwise the query is the text typed after @ in the editor, and the editor forwards
 * Up / Down / Left / Right / Enter here.
 */
export class AgentMentionMenu extends Disposable {

	private visible = false;
	private content: AgentMentionMenuContent = { kind: 'list', rows: [] };
	private view: MentionMenuView | undefined;
	private menuElement: HTMLElement | undefined;
	private readonly labels: ResourceLabels;

	constructor(
		private readonly options: IAgentMentionMenuOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.labels = this._register(instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
	}

	get isVisible(): boolean {
		return this.visible;
	}

	get isTree(): boolean {
		return this.visible && this.content.kind === 'tree';
	}

	/** A press on a row focuses the list (VS Code lists take focus on mouse down). */
	get containsFocus(): boolean {
		const element = this.menuElement;
		return !!element && element.contains(getActiveElement());
	}

	/** The highlighted row (not a tree entry). */
	get focusedRow(): AgentMentionRow | undefined {
		const element = this.view?.focused();
		return element && element.kind !== 'entry' ? element : undefined;
	}

	/** The search field has the keyboard (typing goes there, not to the composer). */
	get searchFocused(): boolean {
		return this.view?.searchFocused ?? false;
	}

	focusSearch(): void {
		this.view?.focusSearch();
	}

	/** True when Enter would pick something. */
	get hasSelection(): boolean {
		return isNavigable(this.view?.focused());
	}

	show(content: AgentMentionMenuContent): void {
		this.content = content;
		if (this.visible) {
			this.view?.setContent(content);
			return;
		}
		this.visible = true;
		this.contextViewService.showContextView({
			getAnchor: () => this.getAnchor(),
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.BELOW,
			render: container => this.render(container),
			onHide: () => {
				const wasVisible = this.visible;
				this.visible = false;
				this.view = undefined;
				this.menuElement = undefined;
				if (wasVisible) {
					this.options.onDidHide();
				}
			},
		});
	}

	hide(): void {
		if (this.visible) {
			this.visible = false;
			this.contextViewService.hideContextView();
		}
	}

	move(delta: number): void {
		this.view?.move(delta);
	}

	/** Runs the focused row: adds the file, folder, chat, ... as context. */
	accept(): void {
		this.view?.accept();
	}

	/** Right / Left in the tree: open or close the focused folder. False outside the tree. */
	expand(): boolean {
		return this.view?.expand() ?? false;
	}

	collapse(): boolean {
		return this.view?.collapse() ?? false;
	}

	override dispose(): void {
		this.hide();
		super.dispose();
	}

	private getAnchor(): IAnchor {
		const element = this.options.anchor();
		if (!element?.isConnected) {
			return this.options.cursor();
		}
		const page = getDomNodePagePosition(element);
		// Grow the anchor by the gap so the panel keeps its distance whichever side the context view picks.
		return { x: page.left, y: page.top - ANCHOR_GAP, width: page.width, height: page.height + ANCHOR_GAP * 2 };
	}

	private render(container: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const menu = this.menuElement = append(container, $('.volt-agent-mention-menu.show-file-icons'));
		const anchor = this.options.anchor();
		const width = anchor?.isConnected ? anchor.getBoundingClientRect().width : CURSOR_MENU_WIDTH;
		menu.style.width = `${width}px`;
		// The editor (or the search field) keeps focus: nothing else in the panel may take it on press.
		store.add(addDisposableListener(menu, 'mousedown', e => {
			if (!this.view?.isSearchInput(e.target)) {
				e.preventDefault();
			}
		}));
		store.add(addDisposableListener(getWindow(container).document, 'mousedown', e => {
			if (!(e.target instanceof Node) || menu.contains(e.target) || anchor?.contains(e.target)) {
				return;
			}
			this.hide();
		}, true));
		const view = this.view = store.add(new MentionMenuView(menu, width - 2, this.labels, this.options.open, () => this.contextViewService.layout()));
		view.setContent(this.content);
		store.add(toDisposable(() => menu.remove()));
		return store;
	}
}

/** The list and the tree inside the panel; one of them shows at a time. */
class MentionMenuView extends Disposable {

	private readonly searchHost: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private search: IAgentMentionSearch | undefined;
	private readonly listHost: HTMLElement;
	private readonly list: List<AgentMentionRow>;
	private readonly treeHost: HTMLElement;
	private readonly tree: AsyncDataTree<TreeInput, TreeElement>;
	private rows: readonly AgentMentionRow[] = [];
	private treeContent: IAgentMentionTreeContent | undefined;
	private mode: 'list' | 'tree' = 'list';

	constructor(
		menu: HTMLElement,
		private readonly width: number,
		labels: ResourceLabels,
		open: (resource: URI) => void,
		private readonly relayout: () => void,
	) {
		super();
		const styles = getListStyles({
			listBackground: 'transparent',
			listFocusBackground: 'transparent',
			listActiveSelectionBackground: 'transparent',
			listInactiveSelectionBackground: 'transparent',
			listInactiveFocusBackground: 'transparent',
			listFocusAndSelectionBackground: 'transparent',
			listHoverBackground: 'transparent',
			listFocusOutline: 'transparent',
			listInactiveFocusOutline: 'transparent',
			listFocusAndSelectionOutline: 'transparent',
		});

		this.searchHost = append(menu, $('.volt-agent-mention-search.hidden'));
		this.searchHost.appendChild(renderIcon(Codicon.search));
		const input = this.searchInput = append(this.searchHost, $('input.volt-agent-mention-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.autocomplete = 'off';
		this._register(addDisposableListener(input, 'input', () => this.search?.onInput(input.value)));
		this._register(addDisposableListener(input, 'keydown', e => this.search?.onKeyDown(new StandardKeyboardEvent(e))));
		this._register(addDisposableListener(input, 'blur', () => this.search?.onBlur()));
		// A press beside the field (its icon, padding) puts the caret in it.
		this._register(addDisposableListener(this.searchHost, 'mousedown', e => {
			if (e.target !== input) {
				e.preventDefault();
				input.focus();
			}
		}));

		this.listHost = append(menu, $('.volt-agent-mention-list'));
		this.list = this._register(new List<AgentMentionRow>('VoltAgentMentions', this.listHost, new RowDelegate(), [
			new ItemRenderer(),
			new FileRenderer(labels, open, false),
			new HeaderRenderer(),
			new SeparatorRenderer(),
			new MessageRenderer(),
		], {
			identityProvider: { getId: row => row.id },
			multipleSelectionSupport: false,
			keyboardSupport: false,
			mouseSupport: true,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: true,
			setRowLineHeight: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltAgent.mention.menu', "Add context"),
				getWidgetRole: () => 'listbox',
				getRole: row => isNavigable(row) ? 'option' : 'presentation',
				getAriaLabel: row => ariaLabelOf(row),
			},
		}));
		this.list.style(styles);
		this._register(this.list.onMouseMove(e => {
			if (e.index !== undefined && isNavigable(this.rows[e.index]) && this.list.getFocus()[0] !== e.index) {
				this.list.setFocus([e.index]);
			}
		}));
		this._register(this.list.onMouseClick(e => {
			const row = e.index !== undefined ? this.rows[e.index] : undefined;
			if (row && (row.kind === 'item' || row.kind === 'file')) {
				row.run();
			}
		}));

		this.treeHost = append(menu, $('.volt-agent-mention-tree'));
		const rowElements = new WeakMap<HTMLElement, TreeElement>();
		this.tree = this._register(new AsyncDataTree<TreeInput, TreeElement>('VoltAgentMentionFiles', this.treeHost, new TreeDelegate(), [
			new TreeRowRenderer(new ItemRenderer(), rowElements),
			new TreeRowRenderer(new FileRenderer(labels, open, false), rowElements),
			new TreeRowRenderer(new FileRenderer(labels, open, true), rowElements, 'entry'),
			new TreeRowRenderer(new HeaderRenderer(), rowElements),
			new TreeRowRenderer(new SeparatorRenderer(), rowElements),
			new TreeRowRenderer(new MessageRenderer(), rowElements),
		], new TreeDataSource(() => this.treeContent), {
			identityProvider: { getId: element => element.id },
			multipleSelectionSupport: false,
			keyboardSupport: false,
			mouseSupport: true,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: true,
			setRowLineHeight: false,
			collapseByDefault: () => true,
			// The row adds the file or folder as context; only the arrow opens a folder.
			expandOnlyOnTwistieClick: true,
			indent: 12,
			renderIndentGuides: RenderIndentGuides.None,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltAgent.mention.files', "Files & Folders"),
				getWidgetRole: () => 'tree',
				getRole: element => isNavigable(element) ? 'treeitem' : 'presentation',
				getAriaLabel: element => ariaLabelOf(element),
			},
		}));
		this.tree.style(styles);
		// The tree reports no hover: find the row under the pointer through its rendered contents.
		this._register(addDisposableListener(this.treeHost, 'mousemove', e => {
			const contents = isHTMLElement(e.target) ? e.target.closest<HTMLElement>('.monaco-tl-contents') : null;
			const element = contents ? rowElements.get(contents) : undefined;
			if (element && isNavigable(element) && this.tree.getFocus()[0] !== element) {
				this.tree.setFocus([element]);
			}
		}));
		this._register(this.tree.onMouseClick(e => {
			const element = e.element ?? undefined;
			// The arrow opens and closes a folder (the tree handles that); the rest of a row picks it.
			if (e.target === TreeMouseEventTarget.Twistie) {
				return;
			}
			if (element?.kind === 'entry') {
				this.treeContent?.pick(element);
			} else if (element && (element.kind === 'item' || element.kind === 'file')) {
				element.run();
			}
		}));
		this._register(this.tree.onDidChangeContentHeight(() => {
			if (this.mode === 'tree') {
				this.layoutTree();
			}
		}));
	}

	get searchFocused(): boolean {
		return !!this.search && getActiveElement() === this.searchInput;
	}

	isSearchInput(target: EventTarget | null): boolean {
		return !!this.search && target === this.searchInput;
	}

	focusSearch(): void {
		if (this.search) {
			this.searchInput.focus();
		}
	}

	private setSearch(search: IAgentMentionSearch | undefined): void {
		this.search = search;
		this.searchHost.classList.toggle('hidden', !search);
		if (!search) {
			return;
		}
		this.searchInput.placeholder = search.placeholder;
		this.searchInput.setAttribute('aria-label', search.placeholder);
		// Only when it changed elsewhere (the composer's @ text): rewriting it would move the caret.
		if (this.searchInput.value !== search.value) {
			this.searchInput.value = search.value;
		}
		if (search.focus) {
			this.searchInput.focus();
		}
	}

	setContent(content: AgentMentionMenuContent): void {
		this.setSearch(content.search);
		if (content.kind === 'list') {
			this.mode = 'list';
			this.treeHost.style.display = 'none';
			this.listHost.style.display = '';
			this.rows = content.rows;
			this.list.splice(0, this.list.length, [...content.rows]);
			const height = Math.min(MAX_HEIGHT, content.rows.reduce((sum, row) => sum + heightOf(row), 0));
			this.listHost.style.height = `${height}px`;
			this.list.layout(height, this.width);
			const first = firstPick(content.rows);
			this.list.setFocus(first >= 0 ? [first] : []);
			if (first >= 0) {
				this.list.reveal(first);
			}
			this.relayout();
			return;
		}
		this.mode = 'tree';
		this.listHost.style.display = 'none';
		this.treeHost.style.display = '';
		const previous = this.treeContent;
		this.treeContent = content.tree;
		// Same project: keep the open folders and only refresh the rows around them.
		const refresh = previous?.root.toString() === content.tree.root.toString()
			? this.tree.updateChildren(TREE_ROOT, false)
			: this.tree.setInput(TREE_ROOT);
		void refresh.then(() => {
			if (this.mode !== 'tree') {
				return;
			}
			this.layoutTree();
			if (!isNavigable(this.tree.getFocus()[0])) {
				const top = this.treeTopLevel();
				const first = top[firstPick(top)];
				this.tree.setFocus(first ? [first] : []);
			}
		});
	}

	focused(): TreeElement | undefined {
		if (this.mode === 'tree') {
			return this.tree.getFocus()[0] ?? undefined;
		}
		const index = this.list.getFocus()[0];
		return index === undefined ? undefined : this.rows[index];
	}

	move(delta: number): void {
		if (this.mode === 'list') {
			const count = this.rows.length;
			let index = this.list.getFocus()[0] ?? -1;
			for (let step = 0; step < count; step++) {
				index = index < 0 ? (delta > 0 ? 0 : count - 1) : (index + delta + count) % count;
				if (isNavigable(this.rows[index])) {
					this.list.setFocus([index]);
					this.list.reveal(index);
					return;
				}
			}
			return;
		}
		// The tree has no navigation filter of its own: step again over headers and dividers.
		for (let step = 0; step < 50; step++) {
			if (delta > 0) {
				this.tree.focusNext(1, true);
			} else {
				this.tree.focusPrevious(1, true);
			}
			if (isNavigable(this.tree.getFocus()[0] ?? undefined)) {
				break;
			}
		}
		const focused = this.tree.getFocus()[0];
		if (focused) {
			this.tree.reveal(focused);
		}
	}

	accept(): void {
		const element = this.focused();
		if (element?.kind === 'entry') {
			this.treeContent?.pick(element);
		} else if (element && (element.kind === 'item' || element.kind === 'file')) {
			element.run();
		}
	}

	expand(): boolean {
		const element = this.mode === 'tree' ? this.focused() : undefined;
		if (element?.kind !== 'entry' || !element.isDirectory) {
			return this.mode === 'tree';
		}
		if (this.tree.isCollapsed(element)) {
			void this.tree.expand(element);
		} else {
			this.move(1);
		}
		return true;
	}

	collapse(): boolean {
		const element = this.mode === 'tree' ? this.focused() : undefined;
		if (element?.kind !== 'entry') {
			return this.mode === 'tree';
		}
		if (element.isDirectory && !this.tree.isCollapsed(element)) {
			this.tree.collapse(element);
			return true;
		}
		const parent = this.tree.getParentElement(element);
		if (parent && parent !== TREE_ROOT) {
			this.tree.setFocus([parent as TreeElement]);
			this.tree.reveal(parent as TreeElement);
		}
		return true;
	}

	private treeTopLevel(): TreeElement[] {
		const node = this.tree.getNode();
		return node.children.map(child => child.element).filter((element): element is TreeElement => !!element);
	}

	private layoutTree(): void {
		const height = Math.min(MAX_HEIGHT, this.tree.contentHeight);
		this.treeHost.style.height = `${height}px`;
		this.tree.layout(height, this.width);
		this.relayout();
	}
}

function ariaLabelOf(element: TreeElement): string | null {
	switch (element.kind) {
		case 'item': return [element.label, element.description, element.trailing].filter(Boolean).join(', ');
		case 'file': return [basename(element.resource), element.description].filter(Boolean).join(', ');
		case 'entry': return basename(element.resource);
		case 'header': return element.title;
		case 'message': return element.text;
		default: return null;
	}
}

class RowDelegate implements IListVirtualDelegate<AgentMentionRow> {
	getHeight(row: AgentMentionRow): number {
		return heightOf(row);
	}
	getTemplateId(row: AgentMentionRow): string {
		return row.kind;
	}
}

class TreeDelegate implements IListVirtualDelegate<TreeElement> {
	getHeight(element: TreeElement): number {
		return heightOf(element);
	}
	getTemplateId(element: TreeElement): string {
		return element.kind;
	}
}

class TreeDataSource implements IAsyncDataSource<TreeInput, TreeElement> {

	constructor(private readonly content: () => IAgentMentionTreeContent | undefined) { }

	hasChildren(element: TreeInput | TreeElement): boolean {
		return element === TREE_ROOT || (element.kind === 'entry' && element.isDirectory);
	}

	async getChildren(element: TreeInput | TreeElement): Promise<TreeElement[]> {
		const content = this.content();
		if (!content) {
			return [];
		}
		if (element === TREE_ROOT) {
			const entries = await this.entries(content, content.root);
			return [...content.top, ...entries, ...content.bottom];
		}
		return element.kind === 'entry' ? this.entries(content, element.resource) : [];
	}

	private async entries(content: IAgentMentionTreeContent, folder: URI): Promise<ITreeEntryElement[]> {
		const children = await content.children(folder).catch(() => []);
		return children.map(child => ({ kind: 'entry', id: child.resource.toString(), resource: child.resource, isDirectory: child.isDirectory }));
	}
}

interface ITreeRowTemplate<TTemplate> {
	readonly container: HTMLElement;
	readonly inner: TTemplate;
}

/** Lets a list row renderer draw the same row inside the tree, and records which row is where. */
class TreeRowRenderer<TTemplate> implements ITreeRenderer<TreeElement, void, ITreeRowTemplate<TTemplate>> {

	readonly templateId: string;

	constructor(
		private readonly inner: IListRenderer<TreeElement, TTemplate>,
		private readonly rowElements: WeakMap<HTMLElement, TreeElement>,
		templateId?: string,
	) {
		this.templateId = templateId ?? inner.templateId;
	}

	renderTemplate(container: HTMLElement): ITreeRowTemplate<TTemplate> {
		return { container, inner: this.inner.renderTemplate(container) };
	}

	renderElement(node: ITreeNode<TreeElement, void>, index: number, template: ITreeRowTemplate<TTemplate>): void {
		this.rowElements.set(template.container, node.element);
		this.inner.renderElement(node.element, index, template.inner, undefined);
	}

	disposeTemplate(template: ITreeRowTemplate<TTemplate>): void {
		this.rowElements.delete(template.container);
		this.inner.disposeTemplate(template.inner);
	}
}

class ItemRenderer implements IListRenderer<TreeElement, HTMLElement> {
	readonly templateId = 'item';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-row.volt-menu-item.flush'));
	}

	renderElement(element: TreeElement, _index: number, row: HTMLElement): void {
		if (element.kind !== 'item') {
			return;
		}
		clearNode(row);
		const icon = append(row, $('span.volt-menu-icon'));
		if (element.icon) {
			icon.appendChild(renderIcon(element.icon));
		} else {
			icon.classList.add('empty');
		}
		new HighlightedLabel(append(row, $('span.volt-menu-label'))).set(element.label, element.labelMatches ? [...element.labelMatches] : undefined);
		if (element.description) {
			append(row, $('span.volt-menu-detail')).textContent = element.description;
		}
		append(row, $('span.volt-menu-spacer'));
		if (element.trailing) {
			const trailing = append(row, $('span.volt-menu-keybinding'));
			trailing.textContent = element.trailing;
			if (element.trailingTone) {
				trailing.classList.add(element.trailingTone);
			}
		}
		if (element.submenu) {
			append(row, $('span.volt-menu-trailing')).appendChild(renderIcon(Codicon.chevronRight));
		}
	}

	disposeTemplate(): void { }
}

interface IFileTemplate {
	readonly row: HTMLElement;
	readonly label: IResourceLabel;
	readonly action: HTMLElement;
	/** A folder that opens in place. */
	readonly chevron: HTMLElement;
	readonly store: DisposableStore;
	/** What the hover button does for this row, if anything. */
	runAction?: () => void;
}

/**
 * Files and folders drawn by the explorer's label (icon theme glyph, git colors). A file row
 * shows an "open beside the chat" button on hover.
 */
class FileRenderer implements IListRenderer<TreeElement, IFileTemplate> {
	readonly templateId = 'file';

	constructor(
		private readonly labels: ResourceLabels,
		private readonly open: (resource: URI) => void,
		/** Tree entries sit after the twistie; list rows run flush like the other rows. */
		private readonly inTree: boolean,
	) { }

	renderTemplate(container: HTMLElement): IFileTemplate {
		const row = append(container, $('.volt-menu-row.volt-agent-mention-file'));
		if (!this.inTree) {
			row.classList.add('flush');
		}
		const label = this.labels.create(row, { supportHighlights: true, supportDescriptionHighlights: true });
		const action = append(row, $('span.volt-agent-mention-file-action'));
		action.setAttribute('role', 'button');
		const chevron = append(row, $('span.volt-menu-trailing.volt-agent-mention-file-chevron'));
		chevron.appendChild(renderIcon(Codicon.chevronRight));
		const template: IFileTemplate = { row, label, action, chevron, store: new DisposableStore() };
		template.store.add(addDisposableListener(action, 'mousedown', e => EventHelper.stop(e, true)));
		template.store.add(addDisposableListener(action, 'click', e => {
			EventHelper.stop(e, true);
			template.runAction?.();
		}));
		return template;
	}

	renderElement(element: TreeElement, _index: number, template: IFileTemplate): void {
		if (element.kind !== 'file' && element.kind !== 'entry') {
			return;
		}
		const isDirectory = element.kind === 'entry' ? element.isDirectory : element.fileKind === FileKind.FOLDER;
		const resource = element.resource;
		const action = element.kind === 'file' ? element.action : undefined;
		template.runAction = action ? action.run : isDirectory ? undefined : () => this.open(resource);
		template.action.replaceChildren(renderIcon(action?.icon ?? Codicon.goToFile));
		template.action.title = action?.title ?? localize('voltAgent.mention.openFile', "Open to the Side");
		template.chevron.classList.toggle('hidden', !(element.kind === 'file' && element.submenu));
		template.label.setResource(
			{ resource: element.resource, name: basename(element.resource), description: element.kind === 'file' ? element.description : undefined },
			{
				fileKind: isDirectory ? FileKind.FOLDER : FileKind.FILE,
				matches: element.kind === 'file' && element.labelMatches ? [...element.labelMatches] : undefined,
				fileDecorations: { colors: true, badges: false },
			},
		);
		template.action.classList.toggle('hidden', !template.runAction);
	}

	disposeTemplate(template: IFileTemplate): void {
		template.store.dispose();
		template.label.dispose();
	}
}

class HeaderRenderer implements IListRenderer<TreeElement, HTMLElement> {
	readonly templateId = 'header';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-header.flush'));
	}

	renderElement(element: TreeElement, _index: number, header: HTMLElement): void {
		header.textContent = element.kind === 'header' ? element.title : '';
	}

	disposeTemplate(): void { }
}

class SeparatorRenderer implements IListRenderer<TreeElement, HTMLElement> {
	readonly templateId = 'separator';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-separator.flush'));
	}

	renderElement(): void { }

	disposeTemplate(): void { }
}

class MessageRenderer implements IListRenderer<TreeElement, HTMLElement> {
	readonly templateId = 'message';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-message.flush'));
	}

	renderElement(element: TreeElement, _index: number, message: HTMLElement): void {
		message.textContent = element.kind === 'message' ? element.text : '';
	}

	disposeTemplate(): void { }
}
