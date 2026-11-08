/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { domainAllowed } from '../../voltSandbox/common/sandboxPolicy.js';

/**
 * The in-app browser of a sandboxed chat (B-16, I.9, INV-19). Unsandboxed chats share the user's
 * browser profile (`persist:volt-browser`, signed in). A sandboxed chat gets a profile of its own:
 *
 * - **Signed out and in memory**: a partition without `persist:`, so no cookie, login or storage
 *   of the user's reaches it, and nothing it stores outlives Volt. Cookie import refuses it.
 * - **The chat's network rules**: with the network off its session's proxy is Volt's filtering
 *   proxy with the chat's allowed hosts (the same hostname and private-address rules as the
 *   agent's own proxy), and loopback is not bypassed.
 * - **One dispatcher** in the main process judges every request of every such session: it finds
 *   the chat by the request's `webContentsId`, refuses a request without a frame or from web
 *   contents it does not know, and applies {@link sandboxBrowserRequestVerdict}.
 */

const PARTITION_PREFIX = 'volt-sandbox-browser-';

/** The chat's own browser partition. Not `persist:`: in memory, signed out. */
export function sandboxBrowserPartition(sessionId: string): string {
	// Partition names are path-like in Chromium: keep to a safe alphabet, and keep distinct ids distinct.
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, char => `_${char.charCodeAt(0).toString(16)}`).slice(0, 96);
	return `${PARTITION_PREFIX}${safe || 'chat'}`;
}

export function isSandboxBrowserPartition(partition: string | undefined): partition is string {
	return !!partition && partition.startsWith(PARTITION_PREFIX) && /^[A-Za-z0-9_-]+$/.test(partition.slice(PARTITION_PREFIX.length));
}

/** What a sandboxed chat's browser may reach: its sandbox settings' network part. */
export interface ISandboxBrowserRules {
	/** The chat's network is on: any public host (direct). */
	readonly network: boolean;
	/** With the network off: hosts the user allowed (through Volt's filtering proxy). */
	readonly allowedDomains: readonly string[];
	/** Loopback ports the user granted (`net.listen:<port>`): the only local pages. */
	readonly listenPorts: readonly number[];
}

export interface ISandboxBrowserRequest {
	readonly url: string;
	/** The request came from a frame (Electron's `details.frame` was set). */
	readonly hasFrame: boolean;
}

export type SandboxBrowserVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

function isLoopback(host: string): boolean {
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * One request of a sandboxed chat's browser. `rules` undefined: the request could not be tied to
 * a chat whose rules Volt knows (unknown web contents, rules not set yet): refused.
 */
export function sandboxBrowserRequestVerdict(rules: ISandboxBrowserRules | undefined, request: ISandboxBrowserRequest): SandboxBrowserVerdict {
	if (!rules) {
		return { allow: false, reason: 'no chat is known for this page' };
	}
	if (!request.hasFrame) {
		return { allow: false, reason: 'the request has no frame' };
	}
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return { allow: false, reason: 'not a URL' };
	}
	switch (url.protocol) {
		case 'about:':
		case 'data:':
		case 'blob:':
		// The page's own DevTools, docked in the same profile.
		case 'devtools:':
			return { allow: true };
		case 'http:':
		case 'https:':
		case 'ws:':
		case 'wss:':
			break;
		default:
			return { allow: false, reason: `${url.protocol} is not opened from a sandboxed chat's browser` };
	}
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (isLoopback(host)) {
		const port = url.port ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
		return rules.network || rules.listenPorts.includes(port) ? { allow: true } : { allow: false, reason: `local port ${port} was not granted to this chat` };
	}
	if (rules.network || domainAllowed(host, rules.allowedDomains)) {
		return { allow: true };
	}
	return { allow: false, reason: `${host} is not reachable: this chat's network is off` };
}

/**
 * The session proxy for a chat's browser: none with the network on; with it off, Volt's filtering
 * proxy for everything (`<-loopback>` takes away Chromium's implicit loopback bypass) except the
 * granted local ports, which go direct.
 */
export function sandboxBrowserProxyConfig(rules: ISandboxBrowserRules, proxyPort: number | undefined): { readonly mode: 'direct' } | { readonly mode: 'fixed_servers'; readonly proxyRules: string; readonly proxyBypassRules: string } {
	if (rules.network) {
		return { mode: 'direct' };
	}
	// No proxy to send to: an address that refuses every connection.
	const proxyRules = proxyPort ? `http://127.0.0.1:${proxyPort}` : 'http://127.0.0.1:9';
	const direct = rules.listenPorts.flatMap(port => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
	return { mode: 'fixed_servers', proxyRules, proxyBypassRules: ['<-loopback>', ...direct].join(',') };
}

/** The user name a chat's browser signs in to its own proxy with; the password is the proxy's route token. */
export const SANDBOX_BROWSER_PROXY_USER = 'volt';

/**
 * The answer to a sandboxed chat's browser asking to sign in to a proxy (Chromium's `login` event,
 * B-31): a session proxy rule cannot carry credentials, so the proxy's 407 is answered with its
 * route token. Only for the chat's own proxy (127.0.0.1 at its port) and only on the first
 * attempt: a second ask means the token was refused. Undefined: cancel, never a dialog, never the
 * token for anything else (another chat's proxy, a site, a proxy elsewhere).
 */
export function sandboxBrowserProxyLogin(proxy: { readonly port: number; readonly token?: string } | undefined, authInfo: { readonly isProxy: boolean; readonly host: string; readonly port: number }, firstAttempt: boolean): { readonly username: string; readonly password: string } | undefined {
	if (!proxy?.token || !authInfo.isProxy || !firstAttempt || authInfo.host !== '127.0.0.1' || authInfo.port !== proxy.port) {
		return undefined;
	}
	return { username: SANDBOX_BROWSER_PROXY_USER, password: proxy.token };
}
