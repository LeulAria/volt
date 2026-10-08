/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IVoltPrCheck,
	IVoltPrChecksSummary,
	IVoltPrComment,
	IVoltPrCommit,
	IVoltGitStatusFile,
	IVoltPrFile,
	IVoltPrFilePatch,
	IVoltPrLabel,
	IVoltPrRepoRef,
	IVoltPrReview,
	IVoltPrReviewSummary,
	IVoltPrReviewThread,
	IVoltPrUser,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	VoltGitFileStatus,
	VoltPrCheckState,
	VoltPrChecksState,
	VoltPrErrorCode,
	VoltPrFileChange,
	VoltPrMergeable,
	VoltPrMergeState,
	VoltPrProvider,
	VoltPrReviewDecision,
	VoltPrReviewState,
	VoltPrState,
	VoltPrViewedState,
} from './voltPullRequests.js';
import { hostName, hostProductLabel, parseChangeRequestUrl, providerForKnownHost } from './voltPrHosts.js';

//#region Remotes

export interface IParsedRemote {
	readonly host: string;
	readonly owner: string;
	readonly name: string;
	readonly provider: VoltPrProvider;
}

/**
 * `git@github.com:o/n.git`, `ssh://git@host:22/o/n`, `https://user@host/o/n.git`, Azure DevOps
 * (`dev.azure.com/org/project/_git/repo`, `org@vs-ssh.visualstudio.com:v3/org/project/repo`).
 * `githubHosts` are hosts with a GitHub CLI login, so Enterprise servers count as GitHub.
 */
export function parseRemoteUrl(url: string, githubHosts: ReadonlySet<string> = new Set(), knownHosts?: ReadonlyMap<string, VoltPrProvider>): IParsedRemote | undefined {
	const raw = url.trim();
	if (!raw) {
		return undefined;
	}
	let host: string;
	let path: string;
	const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
	if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		host = scp[1];
		path = scp[2];
	} else {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return undefined;
		}
		if (!/^(https?|ssh|git|git\+ssh):$/.test(parsed.protocol)) {
			return undefined;
		}
		// The web port is part of the host (a server on :3000); an SSH port is not where the API is.
		host = /^https?:$/.test(parsed.protocol) ? parsed.host : parsed.hostname;
		path = decodeURIComponent(parsed.pathname);
	}
	host = host.toLowerCase();
	const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
	const bare = hostName(host);
	if (bare === 'dev.azure.com' || bare.endsWith('.dev.azure.com') || bare.endsWith('.visualstudio.com')) {
		// https: org/project/_git/repo (org.visualstudio.com/[DefaultCollection/]project/_git/repo); ssh: v3/org/project/repo
		if (parts[0] === 'v3' && parts.length >= 4) {
			return { host: 'dev.azure.com', owner: `${parts[1]}/${parts[2]}`, name: parts[3], provider: 'azure' };
		}
		const git = parts.indexOf('_git');
		if (git >= 1 && parts[git + 1]) {
			const before = parts.slice(0, git).filter(part => part.toLowerCase() !== 'defaultcollection');
			const org = bare.endsWith('.visualstudio.com') && !bare.startsWith('vs-ssh.') ? bare.slice(0, -'.visualstudio.com'.length) : undefined;
			const owner = (org ? [org, ...before] : before).slice(0, 2).join('/');
			return owner.includes('/') ? { host: 'dev.azure.com', owner, name: parts[git + 1], provider: 'azure' } : undefined;
		}
		return undefined;
	}
	if (parts.length < 2) {
		return undefined;
	}
	// GitLab groups nest; everything before the last segment is the namespace.
	const name = parts[parts.length - 1];
	const owner = parts.slice(0, -1).join('/');
	return { host, owner, name, provider: knownHosts?.get(host) ?? providerForHost(host, githubHosts) };
}

export function providerForHost(host: string, githubHosts: ReadonlySet<string> = new Set()): VoltPrProvider {
	const h = host.toLowerCase();
	if (githubHosts.has(h)) {
		return 'github';
	}
	return providerForKnownHost(h);
}

/** `ssh.github.com` is GitHub's SSH-over-443 alias; the API lives on github.com. */
export function apiHost(host: string): string {
	return host === 'ssh.github.com' ? 'github.com' : host;
}

export function providerLabel(provider: VoltPrProvider): string {
	return hostProductLabel(provider);
}

export function prKey(repo: IVoltPrRepoRef, number: number): string {
	return `${repo.host}/${repo.owner}/${repo.name}#${number}`.toLowerCase();
}

/** A pull request (merge request) URL on any host Volt knows (see {@link parseChangeRequestUrl}) → repo and number. */
export function parsePullRequestUrl(url: string): { repo: IVoltPrRepoRef; number: number } | undefined {
	const parsed = parseChangeRequestUrl(url);
	return parsed ? { repo: parsed.repo, number: parsed.number } : undefined;
}

//#endregion

//#region Errors

/** Sorts a failed `gh` call into an error code from its stderr. */
export function classifyGhError(stderr: string, exitCode: number | null, spawnError?: string): VoltPrErrorCode {
	if (spawnError && /ENOENT/.test(spawnError)) {
		return 'noCli';
	}
	const text = stderr.toLowerCase();
	if (/gh auth login|not logged in|authentication required|bad credentials|requires authentication|http 401|token .* (?:invalid|expired)|no oauth token/.test(text)) {
		return 'noAuth';
	}
	if (/rate limit|secondary rate|abuse detection|http 429/.test(text)) {
		return 'rateLimited';
	}
	if (/head branch was modified|expected head oid|head sha (?:didn't|did not) match|is not up to date with the expected/.test(text)) {
		return 'stale';
	}
	if (/merge conflict|not mergeable|conflicts? (?:must|need)|dirty/.test(text)) {
		return 'conflict';
	}
	if (/could not resolve to a|not found|http 404/.test(text)) {
		return 'notFound';
	}
	if (/could not resolve host|connection refused|network is unreachable|timeout|timed out|tls handshake|no such host|eof|connection reset/.test(text) || exitCode === null) {
		return 'network';
	}
	return 'failed';
}

/** The useful part of `gh`'s stderr: no usage text, at most a few lines. */
export function ghErrorText(stderr: string): string {
	const lines = stderr.split('\n').map(line => line.trim()).filter(line => line && !/^usage:/i.test(line));
	return lines.slice(0, 3).join(' ').replace(/^gh:\s*/i, '').slice(0, 400) || 'The GitHub CLI failed.';
}

//#endregion

//#region GraphQL

/** Fields every pull request read asks for. */
export const PR_SUMMARY_FRAGMENT = `
fragment VoltPr on PullRequest {
	id number title url state isDraft createdAt updatedAt mergedAt closedAt
	author { login avatarUrl __typename }
	headRefName headRefOid baseRefName isCrossRepository
	headRepositoryOwner { login }
	additions deletions changedFiles
	mergeable mergeStateStatus reviewDecision
	autoMergeRequest { enabledAt }
	labels(first: 20) { nodes { name color } }
	assignees(first: 10) { nodes { login } }
	reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } ... on Bot { login } ... on Mannequin { login } } } }
	latestReviews(first: 30) { nodes { author { login } state submittedAt } }
	comments { totalCount }
	reviewThreads(first: 100) { nodes { isResolved comments { totalCount } } }
	commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
		__typename
		... on CheckRun { name status conclusion detailsUrl startedAt completedAt title checkSuite { workflowRun { workflow { name } } app { name } } }
		... on StatusContext { context state targetUrl description createdAt }
	} } } } } }
}`;

type Json = any;

function time(value: unknown): number | undefined {
	if (typeof value !== 'string' || !value) {
		return undefined;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nodes(connection: Json): Json[] {
	return Array.isArray(connection?.nodes) ? connection.nodes.filter((node: unknown) => !!node) : [];
}

export function parseUser(raw: Json): IVoltPrUser {
	// GitHub returns no author for deleted accounts ("ghost").
	const login = str(raw?.login, 'ghost');
	return {
		login,
		...(typeof raw?.avatarUrl === 'string' ? { avatarUrl: raw.avatarUrl } : {}),
		...(raw?.__typename === 'Bot' || /\[bot\]$/.test(login) ? { bot: true } : {}),
	};
}

export function parsePrState(state: unknown, draft: unknown): VoltPrState {
	switch (state) {
		case 'MERGED': return 'merged';
		case 'CLOSED': return 'closed';
		default: return draft ? 'draft' : 'open';
	}
}

export function parseMergeable(value: unknown): VoltPrMergeable {
	switch (value) {
		case 'MERGEABLE': return 'mergeable';
		case 'CONFLICTING': return 'conflicting';
		default: return 'unknown';
	}
}

export function parseMergeState(value: unknown): VoltPrMergeState {
	switch (value) {
		case 'CLEAN': return 'clean';
		case 'BLOCKED': return 'blocked';
		case 'BEHIND': return 'behind';
		case 'DIRTY': return 'dirty';
		case 'UNSTABLE': return 'unstable';
		case 'DRAFT': return 'draft';
		case 'HAS_HOOKS': return 'hasHooks';
		default: return 'unknown';
	}
}

export function parseReviewDecision(value: unknown): VoltPrReviewDecision | undefined {
	switch (value) {
		case 'APPROVED': return 'approved';
		case 'CHANGES_REQUESTED': return 'changesRequested';
		case 'REVIEW_REQUIRED': return 'reviewRequired';
		default: return undefined;
	}
}

export function parseReviewState(value: unknown): VoltPrReviewState {
	switch (value) {
		case 'APPROVED': return 'approved';
		case 'CHANGES_REQUESTED': return 'changesRequested';
		case 'DISMISSED': return 'dismissed';
		case 'PENDING': return 'pending';
		default: return 'commented';
	}
}

export function parseCheckRun(raw: Json): IVoltPrCheck | undefined {
	if (raw?.__typename === 'CheckRun') {
		let state: VoltPrCheckState;
		if (raw.status !== 'COMPLETED') {
			state = 'pending';
		} else {
			switch (raw.conclusion) {
				case 'SUCCESS': state = 'success'; break;
				case 'FAILURE':
				case 'TIMED_OUT':
				case 'STARTUP_FAILURE':
				case 'ACTION_REQUIRED': state = 'failure'; break;
				case 'CANCELLED': state = 'cancelled'; break;
				case 'SKIPPED': state = 'skipped'; break;
				default: state = 'neutral'; break;
			}
		}
		const workflow = raw.checkSuite?.workflowRun?.workflow?.name ?? raw.checkSuite?.app?.name;
		return {
			name: str(raw.name, 'check'),
			...(typeof workflow === 'string' && workflow ? { workflow } : {}),
			state,
			...(typeof raw.detailsUrl === 'string' && raw.detailsUrl ? { url: raw.detailsUrl } : {}),
			...(time(raw.startedAt) !== undefined ? { startedAt: time(raw.startedAt) } : {}),
			...(time(raw.completedAt) !== undefined ? { completedAt: time(raw.completedAt) } : {}),
			...(typeof raw.title === 'string' && raw.title ? { summary: raw.title } : {}),
			...(typeof raw.isRequired === 'boolean' ? { required: raw.isRequired } : {}),
		};
	}
	if (raw?.__typename === 'StatusContext') {
		let state: VoltPrCheckState;
		switch (raw.state) {
			case 'SUCCESS': state = 'success'; break;
			case 'FAILURE':
			case 'ERROR': state = 'failure'; break;
			default: state = 'pending'; break;
		}
		return {
			name: str(raw.context, 'status'),
			state,
			...(typeof raw.targetUrl === 'string' && raw.targetUrl ? { url: raw.targetUrl } : {}),
			...(time(raw.createdAt) !== undefined ? { startedAt: time(raw.createdAt) } : {}),
			...(typeof raw.description === 'string' && raw.description ? { summary: raw.description } : {}),
			...(typeof raw.isRequired === 'boolean' ? { required: raw.isRequired } : {}),
		};
	}
	return undefined;
}

/**
 * The head commit's checks, one per workflow and name: a re-run leaves the old run in the rollup,
 * and only the newest one says where the check stands.
 */
export function latestChecks(checks: readonly IVoltPrCheck[]): IVoltPrCheck[] {
	const byName = new Map<string, IVoltPrCheck>();
	for (const check of checks) {
		const key = `${check.workflow ?? ''}\u0000${check.name}`;
		const seen = byName.get(key);
		if (!seen || (check.startedAt ?? 0) >= (seen.startedAt ?? 0)) {
			byName.set(key, check);
		}
	}
	return [...byName.values()];
}

export function summarizeChecks(checks: readonly IVoltPrCheck[]): IVoltPrChecksSummary {
	let passed = 0, failed = 0, pending = 0, skipped = 0;
	const failing: string[] = [];
	for (const check of checks) {
		switch (check.state) {
			case 'success': passed++; break;
			case 'failure': failed++; failing.push(check.name); break;
			case 'pending': pending++; break;
			default: skipped++; break;
		}
	}
	const total = checks.length;
	let state: VoltPrChecksState;
	if (failed) {
		state = 'failure';
	} else if (pending) {
		state = 'pending';
	} else if (total) {
		state = 'success';
	} else {
		state = 'none';
	}
	return { state, total, passed, failed, pending, skipped, failing };
}

function headChecks(raw: Json): IVoltPrCheck[] {
	const commit = nodes(raw?.commits)[0]?.commit;
	const contexts = nodes(commit?.statusCheckRollup?.contexts);
	return latestChecks(contexts.map(parseCheckRun).filter((check): check is IVoltPrCheck => !!check));
}

function parseLabels(raw: Json): IVoltPrLabel[] {
	return nodes(raw).map(label => ({ name: str(label.name), color: str(label.color, '888888') })).filter(label => label.name);
}

function reviewRequestName(raw: Json): string | undefined {
	const reviewer = raw?.requestedReviewer;
	if (!reviewer) {
		return undefined;
	}
	if (reviewer.__typename === 'Team') {
		return typeof reviewer.combinedSlug === 'string' ? reviewer.combinedSlug : undefined;
	}
	return typeof reviewer.login === 'string' ? reviewer.login : undefined;
}

export function parsePullRequest(raw: Json, repo: IVoltPrRepoRef, viewer: string): IVoltPullRequest {
	const number = num(raw.number);
	const threads = nodes(raw.reviewThreads);
	const reviewComments = threads.reduce((sum, thread) => sum + num(thread?.comments?.totalCount), 0);
	const reviews: IVoltPrReviewSummary[] = nodes(raw.latestReviews).map(review => ({
		author: str(review.author?.login, 'ghost'),
		state: parseReviewState(review.state),
		at: time(review.submittedAt) ?? 0,
	}));
	const reviewDecision = parseReviewDecision(raw.reviewDecision);
	const mergedAt = time(raw.mergedAt);
	const closedAt = time(raw.closedAt);
	const headOwner = raw.headRepositoryOwner?.login;
	return {
		key: prKey(repo, number),
		repo: { host: repo.host, owner: repo.owner, name: repo.name },
		number,
		id: str(raw.id),
		title: str(raw.title),
		url: str(raw.url),
		state: parsePrState(raw.state, raw.isDraft),
		author: parseUser(raw.author),
		headRefName: str(raw.headRefName),
		headRefOid: str(raw.headRefOid),
		baseRefName: str(raw.baseRefName),
		...(typeof headOwner === 'string' ? { headOwner } : {}),
		crossRepository: !!raw.isCrossRepository,
		createdAt: time(raw.createdAt) ?? 0,
		updatedAt: time(raw.updatedAt) ?? 0,
		...(mergedAt !== undefined ? { mergedAt } : {}),
		...(closedAt !== undefined ? { closedAt } : {}),
		additions: num(raw.additions),
		deletions: num(raw.deletions),
		changedFiles: num(raw.changedFiles),
		mergeable: parseMergeable(raw.mergeable),
		mergeState: parseMergeState(raw.mergeStateStatus),
		...(reviewDecision ? { reviewDecision } : {}),
		checks: summarizeChecks(headChecks(raw)),
		labels: parseLabels(raw.labels),
		assignees: nodes(raw.assignees).map(user => str(user.login)).filter(Boolean),
		reviewRequests: nodes(raw.reviewRequests).map(reviewRequestName).filter((name): name is string => !!name),
		reviews,
		unresolvedThreads: threads.filter(thread => thread && !thread.isResolved).length,
		comments: num(raw.comments?.totalCount) + reviewComments,
		autoMerge: !!raw.autoMergeRequest,
		viewer,
	};
}

export function parseFileChange(value: unknown): VoltPrFileChange {
	switch (value) {
		case 'ADDED': return 'added';
		case 'DELETED': return 'deleted';
		case 'RENAMED': return 'renamed';
		case 'COPIED': return 'copied';
		case 'MODIFIED': return 'modified';
		default: return 'changed';
	}
}

export function parseViewed(value: unknown): VoltPrViewedState {
	switch (value) {
		case 'VIEWED': return 'viewed';
		case 'DISMISSED': return 'dismissed';
		default: return 'unviewed';
	}
}

export function parseFile(raw: Json): IVoltPrFile {
	const previousPath = raw.previousFilename ?? raw.previousPath;
	return {
		path: str(raw.path),
		...(typeof previousPath === 'string' && previousPath && previousPath !== raw.path ? { previousPath } : {}),
		change: parseFileChange(raw.changeType),
		additions: num(raw.additions),
		deletions: num(raw.deletions),
		viewed: parseViewed(raw.viewerViewedState),
	};
}

export function parseComment(raw: Json): IVoltPrComment {
	return {
		id: str(raw.id),
		...(typeof raw.databaseId === 'number' ? { databaseId: raw.databaseId } : {}),
		author: parseUser(raw.author),
		body: str(raw.body),
		// A comment written inside a review is drafted first and shown when the review is submitted:
		// that moment (publishedAt) is when others see it.
		createdAt: time(raw.publishedAt) ?? time(raw.createdAt) ?? 0,
		url: str(raw.url),
		...(raw.outdated ? { outdated: true } : {}),
		...(typeof raw.diffHunk === 'string' && raw.diffHunk ? { diffHunk: raw.diffHunk } : {}),
	};
}

export function parseThread(raw: Json): IVoltPrReviewThread {
	const line = typeof raw.line === 'number' ? raw.line : typeof raw.originalLine === 'number' ? raw.originalLine : undefined;
	const startLine = typeof raw.startLine === 'number' ? raw.startLine : undefined;
	return {
		id: str(raw.id),
		path: str(raw.path),
		...(line !== undefined ? { line } : {}),
		...(startLine !== undefined && startLine !== line ? { startLine } : {}),
		side: raw.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
		resolved: !!raw.isResolved,
		outdated: !!raw.isOutdated,
		canResolve: !!(raw.viewerCanResolve || raw.viewerCanUnresolve),
		comments: nodes(raw.comments).map(parseComment),
	};
}

export function parseReview(raw: Json): IVoltPrReview {
	return {
		id: str(raw.id),
		author: parseUser(raw.author),
		state: parseReviewState(raw.state),
		body: str(raw.body),
		at: time(raw.submittedAt) ?? time(raw.createdAt) ?? 0,
		url: str(raw.url),
	};
}

export function parseCommit(raw: Json): IVoltPrCommit {
	const commit = raw?.commit ?? raw;
	const rollup = commit?.statusCheckRollup?.state;
	let checks: VoltPrChecksState;
	switch (rollup) {
		case 'SUCCESS': checks = 'success'; break;
		case 'FAILURE':
		case 'ERROR': checks = 'failure'; break;
		case 'PENDING':
		case 'EXPECTED': checks = 'pending'; break;
		default: checks = 'none'; break;
	}
	return {
		oid: str(commit?.oid),
		headline: str(commit?.messageHeadline),
		author: str(commit?.author?.user?.login ?? commit?.author?.name, 'unknown'),
		at: time(commit?.committedDate) ?? time(commit?.authoredDate) ?? 0,
		checks,
	};
}

export interface IDetailExtras {
	readonly files: readonly IVoltPrFile[];
	readonly checks?: readonly IVoltPrCheck[];
}

export function parsePullRequestDetail(raw: Json, repoRaw: Json, repo: IVoltPrRepoRef, viewer: string, extras: IDetailExtras): IVoltPullRequestDetail {
	const summary = parsePullRequest(raw, repo, viewer);
	const checkRuns = extras.checks ? latestChecks(extras.checks) : headChecks(raw);
	const permission = str(repoRaw?.viewerPermission);
	const canWrite = permission === 'ADMIN' || permission === 'MAINTAIN' || permission === 'WRITE';
	return {
		...summary,
		checks: summarizeChecks(checkRuns),
		body: str(raw.body),
		baseRefOid: str(raw.baseRefOid),
		files: extras.files,
		threads: nodes(raw.reviewThreadsFull ?? raw.reviewThreads).map(parseThread),
		reviewList: nodes(raw.reviewList).map(parseReview).filter(review => review.state !== 'pending' || review.author.login === viewer),
		conversation: nodes(raw.conversation).map(parseComment),
		commits: nodes(raw.commitList).map(parseCommit),
		checkRuns,
		mergeOptions: {
			merge: repoRaw?.mergeCommitAllowed !== false,
			squash: repoRaw?.squashMergeAllowed !== false,
			rebase: repoRaw?.rebaseMergeAllowed !== false,
			deleteBranchOnMerge: !!repoRaw?.deleteBranchOnMerge,
			autoMergeAllowed: !!repoRaw?.autoMergeAllowed,
		},
		viewerCanMerge: canWrite,
		viewerCanUpdate: !!raw.viewerCanUpdate || canWrite,
		repoLabels: parseLabels(repoRaw?.labels),
	};
}

/** A GraphQL string literal. */
export function gqlString(value: string): string {
	return JSON.stringify(value);
}

//#endregion

//#region Local git

/** A REST file entry (`pulls/N/files`, `commits/SHA`) with its patch. */
export function parseFilePatch(raw: Json): IVoltPrFilePatch {
	const previousPath = raw?.previous_filename;
	return {
		path: str(raw?.filename),
		...(typeof previousPath === 'string' && previousPath && previousPath !== raw?.filename ? { previousPath } : {}),
		change: parseRestFileChange(raw?.status),
		additions: num(raw?.additions),
		deletions: num(raw?.deletions),
		...(typeof raw?.patch === 'string' && raw.patch ? { patch: raw.patch } : {}),
		...(raw?.status !== 'removed' && typeof raw?.sha === 'string' && /^[0-9a-f]{40,64}$/.test(raw.sha) ? { blob: raw.sha } : {}),
	};
}

export function parseRestFileChange(value: unknown): VoltPrFileChange {
	switch (value) {
		case 'added': return 'added';
		case 'removed': return 'deleted';
		case 'renamed': return 'renamed';
		case 'copied': return 'copied';
		case 'modified': return 'modified';
		default: return 'changed';
	}
}

export interface IParsedGitStatus {
	readonly branch?: string;
	readonly head?: string;
	readonly upstream?: string;
	readonly ahead: number;
	readonly behind: number;
	readonly files: IVoltGitStatusFile[];
}

/** `git status --porcelain=v2 --branch -z`: branch, upstream, ahead/behind and the changed files (no line counts). */
export function parseGitStatusV2(text: string): IParsedGitStatus {
	const entries = text.split('\0');
	let branch: string | undefined;
	let head: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	const files: IVoltGitStatusFile[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) {
			continue;
		}
		if (entry.startsWith('# branch.oid ')) {
			const oid = entry.slice('# branch.oid '.length);
			head = /^[0-9a-f]{7,64}$/.test(oid) ? oid : undefined;
		} else if (entry.startsWith('# branch.head ')) {
			const head = entry.slice('# branch.head '.length);
			branch = head === '(detached)' ? undefined : head;
		} else if (entry.startsWith('# branch.upstream ')) {
			upstream = entry.slice('# branch.upstream '.length);
		} else if (entry.startsWith('# branch.ab ')) {
			const match = /^\+(\d+) -(\d+)$/.exec(entry.slice('# branch.ab '.length));
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
		} else if (entry.startsWith('1 ')) {
			// 1 XY sub mH mI mW hH hI path
			const parts = entry.split(' ');
			files.push({ path: parts.slice(8).join(' '), status: statusFromXY(parts[1]), additions: 0, deletions: 0 });
		} else if (entry.startsWith('2 ')) {
			// 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next entry
			const parts = entry.split(' ');
			const previousPath = entries[++i];
			files.push({ path: parts.slice(9).join(' '), ...(previousPath ? { previousPath } : {}), status: 'renamed', additions: 0, deletions: 0 });
		} else if (entry.startsWith('u ')) {
			const parts = entry.split(' ');
			files.push({ path: parts.slice(10).join(' '), status: 'conflicted', additions: 0, deletions: 0 });
		} else if (entry.startsWith('? ')) {
			files.push({ path: entry.slice(2), status: 'untracked', additions: 0, deletions: 0 });
		}
	}
	return { ...(branch ? { branch } : {}), ...(head ? { head } : {}), ...(upstream ? { upstream } : {}), ahead, behind, files };
}

function statusFromXY(xy: string): VoltGitFileStatus {
	if (xy.includes('D')) {
		return 'deleted';
	}
	if (xy.includes('A')) {
		return 'added';
	}
	return 'modified';
}

/** `git diff --numstat -z`: added and deleted lines by path (binary files count 0). */
export function parseNumstat(text: string): Map<string, { additions: number; deletions: number }> {
	const stats = new Map<string, { additions: number; deletions: number }>();
	const entries = text.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry);
		if (!match) {
			continue;
		}
		let path = match[3];
		if (!path) {
			// A rename: the old and new paths follow as their own entries.
			i++;
			path = entries[++i] ?? '';
		}
		stats.set(path, { additions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]) });
	}
	return stats;
}

//#endregion
