/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's workbench on phones and touch screens (the browser only). The window takes two classes
// the web stylesheet keys on: `volt-web-phone` below a phone's width and `volt-web-touch` without
// hover. On a phone the title bar keeps the chat's own controls and moves the rest into a "…"
// menu, and the agents list follows a finger: pulled in from the chat's left edge, pushed back out
// to the left.

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
import { agentPhoneTool } from '../workspace/agentSurfaceHost.js';
import { postToVoltShell, voltShell } from './voltShellBridge.js';
import { showVoltShellComputers, VOLT_WEB_PHONE_QUERY } from './voltWebPhone.js';

const TOUCH_QUERY = '(hover: none)';

/** How far from the chat's left edge a finger must land to pull the agents list out. */
const EDGE_SWIPE_WIDTH = 28;
/** How far a finger moves before the swipe picks a direction (sideways moves the list, else it scrolls). */
const SWIPE_SLOP = 8;
/** How much more sideways than up or down a move must be to count as sideways. */
const SWIPE_SIDEWAYS_RATIO = 1.4;
/** A flick faster than this (px/ms) decides by its direction, however little of the list is out. */
const SWIPE_FLING_VELOCITY = 0.35;
/** How far back the flick's speed is measured. */
const SWIPE_VELOCITY_WINDOW_MS = 100;
/** Longest the list takes to finish the move once the finger lifts; a fast flick finishes sooner. */
const SWIPE_SETTLE_MAX_MS = 280;
const SWIPE_SETTLE_MIN_MS = 120;
const SWIPE_SETTLE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** A finger moving the agents list (a phone's full-screen drawer). */
interface IDrawerDrag {
	readonly id: number;
	readonly startX: number;
	readonly startY: number;
	/** Pulled in from the chat's edge, or pushed out from the open list. */
	readonly opening: boolean;
	engaged: boolean;
	view?: HTMLElement;
	scrim?: HTMLElement;
	width: number;
	/** The list's left edge from its open place: -width (away) to 0 (open). */
	offset: number;
	readonly samples: { x: number; t: number }[];
	frame?: number;
}

/** Title bar controls a phone moves into the "…" menu (hidden by voltWorkbenchWeb.css), in menu order. */
const OVERFLOW_CONTROLS: readonly { readonly selector: string; readonly icon: ThemeIcon }[] = [
	{ selector: '.volt-agent-primary-header-search', icon: Codicon.search },
	{ selector: '.volt-agent-nav-titlebar .volt-agent-nav-button:first-child', icon: Codicon.arrowLeft },
	{ selector: '.volt-agent-nav-titlebar .volt-agent-nav-button:last-child', icon: Codicon.arrowRight },
	{ selector: '.volt-agent-bottom-panel-toggle', icon: Codicon.terminal },
	{ selector: '.volt-agent-switch-to-ide', icon: Codicon.code },
];

class VoltWebTouchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebTouch';

	private readonly more: HTMLButtonElement;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		const root = layoutService.mainContainer;
		this.trackQuery(root, VOLT_WEB_PHONE_QUERY, 'volt-web-phone');
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
		const items: IVoltMenuItem<() => void>[] = [];
		for (const { selector, icon } of OVERFLOW_CONTROLS) {
			const control = titlebar?.querySelector<HTMLElement>(selector);
			const label = control?.getAttribute('aria-label');
			if (control && label) {
				items.push({ id: selector, label, icon, disabled: control.classList.contains('is-disabled') || control.hasAttribute('disabled'), data: () => control.click() });
			}
		}
		if (voltShell) {
			// The phone app's own list: switch to another computer, pair one, forget one.
			items.push({ id: 'computers', label: localize('voltWeb.computers', "Computers..."), icon: Codicon.vm, data: () => showVoltShellComputers() });
		}
		if (!items.length) {
			return;
		}
		showVoltMenu(this.contextViewService, {
			anchor: this.more,
			align: 'right',
			ariaLabel: localize('voltWeb.titlebarMore', "More Actions"),
			sections: [{ id: 'titlebar', items }],
			onPick: item => item.data(),
		});
	}

	/**
	 * The agents list under a finger. On a phone it fills the window: a swipe right from the chat's
	 * left edge pulls it in and a swipe left on it pushes it out, the list following the finger and
	 * the scrim fading with it; on lifting it finishes the way it was flicked, or else the way it is
	 * mostly out. Wider windows keep the drawer as it was: a swipe left over it closes it.
	 */
	private installDrawerSwipe(root: HTMLElement): void {
		const win = getWindow(root);
		let drag: IDrawerDrag | undefined;
		/** The list is still finishing a move; a new touch waits for it. */
		let settling = false;

		const touchOf = (list: TouchList, id: number) => {
			for (let i = 0; i < list.length; i++) {
				if (list[i].identifier === id) {
					return list[i];
				}
			}
			return undefined;
		};
		const paint = (d: IDrawerDrag) => {
			d.frame = undefined;
			if (d.view) {
				d.view.style.transform = `translate3d(${d.offset}px, 0, 0)`;
			}
			if (d.scrim) {
				d.scrim.style.opacity = String(Math.max(0, Math.min(1, 1 + d.offset / d.width)));
			}
		};
		const release = (d: IDrawerDrag) => {
			if (d.frame !== undefined) {
				win.cancelAnimationFrame(d.frame);
				d.frame = undefined;
			}
			for (const el of [d.view, d.scrim]) {
				el?.style.removeProperty('transform');
				el?.style.removeProperty('opacity');
				el?.style.removeProperty('transition');
			}
			root.classList.remove('volt-agent-drawer-dragging');
		};
		/** The list takes the finger: on its way in it opens now, off screen, and moves with the finger from there. */
		const engage = (d: IDrawerDrag): boolean => {
			root.classList.add('volt-agent-drawer-dragging');
			if (d.opening) {
				this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			}
			const view = this.layoutService.getContainer(win, Parts.AUXILIARYBAR_PART)?.parentElement ?? undefined;
			if (!root.classList.contains('volt-agent-drawer-open') || !view || !view.offsetWidth) {
				root.classList.remove('volt-agent-drawer-dragging');
				return false;
			}
			d.view = view;
			d.scrim = root.querySelector<HTMLElement>(':scope > .volt-agent-drawer-scrim') ?? undefined;
			d.width = view.offsetWidth;
			d.engaged = true;
			return true;
		};
		const settle = (d: IDrawerDrag, velocity: number) => {
			const progress = 1 + d.offset / d.width;
			const open = Math.abs(velocity) > SWIPE_FLING_VELOCITY ? velocity > 0 : progress > 0.5;
			const target = open ? 0 : -d.width;
			const remaining = Math.abs(target - d.offset);
			const speed = Math.max(Math.abs(velocity), remaining / SWIPE_SETTLE_MAX_MS, 0.001);
			const duration = Math.round(Math.max(SWIPE_SETTLE_MIN_MS, Math.min(SWIPE_SETTLE_MAX_MS, remaining / speed)));
			if (open && d.opening) {
				postToVoltShell({ type: 'haptic', style: 'selection' });
			}
			if (d.frame !== undefined) {
				win.cancelAnimationFrame(d.frame);
				d.frame = undefined;
			}
			settling = true;
			if (d.view) {
				d.view.style.transition = `transform ${duration}ms ${SWIPE_SETTLE_EASING}`;
			}
			if (d.scrim) {
				d.scrim.style.transition = `opacity ${duration}ms linear`;
			}
			d.offset = target;
			paint(d);
			win.setTimeout(() => {
				settling = false;
				if (!open) {
					// Still moved away by the finger, so the layout does not slide it away a second time.
					this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
				}
				release(d);
			}, duration + 20);
		};

		this._register(addDisposableListener(root, 'touchstart', (e: TouchEvent) => {
			drag = undefined;
			if (e.touches.length !== 1 || settling || !root.classList.contains('volt-agent-drawer-mode')) {
				return;
			}
			const touch = e.touches[0];
			const target = e.target as HTMLElement | null;
			const open = root.classList.contains('volt-agent-drawer-open');
			if (open) {
				if (!target?.closest('.part.auxiliarybar')) {
					return;
				}
			} else {
				// Only on a phone, from the chat's edge, with the chat (not its tools) in front.
				const tool = agentPhoneTool();
				const edge = touch.clientX - root.getBoundingClientRect().left;
				if (!root.classList.contains('volt-web-phone') || edge > EDGE_SWIPE_WIDTH || (tool !== 'chat' && tool !== undefined)
					|| !target?.closest('.part.editor, .part.titlebar')) {
					return;
				}
			}
			drag = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, opening: !open, engaged: false, width: 0, offset: 0, samples: [] };
		}, { passive: true }));

		this._register(addDisposableListener(root, 'touchmove', (e: TouchEvent) => {
			const d = drag;
			const touch = d && touchOf(e.touches, d.id);
			if (!d || !touch) {
				return;
			}
			const dx = touch.clientX - d.startX;
			const dy = touch.clientY - d.startY;
			const engaging = !d.engaged;
			if (engaging) {
				// Wider windows keep the narrow drawer still (the lift decides): only a phone's list follows the finger.
				if (!root.classList.contains('volt-web-phone') || (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP)) {
					return;
				}
				// Up and down scrolls the list or the chat; only a move the list's own way takes it.
				const sideways = Math.abs(dx) > Math.abs(dy) * SWIPE_SIDEWAYS_RATIO && (d.opening ? dx > 0 : dx < 0);
				if (!sideways || !engage(d)) {
					drag = undefined;
					return;
				}
			}
			if (e.cancelable) {
				e.preventDefault();
			}
			d.samples.push({ x: touch.clientX, t: e.timeStamp });
			while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > SWIPE_VELOCITY_WINDOW_MS) {
				d.samples.shift();
			}
			// Coming in, the list's right edge stays under the finger; going out, it moves as far as the finger did.
			const left = root.getBoundingClientRect().left;
			d.offset = Math.max(-d.width, Math.min(0, d.opening ? touch.clientX - left - d.width : dx));
			if (engaging) {
				// Now: the list just opened, and must not show a frame where it is all the way in.
				paint(d);
			} else {
				d.frame ??= win.requestAnimationFrame(() => paint(d));
			}
		}, { passive: false }));

		this._register(addDisposableListener(root, 'touchend', (e: TouchEvent) => {
			const d = drag;
			const touch = d && touchOf(e.changedTouches, d.id);
			if (!d || !touch) {
				return;
			}
			drag = undefined;
			if (d.engaged) {
				// From the moves, not the lift (some lifts report where the touch began); a finger that
				// stopped before lifting flicked nothing.
				const first = d.samples[0];
				const last = d.samples[d.samples.length - 1];
				const velocity = first && last.t > first.t && e.timeStamp - last.t < SWIPE_VELOCITY_WINDOW_MS ? (last.x - first.x) / (last.t - first.t) : 0;
				settle(d, velocity);
				return;
			}
			// The narrow drawer of a wider window: a swipe left over it closes it, as the scrim's tap does.
			const dx = touch.clientX - d.startX;
			const dy = touch.clientY - d.startY;
			if (!d.opening && dx < -SWIPE_SLOP * 7 && Math.abs(dx) > Math.abs(dy) * SWIPE_SIDEWAYS_RATIO) {
				this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			}
		}, { passive: true }));

		this._register(addDisposableListener(root, 'touchcancel', () => {
			const d = drag;
			drag = undefined;
			if (d?.engaged) {
				settle(d, 0);
			}
		}, { passive: true }));

		// Opened with a tap (Agent, the title bar's toggle), a phone's list slides in from the left as a
		// finger would bring it. An animation of its own: a class would start it again when a drag ends.
		let wasOpen = root.classList.contains('volt-agent-drawer-open');
		this._register(this.layoutService.onDidChangePartVisibility(() => {
			const open = root.classList.contains('volt-agent-drawer-open');
			if (open && !wasOpen && !root.classList.contains('volt-agent-drawer-dragging') && root.classList.contains('volt-web-phone')
				&& root.classList.contains('enable-motion') && !win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
				const view = this.layoutService.getContainer(win, Parts.AUXILIARYBAR_PART)?.parentElement;
				view?.animate([{ transform: 'translate3d(-100%, 0, 0)' }, { transform: 'none' }], { duration: SWIPE_SETTLE_MAX_MS, easing: SWIPE_SETTLE_EASING });
				root.querySelector<HTMLElement>(':scope > .volt-agent-drawer-scrim')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SWIPE_SETTLE_MAX_MS, easing: 'linear' });
			}
			wasOpen = open;
		}));
	}
}

registerWorkbenchContribution2(VoltWebTouchContribution.ID, VoltWebTouchContribution, WorkbenchPhase.AfterRestored);
