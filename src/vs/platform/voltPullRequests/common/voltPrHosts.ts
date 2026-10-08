/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltPrRepoRef, VoltPrProvider } from './voltPullRequests.js';

/**
 * Code hosts other than GitHub: which one a remote's host is, where its API lives, what it calls a
 * pull request, and the URLs people open. Pure, so every rule is unit tested; the main process
 * service reads hosts through it and the views label things with it.
 */

/** A provider Volt can read and write pull requests on. */
export type VoltPrSupportedProvider = Exclude<VoltPrProvider, 'unknown'>;

export const VOLT_PR_PROVIDERS: readonly VoltPrSupportedProvider[] = ['github', 'gitlab', 'bitbucket', 'gitea', 'azure'];

export function isSupportedProvider(provider: VoltPrProvider | undefined): provider is VoltPrSupportedProvider {
	return !!provider && provider !== 'unknown';
}

/** What a host calls its pull requests: GitLab has merge requests (`!12`), the rest pull requests (`#12`). */
export interface IVoltPrTerms {
	/** "pull request", "merge request". */
	readonly noun: string;
	/** "Pull Request", "Merge Request". */
	readonly title: string;
	/** "Pull requests". */
	readonly plural: string;
	/** "PR", "MR". */
	readonly short: string;
	/** "#", "!". */
	readonly sigil: string;
}

const PULL_REQUEST_TERMS: IVoltPrTerms = { noun: 'pull request', title: 'Pull Request', plural: 'Pull requests', short: 'PR', sigil: '#' };
const MERGE_REQUEST_TERMS: IVoltPrTerms = { noun: 'merge request', title: 'Merge Request', plural: 'Merge requests', short: 'MR', sigil: '!' };

export function prTerms(provider: VoltPrProvider | undefined): IVoltPrTerms {
	return provider === 'gitlab' ? MERGE_REQUEST_TERMS : PULL_REQUEST_TERMS;
}

/** `#12` or `!12`. */
export function prRef(provider: VoltPrProvider | undefined, number: number): string {
	return `${prTerms(provider).sigil}${number}`;
}

/** The host's product name. Gitea and Forgejo share an API; `flavor` says which one answered. */
export function hostProductLabel(provider: VoltPrProvider, flavor?: 'gitea' | 'forgejo'): string {
	switch (provider) {
		case 'github': return 'GitHub';
		case 'gitlab': return 'GitLab';
		case 'bitbucket': return 'Bitbucket';
		case 'gitea': return flavor === 'forgejo' ? 'Forgejo' : 'Gitea';
		case 'azure': return 'Azure DevOps';
		case 'unknown': return 'this host';
	}
}

/** Hosts known by name, before any probe or setting. */
export function providerForKnownHost(host: string): VoltPrProvider {
	const h = hostName(host);
	if (h === 'github.com' || h === 'ssh.github.com' || h.endsWith('.ghe.com')) {
		return 'github';
	}
	if (h === 'gitlab.com' || h.startsWith('gitlab.') || h.includes('.gitlab.')) {
		return 'gitlab';
	}
	if (h === 'bitbucket.org' || h.startsWith('bitbucket.')) {
		return 'bitbucket';
	}
	if (h === 'codeberg.org' || h === 'gitea.com' || h.startsWith('gitea.') || h.startsWith('forgejo.') || h.startsWith('git.forgejo.') || h === 'next.forgejo.org') {
		return 'gitea';
	}
	if (h === 'dev.azure.com' || h.endsWith('.dev.azure.com') || h.endsWith('.visualstudio.com')) {
		return 'azure';
	}
	return 'unknown';
}

/** `localhost:3300` → `localhost`. */
export function hostName(host: string): string {
	const lower = host.trim().toLowerCase();
	if (lower.startsWith('[')) {
		const end = lower.indexOf(']');
		return end > 0 ? lower.slice(0, end + 1) : lower;
	}
	const colon = lower.lastIndexOf(':');
	return colon > 0 && /^\d+$/.test(lower.slice(colon + 1)) ? lower.slice(0, colon) : lower;
}

/** `{ "git.corp:8443": "gitlab" }` or `{ "git.corp": { "provider": "gitea", "url": "https://git.corp/forge" } }`. */
export const VOLT_SOURCE_CONTROL_HOSTS_SETTING = 'volt.sourceControl.hosts';

/**
 * The user's own word on a host (`volt.sourceControl.hosts`): a provider name, or an object with
 * the provider and the address of its web UI (`{ "provider": "gitlab", "url": "https://git.corp:8443" }`).
 */
export interface IVoltPrHostSetting {
	readonly provider: VoltPrSupportedProvider;
	readonly url?: string;
}

export function readHostSettings(value: unknown): Map<string, IVoltPrHostSetting> {
	const out = new Map<string, IVoltPrHostSetting>();
	if (!value || typeof value !== 'object') {
		return out;
	}
	for (const [rawHost, raw] of Object.entries(value as Record<string, unknown>)) {
		const host = normalizeHost(rawHost);
		if (!host) {
			continue;
		}
		if (typeof raw === 'string' && isProviderName(raw)) {
			out.set(host, { provider: raw });
		} else if (raw && typeof raw === 'object' && isProviderName((raw as { provider?: unknown }).provider)) {
			const url = (raw as { url?: unknown }).url;
			out.set(host, { provider: (raw as { provider: VoltPrSupportedProvider }).provider, ...(typeof url === 'string' && /^https?:\/\//i.test(url) ? { url: url.replace(/\/+$/, '') } : {}) });
		}
	}
	return out;
}

function isProviderName(value: unknown): value is VoltPrSupportedProvider {
	return typeof value === 'string' && (VOLT_PR_PROVIDERS as readonly string[]).includes(value);
}

/** `https://Git.Corp:8443/` → `git.corp:8443`; a bare host stays as it is (lower case). */
export function normalizeHost(value: string): string | undefined {
	const raw = value.trim();
	if (!raw) {
		return undefined;
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		try {
			return new URL(raw).host.toLowerCase() || undefined;
		} catch {
			return undefined;
		}
	}
	return /^[a-z0-9.\-\[\]:]+$/i.test(raw) ? raw.toLowerCase().replace(/\/+$/, '') : undefined;
}

export interface IVoltPrHostEndpoints {
	/** The web UI's root, no trailing slash: `https://gitlab.com`, `http://localhost:3300`. */
	readonly webUrl: string;
	/** The REST root, no trailing slash. */
	readonly apiUrl: string;
}

/**
 * Where a host's web UI and REST API live. `webUrl` comes from a setting or a sign-in (self-hosted
 * servers on another port or path); otherwise https on the host, except plain-http loopback hosts.
 */
export function hostEndpoints(provider: VoltPrSupportedProvider, host: string, webUrl?: string): IVoltPrHostEndpoints {
	const web = (webUrl ?? defaultWebUrl(host)).replace(/\/+$/, '');
	switch (provider) {
		case 'github':
			return { webUrl: web, apiUrl: hostName(host) === 'github.com' ? 'https://api.github.com' : `${web}/api/v3` };
		case 'gitlab':
			return { webUrl: web, apiUrl: `${web}/api/v4` };
		case 'gitea':
			return { webUrl: web, apiUrl: `${web}/api/v1` };
		case 'bitbucket':
			// Bitbucket Cloud's API has its own host; a test server stands in for both with `webUrl`.
			return { webUrl: web, apiUrl: hostName(host) === 'bitbucket.org' && !webUrl ? 'https://api.bitbucket.org/2.0' : `${web}/2.0` };
		case 'azure':
			return { webUrl: web, apiUrl: web };
	}
}

function defaultWebUrl(host: string): string {
	const name = hostName(host);
	const loopback = name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name.endsWith('.localhost');
	return `${loopback ? 'http' : 'https'}://${host}`;
}

/** The pull request's page on the host. */
export function pullRequestWebUrl(provider: VoltPrProvider, webUrl: string, repo: Pick<IVoltPrRepoRef, 'owner' | 'name'>, number: number): string {
	const base = webUrl.replace(/\/+$/, '');
	switch (provider) {
		case 'gitlab': return `${base}/${repo.owner}/${repo.name}/-/merge_requests/${number}`;
		case 'gitea': return `${base}/${repo.owner}/${repo.name}/pulls/${number}`;
		case 'bitbucket': return `${base}/${repo.owner}/${repo.name}/pull-requests/${number}`;
		case 'azure': return `${base}/${repo.owner}/_git/${repo.name}/pullrequest/${number}`;
		default: return `${base}/${repo.owner}/${repo.name}/pull/${number}`;
	}
}

/** The repository's page on the host. */
export function repositoryWebUrl(provider: VoltPrProvider, webUrl: string, repo: Pick<IVoltPrRepoRef, 'owner' | 'name'>): string {
	const base = webUrl.replace(/\/+$/, '');
	return provider === 'azure' ? `${base}/${repo.owner}/_git/${repo.name}` : `${base}/${repo.owner}/${repo.name}`;
}

/** Where the user makes a token Volt can use, with the scopes it needs filled in when the host allows. */
export function tokenPageUrl(provider: VoltPrProvider, webUrl: string, owner?: string): string {
	const base = webUrl.replace(/\/+$/, '');
	switch (provider) {
		case 'gitlab': return `${base}/-/user_settings/personal_access_tokens?name=Volt&scopes=api`;
		case 'gitea': return `${base}/user/settings/applications`;
		case 'bitbucket': return 'https://bitbucket.org/account/settings/api-tokens/';
		case 'azure': return `${base}/${owner?.split('/')[0] ?? ''}/_usersSettings/tokens`.replace(/\/\/_/, '/_');
		default: return `${base}/settings/tokens`;
	}
}

/** The scopes to tick when making the token, for the sign-in prompt. */
export function tokenScopesHint(provider: VoltPrProvider): string {
	switch (provider) {
		case 'gitlab': return 'api';
		case 'gitea': return 'repository: read and write, issue: read and write, user: read';
		case 'bitbucket': return 'read:pullrequest, write:pullrequest, read:repository, read:user (with your Atlassian email as the username)';
		case 'azure': return 'Code: Read & write';
		default: return 'repo';
	}
}

/**
 * A pull request (merge request) URL on any provider: GitHub `/o/n/pull/12`, Gitea `/o/n/pulls/12`,
 * GitLab `/group/sub/proj/-/merge_requests/12`, Bitbucket `/ws/repo/pull-requests/12`, Azure
 * `/org/project/_git/repo/pullrequest/12` (and `org.visualstudio.com/project/_git/...`).
 */
export function parseChangeRequestUrl(url: string): { repo: IVoltPrRepoRef; number: number; provider: VoltPrProvider } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return undefined;
	}
	if (!/^https?:$/.test(parsed.protocol)) {
		return undefined;
	}
	const host = parsed.host.toLowerCase();
	const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '');
	const finish = (owner: string, name: string, raw: string, provider: VoltPrProvider) => {
		const number = Number(raw);
		return owner && name && Number.isSafeInteger(number) && number > 0 ? { repo: { host, owner, name: name.replace(/\.git$/i, '') }, number, provider } : undefined;
	};
	let match = /^\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(path);
	if (match) {
		return finish(match[1], match[2], match[3], 'gitlab');
	}
	match = /^\/(.+?)\/_git\/([^/]+)\/pullrequest\/(\d+)(?:\/.*)?$/i.exec(path);
	if (match) {
		const segments = match[1].split('/').filter(segment => segment && segment.toLowerCase() !== 'defaultcollection');
		const org = host.endsWith('.visualstudio.com') ? host.slice(0, -'.visualstudio.com'.length) : undefined;
		const owner = org ? [org, ...segments].slice(0, 2).join('/') : segments.slice(0, 2).join('/');
		const result = finish(owner, match[2], match[3], 'azure');
		return result && { ...result, repo: { ...result.repo, host: 'dev.azure.com' } };
	}
	match = /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/.*)?$/.exec(path);
	if (match) {
		return finish(match[1], match[2], match[3], 'bitbucket');
	}
	match = /^\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\/.*)?$/.exec(path);
	if (match) {
		return finish(match[1], match[2], match[3], providerForKnownHost(host) === 'github' ? 'github' : 'gitea');
	}
	match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(path);
	if (match) {
		return finish(match[1], match[2], match[3], 'github');
	}
	return undefined;
}

/** Pull request URLs of any provider in a text (an agent's reply). */
export function findChangeRequestUrls(text: string): string[] {
	const found = new Set<string>();
	const pattern = /https?:\/\/[a-z0-9.:-]+\/[^\s)<>"'`\]]+?\/(?:pull|pulls|pull-requests|pullrequest|-\/merge_requests)\/\d+/gi;
	for (const match of text.matchAll(pattern)) {
		if (parseChangeRequestUrl(match[0])) {
			found.add(match[0]);
		}
	}
	return [...found];
}

/** The ref a host keeps a pull request's head commit under, for `git fetch`; undefined when it keeps none. */
export function pullRequestHeadRef(provider: VoltPrProvider, number: number): string | undefined {
	switch (provider) {
		case 'github':
		case 'gitea': return `refs/pull/${number}/head`;
		case 'gitlab': return `refs/merge-requests/${number}/head`;
		// Azure keeps only the merge preview (refs/pull/N/merge); Bitbucket Cloud keeps none.
		default: return undefined;
	}
}

/** What the response of a probe says about an unknown host: `GET /api/v1/version` (Gitea, Forgejo), `GET /api/v4/version` (GitLab). */
export function providerFromProbe(path: 'gitea' | 'gitlab', status: number, body: string): { provider: VoltPrSupportedProvider; flavor?: 'gitea' | 'forgejo' } | undefined {
	let json: { version?: unknown; message?: unknown } | undefined;
	try {
		json = JSON.parse(body);
	} catch {
		json = undefined;
	}
	if (path === 'gitea') {
		if (status === 200 && typeof json?.version === 'string') {
			return { provider: 'gitea', flavor: /forgejo|\+gitea-/i.test(json.version) ? 'forgejo' : 'gitea' };
		}
		return undefined;
	}
	// GitLab answers 401 {"message":"401 Unauthorized"} without a token, and the version with one.
	if ((status === 200 && typeof json?.version === 'string') || (status === 401 && typeof json?.message === 'string' && /401/.test(json.message))) {
		return { provider: 'gitlab' };
	}
	return undefined;
}
