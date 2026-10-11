/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, asText, IRequestService } from '../../../../platform/request/common/request.js';
import { describeGithubRefusal, githubHeaders, isGithubRateLimitAnswer, readGithubRateLimit, VoltGithubQuota } from '../../../../platform/voltPullRequests/common/voltGithubQuota.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IVoltQuery, IVoltQueryCache, IVoltQueryHandle } from '../../../services/voltRuntime/browser/queryCache.js';

export interface IGitHubRepo {
	readonly fullName: string;
	readonly owner: string;
	readonly name: string;
	readonly private: boolean;
	readonly fork: boolean;
	readonly description?: string;
	readonly cloneUrl: string;
	readonly language?: string;
	readonly stars: number;
	readonly pushedAt?: string;
	readonly defaultBranch?: string;
}

export interface IGitHubAccount {
	readonly login: string;
}

export interface IGitHubRepoPage {
	readonly repos: readonly IGitHubRepo[];
	readonly hasMore: boolean;
}

export const IGitHubReposService = createDecorator<IGitHubReposService>('voltGitHubReposService');

/** The signed-in user's GitHub repositories, for Add Project → GitHub. Mirrors VS Code's GitHub remote source. */
export interface IGitHubReposService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAccount: Event<void>;
	/** Never prompts. Answers with the last known account at once, re-checking behind it. */
	account(): Promise<IGitHubAccount | undefined>;
	signIn(): Promise<boolean>;
	/**
	 * One page of the user's repos, most recently pushed first: starts on the last fetched page
	 * (kept across restarts) and refetches it when stale. Dispose it when the list closes.
	 */
	watchPage(login: string, page: number): IVoltQueryHandle<IGitHubRepoPage>;
	/** Server search; `everywhere` searches all of GitHub instead of the user's own repos and orgs. */
	search(query: string, everywhere: boolean, token: CancellationToken): Promise<readonly IGitHubRepo[]>;
	/** An `http.extraheader` value for cloning private repos over HTTPS. */
	authHeader(): Promise<string | undefined>;
}

const PROVIDER = 'github';
const SCOPES = ['repo'];
const API = 'https://api.github.com';
const HOST = 'github.com';
const PER_PAGE = 100;
const ACCOUNT_KEY = 'github.account';
const REPOS_KEY = 'github.repos:';
/** Pages kept on disk; later ones are fetched again after a restart. */
const PERSISTED_PAGES = 3;

interface IApiRepo {
	readonly full_name: string;
	readonly name: string;
	readonly owner: { readonly login: string };
	readonly private: boolean;
	readonly fork: boolean;
	readonly description: string | null;
	readonly clone_url: string;
	readonly language: string | null;
	readonly stargazers_count: number;
	readonly pushed_at: string | null;
	readonly default_branch: string;
}

export class GitHubReposService extends Disposable implements IGitHubReposService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAccount = this._register(new Emitter<void>());
	readonly onDidChangeAccount = this._onDidChangeAccount.event;

	private accountCache: Promise<IGitHubAccount | undefined> | undefined;
	/** The login pages last saw (null before the first answer); a refetch that changes it redraws them. */
	private knownLogin: string | undefined | null = null;
	/**
	 * GitHub's rate limits as its answers report them. Search has its own small quota (30 a minute
	 * signed in, 10 without): once it is used up, searches wait for its reset without a request.
	 */
	private readonly quota = new VoltGithubQuota();

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IVoltQueryCache private readonly cache: IVoltQueryCache,
	) {
		super();
		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === PROVIDER) {
				this.refreshAccount();
			}
		}));
	}

	account(): Promise<IGitHubAccount | undefined> {
		this.accountCache ??= this.cache.read(this.accountQuery()).catch(() => undefined);
		return this.accountCache.then(account => {
			this.knownLogin = account?.login;
			return account;
		});
	}

	private accountQuery(): IVoltQuery<IGitHubAccount | undefined> {
		return {
			key: ACCOUNT_KEY,
			staleTime: 10 * 60_000,
			fetch: async () => {
				const session = await this.session(false);
				const user = session && await this.get<{ login: string }>(session, '/user', CancellationToken.None).catch(() => undefined);
				const account = session ? { login: user?.login ?? session.account.label } : undefined;
				// A re-check (behind a cached answer, or after a session change) found another account or none: pages redraw.
				if (account?.login !== this.knownLogin) {
					const first = this.knownLogin === null;
					this.knownLogin = account?.login;
					this.accountCache = Promise.resolve(account);
					if (!first) {
						this._onDidChangeAccount.fire();
					}
				}
				return account;
			},
		};
	}

	/** The session changed here: the next answer waits for the real account, and every page is stale. */
	private refreshAccount(): void {
		this.accountCache = this.cache.get(this.accountQuery(), true).catch(() => undefined);
		this.cache.invalidate(REPOS_KEY);
	}

	async signIn(): Promise<boolean> {
		try {
			await this.authenticationService.createSession(PROVIDER, SCOPES);
		} catch (err) {
			this.logService.info('[volt-github] sign-in cancelled or failed', err);
			return false;
		}
		this.refreshAccount();
		return !!await this.account();
	}

	watchPage(login: string, page: number): IVoltQueryHandle<IGitHubRepoPage> {
		return this.cache.watch<IGitHubRepoPage>({
			key: `${REPOS_KEY}${login}:${page}`,
			staleTime: 2 * 60_000,
			persist: page <= PERSISTED_PAGES,
			fetch: async () => {
				const session = await this.session(false);
				if (!session) {
					return { repos: [], hasMore: false };
				}
				const raw = await this.get<IApiRepo[]>(session, `/user/repos?sort=pushed&per_page=${PER_PAGE}&page=${page}&affiliation=owner,collaborator,organization_member`, CancellationToken.None);
				return { repos: raw.map(toRepo), hasMore: raw.length === PER_PAGE };
			},
		});
	}

	async search(query: string, everywhere: boolean, token: CancellationToken): Promise<readonly IGitHubRepo[]> {
		const session = await this.session(false);
		const account = session ? await this.account() : undefined;
		const scope = everywhere || !account ? '' : ` user:${account.login}`;
		const q = encodeURIComponent(`${query} in:name fork:true${scope}`);
		const request = `/search/repositories?q=${q}&per_page=50`;
		const result = session
			? await this.get<{ items: IApiRepo[] }>(session, request, token)
			: await this.getPublic<{ items: IApiRepo[] }>(request, token);
		return (result.items ?? []).map(toRepo);
	}

	async authHeader(): Promise<string | undefined> {
		const session = await this.session(false);
		return session ? `AUTHORIZATION: basic ${encodeBase64(VSBuffer.fromString(`x-access-token:${session.accessToken}`))}` : undefined;
	}

	private async session(create: boolean): Promise<AuthenticationSession | undefined> {
		try {
			const sessions = await this.authenticationService.getSessions(PROVIDER, SCOPES, undefined, true);
			if (sessions.length || !create) {
				return sessions[0];
			}
			return await this.authenticationService.createSession(PROVIDER, SCOPES);
		} catch (err) {
			this.logService.trace('[volt-github] no session', err);
			return undefined;
		}
	}

	private get<T>(session: AuthenticationSession, path: string, token: CancellationToken): Promise<T> {
		return this.fetch<T>(path, token, { Authorization: `token ${session.accessToken}` }, `session:${session.account.id}`);
	}

	private getPublic<T>(path: string, token: CancellationToken): Promise<T> {
		return this.fetch<T>(path, token, {}, 'anonymous');
	}

	private async fetch<T>(path: string, token: CancellationToken, headers: Record<string, string>, account: string): Promise<T> {
		const resource = path.startsWith('/search/') ? 'search' : 'core';
		const refusal = this.quota.admit(account, resource, 'interactive');
		if (refusal) {
			throw new Error(describeGithubRefusal(refusal, HOST));
		}
		const context = await this.requestService.request({
			type: 'GET',
			url: `${API}${path}`,
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Volt', ...headers },
		}, token);
		const status = context.res.statusCode ?? 0;
		const responseHeaders = githubHeaders(context.res.headers);
		const reading = readGithubRateLimit(responseHeaders);
		this.quota.observe(account, reading);
		if (status < 200 || status >= 300) {
			let message = '';
			try {
				message = String((JSON.parse(await asText(context) ?? '') as { message?: unknown } | null)?.message ?? '');
			} catch {
				// Not JSON: the status says enough.
			}
			if (isGithubRateLimitAnswer(status, responseHeaders, message)) {
				// Wait for GitHub's reset (or its `retry-after`) without asking again; not every 403 is this.
				const exhausted = !responseHeaders.has('retry-after') && reading !== undefined && reading.remaining <= 0;
				const retryAt = exhausted && reading ? reading.resetAt : this.quota.pauseEnd(responseHeaders);
				this.quota.pause(account, retryAt, exhausted && reading ? reading.resource : undefined);
				throw new Error(describeGithubRefusal({ resource: reading?.resource ?? resource, retryAt, reason: exhausted ? 'exhausted' : 'paused' }, HOST));
			}
			throw new Error(message ? `GitHub request failed (${status}): ${message}` : `GitHub request failed (${status}).`);
		}
		const json = await asJson<T>(context);
		if (!json) {
			throw new Error('GitHub returned an empty response.');
		}
		return json;
	}
}

function toRepo(repo: IApiRepo): IGitHubRepo {
	return {
		fullName: repo.full_name,
		owner: repo.owner.login,
		name: repo.name,
		private: repo.private,
		fork: repo.fork,
		description: repo.description ?? undefined,
		cloneUrl: repo.clone_url,
		language: repo.language ?? undefined,
		stars: repo.stargazers_count,
		pushedAt: repo.pushed_at ?? undefined,
		defaultBranch: repo.default_branch,
	};
}
