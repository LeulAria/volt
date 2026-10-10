/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IVoltRestackResult, IVoltStack, IVoltStackLayer } from './voltPrStacks.js';

/**
 * Pull requests for agent chats: read, create, review and merge them on the code host.
 *
 * The desktop service runs in the main process. GitHub (github.com and Enterprise hosts) goes
 * through the GitHub CLI, so it uses the accounts the user already signed in with (`gh auth login`),
 * several per host included. GitLab, Bitbucket, Gitea / Forgejo and Azure DevOps go through their
 * REST APIs with a token: one the user gave Volt (kept in Volt's secret storage), else the host's
 * CLI login (glab, tea, az) or its usual environment variable.
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
	/** Absent for GitHub CLI accounts. */
	readonly provider?: VoltPrProvider;
	/** Where the login comes from: the GitHub CLI, a token given to Volt, another CLI, an environment variable. */
	readonly source?: VoltPrAuthSource;
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
	/** GraphQL node id (or the host's own id). */
	readonly id: string;
	/** The kind of host; absent means GitHub. GitLab calls these merge requests (`!12`). */
	readonly provider?: VoltPrProvider;
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

export type VoltPrAuthSource = 'gh' | 'volt' | 'cli' | 'env';

/** A token the user gave Volt for a host (kept in Volt's secret storage, handed to the main process). */
export interface IVoltPrHostCredential {
	/** `gitlab.com`, `git.corp:8443`, `dev.azure.com`. */
	readonly host: string;
	readonly provider: VoltPrProvider;
	readonly token: string;
	/** The web UI's root when it is not `https://<host>` (another port, a path, plain http). */
	readonly webUrl?: string;
	/** Bitbucket API tokens and app passwords sign in with a username (or the Atlassian email). */
	readonly username?: string;
	/** The account the token belongs to, as the host reported it at sign-in. */
	readonly login?: string;
}

export interface IVoltPrSignInRequest {
	readonly host: string;
	readonly provider: VoltPrProvider;
	readonly token: string;
	readonly webUrl?: string;
	readonly username?: string;
	/** Azure DevOps: an organization/project to check the token against (tokens are per organization). */
	readonly owner?: string;
}

/** What Volt knows about a code host: what it is, where it lives, and who it is signed in as. */
export interface IVoltPrHostInfo {
	readonly host: string;
	readonly provider: VoltPrProvider;
	/** Gitea and Forgejo share an API; the version endpoint says which one it is. */
	readonly flavor?: 'gitea' | 'forgejo';
	readonly webUrl: string;
	readonly apiUrl?: string;
	readonly auth?: { readonly source: VoltPrAuthSource; readonly login?: string };
	/** How it was recognized: its name, a setting, a sign-in, an answer from the server, or not at all. */
	readonly detectedBy: 'name' | 'setting' | 'signIn' | 'probe' | 'gh' | 'unknown';
}

/** Which account reads a repository: the host's active one unless the user picked another. */
export interface IVoltPrAuth {
	readonly account?: string;
	/**
	 * A read nobody is waiting on (sync, watch and discovery passes). GitHub refuses it without a
	 * request while the quota is down to the last tenth, which is kept for what the user asks for.
	 */
	readonly background?: boolean;
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

/** Several branches of one repository at once (see {@link IVoltPrBranchRequest}). */
export interface IVoltPrBranchesRequest extends IVoltPrAuth {
	readonly repo: IVoltPrRepoRef;
	readonly branches: readonly string[];
	readonly headOwner?: string;
}

/** A pull request a branch is the head of, with only what tells which one it is. */
export interface IVoltPrBranchRef {
	readonly branch: string;
	readonly repo: IVoltPrRepoRef;
	readonly number: number;
	readonly state: VoltPrState;
	readonly createdAt: number;
	readonly headOwner?: string;
}

export interface IVoltPrBranchPullRequests {
	readonly branch: string;
	/** Newest first, the open one before the rest. */
	readonly pullRequests: readonly IVoltPullRequest[];
}

/**
 * A pull request's "did anything change?" answer, cheap enough to ask for many at once. Compare
 * the parts with an earlier answer; equal parts mean nothing a reader would see moved.
 */
export interface IVoltPrFingerprint {
	readonly key: string;
	/** State, draft, head commit, mergeability, review decision and the head's checks counted by state. */
	readonly status: string;
	/** Comment, review and thread counts, and the newest edit of a comment or review. */
	readonly remarks: string;
	/** A check still runs, or mergeability is being worked out: counts alone cannot say what moved. */
	readonly unsettled: boolean;
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

/** One changed file of a pull request (or of one of its commits) with its patch, for the inline diff. */
export interface IVoltPrFilePatch {
	readonly path: string;
	readonly previousPath?: string;
	readonly change: VoltPrFileChange;
	readonly additions: number;
	readonly deletions: number;
	/** Unified hunks; undefined for binary files and patches GitHub leaves out as too large. */
	readonly patch?: string;
	/** The file's blob on the new side; undefined for a deleted file. */
	readonly blob?: string;
}

/** A comment on a line of a pull request's new side. */
export interface IVoltPrLineComment {
	readonly path: string;
	readonly line: number;
	readonly body: string;
}

export type VoltGitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface IVoltGitStatusFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly status: VoltGitFileStatus;
	readonly additions: number;
	readonly deletions: number;
}

/** Where a work tree stands against its remote: what Commit, Push and Create PR can do from here. */
export interface IVoltGitStatus {
	readonly root: string;
	/** The checked out branch; undefined when HEAD is detached or unborn. */
	readonly branch?: string;
	/** The commit HEAD points at; undefined before the first commit. */
	readonly head?: string;
	/** The remote pushes go to (the upstream's, else `origin`); undefined without remotes. */
	readonly remote?: string;
	/** Every remote's name (`origin`, `upstream`). */
	readonly remotes: readonly string[];
	/** The branch's upstream on that remote, when it has one. */
	readonly upstream?: string;
	readonly ahead: number;
	readonly behind: number;
	/** The remote's default branch (`main`), when it is known. */
	readonly defaultBranch?: string;
	readonly isDefaultBranch: boolean;
	/** Commits on this branch the remote's default branch does not have. */
	readonly aheadOfDefault?: number;
	/** Uncommitted changes, staged or not, untracked files included. */
	readonly files: readonly IVoltGitStatusFile[];
	readonly insertions: number;
	readonly deletions: number;
}

/** A work tree's remotes, read cheaply to decide whether pull request features apply. */
export interface IVoltRepoRemotes {
	/** The work tree's top folder. */
	readonly root: string;
	/** The repository's config file (the main repository's for a linked worktree): remotes change there. */
	readonly configFile: string;
	readonly remotes: readonly string[];
}

export interface IVoltGitCommitRequest {
	readonly folder: string;
	readonly message: string;
	/** Commit only these paths; every change when undefined. */
	readonly paths?: readonly string[];
	/** Create and check out this branch first; the changes come along. */
	readonly newBranch?: string;
}

export interface IVoltGitCommitResult {
	readonly sha: string;
	readonly branch?: string;
	readonly subject: string;
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
	/** `retryAt` (epoch ms): when asking again can work (a rate limit's reset); it rides in the prefix as `[rateLimited@ms]`. */
	constructor(readonly code: VoltPrErrorCode, message: string, readonly retryAt?: number) {
		super(`[${code}${retryAt !== undefined ? `@${Math.round(retryAt)}` : ''}] ${message}`);
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
	const match = /^\[(\w+)(?:@\d+)?\]/.exec(err.message);
	return match ? match[1] as VoltPrErrorCode : 'failed';
}

/** When a failed call can be tried again (a rate limit's reset); undefined when the error does not say. */
export function voltPrErrorRetryAt(err: unknown): number | undefined {
	if (!isVoltPrError(err)) {
		return undefined;
	}
	const match = /^\[\w+@(\d+)\]/.exec(err.message);
	return match ? Number(match[1]) : undefined;
}

/** The message without its `[code]` prefix, for people. */
export function voltPrErrorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/^\[\w+(?:@\d+)?\]\s*/, '');
}

/** One layer of a stack and the pull request its branch has, if any. */
export interface IVoltPrStackLayerView {
	readonly layer: IVoltStackLayer;
	readonly pullRequest?: IVoltPullRequest;
}

export interface IVoltPrStackView {
	readonly stack: IVoltStack;
	/** Bottom first, like `stack.layers`. */
	readonly layers: readonly IVoltPrStackLayerView[];
	/** The branch the work tree has checked out: a new layer is stacked on it. */
	readonly checkedOut?: string;
}

export interface IVoltPrRestackOutcome extends IVoltRestackResult {
	/** Children of merged pull requests that now sit on the merged one's parent, and their new base. */
	readonly retargeted: readonly { readonly branch: string; readonly to: string }[];
}

export interface IVoltPullRequestService {
	readonly _serviceBrand: undefined;
	/** Fires when signed-in accounts may have changed (after a login or a token failure). */
	readonly onDidChangeAccounts: Event<void>;
	/** Signed-in accounts, every host, or one host. Empty when the CLI is missing. */
	accounts(host?: string): Promise<IVoltPrAccount[]>;
	/** Undefined when the folder is not in a git work tree or has no remote on a known host. */
	resolveRepo(folder: string): Promise<IVoltPrRepo | undefined>;
	/** The folder's remotes; undefined outside a git repository. */
	repoRemotes(folder: string): Promise<IVoltRepoRemotes | undefined>;
	list(request: IVoltPrListRequest): Promise<IVoltPullRequest[]>;
	/** Pull requests whose head is the branch, newest first. */
	forBranch(request: IVoltPrBranchRequest): Promise<IVoltPullRequest[]>;
	/** {@link forBranch} for several branches of one repository in a couple of round trips. */
	forBranches(request: IVoltPrBranchesRequest): Promise<IVoltPrBranchPullRequests[]>;
	/**
	 * Which pull requests the branches are the heads of: number, state and age only, so asking
	 * about many branches costs about what asking about one does. Branches with none are left out.
	 */
	branchPullRequests(request: IVoltPrBranchesRequest): Promise<IVoltPrBranchRef[]>;
	/**
	 * A cheap "did anything change?" read for many pull requests at once (on GitHub about a point
	 * for 25). Hosts without one answer an empty list; missing pull requests are left out.
	 */
	fingerprints(requests: readonly IVoltPrRequest[]): Promise<IVoltPrFingerprint[]>;
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
	/** What a commit would hold: the staged changes, else everything; or exactly `paths` against HEAD. */
	describeChanges(request: { readonly folder: string; readonly paths?: readonly string[] }): Promise<IVoltChangesSummary>;
	/** `base` is a branch name; its remote-tracking branch is used when there is one. */
	describeBranch(request: { readonly folder: string; readonly base: string }): Promise<IVoltBranchSummary>;
	/**
	 * Changed files with patches: the whole pull request, or one of its commits. With `folder` (a
	 * local clone), hosts other than GitHub read them from git there, blobs included.
	 */
	filePatches(request: IVoltPrRequest & { readonly commit?: string; readonly folder?: string }): Promise<IVoltPrFilePatch[]>;
	/**
	 * Posts a review with comments on lines of the new side (Volt's review findings). Hosts without
	 * line comments in their API get one comment with every finding.
	 */
	postReview(request: IVoltPrRequest & { readonly body: string; readonly comments: readonly IVoltPrLineComment[]; readonly headOid?: string }): Promise<{ readonly posted: number; readonly url?: string }>;
	/** A file's text by blob id: from the clone at `folder` when it has the blob, else from the host. */
	readBlob(request: IVoltPrAuth & { readonly repo: IVoltPrRepoRef; readonly sha: string; readonly folder?: string }): Promise<string>;
	/** Branch, upstream, default branch and uncommitted files of the work tree at `folder`. */
	gitStatus(folder: string): Promise<IVoltGitStatus | undefined>;
	/** Stages (all, or `paths`) and commits; optionally on a new branch. */
	commit(request: IVoltGitCommitRequest): Promise<IVoltGitCommitResult>;
	/** Fast-forwards the branch to its upstream. */
	pull(folder: string): Promise<{ readonly updated: boolean; readonly branch: string; readonly upstream: string }>;
	/** Creates and checks out `name` at HEAD; uncommitted changes come along. */
	checkoutNewBranch(request: { readonly folder: string; readonly name: string }): Promise<void>;
	/** Forget cached accounts and tokens (after the user signed in or out in a terminal). */
	refreshAccounts(): Promise<void>;
	/** The tokens the user gave Volt, every host (replaces the previous set). */
	setHostCredentials(credentials: readonly IVoltPrHostCredential[]): Promise<void>;
	/** Checks a token against its host and returns the account it belongs to; the caller keeps it. */
	signInHost(request: IVoltPrSignInRequest): Promise<IVoltPrAccount>;
	/** What the host is and who Volt reads it as (probing an unknown host once). */
	hostInfo(host: string): Promise<IVoltPrHostInfo>;
	/** The stack the branch (the checked out one by default) is in, bottom first, with each layer's pull request. */
	stack(request: { readonly folder: string; readonly branch?: string }): Promise<IVoltPrStackView | undefined>;
	/** Creates a layer on the checked out branch, named from `title`, and checks it out. */
	stackNewBranch(request: { readonly folder: string; readonly title: string }): Promise<{ readonly branch: string; readonly parent: string }>;
	/**
	 * Moves the layers above whatever changed: a parent that was amended, rebased or squash-merged.
	 * Children of a merged pull request first sit on its parent (and their pull requests target it).
	 */
	restack(request: { readonly folder: string; readonly branch?: string; readonly syncTrunk?: boolean }): Promise<IVoltPrRestackOutcome>;
}
