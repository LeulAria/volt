/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tiny LRU for prediction results. A cache hit must answer in well under a millisecond -
 * it sits directly on the keystroke path.
 */

export class PredictionCache<T> {
	private readonly map = new Map<string, T>();

	constructor(private readonly capacity = 64) { }

	get(key: string): T | undefined {
		const value = this.map.get(key);
		if (value !== undefined) {
			// Refresh recency.
			this.map.delete(key);
			this.map.set(key, value);
		}
		return value;
	}

	set(key: string, value: T): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.capacity) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) {
				this.map.delete(oldest);
			}
		}
		this.map.set(key, value);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}

const ANCHOR_TAIL = 200;
const SUFFIX_HEAD = 64;

interface IShownCompletion {
	readonly uri: string;
	/** The last characters before the cursor when the completion was made. */
	readonly anchor: string;
	readonly suffixHead: string;
	readonly text: string;
}

/**
 * Typing into a suggestion must never cost a model call: Cursor's and Copilot's ghost text keeps up
 * with the keyboard because each typed character that matches the suggestion just shortens it.
 * Remembers recent completions by where they were made; a later cursor position that is that spot
 * plus a prefix of the completion gets the rest back instantly.
 */
export class TypedThroughCache {
	private entries: IShownCompletion[] = [];

	constructor(private readonly capacity = 8) { }

	remember(uri: string, prefix: string, suffix: string, text: string): void {
		const anchor = prefix.slice(-ANCHOR_TAIL);
		const suffixHead = suffix.slice(0, SUFFIX_HEAD);
		this.entries = this.entries.filter(entry => entry.uri !== uri || entry.anchor !== anchor || entry.suffixHead !== suffixHead);
		this.entries.push({ uri, anchor, suffixHead, text });
		if (this.entries.length > this.capacity) {
			this.entries.shift();
		}
	}

	/** The rest of a remembered completion the user is typing through, or undefined. */
	lookup(uri: string, prefix: string, suffix: string): string | undefined {
		const suffixHead = suffix.slice(0, SUFFIX_HEAD);
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry.uri !== uri || entry.suffixHead !== suffixHead) {
				continue;
			}
			const typed = typedSince(prefix, entry.anchor, entry.text.length);
			if (typed === undefined || !entry.text.startsWith(typed)) {
				continue;
			}
			const rest = entry.text.slice(typed.length);
			if (rest.trim()) {
				return rest;
			}
		}
		return undefined;
	}

	clear(): void {
		this.entries = [];
	}
}

/**
 * What was typed after `anchor`, when `prefix` is `...anchor + typed` with `typed` at most
 * `maxTyped` long; undefined when the cursor is somewhere else.
 */
export function typedSince(prefix: string, anchor: string, maxTyped: number): string | undefined {
	const at = prefix.lastIndexOf(anchor, prefix.length - anchor.length);
	if (at < 0) {
		return undefined;
	}
	const typed = prefix.slice(at + anchor.length);
	return typed.length <= maxTyped ? typed : undefined;
}

/** djb2 - stable, fast, good enough for cache keys (not security). */
export function hashString(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Key = model + file + a window around the cursor. The tail of the prefix and the head of
 * the suffix identify the position; the full excerpt would thrash the hash on every
 * unrelated edit far away in the file.
 */
export function predictionCacheKey(modelRef: string, uri: string, prefix: string, suffix: string): string {
	return `${modelRef}|${hashString(uri)}|${hashString(prefix.slice(-256))}|${hashString(suffix.slice(0, 128))}`;
}
