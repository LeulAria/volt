/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ErrorClass, IClassifiedError, IProgressReport } from '../../../common/harness/progress.js';
import { IRecoveryContext, needsRecovery, RecoveryController, RecoveryStrategy } from '../../../common/harness/recovery.js';

suite('Volt recovery controller', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a healthy step needs no recovery', () => {
		const decision = new RecoveryController().decide(context(report({ score: 0.8 })));
		assert.strictEqual(decision.strategy, 'continue');
		assert.strictEqual(needsRecovery(report({ score: 0.8 })), false);
	});

	test('a low-scoring step needs recovery even with no error', () => {
		assert.strictEqual(needsRecovery(report({ score: 0.1 })), true);
	});

	test('retries a transient failure with exponential backoff', () => {
		const controller = new RecoveryController();
		const first = controller.decide(context(report({ score: 0.1, error: 'transient' })));
		assert.strictEqual(first.strategy, 'retry');
		assert.strictEqual(first.cooldownMs, 400);

		const second = controller.decide(context(report({ score: 0.1, error: 'transient' })));
		assert.strictEqual(second.strategy, 'retry');
		assert.strictEqual(second.cooldownMs, 800);
	});

	test('does not retry a failure that already happened once', () => {
		const decision = new RecoveryController().decide(context(report({ score: 0.1, error: 'transient', repeated: true })));
		assert.strictEqual(decision.strategy, 'nudge');
	});

	test('nudges a not-found failure toward searching first', () => {
		const decision = new RecoveryController().decide(context(report({ score: 0.1, error: 'not-found', message: 'ENOENT src/nope.ts' })));
		assert.strictEqual(decision.strategy, 'nudge');
		assert.ok(/search for it first/i.test(decision.guidance ?? ''));
		assert.ok(decision.guidance?.includes('src/nope.ts'));
	});

	test('tells the model not to route around a denied permission', () => {
		const decision = new RecoveryController().decide(context(report({ score: 0.1, error: 'permission' })));
		assert.ok(/do not retry it or route around it/i.test(decision.guidance ?? ''));
	});

	test('skips nudging on a doom loop and changes the shape of the run', () => {
		const decision = new RecoveryController().decide(context(report({ score: 0.1, doomLoop: true })));
		assert.strictEqual(decision.strategy, 'switch');
		assert.ok(/Stop the current approach/.test(decision.guidance ?? ''));
	});

	test('climbs the ladder and never falls back to a spent rung', () => {
		const controller = new RecoveryController();
		const seen: RecoveryStrategy[] = [];
		for (let i = 0; i < 12; i++) {
			seen.push(controller.decide(context(report({ score: 0.05, stuck: true }))).strategy);
		}
		const rank = (strategy: RecoveryStrategy) => ['retry', 'nudge', 'rollback', 'switch', 'replan', 'escalate', 'delegate', 'isolate', 'reset', 'ask', 'stop'].indexOf(strategy);
		for (let i = 1; i < seen.length; i++) {
			assert.ok(rank(seen[i]) >= rank(seen[i - 1]), `${seen[i - 1]} -> ${seen[i]} went backwards (${seen.join(' -> ')})`);
		}
		assert.strictEqual(seen[seen.length - 1], 'stop');
		assert.ok(seen.includes('ask'), `expected to reach ask: ${seen.join(' -> ')}`);
	});

	test('skips rungs the context forbids', () => {
		const controller = new RecoveryController();
		const strategies = new Set<RecoveryStrategy>();
		for (let i = 0; i < 14; i++) {
			strategies.add(controller.decide({
				...context(report({ score: 0.05, stuck: true })),
				canEscalate: false,
				canDelegate: false,
				canRollback: false,
				canReset: false,
				hasPlan: false,
			}).strategy);
		}
		for (const forbidden of ['escalate', 'delegate', 'rollback', 'reset', 'replan'] as const) {
			assert.strictEqual(strategies.has(forbidden), false, `${forbidden} should have been skipped`);
		}
		assert.ok(strategies.has('stop'));
	});

	test('does not replan without an active step', () => {
		const controller = new RecoveryController();
		const strategies: RecoveryStrategy[] = [];
		for (let i = 0; i < 8; i++) {
			strategies.push(controller.decide({ ...context(report({ score: 0.05, stuck: true })), activeStepId: undefined }).strategy);
		}
		assert.strictEqual(strategies.includes('replan'), false);
	});

	test('replan carries the step id and a prerequisite', () => {
		const controller = new RecoveryController();
		let decision = controller.decide(context(report({ score: 0.05, stuck: true })));
		while (decision.strategy !== 'replan' && decision.strategy !== 'stop') {
			decision = controller.decide(context(report({ score: 0.05, stuck: true })));
		}
		assert.strictEqual(decision.strategy, 'replan');
		assert.strictEqual(decision.replan?.stepId, 's2');
		assert.ok((decision.replan?.insertBefore ?? []).length > 0);
	});

	test('stops out of a cancelled run without climbing', () => {
		const decision = new RecoveryController().decide(context(report({ score: 0, error: 'cancelled' })));
		assert.strictEqual(decision.strategy, 'stop');
		assert.strictEqual(decision.reason, 'Cancelled.');
	});

	test('stops nudging once the lane budget is nearly spent', () => {
		const decision = new RecoveryController().decide({
			...context(report({ score: 0.1, error: 'not-found' })),
			budgetUsed: 0.95,
		});
		assert.ok(decision.strategy !== 'retry' && decision.strategy !== 'nudge', `got ${decision.strategy}`);
	});

	test('rolls back when the same syntax error keeps coming back', () => {
		const controller = new RecoveryController();
		const strategies: RecoveryStrategy[] = [];
		for (let i = 0; i < 10; i++) {
			strategies.push(controller.decide(context(report({ score: 0.05, error: 'syntax', repeated: true, stuck: true }))).strategy);
		}
		assert.ok(strategies.includes('rollback'), strategies.join(' -> '));
	});

	test('token waste alone is enough to reset the context', () => {
		assert.strictEqual(needsRecovery(report({ score: 0.9, tokenWaste: 0.9 })), true);
	});

	test('the ask message explains what the user has to decide', () => {
		const controller = new RecoveryController();
		let decision = controller.decide(context(report({ score: 0.05, stuck: true })));
		while (decision.strategy !== 'ask' && decision.strategy !== 'stop') {
			decision = controller.decide(context(report({ score: 0.05, stuck: true })));
		}
		assert.strictEqual(decision.strategy, 'ask');
		assert.ok(/tell me/i.test(decision.reason));
	});
});

function context(value: IProgressReport): IRecoveryContext {
	return {
		lane: 'agent',
		report: value,
		canEscalate: true,
		canDelegate: true,
		canRollback: true,
		canReset: true,
		hasPlan: true,
		activeStepId: 's2',
		budgetUsed: 0.2,
	};
}

function report(options: {
	score: number;
	error?: ErrorClass;
	message?: string;
	repeated?: boolean;
	stuck?: boolean;
	doomLoop?: boolean;
	tokenWaste?: number;
}): IProgressReport {
	const errors: IClassifiedError[] = options.error
		? [{ callId: 'c1', tool: 'read_file', class: options.error, message: options.message ?? 'boom', repeated: options.repeated ?? false }]
		: [];
	return {
		step: 1,
		score: options.score,
		signals: {
			stateChanged: false,
			novelty: 0.5,
			forward: 0.5,
			repetition: options.doomLoop ? 1 : 0.5,
			errorRate: errors.length ? 1 : 0,
			tokenWaste: options.tokenWaste ?? 0,
			oscillation: 0,
			toolWaste: 0,
			goalDistance: 0.5,
		},
		barrenSteps: options.stuck ? 3 : 0,
		stuck: options.stuck ?? false,
		doomLoop: options.doomLoop ?? false,
		regression: false,
		errors,
		dominantError: options.error,
		reason: 'test',
	};
}
