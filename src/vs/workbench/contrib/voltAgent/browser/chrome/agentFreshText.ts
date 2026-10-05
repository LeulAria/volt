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
 * Streamed reply text shows up in the accent color and fades to the normal color. A reply is
 * rebuilt on every streamed frame, so the tracker remembers when each stretch of text first
 * appeared and wraps it again on each render with a negative animation delay: the fade picks
 * up where it was instead of restarting, and finishes on its own once the stream stops.
 */
export class FreshTextTracker {

	private readonly replies = new WeakMap<object, IReplyText>();

	/**
	 * `roots` hold the reply's rendered text in reading order. Text is new when the reply grew
	 * past what the previous render showed; a reply seen for the first time only counts as new
	 * while it is still streaming, so reopening a finished chat does not flash.
	 */
	apply(owner: object, roots: readonly HTMLElement[], streaming: boolean, now = Date.now()): void {
		const text = roots.map(root => root.textContent ?? '').join('');
		let reply = this.replies.get(owner);
		if (!reply) {
			if (!streaming) {
				return;
			}
			reply = { text: '', chunks: [] };
			this.replies.set(owner, reply);
		}
		if (text.length > reply.text.length) {
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
		wrapFreshText(roots, reply.chunks, now);
	}
}

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
			if (!node.parentElement?.closest(FRESH_TEXT_SKIP)) {
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
