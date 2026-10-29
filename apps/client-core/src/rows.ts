/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { diffText, type IFileDiff } from './diff';
import { basename, firstLine, pluralize } from './format';
import type { IconName } from './icons';
import type { ToolDensity } from './prefs';
import { humanTerminalTitle, terminalCommandLabels } from './shell';
import type { ActivityKind, AgentBlock, AgentMessage, AgentSegment, IActivityItem, IAssistantMessage, ICompaction, IPromptAttachment, ITodoStep, IUserMessage } from './types';

/**
 * The desktop's transcript model (voltAgent/browser/chrome/agentTranscript.ts): between two
 * pieces of reply text, tool calls and thoughts fold into one group line ("Explored 5 files,
 * 3 searches"); each edit is a card of its own with a peek of its diff; subagents get their own
 * rows; a finished turn folds its work behind "Worked for 3m 3s" and keeps its answer in view.
 */

export type StepStatus = 'running' | 'done' | 'error';

export type StepBody =
	| { readonly kind: 'command'; readonly command: string; readonly output: string; readonly exitCode?: number }
	| { readonly kind: 'text'; readonly text: string; readonly mono?: boolean }
	| { readonly kind: 'thought'; readonly text: string }
	| { readonly kind: 'diff'; readonly diff: string; readonly path?: string };

/** What a step is, as the desktop sorts them for its group line. */
export type StepKind = 'thought' | 'read' | 'search' | 'browser' | 'wait' | 'note' | 'run' | 'edit' | 'tool';

/** One line of the work log (a read, a search, a command, a tool call, a thought). */
export interface IStepItem {
	readonly key: string;
	readonly kind: StepKind;
	readonly icon: IconName;
	/** The verb, in the tertiary tone: "Read", "Ran", "Edited", "Thought". Live steps read "Reading", "Running". */
	readonly label: string;
	/** The rest of the line, in the quaternary tone. */
	readonly detail?: string;
	/** A command's program names after its title ("Ran Run tests npm"), quieter still. */
	readonly command?: string;
	readonly status: StepStatus;
	readonly category: StepCategory;
	readonly body?: StepBody;
	/** An edit's line counts. */
	readonly additions?: number;
	readonly deletions?: number;
	/** A command that ended with a non-zero exit code. */
	readonly exitCode?: number;
}

/**
 * How a steps row draws its calls ({@link applyToolDensity}): `group` folds them behind the
 * group line, `lines` lists one line per call, `cards` draws calls with a body as open cards.
 */
export type StepsDisplay = 'group' | 'lines' | 'cards';

export type StepCategory = 'read' | 'search' | 'command' | 'edit' | 'web' | 'agent' | 'thought' | 'other';

export type PendingState = 'sending' | 'queued' | 'failed';

/** A subagent the agent started: its task, its kind, the step it is on, its report once done. */
export interface ISubagentItem {
	readonly key: string;
	readonly title: string;
	readonly type?: string;
	readonly state: 'running' | 'completed' | 'failed' | 'stopped';
	/** The step it is on while it runs; Completed, Failed or Stopped after. */
	readonly status: string;
	/** Progress reports so far, while it runs. */
	readonly steps: number;
	readonly output?: string;
}

/** A file one turn changed, for the card at its end. */
export interface ITurnFile {
	readonly path: string;
	readonly verb: 'Edited' | 'Created' | 'Deleted';
	readonly additions: number;
	readonly deletions: number;
}

export type TranscriptRow =
	| { readonly kind: 'user'; readonly key: string; readonly text: string; readonly chips: readonly string[]; readonly images?: readonly IRowImage[]; readonly turnId?: string; readonly mode?: string; readonly from?: string; readonly pending?: PendingState; readonly steer?: boolean; readonly running?: boolean }
	| { readonly kind: 'divider'; readonly key: string; readonly icon: IconName; readonly label: string; readonly detail?: string; readonly live?: boolean }
	| { readonly kind: 'system'; readonly key: string; readonly icon: IconName; readonly title: string; readonly body: string }
	| { readonly kind: 'markdown'; readonly key: string; readonly docKey: string; readonly text: string; readonly streaming: boolean }
	| { readonly kind: 'thought'; readonly key: string; readonly text: string; readonly durationMs?: number; readonly streaming: boolean }
	| { readonly kind: 'steps'; readonly key: string; readonly items: readonly IStepItem[]; readonly live: boolean; readonly summary: string; readonly action: string; readonly detail: string; readonly additions: number; readonly deletions: number; readonly display?: StepsDisplay }
	| { readonly kind: 'file'; readonly key: string; readonly path: string; readonly verb: 'Edited' | 'Created' | 'Deleted'; readonly additions?: number; readonly deletions?: number; readonly diff?: string; readonly status: StepStatus }
	| { readonly kind: 'subagents'; readonly key: string; readonly items: readonly ISubagentItem[]; readonly live: boolean }
	| { readonly kind: 'compaction'; readonly key: string; readonly status: ICompaction['status']; readonly detail?: string; readonly summary?: string }
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
	/** The live line under a running reply: "Thinking · 12s". */
	| { readonly kind: 'working'; readonly key: string; readonly status: string; readonly since?: number }
	/** "Worked for 3m 3s": the fold over a finished turn's work; `turnKey` names it for {@link buildRows}' `openWorked`. */
	| { readonly kind: 'worked'; readonly key: string; readonly turnKey: string; readonly durationMs: number; readonly open: boolean }
	/** The files a finished turn changed, with Review. */
	| { readonly kind: 'turnFiles'; readonly key: string; readonly turnId?: string; readonly files: readonly ITurnFile[] }
	| { readonly kind: 'footer'; readonly key: string; readonly copyText: string; readonly durationMs?: number; readonly model?: string; readonly tokens?: number; readonly costUsd?: number; readonly outcome?: 'done' | 'failed' | 'stopped'; readonly turnId?: string; readonly filesChanged?: number; readonly tokensUsed?: number; readonly tokensWindow?: number; readonly endedAt?: number };

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
	// Some agents stream arguments as successive snapshots ("{}{"title":…}"): the last one is whole.
	for (const candidate of [input, input.slice(input.lastIndexOf('}{') + 1)]) {
		try {
			const value = JSON.parse(candidate) as unknown;
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				const record = value as Record<string, unknown>;
				// Cursor wraps MCP calls as { toolName, args }.
				return record.args && typeof record.args === 'object' ? { ...record, ...(record.args as Record<string, unknown>) } : record;
			}
		} catch {
			// streamed and not complete yet
		}
	}
	return undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

const SUBAGENT_RE = /^(task|agent|subagent|delegate|run_agent|spawn_agent)$/i;
const EXPLORE_TOOL_RE = /\b(find|glob|grep|rg|search|list.?dir|\bls\b|read.?file|\bread\b|cat|view|open.?file|sleep|wait|webfetch|web fetch|browser|navigate|snapshot|simplebrowser)\b/;
const MUTATING_TOOL_RE = /\b(edit|edited|write|wrote|create|created|delete|deleted|patch|apply|replace|str.?replace|update)\b/;

function toolName(name: string): string {
	return name.replace(/^mcp__[^_]+__/, '').replace(/^mcp[:_\s]+[\w.-]+[:_\s-]+/i, '');
}

/** A harness's Task call or Volt's delegate_task: a subagent row, not a step. */
export function isSubagentCall(name: string, title?: string): boolean {
	const bare = toolName(name);
	return SUBAGENT_RE.test(bare) || /^(task|subagent)\b/i.test(title ?? '') || /^(delegate_task|spawn_subagent|start_subagent)$/i.test(bare);
}

/** Read, search and browser tools: the activity items beside them already draw them. */
function isExploreCall(name: string, title?: string): boolean {
	const s = `${toolName(name)} ${title ?? ''}`.toLowerCase().replace(/[_-]+/g, ' ');
	return !MUTATING_TOOL_RE.test(s) && EXPLORE_TOOL_RE.test(s);
}

function humanize(name: string): string {
	const clean = toolName(name).replace(/[_-]+/g, ' ').trim();
	return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Tool';
}

const ACTIVITY: Record<ActivityKind, { readonly icon: IconName; readonly kind: StepKind; readonly category: StepCategory }> = {
	thought: { icon: 'thought', kind: 'thought', category: 'thought' },
	read: { icon: 'eye', kind: 'read', category: 'read' },
	// Web search and fetch count with searches, as the desktop counts them.
	search: { icon: 'search', kind: 'search', category: 'search' },
	browser: { icon: 'globe', kind: 'search', category: 'search' },
	note: { icon: 'info', kind: 'note', category: 'other' },
	wait: { icon: 'clock', kind: 'wait', category: 'other' },
};

function activityStep(item: IActivityItem, key: string): IStepItem {
	const shape = ACTIVITY[item.kind] ?? ACTIVITY.note;
	const lines = item.startLine !== undefined ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}` : '';
	const detail = (item.detail ?? (item.path ? `${basename(item.path)}${lines}` : item.files?.length ? pluralize(item.files.length, 'file') : undefined))
		// Older chats derived a bogus " in <scope>" from half-streamed glob input.
		?.replace(/\s+in\s+\S*[*?{}"'][^\s]*$/, '');
	const bodyText = item.error ?? item.result;
	const pending = item.result === undefined && item.error === undefined && (item.kind === 'read' || item.kind === 'search' || item.kind === 'browser');
	return {
		key,
		kind: shape.kind,
		icon: shape.icon,
		label: item.label || item.toolTitle || humanize(item.toolName ?? item.kind),
		...(detail ? { detail } : {}),
		status: item.error ? 'error' : pending ? 'running' : 'done',
		category: shape.category,
		...(bodyText ? { body: { kind: 'text', text: bodyText, mono: item.kind !== 'note' } } : item.files?.length ? { body: { kind: 'text', text: item.files.join('\n'), mono: true } } : {}),
	};
}

function blockStatus(status: string): StepStatus {
	return status === 'streaming' ? 'running' : status === 'error' ? 'error' : 'done';
}

function terminalStep(block: Extract<AgentBlock, { type: 'terminal' }>, key: string): IStepItem {
	const failed = block.status !== 'streaming' && ((block.exitCode !== undefined && block.exitCode !== 0) || block.status === 'error');
	const title = humanTerminalTitle(block.title, block.command);
	const labels = terminalCommandLabels(block.command).join(', ');
	return {
		key,
		kind: 'run',
		icon: 'terminal',
		label: 'Ran',
		detail: title,
		...(labels && !title.toLowerCase().includes(labels.toLowerCase()) ? { command: labels } : {}),
		status: failed ? 'error' : blockStatus(block.status),
		category: 'command',
		...(failed ? { exitCode: block.exitCode ?? 1 } : {}),
		body: { kind: 'command', command: block.command, output: block.output, ...(block.exitCode !== undefined ? { exitCode: block.exitCode } : {}) },
	};
}

function toolStep(block: Extract<AgentBlock, { type: 'tool' }>, key: string): IStepItem {
	const input = parseInput(block.input);
	const name = toolName(block.name);
	const command = /bash|shell|exec|command|terminal|^run$/i.test(name) ? str(input?.command) : undefined;
	if (command) {
		return terminalStep({ type: 'terminal', id: block.id, status: block.status, command, output: block.output ?? '', ...(block.title ? { title: block.title } : {}) }, key);
	}
	const raw = (block.title || block.name).trim();
	const titled = !!block.title?.trim() && block.title.trim().toLowerCase() !== block.name.toLowerCase() && !/^mcp__/.test(block.title);
	const mcp = /^(?:mcp[:_\s]+)?([\w.-]+?)(?:__|[:\s])(\w+)$/i.exec(raw);
	const label = titled ? block.title!.trim() : 'Called';
	const detail = titled ? undefined : mcp ? mcp[2] : humanize(block.name);
	let body: StepBody | undefined;
	if (block.output?.trim()) {
		body = { kind: 'text', text: block.output, mono: true };
	} else if (block.input?.trim() && block.input.trim() !== '{}') {
		body = { kind: 'text', text: input ? JSON.stringify(input, null, 2) : block.input, mono: true };
	}
	return {
		key,
		kind: 'tool',
		icon: /todo|plan/i.test(name) ? 'listChecks' : 'sparkles',
		label: block.stopped ? `${label} (stopped)` : label,
		...(detail ? { detail } : {}),
		status: blockStatus(block.status),
		category: 'other',
		...(body ? { body } : {}),
	};
}

function thoughtStep(key: string, text: string, ms: number | undefined): IStepItem {
	return { key, kind: 'thought', icon: 'thought', label: 'Thought', detail: formatThoughtDuration(ms), status: 'done', category: 'thought', ...(text.trim() ? { body: { kind: 'thought', text } } : {}) };
}

function thoughtMs(step: IStepItem): number | undefined {
	const match = /^(\d+)s$/.exec(step.detail ?? '');
	return match ? Number(match[1]) * 1000 : undefined;
}

function thoughtText(step: IStepItem): string {
	return step.body?.kind === 'thought' ? step.body.text : '';
}

/** "4s" after a second of streamed reasoning, otherwise "briefly" (Cursor). */
export function formatThoughtDuration(ms: number | undefined): string {
	return ms === undefined || ms < 1000 ? 'briefly' : `${Math.round(ms / 1000)}s`;
}

/** "3m 3s", "12s", "1h 4m": a finished turn's time, for "Worked for". */
export function formatWorkedTime(ms: number): string {
	const total = Math.max(1, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

const LIVE_VERBS: Partial<Record<StepKind, string>> = { run: 'Running', edit: 'Editing', read: 'Reading', search: 'Searching', thought: 'Thinking' };

/** The verb a running step reads with ("Running", "Reading"); others keep theirs. */
export function liveVerb(step: IStepItem): string {
	return LIVE_VERBS[step.kind] ?? step.label;
}

function countList(entries: ReadonlyArray<readonly [number, string, string]>): string {
	return entries.filter(([count]) => count > 0).map(([count, one, many]) => count === 1 ? one : many).join(', ');
}

/**
 * The group line, as the desktop writes it. Edits lead ("Edited stats.js, explored 1 file, ran
 * 2 commands"), then exploration ("Explored 5 files, 3 searches"), then commands ("Ran 2
 * commands"). A thoughts-only group reads "Thought 6s". Live groups read "Exploring", "Running".
 */
export function stepsTitle(items: readonly IStepItem[], live: boolean): { readonly action: string; readonly detail: string; readonly additions: number; readonly deletions: number } {
	const edited = new Set<string>();
	let reads = 0, searches = 0, browsers = 0, commands = 0, additions = 0, deletions = 0;
	for (const step of items) {
		switch (step.kind) {
			case 'edit':
				edited.add(step.detail ?? step.key);
				additions += step.additions ?? 0;
				deletions += step.deletions ?? 0;
				break;
			case 'read': reads++; break;
			case 'search': searches++; break;
			case 'browser': browsers++; break;
			case 'run': commands++; break;
		}
	}
	const explore = countList([[reads, '1 file', `${reads} files`], [searches, '1 search', `${searches} searches`], [browsers, '1 browser action', `${browsers} browser actions`]]);
	const ran = commands ? (commands === 1 ? 'ran 1 command' : `ran ${commands} commands`) : '';
	if (edited.size) {
		const first = edited.size === 1 ? [...edited][0] : `${edited.size} files`;
		return { action: live ? 'Editing' : 'Edited', detail: [first, explore ? `explored ${explore}` : '', ran].filter(Boolean).join(', '), additions, deletions };
	}
	if (reads || searches) {
		return { action: live ? 'Exploring' : 'Explored', detail: [explore, ran].filter(Boolean).join(', '), additions, deletions };
	}
	if (commands || browsers) {
		return { action: live ? 'Running' : 'Ran', detail: countList([[commands, '1 command', `${commands} commands`], [browsers, '1 browser action', `${browsers} browser actions`]]), additions, deletions };
	}
	if (items.length && items.every(step => step.kind === 'thought')) {
		const ms = items.reduce<number | undefined>((sum, step) => {
			const each = thoughtMs(step);
			return sum === undefined && each === undefined ? undefined : (sum ?? 0) + (each ?? 0);
		}, undefined);
		return { action: live ? 'Thinking' : 'Thought', detail: live ? '' : formatThoughtDuration(ms), additions, deletions };
	}
	const lead = items.find(step => step.kind !== 'thought') ?? items[0];
	return { action: lead ? (live && lead.status === 'running' ? liveVerb(lead) : lead.label) : 'Worked', detail: lead?.detail ?? '', additions, deletions };
}

/** The group line as one string ("Explored 3 files, 2 searches"). */
export function summarizeSteps(items: readonly IStepItem[], live = false): string {
	const title = stepsTitle(items, live);
	return title.detail ? `${title.action} ${title.detail}` : title.action;
}

type StepsRow = Extract<TranscriptRow, { kind: 'steps' }>;

function stepsRow(key: string, items: readonly IStepItem[], live: boolean, display?: StepsDisplay): StepsRow {
	const title = stepsTitle(items, live);
	return { kind: 'steps', key, items, live, summary: title.detail ? `${title.action} ${title.detail}` : title.action, ...title, ...(display ? { display } : {}) };
}

/** Rows {@link applyToolDensity} made, by their source row: the same source gives back the same row. */
const densityCache = new WeakMap<TranscriptRow, { readonly density: ToolDensity; readonly row: TranscriptRow }>();

/**
 * Applies the tool call density. Compact folds each stretch of tool work behind its group line,
 * standard lists a line per call, detailed draws calls with output as open cards. Edits keep
 * their own cards in every density (detailed opens them on their diff).
 */
export function applyToolDensity(rows: readonly TranscriptRow[], density: ToolDensity): TranscriptRow[] {
	if (density === 'compact') {
		return rows as TranscriptRow[];
	}
	const display: StepsDisplay = density === 'standard' ? 'lines' : 'cards';
	return rows.map(row => {
		if (row.kind !== 'steps') {
			return row;
		}
		const hit = densityCache.get(row);
		if (hit?.density === density) {
			return hit.row;
		}
		const next: TranscriptRow = { ...row, display };
		densityCache.set(row, { density, row: next });
		return next;
	});
}

//#endregion

//#region Diffs

const diffCache = new WeakMap<object, { readonly diff?: string; readonly additions?: number; readonly deletions?: number }>();

/** A unified diff from parsed hunks (what the transcript's diff views read). */
export function formatUnifiedDiff(file: IFileDiff, path?: string): string {
	const out: string[] = [];
	if (path) {
		out.push(`--- a/${path}`, `+++ b/${path}`);
	}
	for (const hunk of file.hunks) {
		out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ` ${hunk.header}` : ''}`);
		for (const line of hunk.lines) {
			out.push(`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`);
		}
	}
	return out.join('\n');
}

/** An edit's diff and counts: its own unified diff, or one made from its before and after text. */
function fileDiff(block: Extract<AgentBlock, { type: 'file' }>): { readonly diff?: string; readonly additions?: number; readonly deletions?: number } {
	if (block.unifiedDiff) {
		if (block.additions !== undefined || block.deletions !== undefined) {
			return { diff: block.unifiedDiff, additions: block.additions, deletions: block.deletions };
		}
		let adds = 0, dels = 0;
		for (const line of block.unifiedDiff.split('\n')) {
			if (line.startsWith('+') && !line.startsWith('+++')) {
				adds++;
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				dels++;
			}
		}
		return { diff: block.unifiedDiff, additions: adds, deletions: dels };
	}
	if (block.original === undefined && block.modified === undefined) {
		return { additions: block.additions, deletions: block.deletions };
	}
	const hit = diffCache.get(block);
	if (hit) {
		return hit;
	}
	const before = block.verb === 'Created' ? '' : block.original ?? '';
	const after = block.verb === 'Deleted' ? '' : block.modified ?? '';
	const parsed = before.length + after.length > 400_000 ? undefined : diffText(before, after);
	const result = parsed ? { diff: formatUnifiedDiff(parsed), additions: parsed.additions, deletions: parsed.deletions } : { additions: block.additions, deletions: block.deletions };
	if (block.status !== 'streaming') {
		diffCache.set(block, result);
	}
	return result;
}

//#endregion

//#region Messages

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

const SUBAGENT_TYPES: Record<string, string> = { explore: 'Explorer', generalPurpose: 'General', 'general-purpose': 'General', plan: 'Planner' };

function subagentItem(block: Extract<AgentBlock, { type: 'tool' }>, live: boolean): ISubagentItem {
	const input = parseInput(block.input);
	const title = str(input?.description) ?? str(input?.title) ?? block.title?.replace(/^task:\s*/i, '') ?? humanize(block.name);
	const type = str(input?.subagent_type) ?? str(input?.subagentType);
	const lines = (block.output ?? '').split('\n').map(line => line.trim()).filter(Boolean);
	const state = live ? 'running' : block.stopped ? 'stopped' : block.status === 'error' ? 'failed' : 'completed';
	return {
		key: block.callId || block.id,
		title: firstLine(title, 160),
		...(type ? { type: SUBAGENT_TYPES[type] ?? type.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) } : {}),
		state,
		status: live ? lines.at(-1) ?? 'Working' : state === 'stopped' ? 'Stopped' : state === 'failed' ? 'Failed' : 'Completed',
		steps: live ? lines.length : 0,
		...(!live && block.output?.trim() ? { output: block.output.trim() } : {}),
	};
}

/** A message's rows: its body (work and answer, split for "Worked for") and the rows after it. */
interface IMessageRows {
	readonly index: number;
	readonly lead: readonly TranscriptRow[];
	readonly work: readonly TranscriptRow[];
	readonly answer: readonly TranscriptRow[];
	readonly tail: readonly TranscriptRow[];
	readonly turnKey: string;
	readonly workedMs?: number;
}

/** Rows that read as the turn's answer: they stay in view under a closed "Worked for". */
function isAnswerRow(row: TranscriptRow): boolean {
	return row.kind === 'markdown' || row.kind === 'code' || row.kind === 'table' || row.kind === 'plan' || row.kind === 'chart'
		|| row.kind === 'cards' || row.kind === 'visual' || row.kind === 'answers' || row.kind === 'error';
}

function isWorkRow(row: TranscriptRow): boolean {
	return row.kind === 'steps' || row.kind === 'subagents' || row.kind === 'file' || row.kind === 'thought';
}

function assistantRows(message: IAssistantMessage, mkey: string, index: number): IMessageRows {
	const body: TranscriptRow[] = [];
	const streaming = !!message.activity?.streaming;
	const segments = message.segments ?? [];
	let pending: IStepItem[] = [];
	let pendingKey = '';
	const copy: string[] = [];
	const flushSteps = () => {
		if (!pending.length) {
			return;
		}
		if (pending.every(step => step.kind === 'thought')) {
			// Reasoning straight before an answer is its own "Thought 4s" row.
			const text = pending.map(thoughtText).filter(Boolean).join('\n\n');
			const ms = stepsTitle(pending, false).detail;
			const match = /^(\d+)s$/.exec(ms);
			body.push({ kind: 'thought', key: pendingKey, text, ...(match ? { durationMs: Number(match[1]) * 1000 } : {}), streaming: false });
		} else {
			body.push(stepsRow(pendingKey, pending, false));
		}
		pending = [];
	};
	const addStep = (step: IStepItem) => {
		if (!pending.length) {
			pendingKey = `${step.key}:steps`;
		}
		pending.push(step);
	};
	const addThought = (key: string, text: string, ms: number | undefined) => {
		const last = pending.at(-1);
		if (last?.kind === 'thought') {
			const prev = thoughtMs(last);
			const sum = prev === undefined && ms === undefined ? undefined : (prev ?? 0) + (ms ?? 0);
			const joined = [thoughtText(last), text].filter(Boolean).join('\n');
			pending[pending.length - 1] = thoughtStep(last.key, joined, sum);
		} else {
			addStep(thoughtStep(key, text, ms));
		}
	};
	// A subagent call is drawn once, as its subagent row; the step its activity would add goes.
	const subagentCalls = new Set(segments.flatMap(s => s.kind === 'block' && s.block.type === 'tool' && isSubagentCall(s.block.name, s.block.title) ? [s.block.callId] : []));
	const activityCalls = new Set(segments.flatMap(s => s.kind === 'activity' && s.item.callId ? [s.item.callId] : []));
	let subagents: ISubagentItem[] = [];
	let subagentsKey = '';
	const flushSubagents = () => {
		if (subagents.length) {
			body.push({ kind: 'subagents', key: subagentsKey, items: subagents, live: subagents.some(item => item.state === 'running') });
			subagents = [];
		}
	};

	segments.forEach((segment, i) => {
		const key = `${mkey}:${i}`;
		if (segment.kind !== 'block' || segment.block.type !== 'tool' || !isSubagentCall(segment.block.name, segment.block.title)) {
			flushSubagents();
		}
		switch (segment.kind) {
			case 'text': {
				if (!segment.text.trim()) {
					return;
				}
				flushSteps();
				copy.push(segment.text);
				body.push({ kind: 'markdown', key, docKey: key, text: segment.text, streaming: streaming && i === segments.length - 1 });
				return;
			}
			case 'thought': {
				if (!segment.text.trim()) {
					return;
				}
				const ms = segment.startedAt !== undefined ? Math.max(0, (segment.updatedAt ?? segment.startedAt) - segment.startedAt) : undefined;
				addThought(key, segment.text, ms);
				return;
			}
			case 'activity': {
				const item = segment.item;
				if (item.hidden || (item.callId && subagentCalls.has(item.callId))) {
					return;
				}
				if (item.kind === 'thought') {
					if (item.text?.trim()) {
						addThought(key, item.text, undefined);
					}
					return;
				}
				addStep(activityStep(item, key));
				return;
			}
			case 'notice': {
				// Retries moved to the status line; older chats kept them as notices.
				if (/^retrying\b/i.test(segment.title)) {
					return;
				}
				flushSteps();
				body.push({ kind: 'notice', key, severity: segment.severity, title: segment.title, ...(segment.description ? { description: segment.description } : {}) });
				return;
			}
			case 'compaction': {
				flushSteps();
				const c = segment.compaction;
				const detail = c.preTokens && c.postTokens ? `${Math.round(c.preTokens / 1000)}k → ${Math.round(c.postTokens / 1000)}k tokens` : c.error;
				body.push({ kind: 'compaction', key, status: c.status, ...(detail ? { detail } : {}), ...(c.summary ? { summary: c.summary } : {}) });
				return;
			}
			case 'block': {
				const block = segment.block;
				switch (block.type) {
					case 'terminal':
						addStep(terminalStep(block, key));
						return;
					case 'tool':
						if (isSubagentCall(block.name, block.title)) {
							flushSteps();
							if (!subagents.length) {
								subagentsKey = key;
							}
							// A finished reply's call that never reported its end ended with the turn.
							subagents.push(subagentItem(block, streaming && block.status === 'streaming'));
							return;
						}
						if (activityCalls.has(block.callId) || isExploreCall(block.name, block.title)) {
							return;
						}
						addStep(toolStep(block, key));
						return;
					case 'file': {
						// Older chats recorded Cursor's to-do tool as an edit to "Update TODOs", its plan tool as "Create Plan".
						if (/(^|[\\/])(update todos|create plan)\b/i.test(block.path)) {
							return;
						}
						flushSteps();
						const diff = fileDiff(block);
						body.push({
							kind: 'file', key, path: block.path, verb: block.verb,
							...(diff.additions !== undefined ? { additions: diff.additions } : {}),
							...(diff.deletions !== undefined ? { deletions: diff.deletions } : {}),
							...(diff.diff ? { diff: diff.diff } : {}),
							status: blockStatus(block.status),
						});
						return;
					}
					case 'markdown':
						if (block.content.trim()) {
							flushSteps();
							copy.push(block.content);
							body.push({ kind: 'markdown', key, docKey: key, text: block.content, streaming: block.status === 'streaming' });
						}
						return;
					case 'list':
						flushSteps();
						body.push({ kind: 'markdown', key, docKey: key, text: block.items.map((item, n) => `${block.ordered ? `${n + 1}.` : '-'} ${item}`).join('\n'), streaming: false });
						return;
					case 'code':
						flushSteps();
						body.push({ kind: 'code', key, ...(block.language ? { lang: block.language } : {}), code: block.code, ...(block.path ? { path: block.path } : {}), streaming: block.status === 'streaming' });
						return;
					case 'mermaid':
						flushSteps();
						body.push({ kind: 'code', key, lang: 'mermaid', code: block.source, streaming: block.status === 'streaming' });
						return;
					case 'table':
						flushSteps();
						body.push({ kind: 'table', key, headers: block.headers, rows: block.rows, ...(block.caption ? { caption: block.caption } : {}) });
						return;
					case 'plan':
						flushSteps();
						body.push({ kind: 'plan', key, docKey: key, title: block.name || 'Plan', markdown: block.markdown, ...(block.openQuestions?.length ? { openQuestions: block.openQuestions } : {}), streaming: block.status === 'streaming' });
						return;
					case 'approval':
						// A settled permission is history, not content; a pending one waits in the tray.
						return;
					case 'answers':
						flushSteps();
						body.push({ kind: 'answers', key, outcome: block.outcome, items: block.items, ...(block.note ? { note: block.note } : {}) });
						return;
					case 'error':
						flushSteps();
						body.push({ kind: 'error', key, message: block.message });
						return;
					case 'chart':
						flushSteps();
						body.push({ kind: 'chart', key, ...(block.title ? { title: block.title } : {}), labels: block.labels, values: block.values, ...(block.unit ? { unit: block.unit } : {}) });
						return;
					case 'cards':
						flushSteps();
						body.push({ kind: 'cards', key, items: block.items });
						return;
					case 'visual':
						flushSteps();
						body.push({ kind: 'visual', key, title: block.title, visual: block.kind });
						return;
				}
			}
		}
	});
	flushSubagents();
	flushSteps();

	// While streaming, the newest group (or thought) is live: "Exploring", "Thinking", "Running".
	const last = body.at(-1);
	if (streaming && last?.kind === 'steps') {
		body[body.length - 1] = stepsRow(last.key, last.items, true, last.display);
	} else if (streaming && last?.kind === 'thought') {
		body[body.length - 1] = { ...last, streaming: true };
	}

	const tail: TranscriptRow[] = [];
	if (message.steps?.length) {
		tail.push({ kind: 'todos', key: `${mkey}:todos`, steps: message.steps, live: streaming });
	}
	if (message.failure?.message && !streaming) {
		tail.push({ kind: 'error', key: `${mkey}:failure`, message: message.failure.message, ...(message.failure.retryable ? { retryable: true } : {}) });
	}
	const ms = message.durationMs ?? (message.endedAt && message.startedAt ? message.endedAt - message.startedAt : undefined);
	if (streaming) {
		// The live line, when the reply's last row doesn't already show what runs (text streams on its own).
		if (!last || last.kind === 'steps' || last.kind === 'thought' || last.kind === 'subagents' || (last.kind === 'compaction' && last.status !== 'running') || last.kind === 'file') {
			tail.push({ kind: 'working', key: `${mkey}:working`, status: message.activity?.status || 'Thinking', ...(message.startedAt ? { since: message.startedAt } : {}) });
		}
	} else {
		const files = turnFiles(segments);
		if (files.length) {
			tail.push({ kind: 'turnFiles', key: `${mkey}:files`, ...(message.id ? { turnId: message.id } : {}), files });
		}
		if (copy.length || ms || message.outcome) {
			const tokens = (message.tokensIn ?? 0) + (message.tokensOut ?? 0);
			tail.push({
				kind: 'footer',
				key: `${mkey}:footer`,
				copyText: copy.join('\n\n'),
				...(ms ? { durationMs: ms } : {}),
				...(message.model?.label ? { model: message.model.label } : {}),
				...(tokens ? { tokens } : {}),
				...(message.costUsd ? { costUsd: message.costUsd } : {}),
				...(message.cancelled ? { outcome: 'stopped' as const } : message.outcome ? { outcome: message.outcome } : {}),
				...(message.id ? { turnId: message.id } : {}),
				...(files.length ? { filesChanged: files.length } : {}),
				...(!tokens && message.tokensUsed ? { tokensUsed: message.tokensUsed, ...(message.tokensWindow ? { tokensWindow: message.tokensWindow } : {}) } : {}),
				...(message.endedAt ? { endedAt: message.endedAt } : {}),
			});
		}
	}

	// A finished turn with tool work folds it: everything before the trailing answer goes inside.
	if (!streaming && ms && body.some(isWorkRow)) {
		let start = body.length;
		while (start > 0 && isAnswerRow(body[start - 1])) {
			start--;
		}
		const work = body.slice(0, start);
		const visuals = work.filter(row => row.kind === 'visual');
		return { index, lead: [], work: visuals.length ? work.filter(row => row.kind !== 'visual') : work, answer: [...visuals, ...body.slice(start)], tail, turnKey: mkey, workedMs: ms };
	}
	return { index, lead: [], work: [], answer: body, tail, turnKey: mkey };
}

/** Files a turn edited, created or deleted, merged by path in the order first touched. */
function turnFiles(segments: readonly AgentSegment[]): ITurnFile[] {
	const byPath = new Map<string, { verb: ITurnFile['verb']; additions: number; deletions: number }>();
	for (const segment of segments) {
		if (segment.kind !== 'block' || segment.block.type !== 'file' || /(^|[\\/])(update todos|create plan)\b/i.test(segment.block.path)) {
			continue;
		}
		const block = segment.block;
		const diff = fileDiff(block);
		const prev = byPath.get(block.path);
		byPath.set(block.path, {
			verb: prev?.verb === 'Created' && block.verb !== 'Deleted' ? 'Created' : block.verb,
			additions: (prev?.additions ?? 0) + (diff.additions ?? 0),
			deletions: (prev?.deletions ?? 0) + (diff.deletions ?? 0),
		});
	}
	return [...byPath].map(([path, file]) => ({ path, ...file }));
}

//#endregion

//#region Building

const cache = new WeakMap<object, IMessageRows>();

/** The rows each message drew last time, by key: an unchanged row keeps its object (and its memoized view). */
const previous = new Map<string, Map<string, TranscriptRow>>();
const PREVIOUS_LIMIT = 64;

function same(a: unknown, b: unknown, depth: number): boolean {
	if (a === b) {
		return true;
	}
	if (depth > 4 || !a || !b || typeof a !== 'object' || typeof b !== 'object') {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!same(a[i], b[i], depth + 1)) {
				return false;
			}
		}
		return true;
	}
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) {
		return false;
	}
	for (const k of ka) {
		if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1)) {
			return false;
		}
	}
	return true;
}

/** Hands back last build's row objects where nothing changed; a changed steps row keeps its unchanged steps. */
function intern(mkey: string, rows: readonly TranscriptRow[]): TranscriptRow[] {
	const before = previous.get(mkey);
	const now = new Map<string, TranscriptRow>();
	const out = rows.map(row => {
		const prev = before?.get(row.key);
		let next = row;
		if (prev && prev.kind === row.kind) {
			if (same(prev, row, 0)) {
				next = prev;
			} else if (row.kind === 'steps' && prev.kind === 'steps') {
				const old = new Map(prev.items.map(item => [item.key, item]));
				next = { ...row, items: row.items.map(item => {
					const o = old.get(item.key);
					return o && same(o, item, 0) ? o : item;
				}) };
			}
		}
		now.set(row.key, next);
		return next;
	});
	previous.delete(mkey);
	previous.set(mkey, now);
	if (previous.size > PREVIOUS_LIMIT) {
		previous.delete(previous.keys().next().value!);
	}
	return out;
}

function internParts(mkey: string, parts: IMessageRows): IMessageRows {
	const all = intern(mkey, [...parts.lead, ...parts.work, ...parts.answer, ...parts.tail]);
	let at = 0;
	const take = (n: number) => all.slice(at, at += n);
	return { ...parts, lead: take(parts.lead.length), work: take(parts.work.length), answer: take(parts.answer.length), tail: take(parts.tail.length) };
}

const workedRows = new Map<string, Extract<TranscriptRow, { kind: 'worked' }>>();

function workedRow(turnKey: string, durationMs: number, open: boolean): Extract<TranscriptRow, { kind: 'worked' }> {
	const key = `${turnKey}:worked`;
	const hit = workedRows.get(key);
	if (hit && hit.durationMs === durationMs && hit.open === open) {
		return hit;
	}
	const row = { kind: 'worked' as const, key, turnKey, durationMs, open };
	workedRows.set(key, row);
	if (workedRows.size > 400) {
		workedRows.delete(workedRows.keys().next().value!);
	}
	return row;
}

export interface IBuildRowsOptions {
	/** Turns whose "Worked for" fold is open (by the `turnKey` of its row). */
	readonly openWorked?: ReadonlySet<string>;
	/** Turns whose fold is closed even though it would start open. */
	readonly closedWorked?: ReadonlySet<string>;
}

/**
 * The rows a transcript draws, oldest first. Rows of a message are cached by the message object,
 * so a patch that changed one message rebuilds only that message's rows, and rows within it that
 * did not change keep their objects. Prompts this client sent that the transcript doesn't show
 * yet follow as pending prompts.
 */
export function buildRows(messages: readonly AgentMessage[], pending: readonly IPendingSend[] = [], options: IBuildRowsOptions = {}): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const shown = new Set<string>();
	const lastIndex = messages.length - 1;
	const running = messages[lastIndex]?.kind === 'agent' && !!(messages[lastIndex] as IAssistantMessage).activity?.streaming;
	let lastUser = -1;
	messages.forEach((message, index) => {
		if (message.kind === 'user') {
			lastUser = index;
		}
	});
	messages.forEach((message, index) => {
		if (message.kind === 'user' && message.id) {
			shown.add(message.id);
		}
		let parts = cache.get(message);
		if (!parts || parts.index !== index) {
			const mkey = `${message.kind === 'user' ? 'u' : 'a'}:${message.id ?? `i${index}`}`;
			parts = message.kind === 'user'
				? { index, lead: [], work: [], answer: userRows(message, mkey), tail: [], turnKey: mkey }
				: assistantRows(message, mkey, index);
			parts = internParts(mkey, parts);
			cache.set(message, parts);
		}
		if (running && index === lastUser) {
			// The running prompt carries its Stop button, as on the desktop.
			for (const row of parts.answer) {
				rows.push(row.kind === 'user' && !row.steer ? runningUser(row) : row);
			}
			return;
		}
		if (parts.workedMs !== undefined && parts.work.length) {
			const open = !!options.openWorked?.has(parts.turnKey) && !options.closedWorked?.has(parts.turnKey);
			rows.push(workedRow(parts.turnKey, parts.workedMs, open));
			if (open) {
				rows.push(...parts.work);
			}
		}
		rows.push(...parts.answer, ...parts.tail);
	});
	for (const send of pending) {
		if (!shown.has(send.turnId)) {
			const images = send.attachments?.map(a => ({ ref: a.ref, mime: a.mime, name: a.name }));
			rows.push({ kind: 'user', key: `p:${send.turnId}`, text: send.text, chips: [], ...(images?.length ? { images } : {}), turnId: send.turnId, pending: send.state });
		}
	}
	return rows;
}

const runningRows = new WeakMap<TranscriptRow, TranscriptRow>();

function runningUser(row: Extract<TranscriptRow, { kind: 'user' }>): TranscriptRow {
	let hit = runningRows.get(row);
	if (!hit) {
		hit = { ...row, running: true };
		runningRows.set(row, hit);
	}
	return hit;
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
