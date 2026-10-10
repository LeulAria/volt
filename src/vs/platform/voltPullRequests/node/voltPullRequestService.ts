/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { join } from '../../../base/common/path.js';
import { SequencerByKey } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { withWorkingGitOnPath } from '../../voltGit/node/gitExecutable.js';
import {
	apiHost,
	classifyGhError,
	ghErrorText,
	parseBranchRef,
	parseCheckRun,
	parseFile,
	parseFilePatch,
	parseFingerprint,
	parseGitStatusV2,
	parseNumstat,
	parsePullRequest,
	parsePullRequestDetail,
	parseRemoteUrl,
	parseRestPullRequest,
	PR_BRANCH_REF_FIELDS,
	PR_FINGERPRINT_FRAGMENT,
	PR_SUMMARY_FRAGMENT,
	prKey,
	providerForHost,
	providerLabel,
	splitGhInclude,
} from '../common/voltPullRequestParse.js';
import { describeGithubRefusal, IVoltGithubRefusal, readGithubRateLimit, isGithubRateLimitAnswer, VoltGithubHeaders, VoltGithubPriority, VoltGithubQuota, VoltGithubQuotaResource } from '../common/voltGithubQuota.js';
import { splitUnifiedDiff } from '../common/hosts/hostParse.js';
import { pullRequestHeadRef, repositoryWebUrl } from '../common/voltPrHosts.js';
import { isStackTrunk, IVoltRestackResult, stackBranchName } from '../common/voltPrStacks.js';
import { findingsAsComment, IVoltPrHostClient, parseCommitPathRef } from './hosts/voltPrHostClient.js';
import { readBranchStates, readStack, recordParent, restackStack, retargetChildren, IStackContext, StackGit } from './voltPrStackGit.js';
import { VoltPrFetch } from './hosts/voltPrHttp.js';
import { VoltPrHostRegistry } from './hosts/voltPrHostRegistry.js';
import {
	IVoltBranchSummary,
	IVoltPrBranchesRequest,
	IVoltPrBranchPullRequests,
	IVoltPrBranchRef,
	IVoltPrFingerprint,
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
	IVoltPrHostCredential,
	IVoltPrRestackOutcome,
	IVoltPrStackView,
	IVoltPrStackLayerView,
	IVoltPrHostInfo,
	IVoltPrLineComment,
	IVoltPrListRequest,
	IVoltPrMergeRequest,
	IVoltPrPushResult,
	IVoltPrRepo,
	IVoltPrRepoRef,
	IVoltPrRequest,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	IVoltPullRequestService,
	IVoltPrSignInRequest,
	IVoltRepoRemotes,
	VoltPrError,
	voltPrErrorCode,
	VoltPrProvider,
} from '../common/voltPullRequests.js';

const GH_TIMEOUT_MS = 45_000;
const GIT_TIMEOUT_MS = 120_000;
/** Pull requests per batched GraphQL read; GitHub's node limit leaves room for 100 checks each. */
const BATCH_SIZE = 20;
/** Branches per lookup document: each alias is one connection without nested ones, so 50 cost about a point. */
const BRANCH_BATCH_SIZE = 50;
/** Pull requests per fingerprint document: about a point for 25. */
const FINGERPRINT_BATCH_SIZE = 25;
/** REST reads at a time when GraphQL's quota is out: GitHub's secondary limits punish bursts. */
const REST_CONCURRENCY = 5;
/** Node ids kept for mutations (they never change); the oldest go first past this. */
const MAX_NODE_IDS = 2000;
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

/** One `gh api` answer, its status and headers split off when gh printed them. */
interface IGhApiAnswer {
	readonly result: IRunResult;
	/** Undefined when gh printed no headers (paginated reads) or never reached GitHub. */
	readonly status?: number;
	readonly headers?: VoltGithubHeaders;
	/** stdout without the status line and headers. */
	readonly body: string;
	readonly host: string;
	readonly login: string;
	/** The quota's key: host and account. */
	readonly account: string;
}

interface IRunOptions {
	readonly cwd?: string;
	readonly input?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
}

type Json = any;

export interface IVoltPullRequestServiceOptions {
	/** `volt.sourceControl.hosts`: the user's word on which kind of server a host is. */
	readonly hostSettings?: () => unknown;
	/** Tests point hosts at a local server. */
	readonly fetch?: VoltPrFetch;
	readonly homeDir?: string;
}

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
	/** GitHub's rate limits per account, REST and GraphQL apart, as its answers report them. */
	private readonly quota = new VoltGithubQuota();
	/** GraphQL node ids by pull request key: every mutation needs one, and they never change. */
	private readonly nodeIds = new Map<string, string>();

	/** GitLab, Bitbucket, Gitea / Forgejo and Azure DevOps. */
	private readonly hosts: VoltPrHostRegistry;

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService?: ILogService,
		private readonly ghCommand = 'gh',
		options: IVoltPullRequestServiceOptions = {},
	) {
		super();
		this.hosts = new VoltPrHostRegistry({
			run: (command, args, timeoutMs) => this.run(command, args, { timeoutMs }),
			env: () => this.env(undefined),
			settings: options.hostSettings,
			githubHosts: async () => new Set((await this.githubAccounts()).map(account => account.host)),
			...(options.fetch ? { fetch: options.fetch } : {}),
			...(options.homeDir ? { homeDir: options.homeDir } : {}),
		});
	}

	//#region Other hosts

	async setHostCredentials(credentials: readonly IVoltPrHostCredential[]): Promise<void> {
		this.hosts.setCredentials(credentials);
		this._onDidChangeAccounts.fire();
	}

	signInHost(request: IVoltPrSignInRequest): Promise<IVoltPrAccount> {
		return this.hosts.signIn(request);
	}

	hostInfo(host: string): Promise<IVoltPrHostInfo> {
		return this.hosts.info(apiHost(host));
	}

	/** The REST client for a host that is not GitHub; undefined sends the call down the GitHub CLI path. */
	private async other(host: string): Promise<IVoltPrHostClient | undefined> {
		const api = apiHost(host);
		if (providerForHost(api) === 'github') {
			return undefined;
		}
		return this.hosts.client(api);
	}

	//#endregion

	//#region Accounts

	async accounts(host?: string): Promise<IVoltPrAccount[]> {
		const [github, others] = await Promise.all([this.githubAccounts(), this.hosts.accounts()]);
		const all = [...github, ...others];
		return host ? all.filter(account => account.host === apiHost(host)) : all;
	}

	/** GitHub CLI accounts only (they decide which hosts are GitHub Enterprise). */
	private async githubAccounts(host?: string): Promise<IVoltPrAccount[]> {
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
		this.hosts.refresh();
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
						provider: 'github',
						source: 'gh',
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
		const accounts = await this.githubAccounts(host);
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
		const githubHosts = new Set((await this.githubAccounts()).map(account => account.host));
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
		const githubHosts = new Set((await this.githubAccounts().catch(() => [] as IVoltPrAccount[])).map(account => account.host));
		let parsed = parseRemoteUrl(url, githubHosts, this.hosts.knownProviders());
		if (!parsed) {
			return undefined;
		}
		let webBase: string | undefined;
		if (parsed.provider !== 'github') {
			// Self-hosted servers: a setting, a sign-in or the server's own version endpoint says what it is.
			const info = await this.hosts.info(parsed.host).catch(() => undefined);
			if (info) {
				parsed = { ...parsed, provider: info.provider };
				webBase = info.webUrl;
			}
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
			webUrl: webBase ? repositoryWebUrl(parsed.provider, webBase, parsed) : `https://${host}/${parsed.owner}/${parsed.name}`,
			remote,
			root,
			...(branch ? { branch } : {}),
			...(upstream ? { upstream } : {}),
			...(ahead !== undefined ? { ahead } : {}),
			...(behind !== undefined ? { behind } : {}),
		};
	}

	async repoRemotes(folder: string): Promise<IVoltRepoRemotes | undefined> {
		const top = await this.run('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: folder, timeoutMs: 15_000 });
		const [root, commonDir] = top.stdout.trim().split('\n').map(line => line.trim());
		if (top.code !== 0 || !root || !commonDir) {
			return undefined;
		}
		const remotes = await this.run('git', ['remote'], { cwd: root, timeoutMs: 15_000 });
		return {
			root,
			configFile: join(commonDir, 'config'),
			remotes: remotes.code === 0 ? remotes.stdout.split('\n').map(line => line.trim()).filter(Boolean) : [],
		};
	}

	async remoteBranches(request: IVoltPrAuth & { readonly repo: IVoltPrRepoRef }): Promise<string[]> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.remoteBranches(request.repo);
		}
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
		const other = await this.other(request.repo.host);
		if (other) {
			return tagProvider(await other.list(request.repo, request.state, Math.max(1, Math.min(100, request.limit ?? 50))), other.provider);
		}
		const limit = Math.max(1, Math.min(100, request.limit ?? 50));
		return this.graphqlOrRest(() => this.listGraphql(request, limit), () => this.listRest(request, limit));
	}

	private async listGraphql(request: IVoltPrListRequest, limit: number): Promise<IVoltPullRequest[]> {
		const states = request.state === 'open' ? '[OPEN]' : request.state === 'closed' ? '[CLOSED, MERGED]' : '[OPEN, CLOSED, MERGED]';
		const { data, login } = await this.graphqlAs(request.repo.host, request, `query($owner: String!, $name: String!) {
			viewer { login }
			repository(owner: $owner, name: $name) {
				pullRequests(first: ${limit}, states: ${states}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...VoltPr } }
			}
		}
		${PR_SUMMARY_FRAGMENT}`, { owner: request.repo.owner, name: request.repo.name });
		const viewer = data.viewer?.login ?? login;
		return this.rememberNodeIds((data.repository?.pullRequests?.nodes ?? []).filter(Boolean).map((node: Json) => parsePullRequest(node, request.repo, viewer)));
	}

	/** The list over REST: no checks, reviews or threads, but the pull requests are there. */
	private async listRest(request: IVoltPrListRequest, limit: number): Promise<IVoltPullRequest[]> {
		const state = request.state === 'open' ? 'open' : request.state === 'closed' ? 'closed' : 'all';
		const { data, login } = await this.restAs(request.repo.host, request, 'GET', `repos/${request.repo.owner}/${request.repo.name}/pulls?state=${state}&sort=updated&direction=desc&per_page=${limit}`);
		return (Array.isArray(data) ? data : []).filter(Boolean).map((raw: Json) => parseRestPullRequest(raw, request.repo, login));
	}

	async forBranch(request: IVoltPrBranchRequest): Promise<IVoltPullRequest[]> {
		const { branch, ...rest } = request;
		const [found] = await this.forBranches({ ...rest, branches: [branch] });
		return [...found?.pullRequests ?? []];
	}

	async forBranches(request: IVoltPrBranchesRequest): Promise<IVoltPrBranchPullRequests[]> {
		const branches = [...new Set(request.branches.filter(Boolean))];
		const other = await this.other(request.repo.host);
		if (other) {
			return Promise.all(branches.map(async branch => ({ branch, pullRequests: tagProvider(await other.forBranch(request.repo, branch, request.headOwner), other.provider) })));
		}
		// Which pull requests first (about a point for 50 branches), then the summaries of just those:
		// a summary per pull request found costs far less than ten summaries per branch asked about.
		const refs = await this.branchPullRequests({ ...request, branches });
		const auth = authOf(request);
		const summaries = refs.length ? await this.graphqlOrRest(
			() => this.getMany(refs.map(ref => ({ repo: ref.repo, number: ref.number, ...auth }))),
			() => this.restPullRequests(refs, auth),
		) : [];
		const byNumber = new Map(summaries.map(pr => [pr.number, pr]));
		return branches.map(branch => ({
			branch,
			// The open one first, then the most recent.
			pullRequests: refs.filter(ref => ref.branch === branch)
				.map(ref => byNumber.get(ref.number))
				.filter((pr): pr is IVoltPullRequest => !!pr)
				.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt - a.createdAt),
		}));
	}

	async branchPullRequests(request: IVoltPrBranchesRequest): Promise<IVoltPrBranchRef[]> {
		const branches = [...new Set(request.branches.filter(Boolean))];
		if (!branches.length) {
			return [];
		}
		const other = await this.other(request.repo.host);
		if (other) {
			const found = await Promise.all(branches.map(async branch => (await other.forBranch(request.repo, branch, request.headOwner)).map((pr): IVoltPrBranchRef => ({
				branch,
				repo: pr.repo,
				number: pr.number,
				state: pr.state,
				createdAt: pr.createdAt,
				...(pr.headOwner ? { headOwner: pr.headOwner } : {}),
			}))));
			return found.flat();
		}
		const refs: IVoltPrBranchRef[] = [];
		for (let start = 0; start < branches.length; start += BRANCH_BATCH_SIZE) {
			const chunk = branches.slice(start, start + BRANCH_BATCH_SIZE);
			refs.push(...await this.graphqlOrRest(() => this.branchRefsGraphql(request, chunk), () => this.branchRefsRest(request, chunk)));
		}
		const owner = request.headOwner?.toLowerCase();
		return owner ? refs.filter(ref => (ref.headOwner ?? request.repo.owner).toLowerCase() === owner) : refs;
	}

	/** One document for many branches: an alias per branch, every name a variable. */
	private async branchRefsGraphql(request: IVoltPrBranchesRequest, branches: readonly string[]): Promise<IVoltPrBranchRef[]> {
		const variables: Record<string, unknown> = { owner: request.repo.owner, name: request.repo.name };
		const params: string[] = [];
		const fields = branches.map((branch, i) => {
			variables[`b${i}`] = branch;
			params.push(`$b${i}: String!`);
			return `b${i}: pullRequests(first: 10, headRefName: $b${i}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_BRANCH_REF_FIELDS} } }`;
		});
		const data = await this.graphql(request.repo.host, request, `query($owner: String!, $name: String!, ${params.join(', ')}) {
			repository(owner: $owner, name: $name) {
				${fields.join('\n')}
			}
		}`, variables);
		return branches.flatMap((branch, i) => ((data.repository?.[`b${i}`]?.nodes ?? []) as Json[]).filter(Boolean).map(raw => parseBranchRef(raw, request.repo, branch)));
	}

	/** The lookup over REST, a branch a call: only branches in the repository itself (or in `headOwner`'s fork). */
	private async branchRefsRest(request: IVoltPrBranchesRequest, branches: readonly string[]): Promise<IVoltPrBranchRef[]> {
		const owner = request.headOwner ?? request.repo.owner;
		const found = await mapLimited(branches, REST_CONCURRENCY, async branch => {
			const data = await this.rest(request.repo.host, request, 'GET', `repos/${request.repo.owner}/${request.repo.name}/pulls?state=all&sort=created&direction=desc&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`);
			return (Array.isArray(data) ? data : []).filter(Boolean).map((raw: Json) => parseBranchRef(raw, request.repo, branch));
		});
		return found.flat();
	}

	/** Pull request summaries over REST, one call each, for when GraphQL's quota is out. */
	private async restPullRequests(refs: readonly { readonly repo: IVoltPrRepoRef; readonly number: number }[], auth: IVoltPrAuth): Promise<IVoltPullRequest[]> {
		return mapLimited(refs, REST_CONCURRENCY, async ref => {
			const { data, login } = await this.restAs(ref.repo.host, auth, 'GET', `repos/${ref.repo.owner}/${ref.repo.name}/pulls/${ref.number}`);
			return parseRestPullRequest(data, ref.repo, login);
		});
	}

	async fingerprints(requests: readonly IVoltPrRequest[]): Promise<IVoltPrFingerprint[]> {
		const groups = groupRequests(requests);
		const results: IVoltPrFingerprint[] = [];
		const errors: unknown[] = [];
		await Promise.all([...groups.values()].map(async group => {
			try {
				if (await this.other(group[0].repo.host)) {
					// Other hosts have no cheap read: their callers read the detail as before.
					return;
				}
				const auth = authOf(group[0], group.every(request => request.background));
				for (let start = 0; start < group.length; start += FINGERPRINT_BATCH_SIZE) {
					results.push(...await this.readFingerprints(group.slice(start, start + FINGERPRINT_BATCH_SIZE), auth));
				}
			} catch (err) {
				errors.push(err);
			}
		}));
		if (!results.length && errors.length) {
			throw errors[0];
		}
		return results;
	}

	private async readFingerprints(batch: readonly IVoltPrRequest[], auth: IVoltPrAuth): Promise<IVoltPrFingerprint[]> {
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const fields = batch.map((request, i) => {
			variables[`o${i}`] = request.repo.owner;
			variables[`n${i}`] = request.repo.name;
			variables[`p${i}`] = request.number;
			params.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`);
			return `f${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { ...VoltPrFingerprint } }`;
		});
		const { data } = await this.graphqlAs(batch[0].repo.host, auth, `query(${params.join(', ')}) {
			${fields.join('\n')}
		}
		${PR_FINGERPRINT_FRAGMENT}`, variables, true);
		return batch.flatMap((request, i) => {
			const raw = data[`f${i}`]?.pullRequest;
			return raw ? [parseFingerprint(raw, request.repo)] : [];
		});
	}

	async getMany(requests: readonly IVoltPrRequest[]): Promise<IVoltPullRequest[]> {
		const groups = groupRequests(requests);
		const results: IVoltPullRequest[] = [];
		const errors: unknown[] = [];
		await Promise.all([...groups.values()].map(async group => {
			let other: IVoltPrHostClient | undefined;
			try {
				other = await this.other(group[0].repo.host);
			} catch (err) {
				errors.push(err);
				return;
			}
			if (other) {
				const client = other;
				const read = await Promise.all(group.map(request => client.get(request.repo, request.number).catch(err => {
					errors.push(err);
					return undefined;
				})));
				results.push(...tagProvider(read.filter((pr): pr is IVoltPullRequest => !!pr), client.provider));
				return;
			}
			// A batch nobody waits on stays background only when every request in it is.
			const auth = authOf(group[0], group.every(request => request.background));
			for (let start = 0; start < group.length; start += BATCH_SIZE) {
				const batch = group.slice(start, start + BATCH_SIZE);
				try {
					results.push(...await this.readBatch(batch, auth));
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

	private async readBatch(batch: readonly IVoltPrRequest[], auth: IVoltPrAuth): Promise<IVoltPullRequest[]> {
		const repos: { repo: IVoltPrRepoRef; numbers: number[] }[] = [];
		for (const request of batch) {
			let entry = repos.find(candidate => sameRepo(candidate.repo, request.repo));
			if (!entry) {
				entry = { repo: request.repo, numbers: [] };
				repos.push(entry);
			}
			entry.numbers.push(request.number);
		}
		// Every owner, name and number travels as a variable: nothing a caller supplies is written into the document.
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const fields = repos.map((entry, r) => {
			variables[`r${r}o`] = entry.repo.owner;
			variables[`r${r}n`] = entry.repo.name;
			params.push(`$r${r}o: String!`, `$r${r}n: String!`);
			const prs = entry.numbers.map(number => {
				variables[`r${r}p${number}`] = number;
				params.push(`$r${r}p${number}: Int!`);
				return `p${number}: pullRequest(number: $r${r}p${number}) { ...VoltPr }`;
			});
			return `r${r}: repository(owner: $r${r}o, name: $r${r}n) {
			${prs.join('\n')}
		}`;
		}).join('\n');
		const { data, login } = await this.graphqlAs(batch[0].repo.host, auth, `query(${params.join(', ')}) { viewer { login } ${fields} }
		${PR_SUMMARY_FRAGMENT}`, variables, true);
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
		return this.rememberNodeIds(out);
	}

	async detail(request: IVoltPrRequest): Promise<IVoltPullRequestDetail> {
		const other = await this.other(request.repo.host);
		if (other) {
			return { ...await other.detail(request.repo, request.number), provider: other.provider };
		}
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
		this.rememberNodeIds([{ key: prKey(request.repo, request.number), id: raw.id }]);
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
			// Nice to have: it leaves the REST reserve alone, and the files show without their old names.
			const out = await this.rest(request.repo.host, { ...request, background: true }, 'GET', `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}/files?per_page=100`, undefined, ['--paginate', '--slurp']);
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
		const other = await this.other(request.repo.host);
		if (other) {
			return { ...await other.create(request), provider: other.provider };
		}
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
		const other = await this.other(request.repo.host);
		if (other) {
			return other.merge(request);
		}
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
		const other = await this.other(request.repo.host);
		if (other) {
			return other.cancelAutoMerge(request.repo, request.number);
		}
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
	}

	async updateBranch(request: IVoltPrRequest & { readonly rebase: boolean }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.updateBranch(request.repo, request.number, request.rebase);
		}
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!, $method: PullRequestBranchUpdateMethod) {
			updatePullRequestBranch(input: { pullRequestId: $id, updateMethod: $method }) { clientMutationId }
		}`, { id, method: request.rebase ? 'REBASE' : 'MERGE' });
	}

	async setDraft(request: IVoltPrRequest & { readonly draft: boolean }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.setDraft(request.repo, request.number, request.draft);
		}
		const id = await this.nodeId(request);
		await this.mutate(request, request.draft
			? `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`
			: `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
	}

	async setState(request: IVoltPrRequest & { readonly state: 'open' | 'closed' }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.setState(request.repo, request.number, request.state);
		}
		const id = await this.nodeId(request);
		await this.mutate(request, request.state === 'closed'
			? `mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`
			: `mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
	}

	async setBase(request: IVoltPrRequest & { readonly base: string }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.setBase(request.repo, request.number, request.base);
		}
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!, $base: String!) { updatePullRequest(input: { pullRequestId: $id, baseRefName: $base }) { clientMutationId } }`, { id, base: request.base });
	}

	async setLabels(request: IVoltPrRequest & { readonly add: readonly string[]; readonly remove: readonly string[] }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.setLabels(request.repo, request.number, request.add, request.remove);
		}
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
		if (await this.other(request.repo.host)) {
			// Viewed files are GitHub's: other hosts keep no such state in their API.
			return;
		}
		const id = await this.nodeId(request);
		await this.mutate(request, request.viewed
			? `mutation($id: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
			: `mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id, path: request.path });
	}

	async comment(request: IVoltPrRequest & { readonly body: string }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.comment(request.repo, request.number, request.body);
		}
		const id = await this.nodeId(request);
		await this.mutate(request, `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }`, { id, body: request.body });
	}

	async reply(request: IVoltPrRequest & { readonly threadId: string; readonly body: string }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.reply(request.repo, request.number, request.threadId, request.body);
		}
		await this.mutate(request, `mutation($thread: ID!, $body: String!) {
			addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { clientMutationId }
		}`, { thread: request.threadId, body: request.body });
	}

	async resolveThread(request: IVoltPrRequest & { readonly threadId: string; readonly resolved: boolean }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.resolveThread(request.repo, request.number, request.threadId, request.resolved);
		}
		await this.mutate(request, request.resolved
			? `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { clientMutationId } }`
			: `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { clientMutationId } }`, { thread: request.threadId });
	}

	async review(request: IVoltPrRequest & { readonly event: 'approve' | 'requestChanges' | 'comment'; readonly body: string }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.review(request.repo, request.number, request.event, request.body);
		}
		const id = await this.nodeId(request);
		const event = request.event === 'approve' ? 'APPROVE' : request.event === 'requestChanges' ? 'REQUEST_CHANGES' : 'COMMENT';
		await this.mutate(request, `mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
			addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) { clientMutationId }
		}`, { id, event, ...(request.body ? { body: request.body } : {}) });
	}

	async requestReviewers(request: IVoltPrRequest & { readonly logins: readonly string[] }): Promise<void> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.requestReviewers(request.repo, request.number, request.logins);
		}
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
		const other = await this.other(request.repo.host);
		if (other) {
			return other.rerunFailedChecks(request.repo, request.number);
		}
		// The head commit over REST: everything this does is REST, so it spends no GraphQL points.
		const pr = await this.rest(request.repo.host, request, 'GET', `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}`);
		const headSha = typeof pr?.head?.sha === 'string' ? pr.head.sha : undefined;
		if (!headSha) {
			throw new VoltPrError('notFound', `Pull request #${request.number} was not found.`);
		}
		const runs = await this.rest(request.repo.host, request, 'GET', `repos/${request.repo.owner}/${request.repo.name}/actions/runs?head_sha=${headSha}&per_page=100`);
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

	async postReview(request: IVoltPrRequest & { readonly body: string; readonly comments: readonly IVoltPrLineComment[]; readonly headOid?: string }): Promise<{ readonly posted: number; readonly url?: string }> {
		const other = await this.other(request.repo.host);
		if (other) {
			return other.postReview(request.repo, request.number, request.body, request.comments, request.headOid);
		}
		const path = `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}/reviews`;
		try {
			const review = await this.rest(request.repo.host, request, 'POST', path, {
				...(request.headOid ? { commit_id: request.headOid } : {}),
				body: request.body,
				event: 'COMMENT',
				comments: request.comments.map(comment => ({ path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body })),
			});
			return { posted: request.comments.length, ...(typeof review?.html_url === 'string' ? { url: review.html_url } : {}) };
		} catch (err) {
			// 422: a line is outside the diff. Everything goes in one review body instead.
			if (!request.comments.length || voltPrErrorCode(err) === 'noAuth' || voltPrErrorCode(err) === 'network') {
				throw err;
			}
			const review = await this.rest(request.repo.host, request, 'POST', path, { body: findingsAsComment(request.body, request.comments), event: 'COMMENT' });
			return { posted: request.comments.length, ...(typeof review?.html_url === 'string' ? { url: review.html_url } : {}) };
		}
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
		// Hosts that keep a ref per pull request are fetched by number, so forks and deleted head
		// branches work too; the others (Bitbucket, Azure DevOps) by the head branch.
		const provider = (await this.other(request.repo.host))?.provider ?? 'github';
		const headRef = pullRequestHeadRef(provider, request.number) ?? `refs/heads/${pr.headRefName}`;
		return this.gitQueue.queue(repo.root, async () => {
			const fetched = await this.run('git', [
				'-c', 'credential.interactive=never', 'fetch', '--no-tags', '--no-write-fetch-head', '--quiet', remote,
				`+${headRef}:${ref}/head`,
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

	async filePatches(request: IVoltPrRequest & { readonly commit?: string; readonly folder?: string }): Promise<IVoltPrFilePatch[]> {
		if (request.commit && !/^[0-9a-f]{7,40}$/i.test(request.commit)) {
			throw new VoltPrError('failed', `Not a commit id: ${request.commit}`);
		}
		const other = await this.other(request.repo.host);
		if (other) {
			if (request.folder) {
				try {
					return await this.localFilePatches(request as IVoltPrRequest & { readonly folder: string; readonly commit?: string });
				} catch (err) {
					this.logService?.trace('[volt-pr] reading the diff from the clone failed; asking the host', err);
				}
			}
			return other.filePatches(request.repo, request.number, request.commit);
		}
		const path = request.commit
			? `repos/${request.repo.owner}/${request.repo.name}/commits/${request.commit}`
			: `repos/${request.repo.owner}/${request.repo.name}/pulls/${request.number}/files?per_page=100`;
		const out = await this.rest(request.repo.host, request, 'GET', path, undefined, request.commit ? [] : ['--paginate', '--slurp']);
		const entries: Json[] = request.commit ? (Array.isArray(out?.files) ? out.files : []) : Array.isArray(out) ? out.flat() : [];
		return entries.slice(0, MAX_FILES).map(parseFilePatch).filter(file => !!file.path);
	}

	/** A pull request's (or one commit's) changes from git in a local clone: fetched into hidden refs, blobs included. */
	private async localFilePatches(request: IVoltPrRequest & { readonly folder: string; readonly commit?: string }): Promise<IVoltPrFilePatch[]> {
		const range = request.commit ? undefined : await this.fetch(request);
		const root = (await this.run('git', ['rev-parse', '--show-toplevel'], { cwd: request.folder, timeoutMs: 15_000 })).stdout.trim() || request.folder;
		const args = request.commit
			? ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--full-index', '-M', `${request.commit}^`, request.commit]
			: ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--full-index', '-M', range!.base, range!.head];
		const diff = await this.run('git', args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
		if (diff.code !== 0) {
			throw new VoltPrError('failed', `git diff failed: ${ghErrorText(diff.stderr)}`);
		}
		return splitUnifiedDiff(diff.stdout).slice(0, MAX_FILES);
	}

	async readBlob(request: IVoltPrAuth & { readonly repo: IVoltPrRepoRef; readonly sha: string; readonly folder?: string }): Promise<string> {
		const byPath = parseCommitPathRef(request.sha);
		if (!/^[0-9a-f]{40,64}$/i.test(request.sha) && !byPath) {
			throw new VoltPrError('failed', `Not a blob id: ${request.sha}`);
		}
		if (request.folder) {
			const local = await this.run('git', ['cat-file', 'blob', byPath ? `${byPath.commit}:${byPath.path}` : request.sha], { cwd: request.folder, timeoutMs: 15_000 });
			if (local.code === 0) {
				return local.stdout;
			}
		}
		const other = await this.other(request.repo.host);
		if (other) {
			return other.readBlob(request.repo, request.sha);
		}
		if (byPath) {
			throw new VoltPrError('failed', `Not a blob id: ${request.sha}`);
		}
		// Raw, not through rest(): the text must not be trimmed or read as JSON.
		const answer = await this.ghApi(request.repo.host, request, 'core', ['-H', 'Accept: application/vnd.github.raw+json', `repos/${request.repo.owner}/${request.repo.name}/git/blobs/${request.sha}`]);
		const limited = this.rateLimited(answer, 'core', []);
		if (limited) {
			throw limited;
		}
		if (answer.result.code !== 0) {
			throw this.failure(answer.result, []);
		}
		return answer.body;
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
			remotes,
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

	//#region Stacks

	async stack(request: { readonly folder: string; readonly branch?: string }): Promise<IVoltPrStackView | undefined> {
		const status = await this.gitStatus(request.folder);
		if (!status) {
			return undefined;
		}
		const context = this.stackContext(status.root, status.defaultBranch, status.remote);
		const stack = await readStack(context, request.branch ?? status.branch);
		const repo = await this.resolveRepo(request.folder);
		// Every layer in one lookup, not a read per layer.
		const byBranch = repo ? await this.forBranchesOrNone(repo, stack.layers.map(layer => layer.branch)) : new Map<string, readonly IVoltPullRequest[]>();
		const layers: IVoltPrStackLayerView[] = stack.layers.map(layer => {
			const prs = byBranch.get(layer.branch) ?? [];
			return { layer, pullRequest: prs.find(isOpen) ?? prs[0] };
		});
		return { stack, layers, checkedOut: status.branch };
	}

	async stackNewBranch(request: { readonly folder: string; readonly title: string }): Promise<{ readonly branch: string; readonly parent: string }> {
		const status = await this.gitStatus(request.folder);
		if (!status?.branch || !status.head) {
			throw new VoltPrError('failed', 'Check out a branch with a commit to stack on.');
		}
		const parent = status.branch;
		const parentOid = status.head;
		const context = this.stackContext(status.root, status.defaultBranch, status.remote);
		return this.gitQueue.queue(status.root, async () => {
			const branch = stackBranchName(request.title, new Set((await readBranchStates(context)).keys()));
			const created = await this.run('git', ['checkout', '-b', branch], { cwd: status.root, timeoutMs: 30_000 });
			if (created.code !== 0) {
				throw new VoltPrError('failed', `git checkout -b ${branch} failed: ${ghErrorText(created.stderr)}`);
			}
			await recordParent(context, branch, parent, parentOid);
			return { branch, parent };
		});
	}

	async restack(request: { readonly folder: string; readonly branch?: string; readonly syncTrunk?: boolean }): Promise<IVoltPrRestackOutcome> {
		const status = await this.gitStatus(request.folder);
		if (!status?.branch) {
			throw new VoltPrError('failed', 'Check out a branch in the stack first.');
		}
		const context = this.stackContext(status.root, status.defaultBranch, status.remote);
		const current = request.branch ?? status.branch;
		const repo = await this.resolveRepo(request.folder);
		return this.gitQueue.queue(status.root, async () => {
			const retargeted: { branch: string; to: string }[] = [];
			if (repo) {
				const handled = new Set<string>();
				for (const layer of (await readStack(context, current)).layers) {
					const parent = layer.parent;
					if (isStackTrunk(parent, context.trunk) || handled.has(parent)) {
						continue;
					}
					handled.add(parent);
					if (!(await this.forBranchOrNone(repo, parent)).some(pr => pr.state === 'merged')) {
						continue;
					}
					for (const move of await retargetChildren(context, parent)) {
						retargeted.push({ branch: move.branch, to: move.to });
						const open = (await this.forBranchOrNone(repo, move.branch)).find(isOpen);
						if (open) {
							await this.setBase({ repo, number: open.number, base: move.to });
						}
					}
				}
			}
			const syncTrunk = !!request.syncTrunk || retargeted.some(move => isStackTrunk(move.to, context.trunk));
			if (syncTrunk && context.remote) {
				const fetched = await this.run('git', ['-c', 'credential.interactive=never', 'fetch', '--quiet', context.remote, context.trunk], { cwd: status.root, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
				if (fetched.code !== 0) {
					throw new VoltPrError('network', `git fetch failed: ${ghErrorText(fetched.stderr)}`);
				}
			}
			const result: IVoltRestackResult = await restackStack(context, current, { syncTrunk });
			return { ...result, retargeted };
		});
	}

	private stackContext(root: string, trunk: string | undefined, remote: string | undefined): IStackContext {
		const git: StackGit = (args, cwd) => this.run('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
		return { git, root, trunk: trunk ?? 'main', remote };
	}

	/** {@link forBranchOrNone} for several branches in one lookup. */
	private async forBranchesOrNone(repo: IVoltPrRepo, branches: readonly string[]): Promise<Map<string, readonly IVoltPullRequest[]>> {
		try {
			return new Map((await this.forBranches({ repo, branches })).map(found => [found.branch, found.pullRequests]));
		} catch (err) {
			if (voltPrErrorCode(err) === 'failed') {
				throw err;
			}
			return new Map();
		}
	}

	/** Pull requests for a branch; none when the host can't answer (no sign-in yet), since a stack view still works without them. */
	private async forBranchOrNone(repo: IVoltPrRepo, branch: string): Promise<IVoltPullRequest[]> {
		try {
			return await this.forBranch({ repo, branch });
		} catch (err) {
			if (voltPrErrorCode(err) === 'failed') {
				throw err;
			}
			return [];
		}
	}

	//#endregion

	//#region Plumbing

	private async nodeId(request: IVoltPrRequest): Promise<string> {
		const known = this.nodeIds.get(prKey(request.repo, request.number));
		if (known) {
			return known;
		}
		const data = await this.graphql(request.repo.host, request, `query($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
		}`, { owner: request.repo.owner, name: request.repo.name, number: request.number });
		const id = data.repository?.pullRequest?.id;
		if (typeof id !== 'string') {
			throw new VoltPrError('notFound', `Pull request #${request.number} was not found in ${request.repo.owner}/${request.repo.name}.`);
		}
		this.rememberNodeIds([{ key: prKey(request.repo, request.number), id }]);
		return id;
	}

	/** Keeps the node ids of pull requests just read, so writes to them skip the lookup. */
	private rememberNodeIds<T extends { readonly key: string; readonly id: unknown }>(prs: T[]): T[] {
		for (const pr of prs) {
			if (typeof pr.id === 'string' && pr.id) {
				this.nodeIds.delete(pr.key);
				this.nodeIds.set(pr.key, pr.id);
			}
		}
		while (this.nodeIds.size > MAX_NODE_IDS) {
			this.nodeIds.delete(this.nodeIds.keys().next().value!);
		}
		return prs;
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
		const answer = await this.ghApi(host, auth, 'graphql', ['graphql', '--input', '-'], { input: JSON.stringify({ query, variables }) });
		let body: Json;
		try {
			body = answer.body.trim() ? JSON.parse(answer.body) : undefined;
		} catch {
			body = undefined;
		}
		const errors: Json[] = Array.isArray(body?.errors) ? body.errors : [];
		const limited = this.rateLimited(answer, 'graphql', errors);
		if (limited) {
			throw limited;
		}
		const { result, login } = answer;
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
		return (await this.restAs(host, auth, method, path, body, extra)).data;
	}

	private async restAs(host: string, auth: IVoltPrAuth, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown, extra: readonly string[] = []): Promise<{ data: Json; login: string }> {
		const args = ['--method', method, ...extra, path];
		if (body !== undefined) {
			args.push('--input', '-');
		}
		const answer = await this.ghApi(host, auth, 'core', args, {
			...(body !== undefined ? { input: JSON.stringify(body) } : {}),
			paginate: extra.includes('--paginate'),
		});
		let parsed: Json;
		try {
			parsed = JSON.parse(answer.body);
		} catch {
			parsed = undefined;
		}
		const limited = this.rateLimited(answer, 'core', typeof parsed?.message === 'string' ? [{ message: parsed.message }] : []);
		if (limited) {
			throw limited;
		}
		const { result, login } = answer;
		if (result.code !== 0) {
			const detail = [parsed?.message, ...(Array.isArray(parsed?.errors) ? parsed.errors.map((error: Json) => error?.message ?? error?.code) : [])].filter(Boolean).join(': ');
			throw this.failure(result, detail ? [{ message: detail }] : []);
		}
		const text = answer.body.trim();
		if (!text) {
			return { data: undefined, login };
		}
		try {
			return { data: JSON.parse(text), login };
		} catch {
			return { data: text, login };
		}
	}

	/**
	 * One `gh api` call as the chosen account, under GitHub's rate limits: refused without a request
	 * when the quota says so (background reads leave the last tenth alone), and GitHub's own count
	 * read back from the answer's headers. Paginated reads print headers for every page, so they go
	 * without; the next single answer brings the count up to date.
	 */
	private async ghApi(host: string, auth: IVoltPrAuth, resource: VoltGithubQuotaResource, args: readonly string[], options: { readonly input?: string; readonly paginate?: boolean } = {}): Promise<IGhApiAnswer> {
		const api = apiHost(host);
		const { env, login } = await this.authEnv(api, auth);
		const account = quotaAccount(api, login);
		const priority: VoltGithubPriority = auth.background ? 'background' : 'interactive';
		const refusal = this.quota.admit(account, resource, priority);
		if (refusal) {
			throw refusalError(refusal, api);
		}
		const include = !options.paginate;
		const result = await this.run(this.ghCommand, ['api', '--hostname', api, ...(include ? ['--include'] : []), ...args], {
			env,
			...(options.input !== undefined ? { input: options.input } : {}),
			timeoutMs: GH_TIMEOUT_MS,
		});
		const split = include ? splitGhInclude(result.stdout) : { body: result.stdout };
		if (split.headers) {
			this.quota.observe(account, readGithubRateLimit(split.headers));
		}
		return { result, ...(split.status !== undefined ? { status: split.status } : {}), ...(split.headers ? { headers: split.headers } : {}), body: split.body, host: api, login, account };
	}

	/**
	 * GitHub refused for a rate limit: hold that quota until its reset (or the whole account until
	 * `retry-after`, for a secondary limit), so later calls wait without a request, and say when.
	 */
	private rateLimited(answer: IGhApiAnswer, resource: VoltGithubQuotaResource, errors: readonly Json[]): VoltPrError | undefined {
		const { result, status, headers } = answer;
		const messages = errors.map(error => typeof error?.message === 'string' ? error.message : '').filter(Boolean);
		const graphqlLimited = errors.some(error => error?.type === 'RATE_LIMITED');
		const httpLimited = status !== undefined
			? isGithubRateLimitAnswer(status, headers ?? new Map(), [result.stderr, ...messages].join('\n'))
			: result.code !== 0 && classifyGhError(result.stderr, result.code, result.spawnError) === 'rateLimited';
		if (!graphqlLimited && !httpLimited) {
			return undefined;
		}
		const now = Date.now();
		const reading = (headers && readGithubRateLimit(headers)) ?? this.quota.reading(answer.account, resource, now);
		const exhausted = !headers?.has('retry-after') && (graphqlLimited || (!!reading && reading.remaining <= 0));
		let refusal: IVoltGithubRefusal;
		if (exhausted) {
			// A primary limit: this quota is empty until its reset; the other one still works.
			const quotaResource = reading?.resource ?? resource;
			const retryAt = reading && reading.resetAt > now ? reading.resetAt : this.quota.pauseEnd(undefined, now);
			this.quota.pause(answer.account, retryAt, quotaResource);
			refusal = { resource: quotaResource, retryAt, reason: 'exhausted' };
		} else {
			// A secondary limit holds every quota of the account.
			const retryAt = this.quota.pauseEnd(headers, now);
			this.quota.pause(answer.account, retryAt);
			refusal = { resource, retryAt, reason: 'paused' };
		}
		this.logService?.warn(`[volt-pr] ${describeGithubRefusal(refusal, answer.host, now)}`);
		return refusalError(refusal, answer.host, now);
	}

	/**
	 * GraphQL first, REST when GraphQL's quota refuses. GitHub counts the two apart, so a read that
	 * has both forms keeps working while one is used up. When REST refuses too (a secondary limit
	 * holds the whole account), the GraphQL refusal is what the caller hears.
	 */
	private async graphqlOrRest<T>(graphql: () => Promise<T>, rest: () => Promise<T>): Promise<T> {
		try {
			return await graphql();
		} catch (err) {
			if (voltPrErrorCode(err) !== 'rateLimited') {
				throw err;
			}
			try {
				const read = await rest();
				this.logService?.trace('[volt-pr] GraphQL rate limit reached; read over REST instead');
				return read;
			} catch (restErr) {
				throw voltPrErrorCode(restErr) === 'rateLimited' ? err : restErr;
			}
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
		this.baseEnv ??= this.resolveEnv().then(withWorkingGitOnPath).then(resolved => {
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

/** The quota's key: GitHub counts per account, and each host is its own GitHub. */
function quotaAccount(host: string, login: string): string {
	return `${host}\u0000${login.toLowerCase()}`;
}

function refusalError(refusal: IVoltGithubRefusal, host: string, now = Date.now()): VoltPrError {
	return new VoltPrError('rateLimited', describeGithubRefusal(refusal, host, now), refusal.retryAt);
}

/** Who a call runs as, and whether anyone waits on it. */
function authOf(auth: IVoltPrAuth, background = auth.background): IVoltPrAuth {
	return { ...(auth.account ? { account: auth.account } : {}), ...(background ? { background: true } : {}) };
}

/** Requests by host and account (one GraphQL document can only run as one), each pull request once. */
function groupRequests(requests: readonly IVoltPrRequest[]): Map<string, IVoltPrRequest[]> {
	const groups = new Map<string, IVoltPrRequest[]>();
	for (const request of requests) {
		const key = `${apiHost(request.repo.host)}\u0000${request.account ?? ''}`;
		const group = groups.get(key) ?? [];
		if (!group.some(other => sameRepo(other.repo, request.repo) && other.number === request.number)) {
			group.push(request);
		}
		groups.set(key, group);
	}
	return groups;
}

/** `map` with at most `limit` calls in flight, results in order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await map(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
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

/** Marks reads from a host that is not GitHub with its kind, so views say "merge request" and `!12` where they should. */
function tagProvider<T extends IVoltPullRequest>(prs: readonly T[], provider: VoltPrProvider): T[] {
	return prs.map(pr => ({ ...pr, provider }));
}
