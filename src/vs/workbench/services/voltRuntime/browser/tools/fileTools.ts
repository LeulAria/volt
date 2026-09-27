/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { extname } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileLedger } from '../../common/harness/fileLedger.js';
import { addLineNumbers } from '../../common/harness/toolResult.js';
import { asRecord, pickBoolean, pickNumber, pickString, pickStringAllowEmpty } from '../../common/tools/args.js';
import { applyExactEdits, diffHunk, IExactEdit } from '../../common/tools/editText.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { displayPath, resolveReadableUri, resolveWorkspaceUri } from './workspacePath.js';

/** Open editors: an agent edit lands in the buffer the user sees, not behind it. */
export interface IToolDocuments {
	/** Text of an open document with unsaved changes; `undefined` when disk is current. */
	dirtyText(uri: URI): string | undefined;
	/** Replaces an open document's text and saves it. `false` when the document is not open. */
	writeOpen(uri: URI, text: string): Promise<boolean>;
}

export interface IFileToolHost {
	readonly fileService: IFileService;
	readonly root: () => URI | undefined;
	/** Readable roots outside the workspace, e.g. skill folders. */
	readonly readRoots?: () => readonly URI[];
	readonly ledger?: () => FileLedger | undefined;
	readonly documents?: IToolDocuments;
	/** Project rules whose globs match this file, attached the first time it is touched. */
	readonly rulesFor?: (uri: URI) => string | undefined;
}

const READ_LINE_LIMIT = 2_000;
/** About 10k tokens. Longer reads page. */
const READ_CHAR_BUDGET = 40_000;
const LONG_LINE = 2_000;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function createFileTools(host: IFileToolHost): IVoltTool[] {
	return [
		{
			name: 'read_file',
			group: 'read',
			kind: 'read',
			parallelSafe: true,
			snippet: 'read_file - read a file (or a page of it) with line numbers',
			description: [
				'Read a text file (or an image) in the workspace. Lines come back numbered as `N | text`.',
				'Use when you need a file\'s contents to answer or edit; read several files in one turn with parallel calls.',
				'Large files page: pass offset (1-based line) and limit. Do not use for binaries, or to find a path (use glob / grep).',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string', description: 'Workspace-relative or absolute path' },
				offset: { type: 'integer', description: '1-based first line to read' },
				limit: { type: 'integer', description: 'Maximum number of lines (default 2000)' },
			}, ['path']),
			execute: async (args, ctx) => runRead(host, args, ctx),
		},
		{
			name: 'list_dir',
			group: 'read',
			kind: 'read',
			parallelSafe: true,
			snippet: 'list_dir - list a directory, optionally a few levels deep',
			description: [
				'List a workspace directory as a tree (directories end with /).',
				'Use to see a folder\'s layout; depth up to 3 for a quick map of a subtree.',
				'Do not use to search the whole repo; prefer glob or grep.',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
				depth: { type: 'integer', description: 'Levels to descend, 1-3 (default 1)' },
			}, []),
			execute: async (args, ctx) => runList(host, args, ctx),
		},
		{
			name: 'edit_file',
			group: 'edit',
			kind: 'edit',
			parallelSafe: false,
			snippet: 'edit_file - exact search/replace in a file',
			description: [
				'Replace exact text in an existing file. old_string must match the file exactly (whitespace included) and be unique,',
				'unless replace_all is true. For several changes to one file, pass an edits array in one call.',
				'Returns a diff of what changed. Read the file first. Do not use to create files (use write_file).',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string' },
				old_string: { type: 'string', description: 'Exact text to replace, with enough context to be unique' },
				new_string: { type: 'string', description: 'Replacement text' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence' },
				expected_replacements: { type: 'integer', description: 'Fail unless exactly this many occurrences match' },
				edits: {
					type: 'array',
					description: 'Several replacements applied in order, all or nothing',
					items: {
						type: 'object',
						properties: {
							old_string: { type: 'string' },
							new_string: { type: 'string' },
							replace_all: { type: 'boolean' },
						},
						required: ['old_string', 'new_string'],
					},
				},
			}, ['path']),
			execute: async (args, ctx) => runEdit(host, args, ctx),
		},
		{
			name: 'write_file',
			group: 'edit',
			kind: 'edit',
			parallelSafe: false,
			snippet: 'write_file - create a file or replace all of it',
			description: [
				'Create a new file, or replace an existing file\'s entire contents.',
				'Use for new files. For changes to an existing file prefer edit_file; overwriting a file you have not read fails unless overwrite is true.',
			].join(' '),
			schema: objectSchema({
				path: { type: 'string' },
				contents: { type: 'string' },
				overwrite: { type: 'boolean', description: 'Replace an existing file you have not read' },
			}, ['path', 'contents']),
			execute: async (args, ctx) => runWrite(host, args, ctx),
		},
		{
			name: 'delete_file',
			group: 'edit',
			kind: 'edit',
			parallelSafe: false,
			snippet: 'delete_file - move a file to the trash',
			description: 'Delete a workspace file (it goes to the trash, so it can be restored). Use when a file should no longer exist. Do not use on directories.',
			schema: objectSchema({
				path: { type: 'string' },
			}, ['path']),
			execute: async (args, ctx) => runDelete(host, args, ctx),
		},
	];
}

async function runRead(host: IFileToolHost, args: unknown, _ctx: IToolContext): Promise<IToolResult> {
	const root = host.root();
	const uri = resolveReadableUri(root, pickString(args, 'path', 'file', 'file_path'), host.readRoots?.() ?? []);
	if (!uri) {
		return fail('read_file', 'Path is missing or outside the workspace.');
	}
	const shown = displayPath(root, uri);
	try {
		const image = IMAGE_TYPES[extname(uri.path).toLowerCase()];
		if (image) {
			const bytes = await host.fileService.readFile(uri);
			if (bytes.value.byteLength > MAX_IMAGE_BYTES) {
				return fail('read_file', `${shown} is ${Math.round(bytes.value.byteLength / 1024)} KB, too large to view.`);
			}
			return { callId: '', name: 'read_file', kind: 'read', text: `Image ${shown} (${Math.round(bytes.value.byteLength / 1024)} KB).`, image: `data:${image};base64,${encodeBase64(bytes.value)}` };
		}
		const dirty = host.documents?.dirtyText(uri);
		let raw: string;
		let version: string | undefined;
		if (dirty !== undefined) {
			raw = dirty;
			version = `dirty:${raw.length}:${quickHash(raw)}`;
		} else {
			const file = await host.fileService.readFile(uri);
			raw = file.value.toString();
			version = file.etag;
		}
		if (raw.includes('\0')) {
			return fail('read_file', `${shown} looks binary. Use grep or a different tool.`);
		}
		const lines = raw.split('\n');
		const offset = Math.min(Math.max(1, pickNumber(args, 'offset') ?? 1), Math.max(1, lines.length));
		const requested = Math.max(1, pickNumber(args, 'limit') ?? READ_LINE_LIMIT);
		let end = Math.min(lines.length, offset + requested - 1);
		const ledger = host.ledger?.();
		const key = uri.toString();
		const seen = ledger?.coveredRead(key, version, offset, end);
		if (seen !== undefined) {
			return {
				callId: '',
				name: 'read_file',
				kind: 'read',
				text: `${shown} lines ${offset}-${end} are unchanged since you read them a moment ago (step ${seen}); use that result above. Pass a different offset/limit to read other lines.`,
			};
		}
		const out: string[] = [];
		let chars = 0;
		for (let n = offset; n <= end; n++) {
			let line = lines[n - 1] ?? '';
			if (line.length > LONG_LINE) {
				line = `${line.slice(0, LONG_LINE)} [... ${line.length - LONG_LINE} more characters on this line]`;
			}
			if (chars + line.length > READ_CHAR_BUDGET && out.length) {
				end = n - 1;
				break;
			}
			out.push(line);
			chars += line.length + 1;
		}
		ledger?.recordRead(key, shown, version, offset, end);
		const more = end < lines.length ? `\n\n[Showing lines ${offset}-${end} of ${lines.length}. Continue with offset=${end + 1}.]` : '';
		const header = `${shown} lines ${offset}-${end} of ${lines.length}${dirty !== undefined ? ' (unsaved editor changes)' : ''}`;
		const rules = firstTouchRules(host, uri, ledger);
		return {
			callId: '',
			name: 'read_file',
			kind: 'read',
			text: `${header}\n${addLineNumbers(out.join('\n'), offset)}${more}`,
			display: { card: 'read', title: `Read ${shown}`, path: shown, offset, lines: out.map((text, i) => ({ number: offset + i, text })), totalLines: lines.length },
			...(rules ? { contexts: [rules] } : {}),
		};
	} catch (err) {
		return fail('read_file', errorText(err));
	}
}

async function runList(host: IFileToolHost, args: unknown, _ctx: IToolContext): Promise<IToolResult> {
	const root = host.root();
	const uri = resolveReadableUri(root, pickString(args, 'path', 'directory') ?? '.', host.readRoots?.() ?? []) ?? root;
	if (!uri) {
		return fail('list_dir', 'No workspace is open.');
	}
	const depth = Math.min(3, Math.max(1, pickNumber(args, 'depth') ?? 1));
	const lines: string[] = [];
	let total = 0;
	const limit = 400;
	const walk = async (dir: URI, level: number): Promise<void> => {
		const stat = await host.fileService.resolve(dir);
		const children = [...(stat.children ?? [])].sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
		for (const child of children) {
			total++;
			if (lines.length < limit) {
				lines.push(`${'  '.repeat(level)}${child.name}${child.isDirectory ? '/' : ''}`);
			}
			if (child.isDirectory && level + 1 < depth && !SKIP_DIRS.has(child.name) && lines.length < limit) {
				await walk(child.resource, level + 1).catch(() => undefined);
			}
		}
	};
	try {
		await walk(uri, 0);
		const extra = total > lines.length ? `\n… ${total - lines.length} more entries` : '';
		return { callId: '', name: 'list_dir', kind: 'read', text: lines.length ? `${displayPath(root, uri)}/\n${lines.join('\n')}${extra}` : '(empty)' };
	} catch (err) {
		return fail('list_dir', errorText(err));
	}
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache']);

async function runEdit(host: IFileToolHost, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const root = host.root();
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file', 'file_path'));
	if (!uri) {
		return fail('edit_file', 'Path is missing or outside the workspace.');
	}
	const shown = displayPath(root, uri);
	try {
		const dirty = host.documents?.dirtyText(uri);
		let original: string;
		let etag: string | undefined;
		if (dirty !== undefined) {
			original = dirty;
		} else {
			if (!await host.fileService.exists(uri)) {
				return fail('edit_file', `${shown} does not exist. Use write_file to create it.`);
			}
			const file = await host.fileService.readFile(uri);
			original = file.value.toString();
			etag = file.etag;
		}
		const edits = collectEdits(args);
		const result = applyExactEdits(original, edits);
		if ('error' in result) {
			return fail('edit_file', `${shown}: ${result.error}`);
		}
		const version = await writeText(host, uri, result.text, dirty !== undefined, etag);
		host.ledger?.()?.recordWrite(uri.toString(), shown, version);
		ctx.emit?.({ type: 'file.change', uri, kind: 'edit', before: original, existed: true });
		const hunk = diffHunk(original, result.text);
		const fuzzy = result.fuzzy ? ` Applied ${result.fuzzy} near-match${result.fuzzy === 1 ? '' : 'es'} (whitespace or quote drift); check the diff.` : '';
		const rules = firstTouchRules(host, uri, host.ledger?.());
		return {
			callId: '',
			name: 'edit_file',
			kind: 'edit',
			text: `Edited ${shown}: ${result.replacements} replacement${result.replacements === 1 ? '' : 's'}, +${hunk.added} -${hunk.removed} lines.${fuzzy}\n${hunk.text}`,
			...(rules ? { contexts: [rules] } : {}),
		};
	} catch (err) {
		return fail('edit_file', staleWriteText(shown, err));
	}
}

async function runWrite(host: IFileToolHost, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const root = host.root();
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file', 'file_path'));
	const contents = pickStringAllowEmpty(args, 'contents', 'content', 'text');
	if (!uri) {
		return fail('write_file', 'Path is missing or outside the workspace.');
	}
	if (contents === undefined) {
		return fail('write_file', 'contents is required. Pass the complete file text in contents.');
	}
	const shown = displayPath(root, uri);
	try {
		const existed = await host.fileService.exists(uri);
		const ledger = host.ledger?.();
		const key = uri.toString();
		if (existed && ledger && !ledger.knows(key) && !pickBoolean(args, 'overwrite')) {
			return fail('write_file', `${shown} already exists and you have not read it in this conversation. Read it first and use edit_file, or pass overwrite: true to replace it entirely.`);
		}
		const dirty = existed ? host.documents?.dirtyText(uri) : undefined;
		let previous: string | undefined = dirty;
		if (existed && previous === undefined) {
			previous = await host.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
		}
		const version = await writeText(host, uri, contents, dirty !== undefined, undefined);
		ledger?.recordWrite(key, shown, version);
		ctx.emit?.({ type: 'file.change', uri, kind: existed ? 'edit' : 'create', ...(previous !== undefined ? { before: previous } : {}), existed });
		const lines = contents ? contents.split('\n').length : 0;
		const rules = firstTouchRules(host, uri, ledger);
		return {
			callId: '',
			name: 'write_file',
			kind: 'edit',
			text: `${existed ? 'Overwrote' : 'Created'} ${shown} (${lines} line${lines === 1 ? '' : 's'}).`,
			...(rules ? { contexts: [rules] } : {}),
		};
	} catch (err) {
		return fail('write_file', errorText(err));
	}
}

async function runDelete(host: IFileToolHost, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const root = host.root();
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file', 'file_path'));
	if (!uri) {
		return fail('delete_file', 'Path is missing or outside the workspace.');
	}
	const shown = displayPath(root, uri);
	try {
		const stat = await host.fileService.resolve(uri);
		if (stat.isDirectory) {
			return fail('delete_file', `${shown} is a directory. delete_file only removes files.`);
		}
		const before = await host.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
		await host.fileService.del(uri, { useTrash: true }).catch(() => host.fileService.del(uri));
		host.ledger?.()?.recordWrite(uri.toString(), shown, undefined);
		ctx.emit?.({ type: 'file.change', uri, kind: 'delete', ...(before !== undefined ? { before } : {}), existed: true });
		return { callId: '', name: 'delete_file', kind: 'edit', text: `Deleted ${shown} (moved to trash).` };
	} catch (err) {
		return fail('delete_file', errorText(err));
	}
}

/** Writes through the open editor when it holds unsaved changes; otherwise to disk, refusing a stale overwrite. */
async function writeText(host: IFileToolHost, uri: URI, text: string, open: boolean, etag: string | undefined): Promise<string | undefined> {
	if (open && host.documents && await host.documents.writeOpen(uri, text)) {
		return `dirty:${text.length}:${quickHash(text)}`;
	}
	const stat = await host.fileService.writeFile(uri, VSBuffer.fromString(text), etag ? { etag } : undefined);
	return stat.etag;
}

function firstTouchRules(host: IFileToolHost, uri: URI, ledger: FileLedger | undefined): string | undefined {
	if (!host.rulesFor || (ledger && ledger.knows(`rules:${uri.toString()}`))) {
		return undefined;
	}
	ledger?.recordRead(`rules:${uri.toString()}`, `rules:${uri.path}`, 'rules', 0, 0);
	return host.rulesFor(uri);
}

function collectEdits(args: unknown): IExactEdit[] {
	const record = asRecord(args);
	if (Array.isArray(record.edits) && record.edits.length) {
		return record.edits.map(edit => {
			const item = asRecord(edit);
			return {
				oldString: String(item.old_string ?? item.oldString ?? ''),
				newString: String(item.new_string ?? item.newString ?? ''),
				...(item.replace_all === true || item.replace_all === 'true' ? { replaceAll: true } : {}),
			};
		});
	}
	const oldString = pickStringAllowEmpty(args, 'old_string', 'oldString') ?? '';
	const newString = pickStringAllowEmpty(args, 'new_string', 'newString') ?? '';
	const expected = pickNumber(args, 'expected_replacements');
	if (!oldString && !newString) {
		return [];
	}
	return [{ oldString, newString, ...(pickBoolean(args, 'replace_all') ? { replaceAll: true } : {}), ...(expected !== undefined ? { expected } : {}) }];
}

function staleWriteText(shown: string, err: unknown): string {
	const message = errorText(err);
	return /modified since|newer|FILE_MODIFIED_SINCE|etag/i.test(message)
		? `${shown} changed on disk while you were editing it. Read it again, then redo the edit against the current text.`
		: message;
}

function quickHash(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i += Math.max(1, Math.floor(text.length / 4096))) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function fail(name: string, text: string): IToolResult {
	return { callId: '', name, kind: name === 'read_file' || name === 'list_dir' ? 'read' : 'edit', text, isError: true };
}
