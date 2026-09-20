/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isConflict, SharedTaskState } from '../../../common/harness/sharedState.js';

suite('Volt shared task state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the first claim wins and a later writer is queued', () => {
		const shared = new SharedTaskState();
		const first = shared.claim('w1', 'src/Header.tsx');
		assert.ok(!isConflict(first));
		const second = shared.claim('w2', './src/Header.tsx');
		assert.ok(isConflict(second));
		assert.strictEqual(isConflict(second) && second.resolution, 'queue');
		assert.strictEqual(shared.heldBy('src/Header.tsx'), 'w1');
	});

	test('facts and notes survive in the digest', () => {
		const shared = new SharedTaskState();
		shared.remember('w1', 'entry', 'src/Header.tsx', 1);
		shared.note('Explorer finished');
		const digest = shared.digest();
		assert.ok(/src\/Header\.tsx/.test(digest));
		assert.ok(/Explorer finished/.test(digest));
	});
});
