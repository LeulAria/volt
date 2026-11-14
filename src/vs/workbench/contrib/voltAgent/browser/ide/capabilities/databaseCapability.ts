/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { formatQueryRows, isReadOnlySql, SQLITE_TABLES, sqliteCountsQuery } from '../../../../../services/voltRuntime/common/ide/databaseQuery.js';
import { cliText, display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, str } from './capability.js';

const SQLITE_FILE = /\.(?:db|sqlite3?|db3)$/i;
const MAX_ROWS = 200;

/**
 * Databases through their own CLIs: SQLite files with `sqlite3 -readonly`, Postgres with `psql` in
 * a read-only transaction. Agents queried the fixture's SQLite file with nine `sqlite3` shell calls
 * (round 1, T4); this answers "what tables, what columns, what rows" in one call each, read-only,
 * in the chat's sandbox like any other CLI capability.
 */
export class DatabaseCapability implements IIdeCapability {

	readonly id = 'db';

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const url = str(args, 'url');
		const postgres = !!url && /^postgres(?:ql)?:\/\//i.test(url);
		const file = postgres ? undefined : resolvePath(ctx.root, str(args, 'path') ?? str(args, 'file') ?? url);
		if (!postgres && !file) {
			return this.candidates(ctx);
		}
		const limit = Math.max(1, Math.min(num(args, 'limit') ?? MAX_ROWS, 2_000));
		switch (op) {
			case 'tables': {
				if (postgres) {
					return this.psql(ctx, url!, 'select schemaname || \'.\' || relname as "table", n_live_tup as rows from pg_stat_user_tables order by 1', limit);
				}
				// Names first, then one count per table (SQLite has no dynamic SQL).
				const names = await ctx.cli.run('sqlite3', ['-readonly', '-json', file!.fsPath, SQLITE_TABLES], { timeoutMs: 30_000 });
				if (names.code !== 0 || names.missing) {
					return cliText(names, 'sqlite3');
				}
				const tables = parseJsonRows(names.stdout).map(row => String(row.name ?? '')).filter(Boolean);
				return tables.length ? this.sqlite(ctx, file!, sqliteCountsQuery(tables), limit) : ok(`${display(ctx.root, file!)}: no tables.`);
			}
			case 'schema': {
				const table = str(args, 'table');
				if (table && !/^[\w.]+$/.test(table)) {
					return fail('table must be a plain table name.');
				}
				if (postgres) {
					const [schema, name] = table?.includes('.') ? table.split('.') : ['public', table];
					return this.psql(ctx, url!, `select table_name as "table", column_name as "column", data_type as "type", is_nullable as "null", column_default as "default" from information_schema.columns where table_schema = '${schema}'${name ? ` and table_name = '${name}'` : ''} order by table_name, ordinal_position`, 2_000);
				}
				return this.sqlite(ctx, file!, table ? `select '${table}' as "table", name as "column", type, case "notnull" when 1 then 'NO' else 'YES' end as "null", dflt_value as "default", pk from pragma_table_info('${table}')` : 'select name as "table", sql from sqlite_schema where type in (\'table\', \'view\') and name not like \'sqlite_%\' order by name', 2_000);
			}
			case 'query': {
				const sql = str(args, 'sql') ?? str(args, 'query');
				if (!sql) {
					return fail('query needs sql.');
				}
				if (!isReadOnlySql(sql)) {
					return fail('query runs read-only SQL (select, with, explain, pragma, show). To change data, run the statement with your shell so the user sees it as a command.');
				}
				return postgres ? this.psql(ctx, url!, sql, limit) : this.sqlite(ctx, file!, sql, limit);
			}
		}
		return fail(`Unknown db op ${op}. Use tables, schema or query.`);
	}

	private async sqlite(ctx: IIdeCapabilityContext, file: URI, sql: string, limit: number): Promise<IIdeCapabilityResult> {
		const result = await ctx.cli.run('sqlite3', ['-readonly', '-json', file.fsPath, sql], { timeoutMs: 30_000 });
		if (result.code !== 0 || result.missing) {
			return cliText(result, 'sqlite3');
		}
		return ok(`${display(ctx.root, file)}: ${formatQueryRows(parseJsonRows(result.stdout), limit)}`);
	}

	private async psql(ctx: IIdeCapabilityContext, url: string, sql: string, limit: number): Promise<IIdeCapabilityResult> {
		// One read-only transaction: a statement that writes fails instead of committing. The rows come back as one JSON array.
		const rows = `select coalesce(json_agg(r), '[]') from (${sql.trim().replace(/;\s*$/, '')}) r`;
		const result = await ctx.cli.run('psql', [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', 'begin transaction read only', '-c', rows, '-c', 'rollback'], { timeoutMs: 30_000 });
		if (result.code !== 0 || result.missing) {
			return cliText(result, 'psql');
		}
		return ok(formatQueryRows(parseJsonRows(result.stdout), limit));
	}

	/** No path or url: the database files in the folder, so the next call can name one. */
	private async candidates(ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		if (!ctx.root) {
			return fail('Pass path (a SQLite file) or url (postgres://...).');
		}
		const found = await ctx.cli.run('find', [ctx.root.fsPath, '-maxdepth', '3', '-type', 'f', '(', '-name', '*.db', '-o', '-name', '*.sqlite', '-o', '-name', '*.sqlite3', '-o', '-name', '*.db3', ')', '-not', '-path', '*/node_modules/*'], { timeoutMs: 10_000 });
		const files = found.stdout.split('\n').map(line => line.trim()).filter(line => SQLITE_FILE.test(line)).map(line => display(ctx.root, URI.file(line)));
		return fail(files.length ? `Pass path (a SQLite file) or url (postgres://...). SQLite files here: ${files.slice(0, 20).join(', ')}` : 'Pass path (a SQLite file) or url (postgres://...). No SQLite files found in this folder.');
	}
}

function parseJsonRows(text: string): Record<string, unknown>[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];
	} catch {
		return [];
	}
}
