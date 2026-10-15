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
};

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
	modelUrl: string;
	screen: DeviceScreenSize | null;
	label: string;
	onUnavailable: (cause?: unknown) => void;
}): DuoViewport;
