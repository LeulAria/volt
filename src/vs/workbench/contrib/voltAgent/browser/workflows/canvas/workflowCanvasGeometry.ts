/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IWorkflowLayoutOptions } from '../../../../../services/voltRuntime/common/workflows/workflowGraph.js';
import { getWorkflowNodeType, nodeOutputs } from '../../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowNode, IWorkflowNodeType, IWorkflowPosition, WorkflowPortKind } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';

/**
 * Node metrics and edge routes, in world px. Pure (no DOM), so auto-layout, the template script
 * and the canvas share one source of sizes. Every size here is written to the DOM as is: ports
 * and edges line up exactly and nothing is measured during a gesture.
 *
 * Every card is a header and one labelled row per output port. The input handle sits on the
 * first row's centre line, the same line as the first output, so a chain of nodes at one height
 * is joined by straight edges.
 */

export type Vec = readonly [number, number];

export interface IRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Snap grid and dot grid spacing. */
export const GRID = 16;

export const CARD_WIDTH = 240;
export const START_WIDTH = 256;
export const HEAD_HEIGHT = 48;
/** Space above the first and below the last port row. */
export const PORTS_PAD = 4;
export const PORT_ROW = 24;
/** The first port row's centre (and the input handle's), from the card's top. */
export const FIRST_PORT_Y = HEAD_HEIGHT + PORTS_PAD + PORT_ROW / 2;
export const ROUND_SIZE = 48;
/** The name and summary under a round node. */
export const ROUND_LABEL = 38;
export const PILL_WIDTH = 184;
export const PILL_HEIGHT = 36;
/** Arrowhead length and half width; its tip stops at the input handle's ring. */
export const ARROW = 6;
export const ARROW_HALF = 3.5;
export const ARROW_GAP = 4;

/** Gaps auto-layout leaves between columns and between nodes in a column. */
export const LAYOUT_LAYER_GAP = 96;
export const LAYOUT_NODE_GAP = 48;

export type NodeShape = 'card' | 'round' | 'pill' | 'start';

export interface IPortLayout {
	readonly id: string;
	readonly label: string;
	readonly kind: WorkflowPortKind;
	/** Node-local centre of the dot. */
	readonly x: number;
	readonly y: number;
}

export interface INodeLayout {
	readonly shape: NodeShape;
	readonly width: number;
	readonly height: number;
	/** What hangs under the box and belongs to the node (a round node's label). */
	readonly below: number;
	readonly input?: Vec;
	readonly outputs: readonly IPortLayout[];
	/** Ports drawn as labelled rows (cards and the start node). */
	readonly rows: boolean;
	/** The line edges meet the node on: the input handle, else the first output. Layout aligns these. */
	readonly anchor: number;
}

const layouts = new WeakMap<IWorkflowNode, INodeLayout>();

/** The node's box and ports. Cached per node object (nodes are immutable). */
export function layoutNode(node: IWorkflowNode): INodeLayout {
	let layout = layouts.get(node);
	if (!layout) {
		layout = computeLayout(node, getWorkflowNodeType(node.type));
		layouts.set(node, layout);
	}
	return layout;
}

function computeLayout(node: IWorkflowNode, type: IWorkflowNodeType | undefined): INodeLayout {
	let ports: ReturnType<typeof nodeOutputs> = [];
	try {
		ports = type ? nodeOutputs(node) : [];
	} catch {
		// A type's outputs() choking on odd config must not take the canvas down; validation reports it.
	}
	const outputs = ports.map(port => ({ id: port.id, label: port.label, kind: port.kind ?? 'neutral' }));
	const hasInput = !type || type.inputs.length > 0;
	if (type?.shape === 'round' && outputs.length <= 1) {
		const c = ROUND_SIZE / 2;
		return {
			shape: 'round', width: ROUND_SIZE, height: ROUND_SIZE, below: ROUND_LABEL, rows: false, anchor: c,
			input: hasInput ? [0, c] : undefined,
			outputs: outputs.map(port => ({ ...port, x: ROUND_SIZE, y: c })),
		};
	}
	if (type?.shape === 'pill' && outputs.length <= 1 && (!outputs.length || outputs[0].kind === 'neutral')) {
		const c = PILL_HEIGHT / 2;
		return {
			shape: 'pill', width: PILL_WIDTH, height: PILL_HEIGHT, below: 0, rows: false, anchor: c,
			input: hasInput ? [0, c] : undefined,
			outputs: outputs.map(port => ({ ...port, x: PILL_WIDTH, y: c })),
		};
	}
	const shape: NodeShape = type?.control === 'start' ? 'start' : 'card';
	const width = shape === 'start' ? START_WIDTH : CARD_WIDTH;
	if (!outputs.length) {
		// Nothing leaves it: the header alone, the input on its centre line.
		const c = HEAD_HEIGHT / 2;
		return { shape, width, height: HEAD_HEIGHT, below: 0, rows: false, anchor: c, input: hasInput ? [0, c] : undefined, outputs: [] };
	}
	return {
		shape, width, height: HEAD_HEIGHT + PORTS_PAD * 2 + outputs.length * PORT_ROW, below: 0, rows: true, anchor: FIRST_PORT_Y,
		input: hasInput ? [0, FIRST_PORT_Y] : undefined,
		outputs: outputs.map((port, i) => ({ ...port, x: width, y: FIRST_PORT_Y + i * PORT_ROW })),
	};
}

/** What auto-layout needs of a node: its full size and where its edges meet it, from its top. */
export function nodeLayoutSize(node: IWorkflowNode): { readonly width: number; readonly height: number; readonly input: number; readonly outputs: readonly number[] } {
	const layout = layoutNode(node);
	return { width: layout.width, height: layout.height + layout.below, input: layout.anchor, outputs: layout.outputs.map(port => port.y) };
}

/** Auto-layout options with the canvas's real node sizes and gaps (the canvas and the template script use this). */
export function canvasLayoutOptions(definition: Pick<IWorkflowDefinition, 'nodes'>, only?: ReadonlySet<string>): IWorkflowLayoutOptions {
	return {
		layerGap: LAYOUT_LAYER_GAP,
		nodeGap: LAYOUT_NODE_GAP,
		sizes: new Map(definition.nodes.map(node => [node.id, nodeLayoutSize(node)])),
		...(only ? { only } : {}),
	};
}

export function nodeRect(position: IWorkflowPosition, layout: INodeLayout): IRect {
	return { x: position.x, y: position.y, width: layout.width, height: layout.height };
}

/** The box plus what hangs under it, for fitting, marquee, obstacles and group frames. */
export function nodeBounds(position: IWorkflowPosition, layout: INodeLayout): IRect {
	return { x: position.x, y: position.y, width: layout.width, height: layout.height + layout.below };
}

export function rectsIntersect(a: IRect, b: IRect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function unionRects(rects: readonly IRect[]): IRect | undefined {
	if (!rects.length) {
		return undefined;
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const r of rects) {
		minX = Math.min(minX, r.x);
		minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.width);
		maxY = Math.max(maxY, r.y + r.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function snap(value: number, grid = GRID): number {
	return Math.round(value / grid) * grid;
}

//#region Routes

export interface IEdgeRoute {
	readonly d: string;
	/** The arrowhead, a closed triangle whose tip touches the input handle. */
	readonly arrow: string;
	/** Where the hover tools and labels sit. */
	readonly mid: Vec;
	readonly backward: boolean;
}

export interface IRouteOptions {
	/** Other nodes' bounds: a looping edge's horizontal run goes around them. */
	readonly obstacles?: readonly IRect[];
	/** The source port's index among the node's ports, so loops from neighbouring ports nest instead of crossing. */
	readonly port?: number;
	readonly ports?: number;
}

/** Room a step needs between the port and the line's end to count as forward. */
const MIN_STEP = 8;
/** Clearance between a looping edge and the nodes it goes around. */
const LANE_CLEARANCE = 20;
/** How far a looping edge runs straight out of its port and into its handle. */
const STUB = 16;
/** Spacing between nested loops from neighbouring ports. */
const NEST = 8;
const CORNER = 8;

function n(value: number): string {
	return String(Math.round(value * 10) / 10);
}

export function arrowPath(tip: Vec): string {
	const [x, y] = tip;
	return `M${n(x - ARROW)} ${n(y - ARROW_HALF)}L${n(x)} ${n(y)}L${n(x - ARROW)} ${n(y + ARROW_HALF)}Z`;
}

/** The arrow tip for an input handle at `handle` (world). */
export function arrowTip(handle: Vec): Vec {
	return [handle[0] - ARROW_GAP, handle[1]];
}

/**
 * The edge from an output dot to an input handle, straight runs joined by rounded corners. A
 * handle ahead of the port gets a straight line when the two line up, else a step: out of the
 * port, one vertical run halfway across the gap, into the handle. A handle behind the port goes
 * around: through the gap when one node sits clear above the other, else along a lane just below
 * (or above) both, so it never cuts through a node.
 */
export function routeEdge(source: Vec, handle: Vec, from: IRect, to: IRect, options: IRouteOptions = {}): IEdgeRoute {
	const tip = arrowTip(handle);
	const end: Vec = [tip[0] - ARROW + 0.5, tip[1]];
	const arrow = arrowPath(tip);
	const [sx, sy] = source;
	const [ex, ey] = end;
	if (ex - sx >= MIN_STEP) {
		if (Math.abs(ey - sy) < 2) {
			return { d: `M${n(sx)} ${n(sy)}L${n(ex)} ${n(ey)}`, arrow, mid: [(sx + ex) / 2, sy], backward: false };
		}
		const x = Math.round((sx + ex) / 2);
		return { d: stepPath(sx, sy, x, ex, ey), arrow, mid: [x, (sy + ey) / 2], backward: false };
	}
	const { lane, below } = loopLane(sy, ey, from, to, options.obstacles ?? []);
	// Lower ports nest inside when the loop goes below, upper ports when it goes above.
	const index = options.port ?? 0;
	const count = Math.max(1, options.ports ?? 1);
	const slot = below ? count - 1 - index : index;
	const x1 = Math.max(sx, from.x + from.width) + STUB + slot * NEST;
	const x2 = Math.min(ex, to.x) - STUB - slot * NEST;
	const y = below ? lane + slot * NEST : lane - slot * NEST;
	const points: Vec[] = [[sx, sy], [x1, sy], [x1, y], [x2, y], [x2, ey], [ex, ey]];
	return { d: roundedPath(points, CORNER), arrow, mid: [(x1 + x2) / 2, y], backward: true };
}

/**
 * Across to `x`, along it to the handle's row, into the handle. The corner into the handle keeps
 * the full radius and the first one gives way on a short drop, so edges merging into one handle
 * share their last corner exactly instead of forking just before it.
 */
function stepPath(sx: number, sy: number, x: number, ex: number, ey: number): string {
	const dir = Math.sign(ey - sy);
	const drop = Math.abs(ey - sy);
	const last = Math.min(CORNER, drop, ex - x);
	let first = Math.min(CORNER, drop - last, x - sx);
	first = first < 0.5 ? 0 : first;
	let d = `M${n(sx)} ${n(sy)}L${n(x - first)} ${n(sy)}`;
	if (first) {
		d += `Q${n(x)} ${n(sy)} ${n(x)} ${n(sy + dir * first)}`;
	}
	return d + `L${n(x)} ${n(ey - dir * last)}Q${n(x)} ${n(ey)} ${n(x + last)} ${n(ey)}L${n(ex)} ${n(ey)}`;
}

/**
 * The horizontal run of a looping edge. Through the gap between the two nodes when one sits
 * clear above the other and nothing is in the way; else just below both (and below anything in
 * between), or above when that is clearly the shorter way.
 */
function loopLane(sy: number, ey: number, from: IRect, to: IRect, obstacles: readonly IRect[]): { lane: number; below: boolean } {
	// The horizontal run spans from just left of the target to just right of the source.
	const left = Math.min(from.x, to.x) - STUB * 2;
	const right = from.x + from.width + STUB * 2;
	const isEnd = (o: IRect) => (o.x === from.x && o.y === from.y) || (o.x === to.x && o.y === to.y);
	const inCorridor = obstacles.filter(o => o.x < right && o.x + o.width > left && !isEnd(o));
	const blocked = (y: number) => inCorridor.some(o => o.y - LANE_CLEARANCE < y && o.y + o.height + LANE_CLEARANCE > y);
	const fromBottom = from.y + from.height, toBottom = to.y + to.height;
	// `below`: the run is under the source (the edge turns down out of its port).
	for (const [upper, lower, below] of [[to, from, false], [from, to, true]] as const) {
		const top = upper.y + upper.height, bottom = lower.y;
		if (top + LANE_CLEARANCE * 2 <= bottom) {
			const lane = Math.round((top + bottom) / 2);
			if (!blocked(lane)) {
				return { lane, below };
			}
		}
	}
	let down = Math.max(fromBottom, toBottom) + LANE_CLEARANCE;
	for (let guard = 0; guard < 64 && blocked(down); guard++) {
		down = Math.max(...inCorridor.filter(o => o.y - LANE_CLEARANCE < down && o.y + o.height + LANE_CLEARANCE > down).map(o => o.y + o.height)) + LANE_CLEARANCE;
	}
	let up = Math.min(from.y, to.y) - LANE_CLEARANCE;
	for (let guard = 0; guard < 64 && blocked(up); guard++) {
		up = Math.min(...inCorridor.filter(o => o.y - LANE_CLEARANCE < up && o.y + o.height + LANE_CLEARANCE > up).map(o => o.y)) - LANE_CLEARANCE;
	}
	const costDown = Math.abs(down - sy) + Math.abs(down - ey);
	const costUp = Math.abs(up - sy) + Math.abs(up - ey);
	// Below reads as "goes back round"; above only when it is clearly the shorter way.
	return costUp + 48 < costDown ? { lane: up, below: false } : { lane: down, below: true };
}

/** A polyline with its corners rounded (quadratic, radius shrunk on short segments). */
export function roundedPath(points: readonly Vec[], radius: number): string {
	const clean: Vec[] = [];
	for (const p of points) {
		const last = clean[clean.length - 1];
		if (!last || Math.abs(last[0] - p[0]) > 0.01 || Math.abs(last[1] - p[1]) > 0.01) {
			clean.push(p);
		}
	}
	let d = `M${n(clean[0][0])} ${n(clean[0][1])}`;
	for (let i = 1; i < clean.length - 1; i++) {
		const a = clean[i - 1], p = clean[i], b = clean[i + 1];
		const inLen = Math.hypot(p[0] - a[0], p[1] - a[1]);
		const outLen = Math.hypot(b[0] - p[0], b[1] - p[1]);
		const r = Math.min(radius, inLen / 2, outLen / 2);
		if (r < 0.5) {
			d += `L${n(p[0])} ${n(p[1])}`;
			continue;
		}
		const p1: Vec = [p[0] - (p[0] - a[0]) / inLen * r, p[1] - (p[1] - a[1]) / inLen * r];
		const p2: Vec = [p[0] + (b[0] - p[0]) / outLen * r, p[1] + (b[1] - p[1]) / outLen * r];
		d += `L${n(p1[0])} ${n(p1[1])}Q${n(p[0])} ${n(p[1])} ${n(p2[0])} ${n(p2[1])}`;
	}
	const last = clean[clean.length - 1];
	if (clean.length > 1) {
		d += `L${n(last[0])} ${n(last[1])}`;
	}
	return d;
}

/**
 * The live line from a port to the pointer, stepped like a placed edge: out of the port, one
 * vertical run halfway across, into the pointer. Behind the port the vertical run stays a stub
 * ahead of it, so the line never jumps.
 */
export function routeToPointer(source: Vec, pointer: Vec): string {
	const [sx, sy] = source;
	const [cx, cy] = pointer;
	const x = Math.max(sx + STUB, (sx + cx) / 2);
	return roundedPath([[sx, sy], [x, sy], [x, cy], [cx, cy]], CORNER);
}

/** A step from a port to a point (the empty state's branches). */
export function stepBetween(a: Vec, b: Vec): string {
	const x = (a[0] + b[0]) / 2;
	return roundedPath([a, [x, a[1]], [x, b[1]], b], CORNER);
}

//#endregion
