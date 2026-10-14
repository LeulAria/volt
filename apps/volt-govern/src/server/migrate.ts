/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getMigrations } from 'better-auth/db/migration';
import { authOptions } from './authOptions.js';
import { migrateGovern } from './db.js';

/** Better Auth's tables (users, organizations, SSO, SCIM, device codes), then Volt Govern's. */
export async function migrateAll(): Promise<void> {
	const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(authOptions);
	if (toBeCreated.length || toBeAdded.length) {
		console.info(`[volt-govern] migrating auth schema: ${toBeCreated.length} new tables, ${toBeAdded.length} tables with new columns`);
		await runMigrations();
	}
	await migrateGovern();
}

if (import.meta.url === `file://${process.argv[1]}`) {
	migrateAll().then(() => {
		console.info('[volt-govern] database is up to date');
		process.exit(0);
	}, err => {
		console.error(err);
		process.exit(1);
	});
}
