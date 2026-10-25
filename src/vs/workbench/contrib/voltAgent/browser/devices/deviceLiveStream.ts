/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type * as Viewer from './vendor/voltDeviceViewer.js';

export type DeviceScreenSize = Viewer.DeviceScreenSize;
export type DuoCommand = Viewer.DuoCommand;
export type DuoControlState = Viewer.DuoControlState;
export type DeviceHardwareButton = Viewer.DeviceHardwareButton;

let viewerLoad: Promise<typeof Viewer> | undefined;
const MAX_RETRIES = 3;

/** The stream client and the iPhone Duo viewer (three.js), loaded the first time a device streams. */
export function loadDeviceViewer(): Promise<typeof Viewer> {
	viewerLoad ??= import('./vendor/voltDeviceViewer.js').catch(err => {
		viewerLoad = undefined;
		throw err;
	});
	return viewerLoad;
}

/** The simulator the iPhone Duo viewer draws. */
export function isIphoneDuo(name: string): boolean {
	return /^iPhone Duo$/i.test(name.trim());
}

/** Screen pixels per point: what the frame is drawn in. */
export function iosPointScale(name: string): number {
	return /iPad|iPhone SE|iPhone 8|iPhone 7/i.test(name) ? 2 : 3;
}

/**
 * One iOS simulator streaming from Expo's device hub: H.264 decoded into `canvas`, touches, keys
 * and buttons over the hub's socket, and the iPhone Duo's hinge. `mountDuo` puts the 3D Duo over a
 * host element, fed by the same stream.
 */
export class DeviceLiveStream extends Disposable {

	readonly canvas: HTMLCanvasElement;
	private readonly client: Viewer.DeviceStreamClient;
	private duo: Viewer.DuoViewport | undefined;
	private retries = 0;
	private disposed = false;

	status: Viewer.DeviceStreamStatus = 'connecting';
	detail: string | undefined;
	screen: DeviceScreenSize | undefined;
	inputConnected = false;
	duoControl: DuoControlState = { pending: false, requested: null, error: null };
	/** Why the 3D Duo gave up (no model, no WebGL, no panel feeds); the flat screen stays. */
	duoUnavailable: string | undefined;
	/** Set once the first frame arrived; until then the screenshot path keeps showing the device. */
	streaming = false;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Status, screen size, input connection or Duo control state changed. */
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidFail = this._register(new Emitter<string>());
	readonly onDidFail = this._onDidFail.event;

	constructor(
		private readonly lib: typeof Viewer,
		doc: Document,
		origin: string,
		readonly udid: string,
		/** Attaches the hub to the simulator again (after a hub restart or a reboot). */
		private readonly reattach: () => Promise<unknown>,
	) {
		super();
		this.canvas = doc.createElement('canvas');
		this.canvas.className = 'volt-device-screen volt-device-live-canvas';
		const ws = origin.replace(/^http/, 'ws');
		this.client = lib.createDeviceStreamClient(
			{ platform: 'ios', deviceId: udid, access: { httpBase: origin, wsBase: ws, query: {}, credentials: false } },
			lib.createCanvasFrameSink(this.canvas, () => {
				if (!this.streaming) {
					this.streaming = true;
					this._onDidChange.fire();
				}
				this.duo?.frame();
			}),
			{
				onStatus: (status, detail) => {
					this.status = status;
					this.detail = detail;
					if (status === 'streaming') {
						this.retries = 0;
					}
					this._onDidChange.fire();
					if (status === 'error') {
						this.retry(detail ?? 'The live stream stopped.');
					}
				},
				onScreen: screen => {
					this.screen = screen;
					this.duo?.setScreen(screen);
					this._onDidChange.fire();
				},
				onInputConnected: connected => {
					this.inputConnected = connected;
					this._onDidChange.fire();
				},
				onDuoControl: state => {
					this.duoControl = state;
					this.duo?.setHingePreview(state.requested?.control === 'angle' ? state.requested.value : null);
					if (state.error) {
						this.duo?.controlFailed();
					}
					this._onDidChange.fire();
				},
				onDuoUnavailable: detail => this.loseDuo(detail ?? 'The iPhone Duo displays cannot stream.'),
				// Loopback needs no credentials, and the workbench decodes H.264 itself.
				onUnauthorized: () => this._onDidFail.fire('The device hub refused the stream.'),
				onMjpegFallback: () => this._onDidFail.fire('This window cannot decode the simulator\'s video.'),
			},
		);
		this.client.start();
		this._register(toDisposable(() => {
			this.disposed = true;
			this.unmountDuo();
			this.client.stop();
		}));
	}

	/** The Duo's fold and stand as its controls show them, once the helper sent its screen. */
	foldState(): ReturnType<typeof Viewer.duoFoldState> | undefined {
		return this.screen ? this.lib.duoFoldState(this.screen) : undefined;
	}

	/** The orientation that keeps the phone held as it stands, sent before folding out of a stand. */
	holdOrientation(vertical: boolean): Viewer.DeviceOrientation | undefined {
		return this.screen ? this.lib.duoHoldOrientation(vertical, this.screen.screenId) : undefined;
	}

	/** A dropped stream starts again a few times (the hub restarting, a simulator reboot) before giving up. */
	private retry(reason: string): void {
		if (this.retries >= MAX_RETRIES || this.disposed) {
			this._onDidFail.fire(reason);
			return;
		}
		const delay = 500 * 2 ** this.retries++;
		const handle = setTimeout(async () => {
			await this.reattach().catch(() => undefined);
			if (!this.disposed) {
				this.client.start();
			}
		}, delay);
		this._register(toDisposable(() => clearTimeout(handle)));
	}

	get hasDuo(): boolean {
		return !!this.duo;
	}

	/** Normalized 0..1 point on the raw framebuffer, which is what `canvas` shows. */
	touch(phase: 'begin' | 'move' | 'end', x: number, y: number): void {
		this.client.sendRawTouch(phase, x, y);
	}

	key(event: KeyboardEvent, phase: 'down' | 'up'): void {
		this.client.sendKey(event, phase);
	}

	press(button: DeviceHardwareButton): void {
		this.client.pressButton(button);
	}

	rotate(): void {
		this.client.rotate();
	}

	controlDuo(command: DuoCommand): void {
		this.duo?.cancelInput();
		this.client.controlDuo(command);
	}

	mountDuo(host: HTMLElement, modelData: ArrayBuffer, label: string, onUnavailable: (cause?: unknown) => void): void {
		if (this.duo) {
			return;
		}
		this.duo = this.lib.mountDuoViewport({
			host,
			decoded: this.canvas,
			client: this.client,
			modelData,
			screen: this.screen ?? null,
			label,
			onUnavailable,
		});
	}

	loseDuo(reason: string): void {
		this.unmountDuo();
		this.duoUnavailable = reason;
		this._onDidChange.fire();
	}

	unmountDuo(): void {
		this.duo?.dispose();
		this.duo = undefined;
	}

	resetDuoPose(): void {
		this.duo?.resetPose();
	}
}
