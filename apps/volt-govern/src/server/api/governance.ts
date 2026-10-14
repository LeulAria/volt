/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import type { IEffectivePolicyPreview, IMcpServer, IPolicyRecord, ISkill, ISkillVersion, McpStatus, SkillKind } from '../../shared/api.js';
import { validatePattern } from '../../shared/dlp.js';
import { DEFAULT_ORG_POLICY, type IPolicyDocument, type ScopeType } from '../../shared/policy.js';
import type { AgentCliId } from '../../shared/providers.js';
import { db, type GovMcpServerTable, type GovSkillTable, iso, newId, now, parseJson } from '../db.js';
import { audit } from '../lib/audit.js';
import { actor, type AppEnv, fail, hasPermission, readJson, requireOrg, requirePermission, requireSession } from '../lib/context.js';
import { effectivePolicy, invalidatePolicies } from '../lib/policy.js';

export const governanceApi = new Hono<AppEnv>();
governanceApi.use('*', requireSession, requireOrg);

//#region Policies

const SCOPES: readonly ScopeType[] = ['org', 'team', 'user'];

async function scopeExists(organizationId: string, scopeType: ScopeType, scopeId: string): Promise<boolean> {
	switch (scopeType) {
		case 'org': return scopeId === organizationId;
		case 'team': return !!await db.selectFrom('team').select('id').where('organizationId', '=', organizationId).where('id', '=', scopeId).executeTakeFirst();
		case 'user': return !!await db.selectFrom('member').select('id').where('organizationId', '=', organizationId).where('userId', '=', scopeId).executeTakeFirst();
	}
}

/** Strips unknown keys and validates DLP patterns, so a bad document never reaches the gateway. */
function sanitizeDocument(doc: IPolicyDocument): IPolicyDocument | string {
	const list = (v: unknown) => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, 500) : undefined;
	const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
	const bool = (v: unknown) => typeof v === 'boolean' ? v : undefined;
	for (const p of doc.data?.dlpPatterns ?? []) {
		const error = validatePattern(p.regex);
		if (error) {
			return `DLP pattern "${p.name}": ${error}`;
		}
	}
	return {
		models: doc.models ? { allow: list(doc.models.allow), deny: list(doc.models.deny) } : undefined,
		capabilities: doc.capabilities ? {
			maxAccessPreset: doc.capabilities.maxAccessPreset,
			shell: bool(doc.capabilities.shell),
			webAccess: bool(doc.capabilities.webAccess),
			browser: bool(doc.capabilities.browser),
			agents: list(doc.capabilities.agents) as AgentCliId[] | undefined,
			personalAccounts: bool(doc.capabilities.personalAccounts),
		} : undefined,
		mcp: doc.mcp ? { mode: doc.mcp.mode === 'allowlist' || doc.mcp.mode === 'blocklist' ? doc.mcp.mode : undefined, allow: list(doc.mcp.allow), deny: list(doc.mcp.deny), enforcement: doc.mcp.enforcement === 'block' ? 'block' : doc.mcp.enforcement === 'strip' ? 'strip' : undefined } : undefined,
		skills: doc.skills ? { required: list(doc.skills.required), allowLocal: bool(doc.skills.allowLocal) } : undefined,
		data: doc.data ? {
			redactSecrets: bool(doc.data.redactSecrets),
			dlpPatterns: (doc.data.dlpPatterns ?? []).slice(0, 100).map(p => ({ name: String(p.name).slice(0, 60), regex: String(p.regex).slice(0, 1000), action: p.action === 'block' ? 'block' : 'redact' })),
			blockedPaths: list(doc.data.blockedPaths),
		} : undefined,
		budget: doc.budget ? { monthlyUsd: num(doc.budget.monthlyUsd), monthlyTokens: num(doc.budget.monthlyTokens), onExceed: doc.budget.onExceed === 'block' ? 'block' : 'alert' } : undefined,
		limits: doc.limits ? { requestsPerMinute: num(doc.limits.requestsPerMinute), maxOutputTokens: num(doc.limits.maxOutputTokens) } : undefined,
	};
}

governanceApi.get('/policies', requirePermission({ policy: ['read'] }), async c => {
	const organizationId = c.var.org.id;
	const rows = await db.selectFrom('gov_policy').selectAll().where('organization_id', '=', organizationId).execute();
	const records: IPolicyRecord[] = rows.map(r => ({ scopeType: r.scope_type as ScopeType, scopeId: r.scope_id, document: parseJson<IPolicyDocument>(r.document_json, {}), version: r.version, updatedAt: iso(r.updated_at), updatedBy: r.updated_by }));
	if (!records.some(r => r.scopeType === 'org')) {
		records.unshift({ scopeType: 'org', scopeId: organizationId, document: DEFAULT_ORG_POLICY, version: 0, updatedAt: null, updatedBy: null });
	}
	return c.json(records);
});

governanceApi.put('/policies/:scopeType/:scopeId', requirePermission({ policy: ['update'] }), async c => {
	const organizationId = c.var.org.id;
	const scopeType = c.req.param('scopeType') as ScopeType;
	const scopeId = c.req.param('scopeId');
	if (!SCOPES.includes(scopeType) || !await scopeExists(organizationId, scopeType, scopeId)) {
		return fail(c, 404, 'No such scope');
	}
	const input = await readJson<{ document?: IPolicyDocument; version?: number }>(c);
	if (!input?.document) {
		return fail(c, 400, 'A policy document is required');
	}
	const document = sanitizeDocument(input.document);
	if (typeof document === 'string') {
		return fail(c, 422, document);
	}
	const existing = await db.selectFrom('gov_policy').select(['version', 'document_json']).where('organization_id', '=', organizationId).where('scope_type', '=', scopeType).where('scope_id', '=', scopeId).executeTakeFirst();
	if (existing && input.version !== undefined && input.version !== existing.version) {
		return fail(c, 409, 'Someone else changed this policy. Reload and apply your edit again.', 'version_conflict');
	}
	const version = (existing?.version ?? 0) + 1;
	const json = JSON.stringify(document);
	if (existing) {
		await db.updateTable('gov_policy').set({ document_json: json, version, updated_at: now(), updated_by: c.var.user.id })
			.where('organization_id', '=', organizationId).where('scope_type', '=', scopeType).where('scope_id', '=', scopeId).execute();
	} else {
		await db.insertInto('gov_policy').values({ organization_id: organizationId, scope_type: scopeType, scope_id: scopeId, document_json: json, version, updated_at: now(), updated_by: c.var.user.id }).execute();
	}
	invalidatePolicies(organizationId);
	const before = parseJson<IPolicyDocument>(existing?.document_json, {});
	const sections = (Object.keys({ ...before, ...document }) as (keyof IPolicyDocument)[]).filter(k => JSON.stringify(before[k]) !== JSON.stringify(document[k]));
	await audit({ ...actor(c), action: 'policy.update', targetType: `policy:${scopeType}`, targetId: scopeId, detail: { version, sections } });
	const record: IPolicyRecord = { scopeType, scopeId, document, version, updatedAt: iso(now()), updatedBy: c.var.user.id };
	return c.json(record);
});

governanceApi.delete('/policies/:scopeType/:scopeId', requirePermission({ policy: ['update'] }), async c => {
	const organizationId = c.var.org.id;
	const scopeType = c.req.param('scopeType');
	if (scopeType === 'org') {
		return fail(c, 400, 'The organization policy can be edited but not removed');
	}
	await db.deleteFrom('gov_policy').where('organization_id', '=', organizationId).where('scope_type', '=', scopeType).where('scope_id', '=', c.req.param('scopeId')).execute();
	invalidatePolicies(organizationId);
	await audit({ ...actor(c), action: 'policy.delete', targetType: `policy:${scopeType}`, targetId: c.req.param('scopeId') });
	return c.json({ ok: true });
});

governanceApi.get('/policies/effective/:userId', requirePermission({ policy: ['read'] }), async c => {
	const userId = c.req.param('userId');
	if (!await scopeExists(c.var.org.id, 'user', userId)) {
		return fail(c, 404, 'Not a member');
	}
	const resolved = await effectivePolicy(c.var.org.id, userId);
	const preview: IEffectivePolicyPreview = { userId, layers: resolved.layers.map(l => ({ scopeType: l.scopeType, scopeId: l.scopeId, label: l.label })), policy: resolved.policy };
	return c.json(preview);
});

//#endregion

//#region MCP registry

function toMcp(row: GovMcpServerTable): IMcpServer {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		transport: row.transport === 'http' ? 'http' : 'stdio',
		command: row.command,
		url: row.url,
		status: row.status as McpStatus,
		tools: parseJson<{ name: string; blocked: boolean }[]>(row.tools_json, []),
		requestedBy: row.requested_by,
		requestReason: row.request_reason,
		reviewedBy: row.reviewed_by,
		createdAt: iso(row.created_at)!,
		updatedAt: iso(row.updated_at)!,
	};
}

const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

governanceApi.get('/mcp', requirePermission({ mcp: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_mcp_server').selectAll().where('organization_id', '=', c.var.org.id).orderBy('name').execute();
	return c.json(rows.map(toMcp));
});

governanceApi.post('/mcp', requirePermission({ mcp: ['create'] }), async c => {
	const input = await readJson<Partial<IMcpServer>>(c);
	const name = input?.name?.trim().toLowerCase();
	if (!name || !MCP_NAME.test(name)) {
		return fail(c, 400, 'Name: lowercase letters, digits, - and _ (it is how tools are named: mcp__<name>__<tool>)');
	}
	const status: McpStatus = input?.status === 'approved' && hasPermission(c, { mcp: ['approve'] }) ? 'approved' : input?.status === 'blocked' ? 'blocked' : 'pending';
	const id = newId();
	try {
		await db.insertInto('gov_mcp_server').values({
			id,
			organization_id: c.var.org.id,
			name,
			description: String(input?.description ?? '').slice(0, 500),
			transport: input?.transport === 'http' ? 'http' : 'stdio',
			command: input?.command?.slice(0, 1000) ?? null,
			url: input?.url?.slice(0, 1000) ?? null,
			status,
			tools_json: JSON.stringify((input?.tools ?? []).map(t => ({ name: String(t.name), blocked: !!t.blocked }))),
			requested_by: null,
			request_reason: null,
			reviewed_by: status === 'pending' ? null : c.var.user.id,
			created_at: now(),
			updated_at: now(),
		}).execute();
	} catch {
		return fail(c, 409, `A server named ${name} is already registered`);
	}
	invalidatePolicies(c.var.org.id);
	await audit({ ...actor(c), action: 'mcp.create', targetType: 'mcp', targetId: id, detail: { name, status } });
	return c.json(toMcp(await db.selectFrom('gov_mcp_server').selectAll().where('id', '=', id).executeTakeFirstOrThrow()), 201);
});

governanceApi.patch('/mcp/:id', requirePermission({ mcp: ['update'] }), async c => {
	const organizationId = c.var.org.id;
	const row = await db.selectFrom('gov_mcp_server').selectAll().where('organization_id', '=', organizationId).where('id', '=', c.req.param('id')).executeTakeFirst();
	const input = await readJson<Partial<IMcpServer>>(c);
	if (!row || !input) {
		return fail(c, 404, 'No such server');
	}
	if (input.status && input.status !== row.status && !hasPermission(c, { mcp: ['approve'] })) {
		return fail(c, 403, 'Approving or blocking servers needs the MCP approve permission');
	}
	const changes: Partial<GovMcpServerTable> = { updated_at: now() };
	if (input.description !== undefined) { changes.description = String(input.description).slice(0, 500); }
	if (input.transport !== undefined) { changes.transport = input.transport === 'http' ? 'http' : 'stdio'; }
	if (input.command !== undefined) { changes.command = input.command?.slice(0, 1000) ?? null; }
	if (input.url !== undefined) { changes.url = input.url?.slice(0, 1000) ?? null; }
	if (input.tools !== undefined) { changes.tools_json = JSON.stringify(input.tools.map(t => ({ name: String(t.name), blocked: !!t.blocked })).slice(0, 500)); }
	if (input.status && input.status !== row.status) {
		changes.status = input.status;
		changes.reviewed_by = c.var.user.id;
	}
	await db.updateTable('gov_mcp_server').set(changes).where('organization_id', '=', organizationId).where('id', '=', row.id).execute();
	invalidatePolicies(organizationId);
	const action = changes.status === 'approved' ? 'mcp.approve' : changes.status === 'blocked' ? 'mcp.block' : 'mcp.update';
	await audit({ ...actor(c), action, targetType: 'mcp', targetId: row.id, detail: { name: row.name, from: row.status, to: changes.status ?? row.status } });
	return c.json(toMcp(await db.selectFrom('gov_mcp_server').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow()));
});

governanceApi.delete('/mcp/:id', requirePermission({ mcp: ['delete'] }), async c => {
	const row = await db.selectFrom('gov_mcp_server').select(['id', 'name']).where('organization_id', '=', c.var.org.id).where('id', '=', c.req.param('id')).executeTakeFirst();
	if (!row) {
		return fail(c, 404, 'No such server');
	}
	await db.deleteFrom('gov_mcp_server').where('organization_id', '=', c.var.org.id).where('id', '=', row.id).execute();
	invalidatePolicies(c.var.org.id);
	await audit({ ...actor(c), action: 'mcp.delete', targetType: 'mcp', targetId: row.id, detail: { name: row.name } });
	return c.json({ ok: true });
});

//#endregion

//#region Skills, rules, prompts, agents

function toSkill(row: GovSkillTable): ISkill {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as SkillKind,
		description: row.description,
		content: row.content,
		version: row.version,
		status: row.status as ISkill['status'],
		teams: parseJson<string[]>(row.teams_json, []),
		updatedAt: iso(row.updated_at)!,
		updatedBy: row.updated_by,
	};
}

const KINDS: readonly SkillKind[] = ['skill', 'rule', 'prompt', 'agent'];
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

governanceApi.get('/skills', requirePermission({ skill: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_skill').selectAll().where('organization_id', '=', c.var.org.id).orderBy('name').execute();
	return c.json(rows.map(toSkill));
});

governanceApi.post('/skills', requirePermission({ skill: ['create'] }), async c => {
	const input = await readJson<Partial<ISkill>>(c);
	const name = input?.name?.trim().toLowerCase();
	if (!name || !SKILL_NAME.test(name)) {
		return fail(c, 400, 'Name: lowercase letters, digits, ., - and _');
	}
	const id = newId();
	const content = String(input?.content ?? '');
	try {
		await db.insertInto('gov_skill').values({
			id,
			organization_id: c.var.org.id,
			name,
			kind: KINDS.includes(input?.kind as SkillKind) ? input!.kind! : 'skill',
			description: String(input?.description ?? '').slice(0, 500),
			content: content.slice(0, 200_000),
			version: 1,
			status: 'draft',
			teams_json: JSON.stringify(input?.teams ?? []),
			updated_at: now(),
			updated_by: c.var.user.id,
		}).execute();
	} catch {
		return fail(c, 409, `A skill named ${name} already exists`);
	}
	await db.insertInto('gov_skill_version').values({ skill_id: id, organization_id: c.var.org.id, version: 1, content, created_at: now(), created_by: c.var.user.id }).execute();
	await audit({ ...actor(c), action: 'skill.create', targetType: 'skill', targetId: id, detail: { name } });
	return c.json(toSkill(await db.selectFrom('gov_skill').selectAll().where('id', '=', id).executeTakeFirstOrThrow()), 201);
});

governanceApi.put('/skills/:id', requirePermission({ skill: ['update'] }), async c => {
	const organizationId = c.var.org.id;
	const row = await db.selectFrom('gov_skill').selectAll().where('organization_id', '=', organizationId).where('id', '=', c.req.param('id')).executeTakeFirst();
	const input = await readJson<Partial<ISkill>>(c);
	if (!row || !input) {
		return fail(c, 404, 'No such skill');
	}
	if (input.status && input.status !== row.status && !hasPermission(c, { skill: ['publish'] })) {
		return fail(c, 403, 'Publishing needs the skill publish permission');
	}
	const changes: Partial<GovSkillTable> = { updated_at: now(), updated_by: c.var.user.id };
	if (input.description !== undefined) { changes.description = String(input.description).slice(0, 500); }
	if (input.kind && KINDS.includes(input.kind)) { changes.kind = input.kind; }
	if (input.teams !== undefined) { changes.teams_json = JSON.stringify(input.teams.slice(0, 200)); }
	if (input.status) { changes.status = input.status; }
	if (input.content !== undefined && input.content !== row.content) {
		changes.content = String(input.content).slice(0, 200_000);
		changes.version = row.version + 1;
		await db.insertInto('gov_skill_version').values({ skill_id: row.id, organization_id: organizationId, version: row.version + 1, content: changes.content, created_at: now(), created_by: c.var.user.id }).execute();
	}
	await db.updateTable('gov_skill').set(changes).where('organization_id', '=', organizationId).where('id', '=', row.id).execute();
	invalidatePolicies(organizationId);
	const action = changes.status === 'published' && row.status !== 'published' ? 'skill.publish' : changes.status === 'archived' ? 'skill.archive' : 'skill.update';
	await audit({ ...actor(c), action, targetType: 'skill', targetId: row.id, detail: { name: row.name, version: changes.version ?? row.version } });
	return c.json(toSkill(await db.selectFrom('gov_skill').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow()));
});

governanceApi.get('/skills/:id/versions', requirePermission({ skill: ['read'] }), async c => {
	const rows = await db.selectFrom('gov_skill_version').selectAll().where('organization_id', '=', c.var.org.id).where('skill_id', '=', c.req.param('id')).orderBy('version', 'desc').limit(100).execute();
	const versions: ISkillVersion[] = rows.map(r => ({ version: r.version, content: r.content, createdAt: iso(r.created_at)!, createdBy: r.created_by }));
	return c.json(versions);
});

governanceApi.delete('/skills/:id', requirePermission({ skill: ['delete'] }), async c => {
	const row = await db.selectFrom('gov_skill').select(['id', 'name']).where('organization_id', '=', c.var.org.id).where('id', '=', c.req.param('id')).executeTakeFirst();
	if (!row) {
		return fail(c, 404, 'No such skill');
	}
	await db.deleteFrom('gov_skill_version').where('organization_id', '=', c.var.org.id).where('skill_id', '=', row.id).execute();
	await db.deleteFrom('gov_skill').where('organization_id', '=', c.var.org.id).where('id', '=', row.id).execute();
	invalidatePolicies(c.var.org.id);
	await audit({ ...actor(c), action: 'skill.delete', targetType: 'skill', targetId: row.id, detail: { name: row.name } });
	return c.json({ ok: true });
});

//#endregion
