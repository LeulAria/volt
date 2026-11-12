/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalAddress, cidrContains, ipFamily, isAmbiguousNumericHost, parseCidr } from './networkAddress.js';

/**
 * Host rules of the network broker (spec I.4 "Hostnames", B-32). Pure, shared by the Policy
 * Authority (which decides) and the broker (which normalises what a client asked for):
 *
 * - **Names** are IDNA-mapped to lower-case ASCII (full-width `APPLE.com` is `apple.com`; with a
 *   Cyrillic first letter it is `xn--pple-43d.com`, which no `apple.com` rule matches); one trailing dot is
 *   stripped; controls, `%`, empty labels and numbers a resolver might read in another base are
 *   refused.
 * - **Rules**: `host` and `*.host` (descendants only, never `host` itself, and never over a public
 *   suffix: `*.com`, `*.co.uk`, `*.github.io` match nothing), with `:port`, or `http://host` for
 *   port 80. No port means 443. `*` is every name on 80 and 443 only. IP literals match only IP
 *   rules (an address or a CIDR, with an optional port), never a name pattern.
 * - **Exfil-capable hosts** (paste sites, webhook catchers, tunnels, object storage, fronting CDNs,
 *   publish endpoints, gist and GitHub's write API) are matched only by a rule naming that exact
 *   host: no wildcard and no `*` opens them.
 */

export interface INormalizedHost {
	/** Lower-case ASCII; an IP address in canonical text, without brackets. */
	readonly host: string;
	/** 4 or 6 for an IP literal. */
	readonly ip?: 4 | 6;
}

/** Longest name the broker accepts (RFC 1035). */
const MAX_NAME = 253;

/**
 * What a client asked for, as the broker judges it; a string says why it is refused. IPv6 may come
 * bracketed. IDNA mapping is the platform's URL parser (UTS 46), the same one Chromium uses.
 */
export function normalizeNetworkHost(raw: string): INormalizedHost | string {
	let value = raw;
	if (value.startsWith('[') && value.endsWith(']')) {
		value = value.slice(1, -1);
	}
	if (!value || /[\u0000- \u007f%/\\?#@[\]<>^|"'`{}]/.test(value)) {
		return 'the host is empty or has characters no host name has';
	}
	if (value.includes(':')) {
		const v6 = canonicalAddress(value);
		return v6 && ipFamily(value) === 6 ? { host: v6, ip: 6 } : 'the host is not a valid IPv6 address';
	}
	if (value.endsWith('.')) {
		value = value.slice(0, -1);
	}
	if (!value || value.split('.').some(label => !label)) {
		return 'the host has an empty label';
	}
	if (ipFamily(value) === 4) {
		return { host: value, ip: 4 };
	}
	if (isAmbiguousNumericHost(value)) {
		return 'the host is a number in a form resolvers read differently';
	}
	let ascii: string;
	if (/^[\x21-\x7e]+$/.test(value)) {
		ascii = value.toLowerCase();
	} else {
		try {
			ascii = new URL(`http://${value}/`).hostname;
		} catch {
			return 'the host is not a valid international name';
		}
		if (!ascii || ascii.split('.').some(label => !label)) {
			return 'the host is not a valid international name';
		}
		if (ipFamily(ascii) === 4 || isAmbiguousNumericHost(ascii)) {
			// Full-width digits and dots map to a number: as ambiguous as the ASCII forms.
			return 'the host is a number in a form resolvers read differently';
		}
	}
	if (ascii.length > MAX_NAME || ascii.split('.').some(label => label.length > 63) || !/^[a-z0-9._-]+$/.test(ascii)) {
		return 'the host is not a valid name';
	}
	return { host: ascii };
}

/** `host:port`, `[v6]:port` or a bare host with `defaultPort`; the port is NaN when it is not a number. */
export function splitAuthority(value: string, defaultPort: number): { readonly host: string; readonly port: number } {
	const v6 = /^\[([^\]]*)\](?::(.*))?$/.exec(value);
	if (v6) {
		return { host: `[${v6[1]}]`, port: v6[2] === undefined ? defaultPort : /^\d{1,5}$/.test(v6[2]) ? Number(v6[2]) : NaN };
	}
	const colon = value.lastIndexOf(':');
	if (colon >= 0 && value.indexOf(':') === colon) {
		const port = value.slice(colon + 1);
		return { host: value.slice(0, colon), port: /^\d{1,5}$/.test(port) ? Number(port) : NaN };
	}
	return { host: value, port: defaultPort };
}

// --- rules -------------------------------------------------------------------------------------

export type NetworkRule =
	| { readonly kind: 'any' }
	| { readonly kind: 'name'; readonly host: string; readonly port?: number }
	| { readonly kind: 'suffix'; readonly base: string; readonly port?: number }
	| { readonly kind: 'ip'; readonly cidr: string; readonly port?: number };

/** One allow entry as a rule; undefined when it is not one (it then matches nothing). */
export function parseNetworkRule(entry: string): NetworkRule | undefined {
	let value = entry.trim();
	if (value === '*') {
		return { kind: 'any' };
	}
	let schemePort: number | undefined;
	const scheme = /^(https?):\/\/(.*?)\/?$/i.exec(value);
	if (scheme) {
		schemePort = scheme[1].toLowerCase() === 'http' ? 80 : 443;
		value = scheme[2];
	}
	// A CIDR, bare or bracketed, with an optional port after it.
	const cidr = /^\[?([0-9a-fA-F:.]+)\/(\d{1,3})\]?(?::(\d{1,5}))?$/.exec(value);
	if (cidr) {
		const text = `${cidr[1]}/${cidr[2]}`;
		const port = cidr[3] !== undefined ? Number(cidr[3]) : schemePort;
		return parseCidr(text) && validPort(port) ? { kind: 'ip', cidr: `${canonicalAddress(cidr[1])}/${cidr[2]}`, ...(port !== undefined ? { port } : {}) } : undefined;
	}
	const bareV6 = !value.startsWith('[') && value.split(':').length > 2;
	const { host, port: givenPort } = bareV6 ? { host: value, port: Number.NaN } : splitAuthority(value, -1);
	if (bareV6) {
		const v6 = canonicalAddress(value);
		return v6 && ipFamily(value) === 6 ? { kind: 'ip', cidr: `${v6}/128`, ...(schemePort !== undefined ? { port: schemePort } : {}) } : undefined;
	}
	if (Number.isNaN(givenPort)) {
		return undefined;
	}
	const port = givenPort !== -1 ? givenPort : schemePort;
	if (!validPort(port)) {
		return undefined;
	}
	const withPort = port !== undefined ? { port } : {};
	if (host.startsWith('*.')) {
		const base = normalizeNetworkHost(host.slice(2));
		return typeof base === 'string' || base.ip ? undefined : { kind: 'suffix', base: base.host, ...withPort };
	}
	if (host.includes('*')) {
		return undefined;
	}
	const name = normalizeNetworkHost(host);
	if (typeof name === 'string') {
		return undefined;
	}
	return name.ip ? { kind: 'ip', cidr: `${name.host}/${name.ip === 4 ? 32 : 128}`, ...withPort } : { kind: 'name', host: name.host, ...withPort };
}

function validPort(port: number | undefined): boolean {
	return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
}

/** Whether `rule` lets a connection to `host:port` through. `host` must be normalised. */
export function networkRuleCovers(rule: NetworkRule, target: INormalizedHost, port: number): boolean {
	const portOk = (rulePort: number | undefined) => rulePort === undefined ? port === 443 : port === rulePort;
	switch (rule.kind) {
		case 'any':
			// B-32: `*` is any name on the web ports; never an IP literal, an exfil host or another port.
			return !target.ip && (port === 80 || port === 443) && !isExfilHost(target.host);
		case 'name':
			return !target.ip && target.host === rule.host && portOk(rule.port);
		case 'suffix':
			return !target.ip && target.host.endsWith(`.${rule.base}`) && !isPublicSuffix(rule.base) && portOk(rule.port) && !isExfilHost(target.host);
		case 'ip':
			return !!target.ip && cidrContains(rule.cidr, target.host) && portOk(rule.port);
	}
}

/** Whether any entry in `entries` lets `host:port` through. */
export function networkRulesCover(entries: readonly string[], target: INormalizedHost, port: number): boolean {
	for (const entry of entries) {
		const rule = parseNetworkRule(entry);
		if (rule && networkRuleCovers(rule, target, port)) {
			return true;
		}
	}
	return false;
}

// --- public suffixes ---------------------------------------------------------------------------

/**
 * Multi-label public suffixes a wildcard must not span. Every single-label name is a public suffix
 * too (`*.com`). A curated subset of the Public Suffix List (country second levels Volt users meet
 * most, and hosting platforms where each subdomain is someone else's): a suffix missing here only
 * lets a user's own over-wide rule match more, never an agent's request widen a rule.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
	'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
	'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
	'co.nz', 'org.nz', 'net.nz', 'ac.nz', 'govt.nz',
	'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp', 'ad.jp',
	'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
	'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
	'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
	'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
	'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
	'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in', 'gov.in',
	'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
	'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
	'com.ar', 'org.ar', 'gob.ar', 'com.co', 'org.co', 'com.pe', 'com.ve', 'com.ec', 'com.uy',
	'co.za', 'org.za', 'gov.za', 'ac.za', 'com.ng', 'co.ke', 'com.eg', 'com.et',
	'com.tr', 'org.tr', 'gov.tr', 'edu.tr', 'co.il', 'org.il', 'ac.il', 'gov.il',
	'com.ru', 'org.ru', 'net.ru', 'com.ua', 'org.ua', 'com.pl', 'org.pl', 'net.pl',
	'co.id', 'or.id', 'ac.id', 'go.id', 'com.my', 'org.my', 'gov.my', 'com.ph', 'com.vn', 'co.th', 'in.th', 'ac.th',
	'com.pk', 'com.bd', 'com.sa', 'com.qa', 'co.ae', 'com.kw',
	'github.io', 'githubusercontent.com', 'gitlab.io', 'herokuapp.com', 'herokussl.com', 'vercel.app', 'now.sh', 'netlify.app', 'netlify.com',
	'pages.dev', 'workers.dev', 'r2.dev', 'appspot.com', 'firebaseapp.com', 'web.app', 'cloudfunctions.net', 'run.app',
	'azurewebsites.net', 'cloudapp.net', 'azurestaticapps.net', 'blogspot.com', 'wordpress.com', 'fly.dev', 'onrender.com',
	'glitch.me', 'repl.co', 'replit.dev', 'deno.dev', 'surge.sh', 'readthedocs.io', 'ngrok.io', 'ngrok-free.app', 'ngrok.app',
	'trycloudflare.com', 'loca.lt', 'localhost.run', 'amazonaws.com', 's3.amazonaws.com', 'cloudfront.net', 'elasticbeanstalk.com',
	'digitaloceanspaces.com', 'ondigitalocean.app', 'myshopify.com', 'shopifypreview.com', 'webflow.io', 'framer.app', 'bitbucket.io',
]);

/** Whether `name` (normalised) is a public suffix: a single label, or one of the bundled multi-label ones. */
export function isPublicSuffix(name: string): boolean {
	return !name.includes('.') || MULTI_LABEL_SUFFIXES.has(name);
}

// --- exfil-capable hosts -----------------------------------------------------------------------

/**
 * I.4 "TLS": hosts that take arbitrary data from anyone and hand it to anyone (paste sites, webhook
 * catchers, tunnels, object storage, fronting CDNs, registry publish endpoints, gist and GitHub's
 * write API). An entry `x` covers `x` and its subdomains; `*.x` only its subdomains. Compiled in
 * (N.2: no feed or registry service); updated with Volt releases.
 */
export const EXFIL_HOSTS: readonly string[] = [
	// Paste sites.
	'pastebin.com', 'paste.ee', 'hastebin.com', 'hastebin.skyra.pw', 'dpaste.org', 'dpaste.com', 'rentry.co', 'rentry.org', 'ghostbin.com', 'controlc.com',
	'privatebin.net', 'justpaste.it', 'paste.rs', 'termbin.com', 'ix.io', 'sprunge.us', 'pastes.dev', 'paste.mozilla.org',
	// Webhook catchers and out-of-band interaction services.
	'webhook.site', 'requestbin.com', 'requestbin.net', 'requestcatcher.com', 'pipedream.net', 'beeceptor.com', 'hookbin.com', 'mockbin.org',
	'requestinspector.com', 'interact.sh', 'oast.fun', 'oast.pro', 'oast.live', 'oast.site', 'oast.online', 'oast.me', 'burpcollaborator.net',
	'oastify.com', 'canarytokens.com', 'dnslog.cn', 'ceye.io', 'hooks.slack.com', 'discord.com', 'discordapp.com', 'api.telegram.org',
	// Tunnels.
	'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'ngrok.dev', 'trycloudflare.com', 'loca.lt', 'localtunnel.me', 'serveo.net', 'localhost.run',
	'lhr.life', 'pinggy.io', 'pinggy.link', 'bore.pub', 'tunnelto.dev', 'telebit.cloud', 'devtunnels.ms', 'ts.net',
	// File drops and object storage.
	'transfer.sh', 'file.io', '0x0.st', 'temp.sh', 'tmpfiles.org', 'catbox.moe', 'litterbox.catbox.moe', 'gofile.io', 'wetransfer.com', 'anonfiles.com',
	's3.amazonaws.com', 'blob.core.windows.net', 'storage.googleapis.com', 'r2.cloudflarestorage.com', 'r2.dev', 'backblazeb2.com',
	'digitaloceanspaces.com', 'wasabisys.com', 'linodeobjects.com',
	// Fronting-capable CDNs.
	'cloudfront.net', 'azureedge.net', 'azurefd.net', 'fastly.net', 'global.ssl.fastly.net', 'akamaized.net', 'edgekey.net',
	// Registry publish endpoints.
	'upload.pypi.org', 'test.pypi.org',
	// Gist and GitHub's write API.
	'gist.github.com', 'gist.githubusercontent.com', 'api.github.com', 'uploads.github.com',
];

const EXFIL_SET: ReadonlySet<string> = new Set(EXFIL_HOSTS);

/** Whether `host` (normalised) is exfil-capable: listed, or below a listed host. */
export function isExfilHost(host: string): boolean {
	for (let name = host; ;) {
		if (EXFIL_SET.has(name)) {
			return true;
		}
		const dot = name.indexOf('.');
		if (dot < 0) {
			break;
		}
		name = name.slice(dot + 1);
	}
	// Bucket-style names of the object stores (`bucket.s3.us-east-1.amazonaws.com`).
	return /\.s3[.-][a-z0-9-]*\.?amazonaws\.com$/.test(host) || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
}
