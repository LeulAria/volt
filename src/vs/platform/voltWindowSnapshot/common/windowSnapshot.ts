/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No imports: the window's startup script paints snapshots with this before any workbench code loads.

/**
 * A picture of a window's screen made of its own DOM: what the window showed when it was last
 * left (the chat on screen, its visible rows, the sidebar, the composer with its draft). The next
 * start paints it in the window's first frame, before the workbench code has loaded, and the
 * workbench takes over from it once the restored chat is drawn.
 *
 * Only what can be drawn safely is kept: elements, classes, inline styles and text, no scripts,
 * event handlers, frames or links to load (see {@link SNAPSHOT_ALLOWED_ATTRIBUTES}).
 */
export interface IVoltWindowSnapshot {
	readonly version: typeof VOLT_WINDOW_SNAPSHOT_VERSION;
	/** The window the snapshot is for ({@link voltWindowSnapshotKey}). */
	readonly key: string;
	/** The window's inner size in CSS pixels and its zoom: the picture is used only at the same size. */
	readonly width: number;
	readonly height: number;
	readonly devicePixelRatio: number;
	/** `vs-dark`, `vs`, `hc-black` or `hc-light`. */
	readonly baseTheme: string;
	/** The chat on screen. */
	readonly sessionId?: string;
	/** The runtime style rules the snapshot's elements use (theme colors, icons, token colors). */
	readonly css: string;
	readonly htmlClass: string;
	readonly bodyClass: string;
	/** The workbench element and what it shows. */
	readonly root: VoltSnapshotNode;
	/** Where the composer's text area sits, and the draft it holds. */
	readonly composer?: IVoltSnapshotComposer;
	readonly savedAt: number;
}

export interface IVoltSnapshotComposer {
	/** Left, top, width, height of the composer's text lines, in CSS pixels. */
	readonly rect: readonly [number, number, number, number];
	readonly text: string;
	readonly placeholder: string;
	readonly font: string;
	readonly lineHeight: number;
	readonly letterSpacing: string;
	readonly color: string;
	readonly placeholderColor: string;
	readonly caretColor: string;
}

/**
 * A text node (a string) or an element: tag, SVG namespace flag, attributes, children, and its
 * scroll offset when it was scrolled.
 */
export type VoltSnapshotNode = string | IVoltSnapshotElement;

export interface IVoltSnapshotElement {
	readonly t: string;
	readonly svg?: 1;
	readonly a?: Readonly<Record<string, string>>;
	readonly c?: readonly VoltSnapshotNode[];
	/** scrollTop, scrollLeft */
	readonly s?: readonly [number, number];
}

export const VOLT_WINDOW_SNAPSHOT_VERSION = 1;

/** The element that holds a painted snapshot until the workbench takes over. */
export const VOLT_WINDOW_SNAPSHOT_ID = 'volt-window-snapshot';
/** On `<body>` while a snapshot is shown: the workbench underneath stays invisible until it takes over. */
export const VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS = 'volt-window-snapshot-shown';
/** The text area over the snapshot's composer: keys typed before the workbench is up land here. */
export const VOLT_WINDOW_SNAPSHOT_INPUT_ID = 'volt-window-snapshot-input';

/** HTML and SVG attributes a snapshot keeps; everything else (handlers, links, ids, ARIA) is dropped. */
export const SNAPSHOT_ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
	'class', 'style',
	// SVG drawing
	'viewBox', 'd', 'fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
	'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform',
	'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'preserveAspectRatio',
	'xmlns', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
]);

/** Elements a snapshot never holds: they run code or draw nothing. */
export const SNAPSHOT_DROPPED_TAGS: ReadonlySet<string> = new Set([
	'script', 'style', 'link', 'meta', 'template', 'noscript', 'slot', 'source', 'title',
]);

/**
 * Elements a snapshot keeps only as an empty box of the same size: they load pages or media, or
 * are not drawn from the DOM alone (frames, canvases, images, form fields).
 */
export const SNAPSHOT_BOXED_TAGS: ReadonlySet<string> = new Set([
	'iframe', 'webview', 'frame', 'object', 'embed', 'textarea', 'input', 'select', 'video', 'audio',
	'canvas', 'img', 'picture', 'foreignobject', 'use', 'image',
]);

/** One snapshot per window: its New Window scope, else its workspace, else its empty-window backup folder. */
export function voltWindowSnapshotKey(config: { readonly voltWindowScope?: string; readonly workspace?: { readonly id: string }; readonly backupPath?: string }): string {
	if (config.voltWindowScope) {
		return `scope:${config.voltWindowScope}`;
	}
	if (config.workspace) {
		return `workspace:${config.workspace.id}`;
	}
	const backup = config.backupPath?.split(/[\\/]/).filter(Boolean).at(-1);
	return backup ? `empty:${backup}` : 'empty';
}

/** Whether a stored snapshot can be painted in a window of this size and theme. */
export function canPaintVoltWindowSnapshot(snapshot: IVoltWindowSnapshot | undefined, key: string, window: { readonly innerWidth: number; readonly innerHeight: number; readonly devicePixelRatio: number }, baseTheme: string | undefined): snapshot is IVoltWindowSnapshot {
	return !!snapshot
		&& snapshot.version === VOLT_WINDOW_SNAPSHOT_VERSION
		&& snapshot.key === key
		&& Math.abs(snapshot.width - window.innerWidth) < 1
		&& Math.abs(snapshot.height - window.innerHeight) < 1
		&& snapshot.devicePixelRatio === window.devicePixelRatio
		&& (baseTheme === undefined || snapshot.baseTheme === baseTheme);
}
