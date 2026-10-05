/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';

/** Distance between dot centers and the size of one dot, in CSS px. */
const PITCH = 2.3;
const DOT = 1.5;
/** How long the meter takes to light up, left to right. */
const SWEEP_MS = 760;
const DOT_FADE_MS = 240;

/** Small seeded PRNG, so a meter keeps the same texture across refreshes. */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	}
	return h >>> 0;
}

interface IDot {
	readonly x: number;
	readonly y: number;
	readonly alpha: number;
	/** When it lights during the sweep; unlit dots have none. */
	readonly delay?: number;
}

/**
 * A dot-matrix meter: a grid of small rounded squares, lit in the provider's color up to
 * `fraction` with a ragged leading edge and uneven brightness, faint where unused. Drawn on a
 * canvas sized to the element, in the element's `color`.
 */
export class DotMatrixMeter extends Disposable {

	readonly element: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private frame = 0;
	private size = { width: 0, height: 0 };

	constructor(parent: HTMLElement, private readonly fraction: number, private readonly seed: string, private animate: boolean) {
		super();
		this.element = append(parent, $('.volt-usage-dots'));
		this.canvas = append(this.element, $('canvas')) as HTMLCanvasElement;
		this.canvas.setAttribute('aria-hidden', 'true');
		const window = getWindow(this.element);
		const observer = new window.ResizeObserver(() => this.draw());
		observer.observe(this.element);
		this._register(toDisposable(() => {
			observer.disconnect();
			window.cancelAnimationFrame(this.frame);
		}));
	}

	private layoutDots(width: number, height: number): IDot[] {
		const cols = Math.max(1, Math.floor((width + PITCH - DOT) / PITCH));
		const rows = Math.max(1, Math.floor((height + PITCH - DOT) / PITCH));
		const offsetX = (width - ((cols - 1) * PITCH + DOT)) / 2;
		const offsetY = (height - ((rows - 1) * PITCH + DOT)) / 2;
		const rand = random(hash(this.seed));
		const exact = Math.max(0, Math.min(1, this.fraction)) * cols;
		const full = Math.floor(exact);
		const partial = exact - full;
		const dots: IDot[] = [];
		for (let col = 0; col < cols; col++) {
			for (let row = 0; row < rows; row++) {
				const r = rand();
				const corner = (col === 0 || col === cols - 1) && (row === 0 || row === rows - 1);
				if (corner) {
					continue;
				}
				// A ragged leading edge reads as light spilling over, not a hard cut.
				let lit = col < full;
				if (col === full - 1 && exact > 2 && r < 0.12) {
					lit = false;
				} else if (col === full) {
					lit = r < partial;
				} else if (col === full + 1 && exact > 0) {
					lit = r < partial * 0.25;
				}
				const x = offsetX + col * PITCH;
				const y = offsetY + row * PITCH;
				if (lit) {
					const edge = row === 0 || row === rows - 1 || col === 0;
					const sparkle = r > 0.94 ? 0.25 : 0;
					const alpha = Math.min(1, 0.78 + rand() * 0.16 + sparkle + (edge ? 0.06 : 0));
					dots.push({ x, y, alpha, delay: (col / cols) * SWEEP_MS + rand() * 160 });
				} else {
					dots.push({ x, y, alpha: 0.16 + rand() * 0.05 });
				}
			}
		}
		return dots;
	}

	private draw(): void {
		const width = this.element.clientWidth;
		const height = this.element.clientHeight;
		if (!width || !height) {
			return;
		}
		const window = getWindow(this.element);
		const ratio = window.devicePixelRatio || 1;
		if (width !== this.size.width || height !== this.size.height) {
			this.size = { width, height };
			this.canvas.width = Math.round(width * ratio);
			this.canvas.height = Math.round(height * ratio);
			this.canvas.style.width = `${width}px`;
			this.canvas.style.height = `${height}px`;
		}
		const context = this.canvas.getContext('2d');
		if (!context) {
			return;
		}
		const color = window.getComputedStyle(this.element).color;
		const dots = this.layoutDots(width, height);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const started = window.performance.now();
		const animate = this.animate && !reduced;
		this.animate = false;
		window.cancelAnimationFrame(this.frame);

		const paint = (now: number) => {
			const elapsed = now - started;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			context.fillStyle = color;
			let pending = false;
			for (const dot of dots) {
				let alpha = dot.alpha;
				if (dot.delay !== undefined && animate) {
					const t = Math.min(1, Math.max(0, (elapsed - dot.delay) / DOT_FADE_MS));
					if (t < 1) {
						pending = true;
					}
					// Unlit cells show their resting glow until the sweep reaches them.
					alpha = 0.18 + (dot.alpha - 0.18) * (1 - Math.pow(1 - t, 3));
				}
				context.globalAlpha = alpha;
				context.beginPath();
				context.roundRect(dot.x, dot.y, DOT, DOT, 0.4);
				context.fill();
			}
			context.globalAlpha = 1;
			if (pending) {
				this.frame = window.requestAnimationFrame(paint);
			}
		};
		paint(started);
		if (animate) {
			this.frame = window.requestAnimationFrame(paint);
		}
	}
}
