/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../base/common/hash.js';
import { normalize } from '../../../base/common/path.js';
import { IVoltStorageEntry, IVoltStorageItem, IVoltStorageWorktreeRef, VoltStorageId, VoltStorageKeep } from './voltStorage.js';

/**
 * Pure rules for Volt's storage cleanup: what each row covers and which of its entries Clean may
 * remove. The node service measures and deletes; everything decided here is unit tested.
 */

/** Where Volt keeps things on this machine. */
export interface IVoltStorageLayout {
	readonly userDataPath: string;
	/** `<userData>/User`. */
	readonly userRoamingPath: string;
	/** This session's logs folder (`<userData>/logs/<session>`). */
	readonly logsSessionPath: string;
	/** `~/.volt/worktrees`. */
	readonly worktreesRoot: string;
	/** The build's commit; its CachedData folder is in use. Undefined in dev builds. */
	readonly commit?: string;
}

export interface IStorageRowSpec {
	readonly id: VoltStorageId;
	readonly roots: readonly string[];
	/**
	 * `children`: each child of the roots is an entry. `files`: crash reports, one entry per file
	 * below the roots. `whole`: the row is cleaned at once (through Electron for live caches).
	 * `info`: shown, never cleaned.
	 */
	readonly unit: 'children' | 'files' | 'whole' | 'info';
	readonly keep?: VoltStorageKeep;
}

function join(...parts: string[]): string {
	return normalize(parts.join('/'));
}

export function machineRows(layout: IVoltStorageLayout): IStorageRowSpec[] {
	const data = layout.userDataPath;
	const user = layout.userRoamingPath;
	return [
		{ id: 'logs', roots: [join(data, 'logs')], unit: 'children' },
		{ id: 'crashDumps', roots: [join(data, 'Crashpad', 'completed'), join(data, 'Crashpad', 'pending'), join(data, 'Crashpad', 'new')], unit: 'files' },
		{ id: 'cachedData', roots: [join(data, 'CachedData')], unit: 'children' },
		{ id: 'chromiumCache', roots: [join(data, 'Cache')], unit: 'whole' },
		{ id: 'codeCache', roots: [join(data, 'Code Cache')], unit: 'whole' },
		// The GPU process holds these open for as long as the app runs.
		{ id: 'gpuCache', roots: [join(data, 'GPUCache'), join(data, 'DawnGraphiteCache'), join(data, 'DawnWebGPUCache'), join(data, 'ShaderCache')], unit: 'info', keep: 'inUse' },
		{ id: 'workspaceStorage', roots: [join(user, 'workspaceStorage')], unit: 'children' },
		{ id: 'chatHistory', roots: [join(user, 'agentSessions')], unit: 'info' },
		{ id: 'agentTraces', roots: [join(user, 'voltTraces')], unit: 'children' },
		{ id: 'nativeTranscripts', roots: [join(user, 'voltNative')], unit: 'children' },
		{ id: 'worktrees', roots: [layout.worktreesRoot], unit: 'children' },
		{ id: 'checkpoints', roots: [join(data, 'volt-checkpoints')], unit: 'children' },
		{ id: 'runGroups', roots: [join(user, 'voltRunGroups')], unit: 'info', keep: 'managed' },
		{ id: 'browserCache', roots: [join(data, 'Partitions', 'volt-browser', 'Cache'), join(data, 'Partitions', 'volt-browser', 'Code Cache')], unit: 'whole' },
		{ id: 'browserData', roots: [join(data, 'Partitions', 'volt-browser')], unit: 'whole' },
	];
}

/** Every log folder but this session's. */
export function logKeep(path: string, layout: IVoltStorageLayout): VoltStorageKeep | undefined {
	return normalize(path) === normalize(layout.logsSessionPath) ? 'current' : undefined;
}

/** Old builds' code caches go; this build's stays. */
export function cachedDataKeep(name: string, commit: string | undefined): VoltStorageKeep | undefined {
	return commit && name === commit ? 'current' : undefined;
}

/** A trace is diagnostics only; a running chat's trace is still being written. */
export function traceKeep(fileName: string, runningSessionIds: ReadonlySet<string>): VoltStorageKeep | undefined {
	const id = sessionIdFromFile(fileName);
	return id && runningSessionIds.has(id) ? 'open' : undefined;
}

/** A native transcript lets a chat continue where its model left off; only deleted chats' go. */
export function nativeTranscriptKeep(fileName: string, sessionIds: ReadonlySet<string>): VoltStorageKeep | undefined {
	const id = sessionIdFromFile(fileName);
	return !id || sessionIds.has(id) ? 'exists' : undefined;
}

/** `agent-<uuid>.jsonl` / `.json` / `.draft.json` → `agent-<uuid>`. */
export function sessionIdFromFile(fileName: string): string | undefined {
	const match = /^(agent-[0-9a-f-]{8,})(?:\.draft)?\.jsonl?$/i.exec(fileName);
	return match?.[1];
}

/**
 * The folder or workspace file a workspace storage entry belongs to, from its `workspace.json`
 * (`{ "folder": "file:///…" }` or `{ "workspace": "file:///….code-workspace" }`).
 */
export function workspaceStorageTarget(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as { folder?: unknown; workspace?: unknown };
		const value = typeof parsed.folder === 'string' ? parsed.folder : typeof parsed.workspace === 'string' ? parsed.workspace : undefined;
		return value;
	} catch {
		return undefined;
	}
}

/**
 * Machine-wide, only entries whose folder is gone (or that point nowhere) are cleaned; one for a
 * folder that still exists is cleaned from that project. An entry a window has open never goes.
 */
export function workspaceStorageKeep(id: string, target: string | undefined, targetExists: boolean, openIds: ReadonlySet<string>, forProject = false): VoltStorageKeep | undefined {
	if (openIds.has(id)) {
		return 'open';
	}
	if (forProject) {
		return undefined;
	}
	if (target && !target.startsWith('file:')) {
		// Remote and virtual folders cannot be checked from here.
		return 'exists';
	}
	return target && targetExists ? 'exists' : undefined;
}

/** `file:///a/b%20c` → `/a/b c`; undefined for other schemes. */
export function fileUriToPath(uri: string): string | undefined {
	if (!uri.startsWith('file://')) {
		return undefined;
	}
	try {
		let path = decodeURIComponent(uri.slice('file://'.length).replace(/^[^/]*/, ''));
		// file:///c%3A/x on Windows.
		if (/^\/[a-zA-Z]:/.test(path)) {
			path = path.slice(1);
		}
		return path;
	} catch {
		return undefined;
	}
}

/**
 * A Volt worktree stays while an open (not archived) chat runs in it, or while it has uncommitted
 * changes (`dirty`), or when git could not tell (`dirty === undefined`). Only clean ones of this
 * profile's archived chats go: the worktree folder is shared by every Volt app and profile, so a
 * checkout no chat here knows may belong to another one.
 */
export function worktreeKeep(path: string, refs: readonly IVoltStorageWorktreeRef[], dirty: boolean | undefined): VoltStorageKeep | undefined {
	const target = samePathKey(path);
	const mine = refs.filter(ref => samePathKey(ref.path) === target);
	if (mine.some(ref => !ref.archived)) {
		return 'inUse';
	}
	if (!mine.length) {
		return 'foreign';
	}
	if (dirty === undefined) {
		return 'unknown';
	}
	return dirty ? 'dirty' : undefined;
}

/** Normalized, without a trailing separator, for comparing two spellings of a folder. */
export function samePathKey(path: string): string {
	const normalized = normalize(path);
	return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
}

/** The folder under `~/.volt/worktrees` holding a repository's worktrees (same key the worktree service uses). */
export function worktreeRepoKey(commonDir: string): string {
	return hash(normalize(commonDir)).toString(36);
}

/** A checkpoint store for a folder that is gone can go; one for a folder that is still there is cleaned from its project. */
export function checkpointKeep(workTreeExists: boolean | undefined): VoltStorageKeep | undefined {
	return workTreeExists === false ? undefined : 'exists';
}

/** The row's totals from its entries. Rows without entries (whole/info) pass their measured size. */
export function summarizeRow(spec: Pick<IStorageRowSpec, 'id' | 'roots' | 'unit' | 'keep'>, bytes: number, entries: readonly IVoltStorageEntry[]): IVoltStorageItem {
	const cleanable = spec.unit !== 'info' && !spec.keep;
	let cleanableBytes = 0;
	if (cleanable) {
		cleanableBytes = spec.unit === 'whole' ? bytes : entries.reduce((sum, entry) => sum + (entry.keep ? 0 : entry.bytes), 0);
	}
	return { id: spec.id, roots: spec.roots, bytes, cleanableBytes, entries, cleanable, keep: spec.keep };
}

/** The browser's site data row excludes its cache, which has a row of its own. */
export function browserDataBytes(partitionBytes: number, cacheBytes: number): number {
	return Math.max(0, partitionBytes - cacheBytes);
}

/** Bytes as the UI shows them: 0 B, 812 KB, 4.2 MB, 1.31 GB (decimal units, like Finder). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : unit >= 3 ? 2 : 1;
	return `${value.toFixed(digits)} ${units[unit]}`;
}
