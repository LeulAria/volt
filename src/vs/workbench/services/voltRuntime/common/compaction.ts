/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compaction for every provider. Agents that offer their own `/compact` (Claude Code) run it;
 * native models summarize with Volt's own compactor; any other agent is asked for a hand-off
 * summary, which then replaces the conversation the next agent session is briefed with. Old
 * chats are compacted before they are resumed, when resending their whole history would cost
 * the most (the provider's prompt cache has expired).
 */

/** `/compact`, optionally with focus instructions (`/compact keep the API decisions`). */
export function isCompactCommand(text: string): boolean {
	return /^\/compact(?:\s|$)/.test(text.trim());
}

export function compactInstructions(text: string): string | undefined {
	const rest = text.trim().replace(/^\/compact/, '').trim();
	return rest || undefined;
}

/** What Volt asks an agent with no compaction of its own; its reply becomes the new context. */
export function agentCompactionPrompt(instructions: string | undefined): string {
	return [
		'[Volt] Compact this conversation. Your reply replaces the whole conversation history: the next message starts a fresh session that sees only your reply, so write it for someone continuing this work who knows nothing else.',
		'Do not use tools and do not change anything. Reply with a summary, in this order:',
		'1. The goal and the user\'s requests and preferences, in their own words where it matters.',
		'2. What is done: decisions, files changed (paths) and why, commands that matter and their results.',
		'3. What is in progress and what is left, as concrete next steps.',
		'4. Facts that would be costly to rediscover: errors and their causes, constraints, names, versions.',
		...(instructions ? [`The user asked this summary to focus on: ${instructions}`] : []),
		'Start your reply with "Summary of the conversation so far:".',
	].join('\n');
}

/** The model context after an agent compaction: the summary stands in for everything before it. */
export function compactedHistory(summary: string): { readonly role: 'user' | 'assistant'; readonly content: string }[] {
	return [
		{ role: 'user', content: '[Volt] The earlier conversation was compacted. The summary that follows replaces it.' },
		{ role: 'assistant', content: summary.trim() },
	];
}

export const COMPACT_OLD_THREADS_SETTING = 'volt.agent.compactOldThreads';
/** Context meter fill (percent) from which the composer offers "Compact first". */
export const COMPACT_CHIP_THRESHOLD_SETTING = 'volt.agent.compactChipThreshold';

/** How long a chat must sit idle for its provider's prompt cache to be gone (an hour, plus margin). */
export const OLD_THREAD_IDLE_MS = 70 * 60_000;
/** Only chats this large are worth a compaction turn before the next prompt. */
export const OLD_THREAD_TOKENS = 100_000;

export interface IOldThreadInput {
	readonly enabled: boolean;
	/** When the chat's last reply ended. */
	readonly lastActivityAt: number | undefined;
	/** Tokens the context held after its last turn. */
	readonly usedTokens: number | undefined;
	readonly now: number;
	readonly canCompact: boolean;
	/** The prompt about to go out. */
	readonly text: string;
}

/**
 * Whether to compact a chat before sending into it: it has been idle long enough that its cache
 * expired and is big enough that resending it in full is expensive (T3's "Resume with less
 * context"). Never for `/compact` itself.
 */
export function shouldCompactBeforeSend(input: IOldThreadInput): boolean {
	return input.enabled
		&& input.canCompact
		&& !isCompactCommand(input.text)
		&& input.lastActivityAt !== undefined
		&& input.now - input.lastActivityAt >= OLD_THREAD_IDLE_MS
		&& (input.usedTokens ?? 0) >= OLD_THREAD_TOKENS;
}
