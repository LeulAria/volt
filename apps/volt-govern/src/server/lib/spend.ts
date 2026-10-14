/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sql } from 'kysely';
import type { IEffectivePolicy } from '../../shared/policy.js';
import { formatUsd } from '../../shared/pricing.js';
import { db } from '../db.js';
import { raiseAlert } from './audit.js';

/**
 * Month-to-date spend per budget scope, cached for half a minute and bumped in memory by each
 * request the gateway records, so budgets react between refreshes. Single-instance counters: a
 * horizontally scaled gateway shares them through the database refresh only.
 */
interface ISpend {
	usdMicros: number;
	tokens: number;
	readonly at: number;
}

const spend = new Map<string, ISpend>();

function monthStart(t = new Date()): number {
	return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
}

function monthKey(t = new Date()): string {
	return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function scopeUserIds(organizationId: string, scopeType: string, scopeId: string): Promise<readonly string[] | undefined> {
	if (scopeType === 'org') {
		return undefined;
	}
	if (scopeType === 'user') {
		return [scopeId];
	}
	const rows = await db.selectFrom('teamMember').innerJoin('team', 'team.id', 'teamMember.teamId')
		.select('teamMember.userId').where('team.id', '=', scopeId).where('team.organizationId', '=', organizationId).execute();
	return rows.map(r => r.userId);
}

async function loadSpend(organizationId: string, scopeType: string, scopeId: string): Promise<ISpend> {
	const key = `${organizationId}:${scopeType}:${scopeId}:${monthKey()}`;
	const hit = spend.get(key);
	if (hit && Date.now() - hit.at < 30_000) {
		return hit;
	}
	const users = await scopeUserIds(organizationId, scopeType, scopeId);
	let q = db.selectFrom('gov_usage')
		.select([
			sql<number>`coalesce(sum(cost_micros), 0)`.as('usd'),
			sql<number>`coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)`.as('tokens'),
		])
		.where('organization_id', '=', organizationId)
		.where('created_at', '>=', monthStart());
	if (users) {
		if (!users.length) {
			const empty = { usdMicros: 0, tokens: 0, at: Date.now() };
			spend.set(key, empty);
			return empty;
		}
		q = q.where('user_id', 'in', users);
	}
	const row = await q.executeTakeFirst();
	const value = { usdMicros: Number(row?.usd ?? 0), tokens: Number(row?.tokens ?? 0), at: Date.now() };
	spend.set(key, value);
	return value;
}

export interface IBudgetVerdict {
	readonly blocked: boolean;
	readonly reason?: string;
}

/** Checks every budget layer that applies; raises 80% and 100% alerts once per month each. */
export async function checkBudgets(organizationId: string, policy: IEffectivePolicy): Promise<IBudgetVerdict> {
	for (const layer of policy.budgets) {
		const current = await loadSpend(organizationId, layer.scopeType, layer.scopeId);
		const checks: { readonly used: number; readonly limit: number | undefined; readonly what: string; readonly show: (n: number) => string }[] = [
			{ used: current.usdMicros, limit: layer.budget.monthlyUsd === undefined ? undefined : layer.budget.monthlyUsd * 1_000_000, what: 'spend', show: n => formatUsd(n) },
			{ used: current.tokens, limit: layer.budget.monthlyTokens, what: 'tokens', show: n => `${Math.round(n).toLocaleString('en-US')} tokens` },
		];
		for (const check of checks) {
			if (check.limit === undefined || check.limit <= 0) {
				continue;
			}
			const ratio = check.used / check.limit;
			const month = monthKey();
			if (ratio >= 0.8) {
				const full = ratio >= 1;
				void raiseAlert(organizationId, {
					kind: 'budget',
					severity: full ? 'error' : 'warning',
					dedupeKey: `budget:${layer.scopeType}:${layer.scopeId}:${check.what}:${month}:${full ? 100 : 80}`,
					message: `${layer.label} has used ${Math.round(ratio * 100)}% of its monthly ${check.what} budget (${check.show(check.used)} of ${check.show(check.limit)}).`,
				});
			}
			if (ratio >= 1 && layer.budget.onExceed === 'block') {
				return { blocked: true, reason: `${layer.label} reached its monthly ${check.what} budget` };
			}
		}
	}
	return { blocked: false };
}

/** Adds a recorded request to the in-memory month-to-date counters of the scopes it counts toward. */
export function addSpend(organizationId: string, userId: string, teamIds: readonly string[], usdMicros: number | null, tokens: number): void {
	const month = monthKey();
	const bump = (scopeType: string, scopeId: string) => {
		const entry = spend.get(`${organizationId}:${scopeType}:${scopeId}:${month}`);
		if (entry) {
			entry.usdMicros += usdMicros ?? 0;
			entry.tokens += tokens;
		}
	};
	bump('org', organizationId);
	bump('user', userId);
	teamIds.forEach(id => bump('team', id));
}

//#region Rate limiting

const windows = new Map<string, number[]>();

/** Sliding one-minute window per user. Returns false when the request would exceed the limit. */
export function takeRateSlot(key: string, perMinute: number | undefined): boolean {
	if (!perMinute) {
		return true;
	}
	const t = Date.now();
	const hits = (windows.get(key) ?? []).filter(at => t - at < 60_000);
	if (hits.length >= perMinute) {
		windows.set(key, hits);
		return false;
	}
	hits.push(t);
	windows.set(key, hits);
	return true;
}

//#endregion
