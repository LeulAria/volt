/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt on a phone, in a browser or in the Volt phone app (voltShellBridge.ts). The agent window is
// the same one the desktop draws; a phone gets a bottom bar that switches between the chat and the
// kinds of tabs its right panel holds (which lie over the chat on a phone, agentSurfaceHost.ts),
// turned on its side the same items as a rail along the left edge, the workbench keeps clear of the
// notch, the home indicator and the keyboard, and the system's Back closes what is open.

import { $, addDisposableListener, append, getWindow, isEditableElement } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { isDark } from '../../../../../platform/theme/common/theme.js';
import { editorBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { SIDE_BAR_BACKGROUND } from '../../../../common/theme.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { setWorkbenchLayoutInsets } from '../../../../browser/layoutInsets.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { AgentServerCloseCode } from '../../../../../platform/voltAgentServer/common/protocol.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { ToggleSidebarVisibilityAction } from '../../../../browser/actions/layoutActions.js';
import { onDidChangeShownAgentChat, shownAgentChat } from '../editor/agentShownChat.js';
import { AgentFilesSidebar } from '../workspace/agentFilesSidebar.js';
import { visibleSurfaceMenuItems } from '../workspace/agentSurfaceAddMenu.js';
import { AgentPhoneTool, agentPhoneTabs, agentPhoneTool, closeAgentPhoneTools, IAgentPhoneTab, onDidChangeAgentToolEditors, revealAgentPhoneTab, showAgentPhoneTool, VOLT_PHONE_LANDSCAPE_QUERY } from '../workspace/agentSurfaceHost.js';
import { BROWSER_ICON_SHAPES, createSurfaceStrokeIcon, SIDE_CHAT_ICON_PATH, surfaceOpenCommandId, SvgIconShapes, type AgentSurfaceMenuActionId } from '../workspace/agentSurfaceMenu.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { IVoltFeatureService } from '../../../voltCustomize/common/voltFeatures.js';
import { IVoltShellInsets, onVoltShellMessage, postToVoltShell, voltShell, voltShellInsets } from './voltShellBridge.js';

/** The width below which the window lays out for a phone (agentSurfaceHost.ts lays the tools over the chat below it too). */
export const VOLT_WEB_PHONE_QUERY = '(max-width: 600px)';

/** The bar's own height, above the home indicator. */
const NAV_HEIGHT = 52;

/** The rail's own width, past the notch, on a phone turned on its side (VS Code's activity bar is 48 too). */
const RAIL_WIDTH = 48;

/** Less of the page than this covered is a browser's toolbar, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 120;

/**
 * The phone app says the keyboard is coming before the page shrinks above it, or after. The bar goes
 * (or comes back) with the resize, so the composer moves once; this long without one, it goes anyway.
 */
const KEYBOARD_RESIZE_WAIT_MS = 500;

/** How long the connection to the computer is down before the phone app hears it is reconnecting. */
const CONNECTION_LOST_REPORT_MS = 2000;

/** Tabs the bar has its own item for; the rest open from Tabs. */
const NAV_SURFACES: ReadonlySet<AgentSurfaceMenuActionId> = new Set(['file', 'terminal', 'browser', 'changes']);

const CODE_ICON: SvgIconShapes = [['path', { d: 'm18 16 4-4-4-4' }], ['path', { d: 'm6 8-4 4 4 4' }], ['path', { d: 'm14.5 4-5 16' }]];
const TERMINAL_ICON: SvgIconShapes = [['path', { d: 'm4 17 6-6-6-6' }], ['path', { d: 'M12 19h8' }]];
const GIT_ICON: SvgIconShapes = [
	['path', { d: 'M6 3v12' }],
	['circle', { cx: 18, cy: 6, r: 3 }],
	['circle', { cx: 6, cy: 18, r: 3 }],
	['path', { d: 'M18 9a9 9 0 0 1-9 9' }],
];
const TABS_ICON: SvgIconShapes = [
	['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
	['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
	['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
	['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
];

interface INavItem {
	readonly tool: AgentPhoneTool;
	readonly label: string;
	readonly icon: string | SvgIconShapes;
}

const NAV_ITEMS: readonly INavItem[] = [
	{ tool: 'chat', label: localize('voltPhone.agent', "Agent"), icon: SIDE_CHAT_ICON_PATH },
	{ tool: 'browser', label: localize('voltPhone.browser', "Browser"), icon: BROWSER_ICON_SHAPES },
	{ tool: 'editor', label: localize('voltPhone.editor', "Editor"), icon: CODE_ICON },
	{ tool: 'terminal', label: localize('voltPhone.terminal', "Terminal"), icon: TERMINAL_ICON },
	{ tool: 'git', label: localize('voltPhone.git', "Git"), icon: GIT_ICON },
	{ tool: 'tabs', label: localize('voltPhone.tabs', "Tabs"), icon: TABS_ICON },
];

interface ITabPick extends IQuickPickItem {
	readonly tab?: IAgentPhoneTab;
	readonly open?: AgentSurfaceMenuActionId;
}

class VoltWebPhoneContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebPhone';

	private readonly root: HTMLElement;
	private readonly nav: HTMLElement;
	private readonly buttons = new Map<AgentPhoneTool, HTMLButtonElement>();
	private readonly tabsCount: HTMLElement;
	/** On Agent: another chat waits for an answer or an approval. */
	private readonly waitingDot: HTMLElement;
	/** Reads the page's env(safe-area-inset-*) values. */
	private readonly safeAreaProbe: HTMLElement;
	private readonly phoneQuery: MediaQueryList;
	private readonly landscapeQuery: MediaQueryList;
	private readonly syncScheduler: RunOnceScheduler;
	private readonly waitingScheduler: RunOnceScheduler;
	private keyboardOpen = false;
	private navShown = false;
	/** What the phone app last said about its keyboard; {@link keyboardOpen} follows once the page has resized. */
	private keyboardWanted = false;
	private readonly keyboardFallback: RunOnceScheduler;
	/** The page's width and its tallest height at that width: shorter than that by a keyboard means one is up. */
	private viewportWidth = 0;
	private viewportHeight = 0;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IThemeService private readonly themeService: IThemeService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IOpenerService openerService: IOpenerService,
		@IAgentWorkspaceService workspace: IAgentWorkspaceService,
		@IAgentServerClientService private readonly agentServer: IAgentServerClientService,
		@IVoltFeatureService private readonly featureService: IVoltFeatureService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
	) {
		super();
		this.root = layoutService.mainContainer;
		const doc = this.root.ownerDocument;
		const win = getWindow(this.root);
		this.syncScheduler = this._register(new RunOnceScheduler(() => this.sync(), 0));
		this.waitingScheduler = this._register(new RunOnceScheduler(() => this.syncWaiting(), 250));
		this.keyboardFallback = this._register(new RunOnceScheduler(() => this.setKeyboardOpen(this.keyboardWanted), KEYBOARD_RESIZE_WAIT_MS));

		this.safeAreaProbe = append(doc.body, $('.volt-phone-safe-area-probe'));
		this._register(toDisposable(() => this.safeAreaProbe.remove()));

		// Fixed to the page's bottom edge inside the workbench, so it takes the theme's colours; the
		// layout keeps the workbench above it (layoutInsets.ts).
		this.nav = append(this.root, $('nav.volt-phone-nav.hidden'));
		this.nav.setAttribute('role', 'tablist');
		this.nav.setAttribute('aria-label', localize('voltPhone.nav', "Agent Window"));
		this._register(toDisposable(() => this.nav.remove()));
		let tabsCount: HTMLElement | undefined;
		let waitingDot: HTMLElement | undefined;
		for (const item of NAV_ITEMS) {
			const button = append(this.nav, $('button.volt-phone-nav-item')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.dataset.tool = item.tool;
			const icon = append(button, $('span.volt-phone-nav-icon'));
			icon.appendChild(createSurfaceStrokeIcon(doc, item.icon));
			if (item.tool === 'tabs') {
				tabsCount = append(icon, $('span.volt-phone-nav-count'));
			} else if (item.tool === 'chat') {
				waitingDot = append(icon, $('span.volt-phone-nav-dot.hidden'));
			}
			append(button, $('span.volt-phone-nav-label')).textContent = item.label;
			button.setAttribute('aria-label', item.label);
			// A tap leaves the focus where it was: the bar is not a place to type, and a focused item draws a box.
			this._register(addDisposableListener(button, 'mousedown', e => e.preventDefault()));
			this._register(addDisposableListener(button, 'click', () => this.pick(item.tool)));
			this.buttons.set(item.tool, button);
		}
		this.tabsCount = tabsCount!;
		this.waitingDot = waitingDot!;

		const schedule = () => this.syncScheduler.schedule();
		this.phoneQuery = win.matchMedia(VOLT_WEB_PHONE_QUERY);
		this.landscapeQuery = win.matchMedia(VOLT_PHONE_LANDSCAPE_QUERY);
		this._register(addDisposableListener(this.phoneQuery, 'change', schedule));
		this._register(addDisposableListener(this.landscapeQuery, 'change', schedule));
		this._register(history.onDidChange(() => this.waitingScheduler.schedule()));
		this._register(onDidChangeShownAgentChat(() => this.waitingScheduler.schedule()));
		this._register(layoutService.onDidLayoutMainContainer(schedule));
		this._register(onDidChangeLayoutMode(schedule));
		this._register(onDidChangeAgentToolEditors(schedule));
		this._register(AgentFilesSidebar.onDidChange(schedule));
		this._register(workspace.onDidChangeActive(schedule));
		this._register(addDisposableListener(this.root, AGENT_TOOLS_VISIBILITY_EVENT, schedule));
		this._register(addDisposableListener(win, 'orientationchange', schedule));
		this._register(themeService.onDidColorThemeChange(() => this.postTheme()));

		if (voltShell) {
			this.connectShell(openerService);
		} else {
			this.watchKeyboard();
		}
		this.sync();
		this.syncWaiting();
	}

	private pick(tool: AgentPhoneTool): void {
		postToVoltShell({ type: 'haptic', style: 'selection' });
		const current = agentPhoneTool();
		if (tool === 'tabs') {
			void this.showTabs();
			return;
		}
		if (tool === 'chat' && (current === 'chat' || current === undefined)) {
			// Agent again: the list of agents (the title bar's toggle), the phone's way back to another chat.
			void this.commandService.executeCommand(ToggleSidebarVisibilityAction.ID);
			return;
		}
		if (this.root.classList.contains('volt-agent-drawer-open')) {
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
		showAgentPhoneTool(tool);
	}

	/** The tabs of the chat's tools, then what else can open there. */
	private async showTabs(): Promise<void> {
		const store = new DisposableStore();
		const picker = store.add(this.quickInputService.createQuickPick<ITabPick>({ useSeparators: true }));
		picker.placeholder = localize('voltPhone.tabsPlaceholder', "Open tabs and tools");
		picker.matchOnDescription = true;
		const closeButton = { iconClass: ThemeIcon.asClassName(Codicon.close), tooltip: localize('voltPhone.closeTab', "Close Tab") };
		const render = () => {
			const tabs = agentPhoneTabs();
			const items: (ITabPick | IQuickPickSeparator)[] = [];
			if (tabs.length) {
				items.push({ type: 'separator', label: localize('voltPhone.openTabs', "Open") });
			}
			let active: ITabPick | undefined;
			for (const tab of tabs) {
				const resource = tab.editor.resource;
				const icon = tab.editor.getIcon();
				// A file takes its file icon (classes on the label), a tool its own icon.
				const file = resource && (resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote || resource.scheme === Schemas.untitled);
				const item: ITabPick = {
					label: tab.editor.getName(),
					description: tab.editor.getDescription() ?? undefined,
					iconClasses: file ? getIconClasses(this.modelService, this.languageService, resource) : undefined,
					iconClass: file ? undefined : ThemeIcon.asClassName(ThemeIcon.isThemeIcon(icon) ? icon : Codicon.window),
					buttons: [closeButton],
					tab,
				};
				if (tab.active) {
					active = item;
				}
				items.push(item);
			}
			items.push({ type: 'separator', label: localize('voltPhone.newTab', "New") });
			for (const surface of visibleSurfaceMenuItems(this.configurationService, this.featureService)) {
				if (!NAV_SURFACES.has(surface.id)) {
					items.push({ label: surface.label, iconClass: ThemeIcon.asClassName(surface.icon), open: surface.id });
				}
			}
			picker.items = items;
			if (active) {
				picker.activeItems = [active];
			}
		};
		render();
		store.add(picker.onDidTriggerItemButton(e => {
			const tab = e.item.tab;
			if (tab) {
				void tab.group.closeEditor(tab.editor).then(render);
			}
		}));
		store.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			picker.hide();
			if (item?.tab) {
				revealAgentPhoneTab(item.tab);
			} else if (item?.open) {
				void this.commandService.executeCommand(surfaceOpenCommandId(item.open));
			}
		}));
		store.add(picker.onDidHide(() => store.dispose()));
		picker.show();
	}

	private sync(): void {
		const agent = getLayoutMode(this.layoutService) === 'agent';
		// A phone on its side keeps its height for the chat: the items stand in a rail at the left edge.
		const rail = agent && !this.phoneQuery.matches && this.landscapeQuery.matches;
		const phone = agent && (this.phoneQuery.matches || rail);
		const tool = phone ? agentPhoneTool() : undefined;
		// The keyboard covers a bottom bar; a rail beside it stays.
		const showNav = phone && (rail || !this.keyboardOpen);
		if (showNav !== this.navShown) {
			this.navShown = showNav;
			this.nav.classList.toggle('hidden', !showNav);
			this.root.classList.toggle('volt-phone-nav-shown', showNav);
		}
		this.nav.classList.toggle('rail', rail);
		this.nav.setAttribute('aria-orientation', rail ? 'vertical' : 'horizontal');
		this.root.classList.toggle('volt-phone-rail', showNav && rail);
		if (showNav) {
			for (const [item, button] of this.buttons) {
				const selected = item === tool;
				button.setAttribute('aria-selected', String(selected));
				button.classList.toggle('selected', selected);
				// Without a chat on screen (a page in front) only Agent has somewhere to go.
				button.disabled = tool === undefined && item !== 'chat' && item !== 'tabs';
			}
			const count = agentPhoneTabs().length;
			this.tabsCount.textContent = count ? String(count) : '';
			this.tabsCount.classList.toggle('hidden', !count);
		}
		const safe = this.safeArea();
		const bottom = this.keyboardOpen ? 0 : safe.bottom;
		const style = this.root.style;
		style.setProperty('--volt-phone-safe-top', `${safe.top}px`);
		style.setProperty('--volt-phone-safe-bottom', `${bottom}px`);
		style.setProperty('--volt-phone-safe-left', `${safe.left}px`);
		style.setProperty('--volt-phone-safe-right', `${safe.right}px`);
		style.setProperty('--volt-phone-nav-height', `${NAV_HEIGHT}px`);
		style.setProperty('--volt-phone-rail-width', `${RAIL_WIDTH}px`);
		const insets = {
			top: safe.top,
			right: safe.right,
			left: showNav && rail ? RAIL_WIDTH + safe.left : safe.left,
			bottom: showNav && !rail ? NAV_HEIGHT + bottom : bottom,
		};
		// The page's edges of the workbench, for what is fixed to the page inside it (the agents list on a phone).
		style.setProperty('--volt-phone-inset-top', `${insets.top}px`);
		style.setProperty('--volt-phone-inset-right', `${insets.right}px`);
		style.setProperty('--volt-phone-inset-bottom', `${insets.bottom}px`);
		style.setProperty('--volt-phone-inset-left', `${insets.left}px`);
		// The workbench keeps clear of the edges itself, so nothing inside it pads for them again.
		this.root.classList.toggle('volt-phone-insets', insets.top > 0 || insets.bottom > 0 || insets.left > 0 || insets.right > 0);
		setWorkbenchLayoutInsets(insets);
	}

	/** The dot on Agent: a chat other than the one on screen is blocked on a question or an approval. */
	private syncWaiting(): void {
		const shown = shownAgentChat();
		const waiting = this.history.list({ inWindow: true }).some(session => !!session.attention && !session.archived && session.id !== shown);
		if (waiting === this.waitingDot.classList.contains('hidden')) {
			this.waitingDot.classList.toggle('hidden', !waiting);
			this.buttons.get('chat')?.setAttribute('aria-label', waiting
				? localize('voltPhone.agentWaiting', "Agent, a chat is waiting for you")
				: localize('voltPhone.agent', "Agent"));
		}
	}

	/** The page's safe areas, or the ones the phone app measured when the page reports none (Android). */
	private safeArea(): IVoltShellInsets {
		const style = getWindow(this.safeAreaProbe).getComputedStyle(this.safeAreaProbe);
		const read = (value: string) => Math.max(0, Math.round(Number.parseFloat(value) || 0));
		const page = { top: read(style.paddingTop), right: read(style.paddingRight), bottom: read(style.paddingBottom), left: read(style.paddingLeft) };
		const shell = voltShellInsets();
		return shell ? {
			top: Math.max(page.top, shell.top),
			right: Math.max(page.right, shell.right),
			bottom: Math.max(page.bottom, shell.bottom),
			left: Math.max(page.left, shell.left),
		} : page;
	}

	private setKeyboardOpen(open: boolean): void {
		if (this.keyboardOpen !== open) {
			this.keyboardOpen = open;
			this.root.classList.toggle('volt-phone-keyboard', open);
			this.sync();
		}
	}

	/**
	 * In a phone's browser the bar steps aside while the keyboard is up. The keyboard shrinks the
	 * visual viewport, not the page (iOS Safari, Chrome on Android); a field that only has focus
	 * (the composer focuses itself) brings up no keyboard. (The phone app says when it shows instead.)
	 */
	private watchKeyboard(): void {
		const win = getWindow(this.root);
		const viewport = win.visualViewport;
		if (!viewport) {
			return;
		}
		const update = () => {
			const covered = win.innerHeight - viewport.height * viewport.scale;
			this.setKeyboardOpen(covered > KEYBOARD_MIN_HEIGHT && isEditableElement(this.root.ownerDocument.activeElement as Element));
		};
		this._register(addDisposableListener(viewport, 'resize', update));
		this._register(addDisposableListener(this.root, 'focusout', () => win.setTimeout(update, 0)));
	}

	//#region The Volt phone app

	private connectShell(openerService: IOpenerService): void {
		this.root.classList.add('volt-shell', `volt-shell-${voltShell!.platform}`);
		this.viewportShrunk();
		this._register(addDisposableListener(getWindow(this.root), 'resize', () => this.settleKeyboard()));
		this._register(onVoltShellMessage(message => {
			switch (message.type) {
				case 'insets':
					this.sync();
					break;
				case 'keyboard':
					this.keyboardWanted = message.visible && message.height > 0;
					this.settleKeyboard();
					break;
				case 'back':
					postToVoltShell({ type: 'back', handled: this.back() });
					break;
				case 'appState':
					if (message.active) {
						// iOS suspends the page in the background: the socket may be gone.
						this.agentServer.connection.reconnect();
						this.sync();
					}
					break;
			}
		}));
		// Links leave for the phone's own browser (the app's WebView would leave Volt).
		this._register(openerService.registerExternalOpener({
			openExternal: async (href: string) => {
				let scheme: string;
				try {
					scheme = URI.parse(href).scheme;
				} catch {
					return false;
				}
				if (scheme !== Schemas.http && scheme !== Schemas.https && scheme !== Schemas.mailto && scheme !== 'tel') {
					return false;
				}
				postToVoltShell({ type: 'openExternal', url: href });
				return true;
			}
		}));
		this.postTheme();
		this.reportConnection();
		// Painted: the app hides its launch screen.
		getWindow(this.root).requestAnimationFrame(() => postToVoltShell({ type: 'ready' }));
		setTimeout(() => postToVoltShell({ type: 'ready' }), 1000);
	}

	/**
	 * Tells the app how the link to the computer is doing: while the page reconnects the app looks for
	 * the computer's new address, and when the page's token is refused it signs in again.
	 */
	private reportConnection(): void {
		const connection = this.agentServer.connection;
		/** Said `reconnecting`; `open` follows once the connection is back. */
		let reconnecting = false;
		const report = () => {
			if (!reconnecting && connection.state !== 'open') {
				reconnecting = true;
				postToVoltShell({ type: 'connection', state: 'reconnecting' });
			}
		};
		// A moment's drop is not news: only a connection down this long is.
		const lost = this._register(new RunOnceScheduler(report, CONNECTION_LOST_REPORT_MS));
		const sync = () => {
			if (connection.state === 'open') {
				lost.cancel();
				if (reconnecting) {
					reconnecting = false;
					postToVoltShell({ type: 'connection', state: 'open' });
				}
			} else if (!reconnecting && !lost.isScheduled()) {
				lost.schedule();
			}
		};
		this._register(connection.onDidChangeState(sync));
		sync();
		// Back on a network: the computer may have a new address by now.
		this._register(addDisposableListener(getWindow(this.root), 'online', () => {
			lost.cancel();
			report();
		}));
		let failed = false;
		this._register(connection.onDidFail(({ code }) => {
			if (code === AgentServerCloseCode.Unauthorized && !failed) {
				failed = true;
				postToVoltShell({ type: 'connection', state: 'failed' });
			}
		}));
	}

	/**
	 * The app's WebView ends above its keyboard. The bar steps aside (or comes back) in the same frame
	 * the page changes height, whichever of the app's message and the resize comes first, so the
	 * composer moves once instead of dropping by the bar's height and then rising with the keyboard.
	 */
	private settleKeyboard(): void {
		if (this.viewportShrunk() === this.keyboardWanted) {
			this.keyboardFallback.cancel();
			this.setKeyboardOpen(this.keyboardWanted);
		} else if (this.keyboardOpen !== this.keyboardWanted) {
			this.keyboardFallback.schedule();
		}
	}

	/** Whether the page is a keyboard shorter than at its tallest (at this width: turning the phone starts over). */
	private viewportShrunk(): boolean {
		const win = getWindow(this.root);
		if (win.innerWidth !== this.viewportWidth) {
			this.viewportWidth = win.innerWidth;
			this.viewportHeight = win.innerHeight;
		} else {
			this.viewportHeight = Math.max(this.viewportHeight, win.innerHeight);
		}
		return win.innerHeight < this.viewportHeight - KEYBOARD_MIN_HEIGHT;
	}

	/** The system's Back (Android): closes the top-most thing open; false when nothing was. */
	private back(): boolean {
		if (this.quickInputService.currentQuickInput) {
			this.quickInputService.cancel();
			return true;
		}
		const doc = this.root.ownerDocument;
		const overlay = doc.querySelector('.monaco-dialog-modal-block, .context-view.monaco-component .monaco-menu-container, .context-view .volt-menu, .monaco-hover.workbench-hover');
		if (overlay) {
			const target = (doc.activeElement as HTMLElement | null) ?? doc.body;
			for (const type of ['keydown', 'keyup']) {
				target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
			}
			return true;
		}
		if (this.root.classList.contains('volt-agent-drawer-open')) {
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			return true;
		}
		return closeAgentPhoneTools();
	}

	private postTheme(): void {
		if (!voltShell) {
			return;
		}
		const theme = this.themeService.getColorTheme();
		const background = theme.getColor(SIDE_BAR_BACKGROUND) ?? theme.getColor(editorBackground);
		if (background) {
			postToVoltShell({ type: 'theme', background: background.toString(), dark: isDark(theme.type) });
		}
	}

	//#endregion
}

registerWorkbenchContribution2(VoltWebPhoneContribution.ID, VoltWebPhoneContribution, WorkbenchPhase.AfterRestored);

/** Asks the Volt phone app for its list of computers (switch, pair another, forget). */
export function showVoltShellComputers(): boolean {
	if (!voltShell) {
		return false;
	}
	postToVoltShell({ type: 'computers' });
	return true;
}

/** Tells the phone app this page signed out, instead of showing the browser's sign-in page. */
export function voltShellSignedOut(): boolean {
	if (!voltShell) {
		return false;
	}
	postToVoltShell({ type: 'signedOut' });
	return true;
}
