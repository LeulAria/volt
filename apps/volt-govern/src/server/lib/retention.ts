/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { db } from '../db.js';
import { getSettings } from './settings.js';

const DAY = 86_400_000;

/** Deletes usage, activity, prompts and audit events older than each organization keeps them. */
export async function sweepRetention(): Promise<void> {
	const orgs = await db.selectFrom('organization').select('id').execute();
	for (const { id } of orgs) {
		const { retentionDays } = await getSettings(id);
		const t = Date.now();
		await db.deleteFrom('gov_usage').where('organization_id', '=', id).where('created_at', '<', t - retentionDays.usage * DAY).execute();
		await db.deleteFrom('gov_activity').where('organization_id', '=', id).where('created_at', '<', t - retentionDays.usage * DAY).execute();
		await db.deleteFrom('gov_prompt_log').where('organization_id', '=', id).where('created_at', '<', t - retentionDays.prompts * DAY).execute();
		await db.deleteFrom('gov_audit').where('organization_id', '=', id).where('created_at', '<', t - retentionDays.audit * DAY).execute();
	}
}

export function startRetention(): void {
	const run = () => sweepRetention().catch(err => console.error('[volt-govern] retention sweep failed', err));
	setTimeout(run, 60_000).unref();
	setInterval(run, 60 * 60_000).unref();
}
