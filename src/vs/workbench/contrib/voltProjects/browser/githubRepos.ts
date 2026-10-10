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

export const IGitHubReposService = createDecorator<IGitHubReposService>('voltGitHubReposService');

/** The signed-in user's GitHub repositories, for Add Project → GitHub. Mirrors VS Code's GitHub remote source. */
export interface IGitHubReposService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAccount: Event<void>;
	/** Never prompts. */
	account(): Promise<IGitHubAccount | undefined>;
	signIn(): Promise<boolean>;
	/** One page of the user's repos, most recently pushed first. */
	page(page: number, token: CancellationToken): Promise<{ readonly repos: readonly IGitHubRepo[]; readonly hasMore: boolean }>;
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
	private readonly pages = new Map<number, { readonly repos: readonly IGitHubRepo[]; readonly hasMore: boolean }>();
	/**
	 * GitHub's rate limits as its answers report them. Search has its own small quota (30 a minute
	 * signed in, 10 without): once it is used up, searches wait for its reset without a request.
	 */
	private readonly quota = new VoltGithubQuota();

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === PROVIDER) {
				this.accountCache = undefined;
				this.pages.clear();
				this._onDidChangeAccount.fire();
			}
		}));
	}

	account(): Promise<IGitHubAccount | undefined> {
		this.accountCache ??= this.session(false).then(async session => {
			if (!session) {
				return undefined;
			}
			const user = await this.get<{ login: string }>(session, '/user', CancellationToken.None).catch(() => undefined);
			return { login: user?.login ?? session.account.label };
		});
		return this.accountCache;
	}

	async signIn(): Promise<boolean> {
		try {
			await this.authenticationService.createSession(PROVIDER, SCOPES);
		} catch (err) {
			this.logService.info('[volt-github] sign-in cancelled or failed', err);
			return false;
		}
		this.accountCache = undefined;
		this.pages.clear();
		this._onDidChangeAccount.fire();
		return !!await this.account();
	}

	async page(page: number, token: CancellationToken): Promise<{ readonly repos: readonly IGitHubRepo[]; readonly hasMore: boolean }> {
		const cached = this.pages.get(page);
		if (cached) {
			return cached;
		}
		const session = await this.session(false);
		if (!session) {
			return { repos: [], hasMore: false };
		}
		const raw = await this.get<IApiRepo[]>(session, `/user/repos?sort=pushed&per_page=${PER_PAGE}&page=${page}&affiliation=owner,collaborator,organization_member`, token);
		const result = { repos: raw.map(toRepo), hasMore: raw.length === PER_PAGE };
		this.pages.set(page, result);
		return result;
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
