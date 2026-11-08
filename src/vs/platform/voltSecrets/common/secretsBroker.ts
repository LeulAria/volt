/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubjectKey } from '../../voltSandbox/common/principals.js';

/**
 * The secrets broker's pure rules (spec I.3, INV-24, INV-37): secret names, the hosts a secret may
 * be sent to, and the header it is sent as. The broker itself is `node/secretsBroker.ts`.
 *
 * A secret lives in one subject's namespace (`plugin:acme.x@signer` has its own `github`, separate
 * from every other subject's). A principal holds a reference to it (`secretRef`), never the value:
 * the network broker (I.4) adds it to a request for a host the secret's own metadata lists
 * (`injectHosts`), and nowhere else.
 */

export const SECRETS_BROKER_LIMITS = Object.freeze({
	/** Longest secret value. */
	valueBytes: 16 * 1024,
	/** Hosts one secret may be sent to. */
	injectHosts: 16,
	/** Secrets one subject may keep. */
	perNamespace: 64,
	/** Broker calls per principal per minute. */
	callsPerMinute: 600,
});

/** How the value goes on the wire: `Authorization: Bearer <v>`, `Authorization: Basic <v>`, or the header as is. */
export type SecretScheme = 'bearer' | 'basic' | 'raw';

export interface ISecretRecord {
	readonly value: string;
	/** Hosts (lowercase ASCII; `*.example.com` for its subdomains) the value may be sent to. */
	readonly injectHosts: readonly string[];
	/** Default `Authorization`. */
	readonly header?: string;
	/** Default `bearer`. */
	readonly scheme?: SecretScheme;
	readonly updatedAt: number;
}

/** Where secrets are kept: one namespace per subject. Keychain, libsecret, DPAPI, or the 0600 file fallback. */
export interface ISecretsStore {
	get(namespace: SubjectKey, service: string): Promise<ISecretRecord | undefined>;
	set(namespace: SubjectKey, service: string, record: ISecretRecord): Promise<void>;
	delete(namespace: SubjectKey, service: string): Promise<boolean>;
	list(namespace: SubjectKey): Promise<readonly string[]>;
}

export class SecretsInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SecretsInputError';
	}
}

const SERVICE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A secret's name (`github`, `openrouter`), as a capability target (`secrets.use:<service>`). */
export function validateSecretService(raw: unknown): string {
	if (typeof raw !== 'string' || !SERVICE.test(raw)) {
		throw new SecretsInputError('the service must be 1 to 64 lowercase letters, digits, `.`, `_` or `-`');
	}
	return raw;
}

/** A host as the broker compares it: lowercase ASCII, one trailing dot dropped. Undefined: not a host. */
export function normalizeSecretHost(raw: string): string | undefined {
	const host = raw.trim().toLowerCase().replace(/\.$/, '');
	if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
		return undefined;
	}
	return host;
}

/** `injectHosts` as given: hosts, or `*.` and a host with at least two labels (never a bare suffix such as `*.com`). */
export function validateInjectHosts(raw: unknown): string[] {
	if (!Array.isArray(raw) || !raw.length) {
		throw new SecretsInputError('injectHosts must list the hosts the secret may be sent to');
	}
	if (raw.length > SECRETS_BROKER_LIMITS.injectHosts) {
		throw new SecretsInputError(`a secret may be sent to at most ${SECRETS_BROKER_LIMITS.injectHosts} hosts`);
	}
	return raw.map(entry => {
		if (typeof entry !== 'string') {
			throw new SecretsInputError('injectHosts must be strings');
		}
		const wildcard = entry.startsWith('*.');
		const host = normalizeSecretHost(wildcard ? entry.slice(2) : entry);
		if (!host || (wildcard && host.split('.').length < 2) || /^[0-9.]+$/.test(host)) {
			throw new SecretsInputError(`${entry} is not a host a secret may be sent to`);
		}
		return wildcard ? `*.${host}` : host;
	});
}

/** Whether `host` is one `patterns` lists: exactly, or a subdomain of a `*.` entry (never the bare domain). */
export function secretHostAllowed(host: string, patterns: readonly string[]): boolean {
	const target = normalizeSecretHost(host);
	if (!target) {
		return false;
	}
	return patterns.some(pattern => pattern.startsWith('*.') ? target.endsWith(pattern.slice(1)) : target === pattern);
}

const HEADER = /^[A-Za-z0-9-]{1,64}$/;
/** Headers a secret may not be sent as: they would rewrite the request rather than authenticate it. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'proxy-authorization', 'cookie', 'te', 'trailer', 'expect']);

export function validateSecretHeader(raw: unknown): string | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (typeof raw !== 'string' || !HEADER.test(raw) || RESERVED_HEADERS.has(raw.toLowerCase())) {
		throw new SecretsInputError('header must be an HTTP header name other than Host, Cookie, Proxy-Authorization and the framing headers');
	}
	return raw;
}

/** The header a request gets for `record`. Values with line breaks are refused (header injection). */
export function secretHeader(record: ISecretRecord): { readonly name: string; readonly value: string } {
	if (/[\r\n\0]/.test(record.value)) {
		throw new SecretsInputError('the secret has a line break and cannot be sent as a header');
	}
	const scheme = record.scheme ?? 'bearer';
	return { name: record.header ?? 'Authorization', value: scheme === 'bearer' ? `Bearer ${record.value}` : scheme === 'basic' ? `Basic ${record.value}` : record.value };
}
