/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { WORKFLOW_NODE_COLORS, WorkflowNodeColor } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { setAgentTooltip } from '../../chrome/agentTooltip.js';
import { ScratchCamera } from '../../scratchBoard/scratchCamera.js';
import { IRect, unionRects, Vec } from './workflowCanvasGeometry.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const MAP_WIDTH = 168;
const MAP_HEIGHT = 104;

/** Theme colour behind each node colour; the canvas CSS uses the same variables. */
const COLOR_VARS: Record<WorkflowNodeColor, readonly [string, string]> = {
	default: ['--vscode-descriptionForeground', '#8b8b8b'],
	blue: ['--vscode-charts-blue', '#3794ff'],
	green: ['--vscode-charts-green', '#89d185'],
	yellow: ['--vscode-charts-yellow', '#cca700'],
	orange: ['--vscode-charts-orange', '#d18616'],
	red: ['--vscode-charts-red', '#f14c4c'],
	pink: ['--vscode-terminal-ansiMagenta', '#d670d6'],
	purple: ['--vscode-charts-purple', '#b180d7'],
	teal: ['--vscode-terminal-ansiCyan', '#29b8db'],
};

export interface IMinimapMark {
	readonly rect: IRect;
	readonly color: WorkflowNodeColor;
	readonly selected: boolean;
}

export interface IMinimapSource {
	readonly camera: ScratchCamera;
	marks(): readonly IMinimapMark[];
	/** Edge ends (port to handle), drawn as hairlines. */
	links(): readonly (readonly [Vec, Vec])[];
	focus(): void;
}

/**
 * The workflow in miniature, bottom right: node rectangles in their colours and the visible
 * area as a frame. Click or drag to travel. Redraws at most once a frame, and only when the
 * nodes or the camera changed.
 */
export class WorkflowMinimap extends Disposable {

	readonly element: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly viewport: HTMLElement;
	private colors: Record<WorkflowNodeColor, string> | undefined;
	private accent = '#3b82f6';
	private ink = '#888888';
	private marks: readonly IMinimapMark[] | undefined;
	private contentBounds: IRect | undefined;
	private extent: IRect = { x: -400, y: -250, width: 800, height: 500 };
	private scale = 1;
	private offset: Vec = [0, 0];
	private queued = false;
	private dragging = false;
	private visible = true;

	constructor(parent: HTMLElement, private readonly source: IMinimapSource, themeService: IThemeService) {
		super();
		this.element = append(parent, $('.volt-wf-minimap.volt-wf-chrome'));
		this.element.setAttribute('aria-label', localize('voltWorkflows.minimap', "Workflow overview"));
		this.canvas = append(this.element, $('canvas')) as HTMLCanvasElement;
		this.viewport = append(this.element, $('.volt-wf-minimap-view'));
		this._register(themeService.onDidColorThemeChange(() => {
			this.colors = undefined;
			this.invalidate();
		}));
		this._register(addDisposableListener(this.element, 'pointerdown', e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.element, 'pointermove', e => this.onPointerMove(e)));
		this._register(addDisposableListener(this.element, 'pointerup', e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.element, 'pointercancel', e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.element, 'wheel', e => {
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false }));
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.element.classList.toggle('hidden', !visible);
		if (visible) {
			this.invalidate();
		}
	}

	/** The nodes changed: read them again and redraw on the next frame. */
	invalidate(): void {
		this.marks = undefined;
		this.schedule();
	}

	/** The camera moved: move the frame (and re-fit the map when the view leaves it). */
	paintViewport(): void {
		if (!this.visible) {
			return;
		}
		if (!this.marks) {
			this.schedule();
			return;
		}
		const view = this.visibleWorld();
		const e = this.extent;
		const outside = view.x < e.x || view.y < e.y || view.x + view.width > e.x + e.width || view.y + view.height > e.y + e.height;
		if (outside && !this.dragging) {
			this.redraw();
			return;
		}
		this.placeViewport(view);
	}

	private schedule(): void {
		if (this.queued || !this.visible) {
			return;
		}
		this.queued = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.queued = false;
			this.redraw();
		});
	}

	private visibleWorld(): IRect {
		const camera = this.source.camera;
		const [x0, y0] = camera.screenToWorld([0, 0]);
		const [x1, y1] = camera.screenToWorld([camera.viewportWidth, camera.viewportHeight]);
		return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
	}

	private resolveColors(): Record<WorkflowNodeColor, string> {
		if (!this.colors) {
			const style = getWindow(this.element).getComputedStyle(this.element);
			const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
			this.colors = Object.fromEntries(WORKFLOW_NODE_COLORS.map(color => [color, read(...COLOR_VARS[color])])) as Record<WorkflowNodeColor, string>;
			this.accent = read('--vscode-focusBorder', '#3b82f6');
			this.ink = read('--vscode-foreground', '#888888');
		}
		return this.colors;
	}

	private toMap(x: number, y: number): Vec {
		return [this.offset[0] + (x - this.extent.x) * this.scale, this.offset[1] + (y - this.extent.y) * this.scale];
	}

	private redraw(): void {
		if (!this.visible) {
			return;
		}
		if (!this.marks) {
			this.marks = this.source.marks();
			this.contentBounds = unionRects(this.marks.map(mark => mark.rect));
		}
		const view = this.visibleWorld();
		const b = this.contentBounds ? unionRects([this.contentBounds, view])! : view;
		const pad = Math.max(b.width, b.height) * 0.06;
		this.extent = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
		this.scale = Math.min(MAP_WIDTH / Math.max(1, this.extent.width), MAP_HEIGHT / Math.max(1, this.extent.height));
		this.offset = [(MAP_WIDTH - this.extent.width * this.scale) / 2, (MAP_HEIGHT - this.extent.height * this.scale) / 2];
		const dpr = getWindow(this.element).devicePixelRatio || 1;
		const c = this.canvas;
		if (c.width !== Math.round(MAP_WIDTH * dpr) || c.height !== Math.round(MAP_HEIGHT * dpr)) {
			c.width = Math.round(MAP_WIDTH * dpr);
			c.height = Math.round(MAP_HEIGHT * dpr);
		}
		const ctx = c.getContext('2d');
		if (!ctx) {
			return;
		}
		const colors = this.resolveColors();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
		ctx.globalAlpha = 0.28;
		ctx.strokeStyle = this.ink;
		ctx.lineWidth = 1;
		ctx.beginPath();
		// Stepped like the canvas's edges: across, down, across.
		for (const [a, z] of this.source.links()) {
			const p = this.toMap(a[0], a[1]);
			const q = this.toMap(z[0], z[1]);
			const x = (p[0] + q[0]) / 2;
			ctx.moveTo(p[0], p[1]);
			ctx.lineTo(x, p[1]);
			ctx.lineTo(x, q[1]);
			ctx.lineTo(q[0], q[1]);
		}
		ctx.stroke();
		for (const mark of this.marks) {
			const [x, y] = this.toMap(mark.rect.x, mark.rect.y);
			const w = Math.max(2, mark.rect.width * this.scale);
			const h = Math.max(2, mark.rect.height * this.scale);
			ctx.globalAlpha = 0.7;
			ctx.fillStyle = colors[mark.color];
			ctx.fillRect(x, y, w, h);
			if (mark.selected) {
				ctx.globalAlpha = 1;
				ctx.strokeStyle = this.accent;
				ctx.lineWidth = 1.5;
				ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
			}
		}
		ctx.globalAlpha = 1;
		this.placeViewport(view);
	}

	private placeViewport(view: IRect): void {
		const [x0, y0] = this.toMap(view.x, view.y);
		const w = Math.max(6, view.width * this.scale);
		const h = Math.max(6, view.height * this.scale);
		this.viewport.style.transform = `translate(${x0}px, ${y0}px)`;
		this.viewport.style.width = `${w}px`;
		this.viewport.style.height = `${h}px`;
	}

	private toWorld(e: PointerEvent): Vec {
		const r = this.canvas.getBoundingClientRect();
		const mx = e.clientX - r.left, my = e.clientY - r.top;
		return [(mx - this.offset[0]) / this.scale + this.extent.x, (my - this.offset[1]) / this.scale + this.extent.y];
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.dragging = true;
		this.element.classList.add('dragging');
		this.element.setPointerCapture(e.pointerId);
		this.source.camera.centerOn(this.toWorld(e), true);
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.dragging) {
			e.stopPropagation();
			this.source.camera.centerOn(this.toWorld(e), false);
		}
	}

	private onPointerUp(e: PointerEvent): void {
		if (!this.dragging) {
			return;
		}
		this.dragging = false;
		this.element.classList.remove('dragging');
		if (this.element.hasPointerCapture(e.pointerId)) {
			this.element.releasePointerCapture(e.pointerId);
		}
		this.redraw();
		this.source.focus();
	}
}

export interface IZoomBarActions {
	zoomIn(): void;
	zoomOut(): void;
	resetZoom(): void;
	fitView(): void;
	toggleMinimap(): void;
	readonly minimapShown: boolean;
	focus(): void;
}

/** Bottom left: zoom out, the zoom level (click for 100%), zoom in, fit, and the overview toggle. */
export class WorkflowZoomBar extends Disposable {

	readonly element: HTMLElement;
	private readonly label: HTMLButtonElement;
	private readonly mapButton: HTMLButtonElement;

	constructor(parent: HTMLElement, private readonly actions: IZoomBarActions) {
		super();
		this.element = append(parent, $('.volt-wf-zoom.volt-wf-chrome'));
		const button = (icon: ThemeIcon, label: string, shortcut: string | undefined, run: () => void) => {
			const b = append(this.element, $('button.volt-wf-icon-button')) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.appendChild(renderIcon(icon));
			setAgentTooltip(b, label, shortcut, undefined, 'above');
			this._register(addDisposableListener(b, 'click', () => {
				run();
				this.actions.focus();
			}));
			return b;
		};
		button(Codicon.remove, localize('voltWorkflows.zoomOut', "Zoom out"), `${MOD}-`, () => actions.zoomOut());
		this.label = append(this.element, $('button.volt-wf-zoom-value')) as HTMLButtonElement;
		this.label.type = 'button';
		setAgentTooltip(this.label, localize('voltWorkflows.zoomReset', "Zoom to 100%"), isMacintosh ? '⇧0' : 'Shift+0', undefined, 'above');
		this._register(addDisposableListener(this.label, 'click', () => {
			actions.resetZoom();
			this.actions.focus();
		}));
		button(Codicon.add, localize('voltWorkflows.zoomIn', "Zoom in"), `${MOD}=`, () => actions.zoomIn());
		append(this.element, $('span.volt-wf-zoom-divider'));
		button(Codicon.screenFull, localize('voltWorkflows.fitView', "Fit to view"), isMacintosh ? '⇧1' : 'Shift+1', () => actions.fitView());
		this.mapButton = button(Codicon.map, localize('voltWorkflows.toggleMinimap', "Overview map"), undefined, () => {
			actions.toggleMinimap();
			this.refresh(undefined);
		});
	}

	refresh(zoom: number | undefined): void {
		const text = zoom !== undefined ? `${Math.round(zoom * 100)}%` : undefined;
		if (text !== undefined && text !== this.label.textContent) {
			this.label.textContent = text;
		}
		this.mapButton.classList.toggle('active', this.actions.minimapShown);
		this.mapButton.setAttribute('aria-pressed', String(this.actions.minimapShown));
	}
}
