/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { createCodeCardShell, createMessageCopyIcon, ICodeCardOptions, mountMonacoCode, renderCodeCard } from './agentCodeBlock.js';
import { markupToFragment } from './agentMarkupDom.js';
import { mermaidLoaderShape, renderDotLoader } from '../visuals/agentDotLoader.js';
import type * as BeautifulMermaid from './vendor/beautifulMermaid.js';

interface MermaidNode {
	id: string;
	label: string;
	shape: 'rect' | 'round' | 'diamond' | 'circle';
}

interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
}

const NODE_ID = /[A-Za-z][\w-]*/;

export interface IMermaidOptions extends ICodeCardOptions {
	/** Opens the diagram larger (Cursor's "Expand diagram"). */
	readonly onExpand?: (svg: SVGSVGElement, source: string) => void;
	/** The fence is still streaming in: hold the diagram's place with the dot loader until it closes. */
	readonly streaming?: boolean;
}

/**
 * The colours Cursor hands beautiful-mermaid, as CSS so a theme change recolours drawn
 * diagrams: editor background, primary text, tertiary icon lines, cyan arrows, secondary
 * text, a faint node fill and tertiary borders.
 */
const MERMAID_THEME: BeautifulMermaid.RenderOptions = {
	bg: 'var(--volt-md-mermaid-bg)',
	fg: 'var(--volt-md-mermaid-fg)',
	line: 'var(--volt-md-mermaid-line)',
	accent: 'var(--volt-md-mermaid-accent)',
	muted: 'var(--volt-md-mermaid-muted)',
	surface: 'var(--volt-md-mermaid-surface)',
	border: 'var(--volt-md-mermaid-border)',
	// One family: the library quotes it, so a list here turned into one invalid name.
	font: '-apple-system',
	transparent: true,
};

let mermaidLib: typeof BeautifulMermaid | undefined;
let mermaidLoad: Promise<typeof BeautifulMermaid> | undefined;
const svgCache = new Map<string, string | null>();

/** Starts loading the diagram renderer (1.5 MB) so the first diagram draws without a placeholder. */
export function preloadMermaid(): Promise<unknown> {
	mermaidLoad ??= import('./vendor/beautifulMermaid.js').then(lib => mermaidLib = lib);
	return mermaidLoad.catch(() => undefined);
}

//#region xychart-beta as a Volt chart

/** `"Liechtenstein", Luxembourg, "United States"` → the items without their quotes. */
function splitMermaidList(list: string): string[] {
	const items: string[] = [];
	for (const match of list.matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([^,]+))\s*(?:,|$)/g)) {
		const item = (match[1] ?? match[2] ?? match[3] ?? '').trim();
		if (item || match[1] !== undefined) {
			items.push(item);
		}
	}
	return items;
}

function unquote(value: string | undefined): string | undefined {
	const text = value?.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
	return text || undefined;
}

/** True for ```mermaid sources that are data charts (`xychart-beta`), not diagrams. */
export function isMermaidXyChart(source: string): boolean {
	return /^\s*(?:%%[^\n]*\n\s*)*xychart(?:-beta)?\b/i.test(source);
}

/**
 * A mermaid `xychart-beta` (bars and lines over categories) as a Volt chart spec, so a data chart
 * an agent wrote in mermaid draws like render_chart: theme colors, hover, readable labels.
 * Undefined until the source has at least one complete data series.
 */
export function xychartToChartSpec(source: string): Record<string, unknown> | undefined {
	if (!isMermaidXyChart(source)) {
		return undefined;
	}
	let title: string | undefined;
	let categories: string[] | undefined;
	let xLabel: string | undefined;
	let xRange: [number, number] | undefined;
	let yLabel: string | undefined;
	let yRange: [number, number] | undefined;
	const series: { kind: 'bar' | 'line'; name?: string; data: number[] }[] = [];
	for (const raw of source.split('\n').slice(1)) {
		const line = raw.replace(/%%.*$/, '').trim();
		if (!line) {
			continue;
		}
		let match: RegExpExecArray | null;
		if ((match = /^title\s+(.+)$/i.exec(line))) {
			title = unquote(match[1]);
		} else if ((match = /^x-axis\s*(?:("[^"]*"|[^\s[]+)\s*)?\[(.*)\]\s*$/i.exec(line))) {
			xLabel = unquote(match[1]);
			categories = splitMermaidList(match[2]);
		} else if ((match = /^x-axis\s*(?:("[^"]*"|[^\s\d-][^\s]*)\s+)?(-?[\d.]+)\s*-->\s*(-?[\d.]+)\s*$/i.exec(line))) {
			xLabel = unquote(match[1]);
			xRange = [Number(match[2]), Number(match[3])];
		} else if ((match = /^y-axis\s*(?:("[^"]*"|[^\s\d-][^\s]*)\s*)?(?:(-?[\d.]+)\s*-->\s*(-?[\d.]+))?\s*$/i.exec(line))) {
			yLabel = unquote(match[1]);
			if (match[2] !== undefined && match[3] !== undefined) {
				yRange = [Number(match[2]), Number(match[3])];
			}
		} else if ((match = /^(bar|line)\s*("[^"]*")?\s*\[(.*)\]\s*$/i.exec(line))) {
			const data = splitMermaidList(match[3]).map(Number);
			if (data.length && data.every(Number.isFinite)) {
				series.push({ kind: match[1].toLowerCase() as 'bar' | 'line', name: unquote(match[2]), data });
			}
		}
	}
	if (!series.length) {
		return undefined;
	}
	const points = Math.max(...series.map(s => s.data.length));
	if (!categories?.length) {
		const [from, to] = xRange ?? [1, points];
		const step = points > 1 ? (to - from) / (points - 1) : 0;
		categories = Array.from({ length: points }, (_, index) => String(Math.round((from + step * index) * 100) / 100));
	}
	const bars = series.filter(s => s.kind === 'bar');
	const fallbackName = (index: number) => series.length === 1 ? (yLabel ?? title ?? 'Value') : `Series ${index + 1}`;
	const spec: Record<string, unknown> = {
		type: bars.length > 1 ? 'grouped-bar' : bars.length ? 'bar' : 'line',
		...(title ? { title } : {}),
		// Mermaid carries no unit; plain numbers, so "Thousand USD" never prints 227 as $227.
		unit: 'number',
		categories,
		x: { type: 'category', ...(xLabel ? { label: xLabel } : {}) },
		series: series.map((s, index) => ({
			name: s.name ?? fallbackName(index),
			data: s.data,
			...(bars.length && s.kind === 'line' ? { type: 'line' } : {}),
		})),
	};
	if (yLabel || yRange) {
		spec.y = { ...(yLabel ? { label: yLabel } : {}), ...(yRange ? { min: yRange[0], max: yRange[1] } : {}) };
	}
	return spec;
}

/** beautiful-mermaid keeps the quotes around xychart categories; drop them before it draws. */
function withoutQuotedCategories(source: string): string {
	if (!isMermaidXyChart(source)) {
		return source;
	}
	return source.replace(/^(\s*x-axis\s*(?:"[^"]*"\s*)?)\[(.*)\]\s*$/im, (_, head: string, list: string) => `${head}[${splitMermaidList(list).map(item => item.replace(/,/g, ' ')).join(', ')}]`);
}

//#endregion

//#region Class members

/**
 * The renderer reads class members only as `Type name`, but agents (and mermaid's docs) mostly
 * write `name: Type` and `method(): Type`, which drew as "UUID: id:" and "total(): : Money".
 */
function normalizeClassMember(member: string): string {
	const method = /^([+\-#~]?\s*)(.+?\([^)]*\)[$*]?)\s*:\s*(\S.*)$/.exec(member);
	if (method) {
		return `${method[1]}${method[2]} ${method[3]}`;
	}
	const field = /^([+\-#~]?\s*)([\w$*]+)\s*:\s*(\S.*)$/.exec(member);
	return field ? `${field[1]}${field[3]} ${field[2]}` : member;
}

export function normalizeClassDiagram(source: string): string {
	if (!/^\s*(?:%%[^\n]*\n\s*)*classDiagram\b/.test(source)) {
		return source;
	}
	let depth = 0;
	return source.split('\n').map(line => {
		const trimmed = line.trim();
		if (depth > 0) {
			if (trimmed === '}') {
				depth--;
				return line;
			}
			if (!trimmed || trimmed.startsWith('<<') || trimmed.startsWith('%%')) {
				return line;
			}
			return line.slice(0, line.length - line.trimStart().length) + normalizeClassMember(trimmed);
		}
		if (/^class\s+\S+.*\{\s*$/.test(trimmed)) {
			depth++;
			return line;
		}
		// `Order : +id: UUID` (one member on a line of its own); relations have arrows instead.
		const single = /^(\s*[\w~<>]+\s*:\s*)(.+)$/.exec(line);
		if (single && !/<\||\|>|--|\.\./.test(single[2])) {
			return single[1] + normalizeClassMember(single[2].trim());
		}
		return line;
	}).join('\n');
}

//#endregion

/**
 * The renderer's per-diagram `<style>` has bare `svg {}`, `text {}` and `.mono {}` rules: left as
 * they are they style every SVG in the window, and restyle it on each insert. Scope them to the diagram.
 */
export function scopeMermaidStyle(markup: string): string {
	return markup.replace(/<style>([\s\S]*?)<\/style>/g, (_, css: string) => `<style>${css.replace(/(^|[}\n])\s*(svg|text|\.mono)\s*\{/g, (_match, before: string, selector: string) => `${before}\n  ${selector === 'svg' ? 'svg.volt-md-mermaid-svg' : `.volt-md-mermaid-svg ${selector}`} {`)}</style>`);
}

/** SVG markup for `source`, or `null` when the renderer cannot draw it. `undefined` means not loaded yet. */
function mermaidMarkup(source: string): string | null | undefined {
	const key = normalizeClassDiagram(withoutQuotedCategories(source.trim()));
	if (svgCache.has(key)) {
		return svgCache.get(key)!;
	}
	if (!mermaidLib) {
		return undefined;
	}
	let svg: string | null = null;
	try {
		// The library pulls a web font in with @import; system fonts render the same and stay offline.
		svg = scopeMermaidStyle(mermaidLib.renderMermaidSVG(key, MERMAID_THEME).replace(/@import url\([^)]*\);?/g, ''));
	} catch {
		svg = null;
	}
	svgCache.set(key, svg);
	if (svgCache.size > 100) {
		const oldest = svgCache.keys().next().value;
		if (oldest !== undefined) {
			svgCache.delete(oldest);
		}
	}
	return svg;
}

export function renderMermaidDiagram(parent: HTMLElement, source: string, options: IMermaidOptions): void {
	const host = append(parent, $('.volt-agent-block.mermaid'));
	if (options.streaming) {
		// A half-written diagram either fails to parse or reshuffles with every line: show it once whole.
		renderDiagramLoader(host, source);
		void preloadMermaid();
		return;
	}
	if (mermaidMarkup(source) === undefined) {
		// The renderer is still loading: dots in the diagram's likely shape, then the diagram.
		renderDiagramLoader(host, source);
		preloadMermaid().then(() => {
			if (host.isConnected) {
				host.replaceChildren();
				draw(host, source, options);
				options.onDidChangeSize?.();
			}
		});
		return;
	}
	draw(host, source, options);
}

function renderDiagramLoader(host: HTMLElement, source: string): void {
	host.classList.add('loading');
	const { shape, height } = mermaidLoaderShape(source);
	renderDotLoader(host, {
		shape,
		height,
		caption: localize('voltAgent.mermaid.drawing', "Drawing diagram"),
	});
}

function draw(host: HTMLElement, source: string, options: IMermaidOptions): void {
	host.classList.remove('loading');
	const markup = mermaidMarkup(source);
	const doc = host.ownerDocument;
	let svg: SVGSVGElement | undefined;
	if (markup) {
		const fragment = markupToFragment(doc, markup, true);
		const root = fragment.firstElementChild;
		if (root && root.nodeName.toLowerCase() === 'svg') {
			svg = root as SVGSVGElement;
		}
	}
	svg ??= markup === undefined ? undefined : renderLegacyDiagram(doc, source);
	if (!svg) {
		// Not drawable (yet): show the source the way Cursor shows any other fence.
		renderCodeCard(host, 'mermaid', source.trim(), options);
		return;
	}
	renderDiagramCard(host, svg, source, options);
}

//#region The diagram card

interface IDiagramKind {
	readonly label: string;
	readonly icon: ThemeIcon;
	/** What the parts are called, for "6 states · 7 transitions". */
	readonly nodes?: [one: string, many: string];
	readonly links?: [one: string, many: string];
}

/** What a mermaid source draws, from its first keyword. */
export function diagramKind(source: string): IDiagramKind {
	const keyword = /^\s*(?:%%[^\n]*\n\s*)*([A-Za-z][\w-]*)/.exec(source)?.[1].toLowerCase() ?? '';
	switch (keyword) {
		case 'flowchart':
		case 'graph':
			return { label: localize('voltAgent.diagram.flowchart', "Flowchart"), icon: Codicon.typeHierarchy, nodes: [localize('voltAgent.diagram.node', "node"), localize('voltAgent.diagram.nodes', "nodes")], links: [localize('voltAgent.diagram.link', "link"), localize('voltAgent.diagram.links', "links")] };
		case 'sequencediagram':
			return { label: localize('voltAgent.diagram.sequence', "Sequence diagram"), icon: Codicon.arrowSwap, nodes: [localize('voltAgent.diagram.participant', "participant"), localize('voltAgent.diagram.participants', "participants")], links: [localize('voltAgent.diagram.message', "message"), localize('voltAgent.diagram.messages', "messages")] };
		case 'classdiagram':
			return { label: localize('voltAgent.diagram.class', "Class diagram"), icon: Codicon.symbolClass, nodes: [localize('voltAgent.diagram.classOne', "class"), localize('voltAgent.diagram.classes', "classes")], links: [localize('voltAgent.diagram.relation', "relation"), localize('voltAgent.diagram.relations', "relations")] };
		case 'statediagram':
		case 'statediagram-v2':
			return { label: localize('voltAgent.diagram.state', "State diagram"), icon: Codicon.debugStepOver, nodes: [localize('voltAgent.diagram.stateOne', "state"), localize('voltAgent.diagram.states', "states")], links: [localize('voltAgent.diagram.transition', "transition"), localize('voltAgent.diagram.transitions', "transitions")] };
		case 'erdiagram':
			return { label: localize('voltAgent.diagram.er', "Entity relationship"), icon: Codicon.database, nodes: [localize('voltAgent.diagram.entity', "entity"), localize('voltAgent.diagram.entities', "entities")], links: [localize('voltAgent.diagram.relation', "relation"), localize('voltAgent.diagram.relations', "relations")] };
		case 'pie':
			return { label: localize('voltAgent.diagram.pie', "Pie chart"), icon: Codicon.pieChart };
		case 'xychart':
		case 'xychart-beta':
			return { label: localize('voltAgent.diagram.chart', "Chart"), icon: Codicon.graph };
		default:
			return { label: localize('voltAgent.diagram', "Diagram"), icon: Codicon.typeHierarchy };
	}
}

/** "10 nodes · 9 links", from what the renderer drew. */
function diagramSummary(svg: SVGSVGElement, kind: IDiagramKind): string {
	const count = (what: [string, string] | undefined, selector: string) => {
		const n = what ? svg.querySelectorAll(selector).length : 0;
		return n ? `${n} ${n === 1 ? what![0] : what![1]}` : '';
	};
	// Start and end dots of a state diagram are not states.
	const nodes = count(kind.nodes, 'g.node:not([data-shape^="state-"]), g.class-node, g.entity, g.actor');
	const links = count(kind.links, '.edge, .class-relationship, g.message, .er-relationship');
	return [nodes, links].filter(Boolean).join(' · ');
}

/** Tall diagrams fit a screenful in the reply, down to 75% (labels stay readable); Expand shows them whole. */
const DIAGRAM_FIT_HEIGHT = 560;
const DIAGRAM_MIN_SCALE = 0.75;

function headButton(parent: HTMLElement, icon: ThemeIcon, label: string, store: DisposableStore, run: (button: HTMLButtonElement) => void): HTMLButtonElement {
	const button = append(parent, $('button.volt-diagram-button')) as HTMLButtonElement;
	button.type = 'button';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.appendChild(renderIcon(icon));
	store.add(addDisposableListener(button, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		run(button);
	}));
	return button;
}

/**
 * A drawn diagram: a head with what it is ("Flowchart · 10 nodes · 9 links"), a Diagram / Code
 * switch, Copy and Expand; the diagram on a quiet dot grid, where hovering a node lights it and
 * everything it connects to.
 */
function renderDiagramCard(host: HTMLElement, svg: SVGSVGElement, source: string, options: IMermaidOptions): void {
	const kind = diagramKind(source);
	const shell = createCodeCardShell(host, { ...options, onCopyText: undefined }, [], source.trim());
	shell.card.classList.add('mermaid', 'volt-diagram');
	shell.overlay.remove();
	const head = $('.volt-diagram-head');
	shell.content.insertBefore(head, shell.scroll);
	const title = append(head, $('.volt-diagram-title'));
	title.appendChild(renderIcon(kind.icon));
	append(title, $('span.volt-diagram-kind')).textContent = kind.label;
	const summary = append(title, $('span.volt-diagram-summary'));
	const tools = append(head, $('.volt-diagram-tools'));

	// Diagram / Code: a pill switch whose thumb slides to the chosen side.
	const views = append(tools, $('.volt-diagram-views'));
	views.setAttribute('role', 'tablist');
	append(views, $('span.volt-diagram-views-thumb'));
	const viewTab = (label: string, selected: boolean) => {
		const tab = append(views, $('button.volt-diagram-view')) as HTMLButtonElement;
		tab.type = 'button';
		tab.textContent = label;
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(selected));
		return tab;
	};
	const diagramTab = viewTab(localize('voltAgent.diagram.view', "Diagram"), true);
	const codeTab = viewTab(localize('voltAgent.diagram.code', "Code"), false);
	let sourceView: HTMLElement | undefined;
	const glide = new HeightGlide(shell.card);
	options.store.add(glide);
	const showCode = (code: boolean) => {
		if (shell.card.classList.contains('showing-source') === code) {
			return;
		}
		views.dataset.view = code ? 'code' : 'diagram';
		diagramTab.setAttribute('aria-selected', String(!code));
		codeTab.setAttribute('aria-selected', String(code));
		glide.run(() => {
			// The source in the workbench's own read-only editor (theme colours, Mermaid grammar, line
			// numbers), made the first time it is asked for. Without an editor service, plain text.
			if (code && !sourceView) {
				sourceView = append(shell.content, $('.volt-diagram-source'));
				shell.card.classList.add('showing-source');
				if (!mountMonacoCode(sourceView, source.trim(), 'mermaid', options, { lineNumbers: true, padding: 12, indentGuides: false })) {
					append(append(sourceView, $('pre.volt-diagram-source-plain')), $('code')).textContent = source.trim();
				}
			}
			shell.card.classList.toggle('showing-source', code);
			const shown = code ? sourceView : shell.scroll;
			if (shown) {
				shown.classList.remove('volt-diagram-view-enter');
				void shown.offsetWidth; // restart the fade when switching back and forth quickly
				shown.classList.add('volt-diagram-view-enter');
			}
		}, () => options.onDidChangeSize?.());
	};
	options.store.add(addDisposableListener(diagramTab, 'click', e => { e.preventDefault(); e.stopPropagation(); showCode(false); }));
	options.store.add(addDisposableListener(codeTab, 'click', e => { e.preventDefault(); e.stopPropagation(); showCode(true); }));

	if (options.onCopyText) {
		// The same glyph as a reply's Copy, and the same check once copied.
		const copy = headButton(tools, Codicon.copy, localize('voltAgent.diagram.copy', "Copy Mermaid Source"), options.store, button => {
			options.onCopyText?.(source.trim());
			button.replaceChildren(renderIcon(Codicon.check));
			button.classList.add('done');
			getWindow(button).setTimeout(() => {
				button.replaceChildren(createMessageCopyIcon());
				button.classList.remove('done');
			}, 1500);
		});
		copy.classList.add('copy');
		copy.replaceChildren(createMessageCopyIcon());
	}
	if (options.onExpand) {
		headButton(tools, Codicon.screenFull, localize('voltAgent.mermaid.expand', "Expand diagram"), options.store, () => options.onExpand?.(svg.cloneNode(true) as SVGSVGElement, source));
	}

	const content = append(shell.scroll, $('.volt-md-mermaid-content'));
	svg.classList.add('volt-md-mermaid-svg');
	polishDiagram(svg);
	content.appendChild(svg);
	summary.textContent = diagramSummary(svg, kind);
	if (options.onExpand) {
		// The whole drawing opens the zoomable view: a pointer, not a text cursor, over it.
		content.classList.add('expandable');
		content.tabIndex = 0;
		content.setAttribute('role', 'button');
		content.setAttribute('aria-label', localize('voltAgent.mermaid.expandNamed', "Expand {0}", kind.label));
		const expand = () => options.onExpand?.(svg.cloneNode(true) as SVGSVGElement, source);
		options.store.add(addDisposableListener(content, 'click', e => {
			e.preventDefault();
			expand();
		}));
		options.store.add(addDisposableListener(content, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				expand();
			}
		}));
	}
	// The CSS shrinks a wide diagram to the column while it stays readable; wider ones scroll, and
	// the faded edge says there is more. A tall one is fitted to a screenful the same way.
	const naturalWidth = svg.viewBox?.baseVal?.width || parseFloat(svg.getAttribute('width') ?? '');
	const naturalHeight = svg.viewBox?.baseVal?.height || parseFloat(svg.getAttribute('height') ?? '');
	if (naturalWidth > 0) {
		const fit = naturalHeight > DIAGRAM_FIT_HEIGHT ? Math.max(DIAGRAM_MIN_SCALE, DIAGRAM_FIT_HEIGHT / naturalHeight) : 1;
		svg.style.setProperty('--volt-md-mermaid-width', `${naturalWidth * fit}px`);
	}
	traceConnections(svg);
	const scroll = shell.scroll;
	const updateEdges = () => {
		scroll.classList.toggle('volt-md-scroll-more-left', scroll.scrollLeft > 1);
		scroll.classList.toggle('volt-md-scroll-more-right', scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1);
	};
	scroll.addEventListener('scroll', updateEdges, { passive: true });
	scroll.addEventListener('pointerenter', updateEdges);
	host.ownerDocument.defaultView?.requestAnimationFrame(updateEdges);
}

/**
 * Runs a change to a card's content and glides the card from its old height to the new one, so
 * the reply below moves smoothly instead of jumping. A second change mid-glide starts from where
 * the card is. No glide with reduced motion.
 */
class HeightGlide {
	private timer: number | undefined;
	private generation = 0;

	constructor(private readonly element: HTMLElement) { }

	run(change: () => void, settled: () => void): void {
		const element = this.element;
		const win = getWindow(element);
		const from = element.getBoundingClientRect().height;
		this.reset();
		change();
		const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		const to = element.getBoundingClientRect().height;
		if (reduce || !element.isConnected || Math.abs(to - from) < 1) {
			settled();
			return;
		}
		const generation = ++this.generation;
		// The class makes the card border-box, so the heights read above (borders included) land exactly.
		element.classList.add('volt-diagram-gliding');
		element.style.height = `${from}px`;
		void element.offsetHeight; // commit the start height before the transition
		element.style.height = `${to}px`;
		this.timer = win.setTimeout(() => {
			if (generation === this.generation) {
				this.reset();
				settled();
			}
		}, GLIDE_MS + 40);
	}

	private reset(): void {
		if (this.timer !== undefined) {
			getWindow(this.element).clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.element.classList.remove('volt-diagram-gliding');
		this.element.style.height = '';
	}

	dispose(): void {
		this.generation++;
		this.reset();
	}
}

/** The glide's length; agentMarkdown.css's `.volt-diagram-gliding` transition matches it. */
const GLIDE_MS = 300;

//#region Polish: glass edges and rounded corners

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Every shape's corners, connector bends included. */
const CORNER_RADIUS = 6;
let glassIds = 0;

function points(list: string): [number, number][] {
	const numbers = list.trim().split(/[\s,]+/).map(Number);
	const result: [number, number][] = [];
	for (let i = 0; i + 1 < numbers.length; i += 2) {
		if (Number.isFinite(numbers[i]) && Number.isFinite(numbers[i + 1])) {
			result.push([numbers[i], numbers[i + 1]]);
		}
	}
	return result;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * A path through `pts` whose corners are arcs of `radius` (smaller where the sides are short):
 * a closed one for diamonds and other polygons, an open one for elbow connectors.
 */
export function roundedPath(pts: readonly [number, number][], closed: boolean, radius = CORNER_RADIUS): string {
	if (pts.length < 3) {
		return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${round(x)} ${round(y)}`).join(' ');
	}
	const n = pts.length;
	const corner = (i: number) => {
		const [x, y] = pts[i];
		const [px, py] = pts[(i - 1 + n) % n];
		const [nx, ny] = pts[(i + 1) % n];
		const inLen = Math.hypot(x - px, y - py);
		const outLen = Math.hypot(nx - x, ny - y);
		const r = Math.min(radius, inLen / 2, outLen / 2);
		const a: [number, number] = inLen ? [x - (x - px) / inLen * r, y - (y - py) / inLen * r] : [x, y];
		const b: [number, number] = outLen ? [x + (nx - x) / outLen * r, y + (ny - y) / outLen * r] : [x, y];
		return { a, b, x, y };
	};
	const parts: string[] = [];
	if (closed) {
		const first = corner(0);
		parts.push(`M${round(first.b[0])} ${round(first.b[1])}`);
		for (let i = 1; i <= n; i++) {
			const c = corner(i % n);
			parts.push(`L${round(c.a[0])} ${round(c.a[1])}`, `Q${round(c.x)} ${round(c.y)} ${round(c.b[0])} ${round(c.b[1])}`);
		}
		parts.push('Z');
	} else {
		parts.push(`M${round(pts[0][0])} ${round(pts[0][1])}`);
		for (let i = 1; i < n - 1; i++) {
			const c = corner(i);
			parts.push(`L${round(c.a[0])} ${round(c.a[1])}`, `Q${round(c.x)} ${round(c.y)} ${round(c.b[0])} ${round(c.b[1])}`);
		}
		parts.push(`L${round(pts[n - 1][0])} ${round(pts[n - 1][1])}`);
	}
	return parts.join(' ');
}

/** `element` swapped for a `<path>` with the same attributes (class, data-*, markers, stroke). */
function replaceWithPath(element: SVGElement, d: string): SVGPathElement {
	const path = element.ownerDocument.createElementNS(SVG_NS, 'path') as SVGPathElement;
	for (const attribute of Array.from(element.attributes)) {
		if (attribute.name !== 'points' && !/^(x|y|width|height|rx|ry)$/.test(attribute.name)) {
			path.setAttribute(attribute.name, attribute.value);
		}
	}
	path.setAttribute('d', d);
	element.replaceWith(path);
	return path;
}

/**
 * Makes a drawn diagram modern: every shape with 6px corners (diamonds and other polygons become
 * rounded paths, class and entity title bars round only on top), connector bends rounded the same,
 * and a glass edge (a 1px stroke, brighter at the top) from a gradient of this diagram's own. A
 * copy (the expanded view) only gets a gradient of its own: ids must stay unique in the window.
 */
function polishDiagram(svg: SVGSVGElement): void {
	const doc = svg.ownerDocument;
	svg.querySelector('linearGradient.volt-glass')?.remove();
	const id = `volt-glass-${++glassIds}`;
	const defs = svg.querySelector(':scope > defs') ?? svg.insertBefore(doc.createElementNS(SVG_NS, 'defs'), svg.firstChild);
	const gradient = doc.createElementNS(SVG_NS, 'linearGradient');
	gradient.id = id;
	gradient.setAttribute('class', 'volt-glass');
	gradient.setAttribute('x1', '0');
	gradient.setAttribute('y1', '0');
	gradient.setAttribute('x2', '0');
	gradient.setAttribute('y2', '1');
	for (const [offset, tone] of [['0', 'hi'], ['0.5', 'mid'], ['1', 'lo']]) {
		const stop = doc.createElementNS(SVG_NS, 'stop');
		stop.setAttribute('offset', offset);
		stop.setAttribute('class', `volt-glass-${tone}`);
		gradient.appendChild(stop);
	}
	defs.appendChild(gradient);
	svg.style.setProperty('--volt-glass-stroke', `url(#${id})`);
	if (svg.hasAttribute('data-volt-polished')) {
		return;
	}
	svg.setAttribute('data-volt-polished', '');
	// Diamonds, hexagons, parallelograms...
	for (const polygon of Array.from(svg.querySelectorAll<SVGElement>('g[data-id] polygon'))) {
		const pts = points(polygon.getAttribute('points') ?? '');
		if (pts.length >= 3) {
			replaceWithPath(polygon, roundedPath(pts, true));
		}
	}
	// Class and entity title bars: rounded on top only, so the box keeps one clean outline.
	for (const header of Array.from(svg.querySelectorAll<SVGRectElement>('g.class-node > rect:nth-of-type(2), g.entity > rect:nth-of-type(2)'))) {
		const x = Number(header.getAttribute('x')), y = Number(header.getAttribute('y'));
		const w = Number(header.getAttribute('width')), h = Number(header.getAttribute('height'));
		if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
			const r = Math.min(CORNER_RADIUS, w / 2, h);
			replaceWithPath(header, `M${round(x)} ${round(y + h)} V${round(y + r)} Q${round(x)} ${round(y)} ${round(x + r)} ${round(y)} H${round(x + w - r)} Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + r)} V${round(y + h)} Z`).classList.add('volt-diagram-title-bar');
		}
	}
	// An accent ring over each card's edge, faded in while it is traced. The edge itself is a
	// gradient, which cannot be animated into a colour; a ring fading in over it can.
	for (const group of Array.from(svg.querySelectorAll<SVGGElement>('g.node, g.class-node, g.entity, g.actor'))) {
		const firstText = Array.from(group.children).find(child => child.tagName.toLowerCase() === 'text') ?? null;
		for (const shape of Array.from(group.children)) {
			const tag = shape.tagName.toLowerCase();
			if ((tag === 'rect' || tag === 'path' || tag === 'ellipse') && !shape.classList.contains('volt-diagram-title-bar')) {
				const ring = shape.cloneNode(false) as SVGElement;
				ring.setAttribute('class', 'volt-diagram-ring');
				ring.setAttribute('aria-hidden', 'true');
				group.insertBefore(ring, firstText);
			}
		}
	}
	// Elbow connectors bend on a curve instead of a hard corner.
	for (const line of Array.from(svg.querySelectorAll<SVGElement>('polyline'))) {
		if (line.closest('defs, marker')) {
			continue;
		}
		const pts = points(line.getAttribute('points') ?? '');
		if (pts.length >= 2) {
			replaceWithPath(line, roundedPath(pts, false));
		}
	}
}

//#endregion

/**
 * Hovering a node (or an actor) lights it, its links and the nodes at their other ends, and dims
 * the rest; hovering a link lights it and its two ends. Works on what the renderer marks up:
 * nodes carry `data-id`, links `data-from`/`data-to`, sequence lifelines `data-actor`.
 */
function traceConnections(svg: SVGSVGElement): void {
	// ER relationships name their ends entity1 / entity2.
	for (const link of svg.querySelectorAll<SVGElement>('[data-entity1][data-entity2]')) {
		link.dataset.from = link.dataset.entity1;
		link.dataset.to = link.dataset.entity2;
	}
	const nodes = Array.from(svg.querySelectorAll<SVGElement>('g[data-id]:not(.subgraph)'));
	const links = Array.from(svg.querySelectorAll<SVGElement>('[data-from][data-to]'));
	if (!nodes.length || !links.length) {
		return;
	}
	let lit: SVGElement[] = [];
	const win = getWindow(svg);
	let clearTimer: number | undefined;
	const cancelClear = () => {
		if (clearTimer !== undefined) {
			win.clearTimeout(clearTimer);
			clearTimer = undefined;
		}
	};
	// Leaving a node clears after a beat, so sliding from one node to the next never flashes.
	const clearSoon = () => {
		cancelClear();
		clearTimer = win.setTimeout(() => {
			clearTimer = undefined;
			clear();
		}, 90);
	};
	const clear = () => {
		for (const element of lit) {
			element.classList.remove('lit');
		}
		lit = [];
		svg.classList.remove('tracing');
	};
	const light = (ids: Set<string>, edges: SVGElement[]) => {
		cancelClear();
		clear();
		lit = [...edges, ...nodes.filter(node => ids.has(node.dataset.id!))];
		for (const lifeline of svg.querySelectorAll<SVGElement>('[data-actor]')) {
			if (ids.has(lifeline.dataset.actor!)) {
				lit.push(lifeline);
			}
		}
		for (const element of lit) {
			element.classList.add('lit');
		}
		svg.classList.add('tracing');
	};
	svg.addEventListener('pointerover', event => {
		const target = event.target as Element | null;
		const node = target?.closest<SVGElement>('g[data-id]:not(.subgraph)');
		if (node && svg.contains(node)) {
			const id = node.dataset.id!;
			const edges = links.filter(link => link.dataset.from === id || link.dataset.to === id);
			light(new Set([id, ...edges.flatMap(link => [link.dataset.from!, link.dataset.to!])]), edges);
			return;
		}
		const link = target?.closest<SVGElement>('[data-from][data-to]');
		if (link && svg.contains(link)) {
			const same = links.filter(other => other.dataset.from === link.dataset.from && other.dataset.to === link.dataset.to);
			light(new Set([link.dataset.from!, link.dataset.to!]), same);
			return;
		}
		clearSoon();
	});
	svg.addEventListener('pointerleave', clearSoon);
}

//#endregion

//#region Expanded diagram: zoom and pan

const VIEWER_MIN_ZOOM = 0.2;
const VIEWER_MAX_ZOOM = 6;

/**
 * The diagram full size in the preview dialog, on a canvas that zooms (pinch, ⌘/Ctrl + wheel,
 * double-click, + / −) and pans (drag, wheel), with a zoom pill at the bottom. It opens fitted.
 */
export function createDiagramViewer(svg: SVGSVGElement, store: DisposableStore): HTMLElement {
	const viewer = $('.volt-diagram-viewer');
	viewer.tabIndex = 0;
	const stage = append(viewer, $('.volt-diagram-viewer-stage'));
	const width = svg.viewBox?.baseVal?.width || parseFloat(svg.getAttribute('width') ?? '') || 800;
	const height = svg.viewBox?.baseVal?.height || parseFloat(svg.getAttribute('height') ?? '') || 600;
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.style.removeProperty('--volt-md-mermaid-width');
	svg.classList.add('volt-md-mermaid-svg');
	polishDiagram(svg);
	stage.appendChild(svg);
	traceConnections(svg);

	const bar = append(viewer, $('.volt-diagram-viewer-bar'));
	let zoom = 1;
	let x = 0;
	let y = 0;
	const level = $('button.volt-diagram-viewer-level') as HTMLButtonElement;
	const apply = (animate = false) => {
		stage.classList.toggle('animate', animate);
		stage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
		level.textContent = `${Math.round(zoom * 100)}%`;
	};
	const zoomAt = (next: number, cx: number, cy: number, animate = false) => {
		next = Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, next));
		x = cx - (cx - x) * (next / zoom);
		y = cy - (cy - y) * (next / zoom);
		zoom = next;
		apply(animate);
	};
	const center = () => [viewer.clientWidth / 2, viewer.clientHeight / 2] as const;
	const fit = (animate = false) => {
		const pad = 48;
		const w = viewer.clientWidth;
		const h = viewer.clientHeight - 40;
		if (!w || !h) {
			return;
		}
		zoom = Math.min(2, Math.max(VIEWER_MIN_ZOOM, Math.min((w - pad * 2) / width, (h - pad * 2) / height)));
		x = (w - width * zoom) / 2;
		y = (h - height * zoom) / 2;
		apply(animate);
	};

	headButton(bar, Codicon.zoomOut, localize('voltAgent.diagram.zoomOut', "Zoom Out"), store, () => zoomAt(zoom / 1.25, ...center(), true));
	bar.appendChild(level);
	level.type = 'button';
	level.title = localize('voltAgent.diagram.actualSize', "Actual Size");
	store.add(addDisposableListener(level, 'click', e => {
		e.preventDefault();
		zoomAt(1, ...center(), true);
	}));
	headButton(bar, Codicon.zoomIn, localize('voltAgent.diagram.zoomIn', "Zoom In"), store, () => zoomAt(zoom * 1.25, ...center(), true));
	append(bar, $('span.volt-diagram-viewer-sep'));
	headButton(bar, Codicon.screenNormal, localize('voltAgent.diagram.fit', "Fit to Window"), store, () => fit(true));

	store.add(addDisposableListener(viewer, 'wheel', (e: WheelEvent) => {
		e.preventDefault();
		const rect = viewer.getBoundingClientRect();
		if (e.ctrlKey || e.metaKey) {
			// Trackpad pinch arrives as ctrl + wheel.
			zoomAt(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
		} else {
			x -= e.deltaX;
			y -= e.deltaY;
			apply();
		}
	}, { passive: false }));
	let drag: { id: number; sx: number; sy: number; x: number; y: number } | undefined;
	store.add(addDisposableListener(viewer, 'pointerdown', (e: PointerEvent) => {
		if (e.button !== 0 || bar.contains(e.target as Node)) {
			return;
		}
		drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x, y };
		viewer.setPointerCapture(e.pointerId);
		viewer.classList.add('dragging');
	}));
	store.add(addDisposableListener(viewer, 'pointermove', (e: PointerEvent) => {
		if (drag?.id === e.pointerId) {
			x = drag.x + e.clientX - drag.sx;
			y = drag.y + e.clientY - drag.sy;
			apply();
		}
	}));
	const endDrag = (e: PointerEvent) => {
		if (drag?.id === e.pointerId) {
			drag = undefined;
			viewer.classList.remove('dragging');
		}
	};
	store.add(addDisposableListener(viewer, 'pointerup', endDrag));
	store.add(addDisposableListener(viewer, 'pointercancel', endDrag));
	store.add(addDisposableListener(viewer, 'dblclick', (e: MouseEvent) => {
		if (bar.contains(e.target as Node)) {
			return;
		}
		const rect = viewer.getBoundingClientRect();
		zoomAt(e.shiftKey ? zoom / 1.6 : zoom * 1.6, e.clientX - rect.left, e.clientY - rect.top, true);
	}));
	store.add(addDisposableListener(viewer, 'keydown', (e: KeyboardEvent) => {
		if (e.key === '+' || e.key === '=') {
			zoomAt(zoom * 1.25, ...center(), true);
		} else if (e.key === '-') {
			zoomAt(zoom / 1.25, ...center(), true);
		} else if (e.key === '0') {
			fit(true);
		} else {
			return;
		}
		e.preventDefault();
	}));
	// Fitted once the dialog has laid it out, and again when the window resizes.
	const win = getWindow(viewer);
	const frame = win.requestAnimationFrame(() => {
		fit();
		viewer.focus();
	});
	store.add({ dispose: () => win.cancelAnimationFrame(frame) });
	const observer = new win.ResizeObserver(() => fit());
	observer.observe(viewer);
	store.add({ dispose: () => observer.disconnect() });
	return viewer;
}

//#endregion

function renderLegacyDiagram(doc: Document, source: string): SVGSVGElement | undefined {
	return renderFlowchart(doc, source) ?? renderPie(doc, source) ?? renderSequence(doc, source);
}

function renderFlowchart(doc: Document, source: string): SVGSVGElement | undefined {
	const lines = stripMermaid(source);
	const header = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i.exec(lines[0] ?? '');
	if (!header) {
		return undefined;
	}
	const direction = header[1].toUpperCase() === 'TB' ? 'TD' : header[1].toUpperCase();
	const nodes = new Map<string, MermaidNode>();
	const edges: MermaidEdge[] = [];
	const ensure = (id: string, label?: string, shape?: MermaidNode['shape']) => {
		const current = nodes.get(id);
		if (!current) {
			nodes.set(id, { id, label: label ?? id, shape: shape ?? 'rect' });
			return;
		}
		if (label) {
			current.label = label;
		}
		if (shape) {
			current.shape = shape;
		}
	};

	for (const raw of lines.slice(1)) {
		const line = raw.replace(/%%.*$/, '').trim();
		if (!line || /^(classDef|class|click|style|subgraph|end)\b/i.test(line)) {
			continue;
		}
		const edge = parseEdge(line);
		if (edge?.from && edge.to) {
			ensure(edge.from.id, edge.from.label, edge.from.shape);
			ensure(edge.to.id, edge.to.label, edge.to.shape);
			edges.push({ from: edge.from.id, to: edge.to.id, label: edge.label });
			continue;
		}
		const node = parseNodeToken(line);
		if (node) {
			ensure(node.id, node.label, node.shape);
		}
	}
	if (!nodes.size) {
		return undefined;
	}
	return layoutFlow(doc, nodes, edges, direction.startsWith('L') || direction === 'RL' ? 'LR' : 'TD');
}

function parseEdge(line: string): { from: ReturnType<typeof parseNodeToken>; to: ReturnType<typeof parseNodeToken>; label?: string } | undefined {
	const labeled = /^(.+?)\s*(?:-->|---)\s*\|\s*([^|]+)\s*\|\s*(.+)$/.exec(line)
		?? /^(.+?)\s*--\s+([^-]+?)\s+-->\s*(.+)$/.exec(line);
	if (labeled) {
		const from = parseNodeToken(labeled[1].trim());
		const to = parseNodeToken(labeled[3].trim());
		return from && to ? { from, to, label: labeled[2].trim() } : undefined;
	}
	const plain = /^(.+?)\s*(?:-->|---|-.->|==>)\s*(.+)$/.exec(line);
	if (!plain) {
		return undefined;
	}
	const from = parseNodeToken(plain[1].trim());
	const to = parseNodeToken(plain[2].trim());
	return from && to ? { from, to } : undefined;
}

function parseNodeToken(token: string): { id: string; label?: string; shape?: MermaidNode['shape'] } | undefined {
	const diamond = /^([A-Za-z][\w-]*)\{+([^{}]+)\}+$/.exec(token);
	if (diamond) {
		return { id: diamond[1], label: diamond[2].trim(), shape: 'diamond' };
	}
	const circle = /^([A-Za-z][\w-]*)\(\(+([^()]+)\)+\)$/.exec(token);
	if (circle) {
		return { id: circle[1], label: circle[2].trim(), shape: 'circle' };
	}
	const round = /^([A-Za-z][\w-]*)\(+([^()]+)\)+$/.exec(token);
	if (round) {
		return { id: round[1], label: round[2].trim(), shape: 'round' };
	}
	const rect = /^([A-Za-z][\w-]*)\[+([^[\]]+)\]+$/.exec(token);
	if (rect) {
		return { id: rect[1], label: rect[2].trim(), shape: 'rect' };
	}
	const id = NODE_ID.exec(token)?.[0];
	return id ? { id } : undefined;
}

function layoutFlow(doc: Document, nodes: Map<string, MermaidNode>, edges: readonly MermaidEdge[], axis: 'TD' | 'LR'): SVGSVGElement | undefined {
	const incoming = new Map<string, number>();
	for (const id of nodes.keys()) {
		incoming.set(id, 0);
	}
	for (const edge of edges) {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	}
	const rank = new Map<string, number>();
	const queue = [...nodes.keys()].filter(id => (incoming.get(id) ?? 0) === 0);
	if (!queue.length) {
		queue.push([...nodes.keys()][0]);
	}
	for (const id of queue) {
		rank.set(id, 0);
	}
	const adj = new Map<string, string[]>();
	for (const edge of edges) {
		const list = adj.get(edge.from) ?? [];
		list.push(edge.to);
		adj.set(edge.from, list);
	}
	const seen = new Set(queue);
	while (queue.length) {
		const id = queue.shift()!;
		for (const next of adj.get(id) ?? []) {
			rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	for (const id of nodes.keys()) {
		if (!rank.has(id)) {
			rank.set(id, 0);
		}
	}

	const byRank = new Map<number, MermaidNode[]>();
	for (const node of nodes.values()) {
		const r = rank.get(node.id) ?? 0;
		const list = byRank.get(r) ?? [];
		list.push(node);
		byRank.set(r, list);
	}
	const ranks = [...byRank.keys()].sort((a, b) => a - b);
	const measure = (node: MermaidNode) => Math.min(180, Math.max(72, node.label.length * 7.2 + 24));
	const nodeH = 34;
	const gap = 28;
	const rankGap = 56;
	const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
	let width = 0;
	let height = 0;
	for (const r of ranks) {
		const row = byRank.get(r) ?? [];
		const widths = row.map(measure);
		const rowWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, row.length - 1);
		let x = 0;
		for (const [index, node] of row.entries()) {
			const w = widths[index];
			const h = node.shape === 'diamond' ? 44 : nodeH;
			if (axis === 'TD') {
				positions.set(node.id, { x, y: r * (nodeH + rankGap), w, h });
			} else {
				positions.set(node.id, { x: r * (180 + rankGap), y: x, w, h });
			}
			x += w + gap;
		}
		if (axis === 'TD') {
			width = Math.max(width, rowWidth);
			height = Math.max(height, r * (nodeH + rankGap) + nodeH);
		} else {
			width = Math.max(width, r * (180 + rankGap) + 180);
			height = Math.max(height, rowWidth);
		}
	}
	if (axis === 'TD') {
		for (const r of ranks) {
			const row = byRank.get(r) ?? [];
			const rowWidth = row.reduce((sum, node) => sum + (positions.get(node.id)?.w ?? 0), 0) + gap * Math.max(0, row.length - 1);
			const shift = Math.max(0, (width - rowWidth) / 2);
			for (const node of row) {
				const pos = positions.get(node.id);
				if (pos) {
					pos.x += shift;
				}
			}
		}
	}

	const pad = 16;
	const markerId = `volt-mermaid-arrow-${Math.random().toString(36).slice(2, 8)}`;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${width + pad * 2} ${height + pad * 2}`);
	svg.setAttribute('width', String(Math.min(width + pad * 2, 560)));
	svg.setAttribute('role', 'img');
	const defs = svgEl(svg, 'defs');
	const marker = svgEl(svg, 'marker');
	marker.setAttribute('id', markerId);
	marker.setAttribute('viewBox', '0 0 10 10');
	marker.setAttribute('refX', '8');
	marker.setAttribute('refY', '5');
	marker.setAttribute('markerWidth', '8');
	marker.setAttribute('markerHeight', '8');
	marker.setAttribute('orient', 'auto-start-reverse');
	const head = svgEl(svg, 'path');
	head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
	head.setAttribute('fill', 'currentColor');
	marker.appendChild(head);
	defs.appendChild(marker);
	svg.appendChild(defs);

	const g = svgEl(svg, 'g');
	g.setAttribute('transform', `translate(${pad} ${pad})`);
	for (const edge of edges) {
		const from = positions.get(edge.from);
		const to = positions.get(edge.to);
		if (!from || !to) {
			continue;
		}
		const path = svgEl(svg, 'path');
		const x1 = from.x + from.w / 2;
		const y1 = axis === 'TD' ? from.y + from.h : from.y + from.h / 2;
		const x2 = axis === 'TD' ? to.x + to.w / 2 : to.x;
		const y2 = axis === 'TD' ? to.y : to.y + to.h / 2;
		path.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-opacity', '0.45');
		path.setAttribute('stroke-width', '1.25');
		path.setAttribute('marker-end', `url(#${markerId})`);
		g.appendChild(path);
		if (edge.label) {
			const label = svgEl(svg, 'text');
			label.setAttribute('x', String((x1 + x2) / 2));
			label.setAttribute('y', String((y1 + y2) / 2 - 4));
			label.setAttribute('text-anchor', 'middle');
			label.setAttribute('class', 'volt-agent-mermaid-label');
			label.textContent = edge.label;
			g.appendChild(label);
		}
	}
	for (const node of nodes.values()) {
		const pos = positions.get(node.id);
		if (!pos) {
			continue;
		}
		const shape = svgEl(svg, node.shape === 'circle' ? 'ellipse' : node.shape === 'diamond' ? 'polygon' : 'rect');
		if (node.shape === 'diamond') {
			const cx = pos.x + pos.w / 2;
			const cy = pos.y + pos.h / 2;
			shape.setAttribute('points', `${cx},${pos.y} ${pos.x + pos.w},${cy} ${cx},${pos.y + pos.h} ${pos.x},${cy}`);
		} else if (node.shape === 'circle') {
			shape.setAttribute('cx', String(pos.x + pos.w / 2));
			shape.setAttribute('cy', String(pos.y + pos.h / 2));
			shape.setAttribute('rx', String(pos.w / 2));
			shape.setAttribute('ry', String(pos.h / 2));
		} else {
			shape.setAttribute('x', String(pos.x));
			shape.setAttribute('y', String(pos.y));
			shape.setAttribute('width', String(pos.w));
			shape.setAttribute('height', String(pos.h));
			shape.setAttribute('rx', node.shape === 'round' ? String(pos.h / 2) : '6');
		}
		shape.setAttribute('fill', 'var(--vscode-editorWidget-background, transparent)');
		shape.setAttribute('stroke', 'currentColor');
		shape.setAttribute('stroke-opacity', '0.28');
		g.appendChild(shape);
		const label = svgEl(svg, 'text');
		label.setAttribute('x', String(pos.x + pos.w / 2));
		label.setAttribute('y', String(pos.y + pos.h / 2 + 4));
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('class', 'volt-agent-mermaid-node');
		label.textContent = node.label;
		g.appendChild(label);
	}
	svg.appendChild(g);
	return svg;
}

function renderPie(doc: Document, source: string): SVGSVGElement | undefined {
	const lines = stripMermaid(source);
	if (!/^pie\b/i.test(lines[0] ?? '')) {
		return undefined;
	}
	const slices: Array<{ label: string; value: number }> = [];
	let title = '';
	for (const raw of lines.slice(1)) {
		const titled = /^title\s+(.+)$/i.exec(raw);
		if (titled) {
			title = titled[1].trim();
			continue;
		}
		const slice = /^"([^"]+)"\s*:\s*([\d.]+)/.exec(raw) ?? /^([^:]+):\s*([\d.]+)/.exec(raw);
		if (slice) {
			slices.push({ label: slice[1].trim().replace(/^["']|["']$/g, ''), value: Number(slice[2]) });
		}
	}
	if (slices.length < 2) {
		return undefined;
	}
	const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
	const size = 168;
	const cx = 84;
	const cy = 84;
	const r = 62;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	const legend = slices.length * 22;
	svg.setAttribute('viewBox', `0 0 ${size + 180} ${Math.max(size, legend + 24)}`);
	svg.setAttribute('width', String(Math.min(size + 180, 420)));
	svg.setAttribute('role', 'img');
	if (title) {
		const label = svgEl(svg, 'text');
		label.setAttribute('x', '8');
		label.setAttribute('y', '16');
		label.setAttribute('class', 'volt-agent-mermaid-node');
		label.textContent = title;
		svg.appendChild(label);
	}
	let angle = -Math.PI / 2;
	const colors = ['var(--vscode-charts-blue, #58a6ff)', 'var(--vscode-charts-green, #3fb950)', 'var(--vscode-charts-orange, #d29922)', 'var(--vscode-charts-purple, #a371f7)', 'var(--vscode-charts-red, #f85149)'];
	slices.forEach((slice, index) => {
		const next = angle + (slice.value / total) * Math.PI * 2;
		const path = svgEl(svg, 'path');
		path.setAttribute('d', arcPath(cx, cy + (title ? 8 : 0), r, angle, next));
		path.setAttribute('fill', colors[index % colors.length]);
		path.setAttribute('fill-opacity', '0.85');
		svg.appendChild(path);
		const ly = 28 + index * 22;
		const swatch = svgEl(svg, 'rect');
		swatch.setAttribute('x', String(size + 8));
		swatch.setAttribute('y', String(ly - 10));
		swatch.setAttribute('width', '8');
		swatch.setAttribute('height', '8');
		swatch.setAttribute('rx', '2');
		swatch.setAttribute('fill', colors[index % colors.length]);
		svg.appendChild(swatch);
		const text = svgEl(svg, 'text');
		text.setAttribute('x', String(size + 22));
		text.setAttribute('y', String(ly - 2));
		text.setAttribute('class', 'volt-agent-mermaid-label');
		text.textContent = `${slice.label}  ${slice.value}`;
		svg.appendChild(text);
		angle = next;
	});
	return svg;
}

function renderSequence(doc: Document, source: string): SVGSVGElement | undefined {
	const lines = stripMermaid(source);
	if (!/^sequenceDiagram\b/i.test(lines[0] ?? '')) {
		return undefined;
	}
	const actors: string[] = [];
	const messages: Array<{ from: string; to: string; text: string }> = [];
	const addActor = (name: string) => {
		if (!actors.includes(name)) {
			actors.push(name);
		}
	};
	for (const raw of lines.slice(1)) {
		const participant = /^(?:participant|actor)\s+(\S+)/i.exec(raw);
		if (participant) {
			addActor(participant[1]);
			continue;
		}
		const msg = /^(\S+)\s*-{1,2}>>?\s*(\S+)\s*:\s*(.+)$/.exec(raw);
		if (msg) {
			addActor(msg[1]);
			addActor(msg[2]);
			messages.push({ from: msg[1], to: msg[2], text: msg[3].trim() });
		}
	}
	if (actors.length < 2 || !messages.length) {
		return undefined;
	}
	const col = 120;
	const width = Math.max(240, actors.length * col);
	const height = 48 + messages.length * 36;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('width', String(Math.min(width, 520)));
	svg.setAttribute('role', 'img');
	actors.forEach((actor, index) => {
		const x = 60 + index * col;
		const line = svgEl(svg, 'line');
		line.setAttribute('x1', String(x));
		line.setAttribute('x2', String(x));
		line.setAttribute('y1', '28');
		line.setAttribute('y2', String(height - 8));
		line.setAttribute('stroke', 'currentColor');
		line.setAttribute('stroke-opacity', '0.2');
		svg.appendChild(line);
		const label = svgEl(svg, 'text');
		label.setAttribute('x', String(x));
		label.setAttribute('y', '18');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('class', 'volt-agent-mermaid-node');
		label.textContent = actor;
		svg.appendChild(label);
	});
	messages.forEach((message, index) => {
		const y = 48 + index * 36;
		const x1 = 60 + actors.indexOf(message.from) * col;
		const x2 = 60 + actors.indexOf(message.to) * col;
		const path = svgEl(svg, 'line');
		path.setAttribute('x1', String(x1));
		path.setAttribute('y1', String(y));
		path.setAttribute('x2', String(x2));
		path.setAttribute('y2', String(y));
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-opacity', '0.55');
		svg.appendChild(path);
		const label = svgEl(svg, 'text');
		label.setAttribute('x', String((x1 + x2) / 2));
		label.setAttribute('y', String(y - 6));
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('class', 'volt-agent-mermaid-label');
		label.textContent = message.text;
		svg.appendChild(label);
	});
	return svg;
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
	const x1 = cx + r * Math.cos(start);
	const y1 = cy + r * Math.sin(start);
	const x2 = cx + r * Math.cos(end);
	const y2 = cy + r * Math.sin(end);
	const large = end - start > Math.PI ? 1 : 0;
	return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function stripMermaid(source: string): string[] {
	return source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
}

function svgEl(host: SVGElement, tag: string): SVGElement {
	return host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
}
