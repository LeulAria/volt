/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { applyPatch, ScratchPatch } from './scratchFactory.js';
import { DEFAULT_SCRATCH_SETTINGS, IScratchAgentRun, IScratchBoardSettings, ScratchElement } from './scratchTypes.js';

export type ScratchChangeOrigin = 'user' | 'undo' | 'redo' | 'remote' | 'load';

export interface IScratchSceneChange {
	/** Added or changed. */
	readonly updated: ReadonlySet<string>;
	readonly removed: ReadonlySet<string>;
	/** Paint order changed (adds and removes count). */
	readonly order: boolean;
	readonly settings: boolean;
	readonly runs: boolean;
	readonly origin: ScratchChangeOrigin;
	/** Part of a drag that has not been committed yet. */
	readonly live: boolean;
}

interface IHistoryEntry {
	readonly label: string;
	readonly before: ReadonlyMap<string, ScratchElement | undefined>;
	readonly after: ReadonlyMap<string, ScratchElement | undefined>;
	readonly orderBefore: readonly string[] | undefined;
	readonly orderAfter: readonly string[] | undefined;
	readonly settingsBefore: IScratchBoardSettings | undefined;
	readonly settingsAfter: IScratchBoardSettings | undefined;
	readonly runsBefore: readonly IScratchAgentRun[] | undefined;
	readonly runsAfter: readonly IScratchAgentRun[] | undefined;
	readonly selectionBefore: readonly string[];
	selectionAfter: readonly string[];
	readonly coalesceKey: string | undefined;
	time: number;
}

const HISTORY_LIMIT = 500;
/** Edits with the same coalesce key this close together undo as one (slider drags, typing). */
const COALESCE_MS = 1200;

export interface IScratchTransactionOptions {
	readonly coalesceKey?: string;
	readonly selectionBefore?: readonly string[];
	readonly selectionAfter?: readonly string[];
	/** Off for changes that should not be undoable (camera, a run's status). */
	readonly record?: boolean;
}

/** The board as of the last commit (see ScratchScene.committedView). */
export interface IScratchCommittedView {
	readonly elements: readonly ScratchElement[];
	readonly deleted: ReadonlyMap<string, number>;
	readonly settings: IScratchBoardSettings;
	readonly runs: readonly IScratchAgentRun[];
}

/**
 * Collects changes; applies each at once so the board repaints while a drag is under way, and
 * turns the whole thing into one undo step on commit.
 */
export class ScratchTransaction {

	private readonly before = new Map<string, ScratchElement | undefined>();
	private orderBefore: string[] | undefined;
	private settingsBefore: IScratchBoardSettings | undefined;
	private runsBefore: readonly IScratchAgentRun[] | undefined;
	private pending: { updated: Set<string>; removed: Set<string>; order: boolean; settings: boolean; runs: boolean } = ScratchTransaction.empty();
	private closed = false;
	private readonly startedAt = Date.now();

	private static empty() {
		return { updated: new Set<string>(), removed: new Set<string>(), order: false, settings: false, runs: false };
	}

	constructor(private readonly scene: ScratchScene, readonly label: string, private readonly live: boolean) { }

	get isClosed(): boolean {
		return this.closed;
	}

	private touch(id: string): void {
		if (!this.before.has(id)) {
			this.before.set(id, this.scene.get(id));
		}
	}

	private touchOrder(): void {
		if (!this.orderBefore) {
			this.orderBefore = this.scene.getElements().map(e => e.id);
		}
	}

	update<T extends ScratchElement>(id: string, patch: ScratchPatch<T> | ScratchPatch | ((el: T) => ScratchPatch<T> | ScratchPatch | undefined)): T | undefined {
		this.assertOpen();
		const current = this.scene.get(id) as T | undefined;
		if (!current) {
			return undefined;
		}
		const resolved = typeof patch === 'function' ? patch(current) : patch;
		if (!resolved || !hasChanges(current, resolved)) {
			return current;
		}
		this.touch(id);
		const next = applyPatch(current, resolved);
		this.scene._put(next);
		this.pending.updated.add(id);
		return next;
	}

	/** Puts an element as given (version and time included). Used for remote merges and undo. */
	replace(el: ScratchElement): void {
		this.assertOpen();
		const existed = this.scene.has(el.id);
		this.touch(el.id);
		if (!existed) {
			this.touchOrder();
			this.pending.order = true;
		}
		this.scene._put(el);
		this.pending.updated.add(el.id);
		this.pending.removed.delete(el.id);
	}

	/** Adds on top, or at `index` in paint order. */
	add(el: ScratchElement, index?: number): void {
		this.assertOpen();
		if (this.scene.has(el.id)) {
			this.replace(el);
			return;
		}
		this.touch(el.id);
		this.touchOrder();
		this.scene._insert(el, index);
		this.pending.updated.add(el.id);
		this.pending.removed.delete(el.id);
		this.pending.order = true;
	}

	remove(id: string): void {
		this.assertOpen();
		if (!this.scene.has(id)) {
			return;
		}
		this.touch(id);
		this.touchOrder();
		this.scene._remove(id);
		this.pending.updated.delete(id);
		this.pending.removed.add(id);
		this.pending.order = true;
	}

	/** New paint order. Ids missing from `order` keep their relative place at the end. */
	reorder(order: readonly string[]): void {
		this.assertOpen();
		const current = this.scene.getElements().map(e => e.id);
		const next = completeOrder(order, current);
		if (next.length === current.length && next.every((id, i) => id === current[i])) {
			return;
		}
		this.touchOrder();
		this.scene._reorder(next);
		this.pending.order = true;
	}

	setSettings(settings: Partial<IScratchBoardSettings>): void {
		this.assertOpen();
		const current = this.scene.settings;
		const next = { ...current, ...settings };
		if ((Object.keys(next) as (keyof IScratchBoardSettings)[]).every(key => next[key] === current[key])) {
			return;
		}
		this.settingsBefore ??= current;
		this.scene._setSettings(next);
		this.pending.settings = true;
	}

	setRuns(runs: readonly IScratchAgentRun[]): void {
		this.assertOpen();
		this.runsBefore ??= this.scene.runs;
		this.scene._setRuns(runs);
		this.pending.runs = true;
	}

	/** Sends what changed since the last flush to listeners (live drags call this per frame). */
	flush(): void {
		const p = this.pending;
		if (!p.updated.size && !p.removed.size && !p.order && !p.settings && !p.runs) {
			return;
		}
		this.pending = ScratchTransaction.empty();
		this.scene._emit({ updated: p.updated, removed: p.removed, order: p.order, settings: p.settings, runs: p.runs, origin: 'user', live: this.live });
	}

	/** Ends the transaction and records one undo step. Returns false when nothing changed. */
	commit(options: IScratchTransactionOptions = {}): boolean {
		this.assertOpen();
		this.closed = true;
		this.flush();
		const after = new Map<string, ScratchElement | undefined>();
		const before = new Map<string, ScratchElement | undefined>();
		for (const [id, was] of this.before) {
			const now = this.scene.get(id);
			if (was !== now) {
				before.set(id, was);
				after.set(id, now);
			}
		}
		const orderAfter = this.orderBefore ? this.scene.getElements().map(e => e.id) : undefined;
		const orderChanged = !!this.orderBefore && !sameOrder(this.orderBefore, orderAfter!);
		const settingsChanged = !!this.settingsBefore && this.settingsBefore !== this.scene.settings;
		const runsChanged = !!this.runsBefore && this.runsBefore !== this.scene.runs;
		const changed = before.size > 0 || orderChanged || settingsChanged || runsChanged;
		if (this.live && changed) {
			// Listeners saw live frames; tell them the gesture is over so saves and minimaps catch up.
			this.scene._emit({ updated: new Set(after.keys()), removed: new Set(), order: orderChanged, settings: settingsChanged, runs: runsChanged, origin: 'user', live: false });
		}
		this.scene._endTransaction(this);
		if (!changed) {
			return false;
		}
		if (options.record !== false) {
			this.scene._record({
				label: this.label,
				before, after,
				orderBefore: orderChanged ? this.orderBefore : undefined,
				orderAfter: orderChanged ? orderAfter : undefined,
				settingsBefore: settingsChanged ? this.settingsBefore : undefined,
				settingsAfter: settingsChanged ? this.scene.settings : undefined,
				runsBefore: runsChanged ? this.runsBefore : undefined,
				runsAfter: runsChanged ? this.scene.runs : undefined,
				selectionBefore: options.selectionBefore ?? [],
				selectionAfter: options.selectionAfter ?? options.selectionBefore ?? [],
				coalesceKey: options.coalesceKey,
				time: Date.now(),
			});
		}
		this.scene._markDirty();
		return true;
	}

	/** @internal The scene as it was before this transaction: what a save may write while it is open. */
	_committedView(elements: readonly ScratchElement[], tombstones: ReadonlyMap<string, number>, settings: IScratchBoardSettings, runs: readonly IScratchAgentRun[]): IScratchCommittedView {
		const byId = new Map<string, ScratchElement>();
		for (const el of elements) {
			if (!this.before.has(el.id)) {
				byId.set(el.id, el);
			}
		}
		for (const [id, was] of this.before) {
			if (was) {
				byId.set(id, was);
			}
		}
		const order = completeOrder(this.orderBefore ?? [], elements.map(e => e.id).concat([...byId.keys()]));
		const committed: ScratchElement[] = [];
		for (const id of order) {
			const el = byId.get(id);
			if (el) {
				committed.push(el);
				byId.delete(id);
			}
		}
		const deleted = new Map(tombstones);
		for (const id of this.before.keys()) {
			const at = deleted.get(id);
			if (at !== undefined && at >= this.startedAt) {
				deleted.delete(id);
			}
		}
		return { elements: committed, deleted, settings: this.settingsBefore ?? settings, runs: this.runsBefore ?? runs };
	}

	/** Ends the transaction and puts everything back as it was (Escape during a drag). */
	cancel(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const updated = new Set<string>();
		const removed = new Set<string>();
		for (const [id, was] of this.before) {
			if (was) {
				if (this.scene.has(id)) {
					this.scene._put(was);
				} else {
					this.scene._insert(was);
				}
				updated.add(id);
			} else if (this.scene.has(id)) {
				this.scene._remove(id);
				removed.add(id);
			}
		}
		if (this.orderBefore) {
			this.scene._reorder(completeOrder(this.orderBefore, this.scene.getElements().map(e => e.id)));
		}
		if (this.settingsBefore) {
			this.scene._setSettings(this.settingsBefore);
		}
		if (this.runsBefore) {
			this.scene._setRuns(this.runsBefore);
		}
		this.pending = ScratchTransaction.empty();
		this.scene._endTransaction(this);
		this.scene._emit({ updated, removed, order: !!this.orderBefore, settings: !!this.settingsBefore, runs: !!this.runsBefore, origin: 'user', live: false });
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error(`Scratch transaction "${this.label}" is already closed`);
		}
	}
}

function hasChanges(el: ScratchElement, patch: object): boolean {
	const record = el as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (record[key] !== value) {
			return true;
		}
	}
	return false;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** `preferred` order over the ids in `current`; ids `preferred` does not mention keep their relative place. */
function completeOrder(preferred: readonly string[], current: readonly string[]): string[] {
	const live = new Set(current);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of preferred) {
		if (live.has(id) && !seen.has(id)) {
			out.push(id);
			seen.add(id);
		}
	}
	for (const id of current) {
		if (!seen.has(id)) {
			out.push(id);
		}
	}
	return out;
}

/**
 * The elements of one board in paint order, with transactions, undo and redo. Pure state: the
 * view renders from `onDidChange`, the store saves when `isDirty`.
 */
export class ScratchScene extends Disposable {

	private elements: ScratchElement[] = [];
	private readonly byId = new Map<string, ScratchElement>();
	private indexCache: Map<string, number> | undefined;
	private readonly tombstones = new Map<string, number>();
	private _settings: IScratchBoardSettings = DEFAULT_SCRATCH_SETTINGS;
	private _runs: readonly IScratchAgentRun[] = [];
	private readonly undoStack: IHistoryEntry[] = [];
	private readonly redoStack: IHistoryEntry[] = [];
	private active: ScratchTransaction | undefined;
	private dirtyCounter = 0;

	private readonly _onDidChange = this._register(new Emitter<IScratchSceneChange>());
	readonly onDidChange: Event<IScratchSceneChange> = this._onDidChange.event;
	private readonly _onDidChangeHistory = this._register(new Emitter<void>());
	readonly onDidChangeHistory: Event<void> = this._onDidChangeHistory.event;
	/** Undo and redo hand back the selection that went with the step. */
	private readonly _onDidRestoreSelection = this._register(new Emitter<readonly string[]>());
	readonly onDidRestoreSelection: Event<readonly string[]> = this._onDidRestoreSelection.event;
	private readonly _onDidBecomeDirty = this._register(new Emitter<void>());
	readonly onDidBecomeDirty: Event<void> = this._onDidBecomeDirty.event;
	private readonly _onDidEndTransaction = this._register(new Emitter<void>());
	/** A drag or other open transaction ended (committed or cancelled). */
	readonly onDidEndTransaction: Event<void> = this._onDidEndTransaction.event;

	getElements(): readonly ScratchElement[] {
		return this.elements;
	}

	get(id: string): ScratchElement | undefined {
		return this.byId.get(id);
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	get size(): number {
		return this.elements.length;
	}

	indexOf(id: string): number {
		if (!this.indexCache) {
			this.indexCache = new Map(this.elements.map((e, i) => [e.id, i]));
		}
		return this.indexCache.get(id) ?? -1;
	}

	get settings(): IScratchBoardSettings {
		return this._settings;
	}

	get runs(): readonly IScratchAgentRun[] {
		return this._runs;
	}

	get deleted(): ReadonlyMap<string, number> {
		return this.tombstones;
	}

	/** Bumped on every committed change; the store compares it with what it last saved. */
	get dirtyVersion(): number {
		return this.dirtyCounter;
	}

	get inTransaction(): boolean {
		return !!this.active;
	}

	/** The board as of the last commit: a drag or draft still open is left out. */
	committedView(): IScratchCommittedView {
		const tx = this.active && !this.active.isClosed ? this.active : undefined;
		return tx
			? tx._committedView(this.elements, this.tombstones, this._settings, this._runs)
			: { elements: this.elements, deleted: this.tombstones, settings: this._settings, runs: this._runs };
	}

	/** Replaces everything and clears history (opening a board). */
	load(elements: readonly ScratchElement[], settings: IScratchBoardSettings, runs: readonly IScratchAgentRun[], deleted: Readonly<Record<string, number>>): void {
		this.active?.cancel();
		const removed = new Set(this.byId.keys());
		this.elements = [];
		this.byId.clear();
		this.indexCache = undefined;
		for (const el of elements) {
			if (!this.byId.has(el.id)) {
				this.elements.push(el);
				this.byId.set(el.id, el);
				removed.delete(el.id);
			}
		}
		this.tombstones.clear();
		for (const [id, at] of Object.entries(deleted)) {
			if (!this.byId.has(id)) {
				this.tombstones.set(id, at);
			}
		}
		this._settings = settings;
		this._runs = runs;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this._emit({ updated: new Set(this.byId.keys()), removed, order: true, settings: true, runs: true, origin: 'load', live: false });
		this._onDidChangeHistory.fire();
	}

	/**
	 * Starts a change. `live` transactions repaint as they go (call `flush` per frame) and become
	 * one undo step on commit. Only one runs at a time; a new one cancels nothing, it throws.
	 */
	begin(label: string, live = false): ScratchTransaction {
		if (this.active && !this.active.isClosed) {
			throw new Error(`Scratch transaction "${this.active.label}" is still open`);
		}
		this.active = new ScratchTransaction(this, label, live);
		return this.active;
	}

	/** Runs `fn` in a transaction and commits it. Returns whether anything changed. */
	transact(label: string, fn: (tx: ScratchTransaction) => void, options?: IScratchTransactionOptions): boolean {
		const tx = this.begin(label);
		try {
			fn(tx);
		} catch (error) {
			tx.cancel();
			throw error;
		}
		return tx.commit(options);
	}

	/** Cancels a live gesture left open (the view lost the pointer). */
	cancelActive(): void {
		this.active?.cancel();
	}

	/**
	 * Takes another window's copy of this board: the newer copy of each element wins, deletions
	 * newer than our edit remove ours. Not undoable; does not dirty the board.
	 */
	applyRemote(elements: readonly ScratchElement[], deleted: Readonly<Record<string, number>>, settings: IScratchBoardSettings | undefined, runs: readonly IScratchAgentRun[] | undefined): boolean {
		if (this.active && !this.active.isClosed) {
			return false;
		}
		const updated = new Set<string>();
		const removed = new Set<string>();
		let order = false;
		for (const [id, at] of Object.entries(deleted)) {
			const mine = this.byId.get(id);
			if (mine && at >= mine.updated) {
				this._remove(id);
				// Their deletion time, not ours: a later edit here must still win over it.
				this.tombstones.set(id, at);
				removed.add(id);
				order = true;
			} else if (!mine) {
				const known = this.tombstones.get(id);
				if (known === undefined || known < at) {
					this.tombstones.set(id, at);
				}
			}
		}
		for (const el of elements) {
			const mine = this.byId.get(el.id);
			if (mine) {
				if (el.updated > mine.updated || (el.updated === mine.updated && el.version > mine.version)) {
					this._put(el);
					updated.add(el.id);
				}
			} else {
				const tomb = this.tombstones.get(el.id);
				if (tomb !== undefined && tomb >= el.updated) {
					continue;
				}
				this.tombstones.delete(el.id);
				this._insert(el);
				updated.add(el.id);
				order = true;
			}
		}
		// Their paint order for shared elements; ours for the rest.
		const theirOrder = elements.map(e => e.id).filter(id => this.byId.has(id));
		if (theirOrder.length) {
			const current = this.elements.map(e => e.id);
			const merged = mergeOrder(current, theirOrder);
			if (!sameOrder(current, merged)) {
				this._reorder(merged);
				order = true;
			}
		}
		let settingsChanged = false;
		if (settings && JSON.stringify(settings) !== JSON.stringify(this._settings)) {
			this._settings = settings;
			settingsChanged = true;
		}
		let runsChanged = false;
		if (runs) {
			const merged = mergeRuns(this._runs, runs);
			if (merged !== this._runs) {
				this._runs = merged;
				runsChanged = true;
			}
		}
		if (!updated.size && !removed.size && !order && !settingsChanged && !runsChanged) {
			return false;
		}
		this._emit({ updated, removed, order, settings: settingsChanged, runs: runsChanged, origin: 'remote', live: false });
		return true;
	}

	// ---- history ----

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	get undoLabel(): string | undefined {
		return this.undoStack[this.undoStack.length - 1]?.label;
	}

	get redoLabel(): string | undefined {
		return this.redoStack[this.redoStack.length - 1]?.label;
	}

	undo(): boolean {
		if (this.active && !this.active.isClosed) {
			return false;
		}
		const entry = this.undoStack.pop();
		if (!entry) {
			return false;
		}
		this.applyEntry(entry, 'undo');
		this.redoStack.push(entry);
		this._onDidRestoreSelection.fire(entry.selectionBefore.filter(id => this.byId.has(id)));
		this._onDidChangeHistory.fire();
		return true;
	}

	redo(): boolean {
		if (this.active && !this.active.isClosed) {
			return false;
		}
		const entry = this.redoStack.pop();
		if (!entry) {
			return false;
		}
		this.applyEntry(entry, 'redo');
		this.undoStack.push(entry);
		this._onDidRestoreSelection.fire(entry.selectionAfter.filter(id => this.byId.has(id)));
		this._onDidChangeHistory.fire();
		return true;
	}

	private applyEntry(entry: IHistoryEntry, direction: 'undo' | 'redo'): void {
		const states = direction === 'undo' ? entry.before : entry.after;
		const order = direction === 'undo' ? entry.orderBefore : entry.orderAfter;
		const settings = direction === 'undo' ? entry.settingsBefore : entry.settingsAfter;
		const runs = direction === 'undo' ? entry.runsBefore : entry.runsAfter;
		const now = Date.now();
		const updated = new Set<string>();
		const removed = new Set<string>();
		let orderChanged = false;
		for (const [id, state] of states) {
			const current = this.byId.get(id);
			if (state) {
				// A fresh version and time, so renderers repaint and other windows take the restored copy.
				const restored: ScratchElement = { ...state, version: Math.max(current?.version ?? 0, state.version) + 1, updated: now };
				if (current) {
					this._put(restored);
				} else {
					this._insert(restored);
					orderChanged = true;
				}
				this.tombstones.delete(id);
				updated.add(id);
			} else if (current) {
				this._remove(id);
				this.tombstones.set(id, now);
				removed.add(id);
				orderChanged = true;
			}
		}
		if (order) {
			this._reorder(completeOrder(order, this.elements.map(e => e.id)));
			orderChanged = true;
		}
		if (settings) {
			this._settings = settings;
		}
		if (runs) {
			this._runs = runs;
		}
		this._emit({ updated, removed, order: orderChanged, settings: !!settings, runs: !!runs, origin: direction, live: false });
		this._markDirty();
	}

	clearHistory(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this._onDidChangeHistory.fire();
	}

	// ---- internal, for ScratchTransaction ----

	/** @internal */
	_put(el: ScratchElement): void {
		const index = this.indexOf(el.id);
		if (index < 0) {
			this._insert(el);
			return;
		}
		this.elements[index] = el;
		this.byId.set(el.id, el);
	}

	/** @internal */
	_insert(el: ScratchElement, index?: number): void {
		if (this.byId.has(el.id)) {
			this._put(el);
			return;
		}
		if (index === undefined || index < 0 || index >= this.elements.length) {
			this.elements.push(el);
			if (this.indexCache) {
				this.indexCache.set(el.id, this.elements.length - 1);
			}
		} else {
			this.elements.splice(index, 0, el);
			this.indexCache = undefined;
		}
		this.byId.set(el.id, el);
		this.tombstones.delete(el.id);
	}

	/** @internal */
	_remove(id: string): void {
		const index = this.indexOf(id);
		if (index < 0) {
			return;
		}
		this.elements.splice(index, 1);
		this.byId.delete(id);
		this.indexCache = undefined;
		this.tombstones.set(id, Date.now());
	}

	/** @internal */
	_reorder(order: readonly string[]): void {
		const next: ScratchElement[] = [];
		for (const id of order) {
			const el = this.byId.get(id);
			if (el) {
				next.push(el);
			}
		}
		this.elements = next;
		this.indexCache = undefined;
	}

	/** @internal */
	_setSettings(settings: IScratchBoardSettings): void {
		this._settings = settings;
	}

	/** @internal */
	_setRuns(runs: readonly IScratchAgentRun[]): void {
		this._runs = runs;
	}

	/** @internal */
	_emit(change: IScratchSceneChange): void {
		this._onDidChange.fire(change);
	}

	/** @internal */
	_endTransaction(tx: ScratchTransaction): void {
		if (this.active === tx) {
			this.active = undefined;
			this._onDidEndTransaction.fire();
		}
	}

	/** @internal */
	_markDirty(): void {
		this.dirtyCounter++;
		this._onDidBecomeDirty.fire();
	}

	/** @internal */
	_record(entry: IHistoryEntry): void {
		const last = this.undoStack[this.undoStack.length - 1];
		if (entry.coalesceKey && last && last.coalesceKey === entry.coalesceKey && entry.time - last.time < COALESCE_MS
			&& !entry.orderBefore && !last.orderAfter && !entry.settingsBefore === !last.settingsBefore && !entry.runsBefore === !last.runsBefore) {
			// Fold into the previous step: keep its "before", take this "after".
			const before = new Map(last.before);
			const after = new Map(last.after);
			for (const [id, was] of entry.before) {
				if (!before.has(id)) {
					before.set(id, was);
				}
			}
			for (const [id, now] of entry.after) {
				after.set(id, now);
			}
			this.undoStack[this.undoStack.length - 1] = {
				...last,
				before, after,
				settingsAfter: entry.settingsAfter ?? last.settingsAfter,
				runsAfter: entry.runsAfter ?? last.runsAfter,
				selectionAfter: entry.selectionAfter,
				time: entry.time,
			};
		} else {
			this.undoStack.push(entry);
			if (this.undoStack.length > HISTORY_LIMIT) {
				this.undoStack.splice(0, this.undoStack.length - HISTORY_LIMIT);
			}
		}
		this.redoStack.length = 0;
		this._onDidChangeHistory.fire();
	}
}

/** Their order for ids both sides know, with ids only we have kept after the same neighbour as before. */
function mergeOrder(current: readonly string[], theirs: readonly string[]): string[] {
	const out = [...theirs];
	const placed = new Set(out);
	for (let i = 0; i < current.length; i++) {
		const id = current[i];
		if (placed.has(id)) {
			continue;
		}
		// Find the closest earlier element we share and slot in right after it.
		let at = -1;
		for (let j = i - 1; j >= 0; j--) {
			const k = out.indexOf(current[j]);
			if (k >= 0) {
				at = k;
				break;
			}
		}
		out.splice(at + 1, 0, id);
		placed.add(id);
	}
	return out;
}

/** Union by run id; a run hidden on either side stays hidden. */
export function mergeRuns(ours: readonly IScratchAgentRun[], theirs: readonly IScratchAgentRun[]): readonly IScratchAgentRun[] {
	const byId = new Map(ours.map(r => [r.id, r]));
	let changed = false;
	for (const run of theirs) {
		const mine = byId.get(run.id);
		if (!mine) {
			byId.set(run.id, run);
			changed = true;
		} else if (run.hidden && !mine.hidden) {
			byId.set(run.id, { ...mine, hidden: true });
			changed = true;
		}
	}
	if (!changed) {
		return ours;
	}
	return [...byId.values()].sort((a, b) => a.created - b.created);
}
