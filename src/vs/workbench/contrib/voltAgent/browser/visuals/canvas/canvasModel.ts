/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The design canvas: a persistent, Figma-like board of live screens an agent draws (canvas_render)
 * and then patches (canvas_update) while the user moves, resizes, plays and comments on it. This
 * module is the pure part: the document, the agent's arguments, patches, auto layout, and the
 * messages that carry the user's comments back to the agent. No DOM, no services; tested as is.
 *
 * Token budget is the design constraint. The agent sends each screen's body markup once, with
 * what screens share (head, css, `{{name}}` components) said once; later turns send edits
 * (find/replace on one frame) instead of whole screens. The user's layout and comments live in the
 * same document, so every view of a canvas (inline in the chat, the side panel) shows one state.
 */

//#region Document

export type CanvasFrameKind = 'iphone' | 'android' | 'tablet' | 'browser' | 'desktop' | 'watch' | 'component' | 'frame';
export type CanvasTheme = 'light' | 'dark';

export interface ICanvasSize {
	readonly width: number;
	/** 0: as tall as the content. */
	readonly height: number;
}

/** Default viewport per frame kind, in CSS px (the screen, without any bezel). */
export const CANVAS_FRAME_SIZES: Readonly<Record<CanvasFrameKind, ICanvasSize>> = {
	iphone: { width: 393, height: 852 },
	android: { width: 412, height: 915 },
	tablet: { width: 820, height: 1180 },
	browser: { width: 1280, height: 800 },
	desktop: { width: 1280, height: 800 },
	watch: { width: 205, height: 251 },
	component: { width: 420, height: 0 },
	frame: { width: 800, height: 600 },
};

/** Sizes the user can snap a frame to from its size menu. */
export const CANVAS_SIZE_PRESETS: readonly { readonly label: string; readonly kind: CanvasFrameKind; readonly width: number; readonly height: number }[] = [
	{ label: 'iPhone 16', kind: 'iphone', width: 393, height: 852 },
	{ label: 'iPhone 16 Pro Max', kind: 'iphone', width: 440, height: 956 },
	{ label: 'iPhone SE', kind: 'iphone', width: 375, height: 667 },
	{ label: 'Pixel 9', kind: 'android', width: 412, height: 915 },
	{ label: 'Galaxy S24', kind: 'android', width: 384, height: 832 },
	{ label: 'iPad Air', kind: 'tablet', width: 820, height: 1180 },
	{ label: 'iPad Pro 13"', kind: 'tablet', width: 1032, height: 1376 },
	{ label: 'Laptop', kind: 'browser', width: 1280, height: 800 },
	{ label: 'Desktop', kind: 'browser', width: 1440, height: 900 },
	{ label: 'Wide', kind: 'browser', width: 1920, height: 1080 },
	{ label: 'Apple Watch', kind: 'watch', width: 205, height: 251 },
];

/** A prototype arrow: from a frame (or an element in it) to another frame. */
export interface ICanvasLink {
	readonly from: string;
	readonly to: string;
	/** A CSS selector in `from` the arrow starts at (the button that leads there). */
	readonly trigger?: string;
	readonly label?: string;
}

export interface ICanvasFrame {
	/** Stable id the agent and the user's comments refer to ("welcome", "pricing-dark"). */
	readonly id: string;
	readonly name: string;
	readonly kind: CanvasFrameKind;
	readonly width: number;
	/** 0: as tall as the content (components, long pages). */
	readonly height: number;
	/** Position on the board, in canvas px. Unset: laid out automatically. */
	readonly x?: number;
	readonly y?: number;
	/** Body markup, or a whole document. */
	readonly html?: string;
	readonly css?: string;
	/** A live page instead of markup (the user's dev server, a site), shown as is. */
	readonly url?: string;
	/** A picture instead of markup (a data URL; local paths are embedded by the tool). */
	readonly image?: string;
	/** One line under the frame: the idea, a trade-off, what changed. */
	readonly note?: string;
	/** Frames in one section sit together under its label ("Onboarding", "Option B"). */
	readonly section?: string;
	/** This frame's own look, when it differs from the canvas's. */
	readonly theme?: CanvasTheme;
	/** Badged as the agent's pick (variant boards). */
	readonly recommended?: boolean;
	/** Phones: content runs under the status bar (no safe-area padding). */
	readonly fullbleed?: boolean;
}

export type CanvasCommentStatus = 'open' | 'sent' | 'resolved';

/** Where a comment points: an element in a frame (by selector), or a spot or region of the frame. */
export interface ICanvasAnchor {
	readonly frame: string;
	readonly selector?: string;
	/** `button#start "Get started"`. */
	readonly element?: string;
	readonly text?: string;
	/** The element's markup, trimmed. */
	readonly html?: string;
	/** The point (or region's corner) in the frame's document, CSS px. */
	readonly x: number;
	readonly y: number;
	/** A region instead of a point. */
	readonly w?: number;
	readonly h?: number;
	/** The pin's place on the element, as fractions of its box, so it follows the element. */
	readonly fx?: number;
	readonly fy?: number;
}

/** A visual tweak the user made in the inspector, for the agent to carry into the source. */
export interface ICanvasTweak {
	readonly property: string;
	readonly value: string;
	readonly before?: string;
}

export interface ICanvasComment {
	/** "c1", "c2", ... */
	readonly id: string;
	readonly anchor: ICanvasAnchor;
	readonly text: string;
	readonly status: CanvasCommentStatus;
	readonly author: 'user' | 'agent';
	/** The agent's answer when it resolved the comment. */
	readonly reply?: string;
	/** Inspector edits on the anchored element. */
	readonly tweaks?: readonly ICanvasTweak[];
	readonly at: number;
}

export interface ICanvasDoc {
	readonly id: string;
	readonly title: string;
	readonly subtitle?: string;
	/** Bumped on every agent change; the user's layout and comments do not bump it. */
	readonly version: number;
	/** The look frames open in. Unset: the user's Volt theme. */
	readonly theme?: CanvasTheme;
	/** Shared by every frame: fonts and scripts (`head`), styles (`css`), `{{name}}` snippets (`components`). */
	readonly head?: string;
	readonly css?: string;
	readonly components?: Readonly<Record<string, string>>;
	readonly frames: readonly ICanvasFrame[];
	readonly links: readonly ICanvasLink[];
	readonly comments: readonly ICanvasComment[];
	/** A variant board: every frame gets Choose, and the pick goes back to the agent. */
	readonly pick?: boolean;
	/** The chat the canvas was made in. */
	readonly chat?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** What the last agent change did, one line (shown on the canvas and in the update card). */
	readonly change?: string;
}

/** Frame position and size as the user left them. */
export interface ICanvasLayout {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export const MAX_CANVAS_FRAMES = 40;
export const MAX_CANVAS_COMMENTS = 200;
export const MAX_CANVAS_CHARS = 900_000;
const FRAME_GAP = 120;
const SECTION_GAP = 220;
const SECTION_LABEL = 64;

//#endregion

//#region Parsing the agent's arguments

function text(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;
}

function markup(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function finite(value: unknown): number | undefined {
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A frame id from what the agent wrote: lowercase letters, digits and dashes. */
export function frameSlug(value: string): string {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'frame';
}

/** The frame kind an agent meant ("phone", "ios", "web", "laptop", "card"...). */
export function canvasFrameKind(value: unknown): CanvasFrameKind | undefined {
	const key = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
	switch (key) {
		case 'iphone': case 'phone': case 'ios': case 'mobile': case 'iphonepro': return 'iphone';
		case 'android': case 'pixel': case 'galaxy': case 'androidphone': return 'android';
		case 'tablet': case 'ipad': return 'tablet';
		case 'browser': case 'web': case 'website': case 'page': case 'laptop': case 'site': case 'webpage': return 'browser';
		case 'desktop': case 'window': case 'app': case 'mac': case 'macos': case 'windows': case 'electron': return 'desktop';
		case 'watch': case 'applewatch': case 'wear': return 'watch';
		case 'component': case 'widget': case 'card': case 'element': case 'snippet': return 'component';
		case 'frame': case 'custom': case 'artboard': case 'board': case 'none': return 'frame';
	}
	return undefined;
}

function themeOf(value: unknown): CanvasTheme | undefined {
	return value === 'light' || value === 'dark' ? value : undefined;
}

function clampSize(kind: CanvasFrameKind, width: number | undefined, height: number | undefined): ICanvasSize {
	const base = CANVAS_FRAME_SIZES[kind];
	const w = Math.round(Math.min(3840, Math.max(120, width ?? base.width)));
	const h = height === 0 ? 0 : Math.round(Math.min(4000, Math.max(80, height ?? (width && base.height ? Math.round(width * base.height / base.width) : base.height))));
	return { width: w, height: kind === 'component' && height === undefined ? 0 : h };
}

function parseJsonish(value: unknown): unknown {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return value;
			}
		}
	}
	return value;
}

function parseComponents(value: unknown): Record<string, string> | undefined {
	const raw = parseJsonish(value);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [name, snippet] of Object.entries(raw as Record<string, unknown>)) {
		if (/^[\w-]{1,40}$/.test(name) && typeof snippet === 'string') {
			out[name] = snippet;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/** One frame from the agent, or what is wrong with it. `previous` is the frame it updates. */
function parseFrame(raw: unknown, index: number, taken: Set<string>, previous?: ICanvasFrame): ICanvasFrame | { error: string } {
	if (!raw || typeof raw !== 'object') {
		return { error: `frames[${index}] is not an object.` };
	}
	const item = raw as Record<string, unknown>;
	const name = text(item.name ?? item.title ?? item.label, 80) ?? previous?.name ?? `Screen ${index + 1}`;
	let id = previous?.id;
	if (!id) {
		const wanted = text(item.id, 60);
		id = frameSlug(wanted ?? name);
		if (taken.has(id)) {
			let n = 2;
			while (taken.has(`${id}-${n}`)) {
				n++;
			}
			id = `${id}-${n}`;
		}
	}
	const kindValue = item.kind ?? item.device ?? item.frame ?? item.type;
	const kind = kindValue !== undefined ? canvasFrameKind(kindValue) : previous?.kind ?? 'iphone';
	if (!kind) {
		return { error: `Frame "${name}": unknown kind "${String(kindValue)}". Use iphone, android, tablet, browser, desktop, watch, component or frame.` };
	}
	const kindChanged = !!previous && kind !== previous.kind;
	const size = clampSize(kind, finite(item.width) ?? (kindChanged ? undefined : previous?.width), finite(item.height) ?? (kindChanged ? undefined : previous?.height));
	const html = item.html !== undefined ? markup(item.html) : previous?.html;
	const url = item.url !== undefined ? text(item.url, 2000) : previous?.url;
	const image = item.image !== undefined ? text(item.image, 30_000_000) : previous?.image;
	if (!html && !url && !image) {
		return { error: `Frame "${name}" needs "html" (its body markup), a "url" or an "image".` };
	}
	if (url && !/^https?:\/\//i.test(url)) {
		return { error: `Frame "${name}": "url" must start with http:// or https://.` };
	}
	const has = (key: string) => Object.prototype.hasOwnProperty.call(item, key);
	const frame: { -readonly [K in keyof ICanvasFrame]: ICanvasFrame[K] } = { id, name, kind, width: size.width, height: size.height };
	const set = <K extends keyof ICanvasFrame>(key: K, value: ICanvasFrame[K] | undefined) => {
		if (value !== undefined) {
			frame[key] = value;
		}
	};
	set('x', has('x') ? finite(item.x) : previous?.x);
	set('y', has('y') ? finite(item.y) : previous?.y);
	set('html', url || image ? (has('html') ? html : undefined) : html);
	set('css', has('css') ? markup(item.css) : previous?.css);
	set('url', has('html') && !has('url') ? undefined : url);
	set('image', has('html') && !has('image') ? undefined : image);
	set('note', has('note') ? text(item.note, 300) : previous?.note);
	set('section', has('section') || has('group') ? text(item.section ?? item.group, 60) : previous?.section);
	set('theme', has('theme') ? themeOf(item.theme) : previous?.theme);
	set('recommended', has('recommended') ? (item.recommended === true ? true : undefined) : previous?.recommended);
	set('fullbleed', has('fullbleed') ? (item.fullbleed === true ? true : undefined) : previous?.fullbleed);
	return frame;
}

function parseLinks(value: unknown, frames: readonly ICanvasFrame[]): ICanvasLink[] | { error: string } {
	const raw = parseJsonish(value);
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		return { error: '"links" is a list: [{ "from": "welcome", "to": "signup", "trigger": "#start", "label": "Get started" }].' };
	}
	const ids = new Set(frames.map(frame => frame.id));
	const resolve = (ref: unknown) => {
		const value = text(ref, 80);
		if (!value) {
			return undefined;
		}
		if (ids.has(value)) {
			return value;
		}
		const slug = frameSlug(value);
		return ids.has(slug) ? slug : frames.find(frame => frame.name.toLowerCase() === value.toLowerCase())?.id;
	};
	const links: ICanvasLink[] = [];
	for (const item of raw.slice(0, 120)) {
		const link = item as Record<string, unknown> | undefined;
		const from = resolve(link?.from);
		const to = resolve(link?.to);
		if (!from || !to) {
			return { error: `Link ${JSON.stringify(item).slice(0, 120)}: "from" and "to" must be frame ids (${[...ids].join(', ')}).` };
		}
		const trigger = text(link?.trigger ?? link?.selector, 200);
		const label = text(link?.label, 60);
		links.push({ from, to, ...(trigger ? { trigger } : {}), ...(label ? { label } : {}) });
	}
	return links;
}

/** The size of everything the frames are made of, to keep a canvas under the page limit. */
export function canvasChars(doc: Pick<ICanvasDoc, 'head' | 'css' | 'components' | 'frames'>): number {
	let total = (doc.head?.length ?? 0) + (doc.css?.length ?? 0);
	for (const snippet of Object.values(doc.components ?? {})) {
		total += snippet.length;
	}
	for (const frame of doc.frames) {
		// Images are data, not markup the agent wrote: they count against the page bytes instead.
		total += (frame.html?.length ?? 0) + (frame.css?.length ?? 0);
	}
	return total;
}

export interface ICanvasCreate {
	readonly title: string;
	readonly subtitle?: string;
	readonly theme?: CanvasTheme;
	readonly head?: string;
	readonly css?: string;
	readonly components?: Readonly<Record<string, string>>;
	readonly frames: readonly ICanvasFrame[];
	readonly links: readonly ICanvasLink[];
	readonly pick?: boolean;
}

/** canvas_render's arguments as a new canvas, or what is wrong with them. Pure. */
export function parseCanvasArgs(args: Record<string, unknown>): ICanvasCreate | { readonly error: string } {
	const raw = parseJsonish(args.frames ?? args.screens);
	if (!Array.isArray(raw) || !raw.length) {
		return { error: 'Pass "frames": [{ "id": "welcome", "name": "Welcome", "kind": "iphone", "html": "<main>...</main>" }, ...].' };
	}
	if (raw.length > MAX_CANVAS_FRAMES) {
		return { error: `That is ${raw.length} frames; a canvas holds up to ${MAX_CANVAS_FRAMES}. Split it into canvases by flow.` };
	}
	const frames: ICanvasFrame[] = [];
	const taken = new Set<string>();
	const defaultKind = canvasFrameKind(args.kind ?? args.device);
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i] && typeof raw[i] === 'object' && defaultKind && !(raw[i] as Record<string, unknown>).kind && !(raw[i] as Record<string, unknown>).device ? { ...(raw[i] as object), kind: defaultKind } : raw[i];
		const frame = parseFrame(item, i, taken);
		if ('error' in frame) {
			return frame;
		}
		taken.add(frame.id);
		frames.push(frame);
	}
	const links = parseLinks(args.links ?? args.flows, frames);
	if ('error' in links) {
		return links;
	}
	const head = markup(args.head);
	const css = markup(args.css);
	const components = parseComponents(args.components);
	const create: ICanvasCreate = {
		title: text(args.title, 120) ?? 'Canvas',
		...(text(args.subtitle, 240) ? { subtitle: text(args.subtitle, 240) } : {}),
		...(themeOf(args.theme) ? { theme: themeOf(args.theme) } : {}),
		...(head ? { head } : {}),
		...(css ? { css } : {}),
		...(components ? { components } : {}),
		frames: layoutFrames(frames),
		links,
		...(args.pick === true || args.choose === true ? { pick: true } : {}),
	};
	const chars = canvasChars(create);
	if (chars > MAX_CANVAS_CHARS) {
		return { error: `The frames add up to ${chars.toLocaleString()} characters; the limit is ${MAX_CANVAS_CHARS.toLocaleString()}. Put shared markup in "components", "css" and "head".` };
	}
	return create;
}

/**
 * A mockups_render gallery as a variant board: one frame per option (a row per viewport when the
 * gallery has several), its shared head, css and template carried over, Choose on every frame and
 * the agent's pick badged. Pure.
 */
export function canvasFromMockups(raw: unknown): ICanvasCreate | { readonly error: string } {
	if (!raw || typeof raw !== 'object') {
		return { error: 'No mockups.' };
	}
	const data = raw as Record<string, unknown>;
	const options = Array.isArray(data.options) ? data.options as Record<string, unknown>[] : [];
	const viewports = (Array.isArray(data.viewports) ? data.viewports as Record<string, unknown>[] : []).slice(0, 3);
	if (!options.length) {
		return { error: 'No options.' };
	}
	const template = typeof data.template === 'string' ? data.template : '';
	const sizes = viewports.length ? viewports : [{ kind: 'desktop', width: 1280, height: 800 }];
	const kindOf = (kind: unknown): CanvasFrameKind => kind === 'phone' ? 'iphone' : kind === 'tablet' ? 'tablet' : kind === 'component' ? 'component' : 'browser';
	const frames: Record<string, unknown>[] = [];
	for (const viewport of sizes) {
		const kind = kindOf(viewport.kind);
		for (const option of options) {
			const letter = typeof option.id === 'string' ? option.id : '';
			const label = typeof option.label === 'string' ? option.label : letter;
			const html = typeof option.html === 'string' ? option.html : '';
			const body = /^\s*(?:<!doctype|<html)/i.test(html) || !template ? html : template.includes('{{option}}') ? template.split('{{option}}').join(html) : template + html;
			frames.push({
				id: frameSlug(`${letter} ${label}${sizes.length > 1 ? ` ${kind}` : ''}`),
				name: `${letter} \u00b7 ${label}`,
				kind,
				width: typeof viewport.width === 'number' ? viewport.width : undefined,
				height: typeof viewport.height === 'number' ? viewport.height : undefined,
				html: body,
				...(typeof option.css === 'string' ? { css: option.css } : {}),
				...(typeof option.note === 'string' ? { note: option.note } : {}),
				...(letter && letter === data.recommended ? { recommended: true } : {}),
				...(sizes.length > 1 && typeof viewport.label === 'string' ? { section: viewport.label } : {}),
			});
		}
	}
	// Components in a template were written for {{option}} only; the frames carry the full markup.
	return parseCanvasArgs({
		title: data.title,
		subtitle: data.subtitle,
		head: data.head,
		css: data.css,
		theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : undefined,
		pick: true,
		frames,
	});
}

//#endregion

//#region Layout

/** The height a frame takes on the board (content-height frames get a stand-in until measured). */
export function boardHeight(frame: Pick<ICanvasFrame, 'height' | 'width'>): number {
	return frame.height || Math.round(Math.min(900, Math.max(240, frame.width * 0.6)));
}

/**
 * Places frames that have no position: sections become rows (in the order they first appear),
 * frames sit left to right with room for arrows between them, rows stack below what is placed.
 */
export function layoutFrames(frames: readonly ICanvasFrame[], force = false): ICanvasFrame[] {
	const placed = force ? [] : frames.filter(frame => frame.x !== undefined && frame.y !== undefined);
	let top = placed.length ? Math.max(...placed.map(frame => (frame.y ?? 0) + boardHeight(frame))) + SECTION_GAP : 0;
	const rows = new Map<string, ICanvasFrame[]>();
	for (const frame of frames) {
		if (force || frame.x === undefined || frame.y === undefined) {
			const key = frame.section ?? '';
			rows.set(key, [...rows.get(key) ?? [], frame]);
		}
	}
	const positions = new Map<string, { x: number; y: number }>();
	for (const [section, row] of rows) {
		const y = top + (section ? SECTION_LABEL : 0);
		let x = 0;
		for (const frame of row) {
			positions.set(frame.id, { x, y });
			x += frame.width + FRAME_GAP;
		}
		top = y + Math.max(...row.map(boardHeight)) + SECTION_GAP;
	}
	return frames.map(frame => {
		const at = positions.get(frame.id);
		return at ? { ...frame, x: at.x, y: at.y } : frame;
	});
}

//#endregion

//#region Agent updates

export interface ICanvasUpdateResult {
	readonly doc: ICanvasDoc;
	/** One line per thing that changed, for the agent and the update card. */
	readonly changes: readonly string[];
	/** Frames whose look changed (to check for errors). */
	readonly touched: readonly string[];
}

export interface ICanvasEdit {
	readonly frame: string;
	readonly find: string;
	readonly replace: string;
	readonly all?: boolean;
	/** Edit the frame's `css` instead of its markup. */
	readonly css?: boolean;
}

function countOf(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

/** Finds a frame by id, slug or name. */
export function findFrame(doc: Pick<ICanvasDoc, 'frames'>, ref: unknown): ICanvasFrame | undefined {
	const value = typeof ref === 'string' ? ref.trim() : '';
	if (!value) {
		return undefined;
	}
	return doc.frames.find(frame => frame.id === value) ?? doc.frames.find(frame => frame.id === frameSlug(value)) ?? doc.frames.find(frame => frame.name.toLowerCase() === value.toLowerCase());
}

/**
 * Applies canvas_update's arguments: frames upserted by id (fields merge), find/replace edits on
 * one frame's markup or css, frames removed, links replaced or added, comments resolved with a
 * reply. Atomic: any error leaves the canvas as it was. Pure.
 */
export function applyCanvasUpdate(doc: ICanvasDoc, args: Record<string, unknown>, now = Date.now()): ICanvasUpdateResult | { readonly error: string } {
	let frames = [...doc.frames];
	const changes: string[] = [];
	const touched = new Set<string>();
	let shared: Partial<Pick<ICanvasDoc, 'title' | 'subtitle' | 'theme' | 'head' | 'css' | 'components' | 'pick'>> = {};

	const title = text(args.title, 120);
	if (title && title !== doc.title) {
		shared = { ...shared, title };
		changes.push(`renamed to "${title}"`);
	}
	if (args.subtitle !== undefined) {
		shared = { ...shared, subtitle: text(args.subtitle, 240) };
	}
	if (args.theme !== undefined) {
		shared = { ...shared, theme: themeOf(args.theme) };
		frames.forEach(frame => touched.add(frame.id));
	}
	if (args.pick !== undefined) {
		shared = { ...shared, pick: args.pick === true ? true : undefined };
	}
	for (const key of ['head', 'css'] as const) {
		if (args[key] !== undefined) {
			shared = { ...shared, [key]: markup(args[key]) };
			changes.push(`shared ${key}`);
			frames.forEach(frame => touched.add(frame.id));
		}
	}
	if (args.components !== undefined) {
		const next = { ...doc.components ?? {} };
		const raw = parseJsonish(args.components);
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			for (const [name, snippet] of Object.entries(raw as Record<string, unknown>)) {
				if (snippet === null || snippet === '') {
					delete next[name];
				} else if (typeof snippet === 'string' && /^[\w-]{1,40}$/.test(name)) {
					next[name] = snippet;
				}
				// Every frame that uses it changes.
				frames.filter(frame => (frame.html ?? '').includes(`{{${name}}}`)).forEach(frame => touched.add(frame.id));
			}
		}
		shared = { ...shared, components: Object.keys(next).length ? next : undefined };
		changes.push(`components ${Object.keys(raw && typeof raw === 'object' ? raw : {}).join(', ')}`);
	}

	// Frames: upsert by id.
	const rawFrames = parseJsonish(args.frames);
	if (rawFrames !== undefined) {
		if (!Array.isArray(rawFrames)) {
			return { error: '"frames" is a list of frames to add or change: [{ "id": "welcome", "html": "..." }].' };
		}
		const taken = new Set(frames.map(frame => frame.id));
		for (let i = 0; i < rawFrames.length; i++) {
			const item = rawFrames[i] as Record<string, unknown> | undefined;
			const previous = item ? findFrame({ frames }, item.id) ?? (item.id === undefined ? findFrame({ frames }, item.name) : undefined) : undefined;
			const frame = parseFrame(item, i, taken, previous);
			if ('error' in frame) {
				return frame;
			}
			if (previous) {
				frames = frames.map(other => other.id === previous.id ? frame : other);
				const what = Object.keys(item ?? {}).filter(key => key !== 'id').join(', ');
				changes.push(`${frame.id}: ${what || 'unchanged'}`);
			} else {
				if (frames.length >= MAX_CANVAS_FRAMES) {
					return { error: `A canvas holds up to ${MAX_CANVAS_FRAMES} frames.` };
				}
				taken.add(frame.id);
				frames.push(frame);
				changes.push(`added ${frame.id}`);
			}
			touched.add(frame.id);
		}
	}

	// Edits: find/replace in one frame.
	const rawEdits = parseJsonish(args.edits);
	if (rawEdits !== undefined) {
		if (!Array.isArray(rawEdits)) {
			return { error: '"edits" is a list: [{ "frame": "welcome", "find": "exact text", "replace": "new text" }].' };
		}
		const perFrame = new Map<string, number>();
		for (const raw of rawEdits) {
			const edit = raw as Record<string, unknown> | undefined;
			const frame = findFrame({ frames }, edit?.frame);
			if (!frame) {
				return { error: `Edit for unknown frame "${String(edit?.frame)}". Frames: ${frames.map(f => f.id).join(', ')}.` };
			}
			const find = typeof edit?.find === 'string' ? edit.find : typeof edit?.old === 'string' ? edit.old : '';
			const replace = typeof edit?.replace === 'string' ? edit.replace : typeof edit?.new === 'string' ? edit.new : undefined;
			if (!find || replace === undefined) {
				return { error: `Edit on ${frame.id} needs "find" (exact text in the frame) and "replace".` };
			}
			const field = edit?.css === true ? 'css' : 'html';
			const source = frame[field] ?? '';
			const count = countOf(source, find);
			if (!count) {
				const hint = source.length < 400 ? '' : ` Read it with ${'canvas_read'} {"frames": ["${frame.id}"]} if it changed.`;
				return { error: `Edit on ${frame.id}: "${find.slice(0, 80)}" is not in its ${field}.${hint}` };
			}
			if (count > 1 && edit?.all !== true) {
				return { error: `Edit on ${frame.id}: "${find.slice(0, 80)}" appears ${count} times; add surrounding text to make it unique, or "all": true.` };
			}
			const next = edit?.all === true ? source.split(find).join(replace) : source.replace(find, () => replace);
			frames = frames.map(other => other.id === frame.id ? { ...other, [field]: next } : other);
			perFrame.set(frame.id, (perFrame.get(frame.id) ?? 0) + 1);
			touched.add(frame.id);
		}
		for (const [id, count] of perFrame) {
			changes.push(`${id}: ${count} edit${count === 1 ? '' : 's'}`);
		}
	}

	// Removals.
	const rawRemove = parseJsonish(args.remove);
	if (rawRemove !== undefined) {
		const list = Array.isArray(rawRemove) ? rawRemove : [rawRemove];
		for (const ref of list) {
			const frame = findFrame({ frames }, ref);
			if (!frame) {
				return { error: `Cannot remove unknown frame "${String(ref)}".` };
			}
			frames = frames.filter(other => other.id !== frame.id);
			changes.push(`removed ${frame.id}`);
		}
	}
	if (!frames.length) {
		return { error: 'That would leave the canvas empty.' };
	}

	// Links: replace all, or add.
	let links = doc.links.filter(link => frames.some(frame => frame.id === link.from) && frames.some(frame => frame.id === link.to));
	if (args.links !== undefined) {
		const parsed = parseLinks(args.links, frames);
		if ('error' in parsed) {
			return parsed;
		}
		links = parsed;
		changes.push(`${parsed.length} link${parsed.length === 1 ? '' : 's'}`);
	}
	if (args.addLinks !== undefined || args.add_links !== undefined) {
		const parsed = parseLinks(args.addLinks ?? args.add_links, frames);
		if ('error' in parsed) {
			return parsed;
		}
		links = [...links.filter(link => !parsed.some(other => other.from === link.from && other.to === link.to && other.trigger === link.trigger)), ...parsed];
		changes.push(`+${parsed.length} link${parsed.length === 1 ? '' : 's'}`);
	}

	// Comments: resolve with a reply.
	let comments = doc.comments;
	const rawResolve = parseJsonish(args.resolve);
	if (rawResolve !== undefined) {
		const list = Array.isArray(rawResolve) ? rawResolve : [rawResolve];
		const resolved: string[] = [];
		for (const entry of list) {
			const id = typeof entry === 'string' ? entry : text((entry as Record<string, unknown> | undefined)?.comment ?? (entry as Record<string, unknown> | undefined)?.id, 20);
			const reply = typeof entry === 'object' && entry ? text((entry as Record<string, unknown>).reply, 600) : undefined;
			const target = comments.find(comment => comment.id === id);
			if (!target) {
				return { error: `No comment "${String(id)}". Open comments: ${comments.filter(c => c.status !== 'resolved').map(c => c.id).join(', ') || 'none'}.` };
			}
			comments = comments.map(comment => comment.id === target.id ? { ...comment, status: 'resolved' as const, ...(reply ? { reply } : {}) } : comment);
			resolved.push(target.id);
		}
		if (resolved.length) {
			changes.push(`resolved ${resolved.join(', ')}`);
		}
	}
	// Comments the agent leaves on frames (an explanation pinned to a spot).
	const rawNotes = parseJsonish(args.comment ?? args.notes);
	if (rawNotes !== undefined) {
		const list = Array.isArray(rawNotes) ? rawNotes : [rawNotes];
		for (const entry of list) {
			const note = entry as Record<string, unknown> | undefined;
			const frame = findFrame({ frames }, note?.frame);
			const body = text(note?.text, 600);
			if (!frame || !body) {
				return { error: 'An agent comment is { "frame": "<id>", "text": "...", "selector"?: "#cta" }.' };
			}
			const selector = text(note?.selector, 200);
			comments = [...comments, {
				id: nextCommentId(comments),
				anchor: { frame: frame.id, x: finite(note?.x) ?? 24, y: finite(note?.y) ?? 24, ...(selector ? { selector, fx: 1, fy: 0 } : {}) },
				text: body,
				status: 'open',
				author: 'agent',
				at: now,
			}];
		}
		changes.push(`${list.length} note${list.length === 1 ? '' : 's'}`);
	}
	// Drop comments on frames that are gone.
	comments = comments.filter(comment => frames.some(frame => frame.id === comment.anchor.frame));

	if (args.layout === 'auto' || args.relayout === true) {
		frames = layoutFrames(frames, true);
		changes.push('re-laid out');
	} else {
		frames = layoutFrames(frames);
	}

	const next: ICanvasDoc = {
		...doc,
		...shared,
		frames,
		links,
		comments,
		version: doc.version + (touched.size || changes.length ? 1 : 0),
		updatedAt: now,
		change: changes.join('; ').slice(0, 300) || doc.change,
	};
	const chars = canvasChars(next);
	if (chars > MAX_CANVAS_CHARS) {
		return { error: `That makes the canvas ${chars.toLocaleString()} characters; the limit is ${MAX_CANVAS_CHARS.toLocaleString()}. Remove frames or share markup through "components".` };
	}
	return { doc: next, changes, touched: [...touched] };
}

export function nextCommentId(comments: readonly ICanvasComment[]): string {
	let max = 0;
	for (const comment of comments) {
		const n = Number(comment.id.replace(/^c/, ''));
		if (Number.isFinite(n) && n > max) {
			max = n;
		}
	}
	return `c${max + 1}`;
}

//#endregion

//#region User edits from a view

/** Applies the user's frame moves and resizes from a view. Pure. */
export function applyCanvasLayout(doc: ICanvasDoc, layout: readonly ICanvasLayout[], now = Date.now()): ICanvasDoc {
	const byId = new Map(layout.map(entry => [entry.id, entry]));
	let changed = false;
	const frames = doc.frames.map(frame => {
		const entry = byId.get(frame.id);
		if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) {
			return frame;
		}
		const width = Math.round(Math.min(3840, Math.max(120, entry.width)));
		const height = frame.height === 0 && entry.height === 0 ? 0 : Math.round(Math.min(4000, Math.max(80, entry.height)));
		if (frame.x === entry.x && frame.y === entry.y && frame.width === width && frame.height === height) {
			return frame;
		}
		changed = true;
		return { ...frame, x: Math.round(entry.x), y: Math.round(entry.y), width, height };
	});
	return changed ? { ...doc, frames, updatedAt: now } : doc;
}

/** A comment from a view: new (no id or unknown id), edited, or with a new status. Pure. */
export function upsertCanvasComment(doc: ICanvasDoc, raw: Partial<ICanvasComment> & { readonly anchor?: ICanvasAnchor }, now = Date.now()): { doc: ICanvasDoc; comment: ICanvasComment } | undefined {
	const existing = raw.id ? doc.comments.find(comment => comment.id === raw.id) : undefined;
	const anchor = raw.anchor ?? existing?.anchor;
	if (!anchor || !doc.frames.some(frame => frame.id === anchor.frame)) {
		return undefined;
	}
	const comment: ICanvasComment = {
		id: existing?.id ?? nextCommentId(doc.comments),
		anchor: sanitizeAnchor(anchor),
		text: typeof raw.text === 'string' ? raw.text.slice(0, 4000) : existing?.text ?? '',
		status: raw.status === 'open' || raw.status === 'sent' || raw.status === 'resolved' ? raw.status : existing?.status ?? 'open',
		author: existing?.author ?? 'user',
		...(existing?.reply ? { reply: existing.reply } : {}),
		...(raw.tweaks ? { tweaks: raw.tweaks.slice(0, 24).map(tweak => ({ property: String(tweak.property).slice(0, 60), value: String(tweak.value).slice(0, 400), ...(tweak.before !== undefined ? { before: String(tweak.before).slice(0, 400) } : {}) })) } : existing?.tweaks ? { tweaks: existing.tweaks } : {}),
		at: existing?.at ?? now,
	};
	if (!comment.text.trim() && !comment.tweaks?.length) {
		return undefined;
	}
	const comments = existing ? doc.comments.map(other => other.id === comment.id ? comment : other) : [...doc.comments, comment].slice(-MAX_CANVAS_COMMENTS);
	return { doc: { ...doc, comments, updatedAt: now }, comment };
}

function sanitizeAnchor(anchor: ICanvasAnchor): ICanvasAnchor {
	const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
	const str = (value: unknown, max: number) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
	const out: Record<string, unknown> = { frame: String(anchor.frame), x: num(anchor.x) ?? 0, y: num(anchor.y) ?? 0 };
	for (const [key, max] of [['selector', 300], ['element', 120], ['text', 200], ['html', 1200]] as const) {
		const value = str(anchor[key], max);
		if (value) {
			out[key] = value;
		}
	}
	for (const key of ['w', 'h', 'fx', 'fy'] as const) {
		const value = num(anchor[key]);
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out as unknown as ICanvasAnchor;
}

export function removeCanvasComment(doc: ICanvasDoc, id: string, now = Date.now()): ICanvasDoc {
	return doc.comments.some(comment => comment.id === id) ? { ...doc, comments: doc.comments.filter(comment => comment.id !== id), updatedAt: now } : doc;
}

//#endregion

//#region Messages to the agent

/** `Welcome > button#start "Get started"` or `Pricing (region 320x140 at 24,410)`. */
export function anchorLabel(doc: Pick<ICanvasDoc, 'frames'>, anchor: ICanvasAnchor): string {
	const frame = doc.frames.find(other => other.id === anchor.frame);
	const name = frame ? `${frame.name} [${frame.id}]` : anchor.frame;
	if (anchor.element) {
		return `${name} \u203a ${anchor.element}`;
	}
	if (anchor.w && anchor.h) {
		return `${name} (region ${Math.round(anchor.w)}\u00d7${Math.round(anchor.h)} at ${Math.round(anchor.x)},${Math.round(anchor.y)})`;
	}
	return `${name} (at ${Math.round(anchor.x)},${Math.round(anchor.y)})`;
}

/**
 * The user's comments as one message to the agent: each with its id (to resolve), what it points at
 * (frame, element, selector, markup) and, for inspector tweaks, the exact property changes.
 */
export function formatCanvasFeedback(doc: ICanvasDoc, comments: readonly ICanvasComment[], extra?: string): string {
	const lines = [`Feedback on the design canvas "${doc.title}" (canvas ${doc.id}, v${doc.version}).`];
	if (extra?.trim()) {
		lines.push('', extra.trim());
	}
	lines.push('');
	comments.forEach((comment, index) => {
		lines.push(`${index + 1}. [${comment.id}] ${anchorLabel(doc, comment.anchor)}: ${comment.text.trim() || '(see tweaks)'}`);
		if (comment.anchor.selector) {
			lines.push(`   selector: ${comment.anchor.selector}`);
		}
		if (comment.anchor.html) {
			lines.push(`   markup: ${comment.anchor.html.slice(0, 400)}`);
		}
		for (const tweak of comment.tweaks ?? []) {
			lines.push(`   set ${tweak.property}: ${tweak.value}${tweak.before ? ` (was ${tweak.before})` : ''}`);
		}
	});
	lines.push('', `Answer questions in your reply. For change requests, patch the frames with canvas_update (prefer "edits" to rewriting a frame) and resolve each comment you handled: "resolve": [{ "comment": "c1", "reply": "what you did" }].`);
	return lines.join('\n');
}

/** The user's pick on a variant board. */
export function formatCanvasChoice(doc: ICanvasDoc, frameId: string, note?: string): string {
	const frame = doc.frames.find(other => other.id === frameId);
	const name = frame ? `"${frame.name}" [${frame.id}]` : frameId;
	return `I choose ${name} from the canvas "${doc.title}" (canvas ${doc.id}).${note?.trim() ? ` ${note.trim()}` : ''}`;
}

/** What the agent sees of a canvas: its frames, links and open comments (canvas_read, results). */
export function describeCanvas(doc: ICanvasDoc, options: { readonly frames?: readonly string[]; readonly all?: boolean } = {}): string {
	const lines = [`Canvas ${doc.id} "${doc.title}" v${doc.version}${doc.theme ? `, ${doc.theme}` : ''}${doc.pick ? ', variant board' : ''}.`];
	lines.push(`Frames (${doc.frames.length}):`);
	for (const frame of doc.frames) {
		const source = frame.url ? `url ${frame.url}` : frame.image ? 'image' : `${(frame.html?.length ?? 0).toLocaleString()} chars`;
		lines.push(`- ${frame.id} "${frame.name}" ${frame.kind} ${frame.width}\u00d7${frame.height || 'auto'} at ${Math.round(frame.x ?? 0)},${Math.round(frame.y ?? 0)}${frame.section ? ` [${frame.section}]` : ''}${frame.recommended ? ' (recommended)' : ''} \u00b7 ${source}`);
	}
	if (doc.links.length) {
		lines.push(`Links: ${doc.links.map(link => `${link.from}${link.trigger ? `(${link.trigger})` : ''}\u2192${link.to}`).join(', ')}`);
	}
	const open = doc.comments.filter(comment => comment.status !== 'resolved');
	if (open.length) {
		lines.push(`Open comments (${open.length}):`);
		for (const comment of open) {
			lines.push(`- [${comment.id}] ${comment.author === 'agent' ? '(yours) ' : ''}${anchorLabel(doc, comment.anchor)}: ${comment.text.replace(/\s+/g, ' ').slice(0, 300)}${comment.anchor.selector ? ` {${comment.anchor.selector}}` : ''}${comment.tweaks?.length ? ` tweaks: ${comment.tweaks.map(t => `${t.property}=${t.value}`).join('; ')}` : ''}`);
		}
	}
	if (doc.head || doc.css || doc.components) {
		lines.push(`Shared: ${[doc.head ? `head ${doc.head.length} chars` : '', doc.css ? `css ${doc.css.length} chars` : '', doc.components ? `components ${Object.keys(doc.components).join(', ')}` : ''].filter(Boolean).join(', ')}`);
	}
	const wanted = options.all ? doc.frames : doc.frames.filter(frame => options.frames?.some(ref => findFrame({ frames: [frame] }, ref)));
	for (const frame of wanted) {
		lines.push('', `<frame id="${frame.id}">`, frame.html ?? (frame.url ? `(live page ${frame.url})` : '(image)'), '</frame>');
		if (frame.css) {
			lines.push(`<frame-css id="${frame.id}">`, frame.css, '</frame-css>');
		}
	}
	if (options.all || options.frames?.length) {
		if (doc.css) {
			lines.push('', '<shared-css>', doc.css, '</shared-css>');
		}
		for (const [name, snippet] of Object.entries(doc.components ?? {})) {
			lines.push('', `<component name="${name}">`, snippet, '</component>');
		}
	}
	return lines.join('\n');
}

//#endregion

//#region Streaming

/**
 * What a canvas_render call has said so far while it streams in (partial JSON): its title and the
 * names of the frames it has started, for the placeholder ("Designing 3 screens: Welcome, ...").
 */
export function peekCanvasInput(partial: string): { readonly title?: string; readonly frames: readonly string[] } {
	const title = /"title"\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(partial)?.[1];
	const frames: string[] = [];
	const at = partial.search(/"frames"\s*:\s*\[/);
	if (at !== -1) {
		for (const match of partial.slice(at).matchAll(/"name"\s*:\s*"((?:[^"\\]|\\.){1,80})"/g)) {
			frames.push(match[1].replace(/\\(.)/g, '$1'));
			if (frames.length >= MAX_CANVAS_FRAMES) {
				break;
			}
		}
	}
	return { ...(title ? { title: title.replace(/\\(.)/g, '$1') } : {}), frames };
}

//#endregion
