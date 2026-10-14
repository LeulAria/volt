/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CredentialAuthKind, ICredential } from '../../shared/api.js';
import { type AuthHeader, presetFor, type WireFormat } from '../../shared/providers.js';
import { db, type GovCredentialTable, iso, parseJson } from '../db.js';
import { unseal } from './crypto.js';

export interface IOAuthClientConfig {
	readonly tokenUrl: string;
	readonly clientId: string;
	readonly scope?: string;
}

/** A credential the gateway can use: the secret opened only for the request that needs it. */
export interface IUpstream {
	readonly credentialId: string;
	readonly provider: string;
	readonly baseUrl: string;
	readonly format: WireFormat;
	readonly authHeader: AuthHeader;
	readonly models: readonly string[];
	/** Resolves the header value (API key, or an OAuth access token fetched and cached). */
	readonly authorization: () => Promise<string>;
}

export function toCredential(row: GovCredentialTable): ICredential {
	return {
		id: row.id,
		provider: row.provider,
		label: row.label,
		baseUrl: row.base_url,
		authKind: row.auth_kind as CredentialAuthKind,
		authHeader: row.auth_header as AuthHeader,
		hint: row.hint,
		status: row.status === 'disabled' ? 'disabled' : 'active',
		models: parseJson<string[]>(row.models_json, []),
		createdAt: iso(row.created_at)!,
		createdBy: row.created_by,
		rotatedAt: iso(row.rotated_at),
		lastUsedAt: iso(row.last_used_at),
	};
}

export function hintFor(secret: string): string {
	return secret.length > 8 ? `…${secret.slice(-4)}` : '…';
}

const tokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

/** OAuth 2.0 client credentials (Azure Entra ID for Azure OpenAI, enterprise gateways). */
async function clientCredentialsToken(credentialId: string, config: IOAuthClientConfig, clientSecret: string): Promise<string> {
	const cached = tokens.get(credentialId);
	if (cached && cached.expiresAt - 60_000 > Date.now()) {
		return cached.token;
	}
	const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: clientSecret });
	if (config.scope) {
		body.set('scope', config.scope);
	}
	const res = await fetch(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
	if (!res.ok) {
		throw new Error(`Token endpoint answered ${res.status}`);
	}
	const json = await res.json() as { access_token?: string; expires_in?: number };
	if (!json.access_token) {
		throw new Error('Token endpoint returned no access_token');
	}
	tokens.set(credentialId, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
	return json.access_token;
}

export function forgetToken(credentialId: string): void {
	tokens.delete(credentialId);
}

export function toUpstream(row: GovCredentialTable): IUpstream {
	const preset = presetFor(row.provider);
	const authKind = row.auth_kind as CredentialAuthKind;
	return {
		credentialId: row.id,
		provider: row.provider,
		baseUrl: row.base_url.replace(/\/+$/, ''),
		format: preset?.format ?? 'openai',
		authHeader: row.auth_header as AuthHeader,
		models: parseJson<string[]>(row.models_json, []),
		authorization: async () => {
			const secret = unseal(row.secret_enc, row.organization_id);
			if (authKind === 'oauth_client') {
				const config = parseJson<IOAuthClientConfig | undefined>(row.oauth_json, undefined);
				if (!config) {
					throw new Error('OAuth configuration missing');
				}
				return clientCredentialsToken(row.id, config, secret);
			}
			return secret;
		},
	};
}

const upstreamCache = new Map<string, { readonly at: number; readonly value: readonly GovCredentialTable[] }>();

export function invalidateCredentials(organizationId: string): void {
	upstreamCache.delete(organizationId);
}

export async function activeCredentials(organizationId: string): Promise<readonly GovCredentialTable[]> {
	const hit = upstreamCache.get(organizationId);
	if (hit && Date.now() - hit.at < 30_000) {
		return hit.value;
	}
	const value = await db.selectFrom('gov_credential').selectAll()
		.where('organization_id', '=', organizationId).where('status', '=', 'active')
		.orderBy('created_at', 'asc').execute();
	upstreamCache.set(organizationId, { at: Date.now(), value });
	return value;
}

/**
 * Picks the credential for a requested model on one wire format. `provider/model` names a provider;
 * a bare model goes to the credential that lists it, else the first of that format that lists no
 * models (meaning "any").
 */
export async function resolveUpstream(organizationId: string, format: WireFormat, requested: { readonly provider?: string; readonly model: string }): Promise<IUpstream | undefined> {
	const rows = (await activeCredentials(organizationId)).filter(r => (presetFor(r.provider)?.format ?? 'openai') === format);
	const candidates = requested.provider ? rows.filter(r => r.provider === requested.provider) : rows;
	const listed = candidates.find(r => parseJson<string[]>(r.models_json, []).includes(requested.model));
	const open = candidates.find(r => parseJson<string[]>(r.models_json, []).length === 0);
	const row = listed ?? open;
	return row ? toUpstream(row) : undefined;
}

const lastUsedWrites = new Map<string, number>();

export function touchCredential(credentialId: string): void {
	const t = Date.now();
	if (t - (lastUsedWrites.get(credentialId) ?? 0) < 60_000) {
		return;
	}
	lastUsedWrites.set(credentialId, t);
	void db.updateTable('gov_credential').set({ last_used_at: t }).where('id', '=', credentialId).execute().catch(() => undefined);
}
