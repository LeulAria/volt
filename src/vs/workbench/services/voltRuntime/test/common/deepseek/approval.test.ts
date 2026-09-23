/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { deepseekKnobs, resolveApproval } from '../../../common/deepseek/approval.js';

suite('DeepSeek approval answerer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('access modes map to sandbox and approval knobs', () => {
		assert.deepStrictEqual(deepseekKnobs('supervised'), { sandbox: 'workspace-write', approval: 'ask' });
		assert.deepStrictEqual(deepseekKnobs('auto-accept-edits'), { sandbox: 'workspace-write', approval: 'ask' });
		assert.deepStrictEqual(deepseekKnobs('auto'), { sandbox: 'danger-full-access', approval: 'never' });
		assert.deepStrictEqual(deepseekKnobs('full-access'), { sandbox: 'danger-full-access', approval: 'never' });
	});

	test('ask, allow once, deny, always allow, and cancel', () => {
		const ask = resolveApproval({ policy: 'ask', effect: 'ask', answererAvailable: true });
		assert.strictEqual(ask.ask, true);
		assert.strictEqual(ask.outcome, undefined);

		assert.deepStrictEqual(resolveApproval({ policy: 'ask', effect: 'allow' }), { ask: false, outcome: 'allowed-once' });
		assert.deepStrictEqual(resolveApproval({ policy: 'ask', effect: 'deny' }), { ask: false, outcome: 'rejected' });
		assert.deepStrictEqual(resolveApproval({ policy: 'ask', effect: 'ask', savedAllow: true }), { ask: false, outcome: 'allowed-once' });
		assert.deepStrictEqual(resolveApproval({ policy: 'ask', effect: 'ask', cancelled: true }), { ask: false, outcome: 'cancelled' });
		assert.deepStrictEqual(resolveApproval({ policy: 'never', effect: 'ask' }), { ask: false, outcome: 'allowed-once' });
		assert.deepStrictEqual(resolveApproval({ policy: 'ask', effect: 'ask', answererAvailable: false }), { ask: false, outcome: 'unavailable' });
	});
});
