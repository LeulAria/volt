/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Harness: draws one catalog device with the studio in a plain page, for screenshots outside Volt.
 * `window.voltHarness.show({ id, finish, posture, landscape, view, yaw, pitch, fit })`.
 */
import { createDeviceStudio, type DeviceStudio } from "../src/index.ts";
import type { IDeviceCatalogEntry } from "../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import { DEVICE_CATALOG as CATALOG } from "../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/catalog/index.ts";

declare global {
	interface Window {
		voltHarness: {
			ids(): string[];
			add(entry: IDeviceCatalogEntry): void;
			show(options: { id: string; finish?: string; posture?: "closed" | "half" | "open"; landscape?: boolean; view?: "front" | "angle" | "side" | "back"; yaw?: number; pitch?: number; fit?: number; light?: boolean; hinge?: number }): Promise<string>;
			studio(): DeviceStudio | undefined;
		};
	}
}

const DEVICE_CATALOG: IDeviceCatalogEntry[] = [...CATALOG];
const stage = document.getElementById("stage")!;
const page = document.getElementById("page")!;
const pageImage = document.getElementById("page-img") as HTMLImageElement;
let studio: DeviceStudio | undefined;
const images = new Map<string, HTMLImageElement>();

function load(src: string): Promise<HTMLImageElement> {
	const cached = images.get(src);
	if (cached) {
		return Promise.resolve(cached);
	}
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			images.set(src, img);
			resolve(img);
		};
		img.onerror = reject;
		img.src = src;
	});
}

function pageImageFor(width: number, height: number): string {
	return width > height * 1.2 ? "./page-wide.png" : "./page-phone.png";
}

window.voltHarness = {
	ids: () => DEVICE_CATALOG.map((d) => d.id),
	add: (entry) => {
		const at = DEVICE_CATALOG.findIndex((d) => d.id === entry.id);
		if (at >= 0) {
			DEVICE_CATALOG[at] = entry;
		} else {
			DEVICE_CATALOG.push(entry);
		}
	},
	studio: () => studio,
	async show(options) {
		const entry = DEVICE_CATALOG.find((d) => d.id === options.id);
		if (!entry) {
			throw new Error(`no device ${options.id}`);
		}
		document.body.classList.toggle("light", !!options.light);
		studio?.dispose();
		let layoutDone: () => void = () => {};
		const ready = new Promise<void>((resolve) => (layoutDone = resolve));
		studio = createDeviceStudio({
			stage,
			page: () => page,
			capture: async () => {
				const rect = studio?.state?.viewport;
				return load(pageImageFor(rect?.width ?? 400, rect?.height ?? 800));
			},
			onDidLayout: (state) => {
				pageImage.src = pageImageFor(state.viewport.width, state.viewport.height);
				layoutDone();
			},
			onDidFail: (error) => console.error("studio failed", error),
		});
		studio.setScreenColors("#fffffff0", "#fbfbfd");
		studio.show(entry, { finish: options.finish, posture: options.posture, landscape: options.landscape });
		studio.layout({ width: innerWidth, height: innerHeight, top: 20, bottom: 64, side: 20 }, options.fit ?? "fit");
		await ready;
		await studio.refreshSnapshot();
		if (options.view && options.view !== "front") {
			studio.setView(options.view);
		}
		if (options.yaw !== undefined || options.pitch !== undefined) {
			(studio as unknown as { yaw: number; pitch: number }).yaw = options.yaw ?? 0;
			(studio as unknown as { yaw: number; pitch: number }).pitch = options.pitch ?? 0;
			(studio as unknown as { requestFrame(): void }).requestFrame();
		}
		if (options.hinge !== undefined) {
			const built = (studio as unknown as { built?: { hinge?: { set(d: number): void } } }).built;
			built?.hinge?.set(options.hinge);
			(studio as unknown as { requestFrame(): void }).requestFrame();
		}
		await new Promise((r) => setTimeout(r, options.view && options.view !== "front" ? 1100 : 250));
		const state = studio.state;
		return JSON.stringify({ id: entry.id, finish: studio.finish, state });
	},
};
document.title = "ready";
