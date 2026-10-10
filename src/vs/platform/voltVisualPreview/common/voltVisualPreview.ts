/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltVisualPreviewService = createDecorator<IVoltVisualPreviewService>('voltVisualPreviewService');
export const VOLT_VISUAL_PREVIEW_CHANNEL_NAME = 'voltVisualPreview';

/** Page widths an agent may preview at, in CSS px. */
export const VOLT_VISUAL_MIN_WIDTH = 240;
export const VOLT_VISUAL_MAX_WIDTH = 1600;
/** Tallest capture; a taller page is reported in full but screenshotted to here. */
export const VOLT_VISUAL_MAX_CAPTURE = 2400;

export interface IVoltVisualPreviewRequest {
	/** A complete page, theme and Volt Charts already injected. */
	readonly html: string;
	readonly width: number;
	/** Also measure the page at these widths (no screenshot). */
	readonly measureWidths?: readonly number[];
	/** Skip the screenshot: only heights and console output. */
	readonly measureOnly?: boolean;
	/** Opaque color behind the page (the chat surface): pages leave their own background transparent. */
	readonly background?: { readonly r: number; readonly g: number; readonly b: number };
}

export interface IVoltVisualConsoleMessage {
	readonly level: 'log' | 'info' | 'warning' | 'error';
	readonly text: string;
}

export interface IVoltVisualPreview {
	/** Base64 PNG of the top `capturedHeight` px, one image pixel per CSS pixel. Absent with `measureOnly`. */
	readonly png?: string;
	readonly width: number;
	/** The height the page needs at `width` to show without scrolling. */
	readonly contentHeight: number;
	readonly capturedHeight: number;
	/** `[width, contentHeight]` for each of `measureWidths`. */
	readonly heights: readonly (readonly [number, number])[];
	/** Console output and uncaught errors, in order. */
	readonly console: readonly IVoltVisualConsoleMessage[];
}

//#region Headless pages

/** The emulated `prefers-color-scheme` of a headless page. */
export type VoltPageScheme = 'light' | 'dark';

export interface IVoltPageOpenRequest {
	/** An http(s) or file URL. */
	readonly url: string;
	/** The viewport, in CSS px. */
	readonly width: number;
	readonly height: number;
	/** Image pixels per CSS pixel of the captures: 2 keeps phone screens crisp. Default 1. */
	readonly scale?: number;
	/** A phone or tablet: touch input, `pointer: coarse` and a mobile user agent. */
	readonly mobile?: boolean;
	/** Unset follows the OS. */
	readonly scheme?: VoltPageScheme;
	/** How long the load may take, ms (default 20s). The page stays open either way; `loaded` tells. */
	readonly timeoutMs?: number;
}

export interface IVoltPageState {
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	/** HTTP status of the page's document, when it came over HTTP. */
	readonly status?: number;
	/** The page finished loading and went quiet (no requests, no DOM changes) in time. */
	readonly loaded: boolean;
}

export interface IVoltPageOpened extends IVoltPageState {
	readonly id: string;
}

/** Trusted input, sent the way a user would (DevTools protocol), so it works without window focus. */
export type VoltPageInput =
	| { readonly kind: 'click'; readonly x: number; readonly y: number; readonly button?: 'left' | 'right' | 'middle'; readonly clickCount?: number }
	| { readonly kind: 'move'; readonly x: number; readonly y: number }
	| { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
	/** A key or chord: "Enter", "Escape", "a", "Meta+a", "Shift+Tab". */
	| { readonly kind: 'key'; readonly combo: string };

export interface IVoltPageEvaluation<T> {
	readonly value?: T;
	/** The script threw, or did not answer within its time. */
	readonly error?: string;
	/** A navigation is in flight (the act engine waits for it). */
	readonly loading: boolean;
}

export interface IVoltPageCaptureRequest {
	/** The page's whole scroll height, up to `maxHeight` CSS px, instead of the viewport. */
	readonly fullPage?: boolean;
	readonly maxHeight?: number;
	/** JPEG quality, 30-100. Default 85. */
	readonly quality?: number;
}

export interface IVoltPageCapture {
	/** Base64 JPEG. */
	readonly jpeg: string;
	/** In image pixels (CSS px times the page's scale). */
	readonly width: number;
	readonly height: number;
}

//#endregion

/**
 * Renders agent pages offscreen, in Volt's own Chromium (no download), so render tools can
 * measure a page and agents can see a screenshot of it before they publish. Main process only:
 * the workbench renderer cannot open windows.
 *
 * Headless pages load the user's own app the same way, signed in like the in-app browser (they
 * share its session), at any viewport and color scheme, and take the in-app browser's act steps.
 */
export interface IVoltVisualPreviewService {
	readonly _serviceBrand: undefined;
	capture(request: IVoltVisualPreviewRequest): Promise<IVoltVisualPreview>;

	openPage(request: IVoltPageOpenRequest): Promise<IVoltPageOpened>;
	/** Runs an expression (or a promise) in the page and returns its JSON value. */
	evaluatePage<T>(id: string, expression: string, timeoutMs?: number): Promise<IVoltPageEvaluation<T>>;
	inputPage(id: string, input: readonly VoltPageInput[]): Promise<void>;
	/** Types text at the focus as one input, like an IME commit. */
	insertPageText(id: string, text: string): Promise<boolean>;
	/** A URL, or `back` / `reload`; resolves once the page went quiet (or the time is up). */
	navigatePage(id: string, target: string, timeoutMs?: number): Promise<IVoltPageState>;
	/** Waits for a load in flight to finish and the page to go quiet. */
	waitForPage(id: string, timeoutMs: number): Promise<IVoltPageState>;
	/** Switches `prefers-color-scheme` without a reload; the page's media queries and listeners follow. */
	setPageScheme(id: string, scheme: VoltPageScheme | undefined): Promise<void>;
	capturePage(id: string, request?: IVoltPageCaptureRequest): Promise<IVoltPageCapture>;
	/** Errors and warnings the page logged since the last call. */
	takePageConsole(id: string): Promise<IVoltVisualConsoleMessage[]>;
	closePage(id: string): Promise<void>;
}
