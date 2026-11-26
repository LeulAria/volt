/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt on foldables and tablets (the browser only). A Fold goes from its phone-wide cover screen to
// its tablet-wide inner screen and back with a chat open: a menu hung off a title bar control the
// other layout hides is put away, the tools a phone showed over the chat come back beside it when
// unfolding, and a chat being typed into stays in front when folding. In book posture (the page
// spans two screen segments side by side) nothing sits across the hinge: the agents list, the chat
// and its tools are sized so the boundary between two of them lands on it. Touch targets for
// tablets are in voltWebFoldable.css.

import './media/voltWebFoldable.css';
import { addDisposableListener, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { AGENT_SIDEBAR_MIN_WIDTH, AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { onDidChangeShownAgentChat, shownAgentChat } from '../editor/agentShownChat.js';
import { AgentPhoneTool, agentPhoneTabs, agentPhoneTool, onDidChangeAgentToolEditors, openAgentToolsPanel, showAgentPhoneTool, VOLT_PHONE_LANDSCAPE_QUERY } from '../workspace/agentSurfaceHost.js';
import { VOLT_WEB_PHONE_QUERY } from './voltWebPhone.js';

/** The narrowest the chat gets in the left segment beside its tools before the agents list gives it room. */
const BOOK_CHAT_MIN_WIDTH = 240;

const BOOK_QUERY = '(horizontal-viewport-segments: 2)';

/**
 * The agents list's width before book posture sized it, and the width it got: the layout saves the
 * list's width, so a page reloaded in book posture would otherwise keep the hinge's width for good.
 */
const BOOK_LIST_WIDTH_KEY = 'volt.web.bookListWidth';

/** The hinge between two screen segments side by side: its left and right edges, in page pixels. */
interface IHinge {
	readonly start: number;
	readonly end: number;
}

/** Chrome's Viewport Segments API (`window.viewport.segments`), not in the DOM typings yet. */
interface IViewportWithSegments {
	readonly segments?: readonly DOMRect[] | null;
}

class VoltWebFoldableContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebFoldable';

	private readonly root: HTMLElement;
	private readonly phoneQuery: MediaQueryList;
	/** A phone on its side (a Fold's cover screen turned): its tools lie over the chat too. */
	private readonly landscapeQuery: MediaQueryList;
	private phone: boolean;
	/** The tool a phone last had in front of the chat, to bring back beside the chat once there is room. */
	private phoneTool: AgentPhoneTool | undefined;
	/** The chat {@link phoneTool} was in front of: another chat picked on the phone has its own tools. */
	private phoneToolChat: string | undefined;

	private readonly bookScheduler: RunOnceScheduler;
	/** Reads the hinge from CSS where the browser has the media query but not `window.viewport`. */
	private readonly hingeProbe: HTMLElement;
	/** The chat whose width and insets book posture set. */
	private bookChat: HTMLElement | undefined;
	/** What book posture last applied, so a layout pass that changes nothing does not lay out again. */
	private bookKey = '';
	/** The agents list's width before book posture sized it, given back when the posture ends. */
	private listWidthBeforeBook: number | undefined;
	/** The width book posture asked of the list, and the one it got (the list keeps to a share of the window). */
	private listTarget: { readonly asked: number; readonly got: number } | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService editorService: IEditorService,
	) {
		super();
		this.root = layoutService.mainContainer;
		this.readListWidth();
		const win = getWindow(this.root);
		this.phoneQuery = win.matchMedia(VOLT_WEB_PHONE_QUERY);
		this.landscapeQuery = win.matchMedia(VOLT_PHONE_LANDSCAPE_QUERY);
		this.phone = this.isPhone();
		if (this.phone) {
			this.notePhoneTool();
		}

		// After the layout has taken the new width, so the chat's tools already lie over it or beside it.
		this._register(layoutService.onDidLayoutMainContainer(() => this.syncPhone()));
		this._register(addDisposableListener(this.phoneQuery, 'change', () => this.syncPhone()));
		this._register(addDisposableListener(this.landscapeQuery, 'change', () => this.syncPhone()));
		this._register(onDidChangeAgentToolEditors(() => {
			if (this.phone) {
				this.notePhoneTool();
			}
		}));
		this._register(onDidChangeShownAgentChat(() => {
			if (this.phone) {
				this.notePhoneTool();
			}
		}));

		const doc = this.root.ownerDocument;
		this.hingeProbe = doc.body.appendChild(doc.createElement('div'));
		this.hingeProbe.className = 'volt-web-hinge-probe';
		this._register(toDisposable(() => this.hingeProbe.remove()));
		this.bookScheduler = this._register(new RunOnceScheduler(() => this.syncBook(), 0));
		const schedule = () => this.bookScheduler.schedule();
		this._register(addDisposableListener(win.matchMedia(BOOK_QUERY), 'change', schedule));
		this._register(addDisposableListener(win, 'resize', schedule));
		this._register(layoutService.onDidLayoutMainContainer(schedule));
		this._register(layoutService.onDidChangePartVisibility(schedule));
		this._register(onDidChangeLayoutMode(schedule));
		this._register(onDidChangeAgentToolEditors(schedule));
		this._register(editorService.onDidActiveEditorChange(schedule));
		this._register(addDisposableListener(this.root, AGENT_TOOLS_VISIBILITY_EVENT, schedule));
		this._register(toDisposable(() => this.clearBook(false)));
		this.syncBook();

		// The agents list's saved open state opens it at startup (layoutModeSwitch.ts), as a drawer over
		// the whole chat when the chat and its restored tools leave it no column (an unfolded Fold, a
		// tablet). A drawer stays closed until asked for; the list's column comes back with room.
		if (!this.phone && this.root.classList.contains('volt-agent-drawer-mode') && this.root.classList.contains('volt-agent-drawer-open')) {
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
	}

	//#region Fold and unfold

	/** What the phone's bar would show in front of the chat: a tool, or undefined for the chat itself. */
	private frontTool(): AgentPhoneTool | undefined {
		const tool = agentPhoneTool();
		return tool && tool !== 'chat' ? tool : undefined;
	}

	/** Whether the chat's tools lie over it (a phone, upright or on its side) rather than beside it. */
	private isPhone(): boolean {
		return this.phoneQuery.matches || this.landscapeQuery.matches;
	}

	/** Keeps the tool in front of the chat on a phone; Agent on the bar keeps the one shown before it. */
	private notePhoneTool(): void {
		const chat = shownAgentChat();
		const tool = this.frontTool();
		if (chat !== this.phoneToolChat) {
			this.phoneToolChat = chat;
			this.phoneTool = tool;
		} else if (tool) {
			this.phoneTool = tool;
		}
	}

	private syncPhone(): void {
		const phone = this.isPhone();
		if (phone === this.phone) {
			return;
		}
		this.phone = phone;
		// A menu or hover hangs off a control the other layout moves, or folds into the phone's "…".
		this.contextViewService.hideContextView();
		this.hoverService.hideHover(true);
		if (getLayoutMode(this.layoutService) !== 'agent') {
			this.phoneTool = undefined;
			this.phoneToolChat = undefined;
			return;
		}
		if (phone) {
			// Folding: the tools beside the chat now lie over it, unless the chat was being typed into
			// (the keyboard up over its composer): the message stays in front of the keyboard.
			this.phoneToolChat = shownAgentChat();
			this.phoneTool = this.frontTool();
			if (this.phoneTool && this.typingInChat()) {
				this.keepFocus(() => showAgentPhoneTool('chat'));
			}
			return;
		}
		// Unfolding: the tool the phone showed last comes back beside the chat. Agent on the bar only
		// put it behind the chat, a phone having room for one or the other.
		const tool = this.phoneToolChat === shownAgentChat() ? this.phoneTool : undefined;
		this.phoneTool = undefined;
		this.phoneToolChat = undefined;
		if (!tool || this.frontTool()) {
			return;
		}
		if (agentPhoneTabs().length) {
			this.keepFocus(() => openAgentToolsPanel());
		} else if (tool === 'editor' || tool === 'git') {
			// No tab: the files sidebar alone (Explorer or Source Control).
			this.keepFocus(() => showAgentPhoneTool(tool));
		}
	}

	/**
	 * Whether the keyboard is up over the chat (voltWebPhone.ts tracks it). Focus alone is not typing:
	 * the composer takes focus by itself when a chat opens.
	 */
	private typingInChat(): boolean {
		const active = this.root.ownerDocument.activeElement;
		return this.root.classList.contains('volt-phone-keyboard') && !!active && !!this.chatOnScreen()?.contains(active);
	}

	/** Runs `change` and gives focus back where it was: a pane brought to the front takes it. */
	private keepFocus(change: () => unknown): void {
		const doc = this.root.ownerDocument;
		const active = doc.activeElement;
		change();
		if (isHTMLElement(active) && active.isConnected && doc.activeElement !== active) {
			active.focus();
		}
	}

	//#endregion

	//#region Book posture

	/** The chat on screen in the main editor area (side chats are tabs of the tools, outside it). */
	private chatOnScreen(): HTMLElement | undefined {
		const editor = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		for (const main of editor?.querySelectorAll<HTMLElement>('.volt-agent-editor > .volt-agent-editor-main') ?? []) {
			const box = main.getBoundingClientRect();
			if (box.width > 0 && box.height > 0) {
				return main;
			}
		}
		return undefined;
	}

	/** The hinge while the page spans two segments side by side, else undefined. */
	private hinge(): IHinge | undefined {
		const win = getWindow(this.root);
		const segments = (win as unknown as { readonly viewport?: IViewportWithSegments }).viewport?.segments;
		if (segments) {
			const [left, right] = segments;
			return segments.length === 2 && Math.abs(left.y - right.y) < 1 && right.x > left.x
				? { start: left.x + left.width, end: right.x }
				: undefined;
		}
		if (!win.matchMedia(BOOK_QUERY).matches) {
			return undefined;
		}
		// The probe's left is the first segment's right edge, its width the hinge's (voltWebFoldable.css).
		const style = win.getComputedStyle(this.hingeProbe);
		const start = Number.parseFloat(style.left);
		const width = Number.parseFloat(style.width) || 0;
		return start > 0 ? { start, end: start + width } : undefined;
	}

	private syncBook(): void {
		const hinge = this.isPhone() || getLayoutMode(this.layoutService) !== 'agent' ? undefined : this.hinge();
		const chat = hinge && this.chatOnScreen();
		if (!hinge || !chat) {
			this.clearBook(true);
			return;
		}
		if (this.bookChat !== chat) {
			this.clearChat();
			this.bookChat = chat;
		}
		const container = chat.parentElement!;
		const list = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) && !this.root.classList.contains('volt-agent-drawer-mode');
		const area = this.root.querySelector<HTMLElement>(':scope > .volt-agent-tools-area:not(.hidden)');
		// Full screen tools cover the window on purpose; a floating preview is not beside the chat.
		const tools = container.classList.contains('has-surfaces') && !!area && !area.classList.contains('fullscreen');
		let split = 0;
		let insetStart = 0;
		let insetEnd = 0;
		let box = container.getBoundingClientRect();
		if (tools) {
			// The chat in the left segment, its tools in the right. The list makes room for the chat if it must.
			if (list && hinge.start - box.left < BOOK_CHAT_MIN_WIDTH) {
				this.sizeList(Math.max(AGENT_SIDEBAR_MIN_WIDTH, hinge.start - BOOK_CHAT_MIN_WIDTH));
				box = container.getBoundingClientRect();
			}
			split = Math.max(0, Math.round(hinge.end - box.left));
			// A hinge with a width (the mask between two screens) hides the end of the chat's row: its content stops before.
			insetEnd = Math.round(hinge.end - hinge.start);
		} else if (list) {
			// The agents list in the left segment, the chat in the right. The list keeps to a share of
			// the window and may stop short of the hinge: the chat's content then starts past it.
			this.sizeList(hinge.start);
			box = container.getBoundingClientRect();
			insetStart = Math.max(0, Math.round(hinge.end - box.left));
		} else if (box.left < hinge.start && box.right > hinge.end) {
			// Nothing beside the chat: it keeps to the left segment.
			insetEnd = Math.round(box.right - hinge.start);
		}
		this.root.classList.add('volt-web-book');
		this.root.classList.toggle('volt-web-book-split', split > 0);
		chat.classList.toggle('volt-book-split', split > 0);
		chat.classList.toggle('volt-book-inset', insetStart > 0 || insetEnd > 0);
		chat.style.setProperty('--volt-book-chat-width', `${split}px`);
		chat.style.setProperty('--volt-book-inset-start', `${insetStart}px`);
		chat.style.setProperty('--volt-book-inset-end', `${insetEnd}px`);
		this.syncTitle(hinge, insetStart);
		const key = `${hinge.start},${hinge.end},${split},${insetStart},${insetEnd}`;
		if (key !== this.bookKey) {
			this.bookKey = key;
			// The tools area is placed from the chat's edge, which moved without the window changing size.
			this.layoutService.layout();
		}
	}

	/** The chat's title in the title bar keeps to one side of the hinge, as the chat under it does. */
	private syncTitle(hinge: IHinge, insetStart: number): void {
		const style = this.root.style;
		style.setProperty('--volt-book-title-inset', `${insetStart}px`);
		style.removeProperty('--volt-book-title-max');
		const header = this.root.querySelector<HTMLElement>('.part.titlebar .volt-agent-primary-header');
		const left = header?.getBoundingClientRect().left ?? hinge.start;
		if (left < hinge.start) {
			style.setProperty('--volt-book-title-max', `${Math.max(0, Math.floor(hinge.start - left - 8))}px`);
		}
	}

	/** Sizes the agents list column, keeping the width it had for when book posture ends. */
	private sizeList(width: number): void {
		const size = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
		if (Math.abs(size.width - width) < 1 || (this.listTarget?.asked === width && Math.abs(size.width - this.listTarget.got) < 1)) {
			return;
		}
		this.listWidthBeforeBook ??= size.width;
		this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width, height: size.height });
		this.listTarget = { asked: width, got: this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width };
		this.storageService.store(BOOK_LIST_WIDTH_KEY, JSON.stringify({ before: this.listWidthBeforeBook, got: this.listTarget.got }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** Picks up a width book posture gave the list before the page was reloaded. */
	private readListWidth(): void {
		try {
			const saved = JSON.parse(this.storageService.get(BOOK_LIST_WIDTH_KEY, StorageScope.WORKSPACE) ?? 'null') as { before?: unknown; got?: unknown } | null;
			if (typeof saved?.before === 'number' && typeof saved.got === 'number') {
				this.listWidthBeforeBook = saved.before;
				// Asked for nothing in this page: the next book pass sizes the list again.
				this.listTarget = { asked: -1, got: saved.got };
			}
		} catch {
			this.storageService.remove(BOOK_LIST_WIDTH_KEY, StorageScope.WORKSPACE);
		}
	}

	private clearChat(): void {
		const chat = this.bookChat;
		this.bookChat = undefined;
		if (chat) {
			chat.classList.remove('volt-book-split', 'volt-book-inset');
			for (const name of ['--volt-book-chat-width', '--volt-book-inset-start', '--volt-book-inset-end']) {
				chat.style.removeProperty(name);
			}
		}
	}

	private clearBook(relayout: boolean): void {
		const was = this.root.classList.contains('volt-web-book');
		this.clearChat();
		this.root.classList.remove('volt-web-book', 'volt-web-book-split');
		this.root.style.removeProperty('--volt-book-title-inset');
		this.root.style.removeProperty('--volt-book-title-max');
		this.bookKey = '';
		this.restoreList();
		if (was && relayout) {
			this.layoutService.layout();
		}
	}

	/**
	 * The list gets its width back once book posture ends, unless it was dragged to another one in the
	 * meantime. A list closed then waits until it shows again in its column (a part visibility change
	 * runs {@link syncBook}), or it would come back at the width the hinge gave it.
	 */
	private restoreList(): void {
		const before = this.listWidthBeforeBook;
		const target = this.listTarget;
		if (before === undefined || !target || !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) || this.root.classList.contains('volt-agent-drawer-mode')) {
			return;
		}
		this.listWidthBeforeBook = undefined;
		this.listTarget = undefined;
		this.storageService.remove(BOOK_LIST_WIDTH_KEY, StorageScope.WORKSPACE);
		const size = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
		if (Math.abs(size.width - target.got) < 1) {
			this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: before, height: size.height });
		}
	}

	//#endregion
}

registerWorkbenchContribution2(VoltWebFoldableContribution.ID, VoltWebFoldableContribution, WorkbenchPhase.AfterRestored);
