/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { fitWithin, IRgbaImage } from '../../common/tools/imageAnalysis.js';

/**
 * Decoding and encoding for the design tools, with the renderer's own codecs (canvas). The pixel
 * math lives in `imageAnalysis.ts`.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** Files the image tools read are capped; a design export is a few MB at most. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export function sniffImageType(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return 'image/png';
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return 'image/webp';
	}
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return 'image/gif';
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return 'image/bmp';
	}
	return undefined;
}

export function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
	const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
	if (!match || !match[2]) {
		throw new Error('Not a base64 image data URL.');
	}
	return { bytes: decodeBase64(match[3]).buffer, mime: match[1] };
}

async function bitmapOf(bytes: Uint8Array, mime: string | undefined, size?: { width: number; height: number }): Promise<ImageBitmap> {
	const type = mime ?? sniffImageType(bytes);
	if (!type || !type.startsWith('image/') || type === 'image/svg+xml') {
		throw new Error('The file is not a PNG, JPEG, WebP, GIF or BMP image.');
	}
	const blob = new Blob([new Uint8Array(bytes)], { type });
	try {
		return size
			? await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' })
			: await createImageBitmap(blob);
	} catch {
		throw new Error('The image could not be decoded.');
	}
}

function pixelsOf(bitmap: ImageBitmap): IRgbaImage {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) {
		throw new Error('No 2D canvas is available to decode the image.');
	}
	context.drawImage(bitmap, 0, 0);
	return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

/** Decodes image bytes to RGBA; `size` resamples while decoding (cheap for big captures). */
export async function decodeImage(bytes: Uint8Array, mime?: string, size?: { width: number; height: number }): Promise<IRgbaImage> {
	const bitmap = await bitmapOf(bytes, mime, size);
	try {
		return pixelsOf(bitmap);
	} finally {
		bitmap.close();
	}
}

export async function decodeDataUrl(dataUrl: string, size?: { width: number; height: number }): Promise<IRgbaImage> {
	const { bytes, mime } = dataUrlBytes(dataUrl);
	return decodeImage(bytes, mime, size);
}

async function canvasToDataUrl(canvas: OffscreenCanvas, format: ImageFormat, quality: number): Promise<string> {
	const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: format === 'png' ? undefined : quality });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return `data:${blob.type || `image/${format}`};base64,${encodeBase64(VSBuffer.wrap(bytes))}`;
}

export interface IImageLabel {
	readonly x: number;
	readonly y: number;
	readonly text: string;
}

/** Encodes RGBA as a data URL, optionally with small numbered tags (heatmap regions). */
export async function encodeImage(image: IRgbaImage, format: ImageFormat = 'jpeg', quality = 0.82, labels: readonly IImageLabel[] = []): Promise<string> {
	const canvas = new OffscreenCanvas(image.width, image.height);
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('No 2D canvas is available to encode the image.');
	}
	const pixels = new Uint8ClampedArray(image.width * image.height * 4);
	pixels.set(image.data);
	context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
	if (labels.length) {
		context.font = 'bold 12px sans-serif';
		context.textBaseline = 'top';
		for (const label of labels) {
			const w = Math.ceil(context.measureText(label.text).width) + 6;
			context.fillStyle = 'rgb(255, 160, 0)';
			context.fillRect(label.x, label.y, w, 15);
			context.fillStyle = '#000';
			context.fillText(label.text, label.x + 3, label.y + 1);
		}
	}
	return canvasToDataUrl(canvas, format, quality);
}

export interface IScaledShot {
	readonly dataUrl: string;
	readonly width: number;
	readonly height: number;
	/** Size before scaling (device pixels of the capture). */
	readonly sourceWidth: number;
	readonly sourceHeight: number;
}

export interface IScaleShotOptions {
	/** Longest side of the result. */
	readonly maxSide: number;
	/** Scale to this width first (the page's CSS width), so one image pixel is one CSS pixel. */
	readonly targetWidth?: number;
	readonly format?: ImageFormat;
	readonly quality?: number;
	/** Crop to this rectangle (in `targetWidth` space) before fitting. */
	readonly crop?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/**
 * A screenshot sized for a model: Retina captures come down to CSS pixels, then to `maxSide`,
 * as JPEG by default. A 2000x1600 PNG (several MB, ~4k tokens) becomes ~1000x800 JPEG (~100 KB).
 */
export async function scaleScreenshot(dataUrl: string, options: IScaleShotOptions): Promise<IScaledShot> {
	const { bytes, mime } = dataUrlBytes(dataUrl);
	const full = await bitmapOf(bytes, mime);
	try {
		const sourceWidth = full.width;
		const sourceHeight = full.height;
		const css = options.targetWidth && options.targetWidth > 0 ? options.targetWidth / sourceWidth : 1;
		let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight;
		if (options.crop) {
			sx = Math.max(0, Math.floor(options.crop.x / css));
			sy = Math.max(0, Math.floor(options.crop.y / css));
			sw = Math.max(1, Math.min(sourceWidth - sx, Math.ceil(options.crop.w / css)));
			sh = Math.max(1, Math.min(sourceHeight - sy, Math.ceil(options.crop.h / css)));
		}
		const wanted = fitWithin(Math.max(1, Math.round(sw * Math.min(1, css))), Math.max(1, Math.round(sh * Math.min(1, css))), options.maxSide);
		const canvas = new OffscreenCanvas(wanted.width, wanted.height);
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('No 2D canvas is available to scale the screenshot.');
		}
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = 'high';
		context.drawImage(full, sx, sy, sw, sh, 0, 0, wanted.width, wanted.height);
		const format = options.format ?? 'jpeg';
		return {
			dataUrl: await canvasToDataUrl(canvas, format, options.quality ?? 0.8),
			width: wanted.width,
			height: wanted.height,
			sourceWidth,
			sourceHeight,
		};
	} finally {
		full.close();
	}
}

/** Enlarges a small crop (nearest neighbour up to 4x) so the model can read fine text. */
export async function zoomImage(image: IRgbaImage, maxSide = 800, format: ImageFormat = 'png'): Promise<string> {
	const factor = Math.max(1, Math.min(4, Math.floor(maxSide / Math.max(image.width, image.height))));
	const source = new OffscreenCanvas(image.width, image.height);
	const sourceContext = source.getContext('2d');
	const target = new OffscreenCanvas(image.width * factor, image.height * factor);
	const context = target.getContext('2d');
	if (!sourceContext || !context) {
		throw new Error('No 2D canvas is available to zoom the image.');
	}
	const pixels = new Uint8ClampedArray(image.width * image.height * 4);
	pixels.set(image.data);
	sourceContext.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
	context.imageSmoothingEnabled = false;
	context.drawImage(source, 0, 0, target.width, target.height);
	if (target.width > maxSide * 1.5 || target.height > maxSide * 1.5) {
		const size = fitWithin(target.width, target.height, maxSide);
		const fitted = new OffscreenCanvas(size.width, size.height);
		fitted.getContext('2d')?.drawImage(target, 0, 0, size.width, size.height);
		return canvasToDataUrl(fitted, format, 0.85);
	}
	return canvasToDataUrl(target, format, 0.85);
}
