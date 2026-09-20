/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { StateManager } from '../../../common/harness/stateManager.js';

suite('Volt state manager', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('rollback restores the snapshot from the last checkpoint', () => {
		const state = new StateManager();
		const before = state.snapshot('src/a.ts', 'old');
		state.record(1, 'src/a.ts', 'edit', before, state.snapshot('src/a.ts', 'new'));
		const point = state.checkpoint('after first edit', 1);
		state.record(2, 'src/a.ts', 'edit', state.snapshot('src/a.ts', 'new'), state.snapshot('src/a.ts', 'broken'));
		assert.strictEqual(state.canRollback(), true);

		const result = state.rollback(point.id);
		assert.ok(result);
		assert.strictEqual(result.dropped.length, 1);
		assert.strictEqual(result.restored[0]?.content, 'new');
		assert.strictEqual(state.allMutations().length, 1);
	});

	test('aborting a transaction undoes only its mutations', () => {
		const state = new StateManager();
		state.record(1, 'src/keep.ts', 'edit', state.snapshot('src/keep.ts', 'a'), state.snapshot('src/keep.ts', 'b'));
		const tx = state.beginTransaction();
		state.record(2, 'src/drop.ts', 'create', undefined, state.snapshot('src/drop.ts', 'x'));
		const aborted = state.abortTransaction(tx.id);
		assert.ok(aborted);
		assert.deepStrictEqual(state.changedPaths(), ['src/keep.ts']);
	});
});
