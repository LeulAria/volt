/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scratch: the whiteboard's document model. Everything here is plain data so boards can be saved,
 * merged across windows, diffed for undo and described to an agent without a DOM.
 *
 * Coordinates are world pixels at zoom 1. Colours are stored as they look on a light board; a dark
 * board maps them at paint time (see scratchColor.ts), so a board reads the same in both themes.
 */

export const SCRATCH_SCHEMA_VERSION = 1;

export type ScratchPoint = readonly [number, number];
/** A freehand sample: x, y and pen pressure in 0..1. */
export type ScratchPressurePoint = readonly [number, number, number];

export type ScratchShapeKind =
	| 'rectangle'
	| 'diamond'
	| 'ellipse'
	| 'triangle'
	| 'hexagon'
	| 'parallelogram'
	| 'cylinder'
	| 'pill'
	| 'document'
	| 'cloud'
	| 'star';

export type ScratchFillStyle = 'hachure' | 'cross-hatch' | 'solid';
export type ScratchStrokeStyle = 'solid' | 'dashed' | 'dotted';
export type ScratchRoundness = 'sharp' | 'round';
export type ScratchArrowType = 'sharp' | 'round' | 'elbow';
export type ScratchArrowhead = 'none' | 'arrow' | 'triangle' | 'triangle-outline' | 'dot' | 'circle' | 'bar' | 'diamond' | 'diamond-outline' | 'crowfoot-one' | 'crowfoot-many' | 'crowfoot-one-or-many';
export type ScratchFontFamily = 'hand' | 'sans' | 'serif' | 'mono';
export type ScratchTextAlign = 'left' | 'center' | 'right';
export type ScratchVerticalAlign = 'top' | 'middle' | 'bottom';
export type ScratchPenKind = 'pen' | 'highlighter';

export type ScratchElementType = 'shape' | 'line' | 'arrow' | 'draw' | 'text' | 'note' | 'card' | 'image' | 'icon' | 'frame';

/** Shared by every element. Elements are immutable: a change makes a new object with `version + 1`. */
export interface IScratchElementBase {
	readonly id: string;
	readonly type: ScratchElementType;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** Radians, clockwise, around the centre of the box. */
	readonly angle: number;
	readonly stroke: string;
	/** A colour or `transparent`. */
	readonly fill: string;
	readonly fillStyle: ScratchFillStyle;
	readonly strokeWidth: number;
	readonly strokeStyle: ScratchStrokeStyle;
	/** 0 architect (clean), 1 artist, 2 cartoonist. */
	readonly roughness: number;
	/** 0..100. */
	readonly opacity: number;
	readonly roundness: ScratchRoundness;
	/** Keeps the hand-drawn wobble stable between paints. */
	readonly seed: number;
	readonly version: number;
	/** Wall clock of the last change; the newer copy wins when two windows saved the same board. */
	readonly updated: number;
	/** Innermost group first, outermost last. */
	readonly groupIds: readonly string[];
	readonly frameId: string | null;
	readonly locked: boolean;
	readonly link: string | null;
}

/** Text written inside a shape or along a connector. Rich text, see scratchRichText. */
export interface IScratchLabel {
	readonly html: string;
	readonly fontFamily: ScratchFontFamily;
	readonly fontSize: number;
	readonly textAlign: ScratchTextAlign;
	/**
	 * Inside a shape: where the text sits. Along a connector: `middle` on the line (with the board
	 * colour behind it), `top` beside it (above a level stretch, right of an upright one), `bottom`
	 * on the other side.
	 */
	readonly verticalAlign: ScratchVerticalAlign;
	/** The text's own colour (light-space); without it the text takes the element's stroke. */
	readonly color?: string;
}

/** An icon drawn with a shape's label or in a container frame's header (Aria Icons, icons.leularia.com). */
export interface IScratchInlineIcon {
	/** `set:name`, e.g. `lucide:webhook`. */
	readonly iconId: string;
	readonly svg: string;
	/** Draws with currentColor, so it takes the element's stroke colour. Brand logos keep their own. */
	readonly tintable: boolean;
	/** Above the label, centred, or before it (the label then starts at the left). Frames always put it before the name. */
	readonly placement: 'top' | 'left';
	/** Width and height in board units. */
	readonly size: number;
}

export interface IScratchShapeElement extends IScratchElementBase {
	readonly type: 'shape';
	readonly shape: ScratchShapeKind;
	readonly label: IScratchLabel | null;
	readonly icon?: IScratchInlineIcon | null;
}

/**
 * Where a connector end is attached. `anchor` is a point in the target's own unrotated box
 * (0..1 on each axis); null aims at the centre and lands on the outline, so the end slides along
 * the shape as either side moves.
 */
export interface IScratchBinding {
	readonly elementId: string;
	readonly anchor: ScratchPoint | null;
}

export interface IScratchLinearElement extends IScratchElementBase {
	readonly type: 'line' | 'arrow';
	/** Relative to x, y. The first point is always [0, 0]. */
	readonly points: readonly ScratchPoint[];
	readonly arrowType: ScratchArrowType;
	readonly startArrowhead: ScratchArrowhead;
	readonly endArrowhead: ScratchArrowhead;
	readonly startBinding: IScratchBinding | null;
	readonly endBinding: IScratchBinding | null;
	readonly label: IScratchLabel | null;
	/** A closed line is a polygon (fills like a shape). */
	readonly closed: boolean;
}

export interface IScratchDrawElement extends IScratchElementBase {
	readonly type: 'draw';
	/** Relative to x, y. */
	readonly points: readonly ScratchPressurePoint[];
	readonly pen: ScratchPenKind;
	/** Mouse and trackpad strokes have no pressure; thickness follows speed instead. */
	readonly simulatePressure: boolean;
}

interface IScratchRichTextFields {
	/** Sanitized HTML: paragraphs, inline marks, lists, tables, code. See scratchRichText. */
	readonly html: string;
	readonly fontFamily: ScratchFontFamily;
	readonly fontSize: number;
	readonly textAlign: ScratchTextAlign;
}

/** Free text. With `autoSize` the box hugs the text; otherwise `width` wraps it. */
export interface IScratchTextElement extends IScratchElementBase, IScratchRichTextFields {
	readonly type: 'text';
	readonly autoSize: boolean;
}

/** A sticky note: `fill` is the paper colour. Height grows with the text. */
export interface IScratchNoteElement extends IScratchElementBase, IScratchRichTextFields {
	readonly type: 'note';
}

/** A document card: rendered markdown (headings, tables, code) in a framed page. */
export interface IScratchCardElement extends IScratchElementBase, IScratchRichTextFields {
	readonly type: 'card';
}

export interface IScratchImageElement extends IScratchElementBase {
	readonly type: 'image';
	/** File name in the board store's assets folder (content hash + extension). */
	readonly assetId: string;
	readonly mime: string;
	readonly naturalWidth: number;
	readonly naturalHeight: number;
}

/** A vector icon from Aria Icons (icons.leularia.com) or the built-in set. */
export interface IScratchIconElement extends IScratchElementBase {
	readonly type: 'icon';
	/** `set:name`, e.g. `lucide:database`. */
	readonly iconId: string;
	readonly svg: string;
	/** The icon draws with currentColor, so it takes the stroke colour. Brand logos keep their own. */
	readonly tintable: boolean;
	readonly label: IScratchLabel | null;
}

/**
 * A frame drawn as a container (a group in an architecture diagram): its outline is drawn like a
 * shape's (stroke, width, style, roughness), and the name sits inside at the top left, after an
 * icon and before a quieter subtitle.
 */
export interface IScratchFrameHeader {
	readonly icon: IScratchInlineIcon | null;
	readonly subtitle: string;
	readonly fontFamily: ScratchFontFamily;
	readonly fontSize: number;
	/** The name's colour (light-space). */
	readonly color: string;
}

/** A named region; elements inside move with it. */
export interface IScratchFrameElement extends IScratchElementBase {
	readonly type: 'frame';
	readonly name: string;
	/** Set: a container with its name inside. Unset: a plain frame with its name in a tab above. */
	readonly header?: IScratchFrameHeader | null;
}

export type ScratchElement =
	| IScratchShapeElement
	| IScratchLinearElement
	| IScratchDrawElement
	| IScratchTextElement
	| IScratchNoteElement
	| IScratchCardElement
	| IScratchImageElement
	| IScratchIconElement
	| IScratchFrameElement;

export type ScratchRichTextElement = IScratchTextElement | IScratchNoteElement | IScratchCardElement;
export type ScratchLabelledElement = IScratchShapeElement | IScratchLinearElement | IScratchIconElement;

export type ScratchGrid = 'none' | 'dots' | 'lines';
export type ScratchTheme = 'auto' | 'light' | 'dark';

export interface IScratchCamera {
	/** Screen offset of the world origin, in CSS pixels. */
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
	/** The viewport it was saved for: a restore keeps the same middle in a viewport of another size. */
	readonly viewWidth?: number;
	readonly viewHeight?: number;
}

export interface IScratchBoardSettings {
	/** Light-space colour of the board. */
	readonly background: string;
	readonly grid: ScratchGrid;
	readonly theme: ScratchTheme;
	readonly snapToObjects: boolean;
	readonly snapToGrid: boolean;
}

/**
 * A selection handed to an agent. The board draws a dashed outline around what is left of those
 * elements, with the chat's live state, and a click opens the chat.
 */
export interface IScratchAgentRun {
	readonly id: string;
	readonly sessionId: string;
	readonly elementIds: readonly string[];
	readonly prompt: string;
	readonly modelLabel: string | undefined;
	readonly created: number;
	/** The outline stays where it was if every element was deleted. */
	readonly bounds: IScratchRect;
	readonly hidden?: boolean;
}

export interface IScratchBoardDocument {
	readonly schema: number;
	readonly id: string;
	readonly elements: readonly ScratchElement[];
	/** Element id → time it was deleted, so a merge does not bring it back. Pruned after a while. */
	readonly deleted: Readonly<Record<string, number>>;
	readonly settings: IScratchBoardSettings;
	readonly camera: IScratchCamera | undefined;
	readonly runs: readonly IScratchAgentRun[];
	/** Bumped on every save. */
	readonly revision: number;
	readonly updated: number;
}

export interface IScratchRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface IScratchBounds {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

// ---- Board list ----------------------------------------------------------------------------

export interface IScratchFolder {
	readonly id: string;
	readonly name: string;
	readonly created: number;
	readonly updated: number;
	readonly collapsed?: boolean;
	readonly deleted?: boolean;
}

export interface IScratchBoardMeta {
	readonly id: string;
	readonly title: string;
	readonly folderId: string | null;
	/** The Volt project the board's chats run in; unset gives each chat a scratch folder of its own. */
	readonly projectId?: string;
	readonly pinned: boolean;
	readonly archived: boolean;
	readonly created: number;
	/** Last edit of the board's content. */
	readonly edited: number;
	/** Last change of this entry (title, folder, pin...); the newer entry wins a merge. */
	readonly updated: number;
	readonly deleted?: boolean;
	/** Short text from the board, for search and the row's subtitle. */
	readonly excerpt?: string;
	readonly elementCount?: number;
}

export interface IScratchIndex {
	readonly schema: number;
	readonly boards: readonly IScratchBoardMeta[];
	readonly folders: readonly IScratchFolder[];
	readonly lastOpened: string | undefined;
	readonly updated: number;
}

// ---- Defaults ------------------------------------------------------------------------------

export const SCRATCH_FONT_SIZES = { small: 16, medium: 20, large: 28, huge: 36 } as const;
export const SCRATCH_STROKE_WIDTHS = { thin: 1, bold: 2, extraBold: 4 } as const;
export const SCRATCH_MIN_ZOOM = 0.1;
export const SCRATCH_MAX_ZOOM = 30;
export const SCRATCH_GRID_SIZE = 20;
/** Gap between a bound connector end and the shape's outline. */
export const SCRATCH_BINDING_GAP = 6;

/** Excalidraw-like palettes, light-space. The first stroke is ink, the first fill is none. */
export const SCRATCH_STROKE_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#846358'] as const;
export const SCRATCH_FILL_COLORS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#eebefa', '#99e9f2', '#e9ecef'] as const;
export const SCRATCH_NOTE_COLORS = ['#fff3bf', '#ffd8a8', '#ffc9c9', '#fcc2d7', '#d0bfff', '#a5d8ff', '#b2f2bb', '#e9ecef'] as const;
export const SCRATCH_BACKGROUNDS = ['#ffffff', '#f8f9fa', '#f5faff', '#fffce8', '#fdf8f6', '#f3f0ff', '#ebfbee'] as const;

export const DEFAULT_SCRATCH_SETTINGS: IScratchBoardSettings = {
	background: '#ffffff',
	grid: 'dots',
	theme: 'auto',
	snapToObjects: true,
	snapToGrid: false,
};

/** What new elements are drawn with; the inspector edits it while nothing is selected. */
export interface IScratchStyleDefaults {
	readonly stroke: string;
	readonly fill: string;
	readonly fillStyle: ScratchFillStyle;
	readonly strokeWidth: number;
	readonly strokeStyle: ScratchStrokeStyle;
	readonly roughness: number;
	readonly opacity: number;
	readonly roundness: ScratchRoundness;
	readonly arrowType: ScratchArrowType;
	readonly startArrowhead: ScratchArrowhead;
	readonly endArrowhead: ScratchArrowhead;
	readonly fontFamily: ScratchFontFamily;
	readonly fontSize: number;
	readonly textAlign: ScratchTextAlign;
	readonly noteColor: string;
	readonly pen: ScratchPenKind;
}

export const DEFAULT_SCRATCH_STYLE: IScratchStyleDefaults = {
	stroke: SCRATCH_STROKE_COLORS[0],
	fill: 'transparent',
	fillStyle: 'hachure',
	strokeWidth: SCRATCH_STROKE_WIDTHS.bold,
	strokeStyle: 'solid',
	roughness: 1,
	opacity: 100,
	roundness: 'round',
	arrowType: 'round',
	startArrowhead: 'none',
	endArrowhead: 'arrow',
	fontFamily: 'hand',
	fontSize: SCRATCH_FONT_SIZES.medium,
	textAlign: 'left',
	noteColor: SCRATCH_NOTE_COLORS[0],
	pen: 'pen',
};

/**
 * What agents draw in: clean lines, the system font and quiet greys, like a figure in a paper
 * rather than a sketch. Colour comes only from a diagram's own classDefs.
 */
export const AGENT_SCRATCH_STYLE: IScratchStyleDefaults = {
	...DEFAULT_SCRATCH_STYLE,
	stroke: '#495057',
	fill: '#f8f9fa',
	fillStyle: 'solid',
	strokeWidth: 1.5,
	roughness: 0,
	fontFamily: 'sans',
	fontSize: SCRATCH_FONT_SIZES.small,
	noteColor: SCRATCH_NOTE_COLORS[7],
};

/**
 * What agents draw diagrams in: the board's own hand-drawn look (Excalifont, a light wobble, open
 * outlines in ink), like a diagram someone sketched in Excalidraw. Colour comes from the diagram.
 */
export const AGENT_DIAGRAM_STYLE: IScratchStyleDefaults = {
	...DEFAULT_SCRATCH_STYLE,
	stroke: SCRATCH_STROKE_COLORS[0],
	fill: 'transparent',
	fillStyle: 'solid',
	strokeWidth: SCRATCH_STROKE_WIDTHS.bold,
	roughness: 1,
	fontFamily: 'hand',
	fontSize: SCRATCH_FONT_SIZES.medium,
	noteColor: SCRATCH_NOTE_COLORS[7],
};

export function isLinear(element: ScratchElement): element is IScratchLinearElement {
	return element.type === 'line' || element.type === 'arrow';
}

export function isRichText(element: ScratchElement): element is ScratchRichTextElement {
	return element.type === 'text' || element.type === 'note' || element.type === 'card';
}

export function hasLabel(element: ScratchElement): element is ScratchLabelledElement {
	return element.type === 'shape' || element.type === 'arrow' || element.type === 'line' || element.type === 'icon';
}

/** Elements a connector can attach to. */
export function isBindable(element: ScratchElement): boolean {
	return element.type === 'shape' || element.type === 'text' || element.type === 'note' || element.type === 'card'
		|| element.type === 'image' || element.type === 'icon' || element.type === 'frame';
}
