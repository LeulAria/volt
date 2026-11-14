/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * When a chat's agent is warmed ahead of its first message. A chat whose agent was stopped (idle, or never
 * started since launch) pays a cold start of about a second (the adapter, Claude Code, `session/resume`) before
 * its first word, unless the start begins before the send. These rules start it on the first sign of intent
 * without keeping any agent up at rest: an agent warmed on a sign that is not a press or a key is short-lived
 * (it stops on its own unless the user goes on to focus or type in the composer).
 */

/** A chat that stays open this long gets its agent started (opening chats faster than this starts none). */
export const PREWARM_ON_OPEN_MS = 300;

/**
 * A chat the user clicked open warms at once: the click is the pick. Clicks closer together than this are
 * someone stepping through chats; those wait out {@link PREWARM_ON_OPEN_MS} as any open does.
 */
export const PREWARM_CLICK_GAP_MS = 1_000;

/** A sign of intent that is not a press or a key (the pointer reaching the composer, the window coming to the front) asks at most this often. */
export const PREWARM_INTENT_GAP_MS = 5_000;

/**
 * How long after a chat opens its agent starts. `clickedAt`: when the click that opened it landed (undefined for
 * an open that was not a click: a restored window, a command); `lastClickedAt`: the click before it, if any.
 */
export function openPrewarmDelay(clickedAt: number | undefined, lastClickedAt: number | undefined): number {
	if (clickedAt === undefined) {
		return PREWARM_ON_OPEN_MS;
	}
	return lastClickedAt !== undefined && clickedAt - lastClickedAt < PREWARM_CLICK_GAP_MS ? PREWARM_ON_OPEN_MS : 0;
}

/** Whether a sign of intent at `now` asks for a warm agent, given when the last ask of any kind was made (0: none, or a short-lived one). */
export function intentWantsPrewarm(now: number, lastIntentAt: number, lastPrewarmAt: number): boolean {
	return now - lastIntentAt >= PREWARM_INTENT_GAP_MS && now - lastPrewarmAt >= PREWARM_INTENT_GAP_MS;
}
