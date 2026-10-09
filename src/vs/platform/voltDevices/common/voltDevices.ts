/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltDevicesService = createDecorator<IVoltDevicesService>('voltDevicesService');
export const VOLT_DEVICES_CHANNEL_NAME = 'voltDevices';

export const LOCAL_DEVICE_HOST_ID = 'local';

export type VoltDevicePlatform = 'ios' | 'android';
export type VoltDeviceKind = 'simulator' | 'emulator' | 'physical';
export type VoltDeviceState = 'booted' | 'booting' | 'shutdown' | 'offline' | 'unauthorized' | 'unknown';
/** A foldable's hinge: closed on its cover screen, half open like a laptop, or flat open. */
export type VoltDevicePosture = 'folded' | 'halfOpen' | 'open';
export type VoltDeviceButton = 'home' | 'back' | 'appSwitch' | 'lock' | 'volumeUp' | 'volumeDown' | 'siri' | 'enter' | 'delete';

/** How to reach another machine's simulators: `ssh [-p port] [-i identity] [user@]host`. Keys only; never a password. */
export interface IVoltSshTarget {
	readonly host: string;
	readonly user?: string;
	readonly port?: number;
	readonly identityFile?: string;
}

/** A machine whose simulators and emulators Volt drives: this one, or one reached over SSH. */
export interface IVoltDeviceHost {
	readonly id: string;
	readonly label: string;
	readonly ssh?: IVoltSshTarget;
	/** The Android SDK on that machine, when it is not on its PATH or in the default place. */
	readonly androidSdk?: string;
}

export interface IVoltDeviceRef {
	readonly platform: VoltDevicePlatform;
	/** iOS: the simulator's UDID. Android: the AVD name for emulators, the adb serial for devices. */
	readonly id: string;
}

export interface IVoltDevice extends IVoltDeviceRef {
	readonly hostId: string;
	readonly name: string;
	readonly kind: VoltDeviceKind;
	readonly state: VoltDeviceState;
	/** "iOS 18.5", "Android 15 (API 35)". */
	readonly runtime?: string;
	/** Android: the adb serial while it runs (emulator-5554). */
	readonly serial?: string;
	/** iOS: the device type identifier's last part, e.g. "iPhone-16". */
	readonly model?: string;
	readonly foldable?: boolean;
}

export interface IVoltDeviceList {
	readonly devices: readonly IVoltDevice[];
	/** Tools that are missing or failed, phrased for the user ("adb not found: install Android platform-tools"). */
	readonly problems: readonly string[];
}

export type VoltDeviceInput =
	| { readonly kind: 'tap'; readonly x: number; readonly y: number }
	| { readonly kind: 'swipe'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly durationMs?: number }
	| { readonly kind: 'type'; readonly text: string }
	| { readonly kind: 'button'; readonly button: VoltDeviceButton };

export interface IVoltDeviceScreen {
	/** The image, base64: a VSBuffer inside an object does not survive the IPC channel. PNG unless `format` says otherwise. */
	readonly imageBase64: string;
	readonly format?: 'png' | 'jpeg';
	/** Pixel size of the screen (and of the image, unless `imageWidth` says it was shrunk). */
	readonly width: number;
	readonly height: number;
	/** Set when the image is a scaled copy of the screen (the caller asked for `maxSide`). */
	readonly imageWidth?: number;
	readonly imageHeight?: number;
	/**
	 * Screen pixels per input unit: input on iOS is in points (2 or 3 px each), on Android in
	 * pixels (1).
	 */
	readonly scale: number;
}

export interface IVoltDevicePostures {
	readonly supported: readonly VoltDevicePosture[];
	readonly current?: VoltDevicePosture;
}

/**
 * iOS simulators (`xcrun simctl`) and Android emulators and devices (`adb`, `emulator`), on this
 * machine or another one over SSH. Lives in the main process: the workbench is sandboxed.
 */
export interface IVoltDevicesService {
	readonly _serviceBrand: undefined;

	listDevices(host: IVoltDeviceHost): Promise<IVoltDeviceList>;
	/** Boots the device and waits until it is ready, up to `timeoutMs`. Resolves with its state then. */
	boot(host: IVoltDeviceHost, device: IVoltDeviceRef, timeoutMs?: number): Promise<VoltDeviceState>;
	shutdown(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<void>;
	/** `maxSide` > 0 asks for a JPEG no bigger than that, which is much cheaper to make and to send than the full-size PNG. */
	screenshot(host: IVoltDeviceHost, device: IVoltDeviceRef, maxSide?: number): Promise<IVoltDeviceScreen>;
	/** Coordinates are in input units (see `IVoltDeviceScreen.scale`). */
	input(host: IVoltDeviceHost, device: IVoltDeviceRef, input: VoltDeviceInput): Promise<void>;
	/** A `.app` (iOS simulator) or `.apk` (Android) on this machine; copied over first for a remote host. */
	installApp(host: IVoltDeviceHost, device: IVoltDeviceRef, path: string): Promise<void>;
	/** A bundle id / package name (optionally `package/.Activity`), or a URL to open. */
	launchApp(host: IVoltDeviceHost, device: IVoltDeviceRef, target: string): Promise<void>;
	getPostures(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<IVoltDevicePostures>;
	setPosture(host: IVoltDeviceHost, device: IVoltDeviceRef, posture: VoltDevicePosture): Promise<void>;
}
