/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { HarnessController, IHarnessCapabilities, IHarnessControllerOptions } from '../../../common/harness/harnessController.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { laneDefinition, VoltLane } from '../../../common/harness/lanes.js';
import { ILoopStep } from '../../../common/harness/nativeLoop.js';
import { buildPlan } from '../../../common/harness/plan.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';
import { IProjectChecks } from '../../../common/harness/verification.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt harness controller', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const checks: IProjectChecks = { test: 'npm test', typecheck: 'npx tsc --noEmit' };

	test('lets a productive step carry on', () => {
		const controller = make('add a logout button to the header');
		const result = controller.afterStep(step(1, [call('edit_file', { path: 'src/Header.tsx' })], [ok('edit_file', 'edit')]));
		assert.strictEqual(result.directive.kind, 'continue');
		assert.strictEqual(result.recovery.strategy, 'continue');
		assert.strictEqual(result.progress.signals.stateChanged, true);
	});

	test('sends the model back when it claims done without running the check it was given', () => {
		const controller = make('fix the login bug so the tests pass');
		controller.afterStep(step(1, [call('edit_file', { path: 'src/login.ts' })], [ok('edit_file', 'edit')]));

		const result = controller.afterStep(finishing(2, 'All fixed!'));
		assert.strictEqual(result.directive.kind, 'inject');
		assert.strictEqual(result.completion?.complete, false);
		if (result.directive.kind === 'inject') {
			assert.ok(/have not run test \(`npm test`\)/.test(result.directive.message), result.directive.message);
			assert.ok(/do not claim it is done/.test(result.directive.message));
		}
	});

	test('lets it finish once the evidence supports the claim', () => {
		const controller = make('fix the login bug so the tests pass');
		controller.afterStep(step(1, [call('edit_file', { path: 'src/login.ts' })], [ok('edit_file', 'edit')]));
		controller.afterStep(step(2, [call('shell', { command: 'npm test' })], [ok('shell', 'execute')]));

		const result = controller.afterStep(finishing(3, 'Fixed the token check.'));
		assert.strictEqual(result.directive.kind, 'stop');
		assert.strictEqual(result.completion?.complete, true);
	});

	test('stops arguing after three rejections rather than burning the budget', () => {
		const controller = make('fix the login bug so the tests pass');
		controller.afterStep(step(1, [call('edit_file', { path: 'src/login.ts' })], [ok('edit_file', 'edit')]));

		for (let attempt = 0; attempt < 3; attempt++) {
			assert.strictEqual(controller.afterStep(finishing(2 + attempt, 'done')).directive.kind, 'inject', `rejection ${attempt + 1}`);
		}
		const final = controller.afterStep(finishing(5, 'done'));
		assert.strictEqual(final.directive.kind, 'stop');
		assert.strictEqual(final.completion?.complete, false, 'it gave up, it did not change its mind');
	});

	test('corrects a not-found failure instead of letting it repeat', () => {
		const controller = make('add a logout button to the header');
		const result = controller.afterStep(step(1,
			[call('read_file', { path: 'src/Header.tsx' })],
			[fail('read_file', 'read', 'ENOENT: no such file, open \'src/Header.tsx\'')],
		));
		assert.strictEqual(result.recovery.strategy, 'nudge');
		assert.strictEqual(result.directive.kind, 'inject');
		if (result.directive.kind === 'inject') {
			assert.ok(/search for it first/i.test(result.directive.message));
		}
	});

	test('carries a retry backoff through to the loop', () => {
		const controller = make('add a logout button to the header');
		const result = controller.afterStep(step(1,
			[call('web_fetch', { url: 'https://example.com' })],
			[fail('web_fetch', 'fetch', 'ETIMEDOUT')],
		));
		assert.strictEqual(result.recovery.strategy, 'retry');
		assert.strictEqual(result.directive.kind, 'inject');
		if (result.directive.kind === 'inject') {
			assert.strictEqual(result.directive.cooldownMs, 400);
		}
	});

	test('reports a structural recovery upward and keeps the loop going', () => {
		const controller = make('add a logout button to the header');
		let result = controller.afterStep(barren(1));
		for (let i = 2; !result.action && i < 14; i++) {
			result = controller.afterStep(barren(i));
		}
		assert.ok(result.action, 'expected the ladder to reach a runtime action');
		assert.ok(['escalate', 'delegate', 'rollback', 'reset'].includes(result.action));
		assert.notStrictEqual(result.directive.kind, 'stop');
	});

	test('never asks for a capability the runtime says it does not have', () => {
		const none: IHarnessCapabilities = { canEscalate: false, canDelegate: false, canRollback: false, canReset: false };
		const controller = make('add a logout button to the header', { capabilities: () => none });
		for (let i = 1; i < 14; i++) {
			assert.strictEqual(controller.afterStep(barren(i)).action, undefined, `step ${i} asked for an action`);
		}
	});

	test('records evidence the runtime saw as a file-change event', () => {
		const controller = make('add a logout button to the header');
		controller.recordFileChange(1, 'src/Header.tsx', 'create');
		assert.deepStrictEqual(controller.evidence.changedFiles(), ['src/Header.tsx']);
	});

	suite('plan tracking', () => {
		test('marks the active step running and then done', () => {
			const controller = make('add a logout button to the header and update the tests', { withPlan: true });
			assert.strictEqual(controller.plan?.steps[0].status, 'pending');

			controller.afterStep(step(1, [call('grep', { pattern: 'Header' })], [ok('grep', 'search')]));
			const first = controller.plan?.steps[0];
			assert.ok(first?.status === 'done' || first?.status === 'running', `got ${first?.status}`);
		});

		test('closes every open step when the run genuinely finishes', () => {
			const controller = make('add a logout button to the header and update the tests', { withPlan: true });
			controller.afterStep(step(1, [call('edit_file', { path: 'src/Header.tsx' })], [ok('edit_file', 'edit')]));
			controller.afterStep(step(2, [call('shell', { command: 'npm test' })], [ok('shell', 'execute')]));
			controller.afterStep(finishing(3, 'done'));

			assert.ok(controller.plan?.steps.every(entry => entry.status === 'done' || entry.status === 'skipped'),
				controller.plan?.steps.map(entry => `${entry.id}:${entry.status}`).join(' '));
		});

		test('replan rewrites the plan and tells the model to work the new first step', () => {
			const controller = make('add a logout button to the header and update the tests', { withPlan: true });
			const before = controller.plan!.revision;
			let result = controller.afterStep(barren(1));
			for (let i = 2; result.recovery.strategy !== 'replan' && i < 14; i++) {
				result = controller.afterStep(barren(i));
			}
			assert.strictEqual(result.recovery.strategy, 'replan');
			assert.ok(controller.plan!.revision > before);
			assert.strictEqual(result.directive.kind, 'inject');
		});
	});

	test('sends an agent back when it tries to finish without using a tool', () => {
		const controller = make('add a logout button to the header');
		const result = controller.afterStep(finishing(1, 'I will add it later.'));
		assert.strictEqual(result.directive.kind, 'inject');
		if (result.directive.kind === 'inject') {
			assert.ok(/did not use a tool/i.test(result.directive.message), result.directive.message);
		}
	});

	test('a read-only lane may finish having changed nothing', () => {
		const controller = make('explain how auth works here', { lane: 'chat', readOnly: true });
		const result = controller.afterStep(finishing(1, 'Auth goes through the session middleware.'));
		assert.strictEqual(result.directive.kind, 'stop');
		assert.strictEqual(result.completion?.complete, true);
	});

	test('sends a lookup question back when it answers without searching', () => {
		const controller = make('tell me each model and their price give me in a table', { lane: 'chat', readOnly: true });
		const result = controller.afterStep(finishing(1, 'Prices vary by dealer.'));
		assert.strictEqual(result.directive.kind, 'inject');
		if (result.directive.kind === 'inject') {
			assert.ok(/web_search|look/i.test(result.directive.message), result.directive.message);
		}
	});

	test('sends a researched answer back when it is not the asked table', () => {
		const controller = make('tell me each model and their price give me in a table', { lane: 'chat', readOnly: true });
		controller.afterStep(step(1, [call('web_search', { query: 'models prices' })], [ok('web_search', 'fetch')]));
		const result = controller.afterStep(finishing(2, 'They start around sixty thousand.'));
		assert.strictEqual(result.directive.kind, 'inject');
		if (result.directive.kind === 'inject') {
			assert.ok(/table/i.test(result.directive.message), result.directive.message);
		}
	});

	test('lets a researched table finish', () => {
		const controller = make('tell me each model and their price give me in a table', { lane: 'chat', readOnly: true });
		controller.afterStep(step(1, [call('web_search', { query: 'models prices' })], [ok('web_search', 'fetch')]));
		controller.afterStep(step(2, [call('web_fetch', { url: 'https://example.com/prices' })], [ok('web_fetch', 'fetch')]));
		const result = controller.afterStep(finishing(3, '| Model | Price |\n| --- | --- |\n| A | 1 |\n| B | 2 |'));
		assert.strictEqual(result.directive.kind, 'stop');
		assert.strictEqual(result.completion?.complete, true);
	});

	function make(text: string, overrides: Partial<IHarnessControllerOptions> & { withPlan?: boolean; lane?: VoltLane } = {}): HarnessController {
		const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
		const intel = analyzeTask(text, intent);
		const lane = overrides.lane ?? intent.lane;
		return new HarnessController({
			intel,
			lane,
			checks,
			budget: laneDefinition(lane).budget,
			capabilities: () => ({ canEscalate: true, canDelegate: true, canRollback: true, canReset: true }),
			...(overrides.withPlan ? { plan: buildPlan(intel, lane) } : {}),
			...overrides,
		});
	}
});

function step(index: number, calls: readonly IToolCall[], results: readonly IToolResult[], text = ''): ILoopStep {
	return { step: index, calls, results, assistantText: text, wantsToFinish: false };
}

function finishing(index: number, text: string): ILoopStep {
	return { step: index, calls: [], results: [], assistantText: text, wantsToFinish: true };
}

/** A step that reads somewhere new and learns nothing. */
function barren(index: number): ILoopStep {
	return step(index, [call('read_file', { path: `f${index}.ts` })], [fail('read_file', 'read', 'file is empty')]);
}

let seq = 0;

function call(name: string, args: unknown): IToolCall {
	return { id: `c${++seq}`, name, args };
}

function ok(name: string, kind: IToolResult['kind']): IToolResult {
	return { callId: `c${seq}`, name, kind, text: 'ok' };
}

function fail(name: string, kind: IToolResult['kind'], text: string): IToolResult {
	return { callId: `c${seq}`, name, kind, text, isError: true };
}
