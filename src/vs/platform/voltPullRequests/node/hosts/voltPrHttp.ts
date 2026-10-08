/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltPrError, VoltPrErrorCode } from '../../common/voltPullRequests.js';

/** One REST host's API: JSON in and out, its auth header on every call, errors as {@link VoltPrError}. */

const HTTP_TIMEOUT_MS = 30_000;
/** Pages read at most per list (each page holds up to 100). */
const MAX_PAGES = 10;

export type VoltPrHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface IVoltPrHttpOptions {
	readonly query?: Record<string, string | number | boolean | undefined | readonly string[]>;
	readonly body?: unknown;
	/** Read the answer as text (a diff, a raw file). */
	readonly text?: boolean;
	readonly headers?: Record<string, string>;
	/** Statuses that are an answer, not a failure (404 for "no such pull request yet"). */
	readonly allow?: readonly number[];
}

export interface IVoltPrHttpResponse<T> {
	readonly status: number;
	readonly body: T;
	readonly headers: Headers;
}

export type VoltPrFetch = (url: string, init: RequestInit) => Promise<Response>;

export class VoltPrHttp {

	constructor(
		/** REST root without a trailing slash. */
		readonly apiUrl: string,
		private readonly auth: () => Promise<Record<string, string>>,
		/** "GitLab", for messages. */
		private readonly label: string,
		private readonly fetchImpl: VoltPrFetch = (url, init) => fetch(url, init),
	) { }

	url(path: string, query?: IVoltPrHttpOptions['query']): string {
		const url = new URL(/^https?:\/\//.test(path) ? path : `${this.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) {
				continue;
			}
			if (Array.isArray(value)) {
				for (const item of value) {
					url.searchParams.append(key, item);
				}
			} else {
				url.searchParams.set(key, String(value));
			}
		}
		return url.toString();
	}

	async request<T = unknown>(method: VoltPrHttpMethod, path: string, options: IVoltPrHttpOptions = {}): Promise<IVoltPrHttpResponse<T>> {
		const url = this.url(path, options.query);
		const headers: Record<string, string> = {
			'Accept': options.text ? 'text/plain, */*' : 'application/json',
			'User-Agent': 'Volt',
			// Azure DevOps answers a missing or bad token with a 302 to its sign-in page unless told not to.
			'X-TFS-FedAuthRedirect': 'Suppress',
			...await this.auth(),
			...options.headers,
		};
		let body: string | undefined;
		if (options.body !== undefined) {
			body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
			headers['Content-Type'] ??= 'application/json';
		}
		let response: Response;
		try {
			response = await this.fetchImpl(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
		} catch (err) {
			const message = err instanceof Error ? (err.name === 'TimeoutError' ? `${this.label} did not answer in time.` : `${this.label} could not be reached: ${(err as { cause?: { code?: string } }).cause?.code ?? err.message}`) : String(err);
			throw new VoltPrError('network', message);
		}
		const raw = await response.text();
		if ((response.status < 200 || response.status >= 300) && !options.allow?.includes(response.status)) {
			throw this.failure(response.status, raw, method, path);
		}
		if (options.text) {
			return { status: response.status, body: raw as T, headers: response.headers };
		}
		let parsed: unknown;
		try {
			parsed = raw.trim() ? JSON.parse(raw) : undefined;
		} catch {
			if (response.status >= 200 && response.status < 300 && raw.trim()) {
				throw new VoltPrError('failed', `${this.label} answered ${method} ${path} with something that is not JSON.`);
			}
			parsed = undefined;
		}
		return { status: response.status, body: parsed as T, headers: response.headers };
	}

	async json<T = unknown>(method: VoltPrHttpMethod, path: string, options: IVoltPrHttpOptions = {}): Promise<T> {
		return (await this.request<T>(method, path, options)).body;
	}

	get<T = unknown>(path: string, query?: IVoltPrHttpOptions['query']): Promise<T> {
		return this.json<T>('GET', path, { query });
	}

	async text(path: string, query?: IVoltPrHttpOptions['query']): Promise<string> {
		return (await this.request<string>('GET', path, { query, text: true })).body;
	}

	/**
	 * Every page of a list. `next` reads the following page's URL (or page number) from a response;
	 * undefined ends the walk.
	 */
	async pages<T>(path: string, query: IVoltPrHttpOptions['query'], items: (body: unknown) => readonly T[], next: (response: IVoltPrHttpResponse<unknown>, page: number, got: number) => string | number | undefined, limit = Infinity): Promise<T[]> {
		const out: T[] = [];
		let url: string = path;
		let currentQuery = query;
		for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
			const response = await this.request<unknown>('GET', url, { query: currentQuery });
			const got = items(response.body);
			out.push(...got);
			const following = next(response, page, got.length);
			if (following === undefined || !got.length) {
				break;
			}
			if (typeof following === 'number') {
				currentQuery = { ...query, page: following };
			} else {
				url = following;
				currentQuery = undefined;
			}
		}
		return out.slice(0, limit);
	}

	private failure(status: number, raw: string, method: string, path: string): VoltPrError {
		let message = '';
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			message = [parsed.message, (parsed.error as { message?: unknown })?.message, parsed.error_description, parsed.error, parsed.errors && JSON.stringify(parsed.errors)]
				.find((value): value is string => typeof value === 'string' && !!value) ?? '';
		} catch {
			message = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
		}
		const code: VoltPrErrorCode = status === 401 || (status >= 300 && status < 400) ? 'noAuth'
			: status === 404 ? 'notFound'
				: status === 409 || status === 405 && /merge|conflict|not mergeable/i.test(message) ? 'conflict'
					: status === 429 ? 'rateLimited'
						: status === 403 && /rate limit/i.test(message) ? 'rateLimited'
							: status >= 500 ? 'network'
								: 'failed';
		const what = code === 'noAuth'
			? `${this.label} did not accept the token${message ? `: ${message}` : ''}. Sign in again.`
			: status === 403 ? `${this.label} refused ${method} ${path}: ${message || 'no permission'}`
				: message || `${this.label} answered ${status} to ${method} ${path}.`;
		return new VoltPrError(code, what);
	}
}

export function basicAuth(user: string, password: string): string {
	return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}
