/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { sql } from 'kysely';
import type { IAlert, IMe, IOrgSettings, IOverview } from '../../shared/api.js';
import { db, iso } from '../db.js';
import { audit } from '../lib/audit.js';
import { actor, type AppEnv, readJson, requireOrg, requirePermission, requireSession } from '../lib/context.js';
import { invalidateCredentials } from '../lib/credentials.js';
import { effectivePolicy, invalidatePolicies } from '../lib/policy.js';
import { getSettings, putSettings, sanitizeSettings } from '../lib/settings.js';

export const consoleApi = new Hono<AppEnv>();

const DAY = 86_400_000;

consoleApi.get('/me', requireSession, async c => {
	const user = c.var.user;
	const activeId = (c.var.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
	const orgs = await db.selectFrom('member').innerJoin('organization', 'organization.id', 'member.organizationId')
		.select(['organization.id', 'organization.name', 'organization.slug', 'member.role'])
		.where('member.userId', '=', user.id).orderBy('organization.name').execute();
	const active = orgs.find(o => o.id === activeId);
	const me: IMe = {
		user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
		organization: active ? { id: active.id, name: active.name, slug: active.slug } : null,
		role: active?.role ?? null,
		organizations: orgs.map(o => ({ id: o.id, name: o.name, slug: o.slug })),
	};
	return c.json(me);
});

/** A developer's own view: what they may use, and their usage this month. */
consoleApi.get('/me/access', requireSession, requireOrg, async c => {
	const { id: organizationId } = c.var.org;
	const resolved = await effectivePolicy(organizationId, c.var.user.id);
	const month = new Date();
	const since = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1);
	const usage = await db.selectFrom('gov_usage')
		.select([sql<number>`count(*)`.as('requests'), sql<number>`coalesce(sum(cost_micros), 0)`.as('cost'), sql<number>`coalesce(sum(input_tokens + output_tokens), 0)`.as('tokens')])
		.where('organization_id', '=', organizationId).where('user_id', '=', c.var.user.id).where('created_at', '>=', since)
		.executeTakeFirst();
	return c.json({
		layers: resolved.layers.map(l => ({ scopeType: l.scopeType, scopeId: l.scopeId, label: l.label })),
		policy: resolved.policy,
		usage: { requests: Number(usage?.requests ?? 0), costMicros: Number(usage?.cost ?? 0), tokens: Number(usage?.tokens ?? 0) },
	});
});

/**
 * Team id → member user ids for every team of the organization. Better Auth lists a team's
 * members only to that team's own members; the console shows every team to every member.
 */
consoleApi.get('/team-members', requireSession, requireOrg, async c => {
	const rows = await db.selectFrom('teamMember').innerJoin('team', 'team.id', 'teamMember.teamId')
		.select(['teamMember.teamId', 'teamMember.userId']).where('team.organizationId', '=', c.var.org.id).execute();
	const teams: Record<string, string[]> = {};
	for (const row of rows) {
		(teams[row.teamId] ??= []).push(row.userId);
	}
	return c.json(teams);
});

consoleApi.get('/overview', requireSession, requireOrg, requirePermission({ usage: ['read'] }), async c => {
	const org = c.var.org.id;
	const since = Date.now() - 30 * DAY;
	const [members, teams, devices, credentials, mcp, skills, totals, daily, models, alerts, sso, scim, policy, invitations] = await Promise.all([
		db.selectFrom('member').select(sql<number>`count(*)`.as('n')).where('organizationId', '=', org).executeTakeFirst(),
		db.selectFrom('team').select(sql<number>`count(*)`.as('n')).where('organizationId', '=', org).executeTakeFirst(),
		db.selectFrom('gov_device').select(sql<number>`count(*)`.as('n')).where('organization_id', '=', org).where('revoked_at', 'is', null).executeTakeFirst(),
		db.selectFrom('gov_credential').select(sql<number>`count(*)`.as('n')).where('organization_id', '=', org).where('status', '=', 'active').executeTakeFirst(),
		db.selectFrom('gov_mcp_server').select(['status', sql<number>`count(*)`.as('n')]).where('organization_id', '=', org).groupBy('status').execute(),
		db.selectFrom('gov_skill').select(sql<number>`count(*)`.as('n')).where('organization_id', '=', org).where('status', '=', 'published').executeTakeFirst(),
		db.selectFrom('gov_usage').select([
			sql<number>`count(*)`.as('requests'),
			sql<number | null>`sum(cost_micros)`.as('cost'),
			sql<number>`coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)`.as('tokens'),
			sql<number>`coalesce(sum(case when status = 'blocked' then 1 else 0 end), 0)`.as('blocked'),
			sql<number>`count(distinct user_id)`.as('users'),
		]).where('organization_id', '=', org).where('created_at', '>=', since).executeTakeFirst(),
		db.selectFrom('gov_usage').select([
			sql<number>`(created_at / 86400000)`.as('day'),
			sql<number>`count(*)`.as('requests'),
			sql<number>`coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)`.as('tokens'),
			sql<number>`coalesce(sum(cost_micros), 0)`.as('cost'),
		]).where('organization_id', '=', org).where('created_at', '>=', since).groupBy(sql`(created_at / 86400000)`).execute(),
		db.selectFrom('gov_usage').select(['provider', 'model', sql<number>`count(*)`.as('requests'), sql<number>`coalesce(sum(cost_micros), 0)`.as('cost')])
			.where('organization_id', '=', org).where('created_at', '>=', since).where('status', '=', 'ok')
			.groupBy(['provider', 'model']).orderBy(sql`count(*)`, 'desc').limit(6).execute(),
		db.selectFrom('gov_alert').selectAll().where('organization_id', '=', org).where('acknowledged_at', 'is', null).orderBy('created_at', 'desc').limit(20).execute(),
		db.selectFrom('ssoProvider').select(sql<number>`count(*)`.as('n')).where('organizationId', '=', org).executeTakeFirst().catch(() => ({ n: 0 })),
		sql<{ n: number }>`select count(*) as n from "scimManagedConnection" where "provisioningDomainId" = ${org} and "status" = 'active'`.execute(db).then(r => r.rows[0]).catch(() => ({ n: 0 })),
		db.selectFrom('gov_policy').select(sql<number>`count(*)`.as('n')).where('organization_id', '=', org).executeTakeFirst(),
		sql<{ n: number }>`select count(*) as n from "invitation" where "organizationId" = ${org}`.execute(db).then(r => r.rows[0]).catch(() => ({ n: 0 })),
	]);
	const byDay = new Map(daily.map(d => [Number(d.day), d]));
	const today = Math.floor(Date.now() / DAY);
	const overview: IOverview = {
		members: Number(members?.n ?? 0),
		teams: Number(teams?.n ?? 0),
		devices: Number(devices?.n ?? 0),
		credentials: Number(credentials?.n ?? 0),
		mcpApproved: Number(mcp.find(m => m.status === 'approved')?.n ?? 0),
		mcpPending: Number(mcp.find(m => m.status === 'pending')?.n ?? 0),
		skills: Number(skills?.n ?? 0),
		spend30dMicros: totals?.cost === null || totals?.cost === undefined ? null : Number(totals.cost),
		requests30d: Number(totals?.requests ?? 0),
		tokens30d: Number(totals?.tokens ?? 0),
		blocked30d: Number(totals?.blocked ?? 0),
		activeUsers30d: Number(totals?.users ?? 0),
		daily: Array.from({ length: 30 }, (_, i) => {
			const day = today - 29 + i;
			const d = byDay.get(day);
			return { day: new Date(day * DAY).toISOString().slice(0, 10), requests: Number(d?.requests ?? 0), tokens: Number(d?.tokens ?? 0), costMicros: Number(d?.cost ?? 0) };
		}),
		topModels: models.map(m => ({ model: `${m.provider}/${m.model}`, requests: Number(m.requests), costMicros: Number(m.cost) })),
		alerts: alerts.map(toAlert),
		setup: {
			credential: Number(credentials?.n ?? 0) > 0,
			sso: Number(sso?.n ?? 0) > 0,
			scim: Number(scim?.n ?? 0) > 0,
			policy: Number(policy?.n ?? 0) > 0,
			invited: Number(members?.n ?? 0) > 1 || Number(invitations?.n ?? 0) > 0,
		},
	};
	return c.json(overview);
});

function toAlert(row: { id: string; kind: string; severity: string; message: string; created_at: number; acknowledged_at: number | null }): IAlert {
	return { id: row.id, kind: row.kind as IAlert['kind'], severity: row.severity as IAlert['severity'], message: row.message, createdAt: iso(row.created_at)!, acknowledgedAt: iso(row.acknowledged_at) };
}

consoleApi.get('/alerts', requireSession, requireOrg, requirePermission({ usage: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_alert').selectAll().where('organization_id', '=', c.var.org.id).orderBy('created_at', 'desc').limit(200).execute();
	return c.json(rows.map(toAlert));
});

consoleApi.post('/alerts/:id/ack', requireSession, requireOrg, requirePermission({ usage: ['read'] }), async c => {
	await db.updateTable('gov_alert').set({ acknowledged_at: Date.now(), acknowledged_by: c.var.user.id })
		.where('organization_id', '=', c.var.org.id).where('id', '=', c.req.param('id')).execute();
	return c.json({ ok: true });
});

consoleApi.get('/settings', requireSession, requireOrg, requirePermission({ settings: ['read'] }), async c => c.json(await getSettings(c.var.org.id)));

consoleApi.put('/settings', requireSession, requireOrg, requirePermission({ settings: ['update'] }), async c => {
	const input = await readJson<Partial<IOrgSettings>>(c);
	if (!input) {
		return c.json({ error: 'Invalid settings' }, 400);
	}
	const before = await getSettings(c.var.org.id);
	const next = sanitizeSettings({ ...before, ...input });
	await putSettings(c.var.org.id, next, c.var.user.id);
	invalidatePolicies(c.var.org.id);
	invalidateCredentials(c.var.org.id);
	const changed = (Object.keys(next) as (keyof IOrgSettings)[]).filter(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
	await audit({ ...actor(c), action: 'settings.update', targetType: 'settings', detail: { changed } });
	return c.json(next);
});
