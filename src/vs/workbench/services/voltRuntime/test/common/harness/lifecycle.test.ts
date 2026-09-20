/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TaskLifecycle, isTerminalPhase, toRunStatus } from '../../../common/harness/lifecycle.js';

suite('Volt task lifecycle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('walks the happy path', () => {
		const life = new TaskLifecycle(1);
		assert.strictEqual(life.current, 'created');
		life.transition('planning', 2);
		life.transition('running', 3);
		life.transition('verifying', 4);
		life.transition('completed', 5);
		assert.ok(life.isTerminal());
		assert.strictEqual(toRunStatus(life.current), 'completed');
		assert.deepStrictEqual(life.snapshot.history.map(entry => entry.phase), ['created', 'planning', 'running', 'verifying', 'completed']);
	});

	test('rejects an illegal jump and tryTransition is safe', () => {
		const life = new TaskLifecycle();
		assert.throws(() => life.transition('completed'));
		assert.strictEqual(life.tryTransition('completed'), undefined);
		assert.strictEqual(life.current, 'created');
	});

	test('resume from waiting returns to running', () => {
		const life = new TaskLifecycle();
		life.transition('planning');
		life.transition('running');
		life.transition('waiting');
		assert.strictEqual(toRunStatus(life.current), 'waiting');
		life.resume();
		assert.strictEqual(life.current, 'running');
	});

	test('cancelled is terminal', () => {
		const life = new TaskLifecycle();
		life.transition('cancelled');
		assert.ok(isTerminalPhase(life.current));
		assert.strictEqual(life.tryTransition('running'), undefined);
	});
});
