/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stringHash } from '../../../../../base/common/hash.js';
import type { IModelAssistantPart } from '../providers.js';
import type { IToolSchema } from '../tools/tool.js';
import { messageTokens } from './contextEngine.js';
import { INativeLoopMessage } from './nativeLoop.js';

/**
 * Compaction for the native transcript, done once at a boundary rather than a little every turn:
 * every rewrite restarts the prompt cache and, on current Claude models, invalidates replayed
 * reasoning, so it has to be rare. Older turns become one handoff summary; recent turns stay
 * verbatim; Claude's reasoning blocks are dropped from what remains because their prefix changed.
 */

// --- reasoning bound to the prefix -----------------------------------------------------------

/**
 * Claude signs each thinking block over everything before it: the system prompt, the tools, and
 * every earlier message. Once an earlier turn is edited, every later block fails that check and
 * current models reject the request (400) on enforced accounts. Other providers' reasoning is not
 * bound that way, and DeepSeek, Kimi, and Gemini want theirs back on the tool calls it preceded,
 * so it stays.
 */
export function isPrefixBoundReasoning(part: IModelAssistantPart): boolean {
	return part.type === 'reasoning' && (part.block.provider === 'anthropic' || /claude|anthropic/i.test(part.block.model));
}

export function stripBoundReasoning(message: INativeLoopMessage): INativeLoopMessage {
	if (!message.parts?.some(isPrefixBoundReasoning)) {
		return message;
	}
	const parts = message.parts.filter(part => !isPrefixBoundReasoning(part));
	const { parts: _dropped, ...rest } = message;
	return parts.length ? { ...rest, parts } : rest;
}

/** Identifies the system prompt and tool set a transcript's reasoning was produced under. */
export function promptPrefixKey(system: string, tools: readonly IToolSchema[]): string {
	const text = `${system}\0${JSON.stringify(tools)}`;
	return `${(stringHash(text, 0) >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/**
 * After an edit at `from`, the prefix-bound reasoning in every later message is invalid: it is
 * dropped in place (removing all later blocks is allowed; keeping any is not). Returns how many
 * messages lost reasoning.
 */
export function dropBoundReasoning(messages: INativeLoopMessage[], from = 0): number {
	let dropped = 0;
	for (let i = Math.max(0, from); i < messages.length; i++) {
		const next = stripBoundReasoning(messages[i]);
		if (next !== messages[i]) {
			messages[i] = next;
			dropped++;
		}
	}
	return dropped;
}

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
 * Index of the first message to keep (0: nothing to compact). The kept tail never starts at a tool
 * result, so call/result pairs stay whole, and holds at most `keepTokens` beyond its first cut
 * point. It starts at a user turn when one is in reach; otherwise at the start of a step (an
 * assistant message), because one long task is a single turn of hundreds of steps and would never
 * compact at all.
 */
export function compactionBoundary(messages: readonly INativeLoopMessage[], keepTokens: number): number {
	let turn = 0;
	let step = 0;
	let kept = 0;
	for (let i = messages.length - 1; i > 0; i--) {
		kept += messageTokens(messages[i]);
		const isTurn = messages[i].role === 'user' && !isSteering(messages, i);
		if (!isTurn && messages[i].role !== 'assistant') {
			continue;
		}
		if (kept > keepTokens && (turn || step)) {
			break;
		}
		if (isTurn) {
			turn = i;
		} else {
			step = i;
		}
	}
	if (turn) {
		return turn;
	}
	// Cutting inside the only exchange is worth it only when there is work before the cut.
	return messages.slice(0, step).some(message => message.role === 'assistant') ? step : 0;
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

const SUMMARY_SECTIONS = [
	'1. Task: what the user asked for, including constraints and preferences they stated.',
	'2. Done so far: what was changed and where (paths), and what was verified.',
	'3. Current state: open problems, failing checks, exact error messages that still matter.',
	'4. Decisions: approaches chosen or rejected, and why.',
	'5. Next steps: what remains, in order.',
];

function carried(carry: ICarryForward): string[] {
	return [
		carry.files ? `\nFiles touched (from the harness):\n${carry.files}` : '',
		carry.todo ? `\nTask list (from the harness):\n${carry.todo}` : '',
	];
}

export function compactionRequest(transcript: string, carry: ICarryForward): string {
	return [
		'Summarize the conversation below for the agent that will continue it. Use these sections:',
		...SUMMARY_SECTIONS,
		'Keep it under 1200 words. Do not invent anything that is not in the transcript.',
		...carried(carry),
		'\n<transcript>',
		transcript,
		'</transcript>',
	].filter(Boolean).join('\n');
}

/**
 * The same summary asked for as the next user message of the run's own request: system prompt,
 * tools, options, and history are unchanged, so the whole conversation is read from the prompt
 * cache instead of being sent again as a fresh, uncached transcript (and nothing is clipped).
 */
export function inContextCompactionRequest(carry: ICarryForward): string {
	return [
		'<compaction_request>',
		'The context window is nearly full. Earlier turns of this conversation will be replaced by a summary you write now, for the agent that will continue the work.',
		'Do not call any tools and do not continue the task. Reply with only the summary, in these sections:',
		...SUMMARY_SECTIONS,
		'Keep file paths, function names, commands, error messages, and decisions exact. Keep it under 1200 words. Do not invent anything.',
		...carried(carry),
		'</compaction_request>',
	].filter(Boolean).join('\n');
}

/** An in-context summary shorter than this (a refusal, a tool call instead of text) is not used. */
export const MIN_IN_CONTEXT_SUMMARY_CHARS = 400;

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
	const kept = messages.slice(boundary).map(stripBoundReasoning);
	// The prefix restarts here anyway, so this is the free moment to drop old pixels too.
	pruneImages(kept, { ...DEFAULT_IMAGE_POLICY, pruneAt: DEFAULT_IMAGE_POLICY.keep });
	// Cut inside a long turn: the request it is working on stays word for word.
	const request = kept.some(message => message.role === 'user' && message.turn) ? undefined : latestRequest(messages.slice(0, boundary));
	const note = [
		'<conversation_summary>',
		'Earlier parts of this conversation were compacted. This summary replaces them; files and tool results from before it are no longer in view, so read files again if you need their current contents.',
		'',
		summary.trim(),
		...(request ? ['', 'The user\'s latest request, verbatim:', clip(request, 6_000)] : []),
		'</conversation_summary>',
	].join('\n');
	const first = kept[0];
	if (first?.role === 'user') {
		return [{ ...first, content: `${note}\n\n${first.content}` }, ...kept.slice(1)];
	}
	return [{ role: 'user', content: note }, ...kept];
}

/** The latest message the user typed; older transcripts did not mark turns, so the latest non-steering user message. */
function latestRequest(messages: readonly INativeLoopMessage[]): string | undefined {
	let fallback: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'user' || !message.content.trim()) {
			continue;
		}
		if (message.turn) {
			return message.content;
		}
		if (fallback === undefined && !isSteering(messages, i)) {
			fallback = message.content;
		}
	}
	return fallback;
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
	let earliest = messages.length;
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
		earliest = i;
		const { images: _images, ...rest } = message;
		messages[i] = {
			...rest,
			...(survivors.length ? { images: survivors } : {}),
			content: message.content ? `${message.content}\n${PRUNED_IMAGE_NOTE}` : PRUNED_IMAGE_NOTE,
		};
	}
	dropBoundReasoning(messages, earliest);
	return removed;
}

// --- old tool results --------------------------------------------------------------------------

export interface IToolClearPolicy {
	/** Start once the prompt reaches this fraction of the effective window (compaction starts at 0.8). */
	readonly triggerFraction: number;
	readonly minTrigger: number;
	/** Newest tool results that always stay whole. */
	readonly keep: number;
	/** A pass runs only when it frees this much, so the cached prefix is rewritten rarely. */
	readonly clearAtLeast: number;
	/** Results smaller than this are not worth a stub. */
	readonly minResultTokens: number;
}

export const DEFAULT_TOOL_CLEAR: IToolClearPolicy = { triggerFraction: 0.55, minTrigger: 48_000, keep: 6, clearAtLeast: 30_000, minResultTokens: 400 };

const CLEARED_PREFIX = '[Old tool result cleared to save context';

export function toolClearTrigger(window: number, policy: IToolClearPolicy = DEFAULT_TOOL_CLEAR): number {
	return Math.max(policy.minTrigger, Math.round(effectiveWindow({ window, ...DEFAULT_COMPACTION }) * policy.triggerFraction));
}

/** String arguments longer than this (a file's contents, an edit's text) are cleared with old calls; paths and flags stay. */
const LONG_ARG_CHARS = 300;

/**
 * The client-side twin of Anthropic's server-side `clear_tool_uses`, for every other provider: once
 * the prompt passes the trigger, large tool results older than the newest `keep` become a one-line
 * stub naming the call, in one batch. The long text those older calls sent (files written, edit
 * strings) goes in the same pass: it is resent on every step otherwise, and the file holds it now.
 * That defers full compaction (a summary call and a lost cache) on long runs, and each later step
 * resends far fewer tokens. Claude's reasoning after the first edit is dropped (it would be
 * rejected). Returns the tokens freed.
 */
export function clearOldToolResults(messages: INativeLoopMessage[], promptTokens: number, window: number, policy: IToolClearPolicy = DEFAULT_TOOL_CLEAR): number {
	if (promptTokens < toolClearTrigger(window, policy)) {
		return 0;
	}
	const tools: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') {
			tools.push(i);
		}
	}
	if (tools.length <= policy.keep) {
		return 0;
	}
	// Results before the oldest one that stays whole are old, and so are the calls before the one it answers.
	const recent = tools[tools.length - policy.keep];
	let recentCall = recent;
	while (recentCall > 0 && messages[recentCall].role !== 'assistant') {
		recentCall--;
	}
	const edits = new Map<number, INativeLoopMessage>();
	const calls = new Map<string, { readonly name: string; readonly args: unknown }>();
	for (let i = 0; i < recent; i++) {
		const message = messages[i];
		for (const call of message.toolCalls ?? []) {
			calls.set(call.id, call);
		}
		if (message.role === 'tool' && !message.content.startsWith(CLEARED_PREFIX) && messageTokens(message) >= policy.minResultTokens) {
			const call = message.callId ? calls.get(message.callId) : undefined;
			const what = call ? `${call.name} ${clip(safeJson(call.args), 160)}` : message.name ?? 'tool';
			edits.set(i, { ...message, content: `${CLEARED_PREFIX}: ${what}. It was ${message.isError ? 'an error' : `${message.content.length} characters`}; run the tool again if you need it.]` });
		} else if (message.role === 'assistant' && i < recentCall && message.toolCalls?.length) {
			// Only inside an object: the arguments themselves must stay valid JSON.
			const stubbed = { ...message, toolCalls: message.toolCalls.map(call => call.args && typeof call.args === 'object' ? { ...call, args: clearLongArgs(call.args) } : call) };
			if (messageTokens(message) - messageTokens(stubbed) >= policy.minResultTokens) {
				edits.set(i, stubbed);
			}
		}
	}
	let freeable = 0;
	for (const [i, next] of edits) {
		freeable += messageTokens(messages[i]) - messageTokens(next);
	}
	if (freeable < policy.clearAtLeast) {
		return 0;
	}
	let earliest = messages.length;
	for (const [i, next] of edits) {
		messages[i] = next;
		earliest = Math.min(earliest, i);
	}
	dropBoundReasoning(messages, earliest);
	return freeable;
}

function clearLongArgs(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > LONG_ARG_CHARS ? `[cleared to save context: ${value.length} characters]` : value;
	}
	if (Array.isArray(value)) {
		return value.map(clearLongArgs);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = clearLongArgs(item);
		}
		return out;
	}
	return value;
}
