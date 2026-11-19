/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The words of a voice call on this computer, which has no voice model to phrase them: what it
 * says when it opens, after a tool ran, and which utterances end the call.
 */

export const LOCAL_GREETING = 'Hi. What should I work on?';

const GOODBYE = /^(?:(?:ok(?:ay)?|alright|thanks|thank you)[,.!]?\s+)?(?:bye|good ?bye|bye bye|see you|hang up|end (?:the )?call|stop (?:the )?call)(?:\s+now)?[.!]?$/i;

/** The caller only said goodbye (or asked to hang up), so the call ends instead of sending a task. */
export function isLocalGoodbye(text: string): boolean {
	return GOODBYE.test(text.trim());
}

/** What the line says after one of the brain's tools answered; undefined says nothing. */
export function localToolWords(name: string, output: unknown): string | undefined {
	if (name === 'end_the_call') {
		return 'Bye.';
	}
	if (name !== 'send_task') {
		return undefined;
	}
	const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
	if (typeof result.error === 'string') {
		const reason = result.error.length > 160 ? `${result.error.slice(0, 159)}…` : result.error;
		return `That did not go through. ${reason}`;
	}
	switch (result.relay) {
		case 'unreachable': return 'There is no chat open to send it to. Open a chat and try again.';
		case 'refused': return 'The agent needs you in the chat first.';
	}
	switch (result.receipt) {
		case 'already under way': return 'That is already under way.';
		case 'queued behind the current work': return 'Queued. It starts after the current work.';
		case 'under way': return result.steered ? 'Got it. I passed that to the agent.' : 'On it.';
	}
	return undefined;
}
