/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isValidColor } from './scratchColor.js';
import {
	DEFAULT_SCRATCH_SETTINGS, IScratchAgentRun, IScratchBinding, IScratchBoardDocument, IScratchBoardMeta, IScratchBoardSettings,
	IScratchCamera, IScratchFolder, IScratchIndex, IScratchLabel, IScratchRect, SCRATCH_MAX_ZOOM, SCRATCH_MIN_ZOOM, SCRATCH_SCHEMA_VERSION,
	ScratchArrowhead, ScratchElement, ScratchPoint, ScratchPressurePoint,
} from './scratchTypes.js';
import { SHAPE_KINDS } from './scratchShapes.js';

/**
 * Reading saved boards never throws and never drops a whole board for one bad element: each
 * field falls back to a default, and only elements that cannot be drawn at all are left out
 * (and counted, so the store can keep the original file aside).
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min = -1e7, max = 1e7): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function str(v: unknown, fallback: string, maxLength = 2_000_000): string {
	return typeof v === 'string' ? (v.length > maxLength ? v.slice(0, maxLength) : v) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
	return typeof v === 'string' && (options as readonly string[]).includes(v) ? v as T : fallback;
}

function color(v: unknown, fallback: string): string {
	return typeof v === 'string' && isValidColor(v) ? v : fallback;
}

function point(v: unknown): ScratchPoint | undefined {
	if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && Number.isFinite(v[0]) && Number.isFinite(v[1])) {
		return [num(v[0], 0), num(v[1], 0)];
	}
	return undefined;
}

function pressurePoint(v: unknown): ScratchPressurePoint | undefined {
	const p = point(v);
	if (!p) {
		return undefined;
	}
	const pressure = Array.isArray(v) && typeof v[2] === 'number' && Number.isFinite(v[2]) ? Math.min(1, Math.max(0, v[2])) : 0.5;
	return [p[0], p[1], pressure];
}

const ARROWHEADS: readonly ScratchArrowhead[] = ['none', 'arrow', 'triangle', 'triangle-outline', 'dot', 'circle', 'bar', 'diamond', 'diamond-outline', 'crowfoot-one', 'crowfoot-many', 'crowfoot-one-or-many'];
const FONTS = ['hand', 'sans', 'serif', 'mono'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;

function label(v: unknown): IScratchLabel | null {
	if (!isObject(v)) {
		return null;
	}
	const html = str(v.html, '');
	if (!html) {
		return null;
	}
	return {
		html,
		fontFamily: oneOf(v.fontFamily, FONTS, 'hand'),
		fontSize: num(v.fontSize, 20, 4, 400),
		textAlign: oneOf(v.textAlign, ALIGNS, 'center'),
		verticalAlign: oneOf(v.verticalAlign, ['top', 'middle', 'bottom'] as const, 'middle'),
	};
}

function binding(v: unknown): IScratchBinding | null {
	if (!isObject(v) || typeof v.elementId !== 'string' || !v.elementId) {
		return null;
	}
	const anchor = point(v.anchor);
	return { elementId: v.elementId, anchor: anchor ? [Math.min(1, Math.max(0, anchor[0])), Math.min(1, Math.max(0, anchor[1]))] : null };
}

/** One element from JSON, or undefined when it cannot be drawn. */
export function parseElement(v: unknown): ScratchElement | undefined {
	if (!isObject(v) || typeof v.id !== 'string' || !v.id || typeof v.type !== 'string') {
		return undefined;
	}
	const base = {
		id: v.id,
		x: num(v.x, 0),
		y: num(v.y, 0),
		width: num(v.width, 0, 0, 1e6),
		height: num(v.height, 0, 0, 1e6),
		angle: num(v.angle, 0, -1000, 1000),
		stroke: color(v.stroke, '#1e1e1e'),
		fill: color(v.fill, 'transparent'),
		fillStyle: oneOf(v.fillStyle, ['hachure', 'cross-hatch', 'solid'] as const, 'hachure'),
		strokeWidth: num(v.strokeWidth, 2, 0, 64),
		strokeStyle: oneOf(v.strokeStyle, ['solid', 'dashed', 'dotted'] as const, 'solid'),
		roughness: num(v.roughness, 1, 0, 3),
		opacity: num(v.opacity, 100, 0, 100),
		roundness: oneOf(v.roundness, ['sharp', 'round'] as const, 'round'),
		seed: Math.floor(num(v.seed, 1, 0, 2 ** 31)),
		version: Math.floor(num(v.version, 1, 0, Number.MAX_SAFE_INTEGER)),
		updated: num(v.updated, 0, 0, Number.MAX_SAFE_INTEGER),
		groupIds: Array.isArray(v.groupIds) ? v.groupIds.filter((g): g is string => typeof g === 'string' && g.length > 0) : [],
		frameId: typeof v.frameId === 'string' && v.frameId ? v.frameId : null,
		locked: bool(v.locked, false),
		link: typeof v.link === 'string' && v.link ? v.link : null,
	};
	switch (v.type) {
		case 'shape':
			return { ...base, type: 'shape', shape: oneOf(v.shape, SHAPE_KINDS, 'rectangle'), label: label(v.label) };
		case 'line':
		case 'arrow': {
			const points = Array.isArray(v.points) ? v.points.map(point).filter((p): p is ScratchPoint => !!p) : [];
			if (points.length < 2) {
				return undefined;
			}
			return {
				...base,
				type: v.type,
				points,
				arrowType: oneOf(v.arrowType, ['sharp', 'round', 'elbow'] as const, 'sharp'),
				startArrowhead: oneOf(v.startArrowhead, ARROWHEADS, 'none'),
				endArrowhead: oneOf(v.endArrowhead, ARROWHEADS, v.type === 'arrow' ? 'arrow' : 'none'),
				startBinding: binding(v.startBinding),
				endBinding: binding(v.endBinding),
				label: label(v.label),
				closed: bool(v.closed, false),
			};
		}
		case 'draw': {
			const points = Array.isArray(v.points) ? v.points.map(pressurePoint).filter((p): p is ScratchPressurePoint => !!p) : [];
			if (!points.length) {
				return undefined;
			}
			return { ...base, type: 'draw', points, pen: oneOf(v.pen, ['pen', 'highlighter'] as const, 'pen'), simulatePressure: bool(v.simulatePressure, true) };
		}
		case 'text':
		case 'note':
		case 'card': {
			const rich = {
				html: str(v.html, ''),
				fontFamily: oneOf(v.fontFamily, FONTS, v.type === 'card' ? 'sans' : 'hand'),
				fontSize: num(v.fontSize, 20, 4, 400),
				textAlign: oneOf(v.textAlign, ALIGNS, 'left'),
			};
			if (v.type === 'text') {
				return { ...base, ...rich, type: 'text', autoSize: bool(v.autoSize, true) };
			}
			return v.type === 'note' ? { ...base, ...rich, type: 'note' } : { ...base, ...rich, type: 'card' };
		}
		case 'image': {
			const assetId = str(v.assetId, '');
			if (!/^[A-Za-z0-9._-]+$/.test(assetId)) {
				return undefined;
			}
			return {
				...base,
				type: 'image',
				assetId,
				mime: str(v.mime, 'image/png', 100),
				naturalWidth: num(v.naturalWidth, base.width, 0, 1e6),
				naturalHeight: num(v.naturalHeight, base.height, 0, 1e6),
			};
		}
		case 'icon': {
			const svg = str(v.svg, '', 500_000);
			if (!svg) {
				return undefined;
			}
			return { ...base, type: 'icon', iconId: str(v.iconId, '', 200), svg, tintable: bool(v.tintable, true), label: label(v.label) };
		}
		case 'frame':
			return { ...base, type: 'frame', name: str(v.name, 'Frame', 500) };
	}
	return undefined;
}

function parseSettings(v: unknown): IScratchBoardSettings {
	if (!isObject(v)) {
		return DEFAULT_SCRATCH_SETTINGS;
	}
	return {
		background: color(v.background, DEFAULT_SCRATCH_SETTINGS.background),
		grid: oneOf(v.grid, ['none', 'dots', 'lines'] as const, DEFAULT_SCRATCH_SETTINGS.grid),
		theme: oneOf(v.theme, ['auto', 'light', 'dark'] as const, DEFAULT_SCRATCH_SETTINGS.theme),
		snapToObjects: bool(v.snapToObjects, DEFAULT_SCRATCH_SETTINGS.snapToObjects),
		snapToGrid: bool(v.snapToGrid, DEFAULT_SCRATCH_SETTINGS.snapToGrid),
	};
}

function parseCamera(v: unknown): IScratchCamera | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	const camera: IScratchCamera = { x: num(v.x, 0), y: num(v.y, 0), zoom: num(v.zoom, 1, SCRATCH_MIN_ZOOM, SCRATCH_MAX_ZOOM) };
	const viewWidth = num(v.viewWidth, 0, 0, 1e5), viewHeight = num(v.viewHeight, 0, 0, 1e5);
	return viewWidth > 0 && viewHeight > 0 ? { ...camera, viewWidth, viewHeight } : camera;
}

function parseRect(v: unknown): IScratchRect {
	const o = isObject(v) ? v : {};
	return { x: num(o.x, 0), y: num(o.y, 0), width: num(o.width, 0, 0, 1e6), height: num(o.height, 0, 0, 1e6) };
}

function parseRun(v: unknown): IScratchAgentRun | undefined {
	if (!isObject(v) || typeof v.id !== 'string' || typeof v.sessionId !== 'string' || !v.sessionId) {
		return undefined;
	}
	return {
		id: v.id,
		sessionId: v.sessionId,
		elementIds: Array.isArray(v.elementIds) ? v.elementIds.filter((id): id is string => typeof id === 'string') : [],
		prompt: str(v.prompt, '', 100_000),
		modelLabel: typeof v.modelLabel === 'string' ? v.modelLabel : undefined,
		created: num(v.created, 0, 0, Number.MAX_SAFE_INTEGER),
		bounds: parseRect(v.bounds),
		hidden: v.hidden === true ? true : undefined,
	};
}

export interface IParsedBoard {
	readonly document: IScratchBoardDocument;
	/** Elements left out because they could not be read. */
	readonly dropped: number;
	/** From a newer Volt: saving it back could lose what this version does not know. */
	readonly newerSchema: boolean;
}

export function emptyBoardDocument(id: string, now = Date.now()): IScratchBoardDocument {
	return { schema: SCRATCH_SCHEMA_VERSION, id, elements: [], deleted: {}, settings: DEFAULT_SCRATCH_SETTINGS, camera: undefined, runs: [], revision: 0, updated: now };
}

export function parseBoardDocument(raw: unknown, id: string): IParsedBoard {
	if (!isObject(raw)) {
		return { document: emptyBoardDocument(id, 0), dropped: 0, newerSchema: false };
	}
	const rawElements = Array.isArray(raw.elements) ? raw.elements : [];
	const seen = new Set<string>();
	const elements: ScratchElement[] = [];
	let dropped = 0;
	for (const item of rawElements) {
		const el = parseElement(item);
		if (!el || seen.has(el.id)) {
			dropped++;
			continue;
		}
		seen.add(el.id);
		elements.push(el);
	}
	const deleted: Record<string, number> = {};
	if (isObject(raw.deleted)) {
		for (const [key, value] of Object.entries(raw.deleted)) {
			if (typeof value === 'number' && Number.isFinite(value) && !seen.has(key)) {
				deleted[key] = value;
			}
		}
	}
	const runs = Array.isArray(raw.runs) ? raw.runs.map(parseRun).filter((r): r is IScratchAgentRun => !!r) : [];
	const schema = num(raw.schema, SCRATCH_SCHEMA_VERSION, 0, 1e6);
	return {
		document: {
			schema: SCRATCH_SCHEMA_VERSION,
			id,
			elements,
			deleted,
			settings: parseSettings(raw.settings),
			camera: parseCamera(raw.camera),
			runs,
			revision: Math.floor(num(raw.revision, 0, 0, Number.MAX_SAFE_INTEGER)),
			updated: num(raw.updated, 0, 0, Number.MAX_SAFE_INTEGER),
		},
		dropped,
		newerSchema: schema > SCRATCH_SCHEMA_VERSION,
	};
}

/** Tombstones older than this are forgotten: every window has long since seen the delete. */
const TOMBSTONE_TTL_MS = 30 * 86_400_000;

export function serializeBoardDocument(doc: IScratchBoardDocument, now = Date.now()): string {
	const deleted: Record<string, number> = {};
	for (const [id, at] of Object.entries(doc.deleted)) {
		if (now - at < TOMBSTONE_TTL_MS) {
			deleted[id] = at;
		}
	}
	return JSON.stringify({ ...doc, schema: SCRATCH_SCHEMA_VERSION, deleted });
}

/**
 * Whether `theirs` (a copy on disk) already holds everything in `ours`: each of our elements as new
 * or newer (or deleted after it), each of our deletions, each of our agent runs. When it does not,
 * the window holding `ours` has to write again or its part is lost.
 */
export function documentCovers(theirs: Pick<IScratchBoardDocument, 'elements' | 'deleted' | 'runs'>, ours: { readonly elements: readonly ScratchElement[]; readonly deleted: ReadonlyMap<string, number>; readonly runs: readonly IScratchAgentRun[] }): boolean {
	const theirMap = new Map(theirs.elements.map(e => [e.id, e]));
	for (const mine of ours.elements) {
		const other = theirMap.get(mine.id);
		if (other) {
			if (other.updated < mine.updated || (other.updated === mine.updated && other.version < mine.version)) {
				return false;
			}
		} else if ((theirs.deleted[mine.id] ?? -1) < mine.updated) {
			return false;
		}
	}
	for (const [id, at] of ours.deleted) {
		const other = theirMap.get(id);
		if (other && other.updated <= at) {
			return false;
		}
	}
	const theirRuns = new Map(theirs.runs.map(r => [r.id, r]));
	return ours.runs.every(r => theirRuns.has(r.id) && (!r.hidden || theirRuns.get(r.id)!.hidden));
}

/**
 * Two copies of one board (ours in memory, theirs on disk from another window): per element the
 * newer `updated` wins, a deletion beats an older edit, our paint order wins for shared elements.
 */
export function mergeBoardDocuments(ours: IScratchBoardDocument, theirs: IScratchBoardDocument): IScratchBoardDocument {
	const deleted: Record<string, number> = { ...theirs.deleted };
	for (const [id, at] of Object.entries(ours.deleted)) {
		deleted[id] = Math.max(at, deleted[id] ?? 0);
	}
	const theirMap = new Map(theirs.elements.map(e => [e.id, e]));
	const ourIds = new Set(ours.elements.map(e => e.id));
	const out: ScratchElement[] = [];
	for (const mine of ours.elements) {
		const other = theirMap.get(mine.id);
		const pick = other && (other.updated > mine.updated || (other.updated === mine.updated && other.version > mine.version)) ? other : mine;
		const gone = deleted[mine.id];
		if (gone !== undefined && gone >= pick.updated) {
			continue;
		}
		out.push(pick);
	}
	// Elements only they have, placed after their nearest predecessor we kept.
	for (let i = 0; i < theirs.elements.length; i++) {
		const el = theirs.elements[i];
		if (ourIds.has(el.id)) {
			continue;
		}
		const gone = deleted[el.id];
		if (gone !== undefined && gone >= el.updated) {
			continue;
		}
		let at = out.length;
		for (let j = i - 1; j >= 0; j--) {
			const k = out.findIndex(e => e.id === theirs.elements[j].id);
			if (k >= 0) {
				at = k + 1;
				break;
			}
		}
		out.splice(at, 0, el);
	}
	for (const el of out) {
		delete deleted[el.id];
	}
	const runs = new Map(theirs.runs.map(r => [r.id, r]));
	for (const run of ours.runs) {
		const other = runs.get(run.id);
		runs.set(run.id, other?.hidden ? { ...run, hidden: true } : run);
	}
	return {
		...ours,
		elements: out,
		deleted,
		runs: [...runs.values()].sort((a, b) => a.created - b.created),
		settings: ours.updated >= theirs.updated ? ours.settings : theirs.settings,
		revision: Math.max(ours.revision, theirs.revision),
		updated: Math.max(ours.updated, theirs.updated),
	};
}

// ---- Board list ----------------------------------------------------------------------------

export function emptyIndex(): IScratchIndex {
	return { schema: SCRATCH_SCHEMA_VERSION, boards: [], folders: [], lastOpened: undefined, updated: 0 };
}

function parseBoardMeta(v: unknown): IScratchBoardMeta | undefined {
	if (!isObject(v) || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v.id)) {
		return undefined;
	}
	return {
		id: v.id,
		title: str(v.title, '', 500),
		folderId: typeof v.folderId === 'string' && v.folderId ? v.folderId : null,
		projectId: typeof v.projectId === 'string' && v.projectId ? v.projectId : undefined,
		pinned: bool(v.pinned, false),
		archived: bool(v.archived, false),
		created: num(v.created, 0, 0, Number.MAX_SAFE_INTEGER),
		edited: num(v.edited, 0, 0, Number.MAX_SAFE_INTEGER),
		updated: num(v.updated, 0, 0, Number.MAX_SAFE_INTEGER),
		deleted: v.deleted === true ? true : undefined,
		excerpt: typeof v.excerpt === 'string' ? v.excerpt.slice(0, 300) : undefined,
		elementCount: typeof v.elementCount === 'number' && Number.isFinite(v.elementCount) ? v.elementCount : undefined,
	};
}

function parseFolder(v: unknown): IScratchFolder | undefined {
	if (!isObject(v) || typeof v.id !== 'string' || !v.id) {
		return undefined;
	}
	return {
		id: v.id,
		name: str(v.name, 'Folder', 300),
		created: num(v.created, 0, 0, Number.MAX_SAFE_INTEGER),
		updated: num(v.updated, 0, 0, Number.MAX_SAFE_INTEGER),
		collapsed: v.collapsed === true ? true : undefined,
		deleted: v.deleted === true ? true : undefined,
	};
}

export function parseIndex(raw: unknown): IScratchIndex {
	if (!isObject(raw)) {
		return emptyIndex();
	}
	const boards = new Map<string, IScratchBoardMeta>();
	for (const item of Array.isArray(raw.boards) ? raw.boards : []) {
		const meta = parseBoardMeta(item);
		if (meta && !boards.has(meta.id)) {
			boards.set(meta.id, meta);
		}
	}
	const folders = new Map<string, IScratchFolder>();
	for (const item of Array.isArray(raw.folders) ? raw.folders : []) {
		const folder = parseFolder(item);
		if (folder && !folders.has(folder.id)) {
			folders.set(folder.id, folder);
		}
	}
	return {
		schema: SCRATCH_SCHEMA_VERSION,
		boards: [...boards.values()],
		folders: [...folders.values()],
		lastOpened: typeof raw.lastOpened === 'string' ? raw.lastOpened : undefined,
		updated: num(raw.updated, 0, 0, Number.MAX_SAFE_INTEGER),
	};
}

/** Per entry the newer `updated` wins; deleted entries stay as tombstones so a merge keeps them deleted. */
export function mergeIndexes(ours: IScratchIndex, theirs: IScratchIndex): IScratchIndex {
	const boards = new Map(theirs.boards.map(b => [b.id, b]));
	for (const board of ours.boards) {
		const other = boards.get(board.id);
		if (!other || board.updated >= other.updated) {
			// Content edits come from the board file; keep the later of the two either way.
			boards.set(board.id, other ? { ...board, edited: Math.max(board.edited, other.edited) } : board);
		} else {
			boards.set(board.id, { ...other, edited: Math.max(board.edited, other.edited) });
		}
	}
	const folders = new Map(theirs.folders.map(f => [f.id, f]));
	for (const folder of ours.folders) {
		const other = folders.get(folder.id);
		if (!other || folder.updated >= other.updated) {
			folders.set(folder.id, folder);
		}
	}
	return {
		schema: SCRATCH_SCHEMA_VERSION,
		boards: [...boards.values()],
		folders: [...folders.values()],
		lastOpened: ours.updated >= theirs.updated ? ours.lastOpened : theirs.lastOpened,
		updated: Math.max(ours.updated, theirs.updated),
	};
}
