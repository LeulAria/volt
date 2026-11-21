/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';

/**
 * Chats whose prompt was just sent and is on its way to the orchestrator. The chat's record only
 * says "running" once the turn starts (a round trip to the agent server, longer while the agent
 * starts), and until then the sent draft has already been cleared. The Agents list reads this to
 * move the chat to Working on the keypress instead of losing the row in between.
 */
const sending = new Map<string, string>();
const sendingEmitter = new Emitter<void>();

export const onDidChangeSendingAgentChats: Event<void> = sendingEmitter.event;

/** Chat id → the prompt it is sending. */
export function sendingAgentChats(): ReadonlyMap<string, string> {
	return sending;
}

export function markAgentChatSending(sessionId: string, prompt: string): void {
	sending.set(sessionId, prompt);
	sendingEmitter.fire();
}

/** The orchestrator answered (started, queued or refused): the chat's record and state take over. */
export function clearAgentChatSending(sessionId: string): void {
	if (sending.delete(sessionId)) {
		sendingEmitter.fire();
	}
}
