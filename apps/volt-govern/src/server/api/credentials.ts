/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import type { ICredentialInput } from '../../shared/api.js';
import { type AuthHeader, presetFor } from '../../shared/providers.js';
import { db, newId, now, parseJson } from '../db.js';
import { audit } from '../lib/audit.js';
import { actor, type AppEnv, fail, readJson, requireOrg, requirePermission, requireSession } from '../lib/context.js';
import { forgetToken, hintFor, invalidateCredentials, toCredential, toUpstream } from '../lib/credentials.js';
import { seal } from '../lib/crypto.js';
import { invalidatePolicies } from '../lib/policy.js';

/**
 * Provider credentials. Secrets are write-only: they are sealed on arrival, never returned, and
 * only opened by the gateway for the request that needs them. Everything else about a credential
 * (label, URL, models, status) is editable and audited.
 */
export const credentialsApi = new Hono<AppEnv>();
credentialsApi.use('*', requireSession, requireOrg);

const AUTH_HEADERS: readonly AuthHeader[] = ['x-api-key', 'bearer', 'api-key'];

function cleanModels(models: readonly string[] | undefined): string[] {
	return [...new Set((models ?? []).map(m => String(m).trim()).filter(Boolean))].slice(0, 200);
}

function validBaseUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
	} catch {
		return false;
	}
}

credentialsApi.get('/', requirePermission({ credential: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_credential').selectAll().where('organization_id', '=', c.var.org.id).orderBy('created_at', 'asc').execute();
	return c.json(rows.map(toCredential));
});

credentialsApi.post('/', requirePermission({ credential: ['create'] }), async c => {
	const input = await readJson<ICredentialInput>(c);
	const preset = input && presetFor(input.provider);
	if (!input || !preset) {
		return fail(c, 400, 'Choose a provider');
	}
	if (!input.label?.trim()) {
		return fail(c, 400, 'Give the credential a name');
	}
	if (!input.secret?.trim()) {
		return fail(c, 400, input.authKind === 'oauth_client' ? 'The client secret is required' : 'The API key is required');
	}
	const baseUrl = (input.baseUrl?.trim() || preset.baseUrl).replace(/\/+$/, '');
	if (!validBaseUrl(baseUrl) || baseUrl.includes('<')) {
		return fail(c, 400, 'The base URL must be an https URL (or localhost)');
	}
	if (input.authKind === 'oauth_client' && (!input.oauth?.tokenUrl || !input.oauth.clientId)) {
		return fail(c, 400, 'OAuth client credentials need a token URL and a client id');
	}
	const id = newId();
	const organizationId = c.var.org.id;
	await db.insertInto('gov_credential').values({
		id,
		organization_id: organizationId,
		provider: preset.id,
		label: input.label.trim().slice(0, 120),
		base_url: baseUrl,
		auth_kind: input.authKind === 'oauth_client' ? 'oauth_client' : 'api_key',
		auth_header: input.authHeader && AUTH_HEADERS.includes(input.authHeader) ? input.authHeader : preset.authHeader,
		secret_enc: seal(input.secret.trim(), organizationId),
		oauth_json: input.authKind === 'oauth_client' ? JSON.stringify({ tokenUrl: input.oauth!.tokenUrl, clientId: input.oauth!.clientId, scope: input.oauth!.scope }) : null,
		hint: input.authKind === 'oauth_client' ? input.oauth!.clientId.slice(0, 40) : hintFor(input.secret.trim()),
		status: input.status === 'disabled' ? 'disabled' : 'active',
		models_json: JSON.stringify(cleanModels(input.models)),
		created_at: now(),
		created_by: c.var.user.id,
		rotated_at: null,
		last_used_at: null,
	}).execute();
	invalidateCredentials(organizationId);
	await audit({ ...actor(c), action: 'credential.create', targetType: 'credential', targetId: id, detail: { provider: preset.id, label: input.label, authKind: input.authKind } });
	const row = await db.selectFrom('gov_credential').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
	return c.json(toCredential(row), 201);
});

credentialsApi.patch('/:id', requirePermission({ credential: ['update'] }), async c => {
	const input = await readJson<Partial<ICredentialInput>>(c);
	const organizationId = c.var.org.id;
	const row = await db.selectFrom('gov_credential').selectAll().where('organization_id', '=', organizationId).where('id', '=', c.req.param('id')).executeTakeFirst();
	if (!row || !input) {
		return fail(c, 404, 'No such credential');
	}
	const changes: Record<string, unknown> = {};
	if (input.label !== undefined) {
		changes.label = input.label.trim().slice(0, 120) || row.label;
	}
	if (input.baseUrl !== undefined) {
		const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
		if (!validBaseUrl(baseUrl)) {
			return fail(c, 400, 'The base URL must be an https URL (or localhost)');
		}
		changes.base_url = baseUrl;
	}
	if (input.models !== undefined) {
		changes.models_json = JSON.stringify(cleanModels(input.models));
	}
	if (input.status !== undefined) {
		changes.status = input.status === 'disabled' ? 'disabled' : 'active';
	}
	if (input.authHeader !== undefined && AUTH_HEADERS.includes(input.authHeader)) {
		changes.auth_header = input.authHeader;
	}
	if (input.oauth && row.auth_kind === 'oauth_client') {
		changes.oauth_json = JSON.stringify({ tokenUrl: input.oauth.tokenUrl, clientId: input.oauth.clientId, scope: input.oauth.scope });
		changes.hint = input.oauth.clientId.slice(0, 40);
	}
	if (input.secret?.trim()) {
		changes.secret_enc = seal(input.secret.trim(), organizationId);
		changes.rotated_at = now();
		if (row.auth_kind !== 'oauth_client') {
			changes.hint = hintFor(input.secret.trim());
		}
		forgetToken(row.id);
	}
	if (Object.keys(changes).length) {
		await db.updateTable('gov_credential').set(changes).where('organization_id', '=', organizationId).where('id', '=', row.id).execute();
	}
	invalidateCredentials(organizationId);
	invalidatePolicies(organizationId);
	await audit({ ...actor(c), action: input.secret ? 'credential.rotate' : 'credential.update', targetType: 'credential', targetId: row.id, detail: { fields: Object.keys(changes).filter(k => k !== 'secret_enc') } });
	const next = await db.selectFrom('gov_credential').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
	return c.json(toCredential(next));
});

credentialsApi.delete('/:id', requirePermission({ credential: ['delete'] }), async c => {
	const organizationId = c.var.org.id;
	const row = await db.selectFrom('gov_credential').select(['id', 'label', 'provider']).where('organization_id', '=', organizationId).where('id', '=', c.req.param('id')).executeTakeFirst();
	if (!row) {
		return fail(c, 404, 'No such credential');
	}
	await db.deleteFrom('gov_credential').where('organization_id', '=', organizationId).where('id', '=', row.id).execute();
	forgetToken(row.id);
	invalidateCredentials(organizationId);
	await audit({ ...actor(c), action: 'credential.delete', targetType: 'credential', targetId: row.id, detail: { label: row.label, provider: row.provider } });
	return c.json({ ok: true });
});

/** Asks the provider for its model list with the stored secret: proves the key works, offers models. */
credentialsApi.post('/:id/test', requirePermission({ credential: ['update'] }), async c => {
	const row = await db.selectFrom('gov_credential').selectAll().where('organization_id', '=', c.var.org.id).where('id', '=', c.req.param('id')).executeTakeFirst();
	if (!row) {
		return fail(c, 404, 'No such credential');
	}
	const upstream = toUpstream(row);
	const started = Date.now();
	try {
		const headers = new Headers({ accept: 'application/json' });
		const credential = await upstream.authorization();
		if (upstream.authHeader === 'x-api-key') {
			headers.set('x-api-key', credential);
			headers.set('anthropic-version', '2023-06-01');
		} else if (upstream.authHeader === 'api-key') {
			headers.set('api-key', credential);
		} else {
			headers.set('authorization', `Bearer ${credential}`);
		}
		const res = await fetch(`${upstream.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000) });
		const json = await res.json().catch(() => ({})) as { data?: { id?: string }[] };
		const models = (json.data ?? []).map(m => m.id).filter((m): m is string => !!m).sort();
		await audit({ ...actor(c), action: 'credential.test', targetType: 'credential', targetId: row.id, detail: { ok: res.ok, status: res.status } });
		return c.json({ ok: res.ok, status: res.status, latencyMs: Date.now() - started, models: models.slice(0, 500), configured: parseJson<string[]>(row.models_json, []) });
	} catch (err) {
		return c.json({ ok: false, status: 0, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err), models: [] });
	}
});
