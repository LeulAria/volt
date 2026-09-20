/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Intelligent cache. Four namespaces so a huge grep result cannot evict the system prompt,
 * and a prompt-cache key cannot collide with a tool result.
 *
 * Entries expire. A cache that never forgets becomes a source of stale file contents, which
 * is worse than a miss: the model then reasons about a file it already edited.
 */

export type CacheNamespace = 'context' | 'tool' | 'search' | 'model';

export interface ICacheEntry<T> {
	readonly value: T;
	readonly at: number;
	readonly expiresAt: number;
	readonly hits: number;
}

export interface ICacheStats {
	readonly namespace: CacheNamespace;
	readonly size: number;
	readonly hits: number;
	readonly misses: number;
}

const DEFAULT_TTL: Readonly<Record<CacheNamespace, number>> = {
	context: 10 * 60_000,
	tool: 2 * 60_000,
	search: 5 * 60_000,
	model: 30 * 60_000,
};

const DEFAULT_CAP: Readonly<Record<CacheNamespace, number>> = {
	context: 32,
	tool: 64,
	search: 48,
	model: 16,
};

export class IntelligentCache {

	private readonly maps = new Map<CacheNamespace, Map<string, ICacheEntry<unknown>>>();
	private readonly hits = new Map<CacheNamespace, number>();
	private readonly misses = new Map<CacheNamespace, number>();

	get<T>(namespace: CacheNamespace, key: string, now = Date.now()): T | undefined {
		const map = this.maps.get(namespace);
		const entry = map?.get(key);
		if (!entry || entry.expiresAt <= now) {
			if (entry) {
				map!.delete(key);
			}
			this.misses.set(namespace, (this.misses.get(namespace) ?? 0) + 1);
			return undefined;
		}
		const next: ICacheEntry<T> = { ...entry, hits: entry.hits + 1, value: entry.value as T };
		map!.delete(key);
		map!.set(key, next);
		this.hits.set(namespace, (this.hits.get(namespace) ?? 0) + 1);
		return next.value;
	}

	set<T>(namespace: CacheNamespace, key: string, value: T, now = Date.now(), ttlMs?: number): void {
		const map = this.maps.get(namespace) ?? new Map<string, ICacheEntry<unknown>>();
		const cap = DEFAULT_CAP[namespace];
		if (map.size >= cap && !map.has(key)) {
			const oldest = map.keys().next().value;
			if (oldest !== undefined) {
				map.delete(oldest);
			}
		}
		if (map.has(key)) {
			map.delete(key);
		}
		map.set(key, {
			value,
			at: now,
			expiresAt: now + (ttlMs ?? DEFAULT_TTL[namespace]),
			hits: 0,
		});
		this.maps.set(namespace, map);
	}

	invalidate(namespace: CacheNamespace, key?: string): void {
		if (!key) {
			this.maps.delete(namespace);
			return;
		}
		this.maps.get(namespace)?.delete(key);
	}

	/** Drop tool and search entries after a workspace mutation - those results are now stale. */
	invalidateAfterMutation(): void {
		this.maps.delete('tool');
		this.maps.delete('search');
	}

	stats(namespace: CacheNamespace): ICacheStats {
		return {
			namespace,
			size: this.maps.get(namespace)?.size ?? 0,
			hits: this.hits.get(namespace) ?? 0,
			misses: this.misses.get(namespace) ?? 0,
		};
	}
}

/** Stable, non-cryptographic. Same input, same key, across a run. */
export function cacheKey(...parts: readonly string[]): string {
	let hash = 5381;
	const joined = parts.join('\0');
	for (let i = 0; i < joined.length; i++) {
		hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}
