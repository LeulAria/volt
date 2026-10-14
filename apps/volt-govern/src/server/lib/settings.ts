/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IOrgSettings } from '../../shared/api.js';
import { db, now, parseJson } from '../db.js';

export const DEFAULT_SETTINGS: IOrgSettings = {
	promptLogging: 'metadata',
	retentionDays: { usage: 400, audit: 400, prompts: 30 },
	requireDeviceBinding: true,
	tokenTtlMinutes: 15,
	prices: [],
	allowedEmailDomains: [],
};

const cache = new Map<string, { readonly at: number; readonly value: IOrgSettings }>();

export async function getSettings(organizationId: string): Promise<IOrgSettings> {
	const hit = cache.get(organizationId);
	if (hit && Date.now() - hit.at < 15_000) {
		return hit.value;
	}
	const row = await db.selectFrom('gov_settings').select('settings_json').where('organization_id', '=', organizationId).executeTakeFirst();
	const stored = parseJson<Partial<IOrgSettings>>(row?.settings_json, {});
	const value: IOrgSettings = {
		...DEFAULT_SETTINGS,
		...stored,
		retentionDays: { ...DEFAULT_SETTINGS.retentionDays, ...stored.retentionDays },
	};
	cache.set(organizationId, { at: Date.now(), value });
	return value;
}

export async function putSettings(organizationId: string, settings: IOrgSettings, userId: string): Promise<void> {
	const json = JSON.stringify(settings);
	await db.insertInto('gov_settings')
		.values({ organization_id: organizationId, settings_json: json, updated_at: now(), updated_by: userId })
		.onConflict(oc => oc.column('organization_id').doUpdateSet({ settings_json: json, updated_at: now(), updated_by: userId }))
		.execute();
	cache.delete(organizationId);
}

/** Validates and clamps settings from the console. */
export function sanitizeSettings(input: Partial<IOrgSettings>): IOrgSettings {
	const clamp = (n: unknown, lo: number, hi: number, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
	const logging = input.promptLogging;
	return {
		promptLogging: logging === 'off' || logging === 'metadata' || logging === 'redacted' || logging === 'full' ? logging : DEFAULT_SETTINGS.promptLogging,
		retentionDays: {
			usage: clamp(input.retentionDays?.usage, 1, 3650, DEFAULT_SETTINGS.retentionDays.usage),
			audit: clamp(input.retentionDays?.audit, 30, 3650, DEFAULT_SETTINGS.retentionDays.audit),
			prompts: clamp(input.retentionDays?.prompts, 1, 3650, DEFAULT_SETTINGS.retentionDays.prompts),
		},
		requireDeviceBinding: input.requireDeviceBinding !== false,
		tokenTtlMinutes: clamp(input.tokenTtlMinutes, 5, 60, DEFAULT_SETTINGS.tokenTtlMinutes),
		prices: (input.prices ?? []).filter(p => p && typeof p.match === 'string' && p.match && Number.isFinite(p.input) && Number.isFinite(p.output)).slice(0, 200),
		allowedEmailDomains: (input.allowedEmailDomains ?? []).map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean).slice(0, 100),
	};
}
