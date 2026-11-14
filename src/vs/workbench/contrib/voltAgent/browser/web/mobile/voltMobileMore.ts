/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The phone's More page: every workbench surface the bottom navigation has no room for (Search,
// Source Control, Extensions, Settings, the layouts, the command palette), as a full-screen list.
// It lists the `VoltMobileMoreMenu` menu, so a feature reaches phones by contributing a menu item:
//
//   MenuRegistry.appendMenuItem(VoltMobileMoreMenu, { command: { id, title, icon }, group: '2_workbench', order: 7 });
//
// Picking a row runs the command; the command's own view then opens as a page or a sheet.

import { $, append } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../../base/browser/ui/list/list.js';
import { VoltPage } from '../../../../../../base/browser/ui/voltMobile/voltPage.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { IMenuService, MenuId, MenuItemAction, MenuRegistry, SubmenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { LAYOUT_MODE_CONTEXT_KEY } from '../../../../../browser/parts/titlebar/layoutKeybindingMode.js';
import { SET_AGENT_LAYOUT_MODE_COMMAND_ID, SET_IDE_LAYOUT_MODE_COMMAND_ID } from '../../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchLayoutService } from '../../../../../services/layout/browser/layoutService.js';
import { SEARCH_AGENT_CHATS_COMMAND_ID } from '../../search/agentChatSearchService.js';
import { VoltMobileDestinations } from './voltMobileNavigation.js';

/** What the phone's More page lists. Contribute a command here to put it on phones. */
export const VoltMobileMoreMenu = new MenuId('VoltMobileMore');

const COMMAND_PALETTE_ID = 'workbench.action.showCommands';

type MoreRow =
	| { readonly kind: 'header'; readonly id: string; readonly label: string }
	| { readonly kind: 'action'; readonly id: string; readonly action: MenuItemAction };

const ROW_HEIGHT = 48;
const HEADER_HEIGHT = 36;

const GROUP_TITLES: Record<string, string> = {
	'1_go': localize('voltMobile.more.go', "Go To"),
	'2_workbench': localize('voltMobile.more.workbench', "Workbench"),
	'3_layout': localize('voltMobile.more.layout', "Layout"),
	'4_preferences': localize('voltMobile.more.preferences', "Preferences"),
};

let openPage: VoltPage | undefined;

export function isMobileMorePageOpen(): boolean {
	return !!openPage?.visible;
}

export function showMobileMorePage(accessor: ServicesAccessor): void {
	if (openPage) {
		return;
	}
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const instantiationService = accessor.get(IInstantiationService);
	const menuService = accessor.get(IMenuService);
	const contextKeyService = accessor.get(IContextKeyService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);

	const store = new DisposableStore();
	const run = (action: () => Promise<unknown>) => {
		page.hide();
		// Once the page starts leaving, so what the command opens lands on top.
		setTimeout(() => action().catch(error => notificationService.error(error)));
	};
	const page = store.add(new VoltPage({
		container: layoutService.mainContainer,
		title: localize('voltMobile.more', "More"),
		backLabel: localize('voltMobile.back', "Back"),
		className: 'volt-mobile-more',
		aboveBottomBar: true,
		actions: [{
			id: COMMAND_PALETTE_ID,
			label: localize('voltMobile.commandPalette', "Command Palette"),
			icon: Codicon.search,
			run: () => run(() => commandService.executeCommand(COMMAND_PALETTE_ID)),
		}],
	}));

	const menu = store.add(menuService.createMenu(VoltMobileMoreMenu, contextKeyService));
	const list = store.add(instantiationService.createInstance(WorkbenchList<MoreRow>, 'VoltMobileMore', page.body, new MoreDelegate(), [new HeaderRenderer(), new ActionRenderer()], {
		identityProvider: { getId: row => row.id },
		multipleSelectionSupport: false,
		horizontalScrolling: false,
		setRowLineHeight: false,
		accessibilityProvider: {
			getWidgetAriaLabel: () => localize('voltMobile.more', "More"),
			getRole: row => row.kind === 'action' ? 'menuitem' : 'presentation',
			getAriaLabel: row => row.kind === 'action' ? row.action.label : row.label,
		},
	}));

	const rows = (): MoreRow[] => {
		const result: MoreRow[] = [];
		for (const [group, actions] of menu.getActions()) {
			const items = actions.filter((a): a is MenuItemAction => !(a instanceof SubmenuItemAction) && a instanceof MenuItemAction);
			if (!items.length) {
				continue;
			}
			result.push({ kind: 'header', id: `group:${group}`, label: GROUP_TITLES[group] ?? groupTitle(group) });
			for (const action of items) {
				result.push({ kind: 'action', id: `${group}:${action.id}`, action });
			}
		}
		return result;
	};
	const refresh = () => list.splice(0, list.length, rows());
	store.add(menu.onDidChange(refresh));
	store.add(page.onDidResize(size => list.layout(size.height, size.width)));
	store.add(list.onDidOpen(e => {
		const row = e.element;
		if (row?.kind === 'action' && row.action.enabled) {
			run(() => row.action.run());
		}
	}));
	store.add(page.onDidHide(() => {
		openPage = undefined;
		store.dispose();
		VoltMobileDestinations.notifyActiveChanged();
	}));

	openPage = page;
	page.show();
	list.layout(page.body.clientHeight, page.body.clientWidth);
	refresh();
	VoltMobileDestinations.notifyActiveChanged();
}

function groupTitle(group: string): string {
	const name = group.replace(/^\d+_/, '').replace(/[_-]+/g, ' ');
	return name.charAt(0).toUpperCase() + name.slice(1);
}

class MoreDelegate implements IListVirtualDelegate<MoreRow> {
	getHeight(row: MoreRow): number {
		return row.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT;
	}
	getTemplateId(row: MoreRow): string {
		return row.kind;
	}
}

interface IHeaderTemplate {
	readonly label: HTMLElement;
}

class HeaderRenderer implements IListRenderer<MoreRow, IHeaderTemplate> {
	readonly templateId = 'header';
	renderTemplate(container: HTMLElement): IHeaderTemplate {
		const row = append(container, $('.volt-mobile-more-header'));
		return { label: row };
	}
	renderElement(row: MoreRow, _index: number, template: IHeaderTemplate): void {
		template.label.textContent = row.kind === 'header' ? row.label : '';
	}
	disposeTemplate(): void { }
}

interface IActionTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly row: HTMLElement;
}

class ActionRenderer implements IListRenderer<MoreRow, IActionTemplate> {
	readonly templateId = 'action';
	renderTemplate(container: HTMLElement): IActionTemplate {
		const row = append(container, $('.volt-mobile-more-row'));
		const icon = append(row, $('span.volt-mobile-more-icon'));
		const label = append(row, $('span.volt-mobile-more-label'));
		append(row, $('span.volt-mobile-more-chevron')).appendChild(renderIcon(Codicon.chevronRight));
		return { icon, label, row };
	}
	renderElement(row: MoreRow, _index: number, template: IActionTemplate): void {
		if (row.kind !== 'action') {
			return;
		}
		const icon = row.action.item.icon;
		template.icon.replaceChildren(...(ThemeIcon.isThemeIcon(icon) ? [renderIcon(icon)] : []));
		template.label.textContent = row.action.label;
		template.row.classList.toggle('disabled', !row.action.enabled);
	}
	disposeTemplate(): void { }
}

// ---- What phones get by default -----------------------------------------------------------

const agentLayout = ContextKeyExpr.equals(LAYOUT_MODE_CONTEXT_KEY, 'agent');
const ideLayout = ContextKeyExpr.notEquals(LAYOUT_MODE_CONTEXT_KEY, 'agent');

MenuRegistry.appendMenuItems([
	{ id: VoltMobileMoreMenu, item: { group: '1_go', order: 1, command: { id: 'workbench.action.quickOpen', title: localize2('voltMobile.goToFile', "Go to File"), icon: Codicon.goToFile } } },
	{ id: VoltMobileMoreMenu, item: { group: '1_go', order: 2, command: { id: COMMAND_PALETTE_ID, title: localize2('voltMobile.commandPalette', "Command Palette"), icon: Codicon.terminalCmd } } },
	{ id: VoltMobileMoreMenu, item: { group: '1_go', order: 3, when: agentLayout, command: { id: SEARCH_AGENT_CHATS_COMMAND_ID, title: localize2('voltMobile.searchChats', "Search Chats"), icon: Codicon.commentDiscussion } } },
	{ id: VoltMobileMoreMenu, item: { group: '2_workbench', order: 1, command: { id: 'workbench.view.explorer', title: localize2('voltMobile.explorer', "Explorer"), icon: Codicon.files } } },
	{ id: VoltMobileMoreMenu, item: { group: '2_workbench', order: 2, command: { id: 'workbench.view.search', title: localize2('voltMobile.search', "Search"), icon: Codicon.search } } },
	{ id: VoltMobileMoreMenu, item: { group: '2_workbench', order: 3, command: { id: 'workbench.view.scm', title: localize2('voltMobile.scm', "Source Control"), icon: Codicon.sourceControl } } },
	{ id: VoltMobileMoreMenu, item: { group: '2_workbench', order: 4, command: { id: 'workbench.view.extensions', title: localize2('voltMobile.extensions', "Extensions"), icon: Codicon.extensions } } },
	{ id: VoltMobileMoreMenu, item: { group: '2_workbench', order: 5, command: { id: 'workbench.view.debug', title: localize2('voltMobile.debug', "Run and Debug"), icon: Codicon.debugAlt } } },
	{ id: VoltMobileMoreMenu, item: { group: '2_workbench', order: 6, command: { id: 'workbench.actions.view.problems', title: localize2('voltMobile.problems', "Problems"), icon: Codicon.warning } } },
	{ id: VoltMobileMoreMenu, item: { group: '3_layout', order: 1, when: agentLayout, command: { id: SET_IDE_LAYOUT_MODE_COMMAND_ID, title: localize2('voltMobile.ideLayout', "Switch to IDE Layout"), icon: Codicon.layout } } },
	{ id: VoltMobileMoreMenu, item: { group: '3_layout', order: 1, when: ideLayout, command: { id: SET_AGENT_LAYOUT_MODE_COMMAND_ID, title: localize2('voltMobile.agentLayout', "Switch to Agent Layout"), icon: Codicon.commentDiscussion } } },
	{ id: VoltMobileMoreMenu, item: { group: '3_layout', order: 2, command: { id: 'workbench.action.navigateBack', title: localize2('voltMobile.back.nav', "Go Back"), icon: Codicon.arrowLeft } } },
	{ id: VoltMobileMoreMenu, item: { group: '3_layout', order: 3, command: { id: 'workbench.action.navigateForward', title: localize2('voltMobile.forward', "Go Forward"), icon: Codicon.arrowRight } } },
	{ id: VoltMobileMoreMenu, item: { group: '4_preferences', order: 1, command: { id: 'workbench.action.openSettings', title: localize2('voltMobile.settings', "Settings"), icon: Codicon.settingsGear } } },
	{ id: VoltMobileMoreMenu, item: { group: '4_preferences', order: 2, command: { id: 'workbench.action.selectTheme', title: localize2('voltMobile.theme', "Color Theme"), icon: Codicon.colorMode } } },
]);
