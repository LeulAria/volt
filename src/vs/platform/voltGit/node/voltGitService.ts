/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import { appendFile, copyFile, lstat, mkdir, readFile, readlink, readdir, rm, rmdir, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { SequencerByKey, timeout } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { dirname, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { withWorkingGitOnPath } from './gitExecutable.js';
import {
	IVoltGitApplyResult,
	IVoltGitBranchRef,
	IVoltGitBranches,
	IVoltGitCloneProgress,
	IVoltGitCloneRequest,
	IVoltGitDiffEntry,
	IVoltGitRef,
	IVoltGitRepo,
	IVoltGitRestoreEntry,
	IVoltGitRestoreRequest,
	IVoltGitRestoreResult,
	IVoltGitService,
	IVoltGitSnapshot,
	IVoltGitSnapshotRepo,
	IVoltGitSnapshotRequest,
	VOLT_SNAPSHOT_LIMITS,
	VoltGitChangeKind,
	VoltGitClonePhase,
	VoltGitError,
	VoltGitRestoreOutcome,
} from '../common/voltGit.js';

const DEFAULT_TIMEOUT_MS = 60_000;
/** Other git processes (the user, the SCM view) briefly hold index.lock; wait these long and retry. */
const INDEX_LOCK_RETRIES_MS = [100, 300, 900];
/** The tree of an empty folder; exists in every repo once written. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Leaked into child processes from a parent git hook, these would point commands at the wrong repo. */
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_COMMON_DIR'];

const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: 'Volt',
	GIT_AUTHOR_EMAIL: 'volt@localhost',
	GIT_COMMITTER_NAME: 'Volt',
	GIT_COMMITTER_EMAIL: 'volt@localhost',
};

interface IGitRun {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly env?: Record<string, string>;
	readonly input?: Uint8Array;
	readonly timeoutMs?: number;
	/** Exit codes that are not failures. Defaults to [0]. */
	readonly okCodes?: readonly number[];
	/** Never redirect to a private snapshot repo, even when `cwd` has one (repo discovery, branches, clone). */
	readonly plain?: boolean;
}

export interface IVoltGitServiceOptions {
	/** Folder for the private snapshot repos of folders outside git. Without it those folders get no snapshots. */
	readonly shadowRoot?: string;
}

/** Files `git merge-file` is not asked to merge: NUL bytes in the first 8000 bytes, like git's own check. */
const BINARY_SNIFF_BYTES = 8000;

/** A path's state in a snapshot or on disk; null when the file does not exist. */
interface IPathState {
	readonly blob: string;
	readonly mode: string;
}

/** Stands for "a folder is where the file should be": never matches anything, so it always conflicts. */
const FOLDER_STATE: IPathState = { blob: '', mode: '040000' };

interface IGitOutput {
	readonly exitCode: number;
	readonly stdout: Buffer;
	readonly stderr: string;
}

export class VoltGitService extends Disposable implements IVoltGitService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidCloneProgress = this._register(new Emitter<IVoltGitCloneProgress>());
	readonly onDidCloneProgress = this._onDidCloneProgress.event;

	private readonly queue = new SequencerByKey<string>();
	private readonly clones = new Map<string, ChildProcess>();
	/** Folder outside git → its private snapshot repo's git dir. */
	private readonly shadows = new Map<string, string>();
	private baseEnv: Promise<NodeJS.ProcessEnv> | undefined;

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService?: ILogService,
		private readonly options: IVoltGitServiceOptions = {},
	) {
		super();
	}

	async clone(request: IVoltGitCloneRequest): Promise<void> {
		if (!isAbsolute(request.dest)) {
			throw new VoltGitError(['clone'], null, `Destination must be an absolute path: ${request.dest}`);
		}
		if (!isSafeCloneUrl(request.url)) {
			throw new VoltGitError(['clone'], null, `Refusing to clone from ${request.url}`);
		}
		await mkdir(dirname(request.dest), { recursive: true });
		const extra: Record<string, string> = {};
		if (request.authHeader) {
			// Through the environment so the token is neither on the command line nor in .git/config.
			extra.GIT_CONFIG_COUNT = '1';
			extra.GIT_CONFIG_KEY_0 = `http.${request.authHost ?? 'https://github.com/'}.extraheader`;
			extra.GIT_CONFIG_VALUE_0 = request.authHeader;
		}
		const env = await this.env(extra);
		if (!env.GIT_SSH_COMMAND) {
			// Keys from the agent still work; a passphrase prompt fails fast instead of hanging.
			env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
		}
		const args = ['clone', '--progress', ...(request.ref ? ['--branch', request.ref] : []), ...(request.recursive ? ['--recurse-submodules'] : []), '--', request.url, request.dest];
		const emit = (phase: VoltGitClonePhase, percent: number, message?: string) => this._onDidCloneProgress.fire({ jobId: request.jobId, phase, percent, message });
		emit('starting', 0);
		await new Promise<void>((resolvePromise, reject) => {
			const child = spawn('git', ['--no-pager', ...args], { cwd: dirname(request.dest), env, windowsHide: true });
			this.clones.set(request.jobId, child);
			let stderr = '';
			let pending = '';
			let last = 0;
			child.stderr.on('data', (chunk: Buffer) => {
				const text = chunk.toString('utf8');
				stderr = (stderr + text).slice(-8000);
				pending += text;
				const lines = pending.split(/[\r\n]/);
				pending = lines.pop() ?? '';
				const now = Date.now();
				for (const line of lines.reverse()) {
					const progress = parseCloneProgress(line);
					if (progress) {
						if (now - last > 80 || progress.percent >= 100) {
							last = now;
							emit(progress.phase, progress.percent, line.trim());
						}
						break;
					}
				}
			});
			child.stdout.resume();
			child.on('error', err => {
				this.clones.delete(request.jobId);
				reject(new VoltGitError(args, null, err.message));
			});
			child.on('close', (code, signal) => {
				const cancelled = this.clones.get(request.jobId) !== child;
				this.clones.delete(request.jobId);
				if (cancelled || signal) {
					reject(new VoltGitError(args, code, 'Clone cancelled'));
				} else if (code !== 0) {
					reject(new VoltGitError(args, code, cleanCloneError(stderr)));
				} else {
					emit('done', 100);
					resolvePromise();
				}
			});
		});
	}

	async cancelClone(jobId: string): Promise<void> {
		const child = this.clones.get(jobId);
		if (child) {
			// Dropped first so close knows this was a cancel; git removes the half-made folder itself.
			this.clones.delete(jobId);
			child.kill('SIGTERM');
		}
	}

	async listBranches(request: { readonly repoRoot: string }): Promise<IVoltGitBranches> {
		const format = ['%(refname)', '%(creatordate:unix)', '%(if)%(authorname)%(then)%(authorname)%(else)%(taggername)%(end)', '%(subject)', '%(upstream:track)'].join('%00');
		const [head, out] = await Promise.all([
			this.run({ cwd: request.repoRoot, args: ['symbolic-ref', '-q', '--short', 'HEAD'], okCodes: [0, 1], plain: true }),
			this.run({ cwd: request.repoRoot, args: ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags'], plain: true }),
		]);
		const local: string[] = [];
		const remote: string[] = [];
		const tags: string[] = [];
		const refs: IVoltGitBranchRef[] = [];
		for (const line of out.stdout.toString('utf8').split('\n')) {
			const [ref, date, author = '', subject = '', track = ''] = line.split('\0');
			let kind: IVoltGitBranchRef['kind'];
			let name: string;
			if (ref.startsWith('refs/heads/')) {
				kind = 'local';
				name = ref.slice('refs/heads/'.length);
				local.push(name);
			} else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
				kind = 'remote';
				name = ref.slice('refs/remotes/'.length);
				remote.push(name);
			} else if (ref.startsWith('refs/tags/')) {
				kind = 'tag';
				name = ref.slice('refs/tags/'.length);
				tags.push(name);
			} else {
				continue;
			}
			refs.push({ kind, name, ref, subject, author, date: (Number(date) || 0) * 1000, ...kind === 'local' && track ? aheadBehind(track) : undefined });
		}
		const branch = head.exitCode === 0 ? head.stdout.toString('utf8').trim() || undefined : undefined;
		let detached: string | undefined;
		if (!branch) {
			const sha = await this.run({ cwd: request.repoRoot, args: ['rev-parse', '--short', 'HEAD'], okCodes: [0, 128], plain: true });
			detached = sha.exitCode === 0 ? sha.stdout.toString('utf8').trim() : undefined;
		}
		// HEAD names a branch that has no ref yet: the repo has no commits.
		const unborn = !!branch && !local.includes(branch);
		return { head: branch, unborn, detached, local, remote, tags, refs };
	}

	checkout(request: { readonly repoRoot: string; readonly ref: string; readonly kind: 'local' | 'remote' | 'tag' | 'detached' }): Promise<void> {
		return this.queue.queue(request.repoRoot, async () => {
			let args: string[];
			if (request.kind === 'tag') {
				args = ['switch', '--detach', `refs/tags/${request.ref}`];
			} else if (request.kind === 'detached') {
				args = ['switch', '--detach', request.ref];
			} else if (request.kind === 'remote') {
				const local = request.ref.slice(request.ref.indexOf('/') + 1);
				const exists = await this.run({ cwd: request.repoRoot, args: ['show-ref', '--verify', '-q', `refs/heads/${local}`], okCodes: [0, 1], plain: true });
				args = exists.exitCode === 0 ? ['switch', local] : ['switch', '--track', request.ref];
			} else {
				args = ['switch', request.ref];
			}
			await this.runOnIndex({ cwd: request.repoRoot, args, plain: true });
		});
	}

	createBranch(request: { readonly repoRoot: string; readonly name: string; readonly from?: string }): Promise<void> {
		return this.queue.queue(request.repoRoot, async () => {
			await this.run({ cwd: request.repoRoot, args: ['check-ref-format', '--branch', request.name], plain: true });
			// --no-track: a branch made from origin/x should not push back to x.
			if (request.from) {
				await this.runOnIndex({ cwd: request.repoRoot, args: ['switch', '--no-track', '-c', request.name, request.from], plain: true });
			} else {
				await this.run({ cwd: request.repoRoot, args: ['switch', '-c', request.name], plain: true });
			}
		});
	}

	async resolveRepo(folder: string): Promise<IVoltGitRepo | undefined> {
		const out = await this.run({ cwd: folder, args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], okCodes: [0, 128], plain: true });
		if (out.exitCode !== 0) {
			return undefined;
		}
		const [repoRoot, gitDir, commonDir] = out.stdout.toString('utf8').split('\n');
		if (!repoRoot || !gitDir || !commonDir) {
			return undefined;
		}
		return { repoRoot, gitDir, commonDir: resolve(folder, commonDir) };
	}

	async resolveSnapshotRepo(folder: string): Promise<IVoltGitSnapshotRepo | undefined> {
		const repo = await this.resolveRepo(folder).catch(() => undefined);
		if (repo) {
			const prefix = await this.run({ cwd: folder, args: ['rev-parse', '--show-prefix'], plain: true });
			return { ...repo, workTree: repo.repoRoot, indexFile: join(repo.gitDir, 'volt', 'snapshot.index'), shadow: false, folderPrefix: prefix.stdout.toString('utf8').trim() };
		}
		const root = this.options.shadowRoot;
		const workTree = resolve(folder);
		// Never index a whole home folder or disk.
		if (!root || workTree === resolve(homedir()) || dirname(workTree) === workTree) {
			return undefined;
		}
		try {
			if (!(await stat(workTree)).isDirectory()) {
				return undefined;
			}
		} catch {
			return undefined;
		}
		const gitDir = join(root, `${createHash('sha1').update(workTree).digest('hex').slice(0, 20)}.git`);
		if (!await exists(join(gitDir, 'HEAD'))) {
			await mkdir(root, { recursive: true });
			await this.run({ cwd: root, args: ['init', '--bare', '-q', gitDir], plain: true });
			await this.run({ cwd: root, args: ['--git-dir', gitDir, 'config', 'core.bare', 'false'], plain: true });
			await this.run({ cwd: root, args: ['--git-dir', gitDir, 'config', 'core.worktree', workTree], plain: true });
			await appendFile(join(gitDir, 'info', 'exclude'), '.DS_Store\nThumbs.db\n').catch(() => undefined);
		}
		this.shadows.set(workTree, gitDir);
		return { repoRoot: workTree, gitDir, commonDir: gitDir, workTree, indexFile: join(gitDir, 'volt-snapshot.index'), shadow: true, folderPrefix: '' };
	}

	snapshot(request: IVoltGitSnapshotRequest): Promise<IVoltGitSnapshot> {
		return this.queue.queue(request.repoRoot, async () => {
			const started = Date.now();
			const workTree = request.workTree ?? request.repoRoot;
			const indexFile = request.indexFile;
			const deadline = started + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const remaining = () => Math.max(1, deadline - Date.now());
			const warm = await exists(indexFile);
			if (!warm) {
				// Starting from the user's index reuses its stat cache, so only changed files are hashed.
				await mkdir(dirname(indexFile), { recursive: true });
				const real = await this.gitPath(workTree, 'index');
				await copyFile(real, indexFile).catch(err => {
					if (err?.code !== 'ENOENT') {
						throw err;
					}
				});
			}
			const env = { GIT_INDEX_FILE: indexFile };
			const config = ['-c', 'core.untrackedCache=true', '-c', 'core.splitIndex=false'];
			try {
				// Files the private index already has: modifications and deletions.
				const hinted = warm && !!request.paths?.length;
				let scope = hinted ? request.paths : undefined;
				const updated = await this.run({ cwd: workTree, args: [...config, 'add', '-u', '--', ...(scope ?? [])], env, timeoutMs: remaining(), okCodes: hinted ? [0, 128] : [0] });
				if (updated.exitCode !== 0) {
					// A hinted path the index does not know (new, or gone everywhere); scan everything instead.
					scope = undefined;
					await this.run({ cwd: workTree, args: [...config, 'add', '-u'], env, timeoutMs: remaining() });
				}
				const skipped = await this.addUntracked(workTree, indexFile, scope, request, env, remaining);
				const tree = (await this.run({ cwd: workTree, args: ['write-tree'], env, timeoutMs: remaining() })).stdout.toString('utf8').trim();
				if (request.reuse && request.reuse.tree === tree) {
					return { commit: request.reuse.commit, tree, ...(skipped ? { skipped } : {}) };
				}
				const parent = request.parent ?? await this.head(workTree);
				const commitArgs = ['commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : []), '-m', request.message];
				const commit = (await this.run({ cwd: request.repoRoot, args: commitArgs, env: SNAPSHOT_IDENTITY, timeoutMs: remaining() })).stdout.toString('utf8').trim();
				// Published last, so a ref never names a commit whose objects are missing.
				await this.run({ cwd: request.repoRoot, args: ['update-ref', request.ref, commit], timeoutMs: remaining() });
				this.logService?.trace(`[volt-git] snapshot ${request.ref} in ${Date.now() - started}ms${skipped ? `, ${skipped} untracked files left out` : ''}`);
				return { commit, tree, ...(skipped ? { skipped } : {}) };
			} catch (err) {
				// A killed `add` leaves the private index locked for every later snapshot.
				await rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
				throw err;
			}
		});
	}

	/**
	 * Adds the untracked, not ignored files the private index does not have yet, minus dependency
	 * folders and anything over the size and count limits. Left-out paths are remembered next to
	 * the index so they stay out for good. Returns how many were left out this time.
	 */
	private async addUntracked(workTree: string, indexFile: string, scope: readonly string[] | undefined, limits: IVoltGitSnapshotRequest, env: Record<string, string>, remaining: () => number): Promise<number> {
		const listed = await this.run({ cwd: workTree, args: ['-c', 'core.untrackedCache=true', 'ls-files', '-o', '--exclude-standard', '-z', '--', ...(scope ?? [])], env, timeoutMs: remaining() });
		const skipFile = `${indexFile}.skip`;
		const sticky = new Set((await readFile(skipFile, 'utf8').catch(() => '')).split('\0').filter(Boolean));
		const heavy = new Set(VOLT_SNAPSHOT_LIMITS.heavyFolders);
		// Nested repositories come back as `dir/`; adding them would record a gitlink no restore can rebuild.
		const candidates = listed.stdout.toString('utf8').split('\0')
			.filter(path => path && !path.endsWith('/') && !sticky.has(path) && !path.split('/').slice(0, -1).some(segment => heavy.has(segment)));
		const maxFileBytes = limits.maxFileBytes ?? VOLT_SNAPSHOT_LIMITS.maxFileBytes;
		const maxNewFiles = limits.maxNewFiles ?? VOLT_SNAPSHOT_LIMITS.maxNewFiles;
		const maxNewBytes = limits.maxNewBytes ?? VOLT_SNAPSHOT_LIMITS.maxNewBytes;
		const sizes = await mapLimit(candidates, 64, path => lstat(join(workTree, path)).then(info => info.isDirectory() ? -1 : info.size, () => -1));
		const add: string[] = [];
		const leftOut: string[] = [];
		let bytes = 0;
		candidates.forEach((path, i) => {
			const size = sizes[i];
			if (size < 0) {
				return;
			}
			if (size > maxFileBytes || add.length >= maxNewFiles || bytes + size > maxNewBytes) {
				leftOut.push(path);
				return;
			}
			bytes += size;
			add.push(path);
		});
		if (leftOut.length) {
			await appendFile(skipFile, leftOut.map(path => `${path}\0`).join(''));
		}
		if (add.length) {
			await this.run({ cwd: workTree, args: ['-c', 'core.splitIndex=false', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], env, input: VSBuffer.fromString(add.join('\0')).buffer, timeoutMs: remaining() });
		}
		return leftOut.length;
	}

	writeIndexTree(request: { readonly repoRoot: string }): Promise<string> {
		return this.queue.queue(request.repoRoot, async () => {
			const real = await this.gitPath(request.repoRoot, 'index');
			const copy = join(tmpdir(), `volt-index-${generateUuid()}`);
			try {
				try {
					await copyFile(real, copy);
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
						return (await this.run({ cwd: request.repoRoot, args: ['mktree'], input: new Uint8Array() })).stdout.toString('utf8').trim() || EMPTY_TREE;
					}
					throw err;
				}
				// write-tree also refreshes the index's cache-tree, which would rewrite the user's file.
				return (await this.run({ cwd: request.repoRoot, args: ['write-tree'], env: { GIT_INDEX_FILE: copy } })).stdout.toString('utf8').trim();
			} finally {
				await rm(copy, { force: true }).catch(() => undefined);
				await rm(`${copy}.lock`, { force: true }).catch(() => undefined);
			}
		});
	}

	async diffSummary(request: { readonly repoRoot: string; readonly from: string; readonly to: string; readonly paths?: readonly string[]; readonly renames?: boolean }): Promise<IVoltGitDiffEntry[]> {
		const args = ['-c', 'core.quotePath=false', 'diff', '--raw', '--numstat', '-z', request.renames === false ? '--no-renames' : '-M', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-color', request.from, request.to, '--', ...(request.paths ?? [])];
		const out = await this.run({ cwd: request.repoRoot, args });
		return parseDiffSummary(out.stdout.toString('utf8'));
	}

	async readBlob(request: { readonly repoRoot: string; readonly sha: string; readonly path?: string }): Promise<VSBuffer> {
		if (request.path) {
			// As checked out: line endings and smudge filters, so the text matches the file on disk.
			const filtered = await this.run({ cwd: request.repoRoot, args: ['cat-file', '--filters', `--path=${request.path}`, request.sha], okCodes: [0, 128] });
			if (filtered.exitCode === 0) {
				return VSBuffer.wrap(filtered.stdout);
			}
		}
		const out = await this.run({ cwd: request.repoRoot, args: ['cat-file', 'blob', request.sha] });
		return VSBuffer.wrap(out.stdout);
	}

	async writeBlob(request: { readonly repoRoot: string; readonly content: VSBuffer; readonly path?: string }): Promise<string> {
		const args = ['hash-object', '-w', '--stdin', ...(request.path ? [`--path=${request.path}`] : ['--no-filters'])];
		const out = await this.run({ cwd: request.repoRoot, args, input: request.content.buffer });
		return out.stdout.toString('utf8').trim();
	}

	setIndexEntry(request: { readonly repoRoot: string; readonly path: string; readonly blob: string | null; readonly mode?: string }): Promise<void> {
		return this.queue.queue(request.repoRoot, async () => {
			if (request.blob === null) {
				await this.runOnIndex({ cwd: request.repoRoot, args: ['update-index', '--force-remove', '--', request.path] });
				return;
			}
			const mode = request.mode ?? await this.indexMode(request.repoRoot, request.path) ?? '100644';
			await this.runOnIndex({ cwd: request.repoRoot, args: ['update-index', '--add', '--cacheinfo', mode, request.blob, request.path] });
		});
	}

	resetIndexPaths(request: { readonly repoRoot: string; readonly treeish: string; readonly paths: readonly string[] }): Promise<void> {
		if (!request.paths.length) {
			return Promise.resolve();
		}
		return this.queue.queue(request.repoRoot, async () => {
			await this.runOnIndex({ cwd: request.repoRoot, args: ['reset', '-q', request.treeish, '--', ...request.paths] });
		});
	}

	updateRef(request: { readonly repoRoot: string; readonly ref: string; readonly commit?: string }): Promise<void> {
		return this.queue.queue(request.repoRoot, async () => {
			const args = request.commit ? ['update-ref', request.ref, request.commit] : ['update-ref', '-d', request.ref];
			await this.run({ cwd: request.repoRoot, args });
		});
	}

	async listRefs(request: { readonly repoRoot: string; readonly prefix: string }): Promise<IVoltGitRef[]> {
		const out = await this.run({ cwd: request.repoRoot, args: ['for-each-ref', '--format=%(objectname) %(refname)', request.prefix] });
		const refs: IVoltGitRef[] = [];
		for (const line of out.stdout.toString('utf8').split('\n')) {
			const space = line.indexOf(' ');
			if (space > 0) {
				refs.push({ commit: line.slice(0, space), ref: line.slice(space + 1) });
			}
		}
		return refs;
	}

	deleteRefs(request: { readonly repoRoot: string; readonly prefix: string }): Promise<void> {
		return this.queue.queue(request.repoRoot, async () => {
			const refs = await this.listRefs(request);
			if (!refs.length) {
				return;
			}
			const input = refs.map(ref => `delete ${ref.ref}\n`).join('');
			await this.run({ cwd: request.repoRoot, args: ['update-ref', '--stdin'], input: VSBuffer.fromString(input).buffer });
		});
	}

	applyPatch(request: { readonly repoRoot: string; readonly from: string; readonly to: string; readonly paths?: readonly string[]; readonly reverse?: boolean; readonly index: boolean }): Promise<IVoltGitApplyResult> {
		return this.queue.queue(request.repoRoot, async () => {
			const diff = await this.run({ cwd: request.repoRoot, args: ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', request.from, request.to, '--', ...(request.paths ?? [])] });
			if (!diff.stdout.length) {
				return { ok: true, conflicts: [], stderr: '' };
			}
			if (request.index) {
				// `apply --index` compares stat data; a file rewritten with the same content would read as "does not match index".
				await this.runOnIndex({ cwd: request.repoRoot, args: ['update-index', '-q', '--refresh'], okCodes: [0, 1] });
			}
			// --3way needs the index; without it the apply is all-or-nothing.
			const args = ['apply', '--whitespace=nowarn', ...(request.index ? ['--3way', '--index'] : []), ...(request.reverse ? ['-R'] : []), '-'];
			const out = await this.runOnIndex({ cwd: request.repoRoot, args, input: diff.stdout, okCodes: [0, 1] });
			if (out.exitCode === 0) {
				return { ok: true, conflicts: [], stderr: out.stderr };
			}
			const conflicts = out.stderr.split('\n').filter(line => line.startsWith('U ')).map(line => line.slice(2));
			if (!request.index || !conflicts.length) {
				throw new VoltGitError(args, out.exitCode, out.stderr);
			}
			return { ok: false, conflicts, stderr: out.stderr };
		});
	}

	restore(request: IVoltGitRestoreRequest): Promise<IVoltGitRestoreResult> {
		return this.queue.queue(request.repoRoot, () => this.doRestore(request));
	}

	private async doRestore(request: IVoltGitRestoreRequest): Promise<IVoltGitRestoreResult> {
		const cwd = request.repoRoot;
		const workTree = request.workTree ?? request.repoRoot;
		const timeoutMs = request.timeoutMs;
		// Per path, the steps that touched it, newest first.
		const chains = new Map<string, { before: IPathState | null; after: IPathState | null; binary: boolean }[]>();
		for (const step of request.steps) {
			const args = ['-c', 'core.quotePath=false', 'diff', '--raw', '--numstat', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-color', step.before, step.after, '--', ...(request.paths ?? [])];
			const out = await this.run({ cwd, args, timeoutMs });
			for (const entry of parseDiffSummary(out.stdout.toString('utf8'))) {
				// Submodules are recorded as commits, not files; nothing here can write them back.
				if (entry.oldMode === '160000' || entry.newMode === '160000') {
					continue;
				}
				const chain = chains.get(entry.path) ?? [];
				chain.push({
					before: entry.oldBlob ? { blob: entry.oldBlob, mode: entry.oldMode ?? '100644' } : null,
					after: entry.newBlob ? { blob: entry.newBlob, mode: entry.newMode ?? '100644' } : null,
					binary: entry.binary,
				});
				chains.set(entry.path, chain);
			}
		}
		const paths = [...chains.keys()];
		const current = await this.workTreeStates(cwd, workTree, paths, timeoutMs);
		const entries: IVoltGitRestoreEntry[] = [];
		const writes: { path: string; state: IPathState }[] = [];
		const deletes: string[] = [];
		for (const path of paths) {
			const chain = chains.get(path)!;
			const now = current.get(path) ?? null;
			let state = now;
			let outcome: VoltGitRestoreOutcome = 'restored';
			let binary = chain.some(step => step.binary);
			for (const step of chain) {
				if (sameState(state, step.after)) {
					state = step.before;
				} else if (sameState(state, step.before)) {
					continue;
				} else {
					const mergeable = state && step.before && step.after && state !== FOLDER_STATE && ![state.mode, step.before.mode, step.after.mode].includes('120000');
					const merged = mergeable
						? await this.mergeBlobs(cwd, state!.blob, step.after!.blob, step.before!.blob, timeoutMs)
						: undefined;
					if (merged && merged !== 'binary') {
						state = { blob: merged, mode: state!.mode };
						outcome = 'merged';
						continue;
					}
					binary ||= merged === 'binary';
					if (request.overwrite && now !== FOLDER_STATE) {
						state = chain[chain.length - 1].before;
						outcome = 'restored';
					} else {
						state = now;
						outcome = 'conflict';
					}
					break;
				}
			}
			const action = sameState(state, now) ? 'none' : !state ? 'delete' : !now ? 'create' : 'write';
			if (action === 'none' && outcome !== 'conflict') {
				outcome = 'unchanged';
			}
			entries.push({ path, action, outcome, binary, editedSince: !sameState(now, chain[0].after) });
			if (action === 'delete') {
				deletes.push(path);
			} else if (action !== 'none') {
				writes.push({ path, state: state! });
			}
		}
		const conflicts = entries.filter(entry => entry.outcome === 'conflict').map(entry => entry.path);
		if (request.dryRun) {
			return { entries, conflicts, applied: false };
		}
		if (writes.length) {
			await this.checkoutStates(cwd, writes, timeoutMs);
		}
		for (const path of deletes) {
			await rm(join(workTree, path), { force: true });
			await pruneEmptyParents(workTree, path);
		}
		return { entries, conflicts, applied: true };
	}

	/** Each path's blob and mode on disk, hashed the way `git add` would (clean filters applied). */
	private async workTreeStates(cwd: string, workTree: string, paths: readonly string[], timeoutMs: number | undefined): Promise<Map<string, IPathState | null>> {
		const states = new Map<string, IPathState | null>();
		const files: { path: string; mode: string }[] = [];
		for (const path of paths) {
			let info;
			try {
				info = await lstat(join(workTree, path));
			} catch {
				states.set(path, null);
				continue;
			}
			if (info.isSymbolicLink()) {
				const target = await readlink(join(workTree, path));
				const blob = (await this.run({ cwd, args: ['hash-object', '-w', '--no-filters', '--stdin'], input: VSBuffer.fromString(target).buffer, timeoutMs })).stdout.toString('utf8').trim();
				states.set(path, { blob, mode: '120000' });
			} else if (info.isDirectory()) {
				states.set(path, FOLDER_STATE);
			} else {
				files.push({ path, mode: process.platform !== 'win32' && (info.mode & 0o111) ? '100755' : '100644' });
			}
		}
		// Written (-w) so a three-way merge can read the file's clean content back.
		const batch = files.filter(file => !file.path.includes('\n'));
		if (batch.length) {
			const out = await this.run({ cwd: workTree, args: ['hash-object', '-w', '--stdin-paths'], input: VSBuffer.fromString(batch.map(file => file.path).join('\n') + '\n').buffer, timeoutMs });
			const blobs = out.stdout.toString('utf8').split('\n');
			batch.forEach((file, i) => states.set(file.path, { blob: blobs[i].trim(), mode: file.mode }));
		}
		for (const file of files.filter(file => file.path.includes('\n'))) {
			const out = await this.run({ cwd: workTree, args: ['hash-object', '-w', '--', file.path], timeoutMs });
			states.set(file.path, { blob: out.stdout.toString('utf8').trim(), mode: file.mode });
		}
		return states;
	}

	/**
	 * `git merge-file` on three blobs: `ours` with the change from `base` to `theirs` applied.
	 * Returns the merged blob, undefined on overlapping edits, or 'binary'.
	 */
	private async mergeBlobs(cwd: string, ours: string, base: string, theirs: string, timeoutMs: number | undefined): Promise<string | 'binary' | undefined> {
		const contents = await Promise.all([ours, base, theirs].map(sha => this.run({ cwd, args: ['cat-file', 'blob', sha], timeoutMs }).then(out => out.stdout)));
		if (contents.some(content => content.subarray(0, BINARY_SNIFF_BYTES).includes(0))) {
			return 'binary';
		}
		const dir = join(tmpdir(), `volt-merge-${generateUuid()}`);
		await mkdir(dir, { recursive: true });
		try {
			const files = ['ours', 'base', 'theirs'].map(name => join(dir, name));
			await Promise.all(files.map((file, i) => writeFile(file, contents[i])));
			const merged = await this.run({ cwd, args: ['merge-file', '-p', ...files], okCodes: Array.from({ length: 128 }, (_, i) => i), timeoutMs });
			if (merged.exitCode !== 0) {
				return undefined;
			}
			return (await this.run({ cwd, args: ['hash-object', '-w', '--no-filters', '--stdin'], input: merged.stdout, timeoutMs })).stdout.toString('utf8').trim();
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Writes blobs to the work tree through a throwaway index, so modes, symlinks and smudge filters apply and the user's index is untouched. */
	private async checkoutStates(cwd: string, writes: readonly { path: string; state: IPathState }[], timeoutMs: number | undefined): Promise<void> {
		const index = join(tmpdir(), `volt-restore-${generateUuid()}`);
		const env = { GIT_INDEX_FILE: index };
		try {
			const info = writes.map(({ path, state }) => `${state.mode} ${state.blob}\t${path}\0`).join('');
			await this.run({ cwd, args: ['update-index', '-z', '--index-info'], env, input: VSBuffer.fromString(info).buffer, timeoutMs });
			await this.run({ cwd, args: ['checkout-index', '-f', '-z', '--stdin'], env, input: VSBuffer.fromString(writes.map(write => `${write.path}\0`).join('')).buffer, timeoutMs });
		} finally {
			await rm(index, { force: true }).catch(() => undefined);
			await rm(`${index}.lock`, { force: true }).catch(() => undefined);
		}
	}

	private async head(cwd: string): Promise<string | undefined> {
		const out = await this.run({ cwd, args: ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], okCodes: [0, 1, 128] });
		return out.exitCode === 0 ? out.stdout.toString('utf8').trim() || undefined : undefined;
	}

	private async gitPath(cwd: string, name: string): Promise<string> {
		const out = await this.run({ cwd, args: ['rev-parse', '--git-path', name] });
		return resolve(cwd, out.stdout.toString('utf8').trim());
	}

	private async indexMode(cwd: string, path: string): Promise<string | undefined> {
		const out = await this.run({ cwd, args: ['ls-files', '--stage', '-z', '--', path] });
		const entry = out.stdout.toString('utf8').split('\0')[0];
		return entry ? entry.split(' ')[0] : undefined;
	}

	/** Runs a command that writes the user's index, waiting out another process's index.lock. */
	private async runOnIndex(run: IGitRun): Promise<IGitOutput> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.run(run);
			} catch (err) {
				if (!(err instanceof VoltGitError) || !err.stderr.includes('index.lock') || attempt >= INDEX_LOCK_RETRIES_MS.length) {
					throw err;
				}
				await timeout(INDEX_LOCK_RETRIES_MS[attempt]);
			}
		}
	}

	private async env(extra: Record<string, string> | undefined): Promise<NodeJS.ProcessEnv> {
		this.baseEnv ??= this.resolveEnv().then(withWorkingGitOnPath).then(resolved => {
			const env: NodeJS.ProcessEnv = { ...resolved };
			for (const key of SCRUBBED_ENV) {
				delete env[key];
			}
			return {
				...env,
				GIT_TERMINAL_PROMPT: '0',
				GIT_OPTIONAL_LOCKS: '0',
				GIT_LITERAL_PATHSPECS: '1',
				LC_ALL: 'C',
			};
		});
		const base = await this.baseEnv;
		return extra ? { ...base, ...extra } : base;
	}

	private async run(run: IGitRun): Promise<IGitOutput> {
		const env = await this.env(run.env);
		const shadow = run.plain ? undefined : this.shadows.get(run.cwd);
		// A folder outside git: point every command at its private repo, with the folder as work tree.
		const args = ['--no-pager', ...(shadow ? [`--git-dir=${shadow}`, `--work-tree=${run.cwd}`] : []), ...run.args];
		const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		return new Promise<IGitOutput>((resolvePromise, reject) => {
			const child = spawn('git', args, { cwd: run.cwd, env, windowsHide: true });
			const stdout: Buffer[] = [];
			let stderr = '';
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, timeoutMs);
			child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => stderr += chunk.toString('utf8'));
			child.on('error', err => {
				clearTimeout(timer);
				reject(new VoltGitError(run.args, null, err.message));
			});
			child.on('close', code => {
				clearTimeout(timer);
				if (timedOut) {
					reject(new VoltGitError(run.args, code, stderr, true));
				} else if (code === null || !(run.okCodes ?? [0]).includes(code)) {
					reject(new VoltGitError(run.args, code, stderr));
				} else {
					resolvePromise({ exitCode: code, stdout: Buffer.concat(stdout), stderr });
				}
			});
			child.stdin.on('error', () => { /* the exit code reports it */ });
			child.stdin.end(run.input ? Buffer.from(run.input.buffer, run.input.byteOffset, run.input.byteLength) : undefined);
		});
	}
}

function sameState(a: IPathState | null, b: IPathState | null): boolean {
	if (!a || !b) {
		return a === b;
	}
	if (a === FOLDER_STATE || b === FOLDER_STATE || a.blob !== b.blob) {
		return false;
	}
	// The executable bit only counts where the file system keeps it.
	const kind = (mode: string) => mode === '120000' ? 'link' : process.platform !== 'win32' && mode === '100755' ? 'exec' : 'file';
	return kind(a.mode) === kind(b.mode);
}

/** Removes folders left empty by a deleted file, up to (not including) the work tree. */
async function pruneEmptyParents(workTree: string, path: string): Promise<void> {
	let dir = dirname(join(workTree, path));
	const top = resolve(workTree);
	while (resolve(dir) !== top && resolve(dir).startsWith(top)) {
		try {
			if ((await readdir(dir)).length) {
				return;
			}
			await rmdir(dir);
		} catch {
			return;
		}
		dir = dirname(dir);
	}
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

interface IRawEntry {
	path: string;
	oldPath?: string;
	kind: VoltGitChangeKind;
	oldBlob?: string;
	newBlob?: string;
	oldMode?: string;
	newMode?: string;
}

const ZERO_SHA = /^0+$/;

/**
 * Parses `git diff --raw --numstat -z -M --no-abbrev`: every raw record comes first
 * (`:modes shas status\0path\0`, renames with a second path), then the numstat records
 * (`adds\tdels\tpath\0`, renames as `adds\tdels\t\0old\0new\0`; binary files count `-`).
 */
export function parseDiffSummary(output: string): IVoltGitDiffEntry[] {
	const tokens = output.split('\0');
	const raw = new Map<string, IRawEntry>();
	const order: string[] = [];
	const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
	for (let i = 0; i < tokens.length;) {
		const token = tokens[i];
		if (!token) {
			i++;
			continue;
		}
		if (token.startsWith(':')) {
			const [oldMode, newMode, oldSha, newSha, status] = token.slice(1).split(' ');
			const letter = status?.[0];
			let entry: IRawEntry;
			if (letter === 'R' || letter === 'C') {
				entry = { oldPath: tokens[i + 1], path: tokens[i + 2], kind: letter === 'R' ? 'renamed' : 'added' };
				i += 3;
			} else {
				entry = { path: tokens[i + 1], kind: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' };
				i += 2;
			}
			if (!ZERO_SHA.test(oldSha) && entry.kind !== 'added') {
				entry.oldBlob = oldSha;
				entry.oldMode = oldMode;
			}
			if (!ZERO_SHA.test(newSha) && entry.kind !== 'deleted') {
				entry.newBlob = newSha;
				entry.newMode = newMode;
			}
			raw.set(entry.path, entry);
			order.push(entry.path);
			continue;
		}
		const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
		if (!match) {
			i++;
			continue;
		}
		let path = match[3];
		if (path) {
			i += 1;
		} else {
			path = tokens[i + 2];
			i += 3;
		}
		const binary = match[1] === '-';
		counts.set(path, { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
	}
	return order.map(path => {
		const entry = raw.get(path)!;
		const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
		return { ...entry, ...count };
	});
}

const CLONE_PHASES: readonly { readonly pattern: RegExp; readonly phase: VoltGitClonePhase; readonly from: number; readonly to: number }[] = [
	{ pattern: /Counting objects:\s+(\d+)%/, phase: 'counting', from: 0, to: 5 },
	{ pattern: /Compressing objects:\s+(\d+)%/, phase: 'compressing', from: 5, to: 10 },
	{ pattern: /Receiving objects:\s+(\d+)%/, phase: 'receiving', from: 10, to: 80 },
	{ pattern: /Resolving deltas:\s+(\d+)%/, phase: 'resolving', from: 80, to: 92 },
	{ pattern: /Updating files:\s+(\d+)%/, phase: 'checkout', from: 92, to: 100 },
];

/** Maps one line of `git clone --progress` output to overall progress. */
export function parseCloneProgress(line: string): { readonly phase: VoltGitClonePhase; readonly percent: number } | undefined {
	for (const { pattern, phase, from, to } of CLONE_PHASES) {
		const match = pattern.exec(line);
		if (match) {
			const local = Math.min(100, Number(match[1]));
			return { phase, percent: Math.round(from + (to - from) * local / 100) };
		}
	}
	if (/Enumerating objects|Cloning into/.test(line)) {
		return { phase: 'counting', percent: 0 };
	}
	return undefined;
}

/**
 * URLs git may clone from. Blocks transports that run commands (`ext::`), option injection,
 * and control characters.
 */
export function isSafeCloneUrl(url: string): boolean {
	if (!url || url.startsWith('-') || /[\u0000-\u001f\u007f]/.test(url)) {
		return false;
	}
	if (/^[a-z][a-z0-9+.-]*::/i.test(url)) {
		return false;
	}
	return /^(https?|ssh|git):\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url) || url.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(url) || /^file:\/\//i.test(url);
}

/** The useful part of a failed clone's stderr: git's fatal/error lines, without progress noise. */
function cleanCloneError(stderr: string): string {
	const lines = stderr.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !parseCloneProgress(line));
	const important = lines.filter(line => /^(fatal|error|remote: (error|fatal))/i.test(line));
	return (important.length ? important : lines).slice(-4).join('\n');
}

/** `%(upstream:track)`: `[ahead 2, behind 1]`, `[ahead 2]` or `[gone]`, read as the git extension does. */
function aheadBehind(track: string): { ahead: number; behind: number } {
	const [, ahead, behind] = /\[(?:ahead (\d+))?[,\s]*(?:behind (\d+))?]/.exec(track) ?? [];
	return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}
