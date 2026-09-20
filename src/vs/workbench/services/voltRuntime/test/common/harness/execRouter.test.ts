/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ownsNativeLoop, routeExecution } from '../../../common/harness/execRouter.js';

suite('Volt execution router', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('models stay native; ACP and CLI agents do not', () => {
		const native = routeExecution({ kind: 'model', providerId: 'openai' });
		assert.strictEqual(native.backend, 'native');
		assert.ok(ownsNativeLoop(native));

		assert.strictEqual(routeExecution({ kind: 'agent', providerId: 'cursor-acp' }).backend, 'acp');
		assert.strictEqual(routeExecution({ kind: 'agent', providerId: 'antigravity' }).backend, 'acp');
		assert.strictEqual(routeExecution({ kind: 'agent', providerId: 'kimi' }).backend, 'acp');
		assert.strictEqual(routeExecution({ kind: 'agent', providerId: 'muse' }).backend, 'acp');
		assert.strictEqual(routeExecution({ kind: 'agent', providerId: 'claude-code' }).backend, 'cli');
		assert.ok(!ownsNativeLoop(routeExecution({ kind: 'agent', providerId: 'codex' })));
	});
});
