/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Drawing for `desktop_act`: shapes and SVG paths turned into pointer strokes. Coordinates run 0-100
 * across the target's width and height (a canvas, an image, the window), so the agent draws without
 * knowing pixel sizes, and nothing lands outside the target (a stray drag could hit a toolbar).
 * Sizes (a radius, a square's side) are in hundredths of the width and stay round on any target.
 *
 *   draw in "Canvas" circle 50,40 20 | line 50,60 50,90 | path "M30 70 L70 70"
 */

export type DrawPoint = readonly [number, number];
export type DrawStroke = readonly DrawPoint[];

const SHAPES = ['line', 'polyline', 'polygon', 'rect', 'square', 'ellipse', 'circle', 'arc', 'star', 'path', 'dot'] as const;

export const DRAW_SHAPES: readonly string[] = SHAPES;

/** Most strokes one step may draw, and points in all of them: enough for a detailed sketch. */
const MAX_STROKES = 200;
const MAX_POINTS = 20_000;

function clamp(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function pair(word: string | undefined, what: string): DrawPoint {
	const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(word ?? '');
	if (!m) {
		throw new Error(`${what} needs x,y (0-100 across the target), got ${JSON.stringify(word ?? 'nothing')}`);
	}
	return [Number(m[1]), Number(m[2])];
}

function number(word: string | undefined, what: string): number {
	if (word === undefined || !/^-?\d+(?:\.\d+)?$/.test(word)) {
		throw new Error(`${what} needs a number, got ${JSON.stringify(word ?? 'nothing')}`);
	}
	return Number(word);
}

/** Points around an ellipse, from angle `from` to `to` (degrees, 0 = right, clockwise on screen). */
function ellipsePoints(cx: number, cy: number, rx: number, ry: number, from = 0, to = 360): DrawPoint[] {
	const sweep = to - from;
	const steps = Math.max(12, Math.ceil(Math.abs(sweep) / 360 * Math.max(24, (rx + ry) * 2.5)));
	const points: DrawPoint[] = [];
	for (let i = 0; i <= steps; i++) {
		const a = (from + sweep * i / steps) * Math.PI / 180;
		points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
	}
	return points;
}

/** One shape (`circle 50,50 20`) as strokes; `aspect` is the target's width over its height. */
function shape(spec: string, aspect: number): DrawPoint[][] {
	const trimmed = spec.trim();
	const kind = /^\w+/.exec(trimmed)?.[0].toLowerCase() ?? '';
	const rest = trimmed.slice(kind.length).trim();
	if (kind === 'path') {
		return svgPathStrokes(rest.replace(/^(["'])(.*)\1$/s, '$2'));
	}
	const words = rest.split(/\s+/).filter(Boolean);
	switch (kind) {
		case 'line':
			if (words.length !== 2) {
				throw new Error('line needs two points: line 10,10 90,90');
			}
			return [[pair(words[0], 'line'), pair(words[1], 'line')]];
		case 'polyline':
		case 'polygon': {
			const points = words.map(word => pair(word, kind));
			if (points.length < 2) {
				throw new Error(`${kind} needs at least two points`);
			}
			return [kind === 'polygon' ? [...points, points[0]] : points];
		}
		case 'dot':
			return words.map(word => [pair(word, 'dot')]);
		case 'rect':
		case 'square': {
			const [x, y] = pair(words[0], kind);
			const [w, h] = kind === 'square' ? [number(words[1], 'square'), number(words[1], 'square') * aspect] : pair(words[1], 'rect (x,y w,h)');
			return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
		}
		case 'circle': {
			const [cx, cy] = pair(words[0], 'circle');
			const r = number(words[1], 'circle (center, radius)');
			return [ellipsePoints(cx, cy, r, r * aspect)];
		}
		case 'ellipse': {
			const [cx, cy] = pair(words[0], 'ellipse');
			const [rx, ry] = pair(words[1], 'ellipse (center, rx,ry)');
			return [ellipsePoints(cx, cy, rx, ry * aspect)];
		}
		case 'arc': {
			const [cx, cy] = pair(words[0], 'arc');
			const r = number(words[1], 'arc (center, radius, from, to)');
			return [ellipsePoints(cx, cy, r, r * aspect, number(words[2], 'arc start angle'), number(words[3], 'arc end angle'))];
		}
		case 'star': {
			const [cx, cy] = pair(words[0], 'star');
			const r = number(words[1], 'star (center, radius)');
			const tips = Math.max(3, Math.min(24, words[2] ? number(words[2], 'star points') : 5));
			const points: DrawPoint[] = [];
			for (let i = 0; i <= tips * 2; i++) {
				const a = -Math.PI / 2 + i * Math.PI / tips;
				const radius = i % 2 ? r * 0.42 : r;
				points.push([cx + radius * Math.cos(a), cy + radius * aspect * Math.sin(a)]);
			}
			return [points];
		}
	}
	throw new Error(`unknown shape ${JSON.stringify(kind)}: use ${SHAPES.join(', ')}`);
}

/**
 * Shapes separated by `|` (or new lines) as strokes in the 0-100 space, clamped to it. A stroke
 * that starts where the one before ended continues it: in most drawing apps a press on a line
 * already drawn grabs that line instead of drawing. Throws with a message for the agent when a
 * shape does not parse. `aspect` (the target's width over its height) keeps circles round.
 */
export function parseShapes(spec: string, aspect = 1): DrawStroke[] {
	const strokes: DrawPoint[][] = [];
	for (const part of splitShapes(spec)) {
		for (const stroke of shape(part, aspect > 0 && Number.isFinite(aspect) ? aspect : 1)) {
			if (!stroke.length) {
				continue;
			}
			const points = stroke.map(([x, y]) => [clamp(x), clamp(y)] as const);
			const previous = strokes[strokes.length - 1];
			const end = previous?.[previous.length - 1];
			if (end && Math.abs(end[0] - points[0][0]) < 0.01 && Math.abs(end[1] - points[0][1]) < 0.01) {
				previous.push(...points.slice(1));
			} else {
				strokes.push(points);
			}
		}
	}
	if (!strokes.length) {
		throw new Error(`draw needs shapes: ${SHAPES.join(', ')}, e.g. circle 50,50 20 | line 10,90 90,90`);
	}
	if (strokes.length > MAX_STROKES || strokes.reduce((sum, stroke) => sum + stroke.length, 0) > MAX_POINTS) {
		throw new Error(`a draw step takes at most ${MAX_STROKES} strokes and ${MAX_POINTS} points; split the drawing into several steps`);
	}
	return strokes;
}

/** Splits on `|` outside quotes, so a path's data can be quoted. */
function splitShapes(spec: string): string[] {
	const parts: string[] = [];
	let quote = '';
	let start = 0;
	for (let i = 0; i < spec.length; i++) {
		const ch = spec[i];
		if (quote) {
			if (ch === quote) {
				quote = '';
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '|' || ch === '\n') {
			parts.push(spec.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(spec.slice(start));
	return parts.map(part => part.trim()).filter(Boolean);
}

//#region SVG paths

function cubic(p0: DrawPoint, p1: DrawPoint, p2: DrawPoint, p3: DrawPoint): DrawPoint[] {
	const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
	const steps = Math.max(6, Math.min(200, Math.ceil(length / 1.2)));
	const out: DrawPoint[] = [];
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push([
			u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
			u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
		]);
	}
	return out;
}

function quadratic(p0: DrawPoint, p1: DrawPoint, p2: DrawPoint): DrawPoint[] {
	return cubic(p0, [p0[0] + 2 / 3 * (p1[0] - p0[0]), p0[1] + 2 / 3 * (p1[1] - p0[1])], [p2[0] + 2 / 3 * (p1[0] - p2[0]), p2[1] + 2 / 3 * (p1[1] - p2[1])], p2);
}

/** An SVG elliptical arc (endpoint form) as points, per the SVG spec's center conversion. */
function arcPoints(p0: DrawPoint, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, p1: DrawPoint): DrawPoint[] {
	if (!rx || !ry || (p0[0] === p1[0] && p0[1] === p1[1])) {
		return [p1];
	}
	rx = Math.abs(rx);
	ry = Math.abs(ry);
	const phi = rotation * Math.PI / 180;
	const cos = Math.cos(phi), sin = Math.sin(phi);
	const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
	const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
	const scale = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
	if (scale > 1) {
		rx *= Math.sqrt(scale);
		ry *= Math.sqrt(scale);
	}
	const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
	const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
	const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
	const cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx;
	const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
	const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
	let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
	if (!sweep && delta > 0) {
		delta -= 2 * Math.PI;
	} else if (sweep && delta < 0) {
		delta += 2 * Math.PI;
	}
	const steps = Math.max(8, Math.ceil(Math.abs(delta) * Math.max(rx, ry) / 1.2));
	const out: DrawPoint[] = [];
	for (let i = 1; i <= steps; i++) {
		const a = start + delta * i / steps;
		const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
		out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
	}
	return out;
}

/**
 * SVG path data (M L H V C S Q T A Z, absolute and relative) as strokes: each `M` starts a new
 * stroke, curves become short straight segments.
 */
export function svgPathStrokes(d: string): DrawPoint[][] {
	const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
	const strokes: DrawPoint[][] = [];
	let stroke: DrawPoint[] = [];
	let at: DrawPoint = [0, 0];
	let start: DrawPoint = [0, 0];
	let lastControl: DrawPoint | undefined;
	let lastCommand = '';
	let i = 0;
	let command = '';
	const next = (): number => {
		const token = tokens[i++];
		if (token === undefined || /[a-z]/i.test(token)) {
			throw new Error(`path ${JSON.stringify(d.slice(0, 40))}: a ${command} command is missing a number`);
		}
		return Number(token);
	};
	const flush = () => {
		if (stroke.length) {
			strokes.push(stroke);
		}
		stroke = [];
	};
	while (i < tokens.length) {
		if (/[a-z]/i.test(tokens[i])) {
			command = tokens[i++];
		} else if (!command) {
			throw new Error('path data starts with a command such as M');
		}
		const relative = command === command.toLowerCase();
		const base: DrawPoint = relative ? at : [0, 0];
		const point = (): DrawPoint => {
			const x = next();
			const y = next();
			return [base[0] + x, base[1] + y];
		};
		switch (command.toUpperCase()) {
			case 'M':
				flush();
				at = point();
				start = at;
				stroke.push(at);
				// Further pairs after M are lines.
				command = relative ? 'l' : 'L';
				lastControl = undefined;
				break;
			case 'L':
				at = point();
				stroke.push(at);
				lastControl = undefined;
				break;
			case 'H':
				at = [relative ? at[0] + next() : next(), at[1]];
				stroke.push(at);
				lastControl = undefined;
				break;
			case 'V':
				at = [at[0], relative ? at[1] + next() : next()];
				stroke.push(at);
				lastControl = undefined;
				break;
			case 'C': {
				const c1 = point(), c2 = point(), end = point();
				stroke.push(...cubic(at, c1, c2, end));
				lastControl = c2;
				at = end;
				break;
			}
			case 'S': {
				const c1: DrawPoint = lastControl && /[CS]/i.test(lastCommand) ? [2 * at[0] - lastControl[0], 2 * at[1] - lastControl[1]] : at;
				const c2 = point(), end = point();
				stroke.push(...cubic(at, c1, c2, end));
				lastControl = c2;
				at = end;
				break;
			}
			case 'Q': {
				const c = point(), end = point();
				stroke.push(...quadratic(at, c, end));
				lastControl = c;
				at = end;
				break;
			}
			case 'T': {
				const c: DrawPoint = lastControl && /[QT]/i.test(lastCommand) ? [2 * at[0] - lastControl[0], 2 * at[1] - lastControl[1]] : at;
				const end = point();
				stroke.push(...quadratic(at, c, end));
				lastControl = c;
				at = end;
				break;
			}
			case 'A': {
				const rx = next(), ry = next(), rotation = next(), large = next() !== 0, sweep = next() !== 0;
				const end = point();
				stroke.push(...arcPoints(at, rx, ry, rotation, large, sweep, end));
				at = end;
				lastControl = undefined;
				break;
			}
			case 'Z':
				if (stroke.length) {
					stroke.push(start);
				}
				at = start;
				lastControl = undefined;
				break;
			default:
				throw new Error(`path command ${command} is not supported`);
		}
		lastCommand = command;
		if (!stroke.length && command.toUpperCase() !== 'M') {
			stroke.push(at);
		}
	}
	flush();
	return strokes;
}

//#endregion

/** Strokes in the 0-100 square mapped onto a box in screen points. */
export function placeStrokes(strokes: readonly DrawStroke[], box: readonly [number, number, number, number]): DrawPoint[][] {
	const [x, y, w, h] = box;
	return strokes.map(stroke => stroke.map(([px, py]) => [Math.round((x + px / 100 * w) * 10) / 10, Math.round((y + py / 100 * h) * 10) / 10] as const));
}
