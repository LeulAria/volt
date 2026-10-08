/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../../base/common/hash.js';
import { basename, dirname, isAbsolute, join, normalize, relative } from '../../../../../base/common/path.js';
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

/**
 * The branch a new worktree checks out, picked in the new chat's branch menu. Without one it
 * gets a fresh `volt/<id>` branch at HEAD. As in VS Code's Create Worktree, a branch that is
 * already checked out somewhere gets a fresh branch from it instead.
 */
export type AgentWorktreeTarget =
	| { readonly kind: 'branch'; readonly name: string }
	/** `origin/x`: checks out local `x`, creating it to track the remote when missing. */
	| { readonly kind: 'remote'; readonly name: string }
	| { readonly kind: 'tag'; readonly name: string }
	/** A branch the user named, made from `from` (a full ref) or HEAD. */
	| { readonly kind: 'new'; readonly name: string; readonly from?: string };

/** Archived chats keep this many checkouts. Older clean ones are removed. */
export const ARCHIVED_WORKTREE_KEEP = 15;

/** A worktree starts from a commit, which a freshly initialized repo does not have. */
const NO_COMMITS = 'This repository has no commits yet. Make a first commit to use a worktree.';

const MANAGED_BRANCH = /^volt\/[0-9a-f]{8}$/;
const MANAGED_DIR = /^volt-[0-9a-f]{8}$/;

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

/**
 * A checkout Volt made: a `volt-<id>` folder inside the worktree root. Its branch may be one
 * the user picked, so only `volt/<id>` branches are ever deleted with it.
 */
export function isManagedWorktree(path: string | undefined, worktreesRoot: string): boolean {
	return !!path && isManagedWorktreePath(path, worktreesRoot) && MANAGED_DIR.test(basename(normalize(path)));
}

/**
 * Archived checkouts past the keep window, newest activity first.
 * A path still used by an active chat is never a candidate.
 */
export function archivedWorktreeCandidates(owners: readonly IManagedWorktreeRef[], worktreesRoot: string, keep = ARCHIVED_WORKTREE_KEEP): IManagedWorktreeRef[] {
	const active = new Set(owners.filter(owner => !owner.archived && owner.path).map(owner => normalize(owner.path!)));
	const archived = owners.filter(owner =>
		!!owner.archived
		&& !!owner.branch
		&& isManagedWorktree(owner.path, worktreesRoot)
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
	readonly target?: AgentWorktreeTarget;
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
	// A checkout that is there needs nothing, whoever made it (a chat may move into the user's own worktree).
	if (await input.files.exists(input.path)) {
		return false;
	}
	if (!isManagedWorktree(input.path, input.worktreesRoot)) {
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
	/** The caller made this branch (a run group's `volt/<task>-<model>`): it may go even though it is not `volt/<id>`. */
	readonly ownsBranch?: boolean;
}): Promise<WorktreeRemoval> {
	if (!isManagedWorktree(input.path, input.worktreesRoot)) {
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
	readonly ownsBranch?: boolean;
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
	// A branch the user picked for the worktree is theirs; only Volt's own go with the chat.
	const deleteBranch = input.deleteBranch && (isManagedBranch(input.branch) || !!input.ownsBranch);
	if (deleteBranch) {
		await input.run(input.repoRoot, ['branch', '-D', input.branch]);
	}
	if (input.force && await input.files.exists(input.path)) {
		await input.files.remove(input.path);
	}
	await input.run(input.repoRoot, ['worktree', 'prune']);
	return exists || deleteBranch ? 'removed' : 'missing';
}

/** How the new checkout gets its branch. */
type BranchPlan =
	/** A fresh `volt/<id>` at `base`. */
	| { readonly kind: 'managed'; readonly base: string }
	/** An existing branch, checked out as it is. */
	| { readonly kind: 'existing'; readonly branch: string; readonly base: string }
	/** A branch created for this checkout: named by the user, or tracking a remote branch. */
	| { readonly kind: 'named'; readonly branch: string; readonly base: string; readonly track?: string };

async function planBranch(run: GitRunner, repoRoot: string, target: AgentWorktreeTarget | undefined): Promise<BranchPlan> {
	const commitOf = async (rev: string, missing: string) => {
		const result = await run(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
		if (!ok(result) || !result.stdout.trim()) {
			throw new AgentWorktreeError(missing);
		}
		return result.stdout.trim();
	};
	const localExists = async (name: string) => ok(await run(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]));
	const onBranch = async (name: string): Promise<BranchPlan> => {
		const base = await commitOf(`refs/heads/${name}`, `Branch ${name} no longer exists.`);
		return await checkedOut(run, repoRoot, name) ? { kind: 'managed', base } : { kind: 'existing', branch: name, base };
	};
	const headCommit = async () => {
		const head = await run(repoRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
		if (!ok(head) || !head.stdout.trim()) {
			// Right after `git init`, HEAD names a branch that has no commits yet.
			const unborn = ok(await run(repoRoot, ['symbolic-ref', '-q', 'HEAD']));
			throw new AgentWorktreeError(unborn ? NO_COMMITS : 'This folder is not a git repository.');
		}
		return head.stdout.trim();
	};
	if (!target) {
		return { kind: 'managed', base: await headCommit() };
	}
	switch (target.kind) {
		case 'branch':
			return onBranch(target.name);
		case 'remote': {
			const local = target.name.slice(target.name.indexOf('/') + 1);
			if (await localExists(local)) {
				return onBranch(local);
			}
			const base = await commitOf(`refs/remotes/${target.name}`, `Remote branch ${target.name} no longer exists.`);
			return { kind: 'named', branch: local, base, track: target.name };
		}
		case 'tag':
			return { kind: 'managed', base: await commitOf(`refs/tags/${target.name}`, `Tag ${target.name} no longer exists.`) };
		case 'new': {
			if (await localExists(target.name)) {
				throw new AgentWorktreeError(`A branch named ${target.name} already exists.`);
			}
			const base = target.from ? await commitOf(target.from, `${target.from} no longer exists.`) : await headCommit();
			return { kind: 'named', branch: target.name, base };
		}
		default: {
			const unexpected: never = target;
			return unexpected;
		}
	}
}

/** Git checks a branch out in one work tree at a time. */
async function checkedOut(run: GitRunner, repoRoot: string, branch: string): Promise<boolean> {
	const listed = await run(repoRoot, ['worktree', 'list', '--porcelain']);
	return ok(listed) && listed.stdout.split('\n').some(line => line.trim() === `branch refs/heads/${branch}`);
}

async function createLocked(input: ICreateAgentWorktree, commonDir: string): Promise<ICreatedAgentWorktree> {
	const plan = await planBranch(input.run, input.repoRoot, input.target);
	const commit = plan.base;
	const allocate = input.allocateId ?? allocateWorktreeId;
	const repoKey = hash(normalize(commonDir)).toString(36);
	let lastDetail = '';
	for (let attempt = 0; attempt < 8; attempt++) {
		const id = allocate();
		if (!/^[0-9a-f]{8}$/.test(id)) {
			throw new AgentWorktreeError('Could not find a free worktree path.');
		}
		const branch = plan.kind === 'managed' ? `volt/${id}` : plan.branch;
		const path = join(input.worktreesRoot, repoKey, `volt-${id}`);
		if (await input.files.exists(path)) {
			continue;
		}
		if (plan.kind !== 'existing') {
			const args = plan.kind === 'named' && plan.track ? ['branch', '--track', branch, plan.track] : ['branch', branch, commit];
			const branched = await input.run(input.repoRoot, args);
			if (!ok(branched)) {
				lastDetail = gitDetail(branched);
				if (plan.kind === 'named') {
					throw new AgentWorktreeError(lastDetail || `Could not create branch ${branch}.`);
				}
				continue;
			}
		}
		await input.files.ensureDir(dirname(path));
		const added = await input.run(input.repoRoot, ['worktree', 'add', path, branch]);
		if (ok(added) || await checkoutKept(input.run, input.repoRoot, path, commit)) {
			return { path, branch, commit };
		}
		lastDetail = gitDetail(added);
		// Only a branch made just now goes; a picked one stays.
		await rollback(input, path, plan.kind === 'existing' ? undefined : branch);
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

async function rollback(input: ICreateAgentWorktree, path: string, branch: string | undefined): Promise<void> {
	await input.run(input.repoRoot, ['worktree', 'remove', '--force', path]).catch(() => undefined);
	if (branch) {
		await input.run(input.repoRoot, ['branch', '-D', branch]).catch(() => undefined);
	}
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
	/** A new checkout on `target`'s branch, else a fresh `volt/<id>` at HEAD. */
	create(repoRoot: string, target?: AgentWorktreeTarget): Promise<ICreatedAgentWorktree>;
	/** Recreates a pruned checkout from its kept branch. True when the directory was missing. */
	ensure(repoRoot: string, path: string, branch: string): Promise<boolean>;
	pruneArchived(): Promise<void>;
	removeForDeletedChat(repoRoot: string | undefined, path: string | undefined, branch: string | undefined): Promise<void>;
	/**
	 * Removes a checkout Volt made. A dirty one stays unless `force`. `ownsBranch`: the caller made
	 * the branch too, so `deleteBranch` may delete it whatever its name.
	 */
	remove(repoRoot: string, path: string, branch: string, options: { readonly deleteBranch: boolean; readonly force: boolean; readonly ownsBranch?: boolean }): Promise<WorktreeRemoval>;
	/** Runs git in `cwd` (never throws; a failure is a non-zero exit code). */
	git(cwd: string, args: readonly string[]): Promise<IGitRunResult>;
	/** Runs `work` while no other worktree change of the same repository runs. */
	serialize<T>(repoRoot: string, work: () => Promise<T>): Promise<T>;
}

/** Same queue key as worktree creation and removal: the repository's common git dir. */
export async function serializeForRepo<T>(run: GitRunner, repoRoot: string, work: () => Promise<T>): Promise<T> {
	const commonDir = await gitCommonDir(run, repoRoot);
	return withRepoQueue(commonDir, work);
}
