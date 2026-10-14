/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { NodeSqliteDialect } from '@better-auth/kysely-adapter/node-sqlite-dialect';
import { type Generated, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { env } from './env.js';

/**
 * One database for Better Auth's tables (user, session, organization, member, team, ssoProvider,
 * SCIM, deviceCode: camelCase, owned by Better Auth's migrations) and Volt Govern's own
 * (`gov_*`, snake_case, created below). Postgres in production; a SQLite file in development.
 *
 * Every `gov_*` row carries `organization_id`, and every query in the repositories takes the
 * organization first: tenant isolation is structural, not a filter someone can forget.
 * Timestamps are epoch milliseconds; booleans are 0/1; JSON is text. That keeps the SQL portable.
 */

export interface GovCredentialTable {
	id: string;
	organization_id: string;
	provider: string;
	label: string;
	base_url: string;
	auth_kind: string;
	auth_header: string;
	/** AES-256-GCM under the organization's derived key. */
	secret_enc: string;
	oauth_json: string | null;
	hint: string;
	status: string;
	models_json: string;
	created_at: number;
	created_by: string;
	rotated_at: number | null;
	last_used_at: number | null;
}

export interface GovPolicyTable {
	organization_id: string;
	scope_type: string;
	scope_id: string;
	document_json: string;
	version: number;
	updated_at: number;
	updated_by: string;
}

export interface GovMcpServerTable {
	id: string;
	organization_id: string;
	name: string;
	description: string;
	transport: string;
	command: string | null;
	url: string | null;
	status: string;
	tools_json: string;
	requested_by: string | null;
	request_reason: string | null;
	reviewed_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface GovSkillTable {
	id: string;
	organization_id: string;
	name: string;
	kind: string;
	description: string;
	content: string;
	version: number;
	status: string;
	teams_json: string;
	updated_at: number;
	updated_by: string;
}

export interface GovSkillVersionTable {
	skill_id: string;
	organization_id: string;
	version: number;
	content: string;
	created_at: number;
	created_by: string;
}

export interface GovDeviceTable {
	id: string;
	organization_id: string;
	user_id: string;
	name: string;
	platform: string;
	app_version: string;
	public_jwk: string;
	jkt: string;
	created_at: number;
	last_seen_at: number | null;
	revoked_at: number | null;
	revoked_by: string | null;
}

export interface GovUsageTable {
	id: string;
	organization_id: string;
	user_id: string;
	device_id: string | null;
	credential_id: string | null;
	provider: string;
	model: string;
	endpoint: string;
	status: string;
	reason: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_micros: number | null;
	latency_ms: number;
	tool_calls: number;
	dlp_findings: number;
	stripped_tools: number;
	client: string | null;
	created_at: number;
}

export interface GovPromptLogTable {
	usage_id: string;
	organization_id: string;
	request_json: string;
	response_text: string;
	created_at: number;
}

export interface GovAuditTable {
	id: string;
	organization_id: string;
	actor_id: string | null;
	actor_type: string;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail_json: string;
	ip: string | null;
	user_agent: string | null;
	created_at: number;
}

export interface GovActivityTable {
	id: string;
	organization_id: string;
	user_id: string;
	device_id: string | null;
	kind: string;
	name: string;
	count: number;
	detail_json: string;
	created_at: number;
}

export interface GovSettingsTable {
	organization_id: string;
	settings_json: string;
	updated_at: number;
	updated_by: string | null;
}

export interface GovAlertTable {
	id: string;
	organization_id: string;
	kind: string;
	severity: string;
	dedupe_key: string;
	message: string;
	created_at: number;
	acknowledged_at: number | null;
	acknowledged_by: string | null;
}

export interface GovServerKeyTable {
	kid: string;
	public_jwk: string;
	private_enc: string;
	created_at: number;
	retired_at: number | null;
}

/** The Better Auth tables Volt Govern reads directly (Better Auth's column names). */
export interface AuthUserTable {
	id: string;
	name: string;
	email: string;
	image: string | null;
	createdAt: unknown;
}
export interface AuthMemberTable {
	id: string;
	organizationId: string;
	userId: string;
	role: string;
	createdAt: unknown;
}
export interface AuthOrganizationTable {
	id: string;
	name: string;
	slug: string;
	createdAt: unknown;
}
export interface AuthTeamTable {
	id: string;
	name: string;
	organizationId: string;
}
export interface AuthTeamMemberTable {
	id: string;
	teamId: string;
	userId: string;
}
export interface AuthSessionTable {
	id: string;
	userId: string;
	token: string;
	expiresAt: unknown;
}
export interface AuthSsoProviderTable {
	id: string;
	providerId: string;
	organizationId: string | null;
	domain: string;
	domainVerified: Generated<unknown>;
}

export interface Database {
	gov_credential: GovCredentialTable;
	gov_policy: GovPolicyTable;
	gov_mcp_server: GovMcpServerTable;
	gov_skill: GovSkillTable;
	gov_skill_version: GovSkillVersionTable;
	gov_device: GovDeviceTable;
	gov_usage: GovUsageTable;
	gov_prompt_log: GovPromptLogTable;
	gov_audit: GovAuditTable;
	gov_activity: GovActivityTable;
	gov_settings: GovSettingsTable;
	gov_alert: GovAlertTable;
	gov_server_key: GovServerKeyTable;
	user: AuthUserTable;
	member: AuthMemberTable;
	organization: AuthOrganizationTable;
	team: AuthTeamTable;
	teamMember: AuthTeamMemberTable;
	session: AuthSessionTable;
	ssoProvider: AuthSsoProviderTable;
}

export const dbType: 'postgres' | 'sqlite' = env.databaseUrl ? 'postgres' : 'sqlite';

function createDialect() {
	if (env.databaseUrl) {
		// int8 (counts, epoch ms, micro-dollars) as numbers: every value here fits in 2^53.
		pg.types.setTypeParser(20, value => Number(value));
		return new PostgresDialect({ pool: new pg.Pool({ connectionString: env.databaseUrl, max: 20 }) });
	}
	const database = new DatabaseSync(env.sqlitePath);
	database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	return new NodeSqliteDialect({ database });
}

export const db = new Kysely<Database>({ dialect: createDialect() });

/** Creates Volt Govern's tables and indexes when missing. Idempotent. */
export async function migrateGovern(): Promise<void> {
	const t = (name: keyof Database) => db.schema.createTable(name).ifNotExists();
	const big = dbType === 'postgres' ? 'bigint' : 'integer';

	await t('gov_credential')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('provider', 'text', c => c.notNull())
		.addColumn('label', 'text', c => c.notNull())
		.addColumn('base_url', 'text', c => c.notNull())
		.addColumn('auth_kind', 'text', c => c.notNull())
		.addColumn('auth_header', 'text', c => c.notNull())
		.addColumn('secret_enc', 'text', c => c.notNull())
		.addColumn('oauth_json', 'text')
		.addColumn('hint', 'text', c => c.notNull())
		.addColumn('status', 'text', c => c.notNull())
		.addColumn('models_json', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.addColumn('created_by', 'text', c => c.notNull())
		.addColumn('rotated_at', big)
		.addColumn('last_used_at', big)
		.execute();

	await t('gov_policy')
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('scope_type', 'text', c => c.notNull())
		.addColumn('scope_id', 'text', c => c.notNull())
		.addColumn('document_json', 'text', c => c.notNull())
		.addColumn('version', 'integer', c => c.notNull())
		.addColumn('updated_at', big, c => c.notNull())
		.addColumn('updated_by', 'text', c => c.notNull())
		.addPrimaryKeyConstraint('gov_policy_pk', ['organization_id', 'scope_type', 'scope_id'])
		.execute();

	await t('gov_mcp_server')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('name', 'text', c => c.notNull())
		.addColumn('description', 'text', c => c.notNull())
		.addColumn('transport', 'text', c => c.notNull())
		.addColumn('command', 'text')
		.addColumn('url', 'text')
		.addColumn('status', 'text', c => c.notNull())
		.addColumn('tools_json', 'text', c => c.notNull())
		.addColumn('requested_by', 'text')
		.addColumn('request_reason', 'text')
		.addColumn('reviewed_by', 'text')
		.addColumn('created_at', big, c => c.notNull())
		.addColumn('updated_at', big, c => c.notNull())
		.addUniqueConstraint('gov_mcp_server_name', ['organization_id', 'name'])
		.execute();

	await t('gov_skill')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('name', 'text', c => c.notNull())
		.addColumn('kind', 'text', c => c.notNull())
		.addColumn('description', 'text', c => c.notNull())
		.addColumn('content', 'text', c => c.notNull())
		.addColumn('version', 'integer', c => c.notNull())
		.addColumn('status', 'text', c => c.notNull())
		.addColumn('teams_json', 'text', c => c.notNull())
		.addColumn('updated_at', big, c => c.notNull())
		.addColumn('updated_by', 'text', c => c.notNull())
		.addUniqueConstraint('gov_skill_name', ['organization_id', 'name'])
		.execute();

	await t('gov_skill_version')
		.addColumn('skill_id', 'text', c => c.notNull())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('version', 'integer', c => c.notNull())
		.addColumn('content', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.addColumn('created_by', 'text', c => c.notNull())
		.addPrimaryKeyConstraint('gov_skill_version_pk', ['skill_id', 'version'])
		.execute();

	await t('gov_device')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('user_id', 'text', c => c.notNull())
		.addColumn('name', 'text', c => c.notNull())
		.addColumn('platform', 'text', c => c.notNull())
		.addColumn('app_version', 'text', c => c.notNull())
		.addColumn('public_jwk', 'text', c => c.notNull())
		.addColumn('jkt', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.addColumn('last_seen_at', big)
		.addColumn('revoked_at', big)
		.addColumn('revoked_by', 'text')
		.execute();

	await t('gov_usage')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('user_id', 'text', c => c.notNull())
		.addColumn('device_id', 'text')
		.addColumn('credential_id', 'text')
		.addColumn('provider', 'text', c => c.notNull())
		.addColumn('model', 'text', c => c.notNull())
		.addColumn('endpoint', 'text', c => c.notNull())
		.addColumn('status', 'text', c => c.notNull())
		.addColumn('reason', 'text')
		.addColumn('input_tokens', big, c => c.notNull())
		.addColumn('output_tokens', big, c => c.notNull())
		.addColumn('cache_read_tokens', big, c => c.notNull())
		.addColumn('cache_write_tokens', big, c => c.notNull())
		.addColumn('cost_micros', big)
		.addColumn('latency_ms', 'integer', c => c.notNull())
		.addColumn('tool_calls', 'integer', c => c.notNull())
		.addColumn('dlp_findings', 'integer', c => c.notNull())
		.addColumn('stripped_tools', 'integer', c => c.notNull())
		.addColumn('client', 'text')
		.addColumn('created_at', big, c => c.notNull())
		.execute();

	await t('gov_prompt_log')
		.addColumn('usage_id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('request_json', 'text', c => c.notNull())
		.addColumn('response_text', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.execute();

	await t('gov_audit')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('actor_id', 'text')
		.addColumn('actor_type', 'text', c => c.notNull())
		.addColumn('action', 'text', c => c.notNull())
		.addColumn('target_type', 'text')
		.addColumn('target_id', 'text')
		.addColumn('detail_json', 'text', c => c.notNull())
		.addColumn('ip', 'text')
		.addColumn('user_agent', 'text')
		.addColumn('created_at', big, c => c.notNull())
		.execute();

	await t('gov_activity')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('user_id', 'text', c => c.notNull())
		.addColumn('device_id', 'text')
		.addColumn('kind', 'text', c => c.notNull())
		.addColumn('name', 'text', c => c.notNull())
		.addColumn('count', 'integer', c => c.notNull())
		.addColumn('detail_json', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.execute();

	await t('gov_settings')
		.addColumn('organization_id', 'text', c => c.primaryKey())
		.addColumn('settings_json', 'text', c => c.notNull())
		.addColumn('updated_at', big, c => c.notNull())
		.addColumn('updated_by', 'text')
		.execute();

	await t('gov_alert')
		.addColumn('id', 'text', c => c.primaryKey())
		.addColumn('organization_id', 'text', c => c.notNull())
		.addColumn('kind', 'text', c => c.notNull())
		.addColumn('severity', 'text', c => c.notNull())
		.addColumn('dedupe_key', 'text', c => c.notNull())
		.addColumn('message', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.addColumn('acknowledged_at', big)
		.addColumn('acknowledged_by', 'text')
		.addUniqueConstraint('gov_alert_dedupe', ['organization_id', 'dedupe_key'])
		.execute();

	await t('gov_server_key')
		.addColumn('kid', 'text', c => c.primaryKey())
		.addColumn('public_jwk', 'text', c => c.notNull())
		.addColumn('private_enc', 'text', c => c.notNull())
		.addColumn('created_at', big, c => c.notNull())
		.addColumn('retired_at', big)
		.execute();

	const index = (name: string, table: keyof Database, columns: string[]) =>
		db.schema.createIndex(name).ifNotExists().on(table).columns(columns).execute();
	await index('gov_credential_org', 'gov_credential', ['organization_id']);
	await index('gov_mcp_org', 'gov_mcp_server', ['organization_id']);
	await index('gov_skill_org', 'gov_skill', ['organization_id']);
	await index('gov_device_org_user', 'gov_device', ['organization_id', 'user_id']);
	await index('gov_device_jkt', 'gov_device', ['jkt']);
	await index('gov_usage_org_time', 'gov_usage', ['organization_id', 'created_at']);
	await index('gov_usage_org_user_time', 'gov_usage', ['organization_id', 'user_id', 'created_at']);
	await index('gov_audit_org_time', 'gov_audit', ['organization_id', 'created_at']);
	await index('gov_activity_org_time', 'gov_activity', ['organization_id', 'created_at']);
	await index('gov_prompt_org_time', 'gov_prompt_log', ['organization_id', 'created_at']);
}

export const now = (): number => Date.now();
export const newId = (): string => crypto.randomUUID();

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
	if (!text) {
		return fallback;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

export function iso(ms: number | null | undefined): string | null {
	return ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString();
}

/** Integer day bucket (UTC) from an epoch-ms column, the same in SQLite and Postgres. */
export const dayBucket = sql<number>`(created_at / 86400000)`;
