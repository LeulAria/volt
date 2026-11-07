/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { AgentChatDrawing } from '../../common/agentChatBackground.js';
import { AgentChatOrbit } from './agentChatOrbit.js';

/**
 * A chat background drawn live in the backdrop instead of shown as a picture, under the backdrop's
 * dim layer (agentChatBackground.css). Each one's pictures in media/chatBackgrounds are a still of it,
 * for Settings.
 */
export interface IAgentChatDrawing extends IDisposable {
	resize(width: number, height: number): void;
	/** The backdrop shows: an animated drawing moves. */
	play(): void;
	pause(): void;
}

/** `still`: an animated drawing shows one frame (reduced motion). */
export function createAgentChatDrawing(drawing: AgentChatDrawing, parent: HTMLElement, still: () => boolean): IAgentChatDrawing {
	switch (drawing) {
		case 'orbit':
			return new AgentChatOrbit(parent, still);
		case 'volt':
			return new AgentChatVoltMark(parent);
		case 'halftone':
			return new AgentChatHalftone(parent);
	}
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The app icon's bolt (brand/volt-icon.svg's glyph) in the icon's 1024px box, which the view box crops to the bolt. */
export const VOLT_BOLT_VIEWBOX = '326 233 374 558';
export const VOLT_BOLT_OUTLINE = 'M561.9 243.1 336.4 525.2A13 13 0 0 0 345 546.2L476 561.9A8 8 0 0 1 482.9 571.6L439.2 770A13 13 0 0 0 462.1 780.9L687.6 498.8A13 13 0 0 0 679 477.8L548 462.1A8 8 0 0 1 541.1 452.4L584.8 254A13 13 0 0 0 561.9 243.1Z';
/** Where the icon's shaded faces meet: the edges of its shadowFace and lightFace that lie inside the bolt. */
export const VOLT_BOLT_FOLDS = 'M338.5 536.9 539.2 461 500.6 563 484.8 563M539.2 461 462.9 662.4 686.5 492.5';

/**
 * The Volt background: the app icon's bolt nearly as tall as the chat, in hairlines of the theme's
 * text color, fading out toward the bottom (agentChatBackground.css), like the outlined logo behind
 * Linear's empty views. Nothing to repaint: the lines scale with the view box.
 */
class AgentChatVoltMark extends Disposable implements IAgentChatDrawing {

	constructor(parent: HTMLElement) {
		super();
		const doc = parent.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.classList.add('volt-agent-chat-volt');
		svg.setAttribute('viewBox', VOLT_BOLT_VIEWBOX);
		svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('aria-hidden', 'true');
		for (const [shape, part] of [[VOLT_BOLT_OUTLINE, 'outline'], [VOLT_BOLT_FOLDS, 'folds']]) {
			const path = doc.createElementNS(SVG_NS, 'path');
			path.setAttribute('d', shape);
			path.setAttribute('class', part);
			path.setAttribute('stroke', 'currentColor');
			path.setAttribute('stroke-linejoin', 'round');
			path.setAttribute('vector-effect', 'non-scaling-stroke');
			svg.appendChild(path);
		}
		parent.appendChild(svg);
		this._register(toDisposable(() => svg.remove()));
	}

	resize(): void { }

	play(): void { }

	pause(): void { }
}

/** Dither cells and the square dots in them, in CSS pixels. */
const HALFTONE_CELL = 4;
const HALFTONE_DOT = 2;
/** The share of cells lit in the top left corner: a checkerboard. */
const HALFTONE_DENSITY = 0.5;
/** How far the dots reach, as a share of the width along the top and of the height down the left. */
const HALFTONE_REACH_X = 0.8;
const HALFTONE_REACH_Y = 0.62;
/** The checkerboard holds over this share of the reach, nearest the corner, before it thins out. */
const HALFTONE_PLATEAU = 0.3;
const HALFTONE_ALPHA = 0.2;
/** Bayer's 4x4 ordered-dither thresholds, row by row. */
const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Finer is lost under the dim layer. */
const MAX_PIXEL_RATIO = 2;

/**
 * Paints the Halftone background on a cleared canvas: white square dots, ordered-dithered so they
 * thin out from a checkerboard in the top left corner to nothing, as behind Capy's new chat. The rest
 * stays transparent, over the theme's window color; light themes invert the canvas.
 */
export function paintAgentChatHalftone(context: CanvasRenderingContext2D, width: number, height: number, pixelRatio: number): void {
	context.clearRect(0, 0, context.canvas.width, context.canvas.height);
	context.fillStyle = `rgba(255, 255, 255, ${HALFTONE_ALPHA})`;
	const reachX = Math.max(1, width * HALFTONE_REACH_X);
	const reachY = Math.max(1, height * HALFTONE_REACH_Y);
	const dot = Math.max(1, Math.round(HALFTONE_DOT * pixelRatio));
	for (let row = 0; ; row++) {
		const y = (row + 0.5) * HALFTONE_CELL / reachY;
		if (y >= 1) {
			break;
		}
		for (let column = 0; ; column++) {
			const x = (column + 0.5) * HALFTONE_CELL / reachX;
			const distance = Math.sqrt(x * x + y * y);
			if (distance >= 1) {
				break;
			}
			const near = Math.min(1, (1 - distance) / (1 - HALFTONE_PLATEAU));
			const density = HALFTONE_DENSITY * near * near * (3 - 2 * near);
			if (density > (BAYER_4[(row % 4) * 4 + column % 4] + 0.5) / 16) {
				context.fillRect(Math.round(column * HALFTONE_CELL * pixelRatio), Math.round(row * HALFTONE_CELL * pixelRatio), dot, dot);
			}
		}
	}
}

/** The Halftone background, painted again (once a frame at most) when the backdrop's size changes. */
class AgentChatHalftone extends Disposable implements IAgentChatDrawing {

	private readonly canvas: HTMLCanvasElement;
	private width = 0;
	private height = 0;
	private pixelRatio = 1;
	private frame: number | undefined;

	constructor(parent: HTMLElement) {
		super();
		this.canvas = append(parent, $<HTMLCanvasElement>('canvas.volt-agent-chat-halftone', { 'aria-hidden': 'true' }));
		this._register(toDisposable(() => {
			if (this.frame !== undefined) {
				getWindow(this.canvas).cancelAnimationFrame(this.frame);
			}
			this.canvas.remove();
		}));
	}

	resize(width: number, height: number): void {
		const pixelRatio = Math.min(getWindow(this.canvas).devicePixelRatio || 1, MAX_PIXEL_RATIO);
		if (width === this.width && height === this.height && pixelRatio === this.pixelRatio) {
			return;
		}
		this.width = width;
		this.height = height;
		this.pixelRatio = pixelRatio;
		this.frame ??= getWindow(this.canvas).requestAnimationFrame(() => {
			this.frame = undefined;
			this.paint();
		});
	}

	play(): void { }

	pause(): void { }

	private paint(): void {
		this.canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
		this.canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
		const context = this.canvas.getContext('2d');
		if (context) {
			paintAgentChatHalftone(context, this.width, this.height, this.pixelRatio);
		}
	}
}
