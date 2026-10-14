/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * A small query cache: one entry per key, shared by every component that asks, refetched when
 * invalidated (by key prefix) or when the window regains focus after a while. Enough for a console
 * whose data changes when someone acts, not every second.
 */
interface IEntry {
	data?: unknown;
	error?: Error;
	loading: boolean;
	at: number;
	promise?: Promise<void>;
	fetcher: () => Promise<unknown>;
}

const entries = new Map<string, IEntry>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
	version++;
	listeners.forEach(l => l());
}

function load(key: string): Promise<void> {
	const entry = entries.get(key)!;
	entry.loading = true;
	const promise = entry.fetcher().then(data => {
		entry.data = data;
		entry.error = undefined;
	}, err => {
		entry.error = err instanceof Error ? err : new Error(String(err));
	}).finally(() => {
		entry.loading = false;
		entry.at = Date.now();
		entry.promise = undefined;
		emit();
	});
	entry.promise = promise;
	emit();
	return promise;
}

export interface IQuery<T> {
	readonly data: T | undefined;
	readonly error: Error | undefined;
	readonly loading: boolean;
	readonly refetch: () => Promise<void>;
}

export function useQuery<T>(key: string | undefined, fetcher: () => Promise<T>, options?: { readonly refreshMs?: number }): IQuery<T> {
	useSyncExternalStore(l => (listeners.add(l), () => listeners.delete(l)), () => version);
	if (key && !entries.has(key)) {
		entries.set(key, { loading: false, at: 0, fetcher });
	}
	const entry = key ? entries.get(key)! : undefined;
	if (entry) {
		entry.fetcher = fetcher;
	}
	useEffect(() => {
		if (key && entry && !entry.promise && entry.at === 0) {
			void load(key);
		}
	}, [key, entry]);
	useEffect(() => {
		if (!key || !options?.refreshMs) {
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible' && !entries.get(key)?.promise) {
				void load(key);
			}
		}, options.refreshMs);
		return () => clearInterval(timer);
	}, [key, options?.refreshMs]);
	const refetch = useCallback(() => key ? load(key) : Promise.resolve(), [key]);
	return { data: entry?.data as T | undefined, error: entry?.error, loading: !!entry && (entry.loading || entry.at === 0), refetch };
}

/** Refetches every cached query whose key starts with one of the prefixes. */
export function invalidate(...prefixes: string[]): void {
	for (const key of entries.keys()) {
		if (prefixes.some(p => key.startsWith(p))) {
			void load(key);
		}
	}
}

/** Drops everything (organization switch, sign out). */
export function resetQueries(): void {
	entries.clear();
	emit();
}

if (typeof window !== 'undefined') {
	window.addEventListener('focus', () => {
		for (const [key, entry] of entries) {
			if (!entry.promise && Date.now() - entry.at > 60_000) {
				void load(key);
			}
		}
	});
}
