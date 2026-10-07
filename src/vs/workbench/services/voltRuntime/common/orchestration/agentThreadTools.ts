/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo, VoltThreadToolName } from '../hostTools.js';
import type { IVoltCatalogItem } from '../providers.js';
import type { OrchThreadStatusKind } from './orchestratorViews.js';

/**
 * Orchestration tools: an agent runs other Volt chats the way the user does. It lists and reads
 * them, messages them (and gets the reply in the same call), waits on several at once, forks a
 * conversation into a new chat (on another model, in its own worktree), launches new top-level
 * chats (one per model to compare them), and manages their queues.
 *
 * Modeled on T3 Code's orchestrator MCP tools (thread, queue and worktree toolkits), with what an
 * orchestrating agent otherwise spends extra calls on folded in: `thread_send` with `wait`,
 * `thread_wait` over many chats, `thread_fork` at any turn with a model, worktree and first
 * message, and `thread_launch` with `models`. Agent messages arrive as wake-ups, so two agents
 * messaging each other stop after `maxWakeups` turns in a row and wait for the user.
 *
 * This module is pure: tool definitions, argument parsing and the text agents read.
 */

/** Long-poll budget per call: agents' MCP clients time a call out at 60 s and do not reset on progress. */
export const THREAD_WAIT_MS = 45_000;
/** A reply longer than this is clipped in tool results; `thread_read` pages through the rest. */
export const THREAD_REPLY_CHARS = 8_000;
/** Per message in `thread_read` (default, and the most an agent may ask for). */
export const THREAD_READ_CHARS = 4_000;
export const THREAD_READ_MAX_CHARS = 40_000;
/** Messages an agent may send to another chat in one call. */
export const THREAD_MESSAGE_CHARS = 100_000;
/** Chats one `thread_launch` may start (one per model). */
export const MAX_LAUNCH_MODELS = 4;

const THREAD_ID = { type: 'string', description: 'A chat id from thread_list or thread_search (the `volt://session/<id>` part). Omit for this chat.' };
const REQUIRED_THREAD_ID = { type: 'string', description: 'A chat id from thread_list or thread_search.' };
const QUEUE_ITEM = { type: 'string', description: 'A queued message id from queue_list.' };
const MODEL = { type: 'string', description: 'A `model` value from orchestrator_capabilities (exact ref, or a label such as "Claude Opus 5.5"). Omit for the same model.' };
const MODE = { type: 'string', enum: ['agent', 'plan', 'ask'], description: 'agent edits files; plan and ask are read-only. Default agent (or this chat\'s mode when it is read-only).' };
const WORKSPACE = {
	type: 'object',
	description: 'Where the chat works. root (default): the project\'s main checkout, NOT this chat\'s worktree. worktree: a new git worktree and branch made from base_ref (default: the project\'s current HEAD); setup from .volt/worktrees.json or .cursor/worktrees.json runs before the first message. existing_worktree: a checkout that already exists (worktree_list shows them). Uncommitted edits are never copied.',
	properties: {
		type: { type: 'string', enum: ['root', 'worktree', 'existing_worktree'] },
		base_ref: { type: 'string', description: 'worktree: the branch or commit to start from (for a stacked pull request, the parent branch).' },
		branch: { type: 'string', description: 'worktree: the new branch name (default volt/<id>). existing_worktree: the branch it has checked out.' },
		path: { type: 'string', description: 'existing_worktree: its absolute path.' },
	},
	required: ['type'],
};

/** Mutating tools ask before they run from a read-only (Ask, Plan) chat: they change other chats. */
const CHANGES_CHATS = 'changes other chats';

export const THREAD_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: 'orchestrator_capabilities',
		title: 'Read orchestrator capabilities',
		group: 'threads',
		description: 'What this chat can orchestrate: its own id, project, checkout and model; every model Volt can run (the same list as the user\'s model picker, with each `model` value to pass to delegate_task, thread_launch, thread_fork and thread_configure); the limits (parallel subagents, wake-ups); and which tools to use for what. Call it before choosing models or starting other chats.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'thread_list',
		title: 'Listed chats',
		group: 'threads',
		description: 'List Volt chats, most recently active first: id, title, status (working, needsInput, queued, paused, blocked, idle, failed, interrupted, stopping), model, checkout, queued messages, and a volt://session link. Default: this chat\'s project. Paste a chat\'s link when you mention it so the user can open it.',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: '"this" (default), "all", or a project folder path.' },
				status: { type: 'array', items: { type: 'string', enum: ['working', 'needsInput', 'queued', 'paused', 'blocked', 'idle', 'failed', 'interrupted', 'stopping', 'starting', 'delegating'] }, description: 'Only chats in these states.' },
				query: { type: 'string', description: 'Only chats whose title contains this.' },
				include_subagents: { type: 'boolean', description: 'Also list subagent chats (delegate_task children). Default false.' },
				include_archived: { type: 'boolean' },
				limit: { type: 'number', description: '1-100, default 30.' },
				cursor: { type: 'number', description: 'nextCursor from the previous page.' },
			},
		},
	},
	{
		name: 'thread_search',
		title: 'Searched chats',
		group: 'threads',
		description: 'Search chats by title, first prompt and latest summary (this project by default, "all" for every project). Returns the same lines as thread_list. Use thread_read to read a match.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				project: { type: 'string', description: '"this" (default), "all", or a project folder path.' },
				limit: { type: 'number', description: '1-50, default 20.' },
			},
			required: ['query'],
		},
	},
	{
		name: 'thread_read',
		title: 'Read chat',
		group: 'threads',
		description: 'Read a chat: its status, model, checkout, queue and subagents, then its messages (the user\'s prompts and the final replies), oldest first. Page with after=nextAfter; long messages are clipped at max_chars (read one turn in full with turn and max_chars up to 40000). Without thread_id, reads this chat.',
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: THREAD_ID,
				after: { type: 'number', description: 'Return turns after this turn number (1-based). Default: the last `limit` turns.' },
				turn: { type: 'number', description: 'Read only this turn (1-based).' },
				limit: { type: 'number', description: 'Turns to return, 1-50, default 10.' },
				max_chars: { type: 'number', description: `Per message, default ${THREAD_READ_CHARS}, at most ${THREAD_READ_MAX_CHARS}.` },
			},
		},
	},
	{
		name: 'thread_send',
		title: 'Messaged chat',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: [
			'Send a message to another Volt chat. Its agent reads it as a message from this chat (marked as yours in its transcript, not the user\'s). mode: auto (default) starts an idle chat, steers a running agent that takes messages mid-turn, else queues behind its turn; queue always waits for the running turn; steer only delivers into the running turn (fails if it cannot); interrupt stops the running turn and runs this next.',
			'wait=true waits for the chat to finish (up to about 45 s per call) and returns its reply, so asking another chat a question is one call; if it is still working, call thread_wait. Messages between agents count as wake-ups: a chat answers at most 8 in a row before it waits for the user. Do not use it for a delegated task\'s chat: use message_task, or delegate_task for a new review round.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: REQUIRED_THREAD_ID,
				message: { type: 'string', description: 'Complete and self-contained: the other agent does not see this conversation.' },
				mode: { type: 'string', enum: ['auto', 'queue', 'steer', 'interrupt'] },
				wait: { type: 'boolean', description: 'Return the reply (up to about 45 s). Default false.' },
				client_request_id: { type: 'string', description: 'Idempotency key: a retry with the same key does not send twice.' },
			},
			required: ['thread_id', 'message'],
		},
	},
	{
		name: 'thread_wait',
		title: 'Waited for chats',
		group: 'threads',
		description: 'Wait until chats finish their turn (idle, failed, interrupted) or need the user, and return each one\'s status and latest reply. Waits for all of them, or the first with any=true. Returns after about 45 s even if some still work (the wait never stops them); call again to keep waiting. A chat that is already idle returns at once.',
		inputSchema: {
			type: 'object',
			properties: {
				thread_ids: { type: 'array', items: { type: 'string' }, description: 'Chats to wait for.' },
				thread_id: { type: 'string', description: 'One chat (same as thread_ids with one id).' },
				any: { type: 'boolean', description: 'Return as soon as one of them finishes.' },
				timeout_s: { type: 'number', description: 'At most 45 (the default).' },
			},
		},
	},
	{
		name: 'thread_interrupt',
		title: 'Interrupted chat',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Stop another chat\'s running turn. Its queued messages stay (they run next unless you cancel them with queue_cancel). subagents=true also stops the subagents that turn started. A chat that is not running is left as it is.',
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: REQUIRED_THREAD_ID,
				subagents: { type: 'boolean' },
				reason: { type: 'string' },
			},
			required: ['thread_id'],
		},
	},
	{
		name: 'thread_fork',
		title: 'Forked chat',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Copy a chat\'s conversation into a new top-level chat to try another direction without touching the original: up to turn at_turn (default: every finished turn), optionally on another model (cross-model fork), in its own new worktree (workspace "worktree", so its edits cannot collide with the original\'s), and with a first message to send (fork and continue in one call). The fork\'s agent gets the conversation as context. Without thread_id, forks this chat. Returns the new chat id and link.',
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: THREAD_ID,
				at_turn: { type: 'number', description: 'Keep turns 1..at_turn. Default: every finished turn.' },
				title: { type: 'string', description: 'Default "<title> · fork".' },
				model: MODEL,
				workspace: { type: 'string', enum: ['same', 'worktree'], description: 'same (default): the source chat\'s checkout. worktree: a new worktree branched from that checkout\'s HEAD.' },
				message: { type: 'string', description: 'Sent to the fork right away. Omit to leave it idle for the user.' },
				open: { type: 'boolean', description: 'Open the fork in a tab for the user. Default false.' },
			},
		},
	},
	{
		name: 'thread_launch',
		title: 'Launched chat',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: [
			'Start a new top-level Volt chat (in the user\'s sidebar) with a first message: independent work, a separate pull request, a stack layer in its own worktree. Pick its model, mode and workspace (root, a new worktree from base_ref, or an existing worktree). For a child task whose report should come back to you, use delegate_task instead.',
			`models: 2-${MAX_LAUNCH_MODELS} models run the same message side by side, each in its own worktree, with Volt's compare view to pick a winner.`,
			'Returns at once with the chat id(s) and link(s); follow them with thread_wait / thread_read. No retry key: after an error, check thread_list before launching again.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short title (3-8 words).' },
				message: { type: 'string', description: 'The task, complete and self-contained. Omit to create an idle chat.' },
				model: MODEL,
				models: { type: 'array', items: { type: 'string' }, description: `Compare: 2-${MAX_LAUNCH_MODELS} models, one chat and worktree each.` },
				mode: MODE,
				project: { type: 'string', description: 'A project folder path. Default: this chat\'s project.' },
				workspace: WORKSPACE,
				open: { type: 'boolean', description: 'Open it in a tab for the user. Default false.' },
			},
			required: ['title'],
		},
	},
	{
		name: 'thread_update',
		title: 'Updated chat',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Organize a chat in the user\'s sidebar: rename, pin, unpin, archive, unarchive, settle (done for now), unsettle, snooze (until snoozed_until, ISO time; omit for until woken), unsnooze, mark_unread, mark_read. Without thread_id, acts on this chat.',
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: THREAD_ID,
				action: { type: 'string', enum: ['rename', 'pin', 'unpin', 'archive', 'unarchive', 'settle', 'unsettle', 'snooze', 'unsnooze', 'mark_unread', 'mark_read'] },
				title: { type: 'string', description: 'rename: the new title.' },
				snoozed_until: { type: 'string', description: 'snooze: ISO date-time.' },
			},
			required: ['action'],
		},
	},
	{
		name: 'thread_configure',
		title: 'Switched model',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Move another chat to a different model: now when it is idle, else when its turn ends. The conversation goes with it. For this chat, use handoff (it lets you write a brief for the next model).',
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: REQUIRED_THREAD_ID,
				model: { ...MODEL, description: 'A `model` value from orchestrator_capabilities.' },
				reason: { type: 'string', description: 'One line for the user.' },
			},
			required: ['thread_id', 'model'],
		},
	},
	{
		name: 'queue_list',
		title: 'Listed queue',
		group: 'threads',
		description: 'A chat\'s queued messages in the order they will be sent (id, kind, a preview, whether the user is editing it), and why the queue is paused if it is. Without thread_id, this chat\'s queue.',
		inputSchema: { type: 'object', properties: { thread_id: THREAD_ID, full: { type: 'boolean', description: 'Whole messages instead of previews.' } } },
	},
	{
		name: 'queue_edit',
		title: 'Edited queued message',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Replace a queued message\'s text before it is sent. Fails when it already went, or while the user is editing it.',
		inputSchema: { type: 'object', properties: { thread_id: THREAD_ID, item_id: QUEUE_ITEM, text: { type: 'string' } }, required: ['item_id', 'text'] },
	},
	{
		name: 'queue_cancel',
		title: 'Cancelled queued message',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Remove a queued message (item_id), or every queued message (all=true), so it is never sent.',
		inputSchema: { type: 'object', properties: { thread_id: THREAD_ID, item_id: QUEUE_ITEM, all: { type: 'boolean' } } },
	},
	{
		name: 'queue_reorder',
		title: 'Reordered queue',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Move a queued message before another one (before_item_id), or to the end (before_item_id null). Or pass the whole order as `order`.',
		inputSchema: {
			type: 'object',
			properties: {
				thread_id: THREAD_ID,
				item_id: QUEUE_ITEM,
				before_item_id: { type: ['string', 'null'] },
				order: { type: 'array', items: { type: 'string' }, description: 'Every queued id in the new order.' },
			},
		},
	},
	{
		name: 'queue_send_now',
		title: 'Sent queued message now',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Deliver a queued message now: into the running turn when its agent takes messages mid-turn (steering), otherwise by stopping that turn and running this message next. On an idle chat it simply starts.',
		inputSchema: { type: 'object', properties: { thread_id: THREAD_ID, item_id: QUEUE_ITEM }, required: ['item_id'] },
	},
	{
		name: 'queue_resume',
		title: 'Resumed queue',
		group: 'threads',
		approvalInReadOnlyModes: CHANGES_CHATS,
		description: 'Let a paused queue run again (it pauses after a failed turn, a stop, a restart, or too many wake-ups in a row).',
		inputSchema: { type: 'object', properties: { thread_id: THREAD_ID } },
	},
	{
		name: 'worktree_status',
		title: 'Read checkout',
		group: 'threads',
		description: 'Where a chat works: its own worktree (path and branch) or the project\'s main checkout, the current branch, uncommitted changes, and commits ahead/behind its upstream. Without thread_id, this chat.',
		inputSchema: { type: 'object', properties: { thread_id: THREAD_ID } },
	},
	{
		name: 'worktree_list',
		title: 'Listed worktrees',
		group: 'threads',
		description: 'Every git worktree of this chat\'s project (path, branch, HEAD) and the chat that uses each, for workspace {type:"existing_worktree"} in thread_launch.',
		inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'A project folder path. Default: this chat\'s project.' } } },
	},
];

export function isThreadTool(name: string): name is VoltThreadToolName {
	return THREAD_TOOLS.some(tool => tool.name === name);
}

//#region Arguments

export function stringArg(value: unknown, max = 200): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function numberArg(value: unknown, min: number, max: number): number | undefined {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : undefined;
}

export function stringList(value: unknown, max = 50): string[] {
	if (typeof value === 'string') {
		// Some agents send arrays as JSON text.
		try {
			const parsed = JSON.parse(value) as unknown;
			if (Array.isArray(parsed)) {
				return stringList(parsed, max);
			}
		} catch {
			// a single value
		}
		return value.trim() ? [value.trim()] : [];
	}
	return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()))].slice(0, max) : [];
}

/** A chat id as agents write it: bare, or the `volt://session/<id>` link they were given. */
export function threadIdArg(value: unknown): string | undefined {
	const raw = stringArg(value, 400);
	if (!raw) {
		return undefined;
	}
	const link = /^volt:\/\/session\/([^/?#\s)]+)/i.exec(raw);
	if (link) {
		try {
			return decodeURIComponent(link[1]);
		} catch {
			return link[1];
		}
	}
	return raw;
}

export type ThreadSendMode = 'auto' | 'queue' | 'steer' | 'interrupt';

export function sendModeArg(value: unknown): ThreadSendMode {
	// T3 Code calls it restart.
	return value === 'queue' || value === 'steer' || value === 'interrupt' ? value : value === 'restart' ? 'interrupt' : 'auto';
}

export type ThreadWorkspace =
	| { readonly type: 'root' }
	| { readonly type: 'worktree'; readonly baseRef?: string; readonly branch?: string }
	| { readonly type: 'existing_worktree'; readonly path: string; readonly branch?: string };

/** `workspace` (or T3 Code's `workspaceStrategy`), forgiving about JSON text and camelCase. */
export function parseWorkspace(value: unknown): ThreadWorkspace | { readonly error: string } {
	let raw = value;
	if (typeof raw === 'string') {
		const text = raw.trim();
		if (!text || text === 'root' || text === 'same') {
			return { type: 'root' };
		}
		if (text === 'worktree') {
			return { type: 'worktree' };
		}
		try {
			raw = JSON.parse(text);
		} catch {
			return { error: `workspace must be an object like {"type":"worktree","base_ref":"main"}, not ${JSON.stringify(text.slice(0, 60))}.` };
		}
	}
	if (raw === undefined || raw === null) {
		return { type: 'root' };
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { error: 'workspace must be an object: {"type":"root"|"worktree"|"existing_worktree", ...}.' };
	}
	const record = raw as Record<string, unknown>;
	const type = record.type;
	const branch = stringArg(record.branch, 200);
	if (type === undefined || type === 'root') {
		return { type: 'root' };
	}
	if (type === 'worktree') {
		const baseRef = stringArg(record.base_ref ?? record.baseRef, 200);
		if (branch && !isValidBranchName(branch)) {
			return { error: `"${branch}" is not a valid branch name.` };
		}
		return { type: 'worktree', ...(baseRef ? { baseRef } : {}), ...(branch ? { branch } : {}) };
	}
	if (type === 'existing_worktree') {
		const path = stringArg(record.path ?? record.worktreePath ?? record.worktree_path, 1000);
		if (!path || !(path.startsWith('/') || /^[a-z]:[\\/]/i.test(path))) {
			return { error: 'existing_worktree needs `path`: the worktree\'s absolute path (worktree_list shows them).' };
		}
		return { type: 'existing_worktree', path, ...(branch ? { branch } : {}) };
	}
	return { error: `Unknown workspace type ${JSON.stringify(type)}: use root, worktree or existing_worktree.` };
}

/** `git check-ref-format --branch` rules, enough to refuse a name before git does. */
export function isValidBranchName(name: string): boolean {
	return !!name
		&& name.length <= 200
		&& !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)
		&& !name.startsWith('-')
		&& !name.startsWith('/')
		&& !name.endsWith('/')
		&& !name.endsWith('.')
		&& !name.endsWith('.lock')
		&& !name.includes('..')
		&& !name.includes('//')
		&& !name.includes('@{')
		&& name !== '@';
}

/** A short branch slug from a title: `fix-login-redirect`. */
export function branchSlug(title: string): string {
	return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
}

//#endregion

//#region Status

/** States `thread_wait` stops at: the turn ended, or the chat needs the user. */
export function isSettledStatus(kind: OrchThreadStatusKind): boolean {
	return kind === 'idle' || kind === 'failed' || kind === 'interrupted' || kind === 'paused' || kind === 'needsInput' || kind === 'delegating';
}

export interface IThreadLineInfo {
	readonly id: string;
	readonly title: string;
	readonly status: OrchThreadStatusKind;
	readonly model?: string;
	readonly mode?: string;
	readonly branch?: string;
	readonly updatedAt?: number;
	readonly queued?: number;
	readonly subagents?: number;
	readonly subagent?: boolean;
	readonly archived?: boolean;
	readonly project?: string;
	readonly self?: boolean;
	readonly error?: string;
}

/** `[Fix login redirect](volt://session/agent-1) · working · Claude Opus 5.5 · volt/fix-login · 3m ago · 2 queued` */
export function describeThreadLine(info: IThreadLineInfo, now: number): string {
	const parts = [
		threadLink(info.id, info.title),
		`id ${info.id}`,
		info.status,
		info.model,
		info.mode && info.mode.toLowerCase() !== 'agent' ? `${info.mode.toLowerCase()} mode` : undefined,
		info.branch ? `branch ${info.branch}` : undefined,
		info.project,
		info.updatedAt ? `active ${formatAgo(now - info.updatedAt)}` : undefined,
		info.queued ? `${info.queued} queued` : undefined,
		info.subagents ? `${info.subagents} subagent${info.subagents === 1 ? '' : 's'} running` : undefined,
		info.subagent ? 'subagent' : undefined,
		info.archived ? 'archived' : undefined,
		info.self ? 'this chat' : undefined,
		info.error ? `last error: ${clip(info.error, 160)}` : undefined,
	];
	return `- ${parts.filter(Boolean).join(' · ')}`;
}

export function threadLink(id: string, title: string): string {
	const label = (title || 'Untitled chat').replace(/[[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
	return `[${label}](volt://session/${encodeURIComponent(id)})`;
}

export function formatAgo(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) {
		return `${s}s ago`;
	}
	const m = Math.round(s / 60);
	if (m < 60) {
		return `${m}m ago`;
	}
	const h = Math.round(m / 60);
	if (h < 48) {
		return `${h}h ago`;
	}
	return `${Math.round(h / 24)}d ago`;
}

export function clip(text: string, max: number): string {
	const clean = text.trim();
	return clean.length > max ? `${clean.slice(0, max).trimEnd()} […${(clean.length - max).toLocaleString('en-US')} more chars]` : clean;
}

//#endregion

//#region Transcript

export interface IThreadTurnText {
	readonly user: string;
	readonly reply?: string;
	readonly status?: string;
	readonly at: number;
	/** Not typed by the user: a subagent report, a pull request update, another chat's message. */
	readonly origin?: string;
}

export interface IThreadPage {
	readonly text: string;
	/** The last turn number shown; pass as `after` for the next page. */
	readonly nextAfter?: number;
	readonly shown: number;
}

/**
 * Turns `from..to` (1-based) as text an agent reads: `### Turn 3 · user` then the prompt, then
 * `### Turn 3 · reply`. Messages are clipped at `maxChars` each.
 */
export function formatTurns(turns: readonly IThreadTurnText[], options: { readonly after?: number; readonly turn?: number; readonly limit: number; readonly maxChars: number }): IThreadPage {
	let start: number;
	let end: number;
	if (options.turn !== undefined) {
		start = Math.min(Math.max(1, options.turn), turns.length);
		end = start;
	} else if (options.after !== undefined) {
		start = Math.max(1, options.after + 1);
		end = Math.min(turns.length, start + options.limit - 1);
	} else {
		end = turns.length;
		start = Math.max(1, end - options.limit + 1);
	}
	if (!turns.length || start > turns.length) {
		return { text: turns.length ? `No turns after ${options.after}. The chat has ${turns.length}.` : 'The chat has no messages yet.', shown: 0 };
	}
	const lines: string[] = [];
	if (start > 1 && options.turn === undefined) {
		lines.push(`(Turns 1-${start - 1} not shown: pass after=${Math.max(0, start - 1 - options.limit)} or turn=N to read them.)`);
	}
	for (let index = start; index <= end; index++) {
		const turn = turns[index - 1];
		const who = turn.origin ? `${turn.origin}` : 'user';
		lines.push(`### Turn ${index} · ${who} · ${new Date(turn.at).toISOString()}`, clip(turn.user, options.maxChars) || '(empty)');
		if (turn.reply !== undefined || turn.status) {
			const status = turn.status && turn.status !== 'done' ? ` (${turn.status})` : '';
			lines.push(`### Turn ${index} · reply${status}`, turn.reply?.trim() ? clip(turn.reply, options.maxChars) : '(no text)');
		}
	}
	const nextAfter = end < turns.length ? end : undefined;
	if (nextAfter) {
		lines.push(`(More: call thread_read with after=${nextAfter}.)`);
	}
	return { text: lines.join('\n'), shown: end - start + 1, ...(nextAfter ? { nextAfter } : {}) };
}

//#endregion

//#region Messages between chats

export interface IThreadMessageSource {
	readonly id: string;
	readonly title: string;
	readonly model?: string;
}

/**
 * What the receiving agent reads: who sent it (an agent, not the user), how its reply gets back,
 * and that the user's instructions in its own chat still come first.
 */
export function agentMessagePrompt(from: IThreadMessageSource, message: string): string {
	return [
		`[Volt] Message from another chat's agent: "${from.title}" (thread ${from.id}${from.model ? `, ${from.model}` : ''}). It is an agent, not the user.`,
		'Do what it asks when it fits this chat\'s work and the user\'s instructions; the user\'s instructions win. Answer in your reply as usual: the sender reads it (thread_read / thread_wait). Call thread_send back only if it asks you to.',
		'',
		message.trim(),
	].join('\n');
}

/** The first turn a fork's agent reads: it is a copy, where it came from, and what to do now. */
export function forkPrompt(source: IThreadMessageSource, turns: number, message: string | undefined, worktree: string | undefined): string {
	return [
		`[Volt] This chat is a fork of "${source.title}" (thread ${source.id}): the conversation so far (${turns} turn${turns === 1 ? '' : 's'}) was copied into it. Changes here do not affect the original chat${worktree ? `; you work in your own worktree on branch ${worktree}` : ''}.`,
		'',
		message?.trim() || 'Continue from here.',
	].join('\n');
}

//#endregion

//#region Models and git

/**
 * The connected model an agent named: an exact ref or id, a label ("Claude Opus 5.5"), a label
 * with its qualifier, else the one label or ref that contains it. Undefined when none match.
 */
export function matchCatalogModel(items: readonly IVoltCatalogItem[], value: string): IVoltCatalogItem | undefined {
	const wanted = value.trim().toLowerCase();
	if (!wanted) {
		return undefined;
	}
	// "Opus 5.5 (Claude)" as the lists print it.
	const plain = wanted.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
	const enabled = items.filter(item => item.enabled);
	return enabled.find(item => item.ref.toLowerCase() === wanted)
		?? enabled.find(item => `${item.providerId}:${item.id}`.toLowerCase() === wanted || `${item.profileId}:${item.id}`.toLowerCase() === wanted)
		?? enabled.find(item => item.id.toLowerCase() === wanted)
		?? enabled.find(item => item.label.toLowerCase() === wanted)
		?? enabled.find(item => `${item.label} ${item.qualifier ?? ''}`.trim().toLowerCase() === plain)
		?? enabled.find(item => item.label.toLowerCase().includes(wanted) || item.ref.toLowerCase().includes(wanted));
}

/**
 * The models an agent can pick, one line per provider: `claude-code (agent): claude-opus-5-5 Opus 5.5 · …`.
 * An agent passes `claude-code:claude-opus-5-5` (or the label). A few hundred tokens for dozens of models.
 */
export function describeModelCatalog(items: readonly IVoltCatalogItem[], current: string | undefined): string[] {
	const groups = new Map<string, IVoltCatalogItem[]>();
	for (const item of items.filter(candidate => candidate.enabled)) {
		const key = `${item.providerId}\0${item.kind}`;
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	return [...groups.values()].map(group => {
		const { providerId, kind } = group[0];
		const models = group.map(item => `${item.id}${item.label && item.label.toLowerCase() !== item.id.toLowerCase() ? ` "${item.label}"` : ''}${item.ref === current ? ' (this chat)' : ''}`);
		return `- ${providerId} (${kind === 'agent' ? 'agent harness' : 'model API'}): ${models.join(' · ')}`;
	});
}

export interface IGitWorktreeEntry {
	readonly path: string;
	readonly head?: string;
	/** Short name (`main`), absent when detached. */
	readonly branch?: string;
	readonly detached?: boolean;
	readonly bare?: boolean;
	readonly locked?: boolean;
	readonly prunable?: boolean;
}

/** `git worktree list --porcelain`. */
export function parseWorktreeList(output: string): IGitWorktreeEntry[] {
	const entries: IGitWorktreeEntry[] = [];
	for (const block of output.split(/\n\s*\n/)) {
		let entry: { -readonly [K in keyof IGitWorktreeEntry]?: IGitWorktreeEntry[K] } | undefined;
		for (const line of block.split('\n')) {
			const space = line.indexOf(' ');
			const key = space < 0 ? line.trim() : line.slice(0, space);
			const value = space < 0 ? '' : line.slice(space + 1).trim();
			switch (key) {
				case 'worktree': entry = { path: value }; break;
				case 'HEAD': if (entry) { entry.head = value; } break;
				case 'branch': if (entry) { entry.branch = value.replace(/^refs\/heads\//, ''); } break;
				case 'detached': if (entry) { entry.detached = true; } break;
				case 'bare': if (entry) { entry.bare = true; } break;
				case 'locked': if (entry) { entry.locked = true; } break;
				case 'prunable': if (entry) { entry.prunable = true; } break;
			}
		}
		if (entry?.path) {
			entries.push(entry as IGitWorktreeEntry);
		}
	}
	return entries;
}

export interface IGitBranchStatus {
	readonly branch?: string;
	readonly upstream?: string;
	readonly ahead: number;
	readonly behind: number;
	readonly detached: boolean;
	/** Changed paths (staged, unstaged and untracked), as `XY path`. */
	readonly changes: readonly string[];
}

/** `git status --porcelain=v1 -b`. */
export function parseBranchStatus(output: string): IGitBranchStatus {
	const lines = output.split('\n').filter(line => line.length);
	const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
	let branch: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	let detached = false;
	if (/^HEAD \(no branch\)/.test(head)) {
		detached = true;
	} else if (head) {
		const match = /^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
		branch = match?.[1];
		upstream = match?.[2];
		for (const part of (match?.[3] ?? '').split(',')) {
			const count = /(ahead|behind) (\d+)/.exec(part.trim());
			if (count?.[1] === 'ahead') {
				ahead = Number(count[2]);
			} else if (count?.[1] === 'behind') {
				behind = Number(count[2]);
			}
		}
	}
	return { ...(branch ? { branch } : {}), ...(upstream ? { upstream } : {}), ahead, behind, detached, changes: lines };
}

//#endregion
