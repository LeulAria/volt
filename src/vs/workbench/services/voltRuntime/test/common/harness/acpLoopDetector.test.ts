/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AcpLoopDetector } from '../../../common/harness/acpLoopDetector.js';
import { ISupervisedCall, RunSupervisor } from '../../../common/harness/supervisor.js';

function call(key: string, outcome: string, failed = false, target?: string): ISupervisedCall {
	return { tool: 'execute', key: `execute\0${key}`, ...(target ? { target } : {}), failed, outcome, label: key, ...(failed ? { error: outcome, errorKey: outcome } : {}) };
}

suite('ACP loop detector', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the supervisor\'s own repeat-error signal', () => {
		const detector = new AcpLoopDetector();
		const signals = [1, 2, 3].map(() => detector.record(call('npm test', 'Error: boom', true)));
		assert.strictEqual(signals[2]?.kind, 'repeat-error');
	});

	test('adds near-duplicate calls (same call modulo numbers, same result) as a repeat', () => {
		const detector = new AcpLoopDetector();
		const signals = [1, 2, 3, 4].map(i => detector.record(call(`curl localhost:300${i}/health`, 'connection refused')));
		assert.strictEqual(signals.slice(0, 3).some(Boolean), false);
		assert.strictEqual(signals[3]?.kind, 'repeat');
		assert.ok(signals[3]?.subject.startsWith('near-repeat:'));
	});

	test('reading new things is progress; reset forgets everything', () => {
		const detector = new AcpLoopDetector();
		for (let i = 0; i < 12; i++) {
			assert.strictEqual(detector.record({ tool: 'read', key: `read\0src/f${i}.ts`, target: `src/f${i}.ts`, failed: false, outcome: `content ${i}`, label: `Read f${i}.ts` }), undefined);
		}
		[1, 2, 3].forEach(i => detector.record(call(`curl localhost:300${i}`, 'refused')));
		detector.reset();
		assert.strictEqual(detector.record(call('curl localhost:3004', 'refused')), undefined);
	});

	test('the supervisor gets a fresh detector per turn through the options getter', () => {
		let made = 0;
		const options = { get detector() { made++; return new AcpLoopDetector(); } };
		new RunSupervisor({ ...options });
		new RunSupervisor({ ...options });
		assert.strictEqual(made, 2);
	});
});
