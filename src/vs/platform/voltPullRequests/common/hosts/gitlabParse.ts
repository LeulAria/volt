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
	IVoltPrFilePatch,
	IVoltPrLabel,
	IVoltPrRepoRef,
	IVoltPrReview,
	IVoltPrReviewThread,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	VoltPrCheckState,
	VoltPrChecksState,
	VoltPrMergeable,
	VoltPrMergeState,
	VoltPrState,
} from '../voltPullRequests.js';
import { Json, latestByName, list, num, str, time, user } from './hostParse.js';

/** GitLab (`/api/v4`): merge requests, pipelines and discussions in Volt's shapes. */

/** `group/sub/project` as GitLab's URL-encoded project id. */
export function gitlabProjectId(repo: Pick<IVoltPrRepoRef, 'owner' | 'name'>): string {
	return encodeURIComponent(`${repo.owner}/${repo.name}`);
}

export function gitlabState(raw: Json): VoltPrState {
	switch (raw?.state) {
		case 'merged': return 'merged';
		case 'closed':
		case 'locked': return 'closed';
		default: return raw?.draft || raw?.work_in_progress ? 'draft' : 'open';
	}
}

export function gitlabJobState(status: unknown, allowFailure?: boolean): VoltPrCheckState {
	switch (status) {
		case 'success': return 'success';
		case 'failed': return allowFailure ? 'neutral' : 'failure';
		case 'canceled':
		case 'canceling': return 'cancelled';
		case 'skipped': return 'skipped';
		case 'manual': return 'neutral';
		default: return 'pending';
	}
}

/** A pipeline's overall status as the checks summary of a list row (jobs are read for the detail only). */
export function gitlabPipelineChecks(pipeline: Json): VoltPrChecksState {
	switch (pipeline?.status) {
		case undefined:
		case null: return 'none';
		case 'success': return 'success';
		case 'failed': return 'failure';
		case 'canceled':
		case 'skipped':
		case 'manual': return 'success';
		default: return 'pending';
	}
}

/** A pipeline's jobs, plus external commit statuses, as checks. */
export function parseGitlabChecks(jobs: readonly Json[], statuses: readonly Json[] = []): IVoltPrCheck[] {
	const fromJobs = jobs.map(job => ({
		name: str(job.name, 'job'),
		...(typeof job.stage === 'string' && job.stage ? { workflow: job.stage } : {}),
		state: gitlabJobState(job.status, !!job.allow_failure),
		...(typeof job.web_url === 'string' ? { url: job.web_url } : {}),
		...(time(job.started_at) !== undefined ? { startedAt: time(job.started_at) } : {}),
		...(time(job.finished_at) !== undefined ? { completedAt: time(job.finished_at) } : {}),
		...(job.allow_failure ? { required: false } : {}),
		at: time(job.created_at) ?? 0,
	}));
	const fromStatuses = statuses.map(status => ({
		name: str(status.name, 'status'),
		state: gitlabJobState(status.status, !!status.allow_failure),
		...(typeof status.target_url === 'string' && status.target_url ? { url: status.target_url } : {}),
		...(time(status.started_at ?? status.created_at) !== undefined ? { startedAt: time(status.started_at ?? status.created_at) } : {}),
		...(time(status.finished_at) !== undefined ? { completedAt: time(status.finished_at) } : {}),
		...(typeof status.description === 'string' && status.description ? { summary: status.description } : {}),
		at: time(status.created_at) ?? 0,
	}));
	return latestByName([...fromJobs, ...fromStatuses]);
}

function labels(raw: Json, colors?: ReadonlyMap<string, string>): IVoltPrLabel[] {
	return list(raw).map(label => typeof label === 'string'
		? { name: label, color: colors?.get(label) ?? '888888' }
		: { name: str(label.name), color: str(label.color, '#888888').replace(/^#/, '') }).filter(label => label.name);
}

function mergeability(raw: Json, state: VoltPrState): { mergeable: VoltPrMergeable; mergeState: VoltPrMergeState } {
	if (state !== 'open' && state !== 'draft') {
		return { mergeable: 'unknown', mergeState: 'unknown' };
	}
	const detailed = str(raw.detailed_merge_status);
	if (raw.has_conflicts || detailed === 'conflict' || raw.merge_status === 'cannot_be_merged') {
		return { mergeable: 'conflicting', mergeState: 'dirty' };
	}
	if (state === 'draft' || detailed === 'draft_status') {
		return { mergeable: 'mergeable', mergeState: 'draft' };
	}
	switch (detailed) {
		case 'mergeable': return { mergeable: 'mergeable', mergeState: 'clean' };
		case 'need_rebase': return { mergeable: 'mergeable', mergeState: 'behind' };
		case 'ci_must_pass':
		case 'ci_still_running':
		case 'not_approved':
		case 'requested_changes':
		case 'discussions_not_resolved':
		case 'blocked_status':
		case 'external_status_checks':
		case 'jira_association_missing': return { mergeable: 'mergeable', mergeState: 'blocked' };
		case 'checking':
		case 'unchecked':
		case 'preparing': return { mergeable: 'unknown', mergeState: 'unknown' };
	}
	return raw.merge_status === 'can_be_merged' ? { mergeable: 'mergeable', mergeState: 'clean' } : { mergeable: 'unknown', mergeState: 'unknown' };
}

export interface IGitlabExtras {
	readonly checks?: readonly IVoltPrCheck[];
	/** `GET .../approvals`. */
	readonly approvals?: Json;
	readonly labelColors?: ReadonlyMap<string, string>;
}

export function parseGitlabMergeRequest(raw: Json, repo: IVoltPrRepoRef, viewer: string, extras: IGitlabExtras = {}): IVoltPullRequest {
	const number = num(raw.iid);
	const state = gitlabState(raw);
	const { mergeable, mergeState } = mergeability(raw, state);
	const checks = extras.checks ? summarizeChecks(extras.checks) : pipelineSummary(raw.head_pipeline ?? raw.pipeline);
	const approvedBy: string[] = list(extras.approvals?.approved_by).map(entry => str(entry.user?.username)).filter(Boolean);
	const reviews = approvedBy.map(author => ({ author, state: 'approved' as const, at: time(raw.updated_at) ?? 0 }));
	const reviewDecision = str(raw.detailed_merge_status) === 'requested_changes' ? 'changesRequested' as const
		: extras.approvals?.approved || approvedBy.length ? 'approved' as const
			: str(raw.detailed_merge_status) === 'not_approved' ? 'reviewRequired' as const : undefined;
	const crossRepository = raw.source_project_id !== undefined && raw.target_project_id !== undefined && raw.source_project_id !== raw.target_project_id;
	return {
		key: prKey(repo, number),
		repo: { host: repo.host, owner: repo.owner, name: repo.name },
		number,
		id: String(raw.id ?? number),
		title: str(raw.title),
		url: str(raw.web_url),
		state,
		author: user(raw.author?.username, raw.author?.avatar_url),
		headRefName: str(raw.source_branch),
		headRefOid: str(raw.sha ?? raw.diff_refs?.head_sha),
		baseRefName: str(raw.target_branch),
		crossRepository,
		createdAt: time(raw.created_at) ?? 0,
		updatedAt: time(raw.updated_at) ?? 0,
		...(state === 'merged' && time(raw.merged_at) !== undefined ? { mergedAt: time(raw.merged_at) } : {}),
		...(state === 'closed' && time(raw.closed_at) !== undefined ? { closedAt: time(raw.closed_at) } : {}),
		additions: 0,
		deletions: 0,
		changedFiles: num(String(raw.changes_count ?? '').replace(/\+$/, '')),
		mergeable,
		mergeState,
		...(reviewDecision ? { reviewDecision } : {}),
		checks,
		labels: labels(raw.labels, extras.labelColors),
		assignees: list(raw.assignees).map(assignee => str(assignee.username)).filter(Boolean),
		reviewRequests: list(raw.reviewers).map(reviewer => str(reviewer.username)).filter(name => name && !approvedBy.includes(name)),
		reviews,
		unresolvedThreads: 0,
		comments: num(raw.user_notes_count),
		autoMerge: !!raw.merge_when_pipeline_succeeds || !!raw.auto_merge_enabled,
		viewer,
	};
}

function pipelineSummary(pipeline: Json): IVoltPullRequest['checks'] {
	const state = gitlabPipelineChecks(pipeline);
	return {
		state,
		total: state === 'none' ? 0 : 1,
		passed: state === 'success' ? 1 : 0,
		failed: state === 'failure' ? 1 : 0,
		pending: state === 'pending' ? 1 : 0,
		skipped: 0,
		failing: state === 'failure' ? ['pipeline'] : [],
	};
}

export function parseGitlabNote(raw: Json): IVoltPrComment {
	return {
		id: String(raw.id ?? ''),
		...(typeof raw.id === 'number' ? { databaseId: raw.id } : {}),
		author: user(raw.author?.username, raw.author?.avatar_url),
		body: str(raw.body),
		createdAt: time(raw.created_at) ?? 0,
		url: '',
	};
}

/** Discussions with a position become review threads; the rest (and plain notes) are conversation. System notes are left out. */
export function parseGitlabDiscussions(discussions: readonly Json[], mrUrl: string): { threads: IVoltPrReviewThread[]; conversation: IVoltPrComment[] } {
	const threads: IVoltPrReviewThread[] = [];
	const conversation: IVoltPrComment[] = [];
	for (const discussion of discussions) {
		const notes = list(discussion.notes).filter(note => !note.system);
		if (!notes.length) {
			continue;
		}
		const first = notes[0];
		const position = first.position;
		const comments = notes.map(note => ({ ...parseGitlabNote(note), url: `${mrUrl}#note_${note.id}` }));
		if (position && (position.new_path || position.old_path)) {
			const newLine = num(position.new_line);
			const oldLine = num(position.old_line);
			threads.push({
				id: String(discussion.id),
				path: str(position.new_path ?? position.old_path),
				...(newLine || oldLine ? { line: newLine || oldLine } : {}),
				side: newLine ? 'RIGHT' : 'LEFT',
				resolved: notes.every(note => !note.resolvable || note.resolved),
				outdated: false,
				canResolve: notes.some(note => note.resolvable),
				comments,
			});
		} else {
			conversation.push(...comments);
		}
	}
	return { threads, conversation: conversation.sort((a, b) => a.createdAt - b.createdAt) };
}

/** `GET .../diffs` entries: GitLab's `diff` starts at the first `@@`, like GitHub's `patch`. */
export function parseGitlabDiff(raw: Json): IVoltPrFilePatch {
	const change = raw.new_file ? 'added' as const : raw.deleted_file ? 'deleted' as const : raw.renamed_file ? 'renamed' as const : 'modified' as const;
	const diff = str(raw.diff);
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			additions++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			deletions++;
		}
	}
	const path = change === 'deleted' ? str(raw.old_path) : str(raw.new_path);
	return {
		path,
		...(raw.renamed_file && raw.old_path && raw.old_path !== raw.new_path ? { previousPath: raw.old_path } : {}),
		change,
		additions,
		deletions,
		...(diff ? { patch: diff.replace(/\n$/, '') } : {}),
	};
}

export function parseGitlabCommit(raw: Json): IVoltPrCommit {
	return {
		oid: str(raw.id),
		headline: str(raw.title ?? raw.message).split('\n')[0],
		author: str(raw.author_name, 'unknown'),
		at: time(raw.committed_date) ?? time(raw.created_at) ?? 0,
		checks: 'none',
	};
}

export interface IGitlabDetailParts {
	readonly mr: Json;
	readonly project: Json;
	readonly checks: readonly IVoltPrCheck[];
	readonly diffs: readonly Json[];
	readonly discussions: readonly Json[];
	readonly commits: readonly Json[];
	readonly approvals?: Json;
	readonly labels: readonly Json[];
}

export function parseGitlabDetail(parts: IGitlabDetailParts, repo: IVoltPrRepoRef, viewer: string): IVoltPullRequestDetail {
	const labelColors = new Map<string, string>(parts.labels.map(label => [str(label.name), str(label.color, '#888888').replace(/^#/, '')]));
	const summary = parseGitlabMergeRequest(parts.mr, repo, viewer, { checks: parts.checks, approvals: parts.approvals, labelColors });
	const patches = parts.diffs.map(parseGitlabDiff);
	const files: IVoltPrFile[] = patches.map(patch => ({ path: patch.path, ...(patch.previousPath ? { previousPath: patch.previousPath } : {}), change: patch.change, additions: patch.additions, deletions: patch.deletions, viewed: 'unviewed' }));
	const { threads, conversation } = parseGitlabDiscussions(parts.discussions, summary.url);
	const reviewList: IVoltPrReview[] = summary.reviews.map(review => ({ id: `approval:${review.author}`, author: user(review.author), state: review.state, body: '', at: review.at, url: summary.url }));
	const access = Math.max(num(parts.project?.permissions?.project_access?.access_level), num(parts.project?.permissions?.group_access?.access_level));
	const canWrite = access >= 30 || !!parts.mr?.user?.can_merge;
	return {
		...summary,
		additions: patches.reduce((sum, patch) => sum + patch.additions, 0),
		deletions: patches.reduce((sum, patch) => sum + patch.deletions, 0),
		changedFiles: files.length || summary.changedFiles,
		unresolvedThreads: threads.filter(thread => !thread.resolved).length,
		comments: conversation.length + threads.reduce((sum, thread) => sum + thread.comments.length, 0),
		body: str(parts.mr.description),
		baseRefOid: str(parts.mr.diff_refs?.base_sha),
		files,
		threads,
		reviewList,
		conversation,
		commits: parts.commits.map(parseGitlabCommit).reverse(),
		checkRuns: [...parts.checks],
		mergeOptions: {
			merge: parts.project?.merge_method !== 'ff',
			squash: parts.project?.squash_option !== 'never',
			rebase: parts.project?.merge_method === 'ff' || parts.project?.merge_method === 'rebase_merge',
			deleteBranchOnMerge: !!parts.project?.remove_source_branch_after_merge,
			autoMergeAllowed: true,
		},
		viewerCanMerge: !!parts.mr?.user?.can_merge || canWrite,
		viewerCanUpdate: canWrite || str(parts.mr.author?.username) === viewer,
		repoLabels: labels(parts.labels),
	};
}
