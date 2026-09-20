/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { detectSignals } from '../../../common/harness/intake.js';
import { assessFile, assessNetwork, redactSecrets, safetyPosture, scanSecrets } from '../../../common/harness/safety.js';

suite('Volt safety boundary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds and redacts secrets without keeping the value', () => {
		const text = 'token=sk-abcDEF1234567890abcd and a jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcabcabcabc';
		const hits = scanSecrets(text);
		assert.ok(hits.length >= 1);
		const redacted = redactSecrets(text);
		assert.ok(!/sk-abcDEF/.test(redacted));
		assert.ok(/\[redacted:/.test(redacted));
	});

	test('credential paths are critical', () => {
		assert.strictEqual(assessFile('.env.local', 'read').risk, 'critical');
		assert.strictEqual(assessFile('src/app.ts', 'read').risk, 'safe');
	});

	test('blocks cloud metadata hosts', () => {
		assert.strictEqual(assessNetwork('http://169.254.169.254/latest/meta-data').risk, 'critical');
		assert.strictEqual(assessNetwork('http://127.0.0.1:3000').risk, 'low');
	});

	test('a destructive request requires approval', () => {
		const text = 'delete the production database';
		const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
		const posture = safetyPosture(detectSignals(text, intent), intent);
		assert.strictEqual(posture.risk, 'critical');
		assert.strictEqual(posture.requireApproval, true);
		assert.strictEqual(posture.sandbox, true);
	});
});
