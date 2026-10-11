/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

/** A minimal event emitter: listeners added while firing wait for the next event. */
export class Emitter<T> {
	private readonly listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>): Unsubscribe => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(value);
			} catch (err) {
				console.error('[volt] listener failed', err);
			}
		}
	}

	get size(): number {
		return this.listeners.size;
	}

	clear(): void {
		this.listeners.clear();
	}
}

/**
 * Keyed change notifications for `useSyncExternalStore`: a view subscribes to the keys it reads
 * (`col:history`, `transcript:<id>`) and re-renders only when one of them changes.
 */
export class KeyedNotifier {
	private readonly listeners = new Map<string, Set<() => void>>();
	private batchDepth = 0;
	private readonly pending = new Set<string>();

	subscribe(key: string, listener: () => void): Unsubscribe {
		let set = this.listeners.get(key);
		if (!set) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(listener);
		return () => {
			const current = this.listeners.get(key);
			current?.delete(listener);
			if (current && !current.size) {
				this.listeners.delete(key);
			}
		};
	}

	notify(key: string): void {
		if (this.batchDepth) {
			this.pending.add(key);
			return;
		}
		for (const listener of [...(this.listeners.get(key) ?? [])]) {
			listener();
		}
	}

	/** Coalesces notifications: each key fires once when the outermost batch ends. */
	batch<T>(fn: () => T): T {
		this.batchDepth++;
		try {
			return fn();
		} finally {
			this.batchDepth--;
			if (!this.batchDepth && this.pending.size) {
				const keys = [...this.pending];
				this.pending.clear();
				for (const key of keys) {
					this.notify(key);
				}
			}
		}
	}
}
