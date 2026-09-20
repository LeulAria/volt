/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { htmlToText, isBlockedFetchUrl } from '../../common/harness/htmlText.js';
import { truncateHead } from '../../common/harness/toolResult.js';
import { pickString } from '../../common/tools/args.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { requestText } from '../host/httpStream.js';
import { objectSchema } from './schema.js';

const FETCH_CHARS = 50_000;

export function createWebTools(requestService: IRequestService): IVoltTool[] {
	return [
		{
			name: 'web_fetch',
			group: 'web',
			kind: 'fetch',
			parallelSafe: true,
			snippet: 'web_fetch - fetch a public http(s) URL as text',
			description: [
				'Fetch a public web page and return readable text.',
				'Use when you have a concrete URL.',
				'Do not use for localhost, private IPs, or file paths.',
			].join(' '),
			schema: objectSchema({
				url: { type: 'string' },
			}, ['url']),
			execute: async args => runFetch(requestService, args),
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
			}, ['query']),
			execute: async args => runSearch(requestService, args),
		},
	];
}

async function runFetch(requestService: IRequestService, args: unknown): Promise<IToolResult> {
	const url = pickString(args, 'url', 'href');
	if (!url) {
		return fail('web_fetch', 'url is required.');
	}
	if (isBlockedFetchUrl(url)) {
		return fail('web_fetch', 'That URL is blocked (localhost, private network, or non-http).');
	}
	try {
		const { status, text } = await requestText(requestService, url, { type: 'GET' }, CancellationToken.None);
		if (status < 200 || status >= 400) {
			return fail('web_fetch', `HTTP ${status}`);
		}
		const readable = looksLikeHtml(text) ? htmlToText(text) : text;
		return { callId: '', name: 'web_fetch', kind: 'fetch', text: truncateHead(`${url}\n\n${readable}`, 2000, FETCH_CHARS).text };
	} catch (err) {
		return fail('web_fetch', err instanceof Error ? err.message : String(err));
	}
}

async function runSearch(requestService: IRequestService, args: unknown): Promise<IToolResult> {
	const query = pickString(args, 'query', 'q', 'search');
	if (!query) {
		return fail('web_search', 'query is required.');
	}
	try {
		const instant = await duckInstant(requestService, query);
		const html = await duckHtml(requestService, query);
		const parts = [instant, html].filter(Boolean);
		return { callId: '', name: 'web_search', kind: 'fetch', text: parts.length ? parts.join('\n\n') : `No results for: ${query}` };
	} catch (err) {
		return fail('web_search', err instanceof Error ? err.message : String(err));
	}
}

async function duckInstant(requestService: IRequestService, query: string): Promise<string | undefined> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
	const { status, text } = await requestText(requestService, url, { type: 'GET' }, CancellationToken.None);
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

async function duckHtml(requestService: IRequestService, query: string): Promise<string | undefined> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const { status, text } = await requestText(requestService, url, {
		type: 'GET',
		headers: { 'User-Agent': 'Volt/1.0' },
	}, CancellationToken.None);
	if (status < 200 || status >= 300) {
		return undefined;
	}
	const results: string[] = [];
	const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) && results.length < 8) {
		const href = decodeDuckHref(match[1]);
		const title = htmlToText(match[2]);
		if (href && title) {
			results.push(`- ${title}\n  ${href}`);
		}
	}
	return results.length ? results.join('\n') : undefined;
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
