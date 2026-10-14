/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { type RawBuilder, sql } from 'kysely';
import type { IAuditEvent, IDevice, IRequestLog, IUsageReport, IUsageTotals, UsageGroup } from '../../shared/api.js';
import { db, iso, parseJson } from '../db.js';
import { audit } from '../lib/audit.js';
import { actor, type AppEnv, fail, requireOrg, requirePermission, requireSession } from '../lib/context.js';
import { revokeDevice } from '../lib/devices.js';

export const insightsApi = new Hono<AppEnv>();
insightsApi.use('*', requireSession, requireOrg);

const DAY = 86_400_000;
const GROUPS: readonly UsageGroup[] = ['day', 'model', 'provider', 'user', 'team', 'status'];

function range(from?: string, to?: string): { readonly from: number; readonly to: number } {
	const end = to ? Date.parse(to) : Date.now();
	const start = from ? Date.parse(from) : end - 30 * DAY;
	return { from: Number.isFinite(start) ? start : Date.now() - 30 * DAY, to: Number.isFinite(end) ? end : Date.now() };
}

const TOTALS = [
	sql<number>`count(*)`.as('requests'),
	sql<number>`coalesce(sum(input_tokens), 0)`.as('input'),
	sql<number>`coalesce(sum(output_tokens), 0)`.as('output'),
	sql<number>`coalesce(sum(cache_read_tokens), 0)`.as('cache_read'),
	sql<number | null>`sum(cost_micros)`.as('cost'),
	sql<number>`coalesce(sum(case when status = 'blocked' then 1 else 0 end), 0)`.as('blocked'),
	sql<number>`coalesce(sum(case when status = 'error' then 1 else 0 end), 0)`.as('errors'),
	sql<number>`coalesce(sum(tool_calls), 0)`.as('tools'),
	sql<number>`coalesce(avg(latency_ms), 0)`.as('latency'),
] as const;

interface ITotalsRow { requests: number; input: number; output: number; cache_read: number; cost: number | null; blocked: number; errors: number; tools: number; latency: number }

function totals(row: ITotalsRow | undefined): IUsageTotals {
	return {
		requests: Number(row?.requests ?? 0),
		inputTokens: Number(row?.input ?? 0),
		outputTokens: Number(row?.output ?? 0),
		cacheReadTokens: Number(row?.cache_read ?? 0),
		costMicros: row?.cost === null || row?.cost === undefined ? null : Number(row.cost),
		blocked: Number(row?.blocked ?? 0),
		errors: Number(row?.errors ?? 0),
		toolCalls: Number(row?.tools ?? 0),
		avgLatencyMs: Math.round(Number(row?.latency ?? 0)),
	};
}

insightsApi.get('/usage', requirePermission({ usage: ['read'] }), async c => {
	const organizationId = c.var.org.id;
	const { from, to } = range(c.req.query('from'), c.req.query('to'));
	const groupBy = (GROUPS.includes(c.req.query('groupBy') as UsageGroup) ? c.req.query('groupBy') : 'day') as UsageGroup;
	const userFilter = c.req.query('userId');
	const base = () => {
		let q = db.selectFrom('gov_usage').where('organization_id', '=', organizationId).where('created_at', '>=', from).where('created_at', '<', to);
		if (userFilter) {
			q = q.where('user_id', '=', userFilter);
		}
		return q;
	};
	const all = await base().select(TOTALS).executeTakeFirst() as ITotalsRow | undefined;

	let rows: IUsageReport['rows'][number][];
	if (groupBy === 'team') {
		const teams = await db.selectFrom('team').select(['id', 'name']).where('organizationId', '=', organizationId).execute();
		rows = [];
		for (const team of teams) {
			const members = (await db.selectFrom('teamMember').select('userId').where('teamId', '=', team.id).execute()).map(m => m.userId);
			if (!members.length) {
				continue;
			}
			const row = await base().where('user_id', 'in', members).select(TOTALS).executeTakeFirst() as ITotalsRow | undefined;
			rows.push({ key: team.id, label: team.name, ...totals(row) });
		}
		rows = [...rows].sort((a, b) => b.requests - a.requests);
	} else {
		const key: Record<Exclude<UsageGroup, 'team'>, RawBuilder<unknown>> = {
			day: sql`(created_at / 86400000)`,
			model: sql`provider || '/' || model`,
			provider: sql`provider`,
			user: sql`user_id`,
			status: sql`status`,
		};
		const grouped = await base().select([key[groupBy].as('k') as never, ...TOTALS]).groupBy(key[groupBy] as never).execute() as unknown as (ITotalsRow & { k: string | number })[];
		const names = groupBy === 'user'
			? new Map((await db.selectFrom('user').select(['id', 'name', 'email']).where('id', 'in', grouped.length ? grouped.map(g => String(g.k)) : ['']).execute()).map(u => [u.id, u.name || u.email]))
			: undefined;
		rows = grouped.map(g => ({
			key: String(g.k),
			label: groupBy === 'day' ? new Date(Number(g.k) * DAY).toISOString().slice(0, 10) : names?.get(String(g.k)) ?? String(g.k),
			...totals(g),
		}));
		rows = groupBy === 'day' ? [...rows].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })) : [...rows].sort((a, b) => (b.costMicros ?? 0) - (a.costMicros ?? 0) || b.requests - a.requests);
	}
	const report: IUsageReport = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), groupBy, totals: totals(all), rows };
	return c.json(report);
});

insightsApi.get('/usage/requests', requirePermission({ usage: ['read'] }), async c => {
	const organizationId = c.var.org.id;
	const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)));
	let q = db.selectFrom('gov_usage').leftJoin('user', 'user.id', 'gov_usage.user_id')
		.select(['gov_usage.id', 'gov_usage.created_at', 'gov_usage.user_id', 'user.name as user_name', 'user.email as user_email', 'provider', 'model', 'status', 'reason', 'input_tokens', 'output_tokens', 'cost_micros', 'latency_ms', 'tool_calls', 'dlp_findings', 'client'])
		.where('gov_usage.organization_id', '=', organizationId)
		.orderBy('gov_usage.created_at', 'desc').limit(limit);
	const before = Number(c.req.query('before'));
	if (Number.isFinite(before) && before > 0) {
		q = q.where('gov_usage.created_at', '<', before);
	}
	const status = c.req.query('status');
	if (status === 'ok' || status === 'blocked' || status === 'error') {
		q = q.where('status', '=', status);
	}
	const userId = c.req.query('userId');
	if (userId) {
		q = q.where('gov_usage.user_id', '=', userId);
	}
	const rows = await q.execute();
	const out: IRequestLog[] = rows.map(r => ({
		id: r.id,
		createdAt: iso(r.created_at)!,
		userId: r.user_id,
		userName: r.user_name ?? r.user_email ?? null,
		provider: r.provider,
		model: r.model,
		status: r.status as IRequestLog['status'],
		reason: r.reason,
		inputTokens: Number(r.input_tokens),
		outputTokens: Number(r.output_tokens),
		costMicros: r.cost_micros === null ? null : Number(r.cost_micros),
		latencyMs: r.latency_ms,
		toolCalls: r.tool_calls,
		dlpFindings: r.dlp_findings,
		client: r.client,
	}));
	return c.json(out);
});

/** A logged prompt (when the organization keeps them). Viewing one is itself audited. */
insightsApi.get('/usage/requests/:id/prompt', requirePermission({ usage: ['read'], audit: ['read'] }), async c => {
	const row = await db.selectFrom('gov_prompt_log').selectAll().where('organization_id', '=', c.var.org.id).where('usage_id', '=', c.req.param('id')).executeTakeFirst();
	if (!row) {
		return fail(c, 404, 'No prompt was kept for this request');
	}
	await audit({ ...actor(c), action: 'prompt.view', targetType: 'request', targetId: row.usage_id });
	return c.json({ request: parseJson<unknown>(row.request_json, null), response: row.response_text });
});

insightsApi.get('/activity', requirePermission({ usage: ['read'] }), async c => {
	const { from, to } = range(c.req.query('from'), c.req.query('to'));
	const rows = await db.selectFrom('gov_activity').select(['kind', 'name', sql<number>`sum(count)`.as('total'), sql<number>`count(distinct user_id)`.as('users')])
		.where('organization_id', '=', c.var.org.id).where('created_at', '>=', from).where('created_at', '<', to)
		.groupBy(['kind', 'name']).orderBy(sql`sum(count)`, 'desc').limit(200).execute();
	return c.json(rows.map(r => ({ kind: r.kind, name: r.name, total: Number(r.total), users: Number(r.users) })));
});

//#region Audit

insightsApi.get('/audit', requirePermission({ audit: ['read'] }), async c => {
	const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)));
	let q = db.selectFrom('gov_audit').leftJoin('user', 'user.id', 'gov_audit.actor_id')
		.select(['gov_audit.id', 'gov_audit.created_at', 'actor_id', 'actor_type', 'action', 'target_type', 'target_id', 'detail_json', 'ip', 'user.name as actor_name', 'user.email as actor_email'])
		.where('gov_audit.organization_id', '=', c.var.org.id)
		.orderBy('gov_audit.created_at', 'desc').limit(limit);
	const action = c.req.query('action');
	if (action) {
		q = q.where('action', 'like', `${action.replace(/[%_]/g, '')}%`);
	}
	const actorId = c.req.query('actorId');
	if (actorId) {
		q = q.where('actor_id', '=', actorId);
	}
	const before = Number(c.req.query('before'));
	if (Number.isFinite(before) && before > 0) {
		q = q.where('gov_audit.created_at', '<', before);
	}
	const rows = await q.execute();
	const out: IAuditEvent[] = rows.map(r => ({
		id: r.id,
		createdAt: iso(r.created_at)!,
		actorId: r.actor_id,
		actorName: r.actor_name ?? r.actor_email ?? null,
		actorType: r.actor_type as IAuditEvent['actorType'],
		action: r.action,
		targetType: r.target_type,
		targetId: r.target_id,
		detail: parseJson<Record<string, unknown>>(r.detail_json, {}),
		ip: r.ip,
	}));
	return c.json(out);
});

/** NDJSON export for a SIEM, newest first, up to 100k events. */
insightsApi.get('/audit/export', requirePermission({ audit: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_audit').selectAll().where('organization_id', '=', c.var.org.id).orderBy('created_at', 'desc').limit(100_000).execute();
	await audit({ ...actor(c), action: 'audit.export', detail: { events: rows.length } });
	const body = rows.map(r => JSON.stringify({ id: r.id, time: iso(r.created_at), actor: r.actor_id, actorType: r.actor_type, action: r.action, targetType: r.target_type, targetId: r.target_id, detail: parseJson(r.detail_json, {}), ip: r.ip, userAgent: r.user_agent })).join('\n');
	return c.body(body, 200, { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="volt-govern-audit-${new Date().toISOString().slice(0, 10)}.ndjson"` });
});

//#endregion

//#region Devices

insightsApi.get('/devices', requirePermission({ device: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_device').leftJoin('user', 'user.id', 'gov_device.user_id')
		.select(['gov_device.id', 'gov_device.user_id', 'user.name as user_name', 'user.email as user_email', 'gov_device.name', 'platform', 'app_version', 'gov_device.created_at', 'last_seen_at', 'revoked_at'])
		.where('gov_device.organization_id', '=', c.var.org.id).orderBy('gov_device.created_at', 'desc').limit(2000).execute();
	const out: IDevice[] = rows.map(r => ({
		id: r.id,
		userId: r.user_id,
		userName: r.user_name ?? null,
		userEmail: r.user_email ?? null,
		name: r.name,
		platform: r.platform,
		appVersion: r.app_version,
		createdAt: iso(r.created_at)!,
		lastSeenAt: iso(r.last_seen_at),
		revokedAt: iso(r.revoked_at),
	}));
	return c.json(out);
});

insightsApi.post('/devices/:id/revoke', requirePermission({ device: ['revoke'] }), async c => {
	const ok = await revokeDevice(c.var.org.id, c.req.param('id'), c.var.user.id);
	if (!ok) {
		return fail(c, 404, 'No such active device');
	}
	await audit({ ...actor(c), action: 'device.revoke', targetType: 'device', targetId: c.req.param('id') });
	return c.json({ ok: true });
});

//#endregion
