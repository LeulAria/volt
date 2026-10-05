/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentTranscript.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { extname } from '../../../../../base/common/path.js';
import { localize } from '../../../../../nls.js';
import { AgentBlock, IAgentActivityItem, IToolBlock } from '../blocks/agentBlocks.js';
import { appendHighlightedShell, IBlockRenderContext, renderMarkdownInto } from '../blocks/agentBlockRenderers.js';
import { highlightCodeLines } from '../blocks/agentCodeBlock.js';
import { computeFileChangePreview, IFileChangePreviewLine } from '../review/fileChangePreviewModel.js';
import { fileChangeSource, formatElapsed, ITodoChecklist } from './agentTimeline.js';
import { ITranscriptStep, splitWorkedRows, stepsGroupTitle, subagentStatus, TranscriptRow } from './agentTranscript.js';
import { ISubagentRowOptions, ISubagentView, renderCursorSubagentRow } from './agentSubagents.js';
import type { AgentTooltip } from './agentTooltip.js';

/** What the transcript needs from the editor that owns it. */
export interface ITranscriptHost {
	readonly store: DisposableStore;
	readonly ctx: IBlockRenderContext;
	/** Stored open/closed state for a collapsible, or undefined when the user never toggled it. */
	isExpanded(id: string): boolean | undefined;
	setExpanded(id: string, expanded: boolean): void;
	openFile(path: string, startLine?: number, endLine?: number): void;
	/** Browser rows open their action detail, screenshot rows the image, read rows the file. */
	openStepItem(item: IAgentActivityItem): void;
	/** Draws a shimmering status phrase (the tail "Reading store.js", "Planning next moves"). */
	renderStatus(parent: HTMLElement, key: string, text: string): void;
	renderBlock(parent: HTMLElement, block: AgentBlock): void;
	renderNotice(parent: HTMLElement, row: Extract<TranscriptRow, { kind: 'notice' }>): void;
	setSearchableText(el: HTMLElement, text: string): void;
	/** Hovering a search row lists the files it hit. */
	bindSearchHits?(el: HTMLElement, files: readonly string[]): void;
	/** A subagent row as the orchestrator knows it (live state, model, clock); undefined draws it from the tool call alone. */
	subagentView?(tool: IToolBlock, live: boolean): ISubagentView | undefined;
	openSubagent?(view: ISubagentView): void;
	stopSubagent?(view: ISubagentView): void;
	readonly subagentTooltip?: AgentTooltip;
}

export interface ITranscriptRenderOptions {
	readonly streaming: boolean;
	/** Status phrase for the live tail line. */
	readonly status?: string;
	/** A finished turn's total time, for "Worked for 3m 3s". */
	readonly workedMs?: number;
	/** Whether "Worked for" starts open: right after a live run, as Cursor does. Reopened chats start closed. */
	readonly workedOpenByDefault?: boolean;
	/** Stable key prefix for status-line motion. */
	readonly statusKey: string;
	/** The agent's to-do list for this turn, drawn as a checklist above the live line (collapsed once done). */
	readonly todos?: ITodoChecklist;
	/** When the running turn started: the live line shows a ticking elapsed time. */
	readonly elapsedSince?: number;
}

/** Class of the live elapsed label; the editor's one-second clock refreshes every element with it. */
export const ELAPSED_CLASS = 'volt-tr-elapsed';

/** Renders the rows; returns the reply elements so the caller can fade new text in. */
export function renderTranscript(parent: HTMLElement, rows: readonly TranscriptRow[], host: ITranscriptHost, options: ITranscriptRenderOptions): HTMLElement[] {
	const replies: HTMLElement[] = [];
	if (!options.streaming && options.workedMs !== undefined) {
		const { work, answer } = splitWorkedRows(rows);
		if (work.length) {
			const open = host.isExpanded('worked') ?? !!options.workedOpenByDefault;
			renderWorkedHeader(parent, options.workedMs, open, host);
			if (open) {
				for (const row of work) {
					renderRow(parent, row, host, options, replies);
				}
			}
			for (const row of answer) {
				renderRow(parent, row, host, options, replies);
			}
			if (options.todos) {
				renderTodoChecklist(parent, options.todos, false, host);
			}
			return replies;
		}
	}
	for (const row of rows) {
		renderRow(parent, row, host, options, replies);
	}
	if (options.todos) {
		renderTodoChecklist(parent, options.todos, options.streaming, host);
	}
	if (options.streaming) {
		const last = rows.at(-1);
		if (!last || last.kind === 'steps' || last.kind === 'thought' || last.kind === 'subagent' || last.kind === 'subagents' || last.kind === 'steer') {
			const tail = append(parent, $('.volt-tr-tail'));
			host.renderStatus(tail, `${options.statusKey}:tail`, tailPhrase(rows, options.status));
			if (options.elapsedSince !== undefined) {
				appendElapsed(tail, options.elapsedSince);
			}
		}
	}
	return replies;
}

/** "· 42s" after the live phrase; refreshed every second by the editor's clock. */
function appendElapsed(parent: HTMLElement, since: number): void {
	const elapsed = append(parent, $(`span.${ELAPSED_CLASS}`));
	elapsed.dataset.startedAt = String(since);
	elapsed.textContent = formatElapsed(Date.now() - since);
	elapsed.setAttribute('aria-label', localize('voltAgent.elapsedAria', "Running for {0}", elapsed.textContent));
}

/** Refreshes the live elapsed labels under `root`; called once a second while a turn runs. */
export function tickElapsed(root: HTMLElement, now = Date.now()): void {
	for (const el of root.querySelectorAll<HTMLElement>(`.${ELAPSED_CLASS}`)) {
		const started = Number(el.dataset.startedAt);
		if (Number.isFinite(started)) {
			el.textContent = formatElapsed(now - started);
		}
	}
}

/**
 * The agent's to-dos for the turn: open while it runs (the current one shimmers), folded to
 * Cursor's "3 of 3 To-dos Completed" afterwards.
 */
function renderTodoChecklist(parent: HTMLElement, todos: ITodoChecklist, live: boolean, host: ITranscriptHost): void {
	const open = host.isExpanded('todos') ?? live;
	const group = append(parent, $('.volt-tr-group.volt-tr-todos'));
	group.classList.toggle('live', live);
	const header = collapsibleHeader(group, open, true);
	const icon = append(header, $('span.volt-tr-todos-icon'));
	icon.appendChild(renderIcon(todos.done === todos.total ? Codicon.passFilled : Codicon.checklist));
	appendAction(header, todos.title, host);
	if (!open && live && todos.current) {
		appendDetail(header, todos.current, host);
	}
	appendChevron(header);
	host.store.add(addDisposableListener(header, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		host.setExpanded('todos', !open);
	}));
	if (!open) {
		return;
	}
	const list = append(group, $('ul.volt-tr-todo-list'));
	for (const item of todos.items) {
		const row = append(list, $(`li.volt-tr-todo.${item.state}`));
		const mark = append(row, $('span.volt-tr-todo-mark'));
		mark.appendChild(renderIcon(item.state === 'done' ? Codicon.passFilled : item.state === 'current' && live ? Codicon.loading : Codicon.circleLarge));
		const label = append(row, $('span.volt-tr-todo-label'));
		if (item.state === 'current' && live) {
			label.classList.add('shimmer');
		}
		host.setSearchableText(label, item.label);
	}
}

/** A message the user steered the running agent with, quoted where the agent picked it up. */
function renderSteerRow(parent: HTMLElement, row: Extract<TranscriptRow, { kind: 'steer' }>, host: ITranscriptHost): void {
	const el = append(parent, $('.volt-tr-steer'));
	const label = append(el, $('span.volt-tr-steer-label'));
	label.appendChild(renderIcon(Codicon.arrowRight));
	host.setSearchableText(append(label, $('span')), localize('voltAgent.steered', "Steered"));
	host.setSearchableText(append(el, $('span.volt-tr-steer-text')), row.text);
}

function renderRow(parent: HTMLElement, row: TranscriptRow, host: ITranscriptHost, options: ITranscriptRenderOptions, replies: HTMLElement[]): void {
	switch (row.kind) {
		case 'markdown': {
			const reply = append(parent, $('.volt-agent-reply'));
			renderMarkdownInto(reply, row.content, host.ctx);
			replies.push(reply);
			return;
		}
		case 'steps':
			renderStepsGroup(parent, row, host);
			return;
		case 'thought':
			renderThoughtRow(parent, row.id, row.step, row.live, host);
			return;
		case 'subagent': {
			const view = host.subagentView?.(row.tool, row.live);
			if (view) {
				renderCursorSubagentRow(parent, view, subagentOptions(host));
			} else {
				renderSubagentRow(parent, row.id, row.tool, row.live, host);
			}
			return;
		}
		case 'subagents': {
			// Cursor lists parallel subagents one under another, each with its own line.
			const holder = append(parent, $('.volt-tr-subagents'));
			for (const item of row.items) {
				renderCursorSubagentRow(holder, host.subagentView?.(item.tool, item.live) ?? fallbackSubagentView(item.tool, item.live), subagentOptions(host));
			}
			return;
		}
		case 'notice':
			host.renderNotice(parent, row);
			return;
		case 'steer':
			renderSteerRow(parent, row, host);
			return;
		case 'block':
			host.renderBlock(parent, row.block);
			return;
	}
}

/** "Worked for 3m 3s ⌄": the fold over everything before the final answer. */
function renderWorkedHeader(parent: HTMLElement, ms: number, open: boolean, host: ITranscriptHost): void {
	const group = append(parent, $('.volt-tr-group.worked'));
	const header = collapsibleHeader(group, open, true);
	appendAction(header, localize('voltAgent.worked', "Worked"), host);
	appendDetail(header, localize('voltAgent.workedFor', "for {0}", formatWorkedTime(ms)), host).classList.add('tertiary');
	appendChevron(header);
	host.store.add(addDisposableListener(header, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		host.setExpanded('worked', !open);
	}));
}

export function formatWorkedTime(ms: number): string {
	const total = Math.max(1, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) {
		return `${h}h ${m}m`;
	}
	if (m) {
		return `${m}m ${s}s`;
	}
	return `${s}s`;
}

function renderStepsGroup(parent: HTMLElement, row: Extract<TranscriptRow, { kind: 'steps' }>, host: ITranscriptHost): void {
	const title = stepsGroupTitle(row.steps, row.live);
	const open = host.isExpanded(row.id) ?? false;
	const group = append(parent, $('.volt-tr-group'));
	group.classList.toggle('live', row.live);
	const header = collapsibleHeader(group, open, true);
	appendAction(header, title.action, host);
	if (title.detail) {
		appendDetail(header, title.detail, host);
	}
	appendStats(header, title.additions, title.deletions);
	appendChevron(header);
	host.store.add(addDisposableListener(header, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		host.setExpanded(row.id, !open);
	}));
	if (!open) {
		return;
	}
	const body = append(group, $('.volt-tr-body'));
	for (const step of row.steps) {
		if (step.kind === 'thought') {
			renderThoughtRow(body, `${row.id}:${step.id}`, step, !!step.live, host);
		} else {
			renderStepRow(body, `${row.id}:${step.id}`, step, host);
		}
	}
}

function renderThoughtRow(parent: HTMLElement, id: string, step: ITranscriptStep, live: boolean, host: ITranscriptHost): void {
	const text = step.text?.trim();
	const open = !live && !!text && (host.isExpanded(id) ?? false);
	const group = append(parent, $('.volt-tr-group.thought'));
	group.classList.toggle('live', live);
	const header = collapsibleHeader(group, open, !live && !!text);
	if (live) {
		const action = append(header, $('span.volt-tr-action.shimmer'));
		host.setSearchableText(action, localize('voltAgent.step.thinking', "Thinking"));
		return;
	}
	appendAction(header, step.action, host);
	if (step.detail) {
		appendDetail(header, step.detail, host);
	}
	if (!text) {
		return;
	}
	appendChevron(header);
	host.store.add(addDisposableListener(header, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		host.setExpanded(id, !open);
	}));
	if (open) {
		const body = append(group, $('.volt-tr-body'));
		const reasoning = append(body, $('.volt-tr-thinking.volt-agent-thinking-text'));
		renderMarkdownInto(reasoning, text, host.ctx);
	}
}

function renderStepRow(parent: HTMLElement, id: string, step: ITranscriptStep, host: ITranscriptHost): void {
	const expandable = !!(step.terminal || step.file || (step.tool && (step.tool.output || step.tool.input)));
	const opensItem = !expandable && !!step.item && isOpenable(step.item);
	const open = expandable && (host.isExpanded(id) ?? false);
	const row = append(parent, $(`.volt-tr-group.step.${step.kind}`));
	row.classList.toggle('live', !!step.live);
	const header = collapsibleHeader(row, open, expandable || opensItem);
	const action = appendAction(header, step.live ? liveVerb(step) : step.action, host);
	if (step.live) {
		action.classList.add('shimmer');
	}
	if (step.detail) {
		appendDetail(header, step.detail, host);
	}
	appendStats(header, step.additions ?? 0, step.deletions ?? 0);
	const exitCode = step.terminal?.exitCode;
	if (step.terminal && step.terminal.status !== 'streaming' && ((exitCode !== undefined && exitCode !== 0) || step.terminal.status === 'error')) {
		append(header, $('span.volt-tr-exit')).textContent = localize('voltAgent.step.exitCode', "exit {0}", exitCode ?? 1);
	}
	if (step.item?.kind === 'search' && step.item.files?.length) {
		host.bindSearchHits?.(header, step.item.files);
	}
	if (expandable) {
		appendChevron(header);
	}
	if (expandable) {
		host.store.add(addDisposableListener(header, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			host.setExpanded(id, !open);
		}));
	} else if (opensItem && step.item) {
		const item = step.item;
		host.store.add(addDisposableListener(header, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			host.openStepItem(item);
		}));
	}
	if (!open) {
		return;
	}
	const body = append(row, $('.volt-tr-body'));
	if (step.terminal) {
		renderTerminalCard(body, step.terminal.command, step.terminal.output, host);
	} else if (step.file) {
		renderInlineDiff(body, step, host);
	} else if (step.tool) {
		renderToolOutput(body, step.tool);
	}
}

function isOpenable(item: IAgentActivityItem): boolean {
	return !!(item.browserTool || item.image || item.path);
}

function liveVerb(step: ITranscriptStep): string {
	switch (step.kind) {
		case 'run': return localize('voltAgent.step.running', "Running");
		case 'edit': return localize('voltAgent.step.editing', "Editing");
		case 'read': return localize('voltAgent.step.reading', "Reading");
		case 'search': return localize('voltAgent.step.searching', "Searching");
		default: return step.action;
	}
}

/** Cursor's command card: `$ cmd args` then the output, 13/18 Menlo, at most 200px before it scrolls. */
export function renderTerminalCard(parent: HTMLElement, command: string, output: string, host: ITranscriptHost): void {
	const card = append(parent, $('.volt-tr-terminal'));
	if (host.ctx.onTerminalMenu) {
		const menu = append(card, $('button.volt-tr-terminal-menu')) as HTMLButtonElement;
		menu.type = 'button';
		menu.title = localize('voltAgent.step.commandOptions', "Shell command options");
		menu.setAttribute('aria-label', menu.title);
		menu.setAttribute('aria-haspopup', 'menu');
		menu.appendChild(renderIcon(Codicon.ellipsis));
		host.store.add(addDisposableListener(menu, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			host.ctx.onTerminalMenu?.(menu, command);
		}));
	}
	const scroll = append(card, $('.volt-tr-terminal-scroll'));
	const commandLine = append(scroll, $('code.volt-tr-terminal-command.volt-agent-searchable'));
	append(commandLine, $('span.prompt')).textContent = '$ ';
	appendHighlightedShell(commandLine, command);
	const text = output.replace(/[\r\n]+$/, '');
	if (text) {
		const pre = append(scroll, $('pre.volt-tr-terminal-output.volt-agent-searchable'));
		pre.textContent = text;
	}
}

/** Cursor's edit diff: line numbers, +/- markers, a striped 4px strip, tinted rows, 3 lines of context. */
function renderInlineDiff(parent: HTMLElement, step: ITranscriptStep, host: ITranscriptHost): void {
	const file = step.file!;
	const preview = computeFileChangePreview(fileChangeSource(file), { contextLines: 3, maxLines: 4000 });
	const card = append(parent, $('.volt-tr-diff'));
	if (!preview.lines.length) {
		append(card, $('.volt-tr-diff-empty')).textContent = file.status === 'streaming'
			? localize('voltAgent.step.writing', "Writing…")
			: localize('voltAgent.step.noDiff', "No changes to show");
		return;
	}
	const rows: { line: IFileChangePreviewLine; text: HTMLElement }[] = [];
	let previous: IFileChangePreviewLine | undefined;
	for (const line of preview.lines) {
		if (previous && line.kind !== 'insert' && previous.kind !== 'insert' && line.lineNumber > previous.lineNumber + 1) {
			append(card, $('.volt-tr-diff-gap'));
		}
		const el = append(card, $(`.volt-tr-diff-line.${line.kind}`));
		el.addEventListener('dblclick', () => host.openFile(file.path, line.lineNumber));
		append(el, $('.volt-tr-diff-strip'));
		const gutter = append(el, $('.volt-tr-diff-gutter'));
		append(gutter, $('span.volt-tr-diff-num')).textContent = String(line.lineNumber);
		append(gutter, $('span.volt-tr-diff-ind')).textContent = line.kind === 'insert' ? '+' : line.kind === 'delete' ? '-' : '';
		const text = append(el, $('.volt-tr-diff-text.volt-agent-searchable'));
		text.textContent = line.text || '​';
		rows.push({ line, text });
		previous = line;
	}
	const alias = extname(file.path).replace(/^\./, '').toLowerCase();
	const languageService = host.ctx.languageService;
	if (!languageService || !alias) {
		return;
	}
	const source = rows.map(row => row.line.text).join('\n');
	const apply = (lines: Node[][]) => {
		rows.forEach((row, index) => {
			const nodes = lines[index];
			if (nodes?.length) {
				row.text.replaceChildren(...nodes);
			}
		});
	};
	const highlighted = highlightCodeLines(languageService, alias, source);
	if (highlighted.sync) {
		apply(highlighted.sync);
	} else {
		highlighted.done.then(lines => {
			if (card.isConnected) {
				apply(lines);
			}
		}, () => { /* plain text is fine */ });
	}
}

function renderToolOutput(parent: HTMLElement, tool: IToolBlock): void {
	const card = append(parent, $('.volt-tr-terminal.tool'));
	const scroll = append(card, $('.volt-tr-terminal-scroll'));
	if (tool.input) {
		const input = append(scroll, $('pre.volt-tr-terminal-command.volt-agent-searchable'));
		input.textContent = tool.input;
	}
	if (tool.output) {
		const output = append(scroll, $('pre.volt-tr-terminal-output.volt-agent-searchable'));
		output.textContent = tool.output;
	}
}

/**
 * A subagent: spinner while it works, its task as the title, its type in the quaternary tone,
 * and under it the step it is on (its latest progress report). Expanded, it lists the recent
 * steps while live and its report once done.
 */
function renderSubagentRow(parent: HTMLElement, id: string, tool: IToolBlock, live: boolean, host: ITranscriptHost): void {
	const row = append(parent, $('.volt-tr-subagent'));
	row.classList.toggle('live', live);
	row.classList.toggle('stopped', !live && !!tool.stopped);
	const state = subagentStatus(tool, live);
	const expandable = !!tool.output?.trim();
	const open = expandable && (host.isExpanded(`sub:${id}`) ?? false);
	const icon = append(row, $('span.volt-tr-subagent-icon'));
	icon.appendChild(renderIcon(live ? Codicon.loading : tool.stopped ? Codicon.debugStop : tool.status === 'error' ? Codicon.error : Codicon.check));
	const text = append(row, $('.volt-tr-subagent-text'));
	const head = append(text, $(expandable ? 'button.volt-tr-subagent-head' : '.volt-tr-subagent-head')) as HTMLElement;
	const input = parseJson(tool.input);
	const title = stringField(input, 'description') ?? tool.title ?? tool.name;
	const type = stringField(input, 'subagent_type') ?? stringField(input, 'subagentType');
	host.setSearchableText(append(head, $('span.volt-tr-subagent-title')), title);
	if (type) {
		host.setSearchableText(append(head, $('span.volt-tr-subagent-type')), subagentTypeLabel(type));
	}
	if (expandable) {
		(head as HTMLButtonElement).type = 'button';
		head.setAttribute('aria-expanded', String(open));
		row.classList.toggle('open', open);
		appendChevron(head);
		host.store.add(addDisposableListener(head, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			host.setExpanded(`sub:${id}`, !open);
		}));
	}
	const status = append(text, $('.volt-tr-subagent-status'));
	if (state.live) {
		status.classList.add('shimmer');
	}
	host.setSearchableText(status, state.text);
	if (state.live && state.steps > 1) {
		append(status, $('span.volt-tr-subagent-steps')).textContent = localize('voltAgent.subagent.steps', "{0} steps", state.steps);
	}
	if (open) {
		const body = append(text, $('pre.volt-tr-subagent-output.volt-agent-searchable'));
		body.textContent = tool.output!.trim();
	}
}

function subagentOptions(host: ITranscriptHost): ISubagentRowOptions {
	return {
		store: host.store,
		now: Date.now(),
		tooltip: host.subagentTooltip,
		onOpen: host.openSubagent,
		onStop: host.stopSubagent,
		setText: (el, text) => host.setSearchableText(el, text),
	};
}

/** A subagent row from its tool call alone (no orchestrator record: an old chat, or a harness Volt did not track). */
export function fallbackSubagentView(tool: IToolBlock, live: boolean): ISubagentView {
	const input = parseJson(tool.input);
	const args = input && typeof input.args === 'object' && input.args ? input.args as Record<string, unknown> : input;
	const title = stringField(args, 'description') ?? stringField(args, 'title') ?? tool.title?.replace(/^task:\s*/i, '') ?? tool.name;
	const type = stringField(args, 'subagent_type') ?? stringField(args, 'subagentType');
	const status = subagentStatus(tool, live);
	const state = live ? 'running' : tool.stopped ? 'cancelled' : tool.status === 'error' ? 'failed' : 'completed';
	return {
		key: tool.callId || tool.id,
		title,
		...(type ? { kindLabel: subagentTypeLabel(type) } : {}),
		state,
		stateLabel: live ? localize('voltAgent.subagent.running', "Running") : status.text,
		...(live ? { detail: status.text } : {}),
		openable: false,
		cancellable: false,
		source: 'harness',
	};
}

function subagentTypeLabel(type: string): string {
	const known: Record<string, string> = { explore: 'Explorer', generalPurpose: 'General', 'general-purpose': 'General', plan: 'Planner' };
	return known[type] ?? type.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) {
		return undefined;
	}
	// Some agents stream the arguments as successive snapshots ("{}{"title":…}{"title":…,"task":…}"): the last one is whole.
	for (const candidate of [text, text.slice(text.lastIndexOf('}{') + 1)]) {
		try {
			const value = JSON.parse(candidate);
			if (value && typeof value === 'object') {
				return value as Record<string, unknown>;
			}
		} catch {
			// try the next form
		}
	}
	return undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

/** The live tail: what the agent is doing right now. */
function tailPhrase(rows: readonly TranscriptRow[], status: string | undefined): string {
	const raw = (status ?? '').trim();
	if (raw && !/^(writing|thinking)$/i.test(raw)) {
		return raw;
	}
	const last = rows.at(-1);
	if (last?.kind === 'subagent' && last.live) {
		return localize('voltAgent.waitingForSubagent', "Waiting for subagent");
	}
	if (last?.kind === 'subagents' && last.live) {
		return localize('voltAgent.waitingForSubagents', "Waiting for subagents");
	}
	return raw || localize('voltAgent.planningNext', "Planning next moves");
}

function collapsibleHeader(parent: HTMLElement, open: boolean, interactive: boolean): HTMLElement {
	parent.classList.toggle('open', open);
	const header = append(parent, $(interactive ? 'button.volt-tr-header' : 'div.volt-tr-header')) as HTMLElement;
	if (interactive) {
		(header as HTMLButtonElement).type = 'button';
		header.setAttribute('aria-expanded', String(open));
	}
	return header;
}

function appendAction(header: HTMLElement, text: string, host: ITranscriptHost): HTMLElement {
	const action = append(header, $('span.volt-tr-action'));
	host.setSearchableText(action, text);
	return action;
}

function appendDetail(header: HTMLElement, text: string, host: ITranscriptHost): HTMLElement {
	const detail = append(header, $('span.volt-tr-details'));
	host.setSearchableText(detail, text);
	return detail;
}

function appendStats(header: HTMLElement, additions: number, deletions: number): void {
	if (!additions && !deletions) {
		return;
	}
	const stats = append(header, $('span.volt-tr-stats'));
	if (additions) {
		append(stats, $('span.add')).textContent = `+${additions}`;
	}
	if (deletions) {
		append(stats, $('span.del')).textContent = `-${deletions}`;
	}
}

function appendChevron(header: HTMLElement): void {
	const chevron = append(header, $('span.volt-tr-chevron'));
	chevron.appendChild(renderIcon(Codicon.chevronDown));
}
