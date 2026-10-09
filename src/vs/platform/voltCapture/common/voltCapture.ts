/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltCaptureService = createDecorator<IVoltCaptureService>('voltCaptureService');
export const VOLT_CAPTURE_CHANNEL_NAME = 'voltCapture';

export interface IVoltCaptureSource {
	/** desktopCapturer's id: `window:<native id>:0` or `screen:<id>:0`. Also the `chromeMediaSourceId` to record it. */
	readonly id: string;
	readonly name: string;
	readonly kind: 'window' | 'screen';
	/** A Volt window (capturable without the OS screen recording permission). */
	readonly own: boolean;
}

export interface IVoltCaptureImage {
	/** Base64 PNG: a VSBuffer inside an object does not survive the IPC channel. */
	readonly pngBase64: string;
	readonly width: number;
	readonly height: number;
	readonly source: IVoltCaptureSource;
	/** How it was taken, for the result text: `desktopCapturer`, `capturePage`, `screencapture`, `import`. */
	readonly method: string;
}

/**
 * Screenshots of windows and screens on every platform (desktopCapturer, with Volt's own pages
 * and the OS tools as fallbacks). Recording runs in the window with `getUserMedia` on a source id
 * from `listSources`.
 */
export interface IVoltCaptureService {
	readonly _serviceBrand: undefined;
	listSources(kinds?: readonly ('window' | 'screen')[]): Promise<IVoltCaptureSource[]>;
	/** `maxSide` bounds the longest side in pixels (default 1920). */
	capture(sourceId: string, maxSide?: number): Promise<IVoltCaptureImage>;
	/** The source id of the window that hosts `windowId` (a Volt window), for recording itself. */
	sourceIdOfWindow(windowId: number): Promise<string | undefined>;
	/**
	 * Lets the next `getDisplayMedia` call from a Volt window capture that window's own page, which
	 * works without the OS screen recording permission. Expires after a few seconds.
	 */
	allowOwnDisplayCapture(): Promise<void>;
}

/** `window:1234:0` → `1234`: the CGWindowID (macOS), HWND (Windows) or X window id (Linux). */
export function nativeWindowId(sourceId: string): string | undefined {
	const match = /^window:(\d+):/.exec(sourceId);
	return match ? match[1] : undefined;
}

/**
 * The OS tool that captures one window by its native id into `out` (PNG), when desktopCapturer
 * returns nothing (no permission, or an empty thumbnail): macOS `screencapture`, Linux ImageMagick
 * `import`. Windows has none without a helper; undefined there.
 */
export function platformCaptureCommand(platform: string, sourceId: string, out: string): { file: string; args: string[] } | undefined {
	const id = nativeWindowId(sourceId);
	const screen = /^screen:(\d+):/.exec(sourceId)?.[1];
	if (platform === 'darwin') {
		if (id) {
			return { file: 'screencapture', args: ['-x', '-o', `-l${id}`, '-t', 'png', out] };
		}
		if (screen !== undefined) {
			return { file: 'screencapture', args: ['-x', '-t', 'png', out] };
		}
		return undefined;
	}
	if (platform === 'linux') {
		if (id) {
			return { file: 'import', args: ['-window', `0x${Number(id).toString(16)}`, `png:${out}`] };
		}
		if (screen !== undefined) {
			return { file: 'import', args: ['-window', 'root', `png:${out}`] };
		}
	}
	return undefined;
}

/** The size that fits `width`×`height` into `maxSide` without upscaling. */
export function fitSize(width: number, height: number, maxSide: number): { width: number; height: number } {
	const scale = Math.min(1, maxSide / Math.max(1, width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
