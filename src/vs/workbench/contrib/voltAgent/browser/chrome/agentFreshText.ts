/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, isHTMLElement } from '../../../../../base/browser/dom.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';

/** How long streamed text takes to fade from the accent color to the normal text color. */
export const FRESH_TEXT_FADE_MS = 1100;

export const FRESH_TEXT_CLASS = 'volt-agent-fresh-text';

/** Text arriving this soon after the last chunk joins its fade (one span for both). */
export const FRESH_TEXT_COALESCE_MS = 120;

/**
 * How often a fading span changes colour. A colour that changed on every frame made every frame
 * of a streaming reply paint its newest lines again: on a 120 Hz screen the compositor then had
 * a frame in flight at all times and held each next one back until that one was on screen, the
 * frame that shows a key typed in the composer included (one refresh later than in an idle chat).
 * Stepping at 60 Hz is what a 60 Hz screen shows of the same fade; on a faster screen every
 * other frame is left free of text painting.
 */
export const FRESH_TEXT_STEP_MS = 1000 / 60;

/** CSS `ease-out`, cubic-bezier(0, 0, 0.58, 1), at `x` in 0..1. */
function easeOut(x: number): number {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 40; i++) {
		const t = (lo + hi) / 2;
		// x(t) with control points x1 = 0 and x2 = 0.58.
		if (3 * (1 - t) * t * t * 0.58 + t * t * t < x) {
			lo = t;
		} else {
			hi = t;
		}
	}
	const t = (lo + hi) / 2;
	// y(t) with control points y1 = 0 and y2 = 1.
	return 3 * (1 - t) * t * t + t * t * t;
}

/**
 * `ease-out` held between `steps` equal steps, as a CSS `linear()` easing: during step k the
 * value is ease-out at the step's start, so the colour is the one the smooth fade had there.
 */
export function steppedEaseOut(steps: number): string {
	const stops: string[] = [];
	for (let k = 0; k < steps; k++) {
		const pct = (n: number) => `${Math.round(n / steps * 1e6) / 1e4}%`;
		stops.push(`${Math.round(easeOut(k / steps) * 1e4) / 1e4} ${pct(k)} ${pct(k + 1)}`);
	}
	return `linear(${stops.join(', ')}, 1 100%)`;
}

const FRESH_TEXT_EASING = steppedEaseOut(Math.round(FRESH_TEXT_FADE_MS / FRESH_TEXT_STEP_MS));

/**
 * How far into its fade a span starts (the animation's negative delay), so that its steps fall on
 * the clock every other span steps on: `timelineMs` is the document timeline's time of the frame
 * the animation starts in. Up to one step more than `ageMs`. All spans then change colour in the
 * same frames, and the frames between hold no text painting at all.
 */
export function alignedFadeDelay(ageMs: number, timelineMs: number, stepMs = FRESH_TEXT_STEP_MS): number {
	const age = Math.max(0, ageMs);
	const offset = (((timelineMs - age) % stepMs) + stepMs) % stepMs;
	return Math.round((age + offset) * 100) / 100;
}

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
	/** When the newest stretch of streamed text appeared, in any reply this tracker draws. */
	private lastChunkAt = -Infinity;

	/** The fades this tracker steps itself: each span with the timeline time its fade began at. */
	private readonly driven = new Map<HTMLElement, number>();
	private lastStep = NaN;

	/**
	 * `timelineNow` gives the document timeline's time of the frame being drawn; with it the spans'
	 * colour steps share one clock ({@link alignedFadeDelay}). Without it each span steps on its own.
	 *
	 * With `onDidStartFade` the tracker's owner steps the fades ({@link step}) and the spans'
	 * animations stay paused: the browser gives a running animation a main frame at every screen
	 * refresh, colour change or not, and with a main frame begun at every refresh a key typed in the
	 * composer always waits for the next one. `onDidStartFade` is called when a span starts to fade.
	 */
	constructor(
		private readonly timelineNow?: (document: Document) => number | undefined,
		private readonly onDidStartFade?: () => void,
	) { }

	/**
	 * Moves the fades to the frame at `timelineMs`: every span shows the colour of its fade's current
	 * step (what its animation would show running), and a span whose fade is over is unwrapped. The
	 * colours change once per step, in the first frame of it. False once no fade is left.
	 */
	step(timelineMs: number): boolean {
		const step = Math.floor(timelineMs / FRESH_TEXT_STEP_MS);
		if (step !== this.lastStep) {
			this.lastStep = step;
			for (const [span, start] of this.driven) {
				const age = timelineMs - start;
				if (age >= FRESH_TEXT_FADE_MS) {
					// Also a span not in the document now (a chat kept aside): it would come back held mid-fade.
					this.driven.delete(span);
					span.replaceWith(...span.childNodes);
				} else if (span.isConnected) {
					span.style.animationDelay = `-${Math.round(age * 100) / 100}ms`;
				}
			}
		}
		return this.driven.size > 0;
	}

	/** Whether {@link step} has fades to move. */
	get hasDrivenFades(): boolean {
		return this.driven.size > 0;
	}

	/**
	 * `roots` hold the reply's rendered text in reading order, all of it drawn in this frame. Text
	 * is new when the reply grew past what the previous render showed; a reply seen for the first
	 * time only counts as new while it is still streaming, so reopening a finished chat does not flash.
	 */
	/**
	 * Whether streamed text drawn by this tracker is still fading at `now`. Before a reply's first
	 * words, and once its last words have faded, nothing is: the thinking line, a tool row or the
	 * user's own prompt drawn while the turn runs start no fade.
	 */
	isFading(now = Date.now()): boolean {
		return now - this.lastChunkAt < FRESH_TEXT_FADE_MS;
	}

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
			const start = commonPrefixLength(reply.text, text);
			const last = reply.chunks.at(-1);
			if (last && last.end === start && now - last.at < FRESH_TEXT_COALESCE_MS) {
				// Text that lands within a few frames of the last chunk fades with it: one span, not one
				// per 50 ms chunk. Every animating span costs a style recalc on every frame for 1.1 s.
				reply.chunks[reply.chunks.length - 1] = { start: last.start, end: text.length, at: last.at };
			} else {
				reply.chunks.push({ start, end: text.length, at: now });
				this.lastChunkAt = Math.max(this.lastChunkAt, now);
			}
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
				wrapFreshText(part.roots, chunks, now, this.timelineNow, this.onDidStartFade ? this.drive : undefined);
			}
		}
	}

	private readonly drive = (span: HTMLElement, startTimelineMs: number) => {
		this.driven.set(span, startTimelineMs);
		this.onDidStartFade?.();
	};
}

/**
 * Unwraps each fade span under `root` once its fade ends. Rows kept between redraws keep their
 * spans, and a finished fade still holds its animation (fill mode `both`): a long chat piled up
 * thousands of them, each one applied on every style pass.
 */
export function settleFreshText(root: HTMLElement): IDisposable {
	return addDisposableListener(root, 'animationend', e => {
		const span = e.target;
		if (isHTMLElement(span) && span.classList.contains(FRESH_TEXT_CLASS) && e.animationName === FRESH_TEXT_CLASS) {
			span.replaceWith(...span.childNodes);
		}
	});
}

const TABLE_PARTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP']);

/** When the chunk a fade span shows first appeared. */
const spanChunkAt = new WeakMap<Node, number>();

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
		i++;
	}
	return i;
}

function wrapFreshText(roots: readonly HTMLElement[], chunks: readonly IChunk[], now: number, timelineNow?: (document: Document) => number | undefined, drive?: (span: HTMLElement, startTimelineMs: number) => void): void {
	const nodes: { node: Text; start: number }[] = [];
	let offset = 0;
	for (const root of roots) {
		const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const length = node.nodeValue?.length ?? 0;
			// Chips (inline code, file paths), links, quotes and math render as they are; only prose fades in.
			// The line breaks between table parts stay bare: a span in a row becomes an extra cell.
			// Rows kept from the last redraw already carry their fade (still running at the right point).
			if (!node.parentElement?.closest(FRESH_TEXT_SKIP) && !TABLE_PARTS.has(node.parentElement?.tagName ?? '') && !node.parentElement?.classList.contains(FRESH_TEXT_CLASS)) {
				nodes.push({ node: node as Text, start: offset });
			}
			offset += length;
		}
	}
	for (const { node, start } of nodes) {
		const end = start + (node.nodeValue?.length ?? 0);
		const ranges = chunks
			.filter(chunk => chunk.start < end && chunk.end > start)
			.map(chunk => ({ from: Math.max(chunk.start, start) - start, to: Math.min(chunk.end, end) - start, at: chunk.at, age: now - chunk.at }))
			// Split from the end so earlier offsets stay valid.
			.sort((a, b) => b.from - a.from);
		for (const range of ranges) {
			if (range.to < (node.nodeValue?.length ?? 0)) {
				node.splitText(range.to);
			}
			const fresh = range.from > 0 ? node.splitText(range.from) : node;
			// Text added after its chunk's span (a block that grew in place) joins that span and its fade.
			const before = fresh.previousSibling;
			if (fresh === node && before && spanChunkAt.get(before) === range.at) {
				before.appendChild(fresh);
				continue;
			}
			const span = node.ownerDocument.createElement('span');
			spanChunkAt.set(span, range.at);
			span.className = FRESH_TEXT_CLASS;
			span.style.animationDuration = `${FRESH_TEXT_FADE_MS}ms`;
			span.style.animationTimingFunction = FRESH_TEXT_EASING;
			const timeline = timelineNow?.(node.ownerDocument);
			const delay = timeline === undefined ? Math.max(0, Math.round(range.age)) : alignedFadeDelay(range.age, timeline);
			span.style.animationDelay = `-${delay}ms`;
			if (drive && timeline !== undefined) {
				// Held at its current step; the tracker's owner moves it on (FreshTextTracker.step).
				span.style.animationPlayState = 'paused';
				drive(span, timeline - delay);
			}
			fresh.replaceWith(span);
			span.appendChild(fresh);
		}
	}
}
