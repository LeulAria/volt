/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeEntities } from './scratchHtml.js';

/**
 * Mermaid flowcharts as data: enough of the grammar to turn a pasted diagram into shapes and
 * connectors, and to write a board's diagram back as text an agent can read.
 */

export type MermaidNodeShape = 'rectangle' | 'rounded' | 'stadium' | 'diamond' | 'circle' | 'hexagon' | 'cylinder' | 'parallelogram' | 'subroutine' | 'document';
/** An outline or line from `stroke-dasharray`: a first dash of 2 or less draws dots. */
export type MermaidStrokeStyle = 'solid' | 'dashed' | 'dotted';
/** How a link bends: right angles (the default), a smooth curve, or straight. */
export type MermaidCurve = 'elbow' | 'round' | 'straight';

/** Colours and outline from `style`, `classDef` with `class`/`:::` (hex only; the board maps them for dark boards). */
export interface IMermaidColors {
	readonly fill?: string;
	readonly stroke?: string;
	readonly strokeStyle?: MermaidStrokeStyle;
}

export interface IMermaidNode extends IMermaidColors {
	readonly id: string;
	readonly label: string;
	readonly shape: MermaidNodeShape;
}

export interface IMermaidEdge {
	readonly from: string;
	readonly to: string;
	readonly label: string;
	/** `-->`, `-.->` (drawn dotted) or `==>`. */
	readonly style: 'solid' | 'dotted' | 'thick';
	readonly startHead: boolean;
	readonly endHead: boolean;
	/** From `linkStyle`: colour, dashes, width in px and how the link bends. */
	readonly stroke?: string;
	readonly strokeStyle?: MermaidStrokeStyle;
	readonly strokeWidth?: number;
	readonly curve?: MermaidCurve;
}

export interface IMermaidSubgraph extends IMermaidColors {
	readonly id: string;
	readonly label: string;
	readonly nodeIds: string[];
}

export interface IMermaidGraph {
	readonly direction: 'TB' | 'BT' | 'LR' | 'RL';
	readonly nodes: IMermaidNode[];
	readonly edges: IMermaidEdge[];
	readonly subgraphs: IMermaidSubgraph[];
	/** Every link's bend, from `linkStyle default interpolate`, an init directive or front matter. */
	readonly curve?: MermaidCurve;
}

/** A ```mermaid fenced block, or text that is a flowchart on its own. */
export function extractMermaidSource(text: string): string | undefined {
	const fenced = /(^|\n)\s*(```|~~~)\s*mermaid[^\n]*\n([\s\S]*?)\n\s*\2/.exec(text);
	if (fenced) {
		return fenced[3].trim();
	}
	const body = stripFrontMatter(text.replace(/\r\n?/g, '\n'));
	const first = body.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('%%'));
	if (first && /^(graph|flowchart)\b/i.test(first)) {
		return body.trim();
	}
	return undefined;
}

function stripFrontMatter(text: string): string {
	const m = /^\s*---\n[\s\S]*?\n---\s*\n/.exec(text);
	return m ? text.slice(m[0].length) : text;
}

/** Splits on newlines and `;`, but not inside quotes or brackets. */
function splitStatements(source: string): string[] {
	const out: string[] = [];
	let current = '';
	let quote = false;
	let depth = 0;
	let pipe = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === '"') {
			quote = !quote;
		} else if (!quote) {
			if (ch === '[' || ch === '(' || ch === '{') {
				depth++;
			} else if (ch === ']' || ch === ')' || ch === '}') {
				depth = Math.max(0, depth - 1);
			} else if (ch === '|' && depth === 0) {
				pipe = !pipe;
			}
		}
		if (ch === '\n') {
			// A line always ends a statement; an unbalanced line does not swallow the rest.
			out.push(current);
			current = '';
			quote = false;
			depth = 0;
			pipe = false;
			continue;
		}
		if (ch === ';' && !quote && depth === 0 && !pipe) {
			out.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map(s => s.trim()).filter(s => s.length > 0);
}

/** Labels: mermaid entity codes, html entities, `<br>` line breaks, markdown-string backticks. */
function cleanLabel(raw: string): string {
	let text = raw.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		text = text.slice(1, -1);
	}
	if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
		text = text.slice(1, -1);
	}
	text = text
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/#quot;/g, '"')
		.replace(/#amp;/g, '&')
		.replace(/#lt;/g, '<')
		.replace(/#gt;/g, '>')
		.replace(/#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)));
	return decodeEntities(text).split('\n').map(line => line.trim()).join('\n').trim();
}

const ID_RE = /^[\p{L}\p{N}_$]+(?:[.\-][\p{L}\p{N}_$]+)*/u;

interface IShapeDelimiter {
	readonly open: string;
	readonly close: readonly string[];
	readonly shape: MermaidNodeShape;
}

/** Longest openers first. */
const SHAPE_DELIMITERS: readonly IShapeDelimiter[] = [
	{ open: '(((', close: [')))'], shape: 'circle' },
	{ open: '([', close: ['])'], shape: 'stadium' },
	{ open: '[[', close: [']]'], shape: 'subroutine' },
	{ open: '[(', close: [')]'], shape: 'cylinder' },
	{ open: '((', close: ['))'], shape: 'circle' },
	{ open: '{{', close: ['}}'], shape: 'hexagon' },
	{ open: '[/', close: ['/]', '\\]'], shape: 'parallelogram' },
	{ open: '[\\', close: ['\\]', '/]'], shape: 'parallelogram' },
	{ open: '[', close: [']'], shape: 'rectangle' },
	{ open: '(', close: [')'], shape: 'rounded' },
	{ open: '{', close: ['}'], shape: 'diamond' },
	{ open: '>', close: [']'], shape: 'parallelogram' },
];

const NEW_SYNTAX_SHAPES: Readonly<Record<string, MermaidNodeShape>> = {
	rect: 'rectangle', rectangle: 'rectangle', proc: 'rectangle', process: 'rectangle', square: 'rectangle',
	rounded: 'rounded', event: 'rounded',
	stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
	diam: 'diamond', diamond: 'diamond', decision: 'diamond', question: 'diamond',
	circ: 'circle', circle: 'circle', 'sm-circ': 'circle', 'dbl-circ': 'circle', 'double-circle': 'circle', start: 'circle',
	hex: 'hexagon', hexagon: 'hexagon', prepare: 'hexagon',
	cyl: 'cylinder', cylinder: 'cylinder', database: 'cylinder', db: 'cylinder', 'h-cyl': 'cylinder', 'lin-cyl': 'cylinder',
	'lean-r': 'parallelogram', 'lean-l': 'parallelogram', 'in-out': 'parallelogram', 'out-in': 'parallelogram', parallelogram: 'parallelogram', trap: 'parallelogram', 'trap-b': 'parallelogram', 'trap-t': 'parallelogram',
	subroutine: 'subroutine', subproc: 'subroutine', 'fr-rect': 'subroutine', framed: 'subroutine',
	doc: 'document', document: 'document', docs: 'document', documents: 'document', 'lin-doc': 'document', 'tag-doc': 'document',
};

interface IParsedNode {
	readonly id: string;
	readonly label?: string;
	readonly shape?: MermaidNodeShape;
	/** `A:::className` */
	readonly className?: string;
}

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `stroke-dasharray: 6 4` as an outline style: none or zeros are solid, a first dash of 2 or less is dots. */
function dashStyle(value: string): MermaidStrokeStyle | undefined {
	const dashes = (value.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
	if (/^\s*none\s*$/i.test(value) || (dashes.length && dashes.every(d => d === 0))) {
		return 'solid';
	}
	return dashes.length ? (dashes[0] <= 2 ? 'dotted' : 'dashed') : undefined;
}

/** What `linkStyle` and `style` print for an outline style. */
const DASHARRAY_FOR: Readonly<Record<MermaidStrokeStyle, string>> = { solid: '0', dashed: '6 4', dotted: '2 4' };

interface IStyleProps extends IMermaidColors {
	readonly strokeWidth?: number;
}

/** `fill:#e7f5ff,stroke:#1971c2,stroke-width:2px,stroke-dasharray:6 4`: what the board can show. */
function parseStyleProps(text: string): IStyleProps {
	let fill: string | undefined;
	let stroke: string | undefined;
	let strokeStyle: MermaidStrokeStyle | undefined;
	let strokeWidth: number | undefined;
	for (const part of text.split(/[,;]/)) {
		const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(part);
		if (!m) {
			continue;
		}
		const key = m[1].toLowerCase();
		const value = m[2].replace(/\s*!important$/i, '');
		if (key === 'stroke-dasharray') {
			strokeStyle = dashStyle(value) ?? strokeStyle;
		} else if (key === 'stroke-width') {
			const width = Number.parseFloat(value);
			strokeWidth = width > 0 && width <= 16 ? width : strokeWidth;
		} else if (!HEX_COLOR_RE.test(value)) {
			continue;
		} else if (key === 'fill' || key === 'background') {
			fill = value.toLowerCase();
		} else if (key === 'stroke') {
			stroke = value.toLowerCase();
		}
	}
	return { ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}), ...(strokeStyle ? { strokeStyle } : {}), ...(strokeWidth ? { strokeWidth } : {}) };
}

function mergeColors(...colors: (IMermaidColors | undefined)[]): IMermaidColors {
	let fill: string | undefined;
	let stroke: string | undefined;
	let strokeStyle: MermaidStrokeStyle | undefined;
	for (const c of colors) {
		fill = c?.fill ?? fill;
		stroke = c?.stroke ?? stroke;
		strokeStyle = c?.strokeStyle ?? strokeStyle;
	}
	return { ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}), ...(strokeStyle ? { strokeStyle } : {}) };
}

/** Mermaid's curve names (`basis`, `linear`, `step`...) as a link's bend. */
function curveFor(name: string): MermaidCurve | undefined {
	const n = name.toLowerCase();
	if (n.startsWith('step')) {
		return 'elbow';
	}
	if (n === 'linear') {
		return 'straight';
	}
	return ['basis', 'bumpx', 'bumpy', 'cardinal', 'catmullrom', 'monotonex', 'monotoney', 'natural'].includes(n) ? 'round' : undefined;
}

const CURVE_NAME: Readonly<Record<MermaidCurve, string>> = { elbow: 'step', round: 'basis', straight: 'linear' };

/** `curve:` in front matter (`config: flowchart: curve: basis`) or an init directive. */
function declaredCurve(source: string): MermaidCurve | undefined {
	const front = /^\s*---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
	const directives = [...source.matchAll(/%%\{([\s\S]*?)\}%%/g)].map(m => m[1]).join('\n');
	const m = /["']?\bcurve["']?\s*:\s*["']?(\w+)/.exec(`${front}\n${directives}`);
	return m ? curveFor(m[1]) : undefined;
}

/** A quoted string at `pos` (opening quote included), or undefined. */
function readQuoted(text: string, pos: number): { value: string; end: number } | undefined {
	if (text[pos] !== '"') {
		return undefined;
	}
	const close = text.indexOf('"', pos + 1);
	if (close === -1) {
		return undefined;
	}
	return { value: text.slice(pos + 1, close), end: close + 1 };
}

function skipSpaces(text: string, pos: number): number {
	while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) {
		pos++;
	}
	return pos;
}

/** Parses a node reference with its optional shape at `pos`. */
function readNode(text: string, pos: number): { node: IParsedNode; end: number } | undefined {
	const idMatch = ID_RE.exec(text.slice(pos));
	if (!idMatch) {
		return undefined;
	}
	const id = idMatch[0];
	let end = pos + id.length;
	let label: string | undefined;
	let shape: MermaidNodeShape | undefined;

	if (text.startsWith('@{', end)) {
		const close = findClosingBrace(text, end + 1);
		if (close !== -1) {
			const body = text.slice(end + 2, close);
			const shapeName = /(?:^|,)\s*shape\s*:\s*"?([\w-]+)"?/.exec(body)?.[1]?.toLowerCase();
			const labelMatch = /(?:^|,)\s*label\s*:\s*("(?:[^"]*)"|[^,}]+)/.exec(body);
			shape = shapeName ? NEW_SYNTAX_SHAPES[shapeName] ?? 'rectangle' : undefined;
			label = labelMatch ? cleanLabel(labelMatch[1]) : undefined;
			end = close + 1;
		}
	} else {
		for (const delim of SHAPE_DELIMITERS) {
			if (!text.startsWith(delim.open, end)) {
				continue;
			}
			const inner = end + delim.open.length;
			const quoted = readQuoted(text, skipSpaces(text, inner));
			if (quoted) {
				const after = skipSpaces(text, quoted.end);
				const closer = delim.close.find(c => text.startsWith(c, after));
				if (closer) {
					label = cleanLabel(quoted.value);
					shape = delim.shape;
					end = after + closer.length;
					break;
				}
			}
			let best = -1;
			let bestCloser = '';
			for (const closer of delim.close) {
				const at = text.indexOf(closer, inner);
				if (at !== -1 && (best === -1 || at < best)) {
					best = at;
					bestCloser = closer;
				}
			}
			if (best !== -1) {
				label = cleanLabel(text.slice(inner, best));
				shape = delim.shape;
				end = best + bestCloser.length;
				break;
			}
		}
	}
	// `A:::className`
	const cls = /^:::([\w-]+)/.exec(text.slice(end));
	if (cls) {
		end += cls[0].length;
	}
	return { node: { id, label, shape, ...(cls ? { className: cls[1] } : {}) }, end };
}

function findClosingBrace(text: string, openAt: number): number {
	let quote = false;
	for (let i = openAt + 1; i < text.length; i++) {
		if (text[i] === '"') {
			quote = !quote;
		} else if (!quote && text[i] === '}') {
			return i;
		}
	}
	return -1;
}

interface IParsedLink {
	readonly style: IMermaidEdge['style'];
	readonly startHead: boolean;
	readonly endHead: boolean;
	readonly label: string;
	readonly end: number;
}

const LINK_RE = /^(<|o(?=[-=])|x(?=[-=]))?(?:(-{2,})(>|o|x)|(-{3,})|(-\.+-)(>|o|x)?|(={2,})(>|o|x)|(={3,}))/;
const TEXT_LINK_RES: readonly { start: RegExp; end: RegExp; style: IMermaidEdge['style'] }[] = [
	{ start: /^(<)?--(?![->])/, end: /\s*(-{2,}>|-{3,}|-{2,}[ox])/, style: 'solid' },
	{ start: /^(<)?-\.(?!-)/, end: /\s*(\.-+>|\.-+)/, style: 'dotted' },
	{ start: /^(<)?==(?![=>])/, end: /\s*(={2,}>|={3,}|={2,}[ox])/, style: 'thick' },
];

/** Parses a link (with an optional `|label|`) at `pos`. */
function readLink(text: string, pos: number): IParsedLink | undefined {
	const rest = text.slice(pos);
	const m = LINK_RE.exec(rest);
	if (m) {
		// Groups: 2-3 solid with head / open, 5-6 dotted, 7-8 thick with head, 9 thick open.
		const head = m[3] ?? m[6] ?? m[8];
		const style: IMermaidEdge['style'] = m[5] ? 'dotted' : (m[7] || m[9]) ? 'thick' : 'solid';
		let end = pos + m[0].length;
		let label = '';
		const afterLink = skipSpaces(text, end);
		if (text[afterLink] === '|') {
			const quoted = readQuoted(text, skipSpaces(text, afterLink + 1));
			let close = -1;
			if (quoted) {
				const after = skipSpaces(text, quoted.end);
				if (text[after] === '|') {
					label = cleanLabel(quoted.value);
					close = after;
				}
			}
			if (close === -1) {
				close = text.indexOf('|', afterLink + 1);
				if (close !== -1) {
					label = cleanLabel(text.slice(afterLink + 1, close));
				}
			}
			if (close !== -1) {
				end = close + 1;
			}
		}
		return { style, startHead: !!m[1], endHead: !!head, label, end };
	}
	for (const form of TEXT_LINK_RES) {
		const start = form.start.exec(rest);
		if (!start) {
			continue;
		}
		const textStart = start[0].length;
		const endMatch = new RegExp(form.end.source, 'g');
		endMatch.lastIndex = textStart;
		let found: RegExpExecArray | null;
		while ((found = endMatch.exec(rest))) {
			const labelText = rest.slice(textStart, found.index);
			if (labelText.trim()) {
				const marker = found[1];
				const endHead = /[>ox]$/.test(marker);
				return { style: form.style, startHead: !!start[1], endHead, label: cleanLabel(labelText), end: pos + found.index + found[0].length };
			}
		}
	}
	return undefined;
}

interface IMutableSubgraph {
	id: string;
	label: string;
	nodeIds: string[];
}

/** `linkStyle 2,3 interpolate basis stroke:#e03131,stroke-dasharray:6 4` */
interface ILinkStyle {
	readonly targets: 'default' | readonly number[];
	readonly curve: MermaidCurve | undefined;
	readonly props: IStyleProps;
}

function withLinkStyle(edge: IMermaidEdge, props: IStyleProps, curve: MermaidCurve | undefined): IMermaidEdge {
	return {
		...edge,
		...(props.stroke ? { stroke: props.stroke } : {}),
		...(props.strokeStyle ? { strokeStyle: props.strokeStyle } : {}),
		...(props.strokeWidth ? { strokeWidth: props.strokeWidth } : {}),
		...(curve ? { curve } : {}),
	};
}

/** A Mermaid flowchart (graph/flowchart header). Undefined for other diagram types. */
export function parseMermaidFlowchart(source: string): IMermaidGraph | undefined {
	const normalized = source.replace(/\r\n?/g, '\n');
	const statements = splitStatements(stripFrontMatter(normalized)
		.split('\n').filter(line => !line.trim().startsWith('%%')).join('\n'));
	if (!statements.length) {
		return undefined;
	}
	const header = /^(graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?\b(.*)$/i.exec(statements[0]);
	if (!header) {
		return undefined;
	}
	const dir = (header[2] ?? 'TB').toUpperCase();
	const direction: IMermaidGraph['direction'] = dir === 'TD' ? 'TB' : dir as IMermaidGraph['direction'];
	// `graph TD; A-->B` on one line: the rest of the header line is a statement too.
	const remainder = header[3].trim();
	const body = remainder ? [remainder, ...statements.slice(1)] : statements.slice(1);

	const nodes = new Map<string, { id: string; label?: string; shape?: MermaidNodeShape }>();
	const edges: IMermaidEdge[] = [];
	const subgraphs: IMutableSubgraph[] = [];
	const subgraphOf = new Map<string, IMutableSubgraph>();
	const open: IMutableSubgraph[] = [];
	const classDefs = new Map<string, IMermaidColors>();
	const classesOf = new Map<string, string[]>();
	const styles = new Map<string, IMermaidColors>();
	const linkStyles: ILinkStyle[] = [];
	const addClass = (id: string, name: string) => {
		const list = classesOf.get(id) ?? [];
		list.push(name);
		classesOf.set(id, list);
	};
	let anonymous = 0;

	const touch = (parsed: IParsedNode) => {
		let node = nodes.get(parsed.id);
		if (!node) {
			node = { id: parsed.id };
			nodes.set(parsed.id, node);
		}
		if (parsed.className) {
			addClass(parsed.id, parsed.className);
		}
		if (parsed.label !== undefined) {
			node.label = parsed.label;
		}
		if (parsed.shape !== undefined) {
			node.shape = parsed.shape;
		}
		const current = open[open.length - 1];
		if (current && !subgraphOf.has(parsed.id) && parsed.id !== current.id) {
			subgraphOf.set(parsed.id, current);
			current.nodeIds.push(parsed.id);
		}
	};

	for (const statement of body) {
		const keyword = /^(\w+)\b/.exec(statement)?.[1]?.toLowerCase();
		if (keyword === 'subgraph') {
			const rest = statement.slice('subgraph'.length).trim();
			let id: string;
			let label: string;
			const withLabel = /^([\p{L}\p{N}_$.\-]+)\s*\[(.*)\]\s*$/u.exec(rest);
			if (withLabel) {
				id = withLabel[1];
				label = cleanLabel(withLabel[2]);
			} else if (rest.startsWith('"')) {
				label = cleanLabel(rest);
				id = `subgraph${++anonymous}`;
			} else if (/^[\p{L}\p{N}_$.\-]+$/u.test(rest)) {
				id = rest;
				label = rest;
			} else {
				label = cleanLabel(rest) || `Subgraph ${anonymous + 1}`;
				id = `subgraph${++anonymous}`;
			}
			const sub: IMutableSubgraph = { id, label, nodeIds: [] };
			subgraphs.push(sub);
			open.push(sub);
			continue;
		}
		if (keyword === 'end' && statement.trim().toLowerCase() === 'end') {
			open.pop();
			continue;
		}
		if (keyword === 'classdef') {
			const m = /^classDef\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s+(.+)$/i.exec(statement.trim());
			if (m) {
				const props = parseStyleProps(m[2]);
				for (const name of m[1].split(',')) {
					classDefs.set(name.trim(), mergeColors(classDefs.get(name.trim()), props));
				}
			}
			continue;
		}
		if (keyword === 'class') {
			const m = /^class\s+(.+?)\s+([\w-]+)\s*$/i.exec(statement.trim());
			if (m) {
				for (const id of m[1].split(',')) {
					addClass(id.trim(), m[2]);
				}
			}
			continue;
		}
		if (keyword === 'style') {
			const m = /^style\s+([\p{L}\p{N}_$.\-]+)\s+(.+)$/iu.exec(statement.trim());
			if (m) {
				styles.set(m[1], mergeColors(styles.get(m[1]), parseStyleProps(m[2])));
			}
			continue;
		}
		if (keyword === 'linkstyle') {
			const m = /^linkStyle\s+(default|\d+(?:\s*,\s*\d+)*)\s*(.*)$/i.exec(statement.trim());
			if (m) {
				const interpolate = /^interpolate\s+(\w+)\s*(.*)$/i.exec(m[2]);
				linkStyles.push({
					targets: m[1].toLowerCase() === 'default' ? 'default' : m[1].split(',').map(n => Number(n.trim())),
					curve: interpolate ? curveFor(interpolate[1]) : undefined,
					props: parseStyleProps(interpolate ? interpolate[2] : m[2]),
				});
			}
			continue;
		}
		if (keyword && ['click', 'direction', 'acctitle', 'accdescr', 'title'].includes(keyword)) {
			continue;
		}
		parseChain(statement, touch, edges);
	}

	// `linkStyle` counts links in the order they were written; `default` styles them all and sets the curve.
	let curve = declaredCurve(normalized);
	for (const style of linkStyles) {
		if (style.targets === 'default') {
			curve = style.curve ?? curve;
		}
	}
	const styledEdges = edges.map((edge, i) => linkStyles.reduce((out, style) =>
		style.targets === 'default' ? withLinkStyle(out, style.props, undefined)
			: style.targets.includes(i) ? withLinkStyle(out, style.props, style.curve) : out, edge));

	// `classDef default` first, then the node's classes in order, then its own `style`.
	const colorsOf = (id: string) => mergeColors(classDefs.get('default'), ...(classesOf.get(id) ?? []).map(name => classDefs.get(name)), styles.get(id));
	const subgraphIds = new Set(subgraphs.map(s => s.id));
	const nodeList: IMermaidNode[] = [];
	for (const node of nodes.values()) {
		// A subgraph named in a link is the subgraph, not a new node.
		if (subgraphIds.has(node.id) && node.label === undefined && node.shape === undefined) {
			continue;
		}
		nodeList.push({ id: node.id, label: node.label ?? node.id, shape: node.shape ?? 'rectangle', ...colorsOf(node.id) });
	}
	const kept = new Set(nodeList.map(n => n.id));
	return {
		direction,
		nodes: nodeList,
		edges: styledEdges,
		// A subgraph takes only what is set on it (not `classDef default`, which is for nodes).
		subgraphs: subgraphs.map(s => ({ id: s.id, label: s.label, nodeIds: s.nodeIds.filter(id => kept.has(id)), ...mergeColors(...(classesOf.get(s.id) ?? []).map(name => classDefs.get(name)), styles.get(s.id)) })),
		...(curve ? { curve } : {}),
	};
}

/** `A & B --> C -->|x| D`: node groups joined by links. Statements that do not parse are skipped. */
function parseChain(statement: string, touch: (node: IParsedNode) => void, edges: IMermaidEdge[]): void {
	const groups: IParsedNode[][] = [];
	const links: IParsedLink[] = [];
	let pos = skipSpaces(statement, 0);
	const readGroup = (): IParsedNode[] | undefined => {
		const group: IParsedNode[] = [];
		for (; ;) {
			const node = readNode(statement, pos);
			if (!node) {
				return group.length ? group : undefined;
			}
			group.push(node.node);
			pos = skipSpaces(statement, node.end);
			if (statement[pos] === '&') {
				pos = skipSpaces(statement, pos + 1);
				continue;
			}
			return group;
		}
	};
	const first = readGroup();
	if (!first) {
		return;
	}
	groups.push(first);
	while (pos < statement.length) {
		const link = readLink(statement, pos);
		if (!link) {
			break;
		}
		pos = skipSpaces(statement, link.end);
		const next = readGroup();
		if (!next) {
			break;
		}
		links.push(link);
		groups.push(next);
	}
	for (const group of groups) {
		for (const node of group) {
			touch(node);
		}
	}
	for (let i = 0; i < links.length; i++) {
		const link = links[i];
		for (const from of groups[i]) {
			for (const to of groups[i + 1]) {
				edges.push({ from: from.id, to: to.id, label: link.label, style: link.style, startHead: link.startHead, endHead: link.endHead });
			}
		}
	}
}

// ---- Printing --------------------------------------------------------------------------------

function quoteLabel(label: string): string {
	return '"' + label.replace(/"/g, '#quot;').replace(/\n/g, '<br>') + '"';
}

function nodeSyntax(node: IMermaidNode): string {
	const q = quoteLabel(node.label);
	switch (node.shape) {
		case 'rectangle': return `${node.id}[${q}]`;
		case 'rounded': return `${node.id}(${q})`;
		case 'stadium': return `${node.id}([${q}])`;
		case 'diamond': return `${node.id}{${q}}`;
		case 'circle': return `${node.id}((${q}))`;
		case 'hexagon': return `${node.id}{{${q}}}`;
		case 'cylinder': return `${node.id}[(${q})]`;
		case 'parallelogram': return `${node.id}[/${q}/]`;
		case 'subroutine': return `${node.id}[[${q}]]`;
		case 'document': return `${node.id}@{ shape: doc, label: ${q} }`;
	}
}

function linkSyntax(edge: IMermaidEdge): string {
	const start = edge.startHead ? '<' : '';
	let link: string;
	switch (edge.style) {
		case 'dotted': link = `${start}-.-${edge.endHead ? '>' : ''}`; break;
		case 'thick': link = `${start}==${edge.endHead ? '>' : '='}`; break;
		default: link = `${start}--${edge.endHead ? '>' : '-'}`; break;
	}
	return edge.label ? `${link}|${quoteLabel(edge.label)}|` : link;
}

/** Text that parses back to the same graph. */
export function graphToMermaid(graph: IMermaidGraph): string {
	const lines = [`flowchart ${graph.direction}`];
	for (const node of graph.nodes) {
		lines.push(`    ${nodeSyntax(node)}`);
	}
	for (const sub of graph.subgraphs) {
		lines.push(`    subgraph ${sub.id} [${quoteLabel(sub.label)}]`);
		for (const id of sub.nodeIds) {
			lines.push(`        ${id}`);
		}
		lines.push('    end');
	}
	for (const edge of graph.edges) {
		lines.push(`    ${edge.from} ${linkSyntax(edge)} ${edge.to}`);
	}
	for (const item of [...graph.nodes, ...graph.subgraphs]) {
		const props = [item.fill ? `fill:${item.fill}` : '', item.stroke ? `stroke:${item.stroke}` : '', item.strokeStyle ? `stroke-dasharray:${DASHARRAY_FOR[item.strokeStyle]}` : ''].filter(Boolean);
		if (props.length) {
			lines.push(`    style ${item.id} ${props.join(',')}`);
		}
	}
	if (graph.curve) {
		lines.push(`    linkStyle default interpolate ${CURVE_NAME[graph.curve]}`);
	}
	graph.edges.forEach((edge, i) => {
		const props = [
			edge.stroke ? `stroke:${edge.stroke}` : '',
			edge.strokeWidth ? `stroke-width:${edge.strokeWidth}px` : '',
			edge.strokeStyle ? `stroke-dasharray:${DASHARRAY_FOR[edge.strokeStyle]}` : '',
		].filter(Boolean).join(',');
		if (props || edge.curve) {
			lines.push(`    linkStyle ${i}${edge.curve ? ` interpolate ${CURVE_NAME[edge.curve]}` : ''}${props ? ` ${props}` : ''}`);
		}
	});
	return lines.join('\n');
}
