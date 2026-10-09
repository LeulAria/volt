/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isSubagentToolName, voltTaskToolOf } from '../../../../services/voltRuntime/common/orchestration/harnessSubagents.js';
import { DELEGATE_TASK_TOOL_NAME } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { basename } from '../../../../../base/common/path.js';
import { localize } from '../../../../../nls.js';
import { isSnapshotActivity } from '../preview/browserSnapshot.js';
import type { ISandboxDenial } from '../../../../../platform/voltSandbox/common/sandboxDenials.js';
import { AgentBlock, AgentSegment, createPlanBlock, IAgentActivityItem, IAgentCompaction, IFileChangeBlock, ITerminalBlock, IToolBlock, isExploreTool, isPlanTool, IVisualBlock, parsePlanToolInput, splitMarkdownToBlocks, SupervisionKind } from '../blocks/agentBlocks.js';
import { computeChangeStats } from '../review/fileChangePreviewModel.js';
import { isSignInNotice } from '../../../../services/voltRuntime/common/acpNotices.js';
import { fileChangeSource, partitionAssistantText } from './agentTimeline.js';
import { PREVIEW_HTML_TOOL_NAME, RENDER_HTML_TOOL_NAME, VISUAL_TOOL_NAMES } from '../../../../services/voltRuntime/common/hostTools.js';

/**
 * Cursor's transcript model. Between two pieces of assistant text, every tool call and
 * thought collapses into one group row ("Explored 5 files, 3 searches", "Edited stats.js,
 * explored 1 file, ran 2 commands +1 -1"). Expanded, a group lists one line per step; a
 * step with content (command output, diff, reasoning) expands in place.
 */

export type TranscriptStepKind = 'thought' | 'read' | 'search' | 'browser' | 'snapshot' | 'wait' | 'note' | 'run' | 'edit' | 'tool' | 'todo' | 'visual';

export interface ITranscriptStep {
	readonly id: string;
	readonly kind: TranscriptStepKind;
	/** The verb, drawn in the tertiary tone: "Read", "Ran", "Edited", "Thought". */
	readonly action: string;
	/** The rest of the line, in the quaternary tone. */
	readonly detail?: string;
	readonly additions?: number;
	readonly deletions?: number;
	readonly item?: IAgentActivityItem;
	readonly terminal?: ITerminalBlock;
	readonly file?: IFileChangeBlock;
	readonly tool?: IToolBlock;
	/** Reasoning text behind a "Thought" line. */
	readonly text?: string;
	/** How long the reasoning streamed, when known. */
	readonly ms?: number;
	/** Still running: shown with the live verb and a shimmer. */
	readonly live?: boolean;
}

export type TranscriptRow =
	| { readonly kind: 'steps'; readonly id: string; readonly steps: readonly ITranscriptStep[]; readonly live: boolean }
	| { readonly kind: 'thought'; readonly id: string; readonly step: ITranscriptStep; readonly live: boolean }
	| { readonly kind: 'markdown'; readonly id: string; readonly content: string }
	| { readonly kind: 'block'; readonly block: AgentBlock }
	| { readonly kind: 'subagent'; readonly id: string; readonly tool: IToolBlock; readonly live: boolean }
	/** Subagents started one after another: one card ("3 subagents · 2 working"). */
	| { readonly kind: 'subagents'; readonly id: string; readonly items: readonly { readonly id: string; readonly tool: IToolBlock; readonly live: boolean }[]; readonly live: boolean }
	| { readonly kind: 'notice'; readonly id: string; readonly severity: 'info' | 'warning' | 'error'; readonly title: string; readonly description?: string; readonly supervision?: SupervisionKind; readonly sandbox?: ISandboxDenial }
	/** A message the user sent into the running turn ("Steer"); the agent read it between steps. */
	| { readonly kind: 'steer'; readonly id: string; readonly text: string }
	/** "Compacting context" while the agent summarizes the chat, then "Context compacted". */
	| { readonly kind: 'compaction'; readonly id: string; readonly compaction: IAgentCompaction };

/** A steering message recorded on a reply: `at` is how many segments the reply had when it was sent. */
export interface ITranscriptSteer {
	readonly text: string;
	readonly at: number;
}

const SUBAGENT_RE = /^(task|agent|subagent|delegate|run_agent|spawn_agent)$/i;

/** A harness's own Task call, or Volt's delegate_task: drawn as a subagent row. */
export function isSubagentTool(block: IToolBlock): boolean {
	return SUBAGENT_RE.test(block.name) || /^(task|subagent)\b/i.test(block.title ?? '') || isSubagentToolName(block.name, block.title)
		|| voltTaskToolOf(block.name, block.title, block.input) === DELEGATE_TASK_TOOL_NAME;
}

export function buildTranscriptRows(segments: readonly AgentSegment[] | undefined, fallbackText: string | undefined, streaming: boolean, steers: readonly ITranscriptSteer[] = []): TranscriptRow[] {
	const source: readonly AgentSegment[] = segments?.length
		? segments
		: (fallbackText ? [{ kind: 'text', text: fallbackText }] : []);
	const rows: TranscriptRow[] = [];
	let pending: ITranscriptStep[] = [];
	let reply = '';
	let groupIndex = 0;
	let textIndex = 0;
	let stepIndex = 0;
	const nextStepId = () => `step-${stepIndex++}`;
	const pendingSteers = steers.filter(steer => steer.text.trim()).slice().sort((a, b) => a.at - b.at);
	let steerIndex = 0;
	const pendingVisuals: IVisualBlock[] = [];
	const flushSteers = (before: number) => {
		while (pendingSteers.length && pendingSteers[0].at <= before) {
			const steer = pendingSteers.shift()!;
			flushReply();
			flushSteps();
			rows.push({ kind: 'steer', id: `steer-${steerIndex++}`, text: steer.text.trim() });
		}
	};

	const flushSteps = () => {
		if (!pending.length) {
			return;
		}
		if (pending.every(step => step.kind === 'thought')) {
			// Reasoning straight before an answer is its own "Thought 4s" row.
			rows.push({ kind: 'thought', id: `thought-${groupIndex++}`, step: mergeThoughts(pending), live: false });
		} else {
			rows.push({ kind: 'steps', id: `steps-${groupIndex++}`, steps: pending, live: false });
		}
		pending = [];
	};

	const flushReply = () => {
		const text = reply.trim();
		reply = '';
		if (!text) {
			return;
		}
		flushSteps();
		for (const block of splitMarkdownToBlocks(text, `md-${textIndex++}`)) {
			if (block.type === 'markdown') {
				rows.push({ kind: 'markdown', id: block.id, content: block.content });
			} else {
				rows.push({ kind: 'block', block });
			}
		}
	};

	// A subagent call is drawn once, as its subagent row; the generic step its activity would add goes.
	const subagentCalls = new Set(source.flatMap(segment => segment.kind === 'block' && segment.block.type === 'tool' && isSubagentTool(segment.block) ? [segment.block.callId] : []));
	for (const [segmentIndex, segment] of source.entries()) {
		flushSteers(segmentIndex);
		if (segment.kind === 'activity' && segment.item.callId && subagentCalls.has(segment.item.callId)) {
			continue;
		}
		switch (segment.kind) {
			case 'thought': {
				flushReply();
				const ms = segment.startedAt !== undefined ? Math.max(0, (segment.updatedAt ?? segment.startedAt) - segment.startedAt) : undefined;
				const last = pending.at(-1);
				if (last?.kind === 'thought') {
					pending[pending.length - 1] = thoughtStep(last.id, joinText(last.text ?? '', segment.text), addMs(thoughtMs(last), ms));
				} else {
					pending.push(thoughtStep(nextStepId(), segment.text, ms));
				}
				break;
			}
			case 'activity': {
				if (segment.item.hidden) {
					break;
				}
				flushReply();
				pending.push(activityStep(nextStepId(), segment.item));
				if (streaming) {
					const placeholder = pendingVisualBlock(segment.item, source, segmentIndex);
					if (placeholder) {
						pendingVisuals.push(placeholder);
					}
				}
				break;
			}
			case 'compaction':
				flushReply();
				flushSteps();
				rows.push({ kind: 'compaction', id: `compaction-${segment.compaction.id}`, compaction: segment.compaction });
				break;
			case 'notice':
				flushReply();
				flushSteps();
				rows.push({ kind: 'notice', id: `notice-${textIndex++}`, severity: segment.severity, title: segment.title, ...(segment.description ? { description: segment.description } : {}), ...(segment.supervision ? { supervision: segment.supervision } : {}), ...(segment.sandbox ? { sandbox: segment.sandbox } : {}) });
				break;
			case 'text':
				for (const chunk of partitionAssistantText(segment.text)) {
					if (chunk.kind === 'thought') {
						flushReply();
						pending.push(thoughtStep(nextStepId(), chunk.text, undefined));
					} else {
						reply = reply ? `${reply}\n\n${chunk.text}` : chunk.text;
					}
				}
				break;
			case 'block': {
				flushReply();
				const block = segment.block;
				if (block.type === 'terminal') {
					// A command is its own card (title, command names, output tail), not a "Ran 1 command" fold.
					flushSteps();
					rows.push({ kind: 'block', block });
				} else if (block.type === 'file' && isPlanTool(block.path, undefined, block.input)) {
					// Older chats recorded cursor-agent's plan tool as an edit to a file named "Create Plan".
					flushSteps();
					const plan = parsePlanToolInput(block.input);
					rows.push({ kind: 'block', block: createPlanBlock({ id: block.id, callId: block.callId, input: block.input, name: plan.name, markdown: plan.plan ?? '', status: block.status }) });
				} else if (block.type === 'file') {
					// Older chats recorded Cursor's to-do tool as an edit to a file named "Update TODOs".
					if (!/(^|[\\/])update todos\b/i.test(block.path)) {
						pending.push(editStep(block));
					}
				} else if (block.type === 'tool') {
					if (isExploreTool(block.name, block.title)) {
						break;
					}
					if (isSubagentTool(block)) {
						flushSteps();
						rows.push({ kind: 'subagent', id: block.id, tool: block, live: block.status === 'streaming' });
					} else {
						pending.push(toolStep(block));
					}
				} else if (block.type === 'approval' && block.action !== 'question' && (block.decision || block.blocked)) {
					// A settled permission is history, not content.
					break;
				} else {
					flushSteps();
					rows.push({ kind: 'block', block });
				}
				break;
			}
		}
	}
	flushReply();
	flushSteps();
	flushSteers(Number.POSITIVE_INFINITY);
	// A chart or page still streaming in holds its place with a skeleton, below the work so far.
	for (const block of pendingVisuals) {
		rows.push({ kind: 'block', block });
	}
	const grouped = groupSubagents(rows);
	return streaming ? markLive(grouped) : grouped;
}

/** Two or more subagent rows in a row become one group card, as T3 and Cursor show parallel subagents. */
export function groupSubagents(rows: readonly TranscriptRow[]): TranscriptRow[] {
	const result: TranscriptRow[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (row.kind !== 'subagent') {
			result.push(row);
			continue;
		}
		const run: Extract<TranscriptRow, { kind: 'subagent' }>[] = [row];
		while (rows[index + 1]?.kind === 'subagent') {
			run.push(rows[++index] as Extract<TranscriptRow, { kind: 'subagent' }>);
		}
		if (run.length === 1) {
			result.push(row);
		} else {
			result.push({ kind: 'subagents', id: `subs-${run[0].id}`, items: run.map(item => ({ id: item.id, tool: item.tool, live: item.live })), live: run.some(item => item.live) });
		}
	}
	return result;
}

/**
 * A failed turn shows its error once, in the tray at its end: the inline error line that
 * carried the same text is dropped. Earlier supervisor findings stay where they happened.
 */
export function withoutFailureNotice(rows: readonly TranscriptRow[], failure: string | undefined): TranscriptRow[] {
	const text = failure?.trim();
	if (!text) {
		return [...rows];
	}
	return rows.filter(row => {
		if (row.kind === 'notice' && isSignInNotice(row.title, row.description)) {
			return true;
		}
		return !(row.kind === 'notice' && row.severity === 'error' && (row.title.trim() === text || text.includes(row.title.trim())));
	});
}

/** The sign-in card is already in the transcript, so the generic error tray would only repeat it. */
export function hasSignInNotice(rows: readonly TranscriptRow[]): boolean {
	return rows.some(row => row.kind === 'notice' && isSignInNotice(row.title, row.description));
}

/**
 * A sub-agent's line under its title: the step it is on while it works (from its progress
 * reports), then Completed, Failed or Stopped, as Cursor labels them.
 */
export function subagentStatus(tool: IToolBlock, live: boolean): { readonly text: string; readonly steps: number; readonly live: boolean } {
	const lines = (tool.output ?? '').split('\n').map(line => line.trim()).filter(Boolean);
	if (live) {
		return { text: lines.at(-1) ?? localize('voltAgent.subagent.working', "Working"), steps: lines.length, live: true };
	}
	if (tool.stopped) {
		return { text: localize('voltAgent.subagent.stopped', "Stopped"), steps: 0, live: false };
	}
	return {
		text: tool.status === 'error' ? localize('voltAgent.subagent.failed', "Failed") : localize('voltAgent.subagent.completed', "Completed"),
		steps: 0,
		live: false,
	};
}

/** While streaming, the newest group (or thought) is live: its verbs read "Exploring", "Thinking", "Running". */
function markLive(rows: TranscriptRow[]): TranscriptRow[] {
	const last = rows.at(-1);
	if (last?.kind === 'steps') {
		const steps = last.steps.map((step, index) => index === last.steps.length - 1 ? { ...step, live: isStepRunning(step) } : step);
		rows[rows.length - 1] = { ...last, steps, live: true };
	} else if (last?.kind === 'thought') {
		rows[rows.length - 1] = { ...last, live: true, step: { ...last.step, live: true } };
	}
	return rows;
}

function isStepRunning(step: ITranscriptStep): boolean {
	if (step.terminal) {
		return step.terminal.status === 'streaming';
	}
	if (step.file) {
		return step.file.status === 'streaming';
	}
	if (step.tool) {
		return step.tool.status === 'streaming';
	}
	return step.kind === 'thought';
}

function thoughtStep(id: string, text: string, ms: number | undefined): ITranscriptStep {
	return { id, kind: 'thought', action: localize('voltAgent.step.thought', "Thought"), detail: formatThoughtDuration(ms), text, ms };
}

function thoughtMs(step: ITranscriptStep): number | undefined {
	return step.ms;
}

function addMs(a: number | undefined, b: number | undefined): number | undefined {
	return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function mergeThoughts(steps: readonly ITranscriptStep[]): ITranscriptStep {
	let ms: number | undefined;
	let text = '';
	for (const step of steps) {
		ms = addMs(ms, thoughtMs(step));
		text = joinText(text, step.text ?? '');
	}
	return thoughtStep(steps[0].id, text, ms);
}

/** "4s" after a second of streamed reasoning, otherwise "briefly" (Cursor). */
export function formatThoughtDuration(ms: number | undefined): string {
	if (ms === undefined || ms < 1000) {
		return localize('voltAgent.step.briefly', "briefly");
	}
	return localize('voltAgent.step.seconds', "{0}s", Math.round(ms / 1000));
}

/**
 * A render_chart / render_html call that has not returned yet: a placeholder visual (no ref) the
 * transcript draws as a skeleton. Gone once the call returns or its visual block arrives.
 */
function pendingVisualBlock(item: IAgentActivityItem, source: readonly AgentSegment[], index: number): IVisualBlock | undefined {
	const tool = item.browserTool;
	if (!tool || tool === PREVIEW_HTML_TOOL_NAME || !(VISUAL_TOOL_NAMES as readonly string[]).includes(tool) || item.result !== undefined || item.error !== undefined) {
		return undefined;
	}
	if (source.slice(index + 1).some(segment => segment.kind === 'block' && segment.block.type === 'visual')) {
		return undefined;
	}
	const title = typeof item.hostArgs?.title === 'string' ? item.hostArgs.title : (/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(item.input ?? '')?.[1] ?? '');
	const height = typeof item.hostArgs?.height === 'number' ? item.hostArgs.height : undefined;
	return {
		id: `visual-pending-${item.callId ?? index}`,
		type: 'visual',
		status: 'streaming',
		kind: tool === RENDER_HTML_TOOL_NAME ? 'html' : 'chart',
		title,
		ref: '',
		...(height ? { height } : {}),
	};
}

function activityStep(id: string, item: IAgentActivityItem): ITranscriptStep {
	if (!item.browserTool && isSnapshotActivity(item)) {
		return { id, kind: 'snapshot', action: item.label || localize('voltAgent.step.tookScreenshot', "Took screenshot"), detail: item.detail, item };
	}
	if (item.browserTool && (VISUAL_TOOL_NAMES as readonly string[]).includes(item.browserTool) && item.browserTool !== PREVIEW_HTML_TOOL_NAME) {
		return { id, kind: 'visual', action: item.label, detail: item.detail, item };
	}
	if (item.browserTool) {
		return { id, kind: 'browser', action: item.label, detail: item.detail, item };
	}
	if (item.kind === 'browser') {
		// Web search and fetch are lookups, counted with searches as Cursor does; only the in-app browser counts as browser actions.
		return { id, kind: 'search', action: item.label, detail: item.detail, item };
	}
	if (item.kind === 'thought') {
		return thoughtStep(id, item.text ?? '', undefined);
	}
	return { id, kind: item.kind, action: item.label, detail: cleanDetail(item.detail), item };
}

/** Drops a bogus " in <scope>" that older chats derived from half-streamed glob input. */
function cleanDetail(detail: string | undefined): string | undefined {
	return detail?.replace(/\s+in\s+\S*[*?{}"'][^\s]*$/, '');
}

/** Diff stats per edit block, recomputed only when its content changes (the live turn re-renders every frame). */
const editStats = new WeakMap<IFileChangeBlock, { key: string; additions: number; deletions: number }>();

function statsFor(block: IFileChangeBlock): { additions: number; deletions: number } {
	const key = `${block.original?.length ?? -1}:${block.modified?.length ?? -1}:${block.unifiedDiff?.length ?? -1}:${block.additions ?? ''}:${block.deletions ?? ''}:${block.status}`;
	const cached = editStats.get(block);
	if (cached?.key === key) {
		return cached;
	}
	const stats = { key, ...computeChangeStats(fileChangeSource(block)) };
	editStats.set(block, stats);
	return stats;
}

function editStep(block: IFileChangeBlock): ITranscriptStep {
	const preview = statsFor(block);
	return {
		id: block.id,
		kind: 'edit',
		action: block.verb === 'Created' ? localize('voltAgent.step.created', "Created") : block.verb === 'Deleted' ? localize('voltAgent.step.deleted', "Deleted") : localize('voltAgent.step.edited', "Edited"),
		detail: basename(block.path),
		additions: preview.additions,
		deletions: preview.deletions,
		file: block,
	};
}

function toolStep(block: IToolBlock): ITranscriptStep {
	const label = (block.title || block.name).trim();
	const mcp = /^(?:mcp[:_\s]+)?([\w.-]+)[:_\s-]+(\w+)$/i.exec(label);
	return {
		id: block.id,
		kind: 'tool',
		action: localize('voltAgent.step.called', "Called"),
		detail: mcp ? `${mcp[2]}` : label,
		tool: block,
	};
}

export interface IStepsTitle {
	readonly action: string;
	readonly detail: string;
	readonly additions: number;
	readonly deletions: number;
}

/**
 * The group line. Edits lead ("Edited stats.js, explored 1 file, ran 2 commands"), then
 * exploration ("Explored 5 files, 3 searches"), then commands and browser work
 * ("Ran 8 browser actions"). A thoughts-only group reads "Thought 6s".
 */
export function stepsGroupTitle(steps: readonly ITranscriptStep[], live: boolean): IStepsTitle {
	const edited = new Set<string>();
	let reads = 0, searches = 0, browsers = 0, commands = 0, visuals = 0, additions = 0, deletions = 0;
	for (const step of steps) {
		switch (step.kind) {
			case 'edit':
				edited.add(step.file?.path ?? step.detail ?? step.id);
				additions += step.additions ?? 0;
				deletions += step.deletions ?? 0;
				break;
			case 'read':
				reads++;
				break;
			case 'search':
				searches++;
				break;
			case 'browser':
			case 'snapshot':
				browsers++;
				break;
			case 'run':
				commands++;
				break;
			case 'visual':
				visuals++;
				break;
		}
	}
	const made = visuals ? (visuals === 1 ? localize('voltAgent.count.madeVisual', "made 1 visual") : localize('voltAgent.count.madeVisuals', "made {0} visuals", visuals)) : '';
	const explore = countList([
		[reads, localize('voltAgent.count.file', "1 file"), localize('voltAgent.count.files', "{0} files", reads)],
		[searches, localize('voltAgent.count.search', "1 search"), localize('voltAgent.count.searches', "{0} searches", searches)],
		[browsers, localize('voltAgent.count.browser', "1 browser action"), localize('voltAgent.count.browsers', "{0} browser actions", browsers)],
	]);
	const ran = commands ? (commands === 1 ? localize('voltAgent.count.ranCommand', "ran 1 command") : localize('voltAgent.count.ranCommands', "ran {0} commands", commands)) : '';
	if (edited.size) {
		const first = edited.size === 1 ? basename([...edited][0]) : localize('voltAgent.count.files', "{0} files", edited.size);
		const detail = [first, explore ? localize('voltAgent.count.explored', "explored {0}", explore) : '', ran, made].filter(Boolean).join(', ');
		return { action: live ? localize('voltAgent.step.editing', "Editing") : localize('voltAgent.step.edited', "Edited"), detail, additions, deletions };
	}
	if (reads || searches) {
		return { action: live ? localize('voltAgent.step.exploring', "Exploring") : localize('voltAgent.step.explored', "Explored"), detail: [explore, ran, made].filter(Boolean).join(', '), additions, deletions };
	}
	if (commands || browsers) {
		const detail = countList([
			[commands, localize('voltAgent.count.command', "1 command"), localize('voltAgent.count.commands', "{0} commands", commands)],
			[browsers, localize('voltAgent.count.browser', "1 browser action"), localize('voltAgent.count.browsers', "{0} browser actions", browsers)],
		]);
		return { action: live ? localize('voltAgent.step.running', "Running") : localize('voltAgent.step.ran', "Ran"), detail: [detail, made].filter(Boolean).join(', '), additions, deletions };
	}
	if (visuals) {
		return { action: live ? localize('voltAgent.step.drawing', "Drawing") : localize('voltAgent.step.drew', "Drew"), detail: visuals === 1 ? localize('voltAgent.count.visual', "1 visual") : localize('voltAgent.count.visuals', "{0} visuals", visuals), additions, deletions };
	}
	if (steps.every(step => step.kind === 'thought')) {
		const merged = mergeThoughts(steps);
		return { action: live ? localize('voltAgent.step.thinking', "Thinking") : merged.action, detail: live ? '' : (merged.detail ?? ''), additions, deletions };
	}
	const lead = steps.find(step => step.kind !== 'thought') ?? steps[0];
	return { action: lead.action, detail: lead.detail ?? '', additions, deletions };
}

function countList(entries: ReadonlyArray<[number, string, string]>): string {
	return entries.filter(([count]) => count > 0).map(([count, one, many]) => count === 1 ? one : many).join(', ');
}

/**
 * Splits a finished turn for Cursor's "Worked for 3m 3s" fold: everything before the final
 * answer goes inside, the trailing answer stays visible. Turns without tool work stay flat.
 */
export function splitWorkedRows(rows: readonly TranscriptRow[]): { work: TranscriptRow[]; answer: TranscriptRow[] } {
	if (!rows.some(row => row.kind === 'steps' || row.kind === 'subagent' || row.kind === 'subagents' || isTerminalRow(row))) {
		return { work: [], answer: [...rows] };
	}
	let start = rows.length;
	while (start > 0 && isAnswerRow(rows[start - 1])) {
		start--;
	}
	// Charts and pages the agent showed sit right above its answer, even when it kept working after.
	const work = rows.slice(0, start);
	const visuals = work.filter(isVisualRow);
	return { work: visuals.length ? work.filter(row => !isVisualRow(row)) : work, answer: [...visuals, ...rows.slice(start)] };
}

function isVisualRow(row: TranscriptRow): boolean {
	return row.kind === 'block' && row.block.type === 'visual';
}

function isTerminalRow(row: TranscriptRow): boolean {
	return row.kind === 'block' && row.block.type === 'terminal';
}

function isAnswerRow(row: TranscriptRow): boolean {
	if (row.kind === 'markdown') {
		return true;
	}
	return row.kind === 'block' && row.block.type !== 'approval' && row.block.type !== 'terminal';
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
