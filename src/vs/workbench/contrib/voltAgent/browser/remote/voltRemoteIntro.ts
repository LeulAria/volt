/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltRemoteIntro.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { createVoltButton } from '../chrome/voltButton.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** brand/volt-icon.svg: the squircle (thinned to 120 points) and the bolt with its two faces. */
const SQUIRCLE = 'M924,512L924,639L923,679L922,708L920,732L918,752L916,770L913,785L909,799L905,812L901,824L896,835L891,845L884,854L878,863L871,871L863,878L854,884L845,891L835,896L824,901L812,905L799,909L785,913L770,916L752,918L732,920L708,922L679,923L639,924L512,924L385,924L345,923L316,922L292,920L272,918L254,916L239,913L225,909L212,905L200,901L189,896L179,891L170,884L161,878L153,871L146,863L140,854L133,845L128,835L123,824L119,812L115,799L111,785L108,770L106,752L104,732L102,708L101,679L100,639L100,512L100,385L101,345L102,316L104,292L106,272L108,254L111,239L115,225L119,212L123,200L128,189L133,179L140,170L146,161L153,153L161,146L170,140L179,133L189,128L200,123L212,119L225,115L239,111L254,108L272,106L292,104L316,102L345,101L385,100L512,100L639,100L679,101L708,102L732,104L752,106L770,108L785,111L799,115L812,119L824,123L835,128L845,133L854,140L863,146L871,153L878,161L884,170L891,179L896,189L901,200L905,212L909,225L913,239L916,254L918,272L920,292L922,316L923,345L924,385Z';
const BOLT = 'M561.9,243.1 L336.4,525.2 A13,13 0 0 0 345.0,546.2 L476.0,561.9 A8,8 0 0 1 482.9,571.6 L439.2,770.0 A13,13 0 0 0 462.1,780.9 L687.6,498.8 A13,13 0 0 0 679.0,477.8 L548.0,462.1 A8,8 0 0 1 541.1,452.4 L584.8,254.0 A13,13 0 0 0 561.9,243.1 Z';
const SHADOW_FACE = 'M321.8,543.4 L539.2,461.0 L500.6,563.0 L484.8,563.0 Z';
const LIGHT_FACE = 'M539.2,461.0 L702.2,480.6 L462.9,662.4 Z';

let markIds = 0;

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const element = parent.ownerDocument.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attrs)) {
		element.setAttribute(name, String(value));
	}
	parent.appendChild(element);
	return element;
}

function gradient(defs: SVGDefsElement, id: string, axis: Record<string, number>, stops: [number, string, number?][]): void {
	const element = svg(defs, 'linearGradient', { id, ...axis });
	for (const [offset, color, opacity] of stops) {
		svg(element, 'stop', opacity === undefined ? { offset, 'stop-color': color } : { offset, 'stop-color': color, 'stop-opacity': opacity });
	}
}

/** The Volt app icon, drawn from the brand file so it matches the dock icon exactly. */
export function renderVoltMark(parent: HTMLElement, size: number): SVGSVGElement {
	const id = `volt-mark-${++markIds}`;
	const root = svg(parent, 'svg', { viewBox: '100 100 824 824', width: size, height: size, 'aria-hidden': 'true', class: 'volt-mark' });
	const defs = svg(root, 'defs', {});
	gradient(defs, `${id}-body`, { x1: 0, y1: 0, x2: 0, y2: 1 }, [[0, '#141415'], [1, '#050505']]);
	gradient(defs, `${id}-rim`, { x1: 0, y1: 0, x2: 0, y2: 1 }, [[0, '#fff', 0.22], [0.25, '#fff', 0.06], [1, '#fff', 0.1]]);
	gradient(defs, `${id}-shadow`, { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0, '#C9C9CC'], [1, '#ADADB1']]);
	gradient(defs, `${id}-light`, { x1: 0.2, y1: 0, x2: 0.5, y2: 1 }, [[0, '#E2E2E5'], [1, '#CFCFD3']]);
	svg(svg(defs, 'clipPath', { id: `${id}-clip` }), 'path', { d: BOLT });
	svg(root, 'path', { d: SQUIRCLE, fill: `url(#${id}-body)` });
	svg(root, 'path', { d: SQUIRCLE, fill: 'none', stroke: `url(#${id}-rim)`, 'stroke-width': 4 });
	svg(root, 'path', { d: BOLT, fill: '#fff' });
	const faces = svg(root, 'g', { 'clip-path': `url(#${id}-clip)` });
	svg(faces, 'path', { d: SHADOW_FACE, fill: `url(#${id}-shadow)` });
	svg(faces, 'path', { d: LIGHT_FACE, fill: `url(#${id}-light)` });
	return root;
}

function lines(parent: HTMLElement, className: string, widths: number[]): void {
	for (const width of widths) {
		append(parent, $(className)).style.width = `${width}%`;
	}
}

/** The hero: this Mac's Volt window on a laptop, a phone in front following the same chat. */
function renderHero(hero: HTMLElement): void {
	const laptop = append(hero, $('.laptop'));
	const screen = append(append(laptop, $('.lid')), $('.screen'));
	const sidebar = append(screen, $('.side'));
	renderVoltMark(sidebar, 14);
	append(sidebar, $('.row.on'));
	lines(sidebar, '.row', [80, 65, 75]);
	const main = append(screen, $('.main'));
	append(main, $('.bubble'));
	lines(main, '.line', [90, 72, 84, 40]);
	append(main, $('.composer'));
	append(laptop, $('.base'));

	const phone = append(append(hero, $('.phone')), $('.phone-screen'));
	append(phone, $('.island'));
	const head = append(phone, $('.phone-head'));
	renderVoltMark(head, 12);
	append(head, $('span')).textContent = localize('voltRemoteIntro.phoneChat', "Fix auth redirect");
	append(phone, $('.phone-bubble.mine'));
	append(phone, $('.phone-bubble'));
	append(phone, $('.phone-bubble')).style.width = '80%';
	const typing = append(phone, $('.phone-status'));
	append(typing, $('span.live-dot.small'));
	append(typing, $('span')).textContent = localize('voltRemoteIntro.phoneStatus', "Editing 3 files…");
	append(phone, $('.phone-composer'));

	const pill = append(hero, $('.connected'));
	append(pill, $('span.live-dot'));
	append(pill, $('span')).textContent = localize('voltRemoteIntro.connected', "This Mac · Connected");
}

const FEATURES: { icon: ThemeIcon; title: string; detail: string }[] = [
	{ icon: Codicon.deviceMobile, title: localize('voltRemoteIntro.anywhere', "Pick up anywhere"), detail: localize('voltRemoteIntro.anywhereDetail', "Live chats, diffs and terminals, in sync.") },
	{ icon: Codicon.shield, title: localize('voltRemoteIntro.private', "Private by design"), detail: localize('voltRemoteIntro.privateDetail', "Only devices you pair can connect. Code stays on this Mac.") },
	{ icon: Codicon.key, title: localize('voltRemoteIntro.pair', "Pair in seconds"), detail: localize('voltRemoteIntro.pairDetail', "Scan a one-time code. Nothing to configure.") },
];

export interface IRemoteModal {
	readonly dialog: HTMLElement;
	/** The dark, dotted top of the card (with the close button). */
	readonly hero: HTMLElement;
	readonly body: HTMLElement;
	/** Disposed when the modal closes. */
	readonly store: DisposableStore;
	readonly window: Window & typeof globalThis;
	/** Labels the dialog with this heading. */
	labelWith(title: HTMLElement): void;
	close(): void;
}

let titleIds = 0;

/**
 * The Remote Control modal's frame: a dimmed scrim, an opaque 12px card with a dotted dark hero
 * and the body in the theme's colours. Closes on the close button, a click outside or Escape; `onClose` runs
 * once, however it closes.
 */
export function openRemoteModal(container: HTMLElement, className: string | undefined, onClose: () => void, options: { readonly split?: boolean } = {}): IRemoteModal {
	const store = new DisposableStore();
	const window = getWindow(container);
	const previousFocus = window.document.activeElement as HTMLElement | null;

	// No backdrop-filter anywhere here (volt-transparent-window skill): a plain dimmed scrim
	// and an opaque card.
	const layer = append(container, $('.volt-remote-intro-layer'));
	store.add(toDisposable(() => layer.remove()));
	layer.classList.toggle('split', !!options.split);
	const scrim = append(layer, $('.volt-remote-intro-scrim'));
	const dialog = append(layer, $('.volt-remote-intro'));
	if (className) {
		dialog.classList.add(className);
	}
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.tabIndex = -1;

	const hero = append(dialog, $('.hero'));
	append(hero, $('.dots.faint'));
	append(hero, $('.dots'));
	// Split: the hero is a column on the left, so the close button sits on the body's corner.
	const closeButton = append(options.split ? dialog : hero, $('button.close')) as HTMLButtonElement;
	dialog.classList.toggle('split', !!options.split);
	closeButton.type = 'button';
	closeButton.setAttribute('aria-label', localize('voltRemoteIntro.close', "Close"));
	closeButton.appendChild(renderIcon(Codicon.close));
	const body = append(dialog, $('.body'));

	let closed = false;
	const close = () => {
		if (closed) {
			return;
		}
		closed = true;
		store.dispose();
		previousFocus?.focus?.();
		onClose();
	};
	store.add(addDisposableListener(closeButton, EventType.CLICK, close));
	store.add(addDisposableListener(scrim, EventType.CLICK, close));
	store.add(addDisposableListener(layer, EventType.KEY_DOWN, e => {
		if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	}));
	return {
		dialog, hero, body, store, window, close,
		labelWith: title => {
			title.id ||= `volt-remote-modal-title-${++titleIds}`;
			dialog.setAttribute('aria-labelledby', title.id);
		},
	};
}

/**
 * The first-run introduction to Remote Control, shown the first time someone pairs a phone or
 * another computer. Resolves true when they choose to turn it on, false when they dismiss it.
 */
export function showRemoteControlIntro(container: HTMLElement): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		let accepted = false;
		const modal = openRemoteModal(container, undefined, () => resolve(accepted));
		const { body, store } = modal;
		renderHero(modal.hero);

		append(body, $('.eyebrow')).textContent = localize('voltRemoteIntro.eyebrow', "New in Volt");
		const title = append(body, $('h2'));
		title.textContent = localize('voltRemoteIntro.title', "Your agents, on every device.");
		modal.labelWith(title);
		append(body, $('p.subtitle')).textContent = localize('voltRemoteIntro.subtitle', "Turn on Remote Control to follow and steer chats running on this Mac from your phone or another computer.");

		const list = append(body, $('ul.features'));
		for (const feature of FEATURES) {
			const item = append(list, $('li'));
			append(item, $('span.feature-icon')).appendChild(renderIcon(feature.icon));
			const text = append(item, $('span'));
			append(text, $('b')).textContent = feature.title;
			append(text, $('span')).textContent = feature.detail;
		}

		const actions = append(body, $('.actions'));
		append(actions, $('span.footnote')).textContent = localize('voltRemoteIntro.footnote', "You can turn it off anytime.");
		const notNow = store.add(createVoltButton(actions, 'secondary'));
		notNow.label = localize('voltRemoteIntro.notNow', "Not Now");
		const turnOn = store.add(createVoltButton(actions, 'primary'));
		turnOn.label = localize('voltRemoteIntro.turnOn', "Turn On Remote Control");

		store.add(notNow.onDidClick(() => modal.close()));
		store.add(turnOn.onDidClick(() => {
			accepted = true;
			modal.close();
		}));
		modal.window.requestAnimationFrame(() => turnOn.focus());
	});
}
