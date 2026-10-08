/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import type { ApnsEnvironment, IApnsRequest } from '../src/apns.ts';

// Token-based (p8 key) APNs client for the agent server, Node only. One HTTP/2 session per
// environment, a provider JWT reused for 50 minutes (Apple refuses tokens older than an hour and
// throttles ones refreshed more often than every 20 minutes).

export interface IApnsCredentials {
	/** Apple Developer team id (JWT `iss`). */
	readonly teamId: string;
	/** Key id of the .p8 key (JWT `kid`). */
	readonly keyId: string;
	/** The .p8 file's PEM text. */
	readonly privateKey: string;
}

export interface IApnsResult {
	readonly status: number;
	/** Apple's `reason` on failure (`BadDeviceToken`, `ExpiredToken`, `Unregistered`...). */
	readonly reason?: string;
	readonly apnsId?: string;
}

const HOSTS: Record<ApnsEnvironment, string> = {
	sandbox: 'https://api.sandbox.push.apple.com',
	production: 'https://api.push.apple.com',
};

const JWT_LIFETIME_S = 50 * 60;

function base64url(input: Uint8Array | string): string {
	return (typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** An ES256 provider token. Exported for tests. */
export function providerToken(credentials: IApnsCredentials, issuedAt: number, key: KeyObject = createPrivateKey(credentials.privateKey)): string {
	const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
	const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(issuedAt) }));
	const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
	return `${header}.${claims}.${base64url(signature)}`;
}

/** Tokens Apple says will never work again: drop the registration. */
export function isDeadToken(result: IApnsResult): boolean {
	return result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'Unregistered' || result.reason === 'DeviceTokenNotForTopic';
}

export class ApnsClient {

	private readonly key: KeyObject;
	private token: { readonly value: string; readonly at: number } | undefined;
	private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
	private readonly credentials: IApnsCredentials;
	private readonly now: () => number;

	constructor(credentials: IApnsCredentials, now: () => number = () => Date.now() / 1000) {
		this.credentials = credentials;
		this.now = now;
		this.key = createPrivateKey(credentials.privateKey);
	}

	private bearer(): string {
		const now = this.now();
		if (!this.token || now - this.token.at > JWT_LIFETIME_S) {
			this.token = { value: providerToken(this.credentials, now, this.key), at: now };
		}
		return this.token.value;
	}

	private session(environment: ApnsEnvironment): ClientHttp2Session {
		const existing = this.sessions.get(environment);
		if (existing && !existing.closed && !existing.destroyed) {
			return existing;
		}
		const session = connect(HOSTS[environment]);
		session.on('error', () => this.sessions.delete(environment));
		session.on('close', () => this.sessions.delete(environment));
		session.unref();
		this.sessions.set(environment, session);
		return session;
	}

	send(deviceToken: string, environment: ApnsEnvironment, request: IApnsRequest): Promise<IApnsResult> {
		return new Promise(resolve => {
			const body = JSON.stringify(request.payload);
			let stream;
			try {
				stream = this.session(environment).request({
					':method': 'POST',
					':path': `/3/device/${deviceToken}`,
					authorization: `bearer ${this.bearer()}`,
					'content-type': 'application/json',
					...request.headers,
				});
			} catch (err) {
				resolve({ status: 0, reason: err instanceof Error ? err.message : String(err) });
				return;
			}
			let status = 0;
			let apnsId: string | undefined;
			let text = '';
			stream.setEncoding('utf8');
			stream.on('response', headers => {
				status = Number(headers[':status']);
				apnsId = typeof headers['apns-id'] === 'string' ? headers['apns-id'] : undefined;
			});
			stream.on('data', (chunk: string) => text += chunk);
			stream.on('error', err => resolve({ status: 0, reason: err.message }));
			stream.on('end', () => {
				let reason: string | undefined;
				try {
					reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
				} catch {
					reason = text || undefined;
				}
				resolve({ status, ...(reason ? { reason } : {}), ...(apnsId ? { apnsId } : {}) });
			});
			stream.end(body);
		});
	}

	close(): void {
		for (const session of this.sessions.values()) {
			session.close();
		}
		this.sessions.clear();
	}
}
