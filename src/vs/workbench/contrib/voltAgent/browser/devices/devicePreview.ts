/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltDevices.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { isIosInputToolMissing, IOS_INPUT_TOOL_INSTALL_COMMAND } from '../../../../../platform/voltDevices/common/deviceCommands.js';
import { IVoltDevice, IVoltDevicePostures, VoltDeviceAppearance, VoltDeviceButton, VoltDevicePosture, VoltDeviceTextSize } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { RecordingBadge } from '../capture/recordingBadge.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IBrowserDevice } from '../preview/browserDevices.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IAgentDevicesService, IDeviceShot, IDeviceTarget } from './agentDevicesService.js';
import { DeviceLiveStream, DuoCommand, isIphoneDuo, loadDeviceViewer, PhoneViewport } from './deviceLiveStream.js';

/** The preview refreshes this often while on screen and nothing happens (it streams while someone interacts). */
const IDLE_POLL_MS = 500;
/** After a tap, a swipe or an agent action the preview streams: captures run back to back, up to three overlapping (an adb capture takes ~300 ms; three in flight give ~5 frames a second). */
const ACTIVE_MS = 5000;
const MAX_IN_FLIGHT = 3;
/** Captures slower than this run one at a time: an overloaded emulator must not get more work. */
const SLOW_CAPTURE_MS = 1000;
/** How often the device list is read again while no device is running, or while one streams live. */
const LIST_POLL_MS = 3000;
const PREVIEW_MAX_SIDE = 1400;
/** A press that moves less than this is a tap; more is a swipe. */
const TAP_SLOP = 6;
/** Room around the flat screen, and the controls rail's width on the right. */
const STAGE_PAD = 16;
const RAIL_INSET = 60;
/** The floating mini device's longest side. */
const FLOAT_MAX_SIDE = 420;
const FLOAT_MAX_WIDTH = 320;
const VIEW_STORAGE_KEY = 'volt.devices.view';

/** The iPhone Duo's folds, as T3 Code offers them, and its stands. */
const DUO_FOLDS = [
	{ id: 'closed', angle: 0 },
	{ id: 'half', angle: 90 },
	{ id: 'open', angle: 180 },
] as const;
const DUO_STANDS = ['laptop', 'tent'] as const;
type DuoGlyph = 'closed' | 'book' | 'open' | 'laptop' | 'tent';

//#region Icons

type SvgNode = readonly [tag: string, attributes: Readonly<Record<string, string>>];
const p = (d: string): SvgNode => ['path', { d }];

/** Lucide's outline icons (ISC), the set T3 Code's device rail uses. */
const ICONS = {
	home: [p('M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8'), p('M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')],
	back: [p('m15 18-6-6 6-6')],
	recents: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }]],
	rotate: [p('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), p('M3 3v5h5')],
	moon: [p('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z')],
	sun: [['circle', { cx: '12', cy: '12', r: '4' }], p('M12 2v2'), p('M12 20v2'), p('m4.93 4.93 1.41 1.41'), p('m17.66 17.66 1.41 1.41'), p('M2 12h2'), p('M20 12h2'), p('m6.34 17.66-1.41 1.41'), p('m19.07 4.93-1.41 1.41')],
	type: [p('M4 7V4h16v3'), p('M9 20h6'), p('M12 4v16')],
	tools: [p('M21 4h-7'), p('M10 4H3'), p('M21 12h-9'), p('M8 12H3'), p('M21 20h-5'), p('M12 20H3'), p('M14 2v4'), p('M8 10v4'), p('M16 18v4')],
	camera: [p('M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z'), ['circle', { cx: '12', cy: '13', r: '3' }]],
	more: [['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }], ['circle', { cx: '5', cy: '12', r: '1' }]],
	box: [p('M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'), p('m3.3 7 8.7 5 8.7-5'), p('M12 22V12')],
	phone: [['rect', { x: '5', y: '2', width: '14', height: '20', rx: '2' }], p('M12 18h.01')],
	keyboard: [['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }], p('M6 8h.01'), p('M10 8h.01'), p('M14 8h.01'), p('M18 8h.01'), p('M8 12h.01'), p('M12 12h.01'), p('M16 12h.01'), p('M7 16h10')],
	restore: [p('M8 3H5a2 2 0 0 0-2 2v3'), p('M21 8V5a2 2 0 0 0-2-2h-3'), p('M3 16v3a2 2 0 0 0 2 2h3'), p('M16 21h3a2 2 0 0 0 2-2v-3')],
	expand: [p('M15 3h6v6'), p('M9 21H3v-6'), p('M21 3l-7 7'), p('M3 21l7-7')],
	close: [p('M18 6 6 18'), p('m6 6 12 12')],
} satisfies Record<string, readonly SvgNode[]>;
type IconName = keyof typeof ICONS;

/** T3 Code's iPhone Duo glyphs (MIT): the fold shapes on a 24 grid, the stands on 22×16. */
const DUO_GLYPHS: Record<DuoGlyph, { readonly viewBox: string; readonly strokeWidth: string; readonly nodes: readonly SvgNode[] }> = {
	closed: { viewBox: '0 0 24 24', strokeWidth: '1.35', nodes: [['rect', { x: '5.8', y: '3', width: '12.4', height: '18', rx: '2.2' }], ['circle', { cx: '15.4', cy: '5.7', r: '.6', fill: 'currentColor', stroke: 'none' }], p('M10.6 18.2h2.8')] },
	book: { viewBox: '0 0 24 24', strokeWidth: '1.35', nodes: [p('M4.6 18.1V5.9Q4.6 4.9 5.9 4.9L12 7.5L18.1 4.9Q19.4 4.9 19.4 5.9V18.1Q19.4 19.1 18.1 19.1L12 16.5L5.9 19.1Q4.6 19.1 4.6 18.1Z')] },
	open: { viewBox: '0 0 24 24', strokeWidth: '1.35', nodes: [['rect', { x: '2.5', y: '5', width: '19', height: '14', rx: '2.4' }], p('M10.5 16.3h3')] },
	laptop: { viewBox: '0 0 22 16', strokeWidth: '1.25', nodes: [p('M2.7351 12.9857 L15.8128 11.4159 L14.4114 3.3787 C14.1943 2.134 13.1275 1.2319 12.0283 1.3639 L2.9308 2.4559 C1.8317 2.5879 1.1167 3.7038 1.3337 4.9485 L2.7351 12.9857 Z M2.7351 12.9857 L15.8128 11.4159 L19.9103 12.8914 C20.5449 13.1199 20.1683 13.4121 19.0692 13.5441 L9.9717 14.6361 C8.8725 14.7681 7.4672 14.6898 6.8326 14.4612 L2.7351 12.9857 Z')] },
	tent: { viewBox: '0 0 22 16', strokeWidth: '1.25', nodes: [p('M3.2522 2.7267 L18.7478 1.4816 L16.696 9.7017 C16.3782 10.9748 15.0649 12.0915 13.7626 12.1962 L2.983 13.0623 C1.6807 13.167 0.8826 12.2199 1.2004 10.9468 L3.2522 2.7267 Z M3.2522 2.7267 L18.7478 1.4816 L20.7996 10.6909 C21.1174 12.1172 20.3193 13.3581 19.017 13.4628 L8.2374 14.3289 C6.9351 14.4336 5.6218 13.3623 5.304 11.936 L3.2522 2.7267 Z')] },
};

function svg(doc: Document, viewBox: string, strokeWidth: string, nodes: readonly SvgNode[], className: string): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const root = doc.createElementNS(ns, 'svg');
	for (const [name, value] of Object.entries({ viewBox, fill: 'none', stroke: 'currentColor', 'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: className })) {
		root.setAttribute(name, value);
	}
	for (const [tag, attributes] of nodes) {
		const node = doc.createElementNS(ns, tag);
		for (const [name, value] of Object.entries(attributes)) {
			node.setAttribute(name, value);
		}
		root.appendChild(node);
	}
	return root;
}

export function deviceIcon(doc: Document, name: IconName): SVGElement {
	return svg(doc, '0 0 24 24', '1.75', ICONS[name], 'volt-device-icon');
}

function duoGlyph(doc: Document, glyph: DuoGlyph, rotated = false): SVGElement {
	const spec = DUO_GLYPHS[glyph];
	return svg(doc, spec.viewBox, spec.strokeWidth, spec.nodes, `volt-device-glyph${rotated ? ' rotated' : ''}`);
}

//#endregion

/** The CSS frame a device would get in the browser's device toolbar: its shape from the model and platform. */
export function frameForDevice(device: IVoltDevice, width: number, height: number): IBrowserDevice {
	const base = { id: device.id, label: device.name, width, height };
	if (device.platform === 'ios') {
		const model = device.model ?? device.name;
		if (/iPad/i.test(model)) {
			return { ...base, shape: 'tablet', os: 'ios', finish: '#3a3a3c' };
		}
		if (/iPhone-SE|iPhone SE/i.test(model)) {
			return { ...base, shape: 'home', os: 'ios', finish: '#1f1f21' };
		}
		if (/iPhone[- ](X|XS|XR|11|12|13|14)(?![0-9])(?![- ]Pro)/i.test(model) || /iPhone[- ](X|XS|XR|11|12|13)[- ]Pro/i.test(model)) {
			return { ...base, shape: 'notch', os: 'ios', finish: '#2c2c2e' };
		}
		return { ...base, shape: 'island', os: 'ios', finish: '#3a3f47' };
	}
	const wide = width / Math.max(1, height) > 0.7;
	return { ...base, shape: 'punch', os: 'android', radius: wide ? 26 : 40, finish: '#2f3236' };
}

/** What the preview shows for one device: its bare screen, or the device in 3D. */
type DeviceView = 'flat' | '3d';

/**
 * A simulator or emulator on screen: pick a device (this computer or an SSH host), boot it, see
 * its screen live, tap, swipe and type on it, press its buttons, fold it, and turn it in 3D, with
 * T3 Code's controls rail on the right. Agents drive the same devices through the device_* tools;
 * their actions show up here. While the right panel is closed it can float over the chat as a
 * mini device (`setFloat`).
 */
export class DevicePreview extends Disposable {

	readonly element: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly deviceButton: HTMLButtonElement;
	private readonly deviceDot: HTMLElement;
	private readonly deviceName: HTMLElement;
	private readonly deviceDetail: HTMLElement;
	private readonly powerButton: HTMLButtonElement;
	private readonly stage: HTMLElement;
	/** The bare screen (flat view): the live canvas or the last screenshot. */
	private readonly flat: HTMLElement;
	/** Holds the 3D device (a WebGL canvas). */
	private readonly threeDHost: HTMLElement;
	private readonly rail: HTMLElement;
	private readonly message: HTMLElement;
	private readonly agentPill: HTMLElement;
	/** Screenshots are drawn here: the flat view shows it, and the 3D phone reads it as its screen. */
	private readonly shotCanvas: HTMLCanvasElement;
	private postures: IVoltDevicePostures = { supported: [] };
	/** The device `postures` were read for, so a list refresh does not read them again. */
	private posturesKey: string | undefined;
	private posturesTimer: number | undefined;
	private appearance: VoltDeviceAppearance | undefined;
	private appearanceKey: string | undefined;

	private target: IDeviceTarget | undefined;
	private shot: IDeviceShot | undefined;
	/** The element in `flat` showing the screen: `live.canvas` once it streams, else `shotCanvas`. */
	private screen: HTMLCanvasElement | undefined;
	/** The live stream of the target (simulators and emulators on this computer), replacing screenshot polling once it plays. */
	private live: DeviceLiveStream | undefined;
	private liveKey: string | undefined;
	private readonly liveStore = this._register(new MutableDisposable<DisposableStore>());
	/** Devices whose stream failed, with why: they fall back to screenshots until picked again. */
	private readonly liveFailed = new Map<string, string>();
	/** Booting from this preview: its stream starts with the boot, before the device reports booted. */
	private bootingKey: string | undefined;
	/** The 3D view: the Duo (owned by the stream) or a phone viewport (owned here). */
	private readonly phoneStore = this._register(new MutableDisposable<DisposableStore>());
	private phone: PhoneViewport | undefined;
	private phoneKey: string | undefined;
	private threeDLoading: string | undefined;
	/** Devices the 3D view gave up on (no WebGL, model failed), with why. */
	private readonly threeDFailed = new Map<string, string>();
	private keyboardAttached = false;
	private views: Record<string, DeviceView>;
	private floatHost: HTMLElement | undefined;
	private visible = false;
	private inFlight = 0;
	private captureSeq = 0;
	private appliedSeq = 0;
	private captureMs = 300;
	private activeUntil = 0;
	private pollTimer: number | undefined;
	private busy: string | undefined;
	private typed = '';
	private typeTimer: number | undefined;
	private agentTimer: number | undefined;
	/** Shown once per session: the AXe notice with its Install and Copy actions. */
	private axeOffered = false;

	private readonly _onDidChangeTitle = this._register(new Emitter<string>());
	readonly onDidChangeTitle = this._onDidChangeTitle.event;
	private readonly _onDidRequestClose = this._register(new Emitter<void>());
	/** Close Device Panel in the More menu: the tab closes. */
	readonly onDidRequestClose = this._onDidRequestClose.event;
	private readonly _onDidRequestFloat = this._register(new Emitter<boolean>());
	/** True: float over the chat (close the right panel). False: back into the panel. */
	readonly onDidRequestFloat = this._onDidRequestFloat.event;
	private readonly _onDidRequestReveal = this._register(new Emitter<void>());
	/** Another tab's picker chose this tab's device: bring this tab to the front. */
	readonly onDidRequestReveal = this._onDidRequestReveal.event;

	constructor(
		parent: HTMLElement,
		private initialKey: string | undefined,
		@IAgentDevicesService private readonly devices: IAgentDevicesService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.views = this.readViews();
		this.element = append(parent, $('.volt-device-preview'));
		this.toolbar = append(this.element, $('.volt-device-toolbar'));

		this.deviceButton = append(this.toolbar, $('button.volt-device-picker')) as HTMLButtonElement;
		this.deviceButton.type = 'button';
		this.deviceDot = append(this.deviceButton, $('span.volt-device-state-dot'));
		const names = append(this.deviceButton, $('span.volt-device-picker-text'));
		this.deviceName = append(names, $('span.volt-device-picker-name'));
		this.deviceDetail = append(names, $('span.volt-device-picker-detail'));
		this.deviceButton.appendChild(renderIcon(Codicon.chevronDown));
		this._register(addDisposableListener(this.deviceButton, 'click', () => void this.showDeviceMenu()));

		this.powerButton = append(this.toolbar, $('button.volt-device-power')) as HTMLButtonElement;
		this.powerButton.type = 'button';
		this._register(addDisposableListener(this.powerButton, 'click', () => void this.togglePower()));

		this.stage = append(this.element, $('.volt-device-stage'));
		this.stage.tabIndex = 0;
		this.stage.setAttribute('role', 'application');
		this.stage.setAttribute('aria-label', localize('voltDevices.stage', "Device screen. Click to tap, drag to swipe, type to send keys."));
		this.flat = append(this.stage, $('.volt-device-flat.hidden'));
		this.threeDHost = append(this.stage, $('.volt-device-3d.hidden'));
		this.rail = append(this.stage, $('.volt-device-rail'));
		this.rail.setAttribute('role', 'toolbar');
		this.rail.setAttribute('aria-label', localize('voltDevices.controls', "Device controls"));
		this.message = append(this.stage, $('.volt-device-message.hidden'));
		this.agentPill = append(this.stage, $('.volt-device-agent-pill.hidden'));
		this.agentPill.appendChild(renderIcon(Codicon.sparkle));
		append(this.agentPill, $('span')).textContent = localize('voltDevices.agentActing', "Agent is using this device");
		this._register(instantiationService.createInstance(RecordingBadge, this.stage));
		this.shotCanvas = this.element.ownerDocument.createElement('canvas');
		this.shotCanvas.className = 'volt-device-screen';

		this._register(addDisposableListener(this.flat, 'pointerdown', e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.stage, 'pointerdown', e => {
			if (e.target === this.stage) {
				this.stage.focus();
			}
		}));
		this._register(addDisposableListener(this.stage, 'keydown', e => this.onKeyDown(e)));
		this._register(this.devices.onDidChangeDevices(() => this.syncTarget()));
		this._register(this.devices.onDidAct(activity => {
			if (this.target && activity.key === this.devices.keyOf(this.target)) {
				if (activity.by === 'agent') {
					this.flashAgent();
				}
				this.stream();
				this.refreshSoon(60);
			}
		}));
		this._register({
			dispose: () => {
				const win = getWindow(this.element);
				win.clearTimeout(this.pollTimer);
				win.clearTimeout(this.posturesTimer);
				win.clearTimeout(this.typeTimer);
				win.clearTimeout(this.agentTimer);
				this.setFloat(undefined);
			}
		});
		// The device hub starts now, so the first stream attaches without waiting for it.
		void this.devices.prewarmStream();
		this.renderToolbar();
		void this.devices.list().then(() => this.syncTarget());
	}

	get title(): string {
		return this.target?.device.name ?? localize('voltDevices.title', "Devices");
	}

	get deviceKey(): string | undefined {
		return this.target ? this.devices.keyOf(this.target) : this.initialKey;
	}

	/** Showing as the mini device over the chat. */
	get floating(): boolean {
		return !!this.floatHost;
	}

	/** Whether there is a device worth floating: one is chosen and running. */
	get floatable(): boolean {
		const state = this.target?.device.state;
		return state === 'booted' || state === 'booting' || !!this.bootingKey;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.syncLive();
		this.sync3D();
		if (visible) {
			this.refreshSoon(0);
		}
	}

	focus(): void {
		this.stage.focus();
	}

	//#region Device selection

	/** Picks up the device again after a list refresh (state changes), or the first booted one. */
	private syncTarget(): void {
		const key = this.target ? this.devices.keyOf(this.target) : this.initialKey;
		const found = key ? this.devices.find(key) : undefined;
		const fallback = !found && !this.target ? this.firstBooted() : undefined;
		const next = found ?? fallback ?? this.target;
		this.target = next;
		if (next && next.device.state === 'booted' && this.posturesKey !== this.devices.keyOf(next)) {
			void this.loadPostures();
		} else if (next && next.device.state !== 'booted') {
			this.posturesKey = undefined;
		}
		if (next && next.device.state === 'booted' && this.appearanceKey !== this.devices.keyOf(next)) {
			void this.loadAppearance();
		}
		this.syncLive();
		this.renderToolbar();
		this.sync3D();
		this.refreshSoon(0);
	}

	/** Another device tab that shows this device. */
	private shownElsewhere(key: string): DevicePreview | undefined {
		for (const preview of devicePreviews.values()) {
			if (preview !== this && preview.target && this.devices.keyOf(preview.target) === key) {
				return preview;
			}
		}
		return undefined;
	}

	/** The first booted device no other tab shows yet. */
	private firstBooted(): IDeviceTarget | undefined {
		for (const entry of this.devices.cached()) {
			const device = entry.devices.find(candidate => candidate.state === 'booted' && !this.shownElsewhere(this.devices.keyOf({ host: entry.host, device: candidate })));
			if (device) {
				return { host: entry.host, device };
			}
		}
		return undefined;
	}

	private select(target: IDeviceTarget): void {
		this.target = target;
		this.initialKey = this.devices.keyOf(target);
		this.shot = undefined;
		this.postures = { supported: [] };
		this.posturesKey = undefined;
		this.appearance = undefined;
		this.appearanceKey = undefined;
		this.keyboardAttached = false;
		this.liveFailed.delete(this.devices.keyOf(target));
		this.threeDFailed.delete(this.devices.keyOf(target));
		this.stopLive();
		this.unmount3D();
		this.setScreen(undefined);
		this.syncLive();
		this.renderToolbar();
		this._onDidChangeTitle.fire(this.title);
		if (target.device.state === 'booted') {
			void this.loadPostures();
			void this.loadAppearance();
		}
		this.refreshSoon(0);
	}

	private async showDeviceMenu(): Promise<void> {
		const lists = await this.devices.list(true);
		const current = this.target ? this.devices.keyOf(this.target) : undefined;
		const several = lists.length > 1;
		// iOS and Android each get their own section: a divider and an "Android" header between them.
		const sections: IVoltMenuSection<IDeviceTarget | undefined>[] = lists.flatMap(entry => {
			const host = entry.host.ssh ? localize('voltDevices.remoteHost', "{0} (SSH)", entry.host.label) : entry.host.label;
			const item = (device: IVoltDevice): IVoltMenuItem<IDeviceTarget | undefined> => ({
				id: `${entry.host.id}/${device.platform}/${device.id}`,
				label: device.name,
				description: [device.runtime, device.foldable ? localize('voltDevices.foldable', "Foldable") : undefined].filter(Boolean).join(' · ') || undefined,
				icon: device.platform === 'ios' ? Codicon.deviceMobile : Codicon.vm,
				keybinding: device.state === 'booted' ? localize('voltDevices.booted', "Booted") : undefined,
				checked: `${entry.host.id}/${device.platform}/${device.id}` === current,
				keywords: `${device.platform} ${device.runtime ?? ''} ${entry.host.label}`,
				data: { host: entry.host, device },
			});
			const ios = entry.devices.filter(device => device.platform === 'ios').map(item);
			const android = entry.devices.filter(device => device.platform === 'android').map(item);
			if (!ios.length && !android.length) {
				return [{ id: entry.host.id, title: host, items: [], emptyMessage: entry.problems.join(' · ') || localize('voltDevices.none', "No simulators or emulators") }];
			}
			const iosTitle = localize('voltDevices.iosGroup', "iOS");
			const androidTitle = localize('voltDevices.androidGroup', "Android");
			return [
				...(ios.length ? [{ id: `${entry.host.id}/ios`, title: several ? `${iosTitle} · ${host}` : iosTitle, items: ios }] : []),
				...(android.length ? [{ id: `${entry.host.id}/android`, title: several ? `${androidTitle} · ${host}` : androidTitle, items: android }] : []),
			];
		});
		this.deviceButton.classList.add('open');
		showVoltMenu(this.contextViewService, {
			anchor: this.deviceButton,
			position: 'below',
			gap: 4,
			width: 340,
			search: { placeholder: localize('voltDevices.search', "Search devices") },
			sections,
			footer: [{ id: 'hosts', label: localize('voltDevices.addHost', "Add Remote Machine…"), icon: Codicon.remote, data: undefined }],
			className: 'volt-device-menu',
			ariaLabel: localize('voltDevices.menu', "Devices"),
			onPick: picked => {
				if (picked.data) {
					// One tab per device: a device another tab shows is revealed there.
					const other = this.shownElsewhere(this.devices.keyOf(picked.data));
					if (other) {
						other._onDidRequestReveal.fire();
					} else {
						this.select(picked.data);
					}
				} else {
					void this.commandService.executeCommand('workbench.action.openSettings', 'volt.devices.remoteHosts');
				}
			},
			onHide: () => this.deviceButton.classList.remove('open'),
		});
	}

	//#endregion

	//#region Toolbar and rail

	private renderToolbar(): void {
		const target = this.target;
		const device = target?.device;
		this.deviceName.textContent = device?.name ?? localize('voltDevices.choose', "Choose a Device");
		this.deviceDetail.textContent = device ? [device.runtime, target.host.ssh ? target.host.label : undefined].filter(Boolean).join(' · ') : '';
		const booting = !!this.busy || device?.state === 'booting' || (!!this.bootingKey && this.bootingKey === this.deviceKey);
		this.deviceDot.className = `volt-device-state-dot state-${booting ? 'booting' : device?.state ?? 'none'}`;
		const booted = device?.state === 'booted';
		this.powerButton.classList.toggle('hidden', !device);
		this.powerButton.disabled = !!this.busy;
		this.powerButton.textContent = this.busy ?? (booted ? localize('voltDevices.shutdown', "Shut Down") : localize('voltDevices.boot', "Boot"));
		this.renderRail();
		this._onDidChangeTitle.fire(this.title);
	}

	private railButton(group: HTMLElement, icon: IconName | (() => SVGElement), label: string, run: (button: HTMLButtonElement) => void, options: { readonly disabled?: boolean; readonly pressed?: boolean; readonly description?: string } = {}): HTMLButtonElement {
		const button = append(group, $('button.volt-device-rail-button')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(typeof icon === 'string' ? deviceIcon(this.element.ownerDocument, icon) : icon());
		button.setAttribute('aria-label', label);
		button.disabled = !!options.disabled;
		if (options.pressed !== undefined) {
			button.setAttribute('aria-pressed', String(options.pressed));
			button.classList.toggle('pressed', options.pressed);
		}
		setAgentTooltip(button, options.disabled && options.description ? options.description : label, undefined, undefined, 'start');
		button.addEventListener('click', () => run(button));
		return button;
	}

	/** T3 Code's rail: hardware, settings, screenshot and menus, then the view (3D, flat), then folds. */
	private renderRail(): void {
		clearNode(this.rail);
		const target = this.target;
		const device = target?.device;
		if (!device || this.floatHost) {
			return;
		}
		const booted = device.state === 'booted';
		const live = this.live;
		const streaming = !!live?.streaming;
		const canInput = booted || streaming;
		const android = device.platform === 'android';
		const group = append(this.rail, $('.volt-device-rail-group'));
		const divider = () => append(group, $('.volt-device-rail-divider'));

		this.railButton(group, 'home', localize('voltDevices.home', "Home"), () => void this.press('home'), { disabled: !canInput });
		if (android) {
			this.railButton(group, 'back', localize('voltDevices.back', "Back"), () => void this.press('back'), { disabled: !canInput });
			this.railButton(group, 'recents', localize('voltDevices.recents', "Recents"), () => void this.press('appSwitch'), { disabled: !canInput });
		}
		if (live?.inputConnected) {
			this.railButton(group, 'rotate', localize('voltDevices.rotate', "Rotate Device"), () => live.rotate(), { disabled: this.keyboardAttached });
		}

		divider();
		const dark = this.appearance === 'dark';
		const next: VoltDeviceAppearance = dark ? 'light' : 'dark';
		this.railButton(group, dark ? 'sun' : 'moon', next === 'dark' ? localize('voltDevices.toDark', "Switch Device to Dark Mode") : localize('voltDevices.toLight', "Switch Device to Light Mode"), () => void this.setAppearance(next), { disabled: !booted });
		this.railButton(group, 'type', localize('voltDevices.textSize', "Device Text Size"), button => this.showTextSizeMenu(button), { disabled: !booted });
		this.railButton(group, 'tools', localize('voltDevices.tools', "Device Tools"), button => this.showToolsMenu(button), { disabled: !booted });
		this.railButton(group, 'camera', localize('voltDevices.copyShot', "Copy Screenshot"), () => void this.copyScreenshot(), { disabled: !booted });
		this.railButton(group, 'more', localize('voltDevices.more', "More Device Actions"), button => this.showMoreMenu(button));

		divider();
		const view = this.viewOf();
		const unavailable = this.threeDUnavailable();
		// After a failure the button stays usable: pressing it tries the 3D view again.
		this.railButton(group, 'box', localize('voltDevices.threeD', "3D View"), () => this.retry3D(), { pressed: view === '3d' && !unavailable, disabled: !canInput, description: unavailable ? localize('voltDevices.threeDRetry', "{0} Click to try again.", unavailable) : undefined });
		this.railButton(group, 'phone', localize('voltDevices.flat', "Flat View"), () => this.setView('flat'), { pressed: view === 'flat', disabled: !canInput });
		if (view === '3d' && this.phone?.hasKeyboard) {
			this.railButton(group, 'keyboard', this.keyboardAttached ? localize('voltDevices.detachKeyboard', "Detach Magic Keyboard") : localize('voltDevices.attachKeyboard', "Attach Magic Keyboard"), () => this.toggleKeyboard(), { pressed: this.keyboardAttached });
		}
		if (view === '3d') {
			this.railButton(group, 'restore', localize('voltDevices.resetView', "Restore 3D View"), () => this.resetView());
		}
		this.renderFolds();
	}

	/** The iPhone Duo's fold and stand glyphs, or an Android foldable's, below the rail. */
	private renderFolds(): void {
		const doc = this.element.ownerDocument;
		const live = this.live;
		const screen = live?.screen;
		const device = this.target?.device;
		if (!device) {
			return;
		}
		if (live && screen?.supportsHingeAngle && isIphoneDuo(device.name)) {
			const fold = live.foldState();
			if (!fold) {
				return;
			}
			const enabled = live.inputConnected;
			const pending = live.duoControl.pending && (fold.stand || live.duoControl.requested?.control === 'pose');
			const folds = append(this.rail, $('.volt-device-rail-group.folds'));
			folds.setAttribute('aria-label', localize('voltDevices.foldShape', "Fold shape"));
			for (const { id, angle } of DUO_FOLDS) {
				const label = id === 'closed' ? localize('voltDevices.duoClosed', "Closed") : id === 'open' ? localize('voltDevices.duoOpen', "Open") : fold.phoneVertical ? localize('voltDevices.duoBook', "Book") : localize('voltDevices.duoLaptop', "Laptop");
				this.railButton(folds, () => duoGlyph(doc, id === 'half' ? 'book' : id, !fold.phoneVertical), label, () => {
					const commands: DuoCommand[] = [];
					if (fold.stand) {
						const hold = live.holdOrientation(fold.phoneVertical);
						if (hold) {
							commands.push({ control: 'orientation', value: hold });
						}
					}
					commands.push({ control: 'angle', value: angle });
					commands.forEach(command => live.controlDuo(command));
				}, { pressed: !fold.stand && fold.fold === id, disabled: !enabled || pending });
			}
			const stands = append(this.rail, $('.volt-device-rail-group.folds'));
			stands.setAttribute('aria-label', localize('voltDevices.stance', "Device stance"));
			for (const id of DUO_STANDS) {
				const tentRefused = id === 'tent' && !screen.supportsPhysicalOrientation;
				this.railButton(stands, () => duoGlyph(doc, id), id === 'laptop' ? localize('voltDevices.laptopStand', "Laptop Stand") : localize('voltDevices.tentStand', "Tent Stand"), () => live.controlDuo({ control: 'pose', value: id }), {
					pressed: screen.hingePose === id,
					disabled: !enabled || tentRefused,
					description: tentRefused ? localize('voltDevices.tentRefused', "This simulator cannot stand as a tent.") : undefined,
				});
			}
			if (live.duoControl.error) {
				const error = append(this.rail, $('span.volt-device-rail-error'));
				error.textContent = '!';
				error.setAttribute('role', 'alert');
				setAgentTooltip(error, live.duoControl.error, undefined, undefined, 'start');
			}
			return;
		}
		const supported = device.state === 'booted' ? this.postures.supported : [];
		if (device.foldable && supported.length > 1) {
			const current = this.postures.current ?? supported[supported.length - 1];
			const folds = append(this.rail, $('.volt-device-rail-group.folds'));
			folds.setAttribute('aria-label', localize('voltDevices.androidFold', "Fold"));
			const glyphs: Record<VoltDevicePosture, [DuoGlyph, string]> = {
				folded: ['closed', localize('voltDevices.foldDevice', "Fold Device")],
				halfOpen: ['book', localize('voltDevices.halfOpenDevice', "Half Open")],
				open: ['open', localize('voltDevices.unfoldDevice', "Unfold Device")],
			};
			for (const posture of supported) {
				const [glyph, label] = glyphs[posture];
				this.railButton(folds, () => duoGlyph(doc, glyph), label, () => void this.setPosture(posture), { pressed: posture === current });
			}
		}
	}

	private menuAt(anchor: HTMLElement, width: number, sections: IVoltMenuSection<() => void | Promise<void>>[], ariaLabel: string): void {
		anchor.classList.add('open');
		showVoltMenu(this.contextViewService, {
			anchor,
			position: 'below',
			align: 'right',
			gap: 4,
			width,
			sections,
			className: 'volt-device-menu',
			ariaLabel,
			onPick: picked => void Promise.resolve(picked.data()).catch(err => this.fail(err)),
			onHide: () => anchor.classList.remove('open'),
		});
	}

	private showTextSizeMenu(anchor: HTMLElement): void {
		const sizes: [VoltDeviceTextSize, string][] = [
			['small', localize('voltDevices.textSmall', "Small")],
			['default', localize('voltDevices.textDefault', "Default")],
			['large', localize('voltDevices.textLarge', "Large")],
			['extra-large', localize('voltDevices.textExtraLarge', "Extra Large")],
		];
		const target = this.target;
		this.menuAt(anchor, 180, [{
			id: 'text', items: sizes.map(([id, label]) => ({
				id, label, data: async () => {
					if (target) {
						await this.devices.setTextSize(target, id);
					}
				}
			}))
		}], localize('voltDevices.textSize', "Device Text Size"));
	}

	private showToolsMenu(anchor: HTMLElement): void {
		const target = this.target;
		const booted = target?.device.state === 'booted';
		const android = target?.device.platform === 'android';
		type Action = () => void | Promise<void>;
		const item = (id: string, label: string, run: Action, icon?: ThemeIcon, disabled?: boolean): IVoltMenuItem<Action> => ({ id, label, icon, disabled, data: run });
		const hardware: IVoltMenuItem<Action>[] = android
			? [item('volUp', localize('voltDevices.volumeUp', "Volume Up"), () => this.press('volumeUp'), undefined, !booted), item('volDown', localize('voltDevices.volumeDown', "Volume Down"), () => this.press('volumeDown'), undefined, !booted), item('power', localize('voltDevices.power', "Power Button"), () => this.press('lock'), Codicon.lock, !booted)]
			: [item('siri', localize('voltDevices.siri', "Siri"), () => this.press('siri'), undefined, !booted), item('lock', localize('voltDevices.lock', "Lock"), () => this.press('lock'), Codicon.lock, !booted)];
		this.menuAt(anchor, 250, [
			{
				id: 'apps', items: [
					item('install', localize('voltDevices.install', "Install App…"), () => this.installApp(), Codicon.desktopDownload, !booted),
					{
						...item('launch', localize('voltDevices.launch', "Launch App or URL…"), () => undefined, Codicon.play, !booted),
						prompt: {
							placeholder: android ? localize('voltDevices.launchAndroid', "Package name or URL, e.g. com.example.app") : localize('voltDevices.launchIos', "Bundle id or URL, e.g. com.apple.mobilesafari"),
							onSubmit: async value => {
								await this.devices.launchApp(target!, value.trim());
							},
						},
					},
				]
			},
			{ id: 'hardware', items: hardware },
			{
				id: 'capture', items: [
					item('record', localize('voltDevices.record', "Record Window…"), () => this.commandService.executeCommand('volt.capture.recordWindow'), Codicon.record),
				]
			},
		], localize('voltDevices.tools', "Device Tools"));
	}

	private showMoreMenu(anchor: HTMLElement): void {
		const target = this.target;
		const booted = target?.device.state === 'booted';
		type Action = () => void | Promise<void>;
		const item = (id: string, label: string, run: Action, icon?: ThemeIcon, disabled?: boolean): IVoltMenuItem<Action> => ({ id, label, icon, disabled, data: run });
		this.menuAt(anchor, 250, [
			{
				id: 'panel', items: [
					item('float', localize('voltDevices.float', "Float Device over Chat"), () => this._onDidRequestFloat.fire(true), Codicon.multipleWindows, !booted),
					item('close', localize('voltDevices.closePanel', "Close Device Panel"), () => this._onDidRequestClose.fire(), Codicon.close),
				]
			},
			{
				id: 'devices', items: [
					item('refresh', localize('voltDevices.refresh', "Refresh Devices"), async () => { await this.devices.list(true); }, Codicon.refresh),
					item('hosts', localize('voltDevices.hosts', "Remote Machines…"), () => this.commandService.executeCommand('workbench.action.openSettings', 'volt.devices.remoteHosts'), Codicon.remote),
				]
			},
			{
				id: 'power', items: [
					item('off', localize('voltDevices.powerOff', "Power Off Device"), () => this.togglePower(), Codicon.debugStop, !booted),
				]
			},
		], localize('voltDevices.moreMenu', "More device actions"));
	}

	private async loadPostures(): Promise<void> {
		const target = this.target;
		if (!target || target.device.platform !== 'android') {
			return;
		}
		const key = this.devices.keyOf(target);
		this.posturesKey = key;
		const postures = await this.devices.postures(target).catch(() => undefined);
		// A list refresh swaps in a new object for the same device: compare by key.
		if (!this.target || this.devices.keyOf(this.target) !== key) {
			return;
		}
		if (!postures) {
			// adb was not ready yet (the device just booted, or Volt just started): ask again shortly.
			this.posturesKey = undefined;
			const win = getWindow(this.element);
			win.clearTimeout(this.posturesTimer);
			this.posturesTimer = win.setTimeout(() => this.syncTarget(), 3000);
			return;
		}
		this.postures = postures;
		this.phone?.setFoldAngle(this.foldAngle());
		this.renderRail();
	}

	private async loadAppearance(): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const key = this.devices.keyOf(target);
		this.appearanceKey = key;
		const appearance = await this.devices.appearance(target).catch(() => undefined);
		if (this.target && this.devices.keyOf(this.target) === key) {
			this.appearance = appearance;
			this.renderRail();
		}
	}

	//#endregion

	//#region Actions

	private fail(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		if (isIosInputToolMissing(message)) {
			this.offerAxe(message);
			return;
		}
		this.notificationService.error(message);
	}

	/** Touches without the live stream need AXe: install it from here, or copy the command. */
	private offerAxe(message: string): void {
		const target = this.target;
		if (this.axeOffered) {
			return;
		}
		this.axeOffered = true;
		this.notificationService.prompt(Severity.Info, message, [
			{
				label: localize('voltDevices.installAxe', "Install AXe"),
				run: () => {
					if (!target) {
						return;
					}
					const done = this.notificationService.notify({ severity: Severity.Info, message: localize('voltDevices.installingAxe', "Installing AXe with Homebrew…"), progress: { infinite: true } });
					this.devices.installIosInputTool(target).then(() => {
						done.close();
						this.axeOffered = false;
						this.notificationService.info(localize('voltDevices.axeInstalled', "AXe is installed. Touches and typing work on iOS simulators now."));
					}, err => {
						done.close();
						this.axeOffered = false;
						this.notificationService.prompt(Severity.Error, err instanceof Error ? err.message : String(err), [{
							label: localize('voltDevices.copyCommand', "Copy Command"),
							run: () => void this.clipboardService.writeText(IOS_INPUT_TOOL_INSTALL_COMMAND),
						}]);
					});
				},
			},
			{
				label: localize('voltDevices.copyCommand', "Copy Command"),
				run: () => void this.clipboardService.writeText(IOS_INPUT_TOOL_INSTALL_COMMAND),
			},
		], { onCancel: () => this.axeOffered = false });
	}

	private async togglePower(): Promise<void> {
		const target = this.target;
		if (!target || this.busy) {
			return;
		}
		const booting = target.device.state !== 'booted';
		const key = this.devices.keyOf(target);
		this.busy = booting ? localize('voltDevices.booting', "Booting…") : localize('voltDevices.shuttingDown', "Shutting Down…");
		this.renderToolbar();
		this.renderMessage();
		try {
			if (booting) {
				// The boot returns as soon as the device starts; the stream attaches right away and shows
				// the boot itself, as T3 Code does. The list catches up once it is ready.
				await this.devices.boot(target, undefined, { waitUntilReady: false });
				this.bootingKey = key;
				this.busy = undefined;
				this.syncLive();
				this.renderToolbar();
				void this.devices.boot(target).catch(() => undefined).then(async () => {
					await this.devices.list(true);
					if (this.bootingKey === key) {
						this.bootingKey = undefined;
					}
					this.syncTarget();
				});
				return;
			}
			this.stopLive();
			this.unmount3D();
			await this.devices.shutdown(target);
			this.shot = undefined;
			this.setScreen(undefined);
			await this.devices.list(true);
		} catch (err) {
			this.bootingKey = undefined;
			this.fail(err);
		} finally {
			this.busy = undefined;
			this.syncTarget();
		}
	}

	private async press(button: VoltDeviceButton): Promise<void> {
		if (!this.target) {
			return;
		}
		const live = this.live;
		// The stream's socket presses the hardware buttons through the device's own input, without AXe.
		if (live?.inputConnected) {
			if (button === 'home' || button === 'lock') {
				live.press(button === 'home' ? 'home' : 'power');
				return;
			}
			if (live.platform === 'android' && (button === 'back' || button === 'appSwitch')) {
				live.press(button === 'back' ? 'back' : 'recents');
				return;
			}
		}
		await this.devices.pressButton(this.target, button, 'user').catch(err => this.fail(err));
	}

	private async setPosture(posture: VoltDevicePosture): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const before = this.postures;
		// The 3D fold moves at once; the device follows.
		this.postures = { ...this.postures, current: posture };
		this.phone?.setFoldAngle(this.foldAngle());
		this.renderRail();
		try {
			await this.devices.setPosture(target, posture, 'user');
		} catch (err) {
			this.postures = before;
			this.phone?.setFoldAngle(this.foldAngle());
			this.renderRail();
			this.fail(err);
			void this.loadPostures();
		}
	}

	private async setAppearance(appearance: VoltDeviceAppearance): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const before = this.appearance;
		this.appearance = appearance;
		this.renderRail();
		try {
			await this.devices.setAppearance(target, appearance);
		} catch (err) {
			this.appearance = before;
			this.renderRail();
			this.fail(err);
		}
	}

	private async installApp(): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const ios = target.device.platform === 'ios';
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('voltDevices.installTitle', "Install App on {0}", target.device.name),
			canSelectFiles: !ios,
			canSelectFolders: ios,
			filters: ios ? undefined : [{ name: 'Android app', extensions: ['apk'] }],
		});
		if (!picked?.[0]) {
			return;
		}
		await this.devices.installApp(target, picked[0].fsPath);
		this.notificationService.info(localize('voltDevices.installed', "Installed {0} on {1}.", picked[0].path.split('/').pop(), target.device.name));
	}

	private async copyScreenshot(): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		try {
			const shot = await this.devices.screenshot(target, 0, 'user');
			const blob = await (await fetch(shot.dataUrl)).blob();
			const win = getWindow(this.element) as Window & typeof globalThis;
			await win.navigator.clipboard.write([new win.ClipboardItem({ [blob.type || 'image/png']: blob })]);
			this.notificationService.info(localize('voltDevices.copied', "Screenshot of {0} copied to the clipboard.", target.device.name));
			this.applyShot(shot);
		} catch (err) {
			this.fail(err);
		}
	}

	private flashAgent(): void {
		const win = getWindow(this.element);
		this.agentPill.classList.remove('hidden');
		win.clearTimeout(this.agentTimer);
		this.agentTimer = win.setTimeout(() => this.agentPill.classList.add('hidden'), 2500);
	}

	//#endregion

	//#region Screen

	private refreshSoon(delay: number): void {
		const win = getWindow(this.element);
		win.clearTimeout(this.pollTimer);
		this.pollTimer = win.setTimeout(() => void this.poll(), delay);
	}

	/** Keeps the preview streaming for a few seconds (the user or the agent is interacting). */
	private stream(): void {
		this.activeUntil = Date.now() + ACTIVE_MS;
	}

	private get onScreen(): boolean {
		return (this.visible || !!this.floatHost) && this.element.ownerDocument.visibilityState !== 'hidden';
	}

	/**
	 * Captures while on screen and booted: every `IDLE_POLL_MS` when nothing happens, back to back
	 * (overlapping, so a slow adb capture does not cap the frame rate) while interacting.
	 */
	private async poll(): Promise<void> {
		const target = this.target;
		if (!this.onScreen) {
			this.renderMessage();
			return;
		}
		if (this.live?.streaming) {
			// The live stream draws the screen; agent actions show up in it by themselves. The list
			// is still read now and then, so a shutdown outside Volt ends the stream.
			this.renderMessage();
			void this.devices.list();
			this.refreshSoon(LIST_POLL_MS);
			return;
		}
		if (!target || target.device.state !== 'booted') {
			this.renderMessage();
			// A simulator booted outside Volt (Xcode, simctl) shows up without reopening the menu.
			void this.devices.list();
			this.refreshSoon(this.bootingKey ? 500 : LIST_POLL_MS);
			return;
		}
		if (this.inFlight >= (this.captureMs > SLOW_CAPTURE_MS ? 1 : MAX_IN_FLIGHT)) {
			return;
		}
		this.inFlight++;
		const seq = ++this.captureSeq;
		const started = Date.now();
		let failed = false;
		if (started < this.activeUntil) {
			// The next capture starts a third of the way through this one.
			this.refreshSoon(Math.max(40, this.captureMs / MAX_IN_FLIGHT));
		}
		try {
			const shot = await this.devices.screenshot(target, PREVIEW_MAX_SIDE, 'user');
			// Captures can finish out of order: never show an older one over a newer one.
			if (this.target === target && seq > this.appliedSeq) {
				this.appliedSeq = seq;
				this.applyShot(shot);
			}
		} catch (err) {
			failed = true;
			if (this.target === target) {
				this.renderMessage(err instanceof Error ? err.message : String(err));
			}
		} finally {
			this.inFlight--;
			this.captureMs = Date.now() - started;
		}
		if (this.onScreen && this.target === target) {
			// A failing capture is retried at the idle pace, not in a tight loop.
			const active = Date.now() < this.activeUntil && !failed;
			if (active || !this.inFlight) {
				this.refreshSoon(active ? 0 : IDLE_POLL_MS);
			}
		}
	}

	private applyShot(shot: IDeviceShot): void {
		if (this.live?.streaming) {
			return;
		}
		this.shot = shot;
		const image = new (getWindow(this.element).Image)();
		image.onload = () => {
			if (this.shot !== shot || this.live?.streaming) {
				return;
			}
			const canvas = this.shotCanvas;
			const resized = canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight;
			if (resized) {
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
			}
			canvas.getContext('2d')?.drawImage(image, 0, 0);
			this.setScreen(canvas);
			if (resized) {
				this.layout();
			}
			this.phone?.frame();
			this.renderMessage();
			this.sync3D();
		};
		image.src = shot.dataUrl;
	}

	private renderMessage(error?: string): void {
		const device = this.target?.device;
		let text: string | undefined;
		const hasScreen = !!this.screen;
		if (error) {
			text = error;
		} else if (!device) {
			const problems = this.devices.cached().flatMap(entry => entry.problems);
			text = problems.length ? problems.join('\n') : localize('voltDevices.pick', "Choose a simulator or emulator to preview.");
		} else if (!hasScreen && (this.busy || this.bootingKey === this.deviceKey || device.state === 'booting')) {
			text = this.busy ?? localize('voltDevices.startingStream', "Starting {0}…", device.name);
		} else if (device.state !== 'booted' && !hasScreen) {
			text = localize('voltDevices.notBooted', "{0} is shut down. Boot it to see its screen.", device.name);
		}
		this.message.classList.toggle('hidden', !text);
		this.message.textContent = text ?? '';
	}

	/** Puts `canvas` in the flat view (or nothing). */
	private setScreen(canvas: HTMLCanvasElement | undefined): void {
		if (this.screen === canvas) {
			return;
		}
		this.screen?.remove();
		this.screen = canvas;
		if (canvas) {
			this.flat.appendChild(canvas);
		}
		this.syncPresentation();
		this.layout();
	}

	/** The screen's pixel size: the live stream's, or the last screenshot's. */
	private screenPixels(): { width: number; height: number } | undefined {
		const canvas = this.screen;
		if (!canvas?.width || !canvas.height) {
			return undefined;
		}
		return { width: canvas.width, height: canvas.height };
	}

	layout(): void {
		const pixels = this.screenPixels();
		const canvas = this.screen;
		if (!pixels || !canvas) {
			return;
		}
		const host = this.floatHost;
		const aspect = pixels.width / pixels.height;
		let width: number;
		let height: number;
		if (host) {
			// The mini device: as big as fits a corner of the chat.
			width = Math.min(FLOAT_MAX_WIDTH, FLOAT_MAX_SIDE * aspect);
			height = width / aspect;
			if (height > FLOAT_MAX_SIDE) {
				height = FLOAT_MAX_SIDE;
				width = height * aspect;
			}
			host.style.width = `${Math.round(width)}px`;
			host.style.height = `${Math.round(height)}px`;
		} else {
			// Flat: the bare screen as tall as the stage allows, clear of the rail (T3 Code's fitDeviceFrame).
			const stage = this.stage.getBoundingClientRect();
			if (!stage.width) {
				return;
			}
			const room = { width: Math.max(40, stage.width - RAIL_INSET - STAGE_PAD * 2), height: Math.max(40, stage.height - STAGE_PAD * 2) };
			height = room.height;
			width = height * aspect;
			if (width > room.width) {
				width = room.width;
				height = width / aspect;
			}
			this.flat.style.left = `${Math.round(STAGE_PAD + (room.width - width) / 2)}px`;
			this.flat.style.top = `${Math.round(STAGE_PAD + (room.height - height) / 2)}px`;
		}
		this.flat.style.width = `${Math.round(width)}px`;
		this.flat.style.height = `${Math.round(height)}px`;
		canvas.style.width = '100%';
		canvas.style.height = '100%';
	}

	//#endregion

	//#region View: flat and 3D

	private readViews(): Record<string, DeviceView> {
		try {
			const parsed = JSON.parse(this.storageService.get(VIEW_STORAGE_KEY, StorageScope.PROFILE, '{}')) as unknown;
			return parsed && typeof parsed === 'object' ? parsed as Record<string, DeviceView> : {};
		} catch {
			return {};
		}
	}

	/** The view picked for this device; 3D by default when T3 Code has its real model, flat otherwise. */
	private viewOf(): DeviceView {
		const device = this.target?.device;
		if (!device) {
			return 'flat';
		}
		const picked = this.views[this.devices.keyOf(this.target!)];
		if (picked) {
			return picked;
		}
		return isIphoneDuo(device.name) || /^iPhone 18 Pro( Max)?$|^iPad Pro 13-inch \(M5\)$/i.test(device.name.trim()) ? '3d' : 'flat';
	}

	private setView(view: DeviceView): void {
		if (!this.target) {
			return;
		}
		this.views = { ...this.views, [this.devices.keyOf(this.target)]: view };
		this.storageService.store(VIEW_STORAGE_KEY, JSON.stringify(this.views), StorageScope.PROFILE, StorageTarget.USER);
		this.sync3D();
		this.renderRail();
	}

	/** Shows the 3D view, first forgetting why it failed before (a lost WebGL context, a Duo feed hiccup). */
	private retry3D(): void {
		if (this.target) {
			this.threeDFailed.delete(this.devices.keyOf(this.target));
		}
		this.live?.clearDuoUnavailable();
		this.setView('3d');
	}

	private threeDUnavailable(): string | undefined {
		const target = this.target;
		if (!target) {
			return undefined;
		}
		return this.threeDFailed.get(this.devices.keyOf(target)) ?? this.live?.duoUnavailable;
	}

	/** Android foldables fold in 3D: closed 0 degrees, half open 90, open flat. Other devices have no hinge. */
	private foldAngle(): number | null {
		const device = this.target?.device;
		if (!device?.foldable || this.postures.supported.length < 2 || device.platform !== 'android') {
			return null;
		}
		const current = this.postures.current ?? this.postures.supported[this.postures.supported.length - 1];
		return current === 'folded' ? 0 : current === 'halfOpen' ? 90 : 180;
	}

	/** Mounts or removes the 3D device to match the chosen view and what is on screen. */
	private sync3D(): void {
		const target = this.target;
		const live = this.live;
		const key = target ? this.devices.keyOf(target) : undefined;
		const source = this.screen;
		const wanted = !!target && !!key && !!source && this.visible && !this.floatHost && this.viewOf() === '3d' && !this.threeDUnavailable();
		if (!wanted || !target || !key || !source) {
			this.unmount3D();
			return;
		}
		const duo = !!live?.streaming && source === live.canvas && isIphoneDuo(target.device.name) && !!live.screen?.supportsHingeAngle;
		const mountKey = `${key}|${duo ? 'duo' : source === this.shotCanvas ? 'shot' : 'live'}`;
		if (this.phoneKey === mountKey || this.threeDLoading === mountKey) {
			return;
		}
		this.unmount3D();
		this.threeDLoading = mountKey;
		const lost = (cause?: unknown) => {
			this.threeDFailed.set(key, cause instanceof Error ? cause.message : localize('voltDevices.threeDUnavailable', "The 3D view is unavailable."));
			this.unmount3D();
			this.renderRail();
		};
		if (duo && live) {
			void this.devices.deviceModel('iphone-duo').then(model => {
				if (this.threeDLoading !== mountKey || this.live !== live) {
					return;
				}
				this.threeDLoading = undefined;
				if (!model) {
					lost(new Error(localize('voltDevices.duoModelMissing', "The iPhone Duo 3D model is not on this Mac (~/.volt/device-models/iphone-duo.glb).")));
					return;
				}
				const store = new DisposableStore();
				this.phoneStore.value = store;
				this.phoneKey = mountKey;
				live.mountDuo(this.threeDHost, model, localize('voltDevices.duoLabel', "Interactive 3D iPhone Duo. Drag the screen to touch it. Drag outside it or swipe with two fingers to turn it. Pinch over it to open or close the hinge."), cause => live.loseDuo(cause instanceof Error ? cause.message : localize('voltDevices.threeDUnavailable', "The 3D view is unavailable.")));
				store.add(toDisposable(() => live.unmountDuo()));
				this.syncPresentation();
				this.renderRail();
			});
			return;
		}
		void loadDeviceViewer().then(async lib => {
			const ids = lib.deviceModelIdsFor(target.device.platform, target.device.name).filter(id => id !== 'iphone-duo');
			const data = await Promise.all(ids.map(async id => [id, await this.devices.deviceModel(id).catch(() => undefined)] as const));
			if (this.threeDLoading !== mountKey || this.screen !== source) {
				return;
			}
			this.threeDLoading = undefined;
			const models: Partial<Record<string, ArrayBuffer>> = {};
			let keyboard: ArrayBuffer | undefined;
			for (const [id, bytes] of data) {
				if (bytes && id === 'ipad-pro-13-m5-magic-keyboard') {
					keyboard = bytes;
				} else if (bytes) {
					models[id] = bytes;
				}
			}
			const store = new DisposableStore();
			this.phoneStore.value = store;
			this.phoneKey = mountKey;
			const streamed = source !== this.shotCanvas ? live : undefined;
			const phone = lib.mountPhoneViewport({
				host: this.threeDHost,
				source,
				platform: target.device.platform,
				name: target.device.name,
				models,
				keyboard,
				keyboardAttached: this.keyboardAttached,
				touch: (phase, x, y) => streamed ? streamed.touchDisplayed(phase, x, y) : this.touchShot(phase, x, y),
				screen: streamed?.screen ?? null,
				foldAngle: this.foldAngle(),
				label: localize('voltDevices.phoneLabel', "Interactive 3D {0}. Drag the screen to touch it. Drag outside it or swipe with two fingers to turn it.", target.device.name),
				onUnavailable: lost,
			});
			this.phone = phone;
			store.add(toDisposable(() => {
				phone.dispose();
				if (this.phone === phone) {
					this.phone = undefined;
				}
			}));
			if (streamed) {
				store.add(streamed.onFrame(() => phone.frame()));
				store.add(streamed.onDidChange(() => phone.setScreen(streamed.screen ?? null)));
			}
			this.syncPresentation();
			this.renderRail();
		}, lost);
	}

	private unmount3D(): void {
		this.threeDLoading = undefined;
		this.phoneKey = undefined;
		this.phoneStore.clear();
		this.phone = undefined;
		this.syncPresentation();
	}

	/** The 3D canvas replaces the flat screen while it shows; the flat one keeps feeding it, so it is hidden, not removed. */
	private syncPresentation(): void {
		const threeD = !!this.phoneKey && !this.floatHost;
		this.stage.classList.toggle('three-d', threeD);
		this.threeDHost.classList.toggle('hidden', !threeD);
		this.flat.classList.toggle('hidden', !this.screen);
	}

	private resetView(): void {
		const live = this.live;
		if (live && this.phone && !isIphoneDuo(this.target?.device.name ?? '')) {
			const orientation = this.keyboardAttached ? 'landscape_right' : 'portrait';
			if (live.screen?.orientation !== orientation) {
				live.setOrientation(orientation);
			}
		}
		this.phone?.resetPose();
		live?.resetDuoPose();
	}

	private toggleKeyboard(): void {
		const live = this.live;
		this.phone?.cancelInput();
		this.keyboardAttached = !this.keyboardAttached;
		if (this.keyboardAttached && live?.screen?.orientation !== 'landscape_right') {
			live?.setOrientation('landscape_right');
		}
		this.phone?.setKeyboardAttached(this.keyboardAttached);
		this.renderRail();
	}

	//#endregion

	//#region Floating mini device

	/**
	 * Shows the screen in `host` (the mini device over the chat while the right panel is closed),
	 * or back in the panel. The stream keeps playing while it floats.
	 */
	setFloat(host: HTMLElement | undefined): void {
		if (host === this.floatHost) {
			return;
		}
		this.floatHost = host;
		this.element.classList.toggle('floating', !!host);
		if (host) {
			host.appendChild(this.flat);
			this.flat.style.left = '0';
			this.flat.style.top = '0';
		} else {
			this.stage.insertBefore(this.flat, this.threeDHost);
		}
		this.syncLive();
		this.sync3D();
		this.renderRail();
		this.layout();
		if (host) {
			this.refreshSoon(0);
		}
	}

	//#endregion

	//#region Live stream

	/** Streams the target while on screen, when it is a running simulator or emulator on this computer. */
	private syncLive(): void {
		const target = this.target;
		const key = target ? this.devices.keyOf(target) : undefined;
		const booting = !!key && this.bootingKey === key;
		const wanted = !!target && !!key && (this.visible || !!this.floatHost) && (booting || this.devices.canStream(target)) && !this.liveFailed.has(key);
		if (!wanted || this.liveKey !== key) {
			if (this.liveKey) {
				this.stopLive();
			}
		}
		if (!wanted || !target || !key || this.liveKey === key) {
			return;
		}
		this.liveKey = key;
		const store = new DisposableStore();
		this.liveStore.value = store;
		void Promise.all([this.devices.attachStream(target), loadDeviceViewer()]).then(([attached, lib]) => {
			if (store.isDisposed) {
				return;
			}
			const live = store.add(new DeviceLiveStream(lib, this.element.ownerDocument, attached.origin, target.device.platform, attached.streamId, () => this.devices.attachStream(target)));
			this.live = live;
			store.add(toDisposable(() => {
				if (this.live === live) {
					this.live = undefined;
				}
			}));
			store.add(live.onDidChange(() => this.onLiveChange()));
			store.add(live.onDidFail(reason => this.failLive(key, reason)));
		}, err => {
			if (!store.isDisposed) {
				this.failLive(key, err instanceof Error ? err.message : String(err));
			}
		});
	}

	private stopLive(): void {
		const live = this.live;
		this.liveKey = undefined;
		this.liveStore.clear();
		this.live = undefined;
		if (live && this.screen === live.canvas) {
			this.unmount3D();
			this.setScreen(this.shot ? this.shotCanvas : undefined);
		}
	}

	/** Back to screenshots for this device, saying why once. */
	private failLive(key: string, reason: string): void {
		const name = this.target?.device.name ?? key;
		this.liveFailed.set(key, reason);
		this.stopLive();
		if (this.bootingKey !== key) {
			this.notificationService.warn(localize('voltDevices.liveFailed', "Live view of {0} stopped: {1} Showing screenshots instead.", name, reason));
		}
		this.renderToolbar();
		this.refreshSoon(0);
	}

	private onLiveChange(): void {
		const live = this.live;
		if (!live?.streaming || !this.target) {
			this.renderRail();
			return;
		}
		if (this.screen !== live.canvas) {
			this.unmount3D();
			this.setScreen(live.canvas);
		} else {
			this.layout();
		}
		this.renderMessage();
		this.sync3D();
		this.renderRail();
	}

	//#endregion

	//#region Input

	/** Screenshot coordinates of a normalized point on the screen. */
	private shotPoint(x: number, y: number): { x: number; y: number } | undefined {
		const shot = this.shot;
		return shot ? { x: Math.min(1, Math.max(0, x)) * shot.width, y: Math.min(1, Math.max(0, y)) * shot.height } : undefined;
	}

	private shotTouch: { x: number; y: number; at: number } | undefined;

	/** The 3D phone over a polled device: a press that barely moves is a tap, else a swipe. */
	private touchShot(phase: 'begin' | 'move' | 'end', x: number, y: number): void {
		const target = this.target;
		if (!target) {
			return;
		}
		if (phase === 'begin') {
			this.stream();
			this.shotTouch = { x, y, at: Date.now() };
			return;
		}
		const start = this.shotTouch;
		if (phase !== 'end' || !start) {
			return;
		}
		this.shotTouch = undefined;
		this.sendShotInput(target, start, { x, y }, Date.now() - start.at, (Math.hypot(x - start.x, y - start.y) * Math.max(1, this.flat.clientHeight)) < TAP_SLOP);
	}

	private sendShotInput(target: IDeviceTarget, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number, tap: boolean): void {
		const a = this.shotPoint(from.x, from.y);
		const b = this.shotPoint(to.x, to.y);
		if (!a || !b) {
			return;
		}
		const input = tap
			? { kind: 'tap' as const, x: a.x, y: a.y }
			: { kind: 'swipe' as const, x1: a.x, y1: a.y, x2: b.x, y2: b.y, durationMs: Math.max(120, Math.min(1500, durationMs)) };
		void this.devices.inputAt(target, input, 'user').catch(err => this.fail(err));
	}

	private onPointerDown(e: PointerEvent): void {
		const screen = this.screen;
		const target = this.target;
		if (e.button !== 0 || !screen || !target) {
			return;
		}
		this.stage.focus();
		this.stream();
		e.preventDefault();
		const store = new DisposableStore();
		const startX = e.clientX, startY = e.clientY, started = Date.now();
		this.flat.setPointerCapture(e.pointerId);
		const at = (event: PointerEvent) => {
			const rect = screen.getBoundingClientRect();
			return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
		};
		const live = this.live;
		if (live?.inputConnected && screen === live.canvas) {
			// Real touches: down, every move, up, straight to the device's input.
			const first = at(e);
			live.touch('begin', first.x, first.y);
			// Raw updates arrive as the pointer moves, not once per frame: the finger stays closer.
			const moveEvent = 'onpointerrawupdate' in getWindow(this.stage) ? 'pointerrawupdate' : 'pointermove';
			store.add(addDisposableListener(this.flat, moveEvent, (move: PointerEvent) => {
				const point = at(move);
				live.touch('move', point.x, point.y);
			}));
			const lift = (up: PointerEvent) => {
				store.dispose();
				const point = at(up);
				live.touch('end', point.x, point.y);
				this.showTouch(up.clientX, up.clientY);
			};
			store.add(addDisposableListener(this.flat, 'pointerup', lift));
			store.add(addDisposableListener(this.flat, 'pointercancel', lift));
			return;
		}
		if (target.device.state !== 'booted') {
			return;
		}
		const end = (up: PointerEvent) => {
			store.dispose();
			const moved = Math.hypot(up.clientX - startX, up.clientY - startY);
			this.showTouch(up.clientX, up.clientY);
			this.sendShotInput(target, at(e), at(up), Date.now() - started, moved < TAP_SLOP);
		};
		store.add(addDisposableListener(this.flat, 'pointerup', end));
		store.add(addDisposableListener(this.flat, 'pointercancel', () => store.dispose()));
	}

	private showTouch(x: number, y: number): void {
		const parent = this.floatHost ?? this.stage;
		const box = parent.getBoundingClientRect();
		const ring = append(parent, $('.volt-device-touch'));
		ring.style.left = `${x - box.left}px`;
		ring.style.top = `${y - box.top}px`;
		getWindow(parent).setTimeout(() => ring.remove(), 500);
	}

	/** Keys typed while the mini device has focus go to the device too. */
	handleKeyDown(e: KeyboardEvent): void {
		this.onKeyDown(e);
	}

	private onKeyDown(e: KeyboardEvent): void {
		const target = this.target;
		if (!target || e.metaKey || e.ctrlKey || e.altKey) {
			return;
		}
		const live = this.live;
		if (live?.inputConnected) {
			// Hardware key presses, as a keyboard attached to the device types them.
			e.preventDefault();
			if (e.repeat) {
				return;
			}
			live.key(e, 'down');
			const element = e.currentTarget as HTMLElement;
			const store = new DisposableStore();
			store.add(addDisposableListener(element, 'keyup', up => {
				if (up.code === e.code) {
					store.dispose();
					live.key(up, 'up');
				}
			}));
			store.add(addDisposableListener(element, 'blur', () => {
				store.dispose();
				live.key(e, 'up');
			}));
			return;
		}
		if (target.device.state !== 'booted') {
			return;
		}
		if (e.key === 'Enter' || e.key === 'Backspace') {
			e.preventDefault();
			this.flushTyping();
			void this.press(e.key === 'Enter' ? 'enter' : 'delete');
			return;
		}
		if (e.key.length !== 1) {
			return;
		}
		e.preventDefault();
		// Keys typed quickly go in one command.
		this.typed += e.key;
		const win = getWindow(this.stage);
		win.clearTimeout(this.typeTimer);
		this.typeTimer = win.setTimeout(() => this.flushTyping(), 180);
	}

	private flushTyping(): void {
		getWindow(this.stage).clearTimeout(this.typeTimer);
		const text = this.typed;
		this.typed = '';
		if (text && this.target) {
			void this.devices.inputAt(this.target, { kind: 'type', text }, 'user').catch(err => this.fail(err));
		}
	}

	//#endregion
}

/** Every device preview alive, by its tab: the floating mini device borrows the screen of the one whose panel closed. */
export const devicePreviews = new Map<object, DevicePreview>();

export function registerDevicePreview(input: object, preview: DevicePreview): IDisposable {
	devicePreviews.set(input, preview);
	return toDisposable(() => {
		if (devicePreviews.get(input) === preview) {
			devicePreviews.delete(input);
		}
	});
}
