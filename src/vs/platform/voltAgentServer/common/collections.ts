/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { ICollectionDelta } from './protocol.js';

/**
 * Server side of a replicated collection: a keyed map whose changes become `col` deltas. Values are
 * compared by their JSON so re-publishing an unchanged value sends nothing.
 */
export class ReplicatedCollection {

	private readonly values = new Map<string, { readonly value: unknown; readonly json: string }>();

	constructor(
		readonly name: string,
		private readonly publish: (delta: ICollectionDelta) => void,
	) { }

	get(key: string): unknown {
		return this.values.get(key)?.value;
	}

	keys(): string[] {
		return [...this.values.keys()];
	}

	/** Sets entries; `undefined` deletes. Publishes one delta with what actually changed. */
	update(entries: Record<string, unknown>): void {
		const put: Record<string, unknown> = {};
		const del: string[] = [];
		for (const [key, value] of Object.entries(entries)) {
			if (value === undefined) {
				if (this.values.delete(key)) {
					del.push(key);
				}
				continue;
			}
			const json = JSON.stringify(value);
			if (this.values.get(key)?.json === json) {
				continue;
			}
			// Store the parsed copy: later mutation of the caller's object must not change what was sent.
			this.values.set(key, { value: JSON.parse(json), json });
			put[key] = this.values.get(key)!.value;
		}
		if (del.length || Object.keys(put).length) {
			this.publish({ col: this.name, ...(Object.keys(put).length ? { put } : {}), ...(del.length ? { del } : {}) });
		}
	}

	/** Makes the collection exactly `entries`: missing keys are deleted. */
	replace(entries: Record<string, unknown>): void {
		const next: Record<string, unknown> = { ...entries };
		for (const key of this.values.keys()) {
			if (!(key in entries)) {
				next[key] = undefined;
			}
		}
		this.update(next);
	}

	snapshot(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [key, { value }] of this.values) {
			out[key] = value;
		}
		return out;
	}
}

/** Client side: the mirrored values of every collection, kept current by snapshots and deltas. */
export class CollectionMirror {

	private readonly cols = new Map<string, Map<string, unknown>>();

	private readonly _onDidChange = new Emitter<{ readonly col: string; readonly keys: readonly string[]; readonly reset: boolean }>();
	/** `reset`: the collection was reloaded from a snapshot (keys = every key before and after). */
	readonly onDidChange: Event<{ readonly col: string; readonly keys: readonly string[]; readonly reset: boolean }> = this._onDidChange.event;

	get<T>(col: string, key: string): T | undefined {
		return this.cols.get(col)?.get(key) as T | undefined;
	}

	values<T>(col: string): T[] {
		return [...(this.cols.get(col)?.values() ?? [])] as T[];
	}

	entries<T>(col: string): [string, T][] {
		return [...(this.cols.get(col)?.entries() ?? [])] as [string, T][];
	}

	has(col: string, key: string): boolean {
		return !!this.cols.get(col)?.has(key);
	}

	applyDelta(delta: ICollectionDelta): void {
		let map = this.cols.get(delta.col);
		if (!map) {
			map = new Map();
			this.cols.set(delta.col, map);
		}
		const keys: string[] = [];
		for (const key of delta.del ?? []) {
			if (map.delete(key)) {
				keys.push(key);
			}
		}
		for (const [key, value] of Object.entries(delta.put ?? {})) {
			map.set(key, value);
			keys.push(key);
		}
		if (keys.length) {
			this._onDidChange.fire({ col: delta.col, keys, reset: false });
		}
	}

	/** Replaces every collection with a snapshot. Collections absent from it are cleared. */
	applySnapshot(collections: Record<string, Record<string, unknown>>): void {
		const names = new Set([...this.cols.keys(), ...Object.keys(collections)]);
		for (const col of names) {
			const before = this.cols.get(col);
			const next = new Map(Object.entries(collections[col] ?? {}));
			this.cols.set(col, next);
			const keys = new Set([...(before?.keys() ?? []), ...next.keys()]);
			this._onDidChange.fire({ col, keys: [...keys], reset: true });
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
