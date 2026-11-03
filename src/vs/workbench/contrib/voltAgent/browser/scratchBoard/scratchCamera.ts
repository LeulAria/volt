/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { clamp, Vec } from '../../common/scratchBoard/scratchMath.js';
import { IScratchBounds, IScratchCamera, SCRATCH_MAX_ZOOM, SCRATCH_MIN_ZOOM } from '../../common/scratchBoard/scratchTypes.js';

/** Zoom steps for the buttons and Cmd+=/-; wheel and pinch zoom are continuous. */
const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30];

/**
 * The board's camera: screen = world × zoom + offset. Animated moves ease out over ~240ms and
 * are interrupted by any direct move.
 */
export class ScratchCamera extends Disposable {

	private cam: IScratchCamera = { x: 0, y: 0, zoom: 1 };
	private animation: number | undefined;
	private width = 0;
	private height = 0;

	private readonly _onDidChange = this._register(new Emitter<IScratchCamera>());
	readonly onDidChange: Event<IScratchCamera> = this._onDidChange.event;

	constructor(private readonly element: HTMLElement) {
		super();
		this._register(toDisposable(() => this.stopAnimation()));
	}

	get value(): IScratchCamera {
		return this.cam;
	}

	get zoom(): number {
		return this.cam.zoom;
	}

	setViewportSize(width: number, height: number): void {
		this.width = width;
		this.height = height;
	}

	get viewportWidth(): number {
		return this.width;
	}

	get viewportHeight(): number {
		return this.height;
	}

	set(cam: IScratchCamera, fromAnimation = false): void {
		if (!fromAnimation) {
			this.stopAnimation();
		}
		const next = { x: cam.x, y: cam.y, zoom: clamp(cam.zoom, SCRATCH_MIN_ZOOM, SCRATCH_MAX_ZOOM) };
		if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.zoom)) {
			return;
		}
		if (next.x === this.cam.x && next.y === this.cam.y && next.zoom === this.cam.zoom) {
			return;
		}
		this.cam = next;
		this._onDidChange.fire(next);
	}

	screenToWorld(p: Vec): Vec {
		return [(p[0] - this.cam.x) / this.cam.zoom, (p[1] - this.cam.y) / this.cam.zoom];
	}

	worldToScreen(p: Vec): Vec {
		return [p[0] * this.cam.zoom + this.cam.x, p[1] * this.cam.zoom + this.cam.y];
	}

	/** World area on screen. */
	visibleBounds(): IScratchBounds {
		const [minX, minY] = this.screenToWorld([0, 0]);
		const [maxX, maxY] = this.screenToWorld([this.width, this.height]);
		return { minX, minY, maxX, maxY };
	}

	panBy(dx: number, dy: number): void {
		this.set({ ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy });
	}

	/** Zooms keeping the world point under `screen` still. */
	zoomAt(zoom: number, screen: Vec, animate = false): void {
		const z = clamp(zoom, SCRATCH_MIN_ZOOM, SCRATCH_MAX_ZOOM);
		const world = this.screenToWorld(screen);
		const target = { x: screen[0] - world[0] * z, y: screen[1] - world[1] * z, zoom: z };
		if (animate) {
			this.animateTo(target);
		} else {
			this.set(target);
		}
	}

	zoomStep(direction: 1 | -1, screen: Vec = [this.width / 2, this.height / 2]): void {
		const z = this.cam.zoom;
		const next = direction > 0
			? ZOOM_STEPS.find(s => s > z + 1e-6) ?? SCRATCH_MAX_ZOOM
			: [...ZOOM_STEPS].reverse().find(s => s < z - 1e-6) ?? SCRATCH_MIN_ZOOM;
		this.zoomAt(next, screen, true);
	}

	/** Frames `bounds` with `padding` screen pixels around it, never zooming past `maxZoom`. */
	fit(bounds: IScratchBounds, padding = 64, maxZoom = 1, animate = true): void {
		const w = Math.max(1, bounds.maxX - bounds.minX);
		const h = Math.max(1, bounds.maxY - bounds.minY);
		const availableW = Math.max(40, this.width - padding * 2);
		const availableH = Math.max(40, this.height - padding * 2);
		const zoom = clamp(Math.min(availableW / w, availableH / h, maxZoom), SCRATCH_MIN_ZOOM, SCRATCH_MAX_ZOOM);
		const cx = (bounds.minX + bounds.maxX) / 2;
		const cy = (bounds.minY + bounds.maxY) / 2;
		const target = { x: this.width / 2 - cx * zoom, y: this.height / 2 - cy * zoom, zoom };
		if (animate) {
			this.animateTo(target);
		} else {
			this.set(target);
		}
	}

	/** Centres the world point on screen at the current zoom. */
	centerOn(world: Vec, animate = true): void {
		const target = { x: this.width / 2 - world[0] * this.cam.zoom, y: this.height / 2 - world[1] * this.cam.zoom, zoom: this.cam.zoom };
		if (animate) {
			this.animateTo(target);
		} else {
			this.set(target);
		}
	}

	animateTo(target: IScratchCamera, duration = 240): void {
		this.stopAnimation();
		const from = this.cam;
		const win = getWindow(this.element);
		const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		if (reduce || duration <= 0) {
			this.set(target);
			return;
		}
		const start = win.performance.now();
		// Zoom eases in log space so zooming far in or out feels even.
		const fromLog = Math.log(from.zoom), toLog = Math.log(clamp(target.zoom, SCRATCH_MIN_ZOOM, SCRATCH_MAX_ZOOM));
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / duration);
			const e = 1 - Math.pow(1 - t, 3);
			const zoom = Math.exp(fromLog + (toLog - fromLog) * e);
			// Interpolate the world point at the screen centre so the move does not swing.
			const cx = this.width / 2, cy = this.height / 2;
			const fromCenter: Vec = [(cx - from.x) / from.zoom, (cy - from.y) / from.zoom];
			const toCenter: Vec = [(cx - target.x) / target.zoom, (cy - target.y) / target.zoom];
			const wx = fromCenter[0] + (toCenter[0] - fromCenter[0]) * e;
			const wy = fromCenter[1] + (toCenter[1] - fromCenter[1]) * e;
			this.set({ x: cx - wx * zoom, y: cy - wy * zoom, zoom }, true);
			if (t < 1) {
				this.animation = win.requestAnimationFrame(step);
			} else {
				this.animation = undefined;
				this.set(target, true);
			}
		};
		this.animation = win.requestAnimationFrame(step);
	}

	get animating(): boolean {
		return this.animation !== undefined;
	}

	private stopAnimation(): void {
		if (this.animation !== undefined) {
			getWindow(this.element).cancelAnimationFrame(this.animation);
			this.animation = undefined;
		}
	}
}
