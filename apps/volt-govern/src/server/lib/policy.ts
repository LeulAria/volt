/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_ORG_POLICY, type IEffectivePolicy, type IPolicyDocument, type IPolicyLayer, mergePolicy, type ScopeType } from '../../shared/policy.js';
import { db, parseJson } from '../db.js';

export interface IResolvedPolicy {
	readonly layers: readonly IPolicyLayer[];
	readonly policy: IEffectivePolicy;
	readonly teamIds: readonly string[];
	/** MCP server names the organization knows (for recognizing their tools in requests). */
	readonly knownMcpServers: readonly string[];
	/** Per-server blocked tools from the registry. */
	readonly blockedTools: ReadonlyMap<string, readonly string[]>;
}

const TTL_MS = 30_000;
const cache = new Map<string, { readonly at: number; readonly value: Promise<IResolvedPolicy> }>();

/** Drops cached policies for an organization after any policy, team or MCP change. */
export function invalidatePolicies(organizationId: string): void {
	for (const key of cache.keys()) {
		if (key.startsWith(`${organizationId}:`)) {
			cache.delete(key);
		}
	}
}

export async function loadPolicyDocument(organizationId: string, scopeType: ScopeType, scopeId: string): Promise<IPolicyDocument | undefined> {
	const row = await db.selectFrom('gov_policy').select('document_json')
		.where('organization_id', '=', organizationId).where('scope_type', '=', scopeType).where('scope_id', '=', scopeId)
		.executeTakeFirst();
	return row ? parseJson<IPolicyDocument>(row.document_json, {}) : undefined;
}

async function resolve(organizationId: string, userId: string): Promise<IResolvedPolicy> {
	const [org, teams, rows, mcp] = await Promise.all([
		db.selectFrom('organization').select(['name']).where('id', '=', organizationId).executeTakeFirst(),
		db.selectFrom('teamMember').innerJoin('team', 'team.id', 'teamMember.teamId')
			.select(['team.id', 'team.name']).where('team.organizationId', '=', organizationId).where('teamMember.userId', '=', userId).execute(),
		db.selectFrom('gov_policy').select(['scope_type', 'scope_id', 'document_json']).where('organization_id', '=', organizationId).execute(),
		db.selectFrom('gov_mcp_server').select(['name', 'status', 'tools_json']).where('organization_id', '=', organizationId).execute(),
	]);
	const doc = (type: ScopeType, id: string) => {
		const row = rows.find(r => r.scope_type === type && r.scope_id === id);
		return row ? parseJson<IPolicyDocument>(row.document_json, {}) : undefined;
	};

	// The registry is the MCP catalog admins work in: approved servers join the organization's
	// allow list, blocked ones (and blocked tools) its deny list.
	const approved = mcp.filter(s => s.status === 'approved').map(s => s.name);
	const blocked = mcp.filter(s => s.status === 'blocked').map(s => s.name);
	const blockedTools = new Map<string, string[]>();
	for (const server of mcp) {
		const tools = parseJson<{ name: string; blocked: boolean }[]>(server.tools_json, []).filter(t => t.blocked).map(t => t.name);
		if (tools.length) {
			blockedTools.set(server.name, tools);
		}
	}
	const orgDoc = doc('org', organizationId) ?? DEFAULT_ORG_POLICY;
	const orgLayer: IPolicyLayer = {
		scopeType: 'org',
		scopeId: organizationId,
		label: org?.name ?? 'Organization',
		document: {
			...orgDoc,
			mcp: {
				...orgDoc.mcp,
				mode: orgDoc.mcp?.mode ?? 'allowlist',
				allow: [...(orgDoc.mcp?.allow ?? []), ...approved],
				deny: [...(orgDoc.mcp?.deny ?? []), ...blocked, ...[...blockedTools].flatMap(([server, tools]) => tools.map(t => `${server}:${t}`))],
			},
		},
	};
	const layers: IPolicyLayer[] = [orgLayer];
	for (const team of teams) {
		const d = doc('team', team.id);
		if (d) {
			layers.push({ scopeType: 'team', scopeId: team.id, label: `Team ${team.name}`, document: d });
		}
	}
	const userDoc = doc('user', userId);
	if (userDoc) {
		layers.push({ scopeType: 'user', scopeId: userId, label: 'Member override', document: userDoc });
	}
	return {
		layers,
		policy: mergePolicy(layers),
		teamIds: teams.map(t => t.id),
		knownMcpServers: mcp.map(s => s.name),
		blockedTools,
	};
}

export function effectivePolicy(organizationId: string, userId: string): Promise<IResolvedPolicy> {
	const key = `${organizationId}:${userId}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) {
		return hit.value;
	}
	const value = resolve(organizationId, userId);
	cache.set(key, { at: Date.now(), value });
	value.catch(() => cache.delete(key));
	return value;
}
