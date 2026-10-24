/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project's (or chat worktree's) branch and its pull requests, as the agent server's `git.*` and
// `pullRequests.*` methods return them (src/vs/server/node/voltAgent/serverGit.ts, over the
// desktop's VoltPullRequestService: platform/voltPullRequests/common/voltPullRequests.ts).

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface IGitStatusFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly status: GitFileStatus;
	readonly additions: number;
	readonly deletions: number;
}

/** `git.status(root)`. Outside a git work tree only `root` and `isRepo: false`. */
export interface IGitRepoStatus {
	readonly root: string;
	readonly isRepo: boolean;
	readonly branch?: string;
	readonly head?: string;
	readonly remote?: string;
	readonly remotes?: readonly string[];
	readonly upstream?: string;
	readonly ahead?: number;
	readonly behind?: number;
	readonly defaultBranch?: string;
	readonly isDefaultBranch?: boolean;
	/** Commits on the branch that its default branch lacks. */
	readonly aheadOfDefault?: number;
	readonly files?: readonly IGitStatusFile[];
	readonly insertions?: number;
	readonly deletions?: number;
	/** The pull request host behind the remote; absent when the folder has none Volt knows. */
	readonly repo?: { readonly provider: string; readonly host: string; readonly owner: string; readonly name: string; readonly webUrl: string; readonly remote: string };
	/** Who Volt reads the host as; `signedIn` false when `gh` (or the host's sign-in) is missing. */
	readonly auth?: { readonly signedIn: boolean; readonly login?: string };
}

export interface IGitCommitResult {
	readonly sha: string;
	readonly branch?: string;
	readonly subject: string;
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';
export type PullRequestChecksState = 'none' | 'pending' | 'success' | 'failure';
export type PullRequestMergeMethod = 'squash' | 'merge' | 'rebase';

export interface IPullRequestChecks {
	readonly state: PullRequestChecksState;
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly pending: number;
	readonly skipped: number;
	/** Names of the failing checks. */
	readonly failing: readonly string[];
}

export interface IPullRequestUser {
	readonly login: string;
	readonly avatarUrl?: string;
	readonly bot?: boolean;
}

/** A pull request as lists and the branch row show it. */
export interface IPullRequestSummary {
	readonly key: string;
	readonly repo: { readonly host: string; readonly owner: string; readonly name: string };
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: PullRequestState;
	readonly author: IPullRequestUser;
	readonly headRefName: string;
	readonly headRefOid: string;
	readonly baseRefName: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly mergedAt?: number;
	readonly closedAt?: number;
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
	readonly mergeable: 'mergeable' | 'conflicting' | 'unknown';
	readonly mergeState: 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'draft' | 'hasHooks' | 'unknown';
	readonly reviewDecision?: 'approved' | 'changesRequested' | 'reviewRequired';
	readonly checks: IPullRequestChecks;
	readonly labels: readonly { readonly name: string; readonly color: string }[];
	readonly reviewRequests: readonly string[];
	readonly unresolvedThreads: number;
	readonly comments: number;
	readonly autoMerge: boolean;
	/** Open, mergeable, checks not failing or running, no changes requested: Merge can be offered. */
	readonly readyToMerge: boolean;
}

export interface IPullRequestComment {
	readonly id: string;
	readonly author: IPullRequestUser;
	readonly body: string;
	readonly createdAt: number;
	readonly url: string;
}

export interface IPullRequestCheckRun {
	readonly name: string;
	readonly workflow?: string;
	readonly state: 'pending' | 'success' | 'failure' | 'skipped' | 'neutral' | 'cancelled';
	readonly url?: string;
	readonly summary?: string;
	readonly required?: boolean;
}

/** `pullRequests.get(root, number)`. */
export interface IPullRequestDetail extends IPullRequestSummary {
	readonly body: string;
	readonly files: readonly { readonly path: string; readonly previousPath?: string; readonly change: string; readonly additions: number; readonly deletions: number }[];
	readonly conversation: readonly IPullRequestComment[];
	readonly reviewList: readonly { readonly id: string; readonly author: IPullRequestUser; readonly state: string; readonly body: string; readonly at: number }[];
	readonly commits: readonly { readonly oid: string; readonly headline: string; readonly author: string; readonly at: number; readonly checks: PullRequestChecksState }[];
	readonly checkRuns: readonly IPullRequestCheckRun[];
	readonly mergeOptions: { readonly merge: boolean; readonly squash: boolean; readonly rebase: boolean; readonly deleteBranchOnMerge: boolean; readonly autoMergeAllowed: boolean };
	readonly viewerCanMerge: boolean;
}

/** `pullRequests.files(root, number)`: a file of the pull request with its unified patch. */
export interface IPullRequestFilePatch {
	readonly path: string;
	readonly previousPath?: string;
	readonly change: string;
	readonly additions: number;
	readonly deletions: number;
	readonly patch?: string;
}

export interface IPullRequestCreate {
	readonly title: string;
	readonly body?: string;
	/** Default: the repository's default branch. */
	readonly base?: string;
	readonly draft?: boolean;
}

export interface IPullRequestMerge {
	readonly method: PullRequestMergeMethod;
	readonly deleteBranch?: boolean;
	/** The head the user saw: the merge fails (`stale`) when the branch moved since. */
	readonly headOid?: string;
	/** Merge once checks pass (auto-merge), where the repository allows it. */
	readonly auto?: boolean;
}

/** One entry of the composer's `/` menu (`composer.slashCommands(root)`). */
export interface ISlashCommand {
	readonly name: string;
	/** `builtin-command` acts in the app (`model`, `customize`, `new-chat`, `usage`); the rest send instructions. */
	readonly type: 'builtin-command' | 'skill' | 'command' | 'subagent' | 'rule';
	readonly title: string;
	readonly summary: string;
	readonly description: string;
	readonly builtin: boolean;
	readonly location?: string;
	readonly sourceLabel?: string;
	readonly canUseAsMode: boolean;
}

/**
 * The tag a project file is named by in the prompt text, and the mention the transcript draws as
 * a chip, written as the desktop composer writes them: `@src/cart.ts` relative to the project
 * root (the agent resolves it from its working folder), the full path when outside it.
 */
export function projectFileMention(path: string, root?: string, kind: 'file' | 'folder' = 'file'): { readonly tag: string; readonly mention: { readonly label: string; readonly kind: 'file' | 'folder'; readonly resource: { readonly $mid: 1; readonly scheme: 'file'; readonly authority: ''; readonly path: string } } } {
	const base = root?.replace(/\/+$/, '');
	const relative = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
	const name = path.replace(/\/+$/, '').split('/').pop() || path;
	return {
		tag: `@${relative}`,
		mention: { label: name, kind, resource: { $mid: 1, scheme: 'file', authority: '', path: path.startsWith('/') ? path : `/${path}` } },
	};
}
