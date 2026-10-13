/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';

/** Where a chat should land when it opens: a turn, and the words to find in it. */
export interface IAgentTurnReveal {
	readonly turnId: string;
	/** Seeds the chat's find widget, so the match is highlighted. Empty: only scroll to the turn. */
	readonly find: string;
}

/** A request older than this is for a chat that never opened. */
const REVEAL_TTL_MS = 10_000;

const pending = new Map<string, IAgentTurnReveal & { readonly at: number }>();
const onDidRequest = new Emitter<string>();

/** Fires with the chat id; a chat already on screen takes the request at once, others when they open. */
export const onDidRequestAgentTurnReveal = onDidRequest.event;

/** Asks the chat to scroll to a turn the next time it is shown (search results call this before opening it). */
export function requestAgentTurnReveal(sessionId: string, reveal: IAgentTurnReveal): void {
	pending.set(sessionId, { ...reveal, at: Date.now() });
	onDidRequest.fire(sessionId);
}

export function takeAgentTurnReveal(sessionId: string): IAgentTurnReveal | undefined {
	const reveal = pending.get(sessionId);
	pending.delete(sessionId);
	return reveal && Date.now() - reveal.at < REVEAL_TTL_MS ? reveal : undefined;
}
