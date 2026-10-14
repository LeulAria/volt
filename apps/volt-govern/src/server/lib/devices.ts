/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { db, now } from '../db.js';

/**
 * A device's state as the gateway sees it, cached briefly so every model request does not hit the
 * database. Revocation clears the cache entry, so it takes effect at once on this instance and
 * within the TTL on others.
 */
export interface IDeviceState {
	readonly id: string;
	readonly organizationId: string;
	readonly userId: string;
	readonly jkt: string;
	readonly revoked: boolean;
}

const TTL_MS = 30_000;
const cache = new Map<string, { readonly at: number; readonly value: IDeviceState | undefined }>();
const lastSeenWrites = new Map<string, number>();

export async function deviceState(deviceId: string): Promise<IDeviceState | undefined> {
	const hit = cache.get(deviceId);
	if (hit && Date.now() - hit.at < TTL_MS) {
		return hit.value;
	}
	const row = await db.selectFrom('gov_device').select(['id', 'organization_id', 'user_id', 'jkt', 'revoked_at']).where('id', '=', deviceId).executeTakeFirst();
	const value = row ? { id: row.id, organizationId: row.organization_id, userId: row.user_id, jkt: row.jkt, revoked: row.revoked_at !== null } : undefined;
	cache.set(deviceId, { at: Date.now(), value });
	return value;
}

/** Records that a device was used, at most once a minute. */
export function touchDevice(deviceId: string): void {
	const t = Date.now();
	if (t - (lastSeenWrites.get(deviceId) ?? 0) < 60_000) {
		return;
	}
	lastSeenWrites.set(deviceId, t);
	void db.updateTable('gov_device').set({ last_seen_at: t }).where('id', '=', deviceId).execute().catch(() => undefined);
}

export async function revokeDevice(organizationId: string, deviceId: string, by: string): Promise<boolean> {
	const result = await db.updateTable('gov_device').set({ revoked_at: now(), revoked_by: by })
		.where('organization_id', '=', organizationId).where('id', '=', deviceId).where('revoked_at', 'is', null)
		.executeTakeFirst();
	cache.delete(deviceId);
	return Number(result.numUpdatedRows) > 0;
}

/** Offboarding: every device the user registered in this organization stops working. */
export async function revokeUserDevices(organizationId: string, userId: string, by: string): Promise<void> {
	const rows = await db.selectFrom('gov_device').select('id').where('organization_id', '=', organizationId).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
	if (!rows.length) {
		return;
	}
	await db.updateTable('gov_device').set({ revoked_at: now(), revoked_by: by })
		.where('organization_id', '=', organizationId).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
	rows.forEach(r => cache.delete(r.id));
}
