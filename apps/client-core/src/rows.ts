/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, firstLine, pluralize } from './format';
import type { IconName } from './icons';
import type { ActivityKind, AgentBlock, AgentMessage, IActivityItem, IAssistantMessage, IPromptAttachment, ITodoStep, IUserMessage } from './types';

export type StepStatus = 'running' | 'done' | 'error';

export type StepBody =
	| { readonly kind: 'command'; readonly command: string; readonly output: string; readonly exitCode?: number }
	| { readonly kind: 'text'; readonly text: string; readonly mono?: boolean }
	| { readonly kind: 'diff'; readonly diff: string };

/** One line of the work log (a read, a search, a command, a tool call). */
export interface IStepItem {
	readonly key: string;
	readonly icon: IconName;
	readonly label: string;
	readonly detail?: string;
	readonly status: StepStatus;
	readonly category: StepCategory;
	readonly body?: StepBody;
}

export type StepCategory = 'read' | 'search' | 'command' | 'edit' | 'web' | 'agent' | 'other';

export type PendingState = 'sending' | 'queued' | 'failed';

export type TranscriptRow =
	| { readonly kind: 'user'; readonly key: string; readonly text: string; readonly chips: readonly string[]; readonly images?: readonly IRowImage[]; readonly turnId?: string; readonly mode?: string; readonly from?: string; readonly pending?: PendingState; readonly steer?: boolean }
	| { readonly kind: 'divider'; readonly key: string; readonly icon: IconName; readonly label: string; readonly detail?: string; readonly live?: boolean }
	| { readonly kind: 'system'; readonly key: string; readonly icon: IconName; readonly title: string; readonly body: string }
	| { readonly kind: 'markdown'; readonly key: string; readonly docKey: string; readonly text: string; readonly streaming: boolean }
	| { readonly kind: 'thought'; readonly key: string; readonly text: string; readonly durationMs?: number; readonly streaming: boolean }
	| { readonly kind: 'steps'; readonly key: string; readonly items: readonly IStepItem[]; readonly live: boolean; readonly summary: string }
	| { readonly kind: 'file'; readonly key: string; readonly path: string; readonly verb: 'Edited' | 'Created' | 'Deleted'; readonly additions?: number; readonly deletions?: number; readonly diff?: string; readonly status: StepStatus }
	| { readonly kind: 'code'; readonly key: string; readonly lang?: string; readonly code: string; readonly path?: string; readonly streaming: boolean }
	| { readonly kind: 'table'; readonly key: string; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly caption?: string }
	| { readonly kind: 'plan'; readonly key: string; readonly docKey: string; readonly title: string; readonly markdown: string; readonly openQuestions?: readonly string[]; readonly streaming: boolean }
	| { readonly kind: 'decision'; readonly key: string; readonly action: string; readonly resource: string; readonly decision?: 'allow' | 'deny'; readonly scope?: 'once' | 'always'; readonly blocked?: boolean }
	| { readonly kind: 'answers'; readonly key: string; readonly outcome: 'answered' | 'skipped' | 'cancelled'; readonly items: readonly { readonly question: string; readonly answer: string }[]; readonly note?: string }
	| { readonly kind: 'notice'; readonly key: string; readonly severity: 'info' | 'warning' | 'error'; readonly title: string; readonly description?: string }
	| { readonly kind: 'error'; readonly key: string; readonly message: string; readonly retryable?: boolean }
	| { readonly kind: 'todos'; readonly key: string; readonly steps: readonly ITodoStep[]; readonly live: boolean }
	| { readonly kind: 'chart'; readonly key: string; readonly title?: string; readonly labels: readonly string[]; readonly values: readonly number[]; readonly unit?: string }
	| { readonly kind: 'cards'; readonly key: string; readonly items: readonly { readonly title: string; readonly body: string; readonly meta?: string }[] }
	| { readonly kind: 'visual'; readonly key: string; readonly title: string; readonly visual: 'chart' | 'html' }
	| { readonly kind: 'working'; readonly key: string; readonly status: string; readonly since?: number }
	| { readonly kind: 'footer'; readonly key: string; readonly copyText: string; readonly durationMs?: number; readonly model?: string; readonly tokens?: number; readonly costUsd?: number; readonly outcome?: 'done' | 'failed' | 'stopped'; readonly turnId?: string };

export type RowKind = TranscriptRow['kind'];

/** An image sent with a prompt: shown from the server's attachment store by its ref. */
export interface IRowImage {
	readonly ref: string;
	readonly mime: string;
	readonly name: string;
}

/** A prompt this client sent that the transcript doesn't show yet. */
export interface IPendingSend {
	readonly turnId: string;
	readonly text: string;
	readonly state: PendingState;
	readonly at: number;
	readonly error?: string;
	readonly attachments?: readonly IPromptAttachment[];
}

//#region Steps

function parseInput(input: string | undefined): Record<string, unknown> | undefined {
	if (!input) {
		return undefined;
	}
	try {
		const value = JSON.parse(input) as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			// Cursor wraps MCP calls as { toolName, args }.
			return record.args && typeof record.args === 'object' ? { ...record, ...(record.args as Record<string, unknown>) } : record;
		}
	} catch {
		// streamed and not complete yet
	}
	return undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function toolCategory(name: string): { readonly icon: IconName; readonly category: StepCategory; readonly verb: string } {
	const n = name.toLowerCase();
	if (/bash|shell|exec|command|terminal|run_|^run$/.test(n)) {
		return { icon: 'terminal', category: 'command', verb: 'Ran' };
	}
	if (/write|edit|patch|str_replace|apply|create_file|insert|multiedit|notebook/.test(n)) {
		return { icon: 'pencil', category: 'edit', verb: 'Edited' };
	}
	if (/read|view|open|cat\b|get_file/.test(n)) {
		return { icon: 'eye', category: 'read', verb: 'Read' };
	}
	if (/grep|search|find|glob|list|ls\b|codebase/.test(n)) {
		return { icon: 'search', category: 'search', verb: 'Searched' };
	}
	if (/web|fetch|browse|http|url|browser/.test(n)) {
		return { icon: 'globe', category: 'web', verb: 'Browsed' };
	}
	if (/task|agent|delegate|subagent|thread_/.test(n)) {
		return { icon: 'agents', category: 'agent', verb: 'Delegated' };
	}
	if (/todo|plan/.test(n)) {
		return { icon: 'listChecks', category: 'other', verb: 'Updated plan' };
	}
	return { icon: 'sparkles', category: 'other', verb: '' };
}

function humanize(name: string): string {
	const clean = name.replace(/^mcp__[^_]+__/, '').replace(/[_-]+/g, ' ').trim();
	return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Tool';
}

function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) {
		return undefined;
	}
	const path = str(input.file_path) ?? str(input.path) ?? str(input.filePath) ?? str(input.target_file) ?? str(input.notebook_path);
	if (path) {
		return basename(path);
	}
	return str(input.command)?.split('\n')[0]
		?? str(input.pattern)
		?? str(input.query)
		?? str(input.url)
		?? str(input.description)
		?? str(input.prompt)?.split('\n')[0];
}

function activityStep(item: IActivityItem, key: string, live: boolean): IStepItem {
	const icons: Record<ActivityKind, IconName> = { thought: 'thought', read: 'eye', search: 'search', note: 'info', wait: 'clock', browser: 'globe' };
	const categories: Record<ActivityKind, StepCategory> = { thought: 'other', read: 'read', search: 'search', note: 'other', wait: 'other', browser: 'web' };
	const lines = item.startLine !== undefined ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}` : '';
	const detail = item.detail ?? (item.path ? `${basename(item.path)}${lines}` : item.files?.length ? pluralize(item.files.length, 'file') : undefined);
	const bodyText = item.error ?? item.result ?? item.text;
	return {
		key,
		icon: icons[item.kind] ?? 'sparkles',
		label: item.label || item.toolTitle || humanize(item.toolName ?? item.kind),
		...(detail ? { detail } : {}),
		status: item.error ? 'error' : live ? 'running' : 'done',
		category: categories[item.kind] ?? 'other',
		...(bodyText ? { body: { kind: 'text', text: bodyText, mono: item.kind !== 'note' } } : item.files?.length ? { body: { kind: 'text', text: item.files.join('\n'), mono: true } } : {}),
	};
}

function blockStatus(status: string): StepStatus {
	return status === 'streaming' ? 'running' : status === 'error' ? 'error' : 'done';
}

function blockStep(block: Extract<AgentBlock, { type: 'tool' } | { type: 'terminal' }>, key: string): IStepItem {
	if (block.type === 'terminal') {
		const failed = block.exitCode !== undefined && block.exitCode !== 0;
		return {
			key,
			icon: 'terminal',
			label: block.status === 'streaming' ? 'Running' : 'Ran',
			detail: firstLine(block.command, 120) || block.title || 'command',
			status: failed ? 'error' : blockStatus(block.status),
			category: 'command',
			body: { kind: 'command', command: block.command, output: block.output, ...(block.exitCode !== undefined ? { exitCode: block.exitCode } : {}) },
		};
	}
	const input = parseInput(block.input);
	const kind = toolCategory(block.name);
	const command = kind.category === 'command' ? str(input?.command) : undefined;
	const title = block.title?.trim();
	const label = kind.verb && (!title || title.toLowerCase() === block.name.toLowerCase()) ? kind.verb : title || humanize(block.name);
	const detail = toolDetail(input);
	let body: StepBody | undefined;
	if (command) {
		body = { kind: 'command', command, output: block.output ?? '' };
	} else if (block.output?.trim()) {
		body = { kind: 'text', text: block.output, mono: true };
	} else if (block.input && !input) {
		body = { kind: 'text', text: block.input, mono: true };
	}
	return {
		key,
		icon: kind.icon,
		label: block.stopped ? `${label} (stopped)` : label,
		...(detail && detail !== label ? { detail } : {}),
		status: blockStatus(block.status),
		category: kind.category,
		...(body ? { body } : {}),
	};
}

/** "Explored 3 files, 2 searches · Ran 2 commands" */
export function summarizeSteps(items: readonly IStepItem[]): string {
	const counts: Record<StepCategory, number> = { read: 0, search: 0, command: 0, edit: 0, web: 0, agent: 0, other: 0 };
	for (const item of items) {
		counts[item.category]++;
	}
	const parts: string[] = [];
	if (counts.read || counts.search) {
		const explored = [counts.read ? pluralize(counts.read, 'file') : '', counts.search ? pluralize(counts.search, 'search', 'searches') : ''].filter(Boolean).join(', ');
		parts.push(`Explored ${explored}`);
	}
	if (counts.command) {
		parts.push(`Ran ${pluralize(counts.command, 'command')}`);
	}
	if (counts.edit) {
		parts.push(`Edited ${pluralize(counts.edit, 'file')}`);
	}
	if (counts.web) {
		parts.push(`Browsed ${pluralize(counts.web, 'page')}`);
	}
	if (counts.agent) {
		parts.push(pluralize(counts.agent, 'subagent'));
	}
	if (counts.other) {
		parts.push(pluralize(counts.other, 'step'));
	}
	return parts.join(' · ') || pluralize(items.length, 'step');
}

//#endregion

//#region Messages

const cache = new WeakMap<object, { readonly index: number; readonly rows: readonly TranscriptRow[] }>();

function userRows(message: IUserMessage, mkey: string): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	if (message.handoff) {
		rows.push({ kind: 'divider', key: `${mkey}:handoff`, icon: 'cpu', label: `Switched to ${message.handoff.toLabel}`, ...(message.handoff.reason ? { detail: message.handoff.reason } : message.handoff.fromLabel ? { detail: `from ${message.handoff.fromLabel}` } : {}) });
	}
	if (message.scheduled) {
		rows.push({ kind: 'divider', key: `${mkey}:scheduled`, icon: 'clock', label: message.scheduled.webhook ? 'Triggered' : 'Scheduled', detail: message.scheduled.title });
	}
	if (message.origin === 'notification') {
		const count = message.taskIds?.length ?? 0;
		rows.push({ kind: 'system', key: mkey, icon: 'agents', title: count ? `${pluralize(count, 'subagent')} reported back` : 'Volt continued this chat', body: message.text });
		return rows;
	}
	if (message.origin === 'brief') {
		rows.push({ kind: 'system', key: mkey, icon: 'listChecks', title: 'Task', body: message.text });
		return rows;
	}
	const images: IRowImage[] = [];
	const labels: string[] = [];
	for (const mention of message.mentions ?? []) {
		const ref = mention.image?.ref;
		if (ref) {
			images.push({ ref, mime: mention.image?.mime ?? 'image/png', name: mention.label ?? mention.image?.name ?? 'image' });
		} else if (mention.label ?? mention.name) {
			labels.push(mention.label ?? mention.name ?? '');
		}
	}
	const chips = message.chips?.length ? message.chips.filter(chip => !images.some(image => image.name === chip)) : labels;
	rows.push({
		kind: 'user',
		key: mkey,
		text: message.text,
		chips,
		...(images.length ? { images } : {}),
		...(message.steer ? { steer: true } : {}),
		...(message.id ? { turnId: message.id } : {}),
		...(message.mode && message.mode !== 'Agent' ? { mode: message.mode } : {}),
		...(message.fromThread ? { from: message.fromThread.title } : {}),
	});
	return rows;
}

function assistantRows(message: IAssistantMessage, mkey: string): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const streaming = !!message.activity?.streaming;
	const segments = message.segments ?? [];
	let steps: IStepItem[] | undefined;
	let stepsKey = '';
	const closeSteps = (live: boolean) => {
		if (steps?.length) {
			rows.push({ kind: 'steps', key: stepsKey, items: steps, live, summary: summarizeSteps(steps) });
		}
		steps = undefined;
	};
	const addStep = (step: IStepItem, key: string) => {
		if (!steps) {
			steps = [];
			stepsKey = `${key}:steps`;
		}
		steps.push(step);
	};
	const copy: string[] = [];

	segments.forEach((segment, index) => {
		const key = `${mkey}:${index}`;
		const last = index === segments.length - 1;
		switch (segment.kind) {
			case 'text': {
				if (!segment.text.trim()) {
					return;
				}
				closeSteps(false);
				copy.push(segment.text);
				rows.push({ kind: 'markdown', key, docKey: key, text: segment.text, streaming: streaming && last });
				return;
			}
			case 'thought': {
				if (!segment.text.trim()) {
					return;
				}
				closeSteps(false);
				const durationMs = segment.startedAt && segment.updatedAt ? segment.updatedAt - segment.startedAt : undefined;
				rows.push({ kind: 'thought', key, text: segment.text, ...(durationMs ? { durationMs } : {}), streaming: streaming && last });
				return;
			}
			case 'activity': {
				const item = segment.item;
				if (item.hidden) {
					return;
				}
				if (item.kind === 'thought') {
					if (item.text?.trim()) {
						closeSteps(false);
						rows.push({ kind: 'thought', key, text: item.text, streaming: streaming && last });
					}
					return;
				}
				addStep(activityStep(item, key, streaming && last), key);
				return;
			}
			case 'notice': {
				closeSteps(false);
				rows.push({ kind: 'notice', key, severity: segment.severity, title: segment.title, ...(segment.description ? { description: segment.description } : {}) });
				return;
			}
			case 'compaction': {
				closeSteps(false);
				const c = segment.compaction;
				const running = c.status === 'running';
				const detail = c.preTokens && c.postTokens ? `${Math.round(c.preTokens / 1000)}k → ${Math.round(c.postTokens / 1000)}k tokens` : c.error;
				rows.push({ kind: 'divider', key, icon: 'minimize', label: running ? 'Compacting context…' : c.status === 'failed' ? 'Compaction failed' : 'Context compacted', ...(detail ? { detail } : {}), live: running });
				return;
			}
			case 'block': {
				const block = segment.block;
				switch (block.type) {
					case 'tool':
					case 'terminal':
						addStep(blockStep(block, key), key);
						return;
					case 'markdown':
						if (block.content.trim()) {
							closeSteps(false);
							copy.push(block.content);
							rows.push({ kind: 'markdown', key, docKey: key, text: block.content, streaming: block.status === 'streaming' });
						}
						return;
					case 'list':
						closeSteps(false);
						rows.push({ kind: 'markdown', key, docKey: key, text: block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${item}`).join('\n'), streaming: false });
						return;
					case 'code':
						closeSteps(false);
						rows.push({ kind: 'code', key, ...(block.language ? { lang: block.language } : {}), code: block.code, ...(block.path ? { path: block.path } : {}), streaming: block.status === 'streaming' });
						return;
					case 'mermaid':
						closeSteps(false);
						rows.push({ kind: 'code', key, lang: 'mermaid', code: block.source, streaming: block.status === 'streaming' });
						return;
					case 'file':
						closeSteps(false);
						rows.push({
							kind: 'file', key, path: block.path, verb: block.verb,
							...(block.additions !== undefined ? { additions: block.additions } : {}),
							...(block.deletions !== undefined ? { deletions: block.deletions } : {}),
							...(block.unifiedDiff ? { diff: block.unifiedDiff } : {}),
							status: blockStatus(block.status),
						});
						return;
					case 'table':
						closeSteps(false);
						rows.push({ kind: 'table', key, headers: block.headers, rows: block.rows, ...(block.caption ? { caption: block.caption } : {}) });
						return;
					case 'plan':
						closeSteps(false);
						rows.push({ kind: 'plan', key, docKey: key, title: block.name || 'Plan', markdown: block.markdown, ...(block.openQuestions?.length ? { openQuestions: block.openQuestions } : {}), streaming: block.status === 'streaming' });
						return;
					case 'approval':
						closeSteps(false);
						rows.push({ kind: 'decision', key, action: block.action, resource: block.resource, ...(block.decision ? { decision: block.decision } : {}), ...(block.scope ? { scope: block.scope } : {}), ...(block.blocked ? { blocked: true } : {}) });
						return;
					case 'answers':
						closeSteps(false);
						rows.push({ kind: 'answers', key, outcome: block.outcome, items: block.items, ...(block.note ? { note: block.note } : {}) });
						return;
					case 'error':
						closeSteps(false);
						rows.push({ kind: 'error', key, message: block.message });
						return;
					case 'chart':
						closeSteps(false);
						rows.push({ kind: 'chart', key, ...(block.title ? { title: block.title } : {}), labels: block.labels, values: block.values, ...(block.unit ? { unit: block.unit } : {}) });
						return;
					case 'cards':
						closeSteps(false);
						rows.push({ kind: 'cards', key, items: block.items });
						return;
					case 'visual':
						closeSteps(false);
						rows.push({ kind: 'visual', key, title: block.title, visual: block.kind });
						return;
				}
			}
		}
	});
	closeSteps(streaming);

	if (message.steps?.length) {
		rows.push({ kind: 'todos', key: `${mkey}:todos`, steps: message.steps, live: streaming });
	}
	if (message.failure?.message && !streaming) {
		rows.push({ kind: 'error', key: `${mkey}:failure`, message: message.failure.message, ...(message.failure.retryable ? { retryable: true } : {}) });
	}
	if (streaming) {
		rows.push({ kind: 'working', key: `${mkey}:working`, status: message.activity?.status || 'Thinking', ...(message.startedAt ? { since: message.startedAt } : {}) });
	} else if (copy.length || message.durationMs || message.outcome) {
		const tokens = (message.tokensIn ?? 0) + (message.tokensOut ?? 0);
		rows.push({
			kind: 'footer',
			key: `${mkey}:footer`,
			copyText: copy.join('\n\n'),
			...(message.durationMs ?? (message.endedAt && message.startedAt ? message.endedAt - message.startedAt : undefined) ? { durationMs: message.durationMs ?? (message.endedAt! - message.startedAt!) } : {}),
			...(message.model?.label ? { model: message.model.label } : {}),
			...(tokens ? { tokens } : {}),
			...(message.costUsd ? { costUsd: message.costUsd } : {}),
			...(message.cancelled ? { outcome: 'stopped' as const } : message.outcome ? { outcome: message.outcome } : {}),
			...(message.id ? { turnId: message.id } : {}),
		});
	}
	return rows;
}

/**
 * The rows a transcript draws, oldest first. Rows of a message are cached by the message object,
 * so a patch that changed one message rebuilds only that message's rows. Prompts this client sent
 * that the transcript doesn't show yet follow as pending bubbles.
 */
export function buildRows(messages: readonly AgentMessage[], pending: readonly IPendingSend[] = []): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const shown = new Set<string>();
	messages.forEach((message, index) => {
		if (message.kind === 'user' && message.id) {
			shown.add(message.id);
		}
		const hit = cache.get(message);
		if (hit && hit.index === index) {
			rows.push(...hit.rows);
			return;
		}
		const mkey = `${message.kind === 'user' ? 'u' : 'a'}:${message.id ?? `i${index}`}`;
		const built = message.kind === 'user' ? userRows(message, mkey) : assistantRows(message, mkey);
		cache.set(message, { index, rows: built });
		rows.push(...built);
	});
	for (const send of pending) {
		if (!shown.has(send.turnId)) {
			const images = send.attachments?.map(a => ({ ref: a.ref, mime: a.mime, name: a.name }));
			rows.push({ kind: 'user', key: `p:${send.turnId}`, text: send.text, chips: [], ...(images?.length ? { images } : {}), turnId: send.turnId, pending: send.state });
		}
	}
	return rows;
}

/** Whether the transcript's last reply is still being written. */
export function isStreaming(messages: readonly AgentMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last?.kind === 'agent' && !!last.activity?.streaming;
}

/** The text a reply's "Copy" puts on the clipboard. */
export function messageText(message: AgentMessage): string {
	if (message.kind === 'user') {
		return message.text;
	}
	return message.segments.filter(s => s.kind === 'text').map(s => (s as { text: string }).text).join('\n\n');
}

//#endregion
