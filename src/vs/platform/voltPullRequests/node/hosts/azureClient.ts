/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { azureBranch, IAzureChangeEntryJson, IAzureCommitJson, IAzurePullRequestJson, IAzureStatusJson, IAzureThreadJson, parseAzureChanges, parseAzureChecks, parseAzureDetail, parseAzurePull } from '../../common/hosts/azureParse.js';
import { num } from '../../common/hosts/hostParse.js';
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
import { IVoltPrHostClient, openFirst, parseCommitPathRef, VoltPrRestClient } from './voltPrHostClient.js';
import { VoltPrHttp } from './voltPrHttp.js';

const API_VERSION = '7.1';

/** Azure's list responses: `{ count, value: [...] }`. */
interface IAzureListJson<T> {
	readonly value?: T[];
}

interface IAzureConnectionDataJson {
	readonly authenticatedUser?: {
		readonly id?: unknown;
		readonly providerDisplayName?: unknown;
		readonly customDisplayName?: unknown;
	};
}

/**
 * Azure DevOps Repos. A repository is `org/project` + name; the API sits under the organization on
 * the same host (`https://dev.azure.com/org/project/_apis/git/repositories/name`).
 */
export class AzureClient extends VoltPrRestClient implements IVoltPrHostClient {

	readonly provider = 'azure' as const;
	private readonly identities = new Map<string, Promise<{ id: string; name: string }>>();

	constructor(http: VoltPrHttp, private readonly webUrl: string) {
		super(http);
	}

	private org(repo: Pick<IVoltPrRepoRef, 'owner'>): string {
		return repo.owner.split('/')[0];
	}

	private repoPath(repo: IVoltPrRepoRef): string {
		const [org, project] = repo.owner.split('/');
		return `/${encodeURIComponent(org)}/${encodeURIComponent(project ?? '')}/_apis/git/repositories/${encodeURIComponent(repo.name)}`;
	}

	private pr(repo: IVoltPrRepoRef, number: number): string {
		return `${this.repoPath(repo)}/pullrequests/${number}`;
	}

	private q(extra: Record<string, string | number | boolean | undefined> = {}): Record<string, string | number | boolean | undefined> {
		return { 'api-version': API_VERSION, ...extra };
	}

	/** Who the token is in an organization (votes need the id). */
	private identity(owner: string | undefined): Promise<{ id: string; name: string }> {
		const org = owner?.split('/')[0] ?? '';
		let cached = this.identities.get(org);
		if (!cached) {
			cached = this.http.get<IAzureConnectionDataJson | undefined>(org ? `/${encodeURIComponent(org)}/_apis/connectionData` : '/_apis/connectionData').then(data => {
				const user = data?.authenticatedUser;
				const name = user?.providerDisplayName ?? user?.customDisplayName;
				if (typeof user?.id !== 'string' || typeof name !== 'string' || /^anonymous$/i.test(name)) {
					throw new VoltPrError('noAuth', `${this.label} did not accept the token for ${org || 'this organization'}.`);
				}
				return { id: user.id, name };
			});
			this.identities.set(org, cached);
			cached.catch(() => this.identities.delete(org));
		}
		return cached;
	}

	protected async readViewer(owner?: string): Promise<string> {
		return (await this.identity(owner)).name;
	}

	private async checks(repo: IVoltPrRepoRef, number: number): Promise<IVoltPrCheck[]> {
		const statuses = await this.http.get<IAzureListJson<IAzureStatusJson> | undefined>(`${this.pr(repo, number)}/statuses`, this.q());
		return parseAzureChecks(Array.isArray(statuses?.value) ? statuses.value : []);
	}

	private async rows(repo: IVoltPrRepoRef, raws: readonly IAzurePullRequestJson[], viewer: string): Promise<IVoltPullRequest[]> {
		return this.eachSettled(raws, async raw => parseAzurePull(raw, repo, viewer, { webUrl: this.webUrl, checks: raw.status === 'active' ? await this.checks(repo, num(raw.pullRequestId)) : [] }), raw => parseAzurePull(raw, repo, viewer, { webUrl: this.webUrl }));
	}

	private async search(repo: IVoltPrRepoRef, criteria: Record<string, string>, limit: number): Promise<IAzurePullRequestJson[]> {
		const out = await this.http.get<IAzureListJson<IAzurePullRequestJson> | undefined>(`${this.repoPath(repo)}/pullrequests`, this.q({ ...Object.fromEntries(Object.entries(criteria).map(([key, value]) => [`searchCriteria.${key}`, value])), '$top': Math.min(100, limit) }));
		return Array.isArray(out?.value) ? out.value : [];
	}

	async list(repo: IVoltPrRepoRef, state: 'open' | 'closed' | 'all', limit: number): Promise<IVoltPullRequest[]> {
		const [viewer, raws] = await Promise.all([
			this.viewer(repo.owner),
			state === 'open' ? this.search(repo, { status: 'active' }, limit) : this.search(repo, { status: 'all' }, limit).then(all => state === 'closed' ? all.filter(raw => raw.status !== 'active') : all),
		]);
		return this.rows(repo, raws.slice(0, limit), viewer);
	}

	async forBranch(repo: IVoltPrRepoRef, branch: string): Promise<IVoltPullRequest[]> {
		const [viewer, raws] = await Promise.all([this.viewer(repo.owner), this.search(repo, { status: 'all', sourceRefName: `refs/heads/${branch}` }, 20)]);
		return openFirst(await this.rows(repo, raws, viewer));
	}

	async get(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequest | undefined> {
		const response = await this.http.request<IAzurePullRequestJson | undefined>('GET', this.pr(repo, number), { query: this.q(), allow: [404] });
		if (response.status === 404 || !response.body) {
			return undefined;
		}
		return (await this.rows(repo, [response.body], await this.viewer(repo.owner)))[0];
	}

	async detail(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequestDetail> {
		const response = await this.http.request<IAzurePullRequestJson>('GET', this.pr(repo, number), { query: this.q(), allow: [404] });
		if (response.status === 404) {
			throw new VoltPrError('notFound', `Pull request ${number} was not found in ${repo.owner}/${repo.name}.`);
		}
		const pull = response.body;
		const [viewer, checks, changes, threads, commits] = await Promise.all([
			this.viewer(repo.owner),
			this.checks(repo, number).catch(() => []),
			this.changes(repo, number).catch(() => []),
			this.http.get<IAzureListJson<IAzureThreadJson> | undefined>(`${this.pr(repo, number)}/threads`, this.q()).then(out => Array.isArray(out?.value) ? out.value : []).catch(() => []),
			this.http.get<IAzureListJson<IAzureCommitJson> | undefined>(`${this.pr(repo, number)}/commits`, this.q({ '$top': 100 })).then(out => Array.isArray(out?.value) ? out.value : []).catch(() => []),
		]);
		return parseAzureDetail({ pull, checks, changes, threads, commits, webUrl: this.webUrl }, repo, viewer);
	}

	/** The last iteration's changes against the target. */
	private async changes(repo: IVoltPrRepoRef, number: number): Promise<IAzureChangeEntryJson[]> {
		const iterations = await this.http.get<IAzureListJson<{ readonly id?: unknown } | undefined> | undefined>(`${this.pr(repo, number)}/iterations`, this.q());
		const last = Array.isArray(iterations?.value) ? iterations.value.reduce((max, iteration) => Math.max(max, Number(iteration?.id) || 0), 0) : 0;
		if (!last) {
			return [];
		}
		const changes = await this.http.get<{ readonly changeEntries?: IAzureChangeEntryJson[] } | undefined>(`${this.pr(repo, number)}/iterations/${last}/changes`, this.q({ '$top': 2000, '$compareTo': 0 }));
		return Array.isArray(changes?.changeEntries) ? changes.changeEntries : [];
	}

	async create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest> {
		const created = await this.http.json<IAzurePullRequestJson | undefined>('POST', `${this.repoPath(request.repo)}/pullrequests`, {
			query: this.q(),
			body: { sourceRefName: `refs/heads/${request.head}`, targetRefName: `refs/heads/${request.base}`, title: request.title, description: request.body, isDraft: request.draft },
		});
		if (typeof created?.pullRequestId !== 'number') {
			throw new VoltPrError('failed', `${this.label} did not return the new pull request.`);
		}
		return parseAzurePull(created, request.repo, await this.viewer(request.repo.owner), { webUrl: this.webUrl });
	}

	async merge(request: IVoltPrMergeRequest): Promise<void> {
		const pull = await this.http.get<IAzurePullRequestJson | undefined>(this.pr(request.repo, request.number), this.q());
		const head = String(pull?.lastMergeSourceCommit?.commitId ?? '');
		if (request.headOid && head && head !== request.headOid) {
			throw new VoltPrError('stale', 'Someone pushed to the branch since you looked.');
		}
		const completionOptions = {
			mergeStrategy: request.method === 'squash' ? 'squash' : request.method === 'rebase' ? 'rebase' : 'noFastForward',
			deleteSourceBranch: !!request.deleteBranch,
			...(request.subject ? { mergeCommitMessage: [request.subject, request.body].filter(Boolean).join('\n\n') } : {}),
		};
		try {
			if (request.auto) {
				const me = await this.identity(request.repo.owner);
				await this.http.json('PATCH', this.pr(request.repo, request.number), { query: this.q(), body: { autoCompleteSetBy: { id: me.id }, completionOptions } });
				return;
			}
			await this.http.json('PATCH', this.pr(request.repo, request.number), { query: this.q(), body: { status: 'completed', lastMergeSourceCommit: { commitId: head || request.headOid }, completionOptions } });
		} catch (err) {
			if (/conflict|policy|TF401/i.test(voltPrErrorMessage(err))) {
				throw new VoltPrError('conflict', voltPrErrorMessage(err));
			}
			throw err;
		}
	}

	override async cancelAutoMerge(repo: IVoltPrRepoRef, number: number): Promise<void> {
		await this.http.json('PATCH', this.pr(repo, number), { query: this.q(), body: { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } } });
	}

	async setState(repo: IVoltPrRepoRef, number: number, state: 'open' | 'closed'): Promise<void> {
		await this.http.json('PATCH', this.pr(repo, number), { query: this.q(), body: { status: state === 'closed' ? 'abandoned' : 'active' } });
	}

	async setBase(repo: IVoltPrRepoRef, number: number, base: string): Promise<void> {
		await this.http.json('PATCH', this.pr(repo, number), { query: this.q(), body: { targetRefName: `refs/heads/${base}` } });
	}

	async setDraft(repo: IVoltPrRepoRef, number: number, draft: boolean): Promise<void> {
		await this.http.json('PATCH', this.pr(repo, number), { query: this.q(), body: { isDraft: draft } });
	}

	async comment(repo: IVoltPrRepoRef, number: number, body: string): Promise<void> {
		await this.http.json('POST', `${this.pr(repo, number)}/threads`, { query: this.q(), body: { comments: [{ parentCommentId: 0, content: body, commentType: 'text' }], status: 'active' } });
	}

	override async reply(repo: IVoltPrRepoRef, number: number, threadId: string, body: string): Promise<void> {
		await this.http.json('POST', `${this.pr(repo, number)}/threads/${encodeURIComponent(threadId)}/comments`, { query: this.q(), body: { parentCommentId: 1, content: body, commentType: 'text' } });
	}

	override async resolveThread(repo: IVoltPrRepoRef, number: number, threadId: string, resolved: boolean): Promise<void> {
		await this.http.json('PATCH', `${this.pr(repo, number)}/threads/${encodeURIComponent(threadId)}`, { query: this.q(), body: { status: resolved ? 'fixed' : 'active' } });
	}

	async review(repo: IVoltPrRepoRef, number: number, event: 'approve' | 'requestChanges' | 'comment', body: string): Promise<void> {
		if (event !== 'comment') {
			const me = await this.identity(repo.owner);
			await this.http.json('PUT', `${this.pr(repo, number)}/reviewers/${encodeURIComponent(me.id)}`, { query: this.q(), body: { vote: event === 'approve' ? 10 : -5 } });
		}
		if (body.trim()) {
			await this.comment(repo, number, body);
		}
	}

	async postReview(repo: IVoltPrRepoRef, number: number, body: string, comments: readonly IVoltPrLineComment[]): Promise<{ posted: number; url?: string }> {
		let posted = 0;
		for (const comment of comments) {
			await this.http.json('POST', `${this.pr(repo, number)}/threads`, {
				query: this.q(),
				body: {
					comments: [{ parentCommentId: 0, content: comment.body, commentType: 'text' }],
					status: 'active',
					threadContext: { filePath: `/${comment.path}`, rightFileStart: { line: comment.line, offset: 1 }, rightFileEnd: { line: comment.line, offset: 1 } },
				},
			});
			posted++;
		}
		if (body.trim()) {
			await this.comment(repo, number, body);
		}
		return { posted };
	}

	/** Azure DevOps has no patch API: files and blob ids only (open it in a local clone for the diff). */
	async filePatches(repo: IVoltPrRepoRef, number: number, commit?: string): Promise<IVoltPrFilePatch[]> {
		if (commit) {
			this.unsupported('show one commit\'s changes without a local clone');
		}
		const entries = await this.changes(repo, number);
		const files = parseAzureChanges(entries);
		return files.map((file, index) => {
			const objectId = String(entries.filter(entry => !entry.item?.isFolder && entry.item?.gitObjectType !== 'tree')[index]?.item?.objectId ?? '').toLowerCase();
			return { path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), change: file.change, additions: 0, deletions: 0, ...(file.change !== 'deleted' && /^[0-9a-f]{40}$/.test(objectId) ? { blob: objectId } : {}) };
		});
	}

	async readBlob(repo: IVoltPrRepoRef, ref: string): Promise<string> {
		const byPath = parseCommitPathRef(ref);
		if (byPath) {
			return this.http.text(`${this.repoPath(repo)}/items`, this.q({ path: `/${byPath.path}`, 'versionDescriptor.version': byPath.commit, 'versionDescriptor.versionType': 'commit', '$format': 'text' }));
		}
		return this.http.text(`${this.repoPath(repo)}/blobs/${ref}`, this.q({ '$format': 'text' }));
	}

	async remoteBranches(repo: IVoltPrRepoRef): Promise<string[]> {
		const [repoRaw, refs] = await Promise.all([
			this.http.get<{ readonly defaultBranch?: unknown } | undefined>(this.repoPath(repo), this.q()),
			this.http.get<IAzureListJson<{ readonly name?: unknown } | undefined> | undefined>(`${this.repoPath(repo)}/refs`, this.q({ filter: 'heads/', '$top': 300 })),
		]);
		const names = (Array.isArray(refs?.value) ? refs.value : []).map(ref => azureBranch(ref?.name)).filter(Boolean);
		const main = azureBranch(repoRaw?.defaultBranch);
		return main ? [main, ...names.filter(name => name !== main)] : names;
	}

	/** Unused by the API path; the org part of a repository, for callers that sign in per organization. */
	organization(repo: Pick<IVoltPrRepoRef, 'owner'>): string {
		return this.org(repo);
	}
}
