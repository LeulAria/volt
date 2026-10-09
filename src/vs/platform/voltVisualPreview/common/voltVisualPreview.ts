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

/**
 * Renders agent pages offscreen, in Volt's own Chromium (no download), so render tools can
 * measure a page and agents can see a screenshot of it before they publish. Main process only:
 * the workbench renderer cannot open windows.
 */
export interface IVoltVisualPreviewService {
	readonly _serviceBrand: undefined;
	capture(request: IVoltVisualPreviewRequest): Promise<IVoltVisualPreview>;
}
