/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltUsageLimitGroup } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { formatDuration } from '../../browser/usage/agentUsageFormat.js';
import { poolLimits } from '../../browser/usage/agentUsageModel.js';

suite('Volt usage limits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const account = (id: string, session: number | undefined, week: number, resetsAt: number, extra: Partial<IVoltUsageLimitGroup> = {}): IVoltUsageLimitGroup => ({
		provider: 'claude',
		account: { id },
		checkedAt: 100,
		windows: [
			...(session === undefined ? [] : [{ id: 'session', label: 'Current session', usedPercent: session, resetsAt }]),
			{ id: 'week', label: 'Current week', usedPercent: week, resetsAt: resetsAt + 1000 },
		],
		...extra,
	});

	test('accounts pool per provider: windows averaged over the accounts that report them, soonest reset', () => {
		const [pool, codex] = poolLimits([
			account('a', 20, 50, 5000, { resetCredits: 1 }),
			{ provider: 'codex', checkedAt: 1, windows: [] , error: 'signed out' },
			account('b', 60, 10, 3000, { resetCredits: 2, checkedAt: 50 }),
			account('c', undefined, 90, 9000),
		]);
		assert.strictEqual(pool.provider, 'claude');
		assert.strictEqual(pool.accounts.length, 3);
		assert.deepStrictEqual(pool.windows.map(w => [w.id, w.usedPercent, w.accounts, w.resetsAt]), [['session', 40, 2, 3000], ['week', 50, 3, 4000]]);
		assert.strictEqual(pool.resetCredits, 3);
		assert.strictEqual(pool.checkedAt, 50);
		assert.deepStrictEqual([codex.provider, codex.windows.length, codex.accounts[0].error], ['codex', 0, 'signed out']);
	});

	test('reset countdowns never read 60m or 24h', () => {
		const minute = 60_000;
		assert.strictEqual(formatDuration(4 * 60 * minute + 59.6 * minute), '5h');
		assert.strictEqual(formatDuration(59.7 * minute), '1h');
		assert.strictEqual(formatDuration(3 * 24 * 60 * minute + 23.6 * 60 * minute), '4d');
		assert.strictEqual(formatDuration(90 * minute), '1h 30m');
	});
});
