/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { recordToolBatch } from '../../../common/harness/doomLoop.js';
import { IToolCall } from '../../../common/tools/tool.js';

suite('Volt doom loop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const grep: IToolCall = { id: '1', name: 'grep', args: { pattern: 'foo' } };

	test('three identical batches trip the guard', () => {
		let state = recordToolBatch({ repeats: 0 }, [grep]);
		assert.strictEqual(state.looping, false);
		state = recordToolBatch(state.state, [grep]);
		assert.strictEqual(state.looping, false);
		state = recordToolBatch(state.state, [grep]);
		assert.strictEqual(state.looping, true);
	});

	test('argument order does not reset the counter', () => {
		let state = recordToolBatch({ repeats: 0 }, [{ id: 'a', name: 'read_file', args: { path: 'a.ts', offset: 1 } }]);
		state = recordToolBatch(state.state, [{ id: 'b', name: 'read_file', args: { offset: 1, path: 'a.ts' } }]);
		state = recordToolBatch(state.state, [{ id: 'c', name: 'read_file', args: { path: 'a.ts', offset: 1 } }]);
		assert.strictEqual(state.looping, true);
	});

	test('a different call resets', () => {
		let state = recordToolBatch({ repeats: 0 }, [grep]);
		state = recordToolBatch(state.state, [grep]);
		state = recordToolBatch(state.state, [{ id: '2', name: 'grep', args: { pattern: 'bar' } }]);
		assert.strictEqual(state.looping, false);
		assert.strictEqual(state.state.repeats, 1);
	});
});
