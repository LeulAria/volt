/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pullRequestWebUrl } from '../voltPrHosts.js';
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
	VoltPrMergeable,
	VoltPrMergeState,
	VoltPrState,
} from '../voltPullRequests.js';
import { ALL_MERGE_OPTIONS, latestByName, list, num, str, time, user } from './hostParse.js';

/** Azure DevOps Repos (`{org}/{project}/_apis/git`): pull requests, statuses and threads in Volt's shapes. */

/** An identity (`createdBy`, a reviewer, a comment's author). */
export interface IAzureIdentityJson {
	readonly id?: unknown;
	readonly displayName?: unknown;
	readonly uniqueName?: unknown;
	readonly imageUrl?: unknown;
}

interface IAzureReviewerJson extends IAzureIdentityJson {
	readonly vote?: unknown;
	readonly isRequired?: unknown;
}

interface IAzureCommitRefJson {
	readonly commitId?: unknown;
}

interface IAzureLabelJson {
	readonly name?: unknown;
	readonly active?: unknown;
}

export interface IAzurePullRequestJson {
	readonly pullRequestId?: unknown;
	readonly status?: unknown;
	readonly isDraft?: unknown;
	readonly title?: unknown;
	readonly description?: unknown;
	readonly createdBy?: IAzureIdentityJson;
	readonly reviewers?: unknown;
	readonly labels?: unknown;
	readonly creationDate?: unknown;
	readonly closedDate?: unknown;
	readonly mergeStatus?: unknown;
	readonly sourceRefName?: unknown;
	readonly targetRefName?: unknown;
	readonly lastMergeSourceCommit?: IAzureCommitRefJson;
	readonly lastMergeTargetCommit?: IAzureCommitRefJson;
	readonly forkSource?: unknown;
	readonly autoCompleteSetBy?: unknown;
	readonly completionOptions?: { readonly deleteSourceBranch?: unknown };
	readonly repository?: { readonly webUrl?: unknown };
}

interface IAzureStatusContextJson {
	readonly genre?: unknown;
	readonly name?: unknown;
}

export interface IAzureStatusJson {
	readonly context?: IAzureStatusContextJson;
	readonly state?: unknown;
	readonly targetUrl?: unknown;
	readonly description?: unknown;
	readonly creationDate?: unknown;
	readonly updatedDate?: unknown;
}

export interface IAzureChangeEntryJson {
	readonly changeType?: unknown;
	readonly originalPath?: unknown;
	readonly sourceServerItem?: unknown;
	readonly item?: {
		readonly path?: unknown;
		readonly objectId?: unknown;
		readonly isFolder?: unknown;
		readonly gitObjectType?: unknown;
	};
}

interface IAzureCommentJson {
	readonly id?: unknown;
	readonly author?: IAzureIdentityJson;
	readonly content?: unknown;
	readonly commentType?: unknown;
	readonly isDeleted?: unknown;
	readonly publishedDate?: unknown;
	readonly lastUpdatedDate?: unknown;
}

interface IAzureFilePositionJson {
	readonly line?: unknown;
}

export interface IAzureThreadJson {
	readonly id?: unknown;
	readonly status?: unknown;
	readonly isDeleted?: unknown;
	readonly comments?: unknown;
	readonly threadContext?: {
		readonly filePath?: unknown;
		readonly rightFileStart?: IAzureFilePositionJson;
		readonly leftFileStart?: IAzureFilePositionJson;
	};
}

export interface IAzureCommitJson {
	readonly commitId?: unknown;
	readonly comment?: unknown;
	readonly author?: { readonly name?: unknown; readonly date?: unknown };
	readonly committer?: { readonly date?: unknown };
}

/** `refs/heads/feature/x` → `feature/x`. */
export function azureBranch(ref: unknown): string {
	return str(ref).replace(/^refs\/heads\//, '');
}

export function azureState(raw: IAzurePullRequestJson | undefined): VoltPrState {
	switch (raw?.status) {
		case 'completed': return 'merged';
		case 'abandoned': return 'closed';
		default: return raw?.isDraft ? 'draft' : 'open';
	}
}

export function azureCheckState(value: unknown): VoltPrCheckState {
	switch (value) {
		case 'succeeded': return 'success';
		case 'failed':
		case 'error': return 'failure';
		case 'notApplicable': return 'skipped';
		default: return 'pending';
	}
}

/** `GET .../pullrequests/{id}/statuses` (`value`): newest per context. */
export function parseAzureChecks(statuses: readonly IAzureStatusJson[]): IVoltPrCheck[] {
	return latestByName(statuses.map(status => {
		const context: IAzureStatusContextJson = status.context ?? {};
		const name = [context.genre, context.name].filter((part: unknown) => typeof part === 'string' && part).join('/') || 'status';
		return {
			name,
			state: azureCheckState(status.state),
			...(typeof status.targetUrl === 'string' && status.targetUrl ? { url: status.targetUrl } : {}),
			...(time(status.creationDate) !== undefined ? { startedAt: time(status.creationDate) } : {}),
			...(status.state !== 'pending' && time(status.updatedDate) !== undefined ? { completedAt: time(status.updatedDate) } : {}),
			...(typeof status.description === 'string' && status.description ? { summary: status.description } : {}),
			at: time(status.updatedDate) ?? time(status.creationDate) ?? 0,
		};
	}));
}

/** A reviewer's vote: 10 approved, 5 approved with suggestions, -5 waiting for the author, -10 rejected. */
function voteState(vote: number): IVoltPrReviewSummary['state'] | undefined {
	if (vote >= 5) {
		return 'approved';
	}
	if (vote <= -5) {
		return 'changesRequested';
	}
	return undefined;
}

export function azureLogin(raw: IAzureIdentityJson | undefined): string {
	return str(raw?.displayName || raw?.uniqueName, 'ghost');
}

export interface IAzureExtras {
	readonly checks?: readonly IVoltPrCheck[];
	readonly webUrl?: string;
}

export function parseAzurePull(raw: IAzurePullRequestJson, repo: IVoltPrRepoRef, viewer: string, extras: IAzureExtras = {}): IVoltPullRequest {
	const number = num(raw.pullRequestId);
	const state = azureState(raw);
	const open = state === 'open' || state === 'draft';
	const reviewers = list<IAzureReviewerJson>(raw.reviewers);
	const reviews: IVoltPrReviewSummary[] = [];
	for (const reviewer of reviewers) {
		const verdict = voteState(num(reviewer.vote) || (typeof reviewer.vote === 'number' ? reviewer.vote : 0));
		if (verdict) {
			reviews.push({ author: azureLogin(reviewer), state: verdict, at: time(raw.creationDate) ?? 0 });
		}
	}
	const reviewDecision = reviews.some(review => review.state === 'changesRequested') ? 'changesRequested' as const
		: reviewers.some(reviewer => reviewer.isRequired && !voteState(typeof reviewer.vote === 'number' ? reviewer.vote : 0)) ? 'reviewRequired' as const
			: reviews.some(review => review.state === 'approved') ? 'approved' as const : undefined;
	const mergeStatus = str(raw.mergeStatus);
	const mergeable: VoltPrMergeable = !open ? 'unknown' : mergeStatus === 'conflicts' ? 'conflicting' : mergeStatus === 'succeeded' ? 'mergeable' : 'unknown';
	const mergeState: VoltPrMergeState = !open ? 'unknown' : state === 'draft' ? 'draft' : mergeable === 'conflicting' ? 'dirty' : mergeStatus === 'rejectedByPolicy' ? 'blocked' : mergeable === 'mergeable' ? 'clean' : 'unknown';
	const repoUrl = str(raw.repository?.webUrl);
	const url = extras.webUrl ? pullRequestWebUrl('azure', extras.webUrl, repo, number) : repoUrl ? `${repoUrl}/pullrequest/${number}` : '';
	return {
		key: prKey(repo, number),
		repo: { host: repo.host, owner: repo.owner, name: repo.name },
		number,
		id: String(number),
		title: str(raw.title),
		url,
		state,
		author: user(azureLogin(raw.createdBy), raw.createdBy?.imageUrl),
		headRefName: azureBranch(raw.sourceRefName),
		headRefOid: str(raw.lastMergeSourceCommit?.commitId),
		baseRefName: azureBranch(raw.targetRefName),
		crossRepository: !!raw.forkSource,
		createdAt: time(raw.creationDate) ?? 0,
		updatedAt: time(raw.closedDate) ?? time(raw.creationDate) ?? 0,
		...(state === 'merged' && time(raw.closedDate) !== undefined ? { mergedAt: time(raw.closedDate) } : {}),
		...(state === 'closed' && time(raw.closedDate) !== undefined ? { closedAt: time(raw.closedDate) } : {}),
		additions: 0,
		deletions: 0,
		changedFiles: 0,
		mergeable,
		mergeState,
		...(reviewDecision ? { reviewDecision } : {}),
		checks: summarizeChecks(extras.checks ?? []),
		labels: list<IAzureLabelJson>(raw.labels).filter(label => label.active !== false).map(label => ({ name: str(label.name), color: '888888' })).filter(label => label.name),
		assignees: [],
		reviewRequests: reviewers.filter(reviewer => !voteState(typeof reviewer.vote === 'number' ? reviewer.vote : 0)).map(azureLogin),
		reviews,
		unresolvedThreads: 0,
		comments: 0,
		autoMerge: !!raw.autoCompleteSetBy,
		viewer,
	};
}

export function azureFileChange(value: unknown): VoltPrFileChange {
	const text = str(value).toLowerCase();
	if (text.includes('rename')) {
		return 'renamed';
	}
	if (text.includes('delete')) {
		return 'deleted';
	}
	if (text.includes('add')) {
		return 'added';
	}
	return text.includes('edit') ? 'modified' : 'changed';
}

/** `GET .../iterations/{n}/changes` (`changeEntries`): files only, no line counts (Azure has none). */
export function parseAzureChanges(entries: readonly IAzureChangeEntryJson[]): IVoltPrFile[] {
	return entries
		.filter(entry => !entry.item?.isFolder && entry.item?.gitObjectType !== 'tree')
		.map(entry => {
			const change = azureFileChange(entry.changeType);
			const path = str(entry.item?.path ?? entry.originalPath).replace(/^\//, '');
			const previous = str(entry.originalPath ?? entry.sourceServerItem).replace(/^\//, '');
			return {
				path,
				...(change === 'renamed' && previous && previous !== path ? { previousPath: previous } : {}),
				change,
				additions: 0,
				deletions: 0,
				viewed: 'unviewed' as const,
			};
		})
		.filter(file => file.path);
}

function parseAzureComment(raw: IAzureCommentJson, url: string): IVoltPrComment {
	return {
		id: String(raw.id ?? ''),
		...(typeof raw.id === 'number' ? { databaseId: raw.id } : {}),
		author: user(azureLogin(raw.author), raw.author?.imageUrl),
		body: str(raw.content),
		createdAt: time(raw.publishedDate) ?? time(raw.lastUpdatedDate) ?? 0,
		url,
	};
}

/** Threads with a file context are review threads; others are conversation. System threads (votes, pushes) are left out. */
export function parseAzureThreads(threads: readonly IAzureThreadJson[], prUrl: string): { threads: IVoltPrReviewThread[]; conversation: IVoltPrComment[] } {
	const out: IVoltPrReviewThread[] = [];
	const conversation: IVoltPrComment[] = [];
	for (const thread of threads) {
		if (thread.isDeleted) {
			continue;
		}
		const comments = list<IAzureCommentJson>(thread.comments).filter(comment => comment.commentType !== 'system' && !comment.isDeleted).map(comment => parseAzureComment(comment, `${prUrl}?discussionId=${thread.id}`));
		if (!comments.length) {
			continue;
		}
		const context = thread.threadContext;
		if (context?.filePath) {
			const right = num(context.rightFileStart?.line);
			const left = num(context.leftFileStart?.line);
			out.push({
				id: String(thread.id),
				path: str(context.filePath).replace(/^\//, ''),
				...(right || left ? { line: right || left } : {}),
				side: right ? 'RIGHT' : 'LEFT',
				resolved: thread.status !== 'active' && thread.status !== 'pending' && thread.status !== undefined,
				outdated: false,
				canResolve: true,
				comments,
			});
		} else {
			conversation.push(...comments);
		}
	}
	return { threads: out, conversation: conversation.sort((a, b) => a.createdAt - b.createdAt) };
}

export function parseAzureCommit(raw: IAzureCommitJson): IVoltPrCommit {
	return {
		oid: str(raw.commitId),
		headline: str(raw.comment).split('\n')[0],
		author: str(raw.author?.name, 'unknown'),
		at: time(raw.author?.date) ?? time(raw.committer?.date) ?? 0,
		checks: 'none',
	};
}

export interface IAzureDetailParts {
	readonly pull: IAzurePullRequestJson;
	readonly checks: readonly IVoltPrCheck[];
	readonly changes: readonly IAzureChangeEntryJson[];
	readonly threads: readonly IAzureThreadJson[];
	readonly commits: readonly IAzureCommitJson[];
	readonly webUrl?: string;
}

export function parseAzureDetail(parts: IAzureDetailParts, repo: IVoltPrRepoRef, viewer: string): IVoltPullRequestDetail {
	const summary = parseAzurePull(parts.pull, repo, viewer, { checks: parts.checks, ...(parts.webUrl ? { webUrl: parts.webUrl } : {}) });
	const files = parseAzureChanges(parts.changes);
	const { threads, conversation } = parseAzureThreads(parts.threads, summary.url);
	const reviewList: IVoltPrReview[] = summary.reviews.map(review => ({ id: `vote:${review.author}`, author: user(review.author), state: review.state, body: '', at: review.at, url: summary.url }));
	return {
		...summary,
		changedFiles: files.length,
		unresolvedThreads: threads.filter(thread => !thread.resolved).length,
		comments: conversation.length + threads.reduce((sum, thread) => sum + thread.comments.length, 0),
		body: str(parts.pull.description),
		baseRefOid: str(parts.pull.lastMergeTargetCommit?.commitId),
		files,
		threads,
		reviewList,
		conversation,
		commits: parts.commits.map(parseAzureCommit).reverse(),
		checkRuns: [...parts.checks],
		mergeOptions: { ...ALL_MERGE_OPTIONS, deleteBranchOnMerge: !!parts.pull.completionOptions?.deleteSourceBranch },
		viewerCanMerge: true,
		viewerCanUpdate: true,
		repoLabels: [],
	};
}
