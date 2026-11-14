/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';

/*
 * The Orbit chat background, drawn live: a dotted planet turning slowly and the steps of an agent's
 * work travelling round it on tilted rings, over faint measuring lines. The scene is 1600x900, as
 * tall as the backdrop in a wide chat; a narrow chat fits it across, cropping no more than the rings'
 * far ends. media/chatBackgrounds/orbit.webp and its thumbnail are frame 0 at 16:9, for Settings.
 */

const SCENE_WIDTH = 1600;
const SCENE_HEIGHT = 900;
/** Where the scene sits in a chat taller than it: 30% of the room above it, the rest below. */
const SCENE_ALIGN_Y = 0.3;
/** A narrow chat crops the scene's sides by at most this factor over fitting it across. */
const MAX_SIDE_CROP = 1.4;

/** The motion is slow: more frames than this would cost the chat's main thread for nothing. */
const MAX_FRAMES_PER_SECOND = 30;
/** Sharper than this is lost under the dim layer. */
const MAX_PIXEL_RATIO = 2;
/** Held this long at rest before the canvas is traded for a picture (never during a launch's first frames). */
const ORBIT_REST_DELAY_MS = 5_000;

const BACKGROUND = '#060607';
const INK = '#ffffff';
const FONT = '"Geist Mono", ui-monospace, Menlo, monospace';

/** In the top 40% of the scene: a new chat's pickers and composer sit just under it. */
const PLANET_X = 800;
const PLANET_Y = 215;
const PLANET_RADIUS = 130;
/** Seconds for one turn of the planet. */
const PLANET_TURN = 150;
/** The planet's axis leans toward the viewer (seen a little from above, like the rings) and to the left. */
const LEAN_COS = Math.cos(0.32);
const LEAN_SIN = Math.sin(0.32);
const ROLL_COS = Math.cos(-0.22);
const ROLL_SIN = Math.sin(-0.22);
/** The light comes from the upper left, in front: x right, y up, z toward the viewer. */
const LIGHT = unit(-0.72, 0.42, 0.55);

/** The rings lean down to the right. */
const RING_ROLL_COS = Math.cos(0.08);
const RING_ROLL_SIN = Math.sin(0.08);

interface IOrbitStop {
	readonly label: string;
	/** Where it is at frame 0, in turns: 0 at the ring's right end, 0.25 in front, 0.5 at its left end. */
	readonly at: number;
}

interface IOrbitRing {
	readonly radius: number;
	/** How open the ring is seen: its height over its width. */
	readonly open: number;
	/** Seconds for one trip round. */
	readonly turn: number;
	readonly stops: readonly IOrbitStop[];
}

const RINGS: readonly IOrbitRing[] = [
	{
		radius: 600, open: 0.24, turn: 170, stops: [
			{ label: localize('voltChatOrbit.plan', "Plan"), at: 0.62 },
			{ label: localize('voltChatOrbit.ship', "Ship"), at: 0.12 },
		],
	},
	{
		radius: 440, open: 0.27, turn: 125, stops: [
			{ label: localize('voltChatOrbit.build', "Build"), at: 0.45 },
			{ label: localize('voltChatOrbit.merge', "Merge"), at: 0.93 },
		],
	},
	{
		radius: 300, open: 0.31, turn: 90, stops: [
			{ label: localize('voltChatOrbit.test', "Test"), at: 0.3 },
			{ label: localize('voltChatOrbit.review', "Review"), at: 0.66 },
		],
	},
];

/** The label on the line from the planet. */
const CALLOUT_TITLE = localize('voltChatOrbit.project', "Project");
const CALLOUT_DETAIL = [
	localize('voltChatOrbit.agents', "Agents"),
	localize('voltChatOrbit.worktrees', "Worktrees"),
	localize('voltChatOrbit.tools', "Tools"),
];
const MIDDLE_DOT = String.fromCharCode(0xb7);

/** A stop's name fades out over this many CSS pixels as it comes near the chat's controls or the callout. */
const CLEAR_FADE = 14;
/** How often the controls' boxes are read again while the scene moves. */
const CLEAR_REFRESH_MS = 250;

/** A box in CSS pixels. */
export interface IOrbitBox {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/**
 * How visible a stop is, 0 to 1: 0 on or over any of `keepClear`, rising to 1 at `fade` pixels away.
 * Names never draw over the chat's own controls or the callout's text, so the two never read as one.
 */
export function orbitStopVisibility(box: IOrbitBox, keepClear: readonly IOrbitBox[], fade: number): number {
	let nearest = Infinity;
	for (const other of keepClear) {
		const dx = Math.max(other.left - box.right, box.left - other.right, 0);
		const dy = Math.max(other.top - box.bottom, box.top - other.bottom, 0);
		nearest = Math.min(nearest, Math.hypot(dx, dy));
	}
	return nearest === Infinity ? 1 : Math.min(1, nearest / fade);
}

/** Points on the unit sphere in rows of latitude, each row half a step round from the last: x, y (up), z. */
const PLANET_DOTS = (() => {
	const points: number[] = [];
	let row = 0;
	for (let latitude = -84; latitude <= 84; latitude += 6, row++) {
		const radius = Math.cos(latitude * Math.PI / 180);
		const height = Math.sin(latitude * Math.PI / 180);
		const count = Math.max(6, Math.round(72 * radius));
		for (let i = 0; i < count; i++) {
			const longitude = (i + (row % 2) / 2) / count * Math.PI * 2;
			points.push(radius * Math.cos(longitude), height, radius * Math.sin(longitude));
		}
	}
	return new Float32Array(points);
})();

interface IPoint {
	readonly x: number;
	readonly y: number;
	/** Above 0 in front of the planet's center, below 0 behind it. */
	readonly depth: number;
}

/**
 * Draws the scene at `seconds` over the whole canvas, which is `width` by `height` CSS pixels at
 * `pixelRatio`: as tall as the canvas, or across it when the canvas is narrow (centered, 30% down).
 * `keepClear`: boxes on the canvas, in CSS pixels, where no stop's name may draw (the chat's controls).
 */
export function drawAgentChatOrbit(context: CanvasRenderingContext2D, width: number, height: number, pixelRatio: number, seconds: number, keepClear: readonly IOrbitBox[] = []): void {
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.globalAlpha = 1;
	context.fillStyle = BACKGROUND;
	context.fillRect(0, 0, context.canvas.width, context.canvas.height);

	const scale = Math.min(height / SCENE_HEIGHT, width / SCENE_WIDTH * MAX_SIDE_CROP);
	const offsetX = (width - SCENE_WIDTH * scale) / 2;
	const offsetY = (height - SCENE_HEIGHT * scale) * SCENE_ALIGN_Y;
	context.setTransform(scale * pixelRatio, 0, 0, scale * pixelRatio, offsetX * pixelRatio, offsetY * pixelRatio);
	// One CSS pixel in scene units: lines stay a pixel wide at any size.
	const pixel = 1 / scale;
	context.fillStyle = INK;
	context.strokeStyle = INK;
	context.lineWidth = pixel;

	drawMeasures(context, pixel, -offsetX / scale, (width - offsetX) / scale, -offsetY / scale, (height - offsetY) / scale);
	const callout = placeCallout(context, pixel);
	// In scene units, with the callout's text: what the stops' names stay off.
	const clear: IOrbitBox[] = [callout, ...keepClear.map(box => ({
		left: (box.left - offsetX) / scale,
		top: (box.top - offsetY) / scale,
		right: (box.right - offsetX) / scale,
		bottom: (box.bottom - offsetY) / scale,
	}))];
	const stops = RINGS.flatMap(ring => ring.stops.map(stop => ({ label: stop.label, point: ringPoint(ring, stop.at + seconds / ring.turn) })));
	for (const ring of RINGS) {
		drawRing(context, ring, seconds, pixel, false);
	}
	drawStops(context, stops.filter(stop => stop.point.depth < 0), pixel, clear);
	drawPlanet(context, seconds, pixel);
	for (const ring of RINGS) {
		drawRing(context, ring, seconds, pixel, true);
	}
	drawStops(context, stops.filter(stop => stop.point.depth >= 0), pixel, clear);
	drawCallout(context, callout);
	context.globalAlpha = 1;
}

/** The dashed lines through the planet, edge to edge of the canvas (in scene units), with a tick every 64 units. */
function drawMeasures(context: CanvasRenderingContext2D, pixel: number, left: number, right: number, top: number, bottom: number): void {
	context.globalAlpha = 0.09;
	context.setLineDash([2 * pixel, 6 * pixel]);
	context.beginPath();
	context.moveTo(left, PLANET_Y);
	context.lineTo(right, PLANET_Y);
	context.moveTo(PLANET_X, top);
	context.lineTo(PLANET_X, bottom);
	context.stroke();
	context.setLineDash([]);
	context.globalAlpha = 0.16;
	context.beginPath();
	for (let x = PLANET_X - Math.floor((PLANET_X - left) / 64) * 64; x <= right; x += 64) {
		context.moveTo(x, PLANET_Y - 3);
		context.lineTo(x, PLANET_Y + 3);
	}
	for (let y = PLANET_Y - Math.floor((PLANET_Y - top) / 64) * 64; y <= bottom; y += 64) {
		context.moveTo(PLANET_X - 3, y);
		context.lineTo(PLANET_X + 3, y);
	}
	context.stroke();
}

/** The planet's dots that face the viewer, bright on the lit side and a trace on the far side. */
function drawPlanet(context: CanvasRenderingContext2D, seconds: number, pixel: number): void {
	const spin = seconds / PLANET_TURN * Math.PI * 2;
	const spinCos = Math.cos(spin);
	const spinSin = Math.sin(spin);
	const size = Math.max(1.8, 1.2 * pixel);
	const half = size / 2;
	for (let i = 0; i < PLANET_DOTS.length; i += 3) {
		const x0 = PLANET_DOTS[i];
		const y0 = PLANET_DOTS[i + 1];
		const z0 = PLANET_DOTS[i + 2];
		// Turn round the axis (y), lean toward the viewer (round x), then roll (round z).
		const x1 = x0 * spinCos + z0 * spinSin;
		const z1 = z0 * spinCos - x0 * spinSin;
		const y2 = y0 * LEAN_COS - z1 * LEAN_SIN;
		const z2 = y0 * LEAN_SIN + z1 * LEAN_COS;
		if (z2 <= 0) {
			continue;
		}
		const x3 = x1 * ROLL_COS - y2 * ROLL_SIN;
		const y3 = x1 * ROLL_SIN + y2 * ROLL_COS;
		const lit = Math.max(0, x3 * LIGHT.x + y3 * LIGHT.y + z2 * LIGHT.z);
		// Dots thin out toward the outline, where they crowd.
		context.globalAlpha = (0.07 + 0.93 * lit ** 1.3) * Math.min(1, z2 * 4);
		context.fillRect(PLANET_X + x3 * PLANET_RADIUS - half, PLANET_Y - y3 * PLANET_RADIUS - half, size, size);
	}
}

/**
 * A ring's back half, a faint line broken where the planet hides it, or its front half, dotted and
 * flowing round with the stops. Both fade toward the right, away from the light.
 */
function drawRing(context: CanvasRenderingContext2D, ring: IOrbitRing, seconds: number, pixel: number, front: boolean): void {
	const light = context.createLinearGradient(PLANET_X - ring.radius, 0, PLANET_X + ring.radius, 0);
	light.addColorStop(0, 'rgba(255, 255, 255, 1)');
	light.addColorStop(1, 'rgba(255, 255, 255, 0.35)');
	context.strokeStyle = light;
	context.globalAlpha = front ? 0.7 : 0.24;
	if (front) {
		context.setLineDash([1.2 * pixel, 3.4 * pixel]);
		context.lineDashOffset = -seconds / ring.turn * ellipsePerimeter(ring.radius, ring.radius * ring.open);
	}
	context.beginPath();
	const steps = 180;
	let drawing = false;
	for (let i = 0; i <= steps; i++) {
		// The front half runs from the right end through the front to the left end; the back half on round.
		const point = ringPoint(ring, (front ? 0 : 0.5) + i / steps / 2);
		if (isHidden(point)) {
			drawing = false;
			continue;
		}
		if (drawing) {
			context.lineTo(point.x, point.y);
		} else {
			context.moveTo(point.x, point.y);
			drawing = true;
		}
	}
	context.stroke();
	context.setLineDash([]);
	context.lineDashOffset = 0;
	context.strokeStyle = INK;
}

/**
 * The stops on the rings, each a dot with its step's name; the ones in front brighter. A stop
 * coming near the callout's text or one of the chat's controls (`clear`, scene units) fades out,
 * dot and name, so a name never draws over other text.
 */
function drawStops(context: CanvasRenderingContext2D, stops: readonly { readonly label: string; readonly point: IPoint }[], pixel: number, clear: readonly IOrbitBox[]): void {
	const size = Math.max(11, 9 * pixel);
	context.font = `500 ${size}px ${FONT}`;
	context.letterSpacing = '1.6px';
	const radius = Math.max(2.6, 2 * pixel);
	for (const { label, point } of stops) {
		if (isHidden(point)) {
			continue;
		}
		const text = label.toLocaleUpperCase();
		const x = point.x + 10;
		const y = point.y - 9;
		const box = { left: point.x - radius, top: y - size, right: x + context.measureText(text).width, bottom: point.y + radius };
		const visible = orbitStopVisibility(box, clear, CLEAR_FADE * pixel);
		if (visible <= 0) {
			continue;
		}
		const front = point.depth >= 0;
		context.globalAlpha = (front ? 1 : 0.55) * visible;
		context.beginPath();
		context.arc(point.x, point.y, radius, 0, Math.PI * 2);
		context.fill();
		context.globalAlpha = (front ? 0.85 : 0.5) * visible;
		context.fillText(text, x, y);
	}
	context.letterSpacing = '0px';
}

interface ICallout {
	readonly anchorX: number;
	readonly anchorY: number;
	readonly elbowX: number;
	readonly elbowY: number;
	readonly title: string;
	readonly detail: string;
	readonly titleFont: string;
	readonly detailFont: string;
	/** Where its text is, in scene units. */
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/** Where the line from the planet to its name goes, and the box its text takes. */
function placeCallout(context: CanvasRenderingContext2D, pixel: number): ICallout {
	const angle = 0.35;
	const anchorX = PLANET_X + Math.cos(angle) * PLANET_RADIUS;
	const anchorY = PLANET_Y - Math.sin(angle) * PLANET_RADIUS;
	const elbowX = anchorX + 48;
	const elbowY = anchorY - 52;
	const titleSize = Math.max(12, 10 * pixel);
	const detailSize = Math.max(10, 8 * pixel);
	const title = CALLOUT_TITLE.toLocaleUpperCase();
	const detail = CALLOUT_DETAIL.map(part => part.toLocaleUpperCase()).join(` ${MIDDLE_DOT} `);
	const titleFont = `600 ${titleSize}px ${FONT}`;
	const detailFont = `500 ${detailSize}px ${FONT}`;
	context.letterSpacing = '1.6px';
	context.font = titleFont;
	const titleWidth = context.measureText(title).width;
	context.font = detailFont;
	const detailWidth = context.measureText(detail).width;
	context.letterSpacing = '0px';
	const left = elbowX + 26;
	return {
		anchorX, anchorY, elbowX, elbowY, title, detail, titleFont, detailFont,
		left: left - 4,
		top: elbowY + 4 - titleSize - 4,
		right: left + Math.max(titleWidth, detailWidth) + 4,
		bottom: elbowY + 4 + titleSize * 0.4 + detailSize + 8,
	};
}

/** A line from the planet to its name, with what goes round it underneath. */
function drawCallout(context: CanvasRenderingContext2D, callout: ICallout): void {
	context.globalAlpha = 0.5;
	context.beginPath();
	context.moveTo(callout.anchorX, callout.anchorY);
	context.lineTo(callout.elbowX, callout.elbowY);
	context.lineTo(callout.elbowX + 18, callout.elbowY);
	context.stroke();
	context.letterSpacing = '1.6px';
	context.globalAlpha = 0.9;
	context.font = callout.titleFont;
	context.fillText(callout.title, callout.elbowX + 26, callout.elbowY + 4);
	context.globalAlpha = 0.55;
	context.font = callout.detailFont;
	context.fillText(callout.detail, callout.elbowX + 26, callout.elbowY + 22);
	context.letterSpacing = '0px';
}

/** A point on a ring, `turns` round from its right end. */
function ringPoint(ring: IOrbitRing, turns: number): IPoint {
	const angle = turns * Math.PI * 2;
	const across = ring.radius * Math.cos(angle);
	const down = ring.radius * ring.open * Math.sin(angle);
	return {
		x: PLANET_X + across * RING_ROLL_COS - down * RING_ROLL_SIN,
		y: PLANET_Y + across * RING_ROLL_SIN + down * RING_ROLL_COS,
		depth: Math.sin(angle),
	};
}

/** Behind the planet and inside its outline. */
function isHidden(point: IPoint): boolean {
	if (point.depth >= 0) {
		return false;
	}
	const dx = point.x - PLANET_X;
	const dy = point.y - PLANET_Y;
	return dx * dx + dy * dy < (PLANET_RADIUS + 3) * (PLANET_RADIUS + 3);
}

/** Ramanujan's approximation, for the front dots to flow at the stops' speed. */
function ellipsePerimeter(a: number, b: number): number {
	return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

function unit(x: number, y: number, z: number): { readonly x: number; readonly y: number; readonly z: number } {
	const length = Math.hypot(x, y, z);
	return { x: x / length, y: y / length, z: z / length };
}

/**
 * The Orbit canvas inside a chat's backdrop: draws frames while played, at most 30 a second, and
 * keeps its place in the motion while paused. With reduced motion it draws one still frame.
 */
export class AgentChatOrbit extends Disposable {

	private readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D | null;
	private width = 0;
	private height = 0;
	private pixelRatio = 1;
	/** Seconds of motion before the current play. */
	private elapsed = 0;
	private playingSince: number | undefined;
	private frame: number | undefined;
	private lastFrameTime = 0;
	private keepClear: readonly IOrbitBox[] = [];
	private keepClearAt = 0;
	/** At rest (see {@link rest}): the picture shown in the canvas's place. */
	private resting: { readonly picture: HTMLImageElement; readonly url: string } | undefined;
	private restTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by every wake: a rest still encoding its picture is dropped. */
	private restGeneration = 0;

	/** `keepClear`: the chat's controls on the canvas, in CSS pixels (read at most every 250 ms). */
	constructor(parent: HTMLElement, private readonly still: () => boolean, private readonly readKeepClear: () => readonly IOrbitBox[] = () => [], private readonly restDelayMs = ORBIT_REST_DELAY_MS) {
		super();
		this.canvas = append(parent, $<HTMLCanvasElement>('canvas.volt-agent-chat-orbit', { 'aria-hidden': 'true' }));
		this.context = this.canvas.getContext('2d', { alpha: false });
		this._register(toDisposable(() => {
			this.pause();
			this.restGeneration++;
			clearTimeout(this.restTimer);
			if (this.resting) {
				this.resting.picture.remove();
				URL.revokeObjectURL(this.resting.url);
				this.resting = undefined;
			}
			this.canvas.remove();
		}));
	}

	resize(width: number, height: number): void {
		const pixelRatio = Math.min(getWindow(this.canvas).devicePixelRatio || 1, MAX_PIXEL_RATIO);
		if (width === this.width && height === this.height && pixelRatio === this.pixelRatio) {
			return;
		}
		this.width = width;
		this.height = height;
		this.pixelRatio = pixelRatio;
		this.wake();
		this.draw();
	}

	/**
	 * Held until the next input: the canvas (a window-sized bitmap, about 100 MB of the GPU's memory
	 * with its buffers at 2x) goes, and a picture of the same frame shows in its place. Playing,
	 * drawing again or resizing brings the canvas back with that frame first, in the same task.
	 */
	rest(): void {
		if (this.playingSince !== undefined || this.still() || this.resting || this.restTimer !== undefined) {
			return;
		}
		this.restTimer = setTimeout(() => {
			this.restTimer = undefined;
			void this.trade();
		}, this.restDelayMs);
	}

	private async trade(): Promise<void> {
		if (this.playingSince !== undefined || !this.context || this.canvas.width <= 1 || !this.canvas.isConnected) {
			return;
		}
		const generation = ++this.restGeneration;
		const blob = await new Promise<Blob | null>(resolve => this.canvas.toBlob(resolve, 'image/png'));
		if (!blob || generation !== this.restGeneration || this.playingSince !== undefined) {
			return;
		}
		const url = URL.createObjectURL(blob);
		const picture = $<HTMLImageElement>('img.volt-agent-chat-orbit-still', { alt: '', 'aria-hidden': 'true', draggable: 'false' });
		picture.src = url;
		try {
			await picture.decode();
		} catch {
			URL.revokeObjectURL(url);
			return;
		}
		if (generation !== this.restGeneration || this.playingSince !== undefined || !this.canvas.isConnected) {
			URL.revokeObjectURL(url);
			return;
		}
		this.canvas.after(picture);
		this.resting = { picture, url };
		// A 0x0 canvas lets its bitmap go; its CSS box (inset 0, 100%) keeps the layout.
		this.canvas.width = 0;
		this.canvas.height = 0;
	}

	/** The canvas back at its size (its frame is drawn by the caller), the picture gone; a pending rest is dropped. */
	private wake(): void {
		this.restGeneration++;
		if (this.restTimer !== undefined) {
			clearTimeout(this.restTimer);
			this.restTimer = undefined;
		}
		const width = Math.max(1, Math.round(this.width * this.pixelRatio));
		const height = Math.max(1, Math.round(this.height * this.pixelRatio));
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		if (this.resting) {
			const { picture, url } = this.resting;
			this.resting = undefined;
			// Drawn before the picture goes, in this task: the next frame shows the canvas, never a gap.
			queueMicrotask(() => {
				picture.remove();
				URL.revokeObjectURL(url);
			});
		}
	}

	play(): void {
		if (this.playingSince !== undefined) {
			return;
		}
		if (this.resting || this.restTimer !== undefined) {
			this.wake();
			this.draw();
		}
		if (this.still()) {
			this.draw();
			return;
		}
		this.playingSince = Date.now();
		this.schedule();
	}

	pause(): void {
		if (this.playingSince === undefined) {
			return;
		}
		this.elapsed = this.seconds();
		this.playingSince = undefined;
		if (this.frame !== undefined) {
			getWindow(this.canvas).cancelAnimationFrame(this.frame);
			this.frame = undefined;
		}
	}

	private seconds(): number {
		return this.elapsed + (this.playingSince === undefined ? 0 : (Date.now() - this.playingSince) / 1000);
	}

	private schedule(): void {
		this.frame = getWindow(this.canvas).requestAnimationFrame(time => {
			this.frame = undefined;
			if (this.playingSince === undefined) {
				return;
			}
			if (time - this.lastFrameTime >= 1000 / MAX_FRAMES_PER_SECOND - 4) {
				this.lastFrameTime = time;
				this.draw();
			}
			this.schedule();
		});
	}

	/** The controls moved (the composer grew, a picker changed): read their boxes on the next frame. */
	invalidateKeepClear(): void {
		this.keepClearAt = 0;
		if (this.playingSince === undefined) {
			this.draw();
		}
	}

	private draw(): void {
		if (this.resting || this.restTimer !== undefined) {
			this.wake();
		}
		if (this.context && this.width > 0 && this.height > 0) {
			const now = Date.now();
			if (now - this.keepClearAt >= CLEAR_REFRESH_MS) {
				this.keepClearAt = now;
				this.keepClear = this.readKeepClear();
			}
			drawAgentChatOrbit(this.context, this.width, this.height, this.pixelRatio, this.seconds(), this.keepClear);
		}
	}
}
