/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { darkModeColor } from '../../common/scratchBoard/scratchColor.js';
import { freehandDrawing, IScratchPathSpec, linearCenterline, linearDrawing, shapeDrawing } from '../../common/scratchBoard/scratchDrawing.js';
import { elementBounds, elementBox } from '../../common/scratchBoard/scratchGeometry.js';
import { boundsIntersect, pointAlongPolyline, svgNum } from '../../common/scratchBoard/scratchMath.js';
import { IScratchSceneChange, ScratchScene } from '../../common/scratchBoard/scratchScene.js';
import { IScratchBounds, IScratchLabel, IScratchLinearElement, isRichText, ScratchElement, ScratchFontFamily, ScratchRichTextElement } from '../../common/scratchBoard/scratchTypes.js';
import { highlightCodeBlocks, setRichHtml } from './scratchRichText.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const NOTE_PADDING = 18;
export const CARD_PADDING_X = 22;
export const CARD_PADDING_Y = 18;
export const LABEL_PADDING = 10;

export function fontStack(family: ScratchFontFamily): string {
	switch (family) {
		case 'hand': return '"Excalifont", "Virgil", "Segoe Print", "Bradley Hand", cursive';
		case 'serif': return '"New York", ui-serif, Georgia, "Times New Roman", serif';
		case 'mono': return 'var(--monaco-monospace-font, "Geist Mono", ui-monospace, Menlo, monospace)';
		default: return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	}
}

/** Line height per family; the hand font draws tall. */
export function lineHeightFor(family: ScratchFontFamily): number {
	return family === 'hand' ? 1.25 : family === 'mono' ? 1.4 : 1.35;
}

export interface IScratchRenderHost {
	readonly languageService: ILanguageService;
	assetUrl(assetId: string, mime: string): Promise<string | undefined>;
	/** Rich text measured a different size than the element says (fonts loaded, wrapped, edited). */
	onDidMeasure(id: string, width: number, height: number): void;
	/** The colour the board paints behind a connector's label. */
	labelBackground(): string;
}

interface IView {
	element: ScratchElement;
	readonly node: HTMLElement;
	renderedVersion: number;
	renderedDark: boolean;
	culled: boolean;
	/** Content changed while culled; render when it comes back. */
	stale: boolean;
	richHost?: HTMLElement;
	labelHost?: HTMLElement;
	imageUrl?: string;
}

/**
 * Paints the scene as one absolutely positioned node per element inside the camera's world
 * layer. SVG for strokes and shapes, HTML for text, so rich text, tables and code stay real
 * text. Only what changed is touched; off-screen nodes are hidden and updated when they return.
 */
export class ScratchRenderer extends Disposable {

	private readonly views = new Map<string, IView>();
	private dark = false;
	private viewport: IScratchBounds | undefined;
	private measureQueued = false;
	private readonly toMeasure = new Set<string>();
	private editingId: string | undefined;
	private hiddenIds = new Set<string>();

	constructor(private readonly world: HTMLElement, private readonly scene: ScratchScene, private readonly host: IScratchRenderHost) {
		super();
		const fonts = (world.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
		if (fonts) {
			// Text measured with a fallback font is the wrong size once the real one arrives.
			const remeasure = () => {
				for (const view of this.views.values()) {
					if (isRichText(view.element) || view.labelHost) {
						this.toMeasure.add(view.element.id);
					}
				}
				this.scheduleMeasure();
			};
			fonts.addEventListener('loadingdone', remeasure);
			this._register(toDisposable(() => fonts.removeEventListener('loadingdone', remeasure)));
			void fonts.ready.then(() => !this._store.isDisposed && remeasure());
		}
		this._register(toDisposable(() => {
			for (const view of this.views.values()) {
				view.node.remove();
			}
			this.views.clear();
		}));
	}

	mapColor = (color: string): string => {
		return this.dark ? darkModeColor(color) : color;
	};

	setDark(dark: boolean): void {
		if (this.dark === dark) {
			return;
		}
		this.dark = dark;
		for (const view of this.views.values()) {
			this.paint(view, true);
		}
	}

	get isDark(): boolean {
		return this.dark;
	}

	nodeFor(id: string): HTMLElement | undefined {
		return this.views.get(id)?.node;
	}

	/**
	 * The size of a frame's name tab in world units (it sits inside the world layer, so its layout
	 * box is unscaled). The tab grows when zoomed out to stay readable, so its hit area follows it.
	 */
	frameTitleSize(id: string): { readonly width: number; readonly height: number } | undefined {
		const view = this.views.get(id);
		if (!view || view.culled || view.element.type !== 'frame') {
			return undefined;
		}
		const tab = view.node.querySelector(':scope > .sx-frame-name') as HTMLElement | null;
		if (!tab || !tab.textContent) {
			return undefined;
		}
		return { width: tab.offsetWidth, height: tab.offsetHeight };
	}

	richHostFor(id: string): HTMLElement | undefined {
		return this.views.get(id)?.richHost;
	}

	labelHostFor(id: string): HTMLElement | undefined {
		return this.views.get(id)?.labelHost;
	}

	/** Everything, after a board loads. */
	renderAll(): void {
		const live = new Set<string>();
		for (const el of this.scene.getElements()) {
			live.add(el.id);
		}
		for (const [id, view] of this.views) {
			if (!live.has(id)) {
				view.node.remove();
				this.views.delete(id);
			}
		}
		for (const el of this.scene.getElements()) {
			this.upsert(el);
		}
		this.syncOrder();
	}

	sync(change: IScratchSceneChange): void {
		for (const id of change.removed) {
			const view = this.views.get(id);
			if (view) {
				view.node.remove();
				this.views.delete(id);
			}
		}
		for (const id of change.updated) {
			const el = this.scene.get(id);
			if (el) {
				this.upsert(el);
			}
		}
		if (change.order) {
			this.syncOrder();
		}
	}

	/** The element whose text is being edited paints from the editor, not from the scene. */
	setEditing(id: string | undefined): void {
		const previous = this.editingId;
		this.editingId = id;
		if (previous && previous !== id) {
			const view = this.views.get(previous);
			if (view) {
				view.node.classList.remove('sx-editing');
				// The editor rewrote the text's DOM (code lost its colours): paint it again from the scene.
				delete view.richHost?.dataset.html;
				const label = view.labelHost?.firstElementChild as HTMLElement | null | undefined;
				if (label) {
					delete label.dataset.html;
				}
				this.paint(view, true);
			}
		}
		if (id) {
			this.views.get(id)?.node.classList.add('sx-editing');
		}
	}

	/** Hidden while something else stands in for them (the eraser's preview, a drag ghost). */
	setHidden(ids: ReadonlySet<string>): void {
		for (const id of this.hiddenIds) {
			if (!ids.has(id)) {
				this.views.get(id)?.node.classList.remove('sx-hidden');
			}
		}
		for (const id of ids) {
			this.views.get(id)?.node.classList.add('sx-hidden');
		}
		this.hiddenIds = new Set(ids);
	}

	setClass(id: string, className: string, on: boolean): void {
		this.views.get(id)?.node.classList.toggle(className, on);
	}

	/** Shows only elements near the viewport. `undefined` shows everything (export, measuring). */
	setViewport(bounds: IScratchBounds | undefined): void {
		this.viewport = bounds;
		for (const view of this.views.values()) {
			this.applyCulling(view);
		}
	}

	private applyCulling(view: IView): void {
		const culled = !!this.viewport && view.element.id !== this.editingId && !boundsIntersect(elementBounds(view.element), this.viewport);
		if (culled === view.culled) {
			return;
		}
		view.culled = culled;
		view.node.style.display = culled ? 'none' : '';
		if (!culled && view.stale) {
			this.paint(view, true);
		}
	}

	private upsert(el: ScratchElement): void {
		let view = this.views.get(el.id);
		if (!view) {
			const node = this.world.ownerDocument.createElement('div');
			node.className = `sx-el sx-${el.type}`;
			node.dataset.id = el.id;
			view = { element: el, node, renderedVersion: -1, renderedDark: this.dark, culled: false, stale: false };
			this.views.set(el.id, view);
			this.world.appendChild(node);
		}
		view.element = el;
		this.applyCulling(view);
		this.paint(view, false);
	}

	private syncOrder(): void {
		let previous: Node | null = null;
		for (const el of this.scene.getElements()) {
			const view = this.views.get(el.id);
			if (!view) {
				continue;
			}
			const expected: ChildNode | null = previous ? previous.nextSibling : this.firstElementNode();
			if (view.node !== expected) {
				this.world.insertBefore(view.node, expected);
			}
			previous = view.node;
		}
	}

	/** World children that are not element nodes (run outlines) stay first. */
	private firstElementNode(): ChildNode | null {
		let node = this.world.firstChild;
		while (node && !(isHTMLElement(node) && node.classList.contains('sx-el'))) {
			node = node.nextSibling;
		}
		return node;
	}

	private paint(view: IView, force: boolean): void {
		const el = view.element;
		const node = view.node;
		const box = elementBox(el);
		// Position and rotation are cheap and always applied (drags move many elements per frame).
		node.style.transform = `translate(${svgNum(box.x)}px, ${svgNum(box.y)}px)${el.angle ? ` rotate(${el.angle}rad)` : ''}`;
		node.style.width = `${Math.max(1, box.width)}px`;
		node.style.height = `${Math.max(1, box.height)}px`;
		node.style.opacity = el.opacity >= 100 ? '' : String(el.opacity / 100);
		node.classList.toggle('sx-locked', el.locked);
		if (!force && view.renderedVersion === el.version && view.renderedDark === this.dark) {
			return;
		}
		if (view.culled) {
			view.stale = true;
			return;
		}
		if (el.id === this.editingId && (isRichText(el) || hasLabelText(el))) {
			// The editor owns the text; only the frame around it follows the scene.
			this.paintChrome(view);
			view.renderedVersion = el.version;
			view.renderedDark = this.dark;
			return;
		}
		view.stale = false;
		view.renderedVersion = el.version;
		view.renderedDark = this.dark;
		switch (el.type) {
			case 'shape': this.paintSvg(view, shapeDrawing(el, this.mapColor), box.width, box.height, 0, 0); this.paintLabel(view, el.label, el.stroke, 'inside'); break;
			case 'line':
			case 'arrow': this.paintLinear(view, el); break;
			case 'draw': this.paintSvg(view, freehandDrawing(el, this.mapColor), box.width, box.height, box.x - el.x, box.y - el.y); break;
			case 'text':
			case 'note':
			case 'card': this.paintRich(view, el); break;
			case 'image': this.paintImage(view, el.assetId, el.mime, el.strokeWidth, el.stroke, el.roundness === 'round'); break;
			case 'icon': this.paintIcon(view, el.svg, el.tintable, el.stroke); this.paintLabel(view, el.label, el.stroke, 'below'); break;
			case 'frame': this.paintFrame(view, el.name, el.stroke, el.fill); break;
		}
		this.paintLink(view);
	}

	private paintChrome(view: IView): void {
		const el = view.element;
		if (el.type === 'note') {
			view.node.style.setProperty('--sx-note', this.mapColor(el.fill));
		} else if (el.type === 'card') {
			view.node.style.setProperty('--sx-card', this.mapColor(el.fill === 'transparent' ? '#ffffff' : el.fill));
			view.node.style.setProperty('--sx-card-border', this.mapColor(el.stroke));
		}
	}

	private svg(view: IView): SVGSVGElement {
		let svg = view.node.querySelector(':scope > svg.sx-svg') as SVGSVGElement | null;
		if (!svg) {
			svg = this.world.ownerDocument.createElementNS(SVG_NS, 'svg');
			svg.classList.add('sx-svg');
			svg.setAttribute('aria-hidden', 'true');
			view.node.prepend(svg);
		}
		return svg;
	}

	private paintSvg(view: IView, specs: readonly IScratchPathSpec[], width: number, height: number, originX: number, originY: number): void {
		const svg = this.svg(view);
		const w = Math.max(1, width), h = Math.max(1, height);
		svg.setAttribute('width', svgNum(w));
		svg.setAttribute('height', svgNum(h));
		svg.setAttribute('viewBox', `${svgNum(originX)} ${svgNum(originY)} ${svgNum(w)} ${svgNum(h)}`);
		appendPaths(svg, specs);
	}

	private paintLinear(view: IView, el: IScratchLinearElement): void {
		const box = elementBox(el);
		this.paintSvg(view, linearDrawing(el, this.mapColor), box.width, box.height, box.x - el.x, box.y - el.y);
		if (el.label && el.label.html) {
			const line = linearCenterline(el);
			const mid = pointAlongPolyline(line, 0.5).point;
			const host = this.ensureLabel(view, 'along');
			// Centred on the middle of the connector; local coordinates are relative to x, y.
			host.style.left = `${svgNum(el.x + mid[0] - box.x)}px`;
			host.style.top = `${svgNum(el.y + mid[1] - box.y)}px`;
			host.style.setProperty('--sx-label-bg', this.host.labelBackground());
			this.fillLabel(host, el.label, el.stroke);
		} else {
			this.removeLabel(view);
		}
	}

	private ensureLabel(view: IView, placement: 'inside' | 'below' | 'along'): HTMLElement {
		let host = view.labelHost;
		if (!host) {
			host = this.world.ownerDocument.createElement('div');
			host.className = 'sx-label';
			view.node.appendChild(host);
			view.labelHost = host;
		}
		host.dataset.placement = placement;
		return host;
	}

	private removeLabel(view: IView): void {
		view.labelHost?.remove();
		view.labelHost = undefined;
	}

	private paintLabel(view: IView, label: IScratchLabel | null, color: string, placement: 'inside' | 'below'): void {
		if (!label || !label.html) {
			this.removeLabel(view);
			return;
		}
		const host = this.ensureLabel(view, placement);
		host.style.left = '';
		host.style.top = '';
		this.fillLabel(host, label, color);
	}

	private fillLabel(host: HTMLElement, label: IScratchLabel, color: string): void {
		host.style.fontFamily = fontStack(label.fontFamily);
		host.style.fontSize = `${label.fontSize}px`;
		host.style.lineHeight = String(lineHeightFor(label.fontFamily));
		host.style.color = this.mapColor(color);
		host.style.textAlign = label.textAlign;
		host.dataset.valign = label.verticalAlign;
		let content = host.firstElementChild as HTMLElement | null;
		if (!content) {
			content = this.world.ownerDocument.createElement('div');
			content.className = 'sx-label-text sx-rich';
			host.appendChild(content);
		}
		if (content.dataset.html !== label.html) {
			setRichHtml(content, label.html);
			content.dataset.html = label.html;
		}
	}

	private paintRich(view: IView, el: ScratchRichTextElement): void {
		const node = view.node;
		let host = view.richHost;
		if (!host) {
			host = this.world.ownerDocument.createElement('div');
			host.className = 'sx-rich';
			node.appendChild(host);
			view.richHost = host;
		}
		node.style.fontFamily = fontStack(el.fontFamily);
		node.style.fontSize = `${el.fontSize}px`;
		node.style.lineHeight = String(lineHeightFor(el.fontFamily));
		node.style.textAlign = el.textAlign;
		node.style.color = this.mapColor(el.stroke);
		node.classList.toggle('sx-autosize', el.type === 'text' && el.autoSize);
		node.classList.toggle('sx-empty', !el.html);
		this.paintChrome(view);
		if (host.dataset.html !== el.html) {
			setRichHtml(host, el.html);
			host.dataset.html = el.html;
			if (host.querySelector('pre > code[class*="language-"]')) {
				void highlightCodeBlocks(host, this.host.languageService);
			}
		}
		this.toMeasure.add(el.id);
		this.scheduleMeasure();
	}

	private paintImage(view: IView, assetId: string, mime: string, strokeWidth: number, stroke: string, round: boolean): void {
		let img = view.node.querySelector(':scope > img.sx-image') as HTMLImageElement | null;
		if (!img) {
			img = this.world.ownerDocument.createElement('img');
			img.className = 'sx-image';
			img.draggable = false;
			img.alt = '';
			view.node.appendChild(img);
		}
		view.node.style.setProperty('--sx-image-border', strokeWidth > 0 ? `${strokeWidth}px solid ${this.mapColor(stroke)}` : 'none');
		view.node.classList.toggle('sx-round', round);
		const target = img;
		if (target.dataset.asset !== assetId) {
			target.dataset.asset = assetId;
			view.node.classList.add('sx-loading');
			void this.host.assetUrl(assetId, mime).then(url => {
				if (target.dataset.asset !== assetId) {
					return;
				}
				view.node.classList.remove('sx-loading');
				if (url) {
					target.src = url;
					view.node.classList.remove('sx-missing');
				} else {
					view.node.classList.add('sx-missing');
				}
			});
		}
	}

	private paintIcon(view: IView, svg: string, tintable: boolean, stroke: string): void {
		let img = view.node.querySelector(':scope > img.sx-icon-img') as HTMLImageElement | null;
		if (!img) {
			img = this.world.ownerDocument.createElement('img');
			img.className = 'sx-icon-img';
			img.draggable = false;
			img.alt = '';
			view.node.prepend(img);
		}
		img.src = iconDataUrl(svg, tintable ? this.mapColor(stroke) : undefined, this.dark && !tintable);
	}

	private paintFrame(view: IView, name: string, stroke: string, fill: string): void {
		let tab = view.node.querySelector(':scope > .sx-frame-name') as HTMLElement | null;
		if (!tab) {
			tab = this.world.ownerDocument.createElement('div');
			tab.className = 'sx-frame-name';
			view.node.appendChild(tab);
		}
		tab.textContent = name;
		view.node.style.setProperty('--sx-frame-border', this.mapColor(stroke));
		view.node.style.setProperty('--sx-frame-fill', fill === 'transparent' ? 'transparent' : this.mapColor(fill));
	}

	private paintLink(view: IView): void {
		const link = view.element.link;
		let badge = view.node.querySelector(':scope > .sx-link-badge') as HTMLElement | null;
		if (!link) {
			badge?.remove();
			return;
		}
		if (!badge) {
			badge = this.world.ownerDocument.createElement('div');
			badge.className = 'sx-link-badge codicon codicon-link';
			view.node.appendChild(badge);
		}
		badge.title = link;
	}

	private scheduleMeasure(): void {
		if (this.measureQueued) {
			return;
		}
		this.measureQueued = true;
		getWindow(this.world).requestAnimationFrame(() => {
			this.measureQueued = false;
			this.measure();
		});
	}

	/** Reads text sizes in one pass (no layout thrash) and reports the ones that changed. */
	private measure(): void {
		const results: { id: string; width: number; height: number }[] = [];
		for (const id of this.toMeasure) {
			const view = this.views.get(id);
			if (!view || view.culled || id === this.editingId) {
				continue;
			}
			const size = measureView(view);
			if (size) {
				results.push({ id, ...size });
			}
		}
		this.toMeasure.clear();
		for (const r of results) {
			const el = this.scene.get(r.id);
			if (el && (Math.abs(el.width - r.width) > 0.5 || Math.abs(el.height - r.height) > 0.5)) {
				this.host.onDidMeasure(r.id, r.width, r.height);
			}
		}
	}

	/** Measures what the element's text needs now (for the editor while typing). */
	measureNow(id: string): { width: number; height: number } | undefined {
		const view = this.views.get(id);
		return view ? measureView(view) : undefined;
	}
}

function hasLabelText(el: ScratchElement): boolean {
	return (el.type === 'shape' || el.type === 'arrow' || el.type === 'line' || el.type === 'icon');
}

/** The size a rich-text element should have for its content. */
function measureView(view: IView): { width: number; height: number } | undefined {
	const el = view.element;
	const host = view.richHost;
	if (!host || !isRichText(el)) {
		return undefined;
	}
	if (el.type === 'text') {
		if (el.autoSize) {
			// Hug the content: no wrapping, the widest line wins.
			return { width: Math.ceil(Math.max(8, host.scrollWidth)), height: Math.ceil(Math.max(el.fontSize * lineHeightFor(el.fontFamily), host.scrollHeight)) };
		}
		return { width: el.width, height: Math.ceil(Math.max(el.fontSize * lineHeightFor(el.fontFamily), host.scrollHeight)) };
	}
	if (el.type === 'note') {
		const needed = Math.ceil(host.scrollHeight + NOTE_PADDING * 2);
		return { width: el.width, height: Math.max(el.height, needed) };
	}
	// Cards are as tall as their content.
	return { width: el.width, height: Math.ceil(Math.max(48, host.scrollHeight + CARD_PADDING_Y * 2)) };
}

export function appendPaths(svg: SVGElement, specs: readonly IScratchPathSpec[]): void {
	const doc = svg.ownerDocument;
	// Reuse path nodes: shape edits during drags repaint without churning the DOM.
	const existing = Array.from(svg.children).filter(c => c.tagName === 'path') as SVGPathElement[];
	specs.forEach((spec, i) => {
		let path = existing[i];
		if (!path) {
			path = doc.createElementNS(SVG_NS, 'path');
			svg.appendChild(path);
		}
		path.setAttribute('d', spec.d);
		path.setAttribute('fill', spec.fill);
		path.setAttribute('stroke', spec.stroke);
		path.setAttribute('stroke-width', svgNum(spec.strokeWidth));
		setOrRemove(path, 'stroke-dasharray', spec.dash);
		path.setAttribute('stroke-linecap', spec.lineCap ?? 'round');
		path.setAttribute('stroke-linejoin', spec.lineJoin ?? 'round');
		setOrRemove(path, 'fill-rule', spec.fillRule);
		setOrRemove(path, 'opacity', spec.opacity === undefined || spec.opacity >= 1 ? undefined : String(spec.opacity));
	});
	for (let i = specs.length; i < existing.length; i++) {
		existing[i].remove();
	}
}

function setOrRemove(el: Element, name: string, value: string | undefined): void {
	if (value === undefined) {
		el.removeAttribute(name);
	} else {
		el.setAttribute(name, value);
	}
}

const iconUrlCache = new Map<string, string>();

/**
 * Icons are shown as images of their SVG, so a downloaded icon can never run script or load
 * anything. Tintable icons take the stroke colour in place of currentColor.
 */
export function iconDataUrl(svg: string, tint: string | undefined, invertForDark = false): string {
	const key = `${tint ?? ''}|${invertForDark ? 1 : 0}|${svg}`;
	const cached = iconUrlCache.get(key);
	if (cached) {
		return cached;
	}
	let source = svg;
	if (tint) {
		source = source.replace(/currentColor/g, tint);
	}
	if (!/\sxmlns=/.test(source)) {
		source = source.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
	}
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
	if (iconUrlCache.size > 500) {
		iconUrlCache.clear();
	}
	iconUrlCache.set(key, url);
	return url;
}
