/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's workbench on a phone (the browser only; the desktop never loads this). The workbench, its
// services, commands, views and extensions are the same ones; what changes is how they are
// presented and touched:
//
// - the viewport: phone / tablet / desktop, safe areas, the keyboard (voltViewport.ts), with the
//   grid laid out clear of the notch, the home indicator and the bottom navigation (layout.ts);
// - presentation: menus and context menus rise as bottom sheets (voltMenu.ts, voltMobileContextMenu.ts),
//   pickers as a sheet (quickInputController.ts), the side bar's views as full-screen pages
//   (layout.ts), the rest of the workbench behind More (voltMobileMore.ts);
// - navigation: a bottom bar of destinations (voltMobileNavigation.ts), and the system Back closing
//   whatever is on top (voltSurfaces.ts);
// - code: the keys a phone keyboard lacks on a bar above it (voltMobileKeyBar.ts), and editor
//   defaults for a narrow touch screen (voltMobileEditor.ts);
// - touch: a press state and a ripple on every control, long press for context menus on iOS, no
//   hover tooltips left behind by a tap (voltTouchFeedback.ts), sideways rows that follow a drag
//   (voltDragScroll.ts), and the click a tap would send where VS Code's Gesture cancels it (voltTapClick.ts).

import './media/voltMobileWorkbench.css';
import { $, addDisposableListener, getWindow, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { VoltDragScroll } from '../../../../../../base/browser/ui/voltMobile/voltDragScroll.js';
import { dismissAllVoltSurfaces, openVoltSurface } from '../../../../../../base/browser/ui/voltMobile/voltSurfaces.js';
import { installVoltTapClick } from '../../../../../../base/browser/ui/voltMobile/voltTapClick.js';
import { VoltTouchFeedback } from '../../../../../../base/browser/ui/voltMobile/voltTouchFeedback.js';
import { getVoltLayoutInsets, isVoltCompact, VoltFormFactor, VoltViewport } from '../../../../../../base/browser/ui/voltMobile/voltViewport.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { isIOS } from '../../../../../../base/common/platform.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { getLayoutMode, SET_AGENT_LAYOUT_MODE_COMMAND_ID } from '../../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../common/contributions.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../../../common/editor.js';
import { AgentEditorInput, NEW_AGENT_COMMAND_ID } from '../../editor/agentEditorInput.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../services/layout/browser/layoutService.js';
import { agentSessionToolTabs, closeAgentFilesSidebar, onDidChangeAgentToolEditors, openAgentToolsPanel, SHOW_AGENT_FILES_COMMAND_ID, shownAgentToolEditors, toggleAgentToolsPanel, agentToolsSessionOnScreen } from '../../workspace/agentSurfaceHost.js';
import { installMobileContextMenus } from './voltMobileContextMenu.js';
import { trackPhoneEditorDefaults } from './voltMobileEditor.js';
import { VoltMobileKeyBar } from './voltMobileKeyBar.js';
import { isMobileMorePageOpen, showMobileMorePage } from './voltMobileMore.js';
import { SHOW_MOBILE_EDITOR_COMMAND_ID, TOGGLE_MOBILE_TERMINAL_COMMAND_ID, VoltMobileDestinations, VoltMobileNavigationBar, VoltMobileStrokeIcon } from './voltMobileNavigation.js';
import { AGENT_HOME_NEW_CHAT_ICON_PATH } from '../../home/agentHomeIcons.js';
import { OPEN_PULL_REQUESTS_PAGE_COMMAND_ID } from '../../pullRequests/agentPullRequestCommands.js';
import { AgentPullRequestsPageInput } from '../../pullRequests/agentPullRequestsPageInput.js';

/** The window is a phone or a tablet (touch-first presentation). */
export const VoltMobileContext = new RawContextKey<boolean>('voltMobile', false, localize('voltMobile.context', "Whether the browser window is a phone or a tablet."));
/** 'phone', 'tablet' or 'desktop'. */
export const VoltMobileFormFactorContext = new RawContextKey<string>('voltMobileFormFactor', VoltFormFactor.Desktop, localize('voltMobile.formFactor', "The browser window's form factor: 'phone', 'tablet' or 'desktop'."));

// The navigation's icons: Lucide (via Aria Icons) message-circle, folder, git-pull-request, layout-grid,
// and New Chat's paper plane (the agent list's own, agentHomeIcons.ts).
const CHAT_ICON: VoltMobileStrokeIcon = [['path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' }]];
const PROJECTS_ICON: VoltMobileStrokeIcon = [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]];
const PULL_REQUESTS_ICON: VoltMobileStrokeIcon = [
	['circle', { cx: '18', cy: '18', r: '3' }],
	['circle', { cx: '6', cy: '6', r: '3' }],
	['path', { d: 'M13 6h3a2 2 0 0 1 2 2v7' }],
	['path', { d: 'M6 9v12' }],
];
const NEW_CHAT_ICON: VoltMobileStrokeIcon = [['path', { d: AGENT_HOME_NEW_CHAT_ICON_PATH }]];
const MORE_ICON: VoltMobileStrokeIcon = [
	['rect', { width: '7', height: '7', x: '3', y: '3', rx: '1' }],
	['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1' }],
	['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1' }],
	['rect', { width: '7', height: '7', x: '3', y: '14', rx: '1' }],
];

/** Volt Settings' one editor (voltSettingsEditorInput.ts). */
const VOLT_SETTINGS_RESOURCE = URI.from({ scheme: Schemas.voltSettings, path: 'settings' });
const TERMINAL_FOCUS_COMMAND_ID = 'workbench.action.terminal.focus';
const EXPLORER_VIEW_COMMAND_ID = 'workbench.view.explorer';

class VoltMobileWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltMobileWorkbench';

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextViewService contextViewService: IContextViewService,
		@INotificationService notificationService: INotificationService,
		@IQuickInputService quickInputService: IQuickInputService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		const root = layoutService.mainContainer;
		const win = getWindow(root);
		const viewport = this._register(VoltViewport.install(win, root));

		// Context keys, so menus and keybindings can tell a phone apart.
		const mobileKey = VoltMobileContext.bindTo(contextKeyService);
		const formFactorKey = VoltMobileFormFactorContext.bindTo(contextKeyService);
		const syncKeys = () => {
			mobileKey.set(viewport.state.formFactor !== VoltFormFactor.Desktop);
			formFactorKey.set(viewport.state.formFactor);
			// No hover tooltips on a phone, even before the first press (see `volt-touch-input` below).
			if (viewport.state.formFactor === VoltFormFactor.Phone) {
				win.document.documentElement.classList.add('volt-touch-input');
			}
		};
		syncKeys();

		// The grid follows the safe areas, the keyboard and the navigation bar. This runs before the
		// workbench has built its grid: until it is restored, its own first layout reads the insets.
		const layoutKey = () => `${viewport.state.formFactor}:${JSON.stringify(getVoltLayoutInsets())}`;
		let laidOut = layoutKey();
		const relayout = () => {
			if (layoutService.isRestored()) {
				layoutService.layout();
			}
		};
		this._register(viewport.onDidChange(() => {
			syncKeys();
			const key = layoutKey();
			if (key !== laidOut) {
				laidOut = key;
				relayout();
			}
		}));

		this._register(new VoltTouchFeedback(root, {
			reducedMotion: () => viewport.state.reducedMotion,
			// A phone-sized window answers a mouse the same way (a desktop browser, Volt's own preview).
			acceptMouse: () => viewport.state.formFactor !== VoltFormFactor.Desktop,
		}));
		// Chip rows, tab strips and pill bars follow a drag sideways (a mouse could not move them at all).
		this._register(new VoltDragScroll(root, { enabled: () => viewport.state.formFactor !== VoltFormFactor.Desktop }));
		// A plain button inside a view, a part's title or a list gets the click a finger's tap would send
		// (VS Code's Gesture cancels it there).
		this._register(installVoltTapClick(root, () => viewport.state.formFactor !== VoltFormFactor.Desktop));
		// A tap fires mouseenter: tooltips would open under the finger and stay. Hidden while the last press was a touch.
		// On the document: tooltips can mount outside the workbench.
		const html = win.document.documentElement;
		// A phone-sized window drops them for a mouse too: a phone has nothing to hover.
		this._register(addDisposableListener(win, 'pointerdown', (e: PointerEvent) => html.classList.toggle('volt-touch-input', e.pointerType !== 'mouse' || viewport.state.formFactor === VoltFormFactor.Phone), true));
		this._register(toDisposable(() => html.classList.remove('volt-touch-input')));

		this._register(installMobileContextMenus(root, contextViewService, notificationService));
		this._register(registerDefaultDestinations());
		// New Agent from anywhere (the title bar's paper plane, the Projects screen, a key): the new chat
		// takes the screen, so whatever lies over it closes first.
		this._register(commandService.onWillExecuteCommand(e => {
			if (e.commandId === NEW_AGENT_COMMAND_ID && viewport.state.formFactor === VoltFormFactor.Phone) {
				void instantiationService.invokeFunction(accessor => clearPhoneScreen(accessor));
			}
		}));
		this._register(instantiationService.createInstance(VoltMobileNavigationBar, root, viewport));
		this._register(instantiationService.createInstance(VoltMobileKeyBar, root, viewport));
		// A file opened from the Explorer takes the screen: a phone has no room for the two side by side.
		let tabs = shownAgentToolEditors().length;
		this._register(onDidChangeAgentToolEditors(() => {
			const now = shownAgentToolEditors().length;
			if (now > tabs && viewport.state.formFactor === VoltFormFactor.Phone) {
				closeAgentFilesSidebar();
			}
			tabs = now;
		}));
		this._register(trackPhoneEditorDefaults(() => viewport.state.formFactor === VoltFormFactor.Phone, listener => viewport.onDidChange(listener)));

		// A picker on a phone is a sheet: the page dims behind it, a tap there closes it (and lands on
		// nothing underneath), and the system Back closes it.
		const picker = this._register(new MutableDisposable<DisposableStore>());
		this._register(quickInputService.onShow(() => {
			if (!isVoltCompact()) {
				return;
			}
			const store = new DisposableStore();
			const entry = store.add(openVoltSurface({ dismiss: () => quickInputService.cancel(), dismissible: true }));
			const backdrop = root.appendChild($('.volt-quick-input-backdrop'));
			store.add(toDisposable(() => backdrop.remove()));
			// A picker opened from a sheet (the side toolbar's Run chevron, a menu row) rises over that
			// sheet: its own fixed z-index left it underneath, so the tap looked like it did nothing.
			const widget = root.ownerDocument.querySelector<HTMLElement>('.quick-input-widget');
			if (widget) {
				backdrop.style.zIndex = String(entry.zIndex);
				widget.style.zIndex = String(entry.zIndex + 1);
				store.add(toDisposable(() => widget.style.zIndex = ''));
			}
			store.add(addDisposableListener(backdrop, 'pointerdown', e => {
				e.preventDefault();
				quickInputService.cancel();
			}));
			picker.value = store;
		}));
		this._register(quickInputService.onHide(() => picker.clear()));

		// iOS scrolls the page to bring a focused field above its keyboard; the workbench already shrank
		// to the room left (getClientArea uses the visual viewport there), so put the page back.
		const vv = win.visualViewport;
		if (isIOS && vv) {
			this._register(addDisposableListener(vv, 'scroll', () => {
				if (vv.offsetTop > 0 && viewport.state.formFactor !== VoltFormFactor.Desktop) {
					win.scrollTo(0, 0);
				}
			}));
		}

		// A field the keyboard opened for stays in sight: its scrolling page (Settings, a sheet, a form)
		// brings it above the keyboard, as a native form does. The workbench itself already shrank.
		let keyboardWasOpen = viewport.state.keyboardOpen;
		const revealFocusedField = () => {
			const field = win.document.activeElement;
			if (isHTMLElement(field) && viewport.state.keyboardOpen) {
				win.requestAnimationFrame(() => revealInScroller(field));
			}
		};
		this._register(viewport.onDidChange(() => {
			const open = viewport.state.keyboardOpen;
			if (open && !keyboardWasOpen) {
				revealFocusedField();
			}
			keyboardWasOpen = open;
		}));
		this._register(addDisposableListener(root, 'focusin', () => revealFocusedField()));

		// The insets may have changed between the workbench's first layout and its restore.
		layoutService.whenRestored.then(() => {
			if (!this._store.isDisposed) {
				layoutService.layout();
			}
		});
	}
}

/**
 * Scrolls the nearest scrolling ancestor of `field` just enough that the field sits inside it with a
 * little room below. Not scrollIntoView: that also scrolls the workbench's own overflow-hidden boxes,
 * which shifts the whole layout off the screen.
 */
function revealInScroller(field: HTMLElement): void {
	// The composer and the editors scroll themselves; their textarea is a hidden helper.
	if (field.closest('.monaco-editor')) {
		return;
	}
	const win = getWindow(field);
	for (let node = field.parentElement; node && !node.classList.contains('monaco-workbench'); node = node.parentElement) {
		const overflowY = win.getComputedStyle(node).overflowY;
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
			const box = node.getBoundingClientRect();
			const target = field.getBoundingClientRect();
			const margin = 16;
			if (target.bottom + margin > box.bottom) {
				node.scrollTop += target.bottom + margin - box.bottom;
			} else if (target.top - margin < box.top) {
				node.scrollTop -= box.top - (target.top - margin);
			}
			return;
		}
	}
}

/**
 * Chats, Pull Requests, New Chat, Projects and More. Each clears what lies over the window (pages, sheets,
 * the drawer, the panel, the tools) before it shows its own surface, and reads its active state from
 * the workbench, so the bar is right however the surface was opened.
 */
/**
 * Brings the last chat back over the pages (Automations, Customize, Usage…) that took its place, or
 * a new one when no chat is left behind them (a reload restores only the page).
 */
async function showChatOverPages(editors: IEditorService, commands: ICommandService): Promise<void> {
	if (!editors.activeEditor || editors.activeEditor instanceof AgentEditorInput) {
		return;
	}
	const chat = editors.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(({ editor }) => editor instanceof AgentEditorInput);
	if (chat) {
		await editors.openEditor(chat.editor, undefined, chat.groupId);
	} else {
		await commands.executeCommand(NEW_AGENT_COMMAND_ID);
	}
}

/** The Pull Requests dashboard holds the chat's place. */
function pullRequestsOnScreen(editors: IEditorService): boolean {
	return editors.activeEditor instanceof AgentPullRequestsPageInput;
}

/** A page from More (Usage, Automations, Customize…) holds the chat's place. */
function morePageOnScreen(editors: IEditorService): boolean {
	const active = editors.activeEditor;
	return !!active && !(active instanceof AgentEditorInput) && !(active instanceof AgentPullRequestsPageInput);
}

const has = (layout: IWorkbenchLayoutService, className: string) => layout.mainContainer.classList.contains(className);
const isAgent = (layout: IWorkbenchLayoutService) => getLayoutMode(layout) === 'agent';
const drawerOpen = (layout: IWorkbenchLayoutService) => has(layout, 'volt-agent-drawer-open');
const sideBarPage = (layout: IWorkbenchLayoutService) => has(layout, 'volt-sidebar-page-open');
const toolsOpen = (layout: IWorkbenchLayoutService) => !!layout.mainContainer.querySelector(':scope > .volt-agent-tools-area:not(.hidden):not(.floating)');
const panelOpen = (layout: IWorkbenchLayoutService) => layout.isVisible(Parts.PANEL_PART);
const settingsOpen = (layout: IWorkbenchLayoutService) => has(layout, 'volt-settings-open');
/** A page or the drawer covers the window: no destination under it is the one on screen. */
const covered = (layout: IWorkbenchLayoutService) => isMobileMorePageOpen() || drawerOpen(layout) || sideBarPage(layout) || settingsOpen(layout);

/**
 * Takes what lies over the chat off the screen: pages, sheets, Settings, the drawer, the panel, the
 * tools. Resolves once Settings has closed: its editor leaving brings the chat's editor back, which
 * would otherwise land after (and cover) the terminal or page a tab opens next.
 */
function clearPhoneScreen(accessor: ServicesAccessor, keep: { readonly drawer?: boolean; readonly panel?: boolean; readonly tools?: boolean } = {}): Promise<unknown> {
	const layout = accessor.get(IWorkbenchLayoutService);
	dismissAllVoltSurfaces();
	// Volt Settings covers the window as an editor of its own: a tab of the bar leaves it.
	let settingsClosed: Promise<unknown> = Promise.resolve();
	if (settingsOpen(layout)) {
		const editors = accessor.get(IEditorService);
		settingsClosed = editors.closeEditors(editors.findEditors(VOLT_SETTINGS_RESOURCE));
	}
	if (!keep.drawer && drawerOpen(layout)) {
		layout.setPartHidden(true, Parts.AUXILIARYBAR_PART);
	}
	if (!keep.panel && panelOpen(layout)) {
		if (layout.isPanelMaximized()) {
			layout.toggleMaximizedPanel();
		}
		layout.setPartHidden(true, Parts.PANEL_PART);
	}
	if (!keep.tools && toolsOpen(layout)) {
		// The files sidebar keeps the tools open on its own; it closes first, then any tabs.
		closeAgentFilesSidebar();
		if (toolsOpen(layout)) {
			toggleAgentToolsPanel();
		}
	}
	return settingsClosed;
}

function registerDefaultDestinations(): IDisposable {
	const store = new DisposableStore();
	const clear = clearPhoneScreen;

	store.add(VoltMobileDestinations.register({
		id: 'chat',
		strokeIcon: CHAT_ICON,
		label: localize('voltMobile.nav.chats', "Chats"),
		icon: Codicon.commentDiscussion,
		order: 10,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			const editors = accessor.get(IEditorService);
			await clear(accessor);
			if (!isAgent(layout)) {
				await commands.executeCommand(SET_AGENT_LAYOUT_MODE_COMMAND_ID);
			}
			await showChatOverPages(editors, commands);
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const editors = accessor.get(IEditorService);
			return isAgent(layout) && !covered(layout) && !toolsOpen(layout) && !panelOpen(layout) && !pullRequestsOnScreen(editors) && !morePageOnScreen(editors);
		},
	}));

	// New Chat in the middle: the action a phone is opened for. NEW_AGENT_COMMAND_ID clears the screen
	// first (onWillExecuteCommand above), and the chat it opens lights Chats.
	store.add(VoltMobileDestinations.register({
		id: 'newChat',
		strokeIcon: NEW_CHAT_ICON,
		label: localize('voltMobile.nav.newChat', "New Chat"),
		icon: Codicon.add,
		order: 30,
		primary: true,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			if (!isAgent(layout)) {
				await commands.executeCommand(SET_AGENT_LAYOUT_MODE_COMMAND_ID);
			}
			await commands.executeCommand(NEW_AGENT_COMMAND_ID);
		},
		isActive: () => false,
	}));

	store.add(VoltMobileDestinations.register({
		id: 'projects',
		strokeIcon: PROJECTS_ICON,
		label: localize('voltMobile.nav.projects', "Projects"),
		icon: Codicon.folderLibrary,
		order: 40,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			if (isAgent(layout)) {
				await clear(accessor, { drawer: true });
				// The agents list: projects, their chats, and New Agent.
				layout.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			} else {
				await clear(accessor);
				await commands.executeCommand(EXPLORER_VIEW_COMMAND_ID);
			}
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			return !isMobileMorePageOpen() && !settingsOpen(layout) && (drawerOpen(layout) || (!isAgent(layout) && sideBarPage(layout)));
		},
	}));

	// The editor is a button in the chat's title bar (agentViewSidebars.ts), not a tab of the bar.
	store.add(CommandsRegistry.registerCommand(SHOW_MOBILE_EDITOR_COMMAND_ID, async accessor => {
		const layout = accessor.get(IWorkbenchLayoutService);
		const commands = accessor.get(ICommandService);
		const groups = accessor.get(IEditorGroupsService);
		const editors = accessor.get(IEditorService);
		await clear(accessor, { tools: true });
		if (!isAgent(layout)) {
			groups.activeGroup.focus();
			return;
		}
		// A page (Automations, Customize, Pull Requests) holds the chat's place and has no files of its
		// own: back to the chat first.
		await showChatOverPages(editors, commands);
		// The chat's tabs (its open files, browser, changes) over the chat; the Explorer when it has none,
		// rather than an empty panel of shortcuts.
		if (!toolsOpen(layout)) {
			const session = agentToolsSessionOnScreen();
			const tabs = session ? agentSessionToolTabs(session)?.tabs.length ?? 0 : 0;
			if (tabs) {
				openAgentToolsPanel();
			} else {
				await commands.executeCommand(SHOW_AGENT_FILES_COMMAND_ID);
			}
		}
		if (!toolsOpen(layout)) {
			openAgentToolsPanel();
		}
		VoltMobileDestinations.notifyActiveChanged();
	}, 'internal'));

	store.add(VoltMobileDestinations.register({
		id: 'pullRequests',
		strokeIcon: PULL_REQUESTS_ICON,
		label: localize('voltMobile.nav.pullRequests', "Pull Requests"),
		icon: Codicon.gitPullRequest,
		order: 20,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			await clear(accessor);
			if (!isAgent(layout)) {
				await commands.executeCommand(SET_AGENT_LAYOUT_MODE_COMMAND_ID);
			}
			// The dashboard: a page of its own, like Usage.
			await commands.executeCommand(OPEN_PULL_REQUESTS_PAGE_COMMAND_ID);
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			return !covered(layout) && !toolsOpen(layout) && !panelOpen(layout) && pullRequestsOnScreen(accessor.get(IEditorService));
		},
	}));

	// The terminal is a row of More and of the title bar's "…", not a tab: a phone opens it now and then.
	store.add(CommandsRegistry.registerCommand(TOGGLE_MOBILE_TERMINAL_COMMAND_ID, async accessor => {
		const layout = accessor.get(IWorkbenchLayoutService);
		const commands = accessor.get(ICommandService);
		if (panelOpen(layout) && !covered(layout)) {
			await clear(accessor);
			VoltMobileDestinations.notifyActiveChanged();
			return;
		}
		await clear(accessor, { panel: true });
		await commands.executeCommand(TERMINAL_FOCUS_COMMAND_ID);
		// The whole screen: a phone has no room for the terminal beside anything.
		if (layout.isVisible(Parts.PANEL_PART) && !layout.isPanelMaximized()) {
			layout.toggleMaximizedPanel();
		}
		VoltMobileDestinations.notifyActiveChanged();
	}, 'internal'));

	store.add(VoltMobileDestinations.register({
		id: 'more',
		strokeIcon: MORE_ICON,
		label: localize('voltMobile.nav.more', "More"),
		icon: Codicon.ellipsis,
		order: 50,
		open: accessor => {
			if (isMobileMorePageOpen()) {
				return;
			}
			void clear(accessor, { drawer: true, panel: true, tools: true });
			showMobileMorePage(accessor);
		},
		// More's own page, and what opens from it: Settings, the terminal, Usage, Automations, Customize.
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			if (isMobileMorePageOpen() || settingsOpen(layout)) {
				return true;
			}
			if (drawerOpen(layout) || sideBarPage(layout) || toolsOpen(layout)) {
				return false;
			}
			return panelOpen(layout) || (isAgent(layout) && morePageOnScreen(accessor.get(IEditorService)));
		},
	}));

	return store;
}

registerWorkbenchContribution2(VoltMobileWorkbenchContribution.ID, VoltMobileWorkbenchContribution, WorkbenchPhase.BlockRestore);
