/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildTaskPrompt, describeTask, verifyFromArgs } from '../../../common/orchestration/agentTasks.js';
import { DEFAULT_ORCH_LIMITS } from '../../../common/orchestration/orchestrator.js';
import { extractRoot, parseRootSnapshot } from '../../../common/orchestration/orchestratorCodec.js';
import { OrchSim } from './orchestratorSim.js';

/** A parent that delegated one task with `verify` checks, and the child running its brief. */
function delegated(verify = ['npm test -- a.test.ts']) {
	const sim = new OrchSim(DEFAULT_ORCH_LIMITS);
	sim.submit('p', 'fix the bug');
	sim.start('p');
	sim.spawn('p', 'Fix a.ts so a.test.ts passes.', { taskId: 't-1', role: 'implementation', verify });
	const child = sim.childOf('t-1');
	sim.start(child);
	return { sim, child };
}

suite('Volt orchestrator: Volt runs a subagent\'s checks before its report goes up', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a done report with checks waits for them; passing checks deliver it with the result', () => {
		const { sim, child } = delegated();
		const before = sim.effects.length;
		sim.settle(child, 'done', '## Outcome\nFixed.');
		const task = sim.state.tasks['t-1'];
		assert.strictEqual(task.state, 'running', 'it keeps its slot while Volt checks');
		assert.strictEqual(task.verification?.state, 'running');
		assert.strictEqual(task.result, '## Outcome\nFixed.', 'the report waits in result');
		assert.deepStrictEqual(sim.effectsOf('verifyTask', before).map(effect => [effect.taskId, effect.round]), [['t-1', 1]]);
		assert.notStrictEqual(sim.state.tasks['t-1'].delivery, 'pending', 'nothing reaches the parent yet');

		sim.run({ type: 'task.verified', taskId: 't-1', round: 1, outcome: 'passed', summary: '- passed: `npm test -- a.test.ts` (2.0s)' });
		const done = sim.state.tasks['t-1'];
		assert.strictEqual(done.state, 'completed');
		assert.strictEqual(done.delivery, 'pending');
		assert.ok(done.result?.startsWith('## Outcome\nFixed.'));
		assert.ok(done.result?.includes('## Volt verification\nPassed'));
		assert.ok(done.result?.includes('`npm test -- a.test.ts`'));
	});

	test('a failure sends the subagent back with the output, in the same chat, and the next report is checked again', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'done', 'Fixed.');
		sim.run({ type: 'task.verified', taskId: 't-1', round: 1, outcome: 'failed', summary: '- FAILED: `npm test -- a.test.ts` (exit code 1)\nexpected 2, got 3' });
		const task = sim.state.tasks['t-1'];
		assert.strictEqual(task.state, 'running');
		assert.strictEqual(task.verification?.state, 'failed');
		const followUp = sim.thread(child).active;
		assert.ok(followUp, 'the fix runs at once as the chat\'s next turn');
		assert.strictEqual(followUp.kind, 'followup');
		assert.ok(followUp.prompt.text.includes('expected 2, got 3'));
		assert.ok(followUp.prompt.text.includes('round 1 of 3'));

		const before = sim.effects.length;
		sim.complete(child, 'done', 'Fixed for real.');
		assert.strictEqual(sim.state.tasks['t-1'].verification?.round, 2);
		assert.deepStrictEqual(sim.effectsOf('verifyTask', before).map(effect => effect.round), [2]);
		sim.run({ type: 'task.verified', taskId: 't-1', round: 2, outcome: 'passed', summary: '- passed' });
		assert.strictEqual(sim.state.tasks['t-1'].state, 'completed');
		assert.ok(sim.state.tasks['t-1'].result?.includes('it took 2 rounds'));
	});

	test('past the last round the report goes up saying the checks still fail', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'done', 'r1');
		for (let round = 1; round < DEFAULT_ORCH_LIMITS.maxVerifyRounds; round++) {
			sim.run({ type: 'task.verified', taskId: 't-1', round, outcome: 'failed', summary: 'still red' });
			sim.complete(child, 'done', `r${round + 1}`);
		}
		sim.run({ type: 'task.verified', taskId: 't-1', round: DEFAULT_ORCH_LIMITS.maxVerifyRounds, outcome: 'failed', summary: 'still red' });
		const task = sim.state.tasks['t-1'];
		assert.strictEqual(task.state, 'completed');
		assert.strictEqual(task.delivery, 'pending');
		assert.ok(task.result?.includes(`FAILED after ${DEFAULT_ORCH_LIMITS.maxVerifyRounds} rounds`));
		assert.ok(task.result?.includes('still red'));
	});

	test('a result for an old round, or for a task stopped meanwhile, changes nothing', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'done', 'Fixed.');
		const before = sim.state;
		sim.run({ type: 'task.verified', taskId: 't-1', round: 7, outcome: 'passed', summary: '' });
		assert.deepStrictEqual(sim.state.tasks, before.tasks, 'stale round');
		sim.run({ type: 'task.cancel', taskId: 't-1' });
		assert.strictEqual(sim.state.tasks['t-1'].state, 'cancelled');
		sim.run({ type: 'task.verified', taskId: 't-1', round: 1, outcome: 'passed', summary: '' });
		assert.strictEqual(sim.state.tasks['t-1'].state, 'cancelled');
	});

	test('while Volt checks, the idle child chat is not mistaken for a task whose prompt was removed', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'done', 'Fixed.');
		// Any command runs the scheduler; the task must still be running afterwards.
		sim.run({ type: 'task.ack', taskIds: [] });
		assert.strictEqual(sim.state.tasks['t-1'].state, 'running');
		assert.strictEqual(sim.thread(child).active, undefined);
	});

	test('a failed or stopped round is not checked: only a report that says it is done', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'failed', undefined, 'model error');
		assert.notStrictEqual(sim.state.tasks['t-1'].verification?.state, 'running');
	});

	test('a restart while checks run runs them again; with resume off the report goes up saying they did not finish', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'done', 'Fixed.');
		const before = sim.effects.length;
		sim.run({ type: 'recover', resume: 'all' });
		assert.strictEqual(sim.state.tasks['t-1'].state, 'running');
		assert.deepStrictEqual(sim.effectsOf('verifyTask', before).map(effect => effect.round), [1]);

		const off = delegated();
		off.sim.settle(off.child, 'done', 'Fixed.');
		off.sim.run({ type: 'recover', resume: 'off' });
		const task = off.sim.state.tasks['t-1'];
		assert.strictEqual(task.state, 'completed');
		assert.ok(task.result?.includes('Volt restarted before its checks finished'));
	});

	test('the checks survive a save and load, reach the brief, and show in task_status', () => {
		const { sim, child } = delegated(['npm test', 'npx tsc --noEmit']);
		sim.settle(child, 'done', 'Fixed.');
		const loaded = parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, 'p', [], sim.now))));
		const task = loaded?.tasks.find(candidate => candidate.id === 't-1');
		assert.deepStrictEqual(task?.verify, ['npm test', 'npx tsc --noEmit']);
		assert.strictEqual(task?.verification?.state, 'running');
		assert.ok(describeTask(sim.state.tasks['t-1'], sim.now, { includeResult: false }).includes('checks: Volt is running them (round 1)'));

		const brief = buildTaskPrompt('Fix it.', { role: 'implementation', depth: 1, isolation: 'shared', verify: ['npm test'] });
		assert.ok(brief.includes('Volt itself runs this command in your checkout before your report goes up: `npm test`'));
		assert.deepStrictEqual(verifyFromArgs({ verify: ['npm test', '', 'a\nb', 'tsc'] }), ['npm test', 'tsc'], 'one line each');
		assert.deepStrictEqual(verifyFromArgs({ verify: 'npm test' }), ['npm test']);
	});

	test('a new round from the parent starts its checks over', () => {
		const { sim, child } = delegated();
		sim.settle(child, 'done', 'Fixed.');
		sim.run({ type: 'task.verified', taskId: 't-1', round: 1, outcome: 'passed', summary: '' });
		sim.run({ type: 'task.message', taskId: 't-1', turnId: 'f1', prompt: { text: 'also handle b' } });
		assert.strictEqual(sim.state.tasks['t-1'].verification, undefined);
	});
});
