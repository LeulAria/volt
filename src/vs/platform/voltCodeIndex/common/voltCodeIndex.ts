/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Volt's code index: a trigram index of every project's text files, kept on disk and fresh
 * through a file watcher, so an agent's grep answers in milliseconds instead of re-reading the
 * whole tree with ripgrep (Cursor's "Instant Grep", GitHub Blackbird's masks). The index only
 * picks candidate files; matches always come from the files as they are on disk now, so a
 * result is never stale. Anything it cannot answer exactly says `fallback` and the caller runs
 * ripgrep as before.
 *
 * It runs in its own process, started on first use and stopped when idle, so neither the
 * workbench nor the main process holds index memory.
 */
export const IVoltCodeIndexService = createDecorator<IVoltCodeIndexService>('voltCodeIndexService');
export const VOLT_CODE_INDEX_CHANNEL_NAME = 'voltCodeIndex';

export interface IVoltCodeIndexOptions {
	/** Apply `.voltignore` / `.cursorignore` files in subfolders too, not only at the root. */
	readonly hierarchicalIgnore?: boolean;
	/** Do not follow symbolic links while listing the project's files. */
	readonly ignoreSymlinks?: boolean;
}

export type VoltCodeIndexState = 'none' | 'indexing' | 'ready' | 'error';

export interface IVoltCodeIndexStatus {
	readonly root: string;
	readonly state: VoltCodeIndexState;
	/** Files whose text is indexed. */
	readonly files: number;
	/** Bytes of text indexed. */
	readonly bytes: number;
	/** Size of the index on disk. */
	readonly diskBytes: number;
	readonly symbols: number;
	/** Changed files waiting to be indexed again (searched directly until then). */
	readonly pending: number;
	readonly progress?: { readonly done: number; readonly total: number };
	readonly updatedAt?: number;
	readonly lastUsedAt?: number;
	readonly error?: string;
	/** Duration of the last indexed search, for the settings page. */
	readonly lastSearchMs?: number;
}

export interface IVoltCodeIndexQueryBase {
	/** The indexed folder (a project or a worktree), absolute. */
	readonly root: string;
	/** Search only below this absolute folder inside `root`. */
	readonly folder?: string;
	readonly options?: IVoltCodeIndexOptions;
	/**
	 * How long to wait for an index that is still being built or brought up to date before
	 * answering `fallback`. Default 0: never wait for a first build.
	 */
	readonly waitMs?: number;
}

export interface IVoltCodeIndexSearchRequest extends IVoltCodeIndexQueryBase {
	readonly pattern: string;
	readonly isRegExp: boolean;
	readonly caseSensitive: boolean;
	readonly multiline: boolean;
	readonly wholeWord?: boolean;
	/** Globs over root-relative paths; a file must match one. */
	readonly includes?: readonly string[];
	/** Globs over root-relative paths; a file matching one is skipped. */
	readonly excludes?: readonly string[];
	/** Lines of context around each match (0-5). */
	readonly context?: number;
	/** Stop after this many matching lines; `limitHit` says more exist. */
	readonly maxMatches: number;
	readonly maxLineChars?: number;
}

export interface IVoltCodeIndexLine {
	/** 1-based. */
	readonly line: number;
	readonly text: string;
	readonly match: boolean;
}

export interface IVoltCodeIndexFileHits {
	/** Root-relative, `/`-separated. */
	readonly path: string;
	readonly matches: number;
	readonly lines: readonly IVoltCodeIndexLine[];
}

export interface IVoltCodeIndexSearchStats {
	/** Files the index could not rule out. */
	readonly candidates: number;
	/** Files actually read. */
	readonly scanned: number;
	readonly indexedFiles: number;
	readonly ms: number;
	/** `index`: read in this process; `ripgrep`: the candidates were handed to ripgrep. */
	readonly engine: 'index' | 'ripgrep';
}

export type IVoltCodeIndexSearchResult =
	| { readonly kind: 'fallback'; readonly reason: string }
	| { readonly kind: 'results'; readonly files: readonly IVoltCodeIndexFileHits[]; readonly limitHit: boolean; readonly stats: IVoltCodeIndexSearchStats };

export interface IVoltCodeIndexFilesRequest extends IVoltCodeIndexQueryBase {
	/** Glob over root-relative paths, e.g. `src/**\/*.ts` or `**\/package.json`. */
	readonly pattern: string;
	readonly limit: number;
}

export type IVoltCodeIndexFilesResult =
	| { readonly kind: 'fallback'; readonly reason: string }
	| { readonly kind: 'results'; readonly paths: readonly string[]; readonly limitHit: boolean };

/** Which engine answers fuzzy file searches. `auto`: FFF when it is installed, else the index. */
export type VoltFffMode = 'auto' | 'off';

export interface IVoltCodeIndexFindFilesRequest extends IVoltCodeIndexQueryBase {
	/**
	 * Words of a file name or path, typos allowed: `rootIndx` finds `rootIndex.ts`, `sched fair`
	 * finds `kernel/sched/fair.c`. Each word narrows the results.
	 */
	readonly query: string;
	readonly limit: number;
	readonly fff?: VoltFffMode;
	/** An FFF binary to use instead of Volt's own install or the one on PATH. */
	readonly fffPath?: string;
}

export type IVoltCodeIndexFindFilesResult =
	| { readonly kind: 'fallback'; readonly reason: string }
	| {
		readonly kind: 'results';
		/** Root-relative, best first. */
		readonly paths: readonly string[];
		/** More files matched than `limit`. */
		readonly limitHit: boolean;
		readonly engine: 'fff' | 'index';
		readonly ms: number;
		/** Why FFF did not answer, when it was asked to. */
		readonly fffSkipped?: string;
	};

/** FFF (github.com/dmtrKovalenko/fff), the optional engine for fuzzy file search. */
export interface IVoltFffStatus {
	readonly state: 'ready' | 'missing' | 'error' | 'unsupported';
	readonly version?: string;
	readonly path?: string;
	/** Installed by Volt (in its user data folder), not found on PATH or set in settings. */
	readonly managed?: boolean;
	/** The version Volt installs. */
	readonly bundledVersion: string;
	readonly error?: string;
	/** Projects with an FFF process running now. */
	readonly running: number;
}

export type VoltCodeSymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'constant' | 'module' | 'struct' | 'trait' | 'macro' | 'field';

export interface IVoltCodeSymbol {
	readonly name: string;
	readonly kind: VoltCodeSymbolKind;
	/** Root-relative, `/`-separated. */
	readonly path: string;
	/** 1-based. */
	readonly line: number;
	/** 1-based column of the name on its line. */
	readonly column?: number;
	/** The declaring line, trimmed. */
	readonly text: string;
}

export interface IVoltCodeIndexSymbolsRequest extends IVoltCodeIndexQueryBase {
	/** The name to look for; `*` lists every symbol (with `path`, a file's outline). */
	readonly query: string;
	/** `exact` (default), `prefix`, or `fuzzy` (camel-case and substring). */
	readonly match?: 'exact' | 'prefix' | 'fuzzy';
	readonly kinds?: readonly VoltCodeSymbolKind[];
	/** Only symbols in files under this root-relative path. */
	readonly path?: string;
	readonly limit: number;
}

export type IVoltCodeIndexSymbolsResult =
	| { readonly kind: 'fallback'; readonly reason: string }
	| { readonly kind: 'results'; readonly symbols: readonly IVoltCodeSymbol[]; readonly limitHit: boolean };

//#region Language server budget

/**
 * Every project in Volt is its own workbench, and a parked one keeps its extension host (and
 * with it tsserver, rust-analyzer, ...) running. The budget keeps language servers running in
 * at most N projects: the one on screen, ones with an agent at work, then the most recently used.
 */
export interface IVoltWorkspaceActivity {
	readonly windowId: number;
	/** A remote (SSH, container) window: counted against the remote limit. */
	readonly remote: boolean;
	/** On screen and focused right now. */
	readonly active: boolean;
	/** An agent is working in it. */
	readonly busy: boolean;
	readonly closed?: boolean;
}

export interface IVoltLspLimits {
	readonly enabled: boolean;
	readonly maxLocal: number;
	readonly maxRemote: number;
}

export interface IVoltLspBudget {
	/** Windows allowed to run language servers. */
	readonly allowed: readonly number[];
}

//#endregion

export interface IVoltCodeIndexService {
	readonly _serviceBrand: undefined;

	/** Fires when the set of windows allowed to run language servers changes. */
	readonly onDidChangeLspBudget: Event<IVoltLspBudget>;

	/** Builds or loads the index of `root` and starts keeping it fresh. Returns at once. */
	warm(root: string, options?: IVoltCodeIndexOptions): Promise<void>;
	search(request: IVoltCodeIndexSearchRequest): Promise<IVoltCodeIndexSearchResult>;
	files(request: IVoltCodeIndexFilesRequest): Promise<IVoltCodeIndexFilesResult>;
	/** Fuzzy, typo-tolerant file search by name or path: FFF when installed, else the index. */
	findFiles(request: IVoltCodeIndexFindFilesRequest): Promise<IVoltCodeIndexFindFilesResult>;
	symbols(request: IVoltCodeIndexSymbolsRequest): Promise<IVoltCodeIndexSymbolsResult>;
	/** Whether FFF is installed and where. `fffPath` is the user's setting, if any. */
	fffStatus(fffPath?: string): Promise<IVoltFffStatus>;
	/** Downloads Volt's pinned FFF release into the user data folder, checking its SHA-256. */
	installFff(): Promise<IVoltFffStatus>;
	/** The given roots, or every index on disk. */
	status(roots?: readonly string[]): Promise<readonly IVoltCodeIndexStatus[]>;
	/** Throws the index of `root` away and builds it again. */
	rebuild(root: string, options?: IVoltCodeIndexOptions): Promise<void>;
	/** Deletes the index of `root`, or every index. */
	remove(root?: string): Promise<void>;

	/** A workbench says what it is doing; the answer is the current budget. */
	reportWorkspaceActivity(activity: IVoltWorkspaceActivity, limits: IVoltLspLimits): Promise<IVoltLspBudget>;
}

/** For the agent server's browser pages and tests: no index, every query falls back to ripgrep. */
export class NullVoltCodeIndexService implements IVoltCodeIndexService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeLspBudget: Event<IVoltLspBudget> = Event.None;
	async warm(): Promise<void> { }
	async search(): Promise<IVoltCodeIndexSearchResult> { return { kind: 'fallback', reason: 'unavailable' }; }
	async files(): Promise<IVoltCodeIndexFilesResult> { return { kind: 'fallback', reason: 'unavailable' }; }
	async findFiles(): Promise<IVoltCodeIndexFindFilesResult> { return { kind: 'fallback', reason: 'unavailable' }; }
	async symbols(): Promise<IVoltCodeIndexSymbolsResult> { return { kind: 'fallback', reason: 'unavailable' }; }
	async fffStatus(): Promise<IVoltFffStatus> { return { state: 'unsupported', bundledVersion: '', running: 0 }; }
	async installFff(): Promise<IVoltFffStatus> { return { state: 'unsupported', bundledVersion: '', running: 0 }; }
	async status(): Promise<readonly IVoltCodeIndexStatus[]> { return []; }
	async rebuild(): Promise<void> { }
	async remove(): Promise<void> { }
	async reportWorkspaceActivity(activity: IVoltWorkspaceActivity): Promise<IVoltLspBudget> { return { allowed: [activity.windowId] }; }
}
