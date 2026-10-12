/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { rgPath } from '@vscode/ripgrep';
import { Disposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from '../../../base/common/path.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';

/** A folder paired clients may browse: a project, or a chat's worktree. */
export interface IServerFileRoot {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly kind: 'project' | 'worktree';
	readonly scratch?: boolean;
	/** `worktree`: the chat that runs in it. */
	readonly sessionId?: string;
}

export interface IServerFileEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: 'file' | 'dir';
	readonly size?: number;
	readonly mtime?: number;
	readonly link?: boolean;
}

export type IServerFileContent =
	| { readonly path: string; readonly size: number; readonly mtime: number; readonly kind: 'text'; readonly text: string }
	| { readonly path: string; readonly size: number; readonly mtime: number; readonly kind: 'image'; readonly mime: string; readonly base64: string }
	| { readonly path: string; readonly size: number; readonly mtime: number; readonly kind: 'binary' | 'tooLarge' };

export interface IServerGrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
	/** Columns (UTF-16) of the matches in `text`. */
	readonly ranges: readonly (readonly [number, number])[];
}

export interface IServerGitChange {
	readonly path: string;
	readonly rel: string;
	readonly status: 'M' | 'A' | 'D' | 'R' | 'U' | '?';
	readonly staged: boolean;
	readonly oldPath?: string;
	readonly additions?: number;
	readonly deletions?: number;
}

const MAX_TEXT_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INDEX = 120_000;
const INDEX_TTL_MS = 12_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '.DS_Store', '__pycache__', '.next', '.turbo', '.cache']);
const IMAGE_MIME: Record<string, string> = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
	'.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

/** ripgrep inside the packaged app lives outside the asar archive. */
const rgDiskPath = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

function run(cmd: string, args: readonly string[], cwd: string, maxBuffer = 48 * 1024 * 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args as string[], { cwd, maxBuffer, timeout: 20_000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout));
	});
}

/**
 * The files of the projects Volt has open, for the web IDE and the phone: list, read, write,
 * quick open, text search and git (status and the committed side of a diff). Every path must sit
 * inside a project or a chat's worktree; anything else is refused. A paired device can already
 * run agents with full access there, so reading and writing those files gives it nothing new.
 */
export class ServerFiles extends Disposable {

	private readonly indexes = new Map<string, { readonly at: number; readonly result: Promise<{ files: string[]; truncated: boolean }> }>();
	private readonly realRoots = new Map<string, Promise<string>>();

	constructor(
		protocol: AgentServerProtocol,
		private readonly listRoots: () => IServerFileRoot[],
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(protocol.registerMethods('files', {
			roots: () => this.listRoots(),
			list: (_ctx, path) => this.list(String(path)),
			read: (_ctx, path) => this.read(String(path)),
			write: (_ctx, path, text, options) => this.write(String(path), String(text ?? ''), (options ?? {}) as { mtime?: number; create?: boolean }),
			create: (_ctx, path, kind) => this.create(String(path), kind === 'dir' ? 'dir' : 'file'),
			rename: (_ctx, from, to) => this.rename(String(from), String(to)),
			delete: (_ctx, path) => this.delete(String(path)),
			index: (_ctx, root) => this.index(String(root)),
			grep: (_ctx, root, query, options) => this.grep(String(root), String(query ?? ''), (options ?? {}) as IGrepOptions),
			gitStatus: (_ctx, root) => this.gitStatus(String(root)),
			gitShow: (_ctx, path, ref) => this.gitShow(String(path), typeof ref === 'string' && ref ? ref : 'HEAD'),
			gitBlob: (_ctx, repoRoot, sha) => this.gitBlob(String(repoRoot), String(sha ?? '')),
			gitCommit: (_ctx, root, message) => this.gitCommit(String(root), String(message ?? '')),
		}));
	}

	//#region Paths

	private realRoot(path: string): Promise<string> {
		let real = this.realRoots.get(path);
		if (!real) {
			real = fs.realpath(path).catch(() => normalize(path));
			this.realRoots.set(path, real);
		}
		return real;
	}

	/** The path, checked to be inside a root (symlinks resolved; a new file by its folder). */
	private async allowed(path: string): Promise<string> {
		if (!path || !isAbsolute(path)) {
			fail('BadPath', 'Give an absolute path.');
		}
		const target = normalize(path);
		let real: string;
		try {
			real = await fs.realpath(target);
		} catch {
			const parent = await fs.realpath(dirname(target)).catch(() => dirname(target));
			real = join(parent, basename(target));
		}
		for (const root of this.listRoots()) {
			const base = await this.realRoot(root.path);
			if (real === base || real.startsWith(base.endsWith(sep) ? base : base + sep)) {
				return target;
			}
		}
		return fail('Forbidden', 'That file is outside the projects Volt has open.');
	}

	//#endregion

	//#region Files

	private async list(path: string): Promise<IServerFileEntry[]> {
		const dir = await this.allowed(path);
		const dirents = await fs.readdir(dir, { withFileTypes: true });
		const entries = await Promise.all(dirents.filter(d => d.name !== '.git' && d.name !== '.DS_Store').map(async (d): Promise<IServerFileEntry | undefined> => {
			const full = join(dir, d.name);
			let isDir = d.isDirectory();
			const link = d.isSymbolicLink();
			if (link) {
				const stat = await fs.stat(full).catch(() => undefined);
				if (!stat) {
					return undefined;
				}
				isDir = stat.isDirectory();
			}
			return { name: d.name, path: full, kind: isDir ? 'dir' : 'file', ...(link ? { link: true } : {}) };
		}));
		return entries.filter((e): e is IServerFileEntry => !!e).sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
	}

	private async read(path: string): Promise<IServerFileContent> {
		const file = await this.allowed(path);
		const stat = await fs.stat(file);
		if (stat.isDirectory()) {
			fail('IsDirectory', 'That is a folder.');
		}
		const head = { path: file, size: stat.size, mtime: stat.mtimeMs };
		const mime = IMAGE_MIME[extname(file).toLowerCase()];
		if (mime) {
			if (stat.size > MAX_IMAGE_BYTES) {
				return { ...head, kind: 'tooLarge' };
			}
			return { ...head, kind: 'image', mime, base64: (await fs.readFile(file)).toString('base64') };
		}
		if (stat.size > MAX_TEXT_BYTES) {
			return { ...head, kind: 'tooLarge' };
		}
		const data = await fs.readFile(file);
		if (data.subarray(0, 8192).includes(0)) {
			return { ...head, kind: 'binary' };
		}
		return { ...head, kind: 'text', text: data.toString('utf8') };
	}

	private async write(path: string, text: string, options: { readonly mtime?: number; readonly create?: boolean }): Promise<{ mtime: number; size: number }> {
		const file = await this.allowed(path);
		const before = await fs.stat(file).catch(() => undefined);
		if (!before && !options.create) {
			fail('NotFound', 'The file was deleted on your computer.');
		}
		if (before && typeof options.mtime === 'number' && Math.abs(before.mtimeMs - options.mtime) > 1) {
			fail('Conflict', 'The file changed on your computer since you opened it.');
		}
		await fs.writeFile(file, text, 'utf8');
		const after = await fs.stat(file);
		this.indexes.clear();
		return { mtime: after.mtimeMs, size: after.size };
	}

	private async create(path: string, kind: 'file' | 'dir'): Promise<IServerFileEntry> {
		const target = await this.allowed(path);
		if (await fs.stat(target).catch(() => undefined)) {
			fail('Exists', `${basename(target)} already exists.`);
		}
		if (kind === 'dir') {
			await fs.mkdir(target, { recursive: true });
		} else {
			await fs.mkdir(dirname(target), { recursive: true });
			await fs.writeFile(target, '', { flag: 'wx' });
		}
		this.indexes.clear();
		return { name: basename(target), path: target, kind };
	}

	private async rename(from: string, to: string): Promise<boolean> {
		const source = await this.allowed(from);
		const target = await this.allowed(to);
		if (this.isRoot(source)) {
			fail('Forbidden', 'A project folder can\'t be renamed from here.');
		}
		if (await fs.stat(target).catch(() => undefined)) {
			fail('Exists', `${basename(target)} already exists.`);
		}
		await fs.rename(source, target);
		this.indexes.clear();
		return true;
	}

	private async delete(path: string): Promise<boolean> {
		const target = await this.allowed(path);
		if (this.isRoot(target)) {
			fail('Forbidden', 'A project folder can\'t be deleted from here.');
		}
		await fs.rm(target, { recursive: true, force: true });
		this.indexes.clear();
		return true;
	}

	private isRoot(path: string): boolean {
		return this.listRoots().some(root => normalize(root.path) === path);
	}

	//#endregion

	//#region Quick open and search

	/** Every file under a root, relative and with `/` (git's list when it is a repository). */
	private async index(root: string): Promise<{ files: string[]; truncated: boolean }> {
		const dir = await this.allowed(root);
		const cached = this.indexes.get(dir);
		if (cached && Date.now() - cached.at < INDEX_TTL_MS) {
			return cached.result;
		}
		const result = this.buildIndex(dir);
		this.indexes.set(dir, { at: Date.now(), result });
		result.catch(() => this.indexes.delete(dir));
		return result;
	}

	private async buildIndex(dir: string): Promise<{ files: string[]; truncated: boolean }> {
		try {
			const out = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], dir);
			const files = out.split('\0').filter(Boolean);
			return { files: files.slice(0, MAX_INDEX), truncated: files.length > MAX_INDEX };
		} catch {
			// not a repository: walk it
		}
		const files: string[] = [];
		const walk = async (folder: string, prefix: string): Promise<void> => {
			if (files.length >= MAX_INDEX) {
				return;
			}
			const dirents = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
			for (const d of dirents) {
				if (files.length >= MAX_INDEX) {
					return;
				}
				if (d.isDirectory()) {
					if (!SKIPPED_DIRS.has(d.name)) {
						await walk(join(folder, d.name), `${prefix}${d.name}/`);
					}
				} else if (d.isFile()) {
					files.push(`${prefix}${d.name}`);
				}
			}
		};
		await walk(dir, '');
		return { files, truncated: files.length >= MAX_INDEX };
	}

	private async grep(root: string, query: string, options: IGrepOptions): Promise<{ matches: IServerGrepMatch[]; truncated: boolean }> {
		const dir = await this.allowed(root);
		if (!query) {
			return { matches: [], truncated: false };
		}
		const limit = Math.min(Math.max(options.maxResults ?? 2000, 1), 10_000);
		const args = ['--json', '--max-columns', '500', '--max-count', '200', '--hidden', '-g', '!.git'];
		if (!options.regex) {
			args.push('--fixed-strings');
		}
		args.push(options.caseSensitive ? '--case-sensitive' : '--ignore-case');
		if (options.wholeWord) {
			args.push('--word-regexp');
		}
		for (const glob of (options.include ?? '').split(',').map(g => g.trim()).filter(Boolean)) {
			args.push('-g', glob);
		}
		for (const glob of (options.exclude ?? '').split(',').map(g => g.trim()).filter(Boolean)) {
			args.push('-g', `!${glob}`);
		}
		args.push('--', query, '.');
		return new Promise(resolve => {
			const matches: IServerGrepMatch[] = [];
			let truncated = false;
			let buffer = '';
			const child = spawn(rgDiskPath, args, { cwd: dir, windowsHide: true });
			const timer = setTimeout(() => {
				truncated = true;
				child.kill();
			}, 15_000);
			const onLine = (line: string) => {
				if (!line.startsWith('{"type":"match"')) {
					return;
				}
				try {
					const event = JSON.parse(line) as { data: { path: { text?: string }; lines: { text?: string }; line_number: number; submatches: { start: number; end: number }[] } };
					const rawPath = event.data.path.text;
					const lineText = event.data.lines.text;
					if (!rawPath || lineText === undefined) {
						return;
					}
					// ripgrep reports byte offsets; convert them to string columns.
					const bytes = Buffer.from(lineText, 'utf8');
					const ranges = event.data.submatches.map(m => [bytes.subarray(0, m.start).toString('utf8').length, bytes.subarray(0, m.end).toString('utf8').length] as const);
					matches.push({ path: join(dir, rawPath), line: event.data.line_number, text: lineText.replace(/\r?\n$/, '').slice(0, 500), ranges });
					if (matches.length >= limit) {
						truncated = true;
						child.kill();
					}
				} catch {
					// a partial line
				}
			};
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				buffer += chunk;
				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					onLine(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
				}
			});
			child.on('error', err => {
				this.logService.warn('[volt agent server] search failed', err);
			});
			child.on('close', () => {
				clearTimeout(timer);
				if (buffer) {
					onLine(buffer);
				}
				resolve({ matches: matches.slice(0, limit), truncated });
			});
		});
	}

	//#endregion

	//#region Git

	private async gitStatus(root: string): Promise<{ repoRoot?: string; branch?: string; changes: IServerGitChange[] }> {
		const dir = await this.allowed(root);
		let repoRoot: string;
		try {
			repoRoot = (await run('git', ['rev-parse', '--show-toplevel'], dir)).trim();
		} catch {
			return { changes: [] };
		}
		const [status, branch, numstat] = await Promise.all([
			run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot),
			run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).then(s => s.trim()).catch(() => undefined),
			run('git', ['diff', 'HEAD', '--numstat', '-z'], repoRoot).catch(() => ''),
		]);
		const counts = parseNumstat(numstat);
		const changes: IServerGitChange[] = [];
		const parts = status.split('\0');
		for (let i = 0; i < parts.length; i++) {
			const entry = parts[i];
			if (entry.length < 4) {
				continue;
			}
			const x = entry[0];
			const y = entry[1];
			const rel = entry.slice(3);
			let oldRel: string | undefined;
			if (x === 'R' || x === 'C') {
				oldRel = parts[++i];
			}
			const code = x === '?' ? '?' : x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D') ? 'U' : x === 'R' || x === 'C' ? 'R' : x === 'A' ? 'A' : x === 'D' || y === 'D' ? 'D' : 'M';
			const count = counts.get(rel);
			changes.push({
				path: join(repoRoot, rel),
				rel,
				status: code,
				staged: x !== ' ' && x !== '?',
				...(oldRel ? { oldPath: join(repoRoot, oldRel) } : {}),
				...(count ? { additions: count[0], deletions: count[1] } : {}),
			});
		}
		return { repoRoot, ...(branch ? { branch } : {}), changes };
	}

	/** A file as `ref` has it (the left side of a diff); empty when it is new. */
	private async gitShow(path: string, ref: string): Promise<{ text: string; exists: boolean }> {
		const file = await this.allowed(path);
		if (!/^[\w./~^@{}-]+$/.test(ref)) {
			fail('BadRef', 'That is not a git revision.');
		}
		try {
			const repoRoot = (await run('git', ['rev-parse', '--show-toplevel'], dirname(file))).trim();
			const rel = relative(repoRoot, file).split(sep).join('/');
			return { text: await run('git', ['show', `${ref}:${rel}`], repoRoot), exists: true };
		} catch {
			return { text: '', exists: false };
		}
	}

	private async gitBlob(repoRoot: string, sha: string): Promise<{ text: string; exists: boolean }> {
		const dir = await this.allowed(repoRoot);
		if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
			return { text: '', exists: false };
		}
		try {
			return { text: await run('git', ['cat-file', '-p', sha], dir), exists: true };
		} catch {
			return { text: '', exists: false };
		}
	}

	/** Stages everything under the repository and commits it (Source Control's commit box). */
	private async gitCommit(root: string, message: string): Promise<{ commit: string }> {
		const dir = await this.allowed(root);
		if (!message.trim()) {
			fail('BadMessage', 'Write a commit message.');
		}
		let repoRoot: string;
		try {
			repoRoot = (await run('git', ['rev-parse', '--show-toplevel'], dir)).trim();
		} catch {
			return fail('NotARepository', 'This folder is not a git repository.');
		}
		await run('git', ['add', '-A'], repoRoot);
		try {
			await run('git', ['commit', '-m', message.trim()], repoRoot);
		} catch (err) {
			const detail = (err as { stderr?: string; stdout?: string }).stdout || (err as { stderr?: string }).stderr || '';
			return fail('CommitFailed', detail.trim().split('\n').slice(-3).join(' ') || 'git commit failed.');
		}
		return { commit: (await run('git', ['rev-parse', '--short', 'HEAD'], repoRoot)).trim() };
	}

	//#endregion
}

interface IGrepOptions {
	readonly regex?: boolean;
	readonly caseSensitive?: boolean;
	readonly wholeWord?: boolean;
	readonly include?: string;
	readonly exclude?: string;
	readonly maxResults?: number;
}

/** `git diff --numstat -z`: `adds\tdels\tpath\0` (a rename: `adds\tdels\t\0old\0new\0`). */
function parseNumstat(out: string): Map<string, readonly [number, number]> {
	const counts = new Map<string, readonly [number, number]>();
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
		if (!match) {
			continue;
		}
		let path = match[3];
		if (!path) {
			i += 2;
			path = parts[i] ?? '';
		}
		counts.set(path, [match[1] === '-' ? 0 : Number(match[1]), match[2] === '-' ? 0 : Number(match[2])]);
	}
	return counts;
}
