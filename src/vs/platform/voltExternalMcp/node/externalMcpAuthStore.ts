/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ExternalMcpScope, IExternalMcpGrantView } from '../common/voltExternalMcp.js';
import {
	ACCESS_TOKEN_PREFIX, ACCESS_TOKEN_TTL_MS, AUTH_CODE_PREFIX, AUTH_CODE_TTL_MS, formatScopes, isPkceVerifier, IValidClientMetadata, narrowScopes, parseScopes,
	REFRESH_TOKEN_PREFIX, REFRESH_TOKEN_TTL_MS, sameResource,
} from '../common/externalMcpOAuth.js';

/**
 * Clients, grants and tokens of Volt's external MCP server. Only SHA-256 hashes of tokens and
 * codes are kept; the strings themselves exist only in the HTTP responses that hand them out.
 *
 * - Access tokens live an hour. Refresh tokens rotate on every use and live 30 days from it.
 * - Presenting a refresh token that was already rotated away means two parties hold it: the
 *   whole grant is revoked (OAuth 2.1 section 4.3.1 reuse detection).
 * - Revoking a grant ends every token of it at once.
 */

export interface IClientRecord extends IValidClientMetadata {
	readonly clientId: string;
	readonly createdAt: number;
}

interface IGrantRecord {
	readonly id: string;
	readonly clientId: string;
	readonly clientName: string;
	readonly redirectUri: string;
	scopes: ExternalMcpScope[];
	readonly resource: string;
	readonly createdAt: number;
	lastUsedAt?: number;
	lastTool?: string;
	calls: number;
	refreshHash: string;
	refreshExpiresAt: number;
	/** Rotated-away refresh tokens, newest last: presenting one revokes the grant. */
	retiredRefresh: string[];
	access: { hash: string; expiresAt: number }[];
}

interface ICodeRecord {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly scopes: ExternalMcpScope[];
	readonly challenge: string;
	readonly resource: string;
	readonly expiresAt: number;
}

export interface IStoreData {
	readonly version: 1;
	readonly clients: readonly IClientRecord[];
	readonly grants: readonly IGrantRecord[];
}

export interface ITokenResponse {
	readonly access_token: string;
	readonly token_type: 'Bearer';
	readonly expires_in: number;
	readonly refresh_token: string;
	readonly scope: string;
}

export interface IOAuthError {
	readonly error: 'invalid_grant' | 'invalid_request' | 'invalid_client' | 'invalid_scope' | 'unsupported_grant_type' | 'invalid_target';
	readonly error_description: string;
}

export interface IVerifiedAccess {
	readonly grantId: string;
	readonly clientId: string;
	readonly clientName: string;
	readonly scopes: readonly ExternalMcpScope[];
}

const MAX_CLIENTS = 100;
const MAX_GRANTS = 50;
const MAX_CODES = 50;
const RETIRED_KEEP = 8;

export function hashSecret(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** base64url(SHA-256(verifier)) compared to the challenge in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
	if (!isPkceVerifier(verifier)) {
		return false;
	}
	const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'), 'utf8');
	const expected = Buffer.from(challenge, 'utf8');
	return computed.length === expected.length && timingSafeEqual(computed, expected);
}

function secret(prefix: string): string {
	return prefix + randomBytes(32).toString('base64url');
}

export class ExternalMcpAuthStore {

	private readonly clients = new Map<string, IClientRecord>();
	private readonly grants = new Map<string, IGrantRecord>();
	/** By code hash; in memory only (they live a minute). */
	private readonly codes = new Map<string, ICodeRecord>();
	/** Access token hash → grant id, rebuilt from the grants. */
	private readonly accessIndex = new Map<string, string>();
	private readonly refreshIndex = new Map<string, string>();
	private readonly retiredIndex = new Map<string, string>();

	constructor(
		private readonly onDidChange: () => void = () => { },
		private readonly now: () => number = Date.now,
	) { }

	//#region Persistence

	load(data: unknown): void {
		const value = data as Partial<IStoreData> | undefined;
		if (!value || value.version !== 1) {
			return;
		}
		for (const client of value.clients ?? []) {
			if (client && typeof client.clientId === 'string') {
				this.clients.set(client.clientId, client);
			}
		}
		for (const grant of value.grants ?? []) {
			if (grant && typeof grant.id === 'string' && this.clients.has(grant.clientId)) {
				this.grants.set(grant.id, { ...grant, access: [...(grant.access ?? [])], retiredRefresh: [...(grant.retiredRefresh ?? [])], scopes: [...grant.scopes] });
			}
		}
		this.prune();
		this.reindex();
	}

	toJSON(): IStoreData {
		this.prune();
		return { version: 1, clients: [...this.clients.values()], grants: [...this.grants.values()] };
	}

	private reindex(): void {
		this.accessIndex.clear();
		this.refreshIndex.clear();
		this.retiredIndex.clear();
		for (const grant of this.grants.values()) {
			for (const token of grant.access) {
				this.accessIndex.set(token.hash, grant.id);
			}
			this.refreshIndex.set(grant.refreshHash, grant.id);
			for (const hash of grant.retiredRefresh) {
				this.retiredIndex.set(hash, grant.id);
			}
		}
	}

	/** Drops expired tokens and grants, and clients nobody ever authorized after a day. */
	private prune(): void {
		const now = this.now();
		for (const grant of [...this.grants.values()]) {
			grant.access = grant.access.filter(token => token.expiresAt > now);
			if (grant.refreshExpiresAt <= now) {
				this.grants.delete(grant.id);
			}
		}
		const used = new Set([...this.grants.values()].map(grant => grant.clientId));
		for (const client of [...this.clients.values()]) {
			if (!used.has(client.clientId) && now - client.createdAt > 24 * 60 * 60_000) {
				this.clients.delete(client.clientId);
			}
		}
		for (const [hash, code] of this.codes) {
			if (code.expiresAt <= now) {
				this.codes.delete(hash);
			}
		}
	}

	//#endregion

	//#region Clients

	registerClient(metadata: IValidClientMetadata): IClientRecord {
		this.prune();
		if (this.clients.size >= MAX_CLIENTS) {
			// The oldest client without a grant makes room; registration is open to any local process.
			const used = new Set([...this.grants.values()].map(grant => grant.clientId));
			const spare = [...this.clients.values()].filter(client => !used.has(client.clientId)).sort((a, b) => a.createdAt - b.createdAt)[0];
			if (spare) {
				this.clients.delete(spare.clientId);
			}
		}
		const client: IClientRecord = { ...metadata, clientId: `volt-client-${randomBytes(16).toString('hex')}`, createdAt: this.now() };
		this.clients.set(client.clientId, client);
		this.onDidChange();
		return client;
	}

	getClient(clientId: string | undefined): IClientRecord | undefined {
		return clientId ? this.clients.get(clientId) : undefined;
	}

	//#endregion

	//#region Codes and tokens

	/** After the user approved: a one-time code for the client's redirect. */
	issueCode(request: Omit<ICodeRecord, 'expiresAt'>): string {
		this.prune();
		if (this.codes.size >= MAX_CODES) {
			this.codes.delete(this.codes.keys().next().value!);
		}
		const code = secret(AUTH_CODE_PREFIX);
		this.codes.set(hashSecret(code), { ...request, scopes: [...request.scopes], expiresAt: this.now() + AUTH_CODE_TTL_MS });
		return code;
	}

	/** `grant_type=authorization_code`. A code is spent by the first attempt, right or wrong. */
	exchangeCode(params: { code?: string; clientId?: string; redirectUri?: string; verifier?: string; resource?: string }): ITokenResponse | IOAuthError {
		if (!params.code || !params.clientId || !params.verifier) {
			return { error: 'invalid_request', error_description: 'code, client_id and code_verifier are required.' };
		}
		const hash = hashSecret(params.code);
		const code = this.codes.get(hash);
		this.codes.delete(hash);
		if (!code || code.expiresAt <= this.now()) {
			return { error: 'invalid_grant', error_description: 'The authorization code is unknown, used or expired.' };
		}
		if (code.clientId !== params.clientId) {
			return { error: 'invalid_grant', error_description: 'The code was issued to another client.' };
		}
		if (params.redirectUri !== undefined && params.redirectUri !== code.redirectUri) {
			return { error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request.' };
		}
		if (params.resource !== undefined && !sameResource(params.resource, code.resource)) {
			return { error: 'invalid_target', error_description: 'resource does not match the authorization request.' };
		}
		if (!pkceMatches(params.verifier, code.challenge)) {
			return { error: 'invalid_grant', error_description: 'code_verifier does not match the code_challenge.' };
		}
		const client = this.clients.get(code.clientId);
		if (!client) {
			return { error: 'invalid_client', error_description: 'The client is no longer registered.' };
		}
		// Signing in again replaces the client's earlier grant instead of piling up duplicates.
		for (const grant of [...this.grants.values()]) {
			if (grant.clientId === client.clientId) {
				this.dropGrant(grant.id);
			}
		}
		if (this.grants.size >= MAX_GRANTS) {
			const oldest = [...this.grants.values()].sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0];
			this.dropGrant(oldest.id);
		}
		const grant: IGrantRecord = {
			id: `grant-${randomBytes(12).toString('hex')}`,
			clientId: client.clientId,
			clientName: client.name,
			redirectUri: code.redirectUri,
			scopes: [...code.scopes],
			resource: code.resource,
			createdAt: this.now(),
			calls: 0,
			refreshHash: '',
			refreshExpiresAt: 0,
			retiredRefresh: [],
			access: [],
		};
		this.grants.set(grant.id, grant);
		const response = this.mint(grant, grant.scopes);
		this.onDidChange();
		return response;
	}

	/** `grant_type=refresh_token`: rotates the refresh token; `scope` may narrow, never widen. */
	refresh(params: { refreshToken?: string; clientId?: string; scope?: string; resource?: string }): ITokenResponse | IOAuthError {
		if (!params.refreshToken) {
			return { error: 'invalid_request', error_description: 'refresh_token is required.' };
		}
		const hash = hashSecret(params.refreshToken);
		const retired = this.retiredIndex.get(hash);
		if (retired) {
			// A token that was already exchanged came back: someone else has a copy. End the grant.
			this.dropGrant(retired);
			this.onDidChange();
			return { error: 'invalid_grant', error_description: 'The refresh token was already used; the connection was revoked. Connect again.' };
		}
		const grant = this.grants.get(this.refreshIndex.get(hash) ?? '');
		if (!grant || grant.refreshExpiresAt <= this.now()) {
			return { error: 'invalid_grant', error_description: 'The refresh token is unknown, revoked or expired.' };
		}
		if (params.clientId && params.clientId !== grant.clientId) {
			return { error: 'invalid_grant', error_description: 'The refresh token was issued to another client.' };
		}
		if (params.resource !== undefined && !sameResource(params.resource, grant.resource)) {
			return { error: 'invalid_target', error_description: 'resource does not match the grant.' };
		}
		let scopes = grant.scopes;
		if (params.scope) {
			const parsed = parseScopes(params.scope, []);
			const narrowed = narrowScopes(parsed.scopes, grant.scopes);
			if (parsed.unknown.length || narrowed.length !== parsed.scopes.length || !narrowed.length) {
				return { error: 'invalid_scope', error_description: `The grant allows only: ${formatScopes(grant.scopes)}.` };
			}
			scopes = narrowed;
		}
		grant.retiredRefresh = [...grant.retiredRefresh, grant.refreshHash].slice(-RETIRED_KEEP);
		const response = this.mint(grant, scopes);
		this.onDidChange();
		return response;
	}

	private mint(grant: IGrantRecord, scopes: ExternalMcpScope[]): ITokenResponse {
		const now = this.now();
		const access = secret(ACCESS_TOKEN_PREFIX);
		const refresh = secret(REFRESH_TOKEN_PREFIX);
		grant.scopes = scopes;
		// The previous access token keeps working until it expires: requests already in flight finish.
		grant.access = [...grant.access.filter(token => token.expiresAt > now).slice(-1), { hash: hashSecret(access), expiresAt: now + ACCESS_TOKEN_TTL_MS }];
		grant.refreshHash = hashSecret(refresh);
		grant.refreshExpiresAt = now + REFRESH_TOKEN_TTL_MS;
		this.reindex();
		return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refresh, scope: formatScopes(scopes) };
	}

	/** The grant behind a bearer token, when it is live and was issued for `resource`. */
	verifyAccess(token: string | undefined, resource: string): IVerifiedAccess | undefined {
		if (!token || !token.startsWith(ACCESS_TOKEN_PREFIX)) {
			return undefined;
		}
		const hash = hashSecret(token);
		const grant = this.grants.get(this.accessIndex.get(hash) ?? '');
		const entry = grant?.access.find(candidate => candidate.hash === hash);
		if (!grant || !entry || entry.expiresAt <= this.now() || !sameResource(grant.resource, resource)) {
			return undefined;
		}
		return { grantId: grant.id, clientId: grant.clientId, clientName: grant.clientName, scopes: grant.scopes };
	}

	/** Records a tool call on the Connected agents page (last used, count). */
	touch(grantId: string, tool: string | undefined): void {
		const grant = this.grants.get(grantId);
		if (grant) {
			grant.lastUsedAt = this.now();
			grant.calls++;
			if (tool) {
				grant.lastTool = tool;
			}
		}
	}

	/** RFC 7009: an access or refresh token of a grant ends the grant. Unknown tokens are fine. */
	revokeToken(token: string | undefined): boolean {
		if (!token) {
			return false;
		}
		const hash = hashSecret(token);
		const id = this.accessIndex.get(hash) ?? this.refreshIndex.get(hash) ?? this.retiredIndex.get(hash);
		if (!id) {
			return false;
		}
		this.dropGrant(id);
		this.onDidChange();
		return true;
	}

	revokeGrant(grantId: string): boolean {
		if (!this.grants.has(grantId)) {
			return false;
		}
		this.dropGrant(grantId);
		this.onDidChange();
		return true;
	}

	private dropGrant(grantId: string): void {
		this.grants.delete(grantId);
		this.reindex();
	}

	listGrants(): IExternalMcpGrantView[] {
		this.prune();
		return [...this.grants.values()]
			.sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
			.map(grant => ({
				id: grant.id,
				clientId: grant.clientId,
				clientName: grant.clientName,
				redirectUri: grant.redirectUri,
				scopes: [...grant.scopes],
				createdAt: grant.createdAt,
				...(grant.lastUsedAt ? { lastUsedAt: grant.lastUsedAt } : {}),
				...(grant.lastTool ? { lastTool: grant.lastTool } : {}),
				calls: grant.calls,
				resource: grant.resource,
			}));
	}

	hasGrantFor(clientId: string): boolean {
		return [...this.grants.values()].some(grant => grant.clientId === clientId);
	}

	//#endregion
}
