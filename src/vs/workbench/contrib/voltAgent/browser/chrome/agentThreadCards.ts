/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../../base/common/lifecycle.js';
import { IVoltAgentWindowService, IVoltThreadCard } from '../../../../services/voltPlugins/browser/voltAgentWindow.js';
import type { IAgentMessage } from '../editor/agentEditor.js';

interface IPlacedCard {
	readonly card: IVoltThreadCard;
	readonly element: HTMLElement;
	readonly drawn: IDisposable;
}

/**
 * Feature cards in a chat's thread (`IVoltAgentWindowService.registerThreadCards`), each right after
 * the message it names. The chat calls `afterTurn` as it draws each message, so a redraw of any
 * part of the thread puts the cards back in place; `placeAll` moves every card after a full draw
 * or when the cards change. A card's element lives as long as its id does.
 */
export class AgentThreadCards extends Disposable {

	private readonly placed = this._register(new DisposableMap<string, IPlacedCard & IDisposable>());
	private sessionKey: string | undefined;

	constructor(
		private readonly thread: () => HTMLElement,
		private readonly messages: () => readonly IAgentMessage[],
		private readonly onChange: () => void,
		@IVoltAgentWindowService private readonly agentWindow: IVoltAgentWindowService,
	) {
		super();
		this._register(agentWindow.onDidChangeThreadCards(sessionKey => {
			if (this.sessionKey && (!sessionKey || sessionKey === this.sessionKey)) {
				this.refresh();
			}
		}));
	}

	setSession(sessionKey: string | undefined): void {
		if (sessionKey === this.sessionKey) {
			return;
		}
		this.sessionKey = sessionKey;
		this.placed.clearAndDisposeAll();
		this.refresh();
	}

	/** Puts the cards that follow `message` right after its turn. */
	afterTurn(turn: HTMLElement, message: IAgentMessage, index: number): void {
		if (!this.placed.size) {
			return;
		}
		let after: HTMLElement = turn;
		for (const entry of this.placed.values()) {
			if (this.anchorIndex(entry.card) === index && message === this.messages()[index]) {
				after.after(entry.element);
				after = entry.element;
			}
		}
	}

	/** Every card to its place: after its message when that is drawn, else the thread's end. */
	placeAll(): void {
		const thread = this.thread();
		const messages = this.messages();
		for (const entry of this.placed.values()) {
			const index = this.anchorIndex(entry.card);
			const message = index >= 0 ? messages[index] : undefined;
			const id = message?.id;
			// A prompt and its reply share the turn's id: the message's kind tells them apart.
			const turn = id ? thread.querySelector<HTMLElement>(`.volt-agent-turn.${message.kind}[data-message-id="${CSS.escape(id)}"]`) : null;
			if (turn) {
				if (turn.nextElementSibling !== entry.element) {
					turn.after(entry.element);
				}
			} else if (index < 0 || index >= messages.length - 1 || !id) {
				// Not anchored (or its message is not in this chat yet), or anchored to the last message that has no turn yet: the end.
				thread.append(entry.element);
			} else {
				// The message is in the undrawn head: the card comes back when it is drawn.
				entry.element.remove();
			}
		}
	}

	private refresh(): void {
		const cards = this.sessionKey ? this.agentWindow.threadCards(this.sessionKey) : [];
		const ids = new Set(cards.map(card => card.id));
		for (const id of [...this.placed.keys()]) {
			if (!ids.has(id)) {
				this.placed.deleteAndDispose(id);
			}
		}
		for (const card of cards) {
			if (this.placed.has(card.id)) {
				continue;
			}
			const element = $('.volt-agent-thread-card');
			element.dataset.cardId = card.id;
			const drawn = card.render(element);
			this.placed.set(card.id, { card, element, drawn, dispose: () => { drawn.dispose(); element.remove(); } });
		}
		this.placeAll();
		this.onChange();
	}

	/** The last message with the card's id (a prompt and its reply share one: the card follows the reply). */
	private anchorIndex(card: IVoltThreadCard): number {
		if (!card.afterMessageId) {
			return -1;
		}
		const messages = this.messages();
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].id === card.afterMessageId) {
				return i;
			}
		}
		return -1;
	}
}
