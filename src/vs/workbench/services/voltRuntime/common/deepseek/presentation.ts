/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent, IVoltToolView } from '../events.js';
import { ToolKind } from '../harness/workLog.js';
import { pickNumber, pickString, pickStringAllowEmpty } from '../tools/args.js';
import { IToolCall, IToolResult, IVoltTool } from '../tools/tool.js';
import { FileDiff, ToolCallKind, ToolCallView, ToolResultView } from './protocol.js';

function callKind(tool: IVoltTool): ToolCallKind {
	switch (tool.kind) {
		case 'read': return 'read';
		case 'search': return 'search';
		case 'edit': return 'edit';
		case 'execute': return 'execute';
		case 'fetch': return 'fetch';
		default: return 'other';
	}
}

function voltKind(kind: ToolCallKind | undefined, tool?: IVoltTool): ToolKind | undefined {
	if (tool?.kind) {
		return tool.kind;
	}
	switch (kind) {
		case 'read': return 'read';
		case 'search': return 'search';
		case 'edit':
		case 'delete':
		case 'move': return 'edit';
		case 'execute': return 'execute';
		case 'fetch': return 'fetch';
		default: return undefined;
	}
}

function titleFor(tool: IVoltTool, args: unknown): string {
	const path = pickString(args, 'path', 'file', 'file_path', 'directory');
	const query = pickString(args, 'query', 'q', 'pattern', 'command', 'url');
	if (path && query) {
		return `${tool.name} ${query} ${path}`;
	}
	return [tool.name, query || path].filter(Boolean).join(' ');
}

/** Pending card. Shell and file mutations declare a card; everything else is generic. */
export function presentCall(tool: IVoltTool, args: unknown, cwd?: string): ToolCallView {
	const path = pickString(args, 'path', 'file', 'file_path') ?? '';
	if (tool.group === 'shell' || tool.name === 'shell') {
		return {
			card: 'terminal',
			title: pickString(args, 'command', 'cmd') ?? tool.name,
			description: pickString(args, 'title'),
			cwd: pickString(args, 'cwd') ?? cwd,
		};
	}
	if (tool.name === 'write_file') {
		const contents = pickStringAllowEmpty(args, 'contents', 'content', 'text') ?? '';
		const file = path || 'file';
		return {
			card: 'diff',
			title: `Write ${file}`,
			diffs: [{ path: file, oldText: null, newText: contents }],
			locations: path ? [{ path }] : undefined,
		};
	}
	if (tool.name === 'edit_file' || tool.kind === 'edit') {
		const file = path || tool.name;
		const diffs: FileDiff[] = [{
			path: file,
			oldText: pickStringAllowEmpty(args, 'old_string', 'old') ?? '',
			newText: pickStringAllowEmpty(args, 'new_string', 'new', 'contents', 'content') ?? '',
		}];
		return { card: 'diff', title: `Edit ${file}`, diffs, locations: path ? [{ path }] : undefined };
	}
	const line = pickNumber(args, 'offset', 'line');
	return {
		card: 'generic',
		title: titleFor(tool, args),
		kind: callKind(tool),
		rawInput: args,
		locations: path ? [{ path, ...(line !== undefined ? { line } : {}) }] : undefined,
	};
}

/** Completed card. The model-facing text stays on the tool result; this is only how the UI draws it. */
export function presentResult(tool: IVoltTool, args: unknown, result: IToolResult): ToolResultView {
	if (result.isError) {
		return { card: 'generic', title: tool.name };
	}
	if (tool.group === 'shell' || tool.name === 'shell') {
		return { card: 'terminal', title: pickString(args, 'command', 'cmd'), output: result.text, exitCode: 0 };
	}
	if (tool.name === 'write_file' || tool.name === 'edit_file' || tool.kind === 'edit') {
		const pending = presentCall(tool, args);
		if (pending.card === 'diff') {
			return { card: 'diff', title: pending.title, diffs: pending.diffs };
		}
	}
	if (tool.name === 'grep') {
		const matches = parseGrep(result.text);
		const files = groupGrep(matches);
		const truncated = /\[limit hit/.test(result.text);
		return { card: 'search', shape: 'matches', title: titleFor(tool, args), files, truncated, total: matches.length };
	}
	if (tool.name === 'glob') {
		const paths = result.text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('['));
		const truncated = /\[limit hit/.test(result.text);
		return { card: 'search', shape: 'paths', title: titleFor(tool, args), paths, truncated, total: paths.length };
	}
	if (tool.name === 'read_file') {
		return presentRead(tool, args, result.text);
	}
	if (tool.name === 'web_search') {
		const sources = [...result.text.matchAll(/https?:\/\/\S+/g)].map(match => ({ url: match[0].replace(/[),.;]+$/, '') }));
		return { card: 'web', kind: 'search', title: pickString(args, 'query', 'q'), sources, answer: result.text, truncated: false };
	}
	if (tool.name === 'web_fetch') {
		const url = pickString(args, 'url', 'href') ?? '';
		const status = /HTTP (\d+)/.exec(result.text);
		return { card: 'web', kind: 'fetch', title: url, url, statusCode: status ? Number(status[1]) : 200, truncated: /truncated|\[limit/.test(result.text) };
	}
	return { card: 'generic', title: titleFor(tool, args) };
}

export function toolStartFromView(call: IToolCall, tool: IVoltTool | undefined, view: ToolCallView): IVoltEvent {
	const kind = view.card === 'generic' ? voltKind(view.kind, tool) : view.card === 'terminal' ? 'execute' as const : 'edit' as const;
	const input = view.card === 'generic'
		? (typeof view.rawInput === 'string' ? view.rawInput : JSON.stringify(view.rawInput ?? {}))
		: view.card === 'terminal' ? view.title : JSON.stringify(view.diffs);
	if (view.card === 'terminal') {
		return { type: 'tool.start', callId: call.id, name: call.name, title: view.description || view.title, input, cwd: view.cwd, kind, card: 'terminal' };
	}
	if (view.card === 'diff') {
		return {
			type: 'tool.start',
			callId: call.id,
			name: call.name,
			title: view.title,
			input,
			kind,
			card: 'diff',
			diffs: view.diffs.map(diff => ({ path: diff.path, oldText: diff.oldText, newText: diff.newText })),
			locations: view.locations?.map(location => ({ path: location.path, ...(location.line !== undefined ? { line: location.line } : {}) })),
		};
	}
	return {
		type: 'tool.start',
		callId: call.id,
		name: call.name,
		title: view.title,
		input,
		kind,
		card: 'generic',
		locations: view.locations?.map(location => ({ path: location.path, ...(location.line !== undefined ? { line: location.line } : {}) })),
	};
}

export function toolEndFromView(result: IToolResult, view: ToolResultView): IVoltEvent {
	const base = {
		type: 'tool.end' as const,
		callId: result.callId,
		result: result.text,
		error: result.isError ? result.text : undefined,
		durationMs: result.durationMs,
		title: view.title,
		card: view.card,
	};
	if (view.card === 'terminal') {
		return { ...base, output: view.output, exitCode: view.exitCode };
	}
	if (view.card === 'diff') {
		return { ...base, diffs: view.diffs.map(diff => ({ path: diff.path, oldText: diff.oldText, newText: diff.newText })) };
	}
	const shown = viewFromResult(view);
	return shown ? { ...base, output: result.text, view: shown } : { ...base, output: result.text };
}

function viewFromResult(view: ToolResultView): IVoltToolView | undefined {
	if (view.card === 'search' && view.shape === 'matches') {
		return { card: 'search', shape: 'matches', files: view.files, total: view.total, truncated: view.truncated };
	}
	if (view.card === 'search' && view.shape === 'paths') {
		return { card: 'search', shape: 'paths', paths: view.paths, total: view.total, truncated: view.truncated };
	}
	if (view.card === 'read') {
		return { card: 'read', path: view.path, lines: view.lines, totalLines: view.totalLines };
	}
	if (view.card === 'web' && view.kind === 'search') {
		return { card: 'web', kind: 'search', sources: view.sources.map(source => ({ url: source.url, ...(source.title ? { title: source.title } : {}) })), ...(view.answer ? { answer: view.answer } : {}) };
	}
	if (view.card === 'web' && view.kind === 'fetch') {
		return { card: 'web', kind: 'fetch', url: view.url, statusCode: view.statusCode };
	}
	return undefined;
}

function presentRead(tool: IVoltTool, args: unknown, text: string): ToolResultView {
	const header = /^(\S+) lines (\d+)-(\d+) of (\d+)/.exec(text);
	const path = header?.[1] ?? pickString(args, 'path', 'file') ?? tool.name;
	const offset = header ? Number(header[2]) : (pickNumber(args, 'offset') ?? 1);
	const totalLines = header ? Number(header[4]) : text.split('\n').length;
	const lines = [...text.matchAll(/^\s*(\d+) \| (.*)$/gm)].map(match => ({ number: Number(match[1]), text: match[2] }));
	return { card: 'read', title: `Read ${path}`, path, offset, lines, totalLines };
}

function parseGrep(text: string): { path: string; lineNumber: number; line: string }[] {
	const matches: { path: string; lineNumber: number; line: string }[] = [];
	for (const line of text.split('\n')) {
		const match = /^(.*):(\d+): (.*)$/.exec(line);
		if (match) {
			matches.push({ path: match[1], lineNumber: Number(match[2]), line: match[3] });
		}
	}
	return matches;
}

function groupGrep(matches: readonly { path: string; lineNumber: number; line: string }[]): { path: string; matches: { lineNumber: number; line: string }[] }[] {
	const files: { path: string; matches: { lineNumber: number; line: string }[] }[] = [];
	for (const match of matches) {
		let file = files.find(entry => entry.path === match.path);
		if (!file) {
			file = { path: match.path, matches: [] };
			files.push(file);
		}
		file.matches.push({ lineNumber: match.lineNumber, line: match.line });
	}
	return files;
}
