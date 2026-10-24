/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { darkModeColor, withAlpha } from '../../common/scratchBoard/scratchColor.js';
import { elementBounds, linearWorldPoints } from '../../common/scratchBoard/scratchGeometry.js';
import { unionBounds, Vec } from '../../common/scratchBoard/scratchMath.js';
import { IScratchBounds, isLinear, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { scratchIcon } from './scratchIcons.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const MAP_WIDTH = 208;
const MAP_HEIGHT = 136;
const MINIMAP_KEY = 'volt.scratchBoard.minimap';

function sameBounds(a: IScratchBounds, b: IScratchBounds): boolean {
	return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

/** Zoom out, the zoom level (click for 100%), zoom in; then undo and redo. Bottom left. */
export class ScratchZoomBar extends Disposable {

	private readonly zoomLabel: HTMLButtonElement;
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;

	constructor(parent: HTMLElement, private readonly canvas: ScratchCanvas) {
		super();
		const root = append(parent, $('.sx-bottom-left.sx-chrome-item'));
		const zoom = append(root, $('.sx-zoom.sx-panel'));
		const button = (host: HTMLElement, icon: string, label: string, shortcut: string | undefined, run: () => void) => {
			const b = append(host, $('button.sx-icon-button')) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.appendChild(scratchIcon(parent.ownerDocument, icon, { size: 14 }));
			setAgentTooltip(b, label, shortcut, undefined, 'above');
			this._register(addDisposableListener(b, 'click', () => {
				run();
				this.canvas.focus();
			}));
			return b;
		};
		button(zoom, 'minus', localize('voltScratch.zoomOut', "Zoom out"), `${MOD}-`, () => this.canvas.camera.zoomStep(-1));
		this.zoomLabel = append(zoom, $('button.sx-zoom-value')) as HTMLButtonElement;
		this.zoomLabel.type = 'button';
		setAgentTooltip(this.zoomLabel, localize('voltScratch.zoomReset', "Reset zoom"), 'Shift+0', undefined, 'above');
		this._register(addDisposableListener(this.zoomLabel, 'click', () => this.canvas.resetZoom()));
		button(zoom, 'plus', localize('voltScratch.zoomIn', "Zoom in"), `${MOD}+`, () => this.canvas.camera.zoomStep(1));
		button(zoom, 'scan', localize('voltScratch.zoomFit', "Zoom to fit"), 'Shift+1', () => this.canvas.zoomToFit());
		const history = append(root, $('.sx-history.sx-panel'));
		this.undoButton = button(history, 'undo-2', localize('voltScratch.undo', "Undo"), `${MOD}Z`, () => this.canvas.undo());
		this.redoButton = button(history, 'redo-2', localize('voltScratch.redo', "Redo"), isMacintosh ? '⇧⌘Z' : 'Ctrl+Y', () => this.canvas.redo());
		this.refresh();
	}

	refresh(): void {
		this.zoomLabel.textContent = `${Math.round(this.canvas.camera.zoom * 100)}%`;
		const scene = this.canvas.scene;
		this.undoButton.disabled = !scene?.canUndo;
		this.redoButton.disabled = !scene?.canRedo;
		const undoLabel = scene?.undoLabel;
		const redoLabel = scene?.redoLabel;
		setAgentTooltip(this.undoButton, undoLabel ? localize('voltScratch.undoWhat', "Undo {0}", undoLabel) : localize('voltScratch.undo', "Undo"), `${MOD}Z`, undefined, 'above');
		setAgentTooltip(this.redoButton, redoLabel ? localize('voltScratch.redoWhat', "Redo {0}", redoLabel) : localize('voltScratch.redo', "Redo"), isMacintosh ? '⇧⌘Z' : 'Ctrl+Y', undefined, 'above');
	}
}

/**
 * The whole board in miniature, bottom right: everything drawn as simple marks, the visible
 * area as a frame. Click or drag in it to travel.
 */
export class ScratchMinimap extends Disposable {

	private readonly root: HTMLElement;
	private readonly content: HTMLCanvasElement;
	private readonly viewport: HTMLElement;
	private readonly toggleButton: HTMLButtonElement;
	private extent: IScratchBounds = { minX: -500, minY: -300, maxX: 500, maxY: 300 };
	private scale = 1;
	private offset: Vec = [0, 0];
	private collapsed: boolean;
	private redrawQueued = false;
	private dragging = false;
	/** Each element with its bounds, kept until the scene changes so panning does not measure them again. */
	private marks: { readonly el: ScratchElement; readonly bounds: IScratchBounds }[] | undefined;
	private contentBounds: IScratchBounds | undefined;

	constructor(parent: HTMLElement, private readonly canvas: ScratchCanvas, @IStorageService private readonly storageService: IStorageService) {
		super();
		this.collapsed = storageService.getBoolean(MINIMAP_KEY, StorageScope.PROFILE, false);
		this.root = append(parent, $('.sx-minimap.sx-panel.sx-chrome-item'));
		this.root.setAttribute('aria-label', localize('voltScratch.minimap', "Board overview"));
		const doc = parent.ownerDocument;
		this.content = append(this.root, $('canvas.sx-minimap-canvas')) as HTMLCanvasElement;
		this.viewport = append(this.root, $('.sx-minimap-viewport'));
		this.toggleButton = append(this.root, $('button.sx-icon-button.sx-minimap-toggle')) as HTMLButtonElement;
		this.toggleButton.type = 'button';
		this.toggleButton.appendChild(scratchIcon(doc, 'map', { size: 14 }));
		this._register(addDisposableListener(this.toggleButton, 'click', e => {
			e.stopPropagation();
			this.setCollapsed(!this.collapsed);
		}));
		this._register(addDisposableListener(this.root, 'pointerdown', e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.root, 'pointermove', e => this.onPointerMove(e)));
		this._register(addDisposableListener(this.root, 'pointerup', e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.root, 'pointercancel', e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.root, 'wheel', e => {
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false }));
		this.setCollapsed(this.collapsed);
	}

	private setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.root.classList.toggle('collapsed', collapsed);
		this.storageService.store(MINIMAP_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
		const label = collapsed ? localize('voltScratch.showMinimap', "Show overview") : localize('voltScratch.hideMinimap', "Hide overview");
		this.toggleButton.setAttribute('aria-label', label);
		setAgentTooltip(this.toggleButton, label, undefined, undefined, 'above');
		if (!collapsed) {
			this.refresh();
		}
	}

	layout(): void {
		this.refresh();
	}

	/** Redraws the marks (scene changed). Batched to one per frame. */
	refresh(): void {
		this.marks = undefined;
		if (this.redrawQueued || this.collapsed) {
			return;
		}
		this.redrawQueued = true;
		getWindow(this.root).requestAnimationFrame(() => {
			this.redrawQueued = false;
			this.redraw();
		});
	}

	/** The board and the view with a margin: the map follows the camera every frame, so it never jumps. */
	private extentFor(view: IScratchBounds): IScratchBounds {
		const b = this.contentBounds ? unionBounds([this.contentBounds, view])! : view;
		const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
		const pad = Math.max(w, h) * 0.06;
		return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
	}

	private setExtent(extent: IScratchBounds): void {
		this.extent = extent;
		const ew = extent.maxX - extent.minX, eh = extent.maxY - extent.minY;
		this.scale = Math.min(MAP_WIDTH / ew, MAP_HEIGHT / eh);
		this.offset = [(MAP_WIDTH - ew * this.scale) / 2, (MAP_HEIGHT - eh * this.scale) / 2];
	}

	private toMap(p: Vec): Vec {
		return [this.offset[0] + (p[0] - this.extent.minX) * this.scale, this.offset[1] + (p[1] - this.extent.minY) * this.scale];
	}

	private toWorld(p: Vec): Vec {
		return [(p[0] - this.offset[0]) / this.scale + this.extent.minX, (p[1] - this.offset[1]) / this.scale + this.extent.minY];
	}

	private redraw(): void {
		if (this.collapsed) {
			return;
		}
		if (!this.marks) {
			const scene = this.canvas.scene;
			this.marks = scene ? scene.getElements().map(el => ({ el, bounds: elementBounds(el) })) : [];
			this.contentBounds = this.marks.length ? unionBounds(this.marks.map(m => m.bounds)) : undefined;
		}
		this.setExtent(this.extentFor(this.canvas.camera.visibleBounds()));
		const win = getWindow(this.root);
		const dpr = win.devicePixelRatio || 1;
		const c = this.content;
		if (c.width !== Math.round(MAP_WIDTH * dpr) || c.height !== Math.round(MAP_HEIGHT * dpr)) {
			c.width = Math.round(MAP_WIDTH * dpr);
			c.height = Math.round(MAP_HEIGHT * dpr);
		}
		const ctx = c.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
		const dark = this.canvas.isDarkBoard;
		const map = (color: string) => dark ? darkModeColor(color) : color;
		for (const { el, bounds: b } of this.marks) {
			const [x0, y0] = this.toMap([b.minX, b.minY]);
			const [x1, y1] = this.toMap([b.maxX, b.maxY]);
			const w = Math.max(1.5, x1 - x0), h = Math.max(1.5, y1 - y0);
			const ink = map(el.stroke);
			if (isLinear(el)) {
				const pts = linearWorldPoints(el).map(p => this.toMap(p));
				ctx.strokeStyle = withAlpha(ink, 0.75);
				ctx.lineWidth = 1;
				ctx.beginPath();
				pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
				ctx.stroke();
			} else if (el.type === 'draw') {
				ctx.fillStyle = withAlpha(ink, 0.45);
				ctx.fillRect(x0, y0, w, h);
			} else if (el.type === 'frame') {
				ctx.strokeStyle = withAlpha(ink, 0.6);
				ctx.lineWidth = 1;
				ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
			} else if (el.type === 'note') {
				ctx.fillStyle = map(el.fill);
				ctx.fillRect(x0, y0, w, h);
			} else if (el.type === 'image') {
				ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.18)';
				ctx.fillRect(x0, y0, w, h);
			} else if (el.type === 'text' || el.type === 'card') {
				ctx.fillStyle = withAlpha(ink, el.type === 'card' ? 0.18 : 0.4);
				ctx.fillRect(x0, y0, w, Math.max(1.5, el.type === 'card' ? h : Math.min(h, 3)));
			} else {
				ctx.fillStyle = el.fill !== 'transparent' ? withAlpha(map(el.fill), 0.85) : withAlpha(ink, 0.12);
				ctx.fillRect(x0, y0, w, h);
				ctx.strokeStyle = withAlpha(ink, 0.7);
				ctx.lineWidth = 1;
				ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0.5, w - 1), Math.max(0.5, h - 1));
			}
		}
		this.paintViewport(true);
	}

	/**
	 * Moves the viewport frame (camera moved). The map re-fits in the same frame when the view
	 * changes its extent; the marks are cached, so that is one pass of rectangles.
	 */
	paintViewport(fromRedraw = false): void {
		if (this.collapsed) {
			return;
		}
		const view = this.canvas.camera.visibleBounds();
		if (!fromRedraw && this.marks) {
			// Dragging in the map keeps it still under the pointer unless the view leaves it; it re-fits on release.
			const outside = view.minX < this.extent.minX || view.minY < this.extent.minY || view.maxX > this.extent.maxX || view.maxY > this.extent.maxY;
			if (!this.dragging || outside) {
				const next = this.extentFor(view);
				if (!sameBounds(next, this.extent)) {
					this.redraw();
					return;
				}
			}
		}
		const [x0, y0] = this.toMap([view.minX, view.minY]);
		const [x1, y1] = this.toMap([view.maxX, view.maxY]);
		this.viewport.style.transform = `translate(${x0}px, ${y0}px)`;
		this.viewport.style.width = `${Math.max(4, x1 - x0)}px`;
		this.viewport.style.height = `${Math.max(4, y1 - y0)}px`;
	}

	private local(e: PointerEvent): Vec {
		const r = this.content.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}

	private onPointerDown(e: PointerEvent): void {
		if (this.collapsed || (e.target as HTMLElement).closest('.sx-minimap-toggle')) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.dragging = true;
		this.root.setPointerCapture(e.pointerId);
		this.canvas.camera.centerOn(this.toWorld(this.local(e)), true);
	}

	private onPointerMove(e: PointerEvent): void {
		if (!this.dragging) {
			return;
		}
		e.stopPropagation();
		this.canvas.camera.centerOn(this.toWorld(this.local(e)), false);
	}

	private onPointerUp(e: PointerEvent): void {
		if (!this.dragging) {
			return;
		}
		this.dragging = false;
		if (this.root.hasPointerCapture(e.pointerId)) {
			this.root.releasePointerCapture(e.pointerId);
		}
		this.refresh();
		this.canvas.focus();
	}
}
