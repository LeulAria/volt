/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { truncateHeadTail } from './toolResult.js';
import { INativeLoopMessage } from './nativeLoop.js';
import { stripOrphanToolResults } from './transcriptRepair.js';

/**
 * The context engine: estimate, budget, prioritize, compact.
 *
 * Every long agent run eventually hits the same wall - the transcript outgrows the window - and
 * the naive answer (drop the oldest messages) throws away the goal, which is the oldest message
 * of all. So compaction here is staged by *cost per unit of value* rather than by age:
 *
 *   1. shrink oversized tool results   (huge, and mostly re-readable)
 *   2. stub out old tool results       (large, and already acted on)
 *   3. summarize the middle turns      (medium, and the gist is what matters)
 *   4. drop the oldest middle turns    (last resort)
 *
 * The goal, the system prompt, and the recent working set are never touched. What the model
 * loses is the raw text of work it already did, not the knowledge of having done it: the
 * evidence digest is folded into the summary, so a compacted run still knows which files it
 * changed and which checks it ran.
 */

// --- estimation ------------------------------------------------------------------------------

/**
 * Cheap and deliberately pessimistic. A real tokenizer costs more than it is worth here: this
 * number only has to be good enough to decide *when* to compact, and over-estimating means
 * compacting slightly early, while under-estimating means a hard context error from the
 * provider. Code and JSON pack worse than prose, so the divisor is 3.5 rather than the usual 4.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	return Math.ceil(text.length / 3.5);
}

/** Message overhead: role markers, tool-call envelopes, and delimiters the provider adds. */
const MESSAGE_OVERHEAD = 4;

export function messageTokens(message: INativeLoopMessage): number {
	const calls = message.toolCalls?.reduce((total, call) => total + estimateTokens(call.name) + estimateTokens(safeJson(call.args)) + MESSAGE_OVERHEAD, 0) ?? 0;
	return estimateTokens(message.content) + calls + MESSAGE_OVERHEAD;
}

export function totalTokens(messages: readonly INativeLoopMessage[]): number {
	return messages.reduce((total, message) => total + messageTokens(message), 0);
}

// --- budgeting -------------------------------------------------------------------------------

/**
 * Channels exist so one kind of context cannot starve the others. Without a cap, a long
 * transcript squeezes out the project rules; without a floor, a big rules file squeezes out the
 * conversation.
 */
export type ContextChannel =
	| 'identity'     // who Volt is, the mode, the tool list
	| 'rules'        // AGENTS.md and the user's constraints
	| 'goal'         // the request and the task brief
	| 'plan'         // the current plan
	| 'evidence'     // what the run has established
	| 'memory'       // recalled facts from earlier sessions
	| 'files'        // attached or retrieved file content
	| 'history'      // the transcript
	| 'environment';

/**
 * Share of the usable window each channel may occupy. They sum to more than 1 on purpose:
 * these are ceilings, not reservations, so an absent channel leaves room for the others
 * rather than wasting it.
 */
const CHANNEL_SHARE: Readonly<Record<ContextChannel, number>> = {
	identity: 0.10,
	rules: 0.15,
	goal: 0.10,
	plan: 0.08,
	evidence: 0.15,
	memory: 0.10,
	files: 0.45,
	history: 0.70,
	environment: 0.05,
};

export interface IContextItem {
	readonly id: string;
	readonly channel: ContextChannel;
	readonly text: string;
	/** Higher is kept first within a channel. */
	readonly priority: number;
	/** Survives regardless of budget. Use for the goal and the mode policy, nothing else. */
	readonly pinned?: boolean;
}

export interface IContextWindow {
	/** The model's full context window in tokens. */
	readonly total: number;
	/** Held back for the model's reply. */
	readonly reserveOutput?: number;
	/** Held back for tool schemas, which are sent on every call. */
	readonly reserveTools?: number;
}

export interface IPackedContext {
	readonly items: readonly IContextItem[];
	readonly dropped: readonly IContextItem[];
	readonly tokensUsed: number;
	readonly tokensAvailable: number;
	/** 0..1 of the usable window consumed. Above `COMPACT_AT` the loop compacts. */
	readonly pressure: number;
}

const DEFAULT_OUTPUT_RESERVE = 4_096;
const DEFAULT_TOOL_RESERVE = 1_500;

export function usableTokens(window: IContextWindow): number {
	const reserved = (window.reserveOutput ?? DEFAULT_OUTPUT_RESERVE) + (window.reserveTools ?? DEFAULT_TOOL_RESERVE);
	return Math.max(1, window.total - reserved);
}

/**
 * Minimal sufficient context: fill the window with the highest-priority item from each channel
 * in turn, so every channel gets its most important entry before any channel gets its second.
 * Round-robin rather than a flat priority sort, because a flat sort lets one verbose channel
 * with slightly higher priorities crowd everything else out.
 */
export function packContext(items: readonly IContextItem[], window: IContextWindow): IPackedContext {
	const available = usableTokens(window);
	const kept: IContextItem[] = [];
	const dropped: IContextItem[] = [];
	let used = 0;

	const pinned = items.filter(item => item.pinned);
	for (const item of pinned) {
		kept.push(item);
		used += estimateTokens(item.text);
	}

	const queues = new Map<ContextChannel, IContextItem[]>();
	for (const item of items.filter(item => !item.pinned)) {
		const queue = queues.get(item.channel) ?? [];
		queue.push(item);
		queues.set(item.channel, queue);
	}
	for (const queue of queues.values()) {
		queue.sort((a, b) => b.priority - a.priority);
	}

	const spentPerChannel = new Map<ContextChannel, number>();
	let progressed = true;
	while (progressed) {
		progressed = false;
		for (const [channel, queue] of queues) {
			const next = queue[0];
			if (!next) {
				continue;
			}
			const cost = estimateTokens(next.text);
			const channelCap = Math.floor(available * CHANNEL_SHARE[channel]);
			const channelUsed = spentPerChannel.get(channel) ?? 0;
			if (used + cost > available || channelUsed + cost > channelCap) {
				continue;
			}
			queue.shift();
			kept.push(next);
			used += cost;
			spentPerChannel.set(channel, channelUsed + cost);
			progressed = true;
		}
	}

	for (const queue of queues.values()) {
		dropped.push(...queue);
	}

	return {
		items: kept,
		dropped,
		tokensUsed: used,
		tokensAvailable: available,
		pressure: round2(Math.min(1, used / available)),
	};
}

// --- compaction ------------------------------------------------------------------------------

/** Compact once the usable window is this full, not when it overflows. */
export const COMPACT_AT = 0.75;

/** Kept verbatim at the tail: the model needs its immediate working set intact. */
const DEFAULT_KEEP_RECENT = 6;

/** A tool result larger than this is shrunk before anything else is considered. */
const LARGE_RESULT_TOKENS = 1_200;

/** A stubbed tool result keeps this much of its original text. */
const STUB_CHARS = 180;

/** OpenCode prune: keep this much recent tool output verbatim before clearing older ones. */
const PRUNE_PROTECT_TOKENS = 8_000;
/** Only commit a prune pass if it frees at least this many tokens. */
const PRUNE_MINIMUM = 1_200;
const PRUNE_MARKER = '[Old tool result content cleared - re-run the tool if you need it.]';

export interface ICompactionOptions {
	/** Tokens the compacted transcript must fit in. */
	readonly maxTokens: number;
	readonly keepRecent?: number;
	/** Folded into the summary - normally `EvidenceStore.digest()`. */
	readonly carryOver?: string;
}

export interface ICompactionResult {
	readonly messages: INativeLoopMessage[];
	readonly compacted: boolean;
	/** The summary inserted in place of the dropped middle, if one was needed. */
	readonly summary?: string;
	readonly droppedMessages: number;
	readonly tokensBefore: number;
	readonly tokensAfter: number;
	/** Which stages ran. Logged so a run that keeps compacting is visible in the trace. */
	readonly stages: readonly CompactionStage[];
}

export type CompactionStage = 'prune-results' | 'shrink-results' | 'stub-results' | 'summarize' | 'drop';

/** Zed: prefer provider-reported usage when the last turn measured it. */
export function needsCompaction(messages: readonly INativeLoopMessage[], maxTokens: number, measuredTokens?: number): boolean {
	const used = measuredTokens && measuredTokens > 0 ? measuredTokens : totalTokens(messages);
	return used > maxTokens * COMPACT_AT;
}

/**
 * Runs the stages in order and stops as soon as the transcript fits. Returns the original array
 * untouched when nothing was needed, so the caller can cheaply tell whether anything happened.
 */
export function compact(messages: readonly INativeLoopMessage[], options: ICompactionOptions): ICompactionResult {
	const tokensBefore = totalTokens(messages);
	const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
	const stages: CompactionStage[] = [];

	if (tokensBefore <= options.maxTokens) {
		return { messages: messages.slice(), compacted: false, droppedMessages: 0, tokensBefore, tokensAfter: tokensBefore, stages };
	}

	const { head, middle, tail } = partition(messages, keepRecent);
	let working = middle.slice();

	// OpenCode prune: clear old completed tool outputs in place once the protected tail is
	// large enough, but only if that actually frees a useful amount of tokens.
	const pruned = pruneOldResults(working);
	if (pruned.freed >= PRUNE_MINIMUM) {
		working = pruned.messages;
		stages.push('prune-results');
		if (fits(head, working, tail, options.maxTokens)) {
			return assemble(head, working, tail, { tokensBefore, stages, dropped: 0 });
		}
	}

	// Shrinking applies to the recent window too: a single 200k-character grep result can blow
	// the budget on its own, and dropping conversation to make room for it would be absurd.
	// Stubbing does not - the model is still reasoning about its most recent results.
	const recent = shrinkLargeResults(tail);
	working = shrinkLargeResults(working);
	stages.push('shrink-results');
	if (fits(head, working, recent, options.maxTokens)) {
		return assemble(head, working, recent, { tokensBefore, stages, dropped: 0 });
	}

	working = stubResults(working);
	stages.push('stub-results');
	if (fits(head, working, recent, options.maxTokens)) {
		return assemble(head, working, recent, { tokensBefore, stages, dropped: 0 });
	}

	const summary = summarize(working, options.carryOver);
	const summarized: INativeLoopMessage[] = summary ? [{ role: 'user', content: summary }] : [];
	stages.push('summarize');
	const afterSummary = stripOrphanToolResults([...head, ...summarized, ...recent]);
	const summarizedHead = afterSummary.filter((_, index) => index < head.length);
	const summarizedMid = afterSummary.slice(head.length, head.length + summarized.length);
	const summarizedTail = afterSummary.slice(head.length + summarized.length);
	if (fits(summarizedHead, summarizedMid, summarizedTail, options.maxTokens)) {
		return assemble(summarizedHead, summarizedMid, summarizedTail, { tokensBefore, stages, dropped: working.length, summary });
	}

	// Last resort: give up on the summary's detail and trim the tail from the front. The very
	// last exchange always survives, because dropping it would strand the model mid-thought.
	stages.push('drop');
	const trimmedSummary = summary ? truncateHeadTail(summary, 2_000).text : undefined;
	const trimmedHead: INativeLoopMessage[] = trimmedSummary ? [{ role: 'user', content: trimmedSummary }] : [];
	let keptTail = recent.slice();
	while (keptTail.length > 1 && !fits(head, trimmedHead, keptTail, options.maxTokens)) {
		const cut = balancedPrefix(keptTail);
		if (cut <= 0) {
			keptTail = keptTail.slice(1);
			continue;
		}
		keptTail = keptTail.slice(cut);
	}
	return assemble(head, trimmedHead, keptTail, {
		tokensBefore,
		stages,
		dropped: working.length + (recent.length - keptTail.length),
		summary: trimmedSummary,
	});
}

/**
 * head   system messages plus the first user turn - the goal, which is never dropped
 * middle everything eligible for compaction
 * tail   the recent working set
 */
function partition(messages: readonly INativeLoopMessage[], keepRecent: number): {
	head: INativeLoopMessage[];
	middle: INativeLoopMessage[];
	tail: INativeLoopMessage[];
} {
	const head: INativeLoopMessage[] = [];
	let index = 0;
	while (index < messages.length && messages[index].role === 'system') {
		head.push(messages[index++]);
	}
	if (index < messages.length && messages[index].role === 'user') {
		head.push(messages[index++]);
	}
	const rest = messages.slice(index);
	const tailStart = Math.max(0, rest.length - keepRecent);
	return { head, middle: rest.slice(0, tailStart), tail: rest.slice(tailStart) };
}

function pruneOldResults(messages: readonly INativeLoopMessage[]): { messages: INativeLoopMessage[]; freed: number } {
	let protect = 0;
	let skipUsers = 2;
	const keep = new Set<number>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === 'user' && skipUsers > 0) {
			skipUsers--;
			keep.add(i);
			protect += messageTokens(message);
			continue;
		}
		if (protect < PRUNE_PROTECT_TOKENS) {
			keep.add(i);
			protect += messageTokens(message);
		}
	}
	let freed = 0;
	const next = messages.map((message, index) => {
		if (keep.has(index) || message.role !== 'tool' || message.content === PRUNE_MARKER) {
			return message;
		}
		freed += Math.max(0, messageTokens(message) - estimateTokens(PRUNE_MARKER));
		return { ...message, content: PRUNE_MARKER };
	});
	return { messages: next, freed };
}

function shrinkLargeResults(messages: readonly INativeLoopMessage[]): INativeLoopMessage[] {
	return messages.map(message => {
		if (message.role !== 'tool' || messageTokens(message) <= LARGE_RESULT_TOKENS) {
			return message;
		}
		return { ...message, content: truncateHeadTail(message.content, LARGE_RESULT_TOKENS * 3).text };
	});
}

function stubResults(messages: readonly INativeLoopMessage[]): INativeLoopMessage[] {
	return messages.map(message => {
		if (message.role !== 'tool') {
			return message;
		}
		const head = message.content.slice(0, STUB_CHARS).trimEnd();
		const elided = message.content.length - head.length;
		return {
			...message,
			content: elided > 0 ? `${head}\n[… ${elided} characters of ${message.name ?? 'tool'} output elided during compaction …]` : message.content,
		};
	});
}

/**
 * Extractive, not generative. A model-written summary would be better prose and would cost a
 * round trip in the middle of a run that is already under pressure - and, worse, it can
 * hallucinate progress that never happened. This one can only restate what is already in the
 * transcript.
 */
function summarize(messages: readonly INativeLoopMessage[], carryOver: string | undefined): string {
	if (!messages.length && !carryOver) {
		return '';
	}
	const sections: string[] = ['[Earlier turns were compacted. What happened:]'];

	const requests = messages.filter(message => message.role === 'user' && message.content.trim());
	if (requests.length) {
		sections.push(['Follow-up instructions you were given:', ...requests.slice(-4).map(message => `- ${oneLine(message.content, 200)}`)].join('\n'));
	}

	const toolNames = new Map<string, number>();
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			toolNames.set(call.name, (toolNames.get(call.name) ?? 0) + 1);
		}
	}
	if (toolNames.size) {
		const used = [...toolNames].sort((a, b) => b[1] - a[1]).map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
		sections.push(`Tools already used: ${used.join(', ')}.`);
	}

	const said = messages.filter(message => message.role === 'assistant' && message.content.trim());
	if (said.length) {
		sections.push(['What you last concluded:', ...said.slice(-2).map(message => `- ${oneLine(message.content, 300)}`)].join('\n'));
	}

	if (carryOver?.trim()) {
		sections.push(carryOver.trim());
	}

	sections.push('Continue from here. Do not redo work listed above.');
	return sections.join('\n\n');
}

/**
 * DeepSeek tool-pairing cut: drop a prefix only at a boundary where every
 * `toolCalls` entry has been closed by a following `tool` result. Cutting
 * between a call and its result is how resume reconstructs a conversation
 * that never happened.
 */
export function balancedPrefix(messages: readonly INativeLoopMessage[]): number {
	let open = 0;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === 'assistant' && message.toolCalls?.length) {
			open += message.toolCalls.length;
		}
		if (message.role === 'tool') {
			open = Math.max(0, open - 1);
		}
		if (open === 0 && i + 1 < messages.length) {
			return i + 1;
		}
	}
	return 0;
}

function fits(head: readonly INativeLoopMessage[], middle: readonly INativeLoopMessage[], tail: readonly INativeLoopMessage[], maxTokens: number): boolean {
	return totalTokens(head) + totalTokens(middle) + totalTokens(tail) <= maxTokens;
}

function assemble(
	head: readonly INativeLoopMessage[],
	middle: readonly INativeLoopMessage[],
	tail: readonly INativeLoopMessage[],
	meta: { tokensBefore: number; stages: CompactionStage[]; dropped: number; summary?: string },
): ICompactionResult {
	const messages = [...head, ...middle, ...tail];
	return {
		messages,
		compacted: true,
		droppedMessages: meta.dropped,
		tokensBefore: meta.tokensBefore,
		tokensAfter: totalTokens(messages),
		stages: meta.stages,
		...(meta.summary ? { summary: meta.summary } : {}),
	};
}

// --- hierarchical summaries -------------------------------------------------------------------

export interface ISummaryLayer {
	/** 0 is a summary of raw turns, 1 a summary of those summaries, and so on. */
	readonly level: number;
	readonly text: string;
	readonly coversMessages: number;
	readonly createdAt: number;
}

/**
 * Hierarchical summaries. A run long enough to compact several times accumulates a stack of
 * summaries, and left alone they grow without bound - each one the size of the last. Folding
 * every `FOLD_AT` summaries of a level into one of the next level keeps the total logarithmic
 * in the length of the run.
 */
const FOLD_AT = 3;

export class SummaryLadder {

	private layers: ISummaryLayer[] = [];

	add(text: string, coversMessages: number, now = Date.now()): void {
		if (!text.trim()) {
			return;
		}
		this.layers.push({ level: 0, text: text.trim(), coversMessages, createdAt: now });
		this.fold(now);
	}

	/** Oldest first, so the assembled context reads forwards in time. */
	all(): readonly ISummaryLayer[] {
		return [...this.layers].sort((a, b) => b.level - a.level || a.createdAt - b.createdAt);
	}

	text(): string {
		return this.all().map(layer => layer.text).join('\n\n');
	}

	private fold(now: number): void {
		for (let level = 0; ; level++) {
			const atLevel = this.layers.filter(layer => layer.level === level);
			if (atLevel.length < FOLD_AT) {
				return;
			}
			const folded: ISummaryLayer = {
				level: level + 1,
				text: [
					`[Condensed account of ${atLevel.reduce((total, layer) => total + layer.coversMessages, 0)} earlier turns:]`,
					...atLevel.map(layer => oneLine(layer.text.replace(/^\[[^\]]*\]\s*/, ''), 400)),
				].join('\n'),
				coversMessages: atLevel.reduce((total, layer) => total + layer.coversMessages, 0),
				createdAt: now,
			};
			this.layers = [...this.layers.filter(layer => layer.level !== level), folded];
		}
	}
}

// --- helpers -----------------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
	const single = text.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(value);
	}
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
