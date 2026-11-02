/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../media/agentWorkflowCanvas.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { localize } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { autoLayout as layoutGraph } from '../../../../../services/voltRuntime/common/workflows/workflowGraph.js';
import { getWorkflowNodeType, nodeInputs } from '../../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { parseWorkflowYaml, serializeWorkflow } from '../../../../../services/voltRuntime/common/workflows/workflowSchema.js';
import { IWorkflowDefinition, IWorkflowEdge, IWorkflowGroup, IWorkflowIssue, IWorkflowNode, IWorkflowPosition, IWorkflowRun, WorkflowNodeColor, WorkflowPortKind } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { edgeId, WorkflowEditorModel } from '../../../common/workflows/workflowEditorModel.js';
import { ScratchCamera } from '../../scratchBoard/scratchCamera.js';
import { svg, WorkflowEdgeView } from './workflowCanvasEdges.js';
import { EmptyBranch, WorkflowEmptyState } from './workflowCanvasEmpty.js';
import { canvasLayoutOptions, CARD_WIDTH, FIRST_PORT_Y, GRID, HEAD_HEIGHT, IEdgeRoute, IRect, layoutNode, nodeBounds, nodeRect, PORT_ROW, PORTS_PAD, rectsIntersect, routeEdge, routeToPointer, snap, unionRects, Vec } from './workflowCanvasGeometry.js';
import { IWorkflowCanvasMenuHost, showCanvasMenu, showEdgeMenu, showGroupMenu, showNodeMenu } from './workflowCanvasMenus.js';
import { IMinimapMark, WorkflowMinimap, WorkflowZoomBar } from './workflowCanvasMinimap.js';
import { colorClass, INodeRunView, nodeColor, runViews, WorkflowNodeView } from './workflowCanvasNodes.js';
import { WorkflowEdgeTools, WorkflowNodeToolbar } from './workflowCanvasToolbar.js';

/**
 * A request to add a block. `at` is the suggested top-left of the new node in world px (already
 * clear of other nodes and snapped where that keeps edges straight); `client` is where a picker
 * should open. `from` connects the new node after that port; `splitEdgeId` puts it on that edge.
 */
export interface IWorkflowCanvasAddRequest {
	readonly at: IWorkflowPosition;
	readonly client: { readonly x: number; readonly y: number };
	readonly from?: { readonly nodeId: string; readonly port: string };
	readonly splitEdgeId?: string;
	readonly via: 'port' | 'drop' | 'edge' | 'menu' | 'keyboard' | 'empty';
}

export interface IWorkflowCanvasOptions {
	/** Template previews: pan and zoom only, fitted on every layout. */
	readonly readOnly?: boolean;
	/** False: no overview map at all. */
	readonly minimap?: boolean;
	/** Show the Describe / Add blocks / Browse templates branches while only the start node exists. */
	readonly emptyState?: boolean;
}

const SNAP_KEY = 'volt.workflows.canvas.snapToGrid';
const MINIMAP_KEY = 'volt.workflows.canvas.minimap';
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
const ZOOM_STEPS = [0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
/** The zoom a big workflow opens at: labels readable (they turn into bars under 45%). */
const OPEN_MIN_ZOOM = 0.6;
/** Screen px a press must travel before it is a drag. */
const DRAG_THRESHOLD = 3;
/** Screen px within which a dragged connection snaps to an input handle. */
const SNAP_RADIUS = 24;
/** Below these zooms port labels and summaries, then titles, hide (one class on the root). */
const LOD_LOW = 0.45;
const LOD_MIN = 0.25;
/** A new block's height for spacing suggestions: a card with two ports. */
const NEW_CARD_HEIGHT = HEAD_HEIGHT + PORTS_PAD * 2 + PORT_ROW * 2;
/** Dragging near the canvas edge pans it. */
const EDGE_PAN_ZONE = 32;
const EDGE_PAN_SPEED = 16;
const LAYOUT_ANIMATION_MS = 300;
/** World margin of the edge layer's box around the nodes (loops run outside them). */
const EDGE_LAYER_MARGIN = 240;
/** How far the dot grid layer reaches past the view on each side (agentWorkflowCanvas.css). */
const GRID_LAYER_PAD = 64;

type Client = { readonly x: number; readonly y: number };

type PressTarget =
	| { readonly kind: 'node'; readonly nodeId: string; readonly wasSelected: boolean; readonly toggledOff: boolean }
	| { readonly kind: 'group'; readonly groupId: string }
	| { readonly kind: 'edge'; readonly edgeId: string }
	| { readonly kind: 'empty' };

type Gesture =
	| { readonly kind: 'pan'; readonly pointerId: number; last: Vec }
	| { readonly kind: 'press'; readonly pointerId: number; readonly start: Vec; readonly startWorld: Vec; readonly target: PressTarget; readonly additive: boolean }
	| { readonly kind: 'move'; readonly pointerId: number; readonly ids: readonly string[]; readonly origins: ReadonlyMap<string, IWorkflowPosition>; readonly anchor: string; readonly startWorld: Vec; readonly edges: ReadonlySet<string>; readonly groups: ReadonlySet<string>; delta: Vec }
	| { readonly kind: 'marquee'; readonly pointerId: number; readonly startWorld: Vec; currentWorld: Vec; readonly additive: boolean; readonly base: ReadonlySet<string>; preview: ReadonlySet<string> }
	| {
		readonly kind: 'connect'; readonly pointerId: number; readonly from: { readonly nodeId: string; readonly port: string }; readonly portKind: WorkflowPortKind;
		readonly start: Vec; pointer: Vec; moved: boolean; readonly viaPlus: boolean; readonly detach?: IWorkflowEdge; target?: string; invalid?: string;
	};

interface IGroupView {
	readonly frame: HTMLElement;
	readonly title: HTMLElement;
	group: IWorkflowGroup;
}

interface IClipboardContent {
	readonly text: string;
	readonly nodes: readonly IWorkflowNode[];
	readonly edges: readonly IWorkflowEdge[];
	readonly groups: readonly IWorkflowGroup[];
}

function isTextInput(target: EventTarget | null): boolean {
	return isHTMLElement(target) && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
}

function closestIn(target: EventTarget | null, selector: string): HTMLElement | SVGElement | undefined {
	const el = target as Element | null;
	return (el?.closest?.(selector) as HTMLElement | SVGElement | null) ?? undefined;
}

function isStartType(node: IWorkflowNode): boolean {
	return getWorkflowNodeType(node.type)?.control === 'start';
}

function withColor(node: IWorkflowNode, color: WorkflowNodeColor | undefined): IWorkflowNode {
	const { color: _old, ...rest } = node;
	return color ? { ...rest, color } : rest;
}

function withDisabled(node: IWorkflowNode, disabled: boolean): IWorkflowNode {
	const { disabled: _old, ...rest } = node;
	return disabled ? { ...rest, disabled: true } : rest;
}

/**
 * The workflow canvas: an infinite dotted plane with pan and zoom (the Scratch board's camera),
 * DOM nodes in world coordinates under one `translate() scale()`, edges as paths in one SVG,
 * group frames behind them. Every edit goes through the editor model, so undo, the inspector and
 * the YAML stay in step. Pointer moves are coalesced to one update per frame and never read
 * layout: node sizes are computed (`workflowCanvasGeometry.ts`), not measured.
 */
export class WorkflowCanvas extends Disposable implements IWorkflowCanvasMenuHost {

	/** The last nodes copied from any canvas in this window, with the text put on the clipboard. */
	private static clipboard: IClipboardContent | undefined;

	private readonly _onDidRequestAddNode = this._register(new Emitter<IWorkflowCanvasAddRequest>());
	readonly onDidRequestAddNode: Event<IWorkflowCanvasAddRequest> = this._onDidRequestAddNode.event;
	private readonly _onDidRequestOpenNode = this._register(new Emitter<string>());
	readonly onDidRequestOpenNode: Event<string> = this._onDidRequestOpenNode.event;
	private readonly _onDidRequestNodeAction = this._register(new Emitter<{ readonly nodeId: string; readonly action: 'run' | 'ai' | 'input' | 'output' }>());
	readonly onDidRequestNodeAction: Event<{ readonly nodeId: string; readonly action: 'run' | 'ai' | 'input' | 'output' }> = this._onDidRequestNodeAction.event;
	private readonly _onDidRequestEmptyAction = this._register(new Emitter<'describe' | 'templates'>());
	readonly onDidRequestEmptyAction: Event<'describe' | 'templates'> = this._onDidRequestEmptyAction.event;
	private readonly _onDidRequestChangeTrigger = this._register(new Emitter<HTMLElement>());
	readonly onDidRequestChangeTrigger: Event<HTMLElement> = this._onDidRequestChangeTrigger.event;
	private readonly _onDidChangeViewport = this._register(new Emitter<void>());
	readonly onDidChangeViewport: Event<void> = this._onDidChangeViewport.event;

	readonly camera: ScratchCamera;
	private readonly readOnly: boolean;
	private readonly root: HTMLElement;
	private readonly grid: HTMLElement;
	private gridStep = 0;
	private readonly world: HTMLElement;
	private readonly groupsLayer: HTMLElement;
	private readonly edgeSvg: SVGSVGElement;
	private readonly edgeBadges: HTMLElement;
	private readonly nodesLayer: HTMLElement;
	private readonly liveSvg: SVGSVGElement;
	private liveClass = 'volt-wf-live hidden';
	private readonly livePath: SVGPathElement;
	private readonly liveArrow: SVGPathElement;
	private readonly liveEnd: SVGCircleElement;
	private readonly overlay: HTMLElement;
	private readonly marquee: HTMLElement;
	private marqueeShown = false;
	private readonly toolbar: WorkflowNodeToolbar;
	private readonly edgeTools: WorkflowEdgeTools;
	private readonly zoomBar: WorkflowZoomBar | undefined;
	private readonly minimap: WorkflowMinimap | undefined;
	private readonly emptyState: WorkflowEmptyState;

	private definition: IWorkflowDefinition;
	private readonly views = new Map<string, WorkflowNodeView>();
	private readonly edgeViews = new Map<string, WorkflowEdgeView>();
	private readonly groupViews = new Map<string, IGroupView>();
	/** Edge ids by node id (either end). */
	private readonly adjacency = new Map<string, Set<string>>();
	/** Group ids by member node id. */
	private readonly groupsOf = new Map<string, Set<string>>();
	/** Positions shown instead of the model's during a drag or a layout animation. */
	private readonly overrides = new Map<string, IWorkflowPosition>();
	private readonly selectedEdges = new Set<string>();
	private hoverEdge: string | undefined;
	private edgeBox: IRect = { x: 0, y: 0, width: 0, height: 0 };
	private obstacleCache: IRect[] | undefined;

	private runId: string | undefined;
	private runViewMap = new Map<string, INodeRunView>();
	private traversed = new Set<string>();
	private nodeIssues = new Map<string, IWorkflowIssue[]>();
	private edgeIssues = new Map<string, IWorkflowIssue[]>();

	private gesture: Gesture | undefined;
	private pointer: { client: Vec; shift: boolean; mod: boolean } | undefined;
	private pointerInside = false;
	private spaceHeld = false;
	private rect: { left: number; top: number } = { left: 0, top: 0 };
	private rectAt = 0;
	private width = 0;
	private height = 0;
	private fitted = false;
	private frameHandle: number | undefined;
	private cameraDirty = true;
	private pointerDirty = false;
	private overlayDirty = true;
	private lod = 0;
	private gestureTimer: number | undefined;
	private gesturing = false;
	private layoutAnimation: number | undefined;
	private pending: { readonly from: { readonly nodeId: string; readonly port: string }; readonly kind: WorkflowPortKind; readonly point: Vec } | undefined;
	private readonly pendingListeners = this._register(new DisposableStore());
	private renaming: { readonly input: HTMLInputElement; readonly commit: (keep: boolean) => void } | undefined;
	private lastPaste: { readonly at: Vec; count: number } | undefined;
	private snapValue: boolean;
	private minimapValue: boolean;
	private readonly reducedMotion: boolean;

	constructor(
		container: HTMLElement,
		private readonly model: WorkflowEditorModel,
		private readonly options: IWorkflowCanvasOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IStorageService private readonly storageService: IStorageService,
		@IThemeService themeService: IThemeService,
	) {
		super();
		this.readOnly = !!options.readOnly;
		this.snapValue = storageService.getBoolean(SNAP_KEY, StorageScope.PROFILE, true);
		this.minimapValue = options.minimap !== false && !this.readOnly && storageService.getBoolean(MINIMAP_KEY, StorageScope.PROFILE, true);
		this.definition = model.definition;
		const doc = container.ownerDocument;
		this.reducedMotion = !!getWindow(container).matchMedia?.('(prefers-reduced-motion: reduce)').matches;

		this.root = append(container, $('.volt-wf-canvas'));
		this.root.tabIndex = 0;
		this.root.setAttribute('role', 'application');
		this.root.setAttribute('aria-label', localize('voltWorkflows.canvas', "Workflow canvas"));
		this.root.classList.toggle('read-only', this.readOnly);
		this._register(toDisposable(() => this.root.remove()));

		this.grid = append(this.root, $('.volt-wf-grid'));
		this.world = append(this.root, $('.volt-wf-world'));
		this.groupsLayer = append(this.world, $('.volt-wf-groups'));
		this.edgeSvg = append(this.world, svg(doc, 'svg', 'volt-wf-edges'));
		this.edgeBadges = append(this.world, $('.volt-wf-edge-badges'));
		this.emptyState = this._register(new WorkflowEmptyState(this.world, (branch, button) => this.onEmptyPick(branch, button)));
		this.nodesLayer = append(this.world, $('.volt-wf-nodes'));
		this.liveSvg = append(this.world, svg(doc, 'svg', 'volt-wf-live hidden'));
		this.livePath = this.liveSvg.appendChild(svg(doc, 'path', 'line'));
		this.liveArrow = this.liveSvg.appendChild(svg(doc, 'path', 'arrow'));
		this.liveEnd = this.liveSvg.appendChild(svg(doc, 'circle', 'end'));
		this.liveEnd.setAttribute('r', '4');

		this.overlay = append(this.root, $('.volt-wf-overlay'));
		append(this.overlay, $('.volt-wf-shield'));
		this.marquee = append(this.overlay, $('.volt-wf-marquee.hidden'));
		this.toolbar = this._register(new WorkflowNodeToolbar(this.overlay, {
			configure: id => this._onDidRequestOpenNode.fire(id),
			run: id => this._onDidRequestNodeAction.fire({ nodeId: id, action: 'run' }),
			ai: id => this._onDidRequestNodeAction.fire({ nodeId: id, action: 'ai' }),
			setColor: (id, color) => this.setColor([id], color),
			toggleDisabled: id => this.setDisabled([id], !this.model.node(id)?.disabled),
			duplicate: id => this.duplicate([id]),
			more: (id, anchor) => {
				const node = this.model.node(id);
				if (node) {
					showNodeMenu(this.contextViewService, doc, anchor, this, node, getWorkflowNodeType(node.type), this.model.selection);
				}
			},
			io: (id, which) => this._onDidRequestNodeAction.fire({ nodeId: id, action: which }),
			focus: () => this.focus(),
		}));
		this.edgeTools = this._register(new WorkflowEdgeTools(this.overlay,
			(id, button) => this.insertOnEdge(id, this.centerOf(button)),
			id => this.removeEdge(id),
			() => this.setHoverEdge(undefined)));

		this.camera = this._register(new ScratchCamera(this.root));
		this._register(this.camera.onDidChange(() => {
			this.markGesturing();
			this.cameraDirty = true;
			this.overlayDirty = true;
			this.requestFrame();
		}));
		if (!this.readOnly) {
			const canvas = this;
			this.zoomBar = this._register(new WorkflowZoomBar(this.root, {
				zoomIn: () => this.zoomIn(),
				zoomOut: () => this.zoomOut(),
				resetZoom: () => this.resetZoom(),
				fitView: () => this.fitView(true),
				toggleMinimap: () => this.showMinimap = !this.showMinimap,
				get minimapShown() { return canvas.showMinimap; },
				focus: () => this.focus(),
			}));
		}
		if (options.minimap !== false && !this.readOnly) {
			this.minimap = this._register(new WorkflowMinimap(this.root, {
				camera: this.camera,
				marks: () => this.minimapMarks(),
				links: () => this.minimapLinks(),
				focus: () => this.focus(),
			}, themeService));
			this.minimap.setVisible(this.minimapValue);
		}
		this.zoomBar?.refresh(this.camera.zoom);
		this.root.classList.toggle('with-minimap', !!this.minimap && this.minimapValue);

		this.installInput();
		this._register(model.onDidChange(change => {
			this.clearPendingConnection();
			if (this.renaming && change.source !== 'canvas') {
				this.renaming.commit(false);
			}
			this.sync(change.definition);
		}));
		this._register(model.onDidChangeSelection(() => this.applySelection()));
		this._register(toDisposable(() => {
			const win = getWindow(this.root);
			if (this.frameHandle !== undefined) {
				win.cancelAnimationFrame(this.frameHandle);
			}
			if (this.layoutAnimation !== undefined) {
				win.cancelAnimationFrame(this.layoutAnimation);
			}
			if (this.gestureTimer !== undefined) {
				win.clearTimeout(this.gestureTimer);
			}
			for (const view of this.edgeViews.values()) {
				view.dispose();
			}
		}));
		this.sync(this.definition);
		this.applySelection();
	}

	//#region Public API

	setRunState(run: IWorkflowRun | undefined): void {
		const views = runViews(run);
		this.runViewMap = views;
		for (const [id, view] of this.views) {
			view.setRun(views.get(id));
		}
		const live = !!run && (run.status === 'running' || run.status === 'queued' || run.status === 'paused' || run.status === 'waiting');
		const firstLook = run?.id !== this.runId;
		if (firstLook) {
			for (const id of this.traversed) {
				this.edgeViews.get(id)?.setFlag('traversed', false);
			}
			this.traversed = new Set();
			this.runId = run?.id;
		}
		const next = new Set(run?.traversed ?? []);
		for (const id of next) {
			if (!this.traversed.has(id)) {
				const view = this.edgeViews.get(id);
				view?.setFlag('traversed', true);
				// A finished run opened from history shows its path without replaying it.
				if (view && live && !this.reducedMotion) {
					view.flow();
				}
			}
		}
		for (const id of this.traversed) {
			if (!next.has(id)) {
				this.edgeViews.get(id)?.setFlag('traversed', false);
			}
		}
		this.traversed = next;
		this.overlayDirty = true;
		this.requestFrame();
	}

	setIssues(issues: readonly IWorkflowIssue[]): void {
		this.nodeIssues = new Map();
		this.edgeIssues = new Map();
		for (const issue of issues) {
			if (issue.edgeId) {
				const list = this.edgeIssues.get(issue.edgeId) ?? [];
				list.push(issue);
				this.edgeIssues.set(issue.edgeId, list);
			} else if (issue.nodeId) {
				const list = this.nodeIssues.get(issue.nodeId) ?? [];
				list.push(issue);
				this.nodeIssues.set(issue.nodeId, list);
			}
		}
		for (const [id, view] of this.views) {
			view.setIssues(this.nodeIssues.get(id) ?? []);
		}
		for (const [id, view] of this.edgeViews) {
			view.setIssues(this.edgeIssues.get(id) ?? []);
		}
	}

	fitView(animate = true): void {
		if (!this.width || !this.height) {
			// Not laid out yet: the first layout fits.
			this.fitted = false;
			return;
		}
		const bounds = this.contentBounds();
		if (!bounds) {
			this.camera.set({ x: this.width / 2, y: this.height / 2, zoom: 1 });
			return;
		}
		this.camera.fit({ minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.width, maxY: bounds.y + bounds.height }, this.readOnly ? 24 : 72, 1, animate && !this.reducedMotion);
	}

	/**
	 * The first view of an editable workflow: the whole graph when it fits at a readable zoom; a big
	 * one opens readable instead, its start at the left (Fit still shows it all).
	 */
	private openView(): void {
		const bounds = this.contentBounds();
		if (!bounds) {
			this.fitView(false);
			return;
		}
		const pad = 72;
		const fit = Math.min((this.width - pad * 2) / Math.max(1, bounds.width), (this.height - pad * 2) / Math.max(1, bounds.height), 1);
		if (fit >= OPEN_MIN_ZOOM) {
			this.fitView(false);
			return;
		}
		const zoom = OPEN_MIN_ZOOM;
		this.camera.set({ x: pad - bounds.x * zoom, y: this.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom });
	}

	zoomIn(): void {
		const z = this.camera.zoom;
		this.camera.zoomAt(ZOOM_STEPS.find(step => step > z + 1e-6) ?? MAX_ZOOM, [this.width / 2, this.height / 2], !this.reducedMotion);
	}

	zoomOut(): void {
		const z = this.camera.zoom;
		this.camera.zoomAt([...ZOOM_STEPS].reverse().find(step => step < z - 1e-6) ?? MIN_ZOOM, [this.width / 2, this.height / 2], !this.reducedMotion);
	}

	resetZoom(): void {
		this.camera.zoomAt(1, [this.width / 2, this.height / 2], !this.reducedMotion);
	}

	/** Lays the graph out (or only the selection) with measured sizes, as one undo step, animated. */
	autoLayout(onlySelection = false): void {
		if (this.readOnly) {
			return;
		}
		this.finishLayoutAnimation();
		const definition = this.model.definition;
		const only = onlySelection && this.model.selection.length > 1 ? new Set(this.model.selection) : undefined;
		let positions: ReadonlyMap<string, IWorkflowPosition>;
		try {
			// The same sizes and gaps the templates were laid out with. No snapping: nodes line up by
			// where their edges meet them (straight chains), which a grid on their corners would undo;
			// the columns land on the grid anyway (widths and gaps are multiples of it).
			positions = layoutGraph(definition, canvasLayoutOptions(definition, only));
		} catch {
			return;
		}
		const moves: { id: string; position: IWorkflowPosition }[] = [];
		const from = new Map<string, IWorkflowPosition>();
		for (const [id, position] of positions) {
			const node = this.model.node(id);
			if (!node || (only && !only.has(id)) || (position.x === node.position.x && position.y === node.position.y)) {
				continue;
			}
			moves.push({ id, position: { x: Math.round(position.x), y: Math.round(position.y) } });
			from.set(id, this.positionOf(id));
		}
		if (!moves.length) {
			return;
		}
		// Keep showing the old spots while the model takes the new ones, then glide over.
		for (const [id, position] of from) {
			this.overrides.set(id, position);
		}
		this.model.moveNodes(moves, undefined, 'layout', localize('voltWorkflows.autoLayoutUndo', "Auto-layout"));
		this.animateLayout(from, new Map(moves.map(move => [move.id, move.position])));
		if (!only) {
			const rects = [...this.views.values()].map(view => nodeBounds(this.model.node(view.id)?.position ?? view.node.position, view.layout));
			const bounds = unionRects([...rects, ...(this.emptyState.bounds() ? [this.emptyState.bounds()!] : [])]);
			if (bounds) {
				this.camera.fit({ minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.width, maxY: bounds.y + bounds.height }, 72, 1, !this.reducedMotion);
			}
		}
	}

	revealNode(nodeId: string, select = false): void {
		const view = this.views.get(nodeId);
		if (!view) {
			return;
		}
		const b = nodeBounds(this.positionOf(nodeId), view.layout);
		if (!this.width || !this.height) {
			if (select) {
				this.model.setSelection([nodeId]);
			}
			return;
		}
		const [x0, y0] = this.camera.screenToWorld([40, 40]);
		const [x1, y1] = this.camera.screenToWorld([this.width - 40, this.height - 40]);
		if (b.x < x0 || b.y < y0 || b.x + b.width > x1 || b.y + b.height > y1) {
			this.camera.centerOn([b.x + b.width / 2, b.y + b.height / 2], !this.reducedMotion);
		}
		if (select) {
			this.selectedEdges.clear();
			this.model.setSelection([nodeId]);
		}
	}

	clientToWorld(x: number, y: number): IWorkflowPosition {
		this.refreshRect(true);
		const [wx, wy] = this.camera.screenToWorld([x - this.rect.left, y - this.rect.top]);
		return { x: wx, y: wy };
	}

	get snapToGrid(): boolean {
		return this.snapValue;
	}

	set snapToGrid(on: boolean) {
		this.snapValue = on;
		this.storageService.store(SNAP_KEY, on, StorageScope.PROFILE, StorageTarget.USER);
	}

	get showMinimap(): boolean {
		return !!this.minimap && this.minimapValue;
	}

	set showMinimap(on: boolean) {
		if (!this.minimap) {
			return;
		}
		this.minimapValue = on;
		this.storageService.store(MINIMAP_KEY, on, StorageScope.PROFILE, StorageTarget.USER);
		this.minimap.setVisible(on);
		this.root.classList.toggle('with-minimap', on);
		this.zoomBar?.refresh(undefined);
	}

	layout(width: number, height: number): void {
		this.width = Math.max(0, Math.round(width));
		this.height = Math.max(0, Math.round(height));
		this.root.style.width = `${this.width}px`;
		this.root.style.height = `${this.height}px`;
		this.camera.setViewportSize(this.width, this.height);
		this.refreshRect(true);
		if (this.width && this.height && (!this.fitted || this.readOnly)) {
			this.fitted = true;
			if (this.readOnly) {
				this.fitView(false);
			} else {
				this.openView();
			}
		}
		this.cameraDirty = true;
		this.overlayDirty = true;
		this.minimap?.invalidate();
		this.requestFrame();
	}

	focus(): void {
		this.root.focus({ preventScroll: true });
	}

	/** Ends the ghost line left after dropping a connection on empty canvas (the picker closed). */
	clearPendingConnection(): void {
		if (!this.pending) {
			return;
		}
		this.pending = undefined;
		this.pendingListeners.clear();
		if (this.gesture?.kind !== 'connect') {
			this.setLiveClass('volt-wf-live hidden');
		}
	}

	//#endregion

	//#region Rendering

	private positionOf(id: string): IWorkflowPosition {
		return this.overrides.get(id) ?? this.views.get(id)?.node.position ?? this.model.node(id)?.position ?? { x: 0, y: 0 };
	}

	private rectOf(view: WorkflowNodeView): IRect {
		return nodeRect(this.positionOf(view.id), view.layout);
	}

	private sync(definition: IWorkflowDefinition): void {
		this.definition = definition;
		this.obstacleCache = undefined;
		const seen = new Set<string>();
		for (const node of definition.nodes) {
			if (seen.has(node.id)) {
				continue;
			}
			seen.add(node.id);
			let view = this.views.get(node.id);
			if (!view) {
				view = new WorkflowNodeView(node, definition.trigger, this.readOnly);
				this.views.set(node.id, view);
				this.nodesLayer.appendChild(view.element);
				view.setRun(this.runViewMap.get(node.id));
				view.setIssues(this.nodeIssues.get(node.id) ?? []);
			} else {
				view.update(node, definition.trigger);
			}
			const p = this.overrides.get(node.id) ?? node.position;
			view.setPosition(p.x, p.y);
		}
		for (const [id, view] of this.views) {
			if (!seen.has(id)) {
				view.element.remove();
				this.views.delete(id);
				this.overrides.delete(id);
			}
		}

		this.adjacency.clear();
		const wired = new Map<string, Set<string>>();
		const edgeSeen = new Set<string>();
		for (const edge of definition.edges) {
			if (edgeSeen.has(edge.id)) {
				continue;
			}
			edgeSeen.add(edge.id);
			let view = this.edgeViews.get(edge.id);
			if (!view) {
				view = new WorkflowEdgeView(this.root.ownerDocument, edge, this.edgeBadges);
				this.edgeViews.set(edge.id, view);
				this.edgeSvg.appendChild(view.group);
				view.setIssues(this.edgeIssues.get(edge.id) ?? []);
				if (this.traversed.has(edge.id)) {
					view.setFlag('traversed', true);
				}
			} else if (view.edge !== edge) {
				view.edge = edge;
				view.setLabel(edge.label);
			}
			const source = this.views.get(edge.from);
			view.setKind(source?.layout.outputs.find(port => port.id === edge.port)?.kind ?? 'neutral');
			view.setRoute(this.routeFor(edge));
			for (const end of [edge.from, edge.to]) {
				let set = this.adjacency.get(end);
				if (!set) {
					set = new Set();
					this.adjacency.set(end, set);
				}
				set.add(edge.id);
			}
			let ports = wired.get(edge.from);
			if (!ports) {
				ports = new Set();
				wired.set(edge.from, ports);
			}
			ports.add(edge.port);
		}
		for (const [id, view] of this.edgeViews) {
			if (!edgeSeen.has(id)) {
				view.dispose();
				this.edgeViews.delete(id);
				this.selectedEdges.delete(id);
				if (this.hoverEdge === id) {
					this.hoverEdge = undefined;
					this.edgeTools.hide();
				}
			}
		}

		const empty = this.updateEmptyState();
		for (const [id, view] of this.views) {
			view.setWired(wired.get(id) ?? new Set(), empty && view.isStart);
		}
		this.renderGroups();
		this.updateEdgeLayerBox();
		this.applySelection();
		this.minimap?.invalidate();
		this.overlayDirty = true;
		this.requestFrame();
	}

	private routeFor(edge: IWorkflowEdge): IEdgeRoute | undefined {
		const from = this.views.get(edge.from);
		const to = this.views.get(edge.to);
		if (!from || !to) {
			return undefined;
		}
		return this.routeBetween(from, edge.port, to);
	}

	/** The route from a port of `from` to `to`'s input: around the other nodes, nested by port order. */
	private routeBetween(from: WorkflowNodeView, portId: string, to: WorkflowNodeView): IEdgeRoute {
		const fromRect = this.rectOf(from);
		const toRect = this.rectOf(to);
		const index = Math.max(0, from.layout.outputs.findIndex(p => p.id === portId));
		const port = from.layout.outputs[index];
		const source: Vec = port ? [fromRect.x + port.x, fromRect.y + port.y] : [fromRect.x + fromRect.width, fromRect.y + fromRect.height / 2];
		return routeEdge(source, this.handleOf(to), fromRect, toRect, { obstacles: this.obstacles(), port: index, ports: from.layout.outputs.length });
	}

	/** Every node's bounds, for looping edges to go around; rebuilt once per sync or drag frame. */
	private obstacles(): readonly IRect[] {
		if (!this.obstacleCache) {
			this.obstacleCache = [...this.views.values()].map(view => nodeBounds(this.positionOf(view.id), view.layout));
		}
		return this.obstacleCache;
	}

	private handleOf(view: WorkflowNodeView): Vec {
		const p = this.positionOf(view.id);
		const input = view.layout.input ?? [0, view.layout.height / 2];
		return [p.x + input[0], p.y + input[1]];
	}

	private portOf(nodeId: string, portId: string): Vec | undefined {
		const view = this.views.get(nodeId);
		const port = view?.layout.outputs.find(p => p.id === portId);
		if (!view || !port) {
			return undefined;
		}
		const p = this.positionOf(nodeId);
		return [p.x + port.x, p.y + port.y];
	}

	private rerouteEdges(ids: Iterable<string>): void {
		// Nodes moved: loops may need to go around them differently.
		this.obstacleCache = undefined;
		for (const id of ids) {
			const view = this.edgeViews.get(id);
			if (view) {
				view.setRoute(this.routeFor(view.edge));
			}
		}
	}

	/** The edge SVG covers the nodes plus a margin, so its paths can be hovered (an SVG is hit-tested only inside its box). */
	private updateEdgeLayerBox(): void {
		const b = unionRects([...this.views.values()].map(view => this.rectOf(view))) ?? { x: 0, y: 0, width: 1, height: 1 };
		const x = Math.floor(b.x - EDGE_LAYER_MARGIN), y = Math.floor(b.y - EDGE_LAYER_MARGIN);
		const w = Math.ceil(b.width + EDGE_LAYER_MARGIN * 2), h = Math.ceil(b.height + EDGE_LAYER_MARGIN * 2);
		const box = this.edgeBox;
		if (box.x === x && box.y === y && box.width === w && box.height === h) {
			return;
		}
		this.edgeBox = { x, y, width: w, height: h };
		this.edgeSvg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
		this.edgeSvg.style.transform = `translate(${x}px, ${y}px)`;
		this.edgeSvg.style.width = `${w}px`;
		this.edgeSvg.style.height = `${h}px`;
	}

	/** During a drag: re-fit the edge layer only when the moved nodes get near its edge. */
	private growEdgeLayerBox(moved: IRect): void {
		const box = this.edgeBox;
		const m = EDGE_LAYER_MARGIN / 2;
		if (moved.x - m < box.x || moved.y - m < box.y || moved.x + moved.width + m > box.x + box.width || moved.y + moved.height + m > box.y + box.height) {
			this.updateEdgeLayerBox();
		}
	}

	private renderGroups(): void {
		const groups = this.definition.groups ?? [];
		this.groupsOf.clear();
		const seen = new Set<string>();
		for (const group of groups) {
			seen.add(group.id);
			for (const member of group.nodes) {
				let set = this.groupsOf.get(member);
				if (!set) {
					set = new Set();
					this.groupsOf.set(member, set);
				}
				set.add(group.id);
			}
			let view = this.groupViews.get(group.id);
			if (!view) {
				const frame = append(this.groupsLayer, $('.volt-wf-group'));
				const title = append(frame, $('.volt-wf-group-title'));
				title.dataset.groupTitle = group.id;
				view = { frame, title, group };
				this.groupViews.set(group.id, view);
			}
			view.group = group;
			view.frame.className = `volt-wf-group ${colorClass(group.color ?? 'default')}`;
			if (!view.title.querySelector('input')) {
				view.title.textContent = group.title || localize('voltWorkflows.groupUntitled', "Group");
			}
			this.placeGroup(view);
		}
		for (const [id, view] of this.groupViews) {
			if (!seen.has(id)) {
				view.frame.remove();
				this.groupViews.delete(id);
			}
		}
	}

	private placeGroup(view: IGroupView): void {
		const rects = view.group.nodes.flatMap(id => {
			const node = this.views.get(id);
			return node ? [nodeBounds(this.positionOf(id), node.layout)] : [];
		});
		const b = unionRects(rects);
		if (!b) {
			view.frame.style.display = 'none';
			return;
		}
		const pad = 20, title = 26;
		view.frame.style.display = '';
		view.frame.style.transform = `translate(${b.x - pad}px, ${b.y - pad - title}px)`;
		view.frame.style.width = `${b.width + pad * 2}px`;
		view.frame.style.height = `${b.height + pad * 2 + title}px`;
	}

	private updateEmptyState(): boolean {
		const def = this.definition;
		const start = def.nodes.length === 1 && !def.edges.length && isStartType(def.nodes[0]) ? def.nodes[0] : undefined;
		const view = start && this.options.emptyState && !this.readOnly ? this.views.get(start.id) : undefined;
		const port = view?.layout.outputs[0];
		if (!view || !port) {
			this.emptyState.hide();
			return false;
		}
		const p = this.positionOf(view.id);
		this.emptyState.show([p.x + port.x, p.y + port.y]);
		return true;
	}

	private applySelection(): void {
		const marquee = this.gesture?.kind === 'marquee' ? this.gesture.preview : undefined;
		const selected = marquee ?? new Set(this.model.selection);
		for (const [id, view] of this.views) {
			view.setFlag('selected', selected.has(id));
		}
		for (const [id, view] of this.edgeViews) {
			view.setFlag('selected', this.selectedEdges.has(id));
			view.setFlag('related', !this.selectedEdges.has(id) && (selected.has(view.edge.from) || selected.has(view.edge.to)));
		}
		for (const view of this.groupViews.values()) {
			view.frame.classList.toggle('selected', view.group.nodes.length > 0 && view.group.nodes.every(id => selected.has(id)));
		}
		this.minimap?.invalidate();
		this.overlayDirty = true;
		this.requestFrame();
	}

	private contentBounds(): IRect | undefined {
		const rects = [...this.views.values()].map(view => nodeBounds(this.positionOf(view.id), view.layout));
		const empty = this.emptyState.bounds();
		if (empty) {
			rects.push(empty);
		}
		return unionRects(rects);
	}

	private minimapMarks(): readonly IMinimapMark[] {
		const selected = new Set(this.model.selection);
		return [...this.views.values()].map(view => ({ rect: this.rectOf(view), color: nodeColor(view.node, view.nodeType), selected: selected.has(view.id) }));
	}

	private minimapLinks(): readonly (readonly [Vec, Vec])[] {
		const links: (readonly [Vec, Vec])[] = [];
		for (const view of this.edgeViews.values()) {
			const a = this.portOf(view.edge.from, view.edge.port);
			const target = this.views.get(view.edge.to);
			if (a && target) {
				links.push([a, this.handleOf(target)]);
			}
		}
		return links;
	}

	private requestFrame(): void {
		if (this.frameHandle === undefined) {
			this.frameHandle = getWindow(this.root).requestAnimationFrame(() => this.frame());
		}
	}

	private frame(): void {
		this.frameHandle = undefined;
		if (this.pointerDirty) {
			this.pointerDirty = false;
			this.processPointer();
		}
		this.autoPan();
		if (this.cameraDirty) {
			this.cameraDirty = false;
			this.paintCamera();
		}
		if (this.overlayDirty) {
			this.overlayDirty = false;
			this.paintOverlay();
		}
	}

	private paintCamera(): void {
		const { x, y, zoom } = this.camera.value;
		this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
		// The dot grid is a layer one tile larger than the view that only moves within a tile, so a
		// pan is a compositor move; only a zoom repaints it (new tile size).
		let step = GRID * zoom;
		while (step < 12) {
			step *= 2;
		}
		while (step > GRID_LAYER_PAD) {
			step /= 2;
		}
		if (step !== this.gridStep) {
			this.gridStep = step;
			this.grid.style.backgroundSize = `${step}px ${step}px`;
		}
		const ox = ((x % step) + step) % step, oy = ((y % step) + step) % step;
		this.grid.style.transform = `translate(${ox - step - 1}px, ${oy - step - 1}px)`;
		// Classes change only when the zoom crosses a threshold, not every frame.
		const lod = zoom < LOD_MIN ? 2 : zoom < LOD_LOW ? 1 : 0;
		if (lod !== this.lod) {
			this.lod = lod;
			this.root.classList.toggle('lod-low', lod >= 1);
			this.root.classList.toggle('lod-min', lod >= 2);
		}
		this.zoomBar?.refresh(zoom);
		this.minimap?.paintViewport();
		this._onDidChangeViewport.fire();
	}

	private paintOverlay(): void {
		const g = this.gesture;
		if (g?.kind === 'marquee') {
			const a = this.camera.worldToScreen(g.startWorld);
			const b = this.camera.worldToScreen(g.currentWorld);
			this.marquee.style.transform = `translate(${Math.min(a[0], b[0])}px, ${Math.min(a[1], b[1])}px)`;
			this.marquee.style.width = `${Math.abs(a[0] - b[0])}px`;
			this.marquee.style.height = `${Math.abs(a[1] - b[1])}px`;
		}
		if ((g?.kind === 'marquee') !== this.marqueeShown) {
			this.marqueeShown = g?.kind === 'marquee';
			this.marquee.classList.toggle('hidden', !this.marqueeShown);
		}
		const selection = this.model.selection;
		const busy = !!g && g.kind !== 'press';
		const node = !this.readOnly && !busy && !this.renaming && selection.length === 1 ? this.model.node(selection[0]) : undefined;
		const view = node && this.views.get(node.id);
		if (node && view) {
			this.toolbar.show(node, view.nodeType);
			const p = this.positionOf(node.id);
			const cx = p.x + view.layout.width / 2;
			const top = this.camera.worldToScreen([cx, p.y]);
			const bottom = this.camera.worldToScreen([cx, p.y + view.layout.height + view.extentBelow]);
			this.toolbar.place([top[0], Math.max(top[1], 52)], bottom);
		} else {
			this.toolbar.hide();
		}
		const hovered = this.edgeTools.shownFor && this.edgeViews.get(this.edgeTools.shownFor);
		if (hovered && hovered.route && !busy) {
			this.edgeTools.place(this.camera.worldToScreen(hovered.route.mid));
		} else if (this.edgeTools.shownFor && busy) {
			this.edgeTools.hide();
			this.setHoverEdge(undefined);
		}
	}

	/**
	 * `will-change` on the world and grid layers only while the camera moves (any pan, zoom or
	 * camera animation), so moves are compositor-only and text is re-rastered crisp once it stops.
	 */
	private markGesturing(): void {
		const win = getWindow(this.root);
		if (!this.gesturing) {
			this.gesturing = true;
			this.root.classList.add('gesturing');
		}
		if (this.gestureTimer !== undefined) {
			win.clearTimeout(this.gestureTimer);
		}
		this.gestureTimer = win.setTimeout(() => {
			this.gestureTimer = undefined;
			if (this.gesture?.kind !== 'pan') {
				this.gesturing = false;
				this.root.classList.remove('gesturing');
			}
		}, 180);
	}

	//#endregion

	//#region Input

	private installInput(): void {
		const root = this.root;
		this._register(addDisposableListener(root, 'pointerdown', e => this.onPointerDown(e)));
		this._register(addDisposableListener(root, 'pointermove', e => this.onPointerMove(e)));
		this._register(addDisposableListener(root, 'pointerup', e => this.onPointerUp(e)));
		this._register(addDisposableListener(root, 'pointercancel', e => this.onPointerCancel(e)));
		this._register(addDisposableListener(root, 'lostpointercapture', e => {
			if (this.gesture && this.gesture.pointerId === e.pointerId) {
				this.onPointerUp(e);
			}
		}));
		this._register(addDisposableListener(root, 'pointerenter', () => {
			this.pointerInside = true;
			this.refreshRect(true);
		}));
		this._register(addDisposableListener(root, 'pointerleave', () => {
			this.pointerInside = false;
		}));
		this._register(addDisposableListener(root, 'wheel', e => this.onWheel(e), { passive: false }));
		this._register(addDisposableListener(root, 'contextmenu', e => this.onContextMenu(e)));
		this._register(addDisposableListener(root, 'dblclick', e => this.onDoubleClick(e)));
		this._register(addDisposableListener(root, 'click', e => {
			const trigger = closestIn(e.target, '[data-trigger]');
			if (trigger && isHTMLElement(trigger) && !this.readOnly) {
				e.stopPropagation();
				this._onDidRequestChangeTrigger.fire(trigger);
			}
		}));
		this._register(addDisposableListener(root, 'keydown', e => this.onKeyDown(e)));
		this._register(addDisposableListener(root, 'keyup', e => {
			if (e.key === ' ') {
				this.setSpace(false);
			}
		}));
		this._register(addDisposableListener(getWindow(root), 'blur', () => this.setSpace(false)));
		this._register(addDisposableListener(getWindow(root), 'resize', () => this.refreshRect(true)));
		this._register(addDisposableListener(this.edgeSvg, 'pointerover', e => {
			if (this.gesture || this.readOnly) {
				return;
			}
			const group = closestIn(e.target, '[data-edge]');
			if (group) {
				this.setHoverEdge(group.dataset.edge);
			}
		}));
		this._register(addDisposableListener(this.edgeSvg, 'pointerout', e => {
			const group = closestIn(e.target, '[data-edge]');
			if (group && !(e.relatedTarget instanceof Node && group.contains(e.relatedTarget))) {
				this.edgeTools.scheduleHide();
			}
		}));
	}

	private setSpace(on: boolean): void {
		if (on !== this.spaceHeld) {
			this.spaceHeld = on;
			this.root.classList.toggle('space-pan', on);
		}
	}

	private setHoverEdge(id: string | undefined): void {
		if (id === this.hoverEdge) {
			if (id) {
				this.edgeTools.show(id);
			}
			return;
		}
		if (this.hoverEdge) {
			this.edgeViews.get(this.hoverEdge)?.setFlag('hover', false);
		}
		this.hoverEdge = id;
		if (id) {
			this.edgeViews.get(id)?.setFlag('hover', true);
			this.edgeTools.show(id);
			this.overlayDirty = true;
			this.requestFrame();
		}
	}

	/** The canvas's page offset: read at most once per gesture (never per move). */
	private refreshRect(force = false): void {
		const now = Date.now();
		if (!force && now - this.rectAt < 500) {
			return;
		}
		const r = this.root.getBoundingClientRect();
		this.rect = { left: r.left, top: r.top };
		this.rectAt = now;
	}

	private toScreen(client: Vec): Vec {
		return [client[0] - this.rect.left, client[1] - this.rect.top];
	}

	private toWorld(client: Vec): Vec {
		return this.camera.screenToWorld(this.toScreen(client));
	}

	private worldToClient(p: Vec): Client {
		const [sx, sy] = this.camera.worldToScreen(p);
		return { x: this.rect.left + sx, y: this.rect.top + sy };
	}

	private centerOf(el: Element): Client {
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}

	private capture(e: PointerEvent): void {
		try {
			this.root.setPointerCapture(e.pointerId);
		} catch {
			// Synthetic events have no capture.
		}
	}

	private onWheel(e: WheelEvent): void {
		if (isTextInput(e.target)) {
			return;
		}
		const zoomGesture = e.ctrlKey || e.metaKey;
		// A read-only preview inside a scrolling page lets the page scroll until it is clicked.
		if (this.readOnly && !zoomGesture && !this.root.contains(this.root.ownerDocument.activeElement)) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.refreshRect();
		const screen = this.toScreen([e.clientX, e.clientY]);
		const lineFactor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
		if (zoomGesture) {
			// Trackpad pinch arrives as ctrl+wheel; both zoom at the pointer.
			const delta = Math.max(-60, Math.min(60, e.deltaY * lineFactor));
			const current = this.camera.zoom;
			const next = Math.max(Math.min(MIN_ZOOM, current), Math.min(MAX_ZOOM, current * Math.exp(-delta * 0.0105)));
			this.camera.zoomAt(next, screen);
		} else {
			let dx = e.deltaX * lineFactor;
			let dy = e.deltaY * lineFactor;
			if (e.shiftKey && !dx) {
				dx = dy;
				dy = 0;
			}
			this.camera.panBy(-dx, -dy);
		}
		if (this.gesture && this.gesture.kind !== 'pan') {
			// The world moved under a still pointer: the drag follows it.
			this.pointerDirty = true;
			this.requestFrame();
		}
	}

	private onPointerDown(e: PointerEvent): void {
		this.refreshRect(true);
		this.pointer = { client: [e.clientX, e.clientY], shift: e.shiftKey, mod: isMacintosh ? e.metaKey : e.ctrlKey };
		if (this.gesture) {
			return;
		}
		const target = e.target;
		if (closestIn(target, '.volt-wf-chrome') || isTextInput(target)) {
			return;
		}
		if (this.renaming) {
			this.renaming.commit(true);
		}
		this.clearPendingConnection();
		this.finishLayoutAnimation();
		if (closestIn(target, '[data-trigger]')) {
			// The button's own click opens the trigger menu; no drag, no capture.
			return;
		}
		this.focus();
		const screen = this.toScreen([e.clientX, e.clientY]);
		const world = this.camera.screenToWorld(screen);
		const additive = e.shiftKey || (isMacintosh ? e.metaKey : e.ctrlKey);
		const nodeEl = closestIn(target, '.volt-wf-node');
		const nodeId = nodeEl?.dataset.node;
		if (e.button === 1 || (e.button === 0 && (this.spaceHeld || this.readOnly))) {
			e.preventDefault();
			this.beginGesture(e, { kind: 'pan', pointerId: e.pointerId, last: screen });
			this.root.classList.add('panning');
			this.markGesturing();
			return;
		}
		if (e.button === 2) {
			// Right click picks what it is on (unless that is already selected); the menu follows.
			const edge = closestIn(target, '[data-edge]')?.dataset.edge;
			if (nodeId && !this.model.selection.includes(nodeId)) {
				this.selectedEdges.clear();
				this.model.setSelection([nodeId]);
			} else if (!nodeId && edge) {
				this.selectedEdges.clear();
				this.selectedEdges.add(edge);
				this.model.setSelection([]);
				this.applySelection();
			}
			return;
		}
		if (e.button !== 0) {
			return;
		}
		if (this.readOnly) {
			return;
		}
		const plus = closestIn(target, '[data-plus]');
		const port = plus ? undefined : closestIn(target, '[data-port]');
		if (nodeId && (plus || port)) {
			const portId = plus ? plus.dataset.plus! : port!.dataset.port!;
			this.startConnect(e, nodeId, portId, !!plus, undefined);
			return;
		}
		if (nodeId && closestIn(target, '[data-input]')) {
			const incoming = this.definition.edges.filter(edge => edge.to === nodeId);
			const detach = incoming[incoming.length - 1];
			if (detach) {
				this.startConnect(e, detach.from, detach.port, false, detach);
				return;
			}
		}
		const groupTitle = closestIn(target, '[data-group-title]');
		if (groupTitle?.dataset.groupTitle && !nodeId) {
			this.beginGesture(e, { kind: 'press', pointerId: e.pointerId, start: screen, startWorld: world, target: { kind: 'group', groupId: groupTitle.dataset.groupTitle }, additive });
			return;
		}
		if (nodeId) {
			const selection = this.model.selection;
			const wasSelected = selection.includes(nodeId);
			let toggledOff = false;
			if (additive) {
				toggledOff = wasSelected;
				this.model.setSelection(wasSelected ? selection.filter(id => id !== nodeId) : [...selection, nodeId]);
			} else if (!wasSelected) {
				this.selectedEdges.clear();
				this.model.setSelection([nodeId]);
			}
			this.beginGesture(e, { kind: 'press', pointerId: e.pointerId, start: screen, startWorld: world, target: { kind: 'node', nodeId, wasSelected, toggledOff }, additive });
			return;
		}
		const edge = closestIn(target, '[data-edge]')?.dataset.edge;
		if (edge) {
			this.beginGesture(e, { kind: 'press', pointerId: e.pointerId, start: screen, startWorld: world, target: { kind: 'edge', edgeId: edge }, additive });
			return;
		}
		this.beginGesture(e, { kind: 'press', pointerId: e.pointerId, start: screen, startWorld: world, target: { kind: 'empty' }, additive });
	}

	private beginGesture(e: PointerEvent, gesture: Gesture): void {
		this.gesture = gesture;
		this.capture(e);
		this.overlayDirty = true;
		this.requestFrame();
	}

	private onPointerMove(e: PointerEvent): void {
		this.pointer = { client: [e.clientX, e.clientY], shift: e.shiftKey, mod: isMacintosh ? e.metaKey : e.ctrlKey };
		if (!this.gesture || this.gesture.pointerId !== e.pointerId) {
			return;
		}
		// Coalesced: the latest position is applied once, at the next frame.
		this.pointerDirty = true;
		this.requestFrame();
	}

	private processPointer(): void {
		const g = this.gesture;
		const pointer = this.pointer;
		if (!g || !pointer) {
			return;
		}
		const screen = this.toScreen(pointer.client);
		const world = this.camera.screenToWorld(screen);
		switch (g.kind) {
			case 'pan':
				this.camera.panBy(screen[0] - g.last[0], screen[1] - g.last[1]);
				g.last = screen;
				return;
			case 'press': {
				if (Math.hypot(screen[0] - g.start[0], screen[1] - g.start[1]) < DRAG_THRESHOLD) {
					return;
				}
				const t = g.target;
				if (t.kind === 'node' && !t.toggledOff) {
					const selection = this.model.selection;
					this.startMove(g, selection.includes(t.nodeId) ? selection : [t.nodeId], t.nodeId);
				} else if (t.kind === 'group') {
					const group = this.groupViews.get(t.groupId)?.group;
					if (group?.nodes.length) {
						this.model.setSelection(group.nodes);
						this.startMove(g, group.nodes, group.nodes[0]);
					}
				} else if (t.kind === 'empty' || t.kind === 'edge') {
					const base = g.additive ? new Set(this.model.selection) : new Set<string>();
					if (!g.additive) {
						this.selectedEdges.clear();
					}
					this.gesture = { kind: 'marquee', pointerId: g.pointerId, startWorld: g.startWorld, currentWorld: world, additive: g.additive, base, preview: base };
					this.root.classList.add('marquee');
				}
				// Became a drag: apply this same position to it (and only then, or it would loop).
				if (this.gesture !== g) {
					this.processPointer();
				}
				return;
			}
			case 'move': this.updateMove(g, world, pointer.mod); return;
			case 'marquee': this.updateMarquee(g, world); return;
			case 'connect': this.updateConnect(g, screen, world); return;
		}
	}

	private onPointerUp(e: PointerEvent): void {
		const g = this.gesture;
		if (!g || g.pointerId !== e.pointerId) {
			return;
		}
		this.pointer = { client: [e.clientX, e.clientY], shift: e.shiftKey, mod: isMacintosh ? e.metaKey : e.ctrlKey };
		// Apply the last move before finishing, so a fast release lands where the pointer is.
		this.pointerDirty = false;
		this.processPointer();
		const current = this.gesture!;
		this.gesture = undefined;
		if (this.root.hasPointerCapture?.(e.pointerId)) {
			this.root.releasePointerCapture(e.pointerId);
		}
		switch (current.kind) {
			case 'pan':
				this.root.classList.remove('panning');
				// Drops the layer hint shortly after, unless the camera keeps moving.
				this.markGesturing();
				break;
			case 'press': this.finishPress(current); break;
			case 'move': this.finishMove(current); break;
			case 'marquee': this.finishMarquee(current); break;
			case 'connect': this.finishConnect(current); break;
		}
		this.overlayDirty = true;
		this.requestFrame();
	}

	private onPointerCancel(e: PointerEvent): void {
		if (this.gesture && this.gesture.pointerId === e.pointerId) {
			this.cancelGesture();
		}
	}

	/** Puts a half-done gesture back (Escape, a lost pointer). */
	private cancelGesture(): void {
		const g = this.gesture;
		this.gesture = undefined;
		if (!g) {
			return;
		}
		switch (g.kind) {
			case 'pan':
				this.root.classList.remove('panning');
				this.markGesturing();
				break;
			case 'move':
				for (const id of g.ids) {
					this.overrides.delete(id);
					const view = this.views.get(id);
					if (view) {
						view.setFlag('dragging', false);
						view.setPosition(view.node.position.x, view.node.position.y);
					}
				}
				this.rerouteEdges(g.edges);
				this.placeGroups(g.groups);
				this.root.classList.remove('moving');
				this.minimap?.invalidate();
				break;
			case 'marquee':
				this.root.classList.remove('marquee');
				this.applySelection();
				break;
			case 'connect':
				this.endConnectVisuals(g);
				break;
		}
		this.overlayDirty = true;
		this.requestFrame();
	}

	private finishPress(g: Extract<Gesture, { kind: 'press' }>): void {
		const t = g.target;
		switch (t.kind) {
			case 'node':
				// A click on one of several selected nodes, without dragging, selects just that one.
				if (!g.additive && t.wasSelected) {
					this.selectedEdges.clear();
					this.model.setSelection([t.nodeId]);
					this.applySelection();
				}
				break;
			case 'group': {
				const group = this.groupViews.get(t.groupId)?.group;
				if (group) {
					this.selectedEdges.clear();
					this.model.setSelection(g.additive ? [...new Set([...this.model.selection, ...group.nodes])] : group.nodes);
				}
				break;
			}
			case 'edge':
				if (g.additive) {
					if (!this.selectedEdges.delete(t.edgeId)) {
						this.selectedEdges.add(t.edgeId);
					}
				} else {
					this.selectedEdges.clear();
					this.selectedEdges.add(t.edgeId);
					this.model.setSelection([]);
				}
				this.applySelection();
				break;
			case 'empty':
				if (!g.additive) {
					this.selectedEdges.clear();
					this.model.setSelection([]);
					this.applySelection();
				}
				break;
		}
	}

	//#endregion

	//#region Moving nodes

	private startMove(press: Extract<Gesture, { kind: 'press' }>, ids: readonly string[], anchor: string): void {
		const movable = ids.filter(id => this.views.has(id));
		const origins = new Map(movable.map(id => [id, this.positionOf(id)]));
		const edges = new Set<string>();
		const groups = new Set<string>();
		for (const id of movable) {
			for (const edge of this.adjacency.get(id) ?? []) {
				edges.add(edge);
			}
			for (const group of this.groupsOf.get(id) ?? []) {
				groups.add(group);
			}
			this.views.get(id)!.setFlag('dragging', true);
		}
		this.gesture = { kind: 'move', pointerId: press.pointerId, ids: movable, origins, anchor: movable.includes(anchor) ? anchor : movable[0], startWorld: press.startWorld, edges, groups, delta: [0, 0] };
		this.root.classList.add('moving');
		this.setHoverEdge(undefined);
		this.edgeTools.hide();
	}

	private updateMove(g: Extract<Gesture, { kind: 'move' }>, world: Vec, noSnap: boolean): void {
		let dx = Math.round(world[0] - g.startWorld[0]);
		let dy = Math.round(world[1] - g.startWorld[1]);
		const origin = g.origins.get(g.anchor);
		// Snap the node under the pointer to the grid; the rest keep their offsets from it. Cmd/Ctrl
		// skips it. Vertically it is the line edges meet the node on that snaps, not its top: nodes
		// of different heights then line up and the edges between them run straight.
		if (this.snapValue && !noSnap && origin) {
			const line = this.views.get(g.anchor)?.layout.anchor ?? 0;
			dx = snap(origin.x + dx) - origin.x;
			dy = snap(origin.y + line + dy) - line - origin.y;
		}
		if (dx === g.delta[0] && dy === g.delta[1]) {
			return;
		}
		g.delta = [dx, dy];
		for (const [id, o] of g.origins) {
			const p = { x: o.x + dx, y: o.y + dy };
			this.overrides.set(id, p);
			this.views.get(id)?.setPosition(p.x, p.y);
		}
		this.rerouteEdges(g.edges);
		this.placeGroups(g.groups);
		const moved = unionRects(g.ids.flatMap(id => {
			const view = this.views.get(id);
			return view ? [this.rectOf(view)] : [];
		}));
		if (moved) {
			this.growEdgeLayerBox(moved);
		}
		if (this.emptyState.shown) {
			this.updateEmptyState();
		}
		this.minimap?.invalidate();
	}

	private placeGroups(ids: Iterable<string>): void {
		for (const id of ids) {
			const view = this.groupViews.get(id);
			if (view) {
				this.placeGroup(view);
			}
		}
	}

	private finishMove(g: Extract<Gesture, { kind: 'move' }>): void {
		this.root.classList.remove('moving');
		const moves = g.ids.map(id => ({ id, position: this.overrides.get(id) ?? this.positionOf(id) }));
		for (const id of g.ids) {
			this.overrides.delete(id);
			this.views.get(id)?.setFlag('dragging', false);
		}
		if (g.delta[0] || g.delta[1]) {
			// One drag is one undo step (moveNodes coalesces by key; every drag gets its own).
			this.model.moveNodes(moves, `drag:${Date.now()}`, 'canvas', moves.length === 1 ? localize('voltWorkflows.moveNode', "Move block") : localize('voltWorkflows.moveNodes', "Move {0} blocks", moves.length));
		}
	}

	private nudge(dx: number, dy: number): void {
		const selection = this.model.selection;
		if (!selection.length) {
			return;
		}
		this.model.moveNodes(selection.flatMap(id => {
			const node = this.model.node(id);
			return node ? [{ id, position: { x: node.position.x + dx, y: node.position.y + dy } }] : [];
		}), 'nudge', 'canvas', localize('voltWorkflows.nudge', "Nudge"));
	}

	private animateLayout(from: ReadonlyMap<string, IWorkflowPosition>, to: ReadonlyMap<string, IWorkflowPosition>): void {
		const win = getWindow(this.root);
		const edges = new Set<string>();
		const groups = new Set<string>();
		for (const id of to.keys()) {
			for (const edge of this.adjacency.get(id) ?? []) {
				edges.add(edge);
			}
			for (const group of this.groupsOf.get(id) ?? []) {
				groups.add(group);
			}
		}
		const finish = () => {
			this.layoutAnimation = undefined;
			for (const [id, p] of to) {
				this.overrides.delete(id);
				this.views.get(id)?.setPosition(p.x, p.y);
			}
			this.rerouteEdges(edges);
			this.placeGroups(groups);
			this.updateEdgeLayerBox();
			this.updateEmptyState();
			this.minimap?.invalidate();
			this.overlayDirty = true;
			this.requestFrame();
		};
		this.finishLayoutAnimationNow = finish;
		if (this.reducedMotion) {
			this.finishLayoutAnimation();
			return;
		}
		const start = win.performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / LAYOUT_ANIMATION_MS);
			const e = 1 - Math.pow(1 - t, 3);
			for (const [id, target] of to) {
				const origin = from.get(id) ?? target;
				const p = { x: origin.x + (target.x - origin.x) * e, y: origin.y + (target.y - origin.y) * e };
				this.overrides.set(id, p);
				this.views.get(id)?.setPosition(p.x, p.y);
			}
			this.rerouteEdges(edges);
			this.placeGroups(groups);
			this.overlayDirty = true;
			this.requestFrame();
			if (t < 1) {
				this.layoutAnimation = win.requestAnimationFrame(step);
			} else {
				this.finishLayoutAnimation();
			}
		};
		this.layoutAnimation = win.requestAnimationFrame(step);
	}

	private finishLayoutAnimationNow: (() => void) | undefined;

	/** Jumps a running layout animation to its end (a new gesture or layout starts). */
	private finishLayoutAnimation(): void {
		const finish = this.finishLayoutAnimationNow;
		if (!finish) {
			return;
		}
		this.finishLayoutAnimationNow = undefined;
		if (this.layoutAnimation !== undefined) {
			getWindow(this.root).cancelAnimationFrame(this.layoutAnimation);
		}
		finish();
	}

	//#endregion

	//#region Marquee

	private updateMarquee(g: Extract<Gesture, { kind: 'marquee' }>, world: Vec): void {
		g.currentWorld = world;
		const box: IRect = {
			x: Math.min(g.startWorld[0], world[0]), y: Math.min(g.startWorld[1], world[1]),
			width: Math.abs(world[0] - g.startWorld[0]), height: Math.abs(world[1] - g.startWorld[1]),
		};
		const hits = new Set(g.base);
		for (const view of this.views.values()) {
			if (rectsIntersect(box, nodeBounds(this.positionOf(view.id), view.layout))) {
				hits.add(view.id);
			}
		}
		// The model's selection changes once, on release; until then only the outlines follow.
		g.preview = hits;
		this.applySelection();
	}

	private finishMarquee(g: Extract<Gesture, { kind: 'marquee' }>): void {
		this.root.classList.remove('marquee');
		this.model.setSelection([...g.preview]);
		this.applySelection();
	}

	//#endregion

	//#region Connecting

	private startConnect(e: PointerEvent, nodeId: string, portId: string, viaPlus: boolean, detach: IWorkflowEdge | undefined): void {
		const view = this.views.get(nodeId);
		const port = view?.layout.outputs.find(p => p.id === portId);
		if (!view || !port) {
			return;
		}
		const screen = this.toScreen([e.clientX, e.clientY]);
		this.beginGesture(e, {
			kind: 'connect', pointerId: e.pointerId, from: { nodeId, port: portId }, portKind: port.kind,
			start: screen, pointer: this.camera.screenToWorld(screen), moved: !!detach, viaPlus, detach,
		});
		view.setActivePort(portId);
		this.setHoverEdge(undefined);
		this.edgeTools.hide();
		if (detach) {
			this.edgeViews.get(detach.id)?.setFlag('detached', true);
			this.root.classList.add('connecting');
			this.paintConnect(this.gesture as Extract<Gesture, { kind: 'connect' }>);
		}
	}

	private updateConnect(g: Extract<Gesture, { kind: 'connect' }>, screen: Vec, world: Vec): void {
		if (!g.moved) {
			if (Math.hypot(screen[0] - g.start[0], screen[1] - g.start[1]) < DRAG_THRESHOLD) {
				return;
			}
			g.moved = true;
			this.root.classList.add('connecting');
		}
		g.pointer = world;
		const { target, invalid } = this.connectTargetAt(world, g.from.nodeId);
		if (target !== g.target) {
			if (g.target) {
				this.views.get(g.target)?.setFlag('connect-target', false);
			}
			g.target = target;
			if (target) {
				this.views.get(target)?.setFlag('connect-target', true);
			}
		}
		if (invalid !== g.invalid) {
			if (g.invalid) {
				this.views.get(g.invalid)?.setFlag('connect-invalid', false);
			}
			g.invalid = invalid;
			if (invalid) {
				this.views.get(invalid)?.setFlag('connect-invalid', true);
			}
			this.root.classList.toggle('connect-invalid', !!invalid);
		}
		this.paintConnect(g);
	}

	/**
	 * What a connection dropped at `world` would attach to: the node under the pointer, else the
	 * nearest input handle within the snap radius. Invalid: the node it starts from, nodes without
	 * an input (the start node).
	 */
	private connectTargetAt(world: Vec, fromId: string): { target?: string; invalid?: string } {
		let over: WorkflowNodeView | undefined;
		let nearest: WorkflowNodeView | undefined;
		let best = SNAP_RADIUS / this.camera.zoom;
		for (const view of this.views.values()) {
			const r = this.rectOf(view);
			// The node it starts from counts only well inside it: leaving its own port is not an error.
			const inset = view.id === fromId ? 14 / this.camera.zoom : 0;
			if (world[0] >= r.x + inset && world[0] <= r.x + r.width - inset && world[1] >= r.y + inset && world[1] <= r.y + r.height - inset) {
				over = view;
			}
			if (view.layout.input && view.id !== fromId) {
				const h = this.handleOf(view);
				const d = Math.hypot(world[0] - h[0], world[1] - h[1]);
				if (d < best) {
					best = d;
					nearest = view;
				}
			}
		}
		if (over) {
			return over.id === fromId || !over.layout.input ? { invalid: over.id } : { target: over.id };
		}
		return nearest ? { target: nearest.id } : {};
	}

	private paintConnect(g: Extract<Gesture, { kind: 'connect' }>): void {
		const source = this.portOf(g.from.nodeId, g.from.port);
		if (!source) {
			return;
		}
		const target = g.target ? this.views.get(g.target) : undefined;
		const from = this.views.get(g.from.nodeId)!;
		this.setLiveClass(`volt-wf-live k-${g.portKind}${target ? ' snapped' : ''}`);
		if (target) {
			// Snapped: exactly the edge it will become.
			const route = this.routeBetween(from, g.from.port, target);
			this.livePath.setAttribute('d', route.d);
			this.liveArrow.setAttribute('d', route.arrow);
		} else {
			this.livePath.setAttribute('d', routeToPointer(source, g.pointer));
			this.liveArrow.setAttribute('d', '');
			this.liveEnd.setAttribute('cx', String(g.pointer[0]));
			this.liveEnd.setAttribute('cy', String(g.pointer[1]));
		}
	}

	/** The live line's classes, written only when they change (it is repainted every frame of a drag). */
	private setLiveClass(value: string): void {
		if (value !== this.liveClass) {
			this.liveClass = value;
			this.liveSvg.setAttribute('class', value);
		}
	}

	private endConnectVisuals(g: Extract<Gesture, { kind: 'connect' }>): void {
		this.views.get(g.from.nodeId)?.setActivePort(undefined);
		if (g.target) {
			this.views.get(g.target)?.setFlag('connect-target', false);
		}
		if (g.invalid) {
			this.views.get(g.invalid)?.setFlag('connect-invalid', false);
		}
		if (g.detach) {
			this.edgeViews.get(g.detach.id)?.setFlag('detached', false);
		}
		this.root.classList.remove('connecting', 'connect-invalid');
		if (!this.pending) {
			this.setLiveClass('volt-wf-live hidden');
		}
	}

	private finishConnect(g: Extract<Gesture, { kind: 'connect' }>): void {
		this.endConnectVisuals(g);
		if (!g.moved) {
			// A click on a port or its "+": add a block after it.
			this.requestAddAfterPort(g.from.nodeId, g.from.port, 'port');
			return;
		}
		if (g.target) {
			const toPort = nodeInputs(this.views.get(g.target)!.node)[0]?.id;
			const port = toPort && toPort !== 'in' ? toPort : undefined;
			if (g.detach) {
				const next: IWorkflowEdge = { id: edgeId(g.from.nodeId, g.from.port, g.target, port), from: g.from.nodeId, port: g.from.port, to: g.target, ...(port ? { toPort: port } : {}), ...(g.detach.label ? { label: g.detach.label } : {}) };
				if (next.id !== g.detach.id) {
					const old = g.detach.id;
					this.model.apply(localize('voltWorkflows.reconnect', "Reconnect"), definition => ({
						...definition,
						edges: [...definition.edges.filter(edge => edge.id !== old && edge.id !== next.id), next],
					}));
				}
			} else {
				this.model.connect(g.from.nodeId, g.from.port, g.target, port);
			}
			return;
		}
		if (g.invalid) {
			return;
		}
		// Dropped on empty canvas: ask for a block there, and keep a ghost line to it meanwhile.
		if (g.detach) {
			this.model.disconnect([g.detach.id]);
		}
		const drop = g.pointer;
		// The new card's input handle lands where the line was dropped.
		const at = { x: this.snapValue ? snap(drop[0]) : Math.round(drop[0]), y: Math.round(drop[1] - FIRST_PORT_Y) };
		this.showPending(g.from, g.portKind, drop);
		this._onDidRequestAddNode.fire({ at, client: this.worldToClient(drop), from: g.from, via: 'drop' });
	}

	private showPending(from: { readonly nodeId: string; readonly port: string }, kind: WorkflowPortKind, point: Vec): void {
		const source = this.portOf(from.nodeId, from.port);
		if (!source) {
			return;
		}
		this.pending = { from, kind, point };
		this.setLiveClass(`volt-wf-live pending k-${kind}`);
		this.livePath.setAttribute('d', routeToPointer(source, point));
		this.liveArrow.setAttribute('d', '');
		this.liveEnd.setAttribute('cx', String(point[0]));
		this.liveEnd.setAttribute('cy', String(point[1]));
		// The picker closing without a pick never tells us; a press outside it or Escape ends the line.
		this.pendingListeners.clear();
		const doc = this.root.ownerDocument;
		this.pendingListeners.add(addDisposableListener(doc, 'pointerdown', e => {
			const menu = this.contextViewService.getContextViewElement();
			if (!(e.target instanceof Node && menu.contains(e.target))) {
				this.clearPendingConnection();
			}
		}, true));
		this.pendingListeners.add(addDisposableListener(doc, 'keydown', e => {
			if (e.key === 'Escape') {
				this.clearPendingConnection();
			}
		}, true));
	}

	/**
	 * A spot for a block after a port: one layout gap to the right with its input level with the
	 * port (a straight edge), moved down past whatever is there.
	 */
	private spotAfter(source: Vec): IWorkflowPosition {
		let x = source[0] + 96;
		if (this.snapValue) {
			x = snap(x);
		}
		let y = Math.round(source[1] - FIRST_PORT_Y);
		for (let i = 0; i < 24; i++) {
			const probe: IRect = { x: x - 24, y: y - 24, width: CARD_WIDTH + 48, height: NEW_CARD_HEIGHT + 48 };
			const blocked = [...this.views.values()].some(view => rectsIntersect(probe, nodeBounds(this.positionOf(view.id), view.layout)));
			if (!blocked) {
				break;
			}
			y += NEW_CARD_HEIGHT + 48;
		}
		return { x, y };
	}

	private requestAddAfterPort(nodeId: string, port: string, via: 'port' | 'keyboard' | 'empty', client?: Client): void {
		const source = this.portOf(nodeId, port);
		if (!source) {
			return;
		}
		const at = this.spotAfter(source);
		const plus = this.views.get(nodeId)?.element.querySelector(`[data-plus="${CSS.escape(port)}"]`);
		const anchor = client ?? (plus && !plus.classList.contains('hidden') ? this.centerOf(plus) : this.worldToClient([at.x, at.y + FIRST_PORT_Y]));
		const kind = this.views.get(nodeId)?.layout.outputs.find(p => p.id === port)?.kind ?? 'neutral';
		this.showPending({ nodeId, port }, kind, [at.x, at.y + FIRST_PORT_Y]);
		this._onDidRequestAddNode.fire({ at, client: anchor, from: { nodeId, port }, via });
	}

	private onEmptyPick(branch: EmptyBranch, button: HTMLElement): void {
		if (branch === 'describe' || branch === 'templates') {
			this._onDidRequestEmptyAction.fire(branch);
			return;
		}
		const start = this.definition.nodes.find(isStartType);
		const port = start && this.views.get(start.id)?.layout.outputs[0];
		if (start && port) {
			this.requestAddAfterPort(start.id, port.id, 'empty', this.centerOf(button));
		}
	}

	//#endregion

	//#region Menus, double click, keyboard

	private onContextMenu(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		if (this.readOnly || closestIn(e.target, '.volt-wf-chrome') || isTextInput(e.target)) {
			return;
		}
		this.refreshRect(true);
		const doc = this.root.ownerDocument;
		const client = { x: e.clientX, y: e.clientY };
		const nodeId = closestIn(e.target, '.volt-wf-node')?.dataset.node;
		const node = nodeId ? this.model.node(nodeId) : undefined;
		if (node) {
			showNodeMenu(this.contextViewService, doc, client, this, node, getWorkflowNodeType(node.type), this.model.selection);
			return;
		}
		const groupId = closestIn(e.target, '[data-group-title]')?.dataset.groupTitle;
		const group = groupId ? this.groupViews.get(groupId)?.group : undefined;
		if (group) {
			showGroupMenu(this.contextViewService, doc, client, this, group.id, group.color);
			return;
		}
		const edge = closestIn(e.target, '[data-edge]')?.dataset.edge;
		if (edge) {
			showEdgeMenu(this.contextViewService, doc, client, this, edge);
			return;
		}
		showCanvasMenu(this.contextViewService, doc, client, this, this.model.selection.length > 1);
	}

	private onDoubleClick(e: MouseEvent): void {
		// Pointer capture retargets the click to the canvas: find what is under the pointer.
		const hit = this.root.ownerDocument.elementFromPoint(e.clientX, e.clientY);
		if (closestIn(hit, '.volt-wf-chrome') || isTextInput(hit) || closestIn(hit, '[data-plus],[data-port],[data-trigger]')) {
			return;
		}
		const nodeId = closestIn(hit, '.volt-wf-node')?.dataset.node;
		if (nodeId) {
			e.preventDefault();
			this._onDidRequestOpenNode.fire(nodeId);
			return;
		}
		const groupId = closestIn(hit, '[data-group-title]')?.dataset.groupTitle;
		if (groupId && !this.readOnly) {
			e.preventDefault();
			this.renameGroup(groupId);
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (isTextInput(e.target)) {
			return;
		}
		// Buttons in the floating chrome take Space and Enter themselves.
		if ((e.key === ' ' || e.key === 'Enter') && closestIn(e.target, '.volt-wf-chrome, button')) {
			return;
		}
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		const key = e.key;
		const lower = key.length === 1 ? key.toLowerCase() : key;
		const handled = (run: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			run();
		};
		if (key === ' ' && !mod) {
			handled(() => this.setSpace(true));
			return;
		}
		if (key === 'Escape') {
			handled(() => this.escape());
			return;
		}
		if (mod && !e.altKey) {
			if ((key === '=' || key === '+')) { handled(() => this.zoomIn()); return; }
			if (key === '-' || key === '_') { handled(() => this.zoomOut()); return; }
			if (key === '0') { handled(() => this.fitView(true)); return; }
		}
		if (e.shiftKey && !mod && !e.altKey) {
			if (e.code === 'Digit1') { handled(() => this.fitView(true)); return; }
			if (e.code === 'Digit0') { handled(() => this.resetZoom()); return; }
		}
		if (this.readOnly) {
			return;
		}
		const selection = this.model.selection;
		if (mod && !e.altKey) {
			if (lower === 'z' && !e.shiftKey) { handled(() => this.model.undo()); return; }
			if ((lower === 'z' && e.shiftKey) || lower === 'y') { handled(() => this.model.redo()); return; }
			if (lower === 'c' && !e.shiftKey) { if (selection.length) { handled(() => this.copy(selection)); } return; }
			if (lower === 'x' && !e.shiftKey) { if (selection.length) { handled(() => { this.copy(selection); this.remove(selection); }); } return; }
			if (lower === 'v') { handled(() => this.pasteAt(undefined)); return; }
			if (lower === 'd' && !e.shiftKey) { if (selection.length) { handled(() => this.duplicate(selection)); } return; }
			if (lower === 'a' && !e.shiftKey) { handled(() => this.selectAll()); return; }
			if (lower === 'g') { handled(() => e.shiftKey ? this.ungroupSelection() : this.group(selection)); return; }
			return;
		}
		if (e.shiftKey && e.altKey && e.code === 'KeyL') {
			handled(() => this.autoLayout(selection.length > 1));
			return;
		}
		if (mod || e.altKey) {
			return;
		}
		if (key === 'Delete' || key === 'Backspace') {
			if (selection.length || this.selectedEdges.size) {
				handled(() => this.removeSelection());
			}
			return;
		}
		if (key.startsWith('Arrow') && selection.length) {
			const base = this.snapValue ? GRID : 1;
			const step = e.shiftKey ? base * 10 : base;
			const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
			const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
			handled(() => this.nudge(dx, dy));
			return;
		}
		if (e.shiftKey) {
			return;
		}
		if (key === 'Tab' || lower === 'a') {
			handled(() => this.addFromKeyboard());
			return;
		}
		if (key === 'Enter' && selection.length === 1) {
			handled(() => this._onDidRequestOpenNode.fire(selection[0]));
			return;
		}
		if (key === 'F2' && selection.length === 1) {
			handled(() => this.renameNode(selection[0]));
		}
	}

	private escape(): void {
		if (this.gesture) {
			this.cancelGesture();
			return;
		}
		if (this.pending) {
			this.clearPendingConnection();
			return;
		}
		if (this.model.selection.length || this.selectedEdges.size) {
			this.selectedEdges.clear();
			this.model.setSelection([]);
			this.applySelection();
		}
	}

	/** Tab / A: a block after the selected node's first free port, else in the middle of the view. */
	private addFromKeyboard(): void {
		const selection = this.model.selection;
		const view = selection.length === 1 ? this.views.get(selection[0]) : undefined;
		if (view && view.layout.outputs.length) {
			const wired = new Set(this.definition.edges.filter(edge => edge.from === view.id).map(edge => edge.port));
			const port = view.layout.outputs.find(p => !wired.has(p.id)) ?? view.layout.outputs[0];
			this.requestAddAfterPort(view.id, port.id, 'keyboard');
			return;
		}
		this.refreshRect(true);
		const center = this.camera.screenToWorld([this.width / 2, this.height / 2]);
		const at = { x: Math.round(center[0] - CARD_WIDTH / 2), y: Math.round(center[1] - NEW_CARD_HEIGHT / 2) };
		this._onDidRequestAddNode.fire({ at: this.snapValue ? { x: snap(at.x), y: snap(at.y) } : at, client: this.worldToClient(center), via: 'keyboard' });
	}

	//#endregion

	//#region Menu host (also used by the toolbar and the keyboard)

	addNodeAt(client: Client): void {
		const world = this.toWorld([client.x, client.y]);
		const at = { x: Math.round(world[0]), y: Math.round(world[1]) };
		this._onDidRequestAddNode.fire({ at: this.snapValue ? { x: snap(at.x), y: snap(at.y) } : at, client, via: 'menu' });
	}

	selectAll(): void {
		this.selectedEdges.clear();
		this.model.setSelection(this.definition.nodes.map(node => node.id));
	}

	toggleSnap(): void {
		this.snapToGrid = !this.snapToGrid;
	}

	toggleMinimap(): void {
		this.showMinimap = !this.showMinimap;
	}

	openNode(id: string): void {
		this._onDidRequestOpenNode.fire(id);
	}

	runNode(id: string): void {
		this._onDidRequestNodeAction.fire({ nodeId: id, action: 'run' });
	}

	setColor(ids: readonly string[], color: WorkflowNodeColor | undefined): void {
		const set = new Set(ids);
		this.model.apply(localize('voltWorkflows.colorUndo', "Colour"), definition => ({
			...definition,
			nodes: definition.nodes.map(node => set.has(node.id) && node.color !== color ? withColor(node, color) : node),
		}));
	}

	setDisabled(ids: readonly string[], disabled: boolean): void {
		const set = new Set(ids);
		this.model.apply(disabled ? localize('voltWorkflows.disableUndo', "Disable") : localize('voltWorkflows.enableUndo', "Enable"), definition => ({
			...definition,
			nodes: definition.nodes.map(node => set.has(node.id) && !isStartType(node) && !!node.disabled !== disabled ? withDisabled(node, disabled) : node),
		}));
	}

	duplicate(ids: readonly string[]): void {
		const content = this.contentOf(ids);
		if (content.nodes.length) {
			this.selectedEdges.clear();
			this.model.insertNodes(content.nodes, content.edges, { x: GRID * 2, y: GRID * 2 }, content.groups, localize('voltWorkflows.duplicateUndo', "Duplicate"));
		}
	}

	group(ids: readonly string[]): void {
		if (ids.length) {
			this.model.groupNodes(ids, localize('voltWorkflows.groupTitle', "Group"));
		}
	}

	private ungroupSelection(): void {
		const selection = new Set(this.model.selection);
		const gone = new Set((this.definition.groups ?? []).filter(group => group.nodes.some(id => selection.has(id))).map(group => group.id));
		if (gone.size) {
			this.model.apply(localize('voltWorkflows.ungroupUndo', "Ungroup"), definition => ({ ...definition, groups: (definition.groups ?? []).filter(group => !gone.has(group.id)) }));
		}
	}

	copy(ids: readonly string[]): void {
		const content = this.contentOf(ids);
		if (!content.nodes.length) {
			return;
		}
		WorkflowCanvas.clipboard = content;
		void this.clipboardService.writeText(content.text);
	}

	/** Pastes YAML (nodes copied here, or a whole workflow copied from anywhere) at the pointer, or beside the originals. */
	pasteAt(client: Client | undefined): void {
		void this.paste(client);
	}

	private async paste(client: Client | undefined): Promise<void> {
		let text = '';
		try {
			text = await this.clipboardService.readText();
		} catch {
			text = '';
		}
		const own = WorkflowCanvas.clipboard;
		let content: Omit<IClipboardContent, 'text'> | undefined;
		if (own && (!text || text === own.text)) {
			content = own;
		} else if (text.trim()) {
			const parsed = parseWorkflowYaml(text);
			if (parsed.definition) {
				content = { nodes: parsed.definition.nodes, edges: parsed.definition.edges, groups: parsed.definition.groups ?? [] };
			}
		}
		if (!content?.nodes.length || this.isDisposed) {
			return;
		}
		const bounds = unionRects(content.nodes.map(node => nodeBounds(node.position, layoutNode(node))))!;
		let target: Vec | undefined;
		if (client) {
			target = this.toWorld([client.x, client.y]);
		} else if (this.pointerInside && this.pointer) {
			target = this.toWorld(this.pointer.client);
		} else {
			// Beside the originals when they are in view; else (a workflow copied elsewhere) in the middle of it.
			const [x0, y0] = this.camera.screenToWorld([0, 0]);
			const [x1, y1] = this.camera.screenToWorld([this.width, this.height]);
			if (!rectsIntersect({ x: bounds.x + GRID * 2, y: bounds.y + GRID * 2, width: bounds.width, height: bounds.height }, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) {
				target = [(x0 + x1) / 2, (y0 + y1) / 2];
			}
		}
		let delta: Vec;
		if (target) {
			const repeat = this.lastPaste && Math.hypot(this.lastPaste.at[0] - target[0], this.lastPaste.at[1] - target[1]) < 4;
			this.lastPaste = repeat ? { at: this.lastPaste!.at, count: this.lastPaste!.count + 1 } : { at: target, count: 0 };
			const step = this.lastPaste.count * GRID * 2;
			delta = [target[0] - (bounds.x + bounds.width / 2) + step, target[1] - (bounds.y + bounds.height / 2) + step];
		} else {
			delta = [GRID * 2, GRID * 2];
		}
		if (this.snapValue) {
			delta = [snap(delta[0]), snap(delta[1])];
		}
		this.selectedEdges.clear();
		this.model.insertNodes(content.nodes, content.edges, { x: Math.round(delta[0]), y: Math.round(delta[1]) }, content.groups, localize('voltWorkflows.pasteUndo', "Paste"));
	}

	private get isDisposed(): boolean {
		return !this.root.isConnected;
	}

	/** Selected nodes, the edges between them and their groups, plus the YAML of that partial workflow. */
	private contentOf(ids: readonly string[]): IClipboardContent {
		const set = new Set(ids);
		const definition = this.model.definition;
		const nodes = definition.nodes.filter(node => set.has(node.id));
		const edges = definition.edges.filter(edge => set.has(edge.from) && set.has(edge.to));
		const groups = (definition.groups ?? []).map(group => ({ ...group, nodes: group.nodes.filter(id => set.has(id)) })).filter(group => group.nodes.length);
		const partial: IWorkflowDefinition = { ...definition, nodes, edges, groups: groups.length ? groups : undefined };
		let text: string;
		try {
			text = serializeWorkflow(partial);
		} catch {
			text = JSON.stringify(partial, null, 2);
		}
		return { text, nodes, edges, groups };
	}

	remove(ids: readonly string[]): void {
		this.removeNodesAndEdges(ids, []);
	}

	private removeSelection(): void {
		this.removeNodesAndEdges(this.model.selection, [...this.selectedEdges]);
		this.selectedEdges.clear();
	}

	/** Nodes and loose edges in one undo step. The only start node stays. */
	private removeNodesAndEdges(nodeIds: readonly string[], edgeIds: readonly string[]): void {
		const definition = this.model.definition;
		const nodes = new Set(nodeIds);
		const starts = definition.nodes.filter(isStartType);
		if (starts.length <= 1) {
			for (const start of starts) {
				nodes.delete(start.id);
			}
		}
		const edges = new Set(edgeIds);
		if (!nodes.size && !edges.size) {
			return;
		}
		const label = nodes.size > 1 ? localize('voltWorkflows.deleteNodesUndo', "Delete {0} blocks", nodes.size)
			: nodes.size === 1 ? localize('voltWorkflows.deleteNodeUndo', "Delete block")
				: localize('voltWorkflows.deleteEdgeUndo', "Delete connection");
		this.model.apply(label, def => ({
			...def,
			nodes: def.nodes.filter(node => !nodes.has(node.id)),
			edges: def.edges.filter(edge => !edges.has(edge.id) && !nodes.has(edge.from) && !nodes.has(edge.to)),
			...(def.groups ? { groups: def.groups.map(group => ({ ...group, nodes: group.nodes.filter(id => !nodes.has(id)) })).filter(group => group.nodes.length) } : {}),
		}));
	}

	insertOnEdge(edgeIdValue: string, client: Client): void {
		const view = this.edgeViews.get(edgeIdValue);
		const mid = view?.route?.mid;
		if (!mid) {
			return;
		}
		this.edgeTools.hide();
		this.setHoverEdge(undefined);
		// Centred on the connection, its input on the connection's line.
		const at = { x: Math.round(mid[0] - CARD_WIDTH / 2), y: Math.round(mid[1] - FIRST_PORT_Y) };
		this._onDidRequestAddNode.fire({ at: this.snapValue ? { x: snap(at.x), y: at.y } : at, client, splitEdgeId: edgeIdValue, via: 'edge' });
	}

	removeEdge(edgeIdValue: string): void {
		this.edgeTools.hide();
		this.setHoverEdge(undefined);
		this.selectedEdges.delete(edgeIdValue);
		this.model.disconnect([edgeIdValue]);
	}

	selectGroup(groupId: string): void {
		const group = this.groupViews.get(groupId)?.group;
		if (group) {
			this.selectedEdges.clear();
			this.model.setSelection(group.nodes);
		}
	}

	setGroupColor(groupId: string, color: WorkflowNodeColor | undefined): void {
		const group = this.groupViews.get(groupId)?.group;
		if (!group) {
			return;
		}
		this.model.apply(localize('voltWorkflows.groupColorUndo', "Group colour"), definition => ({
			...definition,
			groups: (definition.groups ?? []).map(g => {
				if (g.id !== groupId) {
					return g;
				}
				const { color: _old, ...rest } = g;
				return color ? { ...rest, color } : rest;
			}),
		}));
	}

	ungroup(groupId: string): void {
		this.model.ungroup(groupId);
	}

	renameNode(id: string): void {
		const view = this.views.get(id);
		if (!view || this.readOnly) {
			return;
		}
		this.revealNode(id);
		const node = view.node;
		this.startInlineEdit(view.titleElement, node.name ?? '', view.titleElement.textContent ?? '', value => {
			const name = value.trim();
			const current = this.model.node(id);
			if (current && (current.name ?? '') !== name) {
				const { name: _old, ...rest } = current;
				this.model.apply(localize('voltWorkflows.renameUndo', "Rename"), definition => ({
					...definition,
					nodes: definition.nodes.map(n => n.id === id ? (name ? { ...rest, name } : rest) : n),
				}));
			}
		}, on => view.setFlag('renaming', on));
	}

	renameGroup(groupId: string): void {
		const view = this.groupViews.get(groupId);
		if (!view || this.readOnly) {
			return;
		}
		this.startInlineEdit(view.title, view.group.title, view.group.title, value => {
			const title = value.trim();
			if (title && title !== view.group.title) {
				this.model.updateGroup(groupId, { title });
			}
			// The title element was emptied for the input; the next render writes it back.
			view.title.textContent = view.group.title || localize('voltWorkflows.groupUntitled', "Group");
		}, on => view.frame.classList.toggle('renaming', on));
	}

	/** An input over `host`'s text: Enter or blur keeps it, Escape puts it back. */
	private startInlineEdit(host: HTMLElement, value: string, placeholder: string, onCommit: (value: string) => void, onToggle: (on: boolean) => void): void {
		this.renaming?.commit(true);
		const previous = host.textContent ?? '';
		const input = $('input.volt-wf-rename') as HTMLInputElement;
		input.type = 'text';
		input.value = value;
		input.placeholder = placeholder;
		input.spellcheck = false;
		host.textContent = '';
		host.appendChild(input);
		onToggle(true);
		const store = new DisposableStore();
		let done = false;
		const commit = (keep: boolean) => {
			if (done) {
				return;
			}
			done = true;
			store.dispose();
			this.renaming = undefined;
			onToggle(false);
			const next = input.value;
			input.remove();
			if (!host.textContent) {
				host.textContent = previous;
			}
			if (keep) {
				onCommit(next);
			}
			this.overlayDirty = true;
			this.requestFrame();
		};
		store.add(addDisposableListener(input, 'keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				commit(true);
				this.focus();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				commit(false);
				this.focus();
			}
		}));
		store.add(addDisposableListener(input, 'pointerdown', e => e.stopPropagation()));
		store.add(addDisposableListener(input, 'blur', () => commit(true)));
		this.renaming = { input, commit };
		this.overlayDirty = true;
		this.requestFrame();
		input.focus();
		input.select();
	}

	//#endregion

	private autoPan(): void {
		const g = this.gesture;
		const pointer = this.pointer;
		if (!g || !pointer || (g.kind !== 'move' && g.kind !== 'marquee' && !(g.kind === 'connect' && g.moved))) {
			return;
		}
		const [sx, sy] = this.toScreen(pointer.client);
		const push = (v: number, size: number) => v < EDGE_PAN_ZONE ? (EDGE_PAN_ZONE - Math.max(0, v)) / EDGE_PAN_ZONE : v > size - EDGE_PAN_ZONE ? -(v - (size - EDGE_PAN_ZONE)) / EDGE_PAN_ZONE : 0;
		const dx = Math.max(-1, Math.min(1, push(sx, this.width))) * EDGE_PAN_SPEED;
		const dy = Math.max(-1, Math.min(1, push(sy, this.height))) * EDGE_PAN_SPEED;
		if (!dx && !dy) {
			return;
		}
		this.camera.panBy(dx, dy);
		this.pointerDirty = true;
		this.requestFrame();
	}
}

