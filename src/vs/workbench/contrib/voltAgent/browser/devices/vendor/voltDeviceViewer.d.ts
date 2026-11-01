/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types for voltDeviceViewer.js, built from build/volt/deviceViewer (see src/index.ts there).

export type DeviceStreamStatus = 'connecting' | 'streaming' | 'error';
export type DeviceOrientation = 'portrait' | 'portrait_upside_down' | 'landscape_left' | 'landscape_right';
export type DuoPose = 'closed' | 'book' | 'open' | 'laptop' | 'tent';

export interface DeviceScreenSize {
	readonly width: number;
	readonly height: number;
	readonly orientation: DeviceOrientation;
	/** iPhone Duo: 1 is the cover display, 3 the inner folding one. */
	readonly screenId?: number;
	readonly supportsHingeAngle?: boolean;
	readonly supportsPhysicalOrientation?: boolean;
	readonly hingeAngle?: number;
	readonly hingePose?: DuoPose | null;
	readonly tableMode?: boolean;
	readonly tableModeAvailable?: boolean;
}

export type DuoCommand =
	| { control: 'angle'; value: number }
	| { control: 'pose'; value: DuoPose }
	| { control: 'table'; value: boolean }
	| { control: 'physical'; value: 'faceup' | 'facedown' }
	| { control: 'orientation'; value: DeviceOrientation };

export interface DuoControlState {
	pending: boolean;
	requested: DuoCommand | null;
	error: string | null;
}

export interface DeviceHubAccess {
	readonly httpBase: string;
	readonly wsBase: string;
	readonly query: Readonly<Record<string, string>>;
	readonly credentials: boolean;
}

export interface DeviceFrameSink {
	readonly present: (source: CanvasImageSource, width: number, height: number) => boolean;
}

export interface DeviceStreamEvents {
	readonly onDuoControl?: (state: DuoControlState) => void;
	readonly onDuoUnavailable?: (detail?: string) => void;
	readonly onStatus: (status: DeviceStreamStatus, detail?: string) => void;
	readonly onScreen: (screen: DeviceScreenSize) => void;
	readonly onUnauthorized: () => void;
	readonly onMjpegFallback: (url: string) => void;
	readonly onInputConnected: (connected: boolean, detail?: string) => void;
}

export type DeviceHardwareButton = 'home' | 'back' | 'recents' | 'power' | 'appSwitcher';

export interface DeviceStreamClient {
	readonly start: () => void;
	readonly stop: () => void;
	readonly setMjpegImage: (image: HTMLImageElement | null) => void;
	/** Normalized 0..1 coordinates in the displayed frame. */
	readonly sendTouch: (phase: 'begin' | 'move' | 'end', x: number, y: number) => void;
	readonly sendKey: (event: KeyboardEvent, phase: 'down' | 'up') => void;
	readonly pressButton: (button: DeviceHardwareButton) => void;
	readonly rotate: () => void;
	readonly setOrientation: (orientation: DeviceOrientation) => void;
	readonly controlDuo: (command: DuoCommand) => void;
	readonly sendRawTouch: (phase: 'begin' | 'move' | 'end', x: number, y: number) => void;
}

export function createDeviceStreamClient(
	target: { readonly platform: 'ios' | 'android'; readonly deviceId: string; readonly access: DeviceHubAccess },
	output: HTMLCanvasElement | DeviceFrameSink,
	events: DeviceStreamEvents,
): DeviceStreamClient;

export function createCanvasFrameSink(canvas: HTMLCanvasElement, onFrame?: (width: number, height: number) => void): DeviceFrameSink;

export function duoFoldState(screen: Pick<DeviceScreenSize, 'orientation' | 'screenId' | 'hingeAngle' | 'hingePose'>): {
	readonly fold: 'closed' | 'open' | 'half';
	readonly stand: boolean;
	readonly phoneVertical: boolean;
	readonly settled: boolean;
};

/** The orientation that keeps the phone held as it is (upright or sideways) on the display `screenId`. */
export function duoHoldOrientation(vertical: boolean, screenId: number | undefined): DeviceOrientation;

export interface DuoViewport {
	readonly setScreen: (screen: DeviceScreenSize | null) => void;
	readonly setHingePreview: (angle: number | null) => void;
	readonly controlFailed: () => void;
	readonly frame: () => void;
	readonly resetPose: () => void;
	readonly cancelInput: () => void;
	readonly dispose: () => void;
}

export function mountDuoViewport(options: {
	host: HTMLElement;
	decoded: HTMLCanvasElement;
	client: DeviceStreamClient;
	/** The .glb file's bytes (the workbench CSP blocks fetching blob: URLs). */
	modelData: ArrayBuffer;
	screen: DeviceScreenSize | null;
	label: string;
	onUnavailable: (cause?: unknown) => void;
}): DuoViewport;

export type DeviceModelId = 'iphone-18-pro' | 'iphone-18-pro-max' | 'ipad-pro-13-m5' | 'iphone-duo';
export type DeviceAssetId = DeviceModelId | 'ipad-pro-13-m5-magic-keyboard';

/** The device's .glb model, matched by exact simulator name (iOS only); null: procedural body. */
export function resolveDeviceModelId(platform: 'ios' | 'android', name: string): DeviceModelId | null;

/**
 * The .glb files (`~/.volt/device-models/<id>.glb`) the device's 3D view can use: its model and,
 * for the iPad Pro 13 (M5), the Magic Keyboard. Empty: the procedural body. "iphone-duo" belongs
 * to `mountDuoViewport`.
 */
export function deviceModelIdsFor(platform: 'ios' | 'android', name: string): DeviceAssetId[];

/** The hinge angle to show for an Android fold reading: the reported angle, else closed 0 / open 180. */
export function androidFoldAngle(fold: { readonly hingeAngle: number | null; readonly posture: string | null }): number;

export interface PhoneViewport {
	readonly setScreen: (screen: DeviceScreenSize | null) => void;
	/** Android foldables: the hinge angle (0 closed, 180 open), or null for a slab phone. */
	readonly setFoldAngle: (angle: number | null) => void;
	/** Attaches the Magic Keyboard; does nothing unless `hasKeyboard`. */
	readonly setKeyboardAttached: (attached: boolean) => void;
	/** The device has a keyboard accessory (iPad Pro 13 (M5) with both .glb files given). */
	readonly hasKeyboard: boolean;
	/** The source canvas drew a new frame (a stream frame or a polled screenshot). */
	readonly frame: () => void;
	readonly resetPose: () => void;
	readonly cancelInput: () => void;
	readonly dispose: () => void;
}

/**
 * The 3D phone or tablet over `host` for every device but the iPhone Duo: drag the screen to
 * touch it, drag outside it (or swipe two fingers) to turn it. iPhone 18 Pro / Pro Max and iPad
 * Pro 13 (M5) use their .glb model when its bytes are in `models`; every other device (or a model
 * that fails to load) gets the procedural body for its platform and size, and Android foldables
 * with a `foldAngle` the folding body. `source` stays owned by the caller, which must call
 * `frame()` after each draw into it (decoded stream frame or polled screenshot).
 */
export function mountPhoneViewport(options: {
	host: HTMLElement;
	source: HTMLCanvasElement;
	platform: 'ios' | 'android';
	name: string;
	/** .glb bytes by model id (the workbench CSP blocks fetching blob: URLs). */
	models: Partial<Record<DeviceModelId, ArrayBuffer>>;
	/** ipad-pro-13-m5-magic-keyboard.glb. */
	keyboard?: ArrayBuffer;
	keyboardAttached?: boolean;
	/** Normalized 0..1 point in the displayed frame, as `DeviceStreamClient.sendTouch` takes. */
	touch: (phase: 'begin' | 'move' | 'end', x: number, y: number) => void;
	screen: DeviceScreenSize | null;
	foldAngle: number | null;
	label: string;
	/** WebGL is unavailable or the context was lost: show the flat view. */
	onUnavailable: (cause?: unknown) => void;
}): PhoneViewport;
