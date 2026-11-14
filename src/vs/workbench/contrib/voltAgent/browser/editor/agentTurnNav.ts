/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { AgentThreadView } from './agentThreadView.js';
import { stepTurnIndex, ThreadGlide, threadGlide } from './agentThreadScroll.js';

export interface IAgentTurnNavTurn {
	/** The sent message: the card's first line. */
	readonly prompt: string;
	/** The start of its reply, read when the card opens. */
	readonly reply: () => string | undefined;
}

/** Sent messages above the drawn exchanges (a long chat draws its older ones as the reader nears them). */
export interface IAgentTurnNavUndrawn {
	readonly count: () => number;
	/** Draws them all now. */
	readonly draw: () => void;
	/** Draws them a frame's worth at a time, the view held still, then calls `done`; a chat switch drops it. */
	readonly drawInFrames: (done: () => void) => void;
}

/** Resting on a tick this long opens its card down to the start of the reply. */
const REPLY_DELAY_MS = 450;
/** Space between ticks; many messages squeeze them into half the thread's height. */
const STEP_MAX = 9;
const STEP_MIN = 3;
const RAIL_WIDTH = 16;
/** A revealed message lands this far below the top edge, as the first one sits at rest. */
const LANDING_OFFSET = 8;
/** Ticks never drop below this many, however short the thread is. */
const TICKS_MIN = 12;

/** The rail of each thread, so keyboard commands can step through its messages. */
const navs = new WeakMap<AgentThreadView, AgentTurnNav>();

/** Plain text of a reply's markdown, cut down for the card. */
export function turnNavPreview(markdown: string, max = 280): string {
	const plain = renderAsPlaintext({ value: markdown.slice(0, max * 4) }).replace(/\s+/g, ' ').trim();
	return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain;
}

/**
 * How many ticks the rail draws for a thread `height` px tall: as many as fit in half of it at the
 * smallest step. A longer chat gets a window of that many ticks around the messages in view, not
 * a tick per message (a thousand of them ran far past the thread and restyled the window on every switch).
 */
export function turnNavCapacity(height: number): number {
	return Math.max(TICKS_MIN, Math.floor(Math.max(0, height) * 0.5 / STEP_MIN));
}

/**
 * The first message the rail's window of `capacity` ticks shows, out of `total`. It stays at
 * `start` while the messages in view (`first` to `last`, -1 when none is drawn) are inside it,
 * and otherwise moves so they sit in its middle; with none in view it shows the last messages.
 */
export function turnNavWindowStart(total: number, capacity: number, start: number, first: number, last: number): number {
	const max = Math.max(0, total - capacity);
	if (first < 0) {
		return max;
	}
	if (first >= start && last < start + capacity && start <= max) {
		return start;
	}
	const middle = Math.floor((first + Math.min(last, first + capacity - 1)) / 2);
	return Math.min(max, Math.max(0, middle - Math.floor(capacity / 2)));
}

/**
 * Whether the rail has somewhere to go: a sent message off screen (or not drawn yet). With every
 * message on screen its two or three ticks read as a stray glyph in the margin, so it rests unseen.
 */
export function turnNavHasOffscreen(drawn: number, first: number, last: number, undrawn: number): boolean {
	return undrawn > 0 || (drawn > 0 && (first !== 0 || last !== drawn - 1));
}

/**
 * The drawn messages on screen between `top` and `bottom`, as `[first, last]` (`[-1, -1]` when
 * none is). Their boxes come in document order, stacked down the thread, so the first one is found
 * by bisecting and only the ones on screen are measured after it: measuring every drawn message
 * cost a thousand layout reads per scrolled frame in a long chat.
 */
export function turnNavVisibleRange(count: number, rectAt: (index: number) => { readonly top: number; readonly bottom: number }, top: number, bottom: number): [number, number] {
	let low = 0;
	let high = count - 1;
	let first = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (rectAt(mid).bottom > top) {
			first = mid;
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}
	if (first < 0 || rectAt(first).top >= bottom) {
		return [-1, -1];
	}
	let last = first;
	while (last + 1 < count && rectAt(last + 1).top < bottom) {
		last++;
	}
	return [first, last];
}

/**
 * A tick per sent message down the transcript's left edge, as in T3 Code. Ticks for the
 * messages on screen are lit; hovering one shows the message (and, resting there, the start
 * of its reply); clicking scrolls to it; the arrows step to the previous or next message.
 */
export class AgentTurnNav extends Disposable {

	/** The rail drawn for a thread, if one was made. */
	static forThread(thread: AgentThreadView): AgentTurnNav | undefined {
		return navs.get(thread);
	}

	readonly element: HTMLElement;

	private readonly up: HTMLButtonElement;
	private readonly down: HTMLButtonElement;
	private readonly ticksEl: HTMLElement;
	private readonly card: HTMLElement;
	private readonly cardPrompt: HTMLElement;
	private readonly cardReply: HTMLElement;
	private readonly glide: ThreadGlide;
	private readonly syncFrame = this._register(new MutableDisposable());
	private turns: readonly IAgentTurnNavTurn[] = [];
	/** The drawn ticks: tick `i` stands for message `windowStart + i`. */
	private ticks: HTMLButtonElement[] = [];
	private windowStart = 0;
	/** The label each tick carries now, so a redraw sets only those that changed. */
	private tickLabels: string[] = [];
	/** The thread's height when last laid out (the window's size), read without forcing a layout. */
	private threadHeight = 0;
	private readonly layoutFrame = this._register(new MutableDisposable());
	/** The exchange of each drawn sent message, kept until the transcript's nodes change. */
	private exchangeList: HTMLElement[] | undefined;
	private hovered: number | undefined;
	/** Once a card has shown a reply, the next ones do at once until the pointer leaves the rail. */
	private warm = false;
	/** Sent messages above the drawn exchanges (a long chat draws its older ones when idle), and how to draw them now. */
	private undrawn: IAgentTurnNavUndrawn | undefined;
	private replyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly thread: AgentThreadView) {
		super();
		navs.set(thread, this);
		this._register(toDisposable(() => navs.delete(thread)));
		this.glide = threadGlide(thread.scroll, thread.element);
		this._register(toDisposable(() => this.glide.cancel()));
		this.element = append(thread.element, $('.volt-agent-turn-nav.hidden'));
		this.element.setAttribute('role', 'navigation');
		this.element.setAttribute('aria-label', localize('voltAgent.turnNav', "Messages"));
		this.up = this.arrow(Codicon.chevronUp, localize('voltAgent.turnNav.previous', "Previous message"), -1);
		this.ticksEl = append(this.element, $('.ticks'));
		this.down = this.arrow(Codicon.chevronDown, localize('voltAgent.turnNav.next', "Next message"), 1);
		this.card = append(this.element, $('.volt-agent-turn-nav-card'));
		this.card.setAttribute('aria-hidden', 'true');
		this.cardPrompt = append(this.card, $('.prompt'));
		this.cardReply = append(this.card, $('.reply'));

		this._register(thread.scroll.onScroll(() => this.scheduleSync()));
		this._register(addDisposableListener(this.element, 'mouseleave', () => {
			this.warm = false;
			this.hideCard();
		}));
		// A wheel or drag during the glide hands the scroll back to the user.
		this._register(addDisposableListener(thread.element, 'wheel', () => this.glide.cancel(), { passive: true }));
		const observer = new (getWindow(thread.element).ResizeObserver)(entries => {
			this.threadHeight = entries.at(-1)?.contentRect.height ?? this.threadHeight;
			this.layout();
		});
		observer.observe(thread.element);
		this._register(toDisposable(() => observer.disconnect()));
		// A scroll reads the list every frame; a query over a long chat's tens of thousands of nodes
		// costs more than the frame's other work, so it is redone only after nodes come or go.
		const mutations = new (getWindow(thread.element).MutationObserver)(() => this.exchangeList = undefined);
		mutations.observe(thread.inner, { childList: true, subtree: true });
		this._register(toDisposable(() => mutations.disconnect()));
		this._register(toDisposable(() => this.clearReplyTimer()));
	}

	/**
	 * The sent messages, in order; call after the transcript is rendered. The rail is laid out in
	 * the next frame, with the thread's own layout, not forced in the middle of drawing it.
	 */
	setTurns(turns: readonly IAgentTurnNavTurn[]): void {
		const changed = turns.length !== this.turns.length;
		this.turns = turns;
		const count = Math.min(turns.length, turnNavCapacity(this.threadHeight || getWindow(this.element).innerHeight));
		if (changed) {
			// A different chat: its rail starts at its last messages (sync moves it to what is in view).
			this.windowStart = Math.max(0, turns.length - count);
		}
		this.drawTicks(count);
		this.scheduleLayout();
	}

	/** `count` ticks from {@link windowStart}, reusing the drawn ones; only changed labels are set. */
	private drawTicks(count: number): void {
		if (this.ticks.length !== count) {
			this.hideCard();
			while (this.ticks.length < count) {
				this.ticks.push(this.tick(this.ticks.length));
			}
			this.ticks.length = count;
			this.tickLabels.length = Math.min(this.tickLabels.length, count);
			this.ticksEl.replaceChildren(...this.ticks);
		}
		for (let index = 0; index < count; index++) {
			const prompt = this.turns[this.windowStart + index]?.prompt ?? '';
			if (this.tickLabels[index] !== prompt) {
				this.tickLabels[index] = prompt;
				this.ticks[index].setAttribute('aria-label', localize('voltAgent.turnNav.goTo', "Go to message: {0}", prompt));
			}
		}
	}

	private scheduleLayout(): void {
		if (!this.layoutFrame.value) {
			this.layoutFrame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
				this.layoutFrame.clear();
				this.layout();
			});
		}
	}

	layout(): void {
		this.layoutFrame.clear();
		const threadRect = this.thread.element.getBoundingClientRect();
		// The rail lives in the room left of the transcript column: the sent card's edge, as the
		// turn itself can bleed to the thread's edge while pinned. Read from the last exchange, which
		// is always laid out: an older one off screen would be laid out just to answer this.
		const inner = this.thread.inner;
		const column = (inner.lastElementChild?.querySelector('.volt-agent-turn.user .volt-agent-bubble') ?? inner.querySelector('.volt-agent-turn.user .volt-agent-bubble') ?? inner.querySelector('.volt-agent-turn'))?.getBoundingClientRect();
		const gutter = column ? column.left - threadRect.left : 0;
		const show = this.turns.length > 1 && gutter >= RAIL_WIDTH + 2 && threadRect.height > 0;
		this.element.classList.toggle('hidden', !show);
		if (!show) {
			this.hideCard();
			return;
		}
		this.threadHeight = threadRect.height;
		const count = Math.min(this.turns.length, turnNavCapacity(threadRect.height));
		if (count !== this.ticks.length) {
			this.windowStart = Math.min(this.windowStart, Math.max(0, this.turns.length - count));
			this.drawTicks(count);
		}
		const step = Math.max(STEP_MIN, Math.min(STEP_MAX, Math.floor(threadRect.height * 0.5 / count)));
		this.element.style.setProperty('--volt-turn-nav-step', `${step}px`);
		this.element.style.left = `${Math.max(2, Math.floor((gutter - RAIL_WIDTH) / 2))}px`;
		this.sync();
	}

	private arrow(icon: ThemeIcon, label: string, direction: -1 | 1): HTMLButtonElement {
		const button = append(this.element, $('button.arrow')) as HTMLButtonElement;
		button.type = 'button';
		button.tabIndex = -1;
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		this._register(addDisposableListener(button, 'mouseenter', () => this.hideCard()));
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.stepTo(direction);
		}));
		return button;
	}

	/** Tick `slot` of the window: it stands for whichever message the window puts there. */
	private tick(slot: number): HTMLButtonElement {
		const tick = $('button.tick') as HTMLButtonElement;
		tick.type = 'button';
		append(tick, $('span.line'));
		tick.addEventListener('mouseenter', () => this.showCard(this.windowStart + slot));
		tick.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.reveal(this.windowStart + slot);
		});
		return tick;
	}

	/** A chat that draws its older exchanges later says how many sent messages are not drawn yet. */
	setUndrawn(undrawn: IAgentTurnNavUndrawn): void {
		this.undrawn = undrawn;
	}

	/**
	 * Draws the messages not drawn yet over the next frames, keeping the view still, then calls
	 * `done` (for going to the first message). False, and `done` is not called, when all are drawn.
	 */
	drawUndrawnThen(done: () => void): boolean {
		if (!this.undrawn?.count()) {
			return false;
		}
		this.undrawn.drawInFrames(done);
		return true;
	}

	/** Exchanges drawn so far, one per sent message: the turn and everything answering it. Tick `i` is exchange `i - skipped`. */
	private exchanges(): HTMLElement[] {
		this.exchangeList ??= Array.from(this.thread.inner.querySelectorAll<HTMLElement>('.volt-agent-turn.user'), turn => turn.parentElement ?? turn);
		return this.exchangeList;
	}

	private scheduleSync(): void {
		if (!this.syncFrame.value && !this.element.classList.contains('hidden')) {
			this.syncFrame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
				this.syncFrame.clear();
				this.sync();
			});
		}
	}

	/** Lights the ticks of messages on screen and enables the arrows that have somewhere to go. */
	private sync(): void {
		const viewport = this.thread.scroll.getDomNode().getBoundingClientRect();
		const landing = viewport.top + LANDING_OFFSET;
		const skipped = this.undrawn?.count() ?? 0;
		const exchanges = this.exchanges();
		const rects = new Map<number, DOMRect>();
		const rectAt = (index: number) => {
			let rect = rects.get(index);
			if (!rect) {
				rect = exchanges[index].getBoundingClientRect();
				rects.set(index, rect);
			}
			return rect;
		};
		// Stacked in order: the first message has the highest top, the last the lowest.
		const above = skipped > 0 || (exchanges.length > 0 && rectAt(0).top < landing - 2);
		const below = exchanges.length > 0 && rectAt(exchanges.length - 1).top > landing + 2;
		const [firstDrawn, lastDrawn] = turnNavVisibleRange(exchanges.length, rectAt, viewport.top + 1, viewport.bottom - 1);
		const first = firstDrawn < 0 ? -1 : firstDrawn + skipped;
		const last = lastDrawn < 0 ? -1 : lastDrawn + skipped;
		const start = turnNavWindowStart(this.turns.length, this.ticks.length, this.windowStart, first, last);
		if (start !== this.windowStart) {
			this.windowStart = start;
			this.hideCard();
			this.drawTicks(this.ticks.length);
		}
		this.ticks.forEach((tick, slot) => {
			const index = this.windowStart + slot;
			tick.classList.toggle('in-view', first >= 0 && index >= first && index <= last);
		});
		const pos = this.thread.scroll.getScrollPosition();
		const dims = this.thread.scroll.getScrollDimensions();
		this.up.disabled = !above;
		this.down.disabled = !below || pos.scrollTop >= dims.scrollHeight - dims.height - 1;
		const idle = !turnNavHasOffscreen(exchanges.length, firstDrawn, lastDrawn, skipped);
		this.element.classList.toggle('idle', idle);
		if (idle) {
			this.hideCard();
		}
	}

	/**
	 * Glides to the message above or below the one at the top of the view (the arrows, and the
	 * previous/next message keys). Steps from where a running glide is headed, so a held key
	 * walks message by message. Returns false when there is no message that way.
	 */
	stepTo(direction: -1 | 1): boolean {
		const viewportTop = this.thread.scroll.getDomNode().getBoundingClientRect().top;
		// Where the view will be once the running glide ends, in the same frame as the tops below.
		const ahead = this.glide.target - this.thread.scroll.getScrollPosition().scrollTop;
		const landing = viewportTop + LANDING_OFFSET + ahead;
		const tops = this.exchanges().map(exchange => exchange.getBoundingClientRect().top);
		const target = stepTurnIndex(tops, landing, direction);
		const skipped = this.undrawn?.count() ?? 0;
		if (target < 0) {
			if (direction < 0 && skipped > 0) {
				// The message above is not drawn yet: it is the last undrawn one.
				this.reveal(skipped - 1);
				return true;
			}
			return false;
		}
		this.reveal(target + skipped);
		return true;
	}

	/** Glides the message to the top of the view. */
	private reveal(index: number): void {
		if (index < (this.undrawn?.count() ?? 0)) {
			this.undrawn?.draw();
		}
		const exchange = this.exchanges()[index - (this.undrawn?.count() ?? 0)];
		if (!exchange) {
			return;
		}
		const viewport = this.thread.scroll.getDomNode().getBoundingClientRect();
		const from = this.thread.scroll.getScrollPosition().scrollTop;
		this.glide.glideTo(from + exchange.getBoundingClientRect().top - viewport.top - LANDING_OFFSET);
	}

	private showCard(index: number): void {
		const turn = this.turns[index];
		if (!turn) {
			return;
		}
		this.clearReplyTimer();
		this.hovered = index;
		this.ticks.forEach((tick, slot) => tick.classList.toggle('hovered', this.windowStart + slot === index));
		this.cardPrompt.textContent = turn.prompt || localize('voltAgent.turnNav.untitled', "Message");
		this.cardReply.textContent = '';
		this.card.classList.remove('with-reply');
		this.card.classList.add('visible');
		const withReply = () => {
			const reply = this.hovered === index ? turn.reply() : undefined;
			if (reply) {
				this.cardReply.textContent = reply;
				this.card.classList.add('with-reply');
				this.warm = true;
			}
			this.placeCard(index);
		};
		if (this.warm) {
			withReply();
			return;
		}
		this.placeCard(index);
		this.replyTimer = setTimeout(() => {
			this.replyTimer = undefined;
			withReply();
		}, REPLY_DELAY_MS);
	}

	/** Beside the tick, centered on it, and kept inside the thread. */
	private placeCard(index: number): void {
		const tick = this.ticks[index - this.windowStart];
		if (!tick) {
			return;
		}
		const nav = this.element.getBoundingClientRect();
		const bounds = this.thread.element.getBoundingClientRect();
		const center = tick.getBoundingClientRect().top + tick.offsetHeight / 2;
		const height = this.card.offsetHeight;
		const top = Math.max(bounds.top + 8, Math.min(center - height / 2, bounds.bottom - 8 - height));
		this.card.style.top = `${Math.round(top - nav.top)}px`;
	}

	private hideCard(): void {
		this.clearReplyTimer();
		this.hovered = undefined;
		this.card.classList.remove('visible', 'with-reply');
		for (const tick of this.ticks) {
			tick.classList.remove('hovered');
		}
	}

	private clearReplyTimer(): void {
		if (this.replyTimer !== undefined) {
			clearTimeout(this.replyTimer);
			this.replyTimer = undefined;
		}
	}
}
