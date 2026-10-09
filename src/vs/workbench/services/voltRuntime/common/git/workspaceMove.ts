/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Moving a chat to another checkout: a new worktree, back to the project's main checkout, or
 * another worktree. The chat keeps its history and sidebar row; its uncommitted changes go with
 * it (the files its agent changed, or every uncommitted change), and they leave the old checkout
 * only after the new one has them byte for byte.
 *
 * T3 Code's `t3_worktree_handoff` creates a worktree and re-points the thread but leaves every
 * edit behind, works one way only, and has no rollback once the branch is made. Here the changes
 * travel as git patches (staged and unstaged kept apart, untracked files included, binaries and
 * file modes intact), each step is checked, and a failure before the chat is re-bound undoes
 * what was done. Everything in this file is pure; the mover service runs the git commands.
 */

export type WorkspaceMoveTarget =
	/** A new branch and worktree from the current checkout's HEAD (or `baseRef`). */
	| { readonly kind: 'newWorktree'; readonly branch?: string }
	/** The project's main checkout. */
	| { readonly kind: 'local' }
	/** A worktree that already exists. */
	| { readonly kind: 'worktree'; readonly path: string };

/**
 * - `thread`: the uncommitted files this chat's agent changed.
 * - `all`: every uncommitted change of the checkout, untracked files included.
 * - `none`: only the chat moves.
 */
export type WorkspaceCarry = 'thread' | 'all' | 'none';

export interface IWorkspaceMoveSpec {
	readonly target: WorkspaceMoveTarget;
	readonly carry: WorkspaceCarry;
	/** Run the worktree's setup (.volt/worktrees.json, .cursor/worktrees.json) in a new worktree. Default true. */
	readonly setup?: boolean;
}

export function parseWorkspaceMoveSpec(value: unknown): IWorkspaceMoveSpec | undefined {
	const spec = value as Partial<IWorkspaceMoveSpec> | undefined;
	const target = spec?.target as Partial<WorkspaceMoveTarget> | undefined;
	const carry: WorkspaceCarry = spec?.carry === 'all' || spec?.carry === 'none' ? spec.carry : 'thread';
	if (!target || typeof target !== 'object') {
		return undefined;
	}
	switch (target.kind) {
		case 'newWorktree': {
			const branch = (target as { branch?: unknown }).branch;
			return { target: { kind: 'newWorktree', ...(typeof branch === 'string' && branch.trim() ? { branch: branch.trim() } : {}) }, carry, ...(spec?.setup === false ? { setup: false } : {}) };
		}
		case 'local':
			return { target: { kind: 'local' }, carry };
		case 'worktree': {
			const path = (target as { path?: unknown }).path;
			return typeof path === 'string' && path.trim() ? { target: { kind: 'worktree', path: path.trim() }, carry } : undefined;
		}
		default:
			return undefined;
	}
}

/** "a new worktree", "the local checkout", "worktree volt/ab12". */
export function workspaceTargetLabel(target: WorkspaceMoveTarget, branch?: string): string {
	switch (target.kind) {
		case 'newWorktree': return target.branch ? `a new worktree (${target.branch})` : 'a new worktree';
		case 'local': return 'the local checkout';
		case 'worktree': return branch ? `worktree ${branch}` : `the worktree at ${target.path}`;
	}
}

/** Git refuses these as branch names (`git check-ref-format --branch`, the common cases). */
export function validateBranchName(name: string): string | undefined {
	const value = name.trim();
	if (!value) {
		return 'Name the branch.';
	}
	if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(value) || value.includes('..') || value.includes('@{') || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock') || value.includes('//') || value === '@') {
		return `"${value}" is not a valid branch name.`;
	}
	return undefined;
}

//#region Status

/** One `git status --porcelain=v1 -z` entry. `x` is the index column, `y` the work tree's. */
export interface IStatusEntry {
	readonly path: string;
	/** Renames and copies: where it came from. */
	readonly origPath?: string;
	readonly x: string;
	readonly y: string;
}

/** `git status --porcelain=v1 -z --untracked-files=all`: renames carry their source as the next NUL field. */
export function parseStatusZ(output: string): IStatusEntry[] {
	const fields = output.split('\0');
	const entries: IStatusEntry[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4 || field[2] !== ' ') {
			continue;
		}
		const x = field[0];
		const y = field[1];
		const path = field.slice(3);
		if (x === 'R' || x === 'C') {
			entries.push({ path, origPath: fields[++index], x, y });
		} else {
			entries.push({ path, x, y });
		}
	}
	return entries;
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function isUnmerged(entry: IStatusEntry): boolean {
	return UNMERGED.has(`${entry.x}${entry.y}`);
}

export function isUntracked(entry: IStatusEntry): boolean {
	return entry.x === '?' && entry.y === '?';
}

/** Ignored files never show in porcelain without `--ignored`; `!!` is skipped all the same. */
function isIgnored(entry: IStatusEntry): boolean {
	return entry.x === '!' && entry.y === '!';
}

/** Every path an entry touches: both sides of a rename. */
export function entryPaths(entry: IStatusEntry): string[] {
	return entry.origPath && entry.x === 'R' ? [entry.origPath, entry.path] : [entry.path];
}

/** `git ls-files -s -z`: the staged mode and blob of each path (stage 0 only). */
export function parseIndexEntries(output: string): Map<string, { readonly mode: string; readonly blob: string }> {
	const entries = new Map<string, { readonly mode: string; readonly blob: string }>();
	for (const record of output.split('\0')) {
		const tab = record.indexOf('\t');
		if (tab < 0) {
			continue;
		}
		const [mode, blob, stage] = record.slice(0, tab).split(' ');
		if (stage === '0' && mode && blob) {
			entries.set(record.slice(tab + 1), { mode, blob });
		}
	}
	return entries;
}

//#endregion

//#region Plan

export interface ICarryPlanInput {
	/** The checkout the chat leaves. */
	readonly status: readonly IStatusEntry[];
	/**
	 * Repo-relative paths this chat's agent changed (from its snapshots). Undefined: not known,
	 * so `thread` carries nothing and says so.
	 */
	readonly threadPaths: readonly string[] | undefined;
	readonly carry: WorkspaceCarry;
	/** The checkout the chat goes to, when it already exists (local, another worktree). */
	readonly targetStatus?: readonly IStatusEntry[];
	/** A merge, rebase, cherry-pick or revert is in progress in the source checkout. */
	readonly inProgress?: string;
}

export interface ICarryPlan {
	/** Entries whose changes move. */
	readonly moved: readonly IStatusEntry[];
	/** Uncommitted entries that stay where they are. */
	readonly left: readonly IStatusEntry[];
	/** Paths for the staged patch (`git diff --cached`) and the unstaged one (`git diff`). */
	readonly tracked: readonly string[];
	/** Untracked files, copied as new-file patches. */
	readonly untracked: readonly string[];
	/** Reasons the move cannot run at all. */
	readonly blockers: readonly string[];
	/** Paths the target checkout already changed: copying over them would lose work there. */
	readonly conflicts: readonly string[];
	readonly notes: readonly string[];
}

/** Decides what moves, what stays, and what stops the move before anything changes. */
export function planCarry(input: ICarryPlanInput): ICarryPlan {
	const blockers: string[] = [];
	const notes: string[] = [];
	const entries = input.status.filter(entry => !isIgnored(entry));
	if (input.inProgress) {
		blockers.push(`A ${input.inProgress} is in progress in this checkout. Finish or abort it first.`);
	}
	let wanted: (entry: IStatusEntry) => boolean;
	if (input.carry === 'none') {
		wanted = () => false;
	} else if (input.carry === 'all') {
		wanted = () => true;
	} else if (input.threadPaths) {
		const mine = new Set(input.threadPaths.map(normalizeRepoPath));
		// A directory the agent created holds its untracked files.
		const dirs = [...mine].map(path => `${path}/`);
		wanted = entry => entryPaths(entry).some(path => mine.has(normalizeRepoPath(path)) || dirs.some(dir => normalizeRepoPath(path).startsWith(dir)));
	} else {
		wanted = () => false;
		if (entries.length) {
			notes.push('Volt does not know which files this chat changed, so its uncommitted changes stay where they are.');
		}
	}
	const moved: IStatusEntry[] = [];
	const left: IStatusEntry[] = [];
	for (const entry of entries) {
		if (!wanted(entry)) {
			left.push(entry);
			continue;
		}
		if (isUnmerged(entry)) {
			blockers.push(`${entry.path} has unresolved merge conflicts.`);
			continue;
		}
		moved.push(entry);
	}
	const tracked = unique(moved.filter(entry => !isUntracked(entry)).flatMap(entryPaths));
	const untracked = unique(moved.filter(isUntracked).map(entry => entry.path));
	const movedPaths = new Set([...tracked, ...untracked].map(normalizeRepoPath));
	const conflicts = unique((input.targetStatus ?? []).filter(entry => !isIgnored(entry)).flatMap(entryPaths).filter(path => movedPaths.has(normalizeRepoPath(path))));
	if (left.length && input.carry !== 'none') {
		notes.push(`${left.length} other uncommitted file${left.length === 1 ? '' : 's'} stay${left.length === 1 ? 's' : ''} in the old checkout.`);
	}
	return { moved, left, tracked, untracked, blockers, conflicts, notes };
}

/**
 * How the old checkout drops what moved, once the new one has it: paths HEAD knows are restored
 * (index and files); paths HEAD does not know (added, a rename's new name, untracked) leave the
 * index and are deleted.
 */
export function cleanupPlan(moved: readonly IStatusEntry[]): { readonly restore: readonly string[]; readonly unstage: readonly string[]; readonly remove: readonly string[] } {
	const restore: string[] = [];
	const unstage: string[] = [];
	const remove: string[] = [];
	for (const entry of moved) {
		if (isUntracked(entry)) {
			remove.push(entry.path);
		} else if (entry.x === 'A' || entry.x === 'C') {
			unstage.push(entry.path);
			remove.push(entry.path);
		} else if (entry.x === 'R') {
			unstage.push(entry.path);
			remove.push(entry.path);
			if (entry.origPath) {
				restore.push(entry.origPath);
			}
		} else {
			restore.push(entry.path);
		}
	}
	return { restore: unique(restore), unstage: unique(unstage), remove: unique(remove) };
}

/**
 * The files the patches create in the target (to delete on rollback) and the ones they change
 * (to restore from HEAD on rollback; the target had them clean, see `conflicts`).
 */
export function targetRollbackPlan(plan: Pick<ICarryPlan, 'moved'>): { readonly restore: readonly string[]; readonly remove: readonly string[] } {
	const cleanup = cleanupPlan(plan.moved);
	return { restore: cleanup.restore, remove: cleanup.remove };
}

/** Files whose content must match on both sides after the copy (the ones that exist after it). */
export function presentAfterMove(moved: readonly IStatusEntry[]): string[] {
	return unique(moved.filter(entry => !(entry.y === 'D' || (entry.x === 'D' && entry.y === ' '))).map(entry => entry.path));
}

function normalizeRepoPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function unique<T>(items: readonly T[]): T[] {
	return [...new Set(items)];
}

//#endregion

//#region Steps and rollback

/** How far a move got: what rollback has to undo. */
export interface IMoveProgress {
	/** A worktree (and branch) this move created. */
	readonly createdWorktree?: { readonly path: string; readonly branch: string };
	/** Patches applied to an existing checkout. */
	readonly appliedTo?: string;
	/** The chat now works in the target: past this point nothing is rolled back. */
	readonly rebound?: boolean;
}

export type MoveRollbackStep =
	| { readonly kind: 'removeWorktree'; readonly path: string; readonly branch: string }
	| { readonly kind: 'restoreTarget'; readonly folder: string };

/**
 * What undoes a failed move. Before the chat is re-bound the old checkout still has everything,
 * so undoing means removing the copy: the new worktree and its branch, or the files patched into
 * an existing checkout. After it, the move stands (a failed cleanup only leaves a duplicate).
 */
export function moveRollback(progress: IMoveProgress): MoveRollbackStep[] {
	if (progress.rebound) {
		return [];
	}
	const steps: MoveRollbackStep[] = [];
	if (progress.createdWorktree) {
		steps.push({ kind: 'removeWorktree', ...progress.createdWorktree });
	} else if (progress.appliedTo) {
		steps.push({ kind: 'restoreTarget', folder: progress.appliedTo });
	}
	return steps;
}

/**
 * The worktree the chat left is removed only when nothing is lost: Volt made it, nothing
 * uncommitted is left in it, its branch has no commits the new place lacks, and no other chat
 * works there. Otherwise it stays for the user (and Volt's archive pruning).
 */
export function shouldRemoveOldWorktree(input: { readonly managed: boolean; readonly clean: boolean; readonly unmergedCommits: number; readonly otherChats: number }): boolean {
	return input.managed && input.clean && input.unmergedCommits === 0 && input.otherChats === 0;
}

//#endregion

//#region Text

export interface IMoveNoteInput {
	readonly fromPath: string;
	readonly toPath: string;
	readonly branch?: string;
	readonly worktree: boolean;
	readonly files: number;
	readonly left: number;
}

/**
 * The note the next turn's model reads: the conversation so far happened in another folder, so
 * paths in it point there. The agent session is new (an ACP session's cwd cannot change), and it
 * is briefed with the conversation as usual.
 */
export function workspaceMoveNote(input: IMoveNoteInput): string {
	const where = input.worktree ? `the git worktree ${input.toPath}${input.branch ? ` (branch ${input.branch})` : ''}` : `the project's main checkout ${input.toPath}${input.branch ? ` (branch ${input.branch})` : ''}`;
	const carried = input.files
		? `The uncommitted changes from before (${input.files} file${input.files === 1 ? '' : 's'}) came along and are in the new folder.`
		: 'No uncommitted changes came along.';
	const left = input.left ? ` ${input.left} other uncommitted file${input.left === 1 ? '' : 's'} stayed in the old folder; they are not yours to touch.` : '';
	return `[Volt] This chat moved from ${input.fromPath} to ${where}. Work only in ${input.toPath} from now on: paths earlier in this conversation that point into ${input.fromPath} now live under ${input.toPath}. ${carried}${left}`;
}

/** The transcript divider and notices: "Moved to worktree volt/ab12 · 3 files". */
export function describeMoveResult(result: { readonly ok: boolean; readonly worktree: boolean; readonly branch?: string; readonly files?: number; readonly error?: string }): string {
	if (!result.ok) {
		return `Could not move the chat: ${result.error ?? 'unknown error'}`;
	}
	const place = result.worktree ? `worktree ${result.branch ?? ''}`.trim() : `local${result.branch ? ` (${result.branch})` : ''}`;
	const files = result.files ? ` · ${result.files} file${result.files === 1 ? '' : 's'}` : '';
	return `Moved to ${place}${files}`;
}

//#endregion
