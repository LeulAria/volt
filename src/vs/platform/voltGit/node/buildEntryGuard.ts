/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { Dirent, promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { gitConfigHooksPath } from '../../voltSandbox/node/sandboxResolver.js';
import { IBuildEntryChange } from '../common/hostGit.js';

/**
 * The build-entry guard (I.6, INV-14). When a sandboxed writer starts in a workspace, the guard
 * records a hash of every execution-bearing file there (git config and hooks, the files that
 * redirect git, editor tasks, package scripts, Makefiles, `.envrc`, hook managers, worktree setup
 * files). Before Volt runs a task, an install, a commit hook or worktree setup for the user, it asks
 * the guard what changed since; changed entries are shown as a diff and wait for the user.
 *
 * The baseline only moves when the user accepts: a second sandboxed run never re-baselines what the
 * first one wrote. Records live in `~/.volt/trust/build-entry` (0600), which every sandbox is
 * denied, so a workload can neither read nor erase them; the agent server and the desktop app
 * share them.
 */

/** Files at a workspace root that a build, a task, an install or worktree setup runs. */
const BUILD_FILES = [
	'.vscode/tasks.json', '.vscode/launch.json', 'package.json', 'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml',
	'.envrc', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'build.rs',
	'.cargo/config.toml', '.cargo/config', 'pyproject.toml', 'setup.py', '.devcontainer/devcontainer.json',
	't3.json', 'volt.json', '.volt/worktrees.json', '.cursor/worktrees.json', '.volt/hooks.json',
];
/** Folders at a workspace root whose every file runs (hook managers). */
const BUILD_DIRS = ['.husky', '.githooks', '.volt/hooks'];
/** Names in a git folder that run code or point git elsewhere. */
const GIT_FILES = ['config', 'config.worktree', 'commondir', 'gitdir', 'info/attributes', 'objects/info/alternates', 'objects/info/http-alternates'];

const MAX_TEXT = 64 * 1024;
const MAX_HASHED = 4 * 1024 * 1024;
const MAX_DIR_FILES = 200;

interface IEntry {
	readonly group: 'git' | 'build';
	/** Null: the file did not exist. */
	readonly sha: string | null;
	readonly text?: string;
}

interface IRecord {
	readonly version: 1;
	readonly root: string;
	readonly takenAt: number;
	readonly entries: Record<string, IEntry>;
	/** Folders whose files were recorded one by one: a new file in one is an addition. */
	readonly dirs: Record<string, 'git' | 'build'>;
}

export class BuildEntryGuard {

	private readonly cache = new Map<string, { readonly mtimeMs: number; readonly record: IRecord }>();
	private readonly pending = new Map<string, Promise<void>>();

	constructor(
		private readonly dir: string,
		/** Where the user's git config lives (`core.hooksPath`). */
		private readonly home: string = homedir(),
	) { }

	/** Records the root's execution-bearing files, unless a baseline the user has not reviewed exists. */
	async snapshot(root: string): Promise<void> {
		const real = await fs.realpath(root).catch(() => undefined);
		if (!real) {
			return;
		}
		const running = this.pending.get(real);
		if (running) {
			return running;
		}
		const work = (async () => {
			if (await this.load(real)) {
				return;
			}
			const current = await collect(real, this.home);
			await this.save({ version: 1, root: real, takenAt: Date.now(), entries: current.entries, dirs: current.dirs });
		})().finally(() => this.pending.delete(real));
		this.pending.set(real, work);
		return work;
	}

	/** What changed since the baseline. Empty when no sandboxed writer has run in `root`. */
	async changes(root: string): Promise<IBuildEntryChange[]> {
		const real = await fs.realpath(root).catch(() => undefined);
		const record = real ? await this.load(real) : undefined;
		if (!record) {
			return [];
		}
		const current = await collect(record.root, this.home, record.dirs);
		const out: IBuildEntryChange[] = [];
		const paths = new Set([...Object.keys(record.entries), ...Object.keys(current.entries)]);
		for (const path of [...paths].sort()) {
			const before = record.entries[path];
			const after = current.entries[path];
			const was = before?.sha ?? null;
			const is = after?.sha ?? null;
			if (was === is) {
				continue;
			}
			out.push({
				path,
				group: (before ?? after)!.group,
				kind: was === null ? 'added' : is === null ? 'removed' : 'changed',
				...(before?.text !== undefined ? { before: before.text } : {}),
				...(after?.text !== undefined ? { after: after.text } : {}),
			});
		}
		return out;
	}

	/** The user reviewed `paths` (all when omitted): they become the baseline. */
	async accept(root: string, paths?: readonly string[]): Promise<void> {
		const real = await fs.realpath(root).catch(() => undefined);
		const record = real ? await this.load(real) : undefined;
		if (!record) {
			return;
		}
		const current = await collect(record.root, this.home, record.dirs);
		const entries: Record<string, IEntry> = { ...record.entries };
		for (const path of new Set([...Object.keys(record.entries), ...Object.keys(current.entries)])) {
			if (!paths || paths.includes(path)) {
				const now = current.entries[path];
				if (now) {
					entries[path] = now;
				} else {
					delete entries[path];
				}
			}
		}
		await this.save({ ...record, entries, dirs: { ...record.dirs, ...current.dirs } });
	}

	private file(root: string): string {
		return join(this.dir, `${createHash('sha256').update(root).digest('hex').slice(0, 40)}.json`);
	}

	private async load(root: string): Promise<IRecord | undefined> {
		const file = this.file(root);
		const st = await fs.stat(file).catch(() => undefined);
		if (!st) {
			this.cache.delete(root);
			return undefined;
		}
		const cached = this.cache.get(root);
		if (cached && cached.mtimeMs === st.mtimeMs) {
			return cached.record;
		}
		try {
			const record = JSON.parse(await fs.readFile(file, 'utf8')) as IRecord;
			if (record?.version !== 1 || record.root !== root || typeof record.entries !== 'object') {
				return undefined;
			}
			this.cache.set(root, { mtimeMs: st.mtimeMs, record });
			return record;
		} catch {
			return undefined;
		}
	}

	private async save(record: IRecord): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const file = this.file(record.root);
		const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
		await fs.rename(temp, file);
		this.cache.delete(record.root);
	}
}

let defaultGuard: BuildEntryGuard | undefined;

/** The guard every Volt process shares, under `~/.volt/trust` (denied to every sandbox). */
export function buildEntryGuard(): BuildEntryGuard {
	defaultGuard ??= new BuildEntryGuard(join(homedir(), '.volt', 'trust', 'build-entry'));
	return defaultGuard;
}

/** The repository's git folder and common folder for a work tree, as git itself would find them from `.git`. */
export async function gitFoldersOf(root: string): Promise<{ readonly gitDir: string; readonly commonDir: string } | undefined> {
	const dotGit = join(root, '.git');
	const st = await fs.lstat(dotGit).catch(() => undefined);
	let gitDir: string | undefined;
	if (st?.isDirectory()) {
		gitDir = dotGit;
	} else if (st?.isFile()) {
		const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8').catch(() => ''))?.[1]?.trim();
		gitDir = pointer ? resolve(root, pointer) : undefined;
	}
	if (!gitDir) {
		return undefined;
	}
	const common = (await fs.readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
	return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

async function collect(root: string, home: string, knownDirs: Readonly<Record<string, 'git' | 'build'>> = {}): Promise<{ entries: Record<string, IEntry>; dirs: Record<string, 'git' | 'build'> }> {
	const entries: Record<string, IEntry> = {};
	const dirs: Record<string, 'git' | 'build'> = { ...knownDirs };
	const files: [string, 'git' | 'build'][] = BUILD_FILES.map(name => [join(root, name), 'build']);
	for (const name of BUILD_DIRS) {
		dirs[join(root, name)] = 'build';
	}
	const git = await gitFoldersOf(root);
	if (git) {
		for (const folder of new Set([git.gitDir, git.commonDir])) {
			files.push(...GIT_FILES.map(name => [join(folder, name), 'git'] as [string, 'git']));
		}
		dirs[join(git.commonDir, 'hooks')] = 'git';
		// `core.hooksPath` from the repository's or the user's config: hooks in a tracked folder (GIT-3).
		for (const config of [join(git.commonDir, 'config'), join(git.gitDir, 'config.worktree'), join(home, '.gitconfig'), join(home, '.config', 'git', 'config')]) {
			const hooksPath = gitConfigHooksPath(await fs.readFile(config, 'utf8').catch(() => ''));
			if (hooksPath && !hooksPath.startsWith('~')) {
				dirs[isAbsolute(hooksPath) ? hooksPath : resolve(root, hooksPath)] = 'git';
			}
		}
	}
	for (const [path, group] of files) {
		entries[path] = await entry(path, group);
	}
	for (const [dir, group] of Object.entries(dirs)) {
		for (const path of await listFiles(dir)) {
			entries[path] = await entry(path, group);
		}
	}
	return { entries, dirs };
}

async function listFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (folder: string, depth: number) => {
		let list: Dirent[];
		try {
			list = await fs.readdir(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of list) {
			if (out.length >= MAX_DIR_FILES) {
				return;
			}
			const path = join(folder, item.name);
			if (item.isDirectory() && depth < 2) {
				await walk(path, depth + 1);
			} else if (!item.isDirectory()) {
				out.push(path);
			}
		}
	};
	await walk(dir, 0);
	return out;
}

async function entry(path: string, group: 'git' | 'build'): Promise<IEntry> {
	const st = await fs.lstat(path).catch(() => undefined);
	if (!st) {
		return { group, sha: null };
	}
	if (st.isSymbolicLink()) {
		const target = await fs.readlink(path).catch(() => '');
		return { group, sha: createHash('sha256').update(`symlink:${target}`).digest('hex'), text: `-> ${target}` };
	}
	if (!st.isFile() || st.size > MAX_HASHED) {
		return { group, sha: createHash('sha256').update(`${st.isFile() ? 'large' : 'other'}:${st.size}:${st.mtimeMs}`).digest('hex') };
	}
	let data = await fs.readFile(path).catch(() => undefined);
	if (!data) {
		return { group, sha: null };
	}
	if (basename(path) === 'package.json') {
		// Only what runs: the scripts, not every dependency bump.
		try {
			const scripts = (JSON.parse(data.toString('utf8')) as { scripts?: unknown }).scripts ?? {};
			data = Buffer.from(JSON.stringify(scripts, null, '\t'), 'utf8');
		} catch {
			// Not valid JSON: hashed as it is.
		}
	}
	const sha = createHash('sha256').update(data).digest('hex');
	const text = data.length <= MAX_TEXT && !data.includes(0) ? data.toString('utf8') : undefined;
	return { group, sha, ...(text !== undefined ? { text } : {}) };
}
