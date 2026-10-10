/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { num, str, stripDraftTitle } from '../../common/hosts/hostParse.js';
import {
	gitlabProjectId,
	IGitlabApprovalsJson,
	IGitlabCommitJson,
	IGitlabCommitStatusJson,
	IGitlabDiffJson,
	IGitlabDiscussionJson,
	IGitlabJobJson,
	IGitlabLabelJson,
	IGitlabMergeRequestJson,
	IGitlabProjectJson,
	IGitlabUserJson,
	parseGitlabChecks,
	parseGitlabDetail,
	parseGitlabDiff,
	parseGitlabMergeRequest,
} from '../../common/hosts/gitlabParse.js';
import {
	IVoltPrCheck,
	IVoltPrCreateRequest,
	IVoltPrFilePatch,
	IVoltPrLineComment,
	IVoltPrMergeRequest,
	IVoltPrRepoRef,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	VoltPrError,
	voltPrErrorCode,
	voltPrErrorMessage,
} from '../../common/voltPullRequests.js';
import { commitPathRef, findingsAsComment, IVoltPrHostClient, openFirst, parseCommitPathRef, VoltPrRestClient } from './voltPrHostClient.js';
import { IVoltPrHttpResponse } from './voltPrHttp.js';

const PER_PAGE = 100;

/** `GET .../changes`: GitLab before 15.7 has no `/diffs`. */
interface IGitlabChangesJson {
	readonly changes?: readonly IGitlabDiffJson[];
}

/** GitLab.com and self-managed GitLab, `/api/v4`. Merge requests are numbered by `iid`. */
export class GitlabClient extends VoltPrRestClient implements IVoltPrHostClient {

	readonly provider = 'gitlab' as const;

	private project(repo: IVoltPrRepoRef): string {
		return `/projects/${gitlabProjectId(repo)}`;
	}

	private mr(repo: IVoltPrRepoRef, number: number): string {
		return `${this.project(repo)}/merge_requests/${number}`;
	}

	protected async readViewer(): Promise<string> {
		const me = await this.http.get<IGitlabUserJson | undefined>('/user');
		if (typeof me?.username !== 'string') {
			throw new VoltPrError('noAuth', `${this.label} did not say who the token belongs to.`);
		}
		return me.username;
	}

	private nextPage(response: IVoltPrHttpResponse<unknown>, page: number, got: number): number | undefined {
		const header = response.headers.get('x-next-page');
		if (header !== null) {
			return /^\d+$/.test(header) ? Number(header) : undefined;
		}
		return got >= PER_PAGE ? page + 1 : undefined;
	}

	private all<T>(path: string, query: Record<string, string | number> = {}, limit = Infinity): Promise<T[]> {
		return this.http.pages<T>(path, { per_page: PER_PAGE, ...query }, body => Array.isArray(body) ? body as T[] : [], (response, page, got) => this.nextPage(response, page, got), limit);
	}

	/** List rows carry no pipeline: open ones are read one by one for it (the single read has `head_pipeline`). */
	private async rows(repo: IVoltPrRepoRef, raws: readonly IGitlabMergeRequestJson[], viewer: string): Promise<IVoltPullRequest[]> {
		return this.eachSettled(raws, async raw => {
			const full = raw.state === 'opened' && raw.head_pipeline === undefined ? await this.http.get<IGitlabMergeRequestJson>(this.mr(repo, num(raw.iid))) : raw;
			return parseGitlabMergeRequest(full, repo, viewer);
		}, raw => parseGitlabMergeRequest(raw, repo, viewer));
	}

	async list(repo: IVoltPrRepoRef, state: 'open' | 'closed' | 'all', limit: number): Promise<IVoltPullRequest[]> {
		const states = state === 'open' ? ['opened'] : state === 'closed' ? ['closed', 'merged'] : ['all'];
		const [viewer, lists] = await Promise.all([this.viewer(), Promise.all(states.map(value => this.all<IGitlabMergeRequestJson>(`${this.project(repo)}/merge_requests`, { state: value, order_by: 'updated_at', sort: 'desc' }, limit)))]);
		const raws = lists.flat().sort((a, b) => Date.parse(str(b.updated_at)) - Date.parse(str(a.updated_at))).slice(0, limit);
		return this.rows(repo, raws, viewer);
	}

	async forBranch(repo: IVoltPrRepoRef, branch: string): Promise<IVoltPullRequest[]> {
		const [viewer, raws] = await Promise.all([this.viewer(), this.all<IGitlabMergeRequestJson>(`${this.project(repo)}/merge_requests`, { state: 'all', source_branch: branch, order_by: 'created_at', sort: 'desc' }, 20)]);
		return openFirst(await this.rows(repo, raws, viewer));
	}

	async get(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequest | undefined> {
		const response = await this.http.request<IGitlabMergeRequestJson | undefined>('GET', this.mr(repo, number), { allow: [404] });
		if (response.status === 404 || !response.body) {
			return undefined;
		}
		return parseGitlabMergeRequest(response.body, repo, await this.viewer());
	}

	/** The head pipeline's jobs (in the project that ran it: a fork's for its merge requests) and external statuses. */
	private async checks(repo: IVoltPrRepoRef, mr: IGitlabMergeRequestJson): Promise<IVoltPrCheck[]> {
		const pipeline = mr.head_pipeline ?? mr.pipeline;
		const [jobs, statuses] = await Promise.all([
			pipeline?.id ? this.all<IGitlabJobJson>(`/projects/${pipeline.project_id ?? gitlabProjectId(repo)}/pipelines/${pipeline.id}/jobs`, { include_retried: 'false' }).catch(() => []) : Promise.resolve([]),
			mr.sha ? this.all<IGitlabCommitStatusJson>(`${this.project(repo)}/repository/commits/${mr.sha}/statuses`).catch(() => []) : Promise.resolve([]),
		]);
		if (!jobs.length && !statuses.length && pipeline?.status) {
			// Jobs can be out of reach (a fork's pipeline): the pipeline itself still says where it stands.
			return parseGitlabChecks([{ name: 'pipeline', status: pipeline.status, web_url: pipeline.web_url, created_at: pipeline.created_at, started_at: pipeline.started_at, finished_at: pipeline.finished_at }]);
		}
		return parseGitlabChecks(jobs, statuses);
	}

	async detail(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequestDetail> {
		const response = await this.http.request<IGitlabMergeRequestJson>('GET', this.mr(repo, number), { allow: [404] });
		if (response.status === 404) {
			throw new VoltPrError('notFound', `Merge request !${number} was not found in ${repo.owner}/${repo.name}.`);
		}
		const mr = response.body;
		const [viewer, project, checks, diffs, discussions, commits, approvals, labels] = await Promise.all([
			this.viewer(),
			this.http.get<IGitlabProjectJson | undefined>(this.project(repo)),
			this.checks(repo, mr),
			this.all<IGitlabDiffJson>(`${this.mr(repo, number)}/diffs`).catch(async err => {
				// GitLab before 15.7 has only `/changes`.
				if (voltPrErrorCode(err) !== 'notFound') {
					throw err;
				}
				return (await this.http.get<IGitlabChangesJson | undefined>(`${this.mr(repo, number)}/changes`))?.changes ?? [];
			}),
			this.all<IGitlabDiscussionJson>(`${this.mr(repo, number)}/discussions`).catch(() => []),
			this.all<IGitlabCommitJson>(`${this.mr(repo, number)}/commits`).catch(() => []),
			this.http.get<IGitlabApprovalsJson>(`${this.mr(repo, number)}/approvals`).catch(() => undefined),
			this.all<IGitlabLabelJson>(`${this.project(repo)}/labels`).catch(() => []),
		]);
		return parseGitlabDetail({ mr, project, checks, diffs, discussions, commits, approvals, labels }, repo, viewer);
	}

	async create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest> {
		const title = request.draft ? `Draft: ${stripDraftTitle(request.title)}` : request.title;
		const created = await this.http.json<IGitlabMergeRequestJson | undefined>('POST', `${this.project(request.repo)}/merge_requests`, {
			body: { source_branch: request.head, target_branch: request.base, title, description: request.body },
		});
		if (typeof created?.iid !== 'number') {
			throw new VoltPrError('failed', `${this.label} did not return the new merge request.`);
		}
		return parseGitlabMergeRequest(created, request.repo, await this.viewer());
	}

	async merge(request: IVoltPrMergeRequest): Promise<void> {
		try {
			await this.http.json('PUT', `${this.mr(request.repo, request.number)}/merge`, {
				body: {
					...(request.headOid ? { sha: request.headOid } : {}),
					squash: request.method === 'squash',
					...(request.deleteBranch ? { should_remove_source_branch: true } : {}),
					...(request.auto ? { merge_when_pipeline_succeeds: true, auto_merge: true } : {}),
					...(request.subject && request.method === 'squash' ? { squash_commit_message: [request.subject, request.body].filter(Boolean).join('\n\n') } : {}),
					...(request.subject && request.method !== 'squash' ? { merge_commit_message: [request.subject, request.body].filter(Boolean).join('\n\n') } : {}),
				},
			});
		} catch (err) {
			// 409: `sha` is not the head any more. 405/406/422: not mergeable now.
			const message = voltPrErrorMessage(err);
			if (/sha does not match|SHA does not match/i.test(message)) {
				throw new VoltPrError('stale', message);
			}
			if (/conflict|cannot be merged|not mergeable|405|406/i.test(message)) {
				throw new VoltPrError('conflict', message);
			}
			throw err;
		}
	}

	override async cancelAutoMerge(repo: IVoltPrRepoRef, number: number): Promise<void> {
		await this.http.json('POST', `${this.mr(repo, number)}/cancel_merge_when_pipeline_succeeds`);
	}

	override async updateBranch(repo: IVoltPrRepoRef, number: number, rebase: boolean): Promise<void> {
		if (!rebase) {
			this.unsupported('merge the target branch into a merge request; use Update with Rebase');
		}
		await this.http.json('PUT', `${this.mr(repo, number)}/rebase`);
	}

	async setState(repo: IVoltPrRepoRef, number: number, state: 'open' | 'closed'): Promise<void> {
		await this.http.json('PUT', this.mr(repo, number), { body: { state_event: state === 'closed' ? 'close' : 'reopen' } });
	}

	async setBase(repo: IVoltPrRepoRef, number: number, base: string): Promise<void> {
		await this.http.json('PUT', this.mr(repo, number), { body: { target_branch: base } });
	}

	async setDraft(repo: IVoltPrRepoRef, number: number, draft: boolean): Promise<void> {
		const mr = await this.http.get<IGitlabMergeRequestJson | undefined>(this.mr(repo, number));
		const plain = stripDraftTitle(String(mr?.title ?? ''));
		await this.http.json('PUT', this.mr(repo, number), { body: { title: draft ? `Draft: ${plain}` : plain } });
	}

	override async setLabels(repo: IVoltPrRepoRef, number: number, add: readonly string[], remove: readonly string[]): Promise<void> {
		await this.http.json('PUT', this.mr(repo, number), { body: { ...(add.length ? { add_labels: add.join(',') } : {}), ...(remove.length ? { remove_labels: remove.join(',') } : {}) } });
	}

	async comment(repo: IVoltPrRepoRef, number: number, body: string): Promise<void> {
		await this.http.json('POST', `${this.mr(repo, number)}/notes`, { body: { body } });
	}

	override async reply(repo: IVoltPrRepoRef, number: number, threadId: string, body: string): Promise<void> {
		await this.http.json('POST', `${this.mr(repo, number)}/discussions/${encodeURIComponent(threadId)}/notes`, { body: { body } });
	}

	override async resolveThread(repo: IVoltPrRepoRef, number: number, threadId: string, resolved: boolean): Promise<void> {
		await this.http.json('PUT', `${this.mr(repo, number)}/discussions/${encodeURIComponent(threadId)}`, { query: { resolved } });
	}

	async review(repo: IVoltPrRepoRef, number: number, event: 'approve' | 'requestChanges' | 'comment', body: string): Promise<void> {
		if (event === 'approve') {
			await this.http.json('POST', `${this.mr(repo, number)}/approve`);
		}
		if (body.trim() || event === 'requestChanges') {
			await this.comment(repo, number, event === 'requestChanges' ? `**Changes requested**\n\n${body}`.trim() : body);
		}
	}

	async postReview(repo: IVoltPrRepoRef, number: number, body: string, comments: readonly IVoltPrLineComment[]): Promise<{ posted: number; url?: string }> {
		const mr = await this.http.get<IGitlabMergeRequestJson | undefined>(this.mr(repo, number));
		const refs = mr?.diff_refs;
		let posted = 0;
		const leftOver: IVoltPrLineComment[] = [];
		for (const comment of comments) {
			if (!refs?.head_sha) {
				leftOver.push(comment);
				continue;
			}
			try {
				await this.http.json('POST', `${this.mr(repo, number)}/discussions`, {
					body: { body: comment.body, position: { position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, new_path: comment.path, old_path: comment.path, new_line: comment.line } },
				});
				posted++;
			} catch {
				// A line outside the diff cannot carry a diff note: it goes into the summary instead.
				leftOver.push(comment);
			}
		}
		if (body.trim() || leftOver.length) {
			await this.comment(repo, number, findingsAsComment(body, leftOver));
			posted += leftOver.length;
		}
		return { posted, ...(typeof mr?.web_url === 'string' ? { url: mr.web_url } : {}) };
	}

	override async rerunFailedChecks(repo: IVoltPrRepoRef, number: number): Promise<number> {
		const mr = await this.http.get<IGitlabMergeRequestJson | undefined>(this.mr(repo, number));
		const pipeline = mr?.head_pipeline;
		if (!pipeline?.id || pipeline.status !== 'failed') {
			return 0;
		}
		await this.http.json('POST', `/projects/${pipeline.project_id ?? gitlabProjectId(repo)}/pipelines/${pipeline.id}/retry`);
		return 1;
	}

	async filePatches(repo: IVoltPrRepoRef, number: number, commit?: string): Promise<IVoltPrFilePatch[]> {
		if (commit) {
			const diffs = await this.all<IGitlabDiffJson>(`${this.project(repo)}/repository/commits/${commit}/diff`);
			return diffs.map(parseGitlabDiff).map(file => file.change === 'deleted' ? file : { ...file, blob: commitPathRef(commit, file.path) });
		}
		const mr = await this.http.get<IGitlabMergeRequestJson | undefined>(this.mr(repo, number));
		const head = String(mr?.sha ?? mr?.diff_refs?.head_sha ?? '');
		let diffs: readonly IGitlabDiffJson[];
		try {
			diffs = await this.all<IGitlabDiffJson>(`${this.mr(repo, number)}/diffs`);
		} catch (err) {
			if (voltPrErrorCode(err) !== 'notFound') {
				throw err;
			}
			diffs = (await this.http.get<IGitlabChangesJson | undefined>(`${this.mr(repo, number)}/changes`))?.changes ?? [];
		}
		return diffs.map(parseGitlabDiff).map(file => file.change === 'deleted' || !head ? file : { ...file, blob: commitPathRef(head, file.path) });
	}

	async readBlob(repo: IVoltPrRepoRef, ref: string): Promise<string> {
		const byPath = parseCommitPathRef(ref);
		if (byPath) {
			return this.http.text(`${this.project(repo)}/repository/files/${encodeURIComponent(byPath.path)}/raw`, { ref: byPath.commit });
		}
		return this.http.text(`${this.project(repo)}/repository/blobs/${ref}/raw`);
	}

	async remoteBranches(repo: IVoltPrRepoRef): Promise<string[]> {
		const [project, branches] = await Promise.all([this.http.get<IGitlabProjectJson | undefined>(this.project(repo)), this.all<{ readonly name?: unknown }>(`${this.project(repo)}/repository/branches`, {}, 300)]);
		const names = branches.map(branch => branch?.name).filter((name): name is string => typeof name === 'string');
		const main = project?.default_branch;
		return typeof main === 'string' ? [main, ...names.filter(name => name !== main)] : names;
	}
}
