/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatQueryRows, isReadOnlySql, sqliteCountsQuery } from '../../common/ide/databaseQuery.js';
import { ideGatewayDescription, ideOp } from '../../common/ide/ideCapabilities.js';

suite('ide db capability', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('only statements that read pass', () => {
		for (const sql of ['select * from orders', 'SELECT 1; select 2;', 'with t as (select 1) select * from t', 'explain query plan select 1', 'pragma table_info(orders)', '-- top skus\nselect sku from orders', '(select 1) union (select 2)']) {
			assert.strictEqual(isReadOnlySql(sql), true, sql);
		}
		for (const sql of ['delete from orders', 'select 1; drop table orders', 'update orders set qty = 0', 'insert into orders values (1)', 'pragma journal_mode = wal', 'with t as (select 1) delete from orders', 'attach database \'x.db\' as x', '', ';']) {
			assert.strictEqual(isReadOnlySql(sql), false, sql);
		}
	});

	test('rows read back as a table, capped, with long values cut', () => {
		assert.strictEqual(formatQueryRows([], 10), '0 rows.');
		assert.strictEqual(formatQueryRows([{ sku: 'b', revenue: 40 }, { sku: 'a', revenue: null }], 10), '2 rows:\nsku\trevenue\nb\t40\na\tNULL');
		const many = Array.from({ length: 5 }, (_, i) => ({ i }));
		assert.ok(formatQueryRows(many, 2).startsWith('5 rows (first 2 shown; add limit or narrow the query):\ni\n0\n1'));
		assert.ok(formatQueryRows([{ note: 'x'.repeat(300) }], 1).endsWith('…'));
	});

	test('table counts quote names', () => {
		assert.strictEqual(sqliteCountsQuery(['orders', 'o"dd']), 'select \'orders\' as "table", count(*) as rows from "orders" union all select \'o"dd\' as "table", count(*) as rows from "o""dd"');
	});

	test('the gateway lists db, and every op is read-only', () => {
		assert.ok(ideGatewayDescription().includes('db (query SQLite files and Postgres, read-only): tables, schema, query'));
		assert.ok(['tables', 'schema', 'query'].every(op => ideOp('db', op)?.readOnly));
	});
});
