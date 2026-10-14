/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Search results keyed by the exact query, valid until any file changes. The epoch moves on every
 * file change Volt hears of (the workspace watcher, the agent's own writes), so a hit can only
 * come from a tree identical to the one searched; the age limit covers changes nobody reported
 * (a folder outside the watcher). Agents repeat searches across turns and subagents; the context
 * retriever repeats them on every follow-up message.
 */
export class SearchCache<T> {

	private epoch = 0;
	private readonly entries = new Map<string, { readonly epoch: number; readonly at: number; readonly value: T }>();
	private hits = 0;
	private misses = 0;

	constructor(
		private readonly maxEntries = 128,
		private readonly maxAgeMs = 30_000,
		private readonly now: () => number = Date.now,
	) { }

	/** Every file change: everything cached so far may be stale. */
	invalidate(): void {
		this.epoch++;
		this.entries.clear();
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry || entry.epoch !== this.epoch || this.now() - entry.at > this.maxAgeMs) {
			if (entry) {
				this.entries.delete(key);
			}
			this.misses++;
			return undefined;
		}
		// Most recently used last, so eviction takes the oldest.
		this.entries.delete(key);
		this.entries.set(key, entry);
		this.hits++;
		return entry.value;
	}

	/** The epoch a search starts in; pass it to `set` so a result that raced a change is dropped. */
	begin(): number {
		return this.epoch;
	}

	set(key: string, value: T, startedIn: number): void {
		if (startedIn !== this.epoch) {
			return; // files changed while it ran: it may describe neither the old tree nor the new one
		}
		this.entries.delete(key);
		this.entries.set(key, { epoch: this.epoch, at: this.now(), value });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.entries.delete(oldest);
		}
	}

	stats(): { readonly hits: number; readonly misses: number; readonly size: number } {
		return { hits: this.hits, misses: this.misses, size: this.entries.size };
	}
}
