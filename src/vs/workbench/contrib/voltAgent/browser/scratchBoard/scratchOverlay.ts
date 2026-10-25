/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { svgNum, Vec } from '../../common/scratchBoard/scratchMath.js';
import type { ResizeHandle } from '../../common/scratchBoard/scratchTransform.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const HANDLE_SIZE = 9;
export const ROTATE_HANDLE_OFFSET = 22;

export interface IOverlayHandle {
	readonly kind: ResizeHandle | 'rotate';
	readonly at: Vec;
}

export interface IOverlayGuide {
	readonly from: Vec;
	readonly to: Vec;
}

/** Everything the overlay draws this frame, in screen pixels. */
export interface IOverlayInput {
	/** One outline per selected element (thin). */
	readonly outlines: readonly (readonly Vec[])[];
	/** Dashed outlines around selected groups. */
	readonly groupOutlines: readonly (readonly Vec[])[];
	/** The transform box around the selection, with its handles. */
	readonly box?: { readonly corners: readonly Vec[]; readonly handles: readonly IOverlayHandle[]; readonly dashed: boolean };
	/** Point handles of a single selected connector. */
	readonly points?: { readonly at: readonly Vec[]; readonly mids: readonly Vec[]; readonly active?: number; readonly bound: readonly boolean[] };
	readonly hover?: readonly Vec[];
	readonly marquee?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly guides: readonly IOverlayGuide[];
	readonly binding?: { readonly outline: readonly Vec[]; readonly ports: readonly Vec[]; readonly activePort: number | undefined };
	readonly eraser?: readonly Vec[];
	readonly laser?: readonly { readonly at: Vec; readonly age: number }[];
	readonly editing?: readonly Vec[];
	/** Dashed frames around what an agent was given; chips are HTML, laid out by the canvas. */
	readonly runs: readonly { readonly corners: readonly Vec[]; readonly state: string }[];
	readonly frameHighlight?: readonly Vec[];
}

/** Paints the screen-space layer above the board: selection, handles, guides, marquee, trails. */
export class ScratchOverlay {

	private readonly svg: SVGSVGElement;

	constructor(parent: HTMLElement) {
		this.svg = parent.ownerDocument.createElementNS(SVG_NS, 'svg');
		this.svg.classList.add('sx-overlay');
		this.svg.setAttribute('aria-hidden', 'true');
		parent.appendChild(this.svg);
	}

	get element(): SVGSVGElement {
		return this.svg;
	}

	render(input: IOverlayInput): void {
		const doc = this.svg.ownerDocument;
		const frag = doc.createDocumentFragment();
		const add = (tag: string, attrs: Record<string, string>, className?: string) => {
			const el = doc.createElementNS(SVG_NS, tag);
			for (const [k, v] of Object.entries(attrs)) {
				el.setAttribute(k, v);
			}
			if (className) {
				el.setAttribute('class', className);
			}
			frag.appendChild(el);
			return el;
		};
		const poly = (points: readonly Vec[], className: string) => add('polygon', { points: points.map(p => `${svgNum(p[0])},${svgNum(p[1])}`).join(' ') }, className);

		for (const run of input.runs) {
			poly(run.corners, `sx-ov-run sx-ov-run-${run.state}`);
		}
		if (input.frameHighlight) {
			poly(input.frameHighlight, 'sx-ov-frame-target');
		}
		if (input.hover) {
			poly(input.hover, 'sx-ov-hover');
		}
		for (const outline of input.groupOutlines) {
			poly(outline, 'sx-ov-group');
		}
		for (const outline of input.outlines) {
			poly(outline, 'sx-ov-outline');
		}
		if (input.editing) {
			poly(input.editing, 'sx-ov-editing');
		}
		if (input.box) {
			poly(input.box.corners, input.box.dashed ? 'sx-ov-box sx-ov-dashed' : 'sx-ov-box');
			for (const handle of input.box.handles) {
				if (handle.kind === 'rotate') {
					add('circle', { cx: svgNum(handle.at[0]), cy: svgNum(handle.at[1]), r: svgNum(HANDLE_SIZE / 2 + 0.5) }, 'sx-ov-handle sx-ov-rotate');
				} else {
					const s = HANDLE_SIZE;
					add('rect', { x: svgNum(handle.at[0] - s / 2), y: svgNum(handle.at[1] - s / 2), width: String(s), height: String(s), rx: '2.5' }, 'sx-ov-handle');
				}
			}
		}
		if (input.points) {
			input.points.mids.forEach(p => add('circle', { cx: svgNum(p[0]), cy: svgNum(p[1]), r: '3.5' }, 'sx-ov-mid'));
			input.points.at.forEach((p, i) => add('circle', { cx: svgNum(p[0]), cy: svgNum(p[1]), r: i === input.points!.active ? '6' : '5' }, `sx-ov-point${input.points!.bound[i] ? ' sx-ov-bound' : ''}${i === input.points!.active ? ' sx-ov-active' : ''}`));
		}
		if (input.binding) {
			poly(input.binding.outline, 'sx-ov-bind');
			input.binding.ports.forEach((p, i) => add('circle', { cx: svgNum(p[0]), cy: svgNum(p[1]), r: i === input.binding!.activePort ? '6' : '4' }, `sx-ov-port${i === input.binding!.activePort ? ' sx-ov-active' : ''}`));
		}
		for (const guide of input.guides) {
			add('line', { x1: svgNum(guide.from[0]), y1: svgNum(guide.from[1]), x2: svgNum(guide.to[0]), y2: svgNum(guide.to[1]) }, 'sx-ov-guide');
			for (const end of [guide.from, guide.to]) {
				add('path', { d: `M${svgNum(end[0] - 3)} ${svgNum(end[1] - 3)}l6 6m0 -6l-6 6` }, 'sx-ov-guide-x');
			}
		}
		if (input.marquee && (input.marquee.width > 0 || input.marquee.height > 0)) {
			const m = input.marquee;
			add('rect', { x: svgNum(m.x), y: svgNum(m.y), width: svgNum(m.width), height: svgNum(m.height), rx: '2' }, 'sx-ov-marquee');
		}
		if (input.eraser && input.eraser.length > 1) {
			add('polyline', { points: input.eraser.map(p => `${svgNum(p[0])},${svgNum(p[1])}`).join(' ') }, 'sx-ov-eraser');
		}
		if (input.laser && input.laser.length > 1) {
			// Fades from the tip back; each segment's opacity follows its age.
			for (let i = 1; i < input.laser.length; i++) {
				const a = input.laser[i - 1], b = input.laser[i];
				const alpha = Math.max(0, 1 - b.age / 900);
				if (alpha <= 0) {
					continue;
				}
				add('line', { x1: svgNum(a.at[0]), y1: svgNum(a.at[1]), x2: svgNum(b.at[0]), y2: svgNum(b.at[1]), 'stroke-opacity': svgNum(alpha), 'stroke-width': svgNum(2 + 3 * alpha) }, 'sx-ov-laser');
			}
		}
		this.svg.replaceChildren(frag);
	}

	clear(): void {
		this.svg.replaceChildren();
	}
}
