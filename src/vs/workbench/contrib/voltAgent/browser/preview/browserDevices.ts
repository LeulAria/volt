/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';

/** How a device looks: drives its frame, status bar and side buttons. Undefined draws no frame. */
export type BrowserDeviceShape = 'island' | 'notch' | 'home' | 'punch' | 'bezel' | 'tablet' | 'tabletHome' | 'slate' | 'display';

export interface IBrowserDevice {
	readonly id: string;
	readonly label: string;
	readonly width: number;
	readonly height: number;
	readonly shape?: BrowserDeviceShape;
	readonly os?: 'ios' | 'android' | 'windows' | 'other';
	/** Outer corner radius, when it differs from the shape's. */
	readonly radius?: number;
	/** The body's edge color. */
	readonly finish?: string;
}

const RESPONSIVE_ID = 'responsive';

/** Cursor's list: current devices first. */
const CURRENT_DEVICES: readonly IBrowserDevice[] = [
	{ id: 'iphone-16e', label: 'iPhone 16e', width: 390, height: 844, shape: 'notch', os: 'ios', finish: '#2c2c2e' },
	{ id: 'iphone-17', label: 'iPhone 17', width: 402, height: 874, shape: 'island', os: 'ios', finish: '#3a3f47' },
	{ id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', width: 440, height: 956, shape: 'island', os: 'ios', finish: '#4a4640' },
	{ id: 'pixel-10', label: 'Pixel 10', width: 412, height: 923, shape: 'punch', os: 'android', radius: 46, finish: '#33363b' },
	{ id: 'galaxy-s25-ultra', label: 'Galaxy S25 Ultra', width: 384, height: 832, shape: 'punch', os: 'android', radius: 22, finish: '#3b3d40' },
	{ id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133, shape: 'tablet', os: 'ios', radius: 34, finish: '#3a3a3c' },
	{ id: 'ipad-air-11', label: 'iPad Air 11"', width: 820, height: 1180, shape: 'tablet', os: 'ios', finish: '#3a3a3c' },
	{ id: 'ipad-pro-13', label: 'iPad Pro 13"', width: 1032, height: 1376, shape: 'tablet', os: 'ios', radius: 38, finish: '#2e2e30' },
	{ id: 'laptop', label: localize('voltBrowser.device.laptop', "Laptop"), width: 1366, height: 768 },
	{ id: 'desktop', label: localize('voltBrowser.device.desktop', "Desktop"), width: 1920, height: 1080 },
];

/** Chrome DevTools' standard list. */
const STANDARD_DEVICES: readonly IBrowserDevice[] = [
	{ id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, shape: 'home', os: 'ios', finish: '#1f1f21' },
	{ id: 'iphone-xr', label: 'iPhone XR', width: 414, height: 896, shape: 'notch', os: 'ios', radius: 58, finish: '#1d3f6e' },
	{ id: 'iphone-12-pro', label: 'iPhone 12 Pro', width: 390, height: 844, shape: 'notch', os: 'ios', finish: '#3f4a52' },
	{ id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932, shape: 'island', os: 'ios', finish: '#3d3a4a' },
	{ id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, shape: 'punch', os: 'android', radius: 40, finish: '#2f3236' },
	{ id: 'galaxy-s8-plus', label: 'Samsung Galaxy S8+', width: 360, height: 740, shape: 'bezel', os: 'android', finish: '#202124' },
	{ id: 'galaxy-s20-ultra', label: 'Samsung Galaxy S20 Ultra', width: 412, height: 915, shape: 'punch', os: 'android', radius: 34, finish: '#2b2b2d' },
	{ id: 'ipad-mini-5', label: 'iPad Mini', width: 768, height: 1024, shape: 'tabletHome', os: 'ios', finish: '#c9c9cc' },
	{ id: 'ipad-air', label: 'iPad Air', width: 820, height: 1180, shape: 'tablet', os: 'ios', finish: '#3a3a3c' },
	{ id: 'ipad-pro', label: 'iPad Pro', width: 1024, height: 1366, shape: 'tablet', os: 'ios', radius: 38, finish: '#2e2e30' },
	{ id: 'surface-pro-7', label: 'Surface Pro 7', width: 912, height: 1368, shape: 'slate', os: 'windows', radius: 14, finish: '#9a9a9e' },
	{ id: 'surface-duo', label: 'Surface Duo', width: 540, height: 720, shape: 'bezel', os: 'android', radius: 26, finish: '#e9e9ea' },
	{ id: 'galaxy-z-fold-5', label: 'Galaxy Z Fold 5', width: 344, height: 882, shape: 'punch', os: 'android', radius: 28, finish: '#2a2b2e' },
	{ id: 'asus-zenbook-fold', label: 'Asus Zenbook Fold', width: 853, height: 1280, shape: 'slate', os: 'windows', radius: 18, finish: '#26282c' },
	{ id: 'galaxy-a51-71', label: 'Samsung Galaxy A51/71', width: 412, height: 914, shape: 'punch', os: 'android', radius: 38, finish: '#25262a' },
	{ id: 'nest-hub', label: 'Nest Hub', width: 1024, height: 600, shape: 'display', os: 'other' },
	{ id: 'nest-hub-max', label: 'Nest Hub Max', width: 1280, height: 800, shape: 'display', os: 'other' },
];

export const BROWSER_DEVICES: readonly IBrowserDevice[] = [...CURRENT_DEVICES, ...STANDARD_DEVICES];

const IOS_PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IOS_TABLET_UA = 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET_UA = 'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** The user agent a device's browser sends, so sites serve their mobile pages. Undefined keeps the desktop one. */
export function deviceUserAgent(device: IBrowserDevice | undefined): string | undefined {
	if (!device?.shape) {
		return undefined;
	}
	const tablet = device.shape === 'tablet' || device.shape === 'tabletHome' || device.shape === 'display';
	switch (device.os) {
		case 'ios':
			return tablet ? IOS_TABLET_UA : IOS_PHONE_UA;
		case 'android':
			return tablet ? ANDROID_TABLET_UA : ANDROID_PHONE_UA;
		default:
			return undefined;
	}
}

/** A frame's bezels in CSS px, portrait. The page's viewport sits between the status bar and the home bar. */
interface IFrameSpec {
	readonly side: number;
	readonly top: number;
	readonly bottom: number;
	readonly radius: number;
	/** Corner radius of the lit display inside the bezel. */
	readonly displayRadius: number;
	readonly status: number;
	readonly home: number;
	/** Space buttons and stands take outside the body. */
	readonly overhang: number;
}

function frameSpec(device: IBrowserDevice): IFrameSpec | undefined {
	switch (device.shape) {
		case 'island': {
			const radius = device.radius ?? 64;
			return { side: 13, top: 13, bottom: 13, radius, displayRadius: radius - 13, status: 54, home: 34, overhang: 7 };
		}
		case 'notch': {
			const radius = device.radius ?? 58;
			return { side: 14, top: 14, bottom: 14, radius, displayRadius: radius - 14, status: 47, home: 34, overhang: 7 };
		}
		case 'home':
			return { side: 20, top: 84, bottom: 84, radius: 56, displayRadius: 2, status: 20, home: 0, overhang: 7 };
		case 'punch': {
			const radius = device.radius ?? 40;
			return { side: 10, top: 10, bottom: 10, radius, displayRadius: Math.max(6, radius - 10), status: 32, home: 22, overhang: 7 };
		}
		case 'bezel': {
			const radius = device.radius ?? 48;
			return { side: 12, top: 52, bottom: 52, radius, displayRadius: 10, status: 24, home: 0, overhang: 7 };
		}
		case 'tablet': {
			const radius = device.radius ?? 36;
			return { side: 24, top: 24, bottom: 24, radius, displayRadius: radius - 20, status: 24, home: 20, overhang: 7 };
		}
		case 'tabletHome':
			return { side: 28, top: 70, bottom: 70, radius: device.radius ?? 42, displayRadius: 2, status: 20, home: 0, overhang: 7 };
		case 'slate':
			return { side: 26, top: 30, bottom: 30, radius: device.radius ?? 14, displayRadius: 4, status: 0, home: 0, overhang: 7 };
		case 'display':
			return { side: 24, top: 24, bottom: 24, radius: device.radius ?? 20, displayRadius: 6, status: 0, home: 0, overhang: 64 };
		default:
			return undefined;
	}
}

interface IInsets {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/** Where the viewport sits inside a device's frame, and the frame's outer size. */
function frameBox(spec: IFrameSpec, width: number, height: number, landscape: boolean): { insets: IInsets; width: number; height: number } {
	const portrait = {
		left: spec.side,
		top: spec.top + spec.status,
		right: spec.side,
		bottom: spec.bottom + spec.home,
	};
	if (!landscape) {
		return { insets: portrait, width: width + portrait.left + portrait.right, height: height + portrait.top + portrait.bottom };
	}
	// Turned a quarter left: the status bar ends up on the left edge, the home bar on the right.
	const insets = { left: portrait.top, top: portrait.right, right: portrait.bottom, bottom: portrait.left };
	return { insets, width: width + insets.left + insets.right, height: height + insets.top + insets.bottom };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(doc: Document, width: number, height: number, build: (root: SVGSVGElement) => void): SVGSVGElement {
	const root = doc.createElementNS(SVG_NS, 'svg');
	root.setAttribute('viewBox', `0 0 ${width} ${height}`);
	root.setAttribute('width', String(width));
	root.setAttribute('height', String(height));
	root.setAttribute('aria-hidden', 'true');
	build(root);
	return root;
}

function shape(root: SVGSVGElement, tag: string, attributes: Record<string, string>): void {
	const el = root.ownerDocument.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) {
		el.setAttribute(name, value);
	}
	root.appendChild(el);
}

function signalIcon(doc: Document, android: boolean): SVGSVGElement {
	if (android) {
		return svg(doc, 14, 14, root => shape(root, 'path', { d: 'M13 1v12H1z', fill: 'currentColor' }));
	}
	return svg(doc, 18, 12, root => {
		[[0, 8, 4], [5, 5.5, 6.5], [10, 3, 9], [15, 0, 12]].forEach(([x, y, h]) => shape(root, 'rect', { x: String(x), y: String(y), width: '3', height: String(h), rx: '1', fill: 'currentColor' }));
	});
}

function wifiIcon(doc: Document, android: boolean): SVGSVGElement {
	if (android) {
		return svg(doc, 16, 14, root => shape(root, 'path', { d: 'M8 13 0.6 4.4a11.4 11.4 0 0 1 14.8 0z', fill: 'currentColor' }));
	}
	return svg(doc, 17, 12, root => {
		shape(root, 'path', { d: 'M8.5 11.4 6.2 9.1a3.3 3.3 0 0 1 4.6 0z', fill: 'currentColor' });
		shape(root, 'path', { d: 'M3.9 6.8a6.5 6.5 0 0 1 9.2 0', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round' });
		shape(root, 'path', { d: 'M1.2 4.1a10.3 10.3 0 0 1 14.6 0', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round' });
	});
}

function batteryIcon(doc: Document, android: boolean): SVGSVGElement {
	if (android) {
		return svg(doc, 9, 15, root => {
			shape(root, 'rect', { x: '2.8', y: '0', width: '3.4', height: '2', rx: '0.6', fill: 'currentColor' });
			shape(root, 'rect', { x: '0', y: '1.6', width: '9', height: '13.4', rx: '1.6', fill: 'currentColor' });
		});
	}
	return svg(doc, 27, 13, root => {
		shape(root, 'rect', { x: '0.5', y: '0.5', width: '23', height: '12', rx: '3.8', fill: 'none', stroke: 'currentColor', 'stroke-opacity': '0.4' });
		shape(root, 'rect', { x: '2', y: '2', width: '20', height: '9', rx: '2.3', fill: 'currentColor' });
		shape(root, 'path', { d: 'M25 4.6v3.8a2 2 0 0 0 0-3.8z', fill: 'currentColor', 'fill-opacity': '0.45' });
	});
}

/** The status bar a device draws above the page: clock on the left, signal, Wi-Fi and battery on the right. */
function renderStatus(host: HTMLElement, device: IBrowserDevice): void {
	const doc = host.ownerDocument;
	const android = device.os === 'android';
	const tablet = device.shape === 'tablet' || device.shape === 'tabletHome';
	const lead = append(host, $('.volt-device-status-lead'));
	append(lead, $('span.volt-device-clock')).textContent = android ? '12:30' : '9:41';
	if (tablet) {
		append(lead, $('span.volt-device-date')).textContent = 'Tue Oct 3';
	}
	append(host, $('.volt-device-status-gap'));
	const icons = append(host, $('.volt-device-status-icons'));
	if (!tablet) {
		icons.appendChild(signalIcon(doc, android));
	}
	icons.appendChild(wifiIcon(doc, android));
	if (tablet) {
		append(icons, $('span.volt-device-battery-text')).textContent = '100%';
	}
	icons.appendChild(batteryIcon(doc, android));
}

interface IButtonSpec {
	readonly side: 'left' | 'right' | 'top';
	/** Offset along the edge, as a share of the edge's length. */
	readonly at: number;
	readonly length: number;
}

function buttonSpecs(device: IBrowserDevice): readonly IButtonSpec[] {
	switch (device.shape) {
		case 'island':
		case 'notch':
			return [
				{ side: 'left', at: 0.2, length: 0.036 },
				{ side: 'left', at: 0.27, length: 0.068 },
				{ side: 'left', at: 0.355, length: 0.068 },
				{ side: 'right', at: 0.3, length: 0.105 },
			];
		case 'home':
			return [
				{ side: 'left', at: 0.16, length: 0.04 },
				{ side: 'left', at: 0.235, length: 0.065 },
				{ side: 'left', at: 0.32, length: 0.065 },
				{ side: 'right', at: 0.22, length: 0.07 },
			];
		case 'punch':
		case 'bezel':
			return [
				{ side: 'right', at: 0.22, length: 0.13 },
				{ side: 'right', at: 0.4, length: 0.065 },
			];
		case 'tablet':
		case 'tabletHome':
			return [
				{ side: 'top', at: 0.82, length: 0.07 },
				{ side: 'right', at: 0.07, length: 0.045 },
				{ side: 'right', at: 0.125, length: 0.045 },
			];
		case 'slate':
			return [
				{ side: 'top', at: 0.08, length: 0.05 },
				{ side: 'top', at: 0.16, length: 0.07 },
			];
		default:
			return [];
	}
}

/**
 * A device drawn around the page, portrait, at 1:1 CSS px: body and edge, the lit display with its
 * status bar and home indicator, the camera (island, notch, punch hole), and side buttons.
 */
function renderDeviceFrame(device: IBrowserDevice, spec: IFrameSpec, width: number, height: number): HTMLElement {
	const frameWidth = width + spec.side * 2;
	const frameHeight = height + spec.top + spec.status + spec.home + spec.bottom;
	const frame = $(`.volt-device-frame.shape-${device.shape}.os-${device.os ?? 'other'}`);
	frame.style.width = `${frameWidth}px`;
	frame.style.height = `${frameHeight}px`;
	frame.style.setProperty('--volt-device-radius', `${spec.radius}px`);
	frame.style.setProperty('--volt-device-display-radius', `${spec.displayRadius}px`);
	if (device.finish) {
		frame.style.setProperty('--volt-device-finish', device.finish);
	}
	for (const button of buttonSpecs(device)) {
		const el = append(frame, $(`.volt-device-button.${button.side}`));
		if (button.side === 'top') {
			el.style.left = `${Math.round(frameWidth * button.at)}px`;
			el.style.width = `${Math.round(frameWidth * button.length)}px`;
		} else {
			el.style.top = `${Math.round(frameHeight * button.at)}px`;
			el.style.height = `${Math.round(frameHeight * button.length)}px`;
		}
	}
	const body = append(frame, $('.volt-device-body'));
	const display = append(body, $('.volt-device-display'));
	display.style.left = `${spec.side}px`;
	display.style.top = `${spec.top}px`;
	display.style.width = `${width}px`;
	display.style.height = `${spec.status + height + spec.home}px`;
	if (spec.status) {
		const status = append(display, $('.volt-device-status'));
		status.style.height = `${spec.status}px`;
		renderStatus(status, device);
	}
	if (spec.home) {
		const home = append(display, $('.volt-device-home'));
		home.style.height = `${spec.home}px`;
		append(home, $('span.volt-device-home-indicator'));
	}
	switch (device.shape) {
		case 'island':
			append(display, $('.volt-device-island'));
			break;
		case 'notch':
			append(display, $('.volt-device-notch'));
			break;
		case 'punch':
			append(display, $('.volt-device-punch'));
			break;
		case 'home': {
			const top = append(body, $('.volt-device-earpiece-row'));
			top.style.height = `${spec.top}px`;
			append(top, $('span.volt-device-camera'));
			append(top, $('span.volt-device-speaker'));
			const bottom = append(body, $('.volt-device-chin'));
			bottom.style.height = `${spec.bottom}px`;
			append(bottom, $('span.volt-device-home-button'));
			break;
		}
		case 'bezel': {
			const top = append(body, $('.volt-device-earpiece-row'));
			top.style.height = `${spec.top}px`;
			append(top, $('span.volt-device-speaker'));
			append(top, $('span.volt-device-camera'));
			break;
		}
		case 'tabletHome': {
			const top = append(body, $('.volt-device-earpiece-row'));
			top.style.height = `${spec.top}px`;
			append(top, $('span.volt-device-camera'));
			const bottom = append(body, $('.volt-device-chin'));
			bottom.style.height = `${spec.bottom}px`;
			append(bottom, $('span.volt-device-home-button'));
			break;
		}
		case 'tablet':
		case 'slate': {
			const top = append(body, $('.volt-device-earpiece-row'));
			top.style.height = `${spec.top}px`;
			append(top, $('span.volt-device-camera'));
			break;
		}
		case 'display':
			append(frame, $('.volt-device-stand'));
			break;
	}
	return frame;
}

/**
 * A device frame around a screen that draws its own status bar and home indicator (a simulator's
 * screenshot): portrait, `width`×`height` CSS px of screen, cameras and buttons included. The
 * screen goes into `display`. Undefined for shapes without a frame.
 */
export function renderBareDeviceFrame(device: IBrowserDevice, width: number, height: number): { frame: HTMLElement; display: HTMLElement; width: number; height: number } | undefined {
	const spec = frameSpec(device);
	if (!spec) {
		return undefined;
	}
	const bare: IFrameSpec = { ...spec, status: 0, home: 0 };
	const frame = renderDeviceFrame(device, bare, width, height);
	const display = frame.querySelector<HTMLElement>('.volt-device-display')!;
	return { frame, display, width: width + bare.side * 2, height: height + bare.top + bare.bottom };
}

export interface IBrowserDeviceSize {
	readonly width: number;
	readonly height: number;
}

export interface IBrowserDeviceHost {
	/** The page element, laid out at the viewport size and scaled to fit. */
	page(): HTMLElement | undefined;
	/** The viewport moved or changed size. */
	onDidLayout(): void;
	/** The device's user agent (undefined: desktop). The page reloads when it changes. */
	setUserAgent(userAgent: string | undefined): void;
	/** Turned off from the toolbar's own controls. */
	onDidDisable(): void;
}

type FitChoice = 'fit' | number;

const MIN_SIZE = 120;
const MAX_SIZE = 4096;
const STAGE_PAD = 20;
/** Room under the viewport for the toolbar, until it can be measured. */
const TOOLBAR_ZONE = 64;

/** Last size the user picked, so the next tab starts there. */
const MOBILE_SIZE: IBrowserDeviceSize = { width: 390, height: 844 };
let lastSize: IBrowserDeviceSize | undefined;

/**
 * Responsive design mode: the page at a chosen viewport size, centered on the stage and scaled to
 * fit, with Cursor's toolbar (device, width × height, rotate, fit). Responsive sizes resize from any
 * edge or corner; a device preset draws that device around the page and sends its user agent.
 */
export class BrowserDeviceMode extends Disposable {

	private readonly toolbar: HTMLElement;
	private readonly deviceButton: HTMLButtonElement;
	private readonly deviceLabel: HTMLElement;
	private readonly widthInput: HTMLInputElement;
	private readonly heightInput: HTMLInputElement;
	private readonly fitButton: HTMLButtonElement;
	private readonly fitLabel: HTMLElement;
	private readonly outline: HTMLElement;
	private readonly handles: HTMLElement[] = [];
	private frame: HTMLElement | undefined;
	private frameKey = '';
	private _active = false;
	private _size: IBrowserDeviceSize = MOBILE_SIZE;
	private _device: IBrowserDevice | undefined;
	private landscape = false;
	private fit: FitChoice = 'fit';
	private _scale = 1;
	private resizing: { scale: number } | undefined;
	private screenColor: string | undefined;
	private homeColor: string | undefined;

	constructor(
		private readonly stage: HTMLElement,
		private readonly host: IBrowserDeviceHost,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.outline = append(stage, $('.volt-browser-device-outline.hidden'));
		for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
			const handle = append(stage, $(`.volt-browser-device-handle.${edge}.hidden`));
			handle.dataset.edge = edge;
			this._register(addDisposableListener(handle, 'pointerdown', e => this.beginResize(e, edge)));
			this.handles.push(handle);
		}

		this.toolbar = append(stage, $('.volt-browser-devicebar.hidden'));
		this.deviceButton = append(this.toolbar, $('button.volt-browser-devicebar-button.device')) as HTMLButtonElement;
		this.deviceButton.type = 'button';
		this.deviceLabel = append(this.deviceButton, $('span.volt-browser-devicebar-label'));
		this.deviceButton.appendChild(renderIcon(Codicon.chevronDown));
		this._register(addDisposableListener(this.deviceButton, 'click', () => this.showDeviceMenu()));
		append(this.toolbar, $('span.volt-browser-devicebar-sep'));
		this.widthInput = this.dimensionInput(localize('voltBrowser.device.width', "Width"));
		append(this.toolbar, $('span.volt-browser-devicebar-times')).textContent = '×';
		this.heightInput = this.dimensionInput(localize('voltBrowser.device.height', "Height"));
		const rotate = append(this.toolbar, $('button.volt-browser-devicebar-button.icon')) as HTMLButtonElement;
		rotate.type = 'button';
		setAgentTooltip(rotate, localize('voltBrowser.device.rotate', "Rotate"));
		rotate.appendChild(rotateIcon(rotate.ownerDocument));
		this._register(addDisposableListener(rotate, 'click', () => this.rotate()));
		append(this.toolbar, $('span.volt-browser-devicebar-sep'));
		this.fitButton = append(this.toolbar, $('button.volt-browser-devicebar-button.fit')) as HTMLButtonElement;
		this.fitButton.type = 'button';
		this.fitLabel = append(this.fitButton, $('span.volt-browser-devicebar-label'));
		this.fitButton.appendChild(renderIcon(Codicon.chevronDown));
		this._register(addDisposableListener(this.fitButton, 'click', () => this.showFitMenu()));
	}

	get active(): boolean {
		return this._active;
	}

	/** The viewport size while the mode is on. */
	get size(): IBrowserDeviceSize | undefined {
		return this._active ? this.viewportSize() : undefined;
	}

	get scale(): number {
		return this._active ? this._scale : 1;
	}

	get device(): IBrowserDevice | undefined {
		return this._active ? this._device : undefined;
	}

	toggle(): void {
		if (this._active) {
			this.disable();
		} else {
			this.enable();
		}
	}

	/** Turns the mode on, at `size` or at the last size used (or a phone size). */
	enable(size?: IBrowserDeviceSize): void {
		if (size) {
			this._device = undefined;
			this.landscape = false;
			this._size = clampSize(size);
		} else if (!this._active) {
			this._size = lastSize ?? MOBILE_SIZE;
		}
		this._active = true;
		this.stage.classList.add('device-mode');
		this.toolbar.classList.remove('hidden');
		this.host.setUserAgent(deviceUserAgent(this._device));
		this.sync();
	}

	disable(): void {
		if (!this._active) {
			return;
		}
		this._active = false;
		this.stage.classList.remove('device-mode', 'device-framed');
		this.toolbar.classList.add('hidden');
		this.outline.classList.add('hidden');
		this.handles.forEach(handle => handle.classList.add('hidden'));
		this.frame?.remove();
		this.frame = undefined;
		this.frameKey = '';
		this._scale = 1;
		const page = this.host.page();
		if (page) {
			for (const property of ['width', 'height', 'left', 'top', 'transform']) {
				page.style.removeProperty(property);
			}
		}
		this.host.setUserAgent(undefined);
		this.host.onDidLayout();
	}

	/** The page's top and bottom colors, so a device's status bar and home bar blend in as they do on the phone. */
	setScreenColor(top: string | undefined, bottom?: string): void {
		this.screenColor = top;
		this.homeColor = bottom ?? top;
		this.applyScreenColor();
	}

	layout(): void {
		if (!this._active) {
			return;
		}
		const page = this.host.page();
		const stage = this.stage.getBoundingClientRect();
		if (stage.width <= 0 || stage.height <= 0) {
			return;
		}
		const viewport = this.viewportSize();
		const spec = this._device ? frameSpec(this._device) : undefined;
		const box = spec ? frameBox(spec, viewport.width, viewport.height, this.landscape) : { insets: { left: 0, top: 0, right: 0, bottom: 0 }, width: viewport.width, height: viewport.height };
		const overhang = spec?.overhang ?? 0;
		const availableWidth = Math.max(80, stage.width - STAGE_PAD * 2);
		const availableHeight = Math.max(80, stage.height - STAGE_PAD - this.toolbarZone(stage.height));
		const fitScale = Math.min(1, availableWidth / (box.width + overhang * 2), availableHeight / (box.height + (this.landscape ? overhang * 2 : overhang)));
		const scale = this.resizing?.scale ?? (this.fit === 'fit' ? fitScale : this.fit);
		this._scale = scale > 0 ? scale : 1;
		const outerWidth = box.width * this._scale;
		const outerHeight = box.height * this._scale;
		const left = Math.round((stage.width - outerWidth) / 2);
		const top = Math.round(STAGE_PAD + Math.max(0, (availableHeight - outerHeight - (spec ? overhang * this._scale : 0)) / 2));
		const pageLeft = left + box.insets.left * this._scale;
		const pageTop = top + box.insets.top * this._scale;
		if (page) {
			page.style.width = `${viewport.width}px`;
			page.style.height = `${viewport.height}px`;
			page.style.left = `${pageLeft}px`;
			page.style.top = `${pageTop}px`;
			page.style.transform = this._scale !== 1 ? `scale(${this._scale})` : '';
		}
		this.layoutFrame(spec, viewport, left, top);
		const rect = { left: pageLeft, top: pageTop, width: viewport.width * this._scale, height: viewport.height * this._scale };
		this.placeOutline(rect, !spec);
		this.syncToolbar(viewport);
		this.host.onDidLayout();
	}

	private layoutFrame(spec: IFrameSpec | undefined, viewport: IBrowserDeviceSize, left: number, top: number): void {
		this.stage.classList.toggle('device-framed', !!spec);
		const device = this._device;
		if (!spec || !device) {
			this.frame?.remove();
			this.frame = undefined;
			this.frameKey = '';
			return;
		}
		// The frame is drawn portrait; landscape turns it a quarter left around its top-left corner.
		const portrait = this.landscape ? { width: viewport.height, height: viewport.width } : viewport;
		const key = `${device.id}:${portrait.width}x${portrait.height}`;
		if (key !== this.frameKey || !this.frame) {
			this.frame?.remove();
			this.frame = renderDeviceFrame(device, spec, portrait.width, portrait.height);
			// Under the page: the page is the frame's screen.
			this.stage.insertBefore(this.frame, this.stage.firstChild);
			this.frameKey = key;
			this.applyScreenColor();
		}
		const frameWidth = portrait.width + spec.side * 2;
		this.frame.classList.toggle('landscape', this.landscape);
		this.frame.style.transform = this.landscape
			? `translate(${left}px, ${top}px) scale(${this._scale}) translate(0, ${frameWidth}px) rotate(-90deg)`
			: `translate(${left}px, ${top}px) scale(${this._scale})`;
	}

	private applyScreenColor(): void {
		if (!this.frame) {
			return;
		}
		const color = this.screenColor || '#ffffff';
		const home = this.homeColor || color;
		this.frame.style.setProperty('--volt-device-screen', color);
		this.frame.style.setProperty('--volt-device-ink', isDark(color) ? '#ffffff' : '#000000');
		this.frame.style.setProperty('--volt-device-home-screen', home);
		this.frame.style.setProperty('--volt-device-home-ink', isDark(home) ? '#ffffff' : '#000000');
	}

	private placeOutline(rect: { left: number; top: number; width: number; height: number }, resizable: boolean): void {
		this.outline.classList.toggle('hidden', !resizable);
		if (resizable) {
			this.outline.style.left = `${rect.left}px`;
			this.outline.style.top = `${rect.top}px`;
			this.outline.style.width = `${rect.width}px`;
			this.outline.style.height = `${rect.height}px`;
		}
		const right = rect.left + rect.width;
		const bottom = rect.top + rect.height;
		const middleX = rect.left + rect.width / 2;
		const middleY = rect.top + rect.height / 2;
		for (const handle of this.handles) {
			handle.classList.toggle('hidden', !resizable);
			if (!resizable) {
				continue;
			}
			const edge = handle.dataset.edge ?? '';
			const x = edge.includes('e') ? right : edge.includes('w') ? rect.left : middleX;
			const y = edge.includes('s') ? bottom : edge.includes('n') ? rect.top : middleY;
			handle.style.left = `${Math.round(x)}px`;
			handle.style.top = `${Math.round(y)}px`;
		}
	}

	private syncToolbar(viewport: IBrowserDeviceSize): void {
		this.deviceLabel.textContent = this._device?.label ?? localize('voltBrowser.device.responsive', "Responsive");
		const doc = this.stage.ownerDocument;
		if (doc.activeElement !== this.widthInput) {
			this.widthInput.value = String(viewport.width);
		}
		if (doc.activeElement !== this.heightInput) {
			this.heightInput.value = String(viewport.height);
		}
		this.fitLabel.textContent = this.fit === 'fit'
			? localize('voltBrowser.device.fit', "Fit")
			: `${Math.round(this.fit * 100)}%`;
	}

	private viewportSize(): IBrowserDeviceSize {
		const base = this._device ? { width: this._device.width, height: this._device.height } : this._size;
		return this.landscape ? { width: base.height, height: base.width } : base;
	}

	/** The toolbar's distance from the stage's bottom (it moves up over a composer dock), plus a gap. */
	private toolbarZone(stageHeight: number): number {
		const top = this.toolbar.offsetTop;
		return this.toolbar.offsetHeight > 0 && top > 0 ? Math.max(TOOLBAR_ZONE, stageHeight - top + 14) : TOOLBAR_ZONE;
	}

	private sync(): void {
		this.layout();
		getWindow(this.stage).requestAnimationFrame(() => this.layout());
	}

	private setResponsiveSize(size: IBrowserDeviceSize): void {
		const wasDevice = !!this._device;
		this._device = undefined;
		this.landscape = false;
		this._size = clampSize(size);
		lastSize = this._size;
		if (wasDevice) {
			this.host.setUserAgent(undefined);
		}
		this.layout();
	}

	private pickDevice(id: string): void {
		if (id === RESPONSIVE_ID) {
			const current = this.viewportSize();
			this._device = undefined;
			this.landscape = false;
			this._size = current;
		} else {
			const device = BROWSER_DEVICES.find(candidate => candidate.id === id);
			if (!device) {
				return;
			}
			this._device = device;
			this.landscape = false;
		}
		this.host.setUserAgent(deviceUserAgent(this._device));
		this.sync();
	}

	private rotate(): void {
		if (this._device) {
			this.landscape = !this.landscape;
		} else {
			this._size = { width: this._size.height, height: this._size.width };
			lastSize = this._size;
		}
		this.sync();
	}

	private dimensionInput(label: string): HTMLInputElement {
		const input = append(this.toolbar, $('input.volt-browser-devicebar-dimension')) as HTMLInputElement;
		input.type = 'text';
		input.inputMode = 'numeric';
		input.spellcheck = false;
		input.setAttribute('aria-label', label);
		const commit = () => {
			const width = parseInt(this.widthInput.value, 10);
			const height = parseInt(this.heightInput.value, 10);
			const current = this.viewportSize();
			if (!Number.isFinite(width) || !Number.isFinite(height)) {
				this.syncToolbar(current);
				return;
			}
			if (width !== current.width || height !== current.height) {
				this.setResponsiveSize({ width, height });
			}
		};
		this._register(addDisposableListener(input, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
				input.select();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.syncToolbar(this.viewportSize());
				input.blur();
			} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				e.preventDefault();
				const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
				input.value = String(Math.max(MIN_SIZE, (parseInt(input.value, 10) || 0) + step));
				commit();
			}
		}));
		this._register(addDisposableListener(input, 'blur', commit));
		this._register(addDisposableListener(input, 'focus', () => input.select()));
		return input;
	}

	private showDeviceMenu(): void {
		const current = this._device?.id ?? RESPONSIVE_ID;
		const item = (device: IBrowserDevice): IVoltMenuItem<string> => ({
			id: device.id,
			label: device.label,
			keybinding: `${device.width} × ${device.height}`,
			checked: device.id === current,
			data: device.id,
		});
		const sections: IVoltMenuSection<string>[] = [
			{ id: 'responsive', items: [{ id: RESPONSIVE_ID, label: localize('voltBrowser.device.responsive', "Responsive"), checked: current === RESPONSIVE_ID, data: RESPONSIVE_ID }] },
			{ id: 'current', items: CURRENT_DEVICES.map(item) },
			{ id: 'standard', title: localize('voltBrowser.device.standard', "Standard"), items: STANDARD_DEVICES.map(item) },
		];
		showVoltMenu(this.contextViewService, {
			anchor: this.deviceButton,
			position: 'above',
			gap: 6,
			width: 300,
			sections,
			className: 'volt-browser-device-menu',
			ariaLabel: localize('voltBrowser.device.menu', "Devices"),
			onPick: picked => this.pickDevice(picked.data),
		});
	}

	private showFitMenu(): void {
		const choices: FitChoice[] = ['fit', 0.5, 0.75, 1, 1.25, 1.5];
		showVoltMenu(this.contextViewService, {
			anchor: this.fitButton,
			position: 'above',
			align: 'right',
			gap: 6,
			width: 140,
			sections: [{
				id: 'fit',
				items: choices.map(choice => ({
					id: String(choice),
					label: choice === 'fit' ? localize('voltBrowser.device.fit', "Fit") : `${Math.round(choice * 100)}%`,
					checked: choice === this.fit,
					data: choice,
				})),
			}],
			ariaLabel: localize('voltBrowser.device.zoom', "Viewport scale"),
			onPick: picked => {
				this.fit = picked.data;
				this.layout();
			},
		});
	}

	/** Dragging an edge grows the viewport on both sides (it stays centered), so the edge follows the pointer. */
	private beginResize(event: PointerEvent, edge: string): void {
		if (!this._active || this._device || event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		const start = this.viewportSize();
		const startX = event.clientX;
		const startY = event.clientY;
		this.resizing = { scale: this._scale };
		const container = this.stage.closest('.volt-browser-editor');
		container?.classList.add('device-resizing');
		const store = new DisposableStore();
		const move = (e: PointerEvent) => {
			const scale = this.resizing?.scale || 1;
			const dx = (e.clientX - startX) / scale;
			const dy = (e.clientY - startY) / scale;
			let width = start.width;
			let height = start.height;
			if (edge.includes('e')) {
				width = start.width + dx * 2;
			} else if (edge.includes('w')) {
				width = start.width - dx * 2;
			}
			if (edge.includes('s')) {
				height = start.height + dy * 2;
			} else if (edge.includes('n')) {
				height = start.height - dy * 2;
			}
			this._size = clampSize({ width: Math.round(width), height: Math.round(height) });
			this.layout();
		};
		const end = () => {
			store.dispose();
			this.resizing = undefined;
			container?.classList.remove('device-resizing');
			lastSize = this._size;
			this.layout();
		};
		store.add(addDisposableListener(handle, 'pointermove', move));
		store.add(addDisposableListener(handle, 'pointerup', end));
		store.add(addDisposableListener(handle, 'pointercancel', end));
		store.add(addDisposableListener(handle, 'lostpointercapture', end));
	}

	override dispose(): void {
		this.frame?.remove();
		this.toolbar.remove();
		this.outline.remove();
		this.handles.forEach(handle => handle.remove());
		super.dispose();
	}
}

function clampSize(size: IBrowserDeviceSize): IBrowserDeviceSize {
	return {
		width: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size.width))),
		height: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size.height))),
	};
}

/** Whether light text reads better on `color` (any CSS color the page reported). */
function isDark(color: string): boolean {
	const match = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
	let rgb: number[] | undefined;
	if (match) {
		if (match[4] !== undefined && parseFloat(match[4]) < 0.2) {
			return false;
		}
		rgb = [match[1], match[2], match[3]].map(Number);
	} else {
		const hex = color.trim().replace(/^#/, '');
		if (/^[0-9a-f]{3}$/i.test(hex)) {
			rgb = hex.split('').map(part => parseInt(part + part, 16));
		} else if (/^[0-9a-f]{6}/i.test(hex)) {
			rgb = [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16));
		}
	}
	if (!rgb) {
		return false;
	}
	const [r, g, b] = rgb.map(channel => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}

function rotateIcon(doc: Document): SVGSVGElement {
	return svg(doc, 16, 16, root => {
		root.setAttribute('viewBox', '0 0 24 24');
		root.setAttribute('fill', 'none');
		root.setAttribute('stroke', 'currentColor');
		root.setAttribute('stroke-width', '1.6');
		root.setAttribute('stroke-linecap', 'round');
		root.setAttribute('stroke-linejoin', 'round');
		shape(root, 'path', { d: 'M3 2v6h6' });
		shape(root, 'path', { d: 'M21 12A9 9 0 0 0 6 5.3L3 8' });
		shape(root, 'path', { d: 'M21 22v-6h-6' });
		shape(root, 'path', { d: 'M3 12a9 9 0 0 0 15 6.7l3-2.7' });
	});
}
