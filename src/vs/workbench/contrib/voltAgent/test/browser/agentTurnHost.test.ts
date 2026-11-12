/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { turnWritesGated } from '../../browser/orchestration/agentTurnHost.js';

suite('Volt turn host: checkpoint before a turn', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const claude = { kind: 'agent' as const, providerId: 'claude-code' };

	test('a read-only subagent never waits for the snapshot, whatever the access mode', () => {
		// Under Full access a CLI agent may write before Volt hears of it, so its prompt waits for the
		// snapshot; a research or review subagent changes no files, so it does not.
		assert.strictEqual(turnWritesGated(claude, 'full-access'), false);
		assert.strictEqual(turnWritesGated(claude, 'full-access', true), true);
		assert.strictEqual(turnWritesGated(claude, 'auto', true), true);
		assert.strictEqual(turnWritesGated(undefined, 'full-access', true), true);
	});

	test('otherwise the gate follows the agent and the access mode, as before', () => {
		assert.strictEqual(turnWritesGated(claude, 'supervised'), true, 'Claude asks before it edits');
		assert.strictEqual(turnWritesGated({ kind: 'agent', providerId: 'cursor-acp' }, 'supervised'), false, 'Cursor\'s own mode decides');
		assert.strictEqual(turnWritesGated({ kind: 'model', providerId: 'anthropic' }, 'full-access'), true, 'Volt\'s own loop gates each write');
		assert.strictEqual(turnWritesGated(undefined, 'supervised'), false, 'a model not known yet');
	});
});
