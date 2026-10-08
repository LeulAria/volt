/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IRelayLink {
	/** Origin plus any path prefix the relay sits under, without a trailing slash. */
	readonly url: string;
	/** One-time pairing code (`ABCD-EFGH`). */
	readonly code?: string;
	/** A device token made elsewhere (`vrc_…`), pasted instead of a code. */
	readonly token?: string;
}

/**
 * Reads what a user pastes into Connect to Relay: the link `volt-relay pair` prints
 * (`https://relay.example.com/#pair=ABCD-EFGH`), the same with `?pair=`, a URL and a code
 * separated by a space, or a URL with `#token=`. A missing scheme means https, except for
 * localhost and private addresses, which mean http.
 */
export function parseRelayLink(text: string): IRelayLink | undefined {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) {
		return undefined;
	}
	let raw = parts[0];
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		const host = raw.split(/[/:?#]/)[0];
		raw = `${isPrivateHost(host) ? 'http' : 'https'}://${raw}`;
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return undefined;
	}
	const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
	const code = normalizeCode(hash.get('pair') ?? parsed.searchParams.get('pair') ?? parts[1]);
	const token = hash.get('token') ?? undefined;
	const path = parsed.pathname.replace(/\/+$/, '');
	return {
		url: `${parsed.protocol}//${parsed.host}${path}`,
		...(code ? { code } : {}),
		...(token ? { token } : {}),
	};
}

function normalizeCode(value: string | null | undefined): string | undefined {
	const letters = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
	return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : undefined;
}

export function isPrivateHost(host: string): boolean {
	return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|host\.docker\.internal$)/i.test(host) || host.endsWith('.local');
}
