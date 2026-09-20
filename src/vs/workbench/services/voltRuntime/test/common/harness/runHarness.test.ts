/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { bindLoopController, compactTurn, createRunHarness } from '../../../common/harness/runHarness.js';
import { prepareRun } from '../../../common/harness/pipeline.js';
import { ILoopStep } from '../../../common/harness/nativeLoop.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt run harness', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('after a productive edit the controller lets the loop continue and emits the plan', async () => {
		const prepared = prepareRun({
			text: 'add a logout button to the header and update the tests so they pass',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
		});
		const harness = createRunHarness(prepared, { test: 'npm test' }, () => ({
			canEscalate: true, canDelegate: true, canRollback: true, canReset: true,
		}));
		const events: string[] = [];
		const controller = bindLoopController(harness, {
			emit: event => events.push(event.type),
		});

		const directive = await controller.afterStep(step(1, [call('edit_file', { path: 'src/Header.tsx' })], [ok('edit_file', 'edit')]));
		assert.strictEqual(directive.kind, 'continue');
		assert.ok(events.includes('plan'));
	});

	test('compactTurn is a no-op on a tiny transcript', () => {
		const prepared = prepareRun({ text: 'what is 2+2', mode: 'agent' });
		const harness = createRunHarness(prepared, {}, () => ({
			canEscalate: false, canDelegate: false, canRollback: false, canReset: false,
		}));
		const messages = [
			{ role: 'system' as const, content: 'you are volt' },
			{ role: 'user' as const, content: 'what is 2+2' },
		];
		assert.strictEqual(compactTurn(harness, messages, 128_000), messages);
	});
});

function step(index: number, calls: readonly IToolCall[], results: readonly IToolResult[]): ILoopStep {
	return { step: index, calls, results, assistantText: '', wantsToFinish: false };
}

let seq = 0;

function call(name: string, args: unknown): IToolCall {
	return { id: `c${++seq}`, name, args };
}

function ok(name: string, kind: IToolResult['kind']): IToolResult {
	return { callId: `c${seq}`, name, kind, text: 'ok' };
}
