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
// - touch: a press state and a ripple on every control, long press for context menus on iOS, and no
//   hover tooltips left behind by a tap (voltTouchFeedback.ts).

import './media/voltMobileWorkbench.css';
import { $, addDisposableListener, getWindow } from '../../../../../../base/browser/dom.js';
import { dismissAllVoltSurfaces, openVoltSurface } from '../../../../../../base/browser/ui/voltMobile/voltSurfaces.js';
import { VoltTouchFeedback } from '../../../../../../base/browser/ui/voltMobile/voltTouchFeedback.js';
import { getVoltLayoutInsets, isVoltCompact, VoltFormFactor, VoltViewport } from '../../../../../../base/browser/ui/voltMobile/voltViewport.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isIOS } from '../../../../../../base/common/platform.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { getLayoutMode, SET_AGENT_LAYOUT_MODE_COMMAND_ID } from '../../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../common/contributions.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../services/layout/browser/layoutService.js';
import { openAgentToolsPanel, SHOW_AGENT_FILES_COMMAND_ID, toggleAgentToolsPanel } from '../../workspace/agentSurfaceHost.js';
import { installMobileContextMenus } from './voltMobileContextMenu.js';
import { isMobileMorePageOpen, showMobileMorePage } from './voltMobileMore.js';
import { VoltMobileDestinations, VoltMobileNavigationBar } from './voltMobileNavigation.js';

/** The window is a phone or a tablet (touch-first presentation). */
export const VoltMobileContext = new RawContextKey<boolean>('voltMobile', false, localize('voltMobile.context', "Whether the browser window is a phone or a tablet."));
/** 'phone', 'tablet' or 'desktop'. */
export const VoltMobileFormFactorContext = new RawContextKey<string>('voltMobileFormFactor', VoltFormFactor.Desktop, localize('voltMobile.formFactor', "The browser window's form factor: 'phone', 'tablet' or 'desktop'."));

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
		};
		syncKeys();

		// The grid follows the safe areas, the keyboard and the navigation bar.
		const layoutKey = () => `${viewport.state.formFactor}:${JSON.stringify(getVoltLayoutInsets())}`;
		let laidOut = layoutKey();
		this._register(viewport.onDidChange(() => {
			syncKeys();
			const key = layoutKey();
			if (key !== laidOut) {
				laidOut = key;
				layoutService.layout();
			}
		}));

		this._register(new VoltTouchFeedback(root, { reducedMotion: () => viewport.state.reducedMotion }));
		// A tap fires mouseenter: tooltips would open under the finger and stay. Hidden while the last press was a touch.
		// On the document: tooltips can mount outside the workbench.
		const html = win.document.documentElement;
		this._register(addDisposableListener(win, 'pointerdown', (e: PointerEvent) => html.classList.toggle('volt-touch-input', e.pointerType !== 'mouse'), true));
		this._register(toDisposable(() => html.classList.remove('volt-touch-input')));

		this._register(installMobileContextMenus(root, contextViewService, notificationService));
		this._register(registerDefaultDestinations());
		this._register(instantiationService.createInstance(VoltMobileNavigationBar, root, viewport));

		// A picker on a phone is a sheet: the page dims behind it, a tap there closes it (and lands on
		// nothing underneath), and the system Back closes it.
		const picker = this._register(new MutableDisposable<DisposableStore>());
		this._register(quickInputService.onShow(() => {
			if (!isVoltCompact()) {
				return;
			}
			const store = new DisposableStore();
			store.add(openVoltSurface({ dismiss: () => quickInputService.cancel(), dismissible: true }));
			const backdrop = root.appendChild($('.volt-quick-input-backdrop'));
			store.add(toDisposable(() => backdrop.remove()));
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

		// The first layout ran before the viewport was known.
		layoutService.layout();
	}
}

/**
 * Chat, Projects, Editor, Terminal and More. Each clears what lies over the window (pages, sheets,
 * the drawer, the panel, the tools) before it shows its own surface, and reads its active state from
 * the workbench, so the bar is right however the surface was opened.
 */
function registerDefaultDestinations(): IDisposable {
	const store = new DisposableStore();
	const has = (layout: IWorkbenchLayoutService, className: string) => layout.mainContainer.classList.contains(className);
	const isAgent = (layout: IWorkbenchLayoutService) => getLayoutMode(layout) === 'agent';
	const drawerOpen = (layout: IWorkbenchLayoutService) => has(layout, 'volt-agent-drawer-open');
	const sideBarPage = (layout: IWorkbenchLayoutService) => has(layout, 'volt-sidebar-page-open');
	const toolsOpen = (layout: IWorkbenchLayoutService) => !!layout.mainContainer.querySelector(':scope > .volt-agent-tools-area:not(.hidden):not(.floating)');
	const panelOpen = (layout: IWorkbenchLayoutService) => layout.isVisible(Parts.PANEL_PART);
	/** A page or the drawer covers the window: no destination under it is the one on screen. */
	const covered = (layout: IWorkbenchLayoutService) => isMobileMorePageOpen() || drawerOpen(layout) || sideBarPage(layout);

	const clear = (layout: IWorkbenchLayoutService, keep: { readonly drawer?: boolean; readonly panel?: boolean; readonly tools?: boolean } = {}) => {
		dismissAllVoltSurfaces();
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
			toggleAgentToolsPanel();
		}
	};

	store.add(VoltMobileDestinations.register({
		id: 'chat',
		label: localize('voltMobile.nav.chat', "Chat"),
		icon: Codicon.commentDiscussion,
		order: 10,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			clear(layout);
			if (!isAgent(layout)) {
				await commands.executeCommand(SET_AGENT_LAYOUT_MODE_COMMAND_ID);
			}
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			return isAgent(layout) && !covered(layout) && !toolsOpen(layout) && !panelOpen(layout);
		},
	}));

	store.add(VoltMobileDestinations.register({
		id: 'projects',
		label: localize('voltMobile.nav.projects', "Projects"),
		icon: Codicon.folderLibrary,
		order: 20,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			if (isAgent(layout)) {
				clear(layout, { drawer: true });
				// The agents list: projects, their chats, and New Agent.
				layout.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			} else {
				clear(layout);
				await commands.executeCommand(EXPLORER_VIEW_COMMAND_ID);
			}
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			return !isMobileMorePageOpen() && (drawerOpen(layout) || (!isAgent(layout) && sideBarPage(layout)));
		},
	}));

	store.add(VoltMobileDestinations.register({
		id: 'editor',
		label: localize('voltMobile.nav.editor', "Editor"),
		icon: Codicon.files,
		order: 30,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			const groups = accessor.get(IEditorGroupsService);
			clear(layout, { tools: true });
			if (!isAgent(layout)) {
				groups.activeGroup.focus();
				return;
			}
			// The chat's tools (its open files and tabs) over the chat; the Explorer when there are none.
			if (!toolsOpen(layout)) {
				openAgentToolsPanel();
			}
			if (!toolsOpen(layout)) {
				await commands.executeCommand(SHOW_AGENT_FILES_COMMAND_ID);
			}
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			if (covered(layout) || panelOpen(layout)) {
				return false;
			}
			return isAgent(layout) ? toolsOpen(layout) : true;
		},
	}));

	store.add(VoltMobileDestinations.register({
		id: 'terminal',
		label: localize('voltMobile.nav.terminal', "Terminal"),
		icon: Codicon.terminal,
		order: 40,
		open: async accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			const commands = accessor.get(ICommandService);
			clear(layout, { panel: true });
			await commands.executeCommand(TERMINAL_FOCUS_COMMAND_ID);
			// The whole screen: a phone has no room for the terminal beside anything.
			if (layout.isVisible(Parts.PANEL_PART) && !layout.isPanelMaximized()) {
				layout.toggleMaximizedPanel();
			}
		},
		isActive: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			return !covered(layout) && panelOpen(layout);
		},
	}));

	store.add(VoltMobileDestinations.register({
		id: 'more',
		label: localize('voltMobile.nav.more', "More"),
		icon: Codicon.ellipsis,
		order: 50,
		open: accessor => {
			const layout = accessor.get(IWorkbenchLayoutService);
			if (isMobileMorePageOpen()) {
				return;
			}
			clear(layout, { drawer: true, panel: true, tools: true });
			showMobileMorePage(accessor);
		},
		isActive: () => isMobileMorePageOpen(),
	}));

	return store;
}

registerWorkbenchContribution2(VoltMobileWorkbenchContribution.ID, VoltMobileWorkbenchContribution, WorkbenchPhase.BlockRestore);
