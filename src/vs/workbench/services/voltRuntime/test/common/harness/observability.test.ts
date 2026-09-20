/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Observability } from '../../../common/harness/observability.js';

suite('Volt observability', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('metrics sum tokens and errors', () => {
		const obs = new Observability();
		const span = obs.start('tool', 'read_file', 10);
		obs.end(span.id, false, 'ENOENT', 40, { tokens: { input: 100, output: 20 } });
		obs.record('recovery', 'nudge', true, 'not-found');
		const metrics = obs.metrics();
		assert.strictEqual(metrics.toolCalls, 1);
		assert.strictEqual(metrics.errors, 1);
		assert.strictEqual(metrics.tokensIn, 100);
		assert.strictEqual(metrics.recoveries, 1);
		assert.strictEqual(metrics.latencyMs, 30);
	});

	test('optimizer hints after repeated recovery', () => {
		const obs = new Observability();
		obs.record('recovery', 'switch', true);
		obs.record('recovery', 'escalate', true);
		const hints = obs.optimize();
		assert.ok(hints.some(hint => hint.target === 'model'));
	});
});
