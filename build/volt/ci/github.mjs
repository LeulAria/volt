/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A small GitHub REST client for the CI scripts (pr.mjs, review/). No dependencies: the scripts
// run straight from a base-branch checkout in pull_request_target workflows, before any install.

/**
 * @typedef {{ status: number, headers: Headers, data: any }} GitHubResponse
 */

export class GitHubError extends Error {
	/**
	 * @param {string} message
	 * @param {number} status
	 * @param {unknown} body
	 */
	constructor(message, status, body) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

export class GitHub {
	/**
	 * @param {{ token: string, repository: string, apiUrl?: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} options
	 */
	constructor(options) {
		if (!options.token) {
			throw new Error('GITHUB_TOKEN is required');
		}
		const [owner, repo] = options.repository.split('/');
		this.owner = owner;
		this.repo = repo;
		this.token = options.token;
		this.apiUrl = (options.apiUrl || 'https://api.github.com').replace(/\/$/, '');
		this.fetch = options.fetch ?? globalThis.fetch;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	}

	/** Repository-scoped path: `repoPath('/pulls/1')` is `/repos/<owner>/<repo>/pulls/1`. */
	repoPath(/** @type {string} */ path) {
		return `/repos/${this.owner}/${this.repo}${path}`;
	}

	/**
	 * @param {string} method
	 * @param {string} path absolute API path or full URL
	 * @param {unknown} [body]
	 * @param {{ accept?: string, allow?: number[] }} [options] `allow`: statuses returned instead of thrown
	 * @returns {Promise<GitHubResponse>}
	 */
	async request(method, path, body, options = {}) {
		const url = path.startsWith('http') ? path : `${this.apiUrl}${path}`;
		for (let attempt = 1; ; attempt++) {
			/** @type {Response} */
			let response;
			try {
				response = await this.fetch(url, {
					method,
					headers: {
						accept: options.accept ?? 'application/vnd.github+json',
						authorization: `Bearer ${this.token}`,
						'x-github-api-version': '2022-11-28',
						'user-agent': 'volt-ci',
						...(body === undefined ? {} : { 'content-type': 'application/json' }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			} catch (error) {
				if (attempt < 4) {
					await this.sleep(1000 * 2 ** attempt);
					continue;
				}
				throw error;
			}
			const text = await response.text();
			/** @type {any} */
			let data = text;
			if ((response.headers.get('content-type') ?? '').includes('json') && text) {
				data = JSON.parse(text);
			}
			if (response.ok || options.allow?.includes(response.status)) {
				return { status: response.status, headers: response.headers, data };
			}
			const retryAfter = Number(response.headers.get('retry-after'));
			const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /secondary rate limit/i.test(text)));
			if ((rateLimited || response.status >= 500) && attempt < 4) {
				await this.sleep(retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : 1000 * 2 ** attempt);
				continue;
			}
			const message = typeof data === 'object' && data?.message ? data.message : text.slice(0, 300);
			throw new GitHubError(`${method} ${path}: ${response.status} ${message}`, response.status, data);
		}
	}

	/**
	 * Every item of a paginated list.
	 * @param {string} path
	 * @param {number} [limit] stop after this many items
	 * @returns {Promise<any[]>}
	 */
	async paginate(path, limit = Infinity) {
		/** @type {any[]} */
		const items = [];
		let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
		while (next && items.length < limit) {
			const { headers, data } = await this.request('GET', next);
			items.push(...(Array.isArray(data) ? data : data.items ?? []));
			next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1] ?? '';
		}
		return items.slice(0, limit);
	}
}

/**
 * The client for the repository the workflow runs in.
 * @returns {GitHub}
 */
export function githubFromEnv() {
	return new GitHub({
		token: process.env.GITHUB_TOKEN ?? '',
		repository: process.env.GITHUB_REPOSITORY ?? '',
		apiUrl: process.env.GITHUB_API_URL,
	});
}
