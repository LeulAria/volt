/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { extractLocalPreviewUrl } from '../preview/localPreview.js';
import { isSnapshotActivity } from '../preview/browserSnapshot.js';
import { ACP_STALL_NOTICE_TITLE } from '../../../../services/voltRuntime/common/harness/acpStall.js';
import { BUDGET_NOTICE_TITLE, LOOP_NOTICE_TITLE } from '../../../../services/voltRuntime/common/harness/supervisor.js';
import { AgentSegment, IAgentActivityItem, IFileChangeBlock, ITerminalBlock, isExploreTool, splitMarkdownToBlocks, SupervisionKind } from '../blocks/agentBlocks.js';
import { computeChangeStats, formatChangeStats, netFileEdit } from '../review/fileChangePreviewModel.js';

export type ThreadPart =
	| { kind: 'group'; id: string; title: string; items: IAgentActivityItem[]; thinking?: string }
	| { kind: 'snapshot'; id: string; item: IAgentActivityItem }
	| { kind: 'markdown'; id: string; content: string }
	| { kind: 'notice'; id: string; severity: 'info' | 'warning' | 'error'; title: string; description?: string }
	| { kind: 'changes'; id: string; files: IFileChangeBlock[]; commands: ITerminalBlock[]; additions: number; deletions: number }
	| { kind: 'block'; block: import('../blocks/agentBlocks.js').AgentBlock };

const PROCESS_RE = /\[volt\]|skip repo-wide|xdg-open|browser mcp|in-app browser cannot|list mcp|webfetch|simplebrowser|evaluation task|these instructions|cannot be used to open|i will list|i'll list|preparing to run|checking the workspace|checking terminals|i cannot use|no browser mcp|no in-app browser/i;

export function isProcessNarration(text: string): boolean {
	const t = text.trim();
	if (!t) {
		return false;
	}
	if (PROCESS_RE.test(t)) {
		return true;
	}
	if (t.length > 240 && /^(checking|preparing|starting|i will|i'll|this appears)/i.test(t)) {
		return true;
	}
	return false;
}

export function partitionAssistantText(text: string): Array<{ kind: 'thought' | 'reply'; text: string }> {
	const parts: Array<{ kind: 'thought' | 'reply'; text: string }> = [];
	for (const raw of text.split(/\n{2,}/)) {
		const para = raw.trim();
		if (!para) {
			continue;
		}
		const kind = classifyAssistantParagraph(para);
		const last = parts.at(-1);
		if (last && last.kind === kind) {
			last.text += `\n\n${para}`;
		} else {
			parts.push({ kind, text: para });
		}
	}
	return parts;
}

function classifyAssistantParagraph(para: string): 'thought' | 'reply' {
	if (extractLocalPreviewUrl(para) || looksLikeAnswerForm(para)) {
		return 'reply';
	}
	// A long paragraph is still the answer; only harness chatter that leaked into the text is hidden.
	if (isProcessNarration(para)) {
		return 'thought';
	}
	return 'reply';
}

/** Tables, lists, and numbered answers stay in the reply - they are not process chrome. */
export function looksLikeAnswerForm(text: string): boolean {
	const lines = text.split('\n');
	const tableRows = lines.filter(line => line.includes('|') && line.replace(/\|/g, '').trim());
	if (tableRows.length >= 2) {
		return true;
	}
	const items = lines.filter(line => /^\s*(?:[-*\u2022]|\d+[.)])\s+\S/.test(line));
	return items.length >= 2;
}

/** The user-visible reply: the answer, file changes, and snapshots. Not thought/explore chrome. */
export function visibleReplyParts(parts: readonly ThreadPart[], streaming = false): ThreadPart[] {
	const visible: ThreadPart[] = [];
	for (const part of parts) {
		// Explore chrome goes, but the agent's browser test stays as one collapsed line (Cursor's
		// "Explored 6 browser actions"): it is how the user checks what was verified, row by row.
		if (part.kind === 'group' && !(!streaming && part.items.some(item => item.browserTool))) {
			continue;
		}
		if (part.kind === 'block' && part.block.type === 'tool') {
			continue;
		}
		// A settled permission is process chrome. One still waiting is how the user answers it,
		// and a plan or question stays: its text is the content of the turn.
		if (part.kind === 'block' && part.block.type === 'approval' && (part.block.decision || part.block.blocked) && part.block.action !== 'question') {
			continue;
		}
		const last = visible.at(-1);
		if (part.kind === 'markdown' && last?.kind === 'markdown') {
			visible[visible.length - 1] = { ...last, content: `${last.content}\n\n${part.content}` };
			continue;
		}
		visible.push(part);
	}
	if (streaming) {
		const live = [...parts].reverse().find(part => part.kind === 'group');
		if (live) {
			visible.push(live);
		}
	}
	return visible;
}

export function buildThreadParts(segments: AgentSegment[] | undefined, fallbackText?: string, streaming = false): ThreadPart[] {
	const source = segments?.length
		? segments
		: (fallbackText ? [{ kind: 'text' as const, text: fallbackText }] : []);
	const parts: ThreadPart[] = [];
	let items: IAgentActivityItem[] = [];
	let thinking = '';
	/** Streamed model reasoning carries timestamps; narration classified as thought does not. */
	let thinkingMs = 0;
	let timed = false;
	let work: Array<IFileChangeBlock | ITerminalBlock> = [];
	let groupIndex = 0;
	let textIndex = 0;
	let reply = '';

	const flushThought = () => {
		const text = thinking.trim();
		if (!text || (!items.length && !timed)) {
			return;
		}
		const label = timed && thinkingMs >= 1_500
			? localize('voltAgent.thoughtFor', "Thought for {0}s", Math.round(thinkingMs / 1000))
			: localize('voltAgent.thoughtBriefly', "Thought briefly");
		const last = items.at(-1);
		if (last?.kind === 'thought') {
			last.text = joinText(last.text ?? '', text);
		} else {
			items.push({ kind: 'thought', label, text });
		}
		thinking = '';
		thinkingMs = 0;
		timed = false;
	};

	const flushGroup = () => {
		flushThought();
		if (!items.length && !thinking.trim()) {
			return;
		}
		parts.push({
			kind: 'group',
			id: `activity-${groupIndex++}`,
			title: activityGroupTitle(items, thinking, false),
			items,
		});
		items = [];
		thinking = '';
	};

	const flushWork = () => {
		if (!work.length) {
			return;
		}
		// Several edits to one file read as that file once, with the edits' stats summed (Cursor).
		const files = mergeFileBlocks(work.filter((block): block is IFileChangeBlock => block.type === 'file'));
		const commands = work.filter((block): block is ITerminalBlock => block.type === 'terminal');
		if (files.length && (files.length > 1 || commands.length > 0)) {
			let additions = 0;
			let deletions = 0;
			for (const file of files) {
				const stats = computeChangeStats(fileChangeSource(file));
				additions += stats.additions;
				deletions += stats.deletions;
			}
			parts.push({
				kind: 'changes',
				id: `changes-${groupIndex++}`,
				files,
				commands,
				additions,
				deletions,
			});
		} else {
			for (const block of [...files, ...commands]) {
				parts.push({ kind: 'block', block });
			}
		}
		work = [];
	};

	const flushReply = () => {
		const text = reply.trim();
		reply = '';
		if (!text) {
			return;
		}
		flushWork();
		flushGroup();
		for (const block of splitMarkdownToBlocks(text, `md-${textIndex++}`)) {
			if (block.type === 'markdown') {
				parts.push({ kind: 'markdown', id: block.id, content: block.content });
			} else {
				parts.push({ kind: 'block', block });
			}
		}
	};

	for (const segment of source) {
		if (segment.kind === 'thought') {
			flushReply();
			thinking = joinText(thinking, segment.text);
			if (segment.startedAt !== undefined) {
				timed = true;
				thinkingMs += Math.max(0, (segment.updatedAt ?? segment.startedAt) - segment.startedAt);
			}
			if (items.length) {
				flushThought();
			}
			continue;
		}
		if (segment.kind === 'activity') {
			if (segment.item.hidden) {
				continue;
			}
			flushReply();
			// An in-app browser screenshot stays a row among the browser actions, as in Cursor.
			if (!segment.item.browserTool && isSnapshotActivity(segment.item)) {
				flushWork();
				flushGroup();
				parts.push({ kind: 'snapshot', id: `snapshot-${groupIndex++}`, item: segment.item });
				continue;
			}
			if (!items.length) {
				if (timed) {
					flushThought();
				} else {
					thinking = '';
				}
			}
			items.push(segment.item);
			continue;
		}
		if (segment.kind === 'notice') {
			flushReply();
			flushWork();
			flushGroup();
			parts.push({
				kind: 'notice',
				id: `notice-${textIndex++}`,
				severity: segment.severity,
				title: segment.title,
				...(segment.description ? { description: segment.description } : {}),
			});
			continue;
		}
		if (segment.kind === 'text') {
			for (const chunk of partitionAssistantText(segment.text)) {
				if (chunk.kind === 'thought') {
					flushReply();
					thinking = joinText(thinking, chunk.text);
					if (items.length) {
						flushThought();
					}
				} else {
					reply = reply ? `${reply}\n\n${chunk.text}` : chunk.text;
				}
			}
			continue;
		}
		if (segment.kind === 'compaction') {
			// The transcript draws it as a divider; it is not part of the reply's work or answer.
			continue;
		}
		flushReply();
		if (segment.block.type === 'tool' && isExploreTool(segment.block.name, segment.block.title)) {
			continue;
		}
		if (segment.block.type === 'file' || segment.block.type === 'terminal') {
			flushGroup();
			work.push(segment.block);
			continue;
		}
		flushWork();
		flushGroup();
		parts.push({ kind: 'block', block: segment.block });
	}
	flushReply();
	flushWork();
	flushGroup();
	if (streaming) {
		const last = parts.at(-1);
		if (last?.kind === 'group') {
			last.title = activityGroupTitle(last.items, last.thinking ?? '', true);
		} else if (last?.kind !== 'snapshot') {
			parts.push({
				kind: 'group',
				id: `activity-${groupIndex}`,
				title: localize('voltAgent.thinking', "Thinking"),
				items: [],
			});
		}
	}
	return parts;
}

/** How long each idle status phrase stays before the line swaps to the next. */
export const STATUS_ROTATE_MS = 2200;

/** Vertical text-swap duration. The shimmer timing is separate and unchanged. */
export const STATUS_SWAP_MS = 420;

const THINKING_PHRASE = localize('voltAgent.thinking', "Thinking");
export const PLANNING_PHRASE = localize('voltAgent.planningNext', "Planning next moves");

export interface IStreamingActivityLines {
	/** Work summary, such as "Exploring 4 files, 3 searches". Omitted when it would repeat the live phrase. */
	summary?: string;
	/** Current action on the swapping line. */
	phrase: string;
	/** When true, the phrase advances on {@link STATUS_ROTATE_MS} while the model is between tools. */
	rotate: boolean;
}

/**
 * What to draw while a turn is still streaming and has no answer text yet.
 * The summary stays put. The phrase is the live action, and it swaps in place
 * between "Thinking" and "Planning next moves" when nothing more specific is running.
 */
export function streamingActivityLines(
	title: string,
	status: string | undefined,
	items: readonly IAgentActivityItem[],
	now: number,
	rotateAnchor: number,
	pinned = false,
): IStreamingActivityLines {
	const live = liveStatusPhrase(status, items, now, rotateAnchor, pinned);
	const generic = !title || title === THINKING_PHRASE || title === localize('voltAgent.thoughtBriefly', "Thought briefly") || title === live.phrase;
	return {
		summary: generic ? undefined : title,
		phrase: live.phrase,
		rotate: live.rotate,
	};
}

function liveStatusPhrase(
	status: string | undefined,
	items: readonly IAgentActivityItem[],
	now: number,
	rotateAnchor: number,
	pinned: boolean,
): { phrase: string; rotate: boolean } {
	const raw = (status ?? '').trim();
	if (pinned && raw) {
		return { phrase: raw, rotate: false };
	}
	if (!raw || raw === THINKING_PHRASE) {
		return { phrase: rotatedThinkingPhrase(now, rotateAnchor), rotate: true };
	}
	if (raw === localize('voltAgent.planning', "Planning") || raw === PLANNING_PHRASE) {
		return { phrase: PLANNING_PHRASE, rotate: false };
	}
	if (raw === localize('voltAgent.verifying', "Verifying")) {
		return { phrase: raw, rotate: false };
	}
	if (raw === localize('voltAgent.waiting', "Waiting")) {
		return { phrase: raw, rotate: false };
	}
	if (raw === localize('voltAgent.writing', "Writing")) {
		return { phrase: raw, rotate: false };
	}
	if (raw === localize('voltAgent.clarify', "Needs a decision")) {
		return { phrase: raw, rotate: false };
	}
	const fromStatus = verbFromStatus(raw);
	if (fromStatus) {
		return { phrase: fromStatus, rotate: false };
	}
	const latest = [...items].reverse().find(item => item.kind !== 'thought');
	if (latest?.kind === 'browser') {
		return { phrase: localize('voltAgent.browsing', "Browsing"), rotate: false };
	}
	if (latest?.kind === 'search') {
		return { phrase: localize('voltAgent.searching', "Searching"), rotate: false };
	}
	if (latest?.kind === 'read') {
		return { phrase: localize('voltAgent.reading', "Reading"), rotate: false };
	}
	if (latest?.kind === 'wait') {
		return { phrase: localize('voltAgent.waiting', "Waiting"), rotate: false };
	}
	if (raw.length <= 48) {
		return { phrase: raw, rotate: false };
	}
	return { phrase: rotatedThinkingPhrase(now, rotateAnchor), rotate: true };
}

function rotatedThinkingPhrase(now: number, anchor: number): string {
	const elapsed = Math.max(0, now - anchor);
	const index = Math.floor(elapsed / STATUS_ROTATE_MS) % 2;
	return index === 0 ? THINKING_PHRASE : PLANNING_PHRASE;
}

function verbFromStatus(status: string): string | undefined {
	const lower = status.toLowerCase();
	if (/^running\b/.test(lower)) {
		return status;
	}
	const reading = localize('voltAgent.reading', "Reading");
	const searching = localize('voltAgent.searching', "Searching");
	const browsing = localize('voltAgent.browsing', "Browsing");
	const editing = localize('voltAgent.editing', "Editing");
	const waiting = localize('voltAgent.waiting', "Waiting");
	if (/^(read|reading)\b/.test(lower)) {
		return joinVerb(reading, status);
	}
	if (/^(search|searched|searching|grep|grepped|find|glob)\b/.test(lower)) {
		return joinVerb(searching, status);
	}
	if (/web[_\s-]?search|web[_\s-]?fetch|\b(browser|browsing|navigate|snapshot)\b/.test(lower)) {
		const host = status.match(/https?:\/\/([^/\s]+)/i)?.[1]?.replace(/^www\./, '');
		const detail = host || compactDetail(status.replace(/^.*?web[_\s-]?(?:search|fetch)\s*/i, ''));
		return detail && detail.toLowerCase() !== lower ? `${browsing} ${detail}` : browsing;
	}
	if (/^(edit|editing|write|wrote|creat|delet|patch|apply)\b/.test(lower)) {
		return joinVerb(editing, status);
	}
	if (/^(wait|waiting|sleep)\b/.test(lower)) {
		return waiting;
	}
	return undefined;
}

function joinVerb(verb: string, status: string): string {
	const tail = status.replace(/^(read|reading|search(?:ed|ing)?|grep(?:ped)?|find|glob|edit(?:ing)?|write|wrote|creat\w*|delet\w*|patch\w*|apply)\s+/i, '').replace(/^files\s+/i, '');
	const detail = compactDetail(tail);
	if (!detail || /^(grep|find|glob|search|read|edit|write|files)$/i.test(detail)) {
		return verb;
	}
	return `${verb} ${detail}`;
}

function compactDetail(raw: string): string | undefined {
	const trimmed = raw.trim().replace(/[.,;:]+$/, '');
	if (!trimmed || trimmed.toLowerCase() === 'command') {
		return undefined;
	}
	let text = trimmed;
	if (text.includes('/') || text.includes('\\')) {
		const token = text.split(/\s+/)[0];
		const base = token.split(/[\\/]/).pop() || token;
		text = `${base}${text.slice(token.length)}`.trim();
	}
	if (text.length > 42) {
		return `${text.slice(0, 39).trimEnd()}...`;
	}
	return text;
}

export function activityGroupTitle(items: readonly IAgentActivityItem[], thinking?: string, streaming = false): string {
	const reads = items.filter(item => item.kind === 'read');
	const files = reads.length;
	const searches = items.filter(item => item.kind === 'search').length;
	const browsers = items.filter(item => item.kind === 'browser').length;
	const waits = items.filter(item => item.kind === 'wait');
	const explore = formatExploreTitle(files, searches, browsers, streaming, reads[0]?.detail);
	if (explore) {
		return explore;
	}
	if (waits.length && waits.length === items.length) {
		return waits[0]?.label || localize('voltAgent.waited', "Waited");
	}
	return streaming
		? localize('voltAgent.thinking', "Thinking")
		: localize('voltAgent.thoughtBriefly', "Thought briefly");
}

function formatExploreTitle(files: number, searches: number, browsers: number, streaming: boolean, fileName?: string): string | undefined {
	if (!files && !searches && !browsers) {
		return undefined;
	}
	const parts: string[] = [];
	if (files) {
		parts.push(files === 1
			? (fileName || localize('voltAgent.oneFile', "1 file"))
			: localize('voltAgent.manyFiles', "{0} files", files));
	}
	if (searches) {
		parts.push(searches === 1
			? localize('voltAgent.oneSearch', "1 search")
			: localize('voltAgent.manySearches', "{0} searches", searches));
	}
	if (browsers) {
		parts.push(browsers === 1
			? localize('voltAgent.oneBrowser', "1 browser action")
			: localize('voltAgent.manyBrowsers', "{0} browser actions", browsers));
	}
	const joined = parts.join(', ');
	return streaming
		? localize('voltAgent.exploring', "Exploring {0}", joined)
		: localize('voltAgent.explored', "Explored {0}", joined);
}

export function fileChangeGroupTitle(files: number, commands: number, additions: number, deletions: number): string {
	const parts: string[] = [];
	if (files) {
		parts.push(files === 1
			? localize('voltAgent.editingOneFile', "Editing 1 file")
			: localize('voltAgent.editingManyFiles', "Editing {0} files", files));
	}
	if (commands) {
		parts.push(commands === 1
			? localize('voltAgent.ranOneCommand', "ran 1 command")
			: localize('voltAgent.ranManyCommands', "ran {0} commands", commands));
	}
	const stats = formatChangeStats(additions, deletions);
	const counts = [stats.added, stats.removed].filter(Boolean).join(' ');
	const joined = parts.join(', ');
	return counts ? `${joined} ${counts}` : joined;
}

/** One block per file: repeated edits to a path fold into the first, with added and removed lines summed. */
export function mergeFileBlocks(files: readonly IFileChangeBlock[]): IFileChangeBlock[] {
	const byPath = new Map<string, IFileChangeBlock[]>();
	for (const file of files) {
		const list = byPath.get(file.path);
		if (list) {
			list.push(file);
		} else {
			byPath.set(file.path, [file]);
		}
	}
	return [...byPath.values()].map(list => {
		if (list.length === 1) {
			return list[0];
		}
		let additions = 0;
		let deletions = 0;
		for (const file of list) {
			const stats = computeChangeStats(fileChangeSource(file));
			additions += stats.additions;
			deletions += stats.deletions;
		}
		const first = list[0];
		const last = list[list.length - 1];
		const diffs = list.map(file => file.unifiedDiff).filter((diff): diff is string => !!diff);
		// When the edits replay into whole files, the card shows the net change (a new file is +N, never -1 for its rewrites).
		const net = netFileEdit(list.map(file => ({ original: file.original, modified: file.modified, created: file.verb === 'Created' })));
		return {
			...first,
			id: `${first.id}-merged`,
			verb: first.verb === 'Created' ? 'Created' : last.verb,
			original: net ? net.original : first.original,
			modified: net ? net.modified : undefined,
			unifiedDiff: net ? undefined : diffs.length === list.length ? diffs.join('\n') : first.unifiedDiff,
			additions: net ? undefined : additions,
			deletions: net ? undefined : deletions,
			status: list.some(file => file.status === 'streaming') ? 'streaming' : list.some(file => file.status === 'error') ? 'error' : 'complete',
		};
	});
}

export interface ITurnFileChange {
	readonly path: string;
	readonly verb: IFileChangeBlock['verb'];
	readonly additions: number;
	readonly deletions: number;
}

/** Every file a reply changed, once each with its summed stats: the end-of-turn "N Files Changed" card. */
export function turnFileChanges(segments: readonly AgentSegment[] | undefined): ITurnFileChange[] {
	const files = (segments ?? []).flatMap(segment => segment.kind === 'block' && segment.block.type === 'file' ? [segment.block] : []);
	return mergeFileBlocks(files).map(file => ({ path: file.path, verb: file.verb, ...computeChangeStats(fileChangeSource(file)) }));
}

export function fileChangeSource(block: IFileChangeBlock) {
	return {
		path: block.path,
		verb: block.verb,
		original: block.original,
		modified: block.modified,
		unifiedDiff: block.unifiedDiff,
		additions: block.additions,
		deletions: block.deletions,
	};
}

function joinText(left: string, right: string): string {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return `${left}${left.endsWith('\n') || right.startsWith('\n') ? '' : '\n'}${right}`;
}

//#region Run state (DOM-free; the editor draws these)

const LOOP_RE = /\b(?:doom[\s-]?loop|looping|loop detected|stuck in a (?:loop|repeating)|repeating (?:the same|itself)|same tools? (?:were |was )?called|called the same tools?|identical tool batch|repeated (?:the same|identical) (?:call|calls|edit|edits|error|errors|step|steps|tool|tools))\b/i;
const STALL_RE = /\b(?:stopped responding|not responding|no (?:response|output|activity|progress|updates?)\b[^.\n]{0,40}?\b(?:for|in|since)|stall(?:ed|ing)?|went quiet|has been quiet|idle for|silent for)\b/i;
const BUDGET_RE = /\b(?:step limit|tool[- ]call (?:limit|budget)|budget|time limit|token limit|turn limit|wall[- ]clock)\b/i;
const CONNECTION_RE = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|connection (?:reset|closed|refused|lost|failed|error)|disconnected)\b/i;

/**
 * A run supervisor's finding, read from a notice or error the runtime emitted: the agent loops,
 * went quiet, or stopped at a budget. Undefined for ordinary provider status.
 */
export function classifySupervisionNotice(text: string): SupervisionKind | undefined {
	// The runtime's own titles first (ACP supervisor and idle watchdog), then its wording.
	const title = text.split('\n', 1)[0].trim();
	if (title === LOOP_NOTICE_TITLE) {
		return 'loop';
	}
	if (title === ACP_STALL_NOTICE_TITLE) {
		return 'stall';
	}
	if (title === BUDGET_NOTICE_TITLE) {
		return 'budget';
	}
	if (LOOP_RE.test(text)) {
		return 'loop';
	}
	if (STALL_RE.test(text)) {
		return 'stall';
	}
	if (BUDGET_RE.test(text)) {
		return 'budget';
	}
	return undefined;
}

/** The parts of a finished reply the run-state helpers read. */
export interface IRunStateMessage {
	readonly cancelled?: boolean;
	readonly outcome?: 'done' | 'failed' | 'stopped';
	readonly failure?: { readonly message: string; readonly retryable?: boolean };
	readonly runId?: string;
	readonly text?: string;
	readonly segments?: readonly AgentSegment[];
	readonly activity?: { readonly streaming?: boolean; readonly status?: string };
}

/** The reply did something worth continuing: wrote text, ran a tool, or edited a file. */
export function turnMadeProgress(message: Pick<IRunStateMessage, 'text' | 'segments'>): boolean {
	if ((message.text ?? '').trim()) {
		return true;
	}
	return (message.segments ?? []).some(segment =>
		segment.kind === 'activity'
		|| (segment.kind === 'text' && !!segment.text.trim())
		|| (segment.kind === 'block' && (segment.block.type === 'file' || segment.block.type === 'terminal' || segment.block.type === 'tool')));
}

export type RunEndKind = 'failed' | 'stopped' | 'interrupted';

export interface IRunEndTray {
	readonly kind: RunEndKind;
	readonly title: string;
	/** The exact error text, when the run failed with one. */
	readonly detail?: string;
	/** Shown as "Request ID: ..." with a Copy Request ID action, as Cursor's error tray does. */
	readonly requestId?: string;
	/** Resend the same prompt in place ("Try again"). Only on the newest turn. */
	readonly canRetry: boolean;
	/** Continue from what the turn already did ("Resume"). Only on the newest turn that made progress. */
	readonly canResume: boolean;
	/** What a supervisor saw, when the run failed because of it (a loop, a stall, a budget). */
	readonly cause?: SupervisionKind;
	/** A loop stop: offer "Continue differently" instead of leaving a dead end like Cursor's tray. */
	readonly canContinueDifferently: boolean;
}

/**
 * What a turn that did not finish shows at its end: a "Stopped" marker after the user's Stop,
 * "Interrupted" after a reload cut it off, or an error tray with the exact message, the run id,
 * and Try again / Resume. Undefined for turns that finished normally or are still running.
 */
export function runEndTray(message: IRunStateMessage, isLast: boolean): IRunEndTray | undefined {
	if (message.activity?.streaming) {
		return undefined;
	}
	const progress = turnMadeProgress(message);
	if (message.outcome === 'failed') {
		const detail = message.failure?.message.trim() || undefined;
		const cause = detail ? classifySupervisionNotice(detail) : undefined;
		// A supervisor's stop is final for that run, not for the task: the user can still go on.
		const retryable = message.failure?.retryable !== false || cause === 'loop' || cause === 'budget';
		return {
			kind: 'failed',
			title: failureTitle(detail),
			detail: detail ?? localize('voltAgent.run.genericFailure', "Something went wrong. Please try again."),
			requestId: message.runId,
			canRetry: isLast && retryable,
			canResume: isLast && retryable && (progress || cause === 'budget') && cause !== 'loop',
			...(cause ? { cause } : {}),
			canContinueDifferently: isLast && cause === 'loop',
		};
	}
	if (message.cancelled || message.outcome === 'stopped') {
		const interrupted = message.outcome !== 'stopped' && message.activity?.status === localize('voltAgent.interrupted', "Interrupted");
		return {
			kind: interrupted ? 'interrupted' : 'stopped',
			title: interrupted ? localize('voltAgent.run.interrupted', "Interrupted") : localize('voltAgent.run.stopped', "Stopped"),
			canRetry: isLast,
			canResume: isLast && progress,
			canContinueDifferently: false,
		};
	}
	return undefined;
}

/** A short heading for a run error; the exact text goes under it. */
export function failureTitle(message: string | undefined): string {
	const text = message ?? '';
	const kind = classifySupervisionNotice(text);
	if (kind === 'loop') {
		return localize('voltAgent.run.loopTitle', "Agent looping detected");
	}
	if (kind === 'stall') {
		return localize('voltAgent.run.stallTitle', "Agent stopped responding");
	}
	if (kind === 'budget') {
		return localize('voltAgent.run.budgetTitle', "Paused at a limit");
	}
	if (CONNECTION_RE.test(text)) {
		return localize('voltAgent.run.connectionTitle', "Connection failed");
	}
	return localize('voltAgent.run.errorTitle', "Something went wrong");
}

export type SupervisionAction = 'continueDifferently' | 'resume' | 'continue' | 'stop';

/**
 * The buttons on a supervisor tray. Cursor's "Agent Looping Detected" is a dead end; here the
 * user can steer the agent onto a different approach or stop it. Older turns get no actions,
 * and a failed turn leaves them to its error tray.
 */
export function supervisionActions(kind: SupervisionKind, state: { readonly running: boolean; readonly isLast: boolean; readonly failed: boolean }): SupervisionAction[] {
	if (!state.isLast) {
		return [];
	}
	if (state.running) {
		switch (kind) {
			case 'loop': return ['continueDifferently', 'stop'];
			case 'stall': return ['resume', 'stop'];
			case 'budget': return [];
		}
	}
	if (state.failed) {
		return [];
	}
	switch (kind) {
		case 'loop': return ['continueDifferently'];
		case 'stall': return ['resume'];
		case 'budget': return ['continue'];
	}
}

/** The heading of a supervisor tray. */
export function supervisionTitle(kind: SupervisionKind): string {
	switch (kind) {
		case 'loop': return localize('voltAgent.supervision.loop', "Agent looping detected");
		case 'stall': return localize('voltAgent.supervision.stall', "Taking longer than expected");
		case 'budget': return localize('voltAgent.supervision.budget', "Run budget");
	}
}

export interface ITodoChecklist {
	readonly items: readonly { readonly label: string; readonly state: 'done' | 'current' | 'pending' }[];
	readonly done: number;
	readonly total: number;
	/** The to-do in progress, else the first one still open. */
	readonly current?: string;
	/** "2 of 5" while running; Cursor's "3 of 3 To-dos Completed" once the turn ends. */
	readonly title: string;
}

/** The checklist under a turn, from the agent's plan / to-do updates. Undefined without to-dos. */
export function todoChecklist(steps: readonly { readonly label: string; readonly state: 'done' | 'current' | 'pending' }[] | undefined, live: boolean): ITodoChecklist | undefined {
	const items = (steps ?? []).filter(step => step.label.trim());
	if (!items.length) {
		return undefined;
	}
	const done = items.filter(step => step.state === 'done').length;
	const current = (items.find(step => step.state === 'current') ?? items.find(step => step.state === 'pending'))?.label;
	const title = live
		? localize('voltAgent.todos.progress', "{0} of {1} To-dos", done, items.length)
		: localize('voltAgent.todos.completed', "{0} of {1} To-dos Completed", done, items.length);
	return { items, done, total: items.length, current: done === items.length ? undefined : current, title };
}

/** One of the agent's to-dos, with when it started and finished (as far as its updates told us). */
export interface IAgentTodoStep {
	label: string;
	state: 'done' | 'current' | 'pending';
	startedAt?: number;
	endedAt?: number;
}

/**
 * The next to-do list with times carried over from the previous one: a to-do starts when it first
 * shows in progress and ends when it first shows done. To-dos match by label, else by position in a
 * list of the same length for the one that was in progress: Claude names it differently while it runs
 * ("Verifying …" for "Verify …").
 */
export function stampTodoSteps(previous: readonly IAgentTodoStep[], next: readonly Pick<IAgentTodoStep, 'label' | 'state'>[], now: number): IAgentTodoStep[] {
	const before = new Map(previous.map(step => [step.label, step]));
	const labels = new Set(next.map(step => step.label));
	const renamed = (index: number) => {
		const step = previous.length === next.length ? previous[index] : undefined;
		return step?.state === 'current' && !labels.has(step.label) ? step : undefined;
	};
	return next.map(({ label, state }, index) => {
		const prior = before.get(label) ?? renamed(index);
		const startedAt = prior?.startedAt ?? (state === 'current' ? now : undefined);
		const endedAt = state === 'done' ? prior?.endedAt ?? now : undefined;
		return {
			label,
			state,
			...(startedAt !== undefined && state !== 'pending' ? { startedAt } : {}),
			...(endedAt !== undefined ? { endedAt } : {}),
		};
	});
}

export interface ITasksCardItem {
	readonly label: string;
	readonly state: 'done' | 'current' | 'pending';
	/** "1m 32s" for a finished to-do whose start we saw, "now" for the one in progress. */
	readonly time?: string;
}

/** The "Tasks" card docked on the composer while the agent works through its to-dos. */
export interface ITasksCard {
	readonly items: readonly ITasksCardItem[];
	readonly done: number;
	readonly total: number;
	/** The to-do in progress, else the next open one; undefined once all are done. */
	readonly current?: string;
	readonly live: boolean;
}

export function tasksCard(steps: readonly IAgentTodoStep[], live: boolean): ITasksCard | undefined {
	const shown = steps.filter(step => step.label.trim());
	if (!shown.length) {
		return undefined;
	}
	const items = shown.map((step): ITasksCardItem => {
		if (step.state === 'done' && step.startedAt !== undefined && step.endedAt !== undefined) {
			return { label: step.label, state: step.state, time: formatElapsed(step.endedAt - step.startedAt) };
		}
		if (step.state === 'current' && live) {
			return { label: step.label, state: step.state, time: localize('voltAgent.tasks.now', "now") };
		}
		return { label: step.label, state: step.state };
	});
	const done = shown.filter(step => step.state === 'done').length;
	const current = (shown.find(step => step.state === 'current') ?? shown.find(step => step.state === 'pending'))?.label;
	return { items, done, total: shown.length, current, live };
}

/**
 * Which to-dos the composer's Tasks card shows: the latest list in the chat, while its turn (or a
 * later one) runs, or after it if some are still open. A finished list leaves the card.
 */
export function composerTasks(messages: readonly { readonly kind: string; readonly steps?: readonly IAgentTodoStep[]; readonly activity?: { readonly streaming?: boolean } }[]): ITasksCard | undefined {
	const agents = messages.filter(message => message.kind === 'agent');
	const last = agents.at(-1);
	const owner = agents.findLast(message => !!message.steps?.length);
	if (!last || !owner?.steps) {
		return undefined;
	}
	const live = !!last.activity?.streaming;
	const open = owner.steps.some(step => step.state !== 'done');
	if (owner !== last && !(live && open)) {
		// An older turn's list: only a run that is still working through it brings it back.
		return undefined;
	}
	if (!live && !open) {
		return undefined;
	}
	return tasksCard(owner.steps, live);
}

/** "42s", "3m 05s", "1h 02m": a live turn's elapsed time, steady width so it does not jitter. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) {
		return `${h}h ${String(m).padStart(2, '0')}m`;
	}
	if (m) {
		return `${m}m ${String(s).padStart(2, '0')}s`;
	}
	return `${s}s`;
}

/**
 * Build for a plan the agent wrote with its plan tool. Cursor attaches the plan file to a canned
 * "Implement the plan as specified" prompt; the plan text goes along here too, so the agent builds
 * what the user read (and edited), not a guess from its name. The bubble shows only "Build ...".
 */
export function createdPlanPrompt(plan: { readonly name?: string; readonly markdown: string }): { readonly text: string; readonly display: string } {
	const name = plan.name?.trim();
	const body = plan.markdown.trim();
	const instructions = localize('voltAgent.plan.buildInstructions', "Implement the plan as specified, it is included below for your reference. Do NOT edit the plan file itself. Track the work as to-dos, marking each one in progress as you start it, and don't stop until you have completed all of them.");
	const text = [name, instructions, body ? `<plan>\n${body}\n</plan>` : ''].filter(Boolean).join('\n\n');
	const display = name
		? localize('voltAgent.plan.buildNamedDisplay', "Build \"{0}\"", name)
		: localize('voltAgent.plan.buildDisplay', "Build the plan");
	return { text, display };
}

//#endregion
