/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { prepareRun, preparedLaneFraming } from '../../../common/harness/pipeline.js';

suite('Volt harness pipeline', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a chat question is a direct dispatch with no plan', () => {
		const prepared = prepareRun({ text: 'what is 2+2', mode: 'agent' });
		assert.strictEqual(prepared.intent.lane, 'chat');
		assert.strictEqual(prepared.dispatch, 'direct');
		assert.strictEqual(prepared.plan, undefined);
		assert.strictEqual(prepared.orchestration.mode, 'single');
		assert.strictEqual(prepared.execution.backend, 'native');
		assert.strictEqual(prepared.strategy.strategy, 'answer');
		assert.ok(!prepared.clarify);
	});

	test('an enumerated table in ask mode researches instead of answering from memory', () => {
		const prepared = prepareRun({ text: 'tell me each model and their price give me in a table', mode: 'ask' });
		assert.strictEqual(prepared.intent.lane, 'chat');
		assert.strictEqual(prepared.strategy.strategy, 'research-answer');
		assert.strictEqual(prepared.requestKind, 'research');
		assert.ok(prepared.intent.budget.maxToolCalls >= 16);
		assert.ok(prepared.intent.budget.maxModelCalls >= 8);
		assert.ok(prepared.tools.suggested.includes('web_search'));
		assert.strictEqual(prepared.orchestration.workers[0]?.role, 'research');
	});

	test('implementing from official docs researches first, then edits', () => {
		const prepared = prepareRun({
			text: 'implement login using the official docs',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
		});
		assert.strictEqual(prepared.intent.lane, 'agent');
		assert.strictEqual(prepared.strategy.strategy, 'research-first');
		assert.strictEqual(prepared.requestKind, 'research');
		assert.strictEqual(prepared.plan?.steps[0]?.role, 'research');
		assert.ok(prepared.plan?.steps.some(step => step.role === 'implement'));
		assert.ok(prepared.tools.suggested.includes('web_search'));
		assert.ok(prepared.intent.groups.includes('edit'));
		assert.ok(!/Do not modify the workspace/.test(preparedLaneFraming(prepared)));
	});

	test('a named edit produces a plan and a loop dispatch', () => {
		const prepared = prepareRun({
			text: 'add a logout button to the header and update the tests so they pass',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
		});
		assert.strictEqual(prepared.intent.lane, 'agent');
		assert.strictEqual(prepared.dispatch, 'loop');
		assert.ok(prepared.plan);
		assert.ok(prepared.planValidation?.ok);
		assert.ok(prepared.intel.deliverables.length >= 1);
		assert.ok(prepared.tools.suggested.length);
	});

	test('an ambiguous first-turn "fix it" trips the clarify gate', () => {
		const prepared = prepareRun({ text: 'fix it', mode: 'agent', intentContext: { hasWorkspace: true } });
		assert.ok(prepared.clarify);
		assert.strictEqual(prepared.dispatch, 'direct');
		assert.strictEqual(prepared.plan, undefined);
	});

	test('an ACP agent is routed away from the native loop', () => {
		const prepared = prepareRun({
			text: 'add a logout button to the header',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
			provider: { kind: 'agent', providerId: 'cursor-acp', acp: true },
		});
		assert.strictEqual(prepared.execution.backend, 'acp');
	});

	test('a model pick stays on the native loop', () => {
		const prepared = prepareRun({
			text: 'add a logout button to the header',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
			provider: { kind: 'model', providerId: 'anthropic' },
		});
		assert.strictEqual(prepared.execution.backend, 'native');
	});
});
