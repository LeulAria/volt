/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { CITATION_CONTEXT_CHARS, IAgentCitation, IQuoteRange, locateQuote } from '../composer/agentCitation.js';

/**
 * Where a cited quote lives in the transcript DOM. Each assistant turn carries its turn id
 * (`data-message-id`); offsets count the text of the turn's body, the same way on capture and
 * on reveal, so prefix, suffix and start all refer to one string.
 */

const TURN_SELECTOR = '.volt-agent-turn.agent[data-message-id]';
/** The CSS Custom Highlight that paints a revealed quote (see `::highlight` in agentEditor.css). */
const HIGHLIGHT_NAME = 'volt-agent-citation';
const HIGHLIGHT_MS = 2400;

export type ICitationSource = Pick<IAgentCitation, 'messageId' | 'quote' | 'prefix' | 'suffix' | 'start'>;

function elementOf(node: Node): Element | null {
	return node instanceof Element ? node : node.parentElement;
}

/** The text a citation's offsets count: the reply body, without the turn's footer. */
function citationRoot(turn: Element): Element {
	return turn.querySelector('.volt-agent-thread-body') ?? turn;
}

/**
 * The source of a selection that lies inside one assistant reply in `thread`, or undefined when
 * it spans several messages or is not in a reply (the quote is then cited without a source).
 */
export function captureCitationSource(range: Range, thread: HTMLElement): ICitationSource | undefined {
	const turn = elementOf(range.startContainer)?.closest(TURN_SELECTOR);
	if (!turn || turn !== elementOf(range.endContainer)?.closest(TURN_SELECTOR) || !thread.contains(turn)) {
		return undefined;
	}
	const root = citationRoot(turn);
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
		return undefined;
	}
	const raw = range.toString();
	const quote = raw.trim();
	const messageId = (turn as HTMLElement).dataset.messageId;
	if (!quote || !messageId) {
		return undefined;
	}
	const before = root.ownerDocument.createRange();
	before.setStart(root, 0);
	before.setEnd(range.startContainer, range.startOffset);
	const start = before.toString().length + (raw.length - raw.trimStart().length);
	const text = root.textContent ?? '';
	const end = start + quote.length;
	return {
		messageId,
		quote,
		start,
		prefix: text.slice(Math.max(0, start - CITATION_CONTEXT_CHARS), start),
		suffix: text.slice(end, end + CITATION_CONTEXT_CHARS),
	};
}

/** A DOM range over `[start, end)` of `root`'s text. */
export function textRange(root: Node, offsets: IQuoteRange): Range | undefined {
	const doc = root.ownerDocument ?? (root as Document);
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const range = doc.createRange();
	let seen = 0;
	let started = false;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const length = node.data.length;
		if (!started && offsets.start < seen + length) {
			range.setStart(node, offsets.start - seen);
			started = true;
		}
		if (started && offsets.end <= seen + length) {
			range.setEnd(node, offsets.end - seen);
			return range;
		}
		seen += length;
	}
	return undefined;
}

/** The quote's range in `thread` today, or undefined when its reply or its words are gone. */
export function findCitation(thread: HTMLElement, citation: ICitationSource): Range | undefined {
	if (!citation.messageId) {
		return undefined;
	}
	const turn = Array.from(thread.querySelectorAll<HTMLElement>(TURN_SELECTOR)).find(candidate => candidate.dataset.messageId === citation.messageId);
	if (!turn) {
		return undefined;
	}
	const root = citationRoot(turn);
	const located = locateQuote(root.textContent ?? '', citation);
	return located ? textRange(root, located) : undefined;
}

let clearHighlight: IDisposable | undefined;

/** Scrolls the quote into view and paints it briefly. False when the source is not found. */
export function revealCitation(thread: HTMLElement, citation: ICitationSource): boolean {
	const range = findCitation(thread, citation);
	if (!range) {
		return false;
	}
	elementOf(range.startContainer)?.scrollIntoView({ block: 'center', inline: 'nearest' });
	const win = getWindow(thread) as Window & typeof globalThis;
	const highlights = win.CSS?.highlights;
	if (highlights && typeof win.Highlight === 'function') {
		clearHighlight?.dispose();
		highlights.set(HIGHLIGHT_NAME, new win.Highlight(range));
		const timer = win.setTimeout(() => highlights.delete(HIGHLIGHT_NAME), HIGHLIGHT_MS);
		clearHighlight = toDisposable(() => {
			win.clearTimeout(timer);
			highlights.delete(HIGHLIGHT_NAME);
		});
	}
	return true;
}

/** A chat that can show a cited reply: each open agent editor registers its transcript. */
export interface ICitationTarget {
	sessionId(): string;
	reveal(citation: IAgentCitation): boolean;
}

const targets = new Set<ICitationTarget>();

export function registerCitationTarget(target: ICitationTarget): IDisposable {
	targets.add(target);
	return toDisposable(() => targets.delete(target));
}

/**
 * Shows a citation in the chat it was quoted from: a side chat's quote opens in the main chat
 * when that chat is on screen. `fallback` (the citing chat) is tried last.
 */
export function revealCitationInChats(citation: IAgentCitation, fallback: ICitationTarget): boolean {
	for (const target of targets) {
		if (target.sessionId() === citation.agentId && target.reveal(citation)) {
			return true;
		}
	}
	return fallback.sessionId() !== citation.agentId && fallback.reveal(citation);
}
