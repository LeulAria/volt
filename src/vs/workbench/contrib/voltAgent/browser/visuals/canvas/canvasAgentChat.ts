/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, getWindow, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IAgentHistoryService } from '../../../../../services/voltRuntime/common/history/agentHistory.js';
import { setAgentTooltip } from '../../chrome/agentTooltip.js';
import { createThinkingDots } from '../../composer/agentComposerChips.js';
import { AgentEditor, IAgentDockState } from '../../editor/agentEditor.js';
import { AgentEditorInput } from '../../editor/agentEditorInput.js';
import { openAgentPanel } from '../../workspace/agentPanels.js';
import { setPageContext } from '../agentVisualBridge.js';
import { ICanvasChatIsland } from './canvasAgent.js';
import type { ICanvasDoc } from './canvasModel.js';
import { IVoltCanvasService } from './canvasService.js';

const OPEN_KEY = 'volt.canvas.islandOpen';
/** The transcript card, as tall as Scratch's dock card by default. */
const DEFAULT_HEIGHT = 380;
const MIN_HEIGHT = 140;
/** The open card stops this far under the page's top edge, clear of the board's top bars. */
const TOP_CLEARANCE = 56;
const GAP = 8;
const BOTTOM = 12;
/** Something open in the chat that Escape closes before it closes the island. */
const ESCAPE_FIRST_CONTEXT_KEYS: readonly string[] = [
	'suggestWidgetVisible', 'inlineSuggestionVisible', 'inlineEditIsVisible', 'parameterHintsVisible', 'findWidgetVisible',
	'renameInputVisible', 'inSnippetMode', 'editorHasMultipleSelections', 'editorHasSelection', 'codeActionMenuVisible',
	'messageVisible', 'referenceSearchVisible', 'inQuickOpen', 'voltInlineCommentVisible', 'voltAgentFindWidgetVisible',
];

/**
 * Which chat the island shows. `own`: the canvas's chat, held here (its transcript in the card, its
 * composer under it). `beside`: that chat is open in a panel on screen, so the island never takes it
 * (it would move the transcript out of that panel): it shows the chat's live state and focuses it.
 * `new`: the canvas has no chat yet; the composer starts one, which becomes the canvas's chat.
 */
type IslandMode = 'own' | 'beside' | 'new';

/**
 * The canvas tab's chat island, as Scratch docks its agents at the bottom of the board: closed, a
 * pill with the chat's live step; open, the chat's transcript in a card with its chips and composer
 * under it. The chat is a real one (model picker, approvals, queue). It shows the chat's own input
 * (AgentEditorInput.acquire), so it never records a run twice, and lets go of it while the tab is
 * hidden or the chat opens in a panel, which takes it over.
 */
export class CanvasChatIsland extends Disposable implements ICanvasChatIsland {

	private readonly element: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly openButton: HTMLButtonElement;
	private readonly body: HTMLElement;
	private readonly chatHost: HTMLElement;
	private readonly bar: HTMLButtonElement;
	private readonly barStatus: HTMLElement;
	private readonly barTitle: HTMLElement;
	private readonly barActivity: HTMLElement;
	private readonly barChevron: HTMLElement;
	private readonly chatStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly inputListener = this._register(new MutableDisposable());
	private readonly besideStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly route = this._register(new MutableDisposable());
	private doc: ICanvasDoc | undefined;
	/** The chat a canvas with none starts, until its first message makes it the canvas's. */
	private freshSession = `agent-${generateUuid()}`;
	private mode: IslandMode | undefined;
	private sessionId: string | undefined;
	private beside: AgentEditor | undefined;
	private chat: AgentEditor | undefined;
	private chatSession: string | undefined;
	private composerObserver: ResizeObserver | undefined;
	private observedComposer: Element | undefined;
	private binding = 0;
	private visible = false;
	private open: boolean;
	private focusPending = false;
	private barState: string | undefined;

	constructor(
		private readonly parent: HTMLElement,
		private readonly canvasId: string,
		@IVoltCanvasService private readonly canvas: IVoltCanvasService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.open = storageService.getBoolean(OPEN_KEY, StorageScope.PROFILE, false);

		this.element = append(parent, $('.volt-canvas-dock'));
		this.element.hidden = true;
		this._register(toDisposable(() => this.element.remove()));

		// Open: the transcript card (the browser dock's float), then the chat's chips and composer.
		this.panel = append(this.element, $('.volt-canvas-dock-panel'));
		this.panel.setAttribute('role', 'region');
		this.panel.setAttribute('aria-label', localize('voltCanvas.island', "Chat about this canvas"));
		const head = append(this.panel, $('.volt-canvas-dock-head.volt-browser-dock-float-head'));
		this.titleEl = append(head, $('span.volt-canvas-dock-title.volt-browser-dock-float-title'));
		const actions = append(head, $('.volt-browser-dock-float-actions'));
		const action = (icon: typeof Codicon.close, label: string, run: () => void): HTMLButtonElement => {
			const b = append(actions, $('button.volt-browser-dock-icon')) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.appendChild(renderIcon(icon));
			setAgentTooltip(b, label, undefined, undefined, 'above');
			this._register(addDisposableListener(b, 'click', e => {
				e.stopPropagation();
				run();
			}));
			return b;
		};
		this.openButton = action(Codicon.screenFull, localize('voltCanvas.islandOpenChat', "Open in Agents"), () => void this.openInAgents());
		action(Codicon.close, localize('voltCanvas.islandClose', "Close"), () => this.setOpen(false));
		this.body = append(this.panel, $('.volt-canvas-dock-body.volt-browser-dock-float-body'));
		this.chatHost = append(this.element, $('.volt-canvas-dock-chat.volt-agent-toolless'));

		// Closed: one pill with the chat and what it is doing.
		this.bar = append(this.element, $('button.volt-canvas-dock-bar')) as HTMLButtonElement;
		this.bar.type = 'button';
		this.barStatus = append(this.bar, $('span.volt-canvas-dock-bar-status'));
		this.barTitle = append(this.bar, $('span.volt-canvas-dock-bar-title'));
		this.barActivity = append(this.bar, $('span.volt-canvas-dock-bar-activity'));
		this.barActivity.setAttribute('aria-live', 'polite');
		this.barChevron = append(this.bar, $('span.volt-canvas-dock-bar-chevron'));
		this._register(addDisposableListener(this.bar, 'click', () => {
			if (this.mode === 'beside') {
				this.beside?.focus();
			} else {
				this.setOpen(true, true);
			}
		}));
		// Escape in the open island (transcript or composer) folds it to its pill, unless something open
		// inside takes the key first (suggestions, ghost text, Find, a selection), as in Scratch's dock.
		this._register(addDisposableListener(this.element, 'keydown', e => {
			if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !this.open || !isHTMLElement(e.target) || this.bar.contains(e.target)) {
				return;
			}
			const context = this.contextKeyService.getContext(e.target);
			if (ESCAPE_FIRST_CONTEXT_KEYS.some(key => !!context.getValue(key))) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.setOpen(false);
			this.bar.focus();
		}));
		this._register(addDisposableListener(head, 'dblclick', e => {
			if (isHTMLElement(e.target) && !e.target.closest('button')) {
				this.setOpen(false);
			}
		}));

		const observer = new (getWindow(parent).ResizeObserver)(() => this.layoutChat());
		observer.observe(parent);
		this._register(toDisposable(() => observer.disconnect()));
		this._register(canvas.onDidChange(change => {
			if (change.id === canvasId) {
				this.setDoc(change.doc);
			}
		}));
		// A panel opening (or closing) the canvas's chat: the island gives it up, or takes it back.
		this._register(editorService.onDidVisibleEditorsChange(() => this.sync()));
		this._register(history.onDidChange(() => this.renderBar()));
		void canvas.get(canvasId).then(doc => {
			if (doc && !this._store.isDisposed && !this.doc) {
				this.setDoc(doc);
			}
		});
	}

	setVisible(visible: boolean): void {
		if (this.visible !== visible) {
			this.visible = visible;
			this.sync();
		}
	}

	private setDoc(doc: ICanvasDoc): void {
		const chatChanged = doc.chat !== this.doc?.chat;
		this.doc = doc;
		if (chatChanged) {
			this.sync();
		}
	}

	/** The canvas's chat when it is shown in a panel on screen (not the island's own view of it). */
	private visiblePane(sessionId: string): AgentEditor | undefined {
		for (const pane of this.editorService.visibleEditorPanes) {
			if (pane instanceof AgentEditor && pane !== this.chat && pane.sessionId === sessionId) {
				return pane;
			}
		}
		return undefined;
	}

	/** Works out which chat to show and how, and binds or lets go of it. */
	private sync(): void {
		if (!this.doc) {
			return;
		}
		const chat = this.doc.chat;
		const pane = chat ? this.visiblePane(chat) : undefined;
		const mode: IslandMode = !chat ? 'new' : pane ? 'beside' : 'own';
		const sessionId = chat ?? this.freshSession;
		if (!this.visible) {
			this.release();
			this.route.clear();
			this.setBeside(undefined);
			this.mode = mode;
			this.sessionId = sessionId;
			this.render();
			return;
		}
		const changed = mode !== this.mode || sessionId !== this.sessionId;
		this.mode = mode;
		this.sessionId = sessionId;
		if (mode === 'beside') {
			this.release();
			this.route.clear();
			this.setBeside(pane);
		} else {
			this.setBeside(undefined);
			if (changed || !this.route.value) {
				this.registerRoute(sessionId);
			}
			if (this.chatSession !== sessionId || !this.chat) {
				void this.bind(sessionId);
			}
		}
		this.render();
	}

	/** Prompts from the page (comments, Ask, Next screen) go to the chat the island holds. */
	private registerRoute(sessionId: string): void {
		this.route.value = this.canvas.registerAgent(this.canvasId, {
			sessionId,
			prompt: (text, send) => {
				const editor = this.chat;
				if (!editor || this.chatSession !== sessionId) {
					return;
				}
				this.brief(sessionId);
				// A chat not started yet starts from its composer (which picks its project): the text waits there.
				if (send && this.mode === 'own') {
					editor.submitPrompt(text);
					return;
				}
				this.setOpen(true);
				editor.prefillDraft(text);
			},
		});
	}

	/** What the chat is looking at rides along with its next message: this canvas, to change in place. */
	private brief(sessionId: string): void {
		const doc = this.doc;
		if (!doc) {
			return;
		}
		setPageContext(sessionId, `canvas:${doc.id}`, doc.title, JSON.stringify({
			canvas: doc.id,
			title: doc.title,
			version: doc.version,
			frames: doc.frames.map(frame => ({ id: frame.id, name: frame.name, kind: frame.kind })),
			openComments: doc.comments.filter(comment => comment.status === 'open').length,
			note: `The user is chatting from the design canvas "${doc.title}" (it is on screen above this chat). Change it in place with canvas_update {"canvas": "${doc.id}", ...} (edits for small changes), read it with canvas_read, and never make a new canvas for a change.`,
		}));
	}

	/** The chat is open in a panel: the pill follows its state and focuses it. */
	private setBeside(pane: AgentEditor | undefined): void {
		if (this.beside === pane) {
			return;
		}
		this.beside = pane;
		this.barState = undefined;
		if (!pane) {
			this.besideStore.clear();
			return;
		}
		const store = new DisposableStore();
		store.add(pane.onDidChangeDock(() => this.renderBar()));
		this.besideStore.value = store;
	}

	private setOpen(open: boolean, focus = false): void {
		if (this.mode === 'beside') {
			open = false;
		}
		if (!open) {
			this.focusPending = false;
		}
		if (this.open !== open) {
			this.open = open;
			this.storageService.store(OPEN_KEY, open, StorageScope.PROFILE, StorageTarget.USER);
			this.render();
			this.layoutChat();
		}
		if (open && focus) {
			if (this.chat && this.chatSession === this.sessionId) {
				this.chat.focus();
			} else {
				this.focusPending = true;
			}
		}
	}

	// ---- Rendering ------------------------------------------------------------------------

	private dockState(): IAgentDockState | undefined {
		if (this.mode === 'beside') {
			return this.beside?.getDockState();
		}
		return this.chat && this.chatSession === this.sessionId ? this.chat.getDockState() : undefined;
	}

	private chatTitle(): string {
		const state = this.dockState();
		const stored = this.sessionId ? this.history.get(this.sessionId)?.title : undefined;
		return state?.title || stored || localize('voltCanvas.islandChat', "Chat");
	}

	private render(): void {
		const shown = this.visible && !!this.doc && !!this.mode;
		this.element.hidden = !shown;
		if (!shown) {
			return;
		}
		const open = this.open && this.mode !== 'beside';
		const hasThread = this.mode === 'own';
		this.element.classList.toggle('open', open);
		this.element.dataset.mode = this.mode;
		this.panel.hidden = !open || !hasThread;
		this.chatHost.hidden = !open;
		this.bar.hidden = open;
		this.openButton.hidden = this.mode !== 'own';
		this.titleEl.textContent = this.chatTitle();
		this.renderBar();
	}

	/** The pill: the chat, its live step (or state), and where a click goes. */
	private renderBar(): void {
		if (!this.mode || this.bar.hidden) {
			if (this.mode && this.mode !== 'beside' && this.open) {
				this.titleEl.textContent = this.chatTitle();
			}
			return;
		}
		const state = this.dockState();
		const working = !!state?.streaming;
		const look = working ? 'working' : this.mode;
		if (this.barState !== look) {
			this.barState = look;
			this.bar.dataset.state = working ? 'working' : 'idle';
			this.barStatus.replaceChildren(working ? createThinkingDots() : renderIcon(this.mode === 'new' ? Codicon.sparkle : Codicon.commentDiscussion));
			this.barChevron.replaceChildren(renderIcon(this.mode === 'beside' ? Codicon.arrowRight : Codicon.chevronUp));
		}
		const title = this.mode === 'new' ? localize('voltCanvas.islandNew', "Ask about this design") : this.chatTitle();
		this.barTitle.textContent = title;
		let activity = '';
		if (working) {
			const step = state?.activity;
			activity = step?.text ? (step.more > 0 ? `${step.text} +${step.more}` : step.text) : state?.status ?? '';
		} else if (this.mode === 'beside') {
			activity = localize('voltCanvas.islandBeside', "Open beside");
		}
		this.barActivity.textContent = activity;
		const tip = this.mode === 'beside'
			? localize('voltCanvas.islandFocusTip', "Go to the chat")
			: this.mode === 'new' ? localize('voltCanvas.islandNewTip', "Start a chat about this canvas") : localize('voltCanvas.islandOpenTip', "Show the chat");
		setAgentTooltip(this.bar, tip, undefined, undefined, 'above');
		this.bar.setAttribute('aria-label', activity ? `${title}, ${activity}. ${tip}` : `${title}. ${tip}`);
	}

	// ---- The chat -------------------------------------------------------------------------

	private async bind(sessionId: string): Promise<void> {
		const seq = ++this.binding;
		const editor = this.chat ?? this.createChat();
		this.chatSession = sessionId;
		// The chat's own input: the one a panel shows or a run records, else a headless one. It is never
		// ours to dispose, and a panel that opens the chat later takes it over, so no run is recorded twice.
		const input = AgentEditorInput.acquire(sessionId, this.instantiationService);
		// A headless input lets go of the chat when its run ends: show the chat's next one.
		this.inputListener.value = input.onWillDispose(() => {
			if (this.chat === editor && this.chatSession === sessionId) {
				this.chatSession = undefined;
				getWindow(this.element).setTimeout(() => this.sync(), 0);
			}
		});
		try {
			await editor.setInput(input, { preserveFocus: true }, {}, CancellationToken.None);
		} catch {
			if (seq === this.binding) {
				this.release();
			}
			return;
		}
		if (seq !== this.binding || this.chat !== editor) {
			return;
		}
		this.brief(sessionId);
		this.mountThread();
		this.observeComposer();
		this.render();
		this.layoutChat();
		if (this.focusPending && this.open) {
			this.focusPending = false;
			editor.focus();
		}
	}

	private createChat(): AgentEditor {
		const store = new DisposableStore();
		const editor = this.instantiationService.createInstance(AgentEditor, this.editorGroupsService.mainPart.activeGroup);
		store.add(editor);
		editor.create(this.chatHost);
		editor.setVisible(true);
		store.add(editor.onDidChangeDock(() => this.renderBar()));
		store.add(editor.onDidComposerSend(() => {
			const sessionId = this.chatSession;
			if (!sessionId) {
				return;
			}
			if (this.mode === 'new' && sessionId === this.freshSession) {
				// The first message started the chat: it is the canvas's chat from now on.
				this.freshSession = `agent-${generateUuid()}`;
				void this.canvas.setChat(this.canvasId, sessionId);
			}
			// The canvas rides along with the next message too (the user may type anything).
			getWindow(this.element).setTimeout(() => this.brief(sessionId), 0);
			this.mountThread();
			this.render();
			this.layoutChat();
		}));
		// The composer grows with what is typed, the approval tray and the queue: the chat's slot follows it.
		this.composerObserver = new (getWindow(this.chatHost).ResizeObserver)(() => this.layoutChat());
		store.add(toDisposable(() => {
			this.composerObserver?.disconnect();
			this.composerObserver = undefined;
			this.observedComposer = undefined;
			// The transcript goes home before its chat goes.
			editor.getThreadView()?.restore();
			if (this.chat === editor) {
				this.chat = undefined;
				this.chatSession = undefined;
			}
			this.chatHost.replaceChildren();
			this.body.replaceChildren();
		}));
		this.chatStore.value = store;
		this.chat = editor;
		return editor;
	}

	private observeComposer(): void {
		const composer = this.chatHost.querySelector('.volt-agent-composer');
		if (composer && composer !== this.observedComposer && this.composerObserver) {
			this.composerObserver.disconnect();
			this.composerObserver.observe(composer);
			for (const child of composer.children) {
				this.composerObserver.observe(child);
			}
			this.observedComposer = composer;
		}
	}

	/** The transcript lives in the card, as in the browser dock; the chat keeps its chips and composer. */
	private mountThread(): void {
		const thread = this.chat?.getThreadView();
		if (thread && thread.element.parentElement !== this.body) {
			thread.mount(this.body);
		}
	}

	/** Lets go of the chat (the input stays with whoever records it). */
	private release(): void {
		this.binding++;
		this.inputListener.clear();
		const editor = this.chat;
		if (!editor) {
			return;
		}
		editor.setVisible(false);
		editor.clearInput();
		this.chatStore.clear();
		this.barState = undefined;
	}

	/** Sizes the chat's slot to its composer, and the card to what is left of the page. */
	private layoutChat(): void {
		if (this.element.hidden || !this.open || this.chatHost.hidden) {
			return;
		}
		const composer = this.chatHost.querySelector<HTMLElement>('.volt-agent-composer');
		const composerHeight = this.chat ? Math.ceil(composer?.offsetHeight ?? 0) : 0;
		// The chips (and the approval tray or queue, when they show) float over the composer: the card ends above them.
		let floating = 0;
		if (composer && composerHeight > 0) {
			const top = composer.getBoundingClientRect().top;
			for (const child of composer.children) {
				const rect = child.getBoundingClientRect();
				if (rect.height > 0) {
					floating = Math.max(floating, Math.ceil(top - rect.top));
				}
			}
		}
		const margin = `${floating}px`;
		if (this.chatHost.style.marginTop !== margin) {
			this.chatHost.style.marginTop = margin;
		}
		if (this.chat && composerHeight > 0) {
			if (this.chatHost.style.height !== `${composerHeight}px`) {
				this.chatHost.style.height = `${composerHeight}px`;
			}
			const width = this.chatHost.clientWidth;
			if (width > 0) {
				this.chat.layout(new Dimension(width, composerHeight));
			}
		}
		if (!this.panel.hidden) {
			const room = this.parent.clientHeight - TOP_CLEARANCE - BOTTOM - (composerHeight ? composerHeight + floating + GAP : 0);
			const height = Math.round(Math.max(Math.min(MIN_HEIGHT, room), Math.min(DEFAULT_HEIGHT, room)));
			this.panel.style.height = `${height}px`;
		}
		this.chat?.layoutThread();
		this.chat?.getThreadView()?.layout();
	}

	private async openInAgents(): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId || this.mode !== 'own') {
			return;
		}
		// Let go first, so the chat's panel takes the transcript over from a single owner.
		this.release();
		this.route.clear();
		await openAgentPanel(this.editorGroupsService, this.instantiationService, sessionId);
		this.sync();
	}
}
