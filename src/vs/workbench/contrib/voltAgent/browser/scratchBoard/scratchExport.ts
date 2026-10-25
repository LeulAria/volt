/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { freehandDrawing, IScratchPathSpec, linearCenterline, linearDrawing, shapeDrawing } from '../../common/scratchBoard/scratchDrawing.js';
import { elementBounds, elementBox, elementCenter } from '../../common/scratchBoard/scratchGeometry.js';
import { pointAlongPolyline, svgNum, unionBounds } from '../../common/scratchBoard/scratchMath.js';
import { IScratchBounds, IScratchLabel, isRichText, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { IScratchBoardService } from './scratchBoardService.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import type { ScratchScene } from '../../common/scratchBoard/scratchScene.js';
import { CARD_PADDING_X, CARD_PADDING_Y, fontStack, iconDataUrl, LABEL_PADDING, lineHeightFor, NOTE_PADDING } from './scratchRenderer.js';
import { setRichHtml } from './scratchRichText.js';

/** Excalifont's files and the code points each covers (OFL 1.1, see media/fonts/excalifont). */
export const EXCALIFONT_FACES: readonly { readonly file: string; readonly range: string }[] = [
	{ file: 'Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2', range: 'U+20-7e,U+a0-a3,U+a5-a6,U+a8-ab,U+ad-b1,U+b4,U+b6-b8,U+ba-ff,U+131,U+152-153,U+2bc,U+2c6,U+2da,U+2dc,U+304,U+308,U+2013-2014,U+2018-201a,U+201c-201e,U+2020,U+2022,U+2024-2026,U+2030,U+2039-203a,U+20ac,U+2122,U+2212' },
	{ file: 'Excalifont-Regular-be310b9bcd4f1a43f571c46df7809174.woff2', range: 'U+100-130,U+132-137,U+139-149,U+14c-151,U+154-17e,U+192,U+1fc-1ff,U+218-21b,U+237,U+1e80-1e85,U+1ef2-1ef3,U+2113' },
	{ file: 'Excalifont-Regular-b9dcf9d2e50a1eaf42fc664b50a3fd0d.woff2', range: 'U+400-45f,U+490-491,U+2116' },
	{ file: 'Excalifont-Regular-41b173a47b57366892116a575a43e2b6.woff2', range: 'U+37e,U+384-38a,U+38c,U+38e-393,U+395-3a1,U+3a3-3a8,U+3aa-3cf,U+3d7' },
	{ file: 'Excalifont-Regular-3f2c5db56cc93c5a6873b1361d730c16.woff2', range: 'U+2c7,U+2d8-2d9,U+2db,U+2dd,U+302,U+306-307,U+30a-30c,U+326-328,U+212e,U+2211,U+fb01-fb02' },
	{ file: 'Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2', range: 'U+462-463,U+472-475,U+4d8-4d9,U+4e2-4e3,U+4e6-4e9,U+4ee-4ef' },
	{ file: 'Excalifont-Regular-623ccf21b21ef6b3a0d87738f77eb071.woff2', range: 'U+300-301,U+303' },
];

function excalifontUrl(file: string): string {
	return FileAccess.asBrowserUri(`vs/workbench/contrib/voltAgent/browser/media/fonts/excalifont/${file}` as AppResourcePath).toString(true);
}

const fontsRegistered = new WeakSet<Document>();
/** A frame name's colour on a light board (the board's dark-mode map lightens it). */
const FRAME_TITLE_INK = '#343a40';

/** Makes Excalifont available in `doc`; each subset downloads the first time some text needs it. */
export function registerScratchFonts(doc: Document): void {
	const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
	const FontFaceCtor = (doc.defaultView as (Window & { FontFace?: typeof FontFace }) | null)?.FontFace;
	if (!fonts || !FontFaceCtor || fontsRegistered.has(doc)) {
		return;
	}
	fontsRegistered.add(doc);
	for (const face of EXCALIFONT_FACES) {
		fonts.add(new FontFaceCtor('Excalifont', `url("${excalifontUrl(face.file)}") format("woff2")`, { unicodeRange: face.range, display: 'block' }));
	}
}

/** Rich text styling for exports; mirrors the `.sx-rich` rules in scratchBoard.css. */
const RICH_CSS = `
.sx-x{box-sizing:border-box;overflow:hidden;word-wrap:break-word;overflow-wrap:anywhere}
.sx-x *{box-sizing:border-box}
.sx-x p{margin:0;min-height:1lh}
.sx-x h1{font-size:1.75em;font-weight:700;margin:.2em 0 .25em;line-height:1.15}
.sx-x h2{font-size:1.4em;font-weight:700;margin:.2em 0 .2em;line-height:1.2}
.sx-x h3{font-size:1.15em;font-weight:650;margin:.15em 0 .15em}
.sx-x strong,.sx-x b{font-weight:700}
.sx-x ul,.sx-x ol{margin:.1em 0;padding-left:1.4em}
.sx-x li[data-checked]{list-style:none;position:relative;padding-left:.2em;margin-left:-1.4em;padding-left:1.5em}
.sx-x li[data-checked]::before{content:"";position:absolute;left:.12em;top:.2em;width:.95em;height:.95em;border:1.5px solid currentColor;border-radius:50%;opacity:.7}
.sx-x li[data-checked="true"]{opacity:.55;text-decoration:line-through}
.sx-x li[data-checked="true"]::before{background:currentColor;opacity:.85}
.sx-x li[data-checked="true"]::after{content:"";position:absolute;top:.37em;left:.47em;width:.22em;height:.42em;border:solid var(--sx-x-check,#fff);border-width:0 .12em .12em 0;transform:rotate(45deg)}
.sx-x blockquote{margin:.2em 0;padding-left:.8em;border-left:3px solid currentColor;opacity:.8}
.sx-x code{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:.86em;padding:.08em .32em;border-radius:4px;background:rgba(127,127,127,.16)}
.sx-x pre{margin:.3em 0;padding:.6em .8em;border-radius:8px;background:rgba(127,127,127,.12);overflow:hidden;white-space:pre-wrap}
.sx-x pre code{padding:0;background:none;font-size:.86em}
.sx-x table{border-collapse:collapse;margin:.3em 0;width:100%;font-size:.92em}
.sx-x th,.sx-x td{border:1px solid rgba(127,127,127,.35);padding:.3em .55em;height:calc(1lh + .6em);text-align:left;vertical-align:top}
.sx-x th{font-weight:650;background:rgba(127,127,127,.1)}
.sx-x hr{border:none;border-top:1px solid rgba(127,127,127,.4);margin:.5em 0}
.sx-x a{color:#1971c2;text-decoration:underline}
.sx-x mark{background:#ffec99;color:inherit;padding:0 .1em}
`;

/** What a render reads: the canvas, or a board that is not on screen (an agent tool). */
export interface IScratchRenderSource {
	readonly scene: ScratchScene | undefined;
	readonly isDarkBoard: boolean;
	mapColor(color: string): string;
	/** Any element of the window to render in (its document makes the image). */
	readonly element: HTMLElement;
}

export interface IScratchRenderOptions {
	readonly padding?: number;
	readonly background?: boolean;
	/** Paint as the board looks now (dark boards stay dark) instead of always light. */
	readonly asShown?: boolean;
	readonly scale?: number;
	/** Longest side in pixels; the scale drops to fit. */
	readonly maxSide?: number;
	/** Numbered pins drawn over the elements (comments sent to an agent), each by its world point. */
	readonly marks?: readonly { readonly at: readonly [number, number]; readonly label: string }[];
}

/** Board → SVG (vector, fonts embedded) → PNG. Used by export, copy as PNG and agent sends. */
export class ScratchExporter {

	private fontCss: Promise<string> | undefined;

	constructor(
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@INotificationService private readonly notificationService: INotificationService,
	) { }

	private embeddedFonts(): Promise<string> {
		if (!this.fontCss) {
			this.fontCss = (async () => {
				const faces: string[] = [];
				for (const face of EXCALIFONT_FACES) {
					try {
						const response = await fetch(excalifontUrl(face.file));
						const bytes = new Uint8Array(await response.arrayBuffer());
						faces.push(`@font-face{font-family:"Excalifont";src:url(data:font/woff2;base64,${encodeBase64(VSBuffer.wrap(bytes))}) format("woff2");unicode-range:${face.range};font-display:block}`);
					} catch {
						// Missing file: the export falls back to the next font in the stack.
					}
				}
				return faces.join('\n');
			})();
		}
		return this.fontCss;
	}

	/** An SVG of `elements` with their surroundings: padding, board colour, fonts, images inline. */
	async renderSvg(canvas: IScratchRenderSource, elements: readonly ScratchElement[], options: IScratchRenderOptions = {}): Promise<{ readonly svg: string; readonly width: number; readonly height: number } | undefined> {
		const scene = canvas.scene;
		if (!scene || !elements.length) {
			return undefined;
		}
		const padding = options.padding ?? 24;
		const marks = options.marks ?? [];
		let bounds = unionBounds(elements.map(el => elementBounds(el))) as IScratchBounds;
		// A pin grows with the drawing so it still reads once the render is scaled down.
		const pin = Math.min(64, Math.max(22, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 40));
		for (const mark of marks) {
			bounds = { minX: Math.min(bounds.minX, mark.at[0]), minY: Math.min(bounds.minY, mark.at[1] - pin), maxX: Math.max(bounds.maxX, mark.at[0] + pin), maxY: Math.max(bounds.maxY, mark.at[1]) };
		}
		const width = Math.ceil(bounds.maxX - bounds.minX + padding * 2);
		const height = Math.ceil(bounds.maxY - bounds.minY + padding * 2);
		const dark = options.asShown ? canvas.isDarkBoard : false;
		const map = (c: string) => dark ? canvas.mapColor(c) : c;
		const doc = getWindow(canvas.element).document;
		const parts: string[] = [];
		const usesHand = elements.some(el => (isRichText(el) && el.fontFamily === 'hand') || ((el.type === 'shape' || el.type === 'arrow' || el.type === 'line' || el.type === 'icon') && el.label?.fontFamily === 'hand'));
		const fonts = usesHand ? await this.embeddedFonts() : '';
		// A done checkbox's check is cut out in the board's colour, as on the board.
		const check = map(scene.settings.background);
		parts.push(`<defs><style>${fonts}${RICH_CSS}.sx-x{--sx-x-check:${/^#[0-9a-f]{3,8}$/i.test(check) ? check : '#ffffff'}}</style></defs>`);
		if (options.background !== false) {
			parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeAttr(map(scene.settings.background))}"/>`);
		}
		const ox = padding - bounds.minX, oy = padding - bounds.minY;
		parts.push(`<g transform="translate(${svgNum(ox)} ${svgNum(oy)})">`);
		const order = new Map(scene.getElements().map((e, i) => [e.id, i]));
		const sorted = [...elements].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		for (const el of sorted) {
			parts.push(await this.elementSvg(el, map, doc, map(scene.settings.background)));
		}
		for (const mark of marks) {
			parts.push(pinSvg(mark.at[0], mark.at[1], pin, mark.label));
		}
		parts.push('</g>');
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
		return { svg, width, height };
	}

	private async elementSvg(el: ScratchElement, map: (c: string) => string, doc: Document, background: string): Promise<string> {
		const box = elementBox(el);
		const center = elementCenter(el);
		const deg = el.angle * 180 / Math.PI;
		const opacity = el.opacity < 100 ? ` opacity="${svgNum(el.opacity / 100)}"` : '';
		// Local drawing coordinates are relative to (x, y); rotation is about the box centre.
		const open = `<g transform="translate(${svgNum(el.x)} ${svgNum(el.y)})${deg ? ` rotate(${svgNum(deg)} ${svgNum(center[0] - el.x)} ${svgNum(center[1] - el.y)})` : ''}"${opacity}>`;
		const inner: string[] = [];
		const local = (x: number, y: number, w: number, h: number) => ({ x: x - el.x, y: y - el.y, w, h });
		switch (el.type) {
			case 'shape':
				inner.push(pathsSvg(shapeDrawing(el, map)));
				if (el.label) {
					const b = local(box.x, box.y, box.width, box.height);
					inner.push(this.labelSvg(el.label, map(el.stroke), b.x + LABEL_PADDING, b.y + LABEL_PADDING, Math.max(1, b.w - LABEL_PADDING * 2), Math.max(1, b.h - LABEL_PADDING * 2), doc));
				}
				break;
			case 'line':
			case 'arrow':
				inner.push(pathsSvg(linearDrawing(el, map)));
				if (el.label) {
					const mid = pointAlongPolyline(linearCenterline(el), 0.5).point;
					const w = 220, h = el.label.fontSize * 3;
					inner.push(this.labelSvg(el.label, map(el.stroke), mid[0] - w / 2, mid[1] - h / 2, w, h, doc, background));
				}
				break;
			case 'draw':
				inner.push(pathsSvg(freehandDrawing(el, map)));
				break;
			case 'text':
			case 'note':
			case 'card': {
				const b = local(box.x, box.y, box.width, box.height);
				if (el.type === 'note') {
					inner.push(`<rect x="${svgNum(b.x)}" y="${svgNum(b.y)}" width="${svgNum(b.w)}" height="${svgNum(b.h)}" rx="6" fill="${escapeAttr(map(el.fill))}"/>`);
				} else if (el.type === 'card') {
					inner.push(`<rect x="${svgNum(b.x + 0.5)}" y="${svgNum(b.y + 0.5)}" width="${svgNum(b.w - 1)}" height="${svgNum(b.h - 1)}" rx="10" fill="${escapeAttr(map(el.fill === 'transparent' ? '#ffffff' : el.fill))}" stroke="${escapeAttr(map(el.stroke))}" stroke-opacity="0.18"/>`);
				}
				const pad = el.type === 'note' ? [NOTE_PADDING, NOTE_PADDING] : el.type === 'card' ? [CARD_PADDING_X, CARD_PADDING_Y] : [0, 0];
				inner.push(this.richSvg(el.html, {
					color: map(el.stroke), fontFamily: el.fontFamily, fontSize: el.fontSize, align: el.textAlign,
					x: b.x + pad[0], y: b.y + pad[1], width: Math.max(1, b.w - pad[0] * 2), height: Math.max(1, b.h - pad[1] * 2),
					nowrap: el.type === 'text' && el.autoSize,
				}, doc));
				break;
			}
			case 'image': {
				const buffer = await this.boards.readAsset(el.assetId);
				if (buffer) {
					const b = local(box.x, box.y, box.width, box.height);
					inner.push(`<image x="${svgNum(b.x)}" y="${svgNum(b.y)}" width="${svgNum(b.w)}" height="${svgNum(b.h)}" preserveAspectRatio="none" href="data:${escapeAttr(el.mime)};base64,${encodeBase64(buffer)}"/>`);
				}
				break;
			}
			case 'icon': {
				const b = local(box.x, box.y, box.width, box.height);
				inner.push(`<image x="${svgNum(b.x)}" y="${svgNum(b.y)}" width="${svgNum(b.w)}" height="${svgNum(b.h)}" href="${escapeAttr(iconDataUrl(el.svg, el.tintable ? map(el.stroke) : undefined))}"/>`);
				if (el.label) {
					inner.push(this.labelSvg(el.label, map(el.stroke), b.x - b.w, b.y + b.h + 4, b.w * 3, el.label.fontSize * 3, doc));
				}
				break;
			}
			case 'frame': {
				const b = local(box.x, box.y, box.width, box.height);
				inner.push(`<rect x="${svgNum(b.x)}" y="${svgNum(b.y)}" width="${svgNum(b.w)}" height="${svgNum(b.h)}" rx="8" fill="${el.fill === 'transparent' ? 'none' : escapeAttr(map(el.fill))}" stroke="${escapeAttr(map(el.stroke))}" stroke-width="1"/>`);
				// The name as the board shows it: a heading in the ink colour, 10px clear of the frame.
				inner.push(`<text x="${svgNum(b.x + 1)}" y="${svgNum(b.y - 13)}" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" fill="${escapeAttr(map(FRAME_TITLE_INK))}">${escapeText(el.name)}</text>`);
				break;
			}
		}
		return `${open}${inner.join('')}</g>`;
	}

	private labelSvg(label: IScratchLabel, color: string, x: number, y: number, width: number, height: number, doc: Document, background?: string): string {
		const valign = label.verticalAlign === 'top' ? 'flex-start' : label.verticalAlign === 'bottom' ? 'flex-end' : 'center';
		const xhtml = this.xhtml(label.html, doc);
		const bg = background ? `background:${background};padding:0 4px;border-radius:4px;` : '';
		return `<foreignObject x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(width)}" height="${svgNum(height)}"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:${valign};justify-content:center;width:100%;height:100%;"><div class="sx-x" style="${bg}max-width:100%;color:${color};font-family:${escapeAttr(fontStack(label.fontFamily))};font-size:${label.fontSize}px;line-height:${lineHeightFor(label.fontFamily)};text-align:${label.textAlign};">${xhtml}</div></div></foreignObject>`;
	}

	private richSvg(html: string, o: { color: string; fontFamily: IScratchLabel['fontFamily']; fontSize: number; align: string; x: number; y: number; width: number; height: number; nowrap: boolean }, doc: Document): string {
		const xhtml = this.xhtml(html, doc);
		// Text that hugs its content gets a little slack: export fonts can measure a hair wider.
		const width = o.nowrap ? o.width + 8 : o.width;
		return `<foreignObject x="${svgNum(o.x)}" y="${svgNum(o.y)}" width="${svgNum(width)}" height="${svgNum(o.height + 4)}"><div xmlns="http://www.w3.org/1999/xhtml" class="sx-x" style="width:${svgNum(width)}px;color:${o.color};font-family:${escapeAttr(fontStack(o.fontFamily))};font-size:${o.fontSize}px;line-height:${lineHeightFor(o.fontFamily)};text-align:${o.align};${o.nowrap ? 'white-space:pre;' : 'white-space:pre-wrap;'}">${xhtml}</div></foreignObject>`;
	}

	/** Board rich text as well-formed XHTML for foreignObject. */
	private xhtml(html: string, doc: Document): string {
		const div = doc.createElement('div');
		setRichHtml(div, html);
		const serializer = new XMLSerializer();
		return Array.from(div.childNodes).map(node => serializer.serializeToString(node)).join('');
	}

	async renderPng(canvas: IScratchRenderSource, elements: readonly ScratchElement[], options: IScratchRenderOptions = {}): Promise<Blob | undefined> {
		const rendered = await this.renderSvg(canvas, elements, options);
		if (!rendered) {
			return undefined;
		}
		const win = getWindow(canvas.element);
		let scale = options.scale ?? 2;
		const maxSide = options.maxSide ?? 8192;
		scale = Math.min(scale, maxSide / Math.max(rendered.width, rendered.height));
		const img = new win.Image();
		img.decoding = 'async';
		const loaded = new Promise<boolean>(resolve => {
			img.onload = () => resolve(true);
			img.onerror = () => resolve(false);
		});
		img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
		if (!await loaded) {
			return undefined;
		}
		const c = win.document.createElement('canvas');
		c.width = Math.max(1, Math.round(rendered.width * scale));
		c.height = Math.max(1, Math.round(rendered.height * scale));
		const ctx = c.getContext('2d');
		if (!ctx) {
			return undefined;
		}
		ctx.scale(scale, scale);
		ctx.drawImage(img, 0, 0, rendered.width, rendered.height);
		return new Promise(resolve => c.toBlob(blob => resolve(blob ?? undefined), 'image/png'));
	}

	async exportImage(canvas: ScratchCanvas, format: 'png' | 'svg', onlySelection = false): Promise<void> {
		const scene = canvas.scene;
		if (!scene) {
			return;
		}
		const selected = canvas.selectedWithContents();
		const elements = onlySelection && selected.length ? selected : [...scene.getElements()];
		if (!elements.length) {
			this.notificationService.info(localize('voltScratch.exportEmpty', "There is nothing on the board to export yet."));
			return;
		}
		const name = safeFileName(canvas.boardTitle || 'scratch');
		const target = await this.fileDialogService.showSaveDialog({
			title: format === 'png' ? localize('voltScratch.exportPng', "Export as PNG") : localize('voltScratch.exportSvg', "Export as SVG"),
			defaultUri: joinPath(await this.pathService.userHome(), 'Downloads', `${name}.${format}`),
			filters: [format === 'png' ? { name: 'PNG', extensions: ['png'] } : { name: 'SVG', extensions: ['svg'] }],
		});
		if (!target) {
			return;
		}
		try {
			if (format === 'png') {
				const blob = await this.renderPng(canvas, elements, { scale: 2 });
				if (!blob) {
					throw new Error('render failed');
				}
				await this.fileService.writeFile(target, VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer())));
			} else {
				const rendered = await this.renderSvg(canvas, elements);
				if (!rendered) {
					throw new Error('render failed');
				}
				await this.fileService.writeFile(target, VSBuffer.fromString(rendered.svg));
			}
		} catch (err) {
			this.notificationService.error(localize('voltScratch.exportFailed', "Could not export the board: {0}", String(err)));
		}
	}

	async exportJson(canvas: ScratchCanvas): Promise<void> {
		const model = canvas.model;
		if (!model) {
			return;
		}
		const name = safeFileName(canvas.boardTitle || 'scratch');
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltScratch.exportJson', "Save board file"),
			defaultUri: joinPath(await this.pathService.userHome(), 'Downloads', `${name}.scratch.json`),
			filters: [{ name: localize('voltScratch.boardFile', "Scratch board"), extensions: ['json'] }],
		});
		if (!target) {
			return;
		}
		const doc = model.toDocument();
		await this.fileService.writeFile(target, VSBuffer.fromString(JSON.stringify({ type: 'volt-scratch', version: 1, title: canvas.boardTitle, elements: doc.elements, settings: doc.settings }, null, '\t')));
	}
}

function pathsSvg(specs: readonly IScratchPathSpec[]): string {
	return specs.map(s => `<path d="${s.d}" fill="${escapeAttr(s.fill)}" stroke="${escapeAttr(s.stroke)}" stroke-width="${svgNum(s.strokeWidth)}" stroke-linecap="${s.lineCap ?? 'round'}" stroke-linejoin="${s.lineJoin ?? 'round'}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}${s.fillRule ? ` fill-rule="${s.fillRule}"` : ''}${s.opacity !== undefined && s.opacity < 1 ? ` opacity="${svgNum(s.opacity)}"` : ''}/>`).join('');
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'scratch';
}

/** A comment pin as on the board: a blue bubble whose pointed corner sits on (x, y), its number inside. */
function pinSvg(x: number, y: number, size: number, label: string): string {
	const r = size / 2;
	const t = size * 0.1;
	const d = `M${svgNum(x)} ${svgNum(y - r)}A${svgNum(r)} ${svgNum(r)} 0 0 1 ${svgNum(x + r)} ${svgNum(y - size)}A${svgNum(r)} ${svgNum(r)} 0 0 1 ${svgNum(x + size)} ${svgNum(y - r)}A${svgNum(r)} ${svgNum(r)} 0 0 1 ${svgNum(x + r)} ${svgNum(y)}L${svgNum(x + t)} ${svgNum(y)}A${svgNum(t)} ${svgNum(t)} 0 0 1 ${svgNum(x)} ${svgNum(y - t)}Z`;
	return `<path d="${d}" fill="#3b82f6" stroke="#ffffff" stroke-width="${svgNum(size / 11)}"/><text x="${svgNum(x + r)}" y="${svgNum(y - r)}" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${svgNum(size * 0.52)}" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeAttr(label)}</text>`;
}
