/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { createStrokeIcon } from '../chrome/agentModeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { closeMediaDialog, decodeImage, imageExtension, trackMediaDialog } from './agentImageAttachments.js';

export interface IAgentImageViewerImage {
	/** The file name (`image.png`). */
	readonly name: string;
	/** The dialog title (`Attached image 1`). */
	readonly title: string;
	readonly bytes: Uint8Array;
	readonly mime: string;
}

export interface IAgentImageViewerOptions {
	/** Any element in the window the dialog opens in. */
	readonly anchor: HTMLElement;
	readonly images: readonly IAgentImageViewerImage[];
	readonly index: number;
	/** Present when the images can be marked up. Called with the edited image as a PNG. */
	readonly onSave?: (index: number, bytes: Uint8Array, mime: string) => void;
	readonly onDidClose?: () => void;
}

type Tool = 'select' | 'arrow' | 'rect' | 'pen' | 'text' | 'crop';

interface IPoint { readonly x: number; readonly y: number }

type Shape =
	| { readonly kind: 'arrow'; readonly color: string; readonly width: number; readonly from: IPoint; readonly to: IPoint }
	| { readonly kind: 'rect'; readonly color: string; readonly width: number; readonly from: IPoint; readonly to: IPoint }
	| { readonly kind: 'pen'; readonly color: string; readonly width: number; readonly points: readonly IPoint[] }
	| { readonly kind: 'text'; readonly color: string; readonly size: number; readonly weight: number; readonly at: IPoint; readonly text: string };

/** The open text box; its style follows the menus until it becomes a mark. */
interface ITextEditor {
	readonly element: HTMLTextAreaElement;
	readonly at: IPoint;
	readonly replacing?: Shape & { kind: 'text' };
	color: string;
	size: number;
	weight: number;
}

/** One undo step: the pixels underneath and the marks on top (still movable). */
interface IMarkupState {
	readonly base: HTMLCanvasElement;
	readonly shapes: readonly Shape[];
}

interface IRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

const COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#111111'] as const;
/** Line widths as multiples of the image-relative default; `preview` is the CSS px the menu draws. */
const STROKES = [
	{ scale: 0.5, preview: 1.5, label: localize('voltAgent.strokeThin', "Thin") },
	{ scale: 1, preview: 2.5, label: localize('voltAgent.strokeMedium', "Medium") },
	{ scale: 2, preview: 4, label: localize('voltAgent.strokeThick', "Thick") },
	{ scale: 3, preview: 6, label: localize('voltAgent.strokeHeavy', "Extra thick") },
] as const;
/** Word-style text sizes; DEFAULT_TEXT_POINTS is the image-relative default and the rest scale from it. */
const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72] as const;
const DEFAULT_TEXT_POINTS = 16;
const TEXT_WEIGHTS = [
	{ weight: 300, label: localize('voltAgent.textLight', "Light") },
	{ weight: 400, label: localize('voltAgent.textRegular', "Regular") },
	{ weight: 500, label: localize('voltAgent.textMediumWeight', "Medium") },
	{ weight: 600, label: localize('voltAgent.textSemibold', "Semibold") },
	{ weight: 700, label: localize('voltAgent.textBold', "Bold") },
	{ weight: 800, label: localize('voltAgent.textExtraBold', "Extra bold") },
	{ weight: 900, label: localize('voltAgent.textBlack', "Black") },
] as const;
/** Markup tool icons from Aria Icons, drawn with a 1.5 stroke. */
const TOOL_ICONS = {
	select: ['M8.12673 19.9859L3.13506 5.01093C2.74861 3.85158 3.85158 2.74861 5.01093 3.13506L19.9859 8.12673C21.2966 8.5636 21.3504 10.3975 20.0677 10.9106L14.117 13.2909C13.7402 13.4416 13.4416 13.7402 13.2909 14.117L10.9106 20.0677C10.3975 21.3504 8.5636 21.2966 8.12673 19.9859Z'],
	arrow: ['M13 5h6v6', 'M19 5 5 19'],
	rect: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
	pen: ['M13 21h8', 'm15 5 4 4', 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'],
	text: ['M12 4v16', 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2', 'M9 20h6'],
	crop: ['M6 2v14a2 2 0 0 0 2 2h14', 'M18 22V8a2 2 0 0 0-2-2H2'],
	rotate: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
	textSize: ['m15 16 2.536-7.328a1.02 1.02 0 0 1 1.928 0L22 16', 'M15.697 14h5.606', 'm2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16', 'M3.304 13h6.392'],
	textWeight: ['M5 6c0-1.414 0-2.121.44-2.56C5.878 3 6.585 3 8 3h4.579C15.02 3 17 5.015 17 7.5S15.02 12 12.579 12H5z', 'M12.429 12h1.238C16.06 12 18 14.015 18 16.5S16.06 21 13.667 21H8c-1.414 0-2.121 0-2.56-.44C5 20.122 5 19.415 5 18v-6'],
	undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11'],
	redo: ['m15 14 5-5-5-5', 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13'],
	chevron: ['m6 9 6 6 6-6'],
} as const satisfies Record<string, readonly string[]>;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

/** Opens the image dialog; one image or video dialog at a time per app. */
export function showAgentImageViewer(createViewer: (options: IAgentImageViewerOptions) => AgentImageViewer, options: IAgentImageViewerOptions): IDisposable {
	closeMediaDialog();
	const viewer = createViewer(options);
	trackMediaDialog(viewer);
	return viewer;
}

/**
 * A large view of a prompt's image with zoom, copy and download. Composer images can also be
 * marked up (arrows, boxes, pen, text) and cropped or rotated; Done replaces the attachment.
 */
export class AgentImageViewer extends Disposable {

	private readonly overlay: HTMLElement;
	private readonly dialog: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly surface: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly zoomLabel: HTMLElement;
	private readonly cropBar: HTMLElement;
	private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
	private readonly imageStore = this._register(new DisposableStore());
	private undoButton: HTMLButtonElement | undefined;
	private redoButton: HTMLButtonElement | undefined;
	private colorButton: HTMLButtonElement | undefined;
	private palette: HTMLElement | undefined;
	private strokeButton: HTMLButtonElement | undefined;
	private strokeMenu: HTMLElement | undefined;
	/** Crop and rotate; text swaps them for the size and weight menus. */
	private imageToolSet: HTMLElement | undefined;
	private textToolSet: HTMLElement | undefined;
	private textSizeMenu: HTMLElement | undefined;
	private textWeightMenu: HTMLElement | undefined;
	private textSizeLabel: HTMLElement | undefined;
	private textWeightLabel: HTMLElement | undefined;
	/** The color, stroke and text style menus. */
	private readonly popups: HTMLElement[] = [];
	private prevButton: HTMLButtonElement | undefined;
	private nextButton: HTMLButtonElement | undefined;

	private index: number;
	private images: IAgentImageViewerImage[];
	private state: IMarkupState | undefined;
	private readonly undoStack: IMarkupState[] = [];
	private readonly redoStack: IMarkupState[] = [];
	private tool: Tool = 'select';
	private color: string = COLORS[0];
	private strokeScale: number = 1;
	private textPoints: number = DEFAULT_TEXT_POINTS;
	private textWeight: number = 600;
	/** CSS px per image px; `fit` follows the stage size. */
	private zoom: number | 'fit' = 'fit';
	private scale = 1;
	private selected: Shape | undefined;
	private draft: Shape | undefined;
	private crop: IRect | undefined;
	private drag: { readonly start: IPoint; readonly origin?: Shape; moved: boolean } | undefined;
	private textEditor: ITextEditor | undefined;
	private loadGeneration = 0;
	private closed = false;
	private closeListeners: (() => void)[] = [];

	constructor(
		private readonly options: IAgentImageViewerOptions,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.images = options.images.slice();
		this.index = Math.max(0, Math.min(options.index, this.images.length - 1));
		const win = getWindow(options.anchor);
		const editable = !!options.onSave;

		this.overlay = append(win.document.body, $('.volt-agent-image-viewer-overlay'));
		this.overlay.tabIndex = -1;
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.dialog = append(this.overlay, $('.volt-agent-image-viewer'));
		this.dialog.classList.toggle('editable', editable);

		const head = append(this.dialog, $('.volt-agent-image-viewer-head'));
		const titleRow = append(head, $('.volt-agent-image-viewer-title-row'));
		if (this.images.length > 1) {
			this.prevButton = this.iconButton(titleRow, Codicon.chevronLeft, localize('voltAgent.imagePrev', "Previous image"), () => this.go(-1));
			this.nextButton = this.iconButton(titleRow, Codicon.chevronRight, localize('voltAgent.imageNext', "Next image"), () => this.go(1));
		}
		this.titleEl = append(titleRow, $('span.volt-agent-image-viewer-title'));

		if (editable) {
			this.renderTools(append(head, $('.volt-agent-image-viewer-tools')));
		}

		const actions = append(head, $('.volt-agent-image-viewer-actions'));
		this.iconButton(actions, Codicon.zoomOut, localize('voltAgent.imageZoomOut', "Zoom out"), () => this.zoomBy(1 / 1.25), formatShortcut('-'));
		this.zoomLabel = append(actions, $('button.volt-agent-image-viewer-zoom'));
		(this.zoomLabel as HTMLButtonElement).type = 'button';
		setAgentTooltip(this.zoomLabel, localize('voltAgent.imageFit', "Fit to window"), formatShortcut('0'));
		this._register(addDisposableListener(this.zoomLabel, EventType.CLICK, () => this.setZoom('fit')));
		this.iconButton(actions, Codicon.zoomIn, localize('voltAgent.imageZoomIn', "Zoom in"), () => this.zoomBy(1.25), formatShortcut('='));
		this.iconButton(actions, Codicon.copy, localize('voltAgent.imageCopy', "Copy image"), () => void this.copy());
		this.iconButton(actions, Codicon.desktopDownload, localize('voltAgent.imageDownload', "Save image as…"), () => void this.download());
		if (editable) {
			const done = append(actions, $('button.volt-agent-image-viewer-done')) as HTMLButtonElement;
			done.type = 'button';
			done.textContent = localize('voltAgent.imageDone', "Done");
			this._register(addDisposableListener(done, EventType.CLICK, () => this.close()));
		} else {
			this.iconButton(actions, Codicon.close, localize('voltAgent.imageClose', "Close"), () => this.close(), 'Esc');
		}

		this.stage = append(this.dialog, $('.volt-agent-image-viewer-stage'));
		this.surface = append(this.stage, $('.volt-agent-image-viewer-surface'));
		this.canvas = append(this.surface, $('canvas.volt-agent-image-viewer-canvas')) as HTMLCanvasElement;
		this.cropBar = append(this.dialog, $('.volt-agent-image-viewer-cropbar.hidden'));
		this.renderCropBar();

		this.registerListeners(win);
		this.overlay.focus();
		void this.load();
	}

	onClose(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	//#region Chrome

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void, shortcut?: string): HTMLButtonElement {
		const button = append(parent, $('button.volt-agent-image-viewer-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		setAgentTooltip(button, label, shortcut);
		this._register(addDisposableListener(button, EventType.CLICK, e => {
			e.preventDefault();
			run();
		}));
		return button;
	}

	private renderTools(parent: HTMLElement): void {
		// One pill of round buttons; thin rules split it into sets.
		const pill = append(parent, $('.volt-agent-image-tool-group'));
		let group = pill;
		const newGroup = (rule = true) => {
			if (rule && pill.childElementCount) {
				append(pill, $('span.volt-agent-image-tool-sep'));
			}
			group = append(pill, $('.volt-agent-image-tool-set'));
			return group;
		};
		const button = (label: string, icon: HTMLElement, key?: string) => {
			const button = append(group, $('button.volt-agent-image-tool')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			button.appendChild(icon);
			setAgentTooltip(button, label, key);
			return button;
		};
		const tool = (id: Tool, icon: HTMLElement, label: string, key: string) => {
			const toolButton = button(label, icon, key);
			this.toolButtons.set(id, toolButton);
			this._register(addDisposableListener(toolButton, EventType.CLICK, () => this.setTool(id)));
		};
		const action = (icon: HTMLElement, label: string, run: () => void, key?: string) => {
			const actionButton = button(label, icon, key);
			this._register(addDisposableListener(actionButton, EventType.CLICK, () => run()));
			return actionButton;
		};
		// Pressing a menu button doesn't take focus, so an open text box stays open and takes the style.
		const keepFocus = (element: HTMLElement) => this._register(addDisposableListener(element, EventType.MOUSE_DOWN, e => e.preventDefault()));
		const dropdown = (label: string, popupClass: string) => {
			const wrap = append(group, $('.volt-agent-image-dropdown'));
			const button = append(wrap, $('button.volt-agent-image-tool')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			button.setAttribute('aria-haspopup', 'true');
			setAgentTooltip(button, label);
			keepFocus(button);
			const popup = append(wrap, $(`.volt-agent-image-popup.${popupClass}.hidden`));
			this.popups.push(popup);
			this._register(addDisposableListener(button, EventType.CLICK, e => {
				e.stopPropagation();
				this.closePopups(wrap);
				popup.classList.toggle('hidden');
				// A long menu opens scrolled to its current choice.
				const active = popup.querySelector<HTMLElement>('.active');
				if (active && popup.scrollHeight > popup.clientHeight) {
					popup.scrollTop = active.offsetTop - (popup.clientHeight - active.offsetHeight) / 2;
				}
			}));
			return { wrap, button, popup };
		};
		const option = (container: HTMLElement, className: string, label: string, run: () => void) => {
			const button = append(container, $(`button.${className}`)) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			keepFocus(button);
			this._register(addDisposableListener(button, EventType.CLICK, e => {
				e.stopPropagation();
				run();
				this.closePopups();
			}));
			return button;
		};

		newGroup();
		tool('select', createStrokeIcon('image-tool-select', TOOL_ICONS.select), localize('voltAgent.toolSelect', "Select and move"), 'V');

		newGroup();
		tool('arrow', createStrokeIcon('image-tool-arrow', TOOL_ICONS.arrow), localize('voltAgent.toolArrow', "Arrow"), 'A');
		tool('rect', createStrokeIcon('image-tool-rect', TOOL_ICONS.rect), localize('voltAgent.toolRect', "Rectangle"), 'R');
		tool('pen', createStrokeIcon('image-tool-pen', TOOL_ICONS.pen), localize('voltAgent.toolPen', "Draw"), 'P');
		tool('text', createStrokeIcon('image-tool-text', TOOL_ICONS.text), localize('voltAgent.toolText', "Text"), 'T');

		// Same slot, two sets: crop and rotate for the image, size and weight for text.
		this.imageToolSet = newGroup();
		tool('crop', createStrokeIcon('image-tool-crop', TOOL_ICONS.crop), localize('voltAgent.toolCrop', "Crop"), 'C');
		action(createStrokeIcon('image-tool-rotate', TOOL_ICONS.rotate), localize('voltAgent.toolRotate', "Rotate"), () => this.rotate(), 'Shift+R');

		// Shares the rule before the image set: only one of the two shows.
		this.textToolSet = newGroup(false);
		this.textToolSet.classList.add('hidden');
		const labeled = (menu: { button: HTMLButtonElement }, icon: readonly string[], iconClass: string) => {
			menu.button.classList.add('labeled');
			menu.button.appendChild(createStrokeIcon(iconClass, icon));
			const label = append(menu.button, $('span.volt-agent-image-tool-label'));
			menu.button.appendChild(createStrokeIcon('image-tool-chevron', TOOL_ICONS.chevron));
			return label;
		};
		const sizeMenu = dropdown(localize('voltAgent.toolTextSize', "Text size"), 'volt-agent-image-text-sizes');
		this.textSizeMenu = sizeMenu.popup;
		this.textSizeLabel = labeled(sizeMenu, TOOL_ICONS.textSize, 'image-tool-text-size');
		this.textSizeLabel.classList.add('size');
		for (const points of TEXT_SIZES) {
			const row = option(this.textSizeMenu, 'volt-agent-image-menu-item.volt-agent-image-text-size', String(points), () => this.setTextStyle({ points }));
			row.dataset.points = String(points);
			row.textContent = String(points);
		}
		const weightMenu = dropdown(localize('voltAgent.toolTextWeight', "Font weight"), 'volt-agent-image-text-weights');
		this.textWeightMenu = weightMenu.popup;
		this.textWeightLabel = labeled(weightMenu, TOOL_ICONS.textWeight, 'image-tool-text-weight');
		this.textWeightLabel.classList.add('weight');
		for (const weight of TEXT_WEIGHTS) {
			const row = option(this.textWeightMenu, 'volt-agent-image-menu-item.volt-agent-image-text-weight', weight.label, () => this.setTextStyle({ weight: weight.weight }));
			row.dataset.weight = String(weight.weight);
			append(row, $('span.volt-agent-image-text-weight-name')).textContent = weight.label;
			append(row, $('span.volt-agent-image-text-weight-value')).textContent = String(weight.weight);
			row.style.fontWeight = String(weight.weight);
		}

		newGroup();
		const colorMenu = dropdown(localize('voltAgent.toolColor', "Color"), 'volt-agent-image-palette');
		this.colorButton = colorMenu.button;
		this.palette = colorMenu.popup;
		append(this.colorButton, $('span.volt-agent-image-color-dot'));
		for (const color of COLORS) {
			const swatch = option(this.palette, 'volt-agent-image-swatch', color, () => this.setColor(color));
			swatch.style.setProperty('--swatch', color);
			swatch.dataset.color = color;
		}

		// Lines take a stroke width; text has no stroke, so the button hides while text is active.
		const strokeMenu = dropdown(localize('voltAgent.toolStroke', "Stroke width"), 'volt-agent-image-strokes');
		this.strokeButton = strokeMenu.button;
		this.strokeMenu = strokeMenu.popup;
		append(this.strokeButton, $('span.volt-agent-image-stroke-line'));
		for (const stroke of STROKES) {
			const row = option(this.strokeMenu, 'volt-agent-image-menu-item.volt-agent-image-stroke', stroke.label, () => this.setStroke(stroke.scale));
			row.style.setProperty('--stroke', `${stroke.preview}px`);
			row.dataset.scale = String(stroke.scale);
			append(row, $('span.volt-agent-image-stroke-line'));
			setAgentTooltip(row, stroke.label);
		}

		// Undo and redo stand on their own, outside any pill.
		group = append(parent, $('.volt-agent-image-tool-history'));
		this.undoButton = action(createStrokeIcon('image-tool-undo', TOOL_ICONS.undo), localize('voltAgent.toolUndo', "Undo"), () => this.undo(), formatShortcut('Z'));
		this.redoButton = action(createStrokeIcon('image-tool-redo', TOOL_ICONS.redo), localize('voltAgent.toolRedo', "Redo"), () => this.redo(), formatShortcut('Shift+Z'));
		this.setColor(this.color);
		this.setStroke(this.strokeScale);
		this.syncTextStyleMenu();
	}

	/** Text gets the size and weight menu where lines get the stroke menu. */
	private get textMode(): boolean {
		return this.tool === 'text' || this.selected?.kind === 'text' || !!this.textEditor;
	}

	/** Hides the open tool menus, except the one inside `keep`; true when one was open. */
	private closePopups(keep?: Node): boolean {
		let closed = false;
		for (const popup of this.popups) {
			if (!popup.classList.contains('hidden') && !(keep && popup.parentElement?.contains(keep))) {
				popup.classList.add('hidden');
				closed = true;
			}
		}
		return closed;
	}

	private renderCropBar(): void {
		append(this.cropBar, $('span.volt-agent-image-cropbar-hint')).textContent = localize('voltAgent.cropHint', "Drag to choose the area to keep");
		const cancel = append(this.cropBar, $('button.volt-agent-image-cropbar-btn')) as HTMLButtonElement;
		cancel.type = 'button';
		cancel.textContent = localize('voltAgent.cropCancel', "Cancel");
		const apply = append(this.cropBar, $('button.volt-agent-image-cropbar-btn.primary')) as HTMLButtonElement;
		apply.type = 'button';
		apply.textContent = localize('voltAgent.cropApply', "Crop");
		this._register(addDisposableListener(cancel, EventType.CLICK, () => this.setTool('select')));
		this._register(addDisposableListener(apply, EventType.CLICK, () => this.applyCrop()));
	}

	private syncChrome(): void {
		const image = this.images[this.index];
		this.titleEl.textContent = image?.title ?? '';
		setAgentTooltip(this.titleEl, image?.name);
		this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
		if (this.prevButton && this.nextButton) {
			this.prevButton.disabled = this.index === 0;
			this.nextButton.disabled = this.index >= this.images.length - 1;
		}
		if (this.undoButton && this.redoButton) {
			this.undoButton.disabled = !this.undoStack.length;
			this.redoButton.disabled = !this.redoStack.length;
		}
		for (const [id, button] of this.toolButtons) {
			button.classList.toggle('active', id === this.tool);
			button.setAttribute('aria-pressed', String(id === this.tool));
		}
		const textMode = this.textMode;
		this.strokeButton?.parentElement?.classList.toggle('hidden', textMode);
		this.imageToolSet?.classList.toggle('hidden', textMode);
		this.textToolSet?.classList.toggle('hidden', !textMode);
		this.syncTextStyleMenu();
		this.cropBar.classList.toggle('hidden', this.tool !== 'crop');
		this.cropBar.querySelector<HTMLButtonElement>('.primary')!.disabled = !this.crop;
		this.surface.dataset.tool = this.options.onSave ? this.tool : 'view';
	}

	private setTool(tool: Tool): void {
		this.commitText();
		this.closePopups();
		if (this.tool === 'crop' && tool !== 'crop') {
			this.crop = undefined;
		}
		this.tool = tool;
		if (tool !== 'select') {
			this.selected = undefined;
		}
		this.syncChrome();
		this.render();
	}

	private setColor(color: string): void {
		this.color = color;
		this.colorButton?.style.setProperty('--swatch', color);
		this.palette?.querySelectorAll<HTMLElement>('.volt-agent-image-swatch').forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color === color));
		if (this.textEditor) {
			this.textEditor.color = color;
			this.textEditor.element.style.color = color;
		}
		// Recolor the selected mark, as a markup editor does.
		if (this.selected && this.state && this.selected.color !== color) {
			const recolored: Shape = { ...this.selected, color };
			this.replaceShape(this.selected, recolored);
			this.selected = recolored;
		}
	}

	private setStroke(scale: number): void {
		this.strokeScale = scale;
		const preview = STROKES.find(stroke => stroke.scale === scale)?.preview ?? STROKES[1].preview;
		this.strokeButton?.style.setProperty('--stroke', `${preview}px`);
		this.strokeMenu?.querySelectorAll<HTMLElement>('.volt-agent-image-stroke').forEach(row => {
			const active = Number(row.dataset.scale) === scale;
			row.classList.toggle('active', active);
			row.setAttribute('aria-pressed', String(active));
		});
		// Restyle the selected line, as with color; text has its own menu.
		const width = this.strokeWidth();
		if (this.selected && this.selected.kind !== 'text' && this.state && this.selected.width !== width) {
			const restyled: Shape = { ...this.selected, width };
			this.replaceShape(this.selected, restyled);
			this.selected = restyled;
		}
	}

	/** Sets the size or weight for new text and for the text being edited or selected; the other setting is left alone. */
	private setTextStyle(style: { readonly points?: number; readonly weight?: number }): void {
		this.textPoints = style.points ?? this.textPoints;
		this.textWeight = style.weight ?? this.textWeight;
		const size = style.points !== undefined ? this.textSize() : undefined;
		if (this.textEditor) {
			this.textEditor.size = size ?? this.textEditor.size;
			this.textEditor.weight = style.weight ?? this.textEditor.weight;
			this.positionTextEditor();
		}
		const selected = this.selected;
		if (selected?.kind === 'text' && this.state) {
			const restyled: Shape = { ...selected, size: size ?? selected.size, weight: style.weight ?? selected.weight };
			if (restyled.size !== selected.size || restyled.weight !== selected.weight) {
				this.replaceShape(selected, restyled);
				this.selected = restyled;
			}
		}
		this.syncTextStyleMenu();
	}

	/** Marks the size and weight of the text being edited or selected, or of new text. */
	private syncTextStyleMenu(): void {
		const target = this.textEditor ?? (this.selected?.kind === 'text' ? this.selected : undefined);
		const points = target
			? TEXT_SIZES.find(size => this.textSize(size) === target.size) ?? Math.round(target.size / this.textSize(DEFAULT_TEXT_POINTS) * DEFAULT_TEXT_POINTS)
			: this.textPoints;
		const weight = target?.weight ?? this.textWeight;
		if (this.textSizeLabel && this.textWeightLabel) {
			this.textSizeLabel.textContent = String(points);
			this.textWeightLabel.textContent = TEXT_WEIGHTS.find(item => item.weight === weight)?.label ?? String(weight);
			this.textWeightLabel.style.fontWeight = String(weight);
		}
		const items = [
			...this.textSizeMenu?.querySelectorAll<HTMLElement>('.volt-agent-image-text-size') ?? [],
			...this.textWeightMenu?.querySelectorAll<HTMLElement>('.volt-agent-image-text-weight') ?? [],
		];
		items.forEach(item => {
			const active = item.dataset.points !== undefined ? Number(item.dataset.points) === points : Number(item.dataset.weight) === weight;
			item.classList.toggle('active', active);
			item.setAttribute('aria-pressed', String(active));
		});
	}

	//#endregion

	//#region Loading and saving

	private async load(): Promise<void> {
		const generation = ++this.loadGeneration;
		const image = this.images[this.index];
		this.imageStore.clear();
		this.state = undefined;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.selected = undefined;
		this.crop = undefined;
		this.zoom = 'fit';
		this.syncChrome();
		if (!image) {
			return;
		}
		try {
			const bitmap = await decodeImage(image.bytes, image.mime);
			if (generation !== this.loadGeneration || this.closed) {
				bitmap.close();
				return;
			}
			const base = this.canvas.ownerDocument.createElement('canvas');
			base.width = bitmap.width;
			base.height = bitmap.height;
			base.getContext('2d')?.drawImage(bitmap, 0, 0);
			bitmap.close();
			this.state = { base, shapes: [] };
			this.layout();
		} catch {
			clearNode(this.surface);
			append(this.surface, $('.volt-agent-image-viewer-error')).textContent = localize('voltAgent.imageUnreadable', "This image can't be shown.");
		}
	}

	private get dirty(): boolean {
		return this.undoStack.length > 0;
	}

	/** The marked-up image as PNG bytes. */
	private async exportPng(): Promise<Uint8Array | undefined> {
		if (!this.state) {
			return undefined;
		}
		const out = this.canvas.ownerDocument.createElement('canvas');
		out.width = this.state.base.width;
		out.height = this.state.base.height;
		const ctx = out.getContext('2d');
		if (!ctx) {
			return undefined;
		}
		this.paint(ctx, this.state, false);
		const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
		return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
	}

	/** The bytes to copy or download: the original unless it was marked up. */
	private async currentBytes(): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
		const image = this.images[this.index];
		if (!image) {
			return undefined;
		}
		if (!this.dirty) {
			return { bytes: image.bytes, mime: image.mime };
		}
		const bytes = await this.exportPng();
		return bytes ? { bytes, mime: 'image/png' } : undefined;
	}

	/** Hands edits to the composer before moving off an image. */
	private async saveCurrent(): Promise<void> {
		this.commitText();
		if (!this.dirty || !this.options.onSave) {
			return;
		}
		const index = this.index;
		const bytes = await this.exportPng();
		if (!bytes) {
			return;
		}
		this.images[index] = { ...this.images[index], bytes, mime: 'image/png' };
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.options.onSave(index, bytes, 'image/png');
	}

	private async copy(): Promise<void> {
		const current = await this.currentBytes();
		if (!current) {
			return;
		}
		try {
			// The clipboard takes PNG only.
			const png = current.mime === 'image/png' ? current.bytes : await this.exportPng();
			if (!png) {
				return;
			}
			const blob = new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' });
			await getWindow(this.overlay).navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
		} catch (err) {
			this.notificationService.warn(localize('voltAgent.imageCopyFailed', "Couldn't copy the image: {0}", String(err)));
		}
	}

	private async download(): Promise<void> {
		const image = this.images[this.index];
		const current = await this.currentBytes();
		if (!image || !current) {
			return;
		}
		const stem = image.name.replace(/\.[^.]+$/, '') || 'image';
		const fileName = `${stem}.${imageExtension(current.mime)}`;
		const defaultUri = joinPath(await this.fileDialogService.defaultFilePath(), fileName);
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltAgent.imageSaveTitle', "Save Image"),
			defaultUri,
			filters: [{ name: localize('voltAgent.imageFilter', "Images"), extensions: [imageExtension(current.mime)] }],
		});
		if (!target) {
			return;
		}
		try {
			await this.fileService.writeFile(target, VSBuffer.wrap(current.bytes));
		} catch (err) {
			this.notificationService.error(localize('voltAgent.imageSaveFailed', "Couldn't save the image: {0}", String(err)));
		}
	}

	private async go(delta: number): Promise<void> {
		const next = this.index + delta;
		if (next < 0 || next >= this.images.length) {
			return;
		}
		await this.saveCurrent();
		this.index = next;
		await this.load();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		void this.saveCurrent().finally(() => this.dispose());
	}

	override dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.overlay.remove();
		super.dispose();
		for (const listener of this.closeListeners) {
			listener();
		}
		this.options.onDidClose?.();
	}

	//#endregion

	//#region Layout and paint

	private layout(): void {
		if (!this.state) {
			return;
		}
		const { width, height } = this.state.base;
		if (this.zoom === 'fit') {
			const availableWidth = Math.max(this.stage.clientWidth - 48, 40);
			const availableHeight = Math.max(this.stage.clientHeight - 48, 40);
			this.scale = Math.min(availableWidth / width, availableHeight / height, 1);
		} else {
			this.scale = this.zoom;
		}
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		this.surface.style.width = `${Math.round(width * this.scale)}px`;
		this.surface.style.height = `${Math.round(height * this.scale)}px`;
		this.positionTextEditor();
		this.syncChrome();
		this.render();
	}

	private setZoom(zoom: number | 'fit'): void {
		this.zoom = zoom === 'fit' ? 'fit' : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
		this.layout();
	}

	private zoomBy(factor: number): void {
		this.setZoom(this.scale * factor);
	}

	private render(): void {
		const ctx = this.canvas.getContext('2d');
		if (!ctx || !this.state) {
			return;
		}
		this.paint(ctx, this.state, true);
	}

	/** Draws the image and marks; `chrome` adds the selection outline, the draft and the crop shade. */
	private paint(ctx: CanvasRenderingContext2D, state: IMarkupState, chrome: boolean): void {
		const { width, height } = state.base;
		ctx.clearRect(0, 0, width, height);
		ctx.drawImage(state.base, 0, 0);
		for (const shape of state.shapes) {
			drawShape(ctx, shape);
		}
		if (!chrome) {
			return;
		}
		if (this.draft) {
			drawShape(ctx, this.draft);
		}
		const px = 1 / this.scale;
		if (this.selected) {
			const box = inflate(shapeBounds(ctx, this.selected), 6 * px);
			ctx.save();
			ctx.setLineDash([5 * px, 4 * px]);
			ctx.lineWidth = 1.5 * px;
			ctx.strokeStyle = '#ffffff';
			ctx.strokeRect(box.x, box.y, box.w, box.h);
			ctx.lineDashOffset = 4.5 * px;
			ctx.strokeStyle = '#0a84ff';
			ctx.strokeRect(box.x, box.y, box.w, box.h);
			ctx.restore();
		}
		if (this.tool === 'crop' && this.crop) {
			const c = this.crop;
			ctx.save();
			ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
			ctx.beginPath();
			ctx.rect(0, 0, width, height);
			ctx.rect(c.x, c.y, c.w, c.h);
			ctx.fill('evenodd');
			ctx.lineWidth = 1.5 * px;
			ctx.strokeStyle = '#ffffff';
			ctx.strokeRect(c.x, c.y, c.w, c.h);
			// Rule-of-thirds guides.
			ctx.globalAlpha = 0.4;
			ctx.beginPath();
			for (const t of [1 / 3, 2 / 3]) {
				ctx.moveTo(c.x + c.w * t, c.y);
				ctx.lineTo(c.x + c.w * t, c.y + c.h);
				ctx.moveTo(c.x, c.y + c.h * t);
				ctx.lineTo(c.x + c.w, c.y + c.h * t);
			}
			ctx.stroke();
			ctx.restore();
		}
	}

	//#endregion

	//#region Editing

	private strokeWidth(): number {
		const base = this.state?.base;
		const medium = base ? Math.max(3, Math.round(Math.max(base.width, base.height) / 260)) : 4;
		return Math.max(1, Math.round(medium * this.strokeScale));
	}

	/** Image px for a menu size; the default size grows with the image so text reads at any resolution. */
	private textSize(points = this.textPoints): number {
		const base = this.state?.base;
		const medium = base ? Math.max(16, Math.round(Math.max(base.width, base.height) / 42)) : 20;
		return Math.max(4, Math.round(medium * points / DEFAULT_TEXT_POINTS));
	}

	private commit(next: IMarkupState): void {
		if (!this.state) {
			return;
		}
		this.undoStack.push(this.state);
		this.redoStack.length = 0;
		this.state = next;
		this.syncChrome();
		this.render();
	}

	private replaceShape(previous: Shape, next: Shape | undefined): void {
		if (!this.state) {
			return;
		}
		const shapes = next
			? this.state.shapes.map(shape => shape === previous ? next : shape)
			: this.state.shapes.filter(shape => shape !== previous);
		this.commit({ base: this.state.base, shapes });
	}

	private undo(): void {
		this.commitText();
		const previous = this.undoStack.pop();
		if (!previous || !this.state) {
			return;
		}
		this.redoStack.push(this.state);
		this.state = previous;
		this.selected = undefined;
		this.layout();
	}

	private redo(): void {
		const next = this.redoStack.pop();
		if (!next || !this.state) {
			return;
		}
		this.undoStack.push(this.state);
		this.state = next;
		this.selected = undefined;
		this.layout();
	}

	private deleteSelected(): void {
		if (this.selected) {
			const selected = this.selected;
			this.selected = undefined;
			this.replaceShape(selected, undefined);
		}
	}

	/** Quarter turn clockwise; marks turn with the image and stay editable. */
	private rotate(): void {
		this.commitText();
		if (!this.state) {
			return;
		}
		const { base, shapes } = this.state;
		const rotated = base.ownerDocument.createElement('canvas');
		rotated.width = base.height;
		rotated.height = base.width;
		const ctx = rotated.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.translate(base.height, 0);
		ctx.rotate(Math.PI / 2);
		ctx.drawImage(base, 0, 0);
		const turn = (p: IPoint): IPoint => ({ x: base.height - p.y, y: p.x });
		this.selected = undefined;
		this.crop = undefined;
		this.commit({ base: rotated, shapes: shapes.map(shape => mapShape(shape, turn)) });
		this.layout();
	}

	private applyCrop(): void {
		const c = this.crop && clampRect(this.crop, this.state?.base);
		if (!c || !this.state || c.w < 2 || c.h < 2) {
			return;
		}
		const { base, shapes } = this.state;
		const cropped = base.ownerDocument.createElement('canvas');
		cropped.width = Math.round(c.w);
		cropped.height = Math.round(c.h);
		cropped.getContext('2d')?.drawImage(base, Math.round(c.x), Math.round(c.y), cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
		const shift = (p: IPoint): IPoint => ({ x: p.x - Math.round(c.x), y: p.y - Math.round(c.y) });
		this.crop = undefined;
		this.tool = 'select';
		this.commit({ base: cropped, shapes: shapes.map(shape => mapShape(shape, shift)) });
		this.zoom = 'fit';
		this.layout();
	}

	private toImage(e: PointerEvent | MouseEvent): IPoint {
		const rect = this.canvas.getBoundingClientRect();
		const width = this.state?.base.width ?? 1;
		const height = this.state?.base.height ?? 1;
		return {
			x: (e.clientX - rect.left) * (width / Math.max(rect.width, 1)),
			y: (e.clientY - rect.top) * (height / Math.max(rect.height, 1)),
		};
	}

	private hitTest(p: IPoint): Shape | undefined {
		const ctx = this.canvas.getContext('2d');
		if (!this.state || !ctx) {
			return undefined;
		}
		const tolerance = 8 / this.scale;
		for (let i = this.state.shapes.length - 1; i >= 0; i--) {
			const shape = this.state.shapes[i];
			if (shapeContains(ctx, shape, p, tolerance)) {
				return shape;
			}
		}
		return undefined;
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !this.state || !this.options.onSave) {
			return;
		}
		this.closePopups();
		if (this.textEditor) {
			this.commitText();
			if (this.tool === 'text') {
				return;
			}
		}
		const p = this.toImage(e);
		e.preventDefault();
		switch (this.tool) {
			case 'select': {
				const hit = this.hitTest(p);
				this.selected = hit;
				this.drag = hit ? { start: p, origin: hit, moved: false } : undefined;
				this.syncChrome();
				this.render();
				break;
			}
			case 'arrow':
			case 'rect':
				this.draft = { kind: this.tool, color: this.color, width: this.strokeWidth(), from: p, to: p };
				this.drag = { start: p, moved: false };
				break;
			case 'pen':
				this.draft = { kind: 'pen', color: this.color, width: this.strokeWidth(), points: [p] };
				this.drag = { start: p, moved: false };
				break;
			case 'text': {
				const hit = this.hitTest(p);
				this.openTextEditor(hit?.kind === 'text' ? hit.at : p, hit?.kind === 'text' ? hit : undefined);
				return;
			}
			case 'crop':
				this.crop = { x: p.x, y: p.y, w: 0, h: 0 };
				this.drag = { start: p, moved: false };
				break;
		}
		this.canvas.setPointerCapture(e.pointerId);
	}

	private onPointerMove(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || !this.state) {
			this.updateHoverCursor(e);
			return;
		}
		const p = this.toImage(e);
		const dx = p.x - drag.start.x;
		const dy = p.y - drag.start.y;
		drag.moved ||= Math.hypot(dx, dy) * this.scale > 2;
		if (!drag.moved) {
			return;
		}
		switch (this.tool) {
			case 'select':
				if (drag.origin && this.selected) {
					const moved = mapShape(drag.origin, q => ({ x: q.x + dx, y: q.y + dy }));
					this.state = { base: this.state.base, shapes: this.state.shapes.map(shape => shape === this.selected ? moved : shape) };
					this.selected = moved;
				}
				break;
			case 'arrow':
			case 'rect':
				if (this.draft && (this.draft.kind === 'arrow' || this.draft.kind === 'rect')) {
					this.draft = { ...this.draft, to: e.shiftKey ? constrain(this.draft.kind, this.draft.from, p) : p };
				}
				break;
			case 'pen':
				if (this.draft?.kind === 'pen') {
					this.draft = { ...this.draft, points: [...this.draft.points, p] };
				}
				break;
			case 'crop':
				this.crop = clampRect(normalizeRect(drag.start, p), this.state.base);
				this.syncChrome();
				break;
		}
		this.render();
	}

	private onPointerUp(e: PointerEvent): void {
		const drag = this.drag;
		this.drag = undefined;
		if (this.canvas.hasPointerCapture(e.pointerId)) {
			this.canvas.releasePointerCapture(e.pointerId);
		}
		if (!drag || !this.state) {
			return;
		}
		if (this.tool === 'select' && drag.origin && drag.moved && this.selected) {
			// Moving rewrote the live state; record the move as one step from the original.
			const moved = this.selected;
			const before = { base: this.state.base, shapes: this.state.shapes.map(shape => shape === moved ? drag.origin! : shape) };
			this.undoStack.push(before);
			this.redoStack.length = 0;
			this.syncChrome();
			return;
		}
		const draft = this.draft;
		this.draft = undefined;
		if (draft && drag.moved) {
			this.commit({ base: this.state.base, shapes: [...this.state.shapes, draft] });
			return;
		}
		if (this.tool === 'crop' && !drag.moved) {
			this.crop = undefined;
			this.syncChrome();
		}
		this.render();
	}

	private updateHoverCursor(e: PointerEvent): void {
		if (this.tool !== 'select' || !this.options.onSave) {
			return;
		}
		this.surface.classList.toggle('over-shape', !!this.hitTest(this.toImage(e)));
	}

	private openTextEditor(at: IPoint, replacing?: Shape & { kind: 'text' }): void {
		this.commitText();
		const element = append(this.surface, $('textarea.volt-agent-image-text-input')) as HTMLTextAreaElement;
		element.rows = 1;
		element.spellcheck = false;
		element.value = replacing?.text ?? '';
		const color = replacing?.color ?? this.color;
		element.style.color = color;
		this.textEditor = { element, at, replacing, color, size: replacing?.size ?? this.textSize(), weight: replacing?.weight ?? this.textWeight };
		if (replacing && this.state) {
			// Hide the mark while it's being edited.
			this.state = { base: this.state.base, shapes: this.state.shapes.filter(shape => shape !== replacing) };
			this.render();
		}
		this.syncChrome();
		this.positionTextEditor();
		this.imageStore.add(addDisposableListener(element, EventType.INPUT, () => this.autosizeTextEditor()));
		this.imageStore.add(addDisposableListener(element, EventType.KEY_DOWN, e => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				e.preventDefault();
				// The style menus leave focus here, so Escape closes an open menu before the text.
				if (!this.closePopups()) {
					this.commitText(true);
					this.overlay.focus();
				}
			} else if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.commitText();
				this.overlay.focus();
			}
		}));
		this.imageStore.add(addDisposableListener(element, EventType.BLUR, () => this.commitText()));
		setTimeout(() => element.focus(), 0);
	}

	private positionTextEditor(): void {
		const editor = this.textEditor;
		if (!editor) {
			return;
		}
		const size = editor.size * this.scale;
		editor.element.style.left = `${editor.at.x * this.scale}px`;
		editor.element.style.top = `${editor.at.y * this.scale}px`;
		editor.element.style.font = textFont(size, editor.weight);
		editor.element.style.lineHeight = `${size * 1.25}px`;
		this.autosizeTextEditor();
	}

	private autosizeTextEditor(): void {
		const element = this.textEditor?.element;
		if (!element) {
			return;
		}
		element.style.height = 'auto';
		element.style.height = `${element.scrollHeight}px`;
		element.style.width = 'auto';
		element.style.width = `${Math.max(element.scrollWidth + 4, 40)}px`;
	}

	/** Turns the open text box into a mark; `cancel` drops it (an edited mark comes back as it was). */
	private commitText(cancel = false): void {
		const editor = this.textEditor;
		if (!editor) {
			return;
		}
		this.textEditor = undefined;
		editor.element.remove();
		if (!this.state) {
			return;
		}
		const text = editor.element.value.replace(/\s+$/, '');
		const replacing = editor.replacing?.kind === 'text' ? editor.replacing : undefined;
		if (cancel || !text) {
			if (replacing) {
				// Put the original back; an empty edit deletes it.
				const before = { base: this.state.base, shapes: [...this.state.shapes, replacing] };
				if (cancel) {
					this.state = before;
				} else {
					this.undoStack.push(before);
					this.redoStack.length = 0;
				}
			}
			this.syncChrome();
			this.render();
			return;
		}
		const shape: Shape = { kind: 'text', color: editor.color, size: editor.size, weight: editor.weight, at: editor.at, text };
		if (replacing) {
			this.undoStack.push({ base: this.state.base, shapes: [...this.state.shapes, replacing] });
			this.redoStack.length = 0;
			this.state = { base: this.state.base, shapes: [...this.state.shapes, shape] };
			this.syncChrome();
			this.render();
		} else {
			this.commit({ base: this.state.base, shapes: [...this.state.shapes, shape] });
		}
	}

	//#endregion

	private registerListeners(win: Window & typeof globalThis): void {
		this._register(addDisposableListener(this.overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === this.overlay) {
				this.close();
			}
		}));
		this._register(addDisposableListener(this.dialog, EventType.MOUSE_DOWN, e => this.closePopups(e.target as Node)));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_DOWN, e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_MOVE, e => this.onPointerMove(e)));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_UP, e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.canvas, 'pointercancel', e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.canvas, EventType.DBLCLICK, e => {
			if (this.tool !== 'select' || !this.options.onSave) {
				return;
			}
			const hit = this.hitTest(this.toImage(e));
			if (hit?.kind === 'text') {
				this.selected = undefined;
				this.openTextEditor(hit.at, hit);
			}
		}));
		this._register(addDisposableListener(this.stage, EventType.MOUSE_WHEEL, e => {
			if (!e.ctrlKey && !e.metaKey) {
				return;
			}
			e.preventDefault();
			this.zoomBy(Math.exp(-e.deltaY * 0.01));
		}, { passive: false }));
		this._register(addDisposableListener(this.overlay, EventType.KEY_DOWN, e => this.onKeyDown(e)));
		const resize = new win.ResizeObserver(() => {
			if (this.zoom === 'fit') {
				this.layout();
			}
		});
		resize.observe(this.stage);
		this._register(toDisposable(() => resize.disconnect()));
	}

	private onKeyDown(e: KeyboardEvent): void {
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();
		const handled = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (e.key === 'Escape') {
			handled();
			if (this.closePopups()) {
				return;
			}
			if (this.tool === 'crop') {
				this.setTool('select');
			} else if (this.selected) {
				this.selected = undefined;
				this.syncChrome();
				this.render();
			} else {
				this.close();
			}
			return;
		}
		if (mod && (key === '=' || key === '+')) {
			handled();
			this.zoomBy(1.25);
			return;
		}
		if (mod && key === '-') {
			handled();
			this.zoomBy(1 / 1.25);
			return;
		}
		if (mod && key === '0') {
			handled();
			this.setZoom('fit');
			return;
		}
		if (mod && key === 'c' && !this.textEditor) {
			handled();
			void this.copy();
			return;
		}
		if (e.key === 'ArrowLeft' && !this.selected && this.images.length > 1) {
			handled();
			void this.go(-1);
			return;
		}
		if (e.key === 'ArrowRight' && !this.selected && this.images.length > 1) {
			handled();
			void this.go(1);
			return;
		}
		if (!this.options.onSave) {
			return;
		}
		if (mod && key === 'z') {
			handled();
			if (e.shiftKey) {
				this.redo();
			} else {
				this.undo();
			}
			return;
		}
		if (mod && key === 'y') {
			handled();
			this.redo();
			return;
		}
		if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
			handled();
			this.deleteSelected();
			return;
		}
		if (e.key === 'Enter' && this.tool === 'crop') {
			handled();
			this.applyCrop();
			return;
		}
		if (mod || e.altKey) {
			return;
		}
		if (e.shiftKey && key === 'r') {
			handled();
			this.rotate();
			return;
		}
		const tools: Record<string, Tool> = { v: 'select', a: 'arrow', r: 'rect', p: 'pen', t: 'text', c: 'crop' };
		const tool = !e.shiftKey ? tools[key] : undefined;
		if (tool) {
			handled();
			this.setTool(tool);
		}
	}
}

//#region Geometry and drawing

function formatShortcut(key: string): string {
	return isMacintosh ? `⌘${key.replace('Shift+', '⇧')}` : `Ctrl+${key}`;
}

function normalizeRect(a: IPoint, b: IPoint): IRect {
	return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function clampRect(rect: IRect, base: HTMLCanvasElement | undefined): IRect | undefined {
	if (!base) {
		return undefined;
	}
	const x = Math.max(0, rect.x);
	const y = Math.max(0, rect.y);
	return { x, y, w: Math.min(base.width, rect.x + rect.w) - x, h: Math.min(base.height, rect.y + rect.h) - y };
}

function inflate(rect: IRect, by: number): IRect {
	return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/** Shift-drag: arrows snap to 45°, boxes to squares. */
function constrain(kind: 'arrow' | 'rect', from: IPoint, to: IPoint): IPoint {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (kind === 'rect') {
		const side = Math.max(Math.abs(dx), Math.abs(dy));
		return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
	}
	const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
	const length = Math.hypot(dx, dy);
	return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

function mapShape(shape: Shape, map: (p: IPoint) => IPoint): Shape {
	switch (shape.kind) {
		case 'arrow':
		case 'rect':
			return { ...shape, from: map(shape.from), to: map(shape.to) };
		case 'pen':
			return { ...shape, points: shape.points.map(map) };
		case 'text':
			return { ...shape, at: map(shape.at) };
	}
}

function textFont(size: number, weight: number): string {
	return `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
}

function textLines(shape: Shape & { kind: 'text' }): string[] {
	return shape.text.split('\n');
}

function shapeBounds(ctx: CanvasRenderingContext2D, shape: Shape): IRect {
	switch (shape.kind) {
		case 'arrow':
		case 'rect':
			return inflate(normalizeRect(shape.from, shape.to), shape.width / 2);
		case 'pen': {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of shape.points) {
				minX = Math.min(minX, p.x);
				minY = Math.min(minY, p.y);
				maxX = Math.max(maxX, p.x);
				maxY = Math.max(maxY, p.y);
			}
			return inflate({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, shape.width / 2);
		}
		case 'text': {
			ctx.save();
			ctx.font = textFont(shape.size, shape.weight);
			const lines = textLines(shape);
			const width = Math.max(...lines.map(line => ctx.measureText(line).width));
			ctx.restore();
			return { x: shape.at.x, y: shape.at.y, w: width, h: lines.length * shape.size * 1.25 };
		}
	}
}

function distanceToSegment(p: IPoint, a: IPoint, b: IPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function shapeContains(ctx: CanvasRenderingContext2D, shape: Shape, p: IPoint, tolerance: number): boolean {
	switch (shape.kind) {
		case 'arrow':
			return distanceToSegment(p, shape.from, shape.to) <= shape.width + tolerance;
		case 'rect': {
			const r = normalizeRect(shape.from, shape.to);
			const edges: [IPoint, IPoint][] = [
				[{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }],
				[{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
				[{ x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
				[{ x: r.x, y: r.y + r.h }, { x: r.x, y: r.y }],
			];
			return edges.some(([a, b]) => distanceToSegment(p, a, b) <= shape.width + tolerance);
		}
		case 'pen':
			for (let i = 1; i < shape.points.length; i++) {
				if (distanceToSegment(p, shape.points[i - 1], shape.points[i]) <= shape.width + tolerance) {
					return true;
				}
			}
			return false;
		case 'text': {
			const box = inflate(shapeBounds(ctx, shape), tolerance / 2);
			return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
		}
	}
}

/** Black outlines on light colors and white ones on dark colors keep marks readable on any image. */
function haloFor(color: string): string {
	const value = parseInt(color.slice(1), 16);
	const luminance = (0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)) / 255;
	return luminance > 0.6 ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.55)';
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
	ctx.save();
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.strokeStyle = shape.color;
	ctx.fillStyle = shape.color;
	ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
	switch (shape.kind) {
		case 'arrow': {
			const { from, to, width } = shape;
			const angle = Math.atan2(to.y - from.y, to.x - from.x);
			const length = Math.hypot(to.x - from.x, to.y - from.y);
			const head = Math.min(width * 4.5 + 6, length * 0.6);
			const spread = Math.PI / 7;
			const neck = { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 };
			ctx.shadowBlur = width;
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(from.x, from.y);
			ctx.lineTo(neck.x, neck.y);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(to.x, to.y);
			ctx.lineTo(to.x - Math.cos(angle - spread) * head, to.y - Math.sin(angle - spread) * head);
			ctx.lineTo(to.x - Math.cos(angle + spread) * head, to.y - Math.sin(angle + spread) * head);
			ctx.closePath();
			ctx.fill();
			break;
		}
		case 'rect': {
			const r = normalizeRect(shape.from, shape.to);
			const radius = Math.min(shape.width * 1.5, r.w / 2, r.h / 2);
			ctx.shadowBlur = shape.width;
			ctx.lineWidth = shape.width;
			ctx.beginPath();
			ctx.roundRect(r.x, r.y, r.w, r.h, radius);
			ctx.stroke();
			break;
		}
		case 'pen': {
			const points = shape.points;
			ctx.shadowBlur = shape.width * 0.75;
			ctx.lineWidth = shape.width;
			ctx.beginPath();
			ctx.moveTo(points[0].x, points[0].y);
			if (points.length === 1) {
				ctx.lineTo(points[0].x + 0.01, points[0].y);
			}
			// Midpoint quadratic curves smooth the pointer samples.
			for (let i = 1; i < points.length - 1; i++) {
				const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
				ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
			}
			if (points.length > 1) {
				const last = points[points.length - 1];
				ctx.lineTo(last.x, last.y);
			}
			ctx.stroke();
			break;
		}
		case 'text': {
			ctx.font = textFont(shape.size, shape.weight);
			ctx.textBaseline = 'top';
			ctx.lineWidth = Math.max(2, shape.size / 7);
			ctx.strokeStyle = haloFor(shape.color);
			textLines(shape).forEach((line, i) => {
				const y = shape.at.y + i * shape.size * 1.25 + shape.size * 0.1;
				ctx.strokeText(line, shape.at.x, y);
				ctx.fillText(line, shape.at.x, y);
			});
			break;
		}
	}
	ctx.restore();
}

//#endregion
