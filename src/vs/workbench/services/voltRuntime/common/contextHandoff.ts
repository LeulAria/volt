/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { estimateTokens } from './harness/contextEngine.js';

/**
 * The conversation an agent session did not see, written for it within a token budget: when the
 * user moves a chat to another model or provider, when a fork starts, when an idle agent was let
 * go, and as Volt's own compaction for agents without `/compact`.
 *
 * T3 Code replays whole history items newest first until a byte budget runs out and drops the
 * rest. This keeps more of the thread in the same room: the newest turns verbatim, older turns
 * condensed to a line or two each, tool calls reduced to what they touched, file edits as paths,
 * the first request pinned, and one line for whatever still did not fit (with where to read it).
 * Everything here is deterministic: the same conversation and budget give the same text.
 */

export type HandoffToolKind = 'read' | 'search' | 'edit' | 'execute' | 'fetch' | 'browser' | 'delegate' | 'other';

/** One tool call, reduced to what it touched: a path, a command, a query, or the tool's name. */
export interface IHandoffToolCall {
	readonly kind: HandoffToolKind;
	readonly label: string;
	readonly failed?: boolean;
}

export interface IHandoffFile {
	readonly path: string;
	readonly kind: 'edit' | 'create' | 'delete';
}

/** What an assistant turn did besides talking. */
export interface IHandoffActivity {
	readonly tools: readonly IHandoffToolCall[];
	readonly files: readonly IHandoffFile[];
}

export interface IHandoffMessage {
	readonly role: 'user' | 'assistant' | 'system';
	readonly content: string;
	/** The model that wrote a reply. */
	readonly model?: string;
	/** A message sent into a running turn, not a turn of its own. */
	readonly steer?: boolean;
	readonly activity?: IHandoffActivity;
	/** A compacted summary that stands in for everything before it. */
	readonly compacted?: boolean;
}

/** Why the agent is being briefed. Changes the opening line only. */
export type HandoffReason = 'switch' | 'return' | 'fork' | 'resume' | 'compact';

export interface IContextHandoffInput {
	/** The messages the receiving session has not seen, oldest first (the prompt about to go out excluded). */
	readonly messages: readonly IHandoffMessage[];
	/** In estimated tokens; the result never exceeds it. */
	readonly budget: number;
	readonly reason: HandoffReason;
	/** 1-based number of the first turn in `messages`, so a delta names its turns as the chat does. */
	readonly firstTurn?: number;
	readonly fromLabel?: string;
	readonly toLabel?: string;
	/** Lets the agent read what was left out (`thread_read`). */
	readonly threadId?: string;
}

export interface IContextHandoff {
	readonly text: string;
	/** Estimated tokens of `text`. */
	readonly tokens: number;
	readonly budget: number;
	readonly reason: HandoffReason;
	readonly turns: number;
	readonly verbatimTurns: number;
	readonly condensedTurns: number;
	readonly omittedTurns: number;
	/** Tool calls reduced to summaries (in verbatim and condensed turns). */
	readonly toolCalls: number;
	/** Files the conversation changed, newest last. */
	readonly files: readonly string[];
}

//#region Budget

export const HANDOFF_BUDGET_PERCENT_SETTING = 'volt.agent.handoff.budgetPercent';
export const HANDOFF_MAX_TOKENS_SETTING = 'volt.agent.handoff.maxTokens';

export const HANDOFF_DEFAULT_PERCENT = 15;
export const HANDOFF_DEFAULT_MAX_TOKENS = 32_000;
/** Below this a handoff cannot hold even the latest exchange. */
export const HANDOFF_MIN_TOKENS = 2_000;
/** When the target model's window is unknown. */
const DEFAULT_WINDOW = 128_000;

/** Volt's own compaction keeps less than a handoff: the point is to free the window. */
export const COMPACT_DEFAULT_PERCENT = 10;
export const COMPACT_MAX_TOKENS = 24_000;

export interface IHandoffBudgetInput {
	/** The receiving model's context window. */
	readonly contextWindow?: number;
	/** Share of the window the handoff may take (1-50). */
	readonly percent?: number;
	readonly maxTokens?: number;
}

/**
 * The handoff's size: a share of the receiving model's window, capped, so a 1M-token model does
 * not get a 150K-token recap and a 32K one is not filled by it.
 */
export function handoffBudget(input: IHandoffBudgetInput): number {
	const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : DEFAULT_WINDOW;
	const percent = clampNumber(input.percent, 1, 50) ?? HANDOFF_DEFAULT_PERCENT;
	const cap = clampNumber(input.maxTokens, HANDOFF_MIN_TOKENS, 200_000) ?? HANDOFF_DEFAULT_MAX_TOKENS;
	// Never more than a third of the window, whatever the settings say: the agent needs room to work.
	return Math.max(HANDOFF_MIN_TOKENS, Math.min(cap, Math.floor(window * percent / 100), Math.floor(window / 3)));
}

/** What Volt's compaction keeps for agents without `/compact`. */
export function compactionBudget(contextWindow: number | undefined): number {
	return handoffBudget({ contextWindow, percent: COMPACT_DEFAULT_PERCENT, maxTokens: COMPACT_MAX_TOKENS });
}

function clampNumber(value: number | undefined, min: number, max: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

//#endregion

//#region Turns

interface ITurn {
	/** 1-based, as the chat counts its turns. */
	readonly number: number;
	readonly user: string;
	/** Messages the user sent into the running turn. */
	readonly steers: string[];
	readonly replies: { readonly text: string; readonly model?: string }[];
	readonly tools: IHandoffToolCall[];
	readonly files: IHandoffFile[];
}

/** User turns with their replies; a compacted summary comes back separately. */
export function groupHandoffTurns(messages: readonly IHandoffMessage[], firstTurn = 1): { readonly summary?: string; readonly turns: readonly ITurn[] } {
	let summary: string | undefined;
	const turns: ITurn[] = [];
	let current: ITurn | undefined;
	for (const message of messages) {
		if (message.role === 'system') {
			continue;
		}
		if (message.compacted) {
			// Everything before a compaction is in its summary.
			summary = message.content.trim();
			turns.length = 0;
			current = undefined;
			continue;
		}
		if (message.role === 'user' && !message.steer) {
			current = { number: firstTurn + turns.length, user: message.content.trim(), steers: [], replies: [], tools: [], files: [] };
			turns.push(current);
			continue;
		}
		if (!current) {
			// A reply with no prompt in the slice: the delta starts mid-turn.
			current = { number: firstTurn + turns.length, user: '', steers: [], replies: [], tools: [], files: [] };
			turns.push(current);
		}
		if (message.role === 'user') {
			if (message.content.trim()) {
				current.steers.push(message.content.trim());
			}
			continue;
		}
		if (message.content.trim()) {
			current.replies.push({ text: message.content.trim(), ...(message.model ? { model: message.model } : {}) });
		}
		current.tools.push(...message.activity?.tools ?? []);
		current.files.push(...message.activity?.files ?? []);
	}
	return { ...(summary ? { summary } : {}), turns };
}

//#endregion

//#region Rendering

/** The one-line form of a turn's tool calls: "read a.ts, b.ts +3 · ran `npm test` (failed) · 2 searches". */
export function summarizeTools(tools: readonly IHandoffToolCall[], maxItems = 4): string {
	if (!tools.length) {
		return '';
	}
	const parts: string[] = [];
	const list = (kind: HandoffToolKind, verb: string, quote: boolean) => {
		const calls = tools.filter(tool => tool.kind === kind);
		if (!calls.length) {
			return;
		}
		const labels: string[] = [];
		for (const call of calls) {
			const label = clip(oneLine(call.label), 80);
			const shown = quote ? `\`${label}\`${call.failed ? ' (failed)' : ''}` : `${label}${call.failed ? ' (failed)' : ''}`;
			if (!labels.includes(shown)) {
				labels.push(shown);
			}
		}
		const more = labels.length - maxItems;
		parts.push(`${verb} ${labels.slice(0, maxItems).join(', ')}${more > 0 ? ` +${more} more` : ''}`);
	};
	list('read', 'read', false);
	list('execute', 'ran', true);
	list('edit', 'edited', false);
	list('fetch', 'fetched', false);
	const counted = (kind: HandoffToolKind, one: string, many: string) => {
		const count = tools.filter(tool => tool.kind === kind).length;
		if (count) {
			parts.push(count === 1 ? one : many.replace('{0}', String(count)));
		}
	};
	counted('search', '1 search', '{0} searches');
	counted('browser', '1 browser action', '{0} browser actions');
	counted('delegate', '1 subagent', '{0} subagents');
	const other = tools.filter(tool => tool.kind === 'other');
	if (other.length) {
		const names = [...new Set(other.map(tool => clip(oneLine(tool.label), 40)))];
		parts.push(`used ${names.slice(0, maxItems).join(', ')}${names.length > maxItems ? ` +${names.length - maxItems} more` : ''}`);
	}
	return parts.join(' · ');
}

/** "src/a.ts (edited), b.ts (created)", latest kind per path. */
export function summarizeFiles(files: readonly IHandoffFile[], maxItems = 8): string {
	const latest = new Map<string, IHandoffFile['kind']>();
	for (const file of files) {
		const previous = latest.get(file.path);
		// Created then edited is still a new file.
		latest.set(file.path, previous === 'create' && file.kind === 'edit' ? 'create' : file.kind);
	}
	const entries = [...latest].map(([path, kind]) => `${path} (${kind === 'create' ? 'created' : kind === 'delete' ? 'deleted' : 'edited'})`);
	const more = entries.length - maxItems;
	return `${entries.slice(0, maxItems).join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}

function renderVerbatim(turn: ITurn, maxMessageTokens: number): string {
	const lines: string[] = [`### Turn ${turn.number}`];
	if (turn.user) {
		lines.push(`User: ${clipTokens(turn.user, maxMessageTokens)}`);
	}
	for (const steer of turn.steers) {
		lines.push(`User (while the agent worked): ${clipTokens(steer, Math.floor(maxMessageTokens / 2))}`);
	}
	const tools = summarizeTools(turn.tools);
	if (tools) {
		lines.push(`Tool calls: ${tools}`);
	}
	if (turn.files.length) {
		lines.push(`Files changed: ${summarizeFiles(turn.files)}`);
	}
	const model = replyModel(turn);
	const reply = turn.replies.map(part => part.text).join('\n\n');
	if (reply) {
		lines.push(`Assistant${model ? ` (${model})` : ''}: ${clipTokens(reply, maxMessageTokens)}`);
	} else if (!turn.user) {
		lines.push('Assistant: (no reply text)');
	} else {
		lines.push('Assistant: (no reply: the turn was stopped or failed)');
	}
	return lines.join('\n');
}

function renderCondensed(turn: ITurn): string {
	const model = replyModel(turn);
	const reply = turn.replies.map(part => part.text).join(' ');
	const extras = [summarizeTools(turn.tools, 3), turn.files.length ? `files: ${summarizeFiles(turn.files, 5)}` : ''].filter(Boolean).join('; ');
	const user = turn.user ? clip(oneLine(turn.user), 200) : '(continued)';
	const lines = [`- Turn ${turn.number}. User: ${user}`];
	if (reply || extras) {
		lines.push(`  Assistant${model ? ` (${model})` : ''}: ${reply ? clip(firstSentences(oneLine(reply), 240), 240) : '(no reply text)'}${extras ? ` [${extras}]` : ''}`);
	}
	return lines.join('\n');
}

function replyModel(turn: ITurn): string | undefined {
	const models = [...new Set(turn.replies.map(part => part.model).filter((model): model is string => !!model))];
	return models.length ? models.join(', ') : undefined;
}

function opening(input: IContextHandoffInput): string {
	const from = input.fromLabel ? ` from ${input.fromLabel}` : '';
	const to = input.toLabel ? ` (${input.toLabel})` : '';
	switch (input.reason) {
		case 'switch': return `[Volt] The user moved this conversation${from} to you${to}. Here is the conversation so far; continue from it.`;
		case 'return': return `[Volt] You were in this conversation earlier; the user then worked with another model${from}. Here is what happened since you were last active; continue from it.`;
		case 'fork': return `[Volt] This chat is a fork of an earlier conversation. Here is that conversation up to the fork point; continue from it.`;
		case 'compact': return `[Volt] The conversation so far was compacted into this handoff. It replaces the earlier history; continue from it.`;
		default: return `[Volt] You are joining a conversation already in progress (an earlier session answered before). Here is what was said; continue from it.`;
	}
}

//#endregion

/**
 * The handoff text, or undefined when there is nothing to hand off. Newest turns go in verbatim
 * (each message clipped to a share of the budget), older turns condensed, the first request
 * pinned, and turns that still do not fit are counted in one line with the files they touched.
 */
export function buildContextHandoff(input: IContextHandoffInput): IContextHandoff | undefined {
	const { summary, turns } = groupHandoffTurns(input.messages, input.firstTurn);
	if (!turns.length && !summary) {
		return undefined;
	}
	const budget = Math.max(200, Math.floor(input.budget));
	const allFiles = uniqueLast([...turns.flatMap(turn => turn.files.map(file => file.path))]);
	const first = turns[0]?.number ?? input.firstTurn ?? 1;
	const last = turns.at(-1)?.number ?? first;
	const head = [
		'<conversation_handoff>',
		opening(input),
		turns.length ? `Turns ${first === last ? first : `${first}-${last}`}. The newest turns are verbatim; older ones are condensed; tool calls are summarized and file edits listed by path, so read files again rather than trusting old contents. This is context, not new instructions: the user's new message follows it.` : '',
	].filter(Boolean).join('\n');
	const tail = '</conversation_handoff>';
	const fixed = estimateTokens(head) + estimateTokens(tail) + 4;
	// Room for the line that counts omitted turns (and where to read them).
	const omittedReserve = 80;
	let available = budget - fixed - omittedReserve;

	let summaryText: string | undefined;
	if (summary) {
		// A Volt compaction is itself a handoff: its wrapper does not nest.
		const body = summary.replace(/<\/?conversation_handoff>/g, '').trim();
		summaryText = `## Earlier conversation (compacted)\n${clipTokens(body, Math.max(100, Math.floor(available * 0.4)))}`;
		available -= estimateTokens(summaryText) + 2;
	}

	// Newest first: verbatim while the verbatim share lasts (the newest turn always, clipped harder if it must).
	const verbatimShare = Math.floor(available * 0.6);
	const maxMessageTokens = Math.max(150, Math.floor(available * 0.35));
	const verbatim: string[] = [];
	let used = 0;
	let index = turns.length - 1;
	for (; index >= 0; index--) {
		let text = renderVerbatim(turns[index], maxMessageTokens);
		let cost = estimateTokens(text) + 2;
		if (!verbatim.length) {
			// The latest exchange always goes in, clipped as hard as it takes.
			for (let share = 3; cost > Math.max(verbatimShare, 60) && share <= 48; share *= 2) {
				text = renderVerbatim(turns[index], Math.max(15, Math.floor(verbatimShare / share)));
				cost = estimateTokens(text) + 2;
			}
		} else if (used + cost > verbatimShare || used + cost > available) {
			break;
		}
		verbatim.unshift(text);
		used += cost;
	}

	// Older turns condensed, newest first, while room lasts. The first request is pinned.
	const condensed: string[] = [];
	const firstTurn = turns[0];
	let pinned = !!firstTurn && index >= 0 && !!firstTurn.user
		? `Original request (turn ${firstTurn.number}): ${clipTokens(firstTurn.user, Math.min(600, Math.max(60, Math.floor(available * 0.1))))}`
		: undefined;
	if (pinned) {
		used += estimateTokens(pinned) + 2;
	}
	for (; index >= 0; index--) {
		const text = renderCondensed(turns[index]);
		const cost = estimateTokens(text) + 1;
		if (used + cost > available) {
			break;
		}
		condensed.unshift(text);
		used += cost;
	}
	const omittedCount = turns.length - verbatim.length - condensed.length;
	if (!omittedCount) {
		// The first turn made it in after all.
		pinned = undefined;
	}
	const omitted = turns.slice(0, omittedCount);
	let omittedLine: string | undefined;
	if (omittedCount > 0) {
		const touched = uniqueLast(omitted.flatMap(turn => turn.files.map(file => file.path)));
		const range = omittedCount === 1 ? `Turn ${omitted[0].number} was` : `Turns ${omitted[0].number}-${omitted.at(-1)!.number} were`;
		omittedLine = `${range} left out to fit${touched.length ? ` (files changed then: ${touched.slice(0, 6).join(', ')}${touched.length > 6 ? ` +${touched.length - 6} more` : ''})` : ''}.${input.threadId ? ` thread_read with thread_id ${input.threadId} returns them in full.` : ''}`;
		omittedLine = clip(omittedLine, omittedReserve * 3);
	}

	const sections = [
		head,
		...(summaryText ? [summaryText] : []),
		...(pinned ? [pinned] : []),
		...(omittedLine ? [omittedLine] : []),
		...(condensed.length ? [`## Earlier turns (condensed)\n${condensed.join('\n')}`] : []),
		...(verbatim.length ? [`## Recent turns\n${verbatim.join('\n\n')}`] : []),
		tail,
	];
	let text = sections.join('\n\n');
	// The estimate of the parts can undershoot the whole by a few tokens; never hand over more than the budget.
	if (estimateTokens(text) > budget) {
		text = clipTokens(text.slice(0, -tail.length), budget - estimateTokens(tail) - 2) + '\n' + tail;
	}
	const kept = turns.slice(turns.length - verbatim.length - condensed.length);
	return {
		text,
		tokens: estimateTokens(text),
		budget,
		reason: input.reason,
		turns: turns.length,
		verbatimTurns: verbatim.length,
		condensedTurns: condensed.length,
		omittedTurns: omittedCount,
		toolCalls: kept.reduce((sum, turn) => sum + turn.tools.length, 0),
		files: allFiles,
	};
}

//#region Text helpers

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

/** Keeps head and tail of a long message: the ask is usually first, the conclusion last. */
function clipTokens(text: string, maxTokens: number): string {
	const maxChars = Math.max(40, Math.floor(maxTokens * 3.5));
	if (text.length <= maxChars) {
		return text;
	}
	const marker = '\n[… clipped …]\n';
	const head = Math.floor((maxChars - marker.length) * 0.7);
	const tail = Math.max(0, maxChars - marker.length - head);
	return `${text.slice(0, head).trimEnd()}${marker}${tail ? text.slice(text.length - tail).trimStart() : ''}`;
}

/** Up to `max` characters, ending at a sentence boundary when one is near. */
function firstSentences(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const cut = text.slice(0, max);
	const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
	return end > max * 0.5 ? cut.slice(0, end + 1) : text;
}

function uniqueLast(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = values.length - 1; i >= 0; i--) {
		if (!seen.has(values[i])) {
			seen.add(values[i]);
			out.unshift(values[i]);
		}
	}
	return out;
}

//#endregion

//#region Recording

/** The path as the agent would write it: relative to the chat's folder when it is inside it. */
export function handoffPath(path: string, cwd: string | undefined): string {
	const normalized = path.replace(/\\/g, '/');
	if (cwd) {
		const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
		if (normalized.startsWith(`${root}/`)) {
			return normalized.slice(root.length + 1);
		}
	}
	return normalized;
}

/**
 * A tool call reduced for a handoff: the command it ran, the path it read or edited, the query it
 * searched, or its name. `kind` is Volt's semantic kind (ACP's, mapped).
 */
export function handoffToolCall(call: { readonly kind?: string; readonly name?: string; readonly title?: string; readonly input?: string; readonly paths?: readonly string[]; readonly failed?: boolean }, cwd: string | undefined): IHandoffToolCall {
	const kind: HandoffToolKind = call.kind === 'read' || call.kind === 'search' || call.kind === 'edit' || call.kind === 'execute' || call.kind === 'fetch' || call.kind === 'browser' || call.kind === 'delegate'
		? call.kind
		: call.kind === 'delete' || call.kind === 'move' ? 'edit' : 'other';
	let input: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = call.input?.trim() ? JSON.parse(call.input) : undefined;
		input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		input = undefined;
	}
	const field = (...names: string[]) => {
		for (const name of names) {
			const value = input?.[name];
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
			if (Array.isArray(value) && value.length && value.every(part => typeof part === 'string')) {
				return value.join(' ');
			}
		}
		return undefined;
	};
	const title = call.title?.replace(/^`+|`+$/g, '').trim();
	let label: string | undefined;
	switch (kind) {
		case 'execute':
			label = field('command', 'cmd') ?? (call.input && !input ? call.input.trim() : undefined) ?? title;
			break;
		case 'read':
		case 'edit': {
			const path = call.paths?.[0] ?? field('file_path', 'filePath', 'path', 'target_file', 'file');
			label = path ? handoffPath(path, cwd) : title;
			break;
		}
		case 'search':
			label = field('pattern', 'query', 'regex', 'glob', 'search') ?? title;
			break;
		case 'fetch':
			label = field('url', 'uri', 'query') ?? title;
			break;
		default:
			label = call.name ?? title;
	}
	return { kind, label: (label || call.name || kind).replace(/\s+/g, ' ').trim(), ...(call.failed ? { failed: true } : {}) };
}

//#endregion
