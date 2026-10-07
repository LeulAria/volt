/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltDevices.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVoltDevice, IVoltDevicePostures, VoltDeviceButton, VoltDevicePosture } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { DEFAULT_ORBIT, hingeAngle, IOrbit, orbitAfterDrag, postureLabel } from '../../common/agentDevices.js';
import { RecordingBadge } from '../capture/recordingBadge.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IBrowserDevice, renderBareDeviceFrame } from '../preview/browserDevices.js';
import { createVoltSegmented, IVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IAgentDevicesService, IDeviceShot, IDeviceTarget } from './agentDevicesService.js';

/** The preview refreshes this often while on screen (plus right after every action). */
const POLL_MS = 350;
const PREVIEW_MAX_SIDE = 1400;
/** A press that moves less than this is a tap; more is a swipe. */
const TAP_SLOP = 6;
const STAGE_PAD = 28;
/** Android screenshots are in pixels; frames are drawn in dp (Pixel density). */
const ANDROID_DENSITY = 2.625;

/** The frame a simulator gets: its shape from the model and platform. */
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

function iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, className = ''): HTMLButtonElement {
	const button = append(parent, $(`button.volt-device-tool${className ? `.${className}` : ''}`)) as HTMLButtonElement;
	button.type = 'button';
	button.appendChild(renderIcon(icon));
	button.setAttribute('aria-label', label);
	setAgentTooltip(button, label);
	return button;
}

/**
 * A simulator or emulator on screen: pick a device (this computer or an SSH host), boot it, see
 * its screen live in its frame, tap, swipe and type on it, press its buttons, fold it, and turn it
 * in 3D. Agents drive the same devices through the device_* tools; their actions show up here.
 */
export class DevicePreview extends Disposable {

	readonly element: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly deviceButton: HTMLButtonElement;
	private readonly deviceDot: HTMLElement;
	private readonly deviceName: HTMLElement;
	private readonly deviceDetail: HTMLElement;
	private readonly powerButton: HTMLButtonElement;
	private readonly hardware: HTMLElement;
	private readonly postureSlot: HTMLElement;
	private readonly threeDButton: HTMLButtonElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly stage: HTMLElement;
	private readonly scene: HTMLElement;
	private readonly rig: HTMLElement;
	private readonly message: HTMLElement;
	private readonly agentPill: HTMLElement;
	private readonly posture = this._register(new MutableDisposable<DisposableStore>());
	private postureControl: IVoltSegmented<VoltDevicePosture> | undefined;
	private postures: IVoltDevicePostures = { supported: [] };

	private target: IDeviceTarget | undefined;
	private shot: IDeviceShot | undefined;
	private screens: HTMLImageElement[] = [];
	private frameKey = '';
	private visible = false;
	private polling = false;
	private pollTimer: number | undefined;
	private busy: string | undefined;
	private threeD = false;
	private orbit: IOrbit = DEFAULT_ORBIT;
	private frameSize = { width: 0, height: 0 };
	private typed = '';
	private typeTimer: number | undefined;
	private agentTimer: number | undefined;

	private readonly _onDidChangeTitle = this._register(new Emitter<string>());
	readonly onDidChangeTitle = this._onDidChangeTitle.event;

	constructor(
		parent: HTMLElement,
		private initialKey: string | undefined,
		@IAgentDevicesService private readonly devices: IAgentDevicesService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
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

		this.hardware = append(this.toolbar, $('.volt-device-hardware'));
		this.postureSlot = append(this.toolbar, $('.volt-device-posture'));
		append(this.toolbar, $('.volt-device-toolbar-gap'));
		this.threeDButton = iconButton(this.toolbar, Codicon.layers, localize('voltDevices.threeD', "3D View"), 'three-d');
		this._register(addDisposableListener(this.threeDButton, 'click', () => this.setThreeD(!this.threeD)));
		const shotButton = iconButton(this.toolbar, Codicon.deviceCamera, localize('voltDevices.copyShot', "Copy Screenshot"));
		this._register(addDisposableListener(shotButton, 'click', () => void this.copyScreenshot()));
		this.moreButton = iconButton(this.toolbar, Codicon.ellipsis, localize('voltDevices.more', "More Actions"));
		this._register(addDisposableListener(this.moreButton, 'click', () => this.showMoreMenu()));

		this.stage = append(this.element, $('.volt-device-stage'));
		this.stage.tabIndex = 0;
		this.stage.setAttribute('role', 'application');
		this.stage.setAttribute('aria-label', localize('voltDevices.stage', "Device screen. Click to tap, drag to swipe, type to send keys."));
		this.scene = append(this.stage, $('.volt-device-scene'));
		this.rig = append(this.scene, $('.volt-device-rig'));
		this.message = append(this.stage, $('.volt-device-message.hidden'));
		this.agentPill = append(this.stage, $('.volt-device-agent-pill.hidden'));
		this.agentPill.appendChild(renderIcon(Codicon.sparkle));
		append(this.agentPill, $('span')).textContent = localize('voltDevices.agentActing', "Agent is using this device");
		this._register(instantiationService.createInstance(RecordingBadge, this.stage));

		this._register(addDisposableListener(this.stage, 'pointerdown', e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.stage, 'dblclick', e => {
			if (this.threeD && !this.isOnScreen(e)) {
				this.orbit = DEFAULT_ORBIT;
				this.layout();
			}
		}));
		this._register(addDisposableListener(this.stage, 'keydown', e => this.onKeyDown(e)));
		this._register(this.devices.onDidChangeDevices(() => this.syncTarget()));
		this._register(this.devices.onDidAct(activity => {
			if (this.target && activity.key === this.devices.keyOf(this.target)) {
				if (activity.by === 'agent') {
					this.flashAgent();
				}
				this.refreshSoon(150);
			}
		}));
		this._register({
			dispose: () => {
				const win = getWindow(this.element);
				win.clearTimeout(this.pollTimer);
				win.clearTimeout(this.typeTimer);
				win.clearTimeout(this.agentTimer);
			}
		});
		this.renderToolbar();
		void this.devices.list().then(() => this.syncTarget());
	}

	get title(): string {
		return this.target?.device.name ?? localize('voltDevices.title', "Devices");
	}

	get deviceKey(): string | undefined {
		return this.target ? this.devices.keyOf(this.target) : this.initialKey;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
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
		const wasBooted = this.target?.device.state === 'booted';
		this.target = next;
		if (next && next.device.state === 'booted' && !wasBooted) {
			void this.loadPostures();
		}
		this.renderToolbar();
		this.refreshSoon(0);
	}

	private firstBooted(): IDeviceTarget | undefined {
		for (const entry of this.devices.cached()) {
			const device = entry.devices.find(candidate => candidate.state === 'booted');
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
		this.frameKey = '';
		this.postures = { supported: [] };
		clearNode(this.rig);
		this.screens = [];
		this.renderToolbar();
		this._onDidChangeTitle.fire(this.title);
		if (target.device.state === 'booted') {
			void this.loadPostures();
		}
		this.refreshSoon(0);
	}

	private async showDeviceMenu(): Promise<void> {
		const lists = await this.devices.list(true);
		const current = this.target ? this.devices.keyOf(this.target) : undefined;
		const sections: IVoltMenuSection<IDeviceTarget | undefined>[] = lists.map(entry => ({
			id: entry.host.id,
			title: entry.host.ssh ? localize('voltDevices.remoteHost', "{0} (SSH)", entry.host.label) : entry.host.label,
			emptyMessage: entry.problems.join(' · ') || localize('voltDevices.none', "No simulators or emulators"),
			items: entry.devices.map((device): IVoltMenuItem<IDeviceTarget | undefined> => ({
				id: `${entry.host.id}/${device.platform}/${device.id}`,
				label: device.name,
				description: [device.runtime, device.foldable ? localize('voltDevices.foldable', "Foldable") : undefined].filter(Boolean).join(' · ') || undefined,
				icon: device.platform === 'ios' ? Codicon.deviceMobile : Codicon.vm,
				keybinding: device.state === 'booted' ? localize('voltDevices.booted', "Booted") : undefined,
				checked: `${entry.host.id}/${device.platform}/${device.id}` === current,
				keywords: `${device.platform} ${device.runtime ?? ''} ${entry.host.label}`,
				data: { host: entry.host, device },
			})),
		}));
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
					this.select(picked.data);
				} else {
					void this.commandService.executeCommand('workbench.action.openSettings', 'volt.devices.remoteHosts');
				}
			},
		});
	}

	//#endregion

	//#region Toolbar

	private renderToolbar(): void {
		const target = this.target;
		const device = target?.device;
		this.deviceName.textContent = device?.name ?? localize('voltDevices.choose', "Choose a Device");
		this.deviceDetail.textContent = device ? [device.runtime, target.host.ssh ? target.host.label : undefined].filter(Boolean).join(' · ') : '';
		this.deviceDot.className = `volt-device-state-dot state-${this.busy ? 'booting' : device?.state ?? 'none'}`;
		const booted = device?.state === 'booted';
		this.powerButton.classList.toggle('hidden', !device);
		this.powerButton.disabled = !!this.busy;
		this.powerButton.textContent = this.busy ?? (booted ? localize('voltDevices.shutdown', "Shut Down") : localize('voltDevices.boot', "Boot"));
		clearNode(this.hardware);
		if (device && booted) {
			const buttons: [VoltDeviceButton, ThemeIcon, string][] = device.platform === 'android'
				? [['back', Codicon.arrowLeft, localize('voltDevices.back', "Back")], ['home', Codicon.circleLargeOutline, localize('voltDevices.home', "Home")], ['appSwitch', Codicon.multipleWindows, localize('voltDevices.recents', "Recent Apps")], ['lock', Codicon.lock, localize('voltDevices.power', "Power")]]
				: [['home', Codicon.circleLargeOutline, localize('voltDevices.home', "Home")], ['lock', Codicon.lock, localize('voltDevices.lock', "Lock")]];
			for (const [button, icon, label] of buttons) {
				const el = iconButton(this.hardware, icon, label);
				el.addEventListener('click', () => void this.press(button));
			}
		}
		this.renderPosture();
		this.threeDButton.classList.toggle('checked', this.threeD);
		this.threeDButton.setAttribute('aria-pressed', String(this.threeD));
		this._onDidChangeTitle.fire(this.title);
	}

	private renderPosture(): void {
		const supported = this.target?.device.state === 'booted' ? this.postures.supported : [];
		if (!supported.length) {
			this.posture.clear();
			this.postureControl = undefined;
			clearNode(this.postureSlot);
			return;
		}
		if (this.postureControl && this.postureControl.element.childElementCount - 1 === supported.length) {
			if (this.postures.current && this.postureControl.value !== this.postures.current) {
				this.postureControl.set(this.postures.current);
			}
			return;
		}
		clearNode(this.postureSlot);
		const store = new DisposableStore();
		this.posture.value = store;
		this.postureControl = createVoltSegmented(this.postureSlot, supported.map(id => ({ id, label: postureLabel(id) })), this.postures.current ?? supported[supported.length - 1], posture => void this.setPosture(posture), store, 'small');
		getWindow(this.element).requestAnimationFrame(() => this.postureControl?.sync());
	}

	private async loadPostures(): Promise<void> {
		const target = this.target;
		if (!target || target.device.platform !== 'android') {
			return;
		}
		const postures = await this.devices.postures(target).catch(() => ({ supported: [] }));
		if (this.target === target) {
			this.postures = postures;
			this.renderPosture();
			this.layout();
		}
	}

	private showMoreMenu(): void {
		const target = this.target;
		const booted = target?.device.state === 'booted';
		const android = target?.device.platform === 'android';
		type Action = () => void | Promise<void>;
		const item = (id: string, label: string, run: Action, icon?: ThemeIcon, disabled?: boolean): IVoltMenuItem<Action> => ({ id, label, icon, disabled, data: run });
		const hardware: IVoltMenuItem<Action>[] = android
			? [item('volUp', localize('voltDevices.volumeUp', "Volume Up"), () => this.press('volumeUp'), undefined, !booted), item('volDown', localize('voltDevices.volumeDown', "Volume Down"), () => this.press('volumeDown'), undefined, !booted)]
			: [item('siri', localize('voltDevices.siri', "Siri"), () => this.press('siri'), undefined, !booted)];
		showVoltMenu(this.contextViewService, {
			anchor: this.moreButton,
			position: 'below',
			align: 'right',
			gap: 4,
			width: 240,
			sections: [
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
					id: 'view', items: [
						item('reset', localize('voltDevices.resetView', "Reset 3D View"), () => { this.orbit = DEFAULT_ORBIT; this.layout(); }, undefined, !this.threeD),
						item('refresh', localize('voltDevices.refresh', "Refresh Devices"), async () => { await this.devices.list(true); }, Codicon.refresh),
						item('record', localize('voltDevices.record', "Record Window…"), () => this.commandService.executeCommand('volt.capture.recordWindow'), Codicon.record),
						item('hosts', localize('voltDevices.hosts', "Remote Machines…"), () => this.commandService.executeCommand('workbench.action.openSettings', 'volt.devices.remoteHosts'), Codicon.remote),
					]
				},
			],
			className: 'volt-device-menu',
			ariaLabel: localize('voltDevices.moreMenu', "Device actions"),
			onPick: picked => void Promise.resolve(picked.data()).catch(err => this.fail(err)),
		});
	}

	//#endregion

	//#region Actions

	private fail(err: unknown): void {
		this.notificationService.error(err instanceof Error ? err.message : String(err));
	}

	private async togglePower(): Promise<void> {
		const target = this.target;
		if (!target || this.busy) {
			return;
		}
		const booting = target.device.state !== 'booted';
		this.busy = booting ? localize('voltDevices.booting', "Booting…") : localize('voltDevices.shuttingDown', "Shutting Down…");
		this.renderToolbar();
		try {
			if (booting) {
				await this.devices.boot(target);
			} else {
				await this.devices.shutdown(target);
				this.shot = undefined;
			}
			await this.devices.list(true);
		} catch (err) {
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
		await this.devices.pressButton(this.target, button, 'user').catch(err => this.fail(err));
	}

	private async setPosture(posture: VoltDevicePosture): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		try {
			await this.devices.setPosture(target, posture, 'user');
			this.postures = { ...this.postures, current: posture };
			this.layout();
		} catch (err) {
			this.fail(err);
			void this.loadPostures();
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

	/** One screenshot at a time, then the next after `POLL_MS`, only while visible and booted. */
	private async poll(): Promise<void> {
		const target = this.target;
		if (!this.visible || this.polling || this.element.ownerDocument.visibilityState === 'hidden') {
			this.renderMessage();
			return;
		}
		if (!target || target.device.state !== 'booted') {
			this.renderMessage();
			return;
		}
		this.polling = true;
		try {
			const shot = await this.devices.screenshot(target, PREVIEW_MAX_SIDE, 'user');
			if (this.target === target) {
				this.applyShot(shot);
			}
		} catch (err) {
			if (this.target === target) {
				this.renderMessage(err instanceof Error ? err.message : String(err));
			}
		} finally {
			this.polling = false;
		}
		if (this.visible && this.target === target) {
			this.refreshSoon(POLL_MS);
		}
	}

	private applyShot(shot: IDeviceShot): void {
		this.shot = shot;
		this.message.classList.add('hidden');
		this.ensureFrame(shot);
		for (const screen of this.screens) {
			if (screen.src !== shot.dataUrl) {
				screen.src = shot.dataUrl;
			}
		}
	}

	private renderMessage(error?: string): void {
		const device = this.target?.device;
		let text: string | undefined;
		if (error) {
			text = error;
		} else if (!device) {
			const problems = this.devices.cached().flatMap(entry => entry.problems);
			text = problems.length ? problems.join('\n') : localize('voltDevices.pick', "Choose a simulator or emulator to preview.");
		} else if (device.state !== 'booted') {
			text = this.busy ?? localize('voltDevices.notBooted', "{0} is shut down. Boot it to see its screen.", device.name);
		}
		this.message.classList.toggle('hidden', !text);
		this.message.textContent = text ?? '';
		this.rig.classList.toggle('hidden', !!text && !this.shot);
	}

	/** Screen size in frame units: iOS points, Android dp. */
	private screenUnits(shot: IDeviceShot): { width: number; height: number } {
		const scale = this.target?.device.platform === 'ios' ? shot.screen.scale : ANDROID_DENSITY;
		return { width: Math.round(shot.screen.width / scale), height: Math.round(shot.screen.height / scale) };
	}

	private ensureFrame(shot: IDeviceShot): void {
		const device = this.target?.device;
		if (!device) {
			return;
		}
		const units = this.screenUnits(shot);
		const hinged = this.threeD && this.postures.current === 'halfOpen';
		const key = `${device.id}:${units.width}x${units.height}:${hinged}`;
		if (key === this.frameKey) {
			return;
		}
		this.frameKey = key;
		clearNode(this.rig);
		this.screens = [];
		const landscape = units.width > units.height && !device.foldable;
		const halves = hinged ? ['left', 'right'] : ['whole'];
		for (const half of halves) {
			const built = landscape ? undefined : renderBareDeviceFrame(frameForDevice(device, units.width, units.height), units.width, units.height);
			const holder = append(this.rig, $(`.volt-device-half.${half}`));
			let host: HTMLElement;
			if (built) {
				built.frame.classList.add('volt-device-live-frame');
				holder.appendChild(built.frame);
				host = built.display;
				this.frameSize = { width: built.width, height: built.height };
			} else {
				host = append(holder, $('.volt-device-bare-screen'));
				host.style.width = `${units.width}px`;
				host.style.height = `${units.height}px`;
				this.frameSize = units;
			}
			holder.style.width = `${this.frameSize.width}px`;
			holder.style.height = `${this.frameSize.height}px`;
			const img = append(host, $('img.volt-device-screen')) as HTMLImageElement;
			img.alt = '';
			img.draggable = false;
			img.style.width = `${units.width}px`;
			img.style.height = `${units.height}px`;
			this.screens.push(img);
		}
		this.layout();
	}

	layout(): void {
		const stage = this.stage.getBoundingClientRect();
		if (!stage.width || !this.frameSize.width) {
			return;
		}
		const room = { width: Math.max(80, stage.width - STAGE_PAD * 2), height: Math.max(80, stage.height - STAGE_PAD * 2) };
		const extra = this.threeD ? 1.18 : 1;
		const scale = Math.min(1.25, room.width / (this.frameSize.width * extra), room.height / (this.frameSize.height * extra));
		this.rig.style.width = `${this.frameSize.width}px`;
		this.rig.style.height = `${this.frameSize.height}px`;
		const turn = this.threeD ? ` rotateX(${this.orbit.pitch}deg) rotateY(${this.orbit.yaw}deg)` : '';
		this.rig.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})${turn}`;
		this.scene.classList.toggle('three-d', this.threeD);
		const hinge = hingeAngle(this.postures.current);
		for (const half of this.rig.querySelectorAll<HTMLElement>('.volt-device-half.right')) {
			// Half open: the right half turns up at the hinge (the middle), like a book standing open.
			half.style.transform = `rotateY(${-hinge}deg)`;
		}
	}

	private setThreeD(on: boolean): void {
		this.threeD = on;
		this.frameKey = '';
		if (this.shot) {
			this.ensureFrame(this.shot);
		}
		this.renderToolbar();
		this.layout();
	}

	//#endregion

	//#region Input

	private isOnScreen(e: MouseEvent): HTMLImageElement | undefined {
		return this.screens.find(screen => screen.contains(e.target as Node));
	}

	/** A point on the screen element in the coordinates of the last screenshot. */
	private toShot(screen: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | undefined {
		const shot = this.shot;
		if (!shot) {
			return undefined;
		}
		const rect = screen.getBoundingClientRect();
		if (!rect.width || !rect.height) {
			return undefined;
		}
		// In 3D the screen is turned; the bounding box is only a projection, so taps are approximate.
		return { x: (clientX - rect.left) / rect.width * shot.width, y: (clientY - rect.top) / rect.height * shot.height };
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return;
		}
		this.stage.focus();
		const screen = this.isOnScreen(e);
		const target = this.target;
		const store = new DisposableStore();
		const startX = e.clientX, startY = e.clientY, started = Date.now();
		this.stage.setPointerCapture(e.pointerId);
		if (!screen || !target || target.device.state !== 'booted') {
			if (!this.threeD) {
				return;
			}
			// Drag the background to turn the device.
			const from = this.orbit;
			this.stage.classList.add('orbiting');
			store.add(addDisposableListener(this.stage, 'pointermove', move => {
				this.orbit = orbitAfterDrag(from, move.clientX - startX, move.clientY - startY, this.stage.clientWidth);
				this.layout();
			}));
			const end = () => {
				this.stage.classList.remove('orbiting');
				store.dispose();
			};
			store.add(addDisposableListener(this.stage, 'pointerup', end));
			store.add(addDisposableListener(this.stage, 'pointercancel', end));
			return;
		}
		e.preventDefault();
		const end = (up: PointerEvent) => {
			store.dispose();
			const from = this.toShot(screen, startX, startY);
			const to = this.toShot(screen, up.clientX, up.clientY);
			if (!from || !to) {
				return;
			}
			const moved = Math.hypot(up.clientX - startX, up.clientY - startY);
			const input = moved < TAP_SLOP
				? { kind: 'tap' as const, x: from.x, y: from.y }
				: { kind: 'swipe' as const, x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs: Math.max(120, Math.min(1500, Date.now() - started)) };
			this.showTouch(up.clientX, up.clientY);
			void this.devices.inputAt(target, input, 'user').catch(err => this.fail(err));
		};
		store.add(addDisposableListener(this.stage, 'pointerup', end));
		store.add(addDisposableListener(this.stage, 'pointercancel', () => store.dispose()));
	}

	private showTouch(x: number, y: number): void {
		const stage = this.stage.getBoundingClientRect();
		const ring = append(this.stage, $('.volt-device-touch'));
		ring.style.left = `${x - stage.left}px`;
		ring.style.top = `${y - stage.top}px`;
		getWindow(this.stage).setTimeout(() => ring.remove(), 500);
	}

	private onKeyDown(e: KeyboardEvent): void {
		const target = this.target;
		if (!target || target.device.state !== 'booted' || e.metaKey || e.ctrlKey || e.altKey) {
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
