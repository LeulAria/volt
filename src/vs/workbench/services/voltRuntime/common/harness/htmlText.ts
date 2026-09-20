/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const BLOCK = /<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|ul|ol|table)>/gi;

/**
 * Cheap HTML → text for web_fetch. Not a browser: scripts/styles die, tags become
 * whitespace, entities decode. Good enough for a model to read a docs page.
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(BLOCK, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, '\'')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

const PRIVATE = /^(localhost|127\.|10\.|0\.0\.0\.0|\[?::1\]?|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Block loopback / RFC1918 / non-http(s) so web_fetch cannot be used as an SSRF gadget. */
export function isBlockedFetchUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return true;
		}
		const host = url.hostname.replace(/^\[|\]$/g, '');
		return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || PRIVATE.test(host);
	} catch {
		return true;
	}
}
