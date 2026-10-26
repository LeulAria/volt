/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { elbowRouteScore, facingSide, IScratchObstacle, IScratchRouteContext, normalizeLinear, rebindConnector, ScratchSide, separateElbowLegs, withLegs } from './scratchBinding.js';
import { connectorLabelAnchor, labelBoxAt } from './scratchDrawing.js';
import { isValidColor, normalizeColor } from './scratchColor.js';
import { createFrame, createLabel, createLinear, createShape } from './scratchFactory.js';
import { FRAME_HEADER_INSET_X, FRAME_HEADER_INSET_Y, geometricBounds } from './scratchGeometry.js';
import { escapeHtml } from './scratchHtml.js';
import { layeredLayout } from './scratchLayout.js';
import { expandBounds, segmentEntersBounds, type Vec } from './scratchMath.js';
import {
	AGENT_DIAGRAM_STYLE, IScratchBounds, IScratchFrameElement, IScratchInlineIcon, IScratchLinearElement, IScratchShapeElement, IScratchStyleDefaults,
	SCRATCH_BINDING_GAP, ScratchElement, ScratchStrokeStyle,
} from './scratchTypes.js';

/**
 * Architecture diagrams: groups (a service, a machine, a vendor) drawn as containers with an icon
 * and a name, holding cards (an icon, a title, a quieter subtitle), joined by numbered connectors
 * with their labels beside the line. Agents describe one as data (`IArchitectureSpec`); the layout
 * is a grid of groups, each laying its cards out in a row or a column, every group in a column as
 * wide as the widest and every group in a row as tall as the tallest.
 */

// ---- The spec --------------------------------------------------------------------------------

export interface IArchitectureNode {
	readonly id: string;
	readonly label: string;
	readonly sub: string;
	/** An icon id (`lucide:webhook`, `logos:github-icon`) or a word to look one up by. */
	readonly icon: string | undefined;
	/** Light-space stroke colour. */
	readonly color: string | undefined;
	/** Planned or not built yet: a dashed outline. */
	readonly dashed: boolean;
	/** Where a node outside every group sits in the grid. */
	readonly cell: IArchitectureCell | undefined;
}

export interface IArchitectureCell {
	readonly row: number | undefined;
	readonly col: number | undefined;
	readonly rowSpan: number;
	readonly colSpan: number;
}

export interface IArchitectureGroup {
	readonly id: string;
	readonly label: string;
	readonly sub: string;
	readonly icon: string | undefined;
	readonly color: string | undefined;
	readonly dashed: boolean;
	/** How its cards sit: side by side (cards with the icon above the text) or stacked (icon before the text). */
	readonly layout: 'row' | 'column' | undefined;
	readonly cell: IArchitectureCell | undefined;
	readonly nodes: readonly IArchitectureNode[];
}

export interface IArchitectureEdge {
	readonly from: string;
	readonly to: string;
	readonly label: string;
	readonly color: string | undefined;
	readonly style: ScratchStrokeStyle;
	/** Arrowheads at both ends. */
	readonly both: boolean;
	/** Which side of the line the label takes: above/right (`top`) or below/left (`bottom`). */
	readonly labelSide: 'top' | 'bottom';
}

export interface IArchitectureSpec {
	/** Which way the main flow runs; places groups when the spec gives no rows and columns. */
	readonly direction: 'LR' | 'TB';
	readonly groups: readonly IArchitectureGroup[];
	/** Cards outside every group. */
	readonly nodes: readonly IArchitectureNode[];
	readonly edges: readonly IArchitectureEdge[];
}

/** Colour names agents can use, as light-space strokes (a dark board lightens them). */
export const ARCHITECTURE_COLORS: Readonly<Record<string, string>> = {
	ink: '#1e1e1e', default: '#1e1e1e', white: '#1e1e1e', black: '#1e1e1e',
	gray: '#868e96', grey: '#868e96',
	red: '#e03131',
	pink: '#c2255c',
	purple: '#9c36b5', grape: '#9c36b5',
	violet: '#6741d9', indigo: '#3b5bdb',
	blue: '#1971c2',
	cyan: '#0c8599', teal: '#0c8599',
	green: '#2f9e44',
	lime: '#66a80f',
	yellow: '#f08c00', amber: '#f08c00',
	orange: '#e8590c',
	brown: '#846358',
};

const MAX_GROUPS = 16;
const MAX_NODES = 48;
const MAX_EDGES = 64;

function text(v: unknown, max = 120): string {
	return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : typeof v === 'number' ? String(v) : '';
}

function colorOf(v: unknown): string | undefined {
	if (typeof v !== 'string' || !v.trim()) {
		return undefined;
	}
	const name = v.trim().toLowerCase();
	if (ARCHITECTURE_COLORS[name]) {
		return ARCHITECTURE_COLORS[name];
	}
	return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(name) && isValidColor(name) ? normalizeColor(name) : undefined;
}

function int(v: unknown): number | undefined {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;
}

function cellOf(v: Record<string, unknown>): IArchitectureCell | undefined {
	const row = int(v.row), col = int(v.col ?? v.column);
	if (row === undefined && col === undefined) {
		return undefined;
	}
	const span = (s: unknown) => Math.min(8, Math.max(1, int(s) ?? 1));
	return { row, col, rowSpan: span(v.rowSpan), colSpan: span(v.colSpan) };
}

function slug(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function iconOf(v: unknown): string | undefined {
	const name = text(v, 120);
	return name || undefined;
}

/**
 * The agent's diagram as a spec, or what is wrong with it. Takes the object or its JSON text. Rows
 * and columns may count from 0 or 1; they are moved to start at 0.
 */
export function parseArchitectureSpec(value: unknown): { readonly spec: IArchitectureSpec; readonly warnings: string[] } | { readonly error: string } {
	let input = value;
	if (typeof input === 'string') {
		try {
			input = JSON.parse(input);
		} catch {
			return { error: '`diagram` is not valid JSON.' };
		}
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { error: '`diagram` must be an object with `groups`, `nodes` and `edges`.' };
	}
	const raw = input as Record<string, unknown>;
	const warnings: string[] = [];
	const ids = new Set<string>();
	const uniqueId = (wanted: string): string => {
		let id = wanted;
		for (let i = 2; ids.has(id); i++) {
			id = `${wanted}-${i}`;
		}
		ids.add(id);
		return id;
	};
	let nodeCount = 0;
	const readNode = (v: unknown, loose: boolean): IArchitectureNode | undefined => {
		if (typeof v === 'string' && v.trim()) {
			v = { label: v };
		}
		if (!v || typeof v !== 'object' || Array.isArray(v)) {
			return undefined;
		}
		const n = v as Record<string, unknown>;
		const label = text(n.label ?? n.title ?? n.name ?? n.id);
		if (!label) {
			return undefined;
		}
		if (++nodeCount > MAX_NODES) {
			return undefined;
		}
		const wanted = text(n.id, 60);
		const id = uniqueId(wanted || slug(label));
		if (wanted && id !== wanted) {
			warnings.push(`two items have the id "${wanted}"; the second is "${id}"`);
		}
		return {
			id, label,
			sub: text(n.sub ?? n.subtitle ?? n.description, 160),
			icon: iconOf(n.icon),
			color: colorOf(n.color),
			dashed: n.dashed === true || n.planned === true || n.style === 'dashed',
			cell: loose ? cellOf(n) : undefined,
		};
	};

	const groups: IArchitectureGroup[] = [];
	for (const v of Array.isArray(raw.groups) ? raw.groups.slice(0, MAX_GROUPS) : []) {
		if (!v || typeof v !== 'object' || Array.isArray(v)) {
			continue;
		}
		const g = v as Record<string, unknown>;
		const label = text(g.label ?? g.title ?? g.name ?? g.id);
		if (!label) {
			continue;
		}
		const wanted = text(g.id, 60);
		const id = uniqueId(wanted || slug(label));
		const layout = g.layout === 'row' || g.layout === 'column' ? g.layout : g.layout === 'col' || g.layout === 'stack' ? 'column' : undefined;
		groups.push({
			id, label,
			sub: text(g.sub ?? g.subtitle ?? g.description, 120),
			icon: iconOf(g.icon),
			color: colorOf(g.color),
			dashed: g.dashed === true || g.planned === true,
			layout,
			cell: cellOf(g),
			nodes: (Array.isArray(g.nodes) ? g.nodes : Array.isArray(g.children) ? g.children : []).map(n => readNode(n, false)).filter((n): n is IArchitectureNode => !!n),
		});
	}
	const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map(n => readNode(n, true)).filter((n): n is IArchitectureNode => !!n);
	if (nodeCount > MAX_NODES) {
		warnings.push(`only the first ${MAX_NODES} cards were drawn`);
	}
	if (!groups.length && !nodes.length) {
		return { error: '`diagram` has nothing to draw: give it `groups` (each with `nodes`) or `nodes`.' };
	}

	// Ends name an id, or a label when the agent wrote that instead.
	const byLabel = new Map<string, string>();
	for (const item of [...groups, ...groups.flatMap(g => g.nodes), ...nodes]) {
		byLabel.set(item.label.toLowerCase(), item.id);
	}
	const resolve = (v: unknown) => {
		const name = text(v, 120);
		return ids.has(name) ? name : byLabel.get(name.toLowerCase());
	};
	const edges: IArchitectureEdge[] = [];
	const unknown: string[] = [];
	for (const v of Array.isArray(raw.edges) ? raw.edges.slice(0, MAX_EDGES) : []) {
		if (!v || typeof v !== 'object' || Array.isArray(v)) {
			continue;
		}
		const e = v as Record<string, unknown>;
		const from = resolve(e.from), to = resolve(e.to);
		if (!from || !to) {
			unknown.push(`${text(e.from, 40) || '?'} → ${text(e.to, 40) || '?'}`);
			continue;
		}
		if (from === to) {
			continue;
		}
		const style = e.style === 'dashed' || e.dashed === true ? 'dashed' : e.style === 'dotted' || e.dotted === true ? 'dotted' : 'solid';
		edges.push({
			from, to,
			label: text(e.label, 80),
			color: colorOf(e.color),
			style,
			both: e.both === true || e.bidirectional === true,
			labelSide: e.labelSide === 'bottom' || e.labelSide === 'below' || e.labelSide === 'left' ? 'bottom' : 'top',
		});
	}
	if (unknown.length) {
		warnings.push(`edges with an end that is not an id in the diagram were left out: ${unknown.join(', ')}`);
	}

	// Rows and columns from 0, whichever way the agent counted.
	const cells = [...groups.map(g => g.cell), ...nodes.map(n => n.cell)].filter((c): c is IArchitectureCell => !!c);
	const first = (values: (number | undefined)[]) => {
		const defined = values.filter((v): v is number => v !== undefined);
		return defined.length ? Math.min(...defined) : 0;
	};
	const minRow = first(cells.map(c => c.row)), minCol = first(cells.map(c => c.col));
	const shift = (c: IArchitectureCell | undefined) => c && {
		...c,
		row: c.row === undefined ? undefined : Math.max(0, c.row - minRow),
		col: c.col === undefined ? undefined : Math.max(0, c.col - minCol),
	};
	const direction = typeof raw.direction === 'string' && /^(TB|TD|BT)$/i.test(raw.direction) ? 'TB' : 'LR';
	return {
		spec: {
			direction,
			groups: groups.map(g => ({ ...g, cell: shift(g.cell) })),
			nodes: nodes.map(n => ({ ...n, cell: shift(n.cell) })),
			edges,
		},
		warnings,
	};
}

// ---- Layout ----------------------------------------------------------------------------------

/** An icon ready to draw. */
export interface IArchitectureIcon {
	readonly iconId: string;
	readonly svg: string;
	readonly tintable: boolean;
}

export interface IArchitectureOptions {
	readonly style?: IScratchStyleDefaults;
	/** The icon for a spec's `icon` value, already fetched; undefined draws the item without one. */
	readonly icon?: (name: string) => IArchitectureIcon | undefined;
	/** Width of `text` at `fontSize` in the style's font; an estimate when not given. */
	readonly measure?: (text: string, fontSize: number) => number;
}

/** Name colour (ink, so white on a dark board) and the quieter grey of edge labels. */
const INK = '#1e1e1e';
const MUTED = '#495057';

const TITLE_SIZE = 20;
const EDGE_LABEL_SIZE = 16;
const HEADER_SIZE = 24;
const HEADER_ICON = 26;
/** The hand font's line height (see lineHeightFor). */
const LINE = 1.25;
/** `.sx-label` sits this far inside its shape. */
const LABEL_INSET = 10;

const STACK_ICON = 30;
const STACK_ICON_GAP = 10;
const STACK_PAD_X = 18;
const STACK_PAD_Y = 14;
const STACK_MIN_WIDTH = 160;
const STACK_TEXT_MAX = 230;

const INLINE_ICON = 28;
/** The icon's place before the text: the label's left padding, the icon and the gap after it (see scratchBoard.css). */
const INLINE_LEAD = 10 + INLINE_ICON + 14;
const INLINE_PAD_Y = 16;
const INLINE_MIN_WIDTH = 200;
const INLINE_TEXT_MAX = 250;

const GROUP_PAD_X = 24;
const GROUP_PAD_BOTTOM = 24;
const CHILD_GAP = 24;
/** Gap between cards an unlabelled connector joins: room for the line and its head. */
const LINKED_GAP = 52;

const GRID_GAP_X = 96;
const GRID_GAP_Y = 96;
/** Room round a label in the gap it sits in. */
const LABEL_AIR = 30;

/** A group stretches to its row's height unless that is more than this much taller than it needs. */
const MAX_STRETCH = 1.5;

/** Estimated width of hand-drawn text (Excalifont runs a little wider than half its size). */
function estimateWidth(value: string, fontSize: number): number {
	return value.length * fontSize * 0.56;
}

interface ISize {
	width: number;
	height: number;
}

interface IRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Words wrapped to `max` px, longest line's width. */
function wrap(value: string, fontSize: number, max: number, measure: (text: string, fontSize: number) => number): { readonly lines: string[]; readonly width: number } {
	if (!value) {
		return { lines: [], width: 0 };
	}
	const lines: string[] = [];
	let line = '';
	for (const word of value.split(' ')) {
		const next = line ? `${line} ${word}` : word;
		if (line && measure(next, fontSize) > max) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) {
		lines.push(line);
	}
	return { lines, width: Math.max(...lines.map(l => measure(l, fontSize))) };
}

interface ICardPlan {
	readonly node: IArchitectureNode;
	readonly inline: boolean;
	readonly html: string;
	readonly icon: IArchitectureIcon | undefined;
	readonly natural: ISize;
	readonly group: IArchitectureGroup | undefined;
}

function planCard(node: IArchitectureNode, inline: boolean, group: IArchitectureGroup | undefined, options: Required<Pick<IArchitectureOptions, 'measure'>> & IArchitectureOptions): ICardPlan {
	const measure = options.measure;
	const icon = node.icon ? options.icon?.(node.icon) : undefined;
	const subSize = TITLE_SIZE * 0.7;
	const max = inline ? INLINE_TEXT_MAX : STACK_TEXT_MAX;
	const title = wrap(node.label, TITLE_SIZE, max, measure);
	// A subtitle is small: it takes a little more width before it wraps (a lone last word reads badly).
	const sub = wrap(node.sub, subSize, max * 1.3, measure);
	const textWidth = Math.max(title.width, sub.width);
	const lines = title.lines.length + sub.lines.length;
	// Every paragraph is a line of the title's height (a subtitle's too: its paragraph has the title's line box).
	const textHeight = lines * TITLE_SIZE * LINE;
	const html = [
		title.lines.length ? `<p>${title.lines.map(escapeHtml).join('<br>')}</p>` : '',
		sub.lines.length ? `<p><small>${sub.lines.map(escapeHtml).join('<br>')}</small></p>` : '',
	].join('');
	// A little slack: text measured off screen can land a hair wider on the board.
	const slack = 10;
	const natural = inline
		? { width: Math.max(INLINE_MIN_WIDTH, LABEL_INSET * 2 + (icon ? INLINE_LEAD : 10) + textWidth + 16 + slack), height: Math.max(icon ? INLINE_ICON : 0, textHeight) + (LABEL_INSET + INLINE_PAD_Y) * 2 }
		: { width: Math.max(STACK_MIN_WIDTH, textWidth + (LABEL_INSET + STACK_PAD_X) * 2 + slack), height: (icon ? STACK_ICON + STACK_ICON_GAP : 0) + textHeight + (LABEL_INSET + STACK_PAD_Y) * 2 };
	return { node, inline, html, icon, natural: { width: Math.ceil(natural.width), height: Math.ceil(natural.height) }, group };
}

interface IGroupPlan {
	readonly group: IArchitectureGroup;
	readonly layout: 'row' | 'column';
	readonly cards: readonly ICardPlan[];
	/** Gap after each card but the last. */
	readonly gaps: readonly number[];
	readonly headerWidth: number;
	readonly icon: IArchitectureIcon | undefined;
	readonly natural: ISize;
}

/** Where cards start below a container's top edge: under its header (see frameHeaderHeight). */
function contentTop(): number {
	return Math.max(HEADER_ICON, HEADER_SIZE * LINE) + FRAME_HEADER_INSET_Y * 2 + 6;
}

/** Widest an edge label is drawn beside a level line (the board wraps it at 360px, see scratchBoard.css). */
const EDGE_LABEL_MAX = 340;

/** An edge label in lines that fit beside the line, and the room they take. */
function edgeLabelLines(label: string, measure: (text: string, fontSize: number) => number): { readonly lines: string[] } & ISize {
	const { lines, width } = wrap(label, EDGE_LABEL_SIZE, EDGE_LABEL_MAX, measure);
	return { lines, width: lines.length ? Math.ceil(width) + 4 : 0, height: Math.ceil(lines.length * EDGE_LABEL_SIZE * LINE) };
}

function edgeLabelSize(label: string, measure: (text: string, fontSize: number) => number): ISize {
	const { width, height } = edgeLabelLines(label, measure);
	return { width, height };
}

function planGroup(group: IArchitectureGroup, edges: readonly IArchitectureEdge[], options: Required<Pick<IArchitectureOptions, 'measure'>> & IArchitectureOptions): IGroupPlan {
	const measure = options.measure;
	const layout = group.layout ?? (group.nodes.length > 3 ? 'column' : 'row');
	const cards = group.nodes.map(node => planCard(node, layout === 'column', group, options));
	// Neighbours a connector joins get room for it, and for its label beside it.
	const gaps = cards.slice(1).map((card, i) => {
		const a = cards[i].node.id, b = card.node.id;
		const link = edges.find(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));
		if (!link) {
			return CHILD_GAP;
		}
		const label = edgeLabelSize(link.label, measure);
		return layout === 'row' ? Math.max(LINKED_GAP, label.width + LABEL_AIR * 2) : Math.max(LINKED_GAP, label.height + LABEL_AIR * 2);
	});
	const icon = group.icon ? options.icon?.(group.icon) : undefined;
	const headerWidth = Math.ceil(FRAME_HEADER_INSET_X * 2 + (icon ? HEADER_ICON + 10 : 0) + measure(group.label, HEADER_SIZE) + (group.sub ? 14 + measure(group.sub, HEADER_SIZE * 0.62) : 0) + 12);
	// Cards in a row share one height, cards in a column one width.
	if (layout === 'row') {
		const height = Math.max(0, ...cards.map(c => c.natural.height));
		cards.forEach(c => c.natural.height = height);
	} else {
		const width = Math.max(0, ...cards.map(c => c.natural.width));
		cards.forEach(c => c.natural.width = width);
	}
	const sumGaps = gaps.reduce((a, b) => a + b, 0);
	const inner = !cards.length ? { width: 160, height: 24 } : layout === 'row'
		? { width: cards.reduce((sum, c) => sum + c.natural.width, 0) + sumGaps, height: cards[0].natural.height }
		: { width: cards[0].natural.width, height: cards.reduce((sum, c) => sum + c.natural.height, 0) + sumGaps };
	return {
		group, layout, cards, gaps, headerWidth, icon,
		natural: { width: Math.max(headerWidth, inner.width + GROUP_PAD_X * 2), height: contentTop() + inner.height + GROUP_PAD_BOTTOM },
	};
}

/** A box of the grid: a group, or a card outside every group. */
interface IItem {
	readonly id: string;
	readonly natural: ISize;
	readonly group: IGroupPlan | undefined;
	readonly card: ICardPlan | undefined;
	cell: { row: number; col: number; rowSpan: number; colSpan: number } | undefined;
	readonly wanted: IArchitectureCell | undefined;
}

/**
 * Rows and columns for items the spec did not place: the layered layout of the groups (the flow
 * runs along `direction`), each rank a column (a row top-down), the items of a rank in the rows
 * nearest their place in it.
 */
function autoCells(items: readonly IItem[], links: readonly (readonly [string, string])[], direction: 'LR' | 'TB'): void {
	const free = items.filter(item => !item.cell);
	if (!free.length) {
		return;
	}
	const placedCells = items.filter(item => item.cell).map(item => item.cell!);
	const horizontal = direction === 'LR';
	const positions = layeredLayout(free.map(item => ({ id: item.id, ...item.natural })), links.map(([from, to]) => ({ from, to })), direction, { node: 48, rank: 96 });
	const centre = (item: IItem): Vec => {
		const p = positions.get(item.id) ?? [0, 0];
		return [p[0] + item.natural.width / 2, p[1] + item.natural.height / 2];
	};
	// Ranks: items whose centres line up along the flow.
	const along = (item: IItem) => centre(item)[horizontal ? 0 : 1];
	const across = (item: IItem) => centre(item)[horizontal ? 1 : 0];
	const sorted = [...free].sort((a, b) => along(a) - along(b));
	const ranks: IItem[][] = [];
	for (const item of sorted) {
		const last = ranks[ranks.length - 1];
		if (last && Math.abs(along(last[0]) - along(item)) < 1) {
			last.push(item);
		} else {
			ranks.push([item]);
		}
	}
	// Slots across the flow: those of the fullest rank; the others take the nearest free ones, in order.
	const fullest = ranks.reduce((a, b) => b.length > a.length ? b : a, ranks[0]);
	const slots = [...fullest].map(across).sort((a, b) => a - b);
	const offset = placedCells.length ? Math.max(...placedCells.map(c => (horizontal ? c.col + c.colSpan : c.row + c.rowSpan))) : 0;
	ranks.forEach((rank, r) => {
		const members = [...rank].sort((a, b) => across(a) - across(b));
		const used = new Set<number>();
		let floor = 0;
		for (let k = 0; k < members.length; k++) {
			const want = across(members[k]);
			let best = -1;
			// Keep the order: each takes a slot after the last one taken, leaving enough for the rest.
			for (let s = floor; s <= slots.length - (members.length - k); s++) {
				if (!used.has(s) && (best < 0 || Math.abs(slots[s] - want) < Math.abs(slots[best] - want))) {
					best = s;
				}
			}
			best = Math.max(best, floor);
			used.add(best);
			floor = best + 1;
			members[k].cell = horizontal
				? { row: best, col: offset + r, rowSpan: 1, colSpan: 1 }
				: { row: offset + r, col: best, rowSpan: 1, colSpan: 1 };
		}
	});
}

/** Places items the spec placed, then the rest after them. */
function assignCells(items: IItem[], links: readonly (readonly [string, string])[], direction: 'LR' | 'TB'): void {
	const taken = new Set<string>();
	const key = (r: number, c: number) => `${r},${c}`;
	for (const item of items) {
		const w = item.wanted;
		if (w && w.row !== undefined && w.col !== undefined) {
			item.cell = { row: w.row, col: w.col, rowSpan: w.rowSpan, colSpan: w.colSpan };
			for (let r = w.row; r < w.row + w.rowSpan; r++) {
				for (let c = w.col; c < w.col + w.colSpan; c++) {
					taken.add(key(r, c));
				}
			}
		}
	}
	// Half placed (a row or a column only): the first free cell along it.
	for (const item of items) {
		const w = item.wanted;
		if (item.cell || !w) {
			continue;
		}
		for (let k = 0; k < 64; k++) {
			const r = w.row ?? k, c = w.col ?? k;
			if (!taken.has(key(r, c))) {
				item.cell = { row: r, col: c, rowSpan: 1, colSpan: 1 };
				taken.add(key(r, c));
				break;
			}
		}
	}
	autoCells(items, links, direction);
}

interface IGrid {
	readonly colX: number[];
	readonly colW: number[];
	readonly rowY: number[];
	readonly rowH: number[];
}

function solveGrid(items: readonly IItem[], gapX: (c: number) => number, gapY: (r: number) => number): IGrid {
	const cols = Math.max(1, ...items.map(i => i.cell!.col + i.cell!.colSpan));
	const rows = Math.max(1, ...items.map(i => i.cell!.row + i.cell!.rowSpan));
	const colW = new Array<number>(cols).fill(0);
	const rowH = new Array<number>(rows).fill(0);
	for (const item of items) {
		const cell = item.cell!;
		if (cell.colSpan === 1) {
			colW[cell.col] = Math.max(colW[cell.col], item.natural.width);
		}
		if (cell.rowSpan === 1) {
			rowH[cell.row] = Math.max(rowH[cell.row], item.natural.height);
		}
	}
	// What spans takes the room it needs from the last row or column it covers.
	for (const item of items) {
		const cell = item.cell!;
		if (cell.colSpan > 1) {
			let span = 0;
			for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
				span += colW[c] + (c > cell.col ? gapX(c - 1) : 0);
			}
			colW[cell.col + cell.colSpan - 1] += Math.max(0, item.natural.width - span);
		}
		if (cell.rowSpan > 1) {
			let span = 0;
			for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
				span += rowH[r] + (r > cell.row ? gapY(r - 1) : 0);
			}
			// A tall item spanning rows only grows them when it does not fit them at all.
			rowH[cell.row + cell.rowSpan - 1] += Math.max(0, item.natural.height - span);
		}
	}
	const colX: number[] = [];
	let x = 0;
	for (let c = 0; c < cols; c++) {
		colX.push(x);
		x += colW[c] + (c + 1 < cols ? gapX(c) : 0);
	}
	const rowY: number[] = [];
	let y = 0;
	for (let r = 0; r < rows; r++) {
		rowY.push(y);
		y += rowH[r] + (r + 1 < rows ? gapY(r) : 0);
	}
	return { colX, colW, rowY, rowH };
}

/** The cards of a group laid out in its box. */
function placeCards(plan: IGroupPlan, box: IRect): Map<string, IRect> {
	const out = new Map<string, IRect>();
	const cards = plan.cards;
	if (!cards.length) {
		return out;
	}
	const top = box.y + contentTop();
	const availW = box.width - GROUP_PAD_X * 2;
	const availH = box.y + box.height - GROUP_PAD_BOTTOM - top;
	const sumGaps = plan.gaps.reduce((a, b) => a + b, 0);
	if (plan.layout === 'row') {
		const natural = cards.reduce((sum, c) => sum + c.natural.width, 0);
		// Cards widen to fill the group, up to a point; past it they keep to the middle.
		const scale = Math.min(MAX_STRETCH, Math.max(1, (availW - sumGaps) / Math.max(1, natural)));
		const height = availH <= cards[0].natural.height * MAX_STRETCH ? availH : cards[0].natural.height;
		const y = top + (availH - height) / 2;
		let x = box.x + GROUP_PAD_X + Math.max(0, (availW - sumGaps - natural * scale) / 2);
		cards.forEach((card, i) => {
			const width = card.natural.width * scale;
			out.set(card.node.id, { x, y, width, height });
			x += width + (plan.gaps[i] ?? 0);
		});
	} else {
		const total = cards.reduce((sum, c) => sum + c.natural.height, 0) + sumGaps;
		let y = top + Math.max(0, (availH - total) / 2);
		cards.forEach((card, i) => {
			out.set(card.node.id, { x: box.x + GROUP_PAD_X, y, width: availW, height: card.natural.height });
			y += card.natural.height + (plan.gaps[i] ?? 0);
		});
	}
	return out;
}

function inlineIcon(icon: IArchitectureIcon | undefined, placement: 'top' | 'left', size: number): IScratchInlineIcon | null {
	return icon ? { iconId: icon.iconId, svg: icon.svg, tintable: icon.tintable, placement, size } : null;
}

/** Ports keep this far in from the ends of a side (a fraction of it, and at least this many px). */
const PORT_INSET = 0.15;
const PORT_INSET_MIN = 18;
const PORT_SPACING = 28;
/** What choosing a way round costs for running through a label, and for each other line on a side it takes. */
const LABEL_HIT_COST = 600;
const CROWDED_SIDE_COST = 90;

interface IEnd {
	readonly edge: number;
	readonly which: 'start' | 'end';
	readonly box: IScratchBounds;
	side: ScratchSide;
	/** Where along the side it wants to be, in board coordinates. */
	at: number;
}

function sideRange(box: IScratchBounds, side: ScratchSide): { readonly lo: number; readonly hi: number } {
	const level = side === 0 || side === 2;
	const lo = level ? box.minX : box.minY, hi = level ? box.maxX : box.maxY;
	const inset = Math.min((hi - lo) / 2, Math.max(PORT_INSET_MIN, (hi - lo) * PORT_INSET));
	return { lo: lo + inset, hi: hi - inset };
}

function anchorFor(box: IScratchBounds, side: ScratchSide, at: number): readonly [number, number] {
	const level = side === 0 || side === 2;
	const f = level ? (at - box.minX) / Math.max(1, box.maxX - box.minX) : (at - box.minY) / Math.max(1, box.maxY - box.minY);
	const t = Math.min(1, Math.max(0, f));
	return side === 0 ? [t, 0] : side === 1 ? [1, t] : side === 2 ? [t, 1] : [0, t];
}

/**
 * The spec as board elements laid out from `origin`: container frames for the groups (first, so
 * they sit under everything), a card per node, and an elbow connector per edge, bound at both ends.
 */
export function architectureToElements(spec: IArchitectureSpec, origin: Vec, options: IArchitectureOptions = {}): ScratchElement[] {
	const style = options.style ?? AGENT_DIAGRAM_STYLE;
	const measure = options.measure ?? estimateWidth;
	const opts = { ...options, measure };

	// Plans: every group and loose card at its own size.
	const groupPlans = spec.groups.map(group => planGroup(group, spec.edges, opts));
	const looseCards = spec.nodes.map(node => planCard(node, false, undefined, opts));
	const items: IItem[] = [
		...groupPlans.map((plan): IItem => ({ id: plan.group.id, natural: plan.natural, group: plan, card: undefined, cell: undefined, wanted: plan.group.cell })),
		...looseCards.map((card): IItem => ({ id: card.node.id, natural: card.natural, group: undefined, card, cell: undefined, wanted: card.node.cell })),
	];
	const itemOf = new Map<string, string>();
	for (const plan of groupPlans) {
		itemOf.set(plan.group.id, plan.group.id);
		for (const card of plan.cards) {
			itemOf.set(card.node.id, plan.group.id);
		}
	}
	for (const card of looseCards) {
		itemOf.set(card.node.id, card.node.id);
	}
	const links = spec.edges.map(e => [itemOf.get(e.from)!, itemOf.get(e.to)!] as const).filter(([a, b]) => a && b && a !== b);
	assignCells(items, links, spec.direction);

	// Gaps wide enough for the labels of the links that cross them.
	const cellOf = new Map(items.map(item => [item.id, item.cell!]));
	const gapXs = new Map<number, number>();
	const gapYs = new Map<number, number>();
	for (const edge of spec.edges) {
		const a = cellOf.get(itemOf.get(edge.from)!), b = cellOf.get(itemOf.get(edge.to)!);
		if (!a || !b || a === b || !edge.label) {
			continue;
		}
		const label = edgeLabelSize(edge.label, measure);
		const [left, right] = a.col <= b.col ? [a, b] : [b, a];
		if (right.col >= left.col + left.colSpan) {
			const gap = right.col - 1;
			gapXs.set(gap, Math.max(gapXs.get(gap) ?? 0, label.width + LABEL_AIR * 2));
		}
		const [upper, lower] = a.row <= b.row ? [a, b] : [b, a];
		if (lower.row >= upper.row + upper.rowSpan) {
			const gap = lower.row - 1;
			gapYs.set(gap, Math.max(gapYs.get(gap) ?? 0, label.height + LABEL_AIR * 2));
		}
	}
	const grid = solveGrid(items, c => Math.max(GRID_GAP_X, gapXs.get(c) ?? 0), r => Math.max(GRID_GAP_Y, gapYs.get(r) ?? 0));
	const spanX = (cell: NonNullable<IItem['cell']>) => grid.colX[cell.col + cell.colSpan - 1] + grid.colW[cell.col + cell.colSpan - 1] - grid.colX[cell.col];
	const spanY = (cell: NonNullable<IItem['cell']>) => grid.rowY[cell.row + cell.rowSpan - 1] + grid.rowH[cell.row + cell.rowSpan - 1] - grid.rowY[cell.row];

	const frames: IScratchFrameElement[] = [];
	const cards: IScratchShapeElement[] = [];
	const elementOf = new Map<string, ScratchElement>();
	const groupFrameOf = new Map<string, string>();
	const makeCard = (card: ICardPlan, rect: IRect, frameId: string | null) => {
		const color = card.node.color ?? card.group?.color ?? INK;
		const shape = createShape({
			x: origin[0] + rect.x, y: origin[1] + rect.y, width: rect.width, height: rect.height,
			shape: 'rectangle', roundness: 'round',
			stroke: color, fill: 'transparent', fillStyle: 'solid',
			strokeWidth: 1.5,
			strokeStyle: card.node.dashed ? 'dashed' : 'solid',
			frameId,
			label: card.html ? createLabel(card.html, style, { fontSize: TITLE_SIZE, textAlign: card.inline ? 'left' : 'center', color: INK }) : null,
		}, style);
		const icon = inlineIcon(card.icon, card.inline ? 'left' : 'top', card.inline ? INLINE_ICON : STACK_ICON);
		const el: IScratchShapeElement = icon ? { ...shape, icon } : shape;
		cards.push(el);
		elementOf.set(card.node.id, el);
	};
	for (const item of items) {
		const cell = item.cell!;
		const cellRect = { x: grid.colX[cell.col], y: grid.rowY[cell.row], width: spanX(cell), height: spanY(cell) };
		if (item.card) {
			// A card on its own keeps its size, in the middle of its cell.
			const { width, height } = item.card.natural;
			makeCard(item.card, { x: cellRect.x + (cellRect.width - width) / 2, y: cellRect.y + (cellRect.height - height) / 2, width, height }, null);
			continue;
		}
		const plan = item.group!;
		// As wide as its column; as tall as its row unless that stretches it out of shape.
		const height = cellRect.height <= plan.natural.height * MAX_STRETCH ? cellRect.height : plan.natural.height;
		const box = { x: cellRect.x, y: cellRect.y, width: cellRect.width, height };
		const color = plan.group.color ?? INK;
		const frame: IScratchFrameElement = {
			...createFrame({ x: origin[0] + box.x, y: origin[1] + box.y, width: box.width, height: box.height, name: plan.group.label }, style),
			stroke: color,
			fill: 'transparent',
			fillStyle: 'solid',
			strokeWidth: style.strokeWidth,
			strokeStyle: plan.group.dashed ? 'dashed' : 'solid',
			roughness: style.roughness,
			header: {
				icon: inlineIcon(plan.icon, 'left', HEADER_ICON),
				subtitle: plan.group.sub,
				fontFamily: style.fontFamily,
				fontSize: HEADER_SIZE,
				color: INK,
			},
		};
		frames.push(frame);
		elementOf.set(plan.group.id, frame);
		const placed = placeCards(plan, box);
		for (const card of plan.cards) {
			makeCard(card, placed.get(card.node.id)!, frame.id);
			groupFrameOf.set(card.node.id, frame.id);
		}
	}

	return [...frames, ...cards, ...connect(spec.edges, elementOf, groupFrameOf, frames, cards, measure, style)];
}

/** Elbow connectors for the edges, each anchored where it runs straight when it can and routed round what is in the way. */
function connect(
	edges: readonly IArchitectureEdge[],
	elementOf: ReadonlyMap<string, ScratchElement>,
	groupFrameOf: ReadonlyMap<string, string>,
	frames: readonly IScratchFrameElement[],
	cards: readonly IScratchShapeElement[],
	measure: (text: string, fontSize: number) => number,
	style: IScratchStyleDefaults,
): IScratchLinearElement[] {
	const drawn = edges.map(edge => ({ edge, from: elementOf.get(edge.from), to: elementOf.get(edge.to) }))
		.filter((e): e is { edge: IArchitectureEdge; from: ScratchElement; to: ScratchElement } => !!e.from && !!e.to && e.from !== e.to
			// A card and the group it is in are one place: a line between them has nowhere to go.
			&& groupFrameOf.get(e.edge.from) !== e.to.id && groupFrameOf.get(e.edge.to) !== e.from.id);
	const boxOf = (el: ScratchElement): IScratchBounds => ({ minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height });

	// Sides: across the wider gap between the two boxes.
	const ends: IEnd[] = [];
	const straight = new Set<number>();
	const pairs = new Map<string, number[]>();
	drawn.forEach(({ from, to }, i) => {
		const a = boxOf(from), b = boxOf(to);
		const sa = facingSide(a, b), sb = facingSide(b, a);
		const start: IEnd = { edge: i, which: 'start', box: a, side: sa, at: 0 };
		const end: IEnd = { edge: i, which: 'end', box: b, side: sb, at: 0 };
		ends.push(start, end);
		const ra = sideRange(a, sa), rb = sideRange(b, sb);
		const lo = Math.max(ra.lo, rb.lo), hi = Math.min(ra.hi, rb.hi);
		if (Math.abs(sa - sb) === 2 && hi >= lo) {
			// Facing sides that overlap: a straight line, shared with other links between the same two boxes.
			straight.add(i);
			const key = [from.id, to.id].sort().join('|');
			pairs.set(key, [...pairs.get(key) ?? [], i]);
		}
	});
	const endsOf = (i: number) => [ends[i * 2], ends[i * 2 + 1]] as const;
	for (const group of pairs.values()) {
		const [s0, e0] = endsOf(group[0]);
		const ra = sideRange(s0.box, s0.side), rb = sideRange(e0.box, e0.side);
		const lo = Math.max(ra.lo, rb.lo), hi = Math.min(ra.hi, rb.hi);
		group.forEach((i, k) => {
			let at: number;
			if (group.length === 1) {
				// The middle of the smaller box, as near as the overlap allows: the line meets it square on.
				const level = s0.side === 0 || s0.side === 2;
				const small = (s0.box.maxX - s0.box.minX) * (s0.box.maxY - s0.box.minY) <= (e0.box.maxX - e0.box.minX) * (e0.box.maxY - e0.box.minY) ? s0.box : e0.box;
				const mid = level ? (small.minX + small.maxX) / 2 : (small.minY + small.maxY) / 2;
				at = Math.min(hi, Math.max(lo, mid));
			} else {
				at = lo + (hi - lo) * (k + 1) / (group.length + 1);
			}
			const [s, e] = endsOf(i);
			s.at = at;
			e.at = at;
		});
	}
	// The rest leave from the middle of their side, or towards the other end when it is off to one side.
	const placeBent = (i: number) => {
		for (const end of endsOf(i)) {
			const other = end.which === 'start' ? endsOf(i)[1].box : endsOf(i)[0].box;
			const level = end.side === 0 || end.side === 2;
			const r = sideRange(end.box, end.side);
			const toward = level ? (other.minX + other.maxX) / 2 : (other.minY + other.maxY) / 2;
			const mid = (r.lo + r.hi) / 2;
			end.at = Math.min(r.hi, Math.max(r.lo, mid + Math.max(-1, Math.min(1, (toward - mid) / Math.max(1, r.hi - r.lo))) * (r.hi - r.lo) * 0.25));
		}
	};
	drawn.forEach((_, i) => !straight.has(i) && placeBent(i));

	// Lines route round every card and every group they do not start or end in, keeping off the lines before them.
	const cardBoxes: IScratchObstacle[] = cards.map(c => ({ id: c.id, bounds: geometricBounds(c) }));
	const frameBoxes: IScratchObstacle[] = frames.map(f => ({ id: f.id, bounds: geometricBounds(f) }));
	const byId = new Map<string, ScratchElement>([...frames, ...cards].map(el => [el.id, el]));
	const lineFor = (i: number): IScratchLinearElement => {
		const { edge, from, to } = drawn[i];
		const [s, e] = endsOf(i);
		const a: Vec = [from.x + from.width / 2, from.y + from.height / 2];
		const b: Vec = [to.x + to.width / 2, to.y + to.height / 2];
		return createLinear({
			type: 'arrow',
			x: a[0], y: a[1],
			points: [[0, 0], [b[0] - a[0], b[1] - a[1]]],
			arrowType: 'elbow',
			startArrowhead: edge.both ? 'arrow' : 'none',
			endArrowhead: 'arrow',
			startBinding: { elementId: from.id, anchor: anchorFor(s.box, s.side, s.at) },
			endBinding: { elementId: to.id, anchor: anchorFor(e.box, e.side, e.at) },
			stroke: edge.color ?? INK,
			strokeWidth: 1.5,
			strokeStyle: edge.style,
			roughness: 0,
			fill: 'transparent',
			label: edge.label ? createLabel(`<p>${edgeLabelLines(edge.label, measure).lines.map(escapeHtml).join('<br>')}</p>`, style, { fontSize: EDGE_LABEL_SIZE, verticalAlign: edge.labelSide, color: edge.color ?? MUTED }) : null,
		}, style);
	};
	const route = (i: number, line: IScratchLinearElement, legs: IScratchRouteContext['legs']): IScratchLinearElement => {
		const { from, to, edge } = drawn[i];
		const own = new Set([from.id, to.id, groupFrameOf.get(edge.from), groupFrameOf.get(edge.to)]);
		const boxes = [...cardBoxes, ...frameBoxes].filter(o => !own.has(o.id));
		const patch = rebindConnector(line, id => byId.get(id), SCRATCH_BINDING_GAP, { boxes, legs });
		return patch ? { ...line, ...patch } : line;
	};
	const worldOf = (line: IScratchLinearElement): Vec[] => line.points.map((p): Vec => [line.x + p[0], line.y + p[1]]);

	// Between two boxes off each other's corners there are three ways round: across the wider gap,
	// or an L either way. Each takes the one that crosses the fewest lines and labels, on the least
	// crowded sides (straight lines go first: they have one way to go).
	const ownerOf = (end: IEnd) => (end.which === 'start' ? drawn[end.edge].from : drawn[end.edge].to).id;
	const crowd = (id: string, side: ScratchSide, skip: number) => ends.filter(o => o.edge !== skip && o.side === side && ownerOf(o) === id).length;
	let known: IScratchRouteContext['legs'] = [];
	const labelBoxes: IScratchBounds[] = [];
	const remember = (i: number, line: IScratchLinearElement) => {
		known = withLegs({ boxes: [], legs: known }, line.id, worldOf(line)).legs;
		if (line.label && drawn[i].edge.label) {
			const size = edgeLabelSize(drawn[i].edge.label, measure);
			const { at, side } = connectorLabelAnchor(line);
			labelBoxes.push(labelBoxAt([line.x + at[0], line.y + at[1]], side, size.width, size.height));
		}
	};
	for (const i of straight) {
		remember(i, route(i, lineFor(i), known));
	}
	drawn.forEach(({ from, to }, i) => {
		if (straight.has(i)) {
			return;
		}
		const a = boxOf(from), b = boxOf(to);
		const apartX = a.maxX < b.minX || b.maxX < a.minX, apartY = a.maxY < b.minY || b.maxY < a.minY;
		if (!apartX || !apartY) {
			return;
		}
		const [s, e] = endsOf(i);
		const vertical = (box: IScratchBounds, other: IScratchBounds): ScratchSide => other.minY > box.maxY ? 2 : 0;
		const horizontal = (box: IScratchBounds, other: IScratchBounds): ScratchSide => other.minX > box.maxX ? 1 : 3;
		const options: [ScratchSide, ScratchSide][] = [[s.side, e.side], [vertical(a, b), horizontal(b, a)], [horizontal(a, b), vertical(b, a)]];
		let best: { readonly sides: [ScratchSide, ScratchSide]; readonly score: number; readonly line: IScratchLinearElement } | undefined;
		for (const sides of options) {
			s.side = sides[0];
			e.side = sides[1];
			placeBent(i);
			const line = route(i, lineFor(i), known);
			const world = worldOf(line);
			const hits = labelBoxes.filter(box => world.some((p, k) => k > 0 && segmentEntersBounds(world[k - 1], p, expandBounds(box, -2)))).length;
			const score = elbowRouteScore(world, known) + hits * LABEL_HIT_COST + (crowd(from.id, sides[0], i) + crowd(to.id, sides[1], i)) * CROWDED_SIDE_COST;
			if (!best || score < best.score - 1) {
				best = { sides, score, line };
			}
		}
		s.side = best!.sides[0];
		e.side = best!.sides[1];
		placeBent(i);
		remember(i, best!.line);
	});

	// Ends on one side keep apart, in order.
	const bySide = new Map<string, IEnd[]>();
	for (const end of ends) {
		const el = end.which === 'start' ? drawn[end.edge].from : drawn[end.edge].to;
		const key = `${el.id}:${end.side}`;
		bySide.set(key, [...bySide.get(key) ?? [], end]);
	}
	for (const group of bySide.values()) {
		if (group.length < 2) {
			continue;
		}
		group.sort((p, q) => p.at - q.at);
		const r = sideRange(group[0].box, group[0].side);
		const spacing = Math.min(PORT_SPACING, (r.hi - r.lo) / Math.max(1, group.length - 1));
		for (let k = 1; k < group.length; k++) {
			group[k].at = Math.max(group[k].at, group[k - 1].at + spacing);
		}
		const over = group[group.length - 1].at - r.hi;
		if (over > 0) {
			for (const end of group) {
				end.at -= over;
			}
			for (let k = group.length - 2; k >= 0; k--) {
				group[k].at = Math.min(group[k].at, group[k + 1].at - spacing);
			}
		}
	}

	// Straight ones first: they have one way to go, and the others keep off them.
	const order = drawn.map((_, i) => i).sort((p, q) => Number(!straight.has(p)) - Number(!straight.has(q)) || p - q);
	const routed: IScratchLinearElement[] = new Array(drawn.length);
	let legs: IScratchRouteContext['legs'] = [];
	for (const i of order) {
		routed[i] = route(i, lineFor(i), legs);
		legs = withLegs({ boxes: [], legs }, routed[i].id, worldOf(routed[i])).legs;
	}
	// Lines that turn in the same gap get a track each.
	const tracks = separateElbowLegs(
		routed.map(worldOf),
		cardBoxes.map(o => o.bounds),
		drawn.map(({ edge }) => edge.label ? edgeLabelSize(edge.label, measure) : undefined),
	);
	return routed.map((line, i) => ({ ...line, ...normalizeLinear(tracks[i]) }));
}
