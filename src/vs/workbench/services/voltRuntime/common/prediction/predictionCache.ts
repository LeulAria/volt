/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
