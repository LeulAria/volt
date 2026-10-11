/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * What a display shows under the live page: the system's status bar, home indicator, camera
 * cutouts and (macOS) menu bar, drawn into a canvas texture in the page's own colors. While the
 * page can't sit on the glass (the device is turned away, half folded, or animating) the last
 * picture of the page is drawn in its place.
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from "three";
import type { IDeviceScreen } from "../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import { roundedRect, toCanvas } from "./shapes.ts";

export type Snapshot = CanvasImageSource & { readonly width: number; readonly height: number };

export interface ScreenPaint {
	/** The page's top and bottom colors (status bar and home bar sit on them). */
	readonly top: string;
	readonly bottom: string;
	/** The page as last captured, at its viewport's aspect. */
	readonly snapshot?: Snapshot;
	readonly landscape: boolean;
	/** Texture pixels per CSS px. */
	readonly resolution: number;
	/** Turned off: a black glass. */
	readonly off?: boolean;
}

const APPLE_FONT = '-apple-system, "SF Pro Text", "SF Pro", "Helvetica Neue", system-ui, sans-serif';
const ANDROID_FONT = '"Google Sans", Roboto, "Helvetica Neue", system-ui, sans-serif';

/** Relative luminance of a CSS color, 0..1 (unknown colors read as light). */
export function luminance(color: string): number {
	const ctx = scratch();
	ctx.fillStyle = "#ffffff";
	ctx.fillStyle = color;
	const value = ctx.fillStyle as string;
	let rgb: number[] | undefined;
	if (value.startsWith("#")) {
		const hex = value.slice(1);
		rgb = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
	} else {
		const match = value.match(/rgba?\(([^)]+)\)/);
		if (match) {
			const parts = match[1].split(/[\s,/]+/).map(Number);
			if (parts.length > 3 && parts[3] < 0.2) {
				return 1;
			}
			rgb = parts.slice(0, 3);
		}
	}
	if (!rgb) {
		return 1;
	}
	const [r, g, b] = rgb.map((channel) => {
		const v = channel / 255;
		return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

let scratchContext: CanvasRenderingContext2D | undefined;
function scratch(): CanvasRenderingContext2D {
	scratchContext ??= document.createElement("canvas").getContext("2d")!;
	return scratchContext;
}

export interface ScreenExtras {
	/** A laptop's notch, CSS px. */
	readonly notch?: { readonly width: number; readonly height: number };
}

/** One display's texture. */
export class ScreenCanvas {
	readonly canvas: HTMLCanvasElement;
	readonly texture: CanvasTexture;
	private paint: ScreenPaint | undefined;

	constructor(
		readonly spec: IDeviceScreen,
		private readonly extras: ScreenExtras = {},
	) {
		this.canvas = document.createElement("canvas");
		this.canvas.width = Math.max(2, Math.round(spec.width));
		this.canvas.height = Math.max(2, Math.round(spec.height));
		this.texture = new CanvasTexture(this.canvas);
		this.texture.colorSpace = SRGBColorSpace;
		this.texture.minFilter = LinearMipmapLinearFilter;
		this.texture.magFilter = LinearFilter;
		this.texture.anisotropy = 8;
	}

	/** Redraws the display. Cheap enough to call on every color or picture change. */
	draw(paint: ScreenPaint): void {
		this.paint = paint;
		const { spec } = this;
		const resolution = Math.max(0.5, Math.min(paint.resolution, 4096 / Math.max(spec.width, spec.height)));
		const width = Math.round(spec.width * resolution);
		const height = Math.round(spec.height * resolution);
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
			// Three needs a fresh upload when the size changes.
			this.texture.dispose();
		}
		const ctx = this.canvas.getContext("2d")!;
		ctx.setTransform(resolution, 0, 0, resolution, 0, 0);
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, spec.width, spec.height);
		if (!paint.off) {
			this.drawPage(ctx, paint);
			if (!paint.landscape || spec.system === "macos") {
				this.drawSystem(ctx, paint);
			}
		}
		this.drawCutout(ctx);
		this.texture.needsUpdate = true;
	}

	redraw(): void {
		if (this.paint) {
			this.draw(this.paint);
		}
	}

	dispose(): void {
		this.texture.dispose();
		this.canvas.width = this.canvas.height = 1;
	}

	/** The page region of the display, portrait CSS px. */
	pageRect(): { x: number; y: number; width: number; height: number } {
		const { spec } = this;
		return { x: 0, y: spec.safeTop, width: spec.width, height: spec.height - spec.safeTop - spec.safeBottom };
	}

	private drawPage(ctx: CanvasRenderingContext2D, paint: ScreenPaint): void {
		const { spec } = this;
		// Status bar and home bar take the page's own edge colors, as they do on the device.
		ctx.fillStyle = paint.top;
		ctx.fillRect(0, 0, spec.width, spec.safeTop + 1);
		ctx.fillStyle = paint.bottom;
		ctx.fillRect(0, spec.height - spec.safeBottom - 1, spec.width, spec.safeBottom + 1);
		const rect = this.pageRect();
		ctx.fillStyle = paint.bottom;
		ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
		const snapshot = paint.snapshot;
		if (!snapshot || !snapshot.width || !snapshot.height) {
			return;
		}
		ctx.save();
		ctx.beginPath();
		ctx.rect(rect.x, rect.y, rect.width, rect.height);
		ctx.clip();
		if (paint.landscape) {
			// The page is upright for a viewer holding the device turned a quarter left: its top runs
			// down the display's right edge.
			ctx.translate(rect.x + rect.width, rect.y);
			ctx.rotate(Math.PI / 2);
			this.cover(ctx, snapshot, rect.height, rect.width);
		} else {
			ctx.translate(rect.x, rect.y);
			this.cover(ctx, snapshot, rect.width, rect.height);
		}
		ctx.restore();
	}

	/** Draws `image` to fill width × height, cropping the overflow (it matches unless the viewport is changing). */
	private cover(ctx: CanvasRenderingContext2D, image: Snapshot, width: number, height: number): void {
		const scale = Math.max(width / image.width, height / image.height);
		const w = image.width * scale;
		const h = image.height * scale;
		ctx.drawImage(image, (width - w) / 2, 0, w, h);
	}

	private drawSystem(ctx: CanvasRenderingContext2D, paint: ScreenPaint): void {
		const { spec } = this;
		const topInk = luminance(paint.top) < 0.4 ? "#ffffff" : "#000000";
		const bottomInk = luminance(paint.bottom) < 0.4 ? "#ffffff" : "#000000";
		switch (spec.system) {
			case "ios":
				this.iosStatus(ctx, topInk);
				this.homeIndicator(ctx, bottomInk, Math.min(144, spec.width * 0.36), 5, 8);
				break;
			case "ipados":
				this.ipadStatus(ctx, topInk);
				if (spec.safeBottom > 0) {
					this.homeIndicator(ctx, bottomInk, Math.min(320, spec.width * 0.3), 5, 8);
				}
				break;
			case "android":
				this.androidStatus(ctx, topInk);
				if (spec.safeBottom > 0) {
					ctx.globalAlpha = 0.75;
					this.homeIndicator(ctx, bottomInk, Math.min(120, spec.width * 0.26), 4, Math.max(6, (spec.safeBottom - 4) / 2));
					ctx.globalAlpha = 1;
				}
				break;
			case "macos":
				this.macMenuBar(ctx, paint.top);
				break;
			case "windows":
				if (spec.safeBottom > 0) {
					this.windowsTaskbar(ctx, paint.bottom);
				}
				break;
		}
	}

	/** Where the status bar's content is centered vertically: on the island or hole, or mid-bar. */
	private statusCenterY(): number {
		const { spec } = this;
		const cutout = spec.cutout;
		if (cutout?.kind === "island") {
			return cutout.top + cutout.height / 2;
		}
		if (cutout?.kind === "punch") {
			return cutout.top + cutout.diameter / 2;
		}
		if (cutout?.kind === "notch") {
			return Math.min(spec.safeTop, cutout.height) / 2 + 2;
		}
		return spec.safeTop / 2 + 1;
	}

	private iosStatus(ctx: CanvasRenderingContext2D, ink: string): void {
		const { spec } = this;
		const cutout = spec.cutout;
		const y = this.statusCenterY();
		const centerGap = cutout?.kind === "island" || cutout?.kind === "notch" ? cutout.width : 0;
		const homeButton = !centerGap && spec.safeTop <= 24;
		ctx.fillStyle = ink;
		ctx.strokeStyle = ink;
		ctx.textBaseline = "middle";
		if (homeButton) {
			// iPhone SE: a thin bar, carrier and Wi-Fi left, time centered, battery right.
			ctx.font = `600 12px ${APPLE_FONT}`;
			ctx.textAlign = "center";
			ctx.fillText("9:41 AM", spec.width / 2, y);
			this.signalBars(ctx, 7, y - 4, 0.75);
			this.wifi(ctx, 30, y, 0.75);
			this.battery(ctx, spec.width - 30, y, 0.85);
			return;
		}
		const earWidth = (spec.width - centerGap) / 2;
		const leftCenter = earWidth / 2 + (cutout?.kind === "island" ? 6 : 2);
		const rightCenter = spec.width - earWidth / 2 - (cutout?.kind === "island" ? 4 : 0);
		ctx.font = `600 17px ${APPLE_FONT}`;
		ctx.textAlign = "center";
		ctx.fillText("9:41", leftCenter, y + 0.5);
		// Signal, Wi-Fi and battery as one group centered in the right ear.
		const groupWidth = 18 + 6 + 17 + 6 + 27;
		let x = rightCenter - groupWidth / 2;
		this.signalBars(ctx, x, y - 6, 1);
		x += 24;
		this.wifi(ctx, x + 8.5, y, 1);
		x += 23;
		this.battery(ctx, x + 13.5, y, 1);
	}

	private ipadStatus(ctx: CanvasRenderingContext2D, ink: string): void {
		const { spec } = this;
		const y = spec.safeTop / 2 + 1;
		ctx.fillStyle = ink;
		ctx.strokeStyle = ink;
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		ctx.font = `600 12px ${APPLE_FONT}`;
		ctx.fillText("9:41", 20, y);
		const timeWidth = ctx.measureText("9:41").width;
		ctx.font = `500 12px ${APPLE_FONT}`;
		ctx.fillText("Fri Oct 10", 20 + timeWidth + 6, y);
		let x = spec.width - 20;
		this.battery(ctx, x - 13, y, 0.85);
		x -= 30;
		ctx.textAlign = "right";
		ctx.font = `500 12px ${APPLE_FONT}`;
		ctx.fillText("100%", x, y);
		x -= ctx.measureText("100%").width + 14;
		this.wifi(ctx, x, y, 0.8);
	}

	private androidStatus(ctx: CanvasRenderingContext2D, ink: string): void {
		const { spec } = this;
		const y = this.statusCenterY();
		const inset = Math.max(16, Math.min(28, spec.cornerRadius * 0.55));
		ctx.fillStyle = ink;
		ctx.strokeStyle = ink;
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		ctx.font = `500 14px ${ANDROID_FONT}`;
		ctx.fillText("12:30", inset, y + 0.5);
		// Battery, signal and Wi-Fi from the right edge in.
		let x = spec.width - inset;
		// Battery: a tall rounded cell.
		ctx.beginPath();
		toCanvas(ctx, roundedRect(x - 8, y - 7, 8, 14, 1.6));
		ctx.fill();
		ctx.fillRect(x - 5.6, y - 8.4, 3.2, 1.6);
		x -= 14;
		ctx.beginPath();
		ctx.moveTo(x, y - 6.5);
		ctx.lineTo(x, y + 6.5);
		ctx.lineTo(x - 13, y + 6.5);
		ctx.closePath();
		ctx.fill();
		x -= 19;
		ctx.beginPath();
		ctx.moveTo(x - 7.5, y + 6);
		ctx.lineTo(x - 15, y - 3.4);
		ctx.quadraticCurveTo(x - 7.5, y - 10, x, y - 3.4);
		ctx.closePath();
		ctx.fill();
	}

	private macMenuBar(ctx: CanvasRenderingContext2D, top: string): void {
		const { spec } = this;
		const height = spec.safeTop;
		// The menu bar takes on the desktop under it; with Safari's page beneath, the page's color.
		const dark = luminance(top) < 0.4;
		ctx.fillStyle = top;
		ctx.fillRect(0, 0, spec.width, height);
		ctx.fillStyle = dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.35)";
		ctx.fillRect(0, 0, spec.width, height);
		const ink = dark ? "#ffffff" : "#000000";
		ctx.fillStyle = ink;
		ctx.strokeStyle = ink;
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		const y = height / 2 + 0.5;
		this.appleLogo(ctx, 20, y, 15);
		let x = 46;
		const notchLeft = (spec.width - (this.extras.notch?.width ?? 0)) / 2 - 12;
		ctx.font = `700 13.5px ${APPLE_FONT}`;
		ctx.fillText("Safari", x, y);
		x += ctx.measureText("Safari").width + 20;
		ctx.font = `400 13.5px ${APPLE_FONT}`;
		for (const item of ["File", "Edit", "View", "History", "Bookmarks", "Window", "Help"]) {
			const w = ctx.measureText(item).width;
			if (x + w > notchLeft) {
				break;
			}
			ctx.fillText(item, x, y);
			x += w + 20;
		}
		ctx.textAlign = "right";
		let right = spec.width - 16;
		ctx.fillText("Fri Oct 10  9:41 AM", right, y);
		right -= ctx.measureText("Fri Oct 10  9:41 AM").width + 18;
		// Control Center: two stacked pills.
		ctx.lineWidth = 1.3;
		ctx.beginPath();
		toCanvas(ctx, roundedRect(right - 14, y - 6, 14, 5, 2.5));
		toCanvas(ctx, roundedRect(right - 14, y + 1, 14, 5, 2.5));
		ctx.stroke();
		right -= 30;
		this.wifi(ctx, right - 8, y, 0.95);
		right -= 30;
		this.battery(ctx, right - 13, y, 0.95);
		right -= 40;
		// Spotlight.
		ctx.lineWidth = 1.6;
		ctx.beginPath();
		ctx.arc(right - 8, y - 1.5, 5, 0, Math.PI * 2);
		ctx.moveTo(right - 4.4, y + 2.2);
		ctx.lineTo(right - 0.5, y + 6);
		ctx.stroke();
	}

	private windowsTaskbar(ctx: CanvasRenderingContext2D, color: string): void {
		const { spec } = this;
		const height = spec.safeBottom;
		const top = spec.height - height;
		const dark = luminance(color) < 0.4;
		ctx.fillStyle = dark ? "#202020" : "#eef0f3";
		ctx.fillRect(0, top, spec.width, height);
		const icons = 6;
		const size = Math.min(26, height * 0.6);
		const gap = 14;
		let x = spec.width / 2 - (icons * size + (icons - 1) * gap) / 2;
		const palette = ["#0a6ed1", "#f2b31b", "#3a96dd", "#e74856", "#16c60c", "#8764b8"];
		for (let i = 0; i < icons; i++) {
			ctx.fillStyle = palette[i];
			ctx.beginPath();
			toCanvas(ctx, roundedRect(x, top + (height - size) / 2, size, size, 5));
			ctx.fill();
			x += size + gap;
		}
		ctx.fillStyle = dark ? "#fff" : "#000";
		ctx.font = `400 12px "Segoe UI", ${APPLE_FONT}`;
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		ctx.fillText("9:41 AM", spec.width - 14, top + height / 2);
	}

	private homeIndicator(ctx: CanvasRenderingContext2D, ink: string, width: number, height: number, fromBottom: number): void {
		const { spec } = this;
		ctx.fillStyle = ink;
		ctx.beginPath();
		toCanvas(ctx, roundedRect((spec.width - width) / 2, spec.height - fromBottom - height, width, height, height / 2));
		ctx.fill();
	}

	private drawCutout(ctx: CanvasRenderingContext2D): void {
		const { spec } = this;
		const cutout = spec.cutout;
		ctx.fillStyle = "#000";
		if (cutout?.kind === "island") {
			const x = (spec.width - cutout.width) / 2;
			ctx.beginPath();
			toCanvas(ctx, roundedRect(x, cutout.top, cutout.width, cutout.height, cutout.height / 2));
			ctx.fill();
			// The front camera's lens, a faint blue glint on the right of the pill.
			this.lensGlint(ctx, x + cutout.width - cutout.height / 2 - 2, cutout.top + cutout.height / 2, cutout.height * 0.2);
		} else if (cutout?.kind === "notch") {
			const x = (spec.width - cutout.width) / 2;
			const r = cutout.radius ?? 20;
			ctx.beginPath();
			// The notch's top corners flare out into the display edge.
			ctx.moveTo(x - 6, 0);
			ctx.quadraticCurveTo(x, 0, x, 6);
			ctx.lineTo(x, cutout.height - r);
			ctx.quadraticCurveTo(x, cutout.height, x + r, cutout.height);
			ctx.lineTo(x + cutout.width - r, cutout.height);
			ctx.quadraticCurveTo(x + cutout.width, cutout.height, x + cutout.width, cutout.height - r);
			ctx.lineTo(x + cutout.width, 6);
			ctx.quadraticCurveTo(x + cutout.width, 0, x + cutout.width + 6, 0);
			ctx.closePath();
			ctx.fill();
			this.lensGlint(ctx, x + cutout.width * 0.68, cutout.height * 0.45, 3.4);
		} else if (cutout?.kind === "punch") {
			const cx = cutout.x ?? spec.width / 2;
			const cy = cutout.top + cutout.diameter / 2;
			ctx.beginPath();
			ctx.arc(cx, cy, cutout.diameter / 2, 0, Math.PI * 2);
			ctx.fill();
			this.lensGlint(ctx, cx, cy, cutout.diameter * 0.28);
		}
		const notch = this.extras.notch;
		if (notch) {
			const x = (spec.width - notch.width) / 2;
			ctx.fillStyle = "#000";
			ctx.beginPath();
			toCanvas(ctx, roundedRect(x, -12, notch.width, notch.height + 12, [0, 0, 9, 9]));
			ctx.fill();
			this.lensGlint(ctx, spec.width / 2, notch.height / 2, 2.4);
		}
	}

	private lensGlint(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
		const gradient = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
		gradient.addColorStop(0, "rgba(70, 86, 120, 0.9)");
		gradient.addColorStop(0.5, "rgba(18, 22, 34, 0.9)");
		gradient.addColorStop(1, "rgba(0, 0, 0, 1)");
		ctx.fillStyle = gradient;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = "#000";
	}

	private signalBars(ctx: CanvasRenderingContext2D, x: number, top: number, scale: number): void {
		const bars: [number, number, number][] = [[0, 8, 4], [5, 5.5, 6.5], [10, 3, 9], [15, 0, 12]];
		for (const [dx, dy, h] of bars) {
			ctx.beginPath();
			toCanvas(ctx, roundedRect(x + dx * scale, top + dy * scale, 3 * scale, h * scale, 1 * scale));
			ctx.fill();
		}
	}

	private wifi(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number): void {
		const baseY = cy + 5.6 * scale;
		ctx.save();
		ctx.lineCap = "round";
		ctx.lineWidth = 1.9 * scale;
		ctx.beginPath();
		ctx.moveTo(cx, baseY);
		ctx.arc(cx, baseY, 4 * scale, -Math.PI * 0.75, -Math.PI * 0.25);
		ctx.closePath();
		ctx.fill();
		for (const r of [7.4, 10.8]) {
			ctx.beginPath();
			ctx.arc(cx, baseY, r * scale, -Math.PI * 0.75, -Math.PI * 0.25);
			ctx.stroke();
		}
		ctx.restore();
	}

	private battery(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number): void {
		const w = 25 * scale;
		const h = 12 * scale;
		const x = cx - w / 2 - 1.5 * scale;
		const y = cy - h / 2;
		ctx.save();
		ctx.globalAlpha = 0.4;
		ctx.lineWidth = 1 * scale;
		ctx.beginPath();
		toCanvas(ctx, roundedRect(x + 0.5, y + 0.5, w - 1, h - 1, 3.8 * scale));
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(x + w + 1 * scale, cy, 2 * scale, -Math.PI / 2, Math.PI / 2);
		ctx.fill();
		ctx.restore();
		ctx.beginPath();
		toCanvas(ctx, roundedRect(x + 2 * scale, y + 2 * scale, w - 4 * scale, h - 4 * scale, 2.3 * scale));
		ctx.fill();
	}

	private appleLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
		ctx.save();
		ctx.translate(cx - size / 2, cy - size / 2 - size * 0.04);
		ctx.scale(size / 24, size / 24);
		ctx.fill(new Path2D(APPLE_LOGO_PATH));
		ctx.restore();
	}
}

/** The Apple logo in a 24 × 24 box. */
export const APPLE_LOGO_PATH =
	"M17.05 12.54c-.03-2.63 2.15-3.9 2.25-3.96-1.23-1.79-3.13-2.04-3.81-2.07-1.62-.16-3.17.96-3.99.96-.83 0-2.09-.94-3.44-.91-1.77.03-3.4 1.03-4.31 2.61-1.84 3.19-.47 7.91 1.32 10.5.88 1.26 1.92 2.68 3.28 2.63 1.32-.05 1.81-.85 3.4-.85 1.59 0 2.04.85 3.43.82 1.42-.02 2.32-1.28 3.18-2.55 1.01-1.46 1.42-2.88 1.44-2.95-.03-.01-2.76-1.06-2.75-4.23zM14.44 4.83c.72-.88 1.21-2.09 1.08-3.31-1.04.04-2.3.7-3.05 1.57-.67.77-1.26 2.01-1.1 3.2 1.16.09 2.35-.59 3.07-1.46z";
