/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentRun.css';
import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../../base/browser/dom.js';
import { ActionBar, ActionsOrientation } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, IAction } from '../../../../../base/common/actions.js';
import { equals } from '../../../../../base/common/arrays.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { createActionViewItem, getFlatActionBarActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { DISCONNECT_ID, FOCUS_SESSION_ID, STOP_ID } from '../../../debug/browser/debugCommands.js';
import { createDisconnectMenuItemAction } from '../../../debug/browser/debugToolBar.js';
import { IDebugService, State } from '../../../debug/common/debug.js';
import { OPEN_BROWSER_COMMAND_ID } from '../preview/browserEditorInput.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IAgentActiveRun, IAgentRunService } from './agentRunService.js';

//#region Inline or floating

let inlineShown = false;
const onDidChangeInlineEmitter = new Emitter<void>();

/**
 * The chat side toolbar shows its own copy of the toolbar while it is expanded beside the chat;
 * otherwise the toolbar floats in the title bar next to the project name.
 */
export function setAgentRunToolbarInline(shown: boolean): void {
	if (shown !== inlineShown) {
		inlineShown = shown;
		onDidChangeInlineEmitter.fire();
	}
}

//#endregion

/**
 * VS Code's debug toolbar for the agent window: while a debug session runs, the real debug toolbar
 * menu (continue, step, restart, stop, and what extensions add, like Flutter's hot reload); while a
 * Volt run runs in its terminal, its own controls (hot reload for Flutter, restart, stop, output).
 */
export class AgentRunToolbar extends Disposable {

	readonly element: HTMLElement;
	private readonly actionBar: ActionBar;
	private readonly stopItemStore = this._register(new DisposableStore());
	private readonly runActions = this._register(new DisposableStore());
	private readonly debugMenu;
	private actions: readonly IAction[] = [];
	private readonly update = this._register(new RunOnceScheduler(() => this.doUpdate(), 20));
	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	/** The toolbar gained or lost its actions. */
	readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event;
	private project: URI | undefined;
	private runKey = '';

	constructor(
		parent: HTMLElement,
		@IDebugService private readonly debugService: IDebugService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentRunService private readonly runService: IAgentRunService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = append(parent, $('.volt-run-toolbar.hidden'));
		this.element.setAttribute('role', 'toolbar');
		const bar = append(this.element, $('.volt-run-toolbar-actions'));
		this.debugMenu = this._register(menuService.createMenu(MenuId.DebugToolBar, contextKeyService));
		this.actionBar = this._register(new ActionBar(bar, {
			orientation: ActionsOrientation.HORIZONTAL,
			actionViewItemProvider: (action: IAction, options: IBaseActionViewItemOptions) => {
				if (action.id === STOP_ID || action.id === DISCONNECT_ID) {
					this.stopItemStore.clear();
					const item = this.instantiationService.invokeFunction(accessor => createDisconnectMenuItemAction(action as MenuItemAction, this.stopItemStore, accessor, { hoverDelegate: options.hoverDelegate }));
					if (item) {
						return item;
					}
				}
				return createActionViewItem(this.instantiationService, action, options);
			},
		}));
		this._register(this.debugService.onDidChangeState(() => this.update.schedule()));
		this._register(this.debugMenu.onDidChange(() => this.update.schedule()));
		this._register(this.runService.onDidChange(() => this.update.schedule()));
		this.doUpdate();
	}

	get hasActions(): boolean {
		return this.actions.length > 0;
	}

	/** The project whose Volt run the toolbar controls (a debug session wins over any run). */
	setProject(project: URI | undefined): void {
		if (project?.toString() !== this.project?.toString()) {
			this.project = project;
			this.update.schedule();
		}
	}

	private doUpdate(): void {
		const debugging = this.debugService.state !== State.Inactive
			&& !this.debugService.getModel().getSessions().every(session => session.suppressDebugToolbar);
		let next: IAction[] = [];
		let mode: 'debug' | 'run' | '' = '';
		if (debugging) {
			mode = 'debug';
			// Focus Session is a native select: the side toolbar has no room for it, and one session needs none.
			next = getFlatActionBarActions(this.debugMenu.getActions({ shouldForwardArgs: true })).filter(action => action.id !== FOCUS_SESSION_ID);
		} else {
			const run = this.runService.activeRun(this.project);
			if (run) {
				mode = 'run';
				const key = `${run.project.toString()}\0${run.script.id}\0${run.url ?? ''}`;
				if (key !== this.runKey || this.element.dataset.mode !== 'run') {
					this.runKey = key;
					next = this.createRunActions(run);
				} else {
					next = [...this.actions];
				}
			}
		}
		this.element.dataset.mode = mode;
		const same = equals(next, this.actions, (a, b) => a.id === b.id && a.enabled === b.enabled);
		if (!same) {
			this.actionBar.clear();
			this.actionBar.push(next, { icon: true, label: false });
			const had = this.actions.length > 0;
			this.actions = next;
			this.element.classList.toggle('hidden', !next.length);
			if (had !== next.length > 0) {
				this._onDidChangeContent.fire();
			}
		}
		this.element.setAttribute('aria-label', mode === 'debug'
			? localize('agentRun.debugToolbar', "Debug toolbar")
			: localize('agentRun.runToolbar', "Run toolbar"));
	}

	private createRunActions(run: IAgentActiveRun): IAction[] {
		this.runActions.clear();
		const action = (id: string, label: string, icon: ThemeIcon, run: () => unknown) => this.runActions.add(new Action(id, label, ThemeIcon.asClassName(icon), true, async () => { await run(); }));
		const actions: IAction[] = [];
		if (run.script.stack === 'flutter') {
			actions.push(action('volt.run.hotReload', localize('agentRun.hotReload', "Hot Reload"), Codicon.zap, () => this.runService.hotReload(run, false)));
			actions.push(action('volt.run.hotRestart', localize('agentRun.hotRestart', "Hot Restart"), Codicon.debugRestart, () => this.runService.hotReload(run, true)));
		} else {
			actions.push(action('volt.run.restart', localize('agentRun.restart', "Restart"), Codicon.debugRestart, () => this.runService.restart(run)));
		}
		actions.push(action('volt.run.stop', localize('agentRun.stop', "Stop"), Codicon.debugStop, () => this.runService.stop(run)));
		if (run.url) {
			const url = run.url;
			actions.push(action('volt.run.openBrowser', localize('agentRun.openInBrowser', "Open {0} in Volt's Browser", url), Codicon.globe, () => this.commandService.executeCommand(OPEN_BROWSER_COMMAND_ID, url)));
		}
		actions.push(action('volt.run.output', localize('agentRun.showOutput', "Show Output"), Codicon.terminal, () => this.runService.showOutput(run)));
		return actions;
	}
}

/** Where the user dragged the floating toolbar, in pixels from the window's top left. */
const FLOATING_POSITION_KEY = 'volt.agent.runToolbar.position';
/** Between the chat title and the toolbar. */
const TITLE_GAP = 12;

/**
 * The toolbar while the chat side toolbar is collapsed or hidden: it floats in the title bar
 * after the project name and chat title (under them when the bar has no room), and its grip
 * drags it anywhere, as VS Code's floating debug toolbar does. Double-clicking the grip puts it back.
 */
class AgentFloatingRunToolbarContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentFloatingRunToolbar';

	private readonly host: HTMLElement;
	private readonly toolbar: AgentRunToolbar;
	private readonly headerResize = new ResizeObserver(() => this.place());
	private observedHeader: HTMLElement | undefined;
	private dragging = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.host = $('.volt-run-toolbar-float.hidden');
		this._register(toDisposable(() => this.host.remove()));
		this._register(toDisposable(() => this.headerResize.disconnect()));
		const grip = append(this.host, $('.volt-run-toolbar-grip'));
		grip.appendChild(renderIcon(Codicon.gripper));
		grip.setAttribute('aria-hidden', 'true');
		this.toolbar = this._register(instantiationService.createInstance(AgentRunToolbar, this.host));
		this._register(this.toolbar.onDidChangeContent(() => this.sync()));
		this._register(onDidChangeInlineEmitter.event(() => this.sync()));
		this._register(onDidChangeLayoutMode(() => this.sync()));
		this._register(layoutService.onDidLayoutMainContainer(() => this.sync()));
		this.registerDrag(grip);
		this.sync();
	}

	private sync(): void {
		const show = this.toolbar.hasActions && !inlineShown && getLayoutMode(this.layoutService) === 'agent';
		if (show && this.host.parentElement !== this.layoutService.mainContainer) {
			this.layoutService.mainContainer.appendChild(this.host);
		}
		this.host.classList.toggle('hidden', !show);
		if (show) {
			this.observeHeader();
			this.place();
		}
	}

	private header(): HTMLElement | undefined {
		const header = this.layoutService.mainContainer.querySelector('.volt-agent-primary-header');
		return isHTMLElement(header) && !header.hidden ? header : undefined;
	}

	private observeHeader(): void {
		const header = this.header();
		if (header !== this.observedHeader) {
			this.headerResize.disconnect();
			this.observedHeader = header;
			if (header) {
				this.headerResize.observe(header);
			}
		}
	}

	/** After the title when the bar has room for it, else under it; the user's spot when they dragged it. */
	private place(): void {
		if (this.dragging || this.host.classList.contains('hidden')) {
			return;
		}
		const container = this.layoutService.mainContainer;
		const bounds = container.getBoundingClientRect();
		const width = this.host.offsetWidth;
		const height = this.host.offsetHeight;
		const stored = this.storedPosition();
		if (stored) {
			this.moveTo(stored.x, stored.y, bounds, width, height);
			return;
		}
		const titlebar = container.querySelector('.part.titlebar');
		const bar = isHTMLElement(titlebar) ? titlebar.getBoundingClientRect() : undefined;
		const header = this.header();
		const title = header?.querySelector('.volt-agent-primary-header-title');
		const anchor = (isHTMLElement(title) && !title.hidden ? title : header)?.getBoundingClientRect();
		const toggles = container.querySelector('.volt-agent-titlebar-toggles');
		const rightLimit = isHTMLElement(toggles) && toggles.offsetParent ? toggles.getBoundingClientRect().left - 8 : bounds.right - 8;
		if (!bar || !anchor) {
			this.moveTo((bounds.width - width) / 2, 6, bounds, width, height);
			return;
		}
		const besideLeft = anchor.right + TITLE_GAP;
		if (besideLeft + width <= rightLimit) {
			this.moveTo(besideLeft - bounds.left, bar.top - bounds.top + (bar.height - height) / 2, bounds, width, height);
		} else {
			this.moveTo(anchor.left - bounds.left, bar.bottom - bounds.top + 6, bounds, width, height);
		}
	}

	private moveTo(x: number, y: number, bounds: DOMRect, width: number, height: number): void {
		const left = Math.max(4, Math.min(x, bounds.width - width - 4));
		const top = Math.max(2, Math.min(y, bounds.height - height - 4));
		this.host.style.left = `${Math.round(left)}px`;
		this.host.style.top = `${Math.round(top)}px`;
	}

	private storedPosition(): { x: number; y: number } | undefined {
		try {
			const raw = this.storageService.get(FLOATING_POSITION_KEY, StorageScope.PROFILE);
			const parsed = raw ? JSON.parse(raw) as { x?: unknown; y?: unknown } : undefined;
			return parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number' ? { x: parsed.x, y: parsed.y } : undefined;
		} catch {
			return undefined;
		}
	}

	private registerDrag(grip: HTMLElement): void {
		this._register(addDisposableListener(grip, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			const bounds = this.layoutService.mainContainer.getBoundingClientRect();
			const start = this.host.getBoundingClientRect();
			const offsetX = e.clientX - start.left;
			const offsetY = e.clientY - start.top;
			this.dragging = true;
			this.host.classList.add('dragging');
			grip.setPointerCapture(e.pointerId);
			const move = addDisposableListener(grip, EventType.POINTER_MOVE, (event: PointerEvent) => {
				this.moveTo(event.clientX - bounds.left - offsetX, event.clientY - bounds.top - offsetY, bounds, this.host.offsetWidth, this.host.offsetHeight);
			});
			const end = () => {
				move.dispose();
				up.dispose();
				cancel.dispose();
				this.dragging = false;
				this.host.classList.remove('dragging');
				const x = parseFloat(this.host.style.left);
				const y = parseFloat(this.host.style.top);
				if (Number.isFinite(x) && Number.isFinite(y)) {
					this.storageService.store(FLOATING_POSITION_KEY, JSON.stringify({ x, y }), StorageScope.PROFILE, StorageTarget.USER);
				}
			};
			const up = addDisposableListener(grip, EventType.POINTER_UP, end);
			const cancel = addDisposableListener(grip, 'pointercancel', end);
		}));
		// Back next to the project name.
		this._register(addDisposableListener(grip, EventType.DBLCLICK, () => {
			this.storageService.remove(FLOATING_POSITION_KEY, StorageScope.PROFILE);
			this.place();
		}));
	}
}

registerWorkbenchContribution2(AgentFloatingRunToolbarContribution.ID, AgentFloatingRunToolbarContribution, WorkbenchPhase.AfterRestored);
