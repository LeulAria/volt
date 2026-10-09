/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { Dirent, promises as fs } from 'fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { withWorkingGitOnPath } from '../../voltGit/node/gitExecutable.js';
import {
	IVoltProjectStorageRequest,
	IVoltStorageCleanResult,
	IVoltStorageContext,
	IVoltStorageEntry,
	IVoltStorageItem,
	IVoltStorageReport,
	IVoltStorageService,
	VoltStorageId,
	VoltStorageKeep,
} from '../common/voltStorage.js';
import {
	browserDataBytes,
	cachedDataKeep,
	checkpointKeep,
	fileUriToPath,
	IStorageRowSpec,
	IVoltStorageLayout,
	logKeep,
	machineRows,
	nativeTranscriptKeep,
	samePathKey,
	sessionIdFromFile,
	summarizeRow,
	traceKeep,
	workspaceStorageKeep,
	workspaceStorageTarget,
	worktreeKeep,
	worktreeRepoKey,
} from '../common/voltStorageRules.js';

const WALK_CONCURRENCY = 32;
const GIT_TIMEOUT_MS = 20_000;
const USE_BLOCKS = process.platform !== 'win32';

/** Rows Electron cleans for the running app (its caches are open). */
export type VoltStorageCleaners = Partial<Record<'chromiumCache' | 'codeCache' | 'browserCache' | 'browserData', () => Promise<void>>>;

interface IMeasured {
	readonly bytes: number;
	readonly files: number;
}

/** Disk use like `du`: allocated blocks, hard links counted once, symlinks not followed. */
export async function measurePath(path: string, seen = new Set<string>()): Promise<IMeasured> {
	let bytes = 0;
	let files = 0;
	const queue: string[] = [path];
	const visit = async (current: string): Promise<void> => {
		let stat;
		try {
			stat = await fs.lstat(current);
		} catch {
			return;
		}
		if (stat.nlink > 1 && !stat.isDirectory()) {
			const key = `${stat.dev}:${stat.ino}`;
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
		}
		// Windows reports no blocks; there the file size stands in for disk use.
		bytes += USE_BLOCKS ? stat.blocks * 512 : stat.size;
		if (!stat.isDirectory()) {
			files++;
			return;
		}
		let children: string[];
		try {
			children = await fs.readdir(current);
		} catch {
			return;
		}
		for (const child of children) {
			queue.push(join(current, child));
		}
	};
	while (queue.length) {
		const batch = queue.splice(0, WALK_CONCURRENCY);
		await Promise.all(batch.map(visit));
	}
	return { bytes, files };
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

async function children(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

export class VoltStorageService implements IVoltStorageService {

	declare readonly _serviceBrand: undefined;

	/** One clean at a time; a second waits instead of racing the first over the same folders. */
	private cleaning: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly layout: IVoltStorageLayout,
		private readonly getEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService: ILogService,
		private readonly cleaners: VoltStorageCleaners = {},
	) { }

	async machineReport(context: IVoltStorageContext): Promise<IVoltStorageReport> {
		const started = Date.now();
		const items = await Promise.all(machineRows(this.layout).map(spec => this.measureRow(spec, context)));
		return { items, measuredAt: Date.now(), durationMs: Date.now() - started };
	}

	async projectReport(request: IVoltProjectStorageRequest): Promise<IVoltStorageReport> {
		const started = Date.now();
		const items = await Promise.all([
			this.projectWorktrees(request),
			this.projectChats(request),
			this.projectTraces(request),
			this.projectWorkspaceStorage(request),
			this.projectCheckpoints(request),
		]);
		return { items, measuredAt: Date.now(), durationMs: Date.now() - started };
	}

	clean(id: VoltStorageId, context: IVoltStorageContext, project?: IVoltProjectStorageRequest): Promise<IVoltStorageCleanResult> {
		const run = this.cleaning.then(() => this.doClean(id, context, project));
		this.cleaning = run.catch(() => undefined);
		return run;
	}

	private async doClean(id: VoltStorageId, context: IVoltStorageContext, project: IVoltProjectStorageRequest | undefined): Promise<IVoltStorageCleanResult> {
		// Measured again now: the window's numbers can be minutes old.
		let item: IVoltStorageItem;
		if (id.startsWith('project.')) {
			if (!project) {
				throw new Error('A project row needs its project.');
			}
			const report = await this.projectReport(project);
			item = report.items.find(candidate => candidate.id === id)!;
		} else {
			const spec = machineRows(this.layout).find(candidate => candidate.id === id);
			if (!spec) {
				throw new Error(`Unknown storage row ${id}.`);
			}
			item = await this.measureRow(spec, context);
		}
		if (!item.cleanable) {
			return { freedBytes: 0, removed: 0, skipped: item.keep ? item.roots.map(path => ({ path, keep: item.keep! })) : [], errors: [] };
		}
		const cleaner = this.cleaners[id as keyof VoltStorageCleaners];
		if (cleaner) {
			const before = item.bytes;
			try {
				await cleaner();
			} catch (err) {
				return { freedBytes: 0, removed: 0, skipped: [], errors: [String(err instanceof Error ? err.message : err)] };
			}
			const spec = machineRows(this.layout).find(candidate => candidate.id === id)!;
			const after = await this.measureRow(spec, context);
			return { freedBytes: Math.max(0, before - after.bytes), removed: 1, skipped: [], errors: [] };
		}
		if (id === 'chatHistory' || id === 'project.chats') {
			// Chats go through the history service in the window, which owns the index.
			return { freedBytes: 0, removed: 0, skipped: [], errors: [] };
		}
		const skipped: { path: string; keep: VoltStorageKeep }[] = [];
		const errors: string[] = [];
		let freedBytes = 0;
		let removed = 0;
		for (const entry of item.entries) {
			if (entry.keep) {
				skipped.push({ path: entry.path, keep: entry.keep });
				continue;
			}
			try {
				if (id === 'worktrees' || id === 'project.worktrees') {
					const result = await this.removeWorktree(entry.path);
					if (result) {
						skipped.push({ path: entry.path, keep: result });
						continue;
					}
				} else {
					await fs.rm(entry.path, { recursive: true, force: true });
				}
				freedBytes += entry.bytes;
				removed++;
			} catch (err) {
				errors.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (id === 'worktrees' || id === 'project.worktrees') {
			await this.removeEmptyRepoFolders();
		}
		this.logService.info(`[volt-storage] cleaned ${id}: ${removed} removed, ${skipped.length} kept, ${errors.length} failed, ${freedBytes} bytes`);
		return { freedBytes, removed, skipped, errors };
	}

	//#region Machine rows

	private async measureRow(spec: IStorageRowSpec, context: IVoltStorageContext): Promise<IVoltStorageItem> {
		switch (spec.id) {
			case 'worktrees':
				return this.machineWorktrees(spec, context);
			case 'browserData': {
				const [partition, cache] = await Promise.all([
					measurePath(spec.roots[0]),
					Promise.all(['Cache', 'Code Cache'].map(name => measurePath(join(spec.roots[0], name)))),
				]);
				return summarizeRow(spec, browserDataBytes(partition.bytes, cache.reduce((sum, part) => sum + part.bytes, 0)), []);
			}
			case 'chatHistory':
				return summarizeRow(spec, (await measurePath(spec.roots[0])).bytes, await this.chatEntries(spec.roots[0], undefined));
		}
		if (spec.unit === 'whole' || spec.unit === 'info') {
			const seen = new Set<string>();
			let bytes = 0;
			for (const root of spec.roots) {
				bytes += (await measurePath(root, seen)).bytes;
			}
			return summarizeRow(spec, bytes, []);
		}
		const entries: IVoltStorageEntry[] = [];
		let bytes = 0;
		const sessionIds = new Set(context.sessionIds);
		const running = new Set(context.runningSessionIds);
		const openWorkspaces = new Set(context.openWorkspaceIds);
		for (const root of spec.roots) {
			// The folder's own entry counts toward the total, like `du`.
			try {
				const stat = await fs.lstat(root);
				bytes += USE_BLOCKS ? stat.blocks * 512 : 0;
			} catch {
				continue;
			}
			const paths = spec.unit === 'files' ? await this.filesBelow(root) : (await children(root)).map(child => join(root, child.name));
			const measured = await Promise.all(paths.map(async path => ({ path, size: await measurePath(path) })));
			for (const { path, size } of measured) {
				bytes += size.bytes;
				entries.push({ path, bytes: size.bytes, keep: await this.entryKeep(spec.id, path, sessionIds, running, openWorkspaces) });
			}
		}
		return summarizeRow(spec, bytes, entries);
	}

	private async entryKeep(id: VoltStorageId, path: string, sessionIds: ReadonlySet<string>, running: ReadonlySet<string>, openWorkspaces: ReadonlySet<string>): Promise<VoltStorageKeep | undefined> {
		const name = basename(path);
		switch (id) {
			case 'logs':
				return logKeep(path, this.layout);
			case 'cachedData':
				return cachedDataKeep(name, this.layout.commit);
			case 'agentTraces':
				return traceKeep(name, running);
			case 'nativeTranscripts':
				return nativeTranscriptKeep(name, sessionIds);
			case 'workspaceStorage': {
				const target = workspaceStorageTarget(await readText(join(path, 'workspace.json')));
				const targetPath = target ? fileUriToPath(target) : undefined;
				return workspaceStorageKeep(name, target, targetPath ? await exists(targetPath) : false, openWorkspaces);
			}
			case 'checkpoints':
				return checkpointKeep(await this.checkpointTargetExists(path));
			default:
				return undefined;
		}
	}

	private async filesBelow(root: string): Promise<string[]> {
		const out: string[] = [];
		for (const child of await children(root)) {
			const path = join(root, child.name);
			if (child.isDirectory()) {
				out.push(...await this.filesBelow(path));
			} else {
				out.push(path);
			}
		}
		return out;
	}

	private async checkpointTargetExists(gitDir: string): Promise<boolean | undefined> {
		const config = await readText(join(gitDir, 'config'));
		const match = config?.match(/^\s*worktree\s*=\s*(.+?)\s*$/m);
		return match ? exists(match[1]) : undefined;
	}

	/** `~/.volt/worktrees/<repo>/<checkout>`: each checkout is an entry. */
	private async machineWorktrees(spec: IStorageRowSpec, context: IVoltStorageContext): Promise<IVoltStorageItem> {
		const root = spec.roots[0];
		const checkouts: string[] = [];
		for (const repo of await children(root)) {
			if (repo.isDirectory()) {
				for (const checkout of await children(join(root, repo.name))) {
					if (checkout.isDirectory()) {
						checkouts.push(join(root, repo.name, checkout.name));
					}
				}
			}
		}
		const bytes = (await measurePath(root)).bytes;
		return summarizeRow(spec, bytes, await this.worktreeEntries(checkouts, context));
	}

	private worktreeEntries(paths: readonly string[], context: IVoltStorageContext): Promise<IVoltStorageEntry[]> {
		return Promise.all(paths.map(async path => {
			const [size, dirty] = await Promise.all([measurePath(path), this.worktreeDirty(path)]);
			const ref = context.worktrees.find(candidate => samePathKey(candidate.path) === samePathKey(path));
			return { path, bytes: size.bytes, keep: worktreeKeep(path, context.worktrees, dirty), sessionId: ref?.sessionId };
		}));
	}

	/** Undefined when git cannot read it (not a worktree, or its repository is gone). */
	private async worktreeDirty(path: string): Promise<boolean | undefined> {
		if (!await exists(join(path, '.git'))) {
			return undefined;
		}
		const status = await this.git(path, ['status', '--porcelain', '--untracked-files=normal']);
		return status.code === 0 ? status.stdout.trim().length > 0 : undefined;
	}

	/** `git worktree remove` from the main checkout, which also refuses a dirty tree. Returns why it stayed, if it did. */
	private async removeWorktree(path: string): Promise<VoltStorageKeep | undefined> {
		if (await this.worktreeDirty(path) !== false) {
			return 'dirty';
		}
		const common = await this.git(path, ['rev-parse', '--git-common-dir']);
		if (common.code !== 0 || !common.stdout.trim()) {
			return 'unknown';
		}
		const raw = common.stdout.trim();
		const commonDir = isAbsolute(raw) ? raw : resolve(path, raw);
		const cwd = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
		const removed = await this.git(cwd, ['worktree', 'remove', path]);
		if (removed.code !== 0) {
			this.logService.warn(`[volt-storage] git worktree remove ${path}: ${removed.stderr.trim()}`);
			return 'dirty';
		}
		return undefined;
	}

	private async removeEmptyRepoFolders(): Promise<void> {
		for (const repo of await children(this.layout.worktreesRoot)) {
			const path = join(this.layout.worktreesRoot, repo.name);
			if (repo.isDirectory() && !(await children(path)).length) {
				await fs.rmdir(path).catch(() => undefined);
			}
		}
	}

	/** One entry per chat: its log plus its draft. */
	private async chatEntries(historyRoot: string, only: ReadonlySet<string> | undefined): Promise<IVoltStorageEntry[]> {
		const sessionsDir = join(historyRoot, 'sessions');
		const byId = new Map<string, { bytes: number; paths: string[] }>();
		for (const file of await children(sessionsDir)) {
			const id = sessionIdFromFile(file.name);
			if (!id || (only && !only.has(id))) {
				continue;
			}
			const path = join(sessionsDir, file.name);
			const size = await measurePath(path);
			const current = byId.get(id) ?? { bytes: 0, paths: [] };
			current.bytes += size.bytes;
			current.paths.push(path);
			byId.set(id, current);
		}
		return [...byId].map(([sessionId, value]) => ({ path: value.paths[0], bytes: value.bytes, sessionId, keep: 'exists' as const }));
	}

	//#endregion

	//#region Project rows

	private async repoKey(root: string): Promise<string | undefined> {
		const common = await this.git(root, ['rev-parse', '--git-common-dir']);
		if (common.code !== 0 || !common.stdout.trim()) {
			return undefined;
		}
		const raw = common.stdout.trim();
		return worktreeRepoKey(isAbsolute(raw) ? raw : resolve(root, raw));
	}

	private async projectWorktrees(request: IVoltProjectStorageRequest): Promise<IVoltStorageItem> {
		const key = await this.repoKey(request.root);
		const folder = key ? join(this.layout.worktreesRoot, key) : undefined;
		const paths = new Set<string>();
		if (folder) {
			for (const checkout of await children(folder)) {
				if (checkout.isDirectory()) {
					paths.add(join(folder, checkout.name));
				}
			}
		}
		const mine = new Set(request.projectSessionIds);
		for (const ref of request.worktrees) {
			if (mine.has(ref.sessionId) && await exists(ref.path)) {
				paths.add(normalize(ref.path));
			}
		}
		const entries = await this.worktreeEntries([...paths], request);
		return summarizeRow({ id: 'project.worktrees', roots: folder ? [folder] : [], unit: 'children' }, entries.reduce((sum, entry) => sum + entry.bytes, 0), entries);
	}

	private async projectChats(request: IVoltProjectStorageRequest): Promise<IVoltStorageItem> {
		const historyRoot = join(this.layout.userRoamingPath, 'agentSessions');
		const entries = await this.chatEntries(historyRoot, new Set(request.projectSessionIds));
		return summarizeRow({ id: 'project.chats', roots: [join(historyRoot, 'sessions')], unit: 'info' }, entries.reduce((sum, entry) => sum + entry.bytes, 0), entries);
	}

	private async projectTraces(request: IVoltProjectStorageRequest): Promise<IVoltStorageItem> {
		const dir = join(this.layout.userRoamingPath, 'voltTraces');
		const mine = new Set(request.projectSessionIds);
		const running = new Set(request.runningSessionIds);
		const entries: IVoltStorageEntry[] = [];
		for (const file of await children(dir)) {
			const id = sessionIdFromFile(file.name);
			if (id && mine.has(id)) {
				const path = join(dir, file.name);
				entries.push({ path, bytes: (await measurePath(path)).bytes, sessionId: id, keep: traceKeep(file.name, running) });
			}
		}
		return summarizeRow({ id: 'project.traces', roots: [dir], unit: 'children' }, entries.reduce((sum, entry) => sum + entry.bytes, 0), entries);
	}

	private async projectWorkspaceStorage(request: IVoltProjectStorageRequest): Promise<IVoltStorageItem> {
		const dir = join(this.layout.userRoamingPath, 'workspaceStorage');
		const root = normalize(request.root);
		const open = new Set(request.openWorkspaceIds);
		const entries: IVoltStorageEntry[] = [];
		for (const child of await children(dir)) {
			const path = join(dir, child.name);
			const target = workspaceStorageTarget(await readText(join(path, 'workspace.json')));
			const targetPath = target ? fileUriToPath(target) : undefined;
			if (targetPath && normalize(targetPath) === root) {
				entries.push({ path, bytes: (await measurePath(path)).bytes, keep: workspaceStorageKeep(child.name, target, true, open, true) });
			}
		}
		return summarizeRow({ id: 'project.workspaceStorage', roots: [dir], unit: 'children' }, entries.reduce((sum, entry) => sum + entry.bytes, 0), entries);
	}

	/** Checkpoints of a folder that is not a git repository (a shadow repository per folder). */
	private async projectCheckpoints(request: IVoltProjectStorageRequest): Promise<IVoltStorageItem> {
		const dir = join(this.layout.userDataPath, 'volt-checkpoints');
		const path = join(dir, `${createHash('sha1').update(resolve(request.root)).digest('hex').slice(0, 20)}.git`);
		const entries: IVoltStorageEntry[] = [];
		if (await exists(path)) {
			const busy = request.projectSessionIds.some(id => request.runningSessionIds.includes(id));
			entries.push({ path, bytes: (await measurePath(path)).bytes, keep: busy ? 'open' : undefined });
		}
		return summarizeRow({ id: 'project.checkpoints', roots: [dir], unit: 'children' }, entries.reduce((sum, entry) => sum + entry.bytes, 0), entries);
	}

	//#endregion

	private async git(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const env = await withWorkingGitOnPath(await this.getEnv().catch(() => process.env));
		return new Promise(resolvePromise => {
			execFile('git', [...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
				const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
				resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	}
}
