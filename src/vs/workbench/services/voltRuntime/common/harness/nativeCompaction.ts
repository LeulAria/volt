/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageTokens } from './contextEngine.js';
import { INativeLoopMessage } from './nativeLoop.js';

/**
 * Compaction for the native transcript, done once at a boundary rather than a little every turn:
 * every rewrite restarts the prompt cache and, on current Claude models, invalidates replayed
 * reasoning, so it has to be rare. Older turns become one handoff summary; recent turns stay
 * verbatim; reasoning blocks are dropped from what remains because their prefix changed.
 */

export interface ICompactionPolicy {
	/** Model window in tokens. */
	readonly window: number;
	/** Compact when the prompt reaches this fraction of the effective window. */
	readonly threshold: number;
	/** Upper bound on the window Volt lets a conversation use, for cost and focus. */
	readonly practicalLimit: number;
}

export const DEFAULT_COMPACTION: Omit<ICompactionPolicy, 'window'> = { threshold: 0.8, practicalLimit: 400_000 };

export function effectiveWindow(policy: ICompactionPolicy): number {
	return Math.max(16_000, Math.min(policy.window, policy.practicalLimit));
}

export function shouldCompact(promptTokens: number, policy: ICompactionPolicy): boolean {
	return promptTokens >= effectiveWindow(policy) * policy.threshold;
}

/**
 * Index of the first message to keep. The kept tail starts at a user message (never at a tool
 * result, so call/result pairs stay whole), holds at most `keepTokens`, and always includes the
 * latest user message.
 */
export function compactionBoundary(messages: readonly INativeLoopMessage[], keepTokens: number): number {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			lastUser = i;
			break;
		}
	}
	if (lastUser <= 0) {
		return 0;
	}
	let boundary = lastUser;
	let kept = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		kept += messageTokens(messages[i]);
		if (kept > keepTokens && i < lastUser) {
			break;
		}
		if (messages[i].role === 'user' && !isSteering(messages, i)) {
			boundary = i;
		}
	}
	return boundary;
}

/** A user message that answers a tool turn (injected context) is not a turn boundary. */
function isSteering(messages: readonly INativeLoopMessage[], index: number): boolean {
	return index > 0 && messages[index - 1].role === 'tool';
}

export interface ICarryForward {
	/** Files read and changed, from the file ledger. */
	readonly files?: string;
	/** The current task list. */
	readonly todo?: string;
}

/**
 * The transcript to summarize, as plain text. Long tool results are cut: the summary needs
 * what happened, not every line of every file.
 */
export function serializeForSummary(messages: readonly INativeLoopMessage[], budgetChars = 400_000): string {
	const parts: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case 'user':
				parts.push(`USER: ${clip(message.content, 6_000)}`);
				break;
			case 'assistant': {
				const calls = message.toolCalls?.map(call => `${call.name}(${clip(safeJson(call.args), 400)})`).join('; ');
				parts.push(`ASSISTANT: ${clip(message.content, 4_000)}${calls ? `\n[called: ${calls}]` : ''}`);
				break;
			}
			case 'tool':
				parts.push(`RESULT ${message.name ?? ''}${message.isError ? ' (error)' : ''}: ${clip(message.content, 1_500)}`);
				break;
		}
	}
	const text = parts.join('\n\n');
	return text.length > budgetChars ? `[earlier history omitted]\n${text.slice(-budgetChars)}` : text;
}

export const COMPACTION_SYSTEM = [
	'You write handoff summaries of coding sessions so the work can continue in a fresh context.',
	'Be factual and specific; keep file paths, function names, commands, error messages, and decisions exact.',
].join(' ');

export function compactionRequest(transcript: string, carry: ICarryForward): string {
	return [
		'Summarize the conversation below for the agent that will continue it. Use these sections:',
		'1. Task: what the user asked for, including constraints and preferences they stated.',
		'2. Done so far: what was changed and where (paths), and what was verified.',
		'3. Current state: open problems, failing checks, exact error messages that still matter.',
		'4. Decisions: approaches chosen or rejected, and why.',
		'5. Next steps: what remains, in order.',
		'Keep it under 1200 words. Do not invent anything that is not in the transcript.',
		carry.files ? `\nFiles touched (from the harness):\n${carry.files}` : '',
		carry.todo ? `\nTask list (from the harness):\n${carry.todo}` : '',
		'\n<transcript>',
		transcript,
		'</transcript>',
	].filter(Boolean).join('\n');
}

/** A summary built without a model call, used when the summarizer fails. */
export function mechanicalSummary(older: readonly INativeLoopMessage[], carry: ICarryForward): string {
	const asks = older.filter(message => message.role === 'user' && message.content.trim()).map(message => `- ${clip(message.content.trim(), 300)}`).slice(-12);
	const lastAnswer = [...older].reverse().find(message => message.role === 'assistant' && message.content.trim())?.content;
	return [
		asks.length ? `User requests so far:\n${asks.join('\n')}` : '',
		carry.files ?? '',
		carry.todo ? `Task list:\n${carry.todo}` : '',
		lastAnswer ? `Last assistant message:\n${clip(lastAnswer, 2_000)}` : '',
	].filter(Boolean).join('\n\n');
}

/**
 * The compacted transcript: one summary message, then the kept tail with reasoning removed.
 * The summary is a user message so every provider accepts the order.
 */
export function applyCompaction(messages: readonly INativeLoopMessage[], boundary: number, summary: string): INativeLoopMessage[] {
	const kept = messages.slice(boundary).map(stripReasoning);
	// The prefix restarts here anyway, so this is the free moment to drop old pixels too.
	pruneImages(kept, { ...DEFAULT_IMAGE_POLICY, pruneAt: DEFAULT_IMAGE_POLICY.keep });
	const note = [
		'<conversation_summary>',
		'Earlier parts of this conversation were compacted. This summary replaces them; files and tool results from before it are no longer in view, so read files again if you need their current contents.',
		'',
		summary.trim(),
		'</conversation_summary>',
	].join('\n');
	const first = kept[0];
	if (first?.role === 'user') {
		return [{ ...first, content: `${note}\n\n${first.content}` }, ...kept.slice(1)];
	}
	return [{ role: 'user', content: note }, ...kept];
}

export function stripReasoning(message: INativeLoopMessage): INativeLoopMessage {
	if (!message.parts?.some(part => part.type === 'reasoning')) {
		return message;
	}
	const parts = message.parts.filter(part => part.type !== 'reasoning');
	const { parts: _dropped, ...rest } = message;
	return parts.length ? { ...rest, parts } : rest;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)} [...]` : text;
}

function safeJson(value: unknown): string {
	try {
		return typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// --- images ------------------------------------------------------------------------------------

export interface IImagePolicy {
	/** Newest images that always stay. */
	readonly keep: number;
	/** Prune only once more than this many images are in view, so the prompt prefix changes rarely. */
	readonly pruneAt: number;
	/** Base64 characters across all images; past this, the oldest go even below `pruneAt`. */
	readonly maxChars: number;
}

/**
 * Screenshots are the heaviest thing a browser loop puts in context (a 2x PNG is a few hundred
 * thousand base64 characters) and only the latest few are worth looking at. Pruning rewrites old
 * messages, which restarts the prompt cache from that point, so it runs in batches: nothing
 * happens until there are `pruneAt` images (or `maxChars`), then it drops back to `keep`.
 */
export const DEFAULT_IMAGE_POLICY: IImagePolicy = { keep: 4, pruneAt: 10, maxChars: 6_000_000 };

export const PRUNED_IMAGE_NOTE = '[An older image was here; it was removed to save context. Take a new screenshot if you need to see the current state.]';

/** Drops pixels from older messages in place. Returns how many images were removed. */
export function pruneImages(messages: INativeLoopMessage[], policy: IImagePolicy = DEFAULT_IMAGE_POLICY): number {
	let count = 0;
	let chars = 0;
	for (const message of messages) {
		for (const image of message.images ?? []) {
			count++;
			chars += image.data.length;
		}
	}
	if (count <= policy.pruneAt && chars <= policy.maxChars) {
		return 0;
	}
	// Walk newest first: keep up to `keep` images within the character budget.
	let kept = 0;
	let keptChars = 0;
	let removed = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message.images?.length) {
			continue;
		}
		const survivors = message.images.filter(image => {
			const fits = kept < policy.keep && keptChars + image.data.length <= policy.maxChars;
			if (fits) {
				kept++;
				keptChars += image.data.length;
			}
			return fits;
		});
		const dropped = message.images.length - survivors.length;
		if (!dropped) {
			continue;
		}
		removed += dropped;
		const { images: _images, ...rest } = message;
		messages[i] = {
			...rest,
			...(survivors.length ? { images: survivors } : {}),
			content: message.content ? `${message.content}\n${PRUNED_IMAGE_NOTE}` : PRUNED_IMAGE_NOTE,
		};
	}
	return removed;
}
