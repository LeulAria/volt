/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { countWork, EMPTY_WORK, formatDuration, mapAcpToolKind, runStatusLine, summarizeWork } from '../../../common/harness/workLog.js';

suite('Volt work log summary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('answer only', () => {
		assert.strictEqual(summarizeWork(EMPTY_WORK), 'Answered');
		assert.strictEqual(runStatusLine(EMPTY_WORK, 2000), 'Answered');
		assert.strictEqual(runStatusLine(EMPTY_WORK, 27_000), 'Worked for 27s · Answered');
	});

	test('edits and commands lead', () => {
		const counts = countWork(['read', 'read', 'search', 'edit', 'edit', 'execute'], 3);
		assert.strictEqual(summarizeWork(counts), 'Edited 3 files · ran 1 command');
	});

	test('exploration only', () => {
		assert.strictEqual(summarizeWork(countWork(['read', 'read', 'search'])), 'Explored 2 files · 1 search');
		assert.strictEqual(summarizeWork(countWork(['fetch'])), 'Fetched 1 page');
		assert.strictEqual(summarizeWork(countWork(['search', 'search'])), 'Ran 2 searches');
	});

	test('duration formatting', () => {
		assert.strictEqual(formatDuration(400), '<1s');
		assert.strictEqual(formatDuration(27_400), '27s');
		assert.strictEqual(formatDuration(125_000), '2m 5s');
		assert.strictEqual(formatDuration(3_600_000), '1h 0m');
	});

	test('maps ACP kinds', () => {
		assert.strictEqual(mapAcpToolKind('execute'), 'execute');
		assert.strictEqual(mapAcpToolKind('delete'), 'edit');
		assert.strictEqual(mapAcpToolKind('other'), undefined);
		assert.strictEqual(mapAcpToolKind(undefined), undefined);
	});
});
