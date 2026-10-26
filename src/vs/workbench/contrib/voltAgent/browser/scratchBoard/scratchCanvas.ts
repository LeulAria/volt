/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/scratchBoard.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IReference, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING } from '../../common/canvasScratchSettings.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { isDark } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { bindingCandidateAt, boundConnectors, IBindingCandidate, IScratchRouteContext, portPosition, rebindConnector, retypeConnector, routeContext, withLegs } from '../../common/scratchBoard/scratchBinding.js';
import { darkModeColor } from '../../common/scratchBoard/scratchColor.js';
import { mermaidToElements, readingOrder } from '../../common/scratchBoard/scratchDiagram.js';
import { parseElement } from '../../common/scratchBoard/scratchDocument.js';
import { createCard, createDraw, createFrame, createIcon, createImage, createLabel, createLinear, createNote, createShape, createText, duplicateElements, newElementId, ScratchPatch } from '../../common/scratchBoard/scratchFactory.js';
import { freehandDrawing } from '../../common/scratchBoard/scratchDrawing.js';
import { simplifyStroke } from '../../common/scratchBoard/scratchFreehand.js';
import { elementBox, elementBounds, elementCenter, elementCorners, elementIntersectsSegment, elementOutline, elementsInMarquee, geometricBounds, hitTestElement, linearWorldPoints, topmostHit, withFrameContents, worldToLocal } from '../../common/scratchBoard/scratchGeometry.js';
import { extractMermaidSource, parseMermaidFlowchart } from '../../common/scratchBoard/scratchMermaid.js';
import { htmlToMarkdown, isEmptyRichText, looksLikeMarkdown } from '../../common/scratchBoard/scratchHtml.js';
import { layeredLayout } from '../../common/scratchBoard/scratchLayout.js';
import { boundsContain, boundsIntersect, boundsOfPoints, distance, expandBounds, lerp, normalize, rotate, sub, unionBounds, Vec } from '../../common/scratchBoard/scratchMath.js';
import { IScratchSceneChange, ScratchScene, ScratchTransaction } from '../../common/scratchBoard/scratchScene.js';
import { SHAPE_DEFAULT_SIZE, SHAPE_PORTS } from '../../common/scratchBoard/scratchShapes.js';
import { snapBounds, snapToGrid } from '../../common/scratchBoard/scratchSnapping.js';
import { alignMany, distributeMany, flipMany, moveMany, ResizeHandle, RESIZE_HANDLE_POSITIONS, resizeMany, resizeSingle, rotateMany, selectionBounds } from '../../common/scratchBoard/scratchTransform.js';
import {
	hasLabel, IScratchAgentRun, IScratchBounds, IScratchElementBase, IScratchLabel, IScratchLinearElement, IScratchStyleDefaults, isBindable, isLinear, isRichText,
	ScratchElement, ScratchPoint, ScratchPressurePoint, ScratchShapeKind, SCRATCH_GRID_SIZE,
} from '../../common/scratchBoard/scratchTypes.js';
import { IScratchAgentBridge } from './scratchAgentBridge.js';
import { ScratchBoardModel, IScratchBoardService } from './scratchBoardService.js';
import { ScratchCamera } from './scratchCamera.js';
import { ScratchCanvasState, ScratchTool } from './scratchCanvasState.js';
import { ScratchComments } from './scratchComments.js';
import { ScratchComposer, ScratchSelectionBar } from './scratchComposer.js';
import { registerScratchFonts, ScratchExporter } from './scratchExport.js';
import { ScratchInspector } from './scratchInspector.js';
import { ScratchLibrary } from './scratchLibrary.js';
import { showScratchContextMenu, showScratchMainMenu } from './scratchMenus.js';
import { ScratchMinimap, ScratchZoomBar } from './scratchMinimap.js';
import { HANDLE_SIZE, IOverlayHandle, IOverlayInput, ROTATE_HANDLE_OFFSET, ScratchOverlay } from './scratchOverlay.js';
import { appendPaths, ScratchRenderer } from './scratchRenderer.js';
import { markdownToRichHtml, plainTextAsRichHtml, sanitizeRichHtml } from './scratchRichText.js';
import { ScratchRuns } from './scratchRuns.js';
import { showScratchShortcuts } from './scratchShortcuts.js';
import { IScratchTextTarget, ScratchFormatBar, ScratchTextEditor } from './scratchTextEditor.js';
import { SHAPE_LABELS } from './scratchIcons.js';
import { ScratchToolbar } from './scratchToolbar.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLIPBOARD_MIME = 'application/x-volt-scratch';
const DRAG_THRESHOLD = 3;
const HIT_TOLERANCE = 6;
const SNAP_THRESHOLD = 6;
const ROTATE_SNAP = Math.PI / 12;
const MAX_IMAGE_SIDE = 960;
/** Larger SVGs are kept as images: the board file holds an icon's markup inline (up to 500K). */
const MAX_ICON_SVG_LENGTH = 400_000;
/** Text elements hold up to 2M characters; a longer paste would be cut short on reload. */
const MAX_PASTE_TEXT_LENGTH = 1_500_000;
/** Room kept between text that grew and the edge of the frame it grew in. */
const MEASURED_FRAME_PADDING = 32;

export interface IScratchCanvasHost {
	readonly boardTitle: () => string;
	readonly setBoardTitle: (title: string) => void;
	/** The project the board's chats run in (the chat's beside it, else the window's); undefined for none. */
	readonly agentProjectId: () => string | undefined;
	readonly newBoard: () => void;
	readonly showVersionHistory: () => void;
	/** Shows a run's chat (the page's agent dock). */
	readonly openRun: (sessionId: string) => void;
	/** Folds the open agent dock (Escape); false when it was not open. */
	readonly closeRun: () => boolean;
}

type Gesture =
	| { readonly kind: 'pan'; readonly pointerId: number; last: Vec }
	| { readonly kind: 'pending'; readonly pointerId: number; readonly start: Vec; readonly startWorld: Vec; readonly hitId: string | undefined; readonly shift: boolean; readonly alt: boolean; readonly insideSelection: boolean }
	| { readonly kind: 'move'; readonly pointerId: number; readonly tx: ScratchTransaction; readonly startWorld: Vec; readonly ids: readonly string[]; readonly originals: ReadonlyMap<string, ScratchElement>; readonly selectionBefore: readonly string[] }
	/** `comment`: the comment tool's box; what it takes gets one comment on release. */
	| { readonly kind: 'marquee'; readonly pointerId: number; readonly startWorld: Vec; currentWorld: Vec; readonly additive: boolean; readonly base: ReadonlySet<string>; readonly comment?: boolean }
	| { readonly kind: 'resize'; readonly pointerId: number; readonly tx: ScratchTransaction; readonly handle: ResizeHandle; readonly originals: readonly ScratchElement[]; readonly startBounds: IScratchBounds; readonly grab: Vec; readonly single: boolean }
	| { readonly kind: 'rotate'; readonly pointerId: number; readonly tx: ScratchTransaction; readonly center: Vec; readonly startAngle: number; readonly originals: readonly ScratchElement[] }
	| { readonly kind: 'create'; readonly pointerId: number; readonly tx: ScratchTransaction; readonly tool: ScratchTool; readonly shape: ScratchShapeKind; readonly startWorld: Vec; id: string | undefined }
	| { readonly kind: 'linear'; readonly pointerId: number; readonly tx: ScratchTransaction; readonly id: string; readonly startScreen: Vec; moved: boolean }
	| { readonly kind: 'point'; readonly pointerId: number; readonly tx: ScratchTransaction; readonly id: string; index: number; readonly grab: Vec; insert?: { readonly local: ScratchPoint; readonly world: Vec } }
	| { readonly kind: 'draw'; readonly pointerId: number; readonly points: ScratchPressurePoint[]; readonly simulate: boolean; readonly preview: SVGSVGElement }
	| { readonly kind: 'erase'; readonly pointerId: number; last: Vec; readonly trail: Vec[]; readonly hits: Set<string> }
	| { readonly kind: 'laser'; readonly pointerId: number };

/** A connector being drawn point by point (click, click, ..., Enter). */
interface ILinearDraft {
	readonly tx: ScratchTransaction;
	readonly id: string;
}

interface IBindingPreview {
	readonly candidate: IBindingCandidate;
}

/**
 * The Scratch board: an infinite canvas with Excalidraw's tools, draw.io's connectors and a
 * direct line to Volt's agents. Owns the camera, the pointer and keyboard state machine, and
 * the floating chrome; the scene (and its saving) comes from a ScratchBoardModel.
 */
export class ScratchCanvas extends Disposable {

	readonly element: HTMLElement;
	readonly state: ScratchCanvasState;
	readonly camera: ScratchCamera;
	readonly exporter: ScratchExporter;

	private readonly stage: HTMLElement;
	private readonly grid: HTMLElement;
	private readonly world: HTMLElement;
	private readonly previewLayer: HTMLElement;
	private readonly overlay: ScratchOverlay;
	private readonly chrome: HTMLElement;
	private readonly hint: HTMLElement;
	private readonly welcome: HTMLElement;
	private readonly textEditor: ScratchTextEditor;
	private readonly formatBar: ScratchFormatBar;
	private readonly toolbar: ScratchToolbar;
	private readonly inspector: ScratchInspector;
	private readonly zoomBar: ScratchZoomBar;
	private readonly minimap: ScratchMinimap;
	private readonly selectionBar: ScratchSelectionBar;
	/** Comments waiting for an agent, pinned on the board. */
	readonly comments: ScratchComments;
	private readonly composer: ScratchComposer;
	private readonly runs: ScratchRuns;
	private readonly library: ScratchLibrary;

	private modelRef: IReference<ScratchBoardModel> | undefined;
	private readonly modelStore = this._register(new DisposableStore());
	private renderer: ScratchRenderer | undefined;
	private readonly rendererStore = this._register(new MutableDisposable<ScratchRenderer>());
	private gesture: Gesture | undefined;
	private linearDraft: ILinearDraft | undefined;
	private binding: IBindingPreview | undefined;
	private guides: { from: Vec; to: Vec }[] = [];
	private frameTarget: string | undefined;
	private hoverId: string | undefined;
	/** Connectors faded while the pointer rests on a shape joined to others. */
	private fadedIds = new Set<string>();
	private spaceHeld = false;
	private pointerScreen: Vec | undefined;
	private lastPaste: { at: Vec; count: number } | undefined;
	private laserTrail: { at: Vec; time: number }[] = [];
	private laserLoop = false;
	private frameQueued = false;
	private cullQueued = false;
	private visible = false;
	/** Places the opened board's view once the canvas has a size. */
	private pendingView: (() => void) | undefined;
	private width = 0;
	private height = 0;
	private dark = false;
	private readonly touches = new Map<number, Vec>();
	private pinch: { startDistance: number; startZoom: number; startCenter: Vec; startWorld: Vec } | undefined;
	private cursor = '';
	private willChangeTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChangeScene = this._register(new Emitter<IScratchSceneChange>());
	readonly onDidChangeScene: Event<IScratchSceneChange> = this._onDidChangeScene.event;
	private readonly _onDidChangeModel = this._register(new Emitter<void>());
	readonly onDidChangeModel: Event<void> = this._onDidChangeModel.event;
	private readonly _onDidStartRun = this._register(new Emitter<IScratchAgentRun>());
	/** A chat was started from this board (the composer's Send): the page's dock follows it. */
	readonly onDidStartRun: Event<IScratchAgentRun> = this._onDidStartRun.event;
	private readonly _onDidOpenComposer = this._register(new Emitter<void>());
	/** The Ask Agent composer opened: the page's dock folds to its bar so it does not cover it. */
	readonly onDidOpenComposer: Event<void> = this._onDidOpenComposer.event;

	constructor(
		parent: HTMLElement,
		private readonly host: IScratchCanvasHost,
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IScratchAgentBridge private readonly agents: IScratchAgentBridge,
		@IThemeService private readonly themeService: IThemeService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING)) {
				this.toolbar.refresh();
				this.requestFrame();
			}
		}));
		this.state = this._register(new ScratchCanvasState(storageService));
		this.element = append(parent, $('.sx-canvas'));
		this.element.tabIndex = 0;
		this.element.setAttribute('role', 'application');
		this.element.setAttribute('aria-roledescription', localize('voltScratch.roleDescription', "whiteboard"));
		this.element.setAttribute('aria-label', localize('voltScratch.ariaLabel', "Scratch board"));
		this.stage = append(this.element, $('.sx-stage'));
		this.grid = append(this.stage, $('.sx-grid'));
		this.world = append(this.stage, $('.sx-world'));
		this.previewLayer = append(this.world, $('.sx-preview'));
		this.overlay = new ScratchOverlay(this.stage);
		this.camera = this._register(new ScratchCamera(this.stage));
		this.exporter = this.instantiationService.createInstance(ScratchExporter);
		registerScratchFonts(parent.ownerDocument);

		this.welcome = append(this.stage, $('.sx-welcome'));
		this.renderWelcome();

		this.chrome = append(this.element, $('.sx-chrome'));
		this.runs = this._register(this.instantiationService.createInstance(ScratchRuns, this.chrome, this));
		this.hint = append(this.chrome, $('.sx-hint'));
		this.toolbar = this._register(this.instantiationService.createInstance(ScratchToolbar, this.chrome, this, host));
		// Pins sit under the panels; their count and Send are in the top right.
		this.comments = this._register(this.instantiationService.createInstance(ScratchComments, this.chrome, this.toolbar.commentsSlot, this));
		this.chrome.insertBefore(this.comments.layerElement, this.hint);
		this.inspector = this._register(this.instantiationService.createInstance(ScratchInspector, this.chrome, this));
		this.zoomBar = this._register(this.instantiationService.createInstance(ScratchZoomBar, this.chrome, this));
		this.minimap = this._register(this.instantiationService.createInstance(ScratchMinimap, this.chrome, this));
		this.selectionBar = this._register(this.instantiationService.createInstance(ScratchSelectionBar, this.chrome, this));
		this.composer = this._register(this.instantiationService.createInstance(ScratchComposer, this.chrome, this));
		this.library = this._register(this.instantiationService.createInstance(ScratchLibrary, this.chrome, this));
		this._register(this.library.onDidChangeOpen(() => this.toolbar.refresh()));

		this.textEditor = this._register(new ScratchTextEditor({
			commit: (target, html) => this.commitText(target, html),
			didInput: () => this.requestFrame(),
			askLink: current => this.askLink(current),
		}));
		this.formatBar = this._register(new ScratchFormatBar(this.chrome, this.textEditor));

		this.dark = this.resolveDark();
		this._register(this.themeService.onDidColorThemeChange(() => this.updateTheme()));
		this._register(this.camera.onDidChange(() => this.onCameraChange()));
		this._register(this.state.onDidChangeTool(() => this.onToolChange()));
		this._register(this.state.onDidChangeSelection(() => {
			this.requestFrame();
			this.showHint();
		}));
		this._register(this.agents.onDidChange(() => this.requestFrame()));
		this.installInput();
		this.onToolChange();
		// Text being typed reaches the board when editing ends: end it before the window goes.
		this._register(lifecycleService.onBeforeShutdown(() => {
			this.textEditor.commit();
			this.finishLinearDraft(true);
		}));
		this._register(toDisposable(() => {
			this.textEditor.commit();
			this.cancelGesture();
			this.finishLinearDraft(false);
			this.modelRef?.dispose();
			this.modelRef = undefined;
			if (this.willChangeTimer) {
				clearTimeout(this.willChangeTimer);
			}
		}));
	}

	// ---- Board ---------------------------------------------------------------------------

	get model(): ScratchBoardModel | undefined {
		return this.modelRef?.object;
	}

	get scene(): ScratchScene | undefined {
		return this.modelRef?.object.scene;
	}

	get isDarkBoard(): boolean {
		return this.dark;
	}

	/** Shows a board; the previous one is saved and released. */
	async open(boardId: string): Promise<void> {
		if (this.model?.id === boardId) {
			return;
		}
		const ref = await this.boards.acquireModel(boardId);
		if (this._store.isDisposed) {
			ref.dispose();
			return;
		}
		this.textEditor.commit();
		this.cancelGesture();
		this.finishLinearDraft(true);
		this.modelStore.clear();
		this.modelRef?.dispose();
		this.modelRef = ref;
		const model = ref.object;
		const scene = model.scene;
		const renderer = new ScratchRenderer(this.world, scene, {
			languageService: this.languageService,
			assetUrl: (assetId, mime) => this.boards.assetUrl(assetId, mime),
			onDidMeasure: (id, width, height) => this.applyMeasuredSize(id, width, height),
			labelBackground: () => this.mapColor(scene.settings.background),
		});
		this.rendererStore.value = renderer;
		this.renderer = renderer;
		this.fadedIds = new Set();
		renderer.setDark(this.dark);
		this.state.setSelection([]);
		this.state.setEditingGroup(null);
		renderer.renderAll();
		this.modelStore.add(scene.onDidChange(change => this.onSceneChange(change)));
		this.modelStore.add(scene.onDidRestoreSelection(ids => this.state.setSelection(ids)));
		this.modelStore.add(scene.onDidChangeHistory(() => this.zoomBar.refresh()));
		this.modelStore.add(model.onDidReloadFromDisk(() => this.requestFrame()));
		this.applySettings();
		const camera = model.camera;
		const applyView = () => {
			if (camera) {
				// Saved for another viewport size: keep the same middle.
				const dx = camera.viewWidth ? (this.width - camera.viewWidth) / 2 : 0;
				const dy = camera.viewHeight ? (this.height - camera.viewHeight) / 2 : 0;
				this.camera.set({ x: camera.x + dx, y: camera.y + dy, zoom: camera.zoom });
			} else if (scene.size) {
				this.zoomToFit(false);
			} else {
				this.camera.set({ x: this.width / 2, y: this.height / 2, zoom: 1 });
			}
		};
		// Before the first layout there is no viewport to place the view in yet.
		this.pendingView = this.width > 0 && this.height > 0 ? undefined : applyView;
		if (!this.pendingView) {
			applyView();
		}
		this.boards.setLastOpened(boardId);
		this._onDidChangeModel.fire();
		this.zoomBar.refresh();
		this.onSceneChanged();
		this.scheduleCull();
		this.requestFrame();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.textEditor.commit();
			this.cancelGesture();
			this.finishLinearDraft(true);
			void this.model?.flush();
		} else {
			this.requestFrame();
		}
	}

	layout(width: number, height: number): void {
		const firstLayout = this.width === 0 || this.height === 0;
		const cam = this.camera.value;
		// Keep the board's centre where it was when the window resizes.
		const dx = firstLayout ? 0 : (width - this.width) / 2;
		const dy = firstLayout ? 0 : (height - this.height) / 2;
		this.width = width;
		this.height = height;
		this.camera.setViewportSize(width, height);
		if (dx || dy) {
			this.camera.set({ ...cam, x: cam.x + dx, y: cam.y + dy });
		}
		const pending = width > 0 && height > 0 ? this.pendingView : undefined;
		if (pending) {
			this.pendingView = undefined;
			pending();
		}
		this.minimap.layout();
		this.scheduleCull();
		this.requestFrame();
	}

	/** The title, the boards toggle and the tool states, after the page changed them. */
	refreshChrome(): void {
		this.toolbar.refresh();
	}

	focus(): void {
		if (!this.textEditor.active) {
			this.element.focus({ preventScroll: true });
		}
	}

	get viewportSize(): { width: number; height: number } {
		return { width: this.width, height: this.height };
	}

	// ---- Theme ---------------------------------------------------------------------------

	private resolveDark(): boolean {
		const theme = this.scene?.settings.theme ?? 'auto';
		return theme === 'auto' ? isDark(this.themeService.getColorTheme().type) : theme === 'dark';
	}

	private updateTheme(): void {
		const dark = this.resolveDark();
		if (dark !== this.dark) {
			this.dark = dark;
			this.renderer?.setDark(dark);
		}
		this.applySettings();
	}

	mapColor(color: string): string {
		return this.dark ? darkModeColor(color) : color;
	}

	private applySettings(): void {
		const scene = this.scene;
		if (!scene) {
			return;
		}
		const dark = this.resolveDark();
		if (dark !== this.dark) {
			this.dark = dark;
			this.renderer?.setDark(dark);
		}
		const settings = scene.settings;
		const bg = this.mapColor(settings.background);
		this.element.style.setProperty('--sx-board', bg);
		this.element.classList.toggle('sx-dark', this.dark);
		this.element.classList.toggle('sx-light', !this.dark);
		this.grid.dataset.grid = settings.grid;
		this.updateGrid();
		this.requestFrame();
	}

	private updateGrid(): void {
		const settings = this.scene?.settings;
		if (!settings || settings.grid === 'none') {
			this.grid.style.backgroundImage = 'none';
			return;
		}
		const cam = this.camera.value;
		let size = SCRATCH_GRID_SIZE * cam.zoom;
		// Coarser when zoomed out so the pattern never turns into noise.
		while (size < 12) {
			size *= 5;
		}
		const major = size * 5;
		const dot = this.dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)';
		const line = this.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
		const lineMajor = this.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.085)';
		if (settings.grid === 'dots') {
			const r = Math.max(0.8, Math.min(1.4, cam.zoom));
			this.grid.style.backgroundImage = `radial-gradient(circle at ${r}px ${r}px, ${dot} ${r}px, transparent ${r + 0.6}px)`;
			this.grid.style.backgroundSize = `${size}px ${size}px`;
			this.grid.style.backgroundPosition = `${(cam.x % size) - r}px ${(cam.y % size) - r}px`;
		} else {
			this.grid.style.backgroundImage = `linear-gradient(${lineMajor} 1px, transparent 1px), linear-gradient(90deg, ${lineMajor} 1px, transparent 1px), linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`;
			this.grid.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${size}px ${size}px, ${size}px ${size}px`;
			this.grid.style.backgroundPosition = `${cam.x % major}px ${cam.y % major}px, ${cam.x % major}px ${cam.y % major}px, ${cam.x % size}px ${cam.y % size}px, ${cam.x % size}px ${cam.y % size}px`;
		}
	}

	// ---- Scene changes and painting ------------------------------------------------------

	private onSceneChange(change: IScratchSceneChange): void {
		this.renderer?.sync(change);
		if (change.settings) {
			this.applySettings();
		}
		if (change.removed.size) {
			const selection = this.state.selection;
			if ([...change.removed].some(id => selection.has(id))) {
				this.state.setSelection([...selection].filter(id => !change.removed.has(id)));
			}
		}
		this._onDidChangeScene.fire(change);
		if (!change.live) {
			this.onSceneChanged();
		}
		this.scheduleCull();
		this.requestFrame();
	}

	private onSceneChanged(): void {
		this.welcome.classList.toggle('visible', !!this.scene && this.scene.size === 0);
		this.showHint();
		this.minimap.refresh();
		this.zoomBar.refresh();
		this.inspector.refresh();
	}

	private onCameraChange(): void {
		const cam = this.camera.value;
		this.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
		this.world.style.setProperty('--sx-zoom', String(cam.zoom));
		this.element.style.setProperty('--sx-zoom', String(cam.zoom));
		// Promote the layer while it moves, then let it re-raster crisp at the new zoom.
		this.world.classList.add('sx-moving');
		if (this.willChangeTimer) {
			clearTimeout(this.willChangeTimer);
		}
		this.willChangeTimer = setTimeout(() => this.world.classList.remove('sx-moving'), 160);
		this.updateGrid();
		if (this.width > 0 && this.height > 0 && !this.pendingView) {
			this.model?.setCamera({ ...cam, viewWidth: this.width, viewHeight: this.height });
		}
		this.zoomBar.refresh();
		this.scheduleCull();
		this.requestFrame();
	}

	private scheduleCull(): void {
		if (this.cullQueued) {
			return;
		}
		this.cullQueued = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.cullQueued = false;
			if (this.width && this.height) {
				this.renderer?.setViewport(expandBounds(this.camera.visibleBounds(), 200 / this.camera.zoom));
			}
		});
	}

	requestFrame(): void {
		// A hidden tab paints nothing; showing it again asks for a frame.
		if (this.frameQueued || !this.visible) {
			return;
		}
		this.frameQueued = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.frameQueued = false;
			this.paintFrame();
		});
	}

	private paintFrame(): void {
		this.overlay.render(this.overlayInput());
		this.minimap.paintViewport();
		const editing = this.textEditor.active;
		if (editing) {
			const rect = this.editingScreenRect();
			if (rect) {
				this.formatBar.show(rect, this.viewportSize);
			}
		} else {
			this.formatBar.hide();
		}
		const selected = this.selectedElements();
		const busy = !!this.gesture && this.gesture.kind !== 'pending';
		const screenBounds = selected.length && !editing ? this.selectionScreenBounds(selected) : undefined;
		this.selectionBar.layout(busy || this.composer.isOpen || this.comments.isOpen ? undefined : screenBounds, selected);
		this.composer.layout(screenBounds);
		this.runs.layout();
		this.comments.layout();
	}

	// ---- Coordinates ---------------------------------------------------------------------

	private clientToScreen(e: { clientX: number; clientY: number }): Vec {
		const rect = this.stage.getBoundingClientRect();
		return [e.clientX - rect.left, e.clientY - rect.top];
	}

	toScreen(p: Vec): Vec {
		return this.camera.worldToScreen(p);
	}

	toWorld(p: Vec): Vec {
		return this.camera.screenToWorld(p);
	}

	/** Viewport centre in world coordinates. */
	viewportCenterWorld(): Vec {
		return this.toWorld([this.width / 2, this.height / 2]);
	}

	stageClientRect(): DOMRect {
		return this.stage.getBoundingClientRect();
	}

	// ---- Selection -----------------------------------------------------------------------

	/**
	 * The selection with everything inside its frames, in paint order: what delete, copy, duplicate,
	 * export and send act on (a frame goes with its contents, as it does when moved).
	 */
	selectedWithContents(): ScratchElement[] {
		const scene = this.scene;
		if (!scene) {
			return [];
		}
		const ids = withFrameContents(scene.getElements(), new Set(this.state.selection));
		return scene.getElements().filter(el => ids.has(el.id));
	}

	selectedElements(): ScratchElement[] {
		const scene = this.scene;
		if (!scene) {
			return [];
		}
		const out: ScratchElement[] = [];
		for (const el of scene.getElements()) {
			if (this.state.selection.has(el.id)) {
				out.push(el);
			}
		}
		return out;
	}

	/** The ids a click on `el` selects: its outermost group above the group being edited. */
	private selectableIds(el: ScratchElement): string[] {
		const scene = this.scene!;
		const groups = el.groupIds;
		const editing = this.state.editingGroupId;
		let level: string | undefined;
		if (editing) {
			const at = groups.indexOf(editing);
			if (at < 0) {
				this.state.setEditingGroup(null);
				level = groups[groups.length - 1];
			} else {
				level = at > 0 ? groups[at - 1] : undefined;
			}
		} else {
			level = groups[groups.length - 1];
		}
		if (!level) {
			return [el.id];
		}
		return scene.getElements().filter(e => e.groupIds.includes(level!)).map(e => e.id);
	}

	select(ids: Iterable<string>): void {
		this.state.setSelection(ids);
	}

	selectAll(): void {
		const scene = this.scene;
		if (scene) {
			this.state.setEditingGroup(null);
			this.state.setSelection(scene.getElements().filter(e => !e.locked).map(e => e.id));
		}
	}

	private selectionScreenBounds(elements: readonly ScratchElement[]): IScratchBounds | undefined {
		const b = selectionBounds(elements);
		if (!b) {
			return undefined;
		}
		const a = this.toScreen([b.minX, b.minY]);
		const c = this.toScreen([b.maxX, b.maxY]);
		return { minX: a[0], minY: a[1], maxX: c[0], maxY: c[1] };
	}

	/** Groups whose every member is selected. */
	private selectedGroups(elements: readonly ScratchElement[]): string[] {
		const scene = this.scene!;
		const selected = this.state.selection;
		const seen = new Set<string>();
		const out: string[] = [];
		for (const el of elements) {
			for (const g of el.groupIds) {
				if (seen.has(g)) {
					continue;
				}
				seen.add(g);
				if (scene.getElements().every(e => !e.groupIds.includes(g) || selected.has(e.id))) {
					out.push(g);
				}
			}
		}
		return out;
	}

	// ---- Overlay -------------------------------------------------------------------------

	/** The selection's transform box: a rotated box for one element, an upright one for several. */
	private transformBox(selected: readonly ScratchElement[]): { corners: Vec[]; handles: IOverlayHandle[]; dashed: boolean } | undefined {
		if (!selected.length || selected.some(e => e.locked)) {
			return undefined;
		}
		const zoom = this.camera.zoom;
		if (selected.length === 1 && isLinear(selected[0])) {
			return undefined;
		}
		let worldCorners: Vec[];
		let angle = 0;
		const single = selected.length === 1 ? selected[0] : undefined;
		if (single) {
			worldCorners = elementCorners(single);
			angle = single.angle;
		} else {
			const b = selectionBounds(selected)!;
			worldCorners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
		}
		// A few pixels of breathing room around what is selected.
		const pad = 5 / zoom;
		const center: Vec = [(worldCorners[0][0] + worldCorners[2][0]) / 2, (worldCorners[0][1] + worldCorners[2][1]) / 2];
		const padded = worldCorners.map(c => {
			const local = rotate(c, center, -angle);
			const dx = local[0] < center[0] ? -pad : pad;
			const dy = local[1] < center[1] ? -pad : pad;
			return rotate([local[0] + dx, local[1] + dy], center, angle);
		});
		const corners = padded.map(c => this.toScreen(c));
		const handles: IOverlayHandle[] = [];
		const at = (fx: number, fy: number): Vec => {
			const top = lerp(corners[0], corners[1], fx);
			const bottom = lerp(corners[3], corners[2], fx);
			return lerp(top, bottom, fy);
		};
		const widthPx = distance(corners[0], corners[1]);
		const heightPx = distance(corners[0], corners[3]);
		const handleKinds = this.handleKindsFor(single);
		for (const kind of handleKinds) {
			const [fx, fy] = RESIZE_HANDLE_POSITIONS[kind];
			// Side handles crowd small boxes; corners stay.
			if ((kind === 'n' || kind === 's') && widthPx < 3 * HANDLE_SIZE) {
				continue;
			}
			if ((kind === 'e' || kind === 'w') && heightPx < 3 * HANDLE_SIZE) {
				continue;
			}
			handles.push({ kind, at: at(fx, fy) });
		}
		if (!single || single.type !== 'frame') {
			const topMid = at(0.5, 0);
			const up = normalize(sub(topMid, at(0.5, 1)));
			const dir = up[0] === 0 && up[1] === 0 ? [0, -1] as Vec : up;
			handles.push({ kind: 'rotate', at: [topMid[0] + dir[0] * ROTATE_HANDLE_OFFSET, topMid[1] + dir[1] * ROTATE_HANDLE_OFFSET] });
		}
		return { corners, handles, dashed: !single };
	}

	private handleKindsFor(single: ScratchElement | undefined): ResizeHandle[] {
		if (single?.type === 'text') {
			return ['nw', 'ne', 'se', 'sw', 'e', 'w'];
		}
		if (single?.type === 'card') {
			return ['nw', 'ne', 'se', 'sw', 'e', 'w'];
		}
		return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
	}

	private linearHandles(el: IScratchLinearElement): { at: Vec[]; mids: Vec[]; bound: boolean[]; worldMids: Vec[] } {
		const pts = linearWorldPoints(el);
		const at = pts.map(p => this.toScreen(p));
		const bound = pts.map((_, i) => (i === 0 && !!el.startBinding) || (i === pts.length - 1 && !!el.endBinding));
		const mids: Vec[] = [];
		const worldMids: Vec[] = [];
		if (el.arrowType !== 'elbow') {
			for (let i = 1; i < pts.length; i++) {
				const m = lerp(pts[i - 1], pts[i], 0.5);
				const s = this.toScreen(m);
				// Only where there is room between the two points.
				if (distance(at[i - 1], at[i]) > 36) {
					mids.push(s);
					worldMids.push(m);
				}
			}
		}
		if (el.arrowType === 'elbow') {
			return { at: [at[0], at[at.length - 1]], mids: [], bound: [bound[0], bound[bound.length - 1]], worldMids: [] };
		}
		return { at, mids, bound, worldMids };
	}

	private overlayInput(): IOverlayInput {
		const scene = this.scene;
		const empty: IOverlayInput = { outlines: [], groupOutlines: [], guides: [], runs: [] };
		if (!scene) {
			return empty;
		}
		const selected = this.selectedElements();
		const editing = this.textEditor.active;
		const gesture = this.gesture;
		const outlines: Vec[][] = [];
		const showHandles = !editing && (!gesture || gesture.kind === 'pending' || gesture.kind === 'resize' || gesture.kind === 'rotate' || gesture.kind === 'point');
		const multi = selected.length > 1;
		if (!editing) {
			for (const el of selected) {
				// In a multi-selection a connector's box says nothing (the line itself shows); shapes get theirs.
				if ((multi && !isLinear(el)) || el.locked || (!multi && isLinear(el) && !showHandles)) {
					outlines.push(elementOutline(el).map(p => this.toScreen(p)));
				}
			}
		}
		const groupOutlines: Vec[][] = [];
		for (const g of this.selectedGroups(selected)) {
			const members = scene.getElements().filter(e => e.groupIds.includes(g));
			const b = selectionBounds(members);
			if (b && multi) {
				const pad = 3;
				const a = this.toScreen([b.minX, b.minY]);
				const c = this.toScreen([b.maxX, b.maxY]);
				groupOutlines.push([[a[0] - pad, a[1] - pad], [c[0] + pad, a[1] - pad], [c[0] + pad, c[1] + pad], [a[0] - pad, c[1] + pad]]);
			}
		}
		let box: IOverlayInput['box'];
		let points: IOverlayInput['points'];
		if (showHandles && !this.linearDraft) {
			box = this.transformBox(selected);
			if (selected.length === 1 && isLinear(selected[0]) && !selected[0].locked) {
				const h = this.linearHandles(selected[0]);
				points = { at: h.at, mids: h.mids, bound: h.bound, active: gesture?.kind === 'point' ? gesture.index : undefined };
			}
		}
		let hover: Vec[] | undefined;
		if (this.hoverId && !this.state.selection.has(this.hoverId) && !gesture && (this.state.tool === 'select' || this.state.tool === 'comment')) {
			const el = scene.get(this.hoverId);
			if (el) {
				hover = elementOutline(el).map(p => this.toScreen(p));
			}
		}
		this.highlightConnectionsOf(scene, !!gesture && gesture.kind !== 'pending');
		let marquee: IOverlayInput['marquee'];
		if (gesture?.kind === 'marquee') {
			const a = this.toScreen(gesture.startWorld);
			const b = this.toScreen(gesture.currentWorld);
			marquee = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
		}
		let binding: IOverlayInput['binding'];
		if (this.binding) {
			const target = scene.get(this.binding.candidate.element.id) ?? this.binding.candidate.element;
			binding = {
				outline: elementOutline(target).map(p => this.toScreen(p)),
				ports: target.type === 'frame' ? [] : SHAPE_PORTS.map((_, i) => this.toScreen(portPosition(target, i))),
				activePort: this.binding.candidate.port,
			};
		}
		let editingOutline: Vec[] | undefined;
		if (editing) {
			const rect = this.editingScreenRect();
			if (rect) {
				editingOutline = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]];
			}
		}
		const guides = this.guides.map(g => ({ from: this.toScreen(g.from), to: this.toScreen(g.to) }));
		let eraser: Vec[] | undefined;
		if (gesture?.kind === 'erase') {
			eraser = gesture.trail.slice(-24).map(p => this.toScreen(p));
		}
		const now = Date.now();
		const laser = this.laserTrail.map(p => ({ at: p.at, age: now - p.time }));
		let frameHighlight: Vec[] | undefined;
		if (this.frameTarget) {
			const frame = scene.get(this.frameTarget);
			if (frame) {
				frameHighlight = elementCorners(frame).map(p => this.toScreen(p));
			}
		}
		return { outlines, groupOutlines, box, points, hover, marquee, guides, binding, eraser, laser, editing: editingOutline, runs: this.runs.outlines(), frameHighlight };
	}

	/** Whether hovering lights up connections (Settings > Canvas & Scratch, and the board menu). */
	get highlightConnections(): boolean {
		return this.configurationService.getValue<boolean>(SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING) !== false;
	}

	setHighlightConnections(on: boolean): void {
		void this.configurationService.updateValue(SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING, on);
	}

	/**
	 * What the hovered element is joined to, the way node canvases show it: a shape, its
	 * connectors and the elements at their other ends stay as drawn while everything else greys
	 * out; a connector keeps the two elements it joins. Frames stay (they hold the diagram).
	 * Nothing while dragging.
	 */
	private highlightConnectionsOf(scene: ScratchScene, busy: boolean): void {
		const el = this.highlightConnections && !busy && this.state.tool === 'select' && this.hoverId ? scene.get(this.hoverId) : undefined;
		let connectors: IScratchLinearElement[] = [];
		if (el && isLinear(el)) {
			connectors = el.startBinding || el.endBinding ? [el] : [];
		} else if (el) {
			connectors = boundConnectors(scene.getElements(), new Set([el.id]));
		}
		const faded = new Set<string>();
		if (el && connectors.length) {
			const lit = new Set<string>([el.id]);
			for (const c of connectors) {
				lit.add(c.id);
				for (const binding of [c.startBinding, c.endBinding]) {
					if (binding) {
						lit.add(binding.elementId);
					}
				}
			}
			for (const other of scene.getElements()) {
				if (!lit.has(other.id) && other.type !== 'frame') {
					faded.add(other.id);
				}
			}
		}
		this.setFaded(faded);
	}

	private setFaded(ids: ReadonlySet<string>): void {
		if (!this.renderer) {
			return;
		}
		for (const id of this.fadedIds) {
			if (!ids.has(id)) {
				this.renderer.setClass(id, 'sx-faded', false);
			}
		}
		for (const id of ids) {
			if (!this.fadedIds.has(id)) {
				this.renderer.setClass(id, 'sx-faded', true);
			}
		}
		this.fadedIds = new Set(ids);
	}

	private editingScreenRect(): { x: number; y: number; width: number; height: number } | undefined {
		const target = this.textEditor.active;
		if (!target) {
			return undefined;
		}
		const stage = this.stage.getBoundingClientRect();
		const r = target.host.getBoundingClientRect();
		return { x: r.left - stage.left - 4, y: r.top - stage.top - 4, width: r.width + 8, height: r.height + 8 };
	}

	// ---- Input ---------------------------------------------------------------------------

	private installInput(): void {
		const stage = this.stage;
		this._register(addDisposableListener(stage, 'pointerdown', e => this.onPointerDown(e)));
		this._register(addDisposableListener(stage, 'pointermove', e => this.onPointerMove(e)));
		this._register(addDisposableListener(stage, 'pointerup', e => this.onPointerUp(e)));
		this._register(addDisposableListener(stage, 'pointercancel', e => this.onPointerCancel(e)));
		this._register(addDisposableListener(stage, 'lostpointercapture', e => {
			if (this.gesture && 'pointerId' in this.gesture && this.gesture.pointerId === e.pointerId) {
				this.onPointerUp(e);
			}
		}));
		this._register(addDisposableListener(stage, 'pointerleave', () => {
			if (!this.gesture) {
				this.setHover(undefined);
			}
		}));
		this._register(addDisposableListener(stage, 'dblclick', e => this.onDoubleClick(e)));
		this._register(addDisposableListener(stage, 'wheel', e => this.onWheel(e), { passive: false }));
		this._register(addDisposableListener(stage, 'contextmenu', e => this.onContextMenu(e)));
		this._register(addDisposableListener(this.element, 'keydown', e => this.onKeyDown(e)));
		this._register(addDisposableListener(this.element, 'keyup', e => this.onKeyUp(e)));
		this._register(addDisposableListener(this.element, 'copy', e => this.onCopy(e, false)));
		this._register(addDisposableListener(this.element, 'cut', e => this.onCopy(e, true)));
		this._register(addDisposableListener(this.element, 'paste', e => this.onPaste(e)));
		this._register(addDisposableListener(stage, 'dragover', e => {
			if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes(ScratchLibrary.DRAG_MIME)) {
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer!.dropEffect = 'copy';
			}
		}));
		this._register(addDisposableListener(stage, 'drop', e => this.onDrop(e)));
		this._register(addDisposableListener(getWindow(this.element), 'blur', () => {
			this.spaceHeld = false;
			this.updateCursor();
		}));
		// Gesture events (Safari) are not sent by Chromium; pinch arrives as ctrl+wheel.
	}

	private isTextInput(target: EventTarget | null): boolean {
		return isHTMLElement(target) && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
	}

	private onWheel(e: WheelEvent): void {
		if (this.isTextInput(e.target) && !this.textEditor.active) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const screen = this.clientToScreen(e);
		const lineFactor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
		if (e.ctrlKey || e.metaKey) {
			// Pinch and Cmd+wheel zoom at the pointer.
			const delta = Math.max(-60, Math.min(60, e.deltaY * lineFactor));
			this.camera.zoomAt(this.camera.zoom * Math.exp(-delta * 0.0105), screen);
			return;
		}
		let dx = e.deltaX * lineFactor;
		let dy = e.deltaY * lineFactor;
		if (e.shiftKey && !dx) {
			dx = dy;
			dy = 0;
		}
		this.camera.panBy(-dx, -dy);
	}

	private onPointerDown(e: PointerEvent): void {
		const screen = this.clientToScreen(e);
		this.pointerScreen = screen;
		if (e.pointerType === 'touch') {
			this.touches.set(e.pointerId, screen);
			if (this.touches.size === 2) {
				this.startPinch();
				return;
			}
		}
		if (this.gesture || this.pinch) {
			return;
		}
		const target = e.target as HTMLElement | null;
		if (target?.closest?.('.sx-chrome-item')) {
			return;
		}
		if (this.textEditor.active) {
			// A click outside the text ends editing; the click then does what it would anyway.
			this.textEditor.commit();
		}
		this.element.focus({ preventScroll: true });
		this.composer.dismissIfIdle();
		const world = this.toWorld(screen);
		const scene = this.scene;
		if (!scene) {
			return;
		}
		if (e.button === 1 || (e.button === 0 && (this.spaceHeld || this.state.tool === 'hand'))) {
			this.beginGesture(e, { kind: 'pan', pointerId: e.pointerId, last: screen });
			return;
		}
		if (e.button === 2) {
			// Right click selects what it is on (if it is not already), then the menu opens.
			const hit = this.hitAt(world, true);
			if (hit && !this.state.selection.has(hit.id)) {
				this.select(this.selectableIds(hit));
			} else if (!hit) {
				this.select([]);
			}
			return;
		}
		if (e.button !== 0) {
			return;
		}
		if (this.linearDraft) {
			this.addDraftPoint(world, e);
			return;
		}
		switch (this.state.tool) {
			case 'select': this.selectDown(e, screen, world); return;
			case 'shape':
			case 'frame':
			case 'note':
			case 'card': this.createDown(e, world); return;
			case 'arrow':
			case 'line': this.linearDown(e, screen, world); return;
			case 'draw': this.drawDown(e, world); return;
			case 'text': this.textDown(e, world); return;
			case 'eraser': this.beginGesture(e, { kind: 'erase', pointerId: e.pointerId, last: world, trail: [world], hits: new Set() }); this.eraseAt(world, world); return;
			case 'laser': this.beginGesture(e, { kind: 'laser', pointerId: e.pointerId }); this.addLaser(screen); return;
			case 'image': void this.pickImage(world); return;
			case 'comment': this.commentDown(e, world); return;
		}
	}

	private beginGesture(e: PointerEvent, gesture: Gesture): void {
		this.gesture = gesture;
		try {
			this.stage.setPointerCapture(e.pointerId);
		} catch {
			// Synthetic events have no capture.
		}
		this.updateCursor();
		this.requestFrame();
	}

	private hitAt(world: Vec, includeLocked = false): ScratchElement | undefined {
		const scene = this.scene;
		if (!scene) {
			return undefined;
		}
		const tolerance = HIT_TOLERANCE / this.camera.zoom;
		const hit = topmostHit(scene.getElements(), world, tolerance, this.state.selection);
		// A frame's name is its handle: grabbing it takes the frame and all that is in it. What is
		// drawn over the name (a shape, a note) still wins.
		if (!hit || hit.type === 'frame') {
			const titled = this.frameTitleAt(world, includeLocked);
			if (titled) {
				return titled;
			}
		}
		if (hit || !includeLocked) {
			return hit;
		}
		const elements = scene.getElements();
		for (let i = elements.length - 1; i >= 0; i--) {
			if (elements[i].locked && hitTestElement(elements[i], world, tolerance, false)) {
				return elements[i];
			}
		}
		return undefined;
	}

	/** The topmost frame whose name tab (as big as its text on screen, padding included) holds `world`. */
	/** How far a frame's name tab rises above its top edge, in board units (0 without a name or while not drawn). */
	frameTitleHeight(id: string): number {
		// A container's name is inside it: nothing rises above.
		return Math.max(0, -(this.renderer?.frameTitleSize(id)?.y ?? 0));
	}

	private frameTitleAt(world: Vec, includeLocked: boolean): ScratchElement | undefined {
		const scene = this.scene;
		const renderer = this.renderer;
		if (!scene || !renderer) {
			return undefined;
		}
		const elements = scene.getElements();
		const slop = 2 / this.camera.zoom;
		for (let i = elements.length - 1; i >= 0; i--) {
			const el = elements[i];
			if (el.type !== 'frame' || (el.locked && !includeLocked)) {
				continue;
			}
			const tab = renderer.frameTitleSize(el.id);
			if (!tab) {
				continue;
			}
			const local = worldToLocal(el, world);
			// Above a plain frame (its tab starts at its edge), inside a container.
			const left = el.header ? tab.x : 0;
			const bottom = el.header ? tab.y + tab.height : 0;
			if (local[0] >= left - slop && local[0] <= left + tab.width + slop && local[1] >= bottom - tab.height - slop && local[1] <= bottom + (el.header ? slop : 0)) {
				return el;
			}
		}
		return undefined;
	}

	private handleAt(screen: Vec): IOverlayHandle | undefined {
		const box = this.transformBox(this.selectedElements());
		if (!box) {
			return undefined;
		}
		// Rotation first: it sits outside the box where nothing else competes.
		const sorted = [...box.handles].sort((a, b) => (a.kind === 'rotate' ? -1 : 0) - (b.kind === 'rotate' ? -1 : 0));
		for (const h of sorted) {
			if (distance(h.at, screen) <= HANDLE_SIZE * 0.9) {
				return h;
			}
		}
		return undefined;
	}

	private selectDown(e: PointerEvent, screen: Vec, world: Vec): void {
		const scene = this.scene!;
		const selected = this.selectedElements();
		// Connector point handles.
		if (selected.length === 1 && isLinear(selected[0]) && !selected[0].locked) {
			const el = selected[0];
			const h = this.linearHandles(el);
			const pts = linearWorldPoints(el);
			const index = h.at.findIndex(p => distance(p, screen) <= 8);
			if (index >= 0) {
				const realIndex = el.arrowType === 'elbow' ? (index === 0 ? 0 : pts.length - 1) : index;
				const tx = scene.begin(localize('voltScratch.movePoint', "Move point"), true);
				this.beginGesture(e, { kind: 'point', pointerId: e.pointerId, tx, id: el.id, index: realIndex, grab: sub(world, pts[realIndex]) });
				return;
			}
			const mid = h.mids.findIndex(p => distance(p, screen) <= 7);
			if (mid >= 0) {
				// Find which segment this midpoint belongs to, then insert a bend there.
				const worldMid = h.worldMids[mid];
				let segment = 1;
				for (let i = 1; i < pts.length; i++) {
					if (distance(lerp(pts[i - 1], pts[i], 0.5), worldMid) < 1e-6) {
						segment = i;
						break;
					}
				}
				// The bend goes in once the pointer drags: a click or double-click (label) adds nothing.
				const tx = scene.begin(localize('voltScratch.addPoint', "Add point"), true);
				const unrotated = el.angle ? rotate(worldMid, elementCenter(el), -el.angle) : worldMid;
				this.beginGesture(e, { kind: 'point', pointerId: e.pointerId, tx, id: el.id, index: segment, grab: [0, 0], insert: { local: [unrotated[0] - el.x, unrotated[1] - el.y], world: worldMid } });
				return;
			}
		}
		const handle = this.handleAt(screen);
		if (handle) {
			const originals = selected;
			if (handle.kind === 'rotate') {
				const b = selected.length === 1 ? undefined : selectionBounds(selected);
				const center: Vec = b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : elementCenter(selected[0]);
				const tx = scene.begin(localize('voltScratch.rotate', "Rotate"), true);
				this.beginGesture(e, { kind: 'rotate', pointerId: e.pointerId, tx, center, startAngle: Math.atan2(world[1] - center[1], world[0] - center[0]), originals });
			} else {
				const tx = scene.begin(localize('voltScratch.resize', "Resize"), true);
				const single = selected.length === 1;
				const startBounds = selectionBounds(selected)!;
				let handleWorld: Vec;
				if (single) {
					const box = elementBox(selected[0]);
					const [fx, fy] = RESIZE_HANDLE_POSITIONS[handle.kind];
					handleWorld = rotate([box.x + box.width * fx, box.y + box.height * fy], elementCenter(selected[0]), selected[0].angle);
				} else {
					const [fx, fy] = RESIZE_HANDLE_POSITIONS[handle.kind];
					handleWorld = [startBounds.minX + (startBounds.maxX - startBounds.minX) * fx, startBounds.minY + (startBounds.maxY - startBounds.minY) * fy];
				}
				this.beginGesture(e, { kind: 'resize', pointerId: e.pointerId, tx, handle: handle.kind, originals, startBounds, grab: sub(world, handleWorld), single });
			}
			return;
		}
		const hit = this.hitAt(world);
		const b = selected.length > 1 ? selectionBounds(selected) : undefined;
		const insideSelection = !!b && world[0] >= b.minX && world[0] <= b.maxX && world[1] >= b.minY && world[1] <= b.maxY;
		if (hit) {
			const ids = this.selectableIds(hit);
			if (e.shiftKey) {
				const next = new Set(this.state.selection);
				const all = ids.every(id => next.has(id));
				for (const id of ids) {
					if (all) {
						next.delete(id);
					} else {
						next.add(id);
					}
				}
				this.select(next);
			} else if (!this.state.selection.has(hit.id)) {
				this.select(ids);
			}
		} else if (!insideSelection && !e.shiftKey) {
			this.select([]);
			this.state.setEditingGroup(null);
		}
		this.beginGesture(e, { kind: 'pending', pointerId: e.pointerId, start: screen, startWorld: world, hitId: hit?.id, shift: e.shiftKey, alt: e.altKey, insideSelection });
	}

	private onPointerMove(e: PointerEvent): void {
		const screen = this.clientToScreen(e);
		this.pointerScreen = screen;
		if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
			this.touches.set(e.pointerId, screen);
			if (this.pinch) {
				this.updatePinch();
				return;
			}
		}
		const world = this.toWorld(screen);
		const gesture = this.gesture;
		if (this.linearDraft && !gesture) {
			this.moveDraftPoint(world, e);
			return;
		}
		if (!gesture) {
			this.updateHover(screen, world);
			return;
		}
		if ('pointerId' in gesture && gesture.pointerId !== e.pointerId) {
			return;
		}
		switch (gesture.kind) {
			case 'pan': {
				this.camera.panBy(screen[0] - gesture.last[0], screen[1] - gesture.last[1]);
				gesture.last = screen;
				return;
			}
			case 'pending': {
				if (distance(screen, gesture.start) < DRAG_THRESHOLD) {
					return;
				}
				const selected = this.selectedElements();
				if ((gesture.hitId || gesture.insideSelection) && selected.length && !selected.some(el => el.locked)) {
					this.startMove(gesture, selected);
				} else {
					this.gesture = { kind: 'marquee', pointerId: gesture.pointerId, startWorld: gesture.startWorld, currentWorld: world, additive: gesture.shift, base: new Set(this.state.selection) };
				}
				this.onPointerMove(e);
				return;
			}
			case 'move': this.updateMove(gesture, world, e); return;
			case 'marquee': this.updateMarquee(gesture, world); return;
			case 'resize': this.updateResize(gesture, world, e); return;
			case 'rotate': this.updateRotate(gesture, world, e); return;
			case 'create': this.updateCreate(gesture, world, e); return;
			case 'linear': this.updateLinear(gesture, screen, world, e); return;
			case 'point': this.updatePoint(gesture, world, e); return;
			case 'draw': this.updateDraw(gesture, e); return;
			case 'erase': {
				const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
				for (const ce of events.length ? events : [e]) {
					const p = this.toWorld(this.clientToScreen(ce));
					this.eraseAt(gesture.last, p);
					gesture.last = p;
					gesture.trail.push(p);
				}
				this.requestFrame();
				return;
			}
			case 'laser': this.addLaser(screen); return;
		}
	}

	private onPointerUp(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.touches.delete(e.pointerId);
			if (this.pinch) {
				if (this.touches.size < 2) {
					this.pinch = undefined;
				}
				return;
			}
		}
		const gesture = this.gesture;
		if (!gesture || ('pointerId' in gesture && gesture.pointerId !== e.pointerId)) {
			return;
		}
		this.gesture = undefined;
		try {
			if (this.stage.hasPointerCapture(e.pointerId)) {
				this.stage.releasePointerCapture(e.pointerId);
			}
		} catch {
			// Already released.
		}
		this.guides = [];
		this.binding = undefined;
		this.frameTarget = undefined;
		this.updateBindTargetClass();
		switch (gesture.kind) {
			case 'pending': {
				// A click on an element already in a multi-selection narrows to it.
				if (gesture.hitId && !gesture.shift && this.state.selection.size > 1 && this.state.selection.has(gesture.hitId)) {
					const hit = this.scene?.get(gesture.hitId);
					if (hit) {
						this.select(this.selectableIds(hit));
					}
				}
				this.maybeClickContent(e, gesture.hitId);
				break;
			}
			case 'move': this.finishMove(gesture); break;
			case 'marquee':
				if (gesture.comment) {
					this.finishCommentMarquee(gesture);
				}
				break;
			case 'resize': case 'rotate': {
				gesture.tx.commit({ selectionBefore: [...this.state.selection], selectionAfter: [...this.state.selection] });
				break;
			}
			case 'create': this.finishCreate(gesture); break;
			case 'linear': this.finishLinear(gesture); break;
			case 'point': gesture.tx.commit({ selectionBefore: [gesture.id], selectionAfter: [gesture.id] }); break;
			case 'draw': this.finishDraw(gesture); break;
			case 'erase': this.finishErase(gesture); break;
			case 'laser': break;
			case 'pan': break;
		}
		this.updateCursor();
		this.requestFrame();
	}

	private onPointerCancel(e: PointerEvent): void {
		this.touches.delete(e.pointerId);
		if (this.touches.size < 2) {
			this.pinch = undefined;
		}
		if (this.gesture && 'pointerId' in this.gesture && this.gesture.pointerId === e.pointerId) {
			this.cancelGesture();
		}
	}

	/** Puts a half-done gesture back (Escape, lost pointer, board switch). */
	cancelGesture(): void {
		const gesture = this.gesture;
		this.gesture = undefined;
		this.guides = [];
		this.binding = undefined;
		this.frameTarget = undefined;
		this.updateBindTargetClass();
		if (!gesture) {
			return;
		}
		switch (gesture.kind) {
			case 'move':
				gesture.tx.cancel();
				// An Alt-drag copy goes away: the originals are selected again.
				this.select(gesture.selectionBefore.filter(id => this.scene?.has(id)));
				break;
			case 'resize': case 'rotate': case 'create': case 'linear': case 'point':
				gesture.tx.cancel();
				break;
			case 'marquee':
				this.select([...gesture.base]);
				break;
			case 'draw':
				gesture.preview.remove();
				break;
			case 'erase':
				for (const id of gesture.hits) {
					this.renderer?.setClass(id, 'sx-erasing', false);
				}
				break;
		}
		this.updateCursor();
		this.requestFrame();
	}

	// ---- Hover and cursor ----------------------------------------------------------------

	private updateHover(screen: Vec, world: Vec): void {
		if (this.state.tool === 'comment' && !this.spaceHeld) {
			// Comment mode: what a click would pin to lights up.
			this.setHover(this.comments.isOpen ? undefined : this.hitAt(world)?.id);
			this.updateCursor();
			return;
		}
		if (this.state.tool !== 'select' || this.spaceHeld) {
			this.setHover(undefined);
			this.updateCursor();
			return;
		}
		const handle = this.handleAt(screen);
		if (handle) {
			this.setHover(undefined);
			this.setCursor(handle.kind === 'rotate' ? 'grab' : resizeCursor(handle.kind, this.selectedElements()));
			return;
		}
		const selected = this.selectedElements();
		if (selected.length === 1 && isLinear(selected[0])) {
			const h = this.linearHandles(selected[0]);
			if (h.at.some(p => distance(p, screen) <= 8) || h.mids.some(p => distance(p, screen) <= 7)) {
				this.setCursor('pointer');
				return;
			}
		}
		const hit = this.hitAt(world);
		this.setHover(hit?.id);
		if (hit) {
			this.setCursor('move');
		} else {
			this.updateCursor();
		}
	}

	private setHover(id: string | undefined): void {
		if (id !== this.hoverId) {
			this.hoverId = id;
			this.requestFrame();
		}
	}

	private setCursor(cursor: string): void {
		if (cursor !== this.cursor) {
			this.cursor = cursor;
			this.stage.style.cursor = cursor;
		}
	}

	private updateCursor(): void {
		const g = this.gesture;
		if (g?.kind === 'pan') {
			this.setCursor('grabbing');
			return;
		}
		if (this.spaceHeld || this.state.tool === 'hand') {
			this.setCursor('grab');
			return;
		}
		switch (this.state.tool) {
			case 'select': this.setCursor(g?.kind === 'move' ? 'move' : 'default'); return;
			case 'text': this.setCursor('text'); return;
			case 'eraser': this.setCursor('cell'); return;
			case 'laser': this.setCursor('crosshair'); return;
			case 'comment': this.setCursor(COMMENT_CURSOR); return;
			default: this.setCursor('crosshair'); return;
		}
	}

	// ---- Move ------------------------------------------------------------------------------

	private startMove(pending: Extract<Gesture, { kind: 'pending' }>, selected: ScratchElement[]): void {
		const scene = this.scene!;
		const selectionBefore = [...this.state.selection];
		const tx = scene.begin(pending.alt ? localize('voltScratch.duplicateMove', "Duplicate") : localize('voltScratch.move', "Move"), true);
		let moving = selected;
		if (pending.alt) {
			// Alt-drag leaves the originals and drags copies.
			const { elements: copies } = duplicateElements(selected);
			const top = Math.max(...selected.map(el => scene.indexOf(el.id)));
			copies.forEach((copy, i) => tx.add(copy, top + 1 + i));
			moving = copies;
			this.select(copies.map(c => c.id));
		}
		// Frames carry what is inside them.
		const ids = withFrameContents(scene.getElements(), new Set(moving.map(el => el.id)));
		const originals = new Map<string, ScratchElement>();
		for (const id of ids) {
			const el = scene.get(id);
			if (el) {
				originals.set(id, el);
			}
		}
		this.gesture = { kind: 'move', pointerId: pending.pointerId, tx, startWorld: pending.startWorld, ids: [...ids], originals, selectionBefore };
	}

	private updateMove(g: Extract<Gesture, { kind: 'move' }>, world: Vec, e: PointerEvent): void {
		const scene = this.scene!;
		let dx = world[0] - g.startWorld[0];
		let dy = world[1] - g.startWorld[1];
		if (e.shiftKey) {
			if (Math.abs(dx) > Math.abs(dy)) {
				dy = 0;
			} else {
				dx = 0;
			}
		}
		const originals = [...g.originals.values()];
		const startBounds = selectionBounds(originals);
		this.guides = [];
		const snapOff = isMacintosh ? e.metaKey : e.ctrlKey;
		if (startBounds && !snapOff) {
			const moved: IScratchBounds = { minX: startBounds.minX + dx, minY: startBounds.minY + dy, maxX: startBounds.maxX + dx, maxY: startBounds.maxY + dy };
			if (scene.settings.snapToGrid) {
				dx += snapToGrid(moved.minX, SCRATCH_GRID_SIZE) - moved.minX;
				dy += snapToGrid(moved.minY, SCRATCH_GRID_SIZE) - moved.minY;
			} else if (scene.settings.snapToObjects) {
				const others = this.snapCandidates(new Set(g.ids));
				const snap = snapBounds(moved, others, SNAP_THRESHOLD / this.camera.zoom);
				dx += snap.dx;
				dy += snap.dy;
				this.guides = snap.guides.map(guide => guide.axis === 'x'
					? { from: [guide.value, guide.from] as Vec, to: [guide.value, guide.to] as Vec }
					: { from: [guide.from, guide.value] as Vec, to: [guide.to, guide.value] as Vec });
			}
		}
		const patches = moveMany(originals, dx, dy);
		const movingIds = new Set(g.ids);
		for (const [id, patch] of patches) {
			const original = g.originals.get(id)!;
			let p = patch;
			if (isLinear(original)) {
				// A connector dragged away from shapes that stay behind lets go of them.
				const keepStart = original.startBinding && movingIds.has(original.startBinding.elementId);
				const keepEnd = original.endBinding && movingIds.has(original.endBinding.elementId);
				p = { ...patch, startBinding: keepStart ? original.startBinding : null, endBinding: keepEnd ? original.endBinding : null };
			}
			g.tx.update(id, p);
		}
		this.rebindAround(g.tx, movingIds);
		// Dropping into a frame: highlight the frame that will take it.
		this.frameTarget = this.frameFor(selectionBounds(g.ids.map(id => scene.get(id)!).filter(Boolean)), movingIds);
		g.tx.flush();
	}

	private finishMove(g: Extract<Gesture, { kind: 'move' }>): void {
		const scene = this.scene!;
		const moved = g.ids.map(id => scene.get(id)).filter((el): el is ScratchElement => !!el);
		this.assignFrames(g.tx, moved);
		g.tx.commit({ selectionBefore: g.selectionBefore, selectionAfter: [...this.state.selection] });
	}

	/** Bounds of other visible elements to snap against. */
	private snapCandidates(exclude: ReadonlySet<string>): IScratchBounds[] {
		const view = expandBounds(this.camera.visibleBounds(), 100 / this.camera.zoom);
		const out: IScratchBounds[] = [];
		for (const el of this.scene!.getElements()) {
			if (exclude.has(el.id) || isLinear(el) || el.type === 'draw') {
				continue;
			}
			const b = geometricBounds(el);
			if (boundsIntersect(b, view)) {
				out.push(b);
			}
			if (out.length > 400) {
				break;
			}
		}
		return out;
	}

	/** Connectors in `ids` that moved without the element an end was on let go of it (as a drag does). */
	private releaseLeftBindings(tx: ScratchTransaction, ids: ReadonlySet<string>): void {
		const scene = this.scene!;
		for (const id of ids) {
			const el = scene.get(id);
			if (!el || !isLinear(el)) {
				continue;
			}
			const dropStart = el.startBinding && !ids.has(el.startBinding.elementId);
			const dropEnd = el.endBinding && !ids.has(el.endBinding.elementId);
			if (dropStart || dropEnd) {
				tx.update(id, { startBinding: dropStart ? null : el.startBinding, endBinding: dropEnd ? null : el.endBinding });
			}
		}
	}

	/** Connectors attached to `ids` that are not themselves moving follow them. */
	private rebindAround(tx: ScratchTransaction, ids: ReadonlySet<string>): void {
		const scene = this.scene!;
		const lookup = (id: string) => scene.get(id);
		const routing = routingIn(scene);
		for (const connector of boundConnectors(scene.getElements(), ids)) {
			if (ids.has(connector.id)) {
				continue;
			}
			const patch = rebindConnector(connector, lookup, undefined, routing.around(connector));
			routing.moved(connector.id, patch);
			if (patch) {
				tx.update(connector.id, patch);
			}
		}
	}

	/** The topmost frame that would take `bounds` (its centre inside the frame). */
	private frameFor(bounds: IScratchBounds | undefined, exclude: ReadonlySet<string>): string | undefined {
		if (!bounds) {
			return undefined;
		}
		const center: Vec = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
		const elements = this.scene!.getElements();
		for (let i = elements.length - 1; i >= 0; i--) {
			const el = elements[i];
			if (el.type === 'frame' && !exclude.has(el.id)) {
				const b = geometricBounds(el);
				if (center[0] >= b.minX && center[0] <= b.maxX && center[1] >= b.minY && center[1] <= b.maxY) {
					return el.id;
				}
			}
		}
		return undefined;
	}

	/** Elements whose centre ends up inside a frame join it; ones dragged out leave. */
	private assignFrames(tx: ScratchTransaction, elements: readonly ScratchElement[]): void {
		const movingIds = new Set(elements.map(e => e.id));
		for (const el of elements) {
			if (el.type === 'frame') {
				continue;
			}
			// Children moved with their frame stay in it.
			if (el.frameId && movingIds.has(el.frameId)) {
				continue;
			}
			const frame = this.frameFor(geometricBounds(el), movingIds);
			if ((frame ?? null) !== el.frameId) {
				tx.update(el.id, { frameId: frame ?? null });
			}
		}
	}

	// ---- Marquee -------------------------------------------------------------------------

	private updateMarquee(g: Extract<Gesture, { kind: 'marquee' }>, world: Vec): void {
		g.currentWorld = world;
		const scene = this.scene!;
		const marquee: IScratchBounds = {
			minX: Math.min(g.startWorld[0], world[0]), minY: Math.min(g.startWorld[1], world[1]),
			maxX: Math.max(g.startWorld[0], world[0]), maxY: Math.max(g.startWorld[1], world[1]),
		};
		// Dragging right to left selects what the box touches; left to right what it encloses.
		const mode = world[0] < g.startWorld[0] ? 'intersect' : 'contain';
		const inside = elementsInMarquee(scene.getElements().filter(el => !el.locked), marquee, mode);
		const ids = new Set(g.additive ? g.base : []);
		const editing = this.state.editingGroupId;
		for (const el of inside) {
			if (editing && !el.groupIds.includes(editing)) {
				continue;
			}
			for (const id of this.selectableIds(el)) {
				ids.add(id);
			}
		}
		this.select(ids);
		this.requestFrame();
	}

	// ---- Resize and rotate ---------------------------------------------------------------

	private updateResize(g: Extract<Gesture, { kind: 'resize' }>, world: Vec, e: PointerEvent): void {
		const pointer: Vec = [world[0] - g.grab[0], world[1] - g.grab[1]];
		const ids = new Set(g.originals.map(el => el.id));
		if (g.single) {
			const el = g.originals[0];
			const aspectByDefault = el.type === 'image' || el.type === 'icon';
			const patch = resizeSingle(el, g.handle, pointer, { keepAspect: aspectByDefault ? !e.shiftKey : e.shiftKey, fromCenter: e.altKey, minSize: 4 });
			g.tx.update(el.id, patch);
		} else {
			const patches = resizeMany(g.originals, g.startBounds, g.handle, pointer, { keepAspect: e.shiftKey || g.originals.some(el => el.type === 'image' || el.type === 'icon' || el.type === 'text'), fromCenter: e.altKey });
			for (const [id, patch] of patches) {
				g.tx.update(id, patch);
			}
		}
		this.rebindAround(g.tx, ids);
		g.tx.flush();
	}

	private updateRotate(g: Extract<Gesture, { kind: 'rotate' }>, world: Vec, e: PointerEvent): void {
		let delta = Math.atan2(world[1] - g.center[1], world[0] - g.center[0]) - g.startAngle;
		if (e.shiftKey) {
			// Snap the resulting angle (of the first element) to 15-degree steps.
			const base = g.originals[0]?.angle ?? 0;
			delta = Math.round((base + delta) / ROTATE_SNAP) * ROTATE_SNAP - base;
		}
		for (const [id, patch] of rotateMany(g.originals, g.center, delta)) {
			g.tx.update(id, patch);
		}
		this.rebindAround(g.tx, new Set(g.originals.map(el => el.id)));
		g.tx.flush();
	}

	// ---- Create shapes, notes, cards, frames ---------------------------------------------

	private createDown(e: PointerEvent, world: Vec): void {
		const tx = this.scene!.begin(localize('voltScratch.create', "Add element"), true);
		this.select([]);
		this.beginGesture(e, { kind: 'create', pointerId: e.pointerId, tx, tool: this.state.tool, shape: this.state.shapeKind, startWorld: this.snapWorld(world, e), id: undefined });
	}

	private snapWorld(world: Vec, e: { metaKey: boolean; ctrlKey: boolean }): Vec {
		if (this.scene?.settings.snapToGrid && !(isMacintosh ? e.metaKey : e.ctrlKey)) {
			return [snapToGrid(world[0], SCRATCH_GRID_SIZE), snapToGrid(world[1], SCRATCH_GRID_SIZE)];
		}
		return world;
	}

	private newElementFor(tool: ScratchTool, shape: ScratchShapeKind, x: number, y: number, width: number, height: number): ScratchElement {
		const style = this.state.style;
		const frameId = null;
		switch (tool) {
			case 'note': return createNote({ x, y, width: Math.max(width, 40), height: Math.max(height, 40), frameId }, style);
			case 'card': return createCard({ x, y, width: Math.max(width, 120), height: Math.max(height, 64), frameId, html: '' }, style);
			case 'frame': return createFrame({ x, y, width, height, name: this.nextFrameName() }, style);
			default: return createShape({ x, y, width, height, shape, frameId }, style);
		}
	}

	private nextFrameName(): string {
		const count = this.scene?.getElements().filter(e => e.type === 'frame').length ?? 0;
		return localize('voltScratch.frameName', "Frame {0}", count + 1);
	}

	private updateCreate(g: Extract<Gesture, { kind: 'create' }>, world: Vec, e: PointerEvent): void {
		const p = this.snapWorld(world, e);
		let x0 = g.startWorld[0], y0 = g.startWorld[1];
		let w = p[0] - x0, h = p[1] - y0;
		if (e.shiftKey || g.tool === 'note') {
			const s = Math.max(Math.abs(w), Math.abs(h));
			w = Math.sign(w || 1) * s;
			h = Math.sign(h || 1) * s;
		}
		if (e.altKey) {
			x0 -= w;
			y0 -= h;
			w *= 2;
			h *= 2;
		}
		const x = Math.min(x0, x0 + w), y = Math.min(y0, y0 + h);
		const width = Math.abs(w), height = Math.abs(h);
		if (!g.id) {
			const el = this.newElementFor(g.tool, g.shape, x, y, width, height);
			// Frames go to the back so what is drawn on them stays visible.
			g.tx.add(el, g.tool === 'frame' ? 0 : undefined);
			g.id = el.id;
			this.select([el.id]);
		} else {
			g.tx.update(g.id, { x, y, width, height });
		}
		g.tx.flush();
	}

	private finishCreate(g: Extract<Gesture, { kind: 'create' }>): void {
		const scene = this.scene!;
		let id = g.id;
		const el = id ? scene.get(id) : undefined;
		const tooSmall = !el || (el.width < 6 && el.height < 6);
		if (tooSmall) {
			// A click places a default-size element centred on it.
			const size = g.tool === 'note' ? [220, 220] : g.tool === 'card' ? [420, 200] : g.tool === 'frame' ? [480, 320] : SHAPE_DEFAULT_SIZE[g.shape];
			const x = g.startWorld[0] - size[0] / 2, y = g.startWorld[1] - size[1] / 2;
			if (id && el) {
				g.tx.update(id, { x, y, width: size[0], height: size[1] });
			} else {
				const created = this.newElementFor(g.tool, g.shape, x, y, size[0], size[1]);
				g.tx.add(created, g.tool === 'frame' ? 0 : undefined);
				id = created.id;
			}
		}
		const created = id ? scene.get(id) : undefined;
		if (created && g.tool === 'frame') {
			// A new frame takes in what it was drawn around.
			const fb = geometricBounds(created);
			for (const other of scene.getElements()) {
				if (other.id !== created.id && other.type !== 'frame' && !other.frameId && boundsContain(fb, geometricBounds(other))) {
					g.tx.update(other.id, { frameId: created.id });
				}
			}
		} else if (created) {
			this.assignFrames(g.tx, [created]);
		}
		g.tx.commit({ selectionBefore: [], selectionAfter: id ? [id] : [] });
		if (id) {
			this.select([id]);
		}
		if (!this.state.toolLocked) {
			this.state.setTool('select');
		}
		if (created && (created.type === 'note' || created.type === 'card')) {
			this.editText(created.id);
		}
	}

	// ---- Connectors ------------------------------------------------------------------------

	private linearDown(e: PointerEvent, screen: Vec, world: Vec): void {
		const scene = this.scene!;
		const tx = scene.begin(this.state.tool === 'arrow' ? localize('voltScratch.addArrow', "Add arrow") : localize('voltScratch.addLine', "Add line"), true);
		const start = this.snapWorld(world, e);
		const candidate = bindingCandidateAt(scene.getElements(), start, this.camera.zoom, new Set());
		const style = this.state.style;
		const el = createLinear({
			type: this.state.tool === 'arrow' ? 'arrow' : 'line',
			x: start[0], y: start[1],
			points: [[0, 0], [0, 0]],
			startBinding: candidate && isBindable(candidate.element) ? { elementId: candidate.element.id, anchor: candidate.anchor } : null,
		}, style);
		tx.add(el);
		tx.flush();
		this.select([el.id]);
		this.beginGesture(e, { kind: 'linear', pointerId: e.pointerId, tx, id: el.id, startScreen: screen, moved: false });
	}

	/** Sets the last point of the connector being drawn, binding it to what is under the pointer. */
	private placeLastPoint(tx: ScratchTransaction, id: string, world: Vec, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): void {
		const scene = this.scene!;
		const el = scene.get(id);
		if (!el || !isLinear(el)) {
			return;
		}
		const pts = el.points.map(p => [el.x + p[0], el.y + p[1]] as Vec);
		const prev = pts.length >= 2 ? pts[pts.length - 2] : pts[0];
		let p = this.snapWorld(world, e);
		if (e.shiftKey) {
			// 15-degree steps from the previous point.
			const angle = Math.atan2(p[1] - prev[1], p[0] - prev[0]);
			const snapped = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
			const len = distance(prev, p);
			p = [prev[0] + Math.cos(snapped) * len, prev[1] + Math.sin(snapped) * len];
		}
		const candidate = e.altKey ? undefined : bindingCandidateAt(scene.getElements(), world, this.camera.zoom, new Set([id]));
		this.binding = candidate && candidate.element.id !== el.startBinding?.elementId || (candidate && pts.length > 2) ? { candidate: candidate! } : undefined;
		const endBinding = this.binding ? { elementId: candidate!.element.id, anchor: candidate!.anchor } : null;
		pts[pts.length - 1] = p;
		const draft: IScratchLinearElement = { ...el, x: pts[0][0], y: pts[0][1], angle: 0, points: pts.map(q => [q[0] - pts[0][0], q[1] - pts[0][1]]), endBinding };
		const patch = rebindConnector(draft, lookupIn(scene), undefined, routingIn(scene).around(draft)) ?? { x: draft.x, y: draft.y, points: draft.points, angle: 0, startBinding: draft.startBinding, endBinding: draft.endBinding, width: 0, height: 0 };
		const bbox = boundsOfPoints(patch.points as Vec[]);
		tx.update(id, { ...patch, endBinding: patch.endBinding ?? endBinding, startBinding: patch.startBinding ?? draft.startBinding, width: bbox.maxX - bbox.minX, height: bbox.maxY - bbox.minY });
		this.updateBindTargetClass();
	}

	private updateBindTargetClass(): void {
		const scene = this.scene;
		if (!scene || !this.renderer) {
			return;
		}
		const id = this.binding?.candidate.element.id;
		for (const el of scene.getElements()) {
			this.renderer.setClass(el.id, 'sx-bind-target', el.id === id);
		}
	}

	private updateLinear(g: Extract<Gesture, { kind: 'linear' }>, screen: Vec, world: Vec, e: PointerEvent): void {
		if (!g.moved && distance(screen, g.startScreen) < DRAG_THRESHOLD) {
			return;
		}
		g.moved = true;
		this.placeLastPoint(g.tx, g.id, world, e);
		g.tx.flush();
		this.requestFrame();
	}

	private finishLinear(g: Extract<Gesture, { kind: 'linear' }>): void {
		if (!g.moved) {
			// A click starts a connector drawn point by point; the gesture's transaction lives on.
			const scene = this.scene!;
			const el = scene.get(g.id);
			if (el && isLinear(el)) {
				this.linearDraft = { tx: g.tx, id: g.id };
				this.binding = undefined;
				this.showHint();
				return;
			}
		}
		this.binding = undefined;
		this.updateBindTargetClass();
		const el = this.scene!.get(g.id);
		if (!el || !isLinear(el) || (el.width < 2 && el.height < 2)) {
			g.tx.cancel();
			this.select([]);
		} else {
			g.tx.commit({ selectionBefore: [], selectionAfter: [g.id] });
			this.select([g.id]);
		}
		if (!this.state.toolLocked) {
			this.state.setTool('select');
		}
	}

	private addDraftPoint(world: Vec, e: PointerEvent): void {
		const draft = this.linearDraft!;
		const scene = this.scene!;
		const el = scene.get(draft.id);
		if (!el || !isLinear(el)) {
			this.finishLinearDraft(false);
			return;
		}
		this.placeLastPoint(draft.tx, draft.id, world, e);
		const placed = scene.get(draft.id) as IScratchLinearElement;
		if (placed.endBinding) {
			// Landing on a shape ends the connector there.
			this.finishLinearDraft(true);
			return;
		}
		const pts = placed.points;
		const last = pts[pts.length - 1];
		// The next segment starts where this one ended.
		draft.tx.update(draft.id, { points: [...pts, last] });
		draft.tx.flush();
	}

	private moveDraftPoint(world: Vec, e: PointerEvent): void {
		const draft = this.linearDraft!;
		this.placeLastPoint(draft.tx, draft.id, world, e);
		draft.tx.flush();
		this.requestFrame();
	}

	/** Ends point-by-point drawing; the floating last point is dropped unless it landed on a shape. */
	private finishLinearDraft(keep: boolean): void {
		const draft = this.linearDraft;
		if (!draft) {
			return;
		}
		this.linearDraft = undefined;
		this.binding = undefined;
		this.updateBindTargetClass();
		const scene = this.scene;
		const el = scene?.get(draft.id);
		if (!scene || !el || !isLinear(el) || !keep) {
			draft.tx.cancel();
			this.showHint();
			return;
		}
		let points = el.points;
		if (!el.endBinding && points.length > 2) {
			points = points.slice(0, -1);
		}
		const distinct = points.filter((p, i) => i === 0 || distance(p, points[i - 1]) > 1);
		if (distinct.length < 2) {
			draft.tx.cancel();
			this.select([]);
		} else {
			const world = distinct.map(p => [el.x + p[0], el.y + p[1]] as Vec);
			const draftEl: IScratchLinearElement = { ...el, points: world.map(q => [q[0] - world[0][0], q[1] - world[0][1]]), x: world[0][0], y: world[0][1] };
			const patch = rebindConnector(draftEl, lookupIn(scene), undefined, routingIn(scene).around(draftEl));
			const finalPoints = (patch?.points ?? draftEl.points) as Vec[];
			const bbox = boundsOfPoints(finalPoints);
			draft.tx.update(el.id, { ...(patch ?? {}), x: patch?.x ?? draftEl.x, y: patch?.y ?? draftEl.y, points: finalPoints, width: bbox.maxX - bbox.minX, height: bbox.maxY - bbox.minY });
			draft.tx.commit({ selectionBefore: [], selectionAfter: [el.id] });
			this.select([el.id]);
		}
		if (!this.state.toolLocked) {
			this.state.setTool('select');
		}
		this.showHint();
	}

	private updatePoint(g: Extract<Gesture, { kind: 'point' }>, world: Vec, e: PointerEvent): void {
		const scene = this.scene!;
		let el = scene.get(g.id);
		if (!el || !isLinear(el)) {
			return;
		}
		if (g.insert) {
			if (distance(world, g.insert.world) * this.camera.zoom < DRAG_THRESHOLD) {
				return;
			}
			const points = [...el.points];
			points.splice(g.index, 0, g.insert.local);
			g.insert = undefined;
			el = g.tx.update<IScratchLinearElement>(el.id, { points }) ?? el;
			if (!isLinear(el)) {
				return;
			}
		}
		const pts = linearWorldPoints(el);
		let p = this.snapWorld([world[0] - g.grab[0], world[1] - g.grab[1]], e);
		const isEnd = g.index === 0 || g.index === pts.length - 1;
		if (e.shiftKey) {
			const anchor = g.index === 0 ? pts[1] : pts[g.index - 1];
			if (anchor) {
				const angle = Math.atan2(p[1] - anchor[1], p[0] - anchor[0]);
				const snapped = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
				const len = distance(anchor, p);
				p = [anchor[0] + Math.cos(snapped) * len, anchor[1] + Math.sin(snapped) * len];
			}
		}
		let startBinding = el.startBinding;
		let endBinding = el.endBinding;
		this.binding = undefined;
		if (isEnd && !e.altKey) {
			const candidate = bindingCandidateAt(scene.getElements(), [world[0] - g.grab[0], world[1] - g.grab[1]], this.camera.zoom, new Set([el.id]));
			const binding = candidate ? { elementId: candidate.element.id, anchor: candidate.anchor } : null;
			if (candidate) {
				this.binding = { candidate };
			}
			if (g.index === 0) {
				startBinding = binding;
			} else {
				endBinding = binding;
			}
		} else if (isEnd) {
			if (g.index === 0) {
				startBinding = null;
			} else {
				endBinding = null;
			}
		}
		pts[g.index] = p;
		const draft: IScratchLinearElement = { ...el, angle: 0, x: pts[0][0], y: pts[0][1], points: pts.map(q => [q[0] - pts[0][0], q[1] - pts[0][1]]), startBinding, endBinding };
		const patch = rebindConnector(draft, lookupIn(scene), undefined, routingIn(scene).around(draft));
		const finalPoints = (patch?.points ?? draft.points) as Vec[];
		const bbox = boundsOfPoints(finalPoints);
		g.tx.update(el.id, { ...(patch ?? {}), x: patch?.x ?? draft.x, y: patch?.y ?? draft.y, angle: 0, points: finalPoints, startBinding: patch?.startBinding ?? startBinding, endBinding: patch?.endBinding ?? endBinding, width: bbox.maxX - bbox.minX, height: bbox.maxY - bbox.minY });
		this.updateBindTargetClass();
		g.tx.flush();
	}

	// ---- Freehand --------------------------------------------------------------------------

	private drawDown(e: PointerEvent, world: Vec): void {
		const preview = this.world.ownerDocument.createElementNS(SVG_NS, 'svg');
		preview.classList.add('sx-draw-preview');
		this.previewLayer.appendChild(preview);
		const simulate = e.pointerType !== 'pen';
		const pressure = simulate ? 0.5 : (e.pressure || 0.5);
		this.select([]);
		this.beginGesture(e, { kind: 'draw', pointerId: e.pointerId, points: [[world[0], world[1], pressure]], simulate, preview });
		this.paintDrawPreview(this.gesture as Extract<Gesture, { kind: 'draw' }>);
	}

	private updateDraw(g: Extract<Gesture, { kind: 'draw' }>, e: PointerEvent): void {
		const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
		for (const ce of events.length ? events : [e]) {
			const p = this.toWorld(this.clientToScreen(ce));
			const last = g.points[g.points.length - 1];
			if (Math.abs(p[0] - last[0]) < 0.01 && Math.abs(p[1] - last[1]) < 0.01) {
				continue;
			}
			g.points.push([p[0], p[1], g.simulate ? 0.5 : (ce.pressure || 0.5)]);
		}
		this.paintDrawPreview(g);
	}

	private paintDrawPreview(g: Extract<Gesture, { kind: 'draw' }>): void {
		const style = this.state.style;
		const origin = g.points[0];
		const temp = createDraw({ x: origin[0], y: origin[1], points: g.points.map(p => [p[0] - origin[0], p[1] - origin[1], p[2]]), simulatePressure: g.simulate, pen: style.pen }, style);
		const specs = freehandDrawing(temp, c => this.mapColor(c));
		g.preview.setAttribute('class', `sx-draw-preview${style.pen === 'highlighter' ? ' sx-highlighter' : ''}`);
		g.preview.style.transform = `translate(${origin[0]}px, ${origin[1]}px)`;
		g.preview.style.opacity = style.opacity >= 100 ? '' : String(style.opacity / 100);
		appendPaths(g.preview, specs);
	}

	private finishDraw(g: Extract<Gesture, { kind: 'draw' }>): void {
		g.preview.remove();
		const scene = this.scene!;
		const style = this.state.style;
		const origin = g.points[0];
		const relative = g.points.map(p => [p[0] - origin[0], p[1] - origin[1], p[2]] as ScratchPressurePoint);
		const simplified = relative.length > 8 ? simplifyStroke(relative, 0.35 / this.camera.zoom) : relative;
		const el = createDraw({ x: origin[0], y: origin[1], points: simplified, simulatePressure: g.simulate, pen: style.pen }, style);
		scene.transact(localize('voltScratch.addDrawing', "Draw"), tx => {
			tx.add(el);
			this.assignFrames(tx, [el]);
		}, { selectionBefore: [], selectionAfter: [] });
	}

	// ---- Eraser and laser ----------------------------------------------------------------

	private eraseAt(from: Vec, to: Vec): void {
		const scene = this.scene!;
		const g = this.gesture;
		if (g?.kind !== 'erase') {
			return;
		}
		const tolerance = 8 / this.camera.zoom;
		const segment = expandBounds(boundsOfPoints([from, to]), tolerance + 4);
		for (const el of scene.getElements()) {
			if (el.locked || g.hits.has(el.id) || !boundsIntersect(elementBounds(el), segment)) {
				continue;
			}
			if (elementIntersectsSegment(el, from, to, tolerance) || hitTestElement(el, to, tolerance, false)) {
				g.hits.add(el.id);
				this.renderer?.setClass(el.id, 'sx-erasing', true);
			}
		}
	}

	private finishErase(g: Extract<Gesture, { kind: 'erase' }>): void {
		for (const id of g.hits) {
			this.renderer?.setClass(id, 'sx-erasing', false);
		}
		if (g.hits.size) {
			this.deleteElements([...g.hits], localize('voltScratch.erase', "Erase"));
		}
	}

	private addLaser(screen: Vec): void {
		this.laserTrail.push({ at: screen, time: Date.now() });
		if (this.laserTrail.length > 200) {
			this.laserTrail.splice(0, this.laserTrail.length - 200);
		}
		if (!this.laserLoop) {
			this.laserLoop = true;
			const tick = () => {
				const now = Date.now();
				this.laserTrail = this.laserTrail.filter(p => now - p.time < 900);
				this.paintFrame();
				if (this.laserTrail.length && !this._store.isDisposed) {
					getWindow(this.element).requestAnimationFrame(tick);
				} else {
					this.laserLoop = false;
				}
			};
			getWindow(this.element).requestAnimationFrame(tick);
		}
	}

	// ---- Pinch -------------------------------------------------------------------------------

	private startPinch(): void {
		this.cancelGesture();
		const [a, b] = [...this.touches.values()];
		const center: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		this.pinch = { startDistance: Math.max(1, distance(a, b)), startZoom: this.camera.zoom, startCenter: center, startWorld: this.toWorld(center) };
	}

	private updatePinch(): void {
		const pinch = this.pinch;
		if (!pinch || this.touches.size < 2) {
			return;
		}
		const [a, b] = [...this.touches.values()];
		const center: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		const zoom = pinch.startZoom * distance(a, b) / pinch.startDistance;
		const z = Math.max(0.1, Math.min(30, zoom));
		this.camera.set({ x: center[0] - pinch.startWorld[0] * z, y: center[1] - pinch.startWorld[1] * z, zoom: z });
	}

	// ---- Text ------------------------------------------------------------------------------

	private textDown(e: PointerEvent, world: Vec): void {
		const hit = this.hitAt(world);
		if (hit && (isRichText(hit) || hasLabel(hit))) {
			this.select([hit.id]);
			this.editText(hit.id, { x: e.clientX, y: e.clientY });
			return;
		}
		this.createTextAt(world);
	}

	/** A new free text at `world`, edited at once; nothing is kept if it ends up empty. */
	createTextAt(world: Vec, html = ''): void {
		const scene = this.scene;
		if (!scene) {
			return;
		}
		const style = this.state.style;
		const el = createText({ x: world[0], y: world[1] - style.fontSize * 0.65, html, autoSize: true }, style);
		scene.transact('', tx => tx.add(el), { record: false });
		this.select([el.id]);
		this.editText(el.id, 'end', true);
		if (!this.state.toolLocked) {
			this.state.setTool('select');
		}
	}

	private pendingNewText = new Set<string>();

	/** Starts editing an element's text (or its label). */
	editText(id: string, caret: { x: number; y: number } | 'end' | 'all' = 'end', isNew = false): void {
		const scene = this.scene;
		const renderer = this.renderer;
		const el = scene?.get(id);
		if (!scene || !renderer || !el || el.locked) {
			return;
		}
		if (isNew) {
			this.pendingNewText.add(id);
		}
		let host: HTMLElement | undefined;
		let kind: IScratchTextTarget['kind'];
		let initial = '';
		if (isRichText(el)) {
			host = renderer.richHostFor(id);
			kind = 'rich';
			initial = el.html;
		} else if (hasLabel(el)) {
			kind = 'label';
			initial = el.label?.html ?? '';
			host = renderer.labelTextFor(id);
			if (!host) {
				// No label yet: give the renderer one to paint, then edit it.
				const label: IScratchLabel = createLabel('<p><br></p>', this.state.style, el.type === 'icon' ? { fontSize: 16 } : el.type === 'shape' ? {} : { fontSize: Math.min(20, this.state.style.fontSize) });
				scene.transact('', tx => tx.update(id, { label }), { record: false });
				host = renderer.labelTextFor(id);
				initial = '';
			}
		} else {
			return;
		}
		if (!host) {
			return;
		}
		renderer.setEditing(id);
		this.state.setEditingText(id);
		this.textEditor.start({ elementId: id, kind, host, initialHtml: initial }, caret);
		this.requestFrame();
	}

	private commitText(target: IScratchTextTarget, html: string): void {
		const scene = this.scene;
		const renderer = this.renderer;
		this.state.setEditingText(null);
		renderer?.setEditing(undefined);
		const el = scene?.get(target.elementId);
		const wasNew = this.pendingNewText.delete(target.elementId);
		if (!scene || !el) {
			return;
		}
		if (target.kind === 'rich' && isRichText(el)) {
			const size = renderer?.measureNow(el.id);
			if (el.type === 'text' && isEmptyRichText(html)) {
				// Empty text disappears; a new one leaves no undo step.
				scene.transact(localize('voltScratch.deleteText', "Delete text"), tx => tx.remove(el.id), { record: !wasNew, selectionBefore: [el.id], selectionAfter: [] });
				this.select([]);
				return;
			}
			if (wasNew) {
				// Recreate as one undoable "add" so undo removes the whole thing.
				scene.transact('', tx => tx.remove(el.id), { record: false });
				const added: ScratchElement = { ...el, html, ...(size ? { width: size.width, height: size.height } : {}), version: el.version + 1, updated: Date.now() };
				scene.transact(localize('voltScratch.addText', "Add text"), tx => tx.add(added), { selectionBefore: [], selectionAfter: [el.id] });
				this.select([el.id]);
			} else if (html !== el.html) {
				scene.transact(localize('voltScratch.editText', "Edit text"), tx => tx.update(el.id, { html }), { selectionBefore: [el.id], selectionAfter: [el.id] });
			}
			// The renderer measures the committed text and fits the box.
			this.requestFrame();
		} else if (target.kind === 'label' && hasLabel(el)) {
			const label = el.label;
			const empty = isEmptyRichText(html);
			const next: IScratchLabel | null = empty ? null : { ...(label ?? createLabel(html, this.state.style)), html };
			if ((label?.html ?? '') === '<p><br></p>' || !label?.html) {
				// The placeholder label was never part of history.
				scene.transact('', tx => tx.update(el.id, { label: null }), { record: false });
			}
			if (next && next.html !== label?.html) {
				scene.transact(localize('voltScratch.editLabel', "Edit label"), tx => tx.update(el.id, { label: next }), { selectionBefore: [el.id], selectionAfter: [el.id] });
			} else if (label && label.html && label.html !== '<p><br></p>') {
				scene.transact(localize('voltScratch.editLabel', "Edit label"), tx => tx.update(el.id, { label: null }), { selectionBefore: [el.id], selectionAfter: [el.id] });
			}
		}
		this.requestFrame();
		this.focus();
	}

	/** Text that measured a different size than stored: fit the element (not an undo step). */
	private applyMeasuredSize(id: string, width: number, height: number): void {
		const scene = this.scene;
		const el = scene?.get(id);
		if (!scene || !el || scene.inTransaction) {
			return;
		}
		scene.transact('', tx => {
			tx.update(id, { width, height });
			this.rebindAround(tx, new Set([id]));
			// Text that grew past its frame (a long sticky note, a card) takes the frame with it, frames in frames too.
			let inner = geometricBounds({ ...el, width, height });
			const seen = new Set<string>();
			for (let frame = el.frameId ? scene.get(el.frameId) : undefined; frame?.type === 'frame' && !seen.has(frame.id); frame = frame.frameId ? scene.get(frame.frameId) : undefined) {
				seen.add(frame.id);
				const maxX = Math.max(frame.x + frame.width, inner.maxX + MEASURED_FRAME_PADDING);
				const maxY = Math.max(frame.y + frame.height, inner.maxY + MEASURED_FRAME_PADDING);
				if (maxX - frame.x - frame.width < 0.5 && maxY - frame.y - frame.height < 0.5) {
					break;
				}
				tx.update(frame.id, { width: maxX - frame.x, height: maxY - frame.y });
				inner = { minX: frame.x, minY: frame.y, maxX, maxY };
			}
		}, { record: false });
	}

	/** Web and mail links only: a board file or a paste could carry anything else. */
	private openLink(href: string): void {
		if (/^(https?:|mailto:)/i.test(href.trim())) {
			void this.openerService.open(href.trim(), { openExternal: true });
		}
	}

	private async askLink(current: string | undefined): Promise<string | undefined> {
		const value = await this.quickInputService.input({
			prompt: localize('voltScratch.linkPrompt', "Link address"),
			placeHolder: 'https://',
			value: current ?? '',
			validateInput: async v => !v || /^(https?:|mailto:)/i.test(v.trim()) || /^[\w.-]+\.[a-z]{2,}/i.test(v.trim()) ? undefined : localize('voltScratch.linkInvalid', "Enter a web address"),
		});
		if (value === undefined) {
			return undefined;
		}
		const v = value.trim();
		return !v ? '' : /^[a-z]+:/i.test(v) ? v : `https://${v}`;
	}

	/** A click (no drag) on a link or a checkbox in rich text does what it says. */
	private maybeClickContent(e: PointerEvent, hitId: string | undefined): void {
		const scene = this.scene;
		const el = hitId ? scene?.get(hitId) : undefined;
		const node = el ? this.renderer?.nodeFor(el.id) : undefined;
		if (!scene || !el || !node) {
			return;
		}
		node.classList.add('sx-probe');
		const target = node.ownerDocument.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
		node.classList.remove('sx-probe');
		const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
		if (anchor && node.contains(anchor) && (isMacintosh ? e.metaKey : e.ctrlKey)) {
			this.openLink(anchor.href);
			return;
		}
		const li = target?.closest?.('li[data-checked]') as HTMLElement | null;
		if (li && node.contains(li) && isRichText(el)) {
			const rect = li.getBoundingClientRect();
			const scale = rect.width / Math.max(1, li.offsetWidth);
			const gutter = (parseFloat(getWindow(li).getComputedStyle(li).paddingLeft) || 24) * scale;
			if (e.clientX >= rect.left && e.clientX <= rect.left + gutter) {
				li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
				const host = this.renderer?.richHostFor(el.id);
				if (host) {
					const html = sanitizeRichHtml(host.innerHTML.replace(/ data-highlighted="true"/g, ''));
					scene.transact(localize('voltScratch.toggleCheck', "Check item"), tx => tx.update(el.id, { html }), { selectionBefore: [el.id], selectionAfter: [el.id] });
				}
			}
		}
		if (el.link && (isMacintosh ? e.metaKey : e.ctrlKey)) {
			this.openLink(el.link);
		}
	}

	private onDoubleClick(e: MouseEvent): void {
		const scene = this.scene;
		if (!scene || this.textEditor.active) {
			return;
		}
		if (this.linearDraft) {
			this.finishLinearDraft(true);
			return;
		}
		if (this.state.tool !== 'select' && this.state.tool !== 'text') {
			return;
		}
		const screen = this.clientToScreen(e);
		const world = this.toWorld(screen);
		const selected = this.selectedElements();
		// Double-click a connector's bend to remove it.
		if (selected.length === 1 && isLinear(selected[0]) && selected[0].points.length > 2 && selected[0].arrowType !== 'elbow') {
			const el = selected[0];
			const h = this.linearHandles(el);
			const index = h.at.findIndex(p => distance(p, screen) <= 8);
			if (index > 0 && index < h.at.length - 1) {
				const points = el.points.filter((_, i) => i !== index);
				scene.transact(localize('voltScratch.removePoint', "Remove point"), tx => {
					tx.update(el.id, { points });
					const now = scene.get(el.id) as IScratchLinearElement;
					const patch = rebindConnector(now, lookupIn(scene));
					if (patch) {
						tx.update(el.id, patch);
					}
				}, { selectionBefore: [el.id], selectionAfter: [el.id] });
				return;
			}
		}
		const hit = this.hitAt(world);
		if (!hit) {
			this.state.setEditingGroup(null);
			this.createTextAt(world);
			return;
		}
		// Double-click into a group selects inside it.
		const editing = this.state.editingGroupId;
		const level = editing ? hit.groupIds[hit.groupIds.indexOf(editing) - 1] : hit.groupIds[hit.groupIds.length - 1];
		if (level && (!editing || hit.groupIds.includes(editing))) {
			this.state.setEditingGroup(level);
			this.select(this.selectableIds(hit));
			return;
		}
		if (isRichText(hit) || hasLabel(hit)) {
			this.select([hit.id]);
			this.editText(hit.id, { x: e.clientX, y: e.clientY });
		}
	}

	// ---- Keyboard --------------------------------------------------------------------------

	private onKeyDown(e: KeyboardEvent): void {
		if (this.isTextInput(e.target)) {
			return;
		}
		// Toolbar and panel buttons take Space and Enter themselves.
		if ((e.key === ' ' || e.key === 'Enter') && isHTMLElement(e.target) && e.target.closest('.sx-chrome')) {
			return;
		}
		const scene = this.scene;
		if (!scene) {
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
			handled(() => {
				if (!this.spaceHeld) {
					this.spaceHeld = true;
					this.updateCursor();
				}
			});
			return;
		}
		if (key === 'Escape') {
			handled(() => this.escape());
			return;
		}
		if (key === 'Enter') {
			if (this.linearDraft) {
				handled(() => this.finishLinearDraft(true));
				return;
			}
			if (mod) {
				handled(() => this.openComposer());
				return;
			}
			const selected = this.selectedElements();
			if (selected.length === 1 && (isRichText(selected[0]) || hasLabel(selected[0]))) {
				handled(() => this.editText(selected[0].id, 'end'));
			}
			return;
		}
		if (key === 'Delete' || key === 'Backspace') {
			if (this.state.selection.size) {
				handled(() => this.deleteSelection());
			}
			return;
		}
		if (key.startsWith('Arrow') && !mod && this.state.selection.size) {
			const step = e.shiftKey ? 10 : 1;
			const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
			const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
			handled(() => this.nudge(dx, dy));
			return;
		}
		if (mod) {
			if (lower === 'z' && !e.shiftKey) { handled(() => this.undo()); return; }
			if ((lower === 'z' && e.shiftKey) || lower === 'y') { handled(() => this.redo()); return; }
			if (lower === 'a' && !e.shiftKey) { handled(() => this.selectAll()); return; }
			if (lower === 'd' && !e.shiftKey) { handled(() => this.duplicateSelection()); return; }
			if (lower === 'g') { handled(() => e.shiftKey ? this.ungroupSelection() : this.groupSelection()); return; }
			if (lower === 'l' && e.shiftKey) { handled(() => this.toggleLockSelection()); return; }
			if (key === ']' || key === '}') { handled(() => this.arrange(e.shiftKey || e.altKey ? 'front' : 'forward')); return; }
			if (key === '[' || key === '{') { handled(() => this.arrange(e.shiftKey || e.altKey ? 'back' : 'backward')); return; }
			if ((key === '=' || key === '+') && !e.altKey) { handled(() => this.camera.zoomStep(1)); return; }
			if (key === '-' || key === '_') { handled(() => this.camera.zoomStep(-1)); return; }
			if (key === '0') { handled(() => this.resetZoom()); return; }
			if (lower === 'k' && !e.shiftKey) { handled(() => void this.editLinkOfSelection()); return; }
			if (lower === 'f' && !e.shiftKey) { handled(() => void this.findElements()); return; }
			if (key === '/') { handled(() => this.showShortcuts()); return; }
			if (lower === 'c' && e.shiftKey) { handled(() => void this.copySelectionAsPng()); return; }
			// With Option held, macOS reports c-cedilla and the square-root sign as the key: go by the physical key.
			if (e.code === 'KeyC' && e.altKey) { handled(() => this.copyStyles()); return; }
			if (e.code === 'KeyV' && e.altKey) { handled(() => this.pasteStyles()); return; }
			if (lower === 'e' && e.shiftKey) { handled(() => void this.exporter.exportImage(this, 'png')); return; }
			if (key === '\'') { handled(() => this.toggleGrid()); return; }
			return;
		}
		if (e.altKey && !e.shiftKey) {
			if (e.code === 'KeyS') { handled(() => this.setSnapToObjects(!scene.settings.snapToObjects)); return; }
			return;
		}
		if (e.shiftKey) {
			if (key === '!' || e.code === 'Digit1') { handled(() => this.zoomToFit()); return; }
			if (key === '@' || e.code === 'Digit2') { handled(() => this.zoomToSelection()); return; }
			if (key === ')' || e.code === 'Digit0') { handled(() => this.resetZoom()); return; }
			if (lower === 'h') { handled(() => this.flipSelection('horizontal')); return; }
			if (lower === 'v') { handled(() => this.flipSelection('vertical')); return; }
			if (lower === 'l') { handled(() => this.library.toggle()); return; }
			if (key === '?') { handled(() => this.showShortcuts()); return; }
			return;
		}
		if (e.altKey) {
			return;
		}
		const tool = TOOL_KEYS[lower];
		if (tool) {
			handled(() => {
				if (tool === 'comment') {
					// C on a selection comments on it; otherwise it picks the comment tool.
					if (this.state.tool === 'select' && this.state.selection.size) {
						this.commentOnSelection();
					} else {
						this.setTool('comment');
					}
				} else if (tool === 'lock') {
					this.state.setToolLocked(!this.state.toolLocked);
				} else if (tool === 'image') {
					void this.pickImage(this.viewportCenterWorld());
				} else {
					this.setTool(tool.tool, tool.shape);
				}
			});
		}
	}

	private onKeyUp(e: KeyboardEvent): void {
		if (e.key === ' ') {
			this.spaceHeld = false;
			this.updateCursor();
		}
	}

	private escape(): void {
		if (this.gesture) {
			this.cancelGesture();
			return;
		}
		if (this.linearDraft) {
			this.finishLinearDraft(true);
			return;
		}
		if (this.inspector.dismiss()) {
			return;
		}
		if (this.composer.isOpen) {
			this.composer.close();
			return;
		}
		if (this.comments.isOpen) {
			this.comments.close();
			return;
		}
		if (this.library.isOpen) {
			this.library.close();
			return;
		}
		if (this.host.closeRun()) {
			return;
		}
		if (this.state.editingGroupId) {
			const group = this.state.editingGroupId;
			this.state.setEditingGroup(null);
			const members = this.scene?.getElements().filter(el => el.groupIds.includes(group)).map(el => el.id) ?? [];
			this.select(members);
			return;
		}
		if (this.state.selection.size) {
			this.select([]);
			return;
		}
		if (this.state.tool !== 'select') {
			this.setTool('select');
		}
	}

	// ---- Tools -----------------------------------------------------------------------------

	setTool(tool: ScratchTool, shape?: ScratchShapeKind): void {
		if (this.linearDraft && tool !== this.state.tool) {
			this.finishLinearDraft(true);
		}
		this.textEditor.commit();
		this.state.setTool(tool, shape);
		if (tool !== 'select' && tool !== 'hand') {
			this.select([]);
		}
		this.focus();
	}

	private onToolChange(): void {
		this.updateCursor();
		this.showHint();
		this.toolbar.refresh();
		this.inspector.refresh();
		this.element.dataset.tool = this.state.tool;
	}

	private showHint(): void {
		const tool = this.state.tool;
		let text = '';
		if (this.linearDraft) {
			text = localize('voltScratch.hintDraft', "Click to add points, Enter or double-click to finish, Escape to stop");
		} else if (tool === 'hand') {
			text = localize('voltScratch.hintHand', "Drag to move the board. Scroll to pan, pinch or Cmd+scroll to zoom");
		} else if (tool === 'arrow' || tool === 'line') {
			text = localize('voltScratch.hintArrow', "Drag for a connector, or click to start one point by point. End on a shape to attach it");
		} else if (tool === 'draw') {
			text = localize('voltScratch.hintDraw', "Draw freely. Pen pressure works with a stylus");
		} else if (tool === 'text') {
			text = localize('voltScratch.hintText', "Click to write. Markdown shortcuts work as you type");
		} else if (tool === 'eraser') {
			text = localize('voltScratch.hintEraser', "Drag across what to erase");
		} else if (tool === 'laser') {
			text = localize('voltScratch.hintLaser', "Point things out; the trail fades away");
		} else if (tool === 'comment') {
			text = localize('voltScratch.hintComment', "Click something to comment on it, drag a box round several things, or click an empty spot. Comments wait, then go to an agent together");
		} else if (tool === 'frame') {
			text = localize('voltScratch.hintFrame', "Drag to frame an area. What is inside moves with it");
		} else if (tool === 'shape' || tool === 'note' || tool === 'card') {
			text = localize('voltScratch.hintShape', "Drag to size, or click to place. Shift keeps proportions, Alt draws from the centre");
		} else if (tool === 'select' && !this.state.selection.size && this.scene?.size) {
			text = localize('voltScratch.hintSelect', "To move the board, hold the scroll wheel or Space while dragging, or use the hand tool");
		}
		this.hint.textContent = text;
		this.hint.classList.toggle('visible', !!text);
	}

	// ---- Actions ---------------------------------------------------------------------------

	/**
	 * The board for an action (a key, a menu, the properties panel): a connector being placed point
	 * by point is finished first, and nothing runs while a drag holds the board.
	 */
	private actionScene(): ScratchScene | undefined {
		if (this.linearDraft) {
			this.finishLinearDraft(true);
		}
		const scene = this.scene;
		return scene && !scene.inTransaction ? scene : undefined;
	}

	/** The board once nothing is in progress; for actions that arrive late (an image read, an agent send). */
	async whenIdle(): Promise<ScratchScene | undefined> {
		const scene = this.scene;
		while (scene && this.scene === scene && !this._store.isDisposed) {
			const ready = this.actionScene();
			if (ready) {
				return ready;
			}
			await Event.toPromise(scene.onDidEndTransaction);
		}
		return undefined;
	}

	undo(): void {
		this.textEditor.commit();
		this.finishLinearDraft(true);
		this.scene?.undo();
	}

	redo(): void {
		this.textEditor.commit();
		this.scene?.redo();
	}

	deleteSelection(): void {
		// Locked elements stay: unlock them first.
		this.deleteElements(this.selectedWithContents().filter(el => !el.locked).map(el => el.id), localize('voltScratch.delete', "Delete"));
	}

	private deleteElements(ids: readonly string[], label: string): void {
		const scene = this.actionScene();
		if (!scene || !ids.length) {
			return;
		}
		const remove = new Set(ids);
		// What is left of a frame's contents (Delete takes them along; a caller may pass a frame alone) leaves it.
		scene.transact(label, tx => {
			for (const id of remove) {
				tx.remove(id);
			}
			for (const el of scene.getElements()) {
				if (isLinear(el)) {
					const dropStart = el.startBinding && remove.has(el.startBinding.elementId);
					const dropEnd = el.endBinding && remove.has(el.endBinding.elementId);
					if (dropStart || dropEnd) {
						tx.update(el.id, { startBinding: dropStart ? null : el.startBinding, endBinding: dropEnd ? null : el.endBinding });
					}
				}
				if (el.frameId && remove.has(el.frameId)) {
					tx.update(el.id, { frameId: null });
				}
			}
		}, { selectionBefore: [...this.state.selection], selectionAfter: [] });
		this.select([]);
	}

	duplicateSelection(): void {
		const scene = this.actionScene();
		const selected = this.selectedWithContents();
		if (!scene || !selected.length) {
			return;
		}
		const { elements: copies } = duplicateElements(selected, [16, 16]);
		scene.transact(localize('voltScratch.duplicate', "Duplicate"), tx => {
			const top = Math.max(...selected.map(el => scene.indexOf(el.id)));
			copies.forEach((c, i) => tx.add(c, top + 1 + i));
		}, { selectionBefore: [...this.state.selection], selectionAfter: copies.map(c => c.id) });
		// The copies of what was selected (a frame's contents come along without being selected).
		this.select(copies.filter(c => !c.frameId || !copies.some(o => o.id === c.frameId)).map(c => c.id));
	}

	private nudge(dx: number, dy: number): void {
		const scene = this.actionScene();
		const selected = this.selectedElements().filter(el => !el.locked);
		if (!scene || !selected.length) {
			return;
		}
		scene.transact(localize('voltScratch.nudge', "Move"), tx => {
			const ids = withFrameContents(scene.getElements(), new Set(selected.map(el => el.id)));
			for (const [id, patch] of moveMany([...ids].map(id => scene.get(id)!).filter(Boolean), dx, dy)) {
				tx.update(id, patch);
			}
			this.releaseLeftBindings(tx, ids);
			this.rebindAround(tx, ids);
		}, { selectionBefore: [...this.state.selection], selectionAfter: [...this.state.selection], coalesceKey: `nudge:${[...this.state.selection].join(',')}` });
	}

	groupSelection(): void {
		const scene = this.actionScene();
		const selected = this.selectedElements();
		if (!scene || selected.length < 2) {
			return;
		}
		const group = newElementId();
		const editing = this.state.editingGroupId;
		scene.transact(localize('voltScratch.group', "Group"), tx => {
			for (const el of selected) {
				// The new group sits inside the group being edited, outside everything below it.
				const groups = [...el.groupIds];
				const at = editing ? groups.indexOf(editing) : groups.length;
				groups.splice(at < 0 ? groups.length : at, 0, group);
				tx.update(el.id, { groupIds: groups });
			}
			// Members of a group paint together, at the topmost member's place.
			const order = scene.getElements().map(e => e.id);
			const ids = new Set(selected.map(e => e.id));
			const top = Math.max(...selected.map(e => order.indexOf(e.id)));
			const rest = order.filter(id => !ids.has(id));
			const insertAt = rest.findIndex(id => order.indexOf(id) > top);
			const members = order.filter(id => ids.has(id));
			rest.splice(insertAt < 0 ? rest.length : insertAt, 0, ...members);
			tx.reorder(rest);
		}, { selectionBefore: selected.map(e => e.id), selectionAfter: selected.map(e => e.id) });
		this.requestFrame();
	}

	ungroupSelection(): void {
		const scene = this.actionScene();
		const selected = this.selectedElements();
		if (!scene || !selected.length) {
			return;
		}
		const groups = new Set(this.selectedGroups(selected));
		const editing = this.state.editingGroupId;
		// Only the outermost selected groups (below the edited group) come apart.
		const outermost = [...groups].filter(g => g !== editing && !selected.some(el => {
			const i = el.groupIds.indexOf(g);
			return i >= 0 && el.groupIds.slice(i + 1).some(o => groups.has(o) && o !== editing);
		}));
		if (!outermost.length) {
			return;
		}
		scene.transact(localize('voltScratch.ungroup', "Ungroup"), tx => {
			for (const el of selected) {
				const next = el.groupIds.filter(g => !outermost.includes(g));
				if (next.length !== el.groupIds.length) {
					tx.update(el.id, { groupIds: next });
				}
			}
		}, { selectionBefore: selected.map(e => e.id), selectionAfter: selected.map(e => e.id) });
		this.requestFrame();
	}

	toggleLockSelection(): void {
		const scene = this.actionScene();
		const selected = this.selectedElements();
		if (!scene || !selected.length) {
			return;
		}
		const lock = selected.some(el => !el.locked);
		scene.transact(lock ? localize('voltScratch.lock', "Lock") : localize('voltScratch.unlock', "Unlock"), tx => {
			for (const el of selected) {
				tx.update(el.id, { locked: lock });
			}
		}, { selectionBefore: selected.map(e => e.id), selectionAfter: lock ? [] : selected.map(e => e.id) });
		if (lock) {
			this.select([]);
		}
	}

	unlockAll(): void {
		const scene = this.actionScene();
		const locked = scene?.getElements().filter(el => el.locked) ?? [];
		if (!scene || !locked.length) {
			return;
		}
		scene.transact(localize('voltScratch.unlockAll', "Unlock all"), tx => {
			for (const el of locked) {
				tx.update(el.id, { locked: false });
			}
		}, { selectionBefore: [...this.state.selection], selectionAfter: locked.map(el => el.id) });
		this.select(locked.map(el => el.id));
	}

	hasLockedElements(): boolean {
		return !!this.scene?.getElements().some(el => el.locked);
	}

	arrange(direction: 'front' | 'forward' | 'backward' | 'back'): void {
		const scene = this.actionScene();
		if (!scene || !this.state.selection.size) {
			return;
		}
		const order = scene.getElements().map(e => e.id);
		const selected = new Set(this.state.selection);
		let next: string[];
		if (direction === 'front') {
			next = [...order.filter(id => !selected.has(id)), ...order.filter(id => selected.has(id))];
		} else if (direction === 'back') {
			next = [...order.filter(id => selected.has(id)), ...order.filter(id => !selected.has(id))];
		} else if (direction === 'forward') {
			next = [...order];
			for (let i = next.length - 2; i >= 0; i--) {
				if (selected.has(next[i]) && !selected.has(next[i + 1])) {
					[next[i], next[i + 1]] = [next[i + 1], next[i]];
				}
			}
		} else {
			next = [...order];
			for (let i = 1; i < next.length; i++) {
				if (selected.has(next[i]) && !selected.has(next[i - 1])) {
					[next[i], next[i - 1]] = [next[i - 1], next[i]];
				}
			}
		}
		scene.transact(localize('voltScratch.arrange', "Arrange"), tx => tx.reorder(next), { selectionBefore: [...selected], selectionAfter: [...selected] });
	}

	align(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void {
		this.applyPatchMap(localize('voltScratch.align', "Align"), alignMany(this.selectedElements(), mode));
	}

	distribute(axis: 'horizontal' | 'vertical'): void {
		this.applyPatchMap(localize('voltScratch.distribute', "Distribute"), distributeMany(this.selectedElements(), axis));
	}

	flipSelection(axis: 'horizontal' | 'vertical'): void {
		this.applyPatchMap(localize('voltScratch.flip', "Flip"), flipMany(this.selectedElements(), axis));
	}

	private applyPatchMap(label: string, patches: Map<string, ScratchPatch>): void {
		const scene = this.actionScene();
		if (!scene || !patches.size) {
			return;
		}
		scene.transact(label, tx => {
			for (const [id, patch] of patches) {
				tx.update(id, patch);
			}
			this.releaseLeftBindings(tx, new Set(patches.keys()));
			this.rebindAround(tx, new Set(patches.keys()));
		}, { selectionBefore: [...this.state.selection], selectionAfter: [...this.state.selection] });
	}

	/**
	 * A style change from the inspector: becomes the default for new elements and applies to
	 * what is selected. `coalesce` folds a slider drag into one undo step.
	 */
	applyStyle(patch: Partial<IScratchStyleDefaults>, elementPatch: (el: ScratchElement) => ScratchPatch | undefined, coalesce?: string): void {
		this.state.setStyle(patch);
		const scene = this.actionScene();
		const selected = this.selectedElements();
		if (!scene || !selected.length) {
			return;
		}
		const editing = this.textEditor.active;
		// A text still being written for the first time becomes one "Add text" step when it is done;
		// a style step of its own would bring back an empty element on undo.
		const record = !selected.every(el => this.pendingNewText.has(el.id));
		scene.transact(localize('voltScratch.style', "Change style"), tx => {
			const routing = routingIn(scene);
			for (const el of selected) {
				const p = elementPatch(el);
				const next = p ? tx.update<ScratchElement>(el.id, p) : undefined;
				if (next && isLinear(next) && isLinear(el) && next.arrowType !== el.arrowType) {
					const retyped = retypeConnector(next, el.arrowType, id => scene.get(id), undefined, routing.around(next));
					routing.moved(el.id, retyped);
					if (retyped) {
						tx.update(el.id, retyped);
					}
				}
			}
			this.rebindAround(tx, new Set(selected.map(e => e.id)));
		}, { selectionBefore: selected.map(e => e.id), selectionAfter: selected.map(e => e.id), coalesceKey: coalesce, record });
		if (editing) {
			this.requestFrame();
		}
	}

	private copiedStyle: Partial<IScratchElementBase> | undefined;

	copyStyles(): void {
		const el = this.selectedElements()[0];
		if (el) {
			this.copiedStyle = { stroke: el.stroke, fill: el.fill, fillStyle: el.fillStyle, strokeWidth: el.strokeWidth, strokeStyle: el.strokeStyle, roughness: el.roughness, opacity: el.opacity, roundness: el.roundness };
		}
	}

	pasteStyles(): void {
		const style = this.copiedStyle;
		if (!style) {
			return;
		}
		this.applyStyle({}, el => (el.type === 'image' ? { opacity: style.opacity } : style));
	}

	get hasCopiedStyle(): boolean {
		return !!this.copiedStyle;
	}

	resetZoom(): void {
		this.camera.zoomAt(1, [this.width / 2, this.height / 2], true);
	}

	zoomToFit(animate = true): void {
		const scene = this.scene;
		if (!scene || !scene.size) {
			this.camera.animateTo({ x: this.width / 2, y: this.height / 2, zoom: 1 });
			return;
		}
		const b = unionBounds(scene.getElements().map(el => geometricBounds(el)));
		if (b) {
			this.camera.fit(b, 80, 1, animate);
		}
	}

	zoomToSelection(): void {
		const b = selectionBounds(this.selectedElements());
		if (b) {
			this.camera.fit(b, 96, 4);
		} else {
			this.zoomToFit();
		}
	}

	/** Pans (without selecting) so `ids` are on screen, when they are not already. */
	bringIntoView(ids: readonly string[]): void {
		const scene = this.scene;
		const b = selectionBounds(ids.map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el));
		if (b && !boundsContain(this.camera.visibleBounds(), b)) {
			this.camera.fit(b, 120, Math.max(this.camera.zoom, 0.6), true);
		}
	}

	/** Selects `ids` and brings them into view. */
	reveal(ids: readonly string[]): void {
		const scene = this.scene;
		const elements = ids.map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el);
		const b = selectionBounds(elements);
		if (!b) {
			return;
		}
		this.select(elements.map(el => el.id));
		const view = this.camera.visibleBounds();
		if (!boundsContain(view, b)) {
			this.camera.fit(b, 120, Math.max(this.camera.zoom, 0.6));
		}
	}

	toggleGrid(): void {
		const scene = this.scene;
		if (scene) {
			this.setSettings({ grid: scene.settings.grid === 'none' ? 'dots' : 'none' });
		}
	}

	setSnapToObjects(on: boolean): void {
		this.setSettings({ snapToObjects: on });
	}

	setSettings(patch: Partial<ScratchScene['settings']>): void {
		const scene = this.actionScene();
		if (!scene) {
			return;
		}
		scene.transact(localize('voltScratch.boardSettings', "Board settings"), tx => tx.setSettings(patch), { selectionBefore: [...this.state.selection], selectionAfter: [...this.state.selection], coalesceKey: 'settings' });
		this.applySettings();
		this.updateTheme();
	}

	clearBoard(): void {
		const scene = this.scene;
		if (!scene || !scene.size) {
			return;
		}
		this.deleteElements(scene.getElements().map(e => e.id), localize('voltScratch.clear', "Clear board"));
	}

	async editLinkOfSelection(): Promise<void> {
		const scene = this.scene;
		const selected = this.selectedElements();
		if (!scene || !selected.length) {
			return;
		}
		const url = await this.askLink(selected[0].link ?? undefined);
		if (url === undefined || await this.whenIdle() !== scene) {
			return;
		}
		scene.transact(localize('voltScratch.link', "Link"), tx => {
			for (const el of selected) {
				tx.update(el.id, { link: url || null });
			}
		}, { selectionBefore: selected.map(e => e.id), selectionAfter: selected.map(e => e.id) });
	}

	/** Cmd+F: every element with text, searchable; picking one flies to it. */
	async findElements(): Promise<void> {
		const scene = this.scene;
		if (!scene) {
			return;
		}
		const items = readingOrder(scene.getElements().filter(el => isRichText(el) || (hasLabel(el) && el.label) || el.type === 'frame'))
			.map(el => {
				const text = el.type === 'frame' ? el.name : htmlToMarkdown(isRichText(el) ? el.html : (hasLabel(el) && el.label ? el.label.html : '')).replace(/\s+/g, ' ').trim();
				return { label: text.slice(0, 140) || localize('voltScratch.untitledElement', "(empty)"), description: elementKindLabel(el), id: el.id };
			})
			.filter(item => item.label);
		const picked = await this.quickInputService.pick(items, { placeHolder: localize('voltScratch.findPlaceholder', "Find on this board"), matchOnDescription: true });
		if (picked) {
			this.reveal([picked.id]);
		}
	}

	showShortcuts(): void {
		this.instantiationService.invokeFunction(accessor => showScratchShortcuts(accessor, this.element));
	}

	showMainMenu(anchor: HTMLElement): void {
		this.instantiationService.invokeFunction(accessor => showScratchMainMenu(accessor, this, this.host, anchor));
	}

	private onContextMenu(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		if (!this.scene) {
			return;
		}
		const screen = this.clientToScreen(e);
		this.instantiationService.invokeFunction(accessor => showScratchContextMenu(accessor, this, { x: e.clientX, y: e.clientY }, this.toWorld(screen)));
	}

	async copySelectionAsPng(): Promise<void> {
		const elements = this.selectedWithContents();
		const blob = await this.exporter.renderPng(this, elements.length ? elements : [...(this.scene?.getElements() ?? [])], { scale: 2 });
		if (!blob) {
			return;
		}
		try {
			const win = getWindow(this.element) as Window & typeof globalThis;
			await win.navigator.clipboard.write([new win.ClipboardItem({ 'image/png': blob })]);
			this.notificationService.info(localize('voltScratch.copiedPng', "Copied as PNG"));
		} catch (err) {
			this.notificationService.error(localize('voltScratch.copyPngFailed', "Could not copy the image: {0}", String(err)));
		}
	}

	/** Tidy up: lays out the selected connected shapes as a layered graph, keeping connections. */
	tidySelection(direction: 'TB' | 'LR' = 'LR'): void {
		const scene = this.actionScene();
		const selected = this.selectedElements();
		if (!scene || selected.length < 2) {
			return;
		}
		const nodes = selected.filter(el => !isLinear(el) && el.type !== 'draw' && el.type !== 'frame');
		const ids = new Set(nodes.map(n => n.id));
		const edges = scene.getElements().filter(isLinear)
			.filter(c => c.startBinding && c.endBinding && ids.has(c.startBinding.elementId) && ids.has(c.endBinding.elementId))
			.map(c => ({ from: c.startBinding!.elementId, to: c.endBinding!.elementId }));
		if (nodes.length < 2) {
			return;
		}
		const before = selectionBounds(nodes)!;
		const positions = layeredLayout(nodes.map(n => ({ id: n.id, width: elementBox(n).width, height: elementBox(n).height })), edges, direction, { node: 56, rank: 96 });
		const placed = [...positions.values()];
		const minX = Math.min(...placed.map(p => p[0])), minY = Math.min(...placed.map(p => p[1]));
		scene.transact(localize('voltScratch.tidy', "Tidy up"), tx => {
			for (const n of nodes) {
				const p = positions.get(n.id);
				if (!p) {
					continue;
				}
				const box = elementBox(n);
				const dx = before.minX + (p[0] - minX) - box.x;
				const dy = before.minY + (p[1] - minY) - box.y;
				for (const [id, patch] of moveMany([n], dx, dy)) {
					tx.update(id, patch);
				}
			}
			this.rebindAround(tx, ids);
		}, { selectionBefore: [...this.state.selection], selectionAfter: [...this.state.selection] });
	}

	// ---- Inserting -------------------------------------------------------------------------

	/**
	 * Adds elements (from the library, a paste, a diagram) centred on `at` (or the viewport),
	 * selects them and records one undo step.
	 */
	insertElements(elements: readonly ScratchElement[], at?: Vec, label = localize('voltScratch.insert', "Insert")): void {
		const scene = this.actionScene();
		if (!scene || !elements.length) {
			return;
		}
		this.textEditor.commit();
		const b = selectionBounds(elements);
		const target = at ?? (b ? this.freeSpotNear(this.viewportCenterWorld(), b.maxX - b.minX, b.maxY - b.minY) : this.viewportCenterWorld());
		const dx = b ? target[0] - (b.minX + b.maxX) / 2 : 0;
		const dy = b ? target[1] - (b.minY + b.maxY) / 2 : 0;
		const { elements: placed } = duplicateElements(elements, [dx, dy]);
		scene.transact(label, tx => {
			// Frames first so they paint underneath.
			for (const el of placed) {
				tx.add(el, el.type === 'frame' ? 0 : undefined);
			}
			// Copies land wherever they land: a frame left behind is not theirs any more.
			this.assignFrames(tx, placed);
			this.rebindAround(tx, new Set(placed.map(p => p.id)));
			// Connectors that came with them (a pasted diagram) land on their shapes' outlines, elbows routed.
			const routing = routingIn(scene);
			for (const el of placed) {
				const now = scene.get(el.id);
				if (now && isLinear(now) && (now.startBinding || now.endBinding)) {
					const patch = rebindConnector(now, lookupIn(scene), undefined, routing.around(now));
					routing.moved(now.id, patch);
					if (patch) {
						tx.update(now.id, patch);
					}
				}
			}
		}, { selectionBefore: [...this.state.selection], selectionAfter: placed.map(p => p.id) });
		this.select(placed.filter(p => !p.frameId || !placed.some(o => o.id === p.frameId)).map(p => p.id));
		const pb = selectionBounds(placed);
		if (pb && !boundsContain(this.camera.visibleBounds(), pb)) {
			this.camera.fit(pb, 120, this.camera.zoom);
		}
		this.state.setTool('select');
		this.focus();
	}

	/**
	 * The middle of the view if a `width` x `height` block fits there without covering anything,
	 * else the nearest free place: on screen if there is one, off it otherwise (the view follows).
	 * A second library block so never lands on the first.
	 */
	private freeSpotNear(center: Vec, width: number, height: number): Vec {
		const taken = [...(this.scene?.getElements() ?? []).map(el => elementBounds(el)), ...this.reservedSpots()];
		const view = this.camera.visibleBounds();
		const margin = 16 / this.camera.zoom;
		const free = (c: Vec, onScreen: boolean) => {
			const box = { minX: c[0] - width / 2 - margin, minY: c[1] - height / 2 - margin, maxX: c[0] + width / 2 + margin, maxY: c[1] + height / 2 + margin };
			return (!onScreen || boundsContain(view, box)) && !taken.some(b => boundsIntersect(b, box));
		};
		if (!taken.length || free(center, false)) {
			return center;
		}
		const step = Math.max(24, Math.min(width, height) / 2);
		for (const onScreen of [true, false]) {
			for (let ring = 1; ring <= (onScreen ? 16 : 60); ring++) {
				const offsets: Vec[] = [];
				for (let dx = -ring; dx <= ring; dx++) {
					for (let dy = -ring; dy <= ring; dy++) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) {
							offsets.push([dx * step, dy * step]);
						}
					}
				}
				// Nearest first; at the same distance, right of the middle, then below it.
				offsets.sort((a, b) => (Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1])) || (b[0] - a[0]) || (b[1] - a[1]));
				for (const [dx, dy] of offsets) {
					const c: Vec = [center[0] + dx, center[1] + dy];
					if (free(c, onScreen)) {
						return c;
					}
				}
			}
		}
		return center;
	}

	/** Spots kept for agents asked with nothing attached: their drawing lands there, so nothing else should. */
	reservedSpots(): IScratchBounds[] {
		return (this.scene?.runs ?? []).filter(run => !run.elementIds.length && !run.hidden).map(run => ({
			minX: run.bounds.x, minY: run.bounds.y, maxX: run.bounds.x + run.bounds.width, maxY: run.bounds.y + run.bounds.height,
		}));
	}

	/** Where a paste lands: under the pointer, nudged on repeated pastes. */
	private pasteTarget(): Vec {
		if (this.pointerScreen && this.pointerScreen[0] >= 0 && this.pointerScreen[1] >= 0 && this.pointerScreen[0] <= this.width && this.pointerScreen[1] <= this.height) {
			const at = this.toWorld(this.pointerScreen);
			if (this.lastPaste && distance(this.lastPaste.at, at) < 2) {
				this.lastPaste.count++;
				return [at[0] + 16 * this.lastPaste.count, at[1] + 16 * this.lastPaste.count];
			}
			this.lastPaste = { at, count: 0 };
			return at;
		}
		return this.viewportCenterWorld();
	}

	async insertImageFile(file: Blob, at?: Vec): Promise<void> {
		const scene = this.scene;
		if (!scene || !file.type.startsWith('image/')) {
			return;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (file.type === 'image/svg+xml' && bytes.length <= MAX_ICON_SVG_LENGTH) {
			// Small SVGs become icons (they take the stroke colour); big ones stay images.
			const svg = new TextDecoder().decode(bytes);
			if (/<svg[\s>]/i.test(svg)) {
				this.insertSvgIcon(svg, 'file:svg', at);
				return;
			}
		}
		const size = await imageSize(file);
		const assetId = await this.boards.putAsset(bytes, file.type);
		const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(size.width, size.height, 1));
		const width = Math.max(16, size.width * scale), height = Math.max(16, size.height * scale);
		const target = at ?? this.pasteTarget();
		const el = createImage({ x: target[0] - width / 2, y: target[1] - height / 2, width, height, assetId, mime: file.type, naturalWidth: size.width, naturalHeight: size.height }, this.state.style);
		// The file took a moment to read: the board may be mid-drag, or another one by now.
		if (await this.whenIdle() !== scene) {
			return;
		}
		scene.transact(localize('voltScratch.addImage', "Add image"), tx => {
			tx.add(el);
			this.assignFrames(tx, [el]);
		}, { selectionBefore: [...this.state.selection], selectionAfter: [el.id] });
		this.select([el.id]);
	}

	insertSvgIcon(svg: string, iconId: string, at?: Vec, size = 64): void {
		if (svg.length > MAX_ICON_SVG_LENGTH) {
			void this.insertImageFile(new Blob([svg], { type: 'image/svg+xml' }), at);
			return;
		}
		const tintable = /currentColor/.test(svg);
		const target = at ?? this.pasteTarget();
		const el = createIcon({ x: target[0] - size / 2, y: target[1] - size / 2, width: size, height: size, iconId, svg, tintable }, this.state.style);
		const scene = this.actionScene();
		if (!scene) {
			return;
		}
		scene.transact(localize('voltScratch.addIcon', "Add icon"), tx => {
			tx.add(el);
			this.assignFrames(tx, [el]);
		}, { selectionBefore: [...this.state.selection], selectionAfter: [el.id] });
		this.select([el.id]);
	}

	private async pickImage(at: Vec): Promise<void> {
		const doc = this.element.ownerDocument;
		const input = doc.createElement('input');
		input.type = 'file';
		input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
		input.multiple = true;
		input.style.display = 'none';
		doc.body.appendChild(input);
		const files = await new Promise<File[]>(resolve => {
			input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
			input.addEventListener('cancel', () => resolve([]), { once: true });
			input.click();
		});
		input.remove();
		let offset = 0;
		for (const file of files) {
			await this.insertImageFile(file, [at[0] + offset, at[1] + offset]);
			offset += 24;
		}
		if (!this.state.toolLocked) {
			this.state.setTool('select');
		}
	}

	/** Text from the clipboard or a drop, as the most useful element. */
	insertText(text: string, html: string | undefined, at?: Vec): void {
		if (text.length > MAX_PASTE_TEXT_LENGTH || (html?.length ?? 0) > MAX_PASTE_TEXT_LENGTH) {
			// A board stores up to 2 MB of text per element; more would come back cut short.
			this.notificationService.info(localize('voltScratch.pasteTooLong', "That text is too long for a board. Paste it into a file and link it instead."));
			return;
		}
		const target = at ?? this.pasteTarget();
		const mermaid = extractMermaidSource(text);
		const graph = mermaid ? parseMermaidFlowchart(mermaid) : undefined;
		if (graph && graph.nodes.length) {
			this.insertElements(mermaidToElements(graph, [0, 0], this.state.style), target, localize('voltScratch.pasteDiagram', "Paste diagram"));
			return;
		}
		const trimmed = text.trim();
		if (/^<svg[\s>][\s\S]*<\/svg>\s*$/i.test(trimmed)) {
			this.insertSvgIcon(trimmed, 'paste:svg', target);
			return;
		}
		const doc = this.element.ownerDocument;
		if (/^https?:\/\/\S+$/i.test(trimmed)) {
			const safe = trimmed.replace(/"/g, '%22');
			this.insertElements([createText({ x: 0, y: 0, html: `<p><a href="${safe}">${escapeForHtml(trimmed)}</a></p>`, autoSize: true, link: trimmed }, this.state.style)], target, localize('voltScratch.pasteLink', "Paste link"));
			return;
		}
		if (looksLikeMarkdown(text)) {
			const rich = markdownToRichHtml(text, doc);
			this.insertElements([createCard({ x: 0, y: 0, width: 520, html: rich }, this.state.style)], target, localize('voltScratch.pasteMarkdown', "Paste markdown"));
			return;
		}
		if (html && !text.trim()) {
			return;
		}
		const lines = text.split(/\r?\n/);
		if (text.length > 600 || lines.length > 12) {
			this.insertElements([createCard({ x: 0, y: 0, width: 520, html: plainTextAsRichHtml(text) }, this.state.style)], target, localize('voltScratch.pasteText', "Paste text"));
			return;
		}
		const el = createText({ x: 0, y: 0, html: plainTextAsRichHtml(text), autoSize: true }, this.state.style);
		this.insertElements([el], target, localize('voltScratch.pasteText', "Paste text"));
	}

	// ---- Clipboard and drop ----------------------------------------------------------------

	private onCopy(e: ClipboardEvent, cut: boolean): void {
		if (this.isTextInput(e.target) || this.textEditor.active) {
			return;
		}
		const selected = this.selectedWithContents();
		if (!selected.length || !e.clipboardData) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		e.clipboardData.setData(CLIPBOARD_MIME, JSON.stringify({ type: 'volt-scratch/clipboard', version: 1, elements: selected }));
		// Other apps get the words.
		const text = readingOrder(selected).map(el => isRichText(el) ? htmlToMarkdown(el.html) : hasLabel(el) && el.label ? htmlToMarkdown(el.label.html) : el.type === 'frame' ? el.name : '').filter(Boolean).join('\n\n');
		e.clipboardData.setData('text/plain', text || ' ');
		// The menu's Paste reads the system clipboard, which drops our own format: remember it here.
		this.lastCopied = { text: text || ' ', elements: selected };
		if (cut) {
			this.deleteElements(selected.filter(el => !el.locked).map(el => el.id), localize('voltScratch.cut', "Cut"));
		}
	}

	private onPaste(e: ClipboardEvent): void {
		if (this.isTextInput(e.target) || this.textEditor.active || !this.scene) {
			return;
		}
		const data = e.clipboardData;
		if (!data) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const own = data.getData(CLIPBOARD_MIME);
		if (own) {
			try {
				const parsed = JSON.parse(own) as { elements?: unknown[] };
				const elements = parseClipboardElements(parsed.elements);
				if (elements.length) {
					this.insertElements(elements, this.pasteTarget(), localize('voltScratch.paste', "Paste"));
					return;
				}
			} catch {
				// Fall through to text.
			}
		}
		const files = Array.from(data.files ?? []).filter(f => f.type.startsWith('image/'));
		if (files.length) {
			const at = this.pasteTarget();
			void (async () => {
				let offset = 0;
				for (const file of files) {
					await this.insertImageFile(file, [at[0] + offset, at[1] + offset]);
					offset += 24;
				}
			})();
			return;
		}
		const text = data.getData('text/plain');
		const html = data.getData('text/html');
		if (text) {
			this.insertText(text, html || undefined);
		} else if (html) {
			this.insertElements([createCard({ x: 0, y: 0, width: 520, html: sanitizeRichHtml(html) }, this.state.style)], this.pasteTarget(), localize('voltScratch.paste', "Paste"));
		}
	}

	/** Copy or cut from a menu: the browser's copy event carries our own format. */
	copyToClipboard(cut: boolean): void {
		this.element.focus({ preventScroll: true });
		this.element.ownerDocument.execCommand(cut ? 'cut' : 'copy');
	}

	/** Pastes from the system clipboard (the context menu has no paste event to read). */
	async pasteFromClipboard(at: Vec): Promise<void> {
		try {
			const win = getWindow(this.element) as Window & typeof globalThis;
			const items = await win.navigator.clipboard.read();
			for (const item of items) {
				const imageType = item.types.find(t => t.startsWith('image/'));
				if (imageType) {
					await this.insertImageFile(await item.getType(imageType), at);
					return;
				}
			}
		} catch {
			// No permission or no images: try text.
		}
		const text = await this.clipboardService.readText();
		if (this.lastCopied && text === this.lastCopied.text) {
			this.insertElements(this.lastCopied.elements, at, localize('voltScratch.paste', "Paste"));
			return;
		}
		if (text) {
			this.insertText(text, undefined, at);
		}
	}

	private lastCopied: { readonly text: string; readonly elements: readonly ScratchElement[] } | undefined;

	private onDrop(e: DragEvent): void {
		const data = e.dataTransfer;
		if (!data) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const world = this.toWorld(this.clientToScreen(e));
		const libraryItem = data.getData(ScratchLibrary.DRAG_MIME);
		if (libraryItem) {
			this.library.dropAt(libraryItem, world);
			return;
		}
		const files = Array.from(data.files ?? []);
		void (async () => {
			let offset = 0;
			for (const file of files) {
				const at: Vec = [world[0] + offset, world[1] + offset];
				offset += 24;
				if (file.type.startsWith('image/')) {
					await this.insertImageFile(file, at);
				} else if (/\.(md|markdown|txt|mmd|mermaid)$/i.test(file.name) || file.type.startsWith('text/')) {
					this.insertText(await file.text(), undefined, at);
				}
			}
		})();
	}

	// ---- Agents ------------------------------------------------------------------------------

	get agentBridge(): IScratchAgentBridge {
		return this.agents;
	}

	openComposer(whole = false): void {
		this.comments.close();
		this.composer.open(whole);
		if (this.composer.isOpen) {
			this._onDidOpenComposer.fire();
		}
	}

	/** The comments' batch, in the composer: it goes to an agent from there. */
	openCommentsComposer(): void {
		this.composer.openComments();
		if (this.composer.isOpen) {
			this._onDidOpenComposer.fire();
		}
	}

	/** A comment on what is selected (a frame on its own, not with its contents). */
	commentOnSelection(): void {
		const ids = this.selectedElements().map(el => el.id);
		if (ids.length) {
			this.composer.close();
			this.comments.start(ids);
		}
	}

	private commentDown(e: PointerEvent, world: Vec): void {
		if (this.comments.isOpen) {
			// A click away from an open comment puts it down, like any popover.
			this.comments.close();
			return;
		}
		const hit = this.hitAt(world);
		this.setHover(undefined);
		if (hit) {
			this.comments.start(this.selectableIds(hit));
			return;
		}
		// An empty spot: a drag boxes several things for one comment, a click pins the comment there.
		this.beginGesture(e, { kind: 'marquee', pointerId: e.pointerId, startWorld: world, currentWorld: world, additive: false, base: new Set(this.state.selection), comment: true });
	}

	private finishCommentMarquee(g: Extract<Gesture, { kind: 'marquee' }>): void {
		const ids = [...this.state.selection];
		// The box only showed what it takes; the comment marks it from here.
		this.select([...g.base]);
		if (distance(this.toScreen(g.startWorld), this.toScreen(g.currentWorld)) < DRAG_THRESHOLD) {
			this.comments.start([], g.startWorld);
		} else if (ids.length) {
			this.comments.start(ids);
		}
	}

	/** "Rectangle", "Sticky note": what an element is, for labels. */
	kindLabel(el: ScratchElement): string {
		return el.type === 'shape' ? SHAPE_LABELS[el.shape] : elementKindLabel(el);
	}

	/** The highest a floating bar may sit: under the top bars, and under the properties bar when it shows. */
	get chromeTop(): number {
		// `--sx-under-bars` (48px), then the properties bar.
		return 48 + (this.inspector.visible ? 46 : 4);
	}

	get boardTitle(): string {
		return this.host.boardTitle();
	}

	get agentProjectId(): string | undefined {
		return this.host.agentProjectId();
	}

	openRunChat(sessionId: string): void {
		this.host.openRun(sessionId);
	}

	noteRunStarted(run: IScratchAgentRun): void {
		this._onDidStartRun.fire(run);
	}

	/**
	 * Drags what a run marks, its chip the handle (like a frame's name): the board's own move from
	 * here on, so snapping, connectors and undo behave as for any drag. False when there is nothing
	 * to move (a run drawn into a free spot only, or something locked).
	 */
	dragRun(runId: string, e: { readonly pointerId: number; readonly clientX: number; readonly clientY: number }): boolean {
		const scene = this.scene;
		const run = scene?.runs.find(r => r.id === runId);
		if (!scene || !run || this.gesture || scene.inTransaction) {
			return false;
		}
		const elements = run.elementIds.map(id => scene.get(id)).filter((el): el is ScratchElement => !!el);
		if (!elements.length || elements.some(el => el.locked)) {
			return false;
		}
		const screen = this.clientToScreen(e);
		this.startMove({ kind: 'pending', pointerId: e.pointerId, start: screen, startWorld: this.toWorld(screen), hitId: undefined, shift: false, alt: false, insideSelection: false }, elements);
		try {
			this.stage.setPointerCapture(e.pointerId);
		} catch {
			// Synthetic events have no capture.
		}
		this.updateCursor();
		this.requestFrame();
		return true;
	}

	hideRun(runId: string): void {
		const scene = this.actionScene();
		if (!scene) {
			return;
		}
		scene.transact(localize('voltScratch.hideRun', "Hide agent outline"), tx => tx.setRuns(scene.runs.map(r => r.id === runId ? { ...r, hidden: true } : r)), { selectionBefore: [...this.state.selection], selectionAfter: [...this.state.selection] });
	}

	toggleLibrary(): void {
		this.library.toggle();
	}

	get libraryOpen(): boolean {
		return this.library.isOpen;
	}

	private renderWelcome(): void {
		this.welcome.replaceChildren();
		const card = append(this.welcome, $('.sx-welcome-card'));
		append(card, $('.sx-welcome-title')).textContent = localize('voltScratch.welcomeTitle', "Scratch");
		append(card, $('.sx-welcome-text')).textContent = localize('voltScratch.welcomeText', "Sketch, write, paste anything. Select a part and send it to an agent.");
		const tips = append(card, $('.sx-welcome-tips'));
		const tip = (keys: string, text: string) => {
			const row = append(tips, $('.sx-welcome-tip'));
			append(row, $('kbd')).textContent = keys;
			append(row, $('span')).textContent = text;
		};
		tip('R  D  O', localize('voltScratch.tipShapes', "Shapes"));
		tip('A', localize('voltScratch.tipArrow', "Arrows that stick to shapes"));
		tip('P', localize('voltScratch.tipPen', "Draw by hand"));
		tip('T', localize('voltScratch.tipText', "Text with markdown shortcuts"));
		// allow-any-unicode-next-line
		tip(isMacintosh ? '⌘↵' : 'Ctrl+Enter', localize('voltScratch.tipAgent', "Send the selection to an agent"));
	}
}

/** A speech bubble with its point at the hot spot, like a comment pin. */
const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 22V12A10 10 0 1 1 12 22Z" fill="#3b82f6" stroke="#fff" stroke-width="1.5"/></svg>')}") 2 22, crosshair`;

const TOOL_KEYS: Record<string, { tool: ScratchTool; shape?: ScratchShapeKind } | 'lock' | 'image' | 'comment'> = {
	v: { tool: 'select' }, '1': { tool: 'select' },
	h: { tool: 'hand' },
	r: { tool: 'shape', shape: 'rectangle' }, '2': { tool: 'shape', shape: 'rectangle' },
	d: { tool: 'shape', shape: 'diamond' }, '3': { tool: 'shape', shape: 'diamond' },
	o: { tool: 'shape', shape: 'ellipse' }, '4': { tool: 'shape', shape: 'ellipse' },
	a: { tool: 'arrow' }, '5': { tool: 'arrow' },
	l: { tool: 'line' }, '6': { tool: 'line' },
	p: { tool: 'draw' }, '7': { tool: 'draw' },
	t: { tool: 'text' }, '8': { tool: 'text' },
	'9': 'image',
	e: { tool: 'eraser' }, '0': { tool: 'eraser' },
	n: { tool: 'note' },
	m: { tool: 'card' },
	f: { tool: 'frame' },
	k: { tool: 'laser' },
	c: 'comment',
	q: 'lock',
};

function lookupIn(scene: ScratchScene): (id: string) => ScratchElement | undefined {
	return id => scene.get(id);
}

interface IScratchRouting {
	/** What `connector` routes around and the lines it keeps off; undefined for anything but an elbow. */
	around(connector: IScratchLinearElement): IScratchRouteContext | undefined;
	/** Where a connector re-routed in this pass now runs, so the next one keeps off it. */
	moved(id: string, patch: Pick<IScratchLinearElement, 'x' | 'y' | 'points'> | undefined): void;
}

/** Elbow routing on the board: read once, when the first elbow asks. */
function routingIn(scene: ScratchScene): IScratchRouting {
	let context: IScratchRouteContext | undefined;
	return {
		around: connector => connector.arrowType === 'elbow' ? (context ??= routeContext(scene.getElements())) : undefined,
		moved: (id, patch) => {
			if (context && patch) {
				context = withLegs(context, id, patch.points.map((p): Vec => [patch.x + p[0], patch.y + p[1]]));
			}
		},
	};
}

function resizeCursor(handle: ResizeHandle, selected: readonly ScratchElement[]): string {
	const angle = selected.length === 1 ? selected[0].angle : 0;
	const base: Record<ResizeHandle, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
	const deg = ((base[handle] + angle * 180 / Math.PI) % 180 + 180) % 180;
	if (deg < 22.5 || deg >= 157.5) {
		return 'ew-resize';
	}
	if (deg < 67.5) {
		return 'nwse-resize';
	}
	if (deg < 112.5) {
		return 'ns-resize';
	}
	return 'nesw-resize';
}

function elementKindLabel(el: ScratchElement): string {
	switch (el.type) {
		case 'text': return localize('voltScratch.kindText', "Text");
		case 'note': return localize('voltScratch.kindNote', "Sticky note");
		case 'card': return localize('voltScratch.kindCard', "Card");
		case 'frame': return localize('voltScratch.kindFrame', "Frame");
		case 'arrow': return localize('voltScratch.kindArrow', "Arrow");
		case 'line': return localize('voltScratch.kindLine', "Line");
		case 'icon': return localize('voltScratch.kindIcon', "Icon");
		default: return localize('voltScratch.kindShape', "Shape");
	}
}

function escapeForHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
	try {
		const bitmap = await createImageBitmap(file);
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return size;
	} catch {
		return { width: 400, height: 300 };
	}
}

/** Elements from our own clipboard JSON, validated like a saved board. */
function parseClipboardElements(raw: unknown[] | undefined): ScratchElement[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(item => parseElement(item)).filter((el): el is ScratchElement => !!el);
}

