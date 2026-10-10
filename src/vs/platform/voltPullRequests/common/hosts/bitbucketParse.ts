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
	IVoltPrRepoRef,
	IVoltPrReview,
	IVoltPrReviewSummary,
	IVoltPrReviewThread,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	VoltPrCheckState,
	VoltPrFileChange,
	VoltPrState,
} from '../voltPullRequests.js';
import { ALL_MERGE_OPTIONS, latestByName, list, num, str, time, user } from './hostParse.js';

/** Bitbucket Cloud (`/2.0`): pull requests, build statuses and comments in Volt's shapes. */

interface IBitbucketLinkJson {
	readonly href?: unknown;
}

export interface IBitbucketUserJson {
	readonly nickname?: unknown;
	readonly username?: unknown;
	readonly display_name?: unknown;
	readonly links?: { readonly avatar?: IBitbucketLinkJson };
}

export interface IBitbucketStatusJson {
	readonly key?: unknown;
	readonly name?: unknown;
	readonly state?: unknown;
	readonly url?: unknown;
	readonly description?: unknown;
	readonly created_on?: unknown;
	readonly updated_on?: unknown;
}

interface IBitbucketParticipantJson {
	readonly user?: IBitbucketUserJson;
	readonly approved?: unknown;
	readonly state?: unknown;
	readonly participated_on?: unknown;
}

/** A pull request's `source` or `destination`. */
interface IBitbucketEndpointJson {
	readonly branch?: { readonly name?: unknown };
	readonly commit?: { readonly hash?: unknown };
	readonly repository?: { readonly full_name?: unknown };
}

export interface IBitbucketPullRequestJson {
	readonly id?: unknown;
	readonly state?: unknown;
	readonly draft?: unknown;
	readonly title?: unknown;
	readonly description?: unknown;
	readonly summary?: { readonly raw?: unknown };
	readonly author?: IBitbucketUserJson;
	readonly participants?: unknown;
	readonly reviewers?: unknown;
	readonly source?: IBitbucketEndpointJson;
	readonly destination?: IBitbucketEndpointJson;
	readonly links?: { readonly html?: IBitbucketLinkJson };
	readonly created_on?: unknown;
	readonly updated_on?: unknown;
	readonly comment_count?: unknown;
	readonly close_source_branch?: unknown;
}

export interface IBitbucketDiffstatJson {
	readonly status?: unknown;
	readonly old?: { readonly path?: unknown };
	readonly new?: { readonly path?: unknown };
	readonly lines_added?: unknown;
	readonly lines_removed?: unknown;
}

export interface IBitbucketCommentJson {
	readonly id?: unknown;
	readonly deleted?: unknown;
	readonly parent?: { readonly id?: unknown };
	readonly user?: IBitbucketUserJson;
	readonly content?: { readonly raw?: unknown };
	readonly created_on?: unknown;
	readonly links?: { readonly html?: IBitbucketLinkJson };
	readonly inline?: {
		readonly path?: unknown;
		readonly from?: unknown;
		readonly to?: unknown;
		readonly outdated?: unknown;
	};
	readonly resolution?: unknown;
}

export interface IBitbucketCommitJson {
	readonly hash?: unknown;
	readonly message?: unknown;
	readonly date?: unknown;
	readonly author?: { readonly user?: IBitbucketUserJson; readonly raw?: unknown };
}

export function bitbucketState(raw: IBitbucketPullRequestJson | undefined): VoltPrState {
	switch (raw?.state) {
		case 'MERGED': return 'merged';
		case 'DECLINED':
		case 'SUPERSEDED': return 'closed';
		default: return raw?.draft ? 'draft' : 'open';
	}
}

export function bitbucketCheckState(value: unknown): VoltPrCheckState {
	switch (value) {
		case 'SUCCESSFUL': return 'success';
		case 'FAILED': return 'failure';
		case 'STOPPED': return 'cancelled';
		default: return 'pending';
	}
}

/** `GET .../pullrequests/{id}/statuses` (`values`). */
export function parseBitbucketChecks(statuses: readonly IBitbucketStatusJson[]): IVoltPrCheck[] {
	return latestByName(statuses.map(status => ({
		name: str(status.name || status.key, 'build'),
		state: bitbucketCheckState(status.state),
		...(typeof status.url === 'string' && status.url ? { url: status.url } : {}),
		...(time(status.created_on) !== undefined ? { startedAt: time(status.created_on) } : {}),
		...(status.state !== 'INPROGRESS' && time(status.updated_on) !== undefined ? { completedAt: time(status.updated_on) } : {}),
		...(typeof status.description === 'string' && status.description ? { summary: status.description } : {}),
		at: time(status.updated_on) ?? time(status.created_on) ?? 0,
	})));
}

/** Bitbucket users are named by nickname (display name for older accounts). */
export function bitbucketLogin(raw: IBitbucketUserJson | undefined): string {
	return str(raw?.nickname || raw?.username || raw?.display_name, 'ghost');
}

export interface IBitbucketExtras {
	readonly checks?: readonly IVoltPrCheck[];
}

export function parseBitbucketPull(raw: IBitbucketPullRequestJson, repo: IVoltPrRepoRef, viewer: string, extras: IBitbucketExtras = {}): IVoltPullRequest {
	const number = num(raw.id);
	const state = bitbucketState(raw);
	const participants = list<IBitbucketParticipantJson>(raw.participants);
	const reviews: IVoltPrReviewSummary[] = participants
		.filter(participant => participant.approved || participant.state === 'changes_requested')
		.map(participant => ({ author: bitbucketLogin(participant.user), state: participant.state === 'changes_requested' ? 'changesRequested' as const : 'approved' as const, at: time(participant.participated_on) ?? 0 }));
	const reviewDecision = reviews.some(review => review.state === 'changesRequested') ? 'changesRequested' as const
		: reviews.some(review => review.state === 'approved') ? 'approved' as const
			: list(raw.reviewers).length ? 'reviewRequired' as const : undefined;
	const sourceRepo = str(raw.source?.repository?.full_name);
	const destRepo = str(raw.destination?.repository?.full_name);
	const open = state === 'open' || state === 'draft';
	return {
		key: prKey(repo, number),
		repo: { host: repo.host, owner: repo.owner, name: repo.name },
		number,
		id: String(number),
		title: str(raw.title),
		url: str(raw.links?.html?.href),
		state,
		author: user(bitbucketLogin(raw.author), raw.author?.links?.avatar?.href),
		headRefName: str(raw.source?.branch?.name),
		headRefOid: str(raw.source?.commit?.hash),
		baseRefName: str(raw.destination?.branch?.name),
		...(sourceRepo.includes('/') ? { headOwner: sourceRepo.split('/')[0] } : {}),
		crossRepository: !!sourceRepo && !!destRepo && sourceRepo.toLowerCase() !== destRepo.toLowerCase(),
		createdAt: time(raw.created_on) ?? 0,
		updatedAt: time(raw.updated_on) ?? 0,
		...(state === 'merged' ? { mergedAt: time(raw.updated_on) ?? 0 } : {}),
		...(state === 'closed' ? { closedAt: time(raw.updated_on) ?? 0 } : {}),
		additions: 0,
		deletions: 0,
		changedFiles: 0,
		// Bitbucket computes conflicts only when merging: a pull request says nothing about them.
		mergeable: 'unknown',
		mergeState: !open ? 'unknown' : state === 'draft' ? 'draft' : 'clean',
		...(reviewDecision ? { reviewDecision } : {}),
		checks: summarizeChecks(extras.checks ?? []),
		labels: [],
		assignees: [],
		reviewRequests: list<IBitbucketUserJson>(raw.reviewers).map(bitbucketLogin).filter(name => !reviews.some(review => review.author === name)),
		reviews,
		unresolvedThreads: 0,
		comments: num(raw.comment_count),
		autoMerge: false,
		viewer,
	};
}

export function bitbucketFileChange(value: unknown): VoltPrFileChange {
	switch (value) {
		case 'added': return 'added';
		case 'removed': return 'deleted';
		case 'renamed': return 'renamed';
		case 'modified': return 'modified';
		default: return 'changed';
	}
}

/** `GET .../diffstat` entries. */
export function parseBitbucketDiffstat(raw: IBitbucketDiffstatJson): IVoltPrFile {
	const change = bitbucketFileChange(raw.status);
	const path = str(change === 'deleted' ? raw.old?.path : raw.new?.path ?? raw.old?.path);
	const previous = str(raw.old?.path);
	return {
		path,
		...(change === 'renamed' && previous && previous !== path ? { previousPath: previous } : {}),
		change,
		additions: num(raw.lines_added),
		deletions: num(raw.lines_removed),
		viewed: 'unviewed',
	};
}

export function parseBitbucketComment(raw: IBitbucketCommentJson): IVoltPrComment {
	return {
		id: String(raw.id ?? ''),
		...(typeof raw.id === 'number' ? { databaseId: raw.id } : {}),
		author: user(bitbucketLogin(raw.user), raw.user?.links?.avatar?.href),
		body: str(raw.content?.raw),
		createdAt: time(raw.created_on) ?? 0,
		url: str(raw.links?.html?.href),
	};
}

/** Inline comments (with their replies) as threads; the rest as conversation. Deleted comments are left out. */
export function parseBitbucketComments(comments: readonly IBitbucketCommentJson[]): { threads: IVoltPrReviewThread[]; conversation: IVoltPrComment[] } {
	const live = comments.filter(comment => !comment.deleted);
	const byId = new Map<number, IBitbucketCommentJson>(live.map(comment => [num(comment.id), comment]));
	const rootOf = (comment: IBitbucketCommentJson): IBitbucketCommentJson => {
		let current = comment;
		for (let depth = 0; current?.parent?.id && depth < 50; depth++) {
			const parent = byId.get(num(current.parent.id));
			if (!parent) {
				break;
			}
			current = parent;
		}
		return current;
	};
	const threads = new Map<number, { root: IBitbucketCommentJson; comments: IVoltPrComment[] }>();
	const conversation: IVoltPrComment[] = [];
	for (const comment of live) {
		const root = rootOf(comment);
		if (root.inline?.path) {
			const id = num(root.id);
			const thread = threads.get(id) ?? { root, comments: [] };
			thread.comments.push(parseBitbucketComment(comment));
			threads.set(id, thread);
		} else {
			conversation.push(parseBitbucketComment(comment));
		}
	}
	return {
		threads: [...threads.values()].map(({ root, comments: thread }) => {
			const to = num(root.inline?.to);
			const from = num(root.inline?.from);
			return {
				id: String(root.id),
				path: str(root.inline?.path),
				...(to || from ? { line: to || from } : {}),
				side: to ? 'RIGHT' as const : 'LEFT' as const,
				resolved: !!root.resolution,
				outdated: !!root.inline?.outdated,
				canResolve: false,
				comments: thread.sort((a, b) => a.createdAt - b.createdAt),
			};
		}),
		conversation: conversation.sort((a, b) => a.createdAt - b.createdAt),
	};
}

export function parseBitbucketCommit(raw: IBitbucketCommitJson): IVoltPrCommit {
	return {
		oid: str(raw.hash),
		headline: str(raw.message).split('\n')[0],
		author: str(raw.author?.user ? bitbucketLogin(raw.author.user) : raw.author?.raw, 'unknown'),
		at: time(raw.date) ?? 0,
		checks: 'none',
	};
}

export interface IBitbucketDetailParts {
	readonly pull: IBitbucketPullRequestJson;
	readonly checks: readonly IVoltPrCheck[];
	readonly diffstat: readonly IBitbucketDiffstatJson[];
	readonly comments: readonly IBitbucketCommentJson[];
	readonly commits: readonly IBitbucketCommitJson[];
	/** `GET /repositories/{ws}/{slug}/permissions-config` is admin-only; whether the viewer can write is a best guess. */
	readonly canWrite: boolean;
}

export function parseBitbucketDetail(parts: IBitbucketDetailParts, repo: IVoltPrRepoRef, viewer: string): IVoltPullRequestDetail {
	const summary = parseBitbucketPull(parts.pull, repo, viewer, { checks: parts.checks });
	const files = parts.diffstat.map(parseBitbucketDiffstat);
	const { threads, conversation } = parseBitbucketComments(parts.comments);
	const reviewList: IVoltPrReview[] = summary.reviews.map(review => ({ id: `participant:${review.author}`, author: user(review.author), state: review.state, body: '', at: review.at, url: summary.url }));
	return {
		...summary,
		additions: files.reduce((sum, file) => sum + file.additions, 0),
		deletions: files.reduce((sum, file) => sum + file.deletions, 0),
		changedFiles: files.length,
		unresolvedThreads: threads.filter(thread => !thread.resolved).length,
		comments: conversation.length + threads.reduce((sum, thread) => sum + thread.comments.length, 0),
		body: str(parts.pull.description ?? parts.pull.summary?.raw),
		baseRefOid: str(parts.pull.destination?.commit?.hash),
		files,
		threads,
		reviewList,
		conversation,
		commits: parts.commits.map(parseBitbucketCommit).reverse(),
		checkRuns: [...parts.checks],
		mergeOptions: { ...ALL_MERGE_OPTIONS, rebase: true, deleteBranchOnMerge: !!parts.pull.close_source_branch },
		viewerCanMerge: parts.canWrite,
		viewerCanUpdate: parts.canWrite || summary.author.login === viewer,
		repoLabels: [],
	};
}
