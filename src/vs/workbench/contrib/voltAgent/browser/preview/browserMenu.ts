/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';

export interface IBrowserMenuChoice {
	readonly id: string;
	readonly label: string;
	readonly checked: boolean;
	readonly run: () => void;
}

export type BrowserMenuEntry =
	| { readonly kind: 'item'; readonly label: string; readonly run: () => void; readonly disabled?: boolean; readonly keybinding?: string }
	| { readonly kind: 'toggle'; readonly label: string; readonly checked: boolean; readonly run: (checked: boolean) => void }
	| { readonly kind: 'submenu'; readonly label: string; readonly choices: readonly IBrowserMenuChoice[] }
	| { readonly kind: 'zoom'; readonly level: () => number; readonly zoomIn: () => void; readonly zoomOut: () => void; readonly reset: () => void }
	| { readonly kind: 'header'; readonly label: string }
	| { readonly kind: 'separator' };

/** The menu open right now, so pressing its trigger again closes it. */
let openMenu: { readonly anchor: HTMLElement; readonly hide: () => void } | undefined;

/**
 * The browser's ⋯ menu, drawn like Cursor's and T3 Code's: plain rows, a switch for settings, a
 * flyout for Appearance and an inline zoom stepper. Rows that change a setting keep it open.
 */
export function showBrowserMenu(contextViewService: IContextViewService, anchor: HTMLElement, entries: readonly BrowserMenuEntry[], onHide?: () => void): IDisposable {
	if (openMenu?.anchor === anchor) {
		openMenu.hide();
		return toDisposable(() => { });
	}
	let hidden = false;
	const hide = () => {
		if (!hidden) {
			hidden = true;
			contextViewService.hideContextView();
		}
	};
	contextViewService.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.RIGHT,
		anchorPosition: AnchorPosition.BELOW,
		canRelayout: true,
		render: container => {
			const store = new DisposableStore();
			const doc = anchor.ownerDocument;
			store.add(addDisposableListener(doc, 'mousedown', e => {
				if (e.target instanceof Node && (contextViewService.getContextViewElement().contains(e.target) || anchor.contains(e.target))) {
					return;
				}
				hide();
			}, true));
			// A press in the page never reaches this document; the page takes focus instead.
			store.add(addDisposableListener(getWindow(anchor), 'blur', () => hide()));
			anchor.classList.add('open');
			openMenu = { anchor, hide };
			store.add(toDisposable(() => {
				anchor.classList.remove('open');
				if (openMenu?.anchor === anchor) {
					openMenu = undefined;
				}
			}));
			const host = append(container, $('.volt-browser-menu-host'));
			store.add(toDisposable(() => host.remove()));
			const menu = append(host, $('.volt-browser-menu'));
			menu.setAttribute('role', 'menu');
			const rows: HTMLElement[] = [];
			let flyout: { element: HTMLElement; row: HTMLElement; rows: HTMLElement[] } | undefined;
			let flyoutTimer: number | undefined;
			const win = getWindow(anchor);
			const closeFlyout = () => {
				flyout?.element.remove();
				flyout?.row.classList.remove('open');
				flyout = undefined;
			};
			const openFlyout = (row: HTMLElement, choices: readonly IBrowserMenuChoice[], focus: boolean) => {
				if (flyout?.row === row) {
					if (focus) {
						flyout.rows[0]?.focus();
					}
					return;
				}
				closeFlyout();
				const element = append(host, $('.volt-browser-menu.volt-browser-menu-flyout'));
				element.setAttribute('role', 'menu');
				const flyoutRows: HTMLElement[] = [];
				for (const choice of choices) {
					const item = append(element, $('button.volt-browser-menu-row')) as HTMLButtonElement;
					item.type = 'button';
					item.setAttribute('role', 'menuitemradio');
					item.setAttribute('aria-checked', String(choice.checked));
					append(item, $('span.volt-browser-menu-label')).textContent = choice.label;
					if (choice.checked) {
						append(item, $('span.volt-browser-menu-trailing')).appendChild(renderIcon(Codicon.check));
					}
					store.add(addDisposableListener(item, 'click', () => {
						choice.run();
						hide();
					}));
					store.add(addDisposableListener(item, 'mouseenter', () => win.clearTimeout(flyoutTimer)));
					flyoutRows.push(item);
				}
				// Beside the row, on whichever side has room (the menu usually hugs the right edge).
				const menuBox = menu.getBoundingClientRect();
				const rowBox = row.getBoundingClientRect();
				const width = element.offsetWidth || 160;
				const toLeft = menuBox.right + width + 6 > win.innerWidth - 8;
				element.style.top = `${rowBox.top - menuBox.top - 5}px`;
				element.style.left = toLeft ? `${-width - 4}px` : `${menuBox.width + 4}px`;
				row.classList.add('open');
				flyout = { element, row, rows: flyoutRows };
				if (focus) {
					flyoutRows[0]?.focus();
				}
			};
			for (const entry of entries) {
				switch (entry.kind) {
					case 'separator':
						append(menu, $('.volt-browser-menu-separator'));
						break;
					case 'header':
						append(menu, $('.volt-browser-menu-header')).textContent = entry.label;
						break;
					case 'item': {
						const row = menuRow(menu, entry.label);
						row.setAttribute('role', 'menuitem');
						row.disabled = !!entry.disabled;
						if (entry.keybinding) {
							append(row, $('span.volt-browser-menu-keybinding')).textContent = entry.keybinding;
						}
						store.add(addDisposableListener(row, 'click', () => {
							hide();
							entry.run();
						}));
						rows.push(row);
						break;
					}
					case 'toggle': {
						const row = menuRow(menu, entry.label);
						row.setAttribute('role', 'menuitemcheckbox');
						let checked = entry.checked;
						const toggle = append(row, $('span.volt-browser-menu-switch'));
						const sync = () => {
							toggle.classList.toggle('on', checked);
							row.setAttribute('aria-checked', String(checked));
						};
						sync();
						store.add(addDisposableListener(row, 'click', () => {
							checked = !checked;
							sync();
							entry.run(checked);
						}));
						rows.push(row);
						break;
					}
					case 'submenu': {
						const row = menuRow(menu, entry.label);
						row.setAttribute('aria-haspopup', 'menu');
						append(row, $('span.volt-browser-menu-trailing')).appendChild(renderIcon(Codicon.chevronRight));
						store.add(addDisposableListener(row, 'mouseenter', () => {
							win.clearTimeout(flyoutTimer);
							openFlyout(row, entry.choices, false);
						}));
						store.add(addDisposableListener(row, 'click', () => openFlyout(row, entry.choices, true)));
						store.add(addDisposableListener(row, 'keydown', e => {
							if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
								e.preventDefault();
								openFlyout(row, entry.choices, true);
							}
						}));
						rows.push(row);
						break;
					}
					case 'zoom': {
						const row = append(menu, $('.volt-browser-menu-row.zoom'));
						append(row, $('span.volt-browser-menu-label')).textContent = localize('voltBrowser.menu.zoom', "Zoom");
						const controls = append(row, $('.volt-browser-menu-zoom'));
						const out = zoomButton(controls, Codicon.remove, localize('voltBrowser.menu.zoomOut', "Zoom Out"));
						const value = append(controls, $('span.volt-browser-menu-zoom-value'));
						const into = zoomButton(controls, Codicon.add, localize('voltBrowser.menu.zoomIn', "Zoom In"));
						const reset = zoomButton(controls, Codicon.discard, localize('voltBrowser.menu.zoomReset', "Reset Zoom"));
						reset.classList.add('reset');
						const sync = () => {
							value.textContent = `${Math.round(entry.level() * 100)}%`;
						};
						sync();
						store.add(addDisposableListener(out, 'click', () => { entry.zoomOut(); sync(); }));
						store.add(addDisposableListener(into, 'click', () => { entry.zoomIn(); sync(); }));
						store.add(addDisposableListener(reset, 'click', () => { entry.reset(); sync(); }));
						rows.push(out, into, reset);
						break;
					}
				}
			}
			// Leaving a row for anything but its flyout closes the flyout after a beat.
			for (const row of rows) {
				if (!row.hasAttribute('aria-haspopup')) {
					store.add(addDisposableListener(row, 'mouseenter', () => {
						win.clearTimeout(flyoutTimer);
						flyoutTimer = win.setTimeout(closeFlyout, 140);
					}));
				}
			}
			store.add(toDisposable(() => win.clearTimeout(flyoutTimer)));
			store.add(addDisposableListener(host, 'keydown', e => {
				const active = doc.activeElement;
				const inFlyout = !!flyout && isHTMLElement(active) && flyout.element.contains(active);
				const list = inFlyout && flyout ? flyout.rows : rows.filter(row => !(row as HTMLButtonElement).disabled);
				const index = isHTMLElement(active) ? list.indexOf(active) : -1;
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					if (inFlyout && flyout) {
						const owner = flyout.row;
						closeFlyout();
						owner.focus();
					} else {
						hide();
						anchor.focus();
					}
				} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					const step = e.key === 'ArrowDown' ? 1 : -1;
					list[(index + step + list.length) % list.length]?.focus();
				} else if (inFlyout && flyout && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
					e.preventDefault();
					const owner = flyout.row;
					closeFlyout();
					owner.focus();
				}
			}));
			win.setTimeout(() => rows.find(row => !(row as HTMLButtonElement).disabled)?.focus({ preventScroll: true }), 0);
			return store;
		},
		onHide: () => {
			hidden = true;
			onHide?.();
		},
	});
	return toDisposable(hide);
}

function menuRow(menu: HTMLElement, label: string): HTMLButtonElement {
	const row = append(menu, $('button.volt-browser-menu-row')) as HTMLButtonElement;
	row.type = 'button';
	append(row, $('span.volt-browser-menu-label')).textContent = label;
	return row;
}

function zoomButton(parent: HTMLElement, icon: typeof Codicon.add, label: string): HTMLButtonElement {
	const button = append(parent, $('button.volt-browser-menu-zoom-button')) as HTMLButtonElement;
	button.type = 'button';
	button.setAttribute('aria-label', label);
	button.title = label;
	button.appendChild(renderIcon(icon));
	return button;
}
