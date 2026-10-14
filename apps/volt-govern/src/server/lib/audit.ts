/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { db, newId, now } from '../db.js';

export interface IAuditInput {
	readonly organizationId: string;
	readonly actorId?: string | null;
	readonly actorType?: 'user' | 'device' | 'scim' | 'system';
	/** `resource.verb`, e.g. `credential.create`, `gateway.blocked`, `mcp.approve`. */
	readonly action: string;
	readonly targetType?: string | null;
	readonly targetId?: string | null;
	/** Never secrets: names, counts, before/after of non-secret fields. */
	readonly detail?: Record<string, unknown>;
	readonly ip?: string | null;
	readonly userAgent?: string | null;
}

/** Appends to the audit log. Never throws: a failed audit write is logged, the action stands. */
export async function audit(input: IAuditInput): Promise<void> {
	try {
		await db.insertInto('gov_audit').values({
			id: newId(),
			organization_id: input.organizationId,
			actor_id: input.actorId ?? null,
			actor_type: input.actorType ?? 'user',
			action: input.action,
			target_type: input.targetType ?? null,
			target_id: input.targetId ?? null,
			detail_json: JSON.stringify(input.detail ?? {}),
			ip: input.ip ?? null,
			user_agent: input.userAgent?.slice(0, 300) ?? null,
			created_at: now(),
		}).execute();
	} catch (err) {
		console.error('[volt-govern] audit write failed', input.action, err);
	}
}

/** Raises an alert once per dedupe key (e.g. `budget:org:<id>:2026-10:80`). */
export async function raiseAlert(organizationId: string, alert: { readonly kind: string; readonly severity: 'info' | 'warning' | 'error'; readonly dedupeKey: string; readonly message: string }): Promise<void> {
	try {
		await db.insertInto('gov_alert').values({
			id: newId(),
			organization_id: organizationId,
			kind: alert.kind,
			severity: alert.severity,
			dedupe_key: alert.dedupeKey,
			message: alert.message,
			created_at: now(),
			acknowledged_at: null,
			acknowledged_by: null,
		}).onConflict(oc => oc.columns(['organization_id', 'dedupe_key']).doNothing()).execute();
	} catch (err) {
		console.error('[volt-govern] alert write failed', alert.dedupeKey, err);
	}
}
