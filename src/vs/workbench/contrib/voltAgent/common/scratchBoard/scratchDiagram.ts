/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { elbowRouteScore, facingSide, IScratchLeg, IScratchObstacle, IScratchRouteContext, legsOf, normalizeLinear, rebindConnector, routeCrossings, routeElbowThrough, routeObstacles, routeOverlap, ScratchSide, separateElbowLegs, withLegs } from './scratchBinding.js';
import { connectorLabelAnchor, labelBoxAt } from './scratchDrawing.js';
import { createFrame, createLabel, createLinear, createShape } from './scratchFactory.js';
import { escapeHtml } from './scratchHtml.js';
import { geometricBounds, linearHitPolyline } from './scratchGeometry.js';
import { layeredLayoutWithRoutes } from './scratchLayout.js';
import { boundsIntersect, expandBounds, pointAlongPolyline, segmentEntersBounds, type Vec } from './scratchMath.js';
import { graphToMermaid, IMermaidColors, IMermaidEdge, IMermaidGraph, IMermaidNode, MermaidCurve, MermaidNodeShape } from './scratchMermaid.js';
import {
	AGENT_SCRATCH_STYLE, DEFAULT_SCRATCH_STYLE, IScratchBounds, IScratchFrameElement, IScratchLinearElement, IScratchShapeElement, IScratchStyleDefaults,
	isLinear, SCRATCH_BINDING_GAP, SCRATCH_STROKE_WIDTHS, ScratchArrowType, ScratchElement, ScratchFontFamily, ScratchPoint, ScratchRoundness, ScratchShapeKind,
} from './scratchTypes.js';

/** Board elements to and from Mermaid flowcharts. */

const CHAR_WIDTH = 9;
const LINE_HEIGHT = 25;
const WRAP_AT = 24;
const FRAME_PADDING = 32;

const SHAPE_FOR: Readonly<Record<MermaidNodeShape, { readonly shape: ScratchShapeKind; readonly roundness: ScratchRoundness }>> = {
	rectangle: { shape: 'rectangle', roundness: 'sharp' },
	rounded: { shape: 'rectangle', roundness: 'round' },
	stadium: { shape: 'pill', roundness: 'round' },
	diamond: { shape: 'diamond', roundness: 'round' },
	circle: { shape: 'ellipse', roundness: 'round' },
	hexagon: { shape: 'hexagon', roundness: 'round' },
	cylinder: { shape: 'cylinder', roundness: 'round' },
	parallelogram: { shape: 'parallelogram', roundness: 'round' },
	subroutine: { shape: 'rectangle', roundness: 'sharp' },
	document: { shape: 'document', roundness: 'round' },
};

/** Word-wraps a label for sizing; explicit newlines stay. */
function wrapLines(label: string): string[] {
	const out: string[] = [];
	for (const raw of label.split('\n')) {
		const words = raw.split(/\s+/).filter(Boolean);
		let line = '';
		for (const word of words) {
			if (line && (line.length + 1 + word.length) > WRAP_AT) {
				out.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		out.push(line);
	}
	return out.length ? out : [''];
}

/** A label's average character width and line height in a font (the hand font draws wide and tall). */
function textMetrics(family: ScratchFontFamily, fontSize: number): { readonly char: number; readonly line: number } {
	return family === 'hand'
		? { char: CHAR_WIDTH * fontSize / 20, line: LINE_HEIGHT * fontSize / 20 }
		: { char: fontSize * 0.56, line: fontSize * 1.4 };
}

function nodeSize(node: IMermaidNode, style: IScratchStyleDefaults): { width: number; height: number } {
	const lines = wrapLines(node.label);
	const longest = Math.max(0, ...lines.map(l => l.length));
	const metrics = textMetrics(style.fontFamily, style.fontSize);
	// Even padding round every label: 28px either side, 20px above and below.
	let width = Math.max(140, longest * metrics.char + 56);
	let height = Math.max(60, lines.length * metrics.line + 40);
	switch (node.shape) {
		case 'diamond': width *= 1.5; height *= 1.6; break;
		case 'circle': { const side = Math.max(width, height) * 1.3; width = side; height = side; break; }
		case 'hexagon': width += 40; break;
		case 'parallelogram': width += 48; break;
		case 'cylinder': height += 32; break;
		case 'document': height += 16; break;
		case 'stadium': width += 24; break;
	}
	return { width: Math.round(width), height: Math.round(height) };
}

/** Edge labels: 16px in the hand font, a size under the nodes' otherwise. */
function edgeLabelSize(style: IScratchStyleDefaults): number {
	return style.fontFamily === 'hand' ? 16 : Math.max(12, style.fontSize - 3);
}

/** An edge label's box in the edge label font, with a little air. */
function edgeLabelBox(label: string, style: IScratchStyleDefaults): { readonly width: number; readonly height: number } {
	const lines = label.split('\n');
	const metrics = textMetrics(style.fontFamily, edgeLabelSize(style));
	return { width: Math.max(...lines.map(l => l.length)) * metrics.char + 16, height: lines.length * metrics.line + 12 };
}

function labelHtml(text: string): string {
	return text.split('\n').map(line => `<p>${escapeHtml(line)}</p>`).join('');
}

const LANE_GAP = FRAME_PADDING * 2 + 32;
const LANE_NODE_GAP = 40;
const LANE_MIN_WIDTH = 180;

interface ILanes {
	readonly positions: Map<string, Vec>;
	/** Each subgraph's lane, padded, every lane as long as the whole diagram. */
	readonly frames: Map<string, { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>;
}

/**
 * Subgraphs as swimlanes: each gets a column (a row for LR), steps keep their order along the flow,
 * and lanes never overlap. Without this a flow that goes back and forth between actors (a request
 * flow, a login) frames scattered nodes, and the frames pile onto each other.
 */
function swimlanes(graph: IMermaidGraph, sizes: ReadonlyMap<string, { width: number; height: number }>, positions: ReadonlyMap<string, Vec>): ILanes | undefined {
	const laneOf = new Map<string, number>();
	graph.subgraphs.forEach((sub, i) => {
		for (const id of sub.nodeIds) {
			if (sizes.has(id) && !laneOf.has(id)) {
				laneOf.set(id, i);
			}
		}
	});
	if (!laneOf.size) {
		return undefined;
	}
	const vertical = graph.direction === 'TB' || graph.direction === 'BT';
	const mainOf = (id: string) => vertical ? positions.get(id)![1] : positions.get(id)![0];
	const mainSize = (id: string) => vertical ? sizes.get(id)!.height : sizes.get(id)!.width;
	const crossSize = (id: string) => vertical ? sizes.get(id)!.width : sizes.get(id)!.height;
	// Nodes outside every subgraph share one lane before the others, without a frame.
	const loose = graph.nodes.map(n => n.id).filter(id => !laneOf.has(id));
	const lanes: { readonly key: number | undefined; readonly ids: string[] }[] = [];
	if (loose.length) {
		lanes.push({ key: undefined, ids: loose });
	}
	graph.subgraphs.forEach((_, i) => {
		const ids = graph.nodes.map(n => n.id).filter(id => laneOf.get(id) === i);
		if (ids.length) {
			lanes.push({ key: i, ids });
		}
	});
	const out = new Map<string, Vec>();
	const extents: { readonly key: number | undefined; readonly from: number; readonly size: number }[] = [];
	let cross = 0;
	for (const lane of lanes) {
		// Steps of one lane that share a rank sit side by side.
		const sorted = [...lane.ids].sort((a, b) => mainOf(a) - mainOf(b));
		const clusters: string[][] = [];
		let end = -Infinity;
		for (const id of sorted) {
			if (clusters.length && mainOf(id) < end) {
				clusters[clusters.length - 1].push(id);
			} else {
				clusters.push([id]);
			}
			end = Math.max(end, mainOf(id) + mainSize(id));
		}
		const widthOf = (cluster: readonly string[]) => cluster.reduce((sum, id) => sum + crossSize(id), 0) + LANE_NODE_GAP * (cluster.length - 1);
		const laneSize = Math.max(LANE_MIN_WIDTH, ...clusters.map(widthOf));
		for (const cluster of clusters) {
			let at = cross + (laneSize - widthOf(cluster)) / 2;
			for (const id of cluster) {
				const main = mainOf(id);
				out.set(id, vertical ? [at, main] : [main, at]);
				at += crossSize(id) + LANE_NODE_GAP;
			}
		}
		extents.push({ key: lane.key, from: cross, size: laneSize });
		cross += laneSize + LANE_GAP;
	}
	let mainMin = Infinity, mainMax = -Infinity;
	for (const id of out.keys()) {
		mainMin = Math.min(mainMin, mainOf(id));
		mainMax = Math.max(mainMax, mainOf(id) + mainSize(id));
	}
	const frames = new Map<string, { x: number; y: number; width: number; height: number }>();
	for (const extent of extents) {
		if (extent.key === undefined) {
			continue;
		}
		const sub = graph.subgraphs[extent.key];
		const crossFrom = extent.from - FRAME_PADDING, crossLen = extent.size + FRAME_PADDING * 2;
		const mainFrom = mainMin - FRAME_PADDING, mainLen = mainMax - mainMin + FRAME_PADDING * 2;
		frames.set(sub.id, vertical
			? { x: crossFrom, y: mainFrom, width: crossLen, height: mainLen }
			: { x: mainFrom, y: crossFrom, width: mainLen, height: crossLen });
	}
	return { positions: out, frames };
}

const ARROW_TYPE_FOR: Readonly<Record<MermaidCurve, ScratchArrowType>> = { elbow: 'elbow', round: 'round', straight: 'sharp' };
/** Room between connectors that leave or reach the same side of a shape. */
const PORT_SPACING = 28;

const FLOW: Readonly<Record<IMermaidGraph['direction'], Vec>> = { TB: [0, 1], BT: [0, -1], LR: [1, 0], RL: [-1, 0] };
/** Out of each side: top, right, bottom, left. */
const SIDE_OUT: Readonly<Record<ScratchSide, Vec>> = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };

/**
 * The sides an elbow joins: between steps, the sides along the flow (bottom to top in a top-down
 * chart, right to left across), whichever way the edge runs; within a step, the sides facing each
 * other.
 */
function flowSides(from: IScratchBounds, to: IScratchBounds, flow: Vec): readonly [ScratchSide, ScratchSide] {
	const vertical = flow[1] !== 0;
	const apart = vertical ? Math.max(to.minY - from.maxY, from.minY - to.maxY) : Math.max(to.minX - from.maxX, from.minX - to.maxX);
	if (!(apart > 0)) {
		return [facingSide(from, to), facingSide(to, from)];
	}
	if (vertical) {
		return to.minY >= from.maxY ? [2, 0] : [0, 2];
	}
	return to.minX >= from.maxX ? [1, 3] : [3, 1];
}

interface IPortEnd {
	readonly key: string;
	readonly nodeId: string;
	readonly side: ScratchSide;
	readonly box: IScratchBounds;
	/** Where the line heads from this end: the other end, or the first bend of a long edge. */
	readonly toward: Vec;
}

/** How far an end moves along its side to line up with the other end, so the edge runs straight. */
const ALIGN_REACH = 48;
/** Ports stay this far in from a side's ends. */
const PORT_INSET = 0.15;

/**
 * Anchors for elbow ends: the middle of their side, or spread along it when several share a side,
 * in the order of where they head, so they leave side by side instead of on top of each other (a
 * dotted line hidden under a solid one) and without crossing. Then an edge whose two ends face
 * each other a little out of line (`straight`, start and end keys) gets one end moved to line up
 * with the other, when its side has room: a straight line instead of a kink.
 */
function spreadPorts(ends: readonly IPortEnd[], straight: readonly (readonly [string, string])[]): Map<string, ScratchPoint> {
	const groups = new Map<string, IPortEnd[]>();
	for (const end of ends) {
		const id = `${end.nodeId}:${end.side}`;
		groups.set(id, [...groups.get(id) ?? [], end]);
	}
	// Each end's place along its side, in board coordinates.
	const at = new Map<string, number>();
	const groupOf = new Map<string, IPortEnd[]>();
	const across = (side: ScratchSide) => side === 0 || side === 2 ? 0 : 1;
	const range = (end: IPortEnd) => {
		const a = across(end.side);
		const lo = a === 0 ? end.box.minX : end.box.minY, hi = a === 0 ? end.box.maxX : end.box.maxY;
		return { lo, hi, from: lo + (hi - lo) * PORT_INSET, to: hi - (hi - lo) * PORT_INSET };
	};
	for (const group of groups.values()) {
		const a = across(group[0].side);
		group.sort((p, q) => p.toward[a] - q.toward[a]);
		const { lo, hi } = range(group[0]);
		const spacing = group.length > 1 ? Math.min(PORT_SPACING, (hi - lo) * 0.6 / (group.length - 1)) : 0;
		group.forEach((end, i) => {
			at.set(end.key, (lo + hi) / 2 + (i - (group.length - 1) / 2) * spacing);
			groupOf.set(end.key, group);
		});
	}
	const ends_ = new Map(ends.map(end => [end.key, end]));
	const fits = (key: string, value: number) => {
		const end = ends_.get(key)!;
		const { from, to } = range(end);
		if (value < from || value > to) {
			return false;
		}
		// Its neighbours on the side keep their order and some room.
		const group = groupOf.get(key)!;
		const i = group.findIndex(e => e.key === key);
		const before = group[i - 1], after = group[i + 1];
		return (!before || value - at.get(before.key)! >= PORT_SPACING * 0.6) && (!after || at.get(after.key)! - value >= PORT_SPACING * 0.6);
	};
	for (const [start, end] of straight) {
		const p = at.get(start), q = at.get(end);
		if (p === undefined || q === undefined || Math.abs(p - q) < 0.5 || Math.abs(p - q) > ALIGN_REACH) {
			continue;
		}
		// The end alone on its side moves first: it disturbs nothing.
		const order = (groupOf.get(end)!.length <= groupOf.get(start)!.length ? [[end, p], [start, q]] : [[start, q], [end, p]]) as [string, number][];
		const move = order.find(([key, value]) => fits(key, value));
		if (move) {
			at.set(move[0], move[1]);
		}
	}
	const anchors = new Map<string, ScratchPoint>();
	for (const end of ends) {
		const { lo, hi } = range(end);
		const f = (at.get(end.key)! - lo) / Math.max(1, hi - lo);
		anchors.set(end.key, end.side === 0 ? [f, 0] : end.side === 2 ? [f, 1] : end.side === 1 ? [1, f] : [0, f]);
	}
	return anchors;
}

/** Shapes, bound arrows and frames for a parsed flowchart, laid out from `origin`. */
export function mermaidToElements(graph: IMermaidGraph, origin: Vec, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): ScratchElement[] {
	const sizes = new Map<string, { width: number; height: number }>();
	for (const node of graph.nodes) {
		sizes.set(node.id, nodeSize(node, style));
	}
	const nodeIds = new Set(graph.nodes.map(n => n.id));
	const vertical = graph.direction === 'TB' || graph.direction === 'BT';
	const layout = layeredLayoutWithRoutes(
		graph.nodes.map(n => ({ id: n.id, ...sizes.get(n.id)! })),
		graph.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)).map(e => {
			if (!e.label) {
				return { from: e.from, to: e.to };
			}
			const box = edgeLabelBox(e.label, style);
			return { from: e.from, to: e.to, labelWidth: vertical ? box.width : box.height, labelLength: vertical ? box.height : box.width };
		}),
		graph.direction,
		// One gap between neighbours and a wider one between steps, the same all through the figure.
		{ node: 64, rank: 104 },
	);
	const lanes = swimlanes(graph, sizes, layout.positions);
	const positions = lanes?.positions ?? layout.positions;
	// Swimlanes move nodes across their lanes, so the bends no longer fit; the board routes elbows there.
	const routes = lanes ? undefined : layout.routes;

	const shapes = new Map<string, IScratchShapeElement>();
	for (const node of graph.nodes) {
		const size = sizes.get(node.id)!;
		const pos = positions.get(node.id) ?? [0, 0];
		const mapped = SHAPE_FOR[node.shape];
		shapes.set(node.id, createShape({
			x: origin[0] + pos[0],
			y: origin[1] + pos[1],
			width: size.width,
			height: size.height,
			shape: mapped.shape,
			roundness: mapped.roundness,
			// A coloured node is a flat tint: hachure behind a label reads as noise.
			...(node.fill ? { fill: node.fill, fillStyle: 'solid' as const } : {}),
			...(node.stroke ? { stroke: node.stroke } : {}),
			...(node.strokeStyle ? { strokeStyle: node.strokeStyle } : {}),
			label: node.label ? createLabel(labelHtml(node.label), style) : null,
		}, style));
	}

	const frames = new Map<string, IScratchFrameElement>();
	for (const sub of graph.subgraphs) {
		const members = sub.nodeIds.map(id => shapes.get(id)).filter((s): s is IScratchShapeElement => !!s);
		if (!members.length) {
			continue;
		}
		const lane = lanes?.frames.get(sub.id);
		const minX = lane ? origin[0] + lane.x : Math.min(...members.map(s => s.x)) - FRAME_PADDING;
		const minY = lane ? origin[1] + lane.y : Math.min(...members.map(s => s.y)) - FRAME_PADDING;
		const maxX = lane ? minX + lane.width : Math.max(...members.map(s => s.x + s.width)) + FRAME_PADDING;
		const maxY = lane ? minY + lane.height : Math.max(...members.map(s => s.y + s.height)) + FRAME_PADDING;
		const frame = createFrame({
			x: minX, y: minY, width: maxX - minX, height: maxY - minY, name: sub.label || sub.id,
			...(sub.fill ? { fill: sub.fill } : {}),
			...(sub.stroke ? { stroke: sub.stroke } : {}),
		}, style);
		frames.set(sub.id, frame);
		for (const member of sub.nodeIds) {
			const shape = shapes.get(member);
			if (shape) {
				shapes.set(member, { ...shape, frameId: frame.id });
			}
		}
	}

	const boxOf = (id: string): ScratchElement | undefined => shapes.get(id) ?? frames.get(id);
	const drawn = graph.edges.map(edge => ({ edge, from: boxOf(edge.from), to: boxOf(edge.to) }))
		.filter((e): e is { edge: IMermaidEdge; from: ScratchElement; to: ScratchElement } => !!e.from && !!e.to && e.from !== e.to);
	// Right angles unless the diagram asks for curves (`linkStyle ... interpolate basis`).
	const arrowTypeOf = (edge: IMermaidEdge) => ARROW_TYPE_FOR[edge.curve ?? graph.curve ?? 'elbow'];
	const flow = FLOW[graph.direction];
	const centre = (b: IScratchBounds): Vec => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
	// A long edge's bends from the layout, on the board.
	const viaOf = (edge: IMermaidEdge) => (routes?.get(`${edge.from}>${edge.to}`) ?? []).map((p): Vec => [origin[0] + p[0], origin[1] + p[1]]);
	const sides = drawn.map(({ from, to }) => flowSides(geometricBounds(from), geometricBounds(to), flow));
	const anchors = spreadPorts(drawn.flatMap(({ edge, from, to }, i): IPortEnd[] => {
		if (arrowTypeOf(edge) !== 'elbow') {
			return [];
		}
		const via = viaOf(edge);
		// The element's own box, which anchors are fractions of (its drawn bounds may differ by a hair).
		const a = { minX: from.x, minY: from.y, maxX: from.x + from.width, maxY: from.y + from.height };
		const b = { minX: to.x, minY: to.y, maxX: to.x + to.width, maxY: to.y + to.height };
		return [
			{ key: `${i}:start`, nodeId: from.id, side: sides[i][0], box: a, toward: via[0] ?? centre(b) },
			{ key: `${i}:end`, nodeId: to.id, side: sides[i][1], box: b, toward: via[via.length - 1] ?? centre(a) },
		];
	}), drawn.flatMap(({ edge }, i): (readonly [string, string])[] =>
		// Ends that face each other (bottom to top, side to side); a long edge's lane lines up after.
		arrowTypeOf(edge) === 'elbow' && Math.abs(sides[i][0] - sides[i][1]) === 2 ? [[`${i}:start`, `${i}:end`]] : []));
	const arrows: IScratchLinearElement[] = [];
	drawn.forEach(({ edge, from, to }, i) => {
		const arrowType = arrowTypeOf(edge);
		const a: Vec = [from.x + from.width / 2, from.y + from.height / 2];
		const b: Vec = [to.x + to.width / 2, to.y + to.height / 2];
		// A curve that skips ranks bends through its waypoints, around the nodes between its ends; an elbow is routed below.
		const bends = arrowType === 'round' ? routes?.get(`${edge.from}>${edge.to}`) ?? [] : [];
		const dotted = edge.strokeStyle ? edge.strokeStyle !== 'solid' : edge.style === 'dotted';
		arrows.push(createLinear({
			type: 'arrow',
			x: a[0],
			y: a[1],
			points: [[0, 0], ...bends.map((p): [number, number] => [origin[0] + p[0] - a[0], origin[1] + p[1] - a[1]]), [b[0] - a[0], b[1] - a[1]]],
			arrowType,
			startArrowhead: edge.startHead ? 'arrow' : 'none',
			endArrowhead: edge.endHead ? 'arrow' : 'none',
			startBinding: { elementId: from.id, anchor: anchors.get(`${i}:start`) ?? null },
			endBinding: { elementId: to.id, anchor: anchors.get(`${i}:end`) ?? null },
			// `-.->` is a row of dots; `linkStyle` can make it dashes (or solid) instead.
			strokeStyle: edge.strokeStyle ?? (edge.style === 'dotted' ? 'dotted' : 'solid'),
			// Dots a touch heavier than the solid lines, so a dotted step reads at a glance.
			strokeWidth: edge.strokeWidth ?? (edge.style === 'thick' ? style.strokeWidth * 2 : dotted ? Math.max(style.strokeWidth, SCRATCH_STROKE_WIDTHS.bold) : style.strokeWidth),
			...(edge.stroke ? { stroke: edge.stroke } : {}),
			fill: 'transparent',
			label: edge.label ? createLabel(labelHtml(edge.label), style, { fontSize: edgeLabelSize(style) }) : null,
		}, style));
	});

	// Elbows go round every shape in the figure, the way the board re-routes them when one moves,
	// and a long edge keeps to the lane the layout kept for it.
	// One after another, each keeping off the lines before it: the long edges first, in their lanes.
	const around = routeObstacles([...shapes.values()]);
	const byId = new Map<string, ScratchElement>([...shapes.values(), ...frames.values()].map(el => [el.id, el]));
	let context: IScratchRouteContext = { boxes: around, legs: [] };
	const routed = arrows.slice();
	const order = arrows.map((_, i) => i).sort((p, q) => Number(!viaOf(drawn[p].edge).length) - Number(!viaOf(drawn[q].edge).length) || p - q);
	for (const i of order) {
		const arrow = arrows[i];
		const patch = arrow.arrowType === 'elbow' ? rebindConnector(arrow, id => byId.get(id), SCRATCH_BINDING_GAP, context) : undefined;
		if (!patch) {
			continue;
		}
		const via = viaOf(drawn[i].edge);
		let points = patch.points.map((p): Vec => [patch.x + p[0], patch.y + p[1]]);
		if (via.length) {
			const { from, to } = drawn[i];
			const a = geometricBounds(from), b = geometricBounds(to);
			// Along the flow, or against it for an edge that runs back up.
			const along = (via[0][0] - points[0][0]) * flow[0] + (via[0][1] - points[0][1]) * flow[1] >= 0 ? flow : [-flow[0], -flow[1]] as Vec;
			const others = around.filter(o => o.id !== from.id && o.id !== to.id).map(o => o.bounds);
			const lane = routeElbowThrough(points[0], SIDE_OUT[sides[i][0]], via, along, points[points.length - 1], SIDE_OUT[sides[i][1]], [a, b], others, context.legs);
			// The lane the layout kept, unless the way round the shapes is shorter or straighter (the lane may sit off to one side).
			if (elbowRouteScore(lane, context.legs) < elbowRouteScore(points, context.legs)) {
				points = lane;
			}
		}
		routed[i] = { ...arrow, ...patch, ...normalizeLinear(points) };
		context = withLegs(context, arrow.id, points);
	}

	// Then each is routed again against all the others, and ends sharing a side swap places where that untangles them.
	const labelOf = new Map(drawn.map(({ edge }, i) => [routed[i].id, edge.label ? edgeLabelBox(edge.label, style) : undefined]));
	const untangled = untangleElbows(routed.filter(arrow => arrow.arrowType === 'elbow'), id => byId.get(id), around, id => labelOf.get(id));
	routed.forEach((arrow, i) => { routed[i] = untangled.get(arrow.id) ?? arrow; });

	// Lines that turn in the same gap get a track each, so none hides another.
	const elbows = routed.filter(arrow => arrow.arrowType === 'elbow');
	const tracks = separateElbowLegs(elbows.map(arrow => arrow.points.map((p): Vec => [arrow.x + p[0], arrow.y + p[1]])), around.map(o => o.bounds), elbows.map(arrow => labelOf.get(arrow.id)));
	const separated = new Map(elbows.map((arrow, i) => [arrow.id, tracks[i]]));
	const placed = routed.map(arrow => {
		const points = separated.get(arrow.id);
		return points ? { ...arrow, ...normalizeLinear(points) } : arrow;
	});

	return [...frames.values(), ...shapes.values(), ...placed];
}

/** Rounds of routing every line again against all the others; a round that changes nothing ends it. */
const UNTANGLE_ROUNDS = 4;
/** Cost of another line running through a line's label: worse than crossing a line. */
const LABEL_HIT_COST = 150;
/** The shortest leg between two bends a re-route may have. */
const MIN_STEP = 8;
/** Room kept round a label, so a line does not graze its text. */
const LABEL_PAD = 4;

type LabelSize = { readonly width: number; readonly height: number };

/** Routes the untangling may try per line in the figure, and the time it may take (ms): it stops there, keeping what it found. */
const UNTANGLE_BUDGET = 8;
const UNTANGLE_TIME = 400;
/** Ends sharing a side up to this many try every order of its ports; more try each pair swapped. */
const MAX_PORT_PERMUTE = 4;

/** The orders a side's ports can be handed out in, other than the one they have (index k takes port order[k]). */
function portOrders(n: number): number[][] {
	const out: number[][] = [];
	if (n > MAX_PORT_PERMUTE) {
		for (let p = 0; p < n; p++) {
			for (let q = p + 1; q < n; q++) {
				const order = [...Array(n).keys()];
				[order[p], order[q]] = [order[q], order[p]];
				out.push(order);
			}
		}
		return out;
	}
	const permute = (done: number[], rest: number[]) => {
		if (!rest.length) {
			if (done.some((v, i) => v !== i)) {
				out.push(done);
			}
			return;
		}
		rest.forEach((v, i) => permute([...done, v], [...rest.slice(0, i), ...rest.slice(i + 1)]));
	};
	permute([], [...Array(n).keys()]);
	return out;
}

function worldPoints(arrow: IScratchLinearElement): Vec[] {
	return arrow.points.map((p): Vec => [arrow.x + p[0], arrow.y + p[1]]);
}

/** Where a line's label sits (the middle of its route), padded. */
function labelRect(route: readonly Vec[], size: LabelSize): IScratchBounds {
	const mid = pointAlongPolyline(route, 0.5).point;
	const w = size.width / 2 + LABEL_PAD, h = size.height / 2 + LABEL_PAD;
	return { minX: mid[0] - w, minY: mid[1] - h, maxX: mid[0] + w, maxY: mid[1] + h };
}

/** A label's outline as legs: a line through it crosses two of them. */
function labelLegs(id: string, route: readonly Vec[], size: LabelSize | undefined): IScratchLeg[] {
	if (!size) {
		return [];
	}
	const r = labelRect(route, size);
	return [
		{ id, axis: 1, at: r.minY, lo: r.minX, hi: r.maxX, crossOnly: true },
		{ id, axis: 1, at: r.maxY, lo: r.minX, hi: r.maxX, crossOnly: true },
		{ id, axis: 0, at: r.minX, lo: r.minY, hi: r.maxY, crossOnly: true },
		{ id, axis: 0, at: r.maxX, lo: r.minY, hi: r.maxY, crossOnly: true },
	];
}

/** How many of `legs` (other lines) pass through a line's own label. */
function labelHits(route: readonly Vec[], size: LabelSize | undefined, legs: readonly IScratchLeg[]): number {
	if (!size) {
		return 0;
	}
	const r = labelRect(route, size);
	return legs.filter(leg => leg.axis === 1
		? leg.at > r.minY && leg.at < r.maxY && leg.hi > r.minX && leg.lo < r.maxX
		: leg.at > r.minX && leg.at < r.maxX && leg.hi > r.minY && leg.lo < r.maxY).length;
}

/**
 * Elbows routed one after another only keep off the lines before them. Here each is routed again
 * against all the others (their legs and their labels), and two ends on one side of a box swap
 * places where that crosses or overlaps less (a line coming from the left takes the left port). A
 * change stays only when it lowers the cost, so a round never makes the figure worse.
 * Returns the moved lines by id.
 */
function untangleElbows(arrows: readonly IScratchLinearElement[], lookup: (id: string) => ScratchElement | undefined, boxes: readonly IScratchObstacle[], labelOf: (id: string) => LabelSize | undefined): Map<string, IScratchLinearElement> {
	const lines = arrows.slice();
	const routes = lines.map(worldPoints);
	const lineLegs = (i: number, route: readonly Vec[] = routes[i]) => legsOf(lines[i].id, route);
	const allLegs = (i: number, route: readonly Vec[] = routes[i]) => [...lineLegs(i, route), ...labelLegs(`${lines[i].id}#label`, route, labelOf(lines[i].id))];
	const except = (skip: readonly number[]) => lines.flatMap((_, j) => skip.includes(j) ? [] : allLegs(j));
	const cost = (i: number, route: readonly Vec[], legs: readonly IScratchLeg[]) =>
		elbowRouteScore(route, legs) + labelHits(route, labelOf(lines[i].id), legs.filter(leg => !leg.crossOnly)) * LABEL_HIT_COST;
	// Only a line that runs on, crosses or runs through another line or label is worth routing again.
	const tangled = (i: number) => {
		const legs = except([i]);
		return routeOverlap(routes[i], legs) > 0 || routeCrossings(routes[i], legs) > 0 || labelHits(routes[i], labelOf(lines[i].id), legs.filter(leg => !leg.crossOnly)) > 0;
	};
	let budget = lines.length * UNTANGLE_BUDGET;
	const deadline = Date.now() + UNTANGLE_TIME;
	// Routed afresh from its two ends (with `arrow`'s anchors), round every box and off `legs`.
	const reroute = (arrow: IScratchLinearElement, legs: readonly IScratchLeg[]) => {
		if (budget-- <= 0 || Date.now() > deadline) {
			budget = 0;
			return undefined;
		}
		const route = worldPoints(arrow);
		const fresh = { ...arrow, ...normalizeLinear([route[0], route[route.length - 1]]) };
		const patch = rebindConnector(fresh, lookup, SCRATCH_BINDING_GAP, { boxes, legs });
		const next = patch && worldPoints({ ...arrow, ...patch });
		// A step of a few pixels between bends reads as a kink, not a turn.
		return next && next.every((p, k) => k < 2 || k === next.length - 1 || Math.hypot(p[0] - next[k - 1][0], p[1] - next[k - 1][1]) >= MIN_STEP) ? { arrow: { ...arrow, ...patch }, route: next } : undefined;
	};
	const moved = new Set<number>();
	// What was tried with no gain is tried again only after some other change (`version` counts them).
	let version = 0;
	const triedLine = new Map<number, number>();
	const triedSide = new Map<string, number>();

	// Ends that share a side of a box, which may trade places.
	const sides = new Map<string, { line: number; end: 'startBinding' | 'endBinding' }[]>();
	lines.forEach((line, i) => {
		for (const end of ['startBinding', 'endBinding'] as const) {
			const binding = line[end];
			const anchor = binding?.anchor;
			if (binding && anchor) {
				const side = anchor[1] <= 1e-6 ? 0 : anchor[0] >= 1 - 1e-6 ? 1 : anchor[1] >= 1 - 1e-6 ? 2 : 3;
				const key = `${binding.elementId}:${side}`;
				sides.set(key, [...sides.get(key) ?? [], { line: i, end }]);
			}
		}
	});

	for (let round = 0; round < UNTANGLE_ROUNDS; round++) {
		let changed = false;
		for (let i = 0; i < lines.length; i++) {
			if (triedLine.get(i) === version || !tangled(i)) {
				continue;
			}
			triedLine.set(i, version);
			const legs = except([i]);
			const next = reroute(lines[i], legs);
			if (next && cost(i, next.route, legs) < cost(i, routes[i], legs) - 1) {
				lines[i] = next.arrow;
				routes[i] = next.route;
				moved.add(i);
				changed = true;
				triedLine.set(i, ++version);
			}
		}
		for (const [side, ends] of sides) {
			if (ends.length < 2 || triedSide.get(side) === version || new Set(ends.map(e => e.line)).size < ends.length || !ends.some(e => tangled(e.line))) {
				continue;
			}
			triedSide.set(side, version);
			const group = ends.map(e => e.line);
			const others = except(group);
			// The group's lines, each against the others and the rest of the group.
			const total = (rs: readonly (readonly Vec[])[]) => group.reduce((sum, line, k) =>
				sum + cost(line, rs[k], [...others, ...group.flatMap((other, m) => m === k ? [] : allLegs(other, rs[m]))]), 0);
			let best = { cost: total(group.map(line => routes[line])) - 1, arrows: undefined as IScratchLinearElement[] | undefined, routes: [] as Vec[][] };
			const anchors = ends.map(e => lines[e.line][e.end]!.anchor);
			for (const order of portOrders(ends.length)) {
				const arrows: IScratchLinearElement[] = [], rs: Vec[][] = [];
				for (let k = 0; k < ends.length; k++) {
					const e = ends[k];
					const swapped = { ...lines[e.line], [e.end]: { ...lines[e.line][e.end]!, anchor: anchors[order[k]] } };
					const next = reroute(swapped, [...others, ...rs.flatMap((r, m) => allLegs(group[m], r))]);
					if (!next) {
						break;
					}
					arrows.push(next.arrow);
					rs.push(next.route);
				}
				const c = rs.length === ends.length ? total(rs) : Infinity;
				if (c < best.cost) {
					best = { cost: c, arrows, routes: rs };
				}
			}
			if (best.arrows) {
				group.forEach((line, k) => {
					lines[line] = best.arrows![k];
					routes[line] = best.routes[k];
					moved.add(line);
				});
				changed = true;
				triedSide.set(side, ++version);
			}
		}
		if (!changed || budget <= 0) {
			break;
		}
	}
	return new Map([...moved].map(i => [lines[i].id, { ...lines[i], ...normalizeLinear(routes[i]) }]));
}

// ---- Board → Mermaid -------------------------------------------------------------------------

const MERMAID_SHAPE_FOR: Readonly<Partial<Record<ScratchShapeKind, MermaidNodeShape>>> = {
	diamond: 'diamond',
	ellipse: 'circle',
	hexagon: 'hexagon',
	cylinder: 'cylinder',
	parallelogram: 'parallelogram',
	pill: 'stadium',
	document: 'document',
};

const NODE_TYPES = new Set<ScratchElement['type']>(['shape', 'icon', 'note', 'text', 'card', 'image']);
const FRAME_STROKE = '#868e96';

/** A shape's colours and outline when they are not the board's defaults, so a redraw can keep them. */
function shapeColors(el: ScratchElement): IMermaidColors {
	if (el.type !== 'shape') {
		return {};
	}
	return {
		...(el.fill !== 'transparent' ? { fill: el.fill } : {}),
		...(el.stroke !== DEFAULT_SCRATCH_STYLE.stroke ? { stroke: el.stroke } : {}),
		...(el.strokeStyle !== 'solid' ? { strokeStyle: el.strokeStyle } : {}),
	};
}

/** A connector as a link: `-.->` for dots, `linkStyle` for dashes and a colour of its own. */
function connectorEdge(c: IScratchLinearElement, from: string, to: string, htmlToText: (html: string) => string): IMermaidEdge {
	const own = c.stroke !== DEFAULT_SCRATCH_STYLE.stroke && c.stroke !== AGENT_SCRATCH_STYLE.stroke;
	return {
		from,
		to,
		label: c.label ? htmlToText(c.label.html).trim() : '',
		style: c.strokeStyle !== 'solid' ? 'dotted' : c.strokeWidth >= 4 ? 'thick' : 'solid',
		startHead: c.startArrowhead !== 'none',
		endHead: c.endArrowhead !== 'none',
		...(own ? { stroke: c.stroke } : {}),
		...(c.strokeStyle === 'dashed' ? { strokeStyle: 'dashed' as const } : {}),
	};
}
const MAX_NODE_LABEL = 120;

/** Elements sorted the way a person reads a board: rows of ~40px, then left to right. */
export function readingOrder<T extends ScratchElement>(elements: readonly T[]): T[] {
	return elements
		.map((el, index) => ({ el, index, row: Math.floor(el.y / 40) }))
		.sort((a, b) => a.row - b.row || a.el.x - b.el.x || a.index - b.index)
		.map(entry => entry.el);
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/** The text a board element shows as a diagram node. */
export function nodeLabel(el: ScratchElement, htmlToText: (html: string) => string): string {
	switch (el.type) {
		case 'shape':
			return el.label ? htmlToText(el.label.html).trim() : '';
		case 'icon':
			return (el.label ? htmlToText(el.label.html).trim() : '') || el.iconId;
		case 'note': case 'text': case 'card':
			return clip(htmlToText(el.html).trim(), MAX_NODE_LABEL);
		case 'image':
			return 'Image';
		case 'frame':
			return el.name;
		default:
			return '';
	}
}

export interface IBoardDiagram {
	readonly graph: IMermaidGraph;
	/** Board elements that became nodes, and connectors that became edges. */
	readonly nodeElementIds: ReadonlySet<string>;
	readonly edgeElementIds: ReadonlySet<string>;
}

/** The connected part of a board as a flowchart graph, or undefined with no bound connectors. */
export function boardDiagram(elements: readonly ScratchElement[], htmlToText: (html: string) => string): IBoardDiagram | undefined {
	const byId = new Map(elements.map(el => [el.id, el]));
	const isEnd = (id: string | undefined) => {
		const el = id ? byId.get(id) : undefined;
		return !!el && (NODE_TYPES.has(el.type) || el.type === 'frame');
	};
	const connectors = readingOrder(elements.filter((el): el is IScratchLinearElement =>
		(el.type === 'arrow' || el.type === 'line') && isEnd(el.startBinding?.elementId) && isEnd(el.endBinding?.elementId)
		&& el.startBinding!.elementId !== el.endBinding!.elementId));
	if (!connectors.length) {
		return undefined;
	}

	const endpointIds = new Set<string>();
	for (const c of connectors) {
		endpointIds.add(c.startBinding!.elementId);
		endpointIds.add(c.endBinding!.elementId);
	}
	const nodeEls = readingOrder(elements.filter(el => NODE_TYPES.has(el.type) && (el.type === 'shape' || endpointIds.has(el.id))));
	const frameEls = readingOrder(elements.filter((el): el is IScratchFrameElement => el.type === 'frame'));

	const idFor = new Map<string, string>();
	nodeEls.forEach((el, i) => idFor.set(el.id, `n${i + 1}`));
	frameEls.forEach((el, i) => idFor.set(el.id, `f${i + 1}`));

	const nodes: IMermaidNode[] = nodeEls.map(el => {
		let shape: MermaidNodeShape = 'rectangle';
		if (el.type === 'shape') {
			shape = MERMAID_SHAPE_FOR[el.shape] ?? (el.roundness === 'round' ? 'rounded' : 'rectangle');
		} else if (el.type === 'note' || el.type === 'card') {
			shape = 'document';
		} else if (el.type === 'icon') {
			shape = 'rounded';
		}
		return { id: idFor.get(el.id)!, label: nodeLabel(el, htmlToText), shape, ...shapeColors(el) };
	});

	const nodeSet = new Set(nodeEls.map(el => el.id));
	// Frames become subgraphs when they hold nodes or a connector ends on them.
	const subgraphs = frameEls
		.filter(frame => endpointIds.has(frame.id) || nodeEls.some(el => el.frameId === frame.id))
		.map(frame => ({
			id: idFor.get(frame.id)!,
			label: frame.name,
			nodeIds: nodeEls.filter(el => el.frameId === frame.id).map(el => idFor.get(el.id)!),
			...(frame.fill !== 'transparent' ? { fill: frame.fill } : {}),
			...(frame.stroke !== FRAME_STROKE ? { stroke: frame.stroke } : {}),
		}));

	const edges: IMermaidEdge[] = connectors.map(c => connectorEdge(c, idFor.get(c.startBinding!.elementId)!, idFor.get(c.endBinding!.elementId)!, htmlToText));

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const el of nodeEls) {
		minX = Math.min(minX, el.x); minY = Math.min(minY, el.y);
		maxX = Math.max(maxX, el.x + el.width); maxY = Math.max(maxY, el.y + el.height);
	}
	const direction = (maxY - minY) > (maxX - minX) ? 'TB' : 'LR';
	return {
		graph: { direction, nodes, edges, subgraphs },
		nodeElementIds: nodeSet,
		edgeElementIds: new Set(connectors.map(c => c.id)),
	};
}

/** Mermaid flowchart text for the connected part of a board, or undefined with no bound connectors. */
export function elementsToMermaid(elements: readonly ScratchElement[], htmlToText: (html: string) => string): string | undefined {
	const diagram = boardDiagram(elements, htmlToText);
	return diagram ? graphToMermaid(diagram.graph) : undefined;
}

// ---- Overlaps ----------------------------------------------------------------------------------

/** Hand-drawn outlines wobble and bound ends stop short of them: only a real overlap counts. */
const OVERLAP_INSET = 6;
const MAX_OVERLAPS = 12;

/**
 * What makes a drawing hard to read, in plain sentences: a connector running through a shape that
 * is not one of its ends, a connector label on a shape or on another label, shapes on top of each
 * other. The agent gets these with its picture, which is too small to see every one.
 */
export function diagramOverlaps(elements: readonly ScratchElement[], htmlToText: (html: string) => string): string[] {
	const nodes = elements.filter(el => NODE_TYPES.has(el.type));
	const inner = new Map(nodes.map(el => [el.id, expandBounds(geometricBounds(el), -OVERLAP_INSET)]));
	const name = (el: ScratchElement | undefined) => {
		const text = el ? nodeLabel(el, htmlToText).replace(/\s+/g, ' ').trim() : '';
		return text ? `"${clip(text, 40)}"` : `a ${el?.type ?? 'loose end'}`;
	};
	const byId = new Map(elements.map(el => [el.id, el]));
	const out: string[] = [];
	const labels: { readonly text: string; readonly box: IScratchBounds; readonly beside: boolean; readonly lineId: string }[] = [];
	const paths = new Map<string, Vec[]>();
	const what = (el: IScratchLinearElement) => `the connector ${name(el.startBinding ? byId.get(el.startBinding.elementId) : undefined)} → ${name(el.endBinding ? byId.get(el.endBinding.elementId) : undefined)}`;

	for (const el of elements) {
		if (!isLinear(el)) {
			continue;
		}
		const path = linearHitPolyline(el);
		paths.set(el.id, path);
		const ends = new Set([el.startBinding?.elementId, el.endBinding?.elementId]);
		for (const node of nodes) {
			const box = inner.get(node.id)!;
			if (!ends.has(node.id) && box.maxX > box.minX && box.maxY > box.minY && path.some((p, i) => i > 0 && segmentEntersBounds(path[i - 1], p, box))) {
				out.push(`${what(el)} runs through ${name(node)}`);
			}
		}
		const text = el.label?.html ? htmlToText(el.label.html).trim() : '';
		if (text && path.length > 1) {
			const lines = text.split('\n');
			// The label's own font: a hand-drawn 16px label is wider than a 13px system one.
			const metrics = textMetrics(el.label!.fontFamily, el.label!.fontSize);
			const width = Math.max(...lines.map(l => l.length)) * metrics.char + 8;
			const height = lines.length * metrics.line;
			// On the middle of the line, or beside its longest stretch (see connectorLabelAnchor).
			const { at, side } = connectorLabelAnchor(el);
			const box = labelBoxAt([el.x + at[0], el.y + at[1]], side, width, height);
			for (const node of nodes) {
				if (boundsIntersect(box, inner.get(node.id)!)) {
					out.push(`the label "${clip(text, 40)}" on ${what(el)} sits on ${name(node)}`);
				}
			}
			for (const other of labels) {
				if (boundsIntersect(box, other.box)) {
					out.push(`the labels "${clip(other.text, 40)}" and "${clip(text, 40)}" overlap`);
				}
			}
			labels.push({ text, box, beside: side !== 'on', lineId: el.id });
		}
	}
	// A label beside its line has no backing: another line through it makes both hard to read.
	for (const label of labels) {
		if (!label.beside) {
			continue;
		}
		const box = expandBounds(label.box, -2);
		for (const el of elements) {
			const path = paths.get(el.id);
			if (path && el.id !== label.lineId && isLinear(el) && path.some((p, i) => i > 0 && segmentEntersBounds(path[i - 1], p, box))) {
				out.push(`${what(el)} runs through the label "${clip(label.text, 40)}"`);
			}
		}
	}

	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			if (boundsIntersect(inner.get(nodes[i].id)!, inner.get(nodes[j].id)!)) {
				out.push(`${name(nodes[i])} and ${name(nodes[j])} overlap`);
			}
		}
	}
	return out.length > MAX_OVERLAPS ? [...out.slice(0, MAX_OVERLAPS), `and ${out.length - MAX_OVERLAPS} more`] : out;
}
