/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { addLineNumbers, truncateHead } from '../../common/harness/toolResult.js';
import { noteWriteFail, noteWriteOk, writeFailCoaching } from '../../common/harness/writeCoach.js';
import { pickNumber, pickString, pickStringAllowEmpty } from '../../common/tools/args.js';
import { applyExactEdits, IExactEdit } from '../../common/tools/editText.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { displayPath, resolveWorkspaceUri } from './workspacePath.js';

export function createFileTools(fileService: IFileService, root: () => URI | undefined): IVoltTool[] {
	return [
		{
			name: 'read_file',
			group: 'read',
			kind: 'read',
			parallelSafe: true,
			snippet: 'read_file - read a workspace file with optional offset/limit',
			description: [
				'Read a text file in the workspace.',
				'Use when you need file contents to answer or edit.',
				'Do not use for binary files, or when grep/glob would find the path first.',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string', description: 'Workspace-relative or absolute path' },
				offset: { type: 'integer', description: '1-based start line' },
				limit: { type: 'integer', description: 'Maximum number of lines' },
			}, ['path']),
			execute: async (args, ctx) => runRead(fileService, root(), args, ctx),
		},
		{
			name: 'list_dir',
			group: 'read',
			kind: 'read',
			parallelSafe: true,
			snippet: 'list_dir - list files in a directory',
			description: [
				'List entries in a workspace directory.',
				'Use when you need to see what is in a folder.',
				'Do not use to search the whole repo; prefer glob or grep.',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
			}, []),
			execute: async (args, ctx) => runList(fileService, root(), args, ctx),
		},
		{
			name: 'edit_file',
			group: 'edit',
			kind: 'edit',
			parallelSafe: false,
			snippet: 'edit_file - search/replace in a file (exact, unique)',
			description: [
				'Replace text in a file. old_string should match once. A unique near-match may still apply.',
				'Use when changing an existing file. Future edits must use the returned final_file_content as the baseline.',
				'Do not use to create a new file (use write_file) or to rewrite the whole file unless the match is the entire contents.',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string' },
				old_string: { type: 'string' },
				new_string: { type: 'string' },
				edits: {
					type: 'array',
					items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] },
				},
			}, ['path']),
			execute: async (args, ctx) => runEdit(fileService, root(), args, ctx),
		},
		{
			name: 'write_file',
			group: 'edit',
			kind: 'edit',
			parallelSafe: false,
			snippet: 'write_file - create or overwrite a file',
			description: [
				'Create a file or replace its entire contents.',
				'Use for new files. Prefer edit_file for existing files.',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string' },
				contents: { type: 'string' },
			}, ['path', 'contents']),
			execute: async (args, ctx) => runWrite(fileService, root(), args, ctx),
		},
	];
}

async function runRead(fileService: IFileService, root: URI | undefined, args: unknown, _ctx: IToolContext): Promise<IToolResult> {
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file', 'file_path'));
	if (!uri) {
		return fail('read_file', 'Path is missing or outside the workspace.');
	}
	try {
		const file = await fileService.readFile(uri);
		const raw = file.value.toString();
		if (raw.includes('\0')) {
			return fail('read_file', 'File looks binary. Use grep or a different tool.');
		}
		const lines = raw.split('\n');
		const offset = Math.max(1, pickNumber(args, 'offset', 'start_line') ?? 1);
		const limit = Math.max(1, pickNumber(args, 'limit', 'count') ?? 2000);
		const first = lines[offset - 1] ?? '';
		if (first.length > 8_000 && offset === 1 && (pickNumber(args, 'limit', 'count') === undefined)) {
			return {
				callId: '',
				name: 'read_file',
				kind: 'read',
				text: `${displayPath(root, uri)} line 1 is ${first.length} characters (minified or generated). Re-read with limit=1 to page it, or use grep. Do not load the whole file.`,
			};
		}
		const slice = lines.slice(offset - 1, offset - 1 + limit).join('\n');
		const numbered = addLineNumbers(slice, offset);
		const truncated = truncateHead(numbered);
		const header = `${displayPath(root, uri)} lines ${offset}-${Math.min(lines.length, offset + limit - 1)} of ${lines.length}`;
		return { callId: '', name: 'read_file', kind: 'read', text: `${header}\n${truncated.text}` };
	} catch (err) {
		return fail('read_file', err instanceof Error ? err.message : String(err));
	}
}

async function runList(fileService: IFileService, root: URI | undefined, args: unknown, _ctx: IToolContext): Promise<IToolResult> {
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'directory') ?? '.') ?? root;
	if (!uri) {
		return fail('list_dir', 'No workspace is open.');
	}
	try {
		const stat = await fileService.resolve(uri);
		const entries = (stat.children ?? [])
			.map(child => `${child.name}${child.isDirectory ? '/' : ''}`)
			.sort((a, b) => a.localeCompare(b));
		const shown = entries.slice(0, 500);
		const extra = entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : '';
		return { callId: '', name: 'list_dir', kind: 'read', text: shown.length ? shown.join('\n') + extra : '(empty)' };
	} catch (err) {
		return fail('list_dir', err instanceof Error ? err.message : String(err));
	}
}

async function runEdit(fileService: IFileService, root: URI | undefined, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file', 'file_path'));
	if (!uri) {
		return fail('edit_file', 'Path is missing or outside the workspace.');
	}
	try {
		const original = (await fileService.readFile(uri)).value.toString();
		const edits = collectEdits(args);
		const result = applyExactEdits(original, edits);
		if ('error' in result) {
			return fail('edit_file', result.error);
		}
		await fileService.writeFile(uri, VSBuffer.fromString(result.text));
		ctx.emit?.({ type: 'file.change', uri, kind: 'edit', before: original, existed: true });
		const shown = displayPath(root, uri);
		const fuzzy = result.fuzzy ? ` Applied ${result.fuzzy} near-match${result.fuzzy === 1 ? '' : 'es'} (formatter or whitespace drift).` : '';
		return { callId: '', name: 'edit_file', kind: 'edit', text: finalFileContent(shown, result.text, `Edited ${shown} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'}).${fuzzy}`) };
	} catch (err) {
		return fail('edit_file', err instanceof Error ? err.message : String(err));
	}
}

async function runWrite(fileService: IFileService, root: URI | undefined, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file', 'file_path'));
	const contents = pickStringAllowEmpty(args, 'contents', 'content', 'text');
	if (!uri) {
		return fail('write_file', 'Path is missing or outside the workspace.');
	}
	if (contents === undefined) {
		const path = uri.path || uri.fsPath;
		return fail('write_file', writeFailCoaching(path, noteWriteFail(path)));
	}
	try {
		const existed = await fileService.exists(uri);
		let previous: string | undefined;
		if (existed) {
			try {
				previous = (await fileService.readFile(uri)).value.toString();
			} catch {
				previous = undefined;
			}
		}
		await fileService.writeFile(uri, VSBuffer.fromString(contents));
		noteWriteOk(uri.path || uri.fsPath);
		ctx.emit?.({ type: 'file.change', uri, kind: existed ? 'edit' : 'create', ...(previous !== undefined ? { before: previous } : {}), existed });
		const shown = displayPath(root, uri);
		return { callId: '', name: 'write_file', kind: 'edit', text: finalFileContent(shown, contents, `${existed ? 'Overwrote' : 'Created'} ${shown}.`) };
	} catch (err) {
		return fail('write_file', err instanceof Error ? err.message : String(err));
	}
}

function collectEdits(args: unknown): IExactEdit[] {
	const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
	if (Array.isArray(record.edits)) {
		return record.edits.map(edit => {
			const item = edit && typeof edit === 'object' ? edit as Record<string, unknown> : {};
			return { oldString: String(item.old_string ?? item.oldString ?? ''), newString: String(item.new_string ?? item.newString ?? '') };
		});
	}
	const oldString = pickStringAllowEmpty(args, 'old_string', 'oldString') ?? '';
	const newString = pickString(args, 'new_string', 'newString') ?? '';
	return oldString || newString ? [{ oldString, newString }] : [];
}

function finalFileContent(path: string, contents: string, lead: string): string {
	const body = truncateHead(contents, 400, 12_000).text;
	return `${lead}\n\n<final_file_content path="${path}">\n${body}\n</final_file_content>\nFuture SEARCH/REPLACE must match this exact baseline, including formatter changes.`;
}

function fail(name: string, text: string): IToolResult {
	return { callId: '', name, kind: name === 'read_file' || name === 'list_dir' ? 'read' : 'edit', text, isError: true };
}
