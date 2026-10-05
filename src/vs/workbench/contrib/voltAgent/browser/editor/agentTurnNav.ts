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

export interface IAgentTurnNavTurn {
	/** The sent message: the card's first line. */
	readonly prompt: string;
	/** The start of its reply, read when the card opens. */
	readonly reply: () => string | undefined;
}

/** Resting on a tick this long opens its card down to the start of the reply. */
const REPLY_DELAY_MS = 450;
/** Space between ticks; many messages squeeze them into half the thread's height. */
const STEP_MAX = 9;
const STEP_MIN = 3;
const RAIL_WIDTH = 16;
/** A revealed message lands this far below the top edge, as the first one sits at rest. */
const LANDING_OFFSET = 8;
const SCROLL_MS = 220;

/** Plain text of a reply's markdown, cut down for the card. */
export function turnNavPreview(markdown: string, max = 280): string {
	const plain = renderAsPlaintext({ value: markdown.slice(0, max * 4) }).replace(/\s+/g, ' ').trim();
	return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain;
}

/**
 * A tick per sent message down the transcript's left edge, as in T3 Code. Ticks for the
 * messages on screen are lit; hovering one shows the message (and, resting there, the start
 * of its reply); clicking scrolls to it; the arrows step to the previous or next message.
 */
export class AgentTurnNav extends Disposable {

	readonly element: HTMLElement;

	private readonly up: HTMLButtonElement;
	private readonly down: HTMLButtonElement;
	private readonly ticksEl: HTMLElement;
	private readonly card: HTMLElement;
	private readonly cardPrompt: HTMLElement;
	private readonly cardReply: HTMLElement;
	private readonly scrollAnimation = this._register(new MutableDisposable());
	private readonly syncFrame = this._register(new MutableDisposable());
	private turns: readonly IAgentTurnNavTurn[] = [];
	private ticks: HTMLButtonElement[] = [];
	private hovered: number | undefined;
	/** Once a card has shown a reply, the next ones do at once until the pointer leaves the rail. */
	private warm = false;
	private replyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly thread: AgentThreadView) {
		super();
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
		this._register(addDisposableListener(thread.element, 'wheel', () => this.scrollAnimation.clear(), { passive: true }));
		const observer = new (getWindow(thread.element).ResizeObserver)(() => this.layout());
		observer.observe(thread.element);
		this._register(toDisposable(() => observer.disconnect()));
		this._register(toDisposable(() => this.clearReplyTimer()));
	}

	/** One tick per sent message, in order; call after the transcript is rendered. */
	setTurns(turns: readonly IAgentTurnNavTurn[]): void {
		this.turns = turns;
		if (this.ticks.length !== turns.length) {
			this.hideCard();
			this.ticks = turns.map((_, index) => this.tick(index));
			this.ticksEl.replaceChildren(...this.ticks);
		}
		turns.forEach((turn, index) => this.ticks[index].setAttribute('aria-label', localize('voltAgent.turnNav.goTo', "Go to message: {0}", turn.prompt)));
		this.layout();
	}

	layout(): void {
		const threadRect = this.thread.element.getBoundingClientRect();
		// The rail lives in the room left of the transcript column: the sent card's edge, as the
		// turn itself can bleed to the thread's edge while pinned.
		const column = (this.thread.inner.querySelector('.volt-agent-turn.user .volt-agent-bubble') ?? this.thread.inner.querySelector('.volt-agent-turn'))?.getBoundingClientRect();
		const gutter = column ? column.left - threadRect.left : 0;
		const show = this.turns.length > 1 && gutter >= RAIL_WIDTH + 2 && threadRect.height > 0;
		this.element.classList.toggle('hidden', !show);
		if (!show) {
			this.hideCard();
			return;
		}
		const step = Math.max(STEP_MIN, Math.min(STEP_MAX, Math.floor(threadRect.height * 0.5 / this.turns.length)));
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

	private tick(index: number): HTMLButtonElement {
		const tick = $('button.tick') as HTMLButtonElement;
		tick.type = 'button';
		append(tick, $('span.line'));
		tick.addEventListener('mouseenter', () => this.showCard(index));
		tick.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.reveal(index);
		});
		return tick;
	}

	/** Exchanges, one per sent message: the turn and everything answering it. */
	private exchanges(): HTMLElement[] {
		return Array.from(this.thread.inner.querySelectorAll<HTMLElement>('.volt-agent-turn.user'), turn => turn.parentElement ?? turn);
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
		let above = false;
		let below = false;
		this.exchanges().forEach((exchange, index) => {
			const rect = exchange.getBoundingClientRect();
			this.ticks[index]?.classList.toggle('in-view', rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1);
			above ||= rect.top < landing - 2;
			below ||= rect.top > landing + 2;
		});
		const pos = this.thread.scroll.getScrollPosition();
		const dims = this.thread.scroll.getScrollDimensions();
		this.up.disabled = !above;
		this.down.disabled = !below || pos.scrollTop >= dims.scrollHeight - dims.height - 1;
	}

	/** The message above or below the one at the top of the view. */
	private stepTo(direction: -1 | 1): void {
		const landing = this.thread.scroll.getDomNode().getBoundingClientRect().top + LANDING_OFFSET;
		const tops = this.exchanges().map(exchange => exchange.getBoundingClientRect().top);
		const target = direction < 0
			? tops.findLastIndex(top => top < landing - 2)
			: tops.findIndex(top => top > landing + 2);
		if (target >= 0) {
			this.reveal(target);
		}
	}

	/** Glides the message to the top of the view. */
	private reveal(index: number): void {
		const exchange = this.exchanges()[index];
		if (!exchange) {
			return;
		}
		const viewport = this.thread.scroll.getDomNode().getBoundingClientRect();
		const from = this.thread.scroll.getScrollPosition().scrollTop;
		const dims = this.thread.scroll.getScrollDimensions();
		const to = Math.max(0, Math.min(dims.scrollHeight - dims.height, from + exchange.getBoundingClientRect().top - viewport.top - LANDING_OFFSET));
		if (Math.abs(to - from) < 1) {
			return;
		}
		const targetWindow = getWindow(this.element);
		const start = Date.now();
		const frame = () => {
			const t = Math.min(1, (Date.now() - start) / SCROLL_MS);
			const eased = 1 - Math.pow(1 - t, 3);
			this.thread.scroll.setScrollPosition({ scrollTop: from + (to - from) * eased });
			this.scrollAnimation.value = t < 1 ? scheduleAtNextAnimationFrame(targetWindow, frame) : undefined;
		};
		this.scrollAnimation.value = scheduleAtNextAnimationFrame(targetWindow, frame);
	}

	private showCard(index: number): void {
		const turn = this.turns[index];
		if (!turn) {
			return;
		}
		this.clearReplyTimer();
		this.hovered = index;
		this.ticks.forEach((tick, i) => tick.classList.toggle('hovered', i === index));
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
		const tick = this.ticks[index];
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
