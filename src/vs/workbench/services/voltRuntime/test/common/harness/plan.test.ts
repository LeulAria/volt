/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { VoltLane } from '../../../common/harness/lanes.js';
import {
	buildPlan, criterionId, IExecutionPlan, IPlanStep, isPlanComplete, isPlanStalled,
	planEntries, planProgress, readySteps, replan, scheduleWaves, validatePlan, withStepStatus,
} from '../../../common/harness/plan.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';

suite('Volt adaptive planner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const planFor = (text: string, lane?: VoltLane) => {
		const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
		return buildPlan(analyzeTask(text, intent), lane ?? intent.lane);
	};

	test('plans nothing for a question', () => {
		assert.strictEqual(planFor('what does this function do', 'chat'), undefined);
	});

	test('a coding lookup starts with research before implement', () => {
		const plan = planFor('implement login using the official docs', 'agent');
		assert.ok(plan);
		assert.strictEqual(plan.steps[0].role, 'research');
		assert.ok(plan.steps.some(step => step.role === 'implement'));
		assert.ok(plan.steps.some(step => step.dependsOn.includes('s1')));
		assert.ok(validatePlan(plan).ok);
	});

	test('a fast lookup is research then the named edit', () => {
		const plan = planFor('fix the typo in README.md using the official docs', 'fast');
		assert.ok(plan);
		assert.strictEqual(plan.steps.length, 2);
		assert.strictEqual(plan.steps[0].role, 'research');
		assert.strictEqual(plan.steps[1].role, 'implement');
		assert.deepStrictEqual(plan.steps[1].dependsOn, ['s1']);
	});

	test('plans exactly one step for a fast edit', () => {
		const plan = planFor('rename foo to bar in utils.ts', 'fast');
		assert.ok(plan);
		assert.strictEqual(plan.steps.length, 1);
		assert.strictEqual(plan.steps[0].role, 'implement');
		assert.deepStrictEqual(plan.steps[0].dependsOn, []);
	});

	test('fans implement steps out of one explore step', () => {
		const plan = planFor('add a logout button to the header and update the tests', 'agent');
		assert.ok(plan);
		const roles = plan.steps.map(step => step.role);
		assert.strictEqual(roles[0], 'explore');
		assert.ok(roles.filter(role => role === 'implement').length >= 2);
		for (const step of plan.steps.filter(step => step.role === 'implement')) {
			assert.deepStrictEqual(step.dependsOn, ['s1']);
		}
	});

	test('chains implement steps the user sequenced and keeps them serial', () => {
		const plan = planFor('migrate the schema then update the queries so the tests pass', 'agent');
		assert.ok(plan);
		const implement = plan.steps.filter(step => step.role === 'implement');
		assert.strictEqual(implement.length, 2);
		assert.ok(implement[1].dependsOn.includes(implement[0].id), 'second step should wait on the first');
		assert.strictEqual(implement[1].parallelSafe, false);
	});

	test('adds a verify step depending on every implement step', () => {
		const plan = planFor('fix the login bug so that the tests pass', 'agent');
		assert.ok(plan);
		const verify = plan.steps.find(step => step.role === 'verify');
		assert.ok(verify, 'expected a verify step');
		const implement = plan.steps.filter(step => step.role === 'implement').map(step => step.id);
		assert.deepStrictEqual([...verify.dependsOn].sort(), implement.sort());
	});

	test('omits the verify step when nothing is machine-checkable', () => {
		const plan = planFor('rename foo to bar in utils.ts', 'agent');
		assert.ok(plan);
		assert.strictEqual(plan.steps.some(step => step.role === 'verify'), false);
	});

	test('accepts a well-formed plan', () => {
		const plan = planFor('fix the login bug so that the tests pass', 'agent');
		assert.ok(plan);
		const validation = validatePlan(plan);
		assert.strictEqual(validation.ok, true, validation.errors.join('; '));
		assert.deepStrictEqual(validation.warnings, []);
	});

	test('rejects an unknown dependency', () => {
		const validation = validatePlan(synthetic([
			{ id: 's1', dependsOn: ['nope'] },
		]));
		assert.strictEqual(validation.ok, false);
		assert.ok(validation.errors.some(error => /unknown step nope/.test(error)));
	});

	test('rejects a dependency cycle', () => {
		const validation = validatePlan(synthetic([
			{ id: 's1', dependsOn: ['s3'] },
			{ id: 's2', dependsOn: ['s1'] },
			{ id: 's3', dependsOn: ['s2'] },
		]));
		assert.strictEqual(validation.ok, false);
		assert.ok(validation.errors.some(error => /cycle/.test(error)));
	});

	test('rejects a self-dependency and an empty plan', () => {
		assert.ok(validatePlan(synthetic([{ id: 's1', dependsOn: ['s1'] }])).errors.some(e => /itself/.test(e)));
		assert.ok(validatePlan(synthetic([])).errors.some(e => /no steps/.test(e)));
	});

	test('warns when a criterion has no step to prove it', () => {
		const plan: IExecutionPlan = {
			...synthetic([{ id: 's1', dependsOn: [] }]),
			criteria: [{ text: 'The tests pass.', evidence: 'test', explicit: true }],
		};
		const validation = validatePlan(plan);
		assert.strictEqual(validation.ok, true);
		assert.ok(validation.warnings.some(warning => /No step proves/.test(warning)));
	});

	test('only offers steps whose dependencies are settled', () => {
		let plan = planFor('add a logout button to the header and update the tests', 'agent')!;
		assert.deepStrictEqual(readySteps(plan).map(step => step.id), ['s1']);

		plan = withStepStatus(plan, 's1', 'done');
		const ready = readySteps(plan).map(step => step.id);
		assert.deepStrictEqual(ready, ['s2', 's3']);
	});

	test('treats a skipped dependency as settled but a failed one as blocking', () => {
		let plan = planFor('add a logout button to the header and update the tests', 'agent')!;
		plan = withStepStatus(plan, 's1', 'failed');
		assert.deepStrictEqual(readySteps(plan), []);

		plan = withStepStatus(plan, 's1', 'skipped');
		assert.ok(readySteps(plan).length > 0);
	});

	test('groups independent steps into one wave and isolates serial ones', () => {
		const plan = planFor('add a logout button to the header and update the tests', 'agent')!;
		const waves = scheduleWaves(plan).map(wave => wave.map(step => step.id));
		assert.deepStrictEqual(waves[0], ['s1']);
		assert.deepStrictEqual(waves[1], ['s2', 's3']);
	});

	test('counts a step as attempted every time it starts running', () => {
		let plan = planFor('rename foo to bar in utils.ts', 'fast')!;
		plan = withStepStatus(plan, 's1', 'running');
		plan = withStepStatus(plan, 's1', 'failed', 'compile error');
		plan = withStepStatus(plan, 's1', 'running');
		assert.strictEqual(plan.steps[0].attempts, 2);
		assert.strictEqual(plan.steps[0].note, 'compile error');
	});

	test('reports completion, stall, and progress', () => {
		let plan = planFor('add a logout button to the header and update the tests', 'agent')!;
		assert.strictEqual(isPlanComplete(plan), false);
		assert.strictEqual(isPlanStalled(plan), false);
		assert.strictEqual(planProgress(plan), 0);

		plan = withStepStatus(plan, 's1', 'failed');
		assert.strictEqual(isPlanStalled(plan), true, 'a failed root should stall the plan');

		for (const step of plan.steps) {
			plan = withStepStatus(plan, step.id, 'done');
		}
		assert.strictEqual(isPlanComplete(plan), true);
		assert.strictEqual(planProgress(plan), 1);
	});

	test('replan inserts prerequisites and reopens the failed step', () => {
		let plan = planFor('rename foo to bar in utils.ts', 'fast')!;
		plan = withStepStatus(plan, 's1', 'failed', 'could not find foo');
		plan = replan(plan, { stepId: 's1', reason: 'could not find foo', insertBefore: ['Search the repo for foo'] });

		assert.strictEqual(plan.revision, 2);
		assert.strictEqual(plan.steps.length, 2);
		const target = plan.steps.find(step => step.id === 's1')!;
		assert.strictEqual(target.status, 'pending');
		assert.deepStrictEqual(target.dependsOn, ['s2']);
		assert.deepStrictEqual(readySteps(plan).map(step => step.id), ['s2']);
		assert.strictEqual(validatePlan(plan).ok, true);
	});

	test('replan can skip a step so its dependents unblock', () => {
		let plan = planFor('add a logout button to the header and update the tests', 'agent')!;
		plan = replan(plan, { stepId: 's1', reason: 'nothing to explore', skip: true });
		assert.strictEqual(plan.steps[0].status, 'skipped');
		assert.strictEqual(plan.steps[0].note, 'nothing to explore');
		assert.ok(readySteps(plan).length > 0);
	});

	test('replan ignores an unknown step', () => {
		const plan = planFor('rename foo to bar in utils.ts', 'fast')!;
		assert.strictEqual(replan(plan, { stepId: 'nope', reason: 'x' }), plan);
	});

	test('projects onto the plan entries the UI renders', () => {
		let plan = planFor('add a logout button to the header and update the tests', 'agent')!;
		plan = withStepStatus(plan, 's1', 'done');
		plan = withStepStatus(plan, 's2', 'running');
		const entries = planEntries(plan);
		assert.strictEqual(entries[0].status, 'completed');
		assert.strictEqual(entries[1].status, 'in_progress');
		assert.strictEqual(entries[2].status, 'pending');
	});

	test('criterion ids are stable and positional', () => {
		assert.strictEqual(criterionId(0), 'c0');
		assert.strictEqual(criterionId(3), 'c3');
	});
});

function synthetic(steps: readonly { id: string; dependsOn: readonly string[] }[]): IExecutionPlan {
	return {
		goal: 'test',
		revision: 1,
		criteria: [],
		steps: steps.map(({ id, dependsOn }): IPlanStep => ({
			id,
			title: id,
			role: 'implement',
			dependsOn,
			status: 'pending',
			satisfies: [],
			parallelSafe: true,
			attempts: 0,
		})),
	};
}
