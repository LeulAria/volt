/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// On a phone (voltWebTouch.ts sets `volt-web-phone`) the workbench's pop-ups open as a phone app's
// do: quick picks, Volt's menus, the model picker and context menus are bottom sheets that slide up
// over a dim scrim, with a grab handle; a tap on the scrim or a swipe down on the handle closes
// them. Toasts drop in under the title bar and swipe away. voltPhoneSheets.css lays all of it out
// (and dialogs and hovers); this file adds what CSS cannot: the scrim, the handle and its drag, the
// keyboard's edge in a phone's browser, and a haptic from the phone app.

import './media/voltPhoneSheets.css';
import { $, addDisposableListener, EventHelper, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { onDidShowVoltMenuSheet } from '../ui/menu/voltMenu.js';
import { postToVoltShell } from './voltShellBridge.js';

const PHONE_CLASS = 'volt-web-phone';

/** The tallest a sheet gets, as a share of the visible page (voltMenu.ts uses the same share). */
const SHEET_MAX_SHARE = 0.7;

/** A sheet dragged down this far (px), or flicked down this fast (px/ms), closes. */
const CLOSE_DISTANCE = 96;
const CLOSE_VELOCITY = 0.5;

/** How long a sheet and a toast take to slide out after a swipe (their transitions in voltPhoneSheets.css). */
const SHEET_SLIDE_OUT_MS = 200;
const SLIDE_OUT_MS = 160;

/**
 * The scrim stays this long after its sheet closed, fading: the rest of the tap that closed it
 * (the browser's mouse events come after the finger lifts) lands on it, not on what is under it.
 */
const SCRIM_LINGER_MS = 280;

/** A toast swiped this far sideways (px), or half as far up, is dismissed. */
const TOAST_DISMISS_DISTANCE = 64;

/** Set on the context view while the composer's model picker is in it (agentModelPicker.ts). */
const MODEL_PICKER_VIEW_CLASS = 'volt-agent-models-picker-view';

type SheetLayer = 'quick-input' | 'context';

class VoltPhoneSheetsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltPhoneSheets';

	private readonly root: HTMLElement;
	private readonly quickInputSheet = this._register(new MutableDisposable<DisposableStore>());
	private readonly contextMenuSheet = this._register(new MutableDisposable<DisposableStore>());
	private readonly modelPickerSheet = this._register(new MutableDisposable<DisposableStore>());
	/** The model picker's panel that has the sheet's handle; a picker opened again draws a new one. */
	private modelPickerPanel: HTMLElement | undefined;
	/** Open Volt menu sheets: they fit their lists again when the keyboard changes the page's height. */
	private voltMenuSheets = 0;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.root = layoutService.mainContainer;
		this.trackViewport();
		this.trackTitlebar();

		this._register(quickInputService.onShow(() => this.showQuickInput()));
		this._register(quickInputService.onHide(() => this.quickInputSheet.clear()));
		this._register(contextMenuService.onDidShowContextMenu(() => this.showContextMenu()));
		this._register(contextMenuService.onDidHideContextMenu(() => this.contextMenuSheet.clear()));
		this._register(onDidShowVoltMenuSheet(({ sheet, hide, store }) => {
			this.voltMenuSheets++;
			store.add(toDisposable(() => this.voltMenuSheets--));
			this.decorate(store, sheet, sheet, 'context', hide);
		}));
		this.watchModelPicker();
		this.installToastSwipe();
	}

	private get phone(): boolean {
		return this.root.classList.contains(PHONE_CLASS);
	}

	/**
	 * Where a sheet's bottom edge goes and how tall it may grow. In a phone's browser the keyboard
	 * covers the page instead of shrinking it (iOS), so a sheet sits on the visible part's edge.
	 */
	private trackViewport(): void {
		const win = getWindow(this.root);
		const viewport = win.visualViewport;
		const update = () => {
			const height = viewport ? viewport.height : win.innerHeight;
			const covered = viewport ? Math.max(0, win.innerHeight - viewport.height - viewport.offsetTop) : 0;
			const style = this.root.style;
			style.setProperty('--volt-phone-sheet-bottom', `${Math.round(covered)}px`);
			style.setProperty('--volt-phone-sheet-max-height', `${Math.round(height * SHEET_MAX_SHARE)}px`);
			if (this.voltMenuSheets) {
				// A Volt menu sizes its list in TypeScript (a context menu would close on a layout).
				this.contextViewService.layout();
			}
		};
		update();
		if (viewport) {
			this._register(addDisposableListener(viewport, 'resize', update));
			this._register(addDisposableListener(viewport, 'scroll', update));
		}
		this._register(addDisposableListener(win, 'resize', update));
	}

	/** Toasts drop in under the title bar (voltPhoneSheets.css). */
	private trackTitlebar(): void {
		const update = () => this.root.style.setProperty('--volt-phone-titlebar-height', `${this.layoutService.mainContainerOffset.top}px`);
		update();
		this._register(this.layoutService.onDidLayoutMainContainer(update));
	}

	private showQuickInput(): void {
		if (!this.phone || this.quickInputSheet.value) {
			// Not a phone, or one quick pick taking another's place in the same sheet.
			return;
		}
		const widget = this.root.querySelector<HTMLElement>(':scope > .quick-input-widget');
		if (!widget) {
			return;
		}
		const store = new DisposableStore();
		this.quickInputSheet.value = store;
		this.decorate(store, widget, widget, 'quick-input', () => this.quickInputService.cancel());
	}

	private showContextMenu(): void {
		const view = this.contextViewService.getContextViewElement();
		// voltPhoneSheets.css lays out the workbench's own context view; a menu drawn in a shadow
		// root (the custom title bar's) is out of its reach.
		if (!this.phone || !view.classList.contains('monaco-menu-container') || view.parentElement !== this.root) {
			return;
		}
		const store = new DisposableStore();
		this.contextMenuSheet.value = store;
		const hide = () => this.contextViewService.hideContextView(true);
		// The menu's own page-wide block takes the taps around it. On iOS a tap there leaves focus
		// in the menu, so the menu's blur does not close it: the tap's click does.
		const block = view.querySelector<HTMLElement>(':scope > .context-view-block');
		if (block) {
			store.add(addDisposableListener(block, 'click', e => {
				EventHelper.stop(e, true);
				hide();
			}));
		}
		this.decorate(store, view, view, 'context', hide, view.querySelector<HTMLElement>(':scope > .monaco-scrollable-element') ?? undefined);
	}

	/**
	 * The model picker opens in the context view without an event to say so: the class it sets
	 * there (voltPhoneSheets.css keys its sheet on it) is the sign.
	 */
	private watchModelPicker(): void {
		const view = this.contextViewService.getContextViewElement();
		const observer = new MutationObserver(() => this.syncModelPicker(view));
		observer.observe(view, { attributes: true, attributeFilter: ['class'] });
		this._register(toDisposable(() => observer.disconnect()));
	}

	private syncModelPicker(view: HTMLElement): void {
		const open = this.phone && view.classList.contains(MODEL_PICKER_VIEW_CLASS) && view.parentElement === this.root;
		const panel = open ? view.querySelector<HTMLElement>('.volt-agent-picker-panel') ?? undefined : undefined;
		if (panel === this.modelPickerPanel) {
			return;
		}
		this.modelPickerPanel = panel;
		this.modelPickerSheet.clear();
		if (panel) {
			const store = new DisposableStore();
			this.modelPickerSheet.value = store;
			this.decorate(store, view, panel, 'context', () => this.contextViewService.hideContextView());
		}
	}

	/**
	 * Gives a sheet its scrim, its grab handle (at the top of `handleParent`, or before
	 * `handleBefore`), the handle's drag, and a haptic from the phone app.
	 */
	private decorate(store: DisposableStore, sheet: HTMLElement, handleParent: HTMLElement, layer: SheetLayer, close: () => void, handleBefore?: HTMLElement): void {
		const scrim = $(`.volt-phone-sheet-scrim.${layer}`);
		this.root.appendChild(scrim);
		// A tap's mousedown would first move focus out of a quick pick; its click closes the sheet.
		store.add(addDisposableListener(scrim, 'mousedown', e => e.preventDefault()));
		store.add(addDisposableListener(scrim, 'click', e => {
			EventHelper.stop(e, true);
			close();
		}));
		store.add(toDisposable(() => {
			scrim.classList.add('closing');
			getWindow(scrim).setTimeout(() => scrim.remove(), SCRIM_LINGER_MS);
		}));

		const handle = $('.volt-phone-sheet-handle');
		handle.setAttribute('aria-hidden', 'true');
		handleParent.insertBefore(handle, handleBefore ?? handleParent.firstChild);
		store.add(toDisposable(() => handle.remove()));
		this.installDrag(store, handle, sheet, scrim, close);

		postToVoltShell({ type: 'haptic', style: 'selection' });
	}

	/**
	 * The sheet follows a finger dragging its handle down, its scrim fading as it goes, and closes
	 * when let go far or fast enough.
	 */
	private installDrag(store: DisposableStore, handle: HTMLElement, sheet: HTMLElement, scrim: HTMLElement, close: () => void): void {
		let start: { readonly y: number; readonly time: number } | undefined;
		let offset = 0;
		let closing = false;
		const move = (y: number) => {
			offset = y;
			sheet.style.transform = y ? `translateY(${y}px)` : '';
			scrim.style.opacity = y ? String(Math.max(0, 1 - y / Math.max(1, sheet.offsetHeight))) : '';
		};
		store.add(addDisposableListener(handle, 'touchstart', (e: TouchEvent) => {
			if (e.touches.length !== 1 || closing) {
				return;
			}
			start = { y: e.touches[0].clientY, time: Date.now() };
			offset = 0;
			sheet.classList.add('volt-phone-sheet-dragging');
			scrim.classList.add('volt-phone-sheet-dragging');
		}, { passive: true }));
		store.add(addDisposableListener(handle, 'touchmove', (e: TouchEvent) => {
			if (!start || e.touches.length !== 1) {
				return;
			}
			// The page must not scroll or bounce while the sheet follows the finger.
			e.preventDefault();
			move(Math.max(0, e.touches[0].clientY - start.y));
		}, { passive: false }));
		const end = () => {
			if (!start) {
				return;
			}
			const velocity = offset / Math.max(1, Date.now() - start.time);
			start = undefined;
			sheet.classList.remove('volt-phone-sheet-dragging');
			scrim.classList.remove('volt-phone-sheet-dragging');
			if (offset > CLOSE_DISTANCE || (offset > 24 && velocity > CLOSE_VELOCITY)) {
				// The rest of the way out, then closed.
				closing = true;
				move(sheet.offsetHeight);
				getWindow(sheet).setTimeout(close, SHEET_SLIDE_OUT_MS);
			} else {
				move(0);
			}
		};
		store.add(addDisposableListener(handle, 'touchend', end));
		store.add(addDisposableListener(handle, 'touchcancel', end));
		store.add(toDisposable(() => {
			sheet.classList.remove('volt-phone-sheet-dragging');
			sheet.style.transform = '';
		}));
	}

	/** A toast follows a finger swiping it up or sideways, and is dismissed when let go far enough. */
	private installToastSwipe(): void {
		let drag: { readonly toast: HTMLElement; readonly x: number; readonly y: number; dx: number; dy: number } | undefined;
		this._register(addDisposableListener(this.root, 'touchstart', (e: TouchEvent) => {
			const toast = this.phone && e.touches.length === 1 && isHTMLElement(e.target) ? e.target.closest<HTMLElement>('.notifications-toasts .notification-toast') : null;
			drag = toast ? { toast, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, dy: 0 } : undefined;
		}, { passive: true }));
		this._register(addDisposableListener(this.root, 'touchmove', (e: TouchEvent) => {
			if (!drag || e.touches.length !== 1) {
				return;
			}
			drag.dx = e.touches[0].clientX - drag.x;
			drag.dy = Math.min(0, e.touches[0].clientY - drag.y);
			drag.toast.classList.add('volt-phone-toast-dragging');
			drag.toast.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
			drag.toast.style.opacity = String(Math.max(0.2, 1 - Math.max(Math.abs(drag.dx), -drag.dy) / 240));
		}, { passive: true }));
		const end = () => {
			const current = drag;
			drag = undefined;
			if (!current) {
				return;
			}
			const { toast, dx, dy } = current;
			toast.classList.remove('volt-phone-toast-dragging');
			const clear = toast.querySelector<HTMLElement>('.action-label.codicon-notifications-clear');
			if (clear && (Math.abs(dx) > TOAST_DISMISS_DISTANCE || -dy > TOAST_DISMISS_DISTANCE / 2)) {
				// Out the way it went, then the toast's own Clear.
				toast.style.transform = Math.abs(dx) > -dy ? `translateX(${dx > 0 ? 110 : -110}%)` : 'translateY(-120%)';
				toast.style.opacity = '0';
				const win = getWindow(toast);
				win.setTimeout(() => {
					clear.click();
					// Back in place should the toast stay (its Clear runs a moment after the click).
					win.setTimeout(() => {
						toast.style.transform = '';
						toast.style.opacity = '';
					}, SCRIM_LINGER_MS);
				}, SLIDE_OUT_MS);
			} else {
				toast.style.transform = '';
				toast.style.opacity = '';
			}
		};
		this._register(addDisposableListener(this.root, 'touchend', end, { passive: true }));
		this._register(addDisposableListener(this.root, 'touchcancel', end, { passive: true }));
	}
}

registerWorkbenchContribution2(VoltPhoneSheetsContribution.ID, VoltPhoneSheetsContribution, WorkbenchPhase.AfterRestored);
