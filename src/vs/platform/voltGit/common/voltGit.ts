/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltGitService = createDecorator<IVoltGitService>('voltGitService');
export const VOLT_GIT_CHANNEL_NAME = 'voltGit';

/** Hidden refs that keep agent turn snapshots alive. Not under refs/heads, so never listed or pushed. */
export const VOLT_SNAPSHOT_REF_PREFIX = 'refs/volt/s/';

export interface IVoltGitRepo {
	/** The work tree's top folder. */
	readonly repoRoot: string;
	/** This work tree's git dir (differs from `commonDir` inside a linked worktree). */
	readonly gitDir: string;
	/** The object database and refs, shared by every worktree of the repo. */
	readonly commonDir: string;
}

export interface IVoltGitSnapshotRequest {
	/** The repo whose object database receives the snapshot. */
	readonly repoRoot: string;
	/** The folder to capture. Defaults to `repoRoot`; a linked worktree of the same repo also works. */
	readonly workTree?: string;
	/**
	 * Volt's private index for this session. Seeded from the work tree's own index the first
	 * time, then kept warm so later snapshots only re-hash files whose stat changed.
	 */
	readonly indexFile: string;
	/** Parent commit. Defaults to the work tree's HEAD; none when HEAD is unborn. */
	readonly parent?: string;
	/** Published with `update-ref` only after every object is written. */
	readonly ref: string;
	readonly message: string;
	/** Only re-scan these repo-relative paths. Ignored until the private index is warm. */
	readonly paths?: readonly string[];
	readonly timeoutMs?: number;
	/**
	 * When the captured tree equals this snapshot's tree, return it as is: no commit is written
	 * and the ref is left alone.
	 */
	readonly reuse?: IVoltGitSnapshot;
	/** Untracked files larger than this are left out. Default {@link VOLT_SNAPSHOT_LIMITS}. */
	readonly maxFileBytes?: number;
	/** At most this many untracked files are added per snapshot; the rest are left out. */
	readonly maxNewFiles?: number;
	/** At most this many bytes of untracked files are added per snapshot. */
	readonly maxNewBytes?: number;
}

/**
 * Untracked files a snapshot leaves out, so a stray build folder or a video in the project never
 * floods the object database. A left-out path stays out of every later snapshot of the same
 * private index (even once it shrinks), so a restore never deletes or rewrites a file that no
 * snapshot knew. Tracked files are always captured.
 */
export const VOLT_SNAPSHOT_LIMITS = {
	maxFileBytes: 10 * 1024 * 1024,
	maxNewFiles: 5_000,
	maxNewBytes: 200 * 1024 * 1024,
	/** Untracked folders with these names are never captured (dependency and cache folders). */
	heavyFolders: ['node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.gradle', '.dart_tool', 'Pods', '.terraform', '.cache'] as readonly string[],
};

export interface IVoltGitSnapshot {
	readonly commit: string;
	readonly tree: string;
	/** Untracked files this snapshot left out for size or count (see {@link VOLT_SNAPSHOT_LIMITS}). */
	readonly skipped?: number;
}

/** Where agent snapshots of a folder live. */
export interface IVoltGitSnapshotRepo extends IVoltGitRepo {
	/** The folder snapshots capture and restores write to. */
	readonly workTree: string;
	/** Volt's private index for this work tree (a stat cache; never the user's index). */
	readonly indexFile: string;
	/**
	 * The folder is not a git work tree: snapshots go to a private repo under Volt's data folder.
	 * Nothing is written into the folder itself.
	 */
	readonly shadow: boolean;
	/**
	 * The folder asked for, relative to the work tree (`src/app/`, '' for the top), as git reports
	 * it. Maps repo paths onto the folder's own path when it is reached through a symlink.
	 */
	readonly folderPrefix: string;
}

/** One stretch of agent work to undo: paths that differ between the two snapshots go back from `after` to `before`. */
export interface IVoltGitRestoreStep {
	readonly before: string;
	readonly after: string;
}

export interface IVoltGitRestoreRequest {
	/** `repoRoot` of a {@link IVoltGitSnapshotRepo}. */
	readonly repoRoot: string;
	readonly workTree?: string;
	/** Newest first. A path touched by several steps is walked back through each in turn. */
	readonly steps: readonly IVoltGitRestoreStep[];
	/** Only these repo-relative paths. */
	readonly paths?: readonly string[];
	/** Work out what would happen without writing anything. */
	readonly dryRun?: boolean;
	/** Where a file changed after the agent and the change can't be merged, write the snapshot's version anyway. */
	readonly overwrite?: boolean;
	readonly timeoutMs?: number;
}

/**
 * `restored`: the file goes back to the snapshot. `merged`: it goes back, keeping edits made after
 * the agent that don't overlap. `conflict`: edits made after the agent overlap (or the file is
 * binary), so it is left alone. `unchanged`: it already matches.
 */
export type VoltGitRestoreOutcome = 'restored' | 'merged' | 'conflict' | 'unchanged';

export interface IVoltGitRestoreEntry {
	readonly path: string;
	readonly action: 'write' | 'create' | 'delete' | 'none';
	readonly outcome: VoltGitRestoreOutcome;
	readonly binary: boolean;
	/** The file on disk no longer matches what the agent left: someone edited it since. */
	readonly editedSince: boolean;
}

export interface IVoltGitRestoreResult {
	readonly entries: readonly IVoltGitRestoreEntry[];
	readonly conflicts: readonly string[];
	/** False for a dry run. */
	readonly applied: boolean;
}

export type VoltGitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface IVoltGitDiffEntry {
	/** Repo-relative, forward slashes. The new path for renames. */
	readonly path: string;
	readonly oldPath?: string;
	readonly kind: VoltGitChangeKind;
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
	/** Undefined on the side where the file does not exist. */
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly oldMode?: string;
	readonly newMode?: string;
}

export interface IVoltGitApplyResult {
	/** False when a three-way apply left conflict markers. */
	readonly ok: boolean;
	readonly conflicts: readonly string[];
	readonly stderr: string;
}

export interface IVoltGitCloneRequest {
	/** Chosen by the caller, so it can cancel and match progress events. */
	readonly jobId: string;
	readonly url: string;
	/** Absolute path of the folder to create. Its parent is created when missing. */
	readonly dest: string;
	readonly ref?: string;
	readonly recursive?: boolean;
	/** `http.extraheader` value for this clone only (a GitHub token). Passed through the environment, never written to config. */
	readonly authHeader?: string;
	/** Host the header applies to, e.g. `https://github.com/`. */
	readonly authHost?: string;
}

export type VoltGitClonePhase = 'starting' | 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checkout' | 'done';

export interface IVoltGitCloneProgress {
	readonly jobId: string;
	readonly phase: VoltGitClonePhase;
	/** Overall progress, 0-100, across every phase. */
	readonly percent: number;
	/** git's own line, e.g. "Receiving objects: 42% (420/1000), 1.2 MiB | 3 MiB/s". */
	readonly message?: string;
}

/** A branch or tag with its latest commit, for pickers. */
export interface IVoltGitBranchRef {
	readonly kind: 'local' | 'remote' | 'tag';
	/** `main`, `origin/main`, `v1`. */
	readonly name: string;
	/** The full ref, e.g. `refs/remotes/origin/main`. */
	readonly ref: string;
	readonly subject: string;
	readonly author: string;
	/** Commit (or tag) time in ms since the epoch; 0 when unknown. */
	readonly date: number;
	/** A local branch out of step with its upstream: commits only it has, and only the upstream has. */
	readonly ahead?: number;
	readonly behind?: number;
}

export interface IVoltGitBranches {
	/** The checked-out branch; undefined when HEAD is detached. */
	readonly head?: string;
	/** `head` has no commits yet, as right after `git init`: nothing to branch or check out from. */
	readonly unborn?: boolean;
	/** Short sha when HEAD is detached. */
	readonly detached?: string;
	/** Most recently committed first. */
	readonly local: readonly string[];
	/** `origin/main` style names. */
	readonly remote: readonly string[];
	readonly tags: readonly string[];
	/** Every branch and tag above with its latest commit, most recent first. */
	readonly refs: readonly IVoltGitBranchRef[];
}

export interface IVoltGitRef {
	readonly ref: string;
	readonly commit: string;
}

/**
 * Git plumbing for agent change capture. Every call either succeeds or throws a
 * {@link VoltGitError}; nothing fails quietly. Calls that write an index or refs run one at a
 * time per repo.
 */
export interface IVoltGitService {
	readonly _serviceBrand: undefined;
	readonly onDidCloneProgress: Event<IVoltGitCloneProgress>;
	/** Undefined when `folder` is not inside a git work tree. */
	resolveRepo(folder: string): Promise<IVoltGitRepo | undefined>;
	/** Captures the work tree (tracked, untracked, uncommitted; honoring .gitignore) as a commit. The user's index is never written. */
	snapshot(request: IVoltGitSnapshotRequest): Promise<IVoltGitSnapshot>;
	/** The tree of the user's staging area right now. Reads a copy, so the real index stays byte-identical. */
	writeIndexTree(request: { readonly repoRoot: string }): Promise<string>;
	/** `git diff --raw --numstat -M` between two commits or trees. `renames: false` reports a rename as a delete and an add. */
	diffSummary(request: { readonly repoRoot: string; readonly from: string; readonly to: string; readonly paths?: readonly string[]; readonly renames?: boolean }): Promise<IVoltGitDiffEntry[]>;
	/** With `path`, the blob comes back as it would be checked out there (smudge filters and line endings applied). */
	readBlob(request: { readonly repoRoot: string; readonly sha: string; readonly path?: string }): Promise<VSBuffer>;
	/** Writes `content` as a blob. With `path`, that path's clean filters (eol, LFS) apply first. */
	writeBlob(request: { readonly repoRoot: string; readonly content: VSBuffer; readonly path?: string }): Promise<string>;
	/** Stages `blob` at `path` without touching the file on disk; null removes the entry. Mode defaults to the current entry's, else 100644. */
	setIndexEntry(request: { readonly repoRoot: string; readonly path: string; readonly blob: string | null; readonly mode?: string }): Promise<void>;
	/** `git reset -q <treeish> -- <paths>`: index entries go back to `treeish`, missing ones are removed. */
	resetIndexPaths(request: { readonly repoRoot: string; readonly treeish: string; readonly paths: readonly string[] }): Promise<void>;
	/** Points `ref` at `commit`, or deletes it when `commit` is undefined. */
	updateRef(request: { readonly repoRoot: string; readonly ref: string; readonly commit?: string }): Promise<void>;
	listRefs(request: { readonly repoRoot: string; readonly prefix: string }): Promise<IVoltGitRef[]>;
	deleteRefs(request: { readonly repoRoot: string; readonly prefix: string }): Promise<void>;
	/**
	 * Applies `from..to` to the work tree at `repoRoot`. With `index`, it applies three-way and
	 * stages the result; conflicts come back in the result instead of throwing.
	 */
	applyPatch(request: { readonly repoRoot: string; readonly from: string; readonly to: string; readonly paths?: readonly string[]; readonly reverse?: boolean; readonly index: boolean }): Promise<IVoltGitApplyResult>;
	/** `git clone --progress`. Never prompts; rejects on failure or cancel. */
	clone(request: IVoltGitCloneRequest): Promise<void>;
	cancelClone(jobId: string): Promise<void>;
	listBranches(request: { readonly repoRoot: string }): Promise<IVoltGitBranches>;
	/**
	 * Switches to a local branch, a remote branch (creating the tracking branch), a tag (detached),
	 * or any ref detached. Refuses to overwrite local changes.
	 */
	checkout(request: { readonly repoRoot: string; readonly ref: string; readonly kind: 'local' | 'remote' | 'tag' | 'detached' }): Promise<void>;
	/** Creates `name` from `from` (default HEAD) and switches to it. */
	createBranch(request: { readonly repoRoot: string; readonly name: string; readonly from?: string }): Promise<void>;
	/**
	 * The repo that keeps agent snapshots of `folder`: its own repo, or for a folder outside git a
	 * private repo in Volt's data folder. Undefined when snapshots aren't possible there (git
	 * missing, the home folder, a file system root).
	 *
	 * Optional so web and remote fallbacks can leave it out; the desktop service implements it.
	 */
	resolveSnapshotRepo?(folder: string): Promise<IVoltGitSnapshotRepo | undefined>;
	/**
	 * Undoes agent work on disk, path by path, without touching the user's index. Edits made after
	 * the agent are kept when they merge cleanly and reported as conflicts otherwise. Optional for
	 * the same reason as {@link resolveSnapshotRepo}.
	 */
	restore?(request: IVoltGitRestoreRequest): Promise<IVoltGitRestoreResult>;
}

/**
 * A git command that failed, timed out, or could not start. Only `name` and `message` survive
 * IPC, so the message carries the command, exit code and stderr.
 */
export class VoltGitError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly exitCode: number | null,
		readonly stderr: string,
		readonly timedOut = false,
	) {
		const what = `git ${args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? ''}`.trim();
		const why = timedOut ? 'timed out' : exitCode === null ? 'could not run' : `failed (exit ${exitCode})`;
		const detail = stderr.trim().split('\n').slice(0, 4).join('\n');
		super(detail ? `${what} ${why}: ${detail}` : `${what} ${why}`);
		this.name = VOLT_GIT_ERROR;
	}
}

const VOLT_GIT_ERROR = 'VoltGitError';

export function isVoltGitError(err: unknown): err is Error {
	return err instanceof Error && err.name === VOLT_GIT_ERROR;
}
