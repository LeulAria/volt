/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';

try {
	process.loadEnvFile();
} catch {
	// No .env file: the environment alone.
}

function required(name: string, devFallback: () => string): string {
	const value = process.env[name]?.trim();
	if (value) {
		return value;
	}
	if (process.env.NODE_ENV === 'production') {
		throw new Error(`${name} must be set in production (see .env.example)`);
	}
	const generated = devFallback();
	console.warn(`[volt-govern] ${name} is not set; using a random value for this process. Sessions, credentials and SCIM tokens will not survive a restart.`);
	process.env[name] = generated;
	return generated;
}

const masterKey = Buffer.from(required('VOLT_GOVERN_MASTER_KEY', () => randomBytes(32).toString('base64')), 'base64');
if (masterKey.length !== 32) {
	throw new Error('VOLT_GOVERN_MASTER_KEY must be 32 bytes, base64 encoded');
}

const port = Number(process.env.PORT ?? 4318);
const baseUrl = (process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

export const env = {
	port,
	baseUrl,
	authSecret: required('BETTER_AUTH_SECRET', () => randomBytes(32).toString('base64')),
	scimSecret: required('VOLT_GOVERN_SCIM_SECRET', () => randomBytes(32).toString('base64')),
	masterKey,
	databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
	sqlitePath: process.env.SQLITE_PATH?.trim() || 'volt-govern.db',
	trustedOrigins: (process.env.TRUSTED_ORIGINS ?? 'http://localhost:5179').split(',').map(s => s.trim()).filter(Boolean),
	production: process.env.NODE_ENV === 'production',
} as const;
