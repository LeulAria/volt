/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The `db` capability's pure parts: which SQL it runs, and how rows read back to the agent. */

/** A SQLite file's tables and views, without SQLite's own. */
export const SQLITE_TABLES = 'select name from sqlite_schema where type in (\'table\', \'view\') and name not like \'sqlite_%\' order by name';

/** One row per table with its row count. */
export function sqliteCountsQuery(tables: readonly string[]): string {
	return tables.map(table => `select '${table.replace(/'/g, '\'\'')}' as "table", count(*) as rows from "${table.replace(/"/g, '""')}"`).join(' union all ');
}

/**
 * Read-only statements only: the first keyword of every statement (comments stripped) is one that
 * reads. The CLIs enforce it too (`sqlite3 -readonly`, a read-only Postgres transaction); this
 * gives the agent a clear answer before anything runs.
 */
export function isReadOnlySql(sql: string): boolean {
	const statements = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').split(';').map(part => part.trim()).filter(Boolean);
	return statements.length > 0 && statements.every(statement => {
		const keyword = /^\(*\s*([a-z]+)/i.exec(statement)?.[1].toLowerCase();
		if (keyword === 'pragma') {
			// `pragma x = y` sets; `pragma table_info(t)` reads.
			return !/=/.test(statement);
		}
		if (keyword === 'with') {
			return !/\b(?:insert|update|delete|merge)\b/i.test(statement);
		}
		return keyword === 'select' || keyword === 'explain' || keyword === 'show' || keyword === 'values' || keyword === 'table';
	});
}

/** Rows as a tab-separated table with a header, at most `limit` rows, long values cut. */
export function formatQueryRows(rows: readonly Readonly<Record<string, unknown>>[], limit: number): string {
	if (!rows.length) {
		return '0 rows.';
	}
	const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
	const cell = (value: unknown) => {
		const text = value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
		const flat = text.replace(/\s+/g, ' ');
		return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
	};
	const shown = rows.slice(0, limit);
	const lines = [columns.join('\t'), ...shown.map(row => columns.map(column => cell(row[column])).join('\t'))];
	return `${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (first ${shown.length} shown; add limit or narrow the query)` : ''}:\n${lines.join('\n')}`;
}
