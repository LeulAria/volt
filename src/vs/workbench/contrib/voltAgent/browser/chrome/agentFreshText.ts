/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How long streamed text takes to fade from the accent color to the normal text color. */
export const FRESH_TEXT_FADE_MS = 1100;

export const FRESH_TEXT_CLASS = 'volt-agent-fresh-text';

const FRESH_TEXT_SKIP = 'code, a, blockquote, .katex, .volt-agent-path-pill';

interface IChunk {
	readonly start: number;
	readonly end: number;
	readonly at: number;
}

interface IReplyText {
	text: string;
	chunks: IChunk[];
}

/**
 * A stretch of a reply's text, in reading order. `roots` are the elements drawn for it in this
 * frame; a stretch without them kept its DOM from an earlier frame (and the fade spans in it).
 */
export interface IFreshTextPart {
	readonly text: string;
	readonly roots?: readonly HTMLElement[];
}

/**
 * Streamed reply text shows up in the accent color and fades to the normal color. The tracker
 * remembers when each stretch of text first appeared and wraps the stretches drawn anew with a
 * negative animation delay: the fade picks up where it was instead of restarting, and finishes
 * on its own once the stream stops. DOM kept from an earlier frame keeps its running spans.
 */
export class FreshTextTracker {

	private readonly replies = new WeakMap<object, IReplyText>();

	/**
	 * `roots` hold the reply's rendered text in reading order, all of it drawn in this frame. Text
	 * is new when the reply grew past what the previous render showed; a reply seen for the first
	 * time only counts as new while it is still streaming, so reopening a finished chat does not flash.
	 */
	apply(owner: object, roots: readonly HTMLElement[], streaming: boolean, now = Date.now()): void {
		this.applyParts(owner, roots.map(root => ({ text: root.textContent ?? '', roots: [root] })), streaming, now);
	}

	/** {@link apply} for a reply redrawn in part: only the parts with `roots` are walked and wrapped. */
	applyParts(owner: object, parts: readonly IFreshTextPart[], streaming: boolean, now = Date.now()): void {
		const text = parts.map(part => part.text).join('');
		let reply = this.replies.get(owner);
		if (!reply) {
			if (!streaming) {
				return;
			}
			reply = { text: '', chunks: [] };
			this.replies.set(owner, reply);
		}
		// Growth counts only while the reply streams: the redraw once it ends lays its text out whole
		// (a live reply is drawn block by block), which is no new text.
		if (streaming && text.length > reply.text.length) {
			reply.chunks.push({ start: commonPrefixLength(reply.text, text), end: text.length, at: now });
		}
		reply.text = text;
		reply.chunks = reply.chunks.filter(chunk => now - chunk.at < FRESH_TEXT_FADE_MS && chunk.start < text.length);
		if (!reply.chunks.length) {
			if (!streaming) {
				this.replies.delete(owner);
			}
			return;
		}
		let offset = 0;
		for (const part of parts) {
			const start = offset;
			offset += part.text.length;
			if (!part.roots?.length) {
				continue;
			}
			// Only the chunks that reach into this part, shifted to its own offsets.
			const chunks = reply.chunks
				.filter(chunk => chunk.start < offset && chunk.end > start)
				.map(chunk => ({ start: Math.max(0, chunk.start - start), end: chunk.end - start, at: chunk.at }));
			if (chunks.length) {
				wrapFreshText(part.roots, chunks, now);
			}
		}
	}
}

const TABLE_PARTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP']);

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
		i++;
	}
	return i;
}

function wrapFreshText(roots: readonly HTMLElement[], chunks: readonly IChunk[], now: number): void {
	const nodes: { node: Text; start: number }[] = [];
	let offset = 0;
	for (const root of roots) {
		const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const length = node.nodeValue?.length ?? 0;
			// Chips (inline code, file paths), links, quotes and math render as they are; only prose fades in.
			// The line breaks between table parts stay bare: a span in a row becomes an extra cell.
			if (!node.parentElement?.closest(FRESH_TEXT_SKIP) && !TABLE_PARTS.has(node.parentElement?.tagName ?? '')) {
				nodes.push({ node: node as Text, start: offset });
			}
			offset += length;
		}
	}
	for (const { node, start } of nodes) {
		const end = start + (node.nodeValue?.length ?? 0);
		const ranges = chunks
			.filter(chunk => chunk.start < end && chunk.end > start)
			.map(chunk => ({ from: Math.max(chunk.start, start) - start, to: Math.min(chunk.end, end) - start, age: now - chunk.at }))
			// Split from the end so earlier offsets stay valid.
			.sort((a, b) => b.from - a.from);
		for (const range of ranges) {
			if (range.to < (node.nodeValue?.length ?? 0)) {
				node.splitText(range.to);
			}
			const fresh = range.from > 0 ? node.splitText(range.from) : node;
			const span = node.ownerDocument.createElement('span');
			span.className = FRESH_TEXT_CLASS;
			span.style.animationDuration = `${FRESH_TEXT_FADE_MS}ms`;
			span.style.animationDelay = `-${Math.max(0, Math.round(range.age))}ms`;
			fresh.replaceWith(span);
			span.appendChild(fresh);
		}
	}
}
