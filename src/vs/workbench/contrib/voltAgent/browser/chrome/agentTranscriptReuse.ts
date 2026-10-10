/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';

/**
 * A streamed reply is redrawn up to 20 times a second. Rebuilding every row each time re-parsed
 * all of its markdown, re-mounted an editor per finished code card and restarted every fade, so
 * frame cost grew with the reply (a 5 KB answer spent ~2.5 s in long tasks). The cache below
 * keeps the DOM of rows that did not change between two redraws: a row is drawn once, with its
 * own listener store, and moved into the next redraw while its signature still matches.
 */

/** Inserts `node` before `child`; an atomic move for a node already in the document, so animations, iframes and editors keep their state. */
function insertBefore(parent: Node, node: Node, child: Node | null): void {
	const target = parent as Node & { moveBefore?(node: Node, child: Node | null): void };
	if (target.moveBefore && node.isConnected && parent.isConnected) {
		try {
			target.moveBefore(node, child);
			return;
		} catch {
			// Different roots: fall back to a plain insert.
		}
	}
	parent.insertBefore(node, child);
}

/**
 * Makes `desired` the children of `parent`, in order, touching as little as possible: nodes
 * already in place stay put (a moved subtree is restyled, and its CSS animations restart), new
 * ones are inserted where they belong. Returns the children that are no longer wanted, still
 * attached, so the caller can rescue live content out of them before removing them.
 */
export function reconcileChildren(parent: Node, desired: readonly Node[]): Node[] {
	const wanted = new Set(desired);
	let cursor = parent.firstChild;
	for (const node of desired) {
		while (cursor && !wanted.has(cursor)) {
			cursor = cursor.nextSibling;
		}
		if (cursor === node) {
			cursor = cursor.nextSibling;
			continue;
		}
		insertBefore(parent, node, cursor);
	}
	return Array.from(parent.childNodes).filter(node => !wanted.has(node));
}

interface IRowEntry {
	readonly signature: string;
	readonly nodes: readonly Node[];
	readonly replies: readonly HTMLElement[];
	readonly store: DisposableStore;
	used: boolean;
}

/** Rendered rows of one reply, keyed by row id, kept while their signature holds. */
export class TranscriptRowCache implements IDisposable {

	private readonly rows = new Map<string, IRowEntry>();
	private readonly views = new Map<string, { view: IDisposable; used: boolean }>();
	private disposed = false;

	/** The cached nodes for `key` when it was drawn with this signature; marks it used for this pass. */
	take(key: string, signature: string): IRowEntry | undefined {
		const entry = this.rows.get(key);
		if (!entry || entry.used) {
			// Keys are unique within a pass (the caller numbers repeats), so a used entry is never handed out twice.
			return undefined;
		}
		if (entry.signature !== signature) {
			this.rows.delete(key);
			entry.store.dispose();
			return undefined;
		}
		entry.used = true;
		return entry;
	}

	put(key: string, signature: string, nodes: readonly Node[], replies: readonly HTMLElement[], store: DisposableStore): void {
		if (this.disposed) {
			store.dispose();
			return;
		}
		this.rows.get(key)?.store.dispose();
		this.rows.set(key, { signature, nodes, replies, store, used: true });
	}

	/** A long-lived view for a row whose content keeps changing (the streaming markdown). */
	view<T extends IDisposable>(key: string, create: () => T): T {
		let entry = this.views.get(key);
		if (!entry) {
			entry = { view: create(), used: true };
			this.views.set(key, entry);
		}
		entry.used = true;
		return entry.view as T;
	}

	/** Disposes what the last pass did not use and starts the next one. */
	sweep(): void {
		for (const [key, entry] of this.rows) {
			if (!entry.used) {
				this.rows.delete(key);
				entry.store.dispose();
			} else {
				entry.used = false;
			}
		}
		for (const [key, entry] of this.views) {
			if (!entry.used) {
				this.views.delete(key);
				entry.view.dispose();
			} else {
				entry.used = false;
			}
		}
	}

	get size(): number {
		return this.rows.size + this.views.size;
	}

	dispose(): void {
		this.disposed = true;
		for (const entry of this.rows.values()) {
			entry.store.dispose();
		}
		for (const entry of this.views.values()) {
			entry.view.dispose();
		}
		this.rows.clear();
		this.views.clear();
	}
}

/** Row caches per reply; the editor drops the whole set when it rebuilds the thread from scratch. */
export class TranscriptReuse implements IDisposable {

	private readonly caches = new Map<object, TranscriptRowCache>();

	for(owner: object): TranscriptRowCache {
		let cache = this.caches.get(owner);
		if (!cache) {
			cache = new TranscriptRowCache();
			this.caches.set(owner, cache);
		}
		return cache;
	}

	/** Drops the caches of replies that are no longer drawn from the cache. */
	retain(owners: ReadonlySet<object>): void {
		for (const [owner, cache] of this.caches) {
			if (!owners.has(owner)) {
				cache.dispose();
				this.caches.delete(owner);
			}
		}
	}

	dispose(): void {
		for (const cache of this.caches.values()) {
			cache.dispose();
		}
		this.caches.clear();
	}
}

/** A cheap string hash for signatures of large values. */
export function hashString(value: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = (h2 * 31 + c) | 0;
	}
	return `${value.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const RAW_HTML_OPEN = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i;
/** `[label]: url` reference definitions apply to the whole document; such text is drawn in one piece. */
const LINK_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]+\]:\s*\S/m;

/**
 * Splits markdown into pieces that render the same alone as together: breaks only at blank
 * lines before a new top-level block, never inside a fence, display math, a raw HTML block, a
 * comment, or between the items of one list (a loose list must stay one list). Joining the
 * pieces gives back `text`. Text with reference-style link definitions stays whole.
 */
export function splitMarkdownChunks(text: string): string[] {
	if (LINK_DEFINITION.test(text)) {
		return [text];
	}
	const lines = text.split('\n');
	const chunks: string[] = [];
	let current: string[] = [];
	let fence: string | undefined;
	let math = false;
	let rawHtml: string | undefined;
	let comment = false;
	let hasList = false;
	const flush = () => {
		chunks.push(current.join('\n'));
		current = [];
		hasList = false;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (fence) {
			current.push(line);
			const close = FENCE.exec(line);
			if (close && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1].trim()) {
				fence = undefined;
			}
			continue;
		}
		if (comment) {
			current.push(line);
			comment = !line.includes('-->');
			continue;
		}
		if (rawHtml) {
			current.push(line);
			if (new RegExp(`</${rawHtml}>`, 'i').test(line)) {
				rawHtml = undefined;
			}
			continue;
		}
		const open = FENCE.exec(line);
		if (open) {
			fence = open[1];
			current.push(line);
			continue;
		}
		const trimmed = line.trim();
		if (math) {
			current.push(line);
			if (trimmed.endsWith('$$')) {
				math = false;
			}
			continue;
		}
		if (trimmed.startsWith('$$') && !(trimmed.length > 2 && trimmed.endsWith('$$'))) {
			math = true;
			current.push(line);
			continue;
		}
		const html = RAW_HTML_OPEN.exec(line);
		if (html && !new RegExp(`</${html[1]}>`, 'i').test(line)) {
			rawHtml = html[1];
			current.push(line);
			continue;
		}
		if (/^ {0,3}<!--/.test(line) && !line.includes('-->')) {
			comment = true;
			current.push(line);
			continue;
		}
		if (trimmed === '') {
			current.push(line);
			// Look past the blank run to the next block: break before it only when it starts fresh.
			let next = i + 1;
			while (next < lines.length && lines[next].trim() === '') {
				next++;
			}
			if (next >= lines.length) {
				continue;
			}
			const following = lines[next];
			const continues = /^[ \t]/.test(following) || (hasList && LIST_ITEM.test(following));
			if (!continues && current.some(l => l.trim() !== '')) {
				for (let j = i + 1; j < next; j++) {
					current.push(lines[j]);
				}
				i = next - 1;
				flush();
			}
			continue;
		}
		if (LIST_ITEM.test(line)) {
			hasList = true;
		}
		current.push(line);
	}
	if (current.length) {
		chunks.push(current.join('\n'));
	}
	// Pieces were split on '\n'; put the separators back so joining is lossless.
	return chunks.map((chunk, index) => index < chunks.length - 1 ? chunk + '\n' : chunk);
}
