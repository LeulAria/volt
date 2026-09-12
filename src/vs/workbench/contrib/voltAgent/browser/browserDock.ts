/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import './media/agentEditor.css';
import { AgentComposerChips } from './agentComposerChips.js';
import { AgentEditor, IAgentDockState, IAgentPromptDisplay } from './agentEditor.js';
import { AGENT_SIDE_PANEL_VIEW_ID } from './agentEditorInput.js';
import { AgentThreadView } from './agentThreadView.js';
import { AgentSidePanel } from './agentSidePanel.js';
import { formatAgentTooltipShortcut, setAgentTooltip } from './agentTooltip.js';
import { BrowserAgentComposer } from './browserComposer.js';

export class BrowserAgentDock extends Disposable {

	readonly element: HTMLElement;

	private readonly shellEl: HTMLElement;
	private readonly labelEl: HTMLButtonElement;
	private readonly chips: AgentComposerChips;
	private readonly composerHost: HTMLElement;
	private readonly floatEl: HTMLElement;
	private readonly floatTitle: HTMLElement;
	private readonly floatBody: HTMLElement;
	private readonly hitEl: HTMLElement;
	private readonly composer: BrowserAgentComposer;
	private readonly agentStore = this._register(new MutableDisposable<DisposableStore>());
	private agentEditor: AgentEditor | undefined;
	private hostedThread: AgentThreadView | undefined;
	private expanded = false;
	private floatOpen = false;
	private hovered = false;
	private pendingWork = false;
	private browserOwned = false;
	private mode: 'idle' | 'hover' | 'expanded' | 'chip' = 'idle';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
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
			onStatusClick: () => {
				this.setExpanded(true);
				this.setFloatOpen(!this.floatOpen);
			},
		}));
		this.chips.setHostOpen(false);
		append(this.element, this.chips.element);

		this.hitEl = append(this.element, $('.volt-browser-dock-hit'));
		this.shellEl = append(this.hitEl, $('.volt-browser-dock-shell'));
		this.labelEl = append(this.shellEl, $('button.volt-browser-dock-label')) as HTMLButtonElement;
		this.labelEl.type = 'button';
		append(this.labelEl, $('span.volt-browser-dock-label-text')).textContent = localize('voltBrowser.messageAgent', "Message Volt");
		append(this.labelEl, $('span.volt-browser-dock-label-kb')).textContent = formatAgentTooltipShortcut({ meta: true, key: 'L' });
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
					if (this.composer.isPlusMenuOpen()) {
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
			onMode: id => this.agentEditor?.setMode(id),
			onKeepExpanded: () => this.setExpanded(true),
		}));
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

	layout(): void {
		if (this.expanded) {
			this.composer.layout();
		}
	}

	async submitFromBrowser(text: string, display?: IAgentPromptDisplay): Promise<void> {
		this.setBlocked(false);
		await this.submit(text, display, false);
	}

	prefillFromBrowser(text: string): void {
		this.setBlocked(false);
		this.setExpanded(true);
		this.composer.setDraft(text);
		this.sync();
	}

	dismissIfEmpty(): void {
		if (this.composer.isPlusMenuOpen()) {
			return;
		}
		this.dismissToIdle();
	}

	private isDockSurface(target: EventTarget | null): boolean {
		if (!isHTMLElement(target)) {
			return false;
		}
		return this.hitEl.contains(target)
			|| this.chips.element.contains(target)
			|| this.floatEl.contains(target)
			|| !!target.closest('.volt-agent-dropdown')
			|| !!target.closest('.volt-agent-plus-menu')
			|| !!target.closest('.monaco-context-view')
			|| !!target.closest('.context-view')
			|| !!target.closest('.monaco-menu')
			|| !!target.closest('.suggest-widget');
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.expanded && !this.floatOpen && !this.hovered) {
			return;
		}
		if (this.isDockSurface(e.target)) {
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
		if (this.isWorking()) {
			this.setFloatOpen(false);
			return;
		}
		if (this.expanded && this.composer.hasDraft()) {
			this.setFloatOpen(false);
			return;
		}
		this.hovered = false;
		this.composer.hidePlusMenu();
		this.setFloatOpen(false);
		this.setExpanded(false);
	}

	private isWorking(): boolean {
		return this.pendingWork || !!this.dockState()?.streaming;
	}

	private stopRun(): void {
		this.pendingWork = false;
		this.agentEditor?.stopRun();
		this.composer.setWorking(false);
		this.sync();
	}

	private setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (expanded) {
			this.composer.focus();
		} else {
			this.composer.hidePlusMenu();
		}
		this.sync();
	}

	private setFloatOpen(open: boolean): void {
		this.floatOpen = open;
		if (open) {
			this.renderFloat();
		} else if (!this.browserOwned) {
			this.restoreThread();
		}
		this.sync();
	}

	private async submit(text: string, display?: IAgentPromptDisplay, openFloat = true): Promise<void> {
		const displayText = display?.text ?? this.composer.getDisplayText();
		const mentions = display?.mentions ?? this.composer.getDisplayMentions();
		const promptDisplay: IAgentPromptDisplay | undefined = mentions.length ? { text: displayText, mentions } : undefined;
		this.browserOwned = true;
		this.pendingWork = true;
		this.composer.setWorking(true);
		this.composer.clear();
		this.setExpanded(true);
		const editor = await this.ensureAgent(false);
		if (!editor) {
			this.pendingWork = false;
			this.composer.setWorking(false);
			this.sync();
			return;
		}
		this.bindAgent(editor);
		this.parkThread();
		editor.setMode(this.composer.mode);
		editor.submitPrompt(text, promptDisplay);
		this.setFloatOpen(false);
		this.sync();
	}

	private async openAgentsSidebar(): Promise<void> {
		this.browserOwned = false;
		this.agentEditor?.setBrowserHosted(false);
		this.setFloatOpen(false);
		this.restoreThread();
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await this.viewsService.openView(AGENT_SIDE_PANEL_VIEW_ID, true);
		this.syncVisibility();
	}

	private async ensureAgent(show: boolean): Promise<AgentEditor | undefined> {
		const hidden = !this.isAgentsVisible();
		let view = this.viewsService.getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
		if (!view) {
			view = await this.viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, false) ?? view;
			if (hidden && !show) {
				this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			}
		}
		if (!view) {
			return undefined;
		}
		if (!view.getActiveAgentEditor()) {
			await view.openNewAgent({ focus: false });
		}
		return view.getActiveAgentEditor();
	}

	private activeEditor(): AgentEditor | undefined {
		const editor = this.agentEditor
			?? this.viewsService.getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID)?.getActiveAgentEditor();
		if (editor) {
			this.bindAgent(editor);
		}
		return editor;
	}

	private bindAgent(editor: AgentEditor): void {
		if (this.agentEditor === editor) {
			return;
		}
		this.agentEditor = editor;
		const store = new DisposableStore();
		this.agentStore.value = store;
		store.add(editor.onDidChangeDock(() => this.sync()));
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
				}
			}
		});
	}

	private isAgentsVisible(): boolean {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) && this.viewsService.isViewVisible(AGENT_SIDE_PANEL_VIEW_ID);
	}

	private dockState(): IAgentDockState | undefined {
		return this.activeEditor()?.getDockState();
	}

	private syncVisibility(): void {
		this.element.classList.remove('hidden');
		void this.ensureAgent(false).then(editor => {
			if (editor) {
				this.bindAgent(editor);
				this.sync();
			}
		});
		this.sync();
	}

	private sync(): void {
		if (this.element.classList.contains('hidden') || this.element.classList.contains('blocked')) {
			return;
		}
		const state = this.dockState();
		const hasTurns = !!state?.turns.length;
		const streaming = !!state?.streaming;
		if (streaming) {
			this.pendingWork = false;
		}
		const working = streaming || this.pendingWork;
		const chipLabel = state?.status || (working ? localize('voltAgent.planningMoves', "Planning next moves") : '');
		const showChip = !!chipLabel && (working || this.browserOwned || hasTurns);
		if (streaming || this.pendingWork || this.composer.isPlusMenuOpen() || this.browserOwned || showChip) {
			this.expanded = true;
		}
		const mode: 'idle' | 'hover' | 'expanded' | 'chip' = this.expanded
			? 'expanded'
			: this.hovered
				? 'hover'
				: 'idle';

		this.element.classList.toggle('working', working);
		this.element.classList.toggle('float-open', this.floatOpen);
		this.chips.setStatus({ label: chipLabel, working });
		this.chips.setHostOpen(this.expanded);
		this.composer.setWorking(working);
		this.composer.setPlaceholder(hasTurns || working
			? localize('voltBrowser.followUpPlaceholder', "Send follow-up")
			: localize('voltBrowser.kickoffPlaceholder', "Let's kick something off"));
		if (this.floatOpen) {
			this.renderFloat();
		}
		this.morphTo(mode);
	}

	private morphTo(mode: 'idle' | 'hover' | 'expanded' | 'chip'): void {
		const shell = this.shellEl;
		const from = shell.getBoundingClientRect();
		this.mode = mode;
		this.element.dataset.mode = mode;
		this.element.classList.toggle('mode-idle', mode === 'idle');
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
			: mode === 'hover'
				? 228
				: mode === 'chip'
					? 0
					: Math.min(650, Math.round(available * 0.9));
		const toHeight = mode === 'idle'
			? 10
			: mode === 'hover'
				? 36
				: mode === 'chip'
					? 0
					: Math.max(this.composer.element.offsetHeight, this.composerHost.scrollHeight, 44);
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
		editor.setBrowserHosted(true);
		this.floatBody.querySelector('.volt-browser-dock-empty')?.remove();
		if (this.hostedThread !== thread || thread.element.parentElement !== this.floatBody) {
			this.floatBody.replaceChildren();
			thread.mount(this.floatBody);
			this.hostedThread = thread;
		}
		thread.layout();
		editor.layoutThread();
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
