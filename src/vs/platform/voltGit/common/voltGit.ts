/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
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
}

export interface IVoltGitSnapshot {
	readonly commit: string;
	readonly tree: string;
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
	/** Undefined when `folder` is not inside a git work tree. */
	resolveRepo(folder: string): Promise<IVoltGitRepo | undefined>;
	/** Captures the work tree (tracked, untracked, uncommitted; honoring .gitignore) as a commit. The user's index is never written. */
	snapshot(request: IVoltGitSnapshotRequest): Promise<IVoltGitSnapshot>;
	/** The tree of the user's staging area right now. Reads a copy, so the real index stays byte-identical. */
	writeIndexTree(request: { readonly repoRoot: string }): Promise<string>;
	/** `git diff --raw --numstat -M` between two commits or trees. */
	diffSummary(request: { readonly repoRoot: string; readonly from: string; readonly to: string; readonly paths?: readonly string[] }): Promise<IVoltGitDiffEntry[]>;
	readBlob(request: { readonly repoRoot: string; readonly sha: string }): Promise<VSBuffer>;
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
