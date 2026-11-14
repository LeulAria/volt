/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITestProfileService } from '../../../testing/common/testProfileService.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { ITestService } from '../../../testing/common/testService.js';
import { IncrementalTestCollectionItem } from '../../../testing/common/testTypes.js';
import { IdeTests } from '../../browser/ide/ideTests.js';

suite('Volt IDE tests tool: nothing to run', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function ideTests(rootItems: readonly IncrementalTestCollectionItem[]): { tests: IdeTests; runs: () => number } {
		let runs = 0;
		const testService = {
			collection: { all: rootItems, rootItems, getNodeById: () => undefined, expand: async () => undefined },
			syncTests: async () => undefined,
			runTests: async () => { runs++; throw new Error('a test run started'); },
		} as unknown as ITestService;
		const results = { results: [] } as unknown as ITestResultService;
		return { tests: new IdeTests(testService, results, {} as ITestProfileService), runs: () => runs };
	}

	test('a project no controller covers (node --test) has nothing to run: no ask, an answer at once', async () => {
		// The sandbox ask comes after this check: a `tests run` in a sandboxed chat used to wait 60 s
		// on a card (the agent's MCP client then gave up) for a project with no tests to run.
		const { tests, runs } = ideTests([]);
		assert.strictEqual(await tests.wouldRun('chat', undefined, {}), false);
		assert.deepStrictEqual(await tests.run('chat', undefined, {}, undefined, CancellationToken.None), { text: 'No tests in this workspace to run.', isError: true });
		assert.strictEqual(await tests.wouldRun('chat', undefined, { failed: true }), false, 'no earlier run to take failures from');
		assert.strictEqual(runs(), 0);
	});

	test('a workspace with tests would run them, and checking starts no run', async () => {
		const root = { item: { extId: 'ctrl', label: 'ctrl' }, controllerId: 'ctrl', expand: 0, children: new Set() } as unknown as IncrementalTestCollectionItem;
		const { tests, runs } = ideTests([root]);
		assert.strictEqual(await tests.wouldRun('chat', undefined, {}), true);
		assert.strictEqual(runs(), 0);
	});
});
