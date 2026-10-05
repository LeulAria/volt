/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Pull requests for agent chats: read, create, review and merge them on the code host.
 *
 * The desktop service runs in the main process and talks to GitHub (github.com and Enterprise
 * hosts) through the GitHub CLI, so it uses the accounts the user already signed in with
 * (`gh auth login`), several per host included. Other hosts are recognized from the remote and
 * reported as unsupported rather than guessed at.
 */

export const IVoltPullRequestService = createDecorator<IVoltPullRequestService>('voltPullRequestService');
export const VOLT_PULL_REQUEST_CHANNEL_NAME = 'voltPullRequests';

export type VoltPrProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'azure' | 'unknown';

/** A repository on a code host, as named in its URLs. */
export interface IVoltPrRepoRef {
	/** `github.com`, or an Enterprise host. */
	readonly host: string;
	readonly owner: string;
	readonly name: string;
}

/** The repository a local folder pushes to and opens pull requests against. */
export interface IVoltPrRepo extends IVoltPrRepoRef {
	readonly provider: VoltPrProvider;
	/** `https://github.com/owner/name`. */
	readonly webUrl: string;
	/** The git remote it came from (`origin`, `upstream`). */
	readonly remote: string;
	/** The work tree's top folder. */
	readonly root: string;
	/** The checked out branch; undefined when HEAD is detached or unborn. */
	readonly branch?: string;
	/** The branch's upstream on that remote, when it has one (`feature/x` for `origin/feature/x`). */
	readonly upstream?: string;
	/** Commits on the branch its upstream does not have yet; undefined without an upstream. */
	readonly ahead?: number;
	readonly behind?: number;
}

export interface IVoltPrAccount {
	readonly host: string;
	readonly login: string;
	/** The host's default account in the GitHub CLI. */
	readonly active: boolean;
	/** False when the CLI holds a token that no longer works. */
	readonly ok: boolean;
	readonly scopes?: string;
}

export type VoltPrState = 'open' | 'draft' | 'merged' | 'closed';

export type VoltPrCheckState = 'pending' | 'success' | 'failure' | 'skipped' | 'neutral' | 'cancelled';

export interface IVoltPrCheck {
	readonly name: string;
	/** The workflow or app that ran it ("CI", "Vercel"). */
	readonly workflow?: string;
	readonly state: VoltPrCheckState;
	readonly url?: string;
	readonly startedAt?: number;
	readonly completedAt?: number;
	/** Text the check reported (title or description). */
	readonly summary?: string;
	readonly required?: boolean;
}

export type VoltPrChecksState = 'none' | 'pending' | 'success' | 'failure';

export interface IVoltPrChecksSummary {
	readonly state: VoltPrChecksState;
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly pending: number;
	/** Skipped, neutral and cancelled checks: they neither pass nor block. */
	readonly skipped: number;
	/** Names of the failing checks, for wake-ups and tooltips. */
	readonly failing: readonly string[];
}

export type VoltPrReviewDecision = 'approved' | 'changesRequested' | 'reviewRequired';

/** Whether the head merges into the base without conflicts. GitHub computes it lazily: `unknown` at first. */
export type VoltPrMergeable = 'mergeable' | 'conflicting' | 'unknown';

/**
 * GitHub's merge box state: `clean` can merge, `blocked` waits on reviews or required checks,
 * `behind` needs the base merged in, `dirty` has conflicts, `unstable` has failing optional checks.
 */
export type VoltPrMergeState = 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'draft' | 'hasHooks' | 'unknown';

export type VoltPrMergeMethod = 'merge' | 'squash' | 'rebase';

export interface IVoltPrLabel {
	readonly name: string;
	/** Hex without `#`. */
	readonly color: string;
}

export interface IVoltPrUser {
	readonly login: string;
	readonly avatarUrl?: string;
	readonly bot?: boolean;
}

export type VoltPrReviewState = 'approved' | 'changesRequested' | 'commented' | 'dismissed' | 'pending';

export interface IVoltPrReviewSummary {
	readonly author: string;
	readonly state: VoltPrReviewState;
	readonly at: number;
}

/** What the sidebar, chips and watches need about a pull request. */
export interface IVoltPullRequest {
	/** `github.com/owner/name#12`: one pull request across accounts and chats. */
	readonly key: string;
	readonly repo: IVoltPrRepoRef;
	readonly number: number;
	/** GraphQL node id. */
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly state: VoltPrState;
	readonly author: IVoltPrUser;
	readonly headRefName: string;
	readonly headRefOid: string;
	readonly baseRefName: string;
	/** Owner of the head branch's repository, for pull requests from forks. */
	readonly headOwner?: string;
	readonly crossRepository: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly mergedAt?: number;
	readonly closedAt?: number;
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
	readonly mergeable: VoltPrMergeable;
	readonly mergeState: VoltPrMergeState;
	readonly reviewDecision?: VoltPrReviewDecision;
	readonly checks: IVoltPrChecksSummary;
	readonly labels: readonly IVoltPrLabel[];
	readonly assignees: readonly string[];
	/** Users and teams (`org/team`) asked to review and who have not yet. */
	readonly reviewRequests: readonly string[];
	/** Latest review per reviewer. */
	readonly reviews: readonly IVoltPrReviewSummary[];
	/** Review threads nobody resolved yet. */
	readonly unresolvedThreads: number;
	/** Conversation comments plus review comments. */
	readonly comments: number;
	readonly autoMerge: boolean;
	/** The signed-in account that read it. */
	readonly viewer: string;
}

export type VoltPrFileChange = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed';

export type VoltPrViewedState = 'viewed' | 'unviewed' | 'dismissed';

export interface IVoltPrFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly change: VoltPrFileChange;
	readonly additions: number;
	readonly deletions: number;
	/** `dismissed`: marked viewed, then changed again. */
	readonly viewed: VoltPrViewedState;
}

export interface IVoltPrComment {
	readonly id: string;
	/** REST id, for replies through the REST API. */
	readonly databaseId?: number;
	readonly author: IVoltPrUser;
	readonly body: string;
	readonly createdAt: number;
	readonly url: string;
	readonly outdated?: boolean;
	/** Review comments: the hunk around the line, as GitHub shows above the thread. */
	readonly diffHunk?: string;
}

export interface IVoltPrReviewThread {
	readonly id: string;
	readonly path: string;
	/** Line in the file on `side`; undefined once the thread is outdated past mapping. */
	readonly line?: number;
	readonly startLine?: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly resolved: boolean;
	readonly outdated: boolean;
	readonly canResolve: boolean;
	readonly comments: readonly IVoltPrComment[];
}

export interface IVoltPrReview {
	readonly id: string;
	readonly author: IVoltPrUser;
	readonly state: VoltPrReviewState;
	readonly body: string;
	readonly at: number;
	readonly url: string;
}

export interface IVoltPrCommit {
	readonly oid: string;
	readonly headline: string;
	readonly author: string;
	readonly at: number;
	readonly checks: VoltPrChecksState;
}

export interface IVoltPrMergeOptions {
	readonly merge: boolean;
	readonly squash: boolean;
	readonly rebase: boolean;
	/** The repository deletes head branches after a merge. */
	readonly deleteBranchOnMerge: boolean;
	readonly autoMergeAllowed: boolean;
}

/** Everything the pull request view shows. */
export interface IVoltPullRequestDetail extends IVoltPullRequest {
	readonly body: string;
	readonly baseRefOid: string;
	readonly files: readonly IVoltPrFile[];
	readonly threads: readonly IVoltPrReviewThread[];
	readonly reviewList: readonly IVoltPrReview[];
	/** Conversation (issue) comments, oldest first. */
	readonly conversation: readonly IVoltPrComment[];
	readonly commits: readonly IVoltPrCommit[];
	readonly checkRuns: readonly IVoltPrCheck[];
	readonly mergeOptions: IVoltPrMergeOptions;
	readonly viewerCanMerge: boolean;
	readonly viewerCanUpdate: boolean;
	/** Labels the repository offers, for the label picker. */
	readonly repoLabels: readonly IVoltPrLabel[];
}

/** Which account reads a repository: the host's active one unless the user picked another. */
export interface IVoltPrAuth {
	readonly account?: string;
}

export interface IVoltPrRequest extends IVoltPrAuth {
	readonly repo: IVoltPrRepoRef;
	readonly number: number;
}

export interface IVoltPrCreateRequest extends IVoltPrAuth {
	readonly repo: IVoltPrRepoRef;
	readonly head: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
	readonly draft: boolean;
	/** Owner of the head branch when it lives in a fork. */
	readonly headOwner?: string;
}

export interface IVoltPrMergeRequest extends IVoltPrRequest {
	readonly method: VoltPrMergeMethod;
	/** Only merge if the head is still this commit (nobody pushed since the user looked). */
	readonly headOid?: string;
	readonly deleteBranch?: boolean;
	/** Queue it to merge once checks and reviews allow. */
	readonly auto?: boolean;
	readonly subject?: string;
	readonly body?: string;
}

export interface IVoltPrListRequest extends IVoltPrAuth {
	readonly repo: IVoltPrRepoRef;
	readonly state: 'open' | 'closed' | 'all';
	readonly limit?: number;
}

/** Pull requests whose head is `branch`, newest first: the open one, or the last merged or closed. */
export interface IVoltPrBranchRequest extends IVoltPrAuth {
	readonly repo: IVoltPrRepoRef;
	readonly branch: string;
	readonly headOwner?: string;
}

export interface IVoltPrFetchResult {
	/** Where the base side of the diff starts: the merge base of base and head. */
	readonly base: string;
	readonly head: string;
}

export interface IVoltPrPushResult {
	readonly branch: string;
	readonly remote: string;
	/** True when the branch had no upstream and got one. */
	readonly setUpstream: boolean;
}

/** What a commit would contain, for writing its message. */
export interface IVoltChangesSummary {
	readonly branch?: string;
	/** True when the summary is of the staged changes; false: everything uncommitted. */
	readonly staged: boolean;
	/** `M\tpath` lines, like `git diff --name-status`; untracked files read `A`. */
	readonly files: string;
	readonly patch: string;
	/** Subjects of the latest commits, to match the project's style. */
	readonly recentSubjects: readonly string[];
}

/** What a pull request from the checked out branch would contain, for writing its title and body. */
export interface IVoltBranchSummary {
	readonly head: string;
	readonly base: string;
	/** Subjects of the commits on the branch, oldest first. */
	readonly commits: readonly string[];
	readonly stat: string;
	readonly patch: string;
	/** The repository's pull request template, when it has one. */
	readonly template?: string;
}

export type VoltPrErrorCode =
	/** The GitHub CLI is not installed. */
	| 'noCli'
	/** No signed-in account for the host. */
	| 'noAuth'
	/** The host is not one Volt can talk to yet. */
	| 'unsupported'
	| 'notFound'
	| 'conflict'
	/** The head moved since the user looked (merge with `headOid`). */
	| 'stale'
	| 'network'
	| 'rateLimited'
	| 'failed';

/**
 * A pull request call that failed. Only `name` and `message` survive IPC, so the code rides at the
 * start of the message (`[noAuth] ...`); {@link voltPrErrorCode} reads it back.
 */
export class VoltPrError extends Error {
	constructor(readonly code: VoltPrErrorCode, message: string) {
		super(`[${code}] ${message}`);
		this.name = VOLT_PR_ERROR;
	}
}

const VOLT_PR_ERROR = 'VoltPrError';

export function isVoltPrError(err: unknown): err is Error {
	return err instanceof Error && err.name === VOLT_PR_ERROR;
}

export function voltPrErrorCode(err: unknown): VoltPrErrorCode | undefined {
	if (!isVoltPrError(err)) {
		return undefined;
	}
	const match = /^\[(\w+)\]/.exec(err.message);
	return match ? match[1] as VoltPrErrorCode : 'failed';
}

/** The message without its `[code]` prefix, for people. */
export function voltPrErrorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/^\[\w+\]\s*/, '');
}

export interface IVoltPullRequestService {
	readonly _serviceBrand: undefined;
	/** Fires when signed-in accounts may have changed (after a login or a token failure). */
	readonly onDidChangeAccounts: Event<void>;
	/** Signed-in accounts, every host, or one host. Empty when the CLI is missing. */
	accounts(host?: string): Promise<IVoltPrAccount[]>;
	/** Undefined when the folder is not in a git work tree or has no remote on a known host. */
	resolveRepo(folder: string): Promise<IVoltPrRepo | undefined>;
	list(request: IVoltPrListRequest): Promise<IVoltPullRequest[]>;
	/** Pull requests whose head is the branch, newest first. */
	forBranch(request: IVoltPrBranchRequest): Promise<IVoltPullRequest[]>;
	/** Several pull requests in one round trip per host and account; missing ones are left out. */
	getMany(requests: readonly IVoltPrRequest[]): Promise<IVoltPullRequest[]>;
	detail(request: IVoltPrRequest): Promise<IVoltPullRequestDetail>;
	create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest>;
	merge(request: IVoltPrMergeRequest): Promise<void>;
	/** Disables auto-merge queued by {@link merge} with `auto`. */
	cancelAutoMerge(request: IVoltPrRequest): Promise<void>;
	/** Brings the head up to date with the base, by merge commit or by rebase. */
	updateBranch(request: IVoltPrRequest & { readonly rebase: boolean }): Promise<void>;
	setDraft(request: IVoltPrRequest & { readonly draft: boolean }): Promise<void>;
	setState(request: IVoltPrRequest & { readonly state: 'open' | 'closed' }): Promise<void>;
	setBase(request: IVoltPrRequest & { readonly base: string }): Promise<void>;
	setLabels(request: IVoltPrRequest & { readonly add: readonly string[]; readonly remove: readonly string[] }): Promise<void>;
	setViewed(request: IVoltPrRequest & { readonly path: string; readonly viewed: boolean }): Promise<void>;
	comment(request: IVoltPrRequest & { readonly body: string }): Promise<void>;
	reply(request: IVoltPrRequest & { readonly threadId: string; readonly body: string }): Promise<void>;
	resolveThread(request: IVoltPrRequest & { readonly threadId: string; readonly resolved: boolean }): Promise<void>;
	/** Submits a review: approve, request changes or comment. */
	review(request: IVoltPrRequest & { readonly event: 'approve' | 'requestChanges' | 'comment'; readonly body: string }): Promise<void>;
	requestReviewers(request: IVoltPrRequest & { readonly logins: readonly string[] }): Promise<void>;
	/** Re-runs the failed jobs of the head commit's workflow runs. */
	rerunFailedChecks(request: IVoltPrRequest): Promise<number>;
	/**
	 * Fetches the pull request's base and head into hidden refs of the local clone at `folder`, so
	 * its diff reads from git like any other. Never touches the work tree or branches.
	 */
	fetch(request: IVoltPrRequest & { readonly folder: string }): Promise<IVoltPrFetchResult>;
	/** Pushes the checked out branch at `folder`, setting its upstream on first push. */
	push(request: { readonly folder: string; readonly remote?: string }): Promise<IVoltPrPushResult>;
	/** Branches on the remote, for the base picker. */
	remoteBranches(request: IVoltPrAuth & { readonly repo: IVoltPrRepoRef }): Promise<string[]>;
	describeChanges(request: { readonly folder: string }): Promise<IVoltChangesSummary>;
	/** `base` is a branch name; its remote-tracking branch is used when there is one. */
	describeBranch(request: { readonly folder: string; readonly base: string }): Promise<IVoltBranchSummary>;
	/** Forget cached accounts and tokens (after the user signed in or out in a terminal). */
	refreshAccounts(): Promise<void>;
}
