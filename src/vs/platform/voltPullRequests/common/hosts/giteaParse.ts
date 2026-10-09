/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { prKey, summarizeChecks } from '../voltPullRequestParse.js';
import {
	IVoltPrCheck,
	IVoltPrComment,
	IVoltPrCommit,
	IVoltPrFile,
	IVoltPrLabel,
	IVoltPrMergeOptions,
	IVoltPrRepoRef,
	IVoltPrReview,
	IVoltPrReviewSummary,
	IVoltPrReviewThread,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	VoltPrCheckState,
	VoltPrFileChange,
	VoltPrMergeable,
	VoltPrMergeState,
	VoltPrReviewState,
	VoltPrState,
} from '../voltPullRequests.js';
import { draftTitle, Json, latestByName, list, num, str, time, user } from './hostParse.js';

/** Gitea and Forgejo (`/api/v1`): their pull request JSON in Volt's shapes. */

export function giteaState(raw: Json): VoltPrState {
	if (raw?.merged || raw?.merged_at && time(raw.merged_at)) {
		return 'merged';
	}
	if (raw?.state === 'closed') {
		return 'closed';
	}
	return raw?.draft === true || draftTitle(str(raw?.title)) ? 'draft' : 'open';
}

export function giteaCheckState(value: unknown): VoltPrCheckState {
	switch (value) {
		case 'success': return 'success';
		case 'failure':
		case 'error': return 'failure';
		case 'warning': return 'neutral';
		case 'skipped': return 'skipped';
		default: return 'pending';
	}
}

/** `GET /repos/{o}/{r}/commits/{sha}/status`: the combined status of the head commit (Gitea Actions report there too). */
export function parseGiteaChecks(combined: Json): IVoltPrCheck[] {
	return latestByName(list(combined?.statuses).map(status => ({
		name: str(status.context, 'status'),
		state: giteaCheckState(status.status),
		...(typeof status.target_url === 'string' && status.target_url ? { url: status.target_url } : {}),
		...(time(status.created_at) !== undefined ? { startedAt: time(status.created_at) } : {}),
		...(status.status !== 'pending' && time(status.updated_at) !== undefined ? { completedAt: time(status.updated_at) } : {}),
		...(typeof status.description === 'string' && status.description ? { summary: status.description } : {}),
		at: time(status.updated_at) ?? time(status.created_at) ?? 0,
	})));
}

function labels(raw: Json): IVoltPrLabel[] {
	return list(raw).map(label => ({ name: str(label.name), color: str(label.color, '888888').replace(/^#/, '') })).filter(label => label.name);
}

export function giteaReviewState(value: unknown): VoltPrReviewState {
	switch (value) {
		case 'APPROVED': return 'approved';
		case 'REQUEST_CHANGES': return 'changesRequested';
		case 'PENDING': return 'pending';
		default: return 'commented';
	}
}

export interface IGiteaExtras {
	readonly checks?: readonly IVoltPrCheck[];
	readonly reviews?: readonly Json[];
}

export function parseGiteaPull(raw: Json, repo: IVoltPrRepoRef, viewer: string, extras: IGiteaExtras = {}): IVoltPullRequest {
	const number = num(raw.number);
	const state = giteaState(raw);
	const open = state === 'open' || state === 'draft';
	const mergeable: VoltPrMergeable = !open ? 'unknown' : raw.mergeable === true ? 'mergeable' : raw.mergeable === false ? 'conflicting' : 'unknown';
	const checks = summarizeChecks(extras.checks ?? []);
	const mergeState: VoltPrMergeState = !open ? 'unknown' : state === 'draft' ? 'draft' : mergeable === 'conflicting' ? 'dirty' : checks.state === 'failure' ? 'unstable' : mergeable === 'mergeable' ? 'clean' : 'unknown';
	const latest = new Map<string, IVoltPrReviewSummary>();
	for (const review of extras.reviews ?? []) {
		const author = str(review.user?.login, 'ghost');
		const reviewState = giteaReviewState(review.state);
		if (reviewState === 'pending' || review.dismissed) {
			continue;
		}
		const at = time(review.submitted_at) ?? 0;
		const seen = latest.get(author);
		if (!seen || at >= seen.at) {
			latest.set(author, { author, state: reviewState, at });
		}
	}
	const reviews = [...latest.values()];
	const reviewDecision = reviews.some(review => review.state === 'changesRequested') ? 'changesRequested' as const
		: reviews.some(review => review.state === 'approved') ? 'approved' as const : undefined;
	const headOwner = raw.head?.repo?.owner?.login;
	const baseRepoId = raw.base?.repo_id ?? raw.base?.repo?.id;
	const headRepoId = raw.head?.repo_id ?? raw.head?.repo?.id;
	return {
		key: prKey(repo, number),
		repo: { host: repo.host, owner: repo.owner, name: repo.name },
		number,
		id: String(raw.id ?? number),
		title: str(raw.title),
		url: str(raw.html_url),
		state,
		author: user(raw.user?.login, raw.user?.avatar_url),
		headRefName: str(raw.head?.ref),
		headRefOid: str(raw.head?.sha),
		baseRefName: str(raw.base?.ref),
		...(typeof headOwner === 'string' ? { headOwner } : {}),
		crossRepository: baseRepoId !== undefined && headRepoId !== undefined && baseRepoId !== headRepoId,
		createdAt: time(raw.created_at) ?? 0,
		updatedAt: time(raw.updated_at) ?? 0,
		...(state === 'merged' && time(raw.merged_at) !== undefined ? { mergedAt: time(raw.merged_at) } : {}),
		...(state !== 'open' && state !== 'draft' && time(raw.closed_at) !== undefined ? { closedAt: time(raw.closed_at) } : {}),
		additions: num(raw.additions),
		deletions: num(raw.deletions),
		changedFiles: num(raw.changed_files),
		mergeable,
		mergeState,
		...(reviewDecision ? { reviewDecision } : list(raw.requested_reviewers).length ? { reviewDecision: 'reviewRequired' as const } : {}),
		checks,
		labels: labels(raw.labels),
		assignees: list(raw.assignees).map(assignee => str(assignee.login)).filter(Boolean),
		reviewRequests: list(raw.requested_reviewers).map(reviewer => str(reviewer.login)).filter(Boolean),
		reviews,
		unresolvedThreads: 0,
		comments: num(raw.comments) + num(raw.review_comments),
		autoMerge: false,
		viewer,
	};
}

export function giteaFileChange(value: unknown): VoltPrFileChange {
	switch (value) {
		case 'added': return 'added';
		case 'deleted':
		case 'removed': return 'deleted';
		case 'renamed': return 'renamed';
		case 'copied': return 'copied';
		case 'modified': return 'modified';
		default: return 'changed';
	}
}

export function parseGiteaFile(raw: Json): IVoltPrFile {
	return {
		path: str(raw.filename),
		...(typeof raw.previous_filename === 'string' && raw.previous_filename && raw.previous_filename !== raw.filename ? { previousPath: raw.previous_filename } : {}),
		change: giteaFileChange(raw.status),
		additions: num(raw.additions),
		deletions: num(raw.deletions),
		viewed: 'unviewed',
	};
}

export function parseGiteaComment(raw: Json): IVoltPrComment {
	return {
		id: String(raw.id ?? ''),
		...(typeof raw.id === 'number' ? { databaseId: raw.id } : {}),
		author: user(raw.user?.login, raw.user?.avatar_url),
		body: str(raw.body),
		createdAt: time(raw.created_at) ?? 0,
		url: str(raw.html_url),
		...(typeof raw.diff_hunk === 'string' && raw.diff_hunk ? { diffHunk: raw.diff_hunk } : {}),
	};
}

/** Review comments of one review as threads: each comment opens one (Gitea has no thread ids in its API). */
export function parseGiteaReviewComments(comments: readonly Json[]): IVoltPrReviewThread[] {
	const threads = new Map<string, { path: string; line?: number; side: 'LEFT' | 'RIGHT'; resolved: boolean; outdated: boolean; comments: IVoltPrComment[] }>();
	for (const raw of comments) {
		const newLine = num(raw.position);
		const oldLine = num(raw.original_position);
		const side = newLine > 0 ? 'RIGHT' as const : 'LEFT' as const;
		const line = newLine > 0 ? newLine : oldLine > 0 ? oldLine : undefined;
		const key = `${str(raw.path)}\u0000${side}\u0000${line ?? ''}`;
		let thread = threads.get(key);
		if (!thread) {
			thread = { path: str(raw.path), ...(line !== undefined ? { line } : {}), side, resolved: !!raw.resolver, outdated: raw.commit_id && raw.original_commit_id ? raw.commit_id !== raw.original_commit_id && !newLine : false, comments: [] };
			threads.set(key, thread);
		}
		thread.comments.push(parseGiteaComment(raw));
	}
	return [...threads.entries()].map(([key, thread]) => ({
		id: `gitea-thread:${key}`,
		path: thread.path,
		...(thread.line !== undefined ? { line: thread.line } : {}),
		side: thread.side,
		resolved: thread.resolved,
		outdated: thread.outdated,
		canResolve: false,
		comments: thread.comments.sort((a, b) => a.createdAt - b.createdAt),
	}));
}

export function parseGiteaReview(raw: Json): IVoltPrReview {
	return {
		id: String(raw.id ?? ''),
		author: user(raw.user?.login, raw.user?.avatar_url),
		state: raw.dismissed ? 'dismissed' : giteaReviewState(raw.state),
		body: str(raw.body),
		at: time(raw.submitted_at) ?? 0,
		url: str(raw.html_url),
	};
}

export function parseGiteaCommit(raw: Json): IVoltPrCommit {
	return {
		oid: str(raw.sha),
		headline: str(raw.commit?.message).split('\n')[0],
		author: str(raw.author?.login ?? raw.commit?.author?.name, 'unknown'),
		at: time(raw.commit?.committer?.date) ?? time(raw.commit?.author?.date) ?? time(raw.created) ?? 0,
		checks: 'none',
	};
}

export function giteaMergeOptions(repoRaw: Json): IVoltPrMergeOptions {
	return {
		merge: repoRaw?.allow_merge_commits !== false,
		squash: repoRaw?.allow_squash_merge !== false,
		rebase: repoRaw?.allow_rebase !== false,
		deleteBranchOnMerge: !!repoRaw?.default_delete_branch_after_merge,
		autoMergeAllowed: false,
	};
}

export interface IGiteaDetailParts {
	readonly pull: Json;
	readonly repo: Json;
	readonly checks: readonly IVoltPrCheck[];
	readonly files: readonly Json[];
	readonly comments: readonly Json[];
	readonly reviews: readonly Json[];
	/** Every review's line comments, flattened. */
	readonly reviewComments: readonly Json[];
	readonly commits: readonly Json[];
	readonly labels: readonly Json[];
}

export function parseGiteaDetail(parts: IGiteaDetailParts, repo: IVoltPrRepoRef, viewer: string): IVoltPullRequestDetail {
	const summary = parseGiteaPull(parts.pull, repo, viewer, { checks: parts.checks, reviews: parts.reviews });
	const threads = parseGiteaReviewComments(parts.reviewComments);
	const permissions = parts.repo?.permissions;
	const canWrite = !!(permissions?.admin || permissions?.push);
	return {
		...summary,
		unresolvedThreads: threads.filter(thread => !thread.resolved).length,
		comments: parts.comments.length + parts.reviewComments.length,
		body: str(parts.pull.body),
		baseRefOid: str(parts.pull.merge_base ?? parts.pull.base?.sha),
		files: parts.files.map(parseGiteaFile),
		threads,
		reviewList: parts.reviews.filter(review => review.state !== 'PENDING' || review.user?.login === viewer).map(parseGiteaReview),
		conversation: parts.comments.map(parseGiteaComment),
		commits: parts.commits.map(parseGiteaCommit),
		checkRuns: [...parts.checks],
		mergeOptions: giteaMergeOptions(parts.repo),
		viewerCanMerge: canWrite,
		viewerCanUpdate: canWrite || str(parts.pull.user?.login) === viewer,
		repoLabels: labels(parts.labels),
	};
}
