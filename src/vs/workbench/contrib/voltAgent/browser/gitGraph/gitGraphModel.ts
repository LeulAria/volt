/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { rot } from '../../../../../base/common/numbers.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ColorIdentifier } from '../../../../../platform/theme/common/colorUtils.js';
import { colorRegistry, compareHistoryItemRefs, historyItemRefColor } from '../../../scm/browser/scmHistory.js';
import { ISCMHistoryItem, ISCMHistoryItemGraphNode, ISCMHistoryItemRef, ISCMHistoryItemViewModel, ISCMHistoryProvider } from '../../../scm/common/history.js';
import { ISCMRepository } from '../../../scm/common/scm.js';
import { detectCodingAgents, IGitCodingAgent } from '../../common/gitAgentAttribution.js';

export interface IGitGraphCommitRow {
	readonly kind: 'commit';
	readonly vm: ISCMHistoryItemViewModel;
	/** Coding agents the commit's trailers name; empty for most commits. */
	readonly agents: readonly IGitCodingAgent[];
	/** Shown as a search result: no lanes, since results are not contiguous history. */
	readonly flat: boolean;
}

export interface IGitGraphWorkingTreeRow {
	readonly kind: 'wip';
	readonly files: number;
}

export type GitGraphRow = IGitGraphCommitRow | IGitGraphWorkingTreeRow;

/** Which refs the graph walks: everything, the current branch with its upstream and base, or one ref. */
export type GitGraphScope = { readonly kind: 'all' } | { readonly kind: 'current' } | { readonly kind: 'ref'; readonly id: string };

export const enum GitGraphChange {
	/** Rows replaced (new repository, scope, query or a ref moved). */
	Reset,
	/** Rows added at the end. */
	Append,
	/** Loading state or the working tree count changed. */
	State,
}

const GRAPH_PAGE = 150;
const SEARCH_PAGE = 100;
/** How far `reveal` pages in looking for a commit before the editor falls back to a SHA search. */
const REVEAL_LIMIT = 1000;

/**
 * Lays out lanes a page at a time, carrying the last row's lanes and the color rotation across
 * pages, so loading more never moves or recolors rows already on screen. Same lane rules as the
 * SCM view's `toISCMHistoryItemViewModelArray`; lane nodes are shared, not cloned.
 */
export class GitGraphLaneBuilder {
	private colorIndex = -1;
	private lanes: readonly ISCMHistoryItemGraphNode[] = [];
	private readonly loaded = new Map<string, ISCMHistoryItem>();

	constructor(
		private readonly colorMap: ReadonlyMap<string, ColorIdentifier | undefined>,
		private readonly current?: ISCMHistoryItemRef,
		private readonly remote?: ISCMHistoryItemRef,
		private readonly base?: ISCMHistoryItemRef,
	) { }

	append(items: readonly ISCMHistoryItem[]): ISCMHistoryItemViewModel[] {
		for (const item of items) {
			this.loaded.set(item.id, item);
		}
		const result: ISCMHistoryItemViewModel[] = [];
		for (const item of items) {
			const inputSwimlanes = this.lanes;
			const outputSwimlanes: ISCMHistoryItemGraphNode[] = [];
			let firstParentAdded = false;

			if (item.parentIds.length > 0) {
				for (const node of inputSwimlanes) {
					if (node.id === item.id) {
						if (!firstParentAdded) {
							outputSwimlanes.push({ id: item.parentIds[0], color: this.labelColor(item) ?? node.color });
							firstParentAdded = true;
						}
						continue;
					}
					outputSwimlanes.push(node);
				}
			}

			for (let i = firstParentAdded ? 1 : 0; i < item.parentIds.length; i++) {
				let color: ColorIdentifier | undefined;
				if (i === 0) {
					color = this.labelColor(item);
				} else {
					const parent = this.loaded.get(item.parentIds[i]);
					color = parent ? this.labelColor(parent) : undefined;
				}
				if (!color) {
					this.colorIndex = rot(this.colorIndex + 1, colorRegistry.length);
					color = colorRegistry[this.colorIndex];
				}
				outputSwimlanes.push({ id: item.parentIds[i], color });
			}

			const inputIndex = inputSwimlanes.findIndex(node => node.id === item.id);
			const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
			const circleColor = circleIndex < outputSwimlanes.length ? outputSwimlanes[circleIndex].color
				: circleIndex < inputSwimlanes.length ? inputSwimlanes[circleIndex].color : historyItemRefColor;

			const references = (item.references ?? []).map(ref => {
				let color = this.colorMap.get(ref.id);
				if (this.colorMap.has(ref.id) && color === undefined) {
					color = circleColor;
				}
				return { ...ref, color };
			});
			references.sort((a, b) => compareHistoryItemRefs(a, b, this.current, this.remote, this.base));

			result.push({
				historyItem: { ...item, references },
				isCurrent: item.id === this.current?.revision,
				inputSwimlanes: inputSwimlanes as ISCMHistoryItemGraphNode[],
				outputSwimlanes,
			});
			this.lanes = outputSwimlanes;
		}
		return result;
	}

	private labelColor(item: ISCMHistoryItem): ColorIdentifier | undefined {
		for (const ref of item.references ?? []) {
			const color = this.colorMap.get(ref.id);
			if (color !== undefined) {
				return color;
			}
		}
		return undefined;
	}
}

/**
 * One repository's commits for the Git Graph tab: pages from the SCM history provider (the git
 * extension, so no second git layer), lanes laid out incrementally, agents read from trailers.
 * Reloads when refs move, only while someone is looking (`setVisible`).
 */
export class GitGraphModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<GitGraphChange>());
	readonly onDidChange: Event<GitGraphChange> = this._onDidChange.event;

	private _rows: GitGraphRow[] = [];
	private _commitIds = new Map<string, number>();
	private _loading = false;
	private _hasMore = true;
	private _error: string | undefined;
	private _query = '';
	private _scope: GitGraphScope;
	private _workingTreeFiles = 0;
	private _refs: readonly ISCMHistoryItemRef[] = [];
	private visible = true;
	private stale = false;

	private builder: GitGraphLaneBuilder | undefined;
	private fetched = 0;
	private refIds: string[] = [];
	/** Refs are read once and kept across searches; only a ref moving or a new scope reads them again. */
	private refsStale = true;
	private refsVersion = 0;
	private laneSetup: { colorMap: Map<string, ColorIdentifier | undefined>; current?: ISCMHistoryItemRef; remote?: ISCMHistoryItemRef; base?: ISCMHistoryItemRef } | undefined;
	private readonly request = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly providerStore = this._register(new DisposableStore());
	private readonly reloadSoon = this._register(new RunOnceScheduler(() => this.reload(), 250));

	constructor(readonly repository: ISCMRepository, scope: GitGraphScope) {
		super();
		this._scope = scope;
		const provider = repository.provider;
		this._register(provider.onDidChangeResources(() => this.updateWorkingTree()));
		this.updateWorkingTree(false);

		// The history provider shows up once the git extension has activated; refs moving reloads.
		let first = true;
		this._register(autorun(reader => {
			const history = provider.historyProvider.read(reader);
			this.providerStore.clear();
			if (!history) {
				return;
			}
			this.providerStore.add(autorun(inner => {
				const change = history.historyItemRefChanges.read(inner);
				history.historyItemRef.read(inner);
				if (first) {
					first = false;
					return;
				}
				if (!change.silent) {
					this.invalidate();
				}
			}));
			if (this._rows.length === 0) {
				this.reload();
			}
		}));
	}

	get rows(): readonly GitGraphRow[] { return this._rows; }
	get loading(): boolean { return this._loading; }
	get hasMore(): boolean { return this._hasMore; }
	get error(): string | undefined { return this._error; }
	get query(): string { return this._query; }
	get scope(): GitGraphScope { return this._scope; }
	get refs(): readonly ISCMHistoryItemRef[] { return this._refs; }
	/** Goes up each time the refs (and so the walked history) are read again. */
	get refsGeneration(): number { return this.refsVersion; }
	get workingTreeFiles(): number { return this._workingTreeFiles; }
	get historyProvider(): ISCMHistoryProvider | undefined { return this.repository.provider.historyProvider.get(); }

	indexOfCommit(id: string): number {
		return this._commitIds.get(id) ?? -1;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && this.stale) {
			this.reload();
		}
	}

	setQuery(query: string): void {
		const next = query.trim();
		if (next === this._query) {
			return;
		}
		this._query = next;
		this.reload();
	}

	setScope(scope: GitGraphScope): void {
		this._scope = scope;
		this.refsStale = true;
		this.reload();
	}

	/** A ref moved or the repository changed under us: reload now if on screen, else when shown. */
	invalidate(): void {
		this.refsStale = true;
		if (this.visible) {
			this.reloadSoon.schedule();
		} else {
			this.stale = true;
		}
	}

	reload(): void {
		this.stale = false;
		this.reloadSoon.cancel();
		this.builder = undefined;
		this._rows = [];
		this._commitIds = new Map();
		this.fetched = 0;
		this._hasMore = true;
		this._error = undefined;
		this.request.clear();
		this._loading = false;
		this.withWorkingTree();
		this._onDidChange.fire(GitGraphChange.Reset);
		void this.loadMore();
	}

	/** The next page; resolves once it is in `rows` (or right away while one is loading). */
	async loadMore(): Promise<void> {
		const history = this.historyProvider;
		if (this._loading || !this._hasMore || !history) {
			return;
		}
		const source = new CancellationTokenSource();
		this.request.value = source;
		const token = source.token;
		this._loading = true;
		this._onDidChange.fire(GitGraphChange.State);
		try {
			if (!this.builder) {
				await this.prepare(history);
				if (token.isCancellationRequested) {
					return;
				}
			}
			const searching = this._query.length > 0;
			const limit = searching ? SEARCH_PAGE : GRAPH_PAGE;
			const skip = this.fetched;
			const items = await history.provideHistoryItems({
				historyItemRefs: this.refIds,
				limit,
				skip,
				...(searching ? { filterText: this._query } : {}),
			}, token) ?? [];
			if (token.isCancellationRequested) {
				return;
			}
			// Pages are offsets into git's answer, not into the rows: duplicates still move it on.
			this.fetched += items.length;
			// A search answers with matches only; the same commit can come back on a later page.
			const fresh = items.filter(item => !this._commitIds.has(item.id));
			const viewModels = this.builder!.append(searching ? fresh.map(item => ({ ...item, parentIds: [] })) : fresh);
			for (let i = 0; i < viewModels.length; i++) {
				const vm = searching ? { ...viewModels[i], historyItem: { ...viewModels[i].historyItem, parentIds: fresh[i].parentIds } } : viewModels[i];
				this._commitIds.set(vm.historyItem.id, this._rows.length);
				this._rows.push({ kind: 'commit', vm, agents: detectCodingAgents(vm.historyItem.message), flat: searching });
			}
			this._hasMore = items.length >= limit;
			this._loading = false;
			this._onDidChange.fire(GitGraphChange.Append);
		} catch (error) {
			if (!token.isCancellationRequested) {
				this._error = error instanceof Error ? error.message : String(error);
				this._hasMore = false;
			}
		} finally {
			if (this.request.value === source) {
				this._loading = false;
				this.request.clearAndLeak();
				source.dispose();
				this._onDidChange.fire(GitGraphChange.State);
			}
		}
	}

	/**
	 * Pages until `id` is loaded, up to a limit. Resolves its row index, or -1 when it is further
	 * back than that (or not in this scope).
	 */
	async reveal(id: string): Promise<number> {
		const match = (candidate: string) => candidate === id || (id.length >= 7 && candidate.startsWith(id));
		const find = () => {
			for (const [candidate, index] of this._commitIds) {
				if (match(candidate)) {
					return index;
				}
			}
			return -1;
		};
		let index = find();
		// Without a history provider loadMore returns at once; looping on it would never yield.
		while (index === -1 && this._hasMore && this._commitIds.size < REVEAL_LIMIT && !this._error && this.historyProvider) {
			if (this._loading) {
				await Event.toPromise(Event.filter(this.onDidChange, change => change !== GitGraphChange.State || !this._loading));
			} else {
				await this.loadMore();
			}
			index = find();
		}
		return index;
	}

	/** The revisions the graph walks, for asking git about the same history (the activity strip). */
	get walkedRevisions(): readonly string[] {
		return this.refIds;
	}

	/** The oldest loaded commit's time. */
	get oldestLoaded(): number | undefined {
		for (let i = this._rows.length - 1; i >= 0; i--) {
			const row = this._rows[i];
			if (row.kind === 'commit' && row.vm.historyItem.timestamp) {
				return row.vm.historyItem.timestamp;
			}
		}
		return undefined;
	}

	/**
	 * Pages until history reaches back to `day` (local midnight), up to the reveal limit, and
	 * resolves the row of the newest commit made on or before that day; -1 if it isn't loaded.
	 */
	async revealDay(day: number): Promise<number> {
		const end = day + 24 * 60 * 60 * 1000;
		const find = () => this._rows.findIndex(row => row.kind === 'commit' && (row.vm.historyItem.timestamp ?? 0) < end);
		let index = find();
		while (index === -1 && this._hasMore && this._commitIds.size < REVEAL_LIMIT && !this._error && this.historyProvider) {
			if (this._loading) {
				await Event.toPromise(Event.filter(this.onDidChange, change => change !== GitGraphChange.State || !this._loading));
			} else {
				await this.loadMore();
			}
			index = find();
		}
		return index;
	}

	private async prepare(history: ISCMHistoryProvider): Promise<void> {
		if (!this.refsStale && this.laneSetup) {
			const { colorMap, current, remote, base } = this.laneSetup;
			this.builder = new GitGraphLaneBuilder(colorMap, current, remote, base);
			return;
		}
		const current = history.historyItemRef.get();
		const remote = history.historyItemRemoteRef.get();
		const base = history.historyItemBaseRef.get();
		const all = await history.provideHistoryItemRefs() ?? [];
		this._refs = all;
		this.refsStale = false;
		this.refsVersion++;

		let walk: readonly ISCMHistoryItemRef[];
		const scope = this._scope;
		if (scope.kind === 'all') {
			walk = all;
		} else if (scope.kind === 'ref') {
			const ref = all.find(candidate => candidate.id === scope.id);
			walk = ref ? [ref] : [current, remote, base].filter(isDefined);
		} else {
			walk = [current, remote, base].filter(isDefined);
		}
		this.refIds = walk.map(ref => ref.revision ?? ref.id);

		// The current branch, its upstream and its base keep their colors; every other ref takes its lane's.
		const colorMap = new Map<string, ColorIdentifier | undefined>();
		for (const ref of [current, remote, base]) {
			if (ref) {
				colorMap.set(ref.id, ref.color);
			}
		}
		for (const ref of all) {
			if (!colorMap.has(ref.id)) {
				colorMap.set(ref.id, undefined);
			}
		}
		this.laneSetup = { colorMap, current, remote, base };
		this.builder = new GitGraphLaneBuilder(colorMap, current, remote, base);
	}

	private updateWorkingTree(notify = true): void {
		const files = this.repository.provider.groups.reduce((count, group) => count + group.resources.length, 0);
		if (files === this._workingTreeFiles) {
			return;
		}
		this._workingTreeFiles = files;
		if (notify) {
			const had = this._rows[0]?.kind === 'wip';
			this.withWorkingTree();
			this._onDidChange.fire(had !== (this._rows[0]?.kind === 'wip') ? GitGraphChange.Reset : GitGraphChange.State);
		}
	}

	/** The uncommitted changes, as a header row above the commits (never a made-up commit). */
	private withWorkingTree(): void {
		const has = this._rows[0]?.kind === 'wip';
		const want = this._workingTreeFiles > 0 && !this._query;
		if (has) {
			this._rows.shift();
		}
		if (want) {
			this._rows.unshift({ kind: 'wip', files: this._workingTreeFiles });
		}
		if (has !== want) {
			const shift = want ? 1 : -1;
			for (const [id, index] of this._commitIds) {
				this._commitIds.set(id, index + shift);
			}
		}
	}
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

export type GitGraphDatePreset = 'all' | 'hour' | 'day' | 'today' | 'yesterday' | 'week' | 'month' | 'quarter';

/**
 * Boundaries for a date preset in the user's local time (Today starts at local midnight), as
 * instants; `before` only for Yesterday.
 */
export function dateRange(preset: GitGraphDatePreset, now: Date): { after?: Date; before?: Date } | undefined {
	const hours = (count: number) => new Date(now.getTime() - count * 60 * 60 * 1000);
	const midnight = (daysAgo: number) => {
		const date = new Date(now);
		date.setHours(0, 0, 0, 0);
		date.setDate(date.getDate() - daysAgo);
		return date;
	};
	switch (preset) {
		case 'all': return undefined;
		case 'hour': return { after: hours(1) };
		case 'day': return { after: hours(24) };
		case 'today': return { after: midnight(0) };
		case 'yesterday': return { after: midnight(1), before: midnight(0) };
		case 'week': return { after: midnight(7) };
		case 'month': return { after: midnight(30) };
		case 'quarter': return { after: midnight(90) };
	}
}

/** UTC ISO 8601 to the second, which `git log --since/--until` reads exactly. */
export function isoSeconds(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
