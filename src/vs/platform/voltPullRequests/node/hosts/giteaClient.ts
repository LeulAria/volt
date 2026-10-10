/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Json, splitUnifiedDiff, stripDraftTitle } from '../../common/hosts/hostParse.js';
import { parseGiteaChecks, parseGiteaDetail, parseGiteaPull } from '../../common/hosts/giteaParse.js';
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
import { commitPathRef, IVoltPrHostClient, openFirst, parseCommitPathRef, VoltPrRestClient } from './voltPrHostClient.js';

/** Gitea and Forgejo, `/api/v1`. */
export class GiteaClient extends VoltPrRestClient implements IVoltPrHostClient {

	readonly provider = 'gitea' as const;

	private repoPath(repo: IVoltPrRepoRef): string {
		return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
	}

	protected async readViewer(): Promise<string> {
		const me = await this.http.get<Json>('/user');
		if (typeof me?.login !== 'string') {
			throw new VoltPrError('noAuth', `${this.label} did not say who the token belongs to.`);
		}
		return me.login;
	}

	private async checks(repo: IVoltPrRepoRef, sha: string): Promise<IVoltPrCheck[]> {
		if (!sha) {
			return [];
		}
		const combined = await this.http.request<Json>('GET', `${this.repoPath(repo)}/commits/${sha}/status`, { allow: [404] });
		return combined.status === 404 ? [] : parseGiteaChecks(combined.body);
	}

	private async withChecks(repo: IVoltPrRepoRef, raws: readonly Json[], viewer: string): Promise<IVoltPullRequest[]> {
		return this.eachSettled(raws, async raw => {
			const open = raw.state === 'open';
			const checks = open ? await this.checks(repo, raw.head?.sha ?? '') : [];
			return parseGiteaPull(raw, repo, viewer, { checks });
		}, raw => parseGiteaPull(raw, repo, viewer));
	}

	private async pulls(repo: IVoltPrRepoRef, state: 'open' | 'closed' | 'all', limit: number): Promise<Json[]> {
		return this.http.pages<Json>(`${this.repoPath(repo)}/pulls`, { state, sort: 'recentupdate', limit: Math.min(50, limit) }, body => Array.isArray(body) ? body : [], (_response, page, got) => got >= Math.min(50, limit) ? page + 1 : undefined, limit);
	}

	async list(repo: IVoltPrRepoRef, state: 'open' | 'closed' | 'all', limit: number): Promise<IVoltPullRequest[]> {
		const [viewer, raws] = await Promise.all([this.viewer(), this.pulls(repo, state, limit)]);
		return this.withChecks(repo, raws, viewer);
	}

	async forBranch(repo: IVoltPrRepoRef, branch: string, headOwner?: string): Promise<IVoltPullRequest[]> {
		const [viewer, raws] = await Promise.all([this.viewer(), this.pulls(repo, 'all', 100)]);
		const owner = headOwner?.toLowerCase();
		const mine = raws.filter(raw => raw.head?.ref === branch && (!owner || String(raw.head?.repo?.owner?.login ?? repo.owner).toLowerCase() === owner));
		return openFirst(await this.withChecks(repo, mine, viewer));
	}

	async get(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequest | undefined> {
		const response = await this.http.request<Json>('GET', `${this.repoPath(repo)}/pulls/${number}`, { allow: [404] });
		if (response.status === 404 || !response.body) {
			return undefined;
		}
		const [viewer] = await Promise.all([this.viewer()]);
		return (await this.withChecks(repo, [response.body], viewer))[0];
	}

	async detail(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequestDetail> {
		const base = this.repoPath(repo);
		const pullResponse = await this.http.request<Json>('GET', `${base}/pulls/${number}`, { allow: [404] });
		if (pullResponse.status === 404) {
			throw new VoltPrError('notFound', `Pull request #${number} was not found in ${repo.owner}/${repo.name}.`);
		}
		const pull = pullResponse.body;
		const pageOf = (path: string) => this.http.pages<Json>(path, { limit: 50 }, body => Array.isArray(body) ? body : [], (_response, page, got) => got >= 50 ? page + 1 : undefined);
		const [viewer, repoRaw, checks, files, comments, reviews, commits, labels] = await Promise.all([
			this.viewer(),
			this.http.get<Json>(base),
			this.checks(repo, pull.head?.sha ?? ''),
			pageOf(`${base}/pulls/${number}/files`).catch(() => []),
			pageOf(`${base}/issues/${number}/comments`),
			pageOf(`${base}/pulls/${number}/reviews`),
			pageOf(`${base}/pulls/${number}/commits`).catch(() => []),
			pageOf(`${base}/labels`).catch(() => []),
		]);
		const reviewComments = (await this.each(reviews.filter(review => review.comments_count > 0), review =>
			this.http.get<Json[]>(`${base}/pulls/${number}/reviews/${review.id}/comments`).catch(() => [] as Json[]))).flat();
		return parseGiteaDetail({ pull, repo: repoRaw, checks, files, comments, reviews, reviewComments, commits, labels }, repo, viewer);
	}

	async create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest> {
		const head = request.headOwner && request.headOwner.toLowerCase() !== request.repo.owner.toLowerCase() ? `${request.headOwner}:${request.head}` : request.head;
		const title = request.draft ? `WIP: ${stripDraftTitle(request.title)}` : request.title;
		const created = await this.http.json<Json>('POST', `${this.repoPath(request.repo)}/pulls`, { body: { head, base: request.base, title, body: request.body } });
		const pr = typeof created?.number === 'number' ? await this.get(request.repo, created.number) : undefined;
		if (!pr) {
			throw new VoltPrError('failed', `${this.label} did not return the new pull request.`);
		}
		return pr;
	}

	async merge(request: IVoltPrMergeRequest): Promise<void> {
		const style = request.method === 'rebase' ? 'rebase' : request.method;
		try {
			await this.http.json('POST', `${this.repoPath(request.repo)}/pulls/${request.number}/merge`, {
				body: {
					Do: style,
					...(request.headOid ? { head_commit_id: request.headOid } : {}),
					...(request.deleteBranch ? { delete_branch_after_merge: true } : {}),
					...(request.subject ? { MergeTitleField: request.subject } : {}),
					...(request.body !== undefined ? { MergeMessageField: request.body } : {}),
					...(request.auto ? { merge_when_checks_succeed: true } : {}),
				},
			});
		} catch (err) {
			// 409: the head moved since `head_commit_id`; 405: not mergeable (conflicts, checks, approvals).
			if (voltPrErrorCode(err) === 'conflict' && /head|sha|out of date|modified/i.test((err as Error).message)) {
				throw new VoltPrError('stale', voltPrErrorMessage(err));
			}
			throw err;
		}
	}

	override async cancelAutoMerge(repo: IVoltPrRepoRef, number: number): Promise<void> {
		await this.http.json('DELETE', `${this.repoPath(repo)}/pulls/${number}/merge`);
	}

	override async updateBranch(repo: IVoltPrRepoRef, number: number, rebase: boolean): Promise<void> {
		await this.http.json('POST', `${this.repoPath(repo)}/pulls/${number}/update`, { query: { style: rebase ? 'rebase' : 'merge' } });
	}

	async setState(repo: IVoltPrRepoRef, number: number, state: 'open' | 'closed'): Promise<void> {
		await this.http.json('PATCH', `${this.repoPath(repo)}/pulls/${number}`, { body: { state } });
	}

	async setBase(repo: IVoltPrRepoRef, number: number, base: string): Promise<void> {
		await this.http.json('PATCH', `${this.repoPath(repo)}/pulls/${number}`, { body: { base } });
	}

	async setDraft(repo: IVoltPrRepoRef, number: number, draft: boolean): Promise<void> {
		const pull = await this.http.get<Json>(`${this.repoPath(repo)}/pulls/${number}`);
		const plain = stripDraftTitle(String(pull?.title ?? ''));
		await this.http.json('PATCH', `${this.repoPath(repo)}/pulls/${number}`, { body: { title: draft ? `WIP: ${plain}` : plain } });
	}

	override async setLabels(repo: IVoltPrRepoRef, number: number, add: readonly string[], remove: readonly string[]): Promise<void> {
		const labels = await this.http.get<Json[]>(`${this.repoPath(repo)}/labels`, { limit: 100 });
		const idOf = (name: string) => (labels ?? []).find(label => label.name === name)?.id;
		const addIds = add.map(idOf).filter((id): id is number => typeof id === 'number');
		if (addIds.length) {
			await this.http.json('POST', `${this.repoPath(repo)}/issues/${number}/labels`, { body: { labels: addIds } });
		}
		for (const name of remove) {
			const id = idOf(name);
			if (id !== undefined) {
				await this.http.json('DELETE', `${this.repoPath(repo)}/issues/${number}/labels/${id}`, { allow: [404] });
			}
		}
	}

	async comment(repo: IVoltPrRepoRef, number: number, body: string): Promise<void> {
		await this.http.json('POST', `${this.repoPath(repo)}/issues/${number}/comments`, { body: { body } });
	}

	async review(repo: IVoltPrRepoRef, number: number, event: 'approve' | 'requestChanges' | 'comment', body: string): Promise<void> {
		await this.http.json('POST', `${this.repoPath(repo)}/pulls/${number}/reviews`, { body: { event: event === 'approve' ? 'APPROVED' : event === 'requestChanges' ? 'REQUEST_CHANGES' : 'COMMENT', body } });
	}

	async postReview(repo: IVoltPrRepoRef, number: number, body: string, comments: readonly IVoltPrLineComment[], headOid?: string): Promise<{ posted: number; url?: string }> {
		const review = await this.http.json<Json>('POST', `${this.repoPath(repo)}/pulls/${number}/reviews`, {
			body: {
				event: 'COMMENT',
				body,
				...(headOid ? { commit_id: headOid } : {}),
				// Gitea's `new_position` is the line in the new file.
				comments: comments.map(comment => ({ path: comment.path, body: comment.body, new_position: comment.line })),
			},
		});
		return { posted: comments.length, ...(typeof review?.html_url === 'string' ? { url: review.html_url } : {}) };
	}

	override async requestReviewers(repo: IVoltPrRepoRef, number: number, logins: readonly string[]): Promise<void> {
		await this.http.json('POST', `${this.repoPath(repo)}/pulls/${number}/requested_reviewers`, { body: { reviewers: logins.filter(login => !login.includes('/')), team_reviewers: logins.filter(login => login.includes('/')).map(team => team.split('/').pop()) } });
	}

	async filePatches(repo: IVoltPrRepoRef, number: number, commit?: string): Promise<IVoltPrFilePatch[]> {
		const path = commit ? `${this.repoPath(repo)}/git/commits/${commit}.diff` : `${this.repoPath(repo)}/pulls/${number}.diff`;
		const [diff, head] = await Promise.all([
			this.http.text(path),
			commit ? Promise.resolve(commit) : this.http.get<Json>(`${this.repoPath(repo)}/pulls/${number}`).then(pull => String(pull?.head?.sha ?? '')),
		]);
		return splitUnifiedDiff(diff).map(file => file.change === 'deleted' || !head ? file : { ...file, blob: commitPathRef(head, file.path) });
	}

	async readBlob(repo: IVoltPrRepoRef, ref: string): Promise<string> {
		const byPath = parseCommitPathRef(ref);
		if (byPath) {
			return this.http.text(`${this.repoPath(repo)}/raw/${byPath.path.split('/').map(encodeURIComponent).join('/')}`, { ref: byPath.commit });
		}
		const blob = await this.http.get<Json>(`${this.repoPath(repo)}/git/blobs/${ref}`);
		return typeof blob?.content === 'string' ? Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8') : '';
	}

	async remoteBranches(repo: IVoltPrRepoRef): Promise<string[]> {
		const [repoRaw, branches] = await Promise.all([
			this.http.get<Json>(this.repoPath(repo)),
			this.http.pages<Json>(`${this.repoPath(repo)}/branches`, { limit: 50 }, body => Array.isArray(body) ? body : [], (_response, page, got) => got >= 50 ? page + 1 : undefined),
		]);
		const names = branches.map(branch => branch?.name).filter((name): name is string => typeof name === 'string');
		const main = repoRaw?.default_branch;
		return typeof main === 'string' ? [main, ...names.filter(name => name !== main)] : names;
	}
}
