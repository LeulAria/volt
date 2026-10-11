/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Rounded rectangles with Apple's continuous ("squircle") corners, as one list of path commands that
 * three.js shapes, canvas paths and CSS clip paths all draw. Coordinates are y-down like CSS.
 *
 * The corner math follows Figma's corner smoothing (MIT, figma-squircle): each corner is a short
 * circular arc between two cubic curves, and `smoothing` (0..1) trades arc for curve.
 */
import { Shape, Path } from "three";

export type PathCommand =
	| { readonly op: "M" | "L"; readonly x: number; readonly y: number }
	| { readonly op: "C"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number };

interface CornerParams {
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
	readonly p: number;
	readonly arc: number;
	readonly radius: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

function cornerParams(radius: number, smoothing: number, budget: number): CornerParams {
	let p = (1 + smoothing) * radius;
	const maxSmoothing = budget / radius - 1;
	smoothing = Math.max(0, Math.min(smoothing, maxSmoothing));
	p = Math.min(p, budget);
	const arcMeasure = 90 * (1 - smoothing);
	const arc = Math.sin(toRadians(arcMeasure / 2)) * radius * Math.SQRT2;
	const alpha = (90 - arcMeasure) / 2;
	const p3ToP4 = radius * Math.tan(toRadians(alpha / 2));
	const beta = 45 * smoothing;
	const c = p3ToP4 * Math.cos(toRadians(beta));
	const d = c * Math.tan(toRadians(beta));
	const b = (p - arc - c - d) / 3;
	const a = 2 * b;
	return { a, b, c, d, p, arc, radius };
}

/** A circular arc as one cubic, from angle `from` to `to` (radians, y-down) around (cx, cy). */
function arcCubic(cx: number, cy: number, r: number, from: number, to: number): PathCommand {
	const k = (4 / 3) * Math.tan((to - from) / 4);
	const x0 = cx + r * Math.cos(from);
	const y0 = cy + r * Math.sin(from);
	const x3 = cx + r * Math.cos(to);
	const y3 = cy + r * Math.sin(to);
	return {
		op: "C",
		x1: x0 - k * r * Math.sin(from),
		y1: y0 + k * r * Math.cos(from),
		x2: x3 + k * r * Math.sin(to),
		y2: y3 - k * r * Math.cos(to),
		x: x3,
		y: y3,
	};
}

/**
 * The outline of a `width` × `height` rectangle at (x, y) with corner `radius` and `smoothing`,
 * clockwise from the top edge. Per-corner radii: [top-left, top-right, bottom-right, bottom-left].
 */
export function roundedRect(
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number | readonly [number, number, number, number],
	smoothing = 0,
): PathCommand[] {
	const radii = typeof radius === "number" ? [radius, radius, radius, radius] : radius;
	const budget = Math.min(width, height) / 2;
	const params = radii.map((r) => (r > 0.0001 ? cornerParams(Math.min(r, budget), smoothing, budget) : undefined));
	const out: PathCommand[] = [];
	// Each corner in its own frame: u runs along the edge arriving at the corner, v along the edge leaving it.
	const corner = (k: CornerParams | undefined, cx: number, cy: number, u: readonly [number, number], v: readonly [number, number]) => {
		const at = (du: number, dv: number) => ({ x: cx + u[0] * du + v[0] * dv, y: cy + u[1] * du + v[1] * dv });
		if (!k) {
			out.push({ op: out.length ? "L" : "M", ...at(0, 0) });
			return;
		}
		const { a, b, c, d, p, arc, radius: r } = k;
		const start = at(-p, 0);
		out.push({ op: out.length ? "L" : "M", ...start });
		const c1 = at(-p + a, 0);
		const c2 = at(-p + a + b, 0);
		const e1 = at(-p + a + b + c, d);
		out.push({ op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: e1.x, y: e1.y });
		const e2 = at(-p + a + b + c + arc, d + arc);
		if (arc > 0.0001) {
			const center = at(-r, r);
			const from = Math.atan2(e1.y - center.y, e1.x - center.x);
			let to = Math.atan2(e2.y - center.y, e2.x - center.x);
			while (to - from > Math.PI) {
				to -= 2 * Math.PI;
			}
			while (from - to > Math.PI) {
				to += 2 * Math.PI;
			}
			out.push(arcCubic(center.x, center.y, r, from, to));
		}
		const c3 = at(-p + a + b + c + arc + d, d + arc + c);
		const c4 = at(-p + a + b + c + arc + d, d + arc + b + c);
		const end = at(0, p);
		out.push({ op: "C", x1: c3.x, y1: c3.y, x2: c4.x, y2: c4.y, x: end.x, y: end.y });
	};
	const [tl, tr, br, bl] = params;
	corner(tr, x + width, y, [1, 0], [0, 1]);
	corner(br, x + width, y + height, [0, 1], [-1, 0]);
	corner(bl, x, y + height, [-1, 0], [0, -1]);
	corner(tl, x, y, [0, -1], [1, 0]);
	const first = out[0];
	out.push({ op: "L", x: first.x, y: first.y });
	return out;
}

/** Draws commands into a three.js Shape or Path, flipping y so the shape is y-up around (0, 0) when `flipY`. */
export function toShape<T extends Shape | Path>(target: T, commands: readonly PathCommand[], flipY = true): T {
	const fy = (y: number) => (flipY ? -y : y);
	for (const cmd of commands) {
		switch (cmd.op) {
			case "M":
				target.moveTo(cmd.x, fy(cmd.y));
				break;
			case "L":
				target.lineTo(cmd.x, fy(cmd.y));
				break;
			case "C":
				target.bezierCurveTo(cmd.x1, fy(cmd.y1), cmd.x2, fy(cmd.y2), cmd.x, fy(cmd.y));
				break;
		}
	}
	return target;
}

/** Draws commands into a 2D canvas path. */
export function toCanvas(ctx: CanvasRenderingContext2D | Path2D, commands: readonly PathCommand[]): void {
	for (const cmd of commands) {
		switch (cmd.op) {
			case "M":
				ctx.moveTo(cmd.x, cmd.y);
				break;
			case "L":
				ctx.lineTo(cmd.x, cmd.y);
				break;
			case "C":
				ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
				break;
		}
	}
}

/** The commands as an SVG path, for CSS `clip-path: path(...)`. */
export function toSvgPath(commands: readonly PathCommand[]): string {
	const f = (n: number) => (Math.round(n * 100) / 100).toString();
	return (
		commands
			.map((cmd) =>
				cmd.op === "C"
					? `C${f(cmd.x1)} ${f(cmd.y1)} ${f(cmd.x2)} ${f(cmd.y2)} ${f(cmd.x)} ${f(cmd.y)}`
					: `${cmd.op}${f(cmd.x)} ${f(cmd.y)}`,
			)
			.join("") + "Z"
	);
}
