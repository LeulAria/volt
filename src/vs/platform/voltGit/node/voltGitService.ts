/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { copyFile, mkdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { SequencerByKey, timeout } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { dirname, join, resolve } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import {
	IVoltGitApplyResult,
	IVoltGitDiffEntry,
	IVoltGitRef,
	IVoltGitRepo,
	IVoltGitService,
	IVoltGitSnapshot,
	IVoltGitSnapshotRequest,
	VoltGitChangeKind,
	VoltGitError,
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
}

interface IGitOutput {
	readonly exitCode: number;
	readonly stdout: Buffer;
	readonly stderr: string;
}

export class VoltGitService implements IVoltGitService {

	declare readonly _serviceBrand: undefined;

	private readonly queue = new SequencerByKey<string>();
	private baseEnv: Promise<NodeJS.ProcessEnv> | undefined;

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService?: ILogService,
	) { }

	async resolveRepo(folder: string): Promise<IVoltGitRepo | undefined> {
		const out = await this.run({ cwd: folder, args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], okCodes: [0, 128] });
		if (out.exitCode !== 0) {
			return undefined;
		}
		const [repoRoot, gitDir, commonDir] = out.stdout.toString('utf8').split('\n');
		if (!repoRoot || !gitDir || !commonDir) {
			return undefined;
		}
		return { repoRoot, gitDir, commonDir: resolve(folder, commonDir) };
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
			try {
				const add = ['-c', 'core.untrackedCache=true', '-c', 'core.splitIndex=false', 'add', '-A', '--'];
				const hinted = warm && !!request.paths?.length;
				const added = await this.run({ cwd: workTree, args: [...add, ...(hinted ? request.paths! : [])], env, timeoutMs: remaining(), okCodes: hinted ? [0, 128] : [0] });
				if (added.exitCode !== 0) {
					// A hinted path that no longer exists anywhere; scan everything instead.
					await this.run({ cwd: workTree, args: add, env, timeoutMs: remaining() });
				}
				const tree = (await this.run({ cwd: workTree, args: ['write-tree'], env, timeoutMs: remaining() })).stdout.toString('utf8').trim();
				const parent = request.parent ?? await this.head(workTree);
				const commitArgs = ['commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : []), '-m', request.message];
				const commit = (await this.run({ cwd: request.repoRoot, args: commitArgs, env: SNAPSHOT_IDENTITY, timeoutMs: remaining() })).stdout.toString('utf8').trim();
				// Published last, so a ref never names a commit whose objects are missing.
				await this.run({ cwd: request.repoRoot, args: ['update-ref', request.ref, commit], timeoutMs: remaining() });
				this.logService?.trace(`[volt-git] snapshot ${request.ref} in ${Date.now() - started}ms`);
				return { commit, tree };
			} catch (err) {
				// A killed `add` leaves the private index locked for every later snapshot.
				await rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
				throw err;
			}
		});
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

	async diffSummary(request: { readonly repoRoot: string; readonly from: string; readonly to: string; readonly paths?: readonly string[] }): Promise<IVoltGitDiffEntry[]> {
		const args = ['-c', 'core.quotePath=false', 'diff', '--raw', '--numstat', '-z', '-M', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-color', request.from, request.to, '--', ...(request.paths ?? [])];
		const out = await this.run({ cwd: request.repoRoot, args });
		return parseDiffSummary(out.stdout.toString('utf8'));
	}

	async readBlob(request: { readonly repoRoot: string; readonly sha: string }): Promise<VSBuffer> {
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
		this.baseEnv ??= this.resolveEnv().then(resolved => {
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
		const args = ['--no-pager', ...run.args];
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
