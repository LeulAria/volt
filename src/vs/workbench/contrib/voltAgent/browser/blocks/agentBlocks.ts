/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentBlockStatus = 'streaming' | 'complete' | 'error';

export type AgentBlockType = 'markdown' | 'code' | 'terminal' | 'table' | 'tool' | 'error' | 'approval';

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
	| IToolBlock
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

export type AgentSegment =
	| { kind: 'text'; text: string }
	| { kind: 'block'; block: AgentBlock };

const FENCE_OPEN_RE = /^(`{3,}|~{3,})([A-Za-z0-9_+-]*)(?:\s+(.*))?$/;
const TABLE_LINE_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const SIZE_RE = /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|K|M|G)\s*$/i;
const SHELL_START_RE = /^(sudo\s+)?(ls|cd|pwd|find|grep|rg|cat|head|tail|git|npm|npx|pnpm|yarn|bun|make|echo|curl|wget|python3?|node|cargo|go|docker|kubectl|chmod|chown|rm|mv|cp|mkdir|touch|which|export|source|bash|zsh|sh|for|if)\b/;
const TERMINAL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'terminal', 'console', 'powershell', 'ps1', 'cmd', 'bat']);

export function isShellTool(name: string, title?: string, input?: string): boolean {
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

export function findBlockByCallId(segments: AgentSegment[], callId: string): ITerminalBlock | IToolBlock | undefined {
	for (const segment of segments) {
		if (segment.kind !== 'block') {
			continue;
		}
		const block = segment.block;
		if ((block.type === 'terminal' || block.type === 'tool') && block.callId === callId) {
			return block;
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

export function splitMarkdownToBlocks(text: string, idPrefix: string): AgentBlock[] {
	const blocks: AgentBlock[] = [];
	const lines = text.split('\n');
	let i = 0;
	let markdown: string[] = [];
	let markdownIndex = 0;
	let specialIndex = 0;

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
				id: `${idPrefix}-x-${specialIndex++}`,
				status: 'complete',
				title: humanTerminalTitle(undefined, split.command),
				command: split.command,
				output: split.output,
			}));
			return;
		}
		blocks.push({
			id: `${idPrefix}-md-${markdownIndex++}`,
			type: 'markdown',
			status: 'complete',
			content,
		});
	};

	while (i < lines.length) {
		const line = lines[i];
		const fence = parseFenceLine(line);
		if (fence) {
			flushMarkdown();
			const body: string[] = [];
			if (fence.rest) {
				body.push(fence.rest);
			}
			i++;
			let closed = false;
			while (i < lines.length) {
				const close = parseFenceLine(lines[i]);
				if (close && close.marker[0] === fence.marker[0] && close.marker.length >= fence.marker.length && !close.language && !close.rest) {
					closed = true;
					i++;
					break;
				}
				body.push(lines[i]);
				i++;
			}
			blocks.push(blockFromFence(`${idPrefix}-x-${specialIndex++}`, fence.language || undefined, body.join('\n'), closed));
			continue;
		}

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
				id: `${idPrefix}-x-${specialIndex++}`,
				status: 'complete',
				title: humanTerminalTitle(undefined, split.command),
				command: split.command,
				output: split.output,
			}));
			continue;
		}

		if (TABLE_LINE_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
			flushMarkdown();
			const tableLines = [line, lines[i + 1]];
			i += 2;
			while (i < lines.length && TABLE_LINE_RE.test(lines[i])) {
				tableLines.push(lines[i]);
				i++;
			}
			const table = parseMarkdownTable(tableLines);
			if (table) {
				blocks.push({
					id: `${idPrefix}-x-${specialIndex++}`,
					type: 'table',
					status: 'complete',
					headers: table.headers,
					rows: table.rows,
				});
			}
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
		} else {
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

function parseFenceLine(line: string): { marker: string; language: string; rest: string } | undefined {
	const match = line.match(FENCE_OPEN_RE);
	if (!match) {
		return undefined;
	}
	return { marker: match[1], language: match[2] || '', rest: (match[3] || '').trim() };
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
			case 'tool':
				return [block.title ?? block.name, block.input, block.output].filter(Boolean).join('\n');
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

export function classifyTableCell(value: string, header?: string): 'file' | 'size' | 'rank' | 'text' {
	const raw = stripCellMarkup(value);
	const head = (header ?? '').toLowerCase();
	if (SIZE_RE.test(raw) || head === 'size') {
		return 'size';
	}
	if (head === '#' || head === 'rank' || (/^\d+$/.test(raw) && raw.length <= 3 && head !== 'file')) {
		return 'rank';
	}
	if (head === 'file' || head === 'path' || head === 'name' || isPathLike(raw) || /^`/.test(value.trim())) {
		return 'file';
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

export interface IAgentFileTarget {
	path: string;
	startLine?: number;
	endLine?: number;
}

// allow-any-unicode-next-line
const LINE_TAIL_RE = /(?:\s+|:)(?:#?L(?:ine)?\s*)?(\d+)(?:\s*[-–:]\s*(?:#?L(?:ine)?\s*)?(\d+))?\s*$/i;
const PATH_RE = /(?:^|[\s`"'(])((?:~\/|\.\/|\.\.\/|\/|[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]{1,8})/;
const VERB_RE = /^(Read|Reading|Grepped|Grep|Searched|Search|Edited|Edit|Created|Deleted|Wrote|Write|Explored)\s+(.+)$/i;

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

export function classifyToolActivity(name: string, title?: string): 'read' | 'search' | 'note' {
	const s = `${name} ${title ?? ''}`.toLowerCase();
	if (/\b(search|grep|find|rg|glob)\b/.test(s)) {
		return 'search';
	}
	if (/\b(read|open|cat|view|file|edit|write|create|delete)\b/.test(s) || isPathLike(title ?? name)) {
		return 'read';
	}
	return 'note';
}

export function splitActivityLabel(name: string, title?: string, target?: IAgentFileTarget): { label: string; detail?: string } {
	const raw = (title || name).trim();
	const verb = raw.match(VERB_RE);
	if (verb) {
		return { label: capitalizeActivity(verb[1]), detail: verb[2].trim() };
	}
	if (target) {
		const kind = classifyToolActivity(name, title);
		const file = target.path.split(/[\\/]/).pop() || target.path;
		const lines = target.startLine
			? ` L${target.startLine}${target.endLine && target.endLine !== target.startLine ? `-${target.endLine}` : ''}`
			: '';
		return { label: kind === 'search' ? 'Searched' : 'Read', detail: `${file}${lines}` };
	}
	return { label: raw };
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
		const path = pickString(rec, ['path', 'file', 'uri', 'target', 'filename']);
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

function parseMarkdownTable(lines: string[]): { headers: string[]; rows: string[][] } | undefined {
	if (lines.length < 2) {
		return undefined;
	}
	const split = (line: string) => line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim());
	const headers = split(lines[0]);
	const rows = lines.slice(2).filter(line => line.trim()).map(split).map(row => {
		while (row.length < headers.length) {
			row.push('');
		}
		return row.slice(0, headers.length);
	});
	for (let col = headers.length - 1; col >= 0; col--) {
		if (!headers[col] && rows.every(row => !row[col])) {
			headers.splice(col, 1);
			for (const row of rows) {
				row.splice(col, 1);
			}
		}
	}
	return headers.length ? { headers, rows } : undefined;
}
