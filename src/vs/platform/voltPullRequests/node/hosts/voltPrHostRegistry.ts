/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { hostEndpoints, hostName, hostProductLabel, normalizeHost, providerForKnownHost, providerFromProbe, readHostSettings, VoltPrSupportedProvider } from '../../common/voltPrHosts.js';
import { IVoltPrAccount, IVoltPrHostCredential, IVoltPrHostInfo, IVoltPrSignInRequest, VoltPrAuthSource, VoltPrError, VoltPrProvider, voltPrErrorMessage } from '../../common/voltPullRequests.js';
import { AzureClient } from './azureClient.js';
import { BitbucketClient } from './bitbucketClient.js';
import { GiteaClient } from './giteaClient.js';
import { GitlabClient } from './gitlabClient.js';
import { IVoltPrHostClient } from './voltPrHostClient.js';
import { basicAuth, VoltPrFetch, VoltPrHttp } from './voltPrHttp.js';

/** Azure DevOps' resource id, for `az account get-access-token`. */
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_TTL_MS = 10 * 60_000;
const CLI_TTL_MS = 5 * 60_000;

interface IRun {
	readonly code: number | null;
	readonly stdout: string;
	readonly spawnError?: string;
}

export interface IVoltPrHostRegistryOptions {
	readonly run: (command: string, args: readonly string[], timeoutMs: number) => Promise<IRun>;
	readonly env: () => Promise<NodeJS.ProcessEnv>;
	/** `volt.sourceControl.hosts`. */
	readonly settings?: () => unknown;
	/** Hosts the GitHub CLI is signed in to (Enterprise servers). */
	readonly githubHosts: () => Promise<ReadonlySet<string>>;
	readonly fetch?: VoltPrFetch;
	readonly homeDir?: string;
}

interface IResolvedAuth {
	readonly token: string;
	readonly username?: string;
	readonly source: VoltPrAuthSource;
	readonly login?: string;
	readonly webUrl?: string;
}

/**
 * Knows every code host that is not GitHub: what each one is (by name, setting, sign-in or a probe
 * of its version endpoint), where it lives, which token reads it (Volt's sign-in first, then the
 * host's CLI, then its usual environment variable), and hands out one REST client per host.
 */
export class VoltPrHostRegistry {

	private credentials = new Map<string, IVoltPrHostCredential>();
	private readonly probes = new Map<string, { at: number; result: Promise<{ provider: VoltPrSupportedProvider; flavor?: 'gitea' | 'forgejo' } | undefined> }>();
	private readonly cliAuth = new Map<string, { at: number; auth: Promise<IResolvedAuth | undefined> }>();
	private readonly clients = new Map<string, { signature: string; client: IVoltPrHostClient }>();
	private readonly flavors = new Map<string, 'gitea' | 'forgejo'>();

	constructor(private readonly options: IVoltPrHostRegistryOptions) { }

	setCredentials(credentials: readonly IVoltPrHostCredential[]): void {
		this.credentials = new Map(credentials.filter(credential => credential.host && credential.token).map(credential => [normalizeHost(credential.host) ?? credential.host, credential]));
		this.clients.clear();
	}

	refresh(): void {
		this.cliAuth.clear();
		this.probes.clear();
		this.clients.clear();
	}

	/** Providers known for hosts without probing (sign-ins and settings), for reading remotes. */
	knownProviders(): Map<string, VoltPrProvider> {
		const known = new Map<string, VoltPrProvider>();
		for (const [host, setting] of readHostSettings(this.options.settings?.())) {
			known.set(host, setting.provider);
		}
		for (const [host, credential] of this.credentials) {
			known.set(host, credential.provider);
		}
		return known;
	}

	/** What a host is; probes an unknown one once (cached), unless `probe` is false. */
	async info(host: string, probe = true): Promise<IVoltPrHostInfo> {
		const key = normalizeHost(host) ?? host.toLowerCase();
		const setting = readHostSettings(this.options.settings?.()).get(key);
		const credential = this.credentials.get(key);
		const githubHosts = await this.options.githubHosts().catch(() => new Set<string>());
		let provider: VoltPrProvider;
		let detectedBy: IVoltPrHostInfo['detectedBy'];
		if (credential && credential.provider !== 'unknown') {
			provider = credential.provider;
			detectedBy = 'signIn';
		} else if (setting) {
			provider = setting.provider;
			detectedBy = 'setting';
		} else if (githubHosts.has(key)) {
			provider = 'github';
			detectedBy = 'gh';
		} else {
			provider = providerForKnownHost(key);
			detectedBy = provider === 'unknown' ? 'unknown' : 'name';
		}
		if (provider === 'unknown' && probe) {
			const found = await this.probe(key, setting?.url ?? credential?.webUrl);
			if (found) {
				provider = found.provider;
				detectedBy = 'probe';
				if (found.flavor) {
					this.flavors.set(key, found.flavor);
				}
			}
		}
		const webUrl = credential?.webUrl ?? setting?.url;
		if (provider === 'unknown') {
			return { host: key, provider, webUrl: webUrl ?? `https://${key}`, detectedBy };
		}
		const endpoints = hostEndpoints(provider, key, webUrl);
		const auth = provider === 'github' ? undefined : await this.auth(key, provider);
		const flavor = this.flavors.get(key) ?? (provider === 'gitea' && /codeberg|forgejo/.test(key) ? 'forgejo' : undefined);
		return {
			host: key,
			provider,
			...(flavor ? { flavor } : {}),
			webUrl: endpoints.webUrl,
			apiUrl: endpoints.apiUrl,
			...(auth ? { auth: { source: auth.source, ...(auth.login ? { login: auth.login } : {}) } } : {}),
			detectedBy,
		};
	}

	/** The REST client for a host that is not GitHub; undefined for GitHub and hosts nobody recognizes. */
	async client(host: string): Promise<IVoltPrHostClient | undefined> {
		const info = await this.info(host);
		if (info.provider === 'github' || info.provider === 'unknown') {
			return undefined;
		}
		const auth = await this.auth(info.host, info.provider);
		if (!auth) {
			throw new VoltPrError('noAuth', `Sign in to ${hostProductLabel(info.provider, info.flavor)} (${info.host}) to work with its ${info.provider === 'gitlab' ? 'merge requests' : 'pull requests'}.`);
		}
		const signature = `${info.provider}\u0000${info.apiUrl}\u0000${auth.source}\u0000${auth.username ?? ''}\u0000${auth.token}`;
		const cached = this.clients.get(info.host);
		if (cached?.signature === signature) {
			return cached.client;
		}
		const client = this.createClient(info.provider, info.apiUrl!, info.webUrl, auth, info.flavor);
		this.clients.set(info.host, { signature, client });
		return client;
	}

	private createClient(provider: VoltPrSupportedProvider, apiUrl: string, webUrl: string, auth: { token: string; username?: string }, flavor?: 'gitea' | 'forgejo'): IVoltPrHostClient {
		const headers = authHeaders(provider, auth);
		const http = new VoltPrHttp(apiUrl, async () => headers, hostProductLabel(provider, flavor), this.options.fetch);
		switch (provider) {
			case 'gitea': return new GiteaClient(http);
			case 'gitlab': return new GitlabClient(http);
			case 'bitbucket': return new BitbucketClient(http);
			case 'azure': return new AzureClient(http, webUrl);
			case 'github': throw new VoltPrError('failed', 'GitHub goes through the GitHub CLI.');
		}
	}

	/** Checks a token by asking the host who it belongs to. */
	async signIn(request: IVoltPrSignInRequest): Promise<IVoltPrAccount> {
		const host = normalizeHost(request.host) ?? normalizeHost(request.webUrl ?? '') ?? request.host;
		if (request.provider === 'github' || request.provider === 'unknown') {
			throw new VoltPrError('unsupported', request.provider === 'github' ? 'GitHub signs in through the GitHub CLI (gh auth login).' : 'Pick the kind of server first.');
		}
		const webUrl = request.webUrl?.replace(/\/+$/, '');
		const { apiUrl, webUrl: web } = hostEndpoints(request.provider, host, webUrl);
		const client = this.createClient(request.provider, apiUrl, web, { token: request.token.trim(), ...(request.username ? { username: request.username.trim() } : {}) });
		let login: string;
		try {
			login = await client.viewer(request.owner);
		} catch (err) {
			throw new VoltPrError('noAuth', `${hostProductLabel(request.provider)} did not accept the token: ${voltPrErrorMessage(err)}`);
		}
		return { host, login, active: true, ok: true, provider: request.provider, source: 'volt' };
	}

	/** Signed-in accounts on hosts that are not GitHub (Volt's tokens, plus CLI logins it found). */
	async accounts(): Promise<IVoltPrAccount[]> {
		const out: IVoltPrAccount[] = [];
		for (const credential of this.credentials.values()) {
			out.push({ host: normalizeHost(credential.host) ?? credential.host, login: credential.login ?? credential.username ?? '', active: true, ok: true, provider: credential.provider, source: 'volt' });
		}
		return out;
	}

	private async auth(host: string, provider: VoltPrSupportedProvider): Promise<IResolvedAuth | undefined> {
		const credential = this.credentials.get(host);
		if (credential) {
			return { token: credential.token, source: 'volt', ...(credential.username ? { username: credential.username } : {}), ...(credential.login ? { login: credential.login } : {}), ...(credential.webUrl ? { webUrl: credential.webUrl } : {}) };
		}
		const key = `${provider}\u0000${host}`;
		const now = Date.now();
		let entry = this.cliAuth.get(key);
		if (!entry || now - entry.at > CLI_TTL_MS) {
			entry = { at: now, auth: this.cliToken(host, provider).catch(() => undefined) };
			this.cliAuth.set(key, entry);
		}
		return entry.auth;
	}

	/** The host's own CLI login (glab, tea, az), else its usual environment variable. */
	private async cliToken(host: string, provider: VoltPrSupportedProvider): Promise<IResolvedAuth | undefined> {
		const env = await this.options.env();
		const name = hostName(host);
		switch (provider) {
			case 'gitlab': {
				const glab = await this.options.run('glab', ['config', 'get', 'token', '--host', host], 10_000);
				if (glab.code === 0 && glab.stdout.trim()) {
					return { token: glab.stdout.trim(), source: 'cli' };
				}
				const gitlabHost = env.GITLAB_HOST ? normalizeHost(env.GITLAB_HOST) : 'gitlab.com';
				const token = env.GITLAB_TOKEN || env.GITLAB_ACCESS_TOKEN || env.GL_TOKEN;
				return token && gitlabHost === host ? { token, source: 'env' } : undefined;
			}
			case 'gitea': {
				const tea = await this.teaLogin(host);
				if (tea) {
					return tea;
				}
				const token = env.GITEA_TOKEN || env.FORGEJO_TOKEN;
				const giteaHost = env.GITEA_SERVER_URL || env.GITEA_HOST || env.FORGEJO_URL;
				return token && giteaHost && normalizeHost(giteaHost) === host ? { token, source: 'env' } : undefined;
			}
			case 'azure': {
				if (env.AZURE_DEVOPS_EXT_PAT) {
					return { token: env.AZURE_DEVOPS_EXT_PAT, source: 'env' };
				}
				const az = await this.options.run('az', ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], 20_000);
				return az.code === 0 && az.stdout.trim() ? { token: az.stdout.trim(), source: 'cli' } : undefined;
			}
			case 'bitbucket': {
				const token = env.BITBUCKET_TOKEN || env.BITBUCKET_APP_PASSWORD || env.BITBUCKET_API_TOKEN;
				return token && name === 'bitbucket.org' ? { token, ...(env.BITBUCKET_USERNAME ? { username: env.BITBUCKET_USERNAME } : {}), source: 'env' } : undefined;
			}
			case 'github':
				return undefined;
		}
	}

	/** tea keeps its logins in a small YAML file: `logins: - name, url, token, user`. */
	private async teaLogin(host: string): Promise<IResolvedAuth | undefined> {
		const home = this.options.homeDir ?? (await this.options.env()).HOME;
		if (!home) {
			return undefined;
		}
		for (const file of [join(home, '.config', 'tea', 'config.yml'), join(home, 'Library', 'Application Support', 'tea', 'config.yml')]) {
			let text: string;
			try {
				text = await fs.readFile(file, 'utf8');
			} catch {
				continue;
			}
			const login = parseTeaConfig(text).find(entry => normalizeHost(entry.url) === host);
			if (login?.token) {
				return { token: login.token, source: 'cli', ...(login.user ? { login: login.user } : {}) };
			}
		}
		return undefined;
	}

	/** Asks an unknown host's version endpoints what it is: Gitea / Forgejo (`/api/v1/version`), GitLab (`/api/v4/version`). */
	private probe(host: string, webUrl?: string): Promise<{ provider: VoltPrSupportedProvider; flavor?: 'gitea' | 'forgejo' } | undefined> {
		const now = Date.now();
		const cached = this.probes.get(host);
		if (cached && now - cached.at < PROBE_TTL_MS) {
			return cached.result;
		}
		const base = (webUrl ?? hostEndpoints('gitea', host).webUrl).replace(/\/+$/, '');
		const fetchImpl = this.options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
		const ask = async (path: 'gitea' | 'gitlab') => {
			try {
				const response = await fetchImpl(`${base}${path === 'gitea' ? '/api/v1/version' : '/api/v4/version'}`, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
				return providerFromProbe(path, response.status, await response.text());
			} catch {
				return undefined;
			}
		};
		const result = (async () => (await ask('gitea')) ?? (await ask('gitlab')))();
		this.probes.set(host, { at: now, result });
		return result;
	}
}

export function authHeaders(provider: VoltPrSupportedProvider, auth: { readonly token: string; readonly username?: string }): Record<string, string> {
	switch (provider) {
		case 'gitea':
			return { Authorization: `token ${auth.token}` };
		case 'gitlab':
			return { Authorization: `Bearer ${auth.token}` };
		case 'bitbucket':
			return { Authorization: auth.username ? basicAuth(auth.username, auth.token) : `Bearer ${auth.token}` };
		case 'azure':
			// An `az` access token is a JWT; a personal access token goes in as the password of an empty user.
			return { Authorization: /^eyJ/.test(auth.token) ? `Bearer ${auth.token}` : basicAuth('', auth.token) };
		case 'github':
			return { Authorization: `Bearer ${auth.token}` };
	}
}

/** `logins:` entries of tea's config.yml. Only the flat keys Volt needs are read. */
export function parseTeaConfig(text: string): { name?: string; url: string; token?: string; user?: string }[] {
	const out: { name?: string; url: string; token?: string; user?: string }[] = [];
	let current: Record<string, string> | undefined;
	let inLogins = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^logins:\s*$/.test(line)) {
			inLogins = true;
			continue;
		}
		if (/^\S/.test(line)) {
			inLogins = false;
		}
		if (!inLogins) {
			continue;
		}
		const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
		const field = /^\s+(\w+):\s*(.*)$/.exec(line);
		if (item) {
			if (current?.url) {
				out.push(current as { url: string });
			}
			current = { [item[1]]: unquote(item[2]) };
		} else if (field && current) {
			current[field[1]] = unquote(field[2]);
		}
	}
	if (current?.url) {
		out.push(current as { url: string });
	}
	return out;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
