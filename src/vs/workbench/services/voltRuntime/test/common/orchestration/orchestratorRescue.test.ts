/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DEFAULT_ORCH_LIMITS } from '../../../common/orchestration/orchestrator.js';
import { rescueDueAt } from '../../../common/orchestration/rescue.js';
import { OrchSim, prompt } from './orchestratorSim.js';

const KEEP_WORKING = { ...DEFAULT_ORCH_LIMITS, supervise: true };

suite('Volt orchestrator: keep working until done', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Moves the clock to the chat's restart and ticks. */
	function tickWhenDue(sim: OrchSim, threadId: string): void {
		const rescue = sim.thread(threadId).rescue;
		assert.ok(rescue, `${threadId} waits to be restarted`);
		sim.now = rescueDueAt(rescue, threadId);
		sim.run({ type: 'rescue.tick' });
	}

	test('a chat that keeps failing is restarted with a growing back-off until a turn finishes', () => {
		const sim = new OrchSim(KEEP_WORKING);
		const { turnId } = sim.submit('a', 'build it');
		sim.start('a');
		sim.settle('a', 'failed', undefined, 'something broke');
		assert.strictEqual(sim.thread('a').pause, 'failed');
		assert.deepStrictEqual({ reason: sim.thread('a').rescue?.reason, attempts: sim.thread('a').rescue?.attempts }, { reason: 'failed', attempts: 0 });

		sim.run({ type: 'rescue.tick' });
		assert.strictEqual(sim.thread('a').active, undefined, 'nothing goes before the back-off');

		tickWhenDue(sim, 'a');
		assert.strictEqual(sim.thread('a').active?.id, `${turnId}~s1`);
		assert.strictEqual(sim.thread('a').active?.kind, 'resume');
		assert.ok(sim.thread('a').active?.prompt.text.startsWith('[Volt]'));
		assert.strictEqual(sim.thread('a').pause, undefined);

		const firstWait = rescueDueAt({ ...sim.thread('a').rescue!, attempts: 0 }, 'a') - sim.thread('a').rescue!.at;
		sim.start('a');
		sim.settle('a', 'failed', undefined, 'something broke again');
		const secondWait = rescueDueAt(sim.thread('a').rescue!, 'a') - sim.thread('a').rescue!.at;
		assert.ok(secondWait > firstWait, 'each restart waits longer');

		tickWhenDue(sim, 'a');
		assert.strictEqual(sim.thread('a').active?.id, `${turnId}~s2`);
		sim.complete('a');
		assert.strictEqual(sim.thread('a').rescue, undefined, 'a finished turn ends it');
		assert.strictEqual(sim.thread('a').active, undefined);
	});

	test('stopping the chat or sending it something else ends it; with the setting off nothing is armed', () => {
		const sim = new OrchSim(KEEP_WORKING);
		sim.submit('a', 'one');
		sim.start('a');
		sim.settle('a', 'failed', undefined, 'something broke');
		sim.run({ type: 'turn.cancel', threadId: 'a' });
		assert.strictEqual(sim.thread('a').rescue, undefined);

		sim.submit('b', 'one');
		sim.start('b');
		sim.settle('b', 'failed', undefined, 'something broke');
		const next = sim.submit('b', 'do this instead');
		assert.strictEqual(sim.thread('b').active?.id, next.turnId);
		assert.strictEqual(sim.thread('b').rescue, undefined);

		const off = new OrchSim();
		off.submit('a', 'one');
		off.start('a');
		off.settle('a', 'failed', undefined, 'something broke');
		assert.strictEqual(off.thread('a').rescue, undefined);
		assert.strictEqual(off.thread('a').pause, 'failed');
	});

	test('after a restart an interrupted chat continues after the back-off, and a turn that never reached the agent is sent again as it was', () => {
		const sim = new OrchSim(KEEP_WORKING);
		sim.submit('a', 'write the report');
		sim.run({ type: 'recover', resume: 'subagents' });
		assert.strictEqual(sim.thread('a').pause, 'interrupted');
		assert.strictEqual(sim.thread('a').rescue?.reason, 'interrupted');

		tickWhenDue(sim, 'a');
		assert.strictEqual(sim.thread('a').active?.prompt.text, 'write the report');
	});

	test('chats due together restart one at a time', () => {
		const sim = new OrchSim(KEEP_WORKING);
		for (const id of ['a', 'b']) {
			sim.submit(id, 'one');
			sim.start(id);
		}
		sim.run({ type: 'recover', resume: 'subagents' });
		sim.now += 60 * 60_000;
		sim.run({ type: 'rescue.tick' });
		assert.strictEqual([sim.thread('a').active, sim.thread('b').active].filter(Boolean).length, 1);
		tickWhenDue(sim, sim.thread('a').active ? 'b' : 'a');
		assert.ok(sim.thread('a').active && sim.thread('b').active);
	});

	test('a turn that ends with its plan open continues while each round closes items', () => {
		const sim = new OrchSim(KEEP_WORKING);
		const { turnId } = sim.submit('a', 'migrate everything');
		const done = (openPlan: string[]) => {
			const active = sim.thread('a').active!;
			sim.run({ type: 'run.settled', threadId: 'a', runId: active.runId, turnId: active.id, outcome: 'done', openPlan });
		};
		sim.start('a');
		done(['step two', 'step three']);
		assert.strictEqual(sim.thread('a').active?.id, `${turnId}~c1`);
		assert.strictEqual(sim.thread('a').active?.planOpen, 2);

		sim.start('a');
		done(['step three']);
		assert.strictEqual(sim.thread('a').active?.id, `${turnId}~c2`);

		sim.start('a');
		done(['step three']);
		assert.strictEqual(sim.thread('a').active, undefined, 'a round that closes nothing ends it');

		sim.run({ type: 'thread.submit', threadId: 'p', turnId: 'plan-1', prompt: prompt('plan it', { mode: 'Plan' }), delivery: 'auto' });
		sim.start('p');
		sim.run({ type: 'run.settled', threadId: 'p', runId: sim.thread('p').active!.runId, turnId: 'plan-1', outcome: 'done', openPlan: ['everything'] });
		assert.strictEqual(sim.thread('p').active, undefined, 'plan mode stops at its plan');
	});

	test('a run that used up its step budget goes on in a fresh run, up to the continuation cap', () => {
		const sim = new OrchSim(KEEP_WORKING);
		const { turnId } = sim.submit('a', 'port the whole app');
		const ranOut = () => {
			const active = sim.thread('a').active!;
			sim.run({ type: 'run.settled', threadId: 'a', runId: active.runId, turnId: active.id, outcome: 'done', stepLimit: true });
		};
		sim.start('a');
		ranOut();
		assert.strictEqual(sim.thread('a').active?.id, `${turnId}~c1`);
		assert.ok(sim.thread('a').active?.prompt.text.includes('step limit'));
		for (let round = 2; round <= 24; round++) {
			sim.start('a');
			ranOut();
		}
		assert.strictEqual(sim.thread('a').active?.id, `${turnId}~c24`);
		sim.start('a');
		ranOut();
		assert.strictEqual(sim.thread('a').active, undefined, 'the cap hands the chat back to the user');

		const off = new OrchSim(DEFAULT_ORCH_LIMITS);
		off.submit('b', 'port it');
		off.start('b');
		off.run({ type: 'run.settled', threadId: 'b', runId: off.thread('b').active!.runId, turnId: off.thread('b').active!.id, outcome: 'done', stepLimit: true });
		assert.strictEqual(off.thread('b').active, undefined, 'without Keep working the chat waits');
	});
});
