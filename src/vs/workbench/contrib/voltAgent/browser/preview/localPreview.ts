/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{2,5}))?(?:\/[^\s"'<>\\\]\)*]*)?/gi;
const PYTHON_SERVER_RE = /HTTP\s+on\s+(127\.0\.0\.1|0\.0\.0\.0|localhost)\s+port\s+(\d{2,5})/i;
const HTTP_SERVER_CMD_RE = /python3?\s+(?:-m\s+)?http\.server(?:\s+(\d{2,5}))?/i;
const PORT_FLAG_RE = /(?:--port|-p|--listen)\s+(\d{2,5})\b/i;
const DEV_SERVER_CMD_RE = /\b(vite|next|nuxt|astro|http-server|npm|pnpm|yarn|bun|npx)\b/i;
const DEBUG_PORT = 9229;

export function extractLocalPreviewUrl(...chunks: Array<string | undefined>): string | undefined {
	for (const chunk of chunks) {
		if (!chunk) {
			continue;
		}
		const fromText = extractFromText(chunk);
		if (fromText) {
			return fromText;
		}
		const fromCommand = inferPreviewUrlFromCommand(chunk);
		if (fromCommand) {
			return fromCommand;
		}
	}
	return undefined;
}

export function inferPreviewUrlFromCommand(command: string): string | undefined {
	const httpServer = command.match(HTTP_SERVER_CMD_RE);
	if (httpServer) {
		return localUrl(httpServer[1] || '8000');
	}
	if (DEV_SERVER_CMD_RE.test(command)) {
		const port = command.match(PORT_FLAG_RE);
		if (port) {
			return localUrl(port[1]);
		}
	}
	return extractFromText(command);
}

export function extractHttpUrl(value: string | undefined): string | undefined {
	return firstHttpUrl(value);
}

/** Turn bare http(s) URLs into markdown so the thread can bind click-to-preview. */
export function linkifyPreviewUrls(text: string): string {
	return text.split(/(```[\s\S]*?(?:```|$))/g).map(part => {
		if (part.startsWith('```')) {
			return part;
		}
		return part.replace(/(^|[^`\](\[*])(\*{0,2})(https?:\/\/[^\s`'<>*]+)(\*{0,2})/gi, (_full, prefix: string, _starsBefore: string, raw: string, _starsAfter: string) => {
			const url = firstHttpUrl(raw);
			if (!url) {
				return _full;
			}
			const extra = (raw.startsWith(url) ? raw.slice(url.length) : '')
				.replace(/^\.([A-Z])/, '. $1')
				.replace(/^\*+$/, '');
			return `${prefix}[\`${url}\`](${url})${extra}`;
		});
	}).join('');
}

/** First real http(s) URL in a string - strips markdown `[text](url)` junk. */
export function sanitizeBrowserUrl(value: string | undefined): string | undefined {
	const cleaned = firstHttpUrl(value);
	if (!cleaned) {
		return undefined;
	}
	try {
		const url = new URL(cleaned);
		if (url.hostname === '0.0.0.0') {
			url.hostname = '127.0.0.1';
		}
		return url.toString();
	} catch {
		return cleaned;
	}
}

export function isHttpUrl(value: string): boolean {
	return !!extractHttpUrl(value);
}

export function isLocalPreviewUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return isLocalHost(url.hostname) && isPreviewPort(Number(url.port || '80'));
	} catch {
		return false;
	}
}

function extractFromText(text: string): string | undefined {
	const decoded = decodeMarkdownResidue(text);
	LOCAL_URL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = LOCAL_URL_RE.exec(decoded))) {
		const next = decoded[match.index + match[0].length];
		if (next && /[\w:/?#]/.test(next)) {
			continue;
		}
		if (!next && !/:\d{2,5}\/?$/.test(match[0])) {
			continue;
		}
		if (!next && /:\d{1,3}$/.test(match[0])) {
			continue;
		}
		const normalized = normalizeMatch(match[0]);
		if (normalized && new URL(normalized).port) {
			return normalized;
		}
	}
	const python = text.match(PYTHON_SERVER_RE);
	if (python) {
		return localUrl(python[2], python[1]);
	}
	return undefined;
}

function firstHttpUrl(value: string | undefined): string | undefined {
	const cleaned = cleanUrlCandidate(value);
	return /^https?:\/\//i.test(cleaned) ? cleaned : undefined;
}

function cleanUrlCandidate(value: string | undefined): string {
	const raw = decodeMarkdownResidue((value ?? '').trim());
	if (!raw) {
		return '';
	}
	const href = raw.match(/\]\((https?:\/\/[^)\s]+)\)/i)?.[1]
		?? raw.match(/\[(?:[^\]]*)\]\((https?:\/\/[^)\s]+)\)/i)?.[1];
	if (href) {
		return trimUrlJunk(href);
	}
	const match = raw.match(/https?:\/\/[^\s`'<>*]+/i)?.[0];
	if (!match) {
		return trimUrlJunk(raw.split(/[\s\]>]/)[0]?.replace(/^[<\[]+/, '') ?? '');
	}
	return trimUrlJunk(match
		.replace(/\]\(.*$/i, '')
		.replace(/\((https?:\/\/.*)$/i, '')
		.replace(/[\]>].*$/i, ''));
}

function trimUrlJunk(url: string): string {
	return url
		.replace(/\/\.[A-Z][A-Za-z].*$/, '/')
		.replace(/[.,);]+$/g, '')
		.replace(/[*_~]+$/g, '');
}

function decodeMarkdownResidue(value: string): string {
	return value
		.replace(/%5[dD]/g, ']')
		.replace(/%29/g, ')')
		.replace(/%28/g, '(');
}

function normalizeMatch(raw: string): string | undefined {
	const cleaned = cleanUrlCandidate(raw);
	try {
		const url = new URL(cleaned);
		if (!isLocalHost(url.hostname) || !isPreviewPort(Number(url.port || '80'))) {
			return undefined;
		}
		if (url.hostname === '0.0.0.0') {
			url.hostname = '127.0.0.1';
		}
		return url.toString();
	} catch {
		return undefined;
	}
}

function localUrl(port: string, host = '127.0.0.1'): string {
	const hostname = host === '0.0.0.0' ? '127.0.0.1' : host;
	return `http://${hostname}:${port}/`;
}

function isLocalHost(host: string): boolean {
	return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
}

function isPreviewPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535 && port !== DEBUG_PORT;
}
