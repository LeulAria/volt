/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { SequencerByKey } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import {
	apiHost,
	classifyGhError,
	ghErrorText,
	gqlString,
	parseCheckRun,
	parseFile,
	parseFilePatch,
	parseGitStatusV2,
	parseNumstat,
	parsePullRequest,
	parsePullRequestDetail,
	parseRemoteUrl,
	PR_SUMMARY_FRAGMENT,
	providerForHost,
	providerLabel,
} from '../common/voltPullRequestParse.js';
import {
	IVoltBranchSummary,
	IVoltChangesSummary,
	IVoltGitCommitRequest,
	IVoltGitCommitResult,
	IVoltGitStatus,
	IVoltPrAccount,
	IVoltPrAuth,
	IVoltPrBranchRequest,
	IVoltPrCheck,
	IVoltPrCreateRequest,
	IVoltPrFetchResult,
	IVoltPrFile,
	IVoltPrFilePatch,
	IVoltPrListRequest,
	IVoltPrMergeRequest,
	IVoltPrPushResult,
	IVoltPrRepo,
	IVoltPrRepoRef,
	IVoltPrRequest,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	IVoltPullRequestService,
	VoltPrError,
} from '../common/voltPullRequests.js';

const GH_TIMEOUT_MS = 45_000;
const GIT_TIMEOUT_MS = 120_000;
/** Pull requests per batched GraphQL read; GitHub's node limit leaves room for 100 checks each. */
const BATCH_SIZE = 20;
/** Accounts and tokens stay cached this long; `refreshAccounts` drops them early. */
const ACCOUNT_TTL_MS = 5 * 60_000;
const MAX_FILES = 3000;

/** Leaked into child processes from a parent git hook, these would point commands at the wrong repo. */
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_COMMON_DIR'];
/** Tokens from the environment would override the account the user picked. */
const SCRUBBED_GH_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED', 'GH_PAGER', 'PAGER'];

interface IRunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly spawnError?: string;
	readonly timedOut: boolean;
}

/** A command that had nothing to say (skipped on a repository without commits). */
const EMPTY_RUN: IRunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

interface IRunOptions {
	readonly cwd?: string;
	readonly input?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
}

type Json = any;

export class VoltPullRequestService extends Disposable implements IVoltPullRequestService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAccounts = this._register(new Emitter<void>());
	readonly onDidChangeAccounts = this._onDidChangeAccounts.event;

	private baseEnv: Promise<NodeJS.ProcessEnv> | undefined;
	private accountCache: { at: number; accounts: Promise<IVoltPrAccount[]> } | undefined;
	private readonly tokens = new Map<string, { at: number; token: Promise<string | undefined> }>();
	private readonly viewers = new Map<string, { at: number; login: Promise<string> }>();
	/** Git writes into one clone run one at a time (fetch into hidden refs, push). */
	private readonly gitQueue = new SequencerByKey<string>();

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService?: ILogService,
		private readonly ghCommand = 'gh',
	) {
		super();
	}

	//#region Accounts

	async accounts(host?: string): Promise<IVoltPrAccount[]> {
		const now = Date.now();
		if (!this.accountCache || now - this.accountCache.at > ACCOUNT_TTL_MS) {
			const accounts = this.readAccounts();
			const entry = { at: now, accounts };
			this.accountCache = entry;
			// A read that found nobody (gh timed out, offline) is not kept: the next call asks again.
			void accounts.then(found => {
				if (!found.length && this.accountCache === entry) {
					this.accountCache = undefined;
				}
			});
		}
		const all = await this.accountCache.accounts;
		return host ? all.filter(account => account.host === apiHost(host)) : all;
	}

	async refreshAccounts(): Promise<void> {
		this.accountCache = undefined;
		this.tokens.clear();
		this.viewers.clear();
		this._onDidChangeAccounts.fire();
	}

	private async readAccounts(): Promise<IVoltPrAccount[]> {
		let result = await this.run(this.ghCommand, ['auth', 'status', '--json', 'hosts'], { timeoutMs: 15_000 });
		if (result.spawnError) {
			return [];
		}
		try {
			const parsed = JSON.parse(result.stdout) as { hosts?: Record<string, Json[]> };
			if (!parsed || typeof parsed !== 'object') {
				throw new Error('not json');
			}
			const accounts: IVoltPrAccount[] = [];
			for (const [host, entries] of Object.entries(parsed.hosts ?? {})) {
				for (const entry of entries ?? []) {
					if (typeof entry?.login !== 'string') {
						continue;
					}
					accounts.push({
						host: host.toLowerCase(),
						login: entry.login,
						active: !!entry.active,
						ok: entry.state === 'success',
						...(typeof entry.scopes === 'string' ? { scopes: entry.scopes } : {}),
					});
				}
			}
			return accounts;
		} catch {
			// gh before 2.66 has no --json (it answers "unknown flag"): ask again for the text form,
			// "Logged in to host account login".
			result = await this.run(this.ghCommand, ['auth', 'status'], { timeoutMs: 15_000 });
			const accounts: IVoltPrAccount[] = [];
			let host = '';
			for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
				const header = /^\s*([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(line);
				if (header) {
					host = header[1].toLowerCase();
					continue;
				}
				const login = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line);
				if (login) {
					accounts.push({ host: login[1].toLowerCase() || host, login: login[2].replace(/[()]/g, ''), active: !/Active account: false/.test(line), ok: true });
				}
			}
			return accounts;
		}
	}

	/** The account a call runs as: the one asked for, else the host's active one. */
	private async accountFor(host: string, account: string | undefined): Promise<IVoltPrAccount> {
		const accounts = await this.accounts(host);
		const picked = account ? accounts.find(candidate => candidate.login.toLowerCase() === account.toLowerCase()) : undefined;
		const chosen = picked ?? accounts.find(candidate => candidate.active) ?? accounts[0];
		if (!chosen) {
			const cli = await this.run(this.ghCommand, ['--version'], { timeoutMs: 10_000 });
			if (cli.spawnError) {
				throw new VoltPrError('noCli', 'Install the GitHub CLI (gh) to work with pull requests.');
			}
			throw new VoltPrError('noAuth', `Sign in to ${apiHost(host)} with the GitHub CLI: gh auth login --hostname ${apiHost(host)}`);
		}
		return chosen;
	}

	private async tokenFor(host: string, login: string): Promise<string | undefined> {
		const key = `${host}\u0000${login}`;
		const now = Date.now();
		let entry = this.tokens.get(key);
		if (!entry || now - entry.at > ACCOUNT_TTL_MS) {
			const token = this.run(this.ghCommand, ['auth', 'token', '--hostname', host, '--user', login], { timeoutMs: 15_000 })
				.then(result => result.code === 0 ? result.stdout.trim() || undefined : undefined);
			entry = { at: now, token };
			this.tokens.set(key, entry);
		}
		return entry.token;
	}

	/** Environment that pins a `gh` call to one host and account. */
	private async authEnv(host: string, auth: IVoltPrAuth): Promise<{ env: Record<string, string>; login: string }> {
		const api = apiHost(host);
		const githubHosts = new Set((await this.accounts()).map(account => account.host));
		const provider = providerForHost(api, githubHosts);
		if (provider !== 'github' && provider !== 'unknown') {
			throw unsupportedProviderError(provider);
		}
		const account = await this.accountFor(api, auth.account);
		const token = await this.tokenFor(api, account.login);
		const env: Record<string, string> = { GH_HOST: api };
		if (token) {
			if (api === 'github.com') {
				env.GH_TOKEN = token;
			} else {
				env.GH_ENTERPRISE_TOKEN = token;
			}
		}
		return { env, login: account.login };
	}

	//#endregion

	//#region Repositories

	async resolveRepo(folder: string): Promise<IVoltPrRepo | undefined> {
		const top = await this.run('git', ['rev-parse', '--show-toplevel'], { cwd: folder, timeoutMs: 15_000 });
		if (top.code !== 0) {
			return undefined;
		}
		const root = top.stdout.trim();
		const [branchOut, upstreamOut, remotesOut] = await Promise.all([
			this.run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, timeoutMs: 15_000 }),
			this.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, timeoutMs: 15_000 }),
			this.run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd: root, timeoutMs: 15_000 }),
		]);
		const branch = branchOut.code === 0 ? branchOut.stdout.trim() || undefined : undefined;
		const remotes = new Map<string, string>();
		for (const line of remotesOut.stdout.split('\n')) {
			const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
			if (match && !remotes.has(match[1])) {
				remotes.set(match[1], match[2]);
			}
		}
		let upstreamRemote: string | undefined;
		let upstream: string | undefined;
		if (upstreamOut.code === 0) {
			const full = upstreamOut.stdout.trim();
			upstreamRemote = [...remotes.keys()].filter(name => full.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
			upstream = upstreamRemote ? full.slice(upstreamRemote.length + 1) : undefined;
		}
		const remote = upstreamRemote ?? (remotes.has('origin') ? 'origin' : [...remotes.keys()][0]);
		const url = remote ? remotes.get(remote) : undefined;
		if (!remote || !url) {
			return undefined;
		}
		const githubHosts = new Set((await this.accounts().catch(() => [] as IVoltPrAccount[])).map(account => account.host));
		const parsed = parseRemoteUrl(url, githubHosts);
		if (!parsed) {
			return undefined;
		}
		let ahead: number | undefined;
		let behind: number | undefined;
		if (upstream) {
			const counts = await this.run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: root, timeoutMs: 15_000 });
			const match = /^(\d+)\s+(\d+)/.exec(counts.stdout.trim());
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
		}
		const host = apiHost(parsed.host);
		return {
			provider: parsed.provider,
			host,
			owner: parsed.owner,
			name: parsed.name,
			webUrl: `https://${host}/${parsed.owner}/${parsed.name}`,
			remote,
			root,
			...(branch ? { branch } : {}),
			...(upstream ? { upstream } : {}),
			...(ahead !== undefined ? { ahead } : {}),
			...(behind !== undefined ? { behind } : {}),
		};
	}

	async remoteBranches(request: IVoltPrAuth & { readonly repo: IVoltPrRepoRef }): Promise<string[]> {
		const data = await this.graphql(request.repo.host, request, `query($owner: String!, $name: String!) {
			repository(owner: $owner, name: $name) {
				defaultBranchRef { name }
				refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }
			}
		}`, { owner: request.repo.owner, name: request.repo.name });
		const repo = data.repository;
		const names: string[] = (repo?.refs?.nodes ?? []).map((node: Json) => node?.name).filter((name: unknown): name is string => typeof name === 'string');
		const main = repo?.defaultBranchRef?.name;
		return typeof main === 'string' ? [main, ...names.filter(name => name !== main)] : names;
	}

	//#endregion

	//#region Reads

	async list(request: IVoltPrListRequest): Promise<IVoltPullRequest[]> {
		const states = request.state === 'open' ? '[OPEN]' : request.state === 'closed' ? '[CLOSED, MERGED]' : '[OPEN, CLOSED, MERGED]';
		const limit = Math.max(1, Math.min(100, request.limit ?? 50));
		const { data, login } = await this.graphqlAs(request.repo.host, request, `query($owner: String!, $name: String!) {
			viewer { login }
			repository(owner: $owner, name: $name) {
				pullRequests(first: ${limit}, states: ${states}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...VoltPr } }
			}
		}
		${PR_SUMMARY_FRAGMENT}`, { owner: request.repo.owner, name: request.repo.name });
		const viewer = data.viewer?.login ?? login;
		return (data.repository?.pullRequests?.nodes ?? []).filter(Boolean).map((node: Json) => parsePullRequest(node, request.repo, viewer));
	}

	async forBranch(request: IVoltPrBranchRequest): Promise<IVoltPullRequest[]> {
		const { data, login } = await this.graphqlAs(request.repo.host, request, `query($owner: String!, $name: String!, $branch: String!) {
			viewer { login }
			repository(owner: $owner, name: $name) {
				pullRequests(first: 10, headRefName: $branch, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...VoltPr } }
			}
		}
		${PR_SUMMARY_FRAGMENT}`, { owner: request.repo.owner, name: request.repo.name, branch: request.branch });
		const viewer = data.viewer?.login ?? login;
		const found = (data.repository?.pullRequests?.nodes ?? []).filter(Boolean).map((node: Json) => parsePullRequest(node, request.repo, viewer)) as IVoltPullRequest[];
		const owner = request.headOwner?.toLowerCase();
		const mine = owner ? found.filter(pr => (pr.headOwner ?? request.repo.owner).toLowerCase() === owner) : found;
		// The open one first, then the most recent.
		return mine.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt - a.createdAt);
	}

	async getMany(requests: readonly IVoltPrRequest[]): Promise<IVoltPullRequest[]> {
		const groups = new Map<string, IVoltPrRequest[]>();
		for (const request of requests) {
			const key = `${apiHost(request.repo.host)}\u0000${request.account ?? ''}`;
			const group = groups.get(key) ?? [];
			if (!group.some(other => sameRepo(other.repo, request.repo) && other.number === request.number)) {
				group.push(request);
			}
			groups.set(key, group);
		}
		const results: IVoltPullRequest[] = [];
		const errors: unknown[] = [];
		await Promise.all([...groups.values()].map(async group => {
			for (let start = 0; start < group.length; start += BATCH_SIZE) {
				const batch = group.slice(start, start + BATCH_SIZE);
				try {
					results.push(...await this.readBatch(batch));
				} catch (err) {
					errors.push(err);
				}
			}
		}));
		// A batch that failed whole (auth, network) fails the call when nothing came back at all.
		if (!results.length && errors.length) {
			throw errors[0];
		}
		return results;
	}

	private async readBatch(batch: readonly IVoltPrRequest[]): Promise<IVoltPullRequest[]> {
		const repos: { repo: IVoltPrRepoRef; numbers: number[] }[] = [];
		for (const request of batch) {
			let entry = repos.find(candidate => sameRepo(candidate.repo, request.repo));
			if (!entry) {
				entry = { repo: request.repo, numbers: [] };
				repos.push(entry);
			}
			entry.numbers.push(request.number);
		}
		const fields = repos.map((entry, r) => `r${r}: repository(owner: ${gqlString(entry.repo.owner)}, name: ${gqlString(entry.repo.name)}) {
			${entry.numbers.map(number => `p${number}: pullRequest(number: ${number}) { ...VoltPr }`).join('\n')}
		}`).join('\n');
		const { data, login } = await this.graphqlAs(batch[0].repo.host, batch[0], `query { viewer { login } ${fields} }
		${PR_SUMMARY_FRAGMENT}`, {}, true);
		const viewer = data.viewer?.login ?? login;
		const out: IVoltPullRequest[] = [];
		repos.forEach((entry, r) => {
			for (const number of entry.numbers) {
				const node = data[`r${r}`]?.[`p${number}`];
				if (node) {
					out.push(parsePullRequest(node, entry.repo, viewer));
				}
			}
		});
		return out;
	}

	async detail(request: IVoltPrRequest): Promise<IVoltPullRequestDetail> {
		const { data, login } = await this.graphqlAs(request.repo.host, request, `query($owner: String!, $name: String!, $number: Int!) {
			viewer { login }
			repository(owner: $owner, name: $name) {
				viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge autoMergeAllowed
				labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color } }
				pullRequest(number: $number) {
					...VoltPr
					body baseRefOid viewerCanUpdate
					reviewThreadsFull: reviewThreads(first: 100) { nodes {
						id path line originalLine startLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve
						comments(first: 50) { nodes { id databaseId author { login avatarUrl __typename } body createdAt publishedAt url outdated diffHunk } }
					} }
					reviewList: reviews(last: 50) { nodes { id author { login avatarUrl __typename } state body submittedAt createdAt url } }
					conversation: comments(last: 100) { nodes { id databaseId author { login avatarUrl __typename } body createdAt publishedAt url } }
					commitList: commits(last: 100) { nodes { commit { oid messageHeadline committedDate authoredDate author { name user { login } } statusCheckRollup { state } } } }
					headChecks: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
						__typename
						... on CheckRun { name status conclusion detailsUrl startedAt completedAt title isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } app { name } } }
						... on StatusContext { context state targetUrl description createdAt isRequired(pullRequestNumber: $number) }
					} } } } } }
				}
			}
		}
		${PR_SUMMARY_FRAGMENT}`, { owner: request.repo.owner, name: request.repo.name, number: request.number });
		const repoRaw = data.repository;
		const raw = repoRaw?.pullRequest;
		if (!raw) {
			throw new VoltPrError('notFound', `Pull request #${request.number} was not found in ${request.repo.owner}/${request.repo.name}.`);
		}
		const viewer = data.viewer?.login ?? login;
		const checks = (raw.headChecks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [])
			.map(parseCheckRun).filter((check: IVoltPrCheck | undefined): check is IVoltPrCheck => !!check);
		const files = await this.files(request, raw.id);
		return parsePullRequestDetail(raw, repoRaw, request.repo, viewer, { files, checks });
	}

	/** Every changed file with its viewed state, paged past GitHub's 100 per page. */
	private async files(request: IVoltPrRequest, _id: string): Promise<IVoltPrFile[]> {
		const files: IVoltPrFile[] = [];
		let after: string | undefined;
		while (files.length < MAX_FILES) {
			const data = await this.graphql(request.repo.host, request, `query($owner: String!, $name: String!, $number: Int!, $after: String) {
				repository(owner: $owner, name: $name) { pullRequest(number: $number) {
					files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path additions deletions changeType viewerViewedState } }
				} }
			}`, { owner: request.repo.owner, name: request.repo.name, number: request.number, ...(after ? { after } : {}) });
			const page = data.repository?.pullRequest?.files;
			for (const node of page?.nodes ?? []) {
				if (node) {
					files.push(parseFile(node));
				}
			}
			if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) {
				break;
			}
			after = page.pageInfo.endCursor;
		}
		await this.fillRenames(request, files);
		return files;
	}

	/** GraphQL leaves out where a renamed file came from; the REST list has it. */
	private async fillRenames(request: IVoltPrRequest, files: IVoltPrFile[]): Promise<void> {
		if (!files.some(file => file.change === 'renamed' || file.change === 'copied')) {
			return;
		}
		try {
			const out = await this.rest(request.repo.host, request, 'GET', `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}/files?per_page=100`, undefined, ['--paginate', '--slurp']);
			const pages = Array.isArray(out) ? out.flat() : [];
			const previous = new Map<string, string>();
			for (const entry of pages) {
				if (typeof entry?.filename === 'string' && typeof entry?.previous_filename === 'string') {
					previous.set(entry.filename, entry.previous_filename);
				}
			}
			for (let i = 0; i < files.length; i++) {
				const from = previous.get(files[i].path);
				if (from) {
					files[i] = { ...files[i], previousPath: from };
				}
			}
		} catch (err) {
			this.logService?.trace('[volt-pr] could not read renamed files', err);
		}
	}

	//#endregion

	//#region Writes

	async create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest> {
		const head = request.headOwner && request.headOwner.toLowerCase() !== request.repo.owner.toLowerCase() ? `${request.headOwner}:${request.head}` : request.head;
		const created = await this.rest(request.repo.host, request, 'POST', `repos/${request.repo.owner}/${request.repo.name}/pulls`, {
			title: request.title,
			body: request.body,
			head,
			base: request.base,
			draft: request.draft,
		});
		const number = typeof created?.number === 'number' ? created.number : undefined;
		if (!number) {
			throw new VoltPrError('failed', 'GitHub did not return the new pull request.');
		}
		const [pr] = await this.getMany([{ repo: request.repo, number, ...(request.account ? { account: request.account } : {}) }]);
		if (!pr) {
			throw new VoltPrError('failed', `Created #${number}, but could not read it back.`);
		}
		return pr;
	}

	async merge(request: IVoltPrMergeRequest): Promise<void> {
		const id = await this.nodeId(request);
		const method = request.method.toUpperCase();
		if (request.auto) {
			await this.mutate(request, `mutation($id: ID!, $method: PullRequestMergeMethod!) {
				enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId }
			}`, { id, method });
			return;
		}
		await this.mutate(request, `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID, $headline: String, $body: String) {
			mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid, commitHeadline: $headline, commitBody: $body }) { pullRequest { state } }
		}`, {
			id,
			method,
			...(request.headOid ? { oid: request.headOid } : {}),
			...(request.subject ? { headline: request.subject } : {}),
			...(request.body !== undefined ? { body: request.body } : {}),
		});
		if (request.deleteBranch) {
			await this.deleteHeadBranch(request).catch(err => this.logService?.warn('[volt-pr] merged, but could not delete the head branch', err));
		}
	}

	/** Deletes the merged head branch on the remote. Branches in forks and protected ones stay. */
	private async deleteHeadBranch(request: IVoltPrRequest): Promise<void> {
		const data = await this.graphql(request.repo.host, request, `query($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefName isCrossRepository headRef { id } } }
		}`, { owner: request.repo.owner, name: request.repo.name, number: request.number });
		const pr = data.repository?.pullRequest;
		if (!pr || pr.isCrossRepository || !pr.headRef?.id) {
			return;
		}
		await this.mutate(request, `mutation($id: ID!) { deleteRef(input: { refId: $id }) { clientMutationId } }`, { id: pr.headRef.id });
	}

	async cancelAutoMerge(request: IVoltPrRequest): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
	}

	async updateBranch(request: IVoltPrRequest & { readonly rebase: boolean }): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!, $method: PullRequestBranchUpdateMethod) {
			updatePullRequestBranch(input: { pullRequestId: $id, updateMethod: $method }) { clientMutationId }
		}`, { id, method: request.rebase ? 'REBASE' : 'MERGE' });
	}

	async setDraft(request: IVoltPrRequest & { readonly draft: boolean }): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, request.draft
			? `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`
			: `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
	}

	async setState(request: IVoltPrRequest & { readonly state: 'open' | 'closed' }): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, request.state === 'closed'
			? `mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`
			: `mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
	}

	async setBase(request: IVoltPrRequest & { readonly base: string }): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!, $base: String!) { updatePullRequest(input: { pullRequestId: $id, baseRefName: $base }) { clientMutationId } }`, { id, base: request.base });
	}

	async setLabels(request: IVoltPrRequest & { readonly add: readonly string[]; readonly remove: readonly string[] }): Promise<void> {
		const path = `repos/${request.repo.owner}/${request.repo.name}/issues/${request.number}/labels`;
		if (request.add.length) {
			await this.rest(request.repo.host, request, 'POST', path, { labels: request.add });
		}
		for (const label of request.remove) {
			await this.rest(request.repo.host, request, 'DELETE', `${path}/${encodeURIComponent(label)}`).catch(err => {
				// Already gone is what we wanted.
				if (!/404|not found/i.test(String(err?.message))) {
					throw err;
				}
			});
		}
	}

	async setViewed(request: IVoltPrRequest & { readonly path: string; readonly viewed: boolean }): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, request.viewed
			? `mutation($id: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
			: `mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id, path: request.path });
	}

	async comment(request: IVoltPrRequest & { readonly body: string }): Promise<void> {
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }`, { id, body: request.body });
	}

	async reply(request: IVoltPrRequest & { readonly threadId: string; readonly body: string }): Promise<void> {
		await this.mutate(request, `mutation($thread: ID!, $body: String!) {
			addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { clientMutationId }
		}`, { thread: request.threadId, body: request.body });
	}

	async resolveThread(request: IVoltPrRequest & { readonly threadId: string; readonly resolved: boolean }): Promise<void> {
		await this.mutate(request, request.resolved
			? `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { clientMutationId } }`
			: `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { clientMutationId } }`, { thread: request.threadId });
	}

	async review(request: IVoltPrRequest & { readonly event: 'approve' | 'requestChanges' | 'comment'; readonly body: string }): Promise<void> {
		const id = await this.nodeId(request);
		const event = request.event === 'approve' ? 'APPROVE' : request.event === 'requestChanges' ? 'REQUEST_CHANGES' : 'COMMENT';
		await this.mutate(request, `mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
			addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) { clientMutationId }
		}`, { id, event, ...(request.body ? { body: request.body } : {}) });
	}

	async requestReviewers(request: IVoltPrRequest & { readonly logins: readonly string[] }): Promise<void> {
		if (!request.logins.length) {
			return;
		}
		const users = request.logins.filter(login => !login.includes('/'));
		const teams = request.logins.filter(login => login.includes('/')).map(team => team.split('/').pop()!);
		await this.rest(request.repo.host, request, 'POST', `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}/requested_reviewers`, {
			reviewers: users,
			team_reviewers: teams,
		});
	}

	async rerunFailedChecks(request: IVoltPrRequest): Promise<number> {
		const [pr] = await this.getMany([request]);
		if (!pr) {
			throw new VoltPrError('notFound', `Pull request #${request.number} was not found.`);
		}
		const runs = await this.rest(request.repo.host, request, 'GET', `repos/${request.repo.owner}/${request.repo.name}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`);
		const failed = (runs?.workflow_runs ?? []).filter((run: Json) => run?.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(run?.conclusion));
		let started = 0;
		for (const run of failed) {
			try {
				await this.rest(request.repo.host, request, 'POST', `repos/${request.repo.owner}/${request.repo.name}/actions/runs/${run.id}/rerun-failed-jobs`);
				started++;
			} catch (err) {
				this.logService?.warn(`[volt-pr] could not re-run workflow run ${run.id}`, err);
			}
		}
		return started;
	}

	//#endregion

	//#region Git

	async fetch(request: IVoltPrRequest & { readonly folder: string }): Promise<IVoltPrFetchResult> {
		const repo = await this.resolveRepo(request.folder);
		if (!repo) {
			throw new VoltPrError('notFound', 'This folder is not a clone of the pull request\'s repository.');
		}
		const [pr] = await this.getMany([request]);
		if (!pr) {
			throw new VoltPrError('notFound', `Pull request #${request.number} was not found.`);
		}
		const remote = await this.remoteFor(repo.root, request.repo) ?? repo.remote;
		const ref = `refs/volt/pr/${request.number}`;
		return this.gitQueue.queue(repo.root, async () => {
			// Pull requests are fetched by number, so forks and deleted head branches work too.
			const fetched = await this.run('git', [
				'-c', 'credential.interactive=never', 'fetch', '--no-tags', '--no-write-fetch-head', '--quiet', remote,
				`+refs/pull/${request.number}/head:${ref}/head`,
				`+refs/heads/${pr.baseRefName}:${ref}/base`,
			], { cwd: repo.root, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
			if (fetched.code !== 0) {
				const code = classifyGhError(fetched.stderr, fetched.code, fetched.spawnError);
				throw new VoltPrError(code === 'notFound' ? 'notFound' : code === 'noAuth' ? 'noAuth' : 'network', `git fetch failed: ${ghErrorText(fetched.stderr)}`);
			}
			const base = await this.run('git', ['merge-base', `${ref}/base`, `${ref}/head`], { cwd: repo.root, timeoutMs: 30_000 });
			const head = await this.run('git', ['rev-parse', `${ref}/head`], { cwd: repo.root, timeoutMs: 15_000 });
			if (head.code !== 0) {
				throw new VoltPrError('failed', 'The pull request\'s head could not be read after fetching it.');
			}
			// Unrelated histories have no merge base: compare against the base branch tip.
			const baseOid = base.code === 0 ? base.stdout.trim() : (await this.run('git', ['rev-parse', `${ref}/base`], { cwd: repo.root })).stdout.trim();
			return { base: baseOid, head: head.stdout.trim() };
		});
	}

	/** The remote of `folder` that points at `repo`, so a fork's clone fetches from the right place. */
	private async remoteFor(folder: string, repo: IVoltPrRepoRef): Promise<string | undefined> {
		const remotes = await this.run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd: folder, timeoutMs: 15_000 });
		for (const line of remotes.stdout.split('\n')) {
			const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
			const parsed = match ? parseRemoteUrl(match[2]) : undefined;
			if (match && parsed && apiHost(parsed.host) === apiHost(repo.host) && parsed.owner.toLowerCase() === repo.owner.toLowerCase() && parsed.name.toLowerCase() === repo.name.toLowerCase()) {
				return match[1];
			}
		}
		return undefined;
	}

	async push(request: { readonly folder: string; readonly remote?: string }): Promise<IVoltPrPushResult> {
		const repo = await this.resolveRepo(request.folder);
		if (!repo) {
			throw new VoltPrError('notFound', 'This folder has no git remote to push to.');
		}
		if (!repo.branch) {
			throw new VoltPrError('failed', 'Check out a branch before pushing (HEAD is detached).');
		}
		const remote = request.remote ?? repo.remote;
		// A branch made from origin/main tracks main: pushing to its upstream would push onto main.
		// It goes to a branch of its own name instead, which becomes its upstream.
		const setUpstream = !repo.upstream || repo.upstream !== repo.branch || remote !== repo.remote;
		return this.gitQueue.queue(repo.root, async () => {
			// Always an explicit remote and branch: a bare push follows push.default (matching pushes
			// every branch) and pushRemote, which can differ from the remote reported and opened against.
			const args = ['push', '--porcelain', ...(setUpstream ? ['-u'] : []), remote, `HEAD:refs/heads/${repo.branch}`];
			const pushed = await this.run('git', ['-c', 'credential.interactive=never', ...args], { cwd: repo.root, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
			if (pushed.code !== 0) {
				const text = `${pushed.stderr}\n${pushed.stdout}`;
				if (/rejected|non-fast-forward|fetch first/i.test(text)) {
					throw new VoltPrError('conflict', `The remote has commits this branch does not. Pull them first. ${ghErrorText(pushed.stderr)}`);
				}
				throw new VoltPrError(classifyGhError(pushed.stderr, pushed.code, pushed.spawnError) === 'noAuth' ? 'noAuth' : 'failed', `git push failed: ${ghErrorText(pushed.stderr)}`);
			}
			return { branch: repo.branch!, remote, setUpstream };
		});
	}

	async describeChanges(request: { readonly folder: string; readonly paths?: readonly string[] }): Promise<IVoltChangesSummary> {
		const cwd = request.folder;
		const git = (args: string[], timeoutMs = 30_000) => this.run('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=off', ...args], { cwd, timeoutMs });
		if (request.paths) {
			return this.describePaths(request.paths.filter(path => !!path), git);
		}
		const [branchOut, stagedNames, logOut] = await Promise.all([
			git(['symbolic-ref', '--short', '-q', 'HEAD']),
			git(['diff', '--cached', '--name-status', '-M']),
			git(['log', '-n', '10', '--format=%s']),
		]);
		const branch = branchOut.code === 0 ? branchOut.stdout.trim() || undefined : undefined;
		const recentSubjects = logOut.code === 0 ? logOut.stdout.split('\n').map(line => line.trim()).filter(Boolean) : [];
		if (stagedNames.code === 0 && stagedNames.stdout.trim()) {
			const patch = await git(['diff', '--cached', '--no-ext-diff', '--patch', '--minimal', '-M']);
			return { ...(branch ? { branch } : {}), staged: true, files: stagedNames.stdout.trim(), patch: patch.stdout, recentSubjects };
		}
		// Nothing staged: Commit stages everything, so describe everything uncommitted.
		const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
		const [names, patch, untracked] = await Promise.all([
			hasHead ? git(['diff', 'HEAD', '--name-status', '-M']) : Promise.resolve(EMPTY_RUN),
			hasHead ? git(['diff', 'HEAD', '--no-ext-diff', '--patch', '--minimal', '-M']) : Promise.resolve(EMPTY_RUN),
			git(['ls-files', '--others', '--exclude-standard']),
		]);
		const added = untracked.stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 200).map(path => `A\t${path}`);
		return {
			...(branch ? { branch } : {}),
			staged: false,
			files: [names.stdout.trim(), ...added].filter(Boolean).join('\n'),
			patch: patch.stdout,
			recentSubjects,
		};
	}

	/** Exactly these paths against HEAD (what `commit` with paths records), untracked ones as added. */
	private async describePaths(paths: readonly string[], git: (args: string[]) => Promise<IRunResult>): Promise<IVoltChangesSummary> {
		const [branchOut, logOut, hasHead] = await Promise.all([
			git(['symbolic-ref', '--short', '-q', 'HEAD']),
			git(['log', '-n', '10', '--format=%s']),
			git(['rev-parse', '--verify', '-q', 'HEAD']).then(result => result.code === 0),
		]);
		const branch = branchOut.code === 0 ? branchOut.stdout.trim() || undefined : undefined;
		const recentSubjects = logOut.code === 0 ? logOut.stdout.split('\n').map(line => line.trim()).filter(Boolean) : [];
		if (!paths.length) {
			return { ...(branch ? { branch } : {}), staged: false, files: '', patch: '', recentSubjects };
		}
		const spec = ['--', ...paths];
		const [names, patch, untracked] = await Promise.all([
			hasHead ? git(['diff', 'HEAD', '--name-status', '-M', ...spec]) : Promise.resolve(EMPTY_RUN),
			hasHead ? git(['diff', 'HEAD', '--no-ext-diff', '--patch', '--minimal', '-M', ...spec]) : Promise.resolve(EMPTY_RUN),
			git(['ls-files', '--others', '--exclude-standard', ...spec]),
		]);
		const added = untracked.stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 200).map(path => `A\t${path}`);
		return {
			...(branch ? { branch } : {}),
			staged: false,
			files: [names.stdout.trim(), ...added].filter(Boolean).join('\n'),
			patch: patch.stdout,
			recentSubjects,
		};
	}

	async describeBranch(request: { readonly folder: string; readonly base: string }): Promise<IVoltBranchSummary> {
		const cwd = request.folder;
		const git = (args: string[]) => this.run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs: 30_000 });
		const repo = await this.resolveRepo(cwd);
		if (!repo?.branch) {
			throw new VoltPrError('failed', 'Check out a branch to describe it.');
		}
		if (!request.base || request.base.startsWith('-')) {
			throw new VoltPrError('failed', `Not a branch name: ${request.base}`);
		}
		const remoteBase = `${repo.remote}/${request.base}`;
		const base = (await git(['rev-parse', '--verify', '-q', `refs/remotes/${remoteBase}`])).code === 0 ? remoteBase : request.base;
		const range = `${base}...HEAD`;
		const [log, stat, patch] = await Promise.all([
			git(['log', '--reverse', '--format=%s', `${base}..HEAD`]),
			git(['diff', '--stat', range]),
			git(['diff', '--no-ext-diff', '--patch', '--minimal', range]),
		]);
		let template: string | undefined;
		for (const path of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'docs/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']) {
			const shown = await git(['show', `HEAD:${path}`]);
			if (shown.code === 0 && shown.stdout.trim()) {
				template = shown.stdout;
				break;
			}
		}
		return {
			head: repo.branch,
			base: request.base,
			commits: log.stdout.split('\n').map(line => line.trim()).filter(Boolean),
			stat: stat.stdout.trim(),
			patch: patch.stdout,
			...(template ? { template } : {}),
		};
	}

	async filePatches(request: IVoltPrRequest & { readonly commit?: string }): Promise<IVoltPrFilePatch[]> {
		if (request.commit && !/^[0-9a-f]{7,40}$/i.test(request.commit)) {
			throw new VoltPrError('failed', `Not a commit id: ${request.commit}`);
		}
		const path = request.commit
			? `repos/${request.repo.owner}/${request.repo.name}/commits/${request.commit}`
			: `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}/files?per_page=100`;
		const out = await this.rest(request.repo.host, request, 'GET', path, undefined, request.commit ? [] : ['--paginate', '--slurp']);
		const entries: Json[] = request.commit ? (Array.isArray(out?.files) ? out.files : []) : Array.isArray(out) ? out.flat() : [];
		return entries.slice(0, MAX_FILES).map(parseFilePatch).filter(file => !!file.path);
	}

	async gitStatus(folder: string): Promise<IVoltGitStatus | undefined> {
		const top = await this.run('git', ['rev-parse', '--show-toplevel'], { cwd: folder, timeoutMs: 15_000 });
		if (top.code !== 0) {
			return undefined;
		}
		const root = top.stdout.trim();
		// Read-only: never take index.lock, so a terminal `git commit` running now does not fail.
		const git = (args: string[]) => this.run('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], { cwd: root, timeoutMs: 30_000 });
		const [statusOut, remotesOut, hasHead] = await Promise.all([
			git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
			git(['remote']),
			git(['rev-parse', '--verify', '-q', 'HEAD']).then(result => result.code === 0),
		]);
		if (statusOut.code !== 0) {
			throw new VoltPrError('failed', `git status failed: ${ghErrorText(statusOut.stderr)}`);
		}
		const parsed = parseGitStatusV2(statusOut.stdout);
		const remotes = remotesOut.stdout.split('\n').map(line => line.trim()).filter(Boolean);
		const upstreamRemote = parsed.upstream ? remotes.filter(name => parsed.upstream!.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0] : undefined;
		const remote = upstreamRemote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
		const tracked = parsed.upstream && upstreamRemote ? parsed.upstream.slice(upstreamRemote.length + 1) : undefined;
		// Tracking another branch (made from origin/main) is not being pushed: the branch has no copy of its own yet.
		const upstream = tracked && tracked === parsed.branch ? tracked : undefined;
		let defaultBranch: string | undefined;
		if (remote) {
			const head = await git(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]);
			if (head.code === 0 && head.stdout.trim().startsWith(`${remote}/`)) {
				defaultBranch = head.stdout.trim().slice(remote.length + 1);
			} else {
				for (const candidate of ['main', 'master', 'trunk', 'develop']) {
					if ((await git(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${candidate}`])).code === 0) {
						defaultBranch = candidate;
						break;
					}
				}
			}
		}
		let aheadOfDefault: number | undefined;
		if (remote && defaultBranch && hasHead) {
			const count = await git(['rev-list', '--count', `refs/remotes/${remote}/${defaultBranch}..HEAD`]);
			if (count.code === 0 && /^\d+$/.test(count.stdout.trim())) {
				aheadOfDefault = Number(count.stdout.trim());
			}
		}
		if (aheadOfDefault === undefined && remote && hasHead && !upstream) {
			// No default branch known (an empty remote, no origin/HEAD): commits the remote has nowhere.
			const count = await git(['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`]);
			if (count.code === 0 && /^\d+$/.test(count.stdout.trim())) {
				aheadOfDefault = Number(count.stdout.trim());
			}
		}
		const stats = hasHead && parsed.files.length ? parseNumstat((await git(['diff', 'HEAD', '--numstat', '-z', '-M'])).stdout) : new Map<string, { additions: number; deletions: number }>();
		let insertions = 0;
		let deletions = 0;
		const files = parsed.files.map(file => {
			const stat = stats.get(file.path);
			insertions += stat?.additions ?? 0;
			deletions += stat?.deletions ?? 0;
			return stat ? { ...file, additions: stat.additions, deletions: stat.deletions } : file;
		});
		return {
			root,
			...(parsed.branch ? { branch: parsed.branch } : {}),
			...(parsed.head ? { head: parsed.head } : {}),
			...(remote ? { remote } : {}),
			...(upstream ? { upstream } : {}),
			ahead: upstream ? parsed.ahead : 0,
			behind: upstream ? parsed.behind : 0,
			...(defaultBranch ? { defaultBranch } : {}),
			isDefaultBranch: !!parsed.branch && parsed.branch === defaultBranch,
			...(aheadOfDefault !== undefined ? { aheadOfDefault } : {}),
			files,
			insertions,
			deletions,
		};
	}

	async commit(request: IVoltGitCommitRequest): Promise<IVoltGitCommitResult> {
		const message = request.message.trim();
		if (!message) {
			throw new VoltPrError('failed', 'The commit message is empty.');
		}
		const top = await this.run('git', ['rev-parse', '--show-toplevel'], { cwd: request.folder, timeoutMs: 15_000 });
		if (top.code !== 0) {
			throw new VoltPrError('notFound', 'This folder is not a git repository.');
		}
		const root = top.stdout.trim();
		const git = (args: string[], input?: string) => this.run('git', args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS, ...(input !== undefined ? { input } : {}) });
		const fail = (what: string, result: IRunResult) => new VoltPrError('failed', `${what} failed: ${ghErrorText(result.stderr || result.stdout)}`);
		return this.gitQueue.queue(root, async () => {
			// A merge or cherry-pick stopped on conflicts: `git add` would mark the markers resolved.
			const unmerged = await git(['--no-optional-locks', 'diff', '--name-only', '--diff-filter=U']);
			if (unmerged.code === 0 && unmerged.stdout.trim()) {
				throw new VoltPrError('conflict', `Resolve the merge conflicts first: ${unmerged.stdout.trim().split('\n').slice(0, 3).join(', ')}.`);
			}
			if (request.paths && !request.paths.some(path => !!path)) {
				throw new VoltPrError('failed', 'No files were chosen to commit.');
			}
			let created: string | undefined;
			if (request.newBranch) {
				validateBranchName(request.newBranch);
				const checkout = await git(['checkout', '-b', request.newBranch]);
				if (checkout.code !== 0) {
					throw fail('git checkout -b', checkout);
				}
				created = request.newBranch;
			}
			try {
				// Paths go through stdin, NUL-separated and literal: no length limit, and `[slug]` or a
				// leading `:` is a file name, not a pattern.
				const paths = request.paths?.filter(path => !!path);
				const pathInput = paths ? `${paths.join('\0')}\0` : undefined;
				const pathArgs = paths ? ['--pathspec-from-file=-', '--pathspec-file-nul'] : [];
				const added = await git(['--literal-pathspecs', 'add', '-A', ...pathArgs], pathInput);
				if (added.code !== 0) {
					throw fail('git add', added);
				}
				const committed = await git(['--literal-pathspecs', 'commit', '-m', message, ...pathArgs], pathInput);
				if (committed.code !== 0) {
					const text = `${committed.stdout}\n${committed.stderr}`;
					throw new VoltPrError('failed', /nothing (added )?to commit|no changes added/i.test(text) ? 'There is nothing to commit.' : `git commit failed: ${ghErrorText(committed.stderr || committed.stdout)}`);
				}
			} catch (err) {
				if (created) {
					// Back where the user was, with their changes: a failed commit leaves no stray branch.
					const back = await git(['checkout', '-']);
					if (back.code === 0) {
						await git(['branch', '-D', created]);
					}
				}
				throw err;
			}
			const [sha, branch] = await Promise.all([git(['rev-parse', 'HEAD']), git(['symbolic-ref', '--short', '-q', 'HEAD'])]);
			return {
				sha: sha.stdout.trim(),
				...(branch.code === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
				subject: message.split('\n')[0],
			};
		});
	}

	async pull(folder: string): Promise<{ readonly updated: boolean; readonly branch: string; readonly upstream: string }> {
		const status = await this.gitStatus(folder);
		if (!status?.branch) {
			throw new VoltPrError('failed', 'Check out a branch before pulling (HEAD is detached).');
		}
		if (!status.upstream || !status.remote) {
			throw new VoltPrError('failed', `${status.branch} has no upstream to pull from.`);
		}
		const upstream = `${status.remote}/${status.upstream}`;
		return this.gitQueue.queue(status.root, async () => {
			const pulled = await this.run('git', ['-c', 'credential.interactive=never', 'pull', '--ff-only', '--no-rebase'], { cwd: status.root, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
			if (pulled.code !== 0) {
				const text = `${pulled.stderr}\n${pulled.stdout}`;
				if (/not possible to fast-forward|diverg/i.test(text)) {
					throw new VoltPrError('conflict', `${status.branch} and ${upstream} have diverged. Rebase or merge first.`);
				}
				throw new VoltPrError(classifyGhError(pulled.stderr, pulled.code, pulled.spawnError) === 'noAuth' ? 'noAuth' : 'failed', `git pull failed: ${ghErrorText(pulled.stderr)}`);
			}
			return { updated: !/already up.to.date/i.test(pulled.stdout), branch: status.branch!, upstream };
		});
	}

	async checkoutNewBranch(request: { readonly folder: string; readonly name: string }): Promise<void> {
		validateBranchName(request.name);
		const created = await this.run('git', ['checkout', '-b', request.name], { cwd: request.folder, timeoutMs: 30_000 });
		if (created.code !== 0) {
			throw new VoltPrError('failed', `git checkout -b ${request.name} failed: ${ghErrorText(created.stderr)}`);
		}
	}

	//#endregion

	//#region Plumbing

	private async nodeId(request: IVoltPrRequest): Promise<string> {
		const data = await this.graphql(request.repo.host, request, `query($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
		}`, { owner: request.repo.owner, name: request.repo.name, number: request.number });
		const id = data.repository?.pullRequest?.id;
		if (typeof id !== 'string') {
			throw new VoltPrError('notFound', `Pull request #${request.number} was not found in ${request.repo.owner}/${request.repo.name}.`);
		}
		return id;
	}

	private async mutate(request: IVoltPrRequest, query: string, variables: Record<string, unknown>): Promise<Json> {
		return this.graphql(request.repo.host, request, query, variables);
	}

	private async graphql(host: string, auth: IVoltPrAuth, query: string, variables: Record<string, unknown>): Promise<Json> {
		return (await this.graphqlAs(host, auth, query, variables)).data;
	}

	/**
	 * Runs one GraphQL document as the chosen account. `partial`: a batch where some aliases may
	 * name pull requests that are gone; those come back null and the rest are kept.
	 */
	private async graphqlAs(host: string, auth: IVoltPrAuth, query: string, variables: Record<string, unknown>, partial = false): Promise<{ data: Json; login: string }> {
		const { env, login } = await this.authEnv(host, auth);
		const result = await this.run(this.ghCommand, ['api', 'graphql', '--hostname', apiHost(host), '--input', '-'], {
			env,
			input: JSON.stringify({ query, variables }),
			timeoutMs: GH_TIMEOUT_MS,
		});
		let body: Json;
		try {
			body = result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
		} catch {
			body = undefined;
		}
		const errors: Json[] = Array.isArray(body?.errors) ? body.errors : [];
		if (result.code === 0 && !errors.length && body?.data) {
			return { data: body.data, login };
		}
		if (body?.data && partial) {
			// A batch keeps what it could read: a pull request that is gone (NOT_FOUND) or out of reach
			// (FORBIDDEN, an SSO org) comes back null and is left out, the rest stay.
			if (errors.some(error => error?.type !== 'NOT_FOUND')) {
				this.logService?.trace('[volt-pr] some pull requests in a batch could not be read', errors.map(error => error?.message).join('; '));
			}
			return { data: body.data, login };
		}
		throw this.failure(result, errors);
	}

	private async rest(host: string, auth: IVoltPrAuth, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown, extra: readonly string[] = []): Promise<Json> {
		const { env } = await this.authEnv(host, auth);
		const args = ['api', '--hostname', apiHost(host), '--method', method, ...extra, path];
		if (body !== undefined) {
			args.push('--input', '-');
		}
		const result = await this.run(this.ghCommand, args, {
			env,
			...(body !== undefined ? { input: JSON.stringify(body) } : {}),
			timeoutMs: GH_TIMEOUT_MS,
		});
		if (result.code !== 0) {
			let parsed: Json;
			try {
				parsed = JSON.parse(result.stdout);
			} catch {
				parsed = undefined;
			}
			const detail = [parsed?.message, ...(Array.isArray(parsed?.errors) ? parsed.errors.map((error: Json) => error?.message ?? error?.code) : [])].filter(Boolean).join(': ');
			throw this.failure(result, detail ? [{ message: detail }] : []);
		}
		const text = result.stdout.trim();
		if (!text) {
			return undefined;
		}
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	private failure(result: IRunResult, errors: readonly Json[]): VoltPrError {
		const messages = errors.map(error => typeof error?.message === 'string' ? error.message : '').filter(Boolean);
		const stderr = [result.stderr, ...messages].join('\n');
		if (result.timedOut) {
			return new VoltPrError('network', 'GitHub did not answer in time.');
		}
		const code = errors.some(error => error?.type === 'NOT_FOUND') ? 'notFound' : classifyGhError(stderr, result.code, result.spawnError);
		if (code === 'noCli') {
			return new VoltPrError('noCli', 'Install the GitHub CLI (gh) to work with pull requests.');
		}
		if (code === 'noAuth') {
			void this.refreshAccounts();
		}
		return new VoltPrError(code, messages[0] ?? ghErrorText(result.stderr));
	}

	private async env(extra: Record<string, string> | undefined): Promise<NodeJS.ProcessEnv> {
		this.baseEnv ??= this.resolveEnv().then(resolved => {
			const env: NodeJS.ProcessEnv = { ...resolved };
			for (const key of [...SCRUBBED_ENV, ...SCRUBBED_GH_ENV]) {
				delete env[key];
			}
			return {
				...env,
				GH_PROMPT_DISABLED: '1',
				GH_NO_UPDATE_NOTIFIER: '1',
				GH_SPINNER_DISABLED: '1',
				NO_COLOR: '1',
				GIT_TERMINAL_PROMPT: '0',
				LC_ALL: 'C',
			};
		}).catch(err => {
			this.baseEnv = undefined;
			throw err;
		});
		const base = await this.baseEnv;
		return extra ? { ...base, ...extra } : base;
	}

	private async run(command: string, args: readonly string[], options: IRunOptions = {}): Promise<IRunResult> {
		const env = await this.env(options.env);
		const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
		return new Promise<IRunResult>(resolve => {
			let settled = false;
			const finish = (result: IRunResult) => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};
			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawn(command, args as string[], { cwd: options.cwd, env, windowsHide: true });
			} catch (err) {
				finish({ code: null, stdout: '', stderr: '', spawnError: String(err), timedOut: false });
				return;
			}
			const stdout: Buffer[] = [];
			let stderr = '';
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, timeoutMs);
			child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => stderr += chunk.toString('utf8'));
			child.on('error', err => {
				clearTimeout(timer);
				finish({ code: null, stdout: '', stderr, spawnError: `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`, timedOut });
			});
			child.on('close', code => {
				clearTimeout(timer);
				finish({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr, timedOut });
			});
			child.stdin.on('error', () => { /* the exit code reports it */ });
			child.stdin.end(options.input);
		});
	}

	//#endregion
}

function validateBranchName(name: string): void {
	if (!name || name.startsWith('-') || /[\s~^:?*\[\\]|\.\.|@\{|\.lock$|\/$|^\//.test(name)) {
		throw new VoltPrError('failed', `Not a valid branch name: ${name}`);
	}
}

function sameRepo(a: IVoltPrRepoRef, b: IVoltPrRepoRef): boolean {
	return apiHost(a.host) === apiHost(b.host) && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

function isOpen(pr: IVoltPullRequest): boolean {
	return pr.state === 'open' || pr.state === 'draft';
}

/** For callers outside GitHub: what to tell the user. */
export function unsupportedProviderError(provider: Parameters<typeof providerLabel>[0]): VoltPrError {
	return new VoltPrError('unsupported', `Pull requests on ${providerLabel(provider)} are not supported yet. Volt works with GitHub and GitHub Enterprise.`);
}
