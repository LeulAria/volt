/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dirent, promises as fs } from 'fs';
import { homedir, userInfo } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { basename, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IVoltFsBrowseService, IVoltFsEntry, IVoltFsFoundFolders, IVoltFsInspect, IVoltFsListing, IVoltQuickAccessRoot, VoltFsListError } from '../common/voltFsBrowse.js';

/** Slow or network volumes answer with a timeout row instead of blocking the picker. */
const LIST_TIMEOUT_MS = 1500;
/** Past this many folders, entries come back without git and mtime details. */
const METADATA_LIMIT = 3000;
const METADATA_CONCURRENCY = 64;
const SEARCH_CONCURRENCY = 16;
const SEARCH_BATCH_MS = 40;
const DEFAULT_SEARCH_DEPTH = 5;
const DEFAULT_SEARCH_BUDGET_MS = 4000;
const DEFAULT_SEARCH_LIMIT = 200;

/** Folders deep search never enters: build output, caches, and OS internals. */
const SEARCH_SKIP = new Set([
	'node_modules', '.git', 'Library', 'AppData', '.cache', 'dist', 'build', 'out', 'target', '.venv', 'venv',
	'vendor', 'Pods', '.Trash', 'Applications', '.npm', '.cargo', '.rustup', '.gradle', '.m2', '__pycache__',
	'.next', '.nuxt', 'coverage', 'DerivedData', 'Movies', 'Music', 'Pictures', 'Photos Library.photoslibrary',
]);

/** Common homes for code, in the order they are offered. */
const CODE_FOLDERS = ['code', 'Code', 'dev', 'Developer', 'projects', 'Projects', 'src', 'repos', 'git', 'work', 'workspace'];

export class VoltFsBrowseService extends Disposable implements IVoltFsBrowseService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidFindFolders = this._register(new Emitter<IVoltFsFoundFolders>());
	readonly onDidFindFolders = this._onDidFindFolders.event;

	private readonly searches = new Map<string, { cancelled: boolean }>();

	async home(): Promise<string> {
		return homedir();
	}

	async list(dir: string, options?: { readonly showHidden?: boolean; readonly dirsOnly?: boolean }): Promise<IVoltFsListing> {
		const path = expandHome(dir);
		const dirsOnly = options?.dirsOnly ?? true;
		let dirents: Dirent[];
		try {
			dirents = await withTimeout(fs.readdir(path, { withFileTypes: true }), LIST_TIMEOUT_MS);
		} catch (err) {
			return { path, entries: [], truncated: false, error: listError(err) };
		}
		const candidates: { name: string; dirent: Dirent }[] = [];
		for (const dirent of dirents) {
			const hidden = isHiddenName(dirent.name);
			if (hidden && !options?.showHidden) {
				continue;
			}
			if (dirsOnly && !dirent.isDirectory() && !dirent.isSymbolicLink()) {
				continue;
			}
			candidates.push({ name: dirent.name, dirent });
		}
		let truncated = false;
		const entries = await mapLimit(candidates, METADATA_CONCURRENCY, async ({ name, dirent }, index): Promise<IVoltFsEntry | undefined> => {
			const full = join(path, name);
			const hidden = isHiddenName(name);
			let kind: 'dir' | 'file' = dirent.isDirectory() ? 'dir' : 'file';
			let symlink = false;
			let mtime: number | undefined;
			if (dirent.isSymbolicLink()) {
				// readdir reports links as links; follow them so linked folders are not hidden.
				symlink = true;
				try {
					const target = await fs.stat(full);
					kind = target.isDirectory() ? 'dir' : 'file';
					mtime = target.mtimeMs;
				} catch {
					return undefined;
				}
			}
			if (dirsOnly && kind !== 'dir') {
				return undefined;
			}
			if (index >= METADATA_LIMIT) {
				truncated = true;
				return { name, path: full, kind, symlink: symlink || undefined, hidden };
			}
			let gitRepo = false;
			if (kind === 'dir') {
				const [stat, git] = await Promise.all([
					mtime === undefined ? fs.stat(full).catch(() => undefined) : undefined,
					fs.lstat(join(full, '.git')).then(() => true, () => false),
				]);
				mtime ??= stat?.mtimeMs;
				gitRepo = git;
			}
			return { name, path: full, kind, symlink: symlink || undefined, hidden, gitRepo: gitRepo || undefined, mtime };
		});
		const present = entries.filter((entry): entry is IVoltFsEntry => !!entry);
		present.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.kind === 'dir' ? -1 : 1);
		return { path, entries: present, truncated };
	}

	async findFolders(requestId: string, query: string, roots: readonly string[], options?: { readonly maxDepth?: number; readonly budgetMs?: number; readonly limit?: number }): Promise<void> {
		const token = { cancelled: false };
		const previous = this.searches.get(requestId);
		if (previous) {
			previous.cancelled = true;
		}
		this.searches.set(requestId, token);
		const needle = query.trim().toLowerCase();
		const maxDepth = options?.maxDepth ?? DEFAULT_SEARCH_DEPTH;
		const deadline = Date.now() + (options?.budgetMs ?? DEFAULT_SEARCH_BUDGET_MS);
		const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
		let found = 0;
		let batch: IVoltFsEntry[] = [];
		let lastFlush = Date.now();
		const flush = (done: boolean) => {
			if (token.cancelled) {
				return;
			}
			if (batch.length || done) {
				this._onDidFindFolders.fire({ requestId, entries: batch, done });
				batch = [];
				lastFlush = Date.now();
			}
		};
		const seen = new Set<string>();
		let level = roots.map(expandHome).filter(root => {
			if (seen.has(root)) {
				return false;
			}
			seen.add(root);
			return true;
		});
		try {
			for (let depth = 0; depth < maxDepth && level.length && !token.cancelled; depth++) {
				const next: string[] = [];
				await mapLimit(level, SEARCH_CONCURRENCY, async dir => {
					if (token.cancelled || found >= limit || Date.now() > deadline) {
						return;
					}
					let dirents: Dirent[];
					try {
						dirents = await fs.readdir(dir, { withFileTypes: true });
					} catch {
						return;
					}
					for (const dirent of dirents) {
						// Links are not followed here: they can loop, and their targets are usually reachable anyway.
						if (!dirent.isDirectory() || isHiddenName(dirent.name) || SEARCH_SKIP.has(dirent.name)) {
							continue;
						}
						const full = join(dir, dirent.name);
						if (seen.has(full)) {
							continue;
						}
						seen.add(full);
						const isRepo = await fs.lstat(join(full, '.git')).then(() => true, () => false);
						if (isSubsequence(needle, dirent.name.toLowerCase()) && found < limit) {
							found++;
							batch.push({ name: dirent.name, path: full, kind: 'dir', hidden: false, gitRepo: isRepo || undefined });
							if (Date.now() - lastFlush > SEARCH_BATCH_MS) {
								flush(false);
							}
						}
						// A repo's own folders are rarely projects; skipping them keeps search fast.
						if (!isRepo) {
							next.push(full);
						}
					}
				});
				level = next;
			}
		} finally {
			flush(true);
			if (this.searches.get(requestId) === token) {
				this.searches.delete(requestId);
			}
		}
	}

	async cancelFind(requestId: string): Promise<void> {
		const search = this.searches.get(requestId);
		if (search) {
			search.cancelled = true;
			this.searches.delete(requestId);
		}
	}

	async quickAccess(): Promise<IVoltQuickAccessRoot[]> {
		const home = homedir();
		const roots: IVoltQuickAccessRoot[] = [{ id: 'home', label: localize('voltFs.home', "Home"), path: home }];
		const candidates: IVoltQuickAccessRoot[] = [
			{ id: 'desktop', label: localize('voltFs.desktop', "Desktop"), path: join(home, 'Desktop') },
			{ id: 'documents', label: localize('voltFs.documents', "Documents"), path: join(home, 'Documents') },
			{ id: 'downloads', label: localize('voltFs.downloads', "Downloads"), path: join(home, 'Downloads') },
			...CODE_FOLDERS.map(name => ({ id: 'code' as const, label: name, path: join(home, name) })),
		];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			const real = await fs.realpath(candidate.path).catch(() => undefined);
			// Case-insensitive disks report ~/code and ~/Code as the same folder.
			if (real && !seen.has(real.toLowerCase()) && await isDirectory(real)) {
				seen.add(real.toLowerCase());
				roots.push(candidate);
			}
		}
		roots.push(...await volumes());
		return roots;
	}

	async mkdir(parent: string, name: string): Promise<string> {
		const trimmed = name.trim();
		if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/\0]/.test(trimmed)) {
			throw new Error(localize('voltFs.badName', "A folder name cannot be empty or contain slashes."));
		}
		const path = join(expandHome(parent), trimmed);
		await fs.mkdir(path);
		return path;
	}

	async inspect(path: string): Promise<IVoltFsInspect> {
		const full = expandHome(path);
		let directory = false;
		try {
			directory = (await fs.stat(full)).isDirectory();
		} catch {
			return { exists: false, directory: false, empty: true };
		}
		if (!directory) {
			return { exists: true, directory: false, empty: false };
		}
		const names = await fs.readdir(full).catch(() => [] as string[]);
		return { exists: true, directory: true, empty: names.length === 0, gitRemote: await originUrl(full) };
	}
}

export function expandHome(path: string): string {
	const trimmed = path.trim();
	if (trimmed === '~') {
		return homedir();
	}
	if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		return join(homedir(), trimmed.slice(2));
	}
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(homedir(), trimmed);
}

function isHiddenName(name: string): boolean {
	return name.startsWith('.');
}

/** Every character of `needle` appears in `haystack`, in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
	let at = 0;
	for (let i = 0; i < haystack.length && at < needle.length; i++) {
		if (haystack[i] === needle[at]) {
			at++;
		}
	}
	return at === needle.length;
}

function listError(err: unknown): VoltFsListError {
	if (err instanceof TimeoutError) {
		return 'timeout';
	}
	switch ((err as NodeJS.ErrnoException)?.code) {
		case 'EACCES':
		case 'EPERM':
			return 'noAccess';
		case 'ENOTDIR':
			return 'notDirectory';
		default:
			return 'notFound';
	}
}

class TimeoutError extends Error { }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => timer = setTimeout(() => reject(new TimeoutError()), ms)),
	]).finally(() => clearTimeout(timer));
}

async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await map(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

async function isDirectory(path: string): Promise<boolean> {
	return fs.stat(path).then(stat => stat.isDirectory(), () => false);
}

async function volumes(): Promise<IVoltQuickAccessRoot[]> {
	const out: IVoltQuickAccessRoot[] = [];
	if (isWindows) {
		for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
			const path = `${letter}:\\`;
			if (await isDirectory(path)) {
				out.push({ id: 'volume', label: `${letter}:`, path });
			}
		}
		return out;
	}
	const parents = isMacintosh ? ['/Volumes'] : isLinux ? [`/media/${safeUser()}`, '/mnt'] : [];
	const rootDevice = await fs.stat('/').then(stat => stat.dev, () => undefined);
	for (const parent of parents) {
		const names = await fs.readdir(parent).catch(() => [] as string[]);
		for (const name of names) {
			const path = join(parent, name);
			// Only mount points: a disk of its own. The boot disk (a link to /) and plain folders left in /Volumes are not.
			const stat = !isHiddenName(name) ? await fs.stat(path).catch(() => undefined) : undefined;
			if (stat?.isDirectory() && stat.dev !== rootDevice) {
				out.push({ id: 'volume', label: name, path });
			}
		}
	}
	return out;
}

function safeUser(): string {
	try {
		return userInfo().username;
	} catch {
		return basename(homedir());
	}
}

async function originUrl(repo: string): Promise<string | undefined> {
	let gitDir = join(repo, '.git');
	try {
		const stat = await fs.stat(gitDir);
		if (stat.isFile()) {
			// A linked worktree: `.git` names the real git dir.
			const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(gitDir, 'utf8'))?.[1]?.trim();
			if (!pointer) {
				return undefined;
			}
			gitDir = resolve(repo, pointer);
			const common = await fs.readFile(join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
			if (common) {
				gitDir = resolve(gitDir, common.trim());
			}
		}
		const config = await fs.readFile(join(gitDir, 'config'), 'utf8');
		const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1];
		return section ? /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() : undefined;
	} catch {
		return undefined;
	}
}
