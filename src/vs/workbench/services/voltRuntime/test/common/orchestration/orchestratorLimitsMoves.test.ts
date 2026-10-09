/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { LIMIT_MAX_PROBES, LIMIT_PROBE_BACKOFF_MS, LIMIT_RESET_GRACE_MS, LIMIT_RESUME_TEXT, LIMIT_STAGGER_MS, limitDueAt } from '../../../common/orchestration/limitRecovery.js';
import { emptyOrchState, IOrchMove } from '../../../common/orchestration/orchestrator.js';
import { extractRoot, isRootLive, mergeRoot, parseRootSnapshot } from '../../../common/orchestration/orchestratorCodec.js';
import { scheduleOrch } from '../../../common/orchestration/orchestratorDecider.js';
import { threadStatus } from '../../../common/orchestration/orchestratorViews.js';
import { OrchSim } from './orchestratorSim.js';

/** Runs `threadId`'s active turn and ends it on a usage limit. */
function hitLimit(sim: OrchSim, threadId: string, resetAt?: number, message = 'You\'ve hit your limit · resets 3:40pm'): void {
	const active = sim.thread(threadId).active!;
	if (!active.runId) {
		sim.start(threadId);
	}
	sim.run({ type: 'run.settled', threadId, runId: sim.thread(threadId).active!.runId, turnId: active.id, outcome: 'failed', error: message, limit: { message, ...(resetAt !== undefined ? { resetAt } : {}) } });
}

function tickAt(sim: OrchSim, at: number, autoResume = true) {
	sim.now = at - 10;
	return sim.run({ type: 'limit.tick', autoResume });
}

function move(id: string, label = 'a new worktree'): IOrchMove {
	return { id, target: { kind: 'newWorktree' }, label, by: 'user', at: 0 };
}

suite('Volt orchestrator: usage-limit recovery', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a turn stopped by a usage limit parks the chat with its reset; the tick at the reset continues it', () => {
		const sim = new OrchSim();
		const first = sim.submit('a', 'build it', 'auto', false, 'u1');
		const queued = sim.submit('a', 'then test it', 'queue');
		const resetAt = sim.now + 30 * 60_000;
		hitLimit(sim, 'a', resetAt);
		const thread = sim.thread('a');
		assert.strictEqual(thread.active, undefined);
		assert.strictEqual(thread.pause, 'limit');
		assert.deepStrictEqual({ turnId: thread.limit?.turnId, resetAt: thread.limit?.resetAt, probes: thread.limit?.probes }, { turnId: first.turnId, resetAt, probes: 0 });
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'limited');
		assert.ok(!threadStatus(sim.state, 'a').busy);

		// Too early: nothing happens.
		assert.deepStrictEqual(tickAt(sim, resetAt).events, []);
		const mark = sim.effects.length;
		tickAt(sim, resetAt + LIMIT_RESET_GRACE_MS);
		const resumed = sim.thread('a').active!;
		assert.strictEqual(resumed.kind, 'resume');
		assert.strictEqual(resumed.id, 'u1~l1');
		assert.strictEqual(resumed.prompt.text, LIMIT_RESUME_TEXT);
		assert.strictEqual(resumed.limitProbe, 1);
		assert.strictEqual(sim.thread('a').limit, undefined);
		assert.strictEqual(sim.thread('a').pause, undefined);
		assert.deepStrictEqual(sim.effectsOf('startTurn', mark).map(effect => effect.turn.id), ['u1~l1']);

		// The queue goes on once the resume is done.
		sim.complete('a');
		assert.strictEqual(sim.thread('a').active?.id, queued.turnId);
		// A retried tick does not send it twice.
		assert.deepStrictEqual(tickAt(sim, resetAt + LIMIT_RESET_GRACE_MS + 1).events, []);
	});

	test('an unknown reset is probed with a back-off; a probe that hits the limit again parks with the next delay; probing ends', () => {
		const sim = new OrchSim();
		sim.submit('a', 'go', 'auto', false, 'u1');
		hitLimit(sim, 'a', undefined, 'Claude is temporarily rate limited.');
		const parkedAt = sim.thread('a').limit!.at;
		assert.strictEqual(limitDueAt(sim.thread('a').limit!), parkedAt + LIMIT_PROBE_BACKOFF_MS[0]);
		tickAt(sim, parkedAt + LIMIT_PROBE_BACKOFF_MS[0]);
		assert.strictEqual(sim.thread('a').active?.id, 'u1~l1');
		hitLimit(sim, 'a');
		const second = sim.thread('a').limit!;
		assert.strictEqual(second.probes, 1);
		assert.strictEqual(second.turnId, 'u1~l1');
		assert.strictEqual(limitDueAt(second), second.at + LIMIT_PROBE_BACKOFF_MS[1]);
		tickAt(sim, limitDueAt(second));
		assert.strictEqual(sim.thread('a').active?.id, 'u1~l2', 'the probe ids stay unique per stop');

		// After the last allowed probe the chat waits for the user.
		const capped = new OrchSim();
		capped.submit('b', 'go', 'auto', false, 'b1');
		for (let probe = 0; probe < LIMIT_MAX_PROBES; probe++) {
			hitLimit(capped, 'b');
			tickAt(capped, limitDueAt(capped.thread('b').limit!));
		}
		hitLimit(capped, 'b');
		assert.strictEqual(capped.thread('b').limit?.probes, LIMIT_MAX_PROBES);
		assert.deepStrictEqual(tickAt(capped, capped.now + 365 * 86_400_000).events, []);
	});

	test('a stale reset (already past at the stop) is no reset: it probes instead of resuming into the limit', () => {
		const sim = new OrchSim();
		sim.submit('a', 'go');
		hitLimit(sim, 'a', sim.now - 1);
		assert.strictEqual(sim.thread('a').limit?.resetAt, undefined);
	});

	test('many chats waking at one reset go one at a time, the rest in later slots', () => {
		const sim = new OrchSim();
		const resetAt = sim.now + 60_000;
		for (const id of ['a', 'b', 'c']) {
			sim.submit(id, 'go', 'auto', false, `${id}1`);
			hitLimit(sim, id, resetAt);
		}
		const at = resetAt + LIMIT_RESET_GRACE_MS;
		tickAt(sim, at);
		assert.deepStrictEqual(['a', 'b', 'c'].map(id => !!sim.thread(id).active), [true, false, false]);
		assert.strictEqual(sim.thread('b').limit?.notBefore, at + LIMIT_STAGGER_MS);
		assert.strictEqual(sim.thread('c').limit?.notBefore, at + 2 * LIMIT_STAGGER_MS);
		tickAt(sim, at + LIMIT_STAGGER_MS);
		assert.deepStrictEqual(['a', 'b', 'c'].map(id => !!sim.thread(id).active), [true, true, false]);
		tickAt(sim, at + 2 * LIMIT_STAGGER_MS);
		assert.ok(sim.thread('c').active);
	});

	test('auto-resume off waits for the user; a chat can opt in or cancel; Resume now goes at once', () => {
		const sim = new OrchSim();
		sim.submit('a', 'go', 'auto', false, 'u1');
		const resetAt = sim.now + 60_000;
		hitLimit(sim, 'a', resetAt);
		assert.deepStrictEqual(tickAt(sim, resetAt + 3_600_000, false).events, [], 'the setting is off');
		sim.run({ type: 'limit.configure', threadId: 'a', auto: true });
		tickAt(sim, resetAt + 3_600_001, false);
		assert.ok(sim.thread('a').active, 'the chat asked for it');
		assert.strictEqual(sim.thread('a').active?.limitAuto, true);

		const other = new OrchSim();
		other.submit('b', 'go', 'auto', false, 'b1');
		hitLimit(other, 'b', other.now + 60_000);
		other.run({ type: 'limit.configure', threadId: 'b', auto: false });
		assert.deepStrictEqual(tickAt(other, other.now + 3_600_000).events, [], 'cancelled');
		other.run({ type: 'limit.resume', threadId: 'b' });
		const manual = other.thread('b').active!;
		assert.strictEqual(manual.kind, 'resume');
		assert.match(manual.id, /^b1~m\d+$/);
		assert.strictEqual(manual.limitProbe, 0, 'the user\'s resume is not a probe');
		assert.strictEqual(manual.limitAuto, false, 'a cancelled chat stays cancelled if the limit is still there');
	});

	test('switching models on a parked chat then resuming runs the new model; a new prompt also ends the park', () => {
		const sim = new OrchSim();
		sim.run({ type: 'thread.upsert', threadId: 'a', modelRef: 'claude', modelLabel: 'Claude' });
		sim.submit('a', 'go', 'auto', false, 'u1');
		hitLimit(sim, 'a', sim.now + 3_600_000);
		sim.run({ type: 'thread.handoff', threadId: 'a', to: 'gpt', toLabel: 'GPT', by: 'user' });
		assert.strictEqual(sim.thread('a').modelRef, 'gpt');
		sim.run({ type: 'limit.resume', threadId: 'a' });
		assert.strictEqual(sim.thread('a').active?.prompt.modelRef, undefined, 'the resume runs on the chat\'s model');

		const typed = new OrchSim();
		typed.submit('b', 'go');
		hitLimit(typed, 'b', typed.now + 3_600_000);
		typed.submit('b', 'never mind, do this instead');
		assert.strictEqual(typed.thread('b').limit, undefined);
		assert.strictEqual(typed.thread('b').active?.kind, 'prompt');
	});

	test('a subagent\'s chat fails at a limit instead of parking, so its parent hears about it', () => {
		const sim = new OrchSim();
		sim.submit('p', 'delegate');
		sim.start('p');
		sim.spawn('p', 'research', { taskId: 't-1', childId: 'c1' });
		hitLimit(sim, 'c1', sim.now + 60_000);
		assert.strictEqual(sim.thread('c1').limit, undefined);
		assert.strictEqual(sim.state.tasks['t-1'].state, 'failed');
	});

	test('a parked chat is live: it is loaded at startup, survives a save and load, and recovery leaves it parked', () => {
		const sim = new OrchSim();
		sim.submit('a', 'go', 'auto', false, 'u1');
		const resetAt = sim.now + 60_000;
		hitLimit(sim, 'a', resetAt);
		sim.run({ type: 'limit.configure', threadId: 'a', auto: true });
		assert.ok(isRootLive(sim.state, 'a'));
		const loaded = mergeRoot(emptyOrchState(), parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, 'a', [], 0))))!);
		assert.deepStrictEqual(loaded.threads.a, sim.state.threads.a);
		sim.state = loaded;
		sim.run({ type: 'recover', resume: 'all' });
		assert.ok(sim.thread('a').limit);
		assert.strictEqual(sim.thread('a').active, undefined);
		// The reset passed while Volt was closed: the first tick after startup resumes it.
		tickAt(sim, resetAt + 86_400_000, false);
		assert.ok(sim.thread('a').active);
	});
});

suite('Volt orchestrator: moving a chat between checkouts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an idle chat moves now; prompts sent meanwhile wait and run after the move', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		sim.complete('a');
		const mark = sim.effects.length;
		const decision = sim.run({ type: 'thread.move', threadId: 'a', move: move('m1') });
		assert.strictEqual(decision.outcome, 'started');
		assert.strictEqual(sim.thread('a').moving?.id, 'm1');
		assert.deepStrictEqual(sim.effectsOf('moveWorkspace', mark).map(effect => effect.move.id), ['m1']);
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'moving');

		const waiting = sim.submit('a', 'run pwd');
		assert.strictEqual(waiting.decision.outcome, 'queued');
		assert.strictEqual(sim.thread('a').active, undefined);
		sim.run({ type: 'move.finished', threadId: 'a', result: { id: 'm1', at: sim.now, ok: true, label: 'worktree volt/x', path: '/wt/x', branch: 'volt/x', files: 2 } });
		assert.strictEqual(sim.thread('a').moving, undefined);
		assert.strictEqual(sim.thread('a').lastMove?.path, '/wt/x');
		assert.strictEqual(sim.thread('a').active?.id, waiting.turnId, 'the next turn runs in the new checkout');
	});

	test('a running turn finishes before the move (queued), or is stopped first (stop); the move goes before queued prompts', () => {
		const sim = new OrchSim();
		sim.submit('a', 'working');
		sim.start('a');
		const queued = sim.submit('a', 'after');
		const decision = sim.run({ type: 'thread.move', threadId: 'a', move: move('m1') });
		assert.strictEqual(decision.outcome, 'queued');
		assert.strictEqual(sim.thread('a').pendingMove?.id, 'm1');
		assert.strictEqual(sim.thread('a').active?.phase, 'running', 'the turn keeps going');
		sim.settle('a', 'done');
		assert.strictEqual(sim.thread('a').moving?.id, 'm1');
		assert.strictEqual(sim.thread('a').active, undefined, 'the queued prompt waits for the move');
		sim.run({ type: 'move.finished', threadId: 'a', result: { id: 'm1', at: sim.now, ok: true, label: 'x' } });
		assert.strictEqual(sim.thread('a').active?.id, queued.turnId);

		const stop = new OrchSim();
		stop.submit('b', 'working');
		stop.start('b');
		const mark = stop.effects.length;
		stop.run({ type: 'thread.move', threadId: 'b', move: move('m2'), stop: true });
		assert.strictEqual(stop.thread('b').active?.phase, 'cancelling');
		assert.strictEqual(stop.effectsOf('cancelTurn', mark).length, 1);
		stop.settle('b', 'cancelled');
		assert.strictEqual(stop.thread('b').moving?.id, 'm2');
	});

	test('a pending move can be cancelled; a second move while one runs is refused; subagent chats do not move', () => {
		const sim = new OrchSim();
		sim.submit('a', 'working');
		sim.start('a');
		sim.run({ type: 'thread.move', threadId: 'a', move: move('m1') });
		sim.run({ type: 'move.cancel', threadId: 'a' });
		assert.strictEqual(sim.thread('a').pendingMove, undefined);
		sim.settle('a', 'done');
		assert.strictEqual(sim.thread('a').moving, undefined);

		sim.run({ type: 'thread.move', threadId: 'a', move: move('m2') });
		const second = sim.run({ type: 'thread.move', threadId: 'a', move: move('m3') });
		assert.match(second.rejected ?? '', /already moving/);

		sim.submit('p', 'delegate');
		sim.start('p');
		sim.spawn('p', 'research', { taskId: 't-1', childId: 'c1' });
		assert.ok(sim.run({ type: 'thread.move', threadId: 'c1', move: move('m4') }).rejected);
	});

	test('a failed move leaves the chat where it was and holds prompts written for the new place', () => {
		const sim = new OrchSim();
		sim.submit('a', 'working');
		sim.start('a');
		sim.run({ type: 'thread.move', threadId: 'a', move: move('m1') });
		sim.submit('a', 'continue in the worktree');
		sim.settle('a', 'done');
		sim.run({ type: 'move.finished', threadId: 'a', result: { id: 'm1', at: sim.now, ok: false, label: 'x', error: 'setup failed' } });
		assert.strictEqual(sim.thread('a').lastMove?.ok, false);
		assert.strictEqual(sim.thread('a').pause, 'failed');
		assert.strictEqual(sim.thread('a').active, undefined);
		// A stale finish for another move does nothing.
		assert.deepStrictEqual(sim.run({ type: 'move.finished', threadId: 'a', result: { id: 'zzz', at: sim.now, ok: true, label: 'x' } }).events, []);
	});

	test('a restart during a move ends it as failed; a pending one starts once the interrupted turn is settled', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		sim.complete('a');
		sim.run({ type: 'thread.move', threadId: 'a', move: move('m1') });
		assert.ok(isRootLive(sim.state, 'a'));
		const loaded = mergeRoot(emptyOrchState(), parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, 'a', [], 0))))!);
		assert.deepStrictEqual(loaded.threads.a, sim.state.threads.a);
		sim.state = loaded;
		sim.run({ type: 'recover' });
		assert.strictEqual(sim.thread('a').moving, undefined);
		assert.strictEqual(sim.thread('a').lastMove?.ok, false);

		const pending = new OrchSim();
		pending.submit('b', 'working');
		pending.start('b');
		pending.run({ type: 'thread.move', threadId: 'b', move: move('m2') });
		pending.run({ type: 'recover' });
		assert.strictEqual(pending.thread('b').moving?.id, 'm2', 'the requested move runs after the restart');
		assert.deepStrictEqual(scheduleOrch(pending.state, pending.now), []);
	});

	test('a parked chat can move; the move waits for nothing and the park stays', () => {
		const sim = new OrchSim();
		sim.submit('a', 'go');
		hitLimit(sim, 'a', sim.now + 60_000);
		sim.run({ type: 'thread.move', threadId: 'a', move: move('m1') });
		assert.strictEqual(sim.thread('a').moving?.id, 'm1');
		assert.deepStrictEqual(tickAt(sim, sim.now + 3_600_000).events, [], 'no resume while the files move');
		sim.run({ type: 'move.finished', threadId: 'a', result: { id: 'm1', at: sim.now, ok: true, label: 'x' } });
		tickAt(sim, sim.now + 3_600_000);
		assert.ok(sim.thread('a').active);
	});
});
