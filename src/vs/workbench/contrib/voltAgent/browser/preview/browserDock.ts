/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { revealAgentSidePanel } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import '../media/agentEditor.css';
import { AgentComposerChips, createThinkingDots } from '../composer/agentComposerChips.js';
import { AgentComposerQueue, IAgentQueueEditSurface, queueRowActions } from '../composer/agentComposerQueue.js';
import { cloneDisplayMentions } from '../composer/agentMentions.js';
import { AgentEditor, IAgentDockState, IAgentPromptDisplay } from '../editor/agentEditor.js';
import { AGENT_SIDE_PANEL_VIEW_ID, AgentEditorInput } from '../editor/agentEditorInput.js';
import { AgentSidePanel } from '../chrome/agentSidePanel.js';
import { AgentThreadView } from '../editor/agentThreadView.js';
import { formatAgentTooltipShortcut, setAgentTooltip } from '../chrome/agentTooltip.js';
import { BrowserAgentComposer } from './browserComposer.js';
import { IBrowserCommentMessage, IVoltBrowserComments } from './browserCommentStore.js';

/**
 * idle: a thin glass bar. activity: unfocused while the agent works, the live step ("Explored
 * available tools +2"). hover: "Message Volt ⌘L". expanded: the composer and its chips.
 */
type DockMode = 'idle' | 'activity' | 'hover' | 'expanded' | 'chip';

/** The activity pill's padding (12 + 14), dots and gap (13 + 8), and border, around its text. */
const ACTIVITY_CHROME_PX = 12 + 14 + 13 + 8 + 2;
const ACTIVITY_MAX_PX = 420;

export class BrowserAgentDock extends Disposable {

	readonly element: HTMLElement;

	private readonly clusterEl: HTMLElement;
	private readonly shellEl: HTMLElement;
	private readonly labelEl: HTMLButtonElement;
	private readonly labelIconEl: HTMLElement;
	private readonly labelTextEl: HTMLElement;
	private readonly labelKbEl: HTMLElement;
	private readonly commentsChip: HTMLButtonElement;
	private readonly commentsLine: HTMLButtonElement;
	/** The browser tab whose comments go with the next message. */
	private commentViewId: string | undefined;
	private readonly activityEl: HTMLElement;
	private readonly activityTextEl: HTMLElement;
	private readonly activityMoreEl: HTMLElement;
	private readonly chips: AgentComposerChips;
	private readonly composerHost: HTMLElement;
	private readonly floatEl: HTMLElement;
	private readonly floatTitle: HTMLElement;
	private readonly floatBody: HTMLElement;
	private readonly hitEl: HTMLElement;
	private readonly composer: BrowserAgentComposer;
	private readonly composerQueue: AgentComposerQueue;
	private readonly editSurface: IAgentQueueEditSurface;
	/** The queued messages ticked while Start Multitasking is on; undefined when it is off. */
	private multitaskPick: readonly string[] | undefined;
	private readonly agentStore = this._register(new MutableDisposable<DisposableStore>());
	private agentEditor: AgentEditor | undefined;
	private hostedThread: AgentThreadView | undefined;
	private expanded = false;
	private floatOpen = false;
	private hovered = false;
	private pendingWork = false;
	private browserOwned = false;
	private mode: DockMode = 'idle';
	/** The chat whose tools hold this browser, when there is one: prompts go to it, not to a hidden chat. */
	private chatResolver: (() => string | undefined) | undefined;
	/** Bound to that chat: its thread is only borrowed while the float is open. */
	private external = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IVoltBrowserComments private readonly commentStore: IVoltBrowserComments,
	) {
		super();
		this.element = $('.volt-browser-dock');

		this.floatEl = append(this.element, $('.volt-browser-dock-float'));
		const floatHead = append(this.floatEl, $('.volt-browser-dock-float-head'));
		this.floatTitle = append(floatHead, $('span.volt-browser-dock-float-title'));
		const floatActions = append(floatHead, $('.volt-browser-dock-float-actions'));
		const expandBtn = append(floatActions, $('button.volt-browser-dock-icon')) as HTMLButtonElement;
		setAgentTooltip(expandBtn, localize('voltBrowser.dockExpand', "Open in Agents"));
		expandBtn.appendChild(renderIcon(Codicon.screenFull));
		const closeBtn = append(floatActions, $('button.volt-browser-dock-icon')) as HTMLButtonElement;
		setAgentTooltip(closeBtn, localize('voltBrowser.dockClose', "Close"));
		closeBtn.appendChild(renderIcon(Codicon.close));
		this.floatBody = append(this.floatEl, $('.volt-browser-dock-float-body'));

		this.chips = this._register(instantiationService.createInstance(AgentComposerChips, {
			dock: true,
			onMultitaskPickCancel: () => this.composerQueue.stopPicking(),
			onStatusClick: () => {
				this.setFloatOpen(true);
				this.setExpanded(true);
			},
		}));
		this.chips.setHostOpen(false);

		this.hitEl = append(this.element, $('.volt-browser-dock-hit'));
		append(this.hitEl, this.chips.element);
		this.clusterEl = append(this.hitEl, $('.volt-browser-dock-cluster'));
		this.shellEl = append(this.clusterEl, $('.volt-browser-dock-shell'));
		this.labelEl = append(this.shellEl, $('button.volt-browser-dock-label')) as HTMLButtonElement;
		this.labelEl.type = 'button';
		this.labelIconEl = append(this.labelEl, $('span.volt-browser-dock-label-icon.hidden'));
		this.labelIconEl.appendChild(renderIcon(Codicon.comment));
		this.labelTextEl = append(this.labelEl, $('span.volt-browser-dock-label-text'));
		this.labelTextEl.textContent = localize('voltBrowser.messageAgent', "Message Volt");
		this.labelKbEl = append(this.labelEl, $('span.volt-browser-dock-label-kb'));
		this.labelKbEl.textContent = formatAgentTooltipShortcut({ meta: true, key: 'L' });
		this.activityEl = append(this.shellEl, $('.volt-browser-dock-activity'));
		this.activityEl.setAttribute('aria-live', 'polite');
		append(this.activityEl, createThinkingDots());
		this.activityTextEl = append(this.activityEl, $('span.volt-browser-dock-activity-text'));
		this.activityMoreEl = append(this.activityEl, $('span.volt-browser-dock-activity-more'));
		this.composerHost = append(this.shellEl, $('.volt-browser-dock-composer'));
		this.composer = this._register(instantiationService.createInstance(BrowserAgentComposer, {
			dock: true,
			onSubmit: text => void this.submit(text),
			onPrefill: text => void this.submit(text),
			onLayout: () => {
				if (this.mode === 'expanded') {
					this.shellEl.style.height = 'auto';
				}
			},
			onBlur: () => {
				const win = getWindow(this.element);
				win.setTimeout(() => {
					if (this.agentEditor?.isEditingUser()) {
						return;
					}
					const active = win.document.activeElement;
					if (this.isDockSurface(active)
						|| win.document.querySelector('.volt-agent-plus-menu')
						|| win.document.querySelector('.volt-agent-dropdown')
						|| win.document.querySelector('.monaco-context-view')) {
						return;
					}
					this.dismissToIdle();
				}, 0);
			},
			onStop: () => this.stopRun(),
			onKeepExpanded: () => this.setExpanded(true),
			onEscape: () => {
				if (!this.editingQueued()) {
					return false;
				}
				this.agentEditor?.cancelQueueEdit();
				return true;
			},
			onMode: id => this.composerQueue.setMode(id),
		}));
		// A queued message is edited here, in the dock's own composer, as the chat edits it in its own.
		this.editSurface = {
			content: () => ({ text: this.composer.getDisplayText(), mentions: cloneDisplayMentions(this.composer.getDisplayMentions()) }),
			setContent: (text, mentions) => {
				this.setExpanded(true);
				this.composer.setContent(text, mentions);
				this.sync();
			},
			focus: () => this.composer.focus(),
		};
		this.composerQueue = this._register(instantiationService.createInstance(AgentComposerQueue, {
			// The same rows as the chat's card: edit, send now, send in a new chat, resume, remove, reorder.
			...queueRowActions(() => this.agentEditor, this.editSurface),
			onMultitask: () => {
				this.composer.setMode('Multitask');
				this.composerQueue.setMode('Multitask');
				if (this.agentEditor) {
					this.agentEditor.startMultitasking();
				}
			},
			onMultitaskPick: ids => this.setMultitaskPick(ids),
		}));
		this.hitEl.insertBefore(this.composerQueue.element, this.chips.element);
		// The tab's comments waiting to go: a chip in the row, a blue line in the composer. Both open the list.
		this.commentsChip = $('button.volt-agent-composer-chip.comments.volt-browser-dock-chip.hidden') as HTMLButtonElement;
		this.commentsChip.type = 'button';
		this.commentsChip.appendChild(renderIcon(Codicon.comment));
		append(this.commentsChip, $('span.volt-agent-composer-chip-label'));
		this.chips.element.insertBefore(this.commentsChip, this.chips.element.firstChild);
		this.commentsLine = append(this.composerHost, $('button.volt-browser-dock-comments-line.hidden')) as HTMLButtonElement;
		this.commentsLine.type = 'button';
		this.commentsLine.appendChild(renderIcon(Codicon.comment));
		append(this.commentsLine, $('span'));
		for (const button of [this.commentsChip, this.commentsLine]) {
			this._register(addDisposableListener(button, 'mousedown', e => e.preventDefault()));
			this._register(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.showComments();
			}));
		}
		this._register(this.commentStore.onDidChange(() => this.sync()));
		// The chips and cards over the composer show and hide themselves: the solid tray behind them follows (browserEditor.css).
		const syncStack = () => this.element.classList.toggle('has-stack', this.chips.element.classList.contains('is-visible') || this.chips.element.classList.contains('has-comments') || this.composerQueue.element.classList.contains('has-stack'));
		const stackWatch = new (getWindow(this.element).MutationObserver)(syncStack);
		stackWatch.observe(this.chips.element, { attributes: true, attributeFilter: ['class'] });
		stackWatch.observe(this.composerQueue.element, { attributes: true, attributeFilter: ['class'] });
		this._register({ dispose: () => stackWatch.disconnect() });
		syncStack();
		append(this.composerHost, this.composer.element);

		this._register(addDisposableListener(this.shellEl, 'click', e => {
			if (this.expanded || (isHTMLElement(e.target) && this.composerHost.contains(e.target))) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.setExpanded(true);
		}));
		this._register(addDisposableListener(this.labelEl, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.setExpanded(true);
		}));
		this._register(addDisposableListener(expandBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.openAgentsSidebar();
		}));
		this._register(addDisposableListener(closeBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.setFloatOpen(false);
			this.setExpanded(false);
		}));
		this._register(addDisposableListener(this.hitEl, 'pointerenter', () => {
			this.hovered = true;
			this.sync();
		}));
		this._register(addDisposableListener(this.hitEl, 'pointerleave', () => {
			this.hovered = false;
			if (!this.expanded) {
				this.sync();
			}
		}));
		this._register(addDisposableListener(this.shellEl, 'transitionend', e => {
			if (e.target !== this.shellEl || (e.propertyName !== 'width' && e.propertyName !== 'height')) {
				return;
			}
			if (this.mode === 'expanded') {
				// Hand the size back to CSS so the pill tracks the dock row (and the chips above it)
				// when the browser is resized while the composer stays open.
				this.shellEl.style.width = '100%';
				this.shellEl.style.height = 'auto';
				this.composer.layout();
			}
		}));
		this._register(addDisposableListener(getWindow(this.element), 'pointerdown', e => this.onPointerDown(e), true));
		this._register(addDisposableListener(getWindow(this.element), 'keydown', e => {
			if (e.key === 'Escape' && (this.expanded || this.floatOpen)) {
				e.preventDefault();
				this.dismissToIdle();
			}
		}));
		this._register(this.layoutService.onDidChangePartVisibility(() => this.syncVisibility()));
		this._register(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === AGENT_SIDE_PANEL_VIEW_ID) {
				this.syncVisibility();
			}
		}));

		this.syncVisibility();
	}

	setChatResolver(resolver: () => string | undefined): void {
		this.chatResolver = resolver;
	}

	/** Comments made in browser tab `viewId` queue here and go with the next message. */
	setCommentScope(viewId: string): void {
		this.commentViewId = viewId;
		this.sync();
	}

	private pendingComments(): number {
		return this.commentViewId ? this.commentStore.pending({ viewId: this.commentViewId }).length : 0;
	}

	private showComments(): void {
		if (this.commentViewId) {
			this.commentStore.show({ viewId: this.commentViewId });
		}
	}

	/** The comments waiting to go, taken (marked sent) for the message being sent now. */
	private takeComments(): IBrowserCommentMessage | undefined {
		if (!this.commentViewId) {
			return undefined;
		}
		this.commentStore.setSession(this.commentViewId, this.chatResolver?.());
		return this.commentStore.take({ viewId: this.commentViewId });
	}

	/**
	 * Across the window (full screen) the dock stands in for the chat's composer, so it shows the
	 * chat's state at once; on leaving, a thread borrowed into the float goes back to the chat.
	 */
	setChatMode(on: boolean): void {
		this.element.classList.toggle('chat-mode', on);
		if (on) {
			const editor = this.chatEditor();
			if (editor) {
				this.bindAgent(editor);
				this.external = true;
			}
			this.sync();
			return;
		}
		if (this.external) {
			this.setFloatOpen(false);
			this.restoreThread();
		}
		this.dismissToIdle();
	}

	/** The model the owning chat's composer sends on, when that chat is open. */
	chatModelRef(): string | undefined {
		return this.chatEditor()?.composerModelRef();
	}

	/** The open chat that owns this browser's tools area. */
	private chatEditor(): AgentEditor | undefined {
		const sessionId = this.chatResolver?.();
		if (!sessionId) {
			return undefined;
		}
		for (const pane of this.editorService.visibleEditorPanes) {
			if (pane instanceof AgentEditor && pane.sessionId === sessionId) {
				return pane;
			}
		}
		return undefined;
	}

	setBlocked(blocked: boolean): void {
		this.element.classList.toggle('blocked', blocked);
		if (blocked) {
			this.expanded = false;
			this.pendingWork = false;
			this.setFloatOpen(false);
			this.chips.setHostOpen(false);
			return;
		}
		this.sync();
	}

	/** Over a light page the collapsed bar darkens, over a dark one it lightens; undefined follows the theme. */
	setBackdropTone(tone: 'light' | 'dark' | undefined): void {
		this.element.classList.toggle('backdrop-light', tone === 'light');
		this.element.classList.toggle('backdrop-dark', tone === 'dark');
	}

	/** The middle of the collapsed bar in window coordinates, while it is on screen. */
	backdropPoint(): { x: number; y: number } | undefined {
		if (this.mode === 'expanded' || this.element.classList.contains('blocked')) {
			return undefined;
		}
		const rect = this.shellEl.getBoundingClientRect();
		if (!rect.width || !rect.height) {
			return undefined;
		}
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	}

	/** Words or chips in the dock's composer that haven't been sent. */
	hasDraft(): boolean {
		return this.composer.hasDraft();
	}

	layout(): void {
		if (this.expanded) {
			if (this.mode === 'expanded') {
				this.shellEl.style.width = '100%';
			}
			this.composer.layout();
		}
	}

	/** Sends what the page asked for as is (the page already took its comments). */
	async submitFromBrowser(text: string, display?: IAgentPromptDisplay): Promise<void> {
		this.setBlocked(false);
		await this.submit(text, display, false, false);
	}

	prefillFromBrowser(text: string): void {
		this.setBlocked(false);
		this.setExpanded(true);
		this.composer.setDraft(text);
		this.sync();
	}

	/** A click on the page (the webview took focus): the island folds away, its draft and queue kept. */
	dismissFromPage(): void {
		if (this.agentEditor?.isEditingUser() || this.composer.isPlusMenuOpen()) {
			return;
		}
		this.dismissToIdle();
	}

	private eventElement(target: EventTarget | null): HTMLElement | undefined {
		if (isHTMLElement(target)) {
			return target;
		}
		const parent = (target as { parentElement?: HTMLElement | null } | null)?.parentElement;
		return parent ?? undefined;
	}

	private isDockSurface(target: EventTarget | null): boolean {
		const element = this.eventElement(target);
		if (!element) {
			return false;
		}
		return this.hitEl.contains(element)
			|| this.chips.element.contains(element)
			|| this.floatEl.contains(element)
			|| !!this.hostedThread?.element.contains(element)
			|| !!element.closest('.volt-agent-turn')
			|| !!element.closest('.volt-agent-composer-stack')
			|| !!element.closest('.volt-agent-queue-card')
			|| !!element.closest('.volt-agent-edit-slot')
			|| !!element.closest('.volt-agent-tooltip')
			|| !!element.closest('.volt-agent-dropdown')
			|| !!element.closest('.volt-agent-plus-menu')
			|| !!element.closest('.monaco-context-view')
			|| !!element.closest('.context-view')
			|| !!element.closest('.monaco-menu')
			|| !!element.closest('.suggest-widget');
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.expanded && !this.floatOpen && !this.hovered) {
			return;
		}
		if (this.agentEditor?.isEditingUser() || this.isDockSurface(e.target)) {
			return;
		}
		this.dismissToIdle();
	}

	private dismissToIdle(): void {
		if (this.composer.isPlusMenuOpen()) {
			this.composer.hidePlusMenu();
			this.setExpanded(true);
			return;
		}
		// A draft or a queue no longer holds it open: a click outside folds it away, both kept for next time.
		this.hovered = false;
		this.composer.hidePlusMenu();
		this.setFloatOpen(false);
		this.setExpanded(false);
	}

	private stopRun(): void {
		this.pendingWork = false;
		this.agentEditor?.stopRun();
		this.composer.setWorking(false);
		this.sync();
	}

	private setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		if (expanded) {
			this.composer.focus();
		} else {
			this.composer.hidePlusMenu();
		}
		this.sync();
	}

	private setFloatOpen(open: boolean): void {
		if (this.floatOpen === open) {
			return;
		}
		this.floatOpen = open;
		if (open) {
			this.renderFloat();
		} else if (!this.browserOwned || this.external) {
			this.restoreThread();
		}
		this.sync();
		if (open) {
			this.hostedThread?.layout();
			this.agentEditor?.layoutThread();
		}
	}

	/** Start Multitasking is on: the chip counts the ticked messages and Send (over Stop) starts them. */
	private setMultitaskPick(ids: readonly string[] | undefined): void {
		this.multitaskPick = ids;
		this.chips.setMultitaskPick(ids?.length);
		this.syncPendingSend();
	}

	/** Send (over Stop while the agent works) starts the picked multitasks or saves the queued message being edited. */
	private syncPendingSend(): void {
		this.composer.setPendingSend(!!this.multitaskPick?.length || !!this.editingQueued());
	}

	private async submit(text: string, display?: IAgentPromptDisplay, openFloat = true, withComments = true): Promise<void> {
		const owner = this.agentEditor;
		if (owner && this.editingQueued()) {
			// Send saves the queued message back into the queue, changed (empty: unchanged).
			const agentText = text.trim();
			const mentions = cloneDisplayMentions(display?.mentions ?? this.composer.getDisplayMentions());
			const edited: IAgentPromptDisplay | undefined = mentions.length ? { text: display?.text ?? this.composer.getDisplayText(), mentions } : undefined;
			// The composer clears itself once this returns; the draft it stood in for comes back after that.
			void Promise.resolve().then(() => agentText ? owner.commitQueueEdit(agentText, edited) : owner.cancelQueueEdit());
			return;
		}
		const picked = this.multitaskPick;
		if (picked) {
			// Send starts the ticked queued messages, each as its own agent; typed words still go to the chat.
			this.composerQueue.stopPicking();
			if (picked.length) {
				this.composer.setMode('Multitask');
				this.composerQueue.setMode('Multitask');
				this.agentEditor?.startMultitasking(picked);
			}
			if (!text.trim() && !(withComments && this.pendingComments())) {
				return;
			}
		}
		let displayText = display?.text ?? this.composer.getDisplayText();
		let mentions = display?.mentions ?? this.composer.getDisplayMentions();
		// The tab's queued comments go with the message, ahead of what was typed.
		const comments = withComments ? this.takeComments() : undefined;
		if (comments) {
			text = text.trim() ? `${comments.agentText}\n\n${text}` : comments.agentText;
			displayText = displayText.trim() ? `${comments.displayText}\n${displayText}` : comments.displayText;
			mentions = [...comments.mentions, ...mentions];
		}
		if (!text.trim()) {
			return;
		}
		const promptDisplay: IAgentPromptDisplay | undefined = mentions.length ? { text: displayText, mentions } : undefined;
		this.browserOwned = true;
		this.pendingWork = true;
		this.composer.setWorking(true);
		this.composer.clear();
		this.setExpanded(true);
		const editor = await this.ensureBrowserAgent();
		if (!editor) {
			this.pendingWork = false;
			this.composer.setWorking(false);
			this.sync();
			return;
		}
		this.bindAgent(editor);
		if (!this.external) {
			this.parkThread();
		}
		editor.setMode(this.composer.mode);
		editor.submitPrompt(text, promptDisplay);
		this.setFloatOpen(false);
		this.sync();
	}

	private async openAgentsSidebar(): Promise<void> {
		await this.revealInAgentsSidebar();
	}

	async revealInAgentsSidebar(draft?: string): Promise<void> {
		const input = this.agentEditor?.input;
		const sessionId = input instanceof AgentEditorInput ? input.sessionId : undefined;
		const text = draft?.trim() || (this.composer.hasDraft() ? this.composer.getDisplayText() : '');
		this.browserOwned = false;
		this.agentEditor?.setBrowserHosted(false);
		this.setFloatOpen(false);
		this.restoreThread();
		revealAgentSidePanel(this.layoutService);
		const view = await this.viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, true);
		if (sessionId) {
			await view?.openSession(sessionId);
		}
		const editor = view?.getActiveAgentEditor();
		if (text && editor) {
			editor.prefillDraft(text);
			this.composer.clear();
		} else {
			editor?.focus();
		}
		this.syncVisibility();
	}

	private async ensureBrowserAgent(): Promise<AgentEditor | undefined> {
		const chat = this.chatEditor();
		if (chat) {
			this.external = true;
			return chat;
		}
		if (this.agentEditor && !this.external) {
			return this.agentEditor;
		}
		this.external = false;
		const group = this.editorGroupsService.activeGroup;
		if (!group) {
			return undefined;
		}
		const input = this._register(this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri()));
		const editor = this.instantiationService.createInstance(AgentEditor, group);
		const host = append(this.element, $('.volt-browser-dock-session'));
		host.setAttribute('aria-hidden', 'true');
		editor.create(host);
		editor.layout(new Dimension(420, 560));
		await editor.setInput(input, { preserveFocus: true }, {}, CancellationToken.None);
		this._register(editor);
		this.bindAgent(editor);
		return editor;
	}

	private activeEditor(): AgentEditor | undefined {
		return this.agentEditor;
	}

	private syncQueueStack(): void {
		const editor = this.agentEditor;
		this.composerQueue.setMode(this.composer.mode);
		this.composerQueue.setQueue((editor?.getPromptQueue() ?? []).map(item => ({
			id: item.id,
			text: item.text,
			preview: item.display?.text ?? item.text,
		})));
		this.composerQueue.setState(editor?.queueState() ?? { running: false, steer: false });
		this.syncPendingSend();
	}

	/** The queued message open for editing in this dock's composer, if any. */
	private editingQueued(): string | undefined {
		return this.agentEditor?.queueEditIn(this.editSurface);
	}

	private bindAgent(editor: AgentEditor): void {
		if (this.agentEditor === editor) {
			return;
		}
		// A queued message open here belongs to the chat being left: it goes back to its queue unchanged.
		if (this.editingQueued()) {
			this.agentEditor?.cancelQueueEdit();
		}
		this.agentEditor = editor;
		this.chips.setSessionId(editor.sessionId);
		const store = new DisposableStore();
		this.agentStore.value = store;
		store.add(editor.onDidChangeDock(() => this.sync()));
		store.add(editor.onDidChangeQueue(() => {
			this.syncQueueStack();
			this.sync();
		}));
		store.add(editor.onDidComposerSend(() => {
			this.browserOwned = false;
			editor.setBrowserHosted(false);
			this.restoreThread();
			this.setFloatOpen(false);
		}));
		store.add({
			dispose: () => {
				if (this.agentEditor === editor) {
					this.agentEditor = undefined;
					this.chips.setSessionId(undefined);
				}
			}
		});
	}

	private dockState(): IAgentDockState | undefined {
		return this.activeEditor()?.getDockState();
	}

	private syncVisibility(): void {
		this.element.classList.remove('hidden');
		this.sync();
	}

	private sync(): void {
		if (this.element.classList.contains('hidden') || this.element.classList.contains('blocked')) {
			return;
		}
		const state = this.dockState();
		this.composerQueue.setTasks(this.agentEditor?.getTasksCard());
		const hasTurns = !!state?.turns.length;
		const streaming = !!state?.streaming;
		if (streaming) {
			this.pendingWork = false;
		}
		const working = streaming || this.pendingWork;
		const chipLabel = state?.status || (working ? localize('voltAgent.planningMoves', "Planning next moves") : '');
		// Unfocused it collapses, as Cursor's does: the live step while the agent works, else a glass bar.
		const mode: DockMode = this.expanded
			? 'expanded'
			: this.hovered
				? 'hover'
				: working
					? 'activity'
					: 'idle';
		const activity = state?.activity;
		this.activityTextEl.textContent = activity?.text || chipLabel;
		this.activityMoreEl.textContent = activity && activity.more > 0 ? `+${activity.more}` : '';
		this.activityMoreEl.classList.toggle('hidden', !activity || activity.more <= 0);

		this.element.classList.toggle('working', working);
		this.element.classList.toggle('float-open', this.floatOpen);
		this.chips.setStatus({ label: chipLabel, working });
		this.chips.setHostOpen(this.expanded);
		this.syncComments();
		this.syncQueueStack();
		this.composer.setWorking(working);
		this.composer.setPlaceholder(this.editingQueued()
			? localize('voltAgent.queue.editingPlaceholder', "Editing queued message...")
			: hasTurns || working
				? localize('voltBrowser.followUpPlaceholder', "Send follow-up")
				: localize('voltBrowser.kickoffPlaceholder', "Let's kick something off"));
		if (this.floatOpen) {
			this.floatTitle.textContent = state?.title || localize('voltAgent.chat', "Agent");
		}
		this.morphTo(mode);
	}

	/** "N comments" in the chip row, "Send N comments" on the hovered bar, a blue line in the composer. */
	private syncComments(): void {
		const count = this.pendingComments();
		const has = count > 0;
		this.commentsChip.classList.toggle('hidden', !has);
		this.chips.element.classList.toggle('has-comments', has);
		this.commentsChip.lastElementChild!.textContent = count === 1
			? localize('voltBrowser.oneComment', "1 comment")
			: localize('voltBrowser.comments', "{0} comments", count);
		this.commentsLine.classList.toggle('hidden', !has);
		this.commentsLine.lastElementChild!.textContent = count === 1
			? localize('voltBrowser.sendOneChatComment', "Send 1 comment to chat")
			: localize('voltBrowser.sendChatComments', "Send {0} comments to chat", count);
		this.labelIconEl.classList.toggle('hidden', !has);
		this.labelKbEl.classList.toggle('hidden', has);
		this.labelTextEl.textContent = !has
			? localize('voltBrowser.messageAgent', "Message Volt")
			: count === 1 ? localize('voltBrowser.sendOneComment', "Send 1 comment") : localize('voltBrowser.sendComments', "Send {0} comments", count);
		this.composer.setExtraContent(has);
	}

	private activityWidth(available: number): number {
		const more = this.activityMoreEl.classList.contains('hidden') ? 0 : 6 + this.activityMoreEl.scrollWidth;
		return Math.min(Math.ceil(ACTIVITY_CHROME_PX + this.activityTextEl.scrollWidth + more), ACTIVITY_MAX_PX, available);
	}

	private morphTo(mode: DockMode): void {
		if (this.mode === mode && mode === 'expanded') {
			return;
		}
		const shell = this.shellEl;
		const from = shell.getBoundingClientRect();
		this.mode = mode;
		this.element.dataset.mode = mode;
		this.element.classList.toggle('mode-idle', mode === 'idle');
		this.element.classList.toggle('mode-activity', mode === 'activity');
		this.element.classList.toggle('mode-hover', mode === 'hover');
		this.element.classList.toggle('mode-expanded', mode === 'expanded');
		this.element.classList.toggle('mode-chip', mode === 'chip');
		if (mode === 'expanded') {
			this.composer.layout();
		}
		const styles = getWindow(this.element).getComputedStyle(this.element);
		const pad = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
		const available = Math.max(this.element.clientWidth - pad, 160);
		const toWidth = mode === 'idle'
			? 156
			: mode === 'activity'
				? this.activityWidth(available)
				: mode === 'hover'
					? 228
					: mode === 'chip'
						? 0
						: Math.min(650, Math.round(available * 0.9));
		const toHeight = mode === 'idle'
			? 8
			: mode === 'activity'
				? 34
				: mode === 'hover'
					? 36
					: mode === 'chip'
						? 0
						: Math.max(this.composerHost.scrollHeight, this.composer.element.offsetHeight, 38);
		if (from.width === toWidth && from.height === toHeight && mode !== 'expanded') {
			return;
		}
		shell.style.width = `${Math.max(from.width, 0)}px`;
		shell.style.height = `${Math.max(from.height, 0)}px`;
		void shell.offsetWidth;
		shell.style.width = `${toWidth}px`;
		shell.style.height = `${toHeight}px`;
	}

	override dispose(): void {
		this.restoreThread();
		super.dispose();
	}

	private parkThread(): void {
		const editor = this.activeEditor();
		const thread = editor?.getThreadView();
		if (!editor || !thread) {
			return;
		}
		if (this.hostedThread === thread && thread.element.parentElement === this.floatBody) {
			return;
		}
		editor.setBrowserHosted(true);
		this.floatBody.querySelector('.volt-browser-dock-empty')?.remove();
		this.floatBody.replaceChildren();
		thread.mount(this.floatBody);
		this.hostedThread = thread;
	}

	private renderFloat(): void {
		const editor = this.activeEditor();
		const state = editor?.getDockState();
		this.floatTitle.textContent = state?.title || localize('voltAgent.chat', "Agent");
		const thread = editor?.getThreadView();
		if (!thread) {
			if (!this.browserOwned) {
				this.restoreThread();
			}
			this.floatBody.replaceChildren();
			append(this.floatBody, $('.volt-browser-dock-empty')).textContent = localize('voltBrowser.dockEmpty', "No messages yet");
			return;
		}
		this.parkThread();
	}

	private restoreThread(): void {
		this.agentEditor?.setBrowserHosted(false);
		this.hostedThread?.restore();
		this.hostedThread = undefined;
	}
}
