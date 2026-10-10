/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { num, splitUnifiedDiff } from '../../common/hosts/hostParse.js';
import {
	bitbucketLogin,
	IBitbucketCommentJson,
	IBitbucketCommitJson,
	IBitbucketDiffstatJson,
	IBitbucketPullRequestJson,
	IBitbucketStatusJson,
	IBitbucketUserJson,
	parseBitbucketChecks,
	parseBitbucketDetail,
	parseBitbucketPull,
} from '../../common/hosts/bitbucketParse.js';
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
	voltPrErrorMessage,
} from '../../common/voltPullRequests.js';
import { commitPathRef, IVoltPrHostClient, openFirst, parseCommitPathRef, VoltPrRestClient } from './voltPrHostClient.js';

const PAGE_LEN = 50;

/** A page of a Bitbucket list: `values` and the next page's URL. */
interface IBitbucketPageJson<T> {
	readonly values?: T[];
	readonly next?: unknown;
}

/** Bitbucket Cloud, `/2.0`. Repositories are `workspace/slug`. */
export class BitbucketClient extends VoltPrRestClient implements IVoltPrHostClient {

	readonly provider = 'bitbucket' as const;

	private repoPath(repo: IVoltPrRepoRef): string {
		return `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
	}

	private pr(repo: IVoltPrRepoRef, number: number): string {
		return `${this.repoPath(repo)}/pullrequests/${number}`;
	}

	protected async readViewer(): Promise<string> {
		const me = await this.http.get<IBitbucketUserJson | undefined>('/user');
		if (!me) {
			throw new VoltPrError('noAuth', `${this.label} did not say who the token belongs to.`);
		}
		return bitbucketLogin(me);
	}

	/** Bitbucket pages carry the next page's full URL. */
	private all<T>(path: string, query: Record<string, string | number | readonly string[]> = {}, limit = Infinity): Promise<T[]> {
		return this.http.pages<T>(path, { pagelen: PAGE_LEN, ...query }, body => {
			const page = body as IBitbucketPageJson<T> | undefined;
			return Array.isArray(page?.values) ? page.values : [];
		}, response => {
			const next = (response.body as IBitbucketPageJson<T> | undefined)?.next;
			return typeof next === 'string' ? next : undefined;
		}, limit);
	}

	private async checks(repo: IVoltPrRepoRef, number: number): Promise<IVoltPrCheck[]> {
		return parseBitbucketChecks(await this.all<IBitbucketStatusJson>(`${this.pr(repo, number)}/statuses`));
	}

	private async rows(repo: IVoltPrRepoRef, raws: readonly IBitbucketPullRequestJson[], viewer: string): Promise<IVoltPullRequest[]> {
		return this.eachSettled(raws, async raw => parseBitbucketPull(raw, repo, viewer, { checks: raw.state === 'OPEN' ? await this.checks(repo, num(raw.id)) : [] }), raw => parseBitbucketPull(raw, repo, viewer));
	}

	async list(repo: IVoltPrRepoRef, state: 'open' | 'closed' | 'all', limit: number): Promise<IVoltPullRequest[]> {
		const states = state === 'open' ? ['OPEN'] : state === 'closed' ? ['MERGED', 'DECLINED', 'SUPERSEDED'] : ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];
		const [viewer, raws] = await Promise.all([this.viewer(), this.all<IBitbucketPullRequestJson>(`${this.repoPath(repo)}/pullrequests`, { state: states, sort: '-updated_on' }, limit)]);
		return this.rows(repo, raws, viewer);
	}

	async forBranch(repo: IVoltPrRepoRef, branch: string): Promise<IVoltPullRequest[]> {
		const [viewer, raws] = await Promise.all([this.viewer(), this.all<IBitbucketPullRequestJson>(`${this.repoPath(repo)}/pullrequests`, {
			q: `source.branch.name="${branch.replace(/["\\]/g, '\\$&')}"`,
			state: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'],
			sort: '-created_on',
		}, 20)]);
		return openFirst(await this.rows(repo, raws, viewer));
	}

	async get(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequest | undefined> {
		const response = await this.http.request<IBitbucketPullRequestJson | undefined>('GET', this.pr(repo, number), { allow: [404] });
		if (response.status === 404 || !response.body) {
			return undefined;
		}
		return (await this.rows(repo, [response.body], await this.viewer()))[0];
	}

	async detail(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequestDetail> {
		const response = await this.http.request<IBitbucketPullRequestJson>('GET', this.pr(repo, number), { allow: [404] });
		if (response.status === 404) {
			throw new VoltPrError('notFound', `Pull request #${number} was not found in ${repo.owner}/${repo.name}.`);
		}
		const pull = response.body;
		const [viewer, checks, diffstat, comments, commits, permission] = await Promise.all([
			this.viewer(),
			this.checks(repo, number).catch(() => []),
			this.all<IBitbucketDiffstatJson>(`${this.pr(repo, number)}/diffstat`).catch(() => []),
			this.all<IBitbucketCommentJson>(`${this.pr(repo, number)}/comments`, { pagelen: 100 }).catch(() => []),
			this.all<IBitbucketCommitJson>(`${this.pr(repo, number)}/commits`, {}, 100).catch(() => []),
			this.http.get<IBitbucketPageJson<{ readonly permission?: unknown } | undefined> | undefined>('/user/permissions/repositories', { q: `repository.full_name="${repo.owner}/${repo.name}"` }).catch(() => undefined),
		]);
		const level = permission?.values?.[0]?.permission;
		return parseBitbucketDetail({ pull, checks, diffstat, comments, commits, canWrite: level === 'admin' || level === 'write' || level === undefined }, repo, viewer);
	}

	async create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest> {
		const created = await this.http.json<IBitbucketPullRequestJson | undefined>('POST', `${this.repoPath(request.repo)}/pullrequests`, {
			body: {
				title: request.title,
				description: request.body,
				source: { branch: { name: request.head }, ...(request.headOwner && request.headOwner.toLowerCase() !== request.repo.owner.toLowerCase() ? { repository: { full_name: `${request.headOwner}/${request.repo.name}` } } : {}) },
				destination: { branch: { name: request.base } },
				draft: request.draft,
			},
		});
		if (typeof created?.id !== 'number') {
			throw new VoltPrError('failed', `${this.label} did not return the new pull request.`);
		}
		return parseBitbucketPull(created, request.repo, await this.viewer());
	}

	async merge(request: IVoltPrMergeRequest): Promise<void> {
		if (request.auto) {
			this.unsupported('merge once checks pass (auto-merge)');
		}
		if (request.headOid) {
			// Bitbucket's merge takes no expected head: read it first so a push since then is not merged unseen.
			const pull = await this.http.get<IBitbucketPullRequestJson | undefined>(this.pr(request.repo, request.number));
			const head = String(pull?.source?.commit?.hash ?? '');
			if (head && !request.headOid.startsWith(head) && !head.startsWith(request.headOid)) {
				throw new VoltPrError('stale', 'Someone pushed to the branch since you looked.');
			}
		}
		try {
			await this.http.json('POST', `${this.pr(request.repo, request.number)}/merge`, {
				body: {
					type: 'pullrequest',
					merge_strategy: request.method === 'squash' ? 'squash' : request.method === 'rebase' ? 'fast_forward' : 'merge_commit',
					close_source_branch: !!request.deleteBranch,
					...(request.subject ? { message: [request.subject, request.body].filter(Boolean).join('\n\n') } : {}),
				},
			});
		} catch (err) {
			if (/conflict/i.test(voltPrErrorMessage(err))) {
				throw new VoltPrError('conflict', voltPrErrorMessage(err));
			}
			throw err;
		}
	}

	async setState(repo: IVoltPrRepoRef, number: number, state: 'open' | 'closed'): Promise<void> {
		if (state === 'open') {
			this.unsupported('reopen a declined pull request (Bitbucket cannot)');
		}
		await this.http.json('POST', `${this.pr(repo, number)}/decline`);
	}

	async setBase(repo: IVoltPrRepoRef, number: number, base: string): Promise<void> {
		const pull = await this.http.get<IBitbucketPullRequestJson | undefined>(this.pr(repo, number));
		await this.http.json('PUT', this.pr(repo, number), { body: { title: pull?.title, destination: { branch: { name: base } } } });
	}

	async setDraft(repo: IVoltPrRepoRef, number: number, draft: boolean): Promise<void> {
		const pull = await this.http.get<IBitbucketPullRequestJson | undefined>(this.pr(repo, number));
		await this.http.json('PUT', this.pr(repo, number), { body: { title: pull?.title, draft } });
	}

	async comment(repo: IVoltPrRepoRef, number: number, body: string): Promise<void> {
		await this.http.json('POST', `${this.pr(repo, number)}/comments`, { body: { content: { raw: body } } });
	}

	override async reply(repo: IVoltPrRepoRef, number: number, threadId: string, body: string): Promise<void> {
		await this.http.json('POST', `${this.pr(repo, number)}/comments`, { body: { content: { raw: body }, parent: { id: Number(threadId) } } });
	}

	override async resolveThread(repo: IVoltPrRepoRef, number: number, threadId: string, resolved: boolean): Promise<void> {
		await this.http.json(resolved ? 'POST' : 'DELETE', `${this.pr(repo, number)}/comments/${encodeURIComponent(threadId)}/resolve`);
	}

	async review(repo: IVoltPrRepoRef, number: number, event: 'approve' | 'requestChanges' | 'comment', body: string): Promise<void> {
		if (event === 'approve') {
			await this.http.json('POST', `${this.pr(repo, number)}/approve`);
		} else if (event === 'requestChanges') {
			await this.http.json('POST', `${this.pr(repo, number)}/request-changes`);
		}
		if (body.trim()) {
			await this.comment(repo, number, body);
		}
	}

	async postReview(repo: IVoltPrRepoRef, number: number, body: string, comments: readonly IVoltPrLineComment[]): Promise<{ posted: number; url?: string }> {
		let posted = 0;
		for (const comment of comments) {
			await this.http.json('POST', `${this.pr(repo, number)}/comments`, { body: { content: { raw: comment.body }, inline: { path: comment.path, to: comment.line } } });
			posted++;
		}
		if (body.trim()) {
			await this.comment(repo, number, body);
		}
		return { posted };
	}

	async filePatches(repo: IVoltPrRepoRef, number: number, commit?: string): Promise<IVoltPrFilePatch[]> {
		const pull = commit ? undefined : await this.http.get<IBitbucketPullRequestJson | undefined>(this.pr(repo, number));
		const head = commit ?? String(pull?.source?.commit?.hash ?? '');
		// `/diff` redirects to `/diff/{spec}`, which the transport follows (same host, so the token goes along).
		const diff = await this.http.text(commit ? `${this.repoPath(repo)}/diff/${commit}` : `${this.pr(repo, number)}/diff`);
		return splitUnifiedDiff(diff).map(file => file.change === 'deleted' || !head ? file : { ...file, blob: commitPathRef(head, file.path) });
	}

	async readBlob(repo: IVoltPrRepoRef, ref: string): Promise<string> {
		const byPath = parseCommitPathRef(ref);
		if (!byPath) {
			this.unsupported('read a file by blob id; open the pull request in a local clone');
		}
		return this.http.text(`${this.repoPath(repo)}/src/${byPath.commit}/${byPath.path.split('/').map(encodeURIComponent).join('/')}`);
	}

	async remoteBranches(repo: IVoltPrRepoRef): Promise<string[]> {
		const [repoRaw, branches] = await Promise.all([
			this.http.get<{ readonly mainbranch?: { readonly name?: unknown } } | undefined>(this.repoPath(repo)),
			this.all<{ readonly name?: unknown } | undefined>(`${this.repoPath(repo)}/refs/branches`, { sort: '-target.date' }, 200),
		]);
		const names = branches.map(branch => branch?.name).filter((name): name is string => typeof name === 'string');
		const main = repoRaw?.mainbranch?.name;
		return typeof main === 'string' ? [main, ...names.filter(name => name !== main)] : names;
	}
}
