/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../../base/common/hash.js';
import { dirname, isAbsolute, join, normalize, relative } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

/** Where a new chat runs. Same branch uses the open checkout. */
export type AgentRunOn = 'same-branch' | 'worktree';

export const AGENT_RUN_ON_OPTIONS = ['same-branch', 'worktree'] as const;

/** Missing or unknown values stay on the open checkout. */
export function normalizeAgentRunOn(value: string | undefined): AgentRunOn {
	return value === 'worktree' ? 'worktree' : 'same-branch';
}

export function agentRunOnStorageKey(projectId: string | undefined): string {
	return `volt.agent.runOn.${projectId || 'default'}`;
}

/** Archived chats keep this many checkouts. Older clean ones are removed. */
export const ARCHIVED_WORKTREE_KEEP = 15;

const MANAGED_BRANCH = /^volt\/[0-9a-f]{8}$/;

export interface IGitRunResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<IGitRunResult>;

export interface IWorktreeFiles {
	exists(path: string): Promise<boolean>;
	ensureDir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface ICreatedAgentWorktree {
	readonly path: string;
	readonly branch: string;
	readonly commit: string;
}

export interface IManagedWorktreeRef {
	readonly sessionId: string;
	readonly path?: string;
	readonly branch?: string;
	readonly archived?: boolean;
	readonly updatedAt: number;
	readonly workspaceFolder?: string;
}

export type WorktreeRemoval = 'removed' | 'dirty' | 'refused' | 'missing';

export class AgentWorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentWorktreeError';
	}
}

export function allocateWorktreeId(): string {
	return generateUuid().replace(/-/g, '').slice(0, 8);
}

export function isManagedBranch(branch: string | undefined): boolean {
	return !!branch && MANAGED_BRANCH.test(branch);
}

/** True when `path` is nested inside the Volt worktree root and is not the root itself. */
export function isManagedWorktreePath(path: string, worktreesRoot: string): boolean {
	const root = normalize(worktreesRoot);
	const target = normalize(path);
	if (!root || !target || target === root) {
		return false;
	}
	const rel = relative(root, target);
	return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}

export function isManagedWorktree(path: string | undefined, branch: string | undefined, worktreesRoot: string): boolean {
	return !!path && isManagedBranch(branch) && isManagedWorktreePath(path, worktreesRoot);
}

/**
 * Archived checkouts past the keep window, newest activity first.
 * A path still used by an active chat is never a candidate.
 */
export function archivedWorktreeCandidates(owners: readonly IManagedWorktreeRef[], worktreesRoot: string, keep = ARCHIVED_WORKTREE_KEEP): IManagedWorktreeRef[] {
	const active = new Set(owners.filter(owner => !owner.archived && owner.path).map(owner => normalize(owner.path!)));
	const archived = owners.filter(owner =>
		!!owner.archived
		&& isManagedWorktree(owner.path, owner.branch, worktreesRoot)
		&& !active.has(normalize(owner.path!))
	);
	archived.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
	return archived.slice(Math.max(0, keep));
}

const repoQueues = new Map<string, Promise<unknown>>();

/** One git mutation at a time per repository. A failure does not block the next caller. */
export function withRepoQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = repoQueues.get(key) ?? Promise.resolve();
	const next = previous.then(run, run);
	repoQueues.set(key, next.then(() => undefined, () => undefined));
	return next;
}

export interface ICreateAgentWorktree {
	readonly run: GitRunner;
	readonly files: IWorktreeFiles;
	readonly repoRoot: string;
	readonly worktreesRoot: string;
	readonly allocateId?: () => string;
}

/**
 * Branch first, then one `worktree add`. A failed add is kept only when the
 * checkout is registered and HEAD matches (a post-checkout hook failed after
 * a good tree). Otherwise the branch, directory, and registration are removed.
 */
export async function createAgentWorktree(input: ICreateAgentWorktree): Promise<ICreatedAgentWorktree> {
	const commonDir = await gitCommonDir(input.run, input.repoRoot);
	return withRepoQueue(commonDir, () => createLocked(input, commonDir));
}

export async function ensureAgentWorktree(input: {
	readonly run: GitRunner;
	readonly files: IWorktreeFiles;
	readonly repoRoot: string;
	readonly worktreesRoot: string;
	readonly path: string;
	readonly branch: string;
}): Promise<boolean> {
	if (!isManagedWorktree(input.path, input.branch, input.worktreesRoot)) {
		throw new AgentWorktreeError('Refusing to restore a worktree Volt did not create.');
	}
	const commonDir = await gitCommonDir(input.run, input.repoRoot);
	return withRepoQueue(commonDir, async () => {
		if (await input.files.exists(input.path)) {
			return false;
		}
		await input.files.ensureDir(dirname(input.path));
		const added = await input.run(input.repoRoot, ['worktree', 'add', input.path, input.branch]);
		if (!ok(added)) {
			throw new AgentWorktreeError(gitDetail(added) || 'Could not restore the worktree.');
		}
		return true;
	});
}

export async function removeAgentWorktree(input: {
	readonly run: GitRunner;
	readonly files: IWorktreeFiles;
	readonly repoRoot: string;
	readonly worktreesRoot: string;
	readonly path: string;
	readonly branch: string;
	readonly deleteBranch: boolean;
	readonly force: boolean;
}): Promise<WorktreeRemoval> {
	if (!isManagedWorktree(input.path, input.branch, input.worktreesRoot)) {
		return 'refused';
	}
	let commonDir: string;
	try {
		commonDir = await gitCommonDir(input.run, input.repoRoot);
	} catch {
		if (input.force && await input.files.exists(input.path)) {
			await input.files.remove(input.path);
			return 'removed';
		}
		return 'refused';
	}
	return withRepoQueue(commonDir, () => removeLocked(input));
}

async function removeLocked(input: {
	readonly run: GitRunner;
	readonly files: IWorktreeFiles;
	readonly repoRoot: string;
	readonly path: string;
	readonly branch: string;
	readonly deleteBranch: boolean;
	readonly force: boolean;
}): Promise<WorktreeRemoval> {
	const exists = await input.files.exists(input.path);
	if (exists && !input.force) {
		const status = await input.run(input.path, ['status', '--porcelain']);
		if (!ok(status) || status.stdout.trim()) {
			return 'dirty';
		}
	}
	if (exists) {
		const args = ['worktree', 'remove'];
		if (input.force) {
			args.push('--force');
		}
		args.push(input.path);
		const removed = await input.run(input.repoRoot, args);
		if (!ok(removed)) {
			if (!input.force) {
				return 'dirty';
			}
			await input.files.remove(input.path);
		}
	}
	if (input.deleteBranch) {
		await input.run(input.repoRoot, ['branch', '-D', input.branch]);
	}
	if (input.force && await input.files.exists(input.path)) {
		await input.files.remove(input.path);
	}
	await input.run(input.repoRoot, ['worktree', 'prune']);
	return exists || input.deleteBranch ? 'removed' : 'missing';
}

async function createLocked(input: ICreateAgentWorktree, commonDir: string): Promise<ICreatedAgentWorktree> {
	const commit = await gitStdout(input.run, input.repoRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
	if (!commit) {
		throw new AgentWorktreeError('This folder is not a git repository.');
	}
	const allocate = input.allocateId ?? allocateWorktreeId;
	const repoKey = hash(normalize(commonDir)).toString(36);
	let lastDetail = '';
	for (let attempt = 0; attempt < 8; attempt++) {
		const id = allocate();
		if (!/^[0-9a-f]{8}$/.test(id)) {
			throw new AgentWorktreeError('Could not find a free worktree path.');
		}
		const branch = `volt/${id}`;
		const path = join(input.worktreesRoot, repoKey, `volt-${id}`);
		if (await input.files.exists(path)) {
			continue;
		}
		const branched = await input.run(input.repoRoot, ['branch', branch, commit]);
		if (!ok(branched)) {
			lastDetail = gitDetail(branched);
			continue;
		}
		await input.files.ensureDir(dirname(path));
		const added = await input.run(input.repoRoot, ['worktree', 'add', path, branch]);
		if (ok(added) || await checkoutKept(input.run, input.repoRoot, path, commit)) {
			return { path, branch, commit };
		}
		lastDetail = gitDetail(added);
		await rollback(input, path, branch);
		throw new AgentWorktreeError(lastDetail || 'Could not create the worktree.');
	}
	throw new AgentWorktreeError(lastDetail || 'Could not find a free worktree path.');
}

async function checkoutKept(run: GitRunner, repoRoot: string, path: string, commit: string): Promise<boolean> {
	const listed = await run(repoRoot, ['worktree', 'list', '--porcelain']);
	if (!ok(listed) || !porcelainHas(listed.stdout, path)) {
		return false;
	}
	const head = await run(path, ['rev-parse', 'HEAD']);
	return ok(head) && head.stdout.trim() === commit;
}

async function rollback(input: ICreateAgentWorktree, path: string, branch: string): Promise<void> {
	await input.run(input.repoRoot, ['worktree', 'remove', '--force', path]).catch(() => undefined);
	await input.run(input.repoRoot, ['branch', '-D', branch]).catch(() => undefined);
	await input.files.remove(path).catch(() => undefined);
	await input.run(input.repoRoot, ['worktree', 'prune']).catch(() => undefined);
}

async function gitCommonDir(run: GitRunner, repoRoot: string): Promise<string> {
	const raw = await gitStdout(run, repoRoot, ['rev-parse', '--git-common-dir']);
	if (!raw) {
		throw new AgentWorktreeError('This folder is not a git repository.');
	}
	return isAbsolute(raw) ? normalize(raw) : normalize(join(repoRoot, raw));
}

async function gitStdout(run: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
	const result = await run(cwd, args);
	if (!ok(result)) {
		throw new AgentWorktreeError(gitDetail(result) || 'This folder is not a git repository.');
	}
	return result.stdout.trim();
}

function porcelainHas(stdout: string, path: string): boolean {
	const wanted = normalize(path);
	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (normalize(line.slice('worktree '.length).trim()) === wanted) {
				return true;
			}
		}
	}
	return false;
}

function ok(result: IGitRunResult): boolean {
	return result.exitCode === 0;
}

function gitDetail(result: IGitRunResult): string {
	return (result.stderr || result.stdout).trim();
}

export const IAgentWorktreeService = createDecorator<IAgentWorktreeService>('agentWorktreeService');

export interface IAgentWorktreeService {
	readonly _serviceBrand: undefined;
	create(repoRoot: string): Promise<ICreatedAgentWorktree>;
	/** Recreates a pruned checkout from its kept branch. True when the directory was missing. */
	ensure(repoRoot: string, path: string, branch: string): Promise<boolean>;
	pruneArchived(): Promise<void>;
	removeForDeletedChat(repoRoot: string | undefined, path: string | undefined, branch: string | undefined): Promise<void>;
}
