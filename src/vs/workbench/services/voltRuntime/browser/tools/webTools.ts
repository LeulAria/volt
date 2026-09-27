/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { htmlToText, isBlockedFetchUrl } from '../../common/harness/htmlText.js';
import { pickNumber, pickString } from '../../common/tools/args.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { requestText } from '../host/httpStream.js';
import { objectSchema } from './schema.js';

/** About 5k tokens per page; `offset` reads further. */
const FETCH_CHARS = 20_000;

export function createWebTools(requestService: IRequestService): IVoltTool[] {
	return [
		{
			name: 'web_fetch',
			group: 'web',
			kind: 'fetch',
			parallelSafe: true,
			snippet: 'web_fetch - fetch a public http(s) URL as text',
			description: [
				'Fetch a public web page and return its readable text, a page at a time.',
				'Use when you have a concrete URL (docs, an issue, a changelog). Pass offset to continue a long page.',
				'Do not use for localhost, private IPs, or file paths.',
			].join(' '),
			schema: objectSchema({
				url: { type: 'string' },
				offset: { type: 'integer', description: 'Character offset to continue from' },
				max_chars: { type: 'integer', description: 'Characters to return (default 20000)' },
			}, ['url']),
			idempotent: true,
			timeoutMs: 45_000,
			execute: async (args, ctx) => runFetch(requestService, args, tokenFor(ctx.signal)),
		},
		{
			name: 'web_search',
			group: 'web',
			kind: 'fetch',
			parallelSafe: true,
			snippet: 'web_search - search the public web',
			description: [
				'Search the public web and return titles, URLs, and snippets.',
				'Use for current facts (prices, versions, news) you do not already know.',
				'When the user wants a full list or table, search more than once and then fetch the pages that hold the rows.',
				'Do not use to search the workspace (use grep).',
			].join(' '),
			schema: objectSchema({
				query: { type: 'string' },
				max_results: { type: 'integer', description: 'Results to return (default 8)' },
			}, ['query']),
			idempotent: true,
			timeoutMs: 30_000,
			execute: async (args, ctx) => runSearch(requestService, args, tokenFor(ctx.signal)),
		},
	];
}

async function runFetch(requestService: IRequestService, args: unknown, token: CancellationToken): Promise<IToolResult> {
	const url = pickString(args, 'url', 'href');
	if (!url) {
		return fail('web_fetch', 'url is required.');
	}
	if (isBlockedFetchUrl(url)) {
		return fail('web_fetch', 'That URL is blocked (localhost, private network, or non-http).');
	}
	try {
		const { status, text } = await requestText(requestService, url, { type: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Volt)', 'Accept': 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } }, token);
		if (status < 200 || status >= 400) {
			return fail('web_fetch', `HTTP ${status} for ${url}`);
		}
		const readable = (looksLikeHtml(text) ? htmlToText(text) : text).replace(/\n{3,}/g, '\n\n').trim();
		const offset = Math.max(0, pickNumber(args, 'offset') ?? 0);
		const size = Math.min(60_000, Math.max(1_000, pickNumber(args, 'max_chars') ?? FETCH_CHARS));
		const page = readable.slice(offset, offset + size);
		const more = offset + size < readable.length ? `\n\n[Showing characters ${offset}-${offset + page.length} of ${readable.length}. Continue with offset=${offset + page.length}.]` : '';
		return { callId: '', name: 'web_fetch', kind: 'fetch', text: `${url} (HTTP ${status})\n\n${page}${more}` };
	} catch (err) {
		return fail('web_fetch', err instanceof Error ? err.message : String(err));
	}
}

async function runSearch(requestService: IRequestService, args: unknown, token: CancellationToken): Promise<IToolResult> {
	const query = pickString(args, 'query', 'q', 'search');
	if (!query) {
		return fail('web_search', 'query is required.');
	}
	const limit = Math.min(15, Math.max(1, pickNumber(args, 'max_results') ?? 8));
	try {
		// Both backends at once: the slower one no longer adds its latency to the faster one's.
		const [instant, html] = await Promise.all([
			duckInstant(requestService, query, token).catch(() => undefined),
			duckHtml(requestService, query, limit, token).catch(() => undefined),
		]);
		const parts = [instant, html].filter(Boolean);
		return { callId: '', name: 'web_search', kind: 'fetch', text: parts.length ? parts.join('\n\n') : `No results for: ${query}` };
	} catch (err) {
		return fail('web_search', err instanceof Error ? err.message : String(err));
	}
}

async function duckInstant(requestService: IRequestService, query: string, token: CancellationToken): Promise<string | undefined> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
	const { status, text } = await requestText(requestService, url, { type: 'GET' }, token);
	if (status < 200 || status >= 300) {
		return undefined;
	}
	try {
		const json = JSON.parse(text) as { AbstractText?: string; AbstractURL?: string; Answer?: string; Heading?: string };
		const lines = [
			json.Heading,
			json.Answer,
			json.AbstractText,
			json.AbstractURL,
		].filter(Boolean);
		return lines.length ? lines.join('\n') : undefined;
	} catch {
		return undefined;
	}
}

async function duckHtml(requestService: IRequestService, query: string, limit: number, token: CancellationToken): Promise<string | undefined> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const { status, text } = await requestText(requestService, url, {
		type: 'GET',
		headers: { 'User-Agent': 'Mozilla/5.0 (Volt)' },
	}, token);
	if (status < 200 || status >= 300) {
		return undefined;
	}
	const results: string[] = [];
	const snippets = [...text.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(match => htmlToText(match[1]).replace(/\s+/g, ' ').trim());
	const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) && results.length < limit) {
		const href = decodeDuckHref(match[1]);
		const title = htmlToText(match[2]).replace(/\s+/g, ' ').trim();
		if (href && title) {
			const snippet = snippets[results.length];
			results.push(`- ${title}\n  ${href}${snippet ? `\n  ${snippet.slice(0, 280)}` : ''}`);
		}
	}
	return results.length ? results.join('\n') : undefined;
}

/** Tool bodies take an AbortSignal; the request service takes a CancellationToken. */
function tokenFor(signal: AbortSignal): CancellationToken {
	const source = new CancellationTokenSource();
	if (signal.aborted) {
		source.cancel();
	} else {
		signal.addEventListener('abort', () => source.cancel(), { once: true });
	}
	return source.token;
}

function decodeDuckHref(href: string): string {
	try {
		const url = new URL(href, 'https://html.duckduckgo.com');
		const uddg = url.searchParams.get('uddg');
		return uddg ? decodeURIComponent(uddg) : url.href;
	} catch {
		return href;
	}
}

function looksLikeHtml(text: string): boolean {
	return /<html|<body|<div|<p[\s>]/i.test(text.slice(0, 2000));
}

function fail(name: string, text: string): IToolResult {
	return { callId: '', name, kind: 'fetch', text, isError: true };
}
