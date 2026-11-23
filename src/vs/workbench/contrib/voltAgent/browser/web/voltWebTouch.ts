/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's workbench on phones and touch screens (the browser only). The window takes two classes
// the web stylesheet keys on: `volt-web-phone` below a phone's width and `volt-web-touch` without
// hover. On a phone the title bar keeps the chat's own controls and moves the rest into a "…"
// menu, and the agents drawer closes with a swipe to the left.

import './mobile/voltMobileWorkbench.contribution.js';
import { $, addDisposableListener, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { TOGGLE_MOBILE_TERMINAL_COMMAND_ID } from './mobile/voltMobileNavigation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

/** The width below which the window lays out for a phone (agentSurfaceHost.ts lays the tools over the chat below it too). */
const PHONE_QUERY = '(max-width: 600px)';
const TOUCH_QUERY = '(hover: none)';

/** How far a finger moves left on the open drawer before it closes. */
const SWIPE_CLOSE_DISTANCE = 56;

interface IOverflowControl {
	readonly selector: string;
	readonly icon: ThemeIcon;
	/** The row's name when the control's own label says less on a phone. */
	readonly label?: (control: HTMLElement) => string;
	/** Runs instead of clicking the control (a phone opens it its own way). */
	readonly command?: string;
}

/**
 * Title bar controls a phone moves into the "…" menu (hidden by voltWorkbenchWeb.css), in menu order:
 * the chat's search, its open tabs and files (the right panel), the terminal, and the IDE layout.
 */
const OVERFLOW_CONTROLS: readonly IOverflowControl[] = [
	{ selector: '.volt-agent-primary-header-search', icon: Codicon.search },
	{ selector: '.volt-agent-right-panel-toggle', icon: Codicon.layoutSidebarRight, label: () => localize('voltWeb.openTabs', "Open Tabs") },
	{ selector: '.volt-agent-files-panel-toggle', icon: Codicon.files, label: () => localize('voltWeb.files', "Files") },
	{
		selector: '.volt-agent-bottom-panel-toggle',
		icon: Codicon.terminal,
		label: control => control.getAttribute('aria-expanded') === 'true' ? localize('voltWeb.closeTerminal', "Close Terminal") : localize('voltWeb.terminal', "Terminal"),
		command: TOGGLE_MOBILE_TERMINAL_COMMAND_ID,
	},
	{ selector: '.volt-agent-switch-to-ide', icon: Codicon.code },
];

class VoltWebTouchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebTouch';

	private readonly more: HTMLButtonElement;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const root = layoutService.mainContainer;
		this.trackQuery(root, PHONE_QUERY, 'volt-web-phone');
		this.trackQuery(root, TOUCH_QUERY, 'volt-web-touch');

		this.more = $('button.volt-agent-titlebar-toggle.volt-web-titlebar-more.volt-titlebar-control') as HTMLButtonElement;
		this.more.type = 'button';
		this.more.appendChild(renderIcon(Codicon.ellipsis));
		this.more.setAttribute('aria-label', localize('voltWeb.titlebarMore', "More Actions"));
		this.more.setAttribute('aria-haspopup', 'menu');
		this._register(toDisposable(() => this.more.remove()));
		this._register(addDisposableListener(this.more, 'click', () => this.showMore()));
		// The title bar's toggles are built by the agent layout once it is up; the button joins them then.
		this._register(layoutService.onDidLayoutMainContainer(() => this.mountMore()));
		this.mountMore();

		this.installDrawerSwipe(root);
	}

	private trackQuery(root: HTMLElement, query: string, className: string): void {
		const list = getWindow(root).matchMedia(query);
		const sync = () => root.classList.toggle(className, list.matches);
		sync();
		list.addEventListener('change', sync);
		this._register(toDisposable(() => {
			list.removeEventListener('change', sync);
			root.classList.remove(className);
		}));
	}

	private mountMore(): void {
		const toggles = this.layoutService.mainContainer.querySelector<HTMLElement>('.part.titlebar .volt-agent-titlebar-toggles');
		if (toggles && this.more.parentElement !== toggles) {
			toggles.appendChild(this.more);
		}
	}

	private showMore(): void {
		const titlebar = this.layoutService.mainContainer.querySelector<HTMLElement>('.part.titlebar');
		const items: IVoltMenuItem<{ readonly control: HTMLElement; readonly command?: string }>[] = [];
		const phone = this.layoutService.mainContainer.classList.contains('volt-mobile-phone');
		for (const { selector, icon, label: labelFor, command } of OVERFLOW_CONTROLS) {
			const control = titlebar?.querySelector<HTMLElement>(selector);
			const own = control?.getAttribute('aria-label');
			if (control && own) {
				const label = labelFor?.(control) ?? own;
				items.push({ id: selector, label, icon, disabled: control.classList.contains('is-disabled') || control.hasAttribute('disabled'), data: { control, command: phone ? command : undefined } });
			}
		}
		if (!items.length) {
			return;
		}
		showVoltMenu(this.contextViewService, {
			anchor: this.more,
			align: 'right',
			ariaLabel: localize('voltWeb.titlebarMore', "More Actions"),
			sections: [{ id: 'titlebar', items }],
			onPick: item => item.data.command ? void this.commandService.executeCommand(item.data.command) : item.data.control.click(),
		});
	}

	/** A swipe to the left over the open agents drawer closes it, as the scrim's tap does. */
	private installDrawerSwipe(root: HTMLElement): void {
		let start: { readonly x: number; readonly y: number } | undefined;
		this._register(addDisposableListener(root, 'touchstart', (e: TouchEvent) => {
			const target = e.target as HTMLElement | null;
			start = e.touches.length === 1 && root.classList.contains('volt-agent-drawer-open') && target?.closest('.part.auxiliarybar')
				? { x: e.touches[0].clientX, y: e.touches[0].clientY }
				: undefined;
		}, { passive: true }));
		this._register(addDisposableListener(root, 'touchend', (e: TouchEvent) => {
			const touch = e.changedTouches[0];
			if (!start || !touch) {
				return;
			}
			const dx = touch.clientX - start.x;
			const dy = touch.clientY - start.y;
			start = undefined;
			if (dx < -SWIPE_CLOSE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) {
				this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			}
		}, { passive: true }));
		this._register(addDisposableListener(root, 'touchcancel', () => start = undefined, { passive: true }));
	}
}

registerWorkbenchContribution2(VoltWebTouchContribution.ID, VoltWebTouchContribution, WorkbenchPhase.AfterRestored);
