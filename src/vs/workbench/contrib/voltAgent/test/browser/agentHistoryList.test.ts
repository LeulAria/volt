/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { groupSessionsByDate, isDetailedHistoryGroup } from '../../browser/history/agentHistoryGroups.js';

function session(id: string, updatedAt: number, extra: Partial<IAgentSessionMeta> = {}): IAgentSessionMeta {
	return {
		id, title: id, createdAt: updatedAt, updatedAt, workspaceId: 'w', workspaceLabel: 'w',
		turnCount: 1, preview: id, status: 'done', ...extra,
	};
}

suite('Agent history list grouping', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DAY = 24 * 60 * 60 * 1000;
	// A fixed "now" at 15:00 local time so day boundaries are unambiguous.
	const now = new Date(2026, 8, 13, 15, 0, 0).getTime();

	test('buckets by day, week, month and older months in order', () => {
		const groups = groupSessionsByDate([
			session('today', now - 60_000),
			session('yesterday', now - DAY),
			session('week', now - 4 * DAY),
			session('month', now - 20 * DAY),
			session('older', now - 90 * DAY),
			session('oldest', now - 400 * DAY),
		], now);
		assert.deepStrictEqual(groups.map(group => group.key), ['today', 'yesterday', 'week', 'month', 'm-2026-5', 'm-2025-7']);
		assert.deepStrictEqual(groups.map(group => group.sessions.map(s => s.id)), [['today'], ['yesterday'], ['week'], ['month'], ['older'], ['oldest']]);
	});

	test('pinned sessions come first regardless of age', () => {
		const groups = groupSessionsByDate([
			session('today', now - 60_000),
			session('old-pinned', now - 90 * DAY, { pinned: true }),
		], now);
		assert.deepStrictEqual(groups.map(group => group.key), ['pinned', 'today']);
		assert.strictEqual(groups[0].sessions[0].id, 'old-pinned');
	});

	test('keeps input order inside a bucket and skips empty buckets', () => {
		const groups = groupSessionsByDate([
			session('a', now - 1000),
			session('b', now - 2000),
			session('c', now - 3 * DAY),
		], now);
		assert.deepStrictEqual(groups.map(group => group.key), ['today', 'week']);
		assert.deepStrictEqual(groups[0].sessions.map(s => s.id), ['a', 'b']);
	});

	test('falls back to createdAt when there is no activity yet', () => {
		const groups = groupSessionsByDate([{ ...session('draft', 0), createdAt: now - DAY, updatedAt: 0 }], now);
		assert.deepStrictEqual(groups.map(group => group.key), ['yesterday']);
	});

	test('pinned and today are detailed; older buckets are single-line', () => {
		assert.strictEqual(isDetailedHistoryGroup('pinned'), true);
		assert.strictEqual(isDetailedHistoryGroup('today'), true);
		assert.strictEqual(isDetailedHistoryGroup('yesterday'), false);
		assert.strictEqual(isDetailedHistoryGroup('week'), false);
	});
});
