/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltToolView } from '../../../../services/voltRuntime/common/events.js';
import { presentOutput, type OutputView } from '../../../../services/voltRuntime/common/harness/adaptiveOutput.js';
import type { IWorkCounts, ToolKind } from '../../../../services/voltRuntime/common/harness/workLog.js';

export type AgentBlockStatus = 'streaming' | 'complete' | 'error';

export type AgentBlockType = 'markdown' | 'code' | 'terminal' | 'table' | 'list' | 'cards' | 'chart' | 'mermaid' | 'tool' | 'file' | 'error' | 'approval';

export interface IAgentBaseBlock {
	readonly id: string;
	readonly type: AgentBlockType;
	status: AgentBlockStatus;
}

export interface IMarkdownBlock extends IAgentBaseBlock {
	readonly type: 'markdown';
	content: string;
}

export interface ICodeBlock extends IAgentBaseBlock {
	readonly type: 'code';
	language?: string;
	code: string;
}

export interface ITerminalBlock extends IAgentBaseBlock {
	readonly type: 'terminal';
	title?: string;
	command: string;
	output: string;
	cwd?: string;
	exitCode?: number;
	callId?: string;
	expanded: boolean;
}

export interface ITableBlock extends IAgentBaseBlock {
	readonly type: 'table';
	headers: string[];
	rows: string[][];
	caption?: string;
}

export interface IListBlock extends IAgentBaseBlock {
	readonly type: 'list';
	ordered: boolean;
	items: string[];
}

export interface ICardsBlock extends IAgentBaseBlock {
	readonly type: 'cards';
	items: { title: string; body: string; meta?: string }[];
}

export interface IChartBlock extends IAgentBaseBlock {
	readonly type: 'chart';
	labels: string[];
	values: number[];
	unit?: string;
	title?: string;
}

export interface IMermaidBlock extends IAgentBaseBlock {
	readonly type: 'mermaid';
	source: string;
}

export interface IToolBlock extends IAgentBaseBlock {
	readonly type: 'tool';
	callId: string;
	name: string;
	title?: string;
	input?: string;
	output?: string;
	expanded: boolean;
}

export type FileChangeVerb = 'Edited' | 'Created' | 'Deleted';

export interface IFileChangeBlock extends IAgentBaseBlock {
	readonly type: 'file';
	callId?: string;
	path: string;
	verb: FileChangeVerb;
	input?: string;
	output?: string;
	original?: string;
	modified?: string;
	unifiedDiff?: string;
	additions?: number;
	deletions?: number;
	expanded: boolean;
}

export interface IErrorBlock extends IAgentBaseBlock {
	readonly type: 'error';
	message: string;
}

export interface IApprovalBlock extends IAgentBaseBlock {
	readonly type: 'approval';
	requestId: string;
	action: string;
	resource: string;
	risk: string;
	reason?: string;
	pattern?: string;
	decision?: 'allow' | 'deny';
	scope?: 'once' | 'always';
	blocked?: boolean;
	policySource?: string;
}

export type AgentBlock =
	| IMarkdownBlock
	| ICodeBlock
	| ITerminalBlock
	| ITableBlock
	| IListBlock
	| ICardsBlock
	| IChartBlock
	| IMermaidBlock
	| IToolBlock
	| IFileChangeBlock
	| IErrorBlock
	| IApprovalBlock;

export function createApprovalBlock(partial: Omit<IApprovalBlock, 'type' | 'status'> & { status?: AgentBlockStatus }): IApprovalBlock {
	return {
		type: 'approval',
		status: partial.status ?? 'streaming',
		id: partial.id,
		requestId: partial.requestId,
		action: partial.action,
		resource: partial.resource,
		risk: partial.risk,
		reason: partial.reason,
		pattern: partial.pattern,
		decision: partial.decision,
		scope: partial.scope,
		blocked: partial.blocked,
		policySource: partial.policySource,
	};
}

export type AgentActivityKind = 'thought' | 'read' | 'search' | 'note' | 'wait' | 'browser';

export interface IAgentActivityItem {
	kind: AgentActivityKind;
	label: string;
	detail?: string;
	text?: string;
	path?: string;
	startLine?: number;
	endLine?: number;
	files?: string[];
	callId?: string;
	image?: string;
	input?: string;
	toolName?: string;
	toolTitle?: string;
	/** DeepSeek completed card. Drawn under the activity row. */
	view?: IVoltToolView;
}

export type AgentSegment =
	| { kind: 'text'; text: string }
	| { kind: 'block'; block: AgentBlock }
	| { kind: 'activity'; item: IAgentActivityItem }
	| { kind: 'thought'; text: string };

/**
 * What a reply actually did, counted from its segments. Feeds the status line
 * ("Edited 3 files · ran 2 commands") so the UI never hardcodes an outcome.
 */
export function workCountsForSegments(segments: readonly AgentSegment[]): IWorkCounts {
	const files = new Set<string>();
	let commands = 0, reads = 0, searches = 0, browser = 0, webFetches = 0, subagents = 0;
	for (const segment of segments) {
		if (segment.kind === 'block') {
			const block = segment.block;
			if (block.type === 'terminal') {
				commands++;
			} else if (block.type === 'file') {
				files.add(block.path);
			} else if (block.type === 'tool' && /\b(task|subagent|delegate|spawn)\b/i.test(block.name)) {
				subagents++;
			}
		} else if (segment.kind === 'activity') {
			switch (segment.item.kind) {
				case 'read': reads++; break;
				case 'search': searches++; break;
				case 'browser':
					if (/\b(fetch|webfetch|web fetch|url)\b/i.test(`${segment.item.label} ${segment.item.toolName ?? ''}`)) {
						webFetches++;
					} else {
						browser++;
					}
					break;
			}
		}
	}
	return { filesChanged: files.size, commands, reads, searches, browser, webFetches, subagents };
}

const SIZE_RE = /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|K|M|G)\s*$/i;
const SHELL_START_RE = /^(sudo\s+)?(ls|cd|pwd|find|grep|rg|cat|head|tail|git|npm|npx|pnpm|yarn|bun|make|echo|curl|wget|python3?|node|cargo|go|docker|kubectl|chmod|chown|rm|mv|cp|mkdir|touch|which|export|source|bash|zsh|sh|for|if)\b/;
const TERMINAL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'terminal', 'console', 'powershell', 'ps1', 'cmd', 'bat']);

export function isShellTool(name: string, title?: string, input?: string, kind?: ToolKind): boolean {
	if (kind === 'execute') {
		return true;
	}
	if (kind) {
		return false;
	}
	const s = `${name} ${title ?? ''}`.toLowerCase();
	if (/\b(term|shell|bash|zsh|sh|cmd|exec|execute|command|run|process|stdout)\b/.test(s)) {
		return true;
	}
	const command = parseShellToolInput(input).command;
	return !!command && looksLikeShell(command);
}

export function looksLikeShell(code: string): boolean {
	const first = unwrapShellMarkup(code).split('\n')[0] ?? '';
	return SHELL_START_RE.test(first) || first.startsWith('./') || first.startsWith('~/');
}

export function stringifyToolResult(result: unknown): string {
	if (result === undefined || result === null) {
		return '';
	}
	if (typeof result === 'string') {
		return result;
	}
	if (Array.isArray(result)) {
		return result.map(stringifyToolResult).filter(Boolean).join('\n');
	}
	if (typeof result === 'object') {
		const o = result as Record<string, unknown>;
		if (typeof o.text === 'string') {
			return o.text;
		}
		if (o.content !== undefined && o.content !== null) {
			return stringifyToolResult(o.content);
		}
		if (typeof o.output === 'string') {
			return o.output;
		}
		if (typeof o.stdout === 'string') {
			return o.stdout;
		}
		try {
			return JSON.stringify(result, null, 2);
		} catch {
			return String(result);
		}
	}
	return String(result);
}

export function extractToolInput(value: unknown): string | undefined {
	return parseShellToolInput(value).command || undefined;
}

export function parseShellToolInput(value: unknown): { command: string; cwd?: string; title?: string } {
	if (typeof value === 'string' && value.trim()) {
		const trimmed = value.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				return parseShellToolInput(JSON.parse(trimmed));
			} catch {
				return { command: stripPrompt(trimmed) };
			}
		}
		return { command: stripPrompt(trimmed) };
	}
	if (!value || typeof value !== 'object') {
		return { command: '' };
	}
	const o = Array.isArray(value) ? (value[0] as Record<string, unknown> | undefined) : value as Record<string, unknown>;
	if (!o || typeof o !== 'object') {
		return { command: '' };
	}
	const command = pickString(o, ['command', 'cmd', 'script', 'code']) ?? '';
	const cwd = pickString(o, ['cwd', 'workdir', 'working_directory', 'workingDirectory']);
	const title = pickString(o, ['title', 'description', 'summary', 'purpose']);
	if (command) {
		return { command: stripPrompt(command), cwd, title };
	}
	try {
		return { command: JSON.stringify(value), cwd, title };
	} catch {
		return { command: '', cwd, title };
	}
}

export function firstCommandName(command: string): string {
	const word = stripPrompt(command).split(/[\s;|&]+/).find(part => part && !part.includes('=') && !part.startsWith('-')) ?? '';
	return word.replace(/^\.\//, '');
}

export function humanTerminalTitle(title: string | undefined, command: string): string {
	const t = stripTrailingCommandList(stripPrompt(title?.trim() ?? ''));
	if (isDescriptiveTerminalTitle(t) && t.toLowerCase() !== stripPrompt(command).toLowerCase()) {
		return t;
	}
	return describeShellCommand(command) || firstCommandName(command) || 'Command';
}

export function terminalCommandLabels(command: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const part of stripPrompt(command).split(/\s*(?:&&|\|\||[;|])\s*/)) {
		const name = firstCommandName(part);
		if (!name || NOISE_COMMANDS.has(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	if (names.length <= 2) {
		return names;
	}
	return [names[0], names[names.length - 1]];
}

function isDescriptiveTerminalTitle(text: string): boolean {
	if (!text || GENERIC_SHELL_TITLE_RE.test(text) || looksLikeCommandLine(text)) {
		return false;
	}
	return text.split(/\s+/).filter(Boolean).length >= 2 && text.length >= 8;
}

function stripTrailingCommandList(title: string): string {
	return title
		.replace(/\s*`[^`]+`\s*$/, '')
		.replace(/\s+[a-z][\w.-]*(?:\s*,\s*[a-z][\w.-]*)+$/i, '')
		.trim();
}

function looksLikeCommandLine(text: string): boolean {
	const trimmed = stripPrompt(text);
	if (/[|&;]/.test(trimmed) || /\s-\w/.test(trimmed)) {
		return true;
	}
	return !/\s/.test(trimmed) && (!!firstCommandName(trimmed) && (SHELL_START_RE.test(trimmed) || GENERIC_SHELL_TITLE_RE.test(trimmed)));
}

function describeShellCommand(command: string): string {
	const raw = stripPrompt(command);
	if (!raw) {
		return '';
	}
	const whole = raw.toLowerCase();
	const first = firstCommandName(raw).toLowerCase();
	if (!first) {
		return '';
	}

	if (first === 'ls' || (/\bls\b/.test(whole) && first === 'find')) {
		return describeLsPipeline(whole);
	}
	if (first === 'find') {
		return describeFind(whole);
	}
	if (first === 'grep' || first === 'rg') {
		return 'Search files';
	}
	if (first === 'git') {
		return describeGit(raw);
	}
	if (first === 'cat' || first === 'bat') {
		return 'Read file';
	}
	if (first === 'head') {
		return 'Show first lines';
	}
	if (first === 'tail') {
		return 'Show last lines';
	}
	if (first === 'pwd') {
		return 'Print working directory';
	}
	if (first === 'cd') {
		return 'Change directory';
	}
	if (first === 'du') {
		return 'Show disk usage';
	}
	if (first === 'ps') {
		return 'List processes';
	}
	if (first === 'curl' || first === 'wget') {
		return 'Fetch URL';
	}
	if (first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'bun') {
		return describeNodePkg(raw, first);
	}
	if (first === 'make') {
		return 'Run make';
	}
	if (first === 'docker') {
		return 'Run docker';
	}
	if (first === 'kubectl') {
		return 'Run kubectl';
	}
	if (first === 'python' || first === 'python3' || first === 'node') {
		if (/http\.server/.test(whole)) {
			const port = whole.match(/http\.server\s+(\d{2,5})/);
			return port ? `Start HTTP server on ${port[1]}` : 'Start HTTP server';
		}
		return `Run ${first}`;
	}
	return capitalizeCommandPhrase(first);
}

function describeLsPipeline(whole: string): string {
	const human = hasFlag(whole, 'h') || whole.includes('--human-readable');
	const bySize = hasFlag(whole, 'S') || /--sort=size|\bsort\b/.test(whole);
	const byTime = !bySize && (hasFlag(whole, 't') || /--sort=time/.test(whole));
	let title = 'List files';
	if (bySize) {
		title += ' sorted by size';
	} else if (byTime) {
		title += ' sorted by modification time';
	}
	if (human) {
		title += ' with human-readable sizes';
	}
	return title;
}

function describeFind(whole: string): string {
	if (/\bsort\b/.test(whole) && /size|human/.test(whole)) {
		return 'Find files sorted by size';
	}
	if (whole.includes('-name') || whole.includes('-iname')) {
		return 'Find files by name';
	}
	if (whole.includes('-type f')) {
		return 'Find files';
	}
	if (whole.includes('-type d')) {
		return 'Find directories';
	}
	return 'Find files';
}

function describeGit(command: string): string {
	const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
	switch (sub) {
		case 'status': return 'Show git status';
		case 'log': return 'Show git history';
		case 'diff': return 'Show git diff';
		case 'add': return 'Stage files';
		case 'commit': return 'Create git commit';
		case 'push': return 'Push to remote';
		case 'pull': return 'Pull from remote';
		case 'checkout':
		case 'switch': return 'Switch git branch';
		case 'branch': return 'List git branches';
		case 'clone': return 'Clone repository';
		default: return sub ? `Run git ${sub}` : 'Run git';
	}
}

function describeNodePkg(command: string, bin: string): string {
	const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
	if (sub === 'i' || sub === 'install' || sub === 'add') {
		return 'Install packages';
	}
	if (sub === 'test') {
		return 'Run tests';
	}
	if (sub === 'run' || sub === 'start' || sub === 'dev' || sub === 'build') {
		return `Run ${bin} ${sub === 'run' ? (command.trim().split(/\s+/)[2] ?? 'script') : sub}`;
	}
	return `Run ${bin}`;
}

function hasFlag(command: string, flag: string): boolean {
	const long = new Set(['type', 'name', 'iname', 'path', 'print', 'exec', 'size', 'maxdepth', 'mindepth']);
	return command.split(/\s+/).some(token => {
		if (!/^-[a-zA-Z]{1,5}$/.test(token) || long.has(token.slice(1))) {
			return false;
		}
		return token.includes(flag);
	});
}

function capitalizeCommandPhrase(command: string): string {
	return command.charAt(0).toUpperCase() + command.slice(1);
}

export function outputLineLabel(output: string): string | undefined {
	if (!output.trim()) {
		return undefined;
	}
	const count = output.replace(/\n$/, '').split('\n').length;
	return count > 8 ? '8+' : String(count);
}

export function cwdDisplayName(cwd: string | undefined): string | undefined {
	if (!cwd?.trim()) {
		return undefined;
	}
	const trimmed = cwd.trim().replace(/[\\/]+$/, '');
	if (trimmed === '~' || trimmed === '$HOME') {
		return '~';
	}
	const base = trimmed.split(/[\\/]/).pop();
	return base || trimmed;
}

function stripPrompt(command: string): string {
	return command.replace(/^[\$%>#]+_?\s*/, '').trim();
}

const GENERIC_SHELL_TITLE_RE = /^(bash|sh|zsh|fish|shell|terminal|cmd|command|exec|execute|run|process|stdout|run_terminal_cmd|run_command|shell_command)$/i;
const NOISE_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':', 'tee', 'xargs', 'awk', 'sed', 'tr', 'cut', 'uniq', 'wc']);

export function createTerminalBlock(partial: Omit<ITerminalBlock, 'type' | 'status' | 'expanded'> & { status?: AgentBlockStatus; expanded?: boolean }): ITerminalBlock {
	return {
		type: 'terminal',
		status: partial.status ?? 'streaming',
		expanded: partial.expanded ?? false,
		id: partial.id,
		title: partial.title,
		command: partial.command,
		output: partial.output,
		cwd: partial.cwd,
		exitCode: partial.exitCode,
		callId: partial.callId,
	};
}

export function createToolBlock(partial: Omit<IToolBlock, 'type' | 'status' | 'expanded'> & { status?: AgentBlockStatus; expanded?: boolean }): IToolBlock {
	return {
		type: 'tool',
		status: partial.status ?? 'streaming',
		expanded: partial.expanded ?? false,
		id: partial.id,
		callId: partial.callId,
		name: partial.name,
		title: partial.title,
		input: partial.input,
		output: partial.output,
	};
}

export function createFileChangeBlock(partial: Omit<IFileChangeBlock, 'type' | 'status' | 'expanded'> & { status?: AgentBlockStatus; expanded?: boolean }): IFileChangeBlock {
	return {
		type: 'file',
		status: partial.status ?? 'streaming',
		expanded: partial.expanded ?? false,
		id: partial.id,
		callId: partial.callId,
		path: partial.path,
		verb: partial.verb,
		input: partial.input,
		output: partial.output,
		original: partial.original,
		modified: partial.modified,
		unifiedDiff: partial.unifiedDiff,
		additions: partial.additions,
		deletions: partial.deletions,
	};
}

export function findBlockByCallId(segments: AgentSegment[], callId: string): ITerminalBlock | IToolBlock | IFileChangeBlock | undefined {
	for (const segment of segments) {
		if (segment.kind !== 'block') {
			continue;
		}
		const block = segment.block;
		if ((block.type === 'terminal' || block.type === 'tool' || block.type === 'file') && block.callId === callId) {
			return block;
		}
	}
	return undefined;
}

export function findFileBlockByPath(segments: AgentSegment[], path: string): IFileChangeBlock | undefined {
	const needle = path.replace(/\\/g, '/');
	for (const segment of segments) {
		if (segment.kind !== 'block' || segment.block.type !== 'file') {
			continue;
		}
		if (segment.block.path.replace(/\\/g, '/') === needle || segment.block.path.endsWith(needle) || needle.endsWith(segment.block.path)) {
			return segment.block;
		}
	}
	return undefined;
}

export function appendTextDelta(segments: AgentSegment[], delta: string): void {
	const last = segments.at(-1);
	if (last?.kind === 'text') {
		last.text += delta;
		return;
	}
	segments.push({ kind: 'text', text: delta });
}

export function appendThoughtDelta(segments: AgentSegment[], delta: string): void {
	const last = segments.at(-1);
	if (last?.kind === 'thought') {
		last.text += delta;
		return;
	}
	segments.push({ kind: 'thought', text: delta });
}

export function splitMarkdownToBlocks(text: string, idPrefix: string): AgentBlock[] {
	const blocks: AgentBlock[] = [];
	let markdownIndex = 0;
	let specialIndex = 0;
	const markdownId = () => `${idPrefix}-md-${markdownIndex++}`;
	const specialId = () => `${idPrefix}-x-${specialIndex++}`;

	for (const view of presentOutput(text)) {
		blocks.push(...blocksFromOutputView(view, markdownId, specialId));
	}
	return blocks;
}

function blocksFromOutputView(view: OutputView, markdownId: () => string, specialId: () => string): AgentBlock[] {
	switch (view.kind) {
		case 'text':
			return splitTextWithShell(view.markdown, markdownId, specialId);
		case 'table':
			return [{
				id: specialId(),
				type: 'table',
				status: 'complete',
				headers: [...view.headers],
				rows: view.rows.map(row => [...row]),
				...(view.caption ? { caption: view.caption } : {}),
			}];
		case 'list':
			return [{
				id: specialId(),
				type: 'list',
				status: 'complete',
				ordered: view.ordered,
				items: [...view.items],
			}];
		case 'cards':
			return [{
				id: specialId(),
				type: 'cards',
				status: 'complete',
				items: view.items.map(item => ({ title: item.title, body: item.body, ...(item.meta ? { meta: item.meta } : {}) })),
			}];
		case 'chart':
			return [{
				id: specialId(),
				type: 'chart',
				status: 'complete',
				labels: [...view.labels],
				values: [...view.values],
				...(view.unit ? { unit: view.unit } : {}),
				...(view.title ? { title: view.title } : {}),
			}];
		case 'code':
			return [blockFromFence(specialId(), view.language, view.code, view.closed !== false)];
		case 'mermaid':
			return [{
				id: specialId(),
				type: 'mermaid',
				status: view.closed === false ? 'streaming' : 'complete',
				source: view.source,
			}];
	}
}

function splitTextWithShell(text: string, markdownId: () => string, specialId: () => string): AgentBlock[] {
	const blocks: AgentBlock[] = [];
	const lines = text.split('\n');
	let i = 0;
	let markdown: string[] = [];

	const flushMarkdown = () => {
		const content = markdown.join('\n').trim();
		markdown = [];
		if (!content) {
			return;
		}
		const unwrapped = unwrapShellMarkup(content);
		if (looksLikeShell(unwrapped) && looksLikeUnfencedShell(unwrapped.split('\n')[0] ?? unwrapped)) {
			const split = splitCommandAndOutput(unwrapped);
			blocks.push(createTerminalBlock({
				id: specialId(),
				status: 'complete',
				title: humanTerminalTitle(undefined, split.command),
				command: split.command,
				output: split.output,
			}));
			return;
		}
		blocks.push({
			id: markdownId(),
			type: 'markdown',
			status: 'complete',
			content,
		});
	};

	while (i < lines.length) {
		const line = lines[i];
		if (looksLikeUnfencedShell(line)) {
			flushMarkdown();
			const body = [line.replace(/^\$\s+/, '')];
			i++;
			while (i < lines.length && isShellContinuation(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			const split = splitCommandAndOutput(body.join('\n'));
			blocks.push(createTerminalBlock({
				id: specialId(),
				status: 'complete',
				title: humanTerminalTitle(undefined, split.command),
				command: split.command,
				output: split.output,
			}));
			continue;
		}
		markdown.push(line);
		i++;
	}

	flushMarkdown();
	return blocks;
}

export function collectBlocks(segments: AgentSegment[] | undefined, fallbackText?: string, streaming = false): AgentBlock[] {
	const source = segments?.length
		? segments
		: (fallbackText ? [{ kind: 'text' as const, text: fallbackText }] : []);
	const blocks: AgentBlock[] = [];
	for (const [index, segment] of source.entries()) {
		if (segment.kind === 'text') {
			blocks.push(...splitMarkdownToBlocks(segment.text, `s${index}`));
		} else if (segment.kind === 'block' && !isHiddenExploreToolBlock(segment.block)) {
			blocks.push(segment.block);
		}
	}
	return collapseShellDuplicates(blocks, streaming);
}

function collapseShellDuplicates(blocks: AgentBlock[], streaming: boolean): AgentBlock[] {
	if (streaming) {
		const last = blocks.at(-1);
		if (last?.type === 'markdown' && looksLikeShell(last.content)) {
			const split = splitCommandAndOutput(unwrapShellMarkup(last.content));
			blocks[blocks.length - 1] = createTerminalBlock({
				id: last.id,
				status: 'streaming',
				title: humanTerminalTitle(undefined, split.command),
				command: split.command,
				output: split.output,
			});
		} else if (last?.type === 'code' && looksLikeShell(last.code)) {
			const split = splitCommandAndOutput(last.code);
			blocks[blocks.length - 1] = createTerminalBlock({
				id: last.id,
				status: 'streaming',
				title: humanTerminalTitle(undefined, split.command),
				command: split.command,
				output: split.output,
			});
		} else if (last?.type === 'terminal' && !last.callId) {
			last.status = 'streaming';
		}
	}

	const terminals = blocks.filter((block): block is ITerminalBlock => block.type === 'terminal');
	const toolTerminals = terminals.filter(block => !!block.callId);
	const matchAgainst = toolTerminals.length ? toolTerminals : terminals;

	return blocks.filter((block, index) => {
		if (block.type === 'terminal') {
			if (block.callId || !toolTerminals.length) {
				return true;
			}
			return !toolTerminals.some(other => !other.command || commandsOverlap(other.command, block.command));
		}
		if (block.type === 'code') {
			return !isShellDump(block.code, matchAgainst);
		}
		if (block.type === 'markdown') {
			if (isShellDump(block.content, matchAgainst)) {
				return false;
			}
			const streamingTerminal = blocks.findIndex(candidate => candidate.type === 'terminal' && candidate.status === 'streaming');
			return !(streamingTerminal !== -1 && index < streamingTerminal && looksLikeShell(block.content));
		}
		return true;
	});
}

function isShellDump(text: string, terminals: ITerminalBlock[]): boolean {
	const unwrapped = unwrapShellMarkup(text);
	if (!unwrapped || !terminals.length) {
		return false;
	}
	return terminals.some(block => commandsOverlap(block.command, unwrapped));
}

function commandsOverlap(a: string, b: string): boolean {
	const left = normalizeCommand(a);
	const right = normalizeCommand(b);
	if (!left || !right) {
		return false;
	}
	return left === right || left.includes(right) || right.includes(left);
}

function normalizeCommand(value: string): string {
	return unwrapShellMarkup(value).replace(/\s+/g, ' ');
}

function unwrapShellMarkup(value: string): string {
	return value
		.trim()
		.replace(/^```[\w+-]*\s*/, '')
		.replace(/\s*```$/, '')
		.replace(/^`+|`+$/g, '')
		.replace(/^\$\s+/, '')
		.trim();
}

function looksLikeUnfencedShell(line: string): boolean {
	const trimmed = line.replace(/^\$\s+/, '').trim();
	if (!trimmed || /^[A-Z]/.test(trimmed)) {
		return false;
	}
	if (/^(if|for)\b/.test(trimmed) && !/^(if\s+[\[(]|if\s+test\b|for\s+\S+\s+in\b)/.test(trimmed)) {
		return false;
	}
	if (!looksLikeShell(trimmed)) {
		return false;
	}
	return /[|&;]/.test(trimmed) || /\s-\w/.test(trimmed);
}

function isShellContinuation(line: string): boolean {
	const trimmed = line.trim();
	return /^(\||&&|\|\||\\)/.test(trimmed) || line.startsWith('  ') || line.startsWith('\t');
}

export function blocksPlainText(blocks: AgentBlock[]): string {
	return blocks.map(block => {
		switch (block.type) {
			case 'markdown':
				return block.content;
			case 'code':
				return block.code;
			case 'terminal':
				return [block.command, block.output].filter(Boolean).join('\n');
			case 'table':
				return [block.headers.join(' | '), block.rows.map(row => row.join(' | ')).join('\n')].join('\n');
			case 'list':
				return block.items.map((item, index) => block.ordered ? `${index + 1}. ${item}` : `- ${item}`).join('\n');
			case 'cards':
				return block.items.map(item => [item.title, item.body, item.meta].filter(Boolean).join('\n')).join('\n\n');
			case 'chart':
				return block.labels.map((label, index) => `${label}: ${block.values[index]}${block.unit ?? ''}`).join('\n');
			case 'mermaid':
				return block.source;
			case 'tool':
				return [block.title ?? block.name, block.input, block.output].filter(Boolean).join('\n');
			case 'file':
				return [block.verb, block.path].filter(Boolean).join(' ');
			case 'error':
				return block.message;
			case 'approval':
				return [block.action, block.resource, block.reason].filter(Boolean).join('\n');
		}
	}).filter(Boolean).join('\n\n');
}

export function stripCellMarkup(value: string): string {
	return value.replace(/^[`*_]+|[`*_]+$/g, '').trim();
}

export function classifyTableCell(value: string, header?: string): 'file' | 'size' | 'rank' | 'number' | 'text' {
	const raw = stripCellMarkup(value);
	const head = (header ?? '').toLowerCase();
	if (SIZE_RE.test(raw) || head === 'size') {
		return 'size';
	}
	if (head === '#' || head === 'rank' || (/^\d+$/.test(raw) && raw.length <= 3 && !/file|path|name|population|price|value|count/.test(head))) {
		return 'rank';
	}
	if (head === 'file' || head === 'path' || isTableFileCell(raw) || (/^`/.test(value.trim()) && isTableFileCell(stripCellMarkup(value)))) {
		return 'file';
	}
	if (
		head === 'population' || head === 'price' || head === 'value' || head === 'count' || head === 'score' || head === 'share'
		|| /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?$/.test(raw)
		|| /^(?:[$\u20ac\u00a3\u00a5]|AED|USD|EUR|GBP|INR)\s*-?\d/i.test(raw)
		|| /^-?\d+(?:\.\d+)?%$/.test(raw)
	) {
		return 'number';
	}
	return 'text';
}

export function truncateMiddle(text: string, max = 44): string {
	if (text.length <= max) {
		return text;
	}
	const keep = Math.max(8, Math.floor((max - 1) / 2));
	return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

export function isPathLike(value: string): boolean {
	return /[\/\\]/.test(value) || /^\.[\w.]/.test(value) || /\.\w{1,8}$/.test(value);
}

/** A table cell is a file when it is one path token. A slash inside a sentence is not. */
function isTableFileCell(value: string): boolean {
	const text = value.trim();
	if (!text || /\s/.test(text) || !isPathLike(text)) {
		return false;
	}
	if (!/[/\\]/.test(text)) {
		return true;
	}
	return /^(?:~\/|\.\/|\.\.\/|\/|[A-Za-z]:[\\/])/.test(text)
		|| /\.[A-Za-z0-9]{1,8}$/.test(text)
		|| (text.match(/[/\\]/g)?.length ?? 0) >= 2;
}

export interface IAgentFileTarget {
	path: string;
	startLine?: number;
	endLine?: number;
}

// allow-any-unicode-next-line
const LINE_TAIL_RE = /(?:\s+|:)(?:#?L(?:ine)?\s*)?(\d+)(?:\s*[-–:]\s*(?:#?L(?:ine)?\s*)?(\d+))?\s*$/i;
const PATH_RE = /(?:^|[\s`"'(])((?:~\/|\.\/|\.\.\/|\/|[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]{1,8})/;
const VERB_RE = /^(Read|Reading|Grepped|Grep|Searched|Search|Edited|Edit|Created|Deleted|Wrote|Write|Explored|Waited|Navigated|Listed)\s+(.+)$/i;

export function parseFileTarget(...parts: Array<string | undefined>): IAgentFileTarget | undefined {
	for (const part of parts) {
		if (!part?.trim()) {
			continue;
		}
		const fromJson = parseJsonFileTarget(part);
		if (fromJson) {
			return fromJson;
		}
		const fromText = parseTextFileTarget(part);
		if (fromText) {
			return fromText;
		}
	}
	return undefined;
}

/**
 * Prefer the runtime's semantic `kind` when ACP or a native tool sent one. Name heuristics
 * remain for agents that still emit untitled "other" tools.
 */
export function classifyToolActivity(name: string, title?: string, kind?: ToolKind): AgentActivityKind {
	switch (kind) {
		case 'read': return 'read';
		case 'search': return 'search';
		case 'browser':
		case 'fetch': return 'browser';
		case 'think': return 'wait';
		case 'execute':
		case 'edit':
		case 'delegate': return 'note';
	}
	return classifyToolActivityByName(name, title);
}

function classifyToolActivityByName(name: string, title?: string): AgentActivityKind {
	const s = `${name} ${title ?? ''}`.toLowerCase().replace(/[_-]+/g, ' ');
	if (/\b(sleep|wait|delay)\b/.test(s)) {
		return 'wait';
	}
	if (/\b(browser|navigate|snapshot|web fetch|webfetch|simplebrowser)\b/.test(s)) {
		return 'browser';
	}
	if (/\b(search|grep|find|rg|glob)\b/.test(s)) {
		return 'search';
	}
	if (/\b(read|open|cat|view|file|list.?dir|list mcp)\b/.test(s) || isPathLike(title ?? name)) {
		return 'read';
	}
	return 'note';
}

const EXPLORE_TOOL_RE = /\b(find|glob|grep|rg|search|list.?dir|\bls\b|read.?file|\bread\b|cat|view|open.?file|sleep|wait|webfetch|web fetch|mcp|browser|navigate|snapshot|simplebrowser)\b/;
const MUTATING_TOOL_RE = /\b(edit|edited|write|wrote|create|created|delete|deleted|patch|apply|replace|str.?replace|update)\b/;

/** Read/search/browser tools belong in the activity trail, not as response-body pills. */
export function isExploreTool(name: string, title?: string, kind?: ToolKind): boolean {
	if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'browser' || kind === 'think') {
		return true;
	}
	if (kind === 'edit' || kind === 'execute' || kind === 'delegate') {
		return false;
	}
	const s = `${name} ${title ?? ''}`.toLowerCase().replace(/[_-]+/g, ' ');
	if (MUTATING_TOOL_RE.test(s)) {
		return false;
	}
	const activity = classifyToolActivityByName(name, title);
	return activity === 'read' || activity === 'search' || activity === 'wait' || activity === 'browser' || EXPLORE_TOOL_RE.test(s);
}

export function isFileChangeTool(name: string, title?: string, kind?: ToolKind): boolean {
	if (kind === 'edit') {
		return true;
	}
	if (kind) {
		return false;
	}
	const s = `${name} ${title ?? ''}`.toLowerCase().replace(/[_-]+/g, ' ');
	return MUTATING_TOOL_RE.test(s);
}

function isHiddenExploreToolBlock(block: AgentBlock): boolean {
	return block.type === 'tool' && isExploreTool(block.name, block.title);
}

export function splitActivityLabel(name: string, title?: string, target?: IAgentFileTarget): { label: string; detail?: string } {
	const raw = (title || name).trim();
	if (target) {
		const kind = classifyToolActivity(name, title);
		const file = target.path.split(/[\\/]/).pop() || target.path;
		const lines = target.startLine
			? ` L${target.startLine}${target.endLine && target.endLine !== target.startLine ? `-${target.endLine}` : ''}`
			: '';
		const verb = raw.match(VERB_RE);
		const label = kind === 'search'
			? 'Searched'
			: verb
				? capitalizeActivity(verb[1])
				: 'Read';
		return { label, detail: `${file}${lines}` };
	}
	const verb = raw.match(VERB_RE);
	if (verb && isPathLike(verb[2].trim())) {
		return { label: capitalizeActivity(verb[1]), detail: verb[2].trim() };
	}
	return { label: raw };
}

export function applyFileTargetToActivity(item: IAgentActivityItem, target: IAgentFileTarget | undefined): boolean {
	if (!target) {
		return false;
	}
	item.path = target.path;
	item.startLine = target.startLine;
	item.endLine = target.endLine;
	const split = splitActivityLabel(item.label, item.detail, target);
	item.label = split.label;
	item.detail = split.detail;
	return true;
}

export interface IExploreActivity {
	label: string;
	detail?: string;
	path?: string;
	startLine?: number;
	endLine?: number;
	files?: string[];
	clickable?: boolean;
}

const GENERIC_TOOL_TITLE_RE = /^(find|grep|rg|glob|search|read(\s+file)?|list(\s+dir(ectory)?)?|ls|cat|view|open(\s+file)?|wait|sleep|web\s*fetch)$/i;
const DETAIL_MAX = 56;

export function describeExploreActivity(name: string, title: string | undefined, input?: string): IExploreActivity {
	const kind = classifyToolActivity(name, title);
	const args = parseExploreArgs(input);
	const filePath = args.path && looksLikeFilePath(args.path) ? args.path : undefined;
	const scope = scopeLabel(args.directory || (!filePath ? args.path : undefined));
	const haystack = `${name} ${title ?? ''}`.toLowerCase();
	const grepTool = /\bgrep/.test(haystack);
	const findTool = /\b(find|glob)\b/.test(haystack) && !grepTool;

	if (kind === 'read' && (filePath || args.path) && !args.pattern && !args.glob && !args.query) {
		const file = basenamePath(filePath || args.path!);
		return {
			label: 'Read',
			detail: `${file}${formatLineRange(args.startLine, args.endLine)}`,
			path: filePath || args.path,
			startLine: args.startLine,
			endLine: args.endLine,
			files: args.files,
			clickable: true,
		};
	}

	if (findTool || (args.glob && !grepTool) || (args.query && !args.pattern && !grepTool && kind === 'search')) {
		const needle = args.glob || args.pattern || args.query;
		if (needle) {
			return {
				label: 'Searched files',
				detail: joinScope(truncateExploreDetail(needle), scope),
				path: filePath,
				files: args.files,
				clickable: !!filePath,
			};
		}
	}

	if (grepTool || args.pattern || (kind === 'search' && args.query)) {
		const needle = args.pattern || args.query;
		if (needle) {
			return {
				label: grepTool || args.pattern ? 'Grepped' : 'Searched files',
				detail: joinScope(truncateExploreDetail(needle), scope),
				path: filePath,
				startLine: args.startLine,
				endLine: args.endLine,
				files: args.files,
				clickable: !!filePath,
			};
		}
	}

	if (kind === 'wait') {
		const label = title && !GENERIC_TOOL_TITLE_RE.test(title.trim()) ? title.trim() : 'Waited';
		return { label };
	}

	if (title && !GENERIC_TOOL_TITLE_RE.test(title.trim())) {
		const verb = title.trim().match(VERB_RE);
		if (verb && isPathLike(verb[2].trim())) {
			const target = parseTextFileTarget(verb[2].trim());
			return {
				label: capitalizeActivity(verb[1]),
				detail: target ? `${basenamePath(target.path)}${formatLineRange(target.startLine, target.endLine)}` : verb[2].trim(),
				path: target?.path ?? filePath,
				startLine: target?.startLine ?? args.startLine,
				endLine: target?.endLine ?? args.endLine,
				clickable: !!(target?.path || filePath),
			};
		}
		return {
			label: title.trim(),
			path: filePath || args.path,
			startLine: args.startLine,
			endLine: args.endLine,
			clickable: !!filePath,
		};
	}

	const target = args.path ? { path: args.path, startLine: args.startLine, endLine: args.endLine } : undefined;
	const split = splitActivityLabel(name, title, target);
	return {
		...split,
		path: filePath || args.path,
		startLine: args.startLine,
		endLine: args.endLine,
		files: args.files,
		clickable: !!filePath,
	};
}

export function applyExploreInputToActivity(item: IAgentActivityItem, name: string, title: string | undefined, input?: string): boolean {
	item.toolName ??= name;
	item.toolTitle ??= title;
	const described = describeExploreActivity(item.toolName, item.toolTitle, input);
	const files = mergeActivityFiles(item.files, described.files);
	const changed = item.label !== described.label
		|| item.detail !== described.detail
		|| item.path !== described.path
		|| item.startLine !== described.startLine
		|| item.endLine !== described.endLine
		|| (files?.length ?? 0) !== (item.files?.length ?? 0);
	item.label = described.label;
	item.detail = described.detail;
	item.path = described.path ?? item.path;
	item.startLine = described.startLine ?? item.startLine;
	item.endLine = described.endLine ?? item.endLine;
	item.files = files;
	item.input = input;
	return changed;
}

export function applyExploreResultToActivity(item: IAgentActivityItem, result: unknown, input?: string): boolean {
	if (input) {
		applyExploreInputToActivity(item, item.toolName ?? item.label, item.toolTitle, input);
	}
	const files = mergeActivityFiles(item.files, parseExploreResultFiles(result));
	if (files?.length) {
		item.files = files;
	}
	if (item.kind === 'read' && !item.path && item.files?.[0]) {
		applyFileTargetToActivity(item, {
			path: item.files[0],
			startLine: item.startLine,
			endLine: item.endLine,
		});
	}
	return true;
}

export function parseExploreResultFiles(result: unknown): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	const add = (value?: string) => {
		if (!value) {
			return;
		}
		const path = value.replace(/^file:\/\//, '').trim();
		if (!path || seen.has(path) || (!looksLikeFilePath(path) && !isPathLike(path))) {
			return;
		}
		seen.add(path);
		files.push(path);
	};
	collectExploreResultPaths(result, add);
	return files;
}

export function isExploreItemClickable(item: IAgentActivityItem): boolean {
	if (item.kind === 'thought' || item.kind === 'wait' || item.kind === 'note') {
		return false;
	}
	if (item.image) {
		return true;
	}
	if (!item.path) {
		return false;
	}
	return item.kind === 'read' || item.startLine !== undefined || looksLikeFilePath(item.path);
}

function parseExploreArgs(input?: string): {
	path?: string;
	directory?: string;
	pattern?: string;
	glob?: string;
	query?: string;
	startLine?: number;
	endLine?: number;
	files?: string[];
} {
	if (!input?.trim()) {
		return {};
	}
	const target = parseFileTarget(input);
	const rec = parseJsonRecord(input);
	if (!rec) {
		return {
			path: target?.path,
			startLine: target?.startLine,
			endLine: target?.endLine,
		};
	}
	const path = pickString(rec, ['path', 'file', 'uri', 'target', 'filename', 'target_file', 'targetFile', 'file_path', 'filePath', 'relative_path', 'relativePath']);
	const directory = pickString(rec, ['target_directory', 'targetDirectory', 'directory', 'dir']);
	const pattern = pickString(rec, ['pattern', 'regex', 'regexp']);
	const glob = pickString(rec, ['glob', 'glob_pattern', 'globPattern', 'include', 'file_pattern', 'filePattern']);
	const query = pickString(rec, ['query', 'searchTerm', 'search_term', 'term', 'q']);
	const start = pickNumber(rec, ['offset', 'startLine', 'start_line', 'line', 'lineNumber', 'line_number']);
	const end = pickNumber(rec, ['endLine', 'end_line']);
	const limit = pickNumber(rec, ['limit', 'count']);
	return {
		path: path || target?.path,
		directory,
		pattern,
		glob,
		query,
		startLine: start ?? target?.startLine,
		endLine: end ?? (start && limit ? start + limit - 1 : target?.endLine),
		files: pickStringArray(rec, ['files', 'paths', 'uris']),
	};
}

function collectExploreResultPaths(value: unknown, add: (path: string) => void, depth = 0): void {
	if (depth > 6 || value === null || value === undefined) {
		return;
	}
	if (typeof value === 'string') {
		for (const line of value.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			const target = parseTextFileTarget(trimmed) ?? parseTextFileTarget(trimmed.replace(/:\d+.*$/, ''));
			if (target) {
				add(target.path);
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectExploreResultPaths(item, add, depth + 1);
		}
		return;
	}
	if (typeof value !== 'object') {
		return;
	}
	const rec = value as Record<string, unknown>;
	const path = pickString(rec, ['path', 'file', 'uri', 'target', 'filename', 'target_file', 'targetFile', 'file_path', 'filePath']);
	if (path) {
		add(path);
	}
	if (Array.isArray(rec.locations)) {
		collectExploreResultPaths(rec.locations, add, depth + 1);
	}
	if (rec.content !== undefined) {
		collectExploreResultPaths(rec.content, add, depth + 1);
	}
	if (typeof rec.text === 'string') {
		collectExploreResultPaths(rec.text, add, depth + 1);
	}
	if (Array.isArray(rec.files)) {
		collectExploreResultPaths(rec.files, add, depth + 1);
	}
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const o = Array.isArray(parsed) ? parsed[0] : parsed;
		return o && typeof o === 'object' ? o as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function mergeActivityFiles(current?: string[], next?: string[]): string[] | undefined {
	if (!current?.length && !next?.length) {
		return current ?? next;
	}
	const files: string[] = [];
	const seen = new Set<string>();
	for (const path of [...(current ?? []), ...(next ?? [])]) {
		if (!path || seen.has(path)) {
			continue;
		}
		seen.add(path);
		files.push(path);
	}
	return files.length ? files : undefined;
}

function looksLikeFilePath(value: string): boolean {
	const base = value.split(/[\\/]/).pop() ?? '';
	if (base.startsWith('.') && !base.slice(1).includes('.')) {
		return false;
	}
	return /\.\w{1,8}$/.test(base);
}

function scopeLabel(path?: string): string | undefined {
	if (!path) {
		return undefined;
	}
	const clean = path.replace(/[\\/]+$/, '').trim();
	if (!clean || clean === '.' || clean === './') {
		return undefined;
	}
	return clean.split(/[\\/]/).pop() || clean;
}

function basenamePath(path: string): string {
	return path.split(/[\\/]/).pop() || path;
}

function formatLineRange(start?: number, end?: number): string {
	if (!start) {
		return '';
	}
	return ` L${start}${end && end !== start ? `-${end}` : ''}`;
}

function joinScope(detail: string, scope?: string): string {
	return scope ? `${detail} in ${scope}` : detail;
}

function truncateExploreDetail(text: string, max = DETAIL_MAX): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, Math.max(8, max - 3))}...`;
}

function parseJsonFileTarget(value: string): IAgentFileTarget | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const o = Array.isArray(parsed) ? parsed[0] : parsed;
		if (!o || typeof o !== 'object') {
			return undefined;
		}
		const rec = o as Record<string, unknown>;
		const path = pickString(rec, ['path', 'file', 'uri', 'target', 'filename', 'target_file', 'targetFile', 'file_path', 'filePath', 'relative_path', 'relativePath']);
		if (!path) {
			return undefined;
		}
		const start = pickNumber(rec, ['offset', 'startLine', 'start_line', 'line', 'lineNumber', 'line_number']);
		const end = pickNumber(rec, ['endLine', 'end_line']);
		const limit = pickNumber(rec, ['limit', 'count']);
		return {
			path,
			startLine: start,
			endLine: end ?? (start && limit ? start + limit - 1 : undefined),
		};
	} catch {
		return undefined;
	}
}

function parseTextFileTarget(value: string): IAgentFileTarget | undefined {
	let text = value.trim().replace(/^["'`]+|["'`]+$/g, '');
	let startLine: number | undefined;
	let endLine: number | undefined;
	const lines = text.match(LINE_TAIL_RE);
	if (lines) {
		startLine = Number(lines[1]);
		endLine = lines[2] ? Number(lines[2]) : undefined;
		text = text.slice(0, lines.index).trim();
	}
	const pathMatch = text.match(PATH_RE);
	const path = (pathMatch?.[1] ?? (isPathLike(text) ? text : undefined))?.replace(/^["'`]+|["'`]+$/g, '');
	if (!path || !isPathLike(path)) {
		return undefined;
	}
	return { path, startLine, endLine };
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof o[key] === 'string' && o[key]) {
			return o[key] as string;
		}
	}
	return undefined;
}

function pickStringArray(o: Record<string, unknown>, keys: string[]): string[] | undefined {
	for (const key of keys) {
		if (!Array.isArray(o[key])) {
			continue;
		}
		const values = o[key].filter((value): value is string => typeof value === 'string' && !!value.trim());
		if (values.length) {
			return values;
		}
	}
	return undefined;
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const n = Number(o[key]);
		if (Number.isFinite(n) && n > 0) {
			return n;
		}
	}
	return undefined;
}

function capitalizeActivity(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function blockFromFence(id: string, language: string | undefined, code: string, closed: boolean): AgentBlock {
	const status: AgentBlockStatus = closed ? 'complete' : 'streaming';
	if (isTerminalLanguage(language) || looksLikeShell(code)) {
		const split = splitCommandAndOutput(code);
		return createTerminalBlock({
			id,
			status,
			title: humanTerminalTitle(undefined, split.command),
			command: split.command,
			output: split.output,
			expanded: false,
		});
	}
	return { id, type: 'code', status, language, code };
}

function isTerminalLanguage(language: string | undefined): boolean {
	return !!language && TERMINAL_LANGS.has(language.toLowerCase());
}

function splitCommandAndOutput(code: string): { command: string; output: string } {
	const lines = code.replace(/\n$/, '').split('\n');
	if (!lines.length) {
		return { command: '', output: '' };
	}
	const first = lines[0].replace(/^\$\s*/, '');
	if (lines.length > 1 && (lines[0].startsWith('$ ') || looksLikeOutput(lines[1]) || lines.some(line => /^total\s+\d+/.test(line)))) {
		return { command: first, output: lines.slice(1).join('\n') };
	}
	return { command: code.trim(), output: '' };
}

function looksLikeOutput(line: string): boolean {
	return /^[-dl][-rwxs]{9}/.test(line) || /^total\s+\d+/.test(line) || /^\s*\d+\s+\S+/.test(line);
}
