/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { IDragAndDropData } from '../../../../../base/browser/dnd.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../../base/browser/ui/list/listView.js';
import { IObjectTreeElement, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator, SubmenuAction } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { boardDisplayTitle, organizeIndex } from '../../common/scratchBoard/scratchIndex.js';
import { IScratchBoardMeta, IScratchFolder } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IScratchBoardService } from './scratchBoardService.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';

type SidebarElement =
	| { readonly kind: 'section'; readonly id: 'pinned' | 'archived'; readonly label: string; readonly count: number }
	| { readonly kind: 'folder'; readonly folder: IScratchFolder; readonly count: number }
	| { readonly kind: 'board'; readonly board: IScratchBoardMeta; readonly parent: 'pinned' | 'archived' | 'folder' | 'root' }
	| { readonly kind: 'empty'; readonly text: string };

const ROW_HEIGHT = 30;
const BOARD_ROW_HEIGHT = 44;

function elementId(e: SidebarElement): string {
	switch (e.kind) {
		case 'section': return `section:${e.id}`;
		case 'folder': return `folder:${e.folder.id}`;
		case 'board': return `board:${e.parent}:${e.board.id}`;
		case 'empty': return 'empty';
	}
}

export interface IScratchSidebarHost {
	readonly activeBoardId: () => string | undefined;
	open(boardId: string): void;
	newBoard(folderId: string | null): void;
	sendBoardToAgent(boardId: string): void;
	/** Puts the list away (the boards button and Cmd+\\ bring it back). */
	close(): void;
}

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly text: HTMLElement;
	readonly title: HTMLElement;
	readonly subtitle: HTMLElement;
	readonly count: HTMLElement;
	readonly actions: HTMLElement;
	readonly elementStore: DisposableStore;
}

class Delegate implements IListVirtualDelegate<SidebarElement> {
	getHeight(e: SidebarElement): number {
		return e.kind === 'board' ? BOARD_ROW_HEIGHT : ROW_HEIGHT;
	}
	getTemplateId(): string {
		return 'row';
	}
}

/**
 * The board list beside the canvas: Pinned, folders, loose boards and an Archived section, in
 * VS Code's tree. Rows rename in place, drag into folders, and carry pin, archive and more.
 */
export class ScratchBoardSidebar extends Disposable {

	readonly element: HTMLElement;
	private readonly searchInput: InputBox;
	private readonly tree: WorkbenchObjectTree<SidebarElement>;
	private readonly renderScheduler: RunOnceScheduler;
	private query = '';
	private renamingId: string | undefined;
	private readonly collapsedSections = new Set<string>(['section:archived']);

	private readonly _onDidRequestFocusCanvas = this._register(new Emitter<void>());
	readonly onDidRequestFocusCanvas: Event<void> = this._onDidRequestFocusCanvas.event;

	constructor(
		parent: HTMLElement,
		private readonly host: IScratchSidebarHost,
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService contextViewService: IContextViewService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.element = append(parent, $('.sx-sidebar'));
		this.element.setAttribute('role', 'navigation');
		this.element.setAttribute('aria-label', localize('voltScratch.boards', "Boards"));
		const header = append(this.element, $('.sx-sidebar-header'));
		append(header, $('.sx-sidebar-title')).textContent = localize('voltScratch.boards', "Boards");
		const headerActions = append(header, $('.sx-sidebar-actions'));
		const headerButton = (icon: ScratchIconName, label: string, run: () => void, shortcut?: string) => {
			const b = append(headerActions, $('button.sx-icon-button')) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.appendChild(scratchIcon(parent.ownerDocument, icon, { size: 15 }));
			setAgentTooltip(b, label, shortcut, undefined, 'below');
			this._register(addDisposableListener(b, 'click', run));
		};
		headerButton('folder-plus', localize('voltScratch.newFolderButton', "New Folder"), () => this.newFolder());
		headerButton('file-plus', localize('voltScratch.newBoard', "New Board"), () => this.host.newBoard(null));
		headerButton('panel-left-close', localize('voltScratch.closeBoards', "Close Boards"), () => this.host.close(), isMacintosh ? '⌘\\' : 'Ctrl+\\');

		const search = append(this.element, $('.sx-sidebar-search'));
		this.searchInput = this._register(new InputBox(search, contextViewService, {
			placeholder: localize('voltScratch.searchBoards', "Search boards"),
			ariaLabel: localize('voltScratch.searchBoards', "Search boards"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.searchInput.onDidChange(value => {
			this.query = value;
			this.renderScheduler.schedule();
		}));
		this._register(addDisposableListener(this.searchInput.inputElement, 'keydown', e => {
			if (e.key === 'Escape' && this.searchInput.value) {
				e.preventDefault();
				e.stopPropagation();
				this.searchInput.value = '';
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.tree.domFocus();
				if (!this.tree.getFocus().length) {
					this.tree.focusFirst();
				}
			}
		}));

		const treeContainer = append(this.element, $('.sx-sidebar-tree'));
		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<SidebarElement>,
			'ScratchBoards',
			treeContainer,
			new Delegate(),
			[new Renderer(this)],
			{
				identityProvider: { getId: elementId },
				accessibilityProvider: {
					getAriaLabel: (e: SidebarElement) => e.kind === 'board' ? boardDisplayTitle(e.board) : e.kind === 'folder' ? e.folder.name : e.kind === 'section' ? e.label : e.text,
					getWidgetAriaLabel: () => localize('voltScratch.boards', "Boards"),
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (e: SidebarElement) => e.kind === 'board' ? boardDisplayTitle(e.board) : e.kind === 'folder' ? e.folder.name : '',
				},
				dnd: new BoardsDragAndDrop(this),
				multipleSelectionSupport: false,
				hideTwistiesOfChildlessElements: true,
				setRowLineHeight: false,
				paddingBottom: 12,
			}
		));
		this._register(this.tree.onDidOpen(e => {
			const el = e.element;
			if (el?.kind === 'board' && !this.renamingId) {
				this.host.open(el.board.id);
				if (e.editorOptions.pinned || (e.browserEvent && e.browserEvent.type === 'keydown')) {
					this._onDidRequestFocusCanvas.fire();
				}
			}
		}));
		this._register(this.tree.onContextMenu(e => {
			const el = e.element;
			if (!el || el.kind === 'empty' || el.kind === 'section') {
				return;
			}
			e.browserEvent.preventDefault();
			e.browserEvent.stopPropagation();
			const anchor = isHTMLElement(e.anchor) ? e.anchor : { x: e.anchor.posx, y: e.anchor.posy };
			this.showMenu(el, anchor);
		}));
		this._register(this.tree.onDidChangeCollapseState(e => {
			const el = e.node.element;
			if (el?.kind === 'folder') {
				this.boards.setFolderCollapsed(el.folder.id, e.node.collapsed);
			} else if (el?.kind === 'section') {
				if (e.node.collapsed) {
					this.collapsedSections.add(elementId(el));
				} else {
					this.collapsedSections.delete(elementId(el));
				}
			}
		}));
		this._register(addDisposableListener(treeContainer, 'keydown', e => {
			const focused = this.tree.getFocus()[0];
			if (!focused || this.renamingId) {
				return;
			}
			if (e.key === 'F2' || (e.key === 'Enter' && e.altKey)) {
				e.preventDefault();
				this.startRename(focused);
			} else if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) && (focused.kind === 'board' || focused.kind === 'folder')) {
				e.preventDefault();
				void this.remove(focused);
			}
		}));
		this.renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 0));
		this._register(this.boards.onDidChangeIndex(() => this.renderScheduler.schedule()));
		// Relative times ("2 min ago") stay current.
		const win = getWindow(parent);
		const ticker = win.setInterval(() => this.renderScheduler.schedule(), 60_000);
		this._register(toDisposable(() => win.clearInterval(ticker)));
		this.render();
	}

	get activeBoardId(): string | undefined {
		return this.host.activeBoardId();
	}

	get renaming(): string | undefined {
		return this.renamingId;
	}

	newBoardIn(folderId: string | null): void {
		this.host.newBoard(folderId);
	}

	layout(height: number, width: number): void {
		const headerHeight = 82;
		this.tree.layout(Math.max(0, height - headerHeight), width);
	}

	/** Rebuilds the rows from the index; selection follows the open board. */
	render(): void {
		if (this.renamingId) {
			// Rows rebuilt now would reset the name being typed; the rename finishing renders.
			return;
		}
		const organized = organizeIndex(this.boards.index, this.query);
		const children: IObjectTreeElement<SidebarElement>[] = [];
		const board = (b: IScratchBoardMeta, parent: 'pinned' | 'archived' | 'folder' | 'root'): IObjectTreeElement<SidebarElement> => ({ element: { kind: 'board', board: b, parent } });
		if (organized.pinned.length) {
			const section: SidebarElement = { kind: 'section', id: 'pinned', label: localize('voltScratch.pinned', "Pinned"), count: organized.pinned.length };
			children.push({ element: section, collapsible: true, collapsed: this.collapsedSections.has(elementId(section)), children: organized.pinned.map(b => board(b, 'pinned')) });
		}
		for (const { folder, boards } of organized.folders) {
			children.push({
				element: { kind: 'folder', folder, count: boards.length },
				collapsible: true,
				collapsed: !this.query && !!folder.collapsed,
				children: boards.map(b => board(b, 'folder')),
			});
		}
		for (const b of organized.boards) {
			children.push(board(b, 'root'));
		}
		if (organized.archived.length) {
			const section: SidebarElement = { kind: 'section', id: 'archived', label: localize('voltScratch.archived', "Archived"), count: organized.archived.length };
			children.push({ element: section, collapsible: true, collapsed: !this.query && this.collapsedSections.has(elementId(section)), children: organized.archived.map(b => board(b, 'archived')) });
		}
		if (!children.length) {
			children.push({ element: { kind: 'empty', text: this.query ? localize('voltScratch.noMatches', "No boards match.") : localize('voltScratch.noBoards', "No boards yet.") } });
		}
		this.tree.setChildren(null, children);
		this.syncSelection();
	}

	syncSelection(): void {
		const active = this.host.activeBoardId();
		if (!active) {
			return;
		}
		const meta = this.boards.getBoard(active);
		if (!meta) {
			return;
		}
		const parent = meta.archived ? 'archived' : meta.pinned ? 'pinned' : meta.folderId && this.boards.getFolder(meta.folderId) ? 'folder' : 'root';
		const id = `board:${parent}:${active}`;
		const node = this.findNode(id);
		if (node) {
			this.tree.setSelection([node]);
			if (!this.tree.getFocus().length) {
				this.tree.setFocus([node]);
			}
		}
	}

	private findNode(id: string): SidebarElement | undefined {
		const walk = (node: ITreeNode<SidebarElement | null, void>): SidebarElement | undefined => {
			for (const child of node.children) {
				if (child.element && elementId(child.element) === id) {
					return child.element;
				}
				const found = walk(child as ITreeNode<SidebarElement | null, void>);
				if (found) {
					return found;
				}
			}
			return undefined;
		};
		return walk(this.tree.getNode() as ITreeNode<SidebarElement | null, void>);
	}

	focus(): void {
		this.tree.domFocus();
	}

	// ---- Actions ----

	private newFolder(): void {
		const id = this.boards.createFolder(localize('voltScratch.newFolder', "New Folder"));
		// Rename it straight away once the row exists.
		this.renderScheduler.cancel();
		this.render();
		const folder = this.boards.getFolder(id);
		if (folder) {
			this.startRename({ kind: 'folder', folder, count: 0 });
		}
	}

	startRename(el: SidebarElement): void {
		if (el.kind !== 'board' && el.kind !== 'folder') {
			return;
		}
		// The tree knows its rows by object: find the row as it is now (the list may have been rebuilt).
		if (this.renamingId) {
			this.finishRename(undefined);
		}
		this.renderScheduler.cancel();
		this.render();
		const live = this.findNode(elementId(el));
		if (!live) {
			return;
		}
		this.renamingId = el.kind === 'board' ? el.board.id : el.folder.id;
		this.tree.reveal(live);
		this.tree.rerender(live);
	}

	finishRename(value: string | undefined): void {
		const id = this.renamingId;
		this.renamingId = undefined;
		if (id && value !== undefined) {
			const v = value.trim();
			if (v) {
				if (this.boards.getBoard(id)) {
					this.boards.renameBoard(id, v);
				} else if (this.boards.getFolder(id)) {
					this.boards.renameFolder(id, v);
				}
			}
		}
		this.render();
		this.tree.domFocus();
	}

	setPinned(board: IScratchBoardMeta, pinned: boolean): void {
		this.boards.setBoardPinned(board.id, pinned);
	}

	setArchived(board: IScratchBoardMeta, archived: boolean): void {
		this.boards.setBoardArchived(board.id, archived);
	}

	/** Into a folder (or the top level), out of Pinned and Archived: where it was dropped is where it shows. */
	moveBoard(boardId: string, folderId: string | null): void {
		const meta = this.boards.getBoard(boardId);
		if (!meta) {
			return;
		}
		this.boards.moveBoard(boardId, folderId);
		if (meta.archived) {
			this.boards.setBoardArchived(boardId, false);
		}
		if (meta.pinned) {
			this.boards.setBoardPinned(boardId, false);
		}
	}

	async remove(el: SidebarElement): Promise<void> {
		if (el.kind === 'folder') {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('voltScratch.deleteFolderConfirm', "Delete the folder \"{0}\"?", el.folder.name),
				detail: localize('voltScratch.deleteFolderDetail', "Its boards are kept and move to the top level."),
				primaryButton: localize('voltScratch.deleteFolderButton', "Delete Folder"),
			});
			if (confirmed) {
				this.boards.deleteFolder(el.folder.id);
			}
			return;
		}
		if (el.kind !== 'board') {
			return;
		}
		const title = boardDisplayTitle(el.board);
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltScratch.deleteBoardConfirm', "Delete \"{0}\"?", title),
			detail: localize('voltScratch.deleteBoardDetail', "The board moves to the trash for 30 days; you can undo right after."),
			primaryButton: localize('voltScratch.deleteBoardButton', "Delete Board"),
		});
		if (!confirmed) {
			return;
		}
		// The page moves off a deleted board that was open (it watches the index).
		const restore = await this.boards.deleteBoard(el.board.id);
		if (!restore) {
			this.notificationService.error(localize('voltScratch.deleteFailed', "Could not delete \"{0}\".", title));
			return;
		}
		this.notificationService.prompt(Severity.Info, localize('voltScratch.deleted', "Deleted \"{0}\".", title), [{
			label: localize('voltScratch.undoDelete', "Undo"),
			run: async () => {
				if (await restore()) {
					this.host.open(el.board.id);
				} else {
					this.notificationService.error(localize('voltScratch.restoreDeletedFailed', "Could not bring back \"{0}\". It is kept in the Scratch trash folder for 30 days.", title));
				}
			},
		}]);
	}

	showMenu(el: SidebarElement, anchor: HTMLElement | { x: number; y: number }): void {
		const actions: IAction[] = [];
		if (el.kind === 'board') {
			const b = el.board;
			const folders = this.boards.index.folders.filter(f => !f.deleted).sort((x, y) => x.name.localeCompare(y.name));
			actions.push(
				new Action('open', localize('voltScratch.openBoard', "Open"), undefined, true, async () => this.host.open(b.id)),
				new Action('rename', localize('voltScratch.rename', "Rename"), undefined, true, async () => this.startRename(el)),
				new Action('duplicate', localize('voltScratch.duplicateBoard', "Duplicate"), undefined, true, async () => {
					const id = await this.boards.duplicateBoard(b.id);
					if (id) {
						this.host.open(id);
					}
				}),
				new Separator(),
				new Action('send', localize('voltScratch.sendBoard', "Send to Agent"), undefined, true, async () => this.host.sendBoardToAgent(b.id)),
				new Separator(),
				new Action('pin', b.pinned ? localize('voltScratch.unpin', "Unpin") : localize('voltScratch.pin', "Pin"), undefined, true, async () => this.setPinned(b, !b.pinned)),
				new SubmenuAction('move', localize('voltScratch.moveTo', "Move to"), [
					new Action('move-root', localize('voltScratch.noFolder', "No Folder"), undefined, !!b.folderId, async () => this.moveBoard(b.id, null)),
					...(folders.length ? [new Separator()] : []),
					...folders.map(f => new Action(`move-${f.id}`, f.name, undefined, f.id !== b.folderId, async () => this.moveBoard(b.id, f.id))),
					new Separator(),
					new Action('move-new', localize('voltScratch.newFolderDots', "New Folder"), undefined, true, async () => {
						const id = this.boards.createFolder(localize('voltScratch.newFolder', "New Folder"));
						this.moveBoard(b.id, id);
						this.render();
						const folder = this.boards.getFolder(id);
						if (folder) {
							this.startRename({ kind: 'folder', folder, count: 1 });
						}
					}),
				]),
				new Action('archive', b.archived ? localize('voltScratch.unarchive', "Unarchive") : localize('voltScratch.archive', "Archive"), undefined, true, async () => this.setArchived(b, !b.archived)),
				new Separator(),
				new Action('delete', localize('voltScratch.deleteBoardMenu', "Delete"), undefined, true, async () => this.remove(el)),
			);
		} else if (el.kind === 'folder') {
			actions.push(
				new Action('new', localize('voltScratch.newBoardHere', "New Board in Folder"), undefined, true, async () => this.host.newBoard(el.folder.id)),
				new Action('rename', localize('voltScratch.rename', "Rename"), undefined, true, async () => this.startRename(el)),
				new Separator(),
				new Action('delete', localize('voltScratch.deleteFolderMenu', "Delete Folder"), undefined, true, async () => this.remove(el)),
			);
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}
}

class Renderer implements ITreeRenderer<SidebarElement, void, IRowTemplate> {

	readonly templateId = 'row';

	constructor(private readonly sidebar: ScratchBoardSidebar) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = append(container, $('.sx-row'));
		const icon = append(row, $('.sx-row-icon'));
		const text = append(row, $('.sx-row-text'));
		const title = append(text, $('.sx-row-title'));
		const subtitle = append(text, $('.sx-row-subtitle'));
		const count = append(row, $('.sx-row-count'));
		const actions = append(row, $('.sx-row-actions'));
		return { row, icon, text, title, subtitle, count, actions, elementStore: new DisposableStore() };
	}

	renderElement(node: ITreeNode<SidebarElement, void>, _index: number, t: IRowTemplate): void {
		t.elementStore.clear();
		const el = node.element;
		const doc = t.row.ownerDocument;
		t.row.className = `sx-row sx-row-${el.kind}`;
		t.icon.replaceChildren();
		t.actions.replaceChildren();
		t.count.textContent = '';
		t.subtitle.textContent = '';
		t.title.replaceChildren();
		t.text.hidden = false;
		const action = (icon: ScratchIconName, label: string, run: () => void) => {
			const b = append(t.actions, $('button.sx-row-action')) as HTMLButtonElement;
			b.type = 'button';
			b.tabIndex = -1;
			b.setAttribute('aria-label', label);
			b.appendChild(scratchIcon(doc, icon, { size: 14 }));
			setAgentTooltip(b, label, undefined, undefined, 'above');
			t.elementStore.add(addDisposableListener(b, 'mousedown', e => e.stopPropagation()));
			t.elementStore.add(addDisposableListener(b, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				run();
			}));
		};
		switch (el.kind) {
			case 'section': {
				t.title.textContent = el.label;
				t.count.textContent = String(el.count);
				break;
			}
			case 'empty': {
				t.title.textContent = el.text;
				break;
			}
			case 'folder': {
				t.icon.appendChild(scratchIcon(doc, node.collapsed ? 'folder' : 'folder-open', { size: 15 }));
				if (this.sidebar.renaming === el.folder.id) {
					this.renderRename(t, el.folder.name);
				} else {
					t.title.textContent = el.folder.name;
					t.count.textContent = el.count ? String(el.count) : '';
				}
				action('plus', localize('voltScratch.newBoardHere', "New Board in Folder"), () => this.sidebar.newBoardIn(el.folder.id));
				action('ellipsis', localize('voltScratch.more', "More"), () => this.sidebar.showMenu(el, t.actions));
				break;
			}
			case 'board': {
				const b = el.board;
				t.row.classList.toggle('active', this.sidebar.activeBoardId === b.id);
				t.icon.appendChild(scratchIcon(doc, b.pinned && el.parent === 'pinned' ? 'pin' : 'scratch-board', { size: 16, strokeWidth: b.pinned && el.parent === 'pinned' ? 1.75 : 1.4 }));
				if (this.sidebar.renaming === b.id) {
					this.renderRename(t, b.title);
				} else {
					t.title.textContent = boardDisplayTitle(b);
					const when = fromNow(b.edited || b.created, true);
					t.subtitle.textContent = b.excerpt ? `${when} · ${b.excerpt}` : when;
				}
				action(b.pinned ? 'pin-off' : 'pin', b.pinned ? localize('voltScratch.unpin', "Unpin") : localize('voltScratch.pin', "Pin"), () => this.sidebar.setPinned(b, !b.pinned));
				action(b.archived ? 'archive-restore' : 'archive', b.archived ? localize('voltScratch.unarchive', "Unarchive") : localize('voltScratch.archive', "Archive"), () => this.sidebar.setArchived(b, !b.archived));
				action('ellipsis', localize('voltScratch.more', "More"), () => this.sidebar.showMenu(el, t.actions));
				break;
			}
		}
	}

	private renderRename(t: IRowTemplate, value: string): void {
		t.row.classList.add('renaming');
		const host = append(t.title, $('.sx-rename'));
		const input = append(host, $('input.sx-rename-input')) as HTMLInputElement;
		input.type = 'text';
		input.value = value;
		input.spellcheck = false;
		let done = false;
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			this.sidebar.finishRename(commit ? input.value : undefined);
		};
		t.elementStore.add(addDisposableListener(input, 'keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				finish(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(false);
			}
		}));
		t.elementStore.add(addDisposableListener(input, 'blur', () => finish(true)));
		t.elementStore.add(addDisposableListener(input, 'mousedown', e => e.stopPropagation()));
		t.elementStore.add(addDisposableListener(input, 'click', e => e.stopPropagation()));
		setTimeout(() => {
			if (!done) {
				input.focus();
				input.select();
			}
		}, 0);
	}

	disposeElement(_node: ITreeNode<SidebarElement, void>, _index: number, t: IRowTemplate): void {
		t.elementStore.clear();
	}

	disposeTemplate(t: IRowTemplate): void {
		t.elementStore.dispose();
	}
}

/** Boards drag onto folders (move), Pinned (pin), Archived (archive) or the top level. */
class BoardsDragAndDrop implements ITreeDragAndDrop<SidebarElement> {

	constructor(private readonly sidebar: ScratchBoardSidebar) { }

	getDragURI(element: SidebarElement): string | null {
		return element.kind === 'board' ? `volt-scratchboard:${element.board.id}` : null;
	}

	getDragLabel(elements: SidebarElement[]): string | undefined {
		const first = elements[0];
		return first?.kind === 'board' ? boardDisplayTitle(first.board) : undefined;
	}

	private boardsOf(data: IDragAndDropData): IScratchBoardMeta[] {
		if (!(data instanceof ElementsDragAndDropData)) {
			return [];
		}
		return (data.elements as SidebarElement[]).filter((e): e is Extract<SidebarElement, { kind: 'board' }> => e.kind === 'board').map(e => e.board);
	}

	onDragOver(data: IDragAndDropData, target: SidebarElement | undefined, _index: number | undefined, _sector: ListViewTargetSector | undefined): boolean | ITreeDragOverReaction {
		const boards = this.boardsOf(data);
		if (!boards.length || this.sidebar.renaming) {
			return false;
		}
		const over = { accept: true, effect: { type: ListDragOverEffectType.Move, position: ListDragOverEffectPosition.Over } } as const;
		if (!target) {
			return over;
		}
		if (target.kind === 'folder') {
			return { ...over, autoExpand: true };
		}
		if (target.kind === 'section') {
			return over;
		}
		if (target.kind === 'board') {
			return over;
		}
		return false;
	}

	drop(data: IDragAndDropData, target: SidebarElement | undefined): void {
		const boards = this.boardsOf(data);
		for (const board of boards) {
			if (!target || target.kind === 'empty') {
				this.sidebar.moveBoard(board.id, null);
			} else if (target.kind === 'folder') {
				this.sidebar.moveBoard(board.id, target.folder.id);
			} else if (target.kind === 'section') {
				if (target.id === 'pinned') {
					this.sidebar.setPinned(board, true);
				} else {
					this.sidebar.setArchived(board, true);
				}
			} else if (target.kind === 'board') {
				// Dropped on a board: join its place (its folder, or the section it is in).
				if (target.parent === 'pinned') {
					this.sidebar.setPinned(board, true);
				} else if (target.parent === 'archived') {
					this.sidebar.setArchived(board, true);
				} else {
					this.sidebar.moveBoard(board.id, target.board.folderId);
				}
			}
		}
	}

	dispose(): void { }
}
