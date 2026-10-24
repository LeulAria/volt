/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { withFrameContents } from '../../common/scratchBoard/scratchGeometry.js';
import { IScratchAgentRun } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createThinkingDots } from '../composer/agentComposerChips.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IScratchAgentBridge, ScratchRunState } from './scratchAgentBridge.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';
import { IScratchSessionLinks } from './scratchSessionLinks.js';
import { runStateIcon, runStateLabel } from './scratchRuns.js';

const OPEN_KEY = 'volt.scratchBoard.dockOpen';
const HEIGHT_KEY = 'volt.scratchBoard.dockHeight';
/** The transcript card, as tall as the browser dock's (min(520px, 62vh)) by default. */
const DEFAULT_HEIGHT = 420;
const MIN_HEIGHT = 160;
/** The open dock stops this far under the page's top edge, clear of the top bars. */
const TOP_CLEARANCE = 56;
/** The gap between the card and the composer, and under the composer. */
const GAP = 8;
const BOTTOM = 12;
const SIDE = 12;
/** Narrower than this, the dock covers a side panel rather than shrink further. */
const MIN_ROOM = 380;
const WORKING: ReadonlySet<ScratchRunState> = new Set<ScratchRunState>(['starting', 'running', 'queued']);
/** Something open in the chat that Escape closes before it closes the dock. */
const ESCAPE_FIRST_CONTEXT_KEYS: readonly string[] = [
	'suggestWidgetVisible', 'inlineSuggestionVisible', 'inlineEditIsVisible', 'parameterHintsVisible', 'findWidgetVisible',
	'renameInputVisible', 'inSnippetMode', 'editorHasMultipleSelections', 'editorHasSelection', 'codeActionMenuVisible',
	'messageVisible', 'referenceSearchVisible', 'inQuickOpen', 'voltInlineCommentVisible', 'voltAgentFindWidgetVisible',
];

type RunPick = { readonly kind: 'select' | 'hide'; readonly runId: string };

/**
 * The agents a board started, docked at the bottom of the page the way the browser docks its agent:
 * closed, a bar with the live step while one works; open, the transcript in a card with the chat's
 * chips and composer under it. The chat is a real one (model picker, approvals, queue, follow-ups),
 * its transcript moved into the card like the browser dock does. One chat view serves every run.
 * It shows the chat's own input (AgentEditorInput.acquire), so it never records a run twice, and
 * lets go of it while the page is hidden so the chat can open in Agents and take it over.
 */
export class ScratchAgentDock extends Disposable {

	private readonly element: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly titleButton: HTMLButtonElement;
	private readonly titleIcon: HTMLElement;
	private readonly titleText: HTMLElement;
	private readonly titleChevron: SVGSVGElement;
	private readonly body: HTMLElement;
	private readonly emptyEl: HTMLElement;
	private readonly chatHost: HTMLElement;
	private readonly bar: HTMLElement;
	private readonly barStatus: HTMLElement;
	private readonly barTitle: HTMLElement;
	private readonly barActivity: HTMLElement;
	private readonly barCount: HTMLElement;
	private readonly syncScheduler: RunOnceScheduler;
	private readonly chatStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly inputListener = this._register(new MutableDisposable());
	private readonly menu = this._register(new MutableDisposable());
	private runs: IScratchAgentRun[] = [];
	private selectedRunId: string | undefined;
	/** The run whose diagram the selection is on, if any. */
	private focusedRunId: string | undefined;
	private open: boolean;
	/** The transcript card over the composer: shut until the composer's status chip opens it. */
	private transcript = false;
	private height: number;
	private visible = false;
	private pageHeight = 0;
	private chat: AgentEditor | undefined;
	private chatSession: string | undefined;
	private composerObserver: ResizeObserver | undefined;
	private observedComposer: Element | undefined;
	/** Bumped by every bind and release, so a bind that finishes late does not win. */
	private binding = 0;
	/** The user opened the dock to type: the composer takes focus once the chat is there. */
	private focusPending = false;
	/** The runs the dock shows (ids and order), to skip the scene changes that leave them alone. */
	private runsKey = '';
	private barState: string | undefined;
	private titleState: string | undefined;

	constructor(
		parent: HTMLElement,
		private readonly canvas: ScratchCanvas,
		@IScratchAgentBridge private readonly agents: IScratchAgentBridge,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IStorageService private readonly storageService: IStorageService,
		@IScratchSessionLinks private readonly links: IScratchSessionLinks,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.open = storageService.getBoolean(OPEN_KEY, StorageScope.PROFILE, false);
		this.height = storageService.getNumber(HEIGHT_KEY, StorageScope.PROFILE, DEFAULT_HEIGHT);
		const doc = parent.ownerDocument;

		this.element = append(parent, $('.sx-dock'));
		this.element.hidden = true;

		// Open: the transcript card (the browser dock's float), then the chat's chips and composer.
		this.panel = append(this.element, $('.sx-dock-panel'));
		this.panel.setAttribute('role', 'region');
		this.panel.setAttribute('aria-label', localize('voltScratch.dock', "Agents on this board"));
		const grip = append(this.panel, $('.sx-dock-grip'));
		grip.setAttribute('aria-hidden', 'true');
		const head = append(this.panel, $('.sx-dock-head.volt-browser-dock-float-head'));
		this.titleButton = append(head, $('button.sx-dock-title')) as HTMLButtonElement;
		this.titleButton.type = 'button';
		this.titleIcon = append(this.titleButton, $('span.sx-dock-title-icon'));
		this.titleText = append(this.titleButton, $('span.sx-dock-title-text'));
		this.titleChevron = this.titleButton.appendChild(scratchIcon(doc, 'chevron-down', { size: 13, className: 'sx-dock-title-chevron' }));
		this._register(addDisposableListener(this.titleButton, 'click', () => this.showRunsMenu()));
		const actions = append(head, $('.volt-browser-dock-float-actions'));
		const action = (icon: ScratchIconName, label: string, run: () => void) => {
			const b = append(actions, $('button.volt-browser-dock-icon')) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.appendChild(scratchIcon(doc, icon, { size: 14 }));
			setAgentTooltip(b, label, undefined, undefined, 'above');
			this._register(addDisposableListener(b, 'click', e => {
				e.stopPropagation();
				run();
			}));
		};
		action('locate-fixed', localize('voltScratch.dockShow', "Show on Board"), () => this.showOnBoard());
		// Folds the transcript back into the composer's status chip; the composer stays.
		action('minimize-2', localize('voltScratch.dockCollapse', "Collapse to Chip"), () => this.setTranscript(false));
		action('x', localize('voltScratch.dockClose', "Close"), () => this.setOpen(false));
		this.body = append(this.panel, $('.sx-dock-body.volt-browser-dock-float-body'));
		this.emptyEl = append(this.panel, $('.sx-dock-empty'));
		this.emptyEl.hidden = true;
		this.chatHost = append(this.element, $('.sx-dock-chat.volt-agent-toolless'));

		// Closed: one pill with the run that matters most and what it is doing.
		this.bar = append(this.element, $('.sx-dock-bar'));
		this.bar.setAttribute('role', 'button');
		this.bar.tabIndex = 0;
		this.barStatus = append(this.bar, $('span.sx-dock-bar-status'));
		this.barTitle = append(this.bar, $('span.sx-dock-bar-title'));
		this.barActivity = append(this.bar, $('span.sx-dock-bar-activity'));
		this.barActivity.setAttribute('aria-live', 'polite');
		this.barCount = append(this.bar, $('span.sx-dock-bar-count'));
		this.bar.appendChild(scratchIcon(doc, 'chevron-up', { size: 14, className: 'sx-dock-bar-chevron' }));
		setAgentTooltip(this.bar, localize('voltScratch.dockOpenTip', "Show the agent's chat"), undefined, undefined, 'above');
		this._register(addDisposableListener(this.bar, 'click', () => this.setOpen(true, true)));
		this._register(addDisposableListener(this.bar, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.setOpen(true, true);
			}
		}));
		// Escape anywhere in the open dock (transcript or composer) folds it to its bar, unless something
		// inside is open and takes the key first: a menu or edit that already took it, or the composer's
		// suggestions, ghost text, Find, a selection. Asking only whether some Escape keybinding matches
		// is not enough: in the composer one matches with nothing open (an editor command whose context
		// is on), and Escape there did nothing at all.
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
			this.close();
			this.canvas.focus();
		}));
		this._register(addDisposableListener(head, 'dblclick', e => {
			if (isHTMLElement(e.target) && !e.target.closest('button')) {
				this.setOpen(false);
			}
		}));
		this.installResize(grip);

		this.syncScheduler = this._register(new RunOnceScheduler(() => this.syncRuns(true), 60));
		this._register(canvas.onDidChangeModel(() => {
			this.selectedRunId = undefined;
			this.syncRuns();
		}));
		this._register(canvas.onDidChangeScene(() => this.syncScheduler.schedule()));
		// The closed bar only shows while the user is on a run's diagram.
		this._register(canvas.state.onDidChangeSelection(() => this.syncFocus()));
		this._register(canvas.onDidStartRun(run => {
			// A chat just started from the board: the dock follows it (open or closed, as the user left it).
			this.selectedRunId = run.id;
			this.syncRuns();
		}));
		// A press on the board (outside the dock, which sits beside the canvas) closes the open dock. A run
		// chip opens and closes it itself; the chat's menus open in the context view, not on the board.
		this._register(addDisposableListener(canvas.element, 'pointerdown', e => {
			if (this.open && !this.element.hidden && !(isHTMLElement(e.target) && e.target.closest('.sx-run-chip'))) {
				this.setOpen(false);
			}
		}, true));
		// The whole-board composer opens where the dock stands: the dock makes way (its bar stays).
		this._register(canvas.onDidOpenComposer(() => this.setOpen(false)));
		// The library (right) stays uncovered: the dock moves left of it.
		const library = canvas.element.querySelector('.sx-library');
		const panelWatch = new (getWindow(parent).MutationObserver)(() => this.syncSides());
		if (library) {
			panelWatch.observe(library, { attributes: true, attributeFilter: ['class'] });
		}
		this._register(toDisposable(() => panelWatch.disconnect()));
		this._register(agents.onDidChange(() => {
			this.render();
			// A chat deleted meanwhile shows as gone.
			this.bindSelected();
		}));
	}

	/** The page is on screen (or not): the chat is only held while it is. */
	setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (visible) {
			this.syncRuns();
		} else {
			this.release();
		}
	}

	layout(height: number): void {
		this.pageHeight = height;
		this.syncSides();
		this.layoutChat();
	}

	/** Keeps the dock clear of the open side panels, unless that would leave it too narrow. */
	private syncSides(): void {
		const width = this.element.clientWidth;
		if (!width) {
			return;
		}
		// Layout offsets, not client rects: the library slides in with a transform.
		const library = this.canvas.element.querySelector<HTMLElement>('.sx-library.visible');
		const left = SIDE;
		let right = library ? Math.max(SIDE, width - library.offsetLeft + SIDE) : SIDE;
		if (width - left - right < MIN_ROOM) {
			right = SIDE;
		}
		const padLeft = `${left}px`, padRight = `${right}px`;
		if (this.element.style.paddingLeft !== padLeft || this.element.style.paddingRight !== padRight) {
			this.element.style.paddingLeft = padLeft;
			this.element.style.paddingRight = padRight;
			this.layoutChat();
		}
	}

	/** Opens the dock on the run with chat `sessionId` (a run chip was clicked). */
	showSession(sessionId: string): void {
		this.syncRuns();
		const run = [...this.runs].reverse().find(r => r.sessionId === sessionId);
		if (!run) {
			void this.agents.openChat(sessionId);
			return;
		}
		// The chip of the run already open closes the dock again.
		if (this.open && !this.element.hidden && this.selectedRunId === run.id) {
			this.setOpen(false);
			return;
		}
		this.select(run.id);
		this.setOpen(true, true);
	}

	/** Back from the chat in Agents: its run is the one shown, and its part of the board comes into view. */
	focusSession(sessionId: string): void {
		this.syncRuns();
		const run = [...this.runs].reverse().find(r => r.sessionId === sessionId);
		if (!run) {
			return;
		}
		this.select(run.id);
		const scene = this.canvas.scene;
		const live = run.elementIds.filter(id => scene?.get(id));
		if (live.length) {
			this.canvas.bringIntoView(live);
		}
	}

	/** `onlyIfChanged`: a scene change, which mostly moves elements and leaves the runs alone. */
	private syncRuns(onlyIfChanged = false): void {
		const scene = this.canvas.scene;
		const runs = scene ? scene.runs.filter(run => !run.hidden).sort((a, b) => a.created - b.created) : [];
		const key = runs.map(run => run.id).join(',');
		if (onlyIfChanged && key === this.runsKey) {
			return;
		}
		this.runsKey = key;
		this.runs = runs;
		// Every chat on this board leads back to it from Agents (runs made before the links were kept too).
		const boardId = this.canvas.model?.id;
		if (scene && boardId) {
			for (const run of scene.runs) {
				this.links.link(run.sessionId, boardId);
			}
		}
		if (!this.runs.some(run => run.id === this.selectedRunId)) {
			this.selectedRunId = this.defaultRun()?.id;
		}
		this.focusedRunId = this.runOnSelection()?.id;
		this.render();
		this.bindSelected();
	}

	/** The newest run whose diagram holds something selected (a frame it marks counts for all inside). */
	private runOnSelection(): IScratchAgentRun | undefined {
		const scene = this.canvas.scene;
		const selection = this.canvas.state.selection;
		if (!scene || !selection.size) {
			return undefined;
		}
		const elements = scene.getElements();
		for (let i = this.runs.length - 1; i >= 0; i--) {
			const marked = withFrameContents(elements, new Set(this.runs[i].elementIds));
			for (const id of selection) {
				if (marked.has(id)) {
					return this.runs[i];
				}
			}
		}
		return undefined;
	}

	/** Selecting on a run's diagram shows its bar (and makes it the dock's run); selecting elsewhere hides the closed bar. */
	private syncFocus(): void {
		const run = this.runOnSelection();
		if (run?.id === this.focusedRunId) {
			return;
		}
		this.focusedRunId = run?.id;
		if (run && !this.open) {
			this.select(run.id);
		}
		this.render();
	}

	/** The newest run still working, else the newest. */
	private defaultRun(): IScratchAgentRun | undefined {
		for (let i = this.runs.length - 1; i >= 0; i--) {
			if (WORKING.has(this.agents.status(this.runs[i].sessionId).state)) {
				return this.runs[i];
			}
		}
		return this.runs[this.runs.length - 1];
	}

	private selected(): IScratchAgentRun | undefined {
		return this.runs.find(run => run.id === this.selectedRunId);
	}

	private select(runId: string): void {
		if (this.selectedRunId === runId) {
			return;
		}
		this.selectedRunId = runId;
		this.render();
		this.bindSelected();
	}

	private setTranscript(on: boolean): void {
		if (this.transcript === on || !this.open) {
			return;
		}
		this.transcript = on;
		this.render();
		this.layoutChat();
	}

	/** Folds the open dock to its bar (Escape); false when it was not open. */
	close(): boolean {
		if (!this.open || this.element.hidden) {
			return false;
		}
		this.setOpen(false);
		return true;
	}

	private setOpen(open: boolean, focus = false): void {
		if (open && !this.runs.length) {
			return;
		}
		if (!open) {
			this.focusPending = false;
			this.menu.clear();
			// Opened again, the dock starts at its composer.
			this.transcript = false;
		}
		if (this.open !== open) {
			this.open = open;
			this.storageService.store(OPEN_KEY, open, StorageScope.PROFILE, StorageTarget.USER);
			this.render();
			this.layoutChat();
		}
		if (open && focus) {
			if (this.chat && this.chatSession === this.selected()?.sessionId) {
				this.chat.focus();
			} else {
				this.focusPending = true;
			}
		}
	}

	// ---- Header and bar -------------------------------------------------------------------

	private titleOf(run: IScratchAgentRun): string {
		return run.prompt.split('\n')[0].trim() || this.agents.status(run.sessionId).title || localize('voltScratch.run.untitled', "Agent");
	}

	private render(): void {
		const run = this.selected();
		// Closed, the bar stays out of the way until the user is on a run's diagram; a chip click opens the dock.
		const hidden = !run || (!this.open && !this.focusedRunId);
		this.element.hidden = hidden;
		// The open dock covers the board's bottom edge: its zoom and undo would sit under the chat's chips.
		this.canvas.element.classList.toggle('sx-dock-open', !hidden && this.open);
		if (!run || hidden) {
			return;
		}
		this.element.classList.toggle('open', this.open);
		this.syncSides();
		// A deleted chat has no composer: its note shows in the card instead.
		this.panel.hidden = !this.open || (!this.transcript && this.emptyEl.hidden);
		this.chatHost.hidden = !this.open || !this.emptyEl.hidden;
		this.bar.hidden = this.open;
		const status = this.agents.status(run.sessionId);
		if (this.titleState !== status.state) {
			this.titleState = status.state;
			this.titleButton.dataset.state = status.state;
			this.titleIcon.replaceChildren(scratchIcon(this.element.ownerDocument, runStateIcon(status.state), { size: 13, strokeWidth: 2 }));
		}
		const title = this.titleOf(run);
		if (this.titleText.textContent !== title) {
			this.titleText.textContent = title;
		}
		// With more than one agent on the board, the title switches between them.
		const several = this.runs.length > 1;
		this.titleButton.classList.toggle('several', several);
		this.titleButton.setAttribute('aria-haspopup', several ? 'menu' : 'false');
		this.titleChevron.style.display = several ? '' : 'none';
		const meta = [runStateLabel(status.state), status.modelLabel ?? run.modelLabel].filter(Boolean).join(' · ');
		setAgentTooltip(this.titleButton, several ? localize('voltScratch.dockSwitch', "{0}\n{1}. Switch agent", title, meta) : `${title}\n${meta}`, undefined, undefined, 'above');
		this.renderBar();
	}

	/** The bar: the selected run, its live step (from the chat) or its state, and how many others there are. */
	private renderBar(): void {
		const run = this.selected();
		if (!run || this.open) {
			return;
		}
		const status = this.agents.status(run.sessionId);
		const dock = this.chatSession === run.sessionId ? this.chat?.getDockState() : undefined;
		const working = WORKING.has(status.state) || !!dock?.streaming;
		const state = working ? 'working' : status.state;
		if (this.barState !== state) {
			this.barState = state;
			this.bar.dataset.state = state;
			this.barStatus.replaceChildren(working ? createThinkingDots() : scratchIcon(this.bar.ownerDocument, runStateIcon(status.state), { size: 14, strokeWidth: 2 }));
		}
		this.barTitle.textContent = this.titleOf(run);
		let activity: string;
		if (working) {
			const step = dock?.activity;
			activity = step?.text ? (step.more > 0 ? `${step.text} +${step.more}` : step.text) : dock?.status || runStateLabel(status.state);
		} else {
			activity = [runStateLabel(status.state), dock?.status && dock.status !== runStateLabel(status.state) ? dock.status : undefined].filter(Boolean).join(' · ');
		}
		this.barActivity.textContent = activity;
		const others = this.runs.length - 1;
		const othersWorking = this.runs.filter(r => r.id !== run.id && WORKING.has(this.agents.status(r.sessionId).state)).length;
		this.barCount.hidden = others <= 0;
		this.barCount.textContent = othersWorking > 0
			? localize('voltScratch.dockMoreWorking', "+{0} working", othersWorking)
			: localize('voltScratch.dockMore', "+{0}", others);
		this.bar.setAttribute('aria-label', localize('voltScratch.dockBarAria', "Agent: {0}, {1}. Show the chat", this.barTitle.textContent, activity));
	}

	/** The board's agents, newest first: pick one, or take one off the board. */
	private showRunsMenu(): void {
		if (this.runs.length < 2) {
			return;
		}
		const doc = this.element.ownerDocument;
		const items: IVoltMenuItem<RunPick>[] = [...this.runs].reverse().map(run => {
			const status = this.agents.status(run.sessionId);
			return {
				id: run.id,
				label: this.titleOf(run),
				description: [runStateLabel(status.state), status.modelLabel ?? run.modelLabel].filter(Boolean).join(' · '),
				icon: () => scratchIcon(doc, runStateIcon(status.state), { size: 14, strokeWidth: 2, className: `sx-dock-menu-icon state-${status.state}` }),
				checked: run.id === this.selectedRunId,
				data: { kind: 'select', runId: run.id },
				action: { icon: Codicon.close, tooltip: localize('voltScratch.dockHide', "Hide from Board"), data: { kind: 'hide', runId: run.id } },
			};
		});
		this.menu.value = showVoltMenu<RunPick>(this.contextViewService, {
			anchor: this.titleButton,
			position: 'above',
			align: 'left',
			gap: 6,
			width: 380,
			ariaLabel: localize('voltScratch.dockTabs', "Agents"),
			sections: [{ id: 'runs', items }],
			onPick: item => {
				if (item.data.kind === 'hide') {
					this.canvas.hideRun(item.data.runId);
				} else {
					this.select(item.data.runId);
				}
			},
		});
	}

	// ---- The chat -------------------------------------------------------------------------

	private bindSelected(): void {
		const run = this.selected();
		if (!this.visible || !run) {
			this.release();
			this.showEmpty(undefined);
			return;
		}
		if (!this.agents.exists(run.sessionId)) {
			this.release();
			this.showEmpty(run);
			return;
		}
		this.showEmpty(undefined);
		if (this.chatSession === run.sessionId && this.chat) {
			return;
		}
		void this.bind(run.sessionId);
	}

	private async bind(sessionId: string): Promise<void> {
		const seq = ++this.binding;
		const editor = this.chat ?? this.createChat();
		this.chatSession = sessionId;
		// The chat's own input: the one a panel shows or a run records, else a headless one. It is never
		// ours to dispose, and a panel that opens the chat later takes it over, so no run is recorded twice.
		const input = AgentEditorInput.acquire(sessionId, this.instantiationService);
		// A headless input lets go of the chat when its run ends (a panel's, when the panel closes): show the chat's next one.
		this.inputListener.value = input.onWillDispose(() => {
			if (this.chat === editor && this.chatSession === sessionId) {
				this.chatSession = undefined;
				getWindow(this.element).setTimeout(() => this.bindSelected(), 0);
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
		this.mountThread();
		this.observeComposer();
		this.layoutChat();
		this.renderBar();
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
		// "Worked for 39s" (or the live status) shows the transcript over the composer, and hides it again.
		store.add(editor.onDidClickStatus(() => this.setTranscript(!this.transcript)));
		// The composer grows with what is typed, the approval tray and the queue: the chat's slot follows it.
		this.composerObserver = new (getWindow(this.chatHost).ResizeObserver)(() => this.layoutChat());
		this.observeComposer();
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
		this.mountThread();
		return editor;
	}

	/** The composer and what floats over it (chips, approvals, queue) change size as the chat goes. */
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

	/** A run whose chat was deleted: say so, and offer to take its outline off the board. */
	private showEmpty(run: IScratchAgentRun | undefined): void {
		this.emptyEl.hidden = !run;
		this.body.hidden = !!run;
		this.chatHost.hidden = !this.open || !!run;
		this.panel.hidden = !this.open || (!this.transcript && !run);
		if (!run) {
			return;
		}
		this.emptyEl.replaceChildren();
		append(this.emptyEl, $('.sx-dock-empty-title')).textContent = localize('voltScratch.dockGone', "This chat was deleted");
		append(this.emptyEl, $('.sx-dock-empty-text')).textContent = localize('voltScratch.dockGoneText', "Its outline is still on the board.");
		const remove = append(this.emptyEl, $('button.sx-dock-empty-action')) as HTMLButtonElement;
		remove.type = 'button';
		remove.classList.add('volt-button', 'volt-button-secondary', 'volt-button-small');
		remove.textContent = localize('voltScratch.dockRemoveOutline', "Remove Outline");
		remove.addEventListener('click', () => this.canvas.hideRun(run.id), { once: true });
	}

	/** Sizes the chat's slot to its composer, and the card to what is left of the page. */
	private layoutChat(): void {
		if (!this.open) {
			return;
		}
		const composer = this.chatHost.querySelector<HTMLElement>('.volt-agent-composer');
		const composerHeight = this.chat && !this.chatHost.hidden ? Math.ceil(composer?.offsetHeight ?? 0) : 0;
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
			const width = this.chatHost.clientWidth;
			if (this.chatHost.style.height !== `${composerHeight}px`) {
				this.chatHost.style.height = `${composerHeight}px`;
			}
			if (width > 0) {
				this.chat.layout(new Dimension(width, composerHeight));
			}
		}
		if (this.panel.hidden) {
			return;
		}
		const room = this.pageHeight - TOP_CLEARANCE - BOTTOM - (composerHeight ? composerHeight + floating + GAP : 0);
		const height = Math.round(Math.max(Math.min(MIN_HEIGHT, room), Math.min(this.height, room)));
		this.panel.style.height = `${height}px`;
		this.chat?.layoutThread();
		this.chat?.getThreadView()?.layout();
	}

	// ---- Size -----------------------------------------------------------------------------

	/** The grip on the card's top edge: drag to resize, double-click for the default height. */
	private installResize(grip: HTMLElement): void {
		this._register(addDisposableListener(grip, 'pointerdown', e => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			const startY = e.clientY;
			const start = this.panel.offsetHeight;
			const win = getWindow(grip);
			grip.setPointerCapture(e.pointerId);
			this.element.classList.add('resizing');
			const move = addDisposableListener(grip, 'pointermove', ev => {
				this.height = Math.max(MIN_HEIGHT, start + startY - ev.clientY);
				this.layoutChat();
			});
			const end = () => {
				move.dispose();
				up.dispose();
				cancel.dispose();
				this.element.classList.remove('resizing');
				// What the page allowed, not how far the pointer went past it.
				this.height = this.panel.offsetHeight || this.height;
				this.storageService.store(HEIGHT_KEY, Math.round(this.height), StorageScope.PROFILE, StorageTarget.USER);
				win.requestAnimationFrame(() => this.layoutChat());
			};
			const up = addDisposableListener(grip, 'pointerup', end);
			const cancel = addDisposableListener(grip, 'pointercancel', end);
		}));
		this._register(addDisposableListener(grip, 'dblclick', () => {
			this.height = DEFAULT_HEIGHT;
			this.layoutChat();
			this.storageService.store(HEIGHT_KEY, DEFAULT_HEIGHT, StorageScope.PROFILE, StorageTarget.USER);
		}));
	}

	// ---- Actions --------------------------------------------------------------------------

	private showOnBoard(): void {
		const run = this.selected();
		if (!run) {
			return;
		}
		const scene = this.canvas.scene;
		const live = run.elementIds.filter(id => scene?.get(id));
		if (live.length) {
			this.canvas.reveal(live);
		}
		this.canvas.focus();
	}
}
