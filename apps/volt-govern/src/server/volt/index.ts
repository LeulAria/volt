/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { JsonWebKey } from 'node:crypto';
import { type Context, Hono } from 'hono';
import type { IVoltPolicyBundle } from '../../shared/api.js';
import { auth, VOLT_DESKTOP_CLIENT_ID } from '../auth.js';
import { db, newId, now, parseJson } from '../db.js';
import { env } from '../env.js';
import { allowedModels } from '../gateway/index.js';
import { authenticate, type IPrincipal, issueGatewayToken } from '../gateway/principal.js';
import { audit } from '../lib/audit.js';
import { clientIp, fail, readJson } from '../lib/context.js';
import { jwks, jwkThumbprint, signJwt, verifyDpop } from '../lib/crypto.js';
import { deviceState } from '../lib/devices.js';
import { effectivePolicy } from '../lib/policy.js';

/**
 * What Volt desktop talks to. Sign-in is the OAuth device authorization grant (Better Auth's
 * `/api/auth/device/*`): Volt shows a code, the developer approves it in the console (or their
 * SSO), and Volt receives a session token. With it, Volt registers its device key and mints
 * short-lived gateway tokens, every request proving possession of that key (DPoP).
 */
export const wellKnown = new Hono();
export const voltApi = new Hono();

wellKnown.get('/configuration', c => c.json({
	issuer: env.baseUrl,
	device_authorization: {
		client_id: VOLT_DESKTOP_CLIENT_ID,
		device_authorization_endpoint: `${env.baseUrl}/api/auth/device/code`,
		token_endpoint: `${env.baseUrl}/api/auth/device/token`,
		verification_uri: `${env.baseUrl}/device`,
	},
	endpoints: {
		organizations: `${env.baseUrl}/api/auth/organization/list`,
		register_device: `${env.baseUrl}/api/volt/devices`,
		token: `${env.baseUrl}/api/volt/token`,
		policy: `${env.baseUrl}/api/volt/policy`,
		skills: `${env.baseUrl}/api/volt/skills`,
		mcp_requests: `${env.baseUrl}/api/volt/mcp-requests`,
		events: `${env.baseUrl}/api/volt/events`,
	},
	gateway: {
		anthropic_base_url: `${env.baseUrl}/gateway/anthropic`,
		openai_base_url: `${env.baseUrl}/gateway/openai/v1`,
	},
	dpop_signing_alg_values_supported: ['ES256', 'EdDSA'],
	jwks_uri: `${env.baseUrl}/.well-known/volt-govern/jwks.json`,
}));

wellKnown.get('/jwks.json', async c => c.json(await jwks()));

/** Session from a bearer token only: a cookie must never be enough to enrol a device (CSRF). */
async function bearerSession(c: Context) {
	if (!/^Bearer\s+/i.test(c.req.header('authorization') ?? '')) {
		return undefined;
	}
	return auth.api.getSession({ headers: c.req.raw.headers });
}

voltApi.post('/devices', async c => {
	const session = await bearerSession(c);
	if (!session) {
		return fail(c, 401, 'Sign in with Volt first (device authorization)', 'unauthenticated');
	}
	const body = await readJson<{ organizationId?: string; name?: string; platform?: string; appVersion?: string; publicJwk?: JsonWebKey }>(c);
	if (!body?.organizationId || !body.publicJwk || !body.name) {
		return fail(c, 400, 'organizationId, name and publicJwk are required');
	}
	const member = await db.selectFrom('member').select('id').where('organizationId', '=', body.organizationId).where('userId', '=', session.user.id).executeTakeFirst();
	if (!member) {
		return fail(c, 403, 'You are not a member of this organization', 'not_member');
	}
	let jkt: string;
	try {
		jkt = jwkThumbprint(body.publicJwk);
	} catch {
		return fail(c, 400, 'publicJwk must be an EC P-256 or Ed25519 public key');
	}
	const proof = verifyDpop(c.req.header('dpop'), { method: 'POST', path: '/api/volt/devices', expectedJkt: jkt });
	if ('error' in proof) {
		return fail(c, 401, proof.error, 'dpop_required');
	}
	const id = newId();
	const publicJwk = { kty: body.publicJwk.kty, crv: body.publicJwk.crv, x: body.publicJwk.x, y: body.publicJwk.y };
	await db.insertInto('gov_device').values({
		id,
		organization_id: body.organizationId,
		user_id: session.user.id,
		name: String(body.name).slice(0, 120),
		platform: String(body.platform ?? 'unknown').slice(0, 40),
		app_version: String(body.appVersion ?? '').slice(0, 40),
		public_jwk: JSON.stringify(publicJwk),
		jkt,
		created_at: now(),
		last_seen_at: now(),
		revoked_at: null,
		revoked_by: null,
	}).execute();
	await audit({ organizationId: body.organizationId, actorId: session.user.id, action: 'device.register', targetType: 'device', targetId: id, detail: { name: body.name, platform: body.platform, appVersion: body.appVersion }, ip: clientIp(c), userAgent: c.req.header('user-agent') });
	return c.json({ deviceId: id });
});

voltApi.post('/token', async c => {
	const session = await bearerSession(c);
	if (!session) {
		return fail(c, 401, 'Your Volt session has ended; sign in again', 'unauthenticated');
	}
	const body = await readJson<{ deviceId?: string }>(c);
	const device = body?.deviceId ? await deviceState(body.deviceId) : undefined;
	if (!device || device.userId !== session.user.id) {
		return fail(c, 404, 'Unknown device; register it again', 'unknown_device');
	}
	if (device.revoked) {
		return fail(c, 401, 'This device was revoked by your organization', 'device_revoked');
	}
	const proof = verifyDpop(c.req.header('dpop'), { method: 'POST', path: '/api/volt/token', expectedJkt: device.jkt });
	if ('error' in proof) {
		return fail(c, 401, proof.error, 'dpop_required');
	}
	const member = await db.selectFrom('member').select('id').where('organizationId', '=', device.organizationId).where('userId', '=', session.user.id).executeTakeFirst();
	if (!member) {
		return fail(c, 403, 'You are no longer a member of this organization', 'not_member');
	}
	const { token, expiresIn } = await issueGatewayToken(device.organizationId, session.user.id, device.id, device.jkt);
	return c.json({ access_token: token, token_type: 'DPoP', expires_in: expiresIn, organization_id: device.organizationId });
});

/** Routes Volt calls with its gateway token (and DPoP), like the gateway itself. */
async function principalOf(c: Context): Promise<IPrincipal | Response> {
	const result = await authenticate(c);
	return 'principal' in result ? result.principal : fail(c, result.status, result.error, result.code);
}

voltApi.get('/policy', async c => {
	const principal = await principalOf(c);
	if (principal instanceof Response) {
		return principal;
	}
	const { organizationId, userId } = principal;
	const resolved = await effectivePolicy(organizationId, userId);
	const [mcp, skills, anthropicModels, openaiModels] = await Promise.all([
		db.selectFrom('gov_mcp_server').selectAll().where('organization_id', '=', organizationId).where('status', '=', 'approved').execute(),
		db.selectFrom('gov_skill').select(['id', 'name', 'kind', 'version', 'description', 'teams_json']).where('organization_id', '=', organizationId).where('status', '=', 'published').execute(),
		allowedModels(principal, 'anthropic'),
		allowedModels(principal, 'openai'),
	]);
	const required = new Set(resolved.policy.skills.required);
	const iat = Math.floor(Date.now() / 1000);
	const bundle: IVoltPolicyBundle = {
		organizationId,
		userId,
		issuedAt: iat,
		expiresAt: iat + 3600,
		gateway: { anthropic: `${env.baseUrl}/gateway/anthropic`, openai: `${env.baseUrl}/gateway/openai/v1` },
		models: [
			...anthropicModels.map(m => ({ ref: m.id, provider: m.provider, model: m.id.replace(/^[^/]+\//, ''), format: 'anthropic' as const })),
			...openaiModels.map(m => ({ ref: m.id, provider: m.provider, model: m.id.replace(/^[^/]+\//, ''), format: 'openai' as const })),
		],
		policy: resolved.policy,
		mcpServers: mcp.map(s => ({
			name: s.name,
			transport: s.transport === 'http' ? 'http' : 'stdio',
			command: s.command,
			url: s.url,
			blockedTools: parseJson<{ name: string; blocked: boolean }[]>(s.tools_json, []).filter(t => t.blocked).map(t => t.name),
		})),
		skills: skills
			.filter(s => {
				const teams = parseJson<string[]>(s.teams_json, []);
				return required.has(s.id) || !teams.length || teams.some(t => resolved.teamIds.includes(t));
			})
			.map(s => ({ id: s.id, name: s.name, kind: s.kind as IVoltPolicyBundle['skills'][number]['kind'], version: s.version, description: s.description })),
	};
	return c.json({ bundle, signature: await signJwt({ ...bundle, exp: bundle.expiresAt }, 'vgp+jwt') });
});

voltApi.get('/skills/:id', async c => {
	const principal = await principalOf(c);
	if (principal instanceof Response) {
		return principal;
	}
	const skill = await db.selectFrom('gov_skill').selectAll().where('organization_id', '=', principal.organizationId).where('id', '=', c.req.param('id')).where('status', '=', 'published').executeTakeFirst();
	if (!skill) {
		return fail(c, 404, 'No such skill');
	}
	const { teamIds, policy } = await effectivePolicy(principal.organizationId, principal.userId);
	const teams = parseJson<string[]>(skill.teams_json, []);
	if (teams.length && !teams.some(t => teamIds.includes(t)) && !policy.skills.required.includes(skill.id)) {
		return fail(c, 403, 'This skill is not shared with your teams');
	}
	return c.json({ id: skill.id, name: skill.name, kind: skill.kind, version: skill.version, description: skill.description, content: skill.content });
});

voltApi.post('/mcp-requests', async c => {
	const principal = await principalOf(c);
	if (principal instanceof Response) {
		return principal;
	}
	const body = await readJson<{ name?: string; transport?: string; command?: string; url?: string; reason?: string; description?: string }>(c);
	const name = body?.name?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
	if (!name) {
		return fail(c, 400, 'A server name is required');
	}
	const existing = await db.selectFrom('gov_mcp_server').select(['id', 'status']).where('organization_id', '=', principal.organizationId).where('name', '=', name).executeTakeFirst();
	if (existing) {
		return c.json({ id: existing.id, status: existing.status });
	}
	const id = newId();
	await db.insertInto('gov_mcp_server').values({
		id,
		organization_id: principal.organizationId,
		name,
		description: String(body?.description ?? '').slice(0, 500),
		transport: body?.transport === 'http' ? 'http' : 'stdio',
		command: body?.command?.slice(0, 1000) ?? null,
		url: body?.url?.slice(0, 1000) ?? null,
		status: 'pending',
		tools_json: '[]',
		requested_by: principal.userId,
		request_reason: body?.reason?.slice(0, 1000) ?? null,
		reviewed_by: null,
		created_at: now(),
		updated_at: now(),
	}).execute();
	await audit({ organizationId: principal.organizationId, actorId: principal.userId, actorType: 'device', action: 'mcp.request', targetType: 'mcp', targetId: id, detail: { name } });
	return c.json({ id, status: 'pending' });
});

const EVENT_KINDS = new Set(['run', 'tool', 'mcp_call', 'edit', 'access_denied', 'skill_used', 'session']);

/** Client-side activity (runs, tool calls, MCP use, denials) for insights. Bounded and typed. */
voltApi.post('/events', async c => {
	const principal = await principalOf(c);
	if (principal instanceof Response) {
		return principal;
	}
	const body = await readJson<{ events?: { kind?: string; name?: string; count?: number; detail?: Record<string, unknown>; at?: number }[] }>(c);
	const events = (body?.events ?? []).filter(e => e && EVENT_KINDS.has(String(e.kind))).slice(0, 500);
	if (events.length) {
		await db.insertInto('gov_activity').values(events.map(e => ({
			id: newId(),
			organization_id: principal.organizationId,
			user_id: principal.userId,
			device_id: principal.deviceId,
			kind: String(e.kind),
			name: String(e.name ?? '').slice(0, 200),
			count: Math.max(1, Math.min(1_000_000, Math.round(Number(e.count ?? 1)) || 1)),
			detail_json: JSON.stringify(e.detail ?? {}).slice(0, 4000),
			created_at: typeof e.at === 'number' && Math.abs(e.at - Date.now()) < 7 * 86_400_000 ? Math.round(e.at) : now(),
		}))).execute();
	}
	return c.json({ accepted: events.length });
});
