/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { mermaidToElements } from '../../common/scratchBoard/scratchDiagram.js';
import { createCard, createFrame, createIcon, createLabel, createNote, createShape, createText, SCRATCH_CARD_FONT_SIZE } from '../../common/scratchBoard/scratchFactory.js';
import { extractMermaidSource, parseMermaidFlowchart } from '../../common/scratchBoard/scratchMermaid.js';
import { Vec } from '../../common/scratchBoard/scratchMath.js';
import { SHAPE_DEFAULT_SIZE, SHAPE_KINDS } from '../../common/scratchBoard/scratchShapes.js';
import { IScratchStyleDefaults, ScratchElement, ScratchShapeKind } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { voltButtonClasses } from '../chrome/voltButton.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { iconSvgMarkup, scratchIcon, ScratchIconName } from './scratchIcons.js';
import { iconDataUrl } from './scratchRenderer.js';
import { SHAPE_ICONS, SHAPE_LABELS } from './scratchToolbar.js';

const ARIA_SEARCH = 'https://icons.leularia.com/api/v1/search';
const ARIA_ICONS = 'https://icons.leularia.com/api/v1/icons';
/** The icons endpoint answers at most this many ids per request. */
const ARIA_BATCH = 20;
const ICON_RESULTS = 60;
/** A search (and its icons) that takes longer than this is reported as unreachable. */
const SEARCH_TIMEOUT_MS = 8000;

export const TABLE_TEMPLATE_HTML = '<table><thead><tr><th>Column</th><th>Column</th><th>Column</th></tr></thead><tbody><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr></tbody></table>';
export const CHECKLIST_TEMPLATE_HTML = '<h3>To do</h3><ul><li data-checked="false">First thing</li><li data-checked="false">Second thing</li><li data-checked="false">Third thing</li></ul>';
/** A table straight on the board: text with no card behind it (a card's background boxed it in). */
export function createTableBlock(style: IScratchStyleDefaults): ScratchElement {
	return createText({ x: 0, y: 0, width: 480, height: 104, html: TABLE_TEMPLATE_HTML, autoSize: false, fontFamily: 'sans', fontSize: SCRATCH_CARD_FONT_SIZE }, style);
}

/** A checklist straight on the board, not on a sticky note. */
export function createChecklistBlock(style: IScratchStyleDefaults): ScratchElement {
	return createText({ x: 0, y: 0, width: 260, height: 124, html: CHECKLIST_TEMPLATE_HTML, autoSize: false, fontFamily: 'sans', fontSize: 17 }, style);
}

export const CODE_TEMPLATE_HTML = '<pre><code class="language-ts">function hello(name: string) {\n\treturn `Hello, ${name}`;\n}</code></pre>';

interface ILibraryItem {
	readonly id: string;
	readonly label: string;
	readonly keywords: string;
	readonly icon: ScratchIconName;
	readonly build: (style: IScratchStyleDefaults) => ScratchElement[];
}

interface ILibrarySection {
	readonly id: string;
	readonly title: string;
	readonly items: readonly ILibraryItem[];
}

function labelled(shape: ScratchShapeKind, text: string, w: number, h: number, style: IScratchStyleDefaults, extra: Partial<Parameters<typeof createShape>[0]> = {}): ScratchElement {
	return createShape({ x: 0, y: 0, width: w, height: h, shape, label: createLabel(`<p>${text}</p>`, style), ...extra }, style);
}

function iconItem(icon: ScratchIconName, text: string, style: IScratchStyleDefaults): ScratchElement {
	// The Aria Icons id: `tabler-load-balancer` is tabler:load-balancer, the rest are Lucide.
	const iconId = icon.startsWith('tabler-') ? `tabler:${icon.slice('tabler-'.length)}` : `lucide:${icon}`;
	return createIcon({ x: 0, y: 0, width: 56, height: 56, iconId, svg: iconSvgMarkup(icon), tintable: true, label: createLabel(`<p>${text}</p>`, style, { fontSize: 16 }) }, style);
}

function sections(): ILibrarySection[] {
	const basics: ILibraryItem[] = [
		{ id: 'note', label: localize('voltScratch.lib.note', "Sticky note"), keywords: 'sticky post-it', icon: 'sticky-note', build: s => [createNote({ x: 0, y: 0 }, s)] },
		{ id: 'card', label: localize('voltScratch.lib.card', "Markdown card"), keywords: 'doc page document text', icon: 'file-text', build: s => [createCard({ x: 0, y: 0, html: '<h2>Title</h2><p>Write anything. Paste markdown and it renders.</p>' }, s)] },
		{ id: 'table', label: localize('voltScratch.lib.table', "Table"), keywords: 'grid rows columns', icon: 'table', build: s => [createTableBlock(s)] },
		{ id: 'checklist', label: localize('voltScratch.lib.checklist', "Checklist"), keywords: 'todo tasks', icon: 'list-checks', build: s => [createChecklistBlock(s)] },
		{ id: 'code', label: localize('voltScratch.lib.code', "Code block"), keywords: 'snippet source', icon: 'code-xml', build: s => [createCard({ x: 0, y: 0, width: 520, html: CODE_TEMPLATE_HTML }, s)] },
		{ id: 'frame', label: localize('voltScratch.lib.frame', "Frame"), keywords: 'section area group', icon: 'frame', build: s => [createFrame({ x: 0, y: 0, width: 520, height: 340 }, s)] },
	];
	const shapes: ILibraryItem[] = SHAPE_KINDS.map(kind => ({
		id: `shape-${kind}`,
		label: SHAPE_LABELS[kind],
		keywords: `shape ${kind}`,
		icon: SHAPE_ICONS[kind],
		build: s => [createShape({ x: 0, y: 0, width: SHAPE_DEFAULT_SIZE[kind][0], height: SHAPE_DEFAULT_SIZE[kind][1], shape: kind }, s)],
	}));
	// Each block has its own glyph, so a board reads at a glance (Tabler's infrastructure set, via Aria Icons).
	const system: ILibraryItem[] = [
		// First: the area the other blocks go in.
		{ id: 'boundary', label: localize('voltScratch.lib.boundary', "Boundary"), keywords: 'vpc region zone swimlane container group', icon: 'square-dashed', build: s => [createFrame({ x: 0, y: 0, width: 560, height: 360, name: 'Boundary' }, s)] },
		{ id: 'client', label: localize('voltScratch.lib.client', "Client"), keywords: 'browser web frontend desktop', icon: 'tabler-device-desktop', build: s => [iconItem('tabler-device-desktop', 'Client', s)] },
		{ id: 'mobile', label: localize('voltScratch.lib.mobile', "Mobile app"), keywords: 'phone ios android', icon: 'tabler-device-mobile', build: s => [iconItem('tabler-device-mobile', 'Mobile app', s)] },
		{ id: 'user', label: localize('voltScratch.lib.user', "User"), keywords: 'person actor', icon: 'tabler-user', build: s => [iconItem('tabler-user', 'User', s)] },
		{ id: 'gateway', label: localize('voltScratch.lib.gateway', "API gateway"), keywords: 'api edge proxy', icon: 'tabler-api', build: s => [labelled('hexagon', 'API gateway', 180, 90, s)] },
		{ id: 'service', label: localize('voltScratch.lib.service', "Service"), keywords: 'microservice server backend', icon: 'tabler-server-2', build: s => [labelled('rectangle', 'Service', 170, 84, s, { roundness: 'round' })] },
		{ id: 'database', label: localize('voltScratch.lib.database', "Database"), keywords: 'db sql postgres storage', icon: 'tabler-database', build: s => [labelled('cylinder', 'Database', 120, 130, s)] },
		{ id: 'cache', label: localize('voltScratch.lib.cache', "Cache"), keywords: 'redis memcached memory', icon: 'tabler-server-bolt', build: s => [labelled('cylinder', 'Cache', 110, 110, s, { fill: '#ffc9c9', fillStyle: 'solid' })] },
		{ id: 'queue', label: localize('voltScratch.lib.queue', "Queue"), keywords: 'kafka rabbit sqs stream message bus topic', icon: 'tabler-stack-push', build: s => [iconItem('tabler-stack-push', 'Queue', s)] },
		{ id: 'storage', label: localize('voltScratch.lib.storage', "Object storage"), keywords: 's3 bucket blob files', icon: 'tabler-bucket', build: s => [iconItem('tabler-bucket', 'Object storage', s)] },
		{ id: 'function', label: localize('voltScratch.lib.function', "Function"), keywords: 'lambda serverless', icon: 'tabler-lambda', build: s => [iconItem('tabler-lambda', 'Function', s)] },
		{ id: 'lb', label: localize('voltScratch.lib.lb', "Load balancer"), keywords: 'lb balancer ingress', icon: 'tabler-load-balancer', build: s => [iconItem('tabler-load-balancer', 'Load balancer', s)] },
		{ id: 'container', label: localize('voltScratch.lib.container', "Container"), keywords: 'docker pod kubernetes', icon: 'tabler-box', build: s => [iconItem('tabler-box', 'Container', s)] },
		{ id: 'cloud', label: localize('voltScratch.lib.cloud', "Cloud"), keywords: 'internet provider', icon: 'tabler-cloud', build: s => [labelled('cloud', 'Cloud', 200, 120, s)] },
		{ id: 'auth', label: localize('voltScratch.lib.auth', "Auth"), keywords: 'security identity login', icon: 'tabler-shield-lock', build: s => [iconItem('tabler-shield-lock', 'Auth', s)] },
		{ id: 'external', label: localize('voltScratch.lib.external', "External API"), keywords: 'third party integration web', icon: 'tabler-plug-connected', build: s => [iconItem('tabler-plug-connected', 'External API', s)] },
		{ id: 'notify', label: localize('voltScratch.lib.notify', "Notifications"), keywords: 'push alert', icon: 'tabler-bell-ringing', build: s => [iconItem('tabler-bell-ringing', 'Notifications', s)] },
		{ id: 'worker', label: localize('voltScratch.lib.worker', "Worker"), keywords: 'job background cron', icon: 'tabler-settings-automation', build: s => [iconItem('tabler-settings-automation', 'Worker', s)] },
	];
	const flow: ILibraryItem[] = [
		{ id: 'flow-start', label: localize('voltScratch.lib.start', "Start / end"), keywords: 'terminator flowchart', icon: 'shape-pill', build: s => [labelled('pill', 'Start', 160, 64, s)] },
		{ id: 'flow-process', label: localize('voltScratch.lib.process', "Process"), keywords: 'step action flowchart', icon: 'square', build: s => [labelled('rectangle', 'Process', 170, 84, s, { roundness: 'sharp' })] },
		{ id: 'flow-decision', label: localize('voltScratch.lib.decision', "Decision"), keywords: 'if branch condition flowchart', icon: 'diamond', build: s => [labelled('diamond', 'Decision?', 170, 120, s)] },
		{ id: 'flow-io', label: localize('voltScratch.lib.io', "Input / output"), keywords: 'data flowchart', icon: 'shape-parallelogram', build: s => [labelled('parallelogram', 'Input', 180, 84, s)] },
		{ id: 'flow-doc', label: localize('voltScratch.lib.document', "Document"), keywords: 'report file flowchart', icon: 'shape-document', build: s => [labelled('document', 'Document', 160, 100, s)] },
		{ id: 'flow-data', label: localize('voltScratch.lib.data', "Data store"), keywords: 'database flowchart', icon: 'cylinder', build: s => [labelled('cylinder', 'Data', 110, 120, s)] },
	];
	return [
		{ id: 'basics', title: localize('voltScratch.lib.basics', "Basics"), items: basics },
		{ id: 'shapes', title: localize('voltScratch.lib.shapes', "Shapes"), items: shapes },
		{ id: 'system', title: localize('voltScratch.lib.system', "System design"), items: system },
		{ id: 'flow', title: localize('voltScratch.lib.flow', "Flowchart"), items: flow },
	];
}

interface IAriaIcon {
	readonly id: string;
	readonly name: string;
	readonly svg?: string;
}

/**
 * The library drawer: building blocks to drag or click onto the board, and a search across
 * Aria Icons (icons.leularia.com: Lucide, Tabler, brand logos, cloud and Kubernetes sets...).
 */
export class ScratchLibrary extends Disposable {

	static readonly DRAG_MIME = 'application/x-volt-scratch-library';

	private readonly element: HTMLElement;
	private readonly search: HTMLInputElement;
	private readonly body: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly sections = sections();
	private readonly icons = new Map<string, IAriaIcon>();
	/** The icon search in flight; a newer query (or closing the board) aborts it. */
	private searchAbort: AbortController | undefined;
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private query = '';
	private iconResults: IAriaIcon[] = [];
	private iconState: 'idle' | 'loading' | 'error' | 'done' = 'idle';
	private open = false;
	private readonly _onDidChangeOpen = this._register(new Emitter<void>());
	/** Opened or closed, from any of its ways (its X, Escape, the toolbar). */
	readonly onDidChangeOpen: Event<void> = this._onDidChangeOpen.event;

	constructor(parent: HTMLElement, private readonly canvas: ScratchCanvas) {
		super();
		const doc = parent.ownerDocument;
		this.element = append(parent, $('.sx-library.sx-panel.sx-chrome-item'));
		this.element.setAttribute('role', 'complementary');
		this.element.setAttribute('aria-label', localize('voltScratch.library', "Library"));
		const header = append(this.element, $('.sx-library-header'));
		append(header, $('.sx-library-title')).textContent = localize('voltScratch.library', "Library");
		const close = append(header, $('button.sx-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltScratch.close', "Close"));
		close.appendChild(scratchIcon(doc, 'x', { size: 14 }));
		this._register(addDisposableListener(close, 'click', () => this.close()));
		const searchBox = append(this.element, $('.sx-library-search'));
		searchBox.appendChild(scratchIcon(doc, 'search', { size: 14 }));
		this.search = append(searchBox, $('input')) as HTMLInputElement;
		this.search.type = 'search';
		this.search.placeholder = localize('voltScratch.librarySearch', "Search shapes and 1M+ icons");
		this.search.setAttribute('aria-label', localize('voltScratch.librarySearchAria', "Search the library"));
		this._register(addDisposableListener(this.search, 'input', () => this.onQuery()));
		this._register(addDisposableListener(this.search, 'keydown', e => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				if (this.search.value) {
					this.search.value = '';
					this.onQuery();
				} else {
					this.close();
				}
			}
		}));
		this.body = append(this.element, $('.sx-library-body'));
		this._register(addDisposableListener(this.element, 'wheel', e => e.stopPropagation()));
		this._register(addDisposableListener(this.element, 'pointerdown', e => e.stopPropagation()));
		this._register(toDisposable(() => {
			if (this.searchTimer) {
				clearTimeout(this.searchTimer);
			}
			this.searchAbort?.abort();
		}));
	}

	get isOpen(): boolean {
		return this.open;
	}

	toggle(): void {
		if (this.open) {
			this.close();
		} else {
			this.show();
		}
	}

	show(): void {
		this.open = true;
		this.element.classList.add('visible');
		this.render();
		this.search.focus();
		this._onDidChangeOpen.fire();
	}

	close(): void {
		if (!this.open) {
			return;
		}
		this.open = false;
		this.element.classList.remove('visible');
		this.canvas.focus();
		this._onDidChangeOpen.fire();
	}

	private onQuery(): void {
		this.query = this.search.value.trim();
		if (this.searchTimer) {
			clearTimeout(this.searchTimer);
		}
		if (this.query.length >= 2) {
			this.iconState = 'loading';
			this.searchTimer = setTimeout(() => void this.searchIcons(this.query), 220);
		} else {
			this.iconResults = [];
			this.iconState = 'idle';
		}
		this.render();
	}

	private async searchIcons(query: string): Promise<void> {
		this.searchAbort?.abort();
		const abort = new AbortController();
		this.searchAbort = abort;
		const timer = setTimeout(() => abort.abort(), SEARCH_TIMEOUT_MS);
		const current = () => this.searchAbort === abort && query === this.query;
		try {
			const url = `${ARIA_SEARCH}?${new URLSearchParams({ q: query, limit: String(ICON_RESULTS) })}`;
			const response = await fetch(url, { headers: { accept: 'application/json' }, signal: abort.signal });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json() as { icons?: { id: string; name: string }[] };
			if (!current()) {
				return;
			}
			const found = (data.icons ?? []).filter(i => typeof i.id === 'string').map(i => ({ id: i.id, name: i.name ?? i.id }));
			this.iconResults = found.map(i => this.icons.get(i.id) ?? i);
			this.iconState = 'done';
			this.render();
			await this.loadSvgs(this.iconResults.filter(i => !i.svg).map(i => i.id), abort.signal);
		} catch {
			// Timed out or failed; a search replaced by a newer one says nothing.
			if (current()) {
				this.iconState = 'error';
				this.render();
			}
		} finally {
			clearTimeout(timer);
		}
	}

	private async loadSvgs(ids: readonly string[], signal: AbortSignal): Promise<void> {
		const batches: string[][] = [];
		for (let i = 0; i < ids.length; i += ARIA_BATCH) {
			batches.push(ids.slice(i, i + ARIA_BATCH));
		}
		await Promise.all(batches.map(async batch => {
			try {
				const response = await fetch(`${ARIA_ICONS}?${new URLSearchParams({ ids: batch.join(',') })}`, { headers: { accept: 'application/json' }, signal });
				const data = await response.json() as { icons?: { id: string; name?: string; svg?: string }[] };
				for (const icon of data.icons ?? []) {
					if (typeof icon.svg === 'string' && /^\s*<svg[\s>]/i.test(icon.svg) && icon.svg.length < 200_000) {
						this.icons.set(icon.id, { id: icon.id, name: icon.name ?? icon.id, svg: icon.svg });
					}
				}
			} catch {
				// Those tiles stay as placeholders.
			}
		}));
		if (signal.aborted) {
			return;
		}
		this.iconResults = this.iconResults.map(i => this.icons.get(i.id) ?? i);
		this.render();
	}

	private render(): void {
		if (!this.open) {
			return;
		}
		const scroll = this.body.scrollTop;
		this.renderStore.clear();
		this.body.replaceChildren();
		const q = this.query.toLowerCase();
		const doc = this.body.ownerDocument;
		for (const section of this.sections) {
			const items = q ? section.items.filter(item => `${item.label} ${item.keywords}`.toLowerCase().includes(q)) : section.items;
			if (!items.length) {
				continue;
			}
			append(this.body, $('.sx-library-section')).textContent = section.title;
			const grid = append(this.body, $('.sx-library-grid'));
			for (const item of items) {
				const tile = append(grid, $('button.sx-library-tile')) as HTMLButtonElement;
				tile.type = 'button';
				tile.draggable = true;
				tile.appendChild(scratchIcon(doc, item.icon, { size: 22, strokeWidth: 1.5 }));
				append(tile, $('span')).textContent = item.label;
				tile.setAttribute('aria-label', item.label);
				this.renderStore.add(addDisposableListener(tile, 'click', () => this.insert(item.id)));
				this.renderStore.add(addDisposableListener(tile, 'dragstart', e => {
					e.dataTransfer?.setData(ScratchLibrary.DRAG_MIME, item.id);
					if (e.dataTransfer) {
						e.dataTransfer.effectAllowed = 'copy';
					}
				}));
			}
		}
		if (q.length >= 2) {
			append(this.body, $('.sx-library-section')).textContent = localize('voltScratch.lib.icons', "Icons");
			if (this.iconState === 'loading' && !this.iconResults.length) {
				append(this.body, $('.sx-library-empty')).textContent = localize('voltScratch.lib.searching', "Searching Aria Icons…");
			} else if (this.iconState === 'error') {
				append(this.body, $('.sx-library-empty')).textContent = localize('voltScratch.lib.offline', "Aria Icons could not be reached. Check your connection.");
			} else if (!this.iconResults.length) {
				append(this.body, $('.sx-library-empty')).textContent = localize('voltScratch.lib.noIcons', "No icons match.");
			} else {
				const grid = append(this.body, $('.sx-library-icons'));
				for (const icon of this.iconResults) {
					const tile = append(grid, $('button.sx-library-icon')) as HTMLButtonElement;
					tile.type = 'button';
					tile.setAttribute('aria-label', icon.name);
					setAgentTooltip(tile, icon.name, icon.id.split(':')[0], undefined, 'above');
					if (icon.svg) {
						const img = append(tile, $('img')) as HTMLImageElement;
						img.alt = '';
						img.draggable = false;
						img.src = iconDataUrl(icon.svg, /currentColor/.test(icon.svg) ? (this.canvas.isDarkBoard ? '#e9ecef' : '#1e1e1e') : undefined);
						tile.draggable = true;
						this.renderStore.add(addDisposableListener(tile, 'dragstart', e => {
							e.dataTransfer?.setData(ScratchLibrary.DRAG_MIME, `icon:${icon.id}`);
						}));
					} else {
						tile.classList.add('loading');
					}
					this.renderStore.add(addDisposableListener(tile, 'click', () => this.insert(`icon:${icon.id}`)));
				}
			}
		} else if (!q) {
			const hint = append(this.body, $('.sx-library-hint'));
			hint.textContent = localize('voltScratch.lib.hint', "Type to search icons: try \"postgres\", \"kubernetes\", \"aws lambda\".");
		}
		append(this.body, $('.sx-library-footer')).textContent = localize('voltScratch.lib.credit', "Icons from Aria Icons · icons.leularia.com");
		this.body.scrollTop = scroll;
	}

	private build(id: string): ScratchElement[] | undefined {
		if (id.startsWith('icon:')) {
			const icon = this.icons.get(id.slice(5));
			if (!icon?.svg) {
				return undefined;
			}
			const name = icon.name.replace(/[-_]+/g, ' ');
			return [createIcon({ x: 0, y: 0, width: 64, height: 64, iconId: icon.id, svg: icon.svg, tintable: /currentColor/.test(icon.svg), label: createLabel(`<p>${escapeHtml(name)}</p>`, this.canvas.state.style, { fontSize: 16 }) }, this.canvas.state.style)];
		}
		for (const section of this.sections) {
			const item = section.items.find(i => i.id === id);
			if (item) {
				return item.build(this.canvas.state.style);
			}
		}
		return undefined;
	}

	private insert(id: string): void {
		const elements = this.build(id);
		if (elements) {
			this.canvas.insertElements(elements, undefined, localize('voltScratch.insertFromLibrary', "Insert from library"));
		}
	}

	dropAt(id: string, world: Vec): void {
		const elements = this.build(id);
		if (elements) {
			this.canvas.insertElements(elements, world, localize('voltScratch.insertFromLibrary', "Insert from library"));
		}
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A small dialog to paste Mermaid flowchart source; it becomes shapes and connectors. */
export async function promptMermaid(canvas: ScratchCanvas): Promise<void> {
	const doc = canvas.element.ownerDocument;
	const backdrop = append(canvas.element, $('.sx-modal-backdrop.sx-chrome-item'));
	const dialog = append(backdrop, $('.sx-modal.sx-panel'));
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-label', localize('voltScratch.mermaidTitle', "Diagram from Mermaid"));
	append(dialog, $('.sx-modal-title')).textContent = localize('voltScratch.mermaidTitle', "Diagram from Mermaid");
	append(dialog, $('.sx-modal-text')).textContent = localize('voltScratch.mermaidText', "Paste a flowchart. Nodes become shapes and edges become connectors you can keep editing.");
	const area = append(dialog, $('textarea.sx-modal-input')) as HTMLTextAreaElement;
	area.spellcheck = false;
	area.value = 'flowchart LR\n  A[Client] --> B{Auth?}\n  B -->|yes| C[API]\n  B -->|no| D[Login]\n  C --> E[(Database)]';
	const error = append(dialog, $('.sx-modal-error'));
	const actions = append(dialog, $('.sx-modal-actions'));
	const cancel = append(actions, $('button')) as HTMLButtonElement;
	cancel.type = 'button';
	cancel.classList.add(...voltButtonClasses('secondary'));
	cancel.textContent = localize('voltScratch.cancel', "Cancel");
	const ok = append(actions, $('button')) as HTMLButtonElement;
	ok.type = 'button';
	ok.classList.add(...voltButtonClasses('primary'));
	ok.textContent = localize('voltScratch.insertDiagram', "Insert Diagram");
	const store = new DisposableStore();
	const done = () => {
		store.dispose();
		backdrop.remove();
		canvas.focus();
	};
	const submit = () => {
		const source = extractMermaidSource(area.value) ?? area.value;
		const graph = parseMermaidFlowchart(source);
		if (!graph || !graph.nodes.length) {
			error.textContent = localize('voltScratch.mermaidError', "That does not read as a Mermaid flowchart (it should start with \"flowchart\" or \"graph\").");
			return;
		}
		done();
		canvas.insertElements(mermaidToElements(graph, [0, 0], canvas.state.style), undefined, localize('voltScratch.insertDiagram', "Insert Diagram"));
	};
	store.add(addDisposableListener(cancel, 'click', done));
	store.add(addDisposableListener(ok, 'click', submit));
	store.add(addDisposableListener(backdrop, 'pointerdown', e => {
		if (e.target === backdrop) {
			done();
		}
		e.stopPropagation();
	}));
	store.add(addDisposableListener(dialog, 'keydown', e => {
		e.stopPropagation();
		if (e.key === 'Escape') {
			done();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			submit();
		}
	}));
	getWindow(doc.body).requestAnimationFrame(() => {
		area.focus();
		area.select();
	});
}
