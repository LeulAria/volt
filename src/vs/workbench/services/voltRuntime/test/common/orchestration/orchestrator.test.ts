/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DEFAULT_ORCH_LIMITS, emptyOrchState } from '../../../common/orchestration/orchestrator.js';
import { extractRoot, isRootLive, mergeRoot, parseRootSnapshot } from '../../../common/orchestration/orchestratorCodec.js';
import { harnessTaskId, RESTART_RESUME_TEXT, scheduleOrch } from '../../../common/orchestration/orchestratorDecider.js';
import { applyOrchEvents } from '../../../common/orchestration/orchestratorProjector.js';
import { agentRow, dockModel, formatElapsed, lineage, threadStatus } from '../../../common/orchestration/orchestratorViews.js';
import { OrchSim, prompt } from './orchestratorSim.js';

suite('Volt orchestrator: turns and queue', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an idle chat starts the prompt; a busy one queues it and sends it when the turn ends', () => {
		const sim = new OrchSim();
		const first = sim.submit('a', 'one');
		assert.strictEqual(first.decision.outcome, 'started');
		assert.deepStrictEqual(sim.effectsOf('startTurn').map(effect => effect.turn.id), [first.turnId]);
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'starting');

		sim.start('a');
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'working');
		const second = sim.submit('a', 'two');
		assert.strictEqual(second.decision.outcome, 'queued');
		assert.deepStrictEqual(sim.state.threads.a.queue.map(item => item.id), [second.turnId]);

		const mark = sim.effects.length;
		sim.settle('a', 'done');
		assert.strictEqual(sim.state.threads.a.active?.id, second.turnId, 'the queued prompt runs as soon as the turn ends');
		assert.deepStrictEqual(sim.effectsOf('startTurn', mark).map(effect => effect.turn.id), [second.turnId]);
		assert.strictEqual(sim.state.threads.a.queue.length, 0);
	});

	test('a failed turn pauses the queue until the user resumes it', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		sim.start('a');
		const queued = sim.submit('a', 'two');
		sim.settle('a', 'failed', undefined, 'quota exceeded');
		assert.strictEqual(sim.thread('a').active, undefined);
		assert.strictEqual(sim.state.threads.a.pause, 'failed');
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'paused');

		sim.run({ type: 'queue.resume', threadId: 'a' });
		assert.strictEqual(sim.state.threads.a.active?.id, queued.turnId);
		assert.strictEqual(sim.state.threads.a.pause, undefined);
	});

	test('Send now steers an agent that takes messages, and otherwise stops it and goes first', () => {
		const sim = new OrchSim();
		sim.submit('native', 'one');
		sim.start('native');
		const steer = sim.submit('native', 'also do this', 'now', true);
		assert.strictEqual(steer.decision.outcome, 'steered');
		assert.strictEqual(sim.effectsOf('steer').length, 1);
		assert.strictEqual(sim.state.threads.native.queue.length, 0);

		sim.submit('acp', 'one');
		sim.start('acp');
		const later = sim.submit('acp', 'later');
		const urgent = sim.submit('acp', 'urgent', 'now', false);
		assert.deepStrictEqual(sim.state.threads.acp.queue.map(item => item.id), [urgent.turnId, later.turnId]);
		assert.strictEqual(sim.state.threads.acp.active?.phase, 'cancelling');
		assert.strictEqual(sim.effectsOf('cancelTurn').length, 1);
		assert.strictEqual(threadStatus(sim.state, 'acp').kind, 'stopping');
		sim.settle('acp', 'cancelled');
		assert.strictEqual(sim.state.threads.acp.active?.id, urgent.turnId);
	});

	test('the queue waits at a prompt being edited, keeps its order, and a duplicate command acts once', () => {
		const sim = new OrchSim();
		const active = () => sim.state.threads.a.active;
		sim.submit('a', 'one');
		sim.start('a');
		const held = sim.submit('a', 'held');
		const next = sim.submit('a', 'next');
		sim.run({ type: 'queue.hold', threadId: 'a', itemId: held.turnId, held: true });
		sim.settle('a', 'done');
		assert.strictEqual(active(), undefined, 'nothing jumps ahead of the prompt being edited');
		assert.deepStrictEqual(sim.state.threads.a.queue.map(item => item.id), [held.turnId, next.turnId]);
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'idle');
		sim.run({ type: 'queue.update', threadId: 'a', itemId: held.turnId, prompt: prompt('held, edited') });
		assert.strictEqual(active()?.id, held.turnId, 'putting it back sends it first');
		assert.strictEqual(active()?.prompt.text, 'held, edited');
		sim.complete('a');
		assert.strictEqual(active()?.id, next.turnId);

		// A prompt held further back lets the ones ahead of it go, then the queue waits at it.
		sim.complete('a');
		sim.submit('a', 'busy');
		sim.start('a');
		const first = sim.submit('a', 'first');
		const editing = sim.submit('a', 'editing');
		sim.submit('a', 'last');
		sim.run({ type: 'queue.hold', threadId: 'a', itemId: editing.turnId, held: true });
		sim.complete('a');
		assert.strictEqual(active()?.id, first.turnId);
		sim.complete('a');
		assert.strictEqual(active(), undefined);
		assert.deepStrictEqual(sim.state.threads.a.queue.map(item => item.prompt.text), ['editing', 'last']);

		const before = sim.state;
		const decision = sim.run({ type: 'queue.remove', threadId: 'a', itemId: editing.turnId }, 'same-id');
		assert.deepStrictEqual(decision.events.filter(event => event.type === 'queue.removed').map(event => event.itemId), [editing.turnId, active()?.id]);
		const again = sim.run({ type: 'queue.remove', threadId: 'a', itemId: editing.turnId }, 'same-id');
		assert.strictEqual(again.outcome, 'duplicate');
		assert.notStrictEqual(before, sim.state);
		assert.strictEqual(active()?.prompt.text, 'last', 'with it gone the queue moves on');
	});

	test('a notification wakes an idle chat, waits behind a running turn, and never interrupts it', () => {
		const sim = new OrchSim();
		const wake = sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'pr-1', prompt: prompt('Checks failed on #12') });
		assert.strictEqual(wake.outcome, 'started');
		assert.strictEqual(sim.state.threads.a.active?.kind, 'notification');
		assert.strictEqual(sim.state.threads.a.wakeups, 1);
		sim.complete('a');

		sim.submit('a', 'user prompt');
		sim.start('a');
		const queued = sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'pr-2', prompt: prompt('A review came in') });
		assert.strictEqual(queued.outcome, 'queued');
		assert.notStrictEqual(sim.state.threads.a.active?.phase, 'cancelling', 'a running turn is never stopped for news');
		assert.strictEqual(sim.effectsOf('cancelTurn').length, 0);
		assert.deepStrictEqual(sim.state.threads.a.queue.map(item => [item.id, item.kind]), [['pr-2', 'notification']]);
		sim.complete('a');
		assert.strictEqual(sim.state.threads.a.active?.id, 'pr-2');
		assert.strictEqual(sim.state.threads.a.active?.kind, 'notification');
		assert.strictEqual(sim.state.threads.a.wakeups, 1, 'the user turn between reset the count');

		const again = sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'pr-2', prompt: prompt('A review came in') });
		assert.strictEqual(again.outcome, 'duplicate', 'a retried wake-up is not sent twice');
	});

	test('notifications wait for a paused or blocked chat, and stop after too many wake-ups in a row', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, maxWakeups: 3 });
		const thread = (id: string) => sim.state.threads[id];
		sim.submit('a', 'one');
		sim.start('a');
		sim.settle('a', 'failed', undefined, 'boom');
		assert.strictEqual(thread('a').pause, 'failed');
		const paused = sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'w1', prompt: prompt('news') });
		assert.strictEqual(paused.outcome, 'queued');
		assert.strictEqual(thread('a').active, undefined, 'a paused chat stays paused');
		sim.run({ type: 'queue.resume', threadId: 'a' });
		assert.strictEqual(thread('a').active?.id, 'w1');
		sim.complete('a');
		sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'w2', prompt: prompt('news') });
		sim.complete('a');
		sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'w3', prompt: prompt('news') });
		sim.complete('a');
		assert.strictEqual(thread('a').wakeups, 3);
		const refused = sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'w4', prompt: prompt('news') });
		assert.ok(refused.rejected, 'the fourth wake-up in a row waits for the user');
		assert.strictEqual(thread('a').active, undefined);
		sim.submit('a', 'carry on');
		sim.complete('a');
		assert.strictEqual(sim.run({ type: 'thread.notify', threadId: 'a', turnId: 'w5', prompt: prompt('news') }).outcome, 'started');

		sim.run({ type: 'thread.block', threadId: 'b', reason: 'cloning' });
		assert.strictEqual(sim.run({ type: 'thread.notify', threadId: 'b', turnId: 'b1', prompt: prompt('news') }).outcome, 'queued');
		sim.run({ type: 'thread.block', threadId: 'b', reason: undefined });
		assert.strictEqual(thread('b').active?.id, 'b1', 'it runs once the chat can');
	});

	test('a run Volt did not dispatch is adopted, so the queue waits for it', () => {
		const sim = new OrchSim();
		sim.run({ type: 'thread.upsert', threadId: 'a', title: 'A' });
		sim.run({ type: 'run.started', threadId: 'a', runId: 'r-ext' });
		assert.strictEqual(sim.state.threads.a.active?.kind, 'external');
		assert.strictEqual(sim.effectsOf('startTurn').length, 0, 'an adopted run is not started again');
		const queued = sim.submit('a', 'after');
		assert.strictEqual(queued.decision.outcome, 'queued');
		sim.run({ type: 'run.settled', threadId: 'a', runId: 'r-ext', outcome: 'done' });
		assert.strictEqual(sim.state.threads.a.active?.id, queued.turnId);
	});

	test('a stale settle for another run does not end the current turn', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		const runId = sim.start('a');
		sim.run({ type: 'run.settled', threadId: 'a', runId: 'old-run', outcome: 'cancelled' });
		assert.strictEqual(sim.state.threads.a.active?.runId, runId);
		sim.run({ type: 'run.settled', threadId: 'a', runId, outcome: 'done' });
		assert.strictEqual(sim.state.threads.a.active, undefined);
	});

	test('a dispatch that fails before the runtime takes it fails the turn', () => {
		const sim = new OrchSim();
		const { turnId } = sim.submit('a', 'one');
		sim.run({ type: 'dispatch.failed', threadId: 'a', turnId, error: 'No model is connected' });
		assert.strictEqual(sim.state.threads.a.last?.outcome, 'failed');
		assert.strictEqual(sim.state.threads.a.last?.error, 'No model is connected');
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'failed');
	});

	test('a blocked chat (cloning) queues prompts and sends them once it is ready', () => {
		const sim = new OrchSim();
		sim.run({ type: 'thread.block', threadId: 'a', reason: 'cloning' });
		const queued = sim.submit('a', 'one');
		assert.strictEqual(queued.decision.outcome, 'queued');
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'blocked');
		sim.run({ type: 'thread.block', threadId: 'a', reason: undefined });
		assert.strictEqual(sim.state.threads.a.active?.id, queued.turnId);
	});

	test('pending questions make the chat need input, and a settled turn clears them', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		sim.start('a');
		sim.run({ type: 'input.opened', threadId: 'a', inputId: 'q1', kind: 'question' });
		assert.strictEqual(threadStatus(sim.state, 'a').kind, 'needsInput');
		sim.settle('a', 'done');
		assert.deepStrictEqual(sim.state.threads.a.inputs, []);
	});

	test('a handoff waits for the turn to end, then moves the chat and its queue to the new model', () => {
		const sim = new OrchSim();
		sim.run({ type: 'thread.upsert', threadId: 'a', modelRef: 'claude', modelLabel: 'Claude Opus 5.5' });
		sim.submit('a', 'one');
		sim.start('a');
		sim.run({ type: 'thread.submit', threadId: 'a', turnId: 'q', prompt: prompt('next', { modelRef: 'claude' }), delivery: 'auto' });
		sim.run({ type: 'thread.handoff', threadId: 'a', to: 'gpt', toLabel: 'GPT-6', by: 'agent', brief: 'finish the tests' });
		assert.strictEqual(sim.state.threads.a.modelRef, 'claude');
		assert.strictEqual(sim.state.threads.a.pendingHandoff?.to, 'gpt');
		sim.settle('a', 'done');
		assert.strictEqual(sim.state.threads.a.modelRef, 'gpt');
		assert.strictEqual(sim.state.threads.a.handoffs.at(-1)?.fromLabel, 'Claude Opus 5.5');
		assert.strictEqual(sim.state.threads.a.active?.prompt.modelRef, 'gpt', 'the queued prompt follows the chat to the new model');
	});
});

suite('Volt orchestrator: subagents', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a delegated task starts its own chat with the brief', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'build it');
		sim.start('parent');
		const decision = sim.spawn('parent', 'Write the README', { title: 'README', modelRef: 'grok', modelLabel: 'Grok' });
		const task = sim.state.tasks[decision.taskId!];
		assert.strictEqual(task.state, 'running');
		const child = sim.state.threads[task.childId!];
		assert.strictEqual(child.parentId, 'parent');
		assert.strictEqual(child.rootId, 'parent');
		assert.strictEqual(child.active?.kind, 'brief');
		assert.ok(child.active?.prompt.text.includes('<task>'));
		assert.ok(sim.effectsOf('startTurn').some(effect => effect.threadId === child.id));
	});

	test('limits hold extra subagents in a queue and start them as slots free up', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, runningPerParent: 2 });
		sim.submit('parent', 'go');
		sim.start('parent');
		const ids = ['a', 'b', 'c', 'd'].map(name => sim.spawn('parent', `task ${name}`).taskId!);
		assert.deepStrictEqual(ids.map(id => sim.state.tasks[id].state), ['running', 'running', 'queued', 'queued']);
		assert.strictEqual(sim.state.threads[sim.childOf(ids[2])].active, undefined, 'a queued subagent does not run');
		sim.complete(sim.childOf(ids[0]));
		assert.deepStrictEqual(ids.map(id => sim.state.tasks[id].state), ['completed', 'running', 'running', 'queued']);
	});

	test('a parent that went idle wakes up with its subagents\' reports', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const one = sim.spawn('parent', 'research one').taskId!;
		const two = sim.spawn('parent', 'research two').taskId!;
		sim.settle('parent', 'done');
		assert.strictEqual(threadStatus(sim.state, 'parent').kind, 'delegating');
		assert.strictEqual(threadStatus(sim.state, 'parent').busy, false, 'running subagents do not make the chat look busy');

		sim.complete(sim.childOf(one), 'done', 'Found the bug in auth.ts:12');
		const notification = sim.state.threads.parent.active;
		assert.strictEqual(notification?.kind, 'notification');
		assert.deepStrictEqual(notification?.taskIds, [one]);
		assert.ok(notification?.prompt.text.includes('Found the bug in auth.ts:12'));
		assert.ok(notification?.prompt.text.includes('Still running'), 'the parent knows another report is coming');
		assert.strictEqual(sim.state.tasks[one].delivery, 'delivered');
		assert.strictEqual(sim.state.tasks[two].state, 'running', 'a sibling finishing does not finish the other');

		sim.complete('parent');
		sim.complete(sim.childOf(two), 'done', 'second report');
		assert.deepStrictEqual(sim.state.threads.parent.active?.taskIds, [two]);
	});

	test('reports wait for a busy parent and go before its queued prompts', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'look into it').taskId!;
		const queued = sim.submit('parent', 'and then this');
		sim.complete(sim.childOf(task), 'done', 'report');
		assert.strictEqual(sim.state.tasks[task].delivery, 'pending');
		assert.notStrictEqual(sim.state.threads.parent.active?.kind, 'notification');
		sim.settle('parent', 'done');
		assert.strictEqual(sim.state.threads.parent.active?.kind, 'notification');
		sim.complete('parent');
		assert.strictEqual(sim.state.threads.parent.active?.id, queued.turnId);
	});

	test('a report the parent read itself is not delivered again', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'check').taskId!;
		sim.complete(sim.childOf(task), 'done', 'r');
		sim.run({ type: 'task.ack', taskIds: [task] });
		sim.settle('parent', 'done');
		assert.strictEqual(sim.state.threads.parent.active, undefined);
		assert.strictEqual(sim.state.tasks[task].delivery, 'acknowledged');
	});

	test('a subagent waiting for the user is surfaced and does not stall its siblings', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const asking = sim.spawn('parent', 'asks a question').taskId!;
		const other = sim.spawn('parent', 'works alone').taskId!;
		sim.start(sim.childOf(asking));
		sim.run({ type: 'input.opened', threadId: sim.childOf(asking), inputId: 'q', kind: 'question' });
		assert.strictEqual(sim.state.tasks[asking].state, 'waiting');
		assert.strictEqual(threadStatus(sim.state, 'parent').waiting, 1);
		assert.strictEqual(dockModel(sim.state, 'parent').waiting, 1);
		sim.complete(sim.childOf(other));
		assert.strictEqual(sim.state.tasks[other].state, 'completed');
		sim.run({ type: 'input.closed', threadId: sim.childOf(asking), inputId: 'q' });
		assert.strictEqual(sim.state.tasks[asking].state, 'running');
	});

	test('Stop cascades to the subagents the chat started, and their own children', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const child = sim.spawn('parent', 'level one').taskId!;
		const childThread = sim.childOf(child);
		sim.start(childThread);
		const grandchild = sim.spawn(childThread, 'level two').taskId!;
		sim.run({ type: 'turn.cancel', threadId: 'parent', cascade: 'turn' });
		assert.strictEqual(sim.state.tasks[child].state, 'cancelled');
		assert.strictEqual(sim.state.tasks[grandchild].state, 'cancelled');
		assert.strictEqual(sim.state.threads[childThread].active?.phase, 'cancelling');
		assert.strictEqual(sim.state.tasks[child].delivery, 'none', 'a cancelled task does not wake its parent');
		sim.settle(childThread, 'cancelled');
		sim.settle('parent', 'cancelled');
		assert.strictEqual(sim.state.threads.parent.active, undefined);
	});

	test('a retried or repeated delegation returns the task already working on it', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const first = sim.spawn('parent', 'Audit the API', { clientRequestId: 'k1' }).taskId!;
		assert.deepStrictEqual(sim.spawn('parent', 'something else', { clientRequestId: 'k1' }), { events: [], taskId: first, reused: true });
		assert.strictEqual(sim.spawn('parent', '  audit   the api ').taskId, first);
		assert.notStrictEqual(sim.spawn('parent', 'Audit the API', { modelRef: 'other-model' }).taskId, first, 'another model is another opinion');
		assert.strictEqual(Object.values(sim.state.tasks).length, 2);
	});

	test('delegation depth is limited', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, maxDepth: 1 });
		sim.submit('parent', 'go');
		sim.start('parent');
		const child = sim.childOf(sim.spawn('parent', 'one').taskId!);
		sim.start(child);
		const deeper = sim.spawn(child, 'two');
		assert.ok(deeper.rejected?.includes('1 level deep'));
	});

	test('a follow-up to a finished subagent continues its chat and reports again', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'review').taskId!;
		sim.complete(sim.childOf(task), 'done', 'found 2 issues');
		sim.run({ type: 'task.ack', taskIds: [task] });
		sim.run({ type: 'task.message', taskId: task, turnId: 'f1', prompt: prompt('fix them') });
		assert.strictEqual(sim.state.tasks[task].state, 'running', 'a free slot starts the next round at once');
		assert.strictEqual(sim.state.tasks[task].rounds, 2);
		assert.strictEqual(sim.state.threads[sim.childOf(task)].active?.kind, 'followup');
		sim.complete(sim.childOf(task), 'done', 'fixed');
		assert.strictEqual(sim.state.tasks[task].result, 'fixed');
		assert.strictEqual(sim.state.tasks[task].delivery, 'pending');
	});

	test('a failed subagent reports its error to the parent', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'deploy').taskId!;
		sim.settle('parent', 'done');
		sim.start(sim.childOf(task));
		sim.settle(sim.childOf(task), 'failed', undefined, 'Provider error: 529 overloaded');
		assert.strictEqual(sim.state.tasks[task].state, 'failed');
		const note = sim.state.threads.parent.active;
		assert.strictEqual(note?.kind, 'notification');
		assert.ok(note?.prompt.text.includes('529 overloaded'));
		assert.strictEqual(dockModel(sim.state, 'parent').failed, 1);
	});

	test('harness subagents are tracked by their own Task call, and end with the parent turn', () => {
		const sim = new OrchSim();
		sim.submit('a', 'go');
		sim.start('a');
		sim.run({ type: 'harness.started', threadId: 'a', toolCallId: 'call-1', title: 'Explore auth', kind: 'explore' });
		sim.run({ type: 'harness.started', threadId: 'a', toolCallId: 'call-2', title: 'Explore billing', kind: 'explore' });
		sim.run({ type: 'harness.progress', threadId: 'a', toolCallId: 'call-1', activity: 'Read auth.ts' });
		sim.run({ type: 'harness.ended', threadId: 'a', toolCallId: 'call-1', ok: true, result: 'auth is fine' });
		assert.strictEqual(sim.state.tasks[harnessTaskId('call-1')].state, 'completed');
		assert.strictEqual(sim.state.tasks[harnessTaskId('call-2')].state, 'running', 'the sibling is still running');
		assert.strictEqual(sim.state.tasks[harnessTaskId('call-1')].steps, 1);
		sim.settle('a', 'done');
		assert.strictEqual(sim.state.tasks[harnessTaskId('call-2')].state, 'completed', 'nothing stays "running" after its turn');
		assert.strictEqual(sim.state.threads.a.active, undefined, 'harness subagents never trigger a notification turn');
		assert.strictEqual(sim.run({ type: 'task.cancel', taskId: harnessTaskId('call-2') }).events.length, 0);
	});

	test('parallel subagents editing the same file in one checkout raise a conflict until one ends', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const one = sim.spawn('parent', 'header').taskId!;
		const two = sim.spawn('parent', 'footer').taskId!;
		sim.run({ type: 'file.changed', threadId: sim.childOf(one), path: '/repo/src/layout.tsx' });
		assert.strictEqual(sim.conflicts('parent'), undefined);
		sim.run({ type: 'file.changed', threadId: sim.childOf(two), path: '/repo/src/layout.tsx' });
		assert.deepStrictEqual(sim.state.conflicts.parent?.map(conflict => conflict.path), ['/repo/src/layout.tsx']);
		assert.strictEqual(dockModel(sim.state, 'parent').conflicts.length, 1);
		sim.complete(sim.childOf(one));
		assert.strictEqual(sim.state.conflicts.parent, undefined);
	});

	test('a worktree subagent waits for its checkout before its first turn', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'refactor', { isolation: 'worktree' }).taskId!;
		assert.strictEqual(sim.effectsOf('prepareWorktree').length, 1);
		assert.strictEqual(sim.state.threads[sim.childOf(task)].active, undefined);
		sim.run({ type: 'task.worktree', taskId: task, path: '/wt/refactor', branch: 'volt/refactor' });
		assert.strictEqual(sim.state.threads[sim.childOf(task)].active?.kind, 'brief');
		assert.strictEqual(sim.state.tasks[task].worktreeBranch, 'volt/refactor');
	});

	test('a worktree that fails, even after the task stopped, unblocks its chat and drops what waited for it', () => {
		const sim = new OrchSim();
		const thread = (id: string) => sim.state.threads[id];
		sim.submit('parent', 'go');
		sim.start('parent');
		const live = sim.spawn('parent', 'refactor', { isolation: 'worktree' }).taskId!;
		sim.run({ type: 'task.error', taskId: live, error: 'git worktree add failed' });
		assert.strictEqual(sim.state.tasks[live].state, 'failed');
		assert.strictEqual(thread(sim.childOf(live)).blocked, undefined);

		const stopped = sim.spawn('parent', 'rename', { isolation: 'worktree' }).taskId!;
		sim.run({ type: 'task.cancel', taskId: stopped });
		sim.run({ type: 'task.message', taskId: stopped, turnId: 'f1', prompt: prompt('also this') });
		sim.run({ type: 'recover' });
		sim.run({ type: 'task.error', taskId: stopped, error: 'git worktree add failed' });
		assert.strictEqual(thread(sim.childOf(stopped)).blocked, undefined);
		assert.deepStrictEqual(thread(sim.childOf(stopped)).queue, [], 'nothing waits forever for a checkout that will not come');
	});
});

suite('Volt orchestrator: recovery and persistence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('after a restart nothing claims to run, queues wait, and parents hear about interrupted subagents', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'long job').taskId!;
		sim.start(sim.childOf(task));
		sim.submit('parent', 'queued');
		sim.run({ type: 'input.opened', threadId: 'parent', inputId: 'p', kind: 'approval' });
		sim.run({ type: 'harness.started', threadId: 'parent', toolCallId: 'h', title: 'Explore' });

		const mark = sim.effects.length;
		sim.run({ type: 'recover' });
		assert.strictEqual(sim.effectsOf('startTurn', mark).length, 0, 'recovery never starts work on its own');
		for (const thread of Object.values(sim.state.threads)) {
			assert.strictEqual(thread.active, undefined);
			assert.deepStrictEqual(thread.inputs, []);
		}
		assert.strictEqual(sim.state.threads.parent.pause, 'interrupted');
		assert.strictEqual(sim.state.tasks[task].state, 'interrupted');
		assert.strictEqual(sim.state.tasks[task].delivery, 'pending');
		assert.strictEqual(sim.state.tasks[harnessTaskId('h')].state, 'interrupted');
		assert.strictEqual(threadStatus(sim.state, 'parent').kind, 'interrupted');

		sim.run({ type: 'queue.resume', threadId: 'parent' });
		assert.strictEqual(sim.state.threads.parent.active?.kind, 'notification', 'resuming delivers the interrupted report first');
	});

	test('with subagents resuming, a delegated task that was running continues on its own and its report wakes the parent', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'long job').taskId!;
		const child = sim.childOf(task);
		const brief = sim.state.threads[child].active!.id;
		sim.start(child);
		sim.complete('parent', 'done', 'Started a subagent; its report will come back.');
		sim.run({ type: 'input.opened', threadId: child, inputId: 'q1', kind: 'question' });
		assert.strictEqual(sim.state.tasks[task].state, 'waiting');

		const mark = sim.effects.length;
		sim.run({ type: 'recover', resume: 'subagents' });
		const started = sim.effectsOf('startTurn', mark);
		assert.deepStrictEqual(started.map(effect => [effect.threadId, effect.turn.id, effect.turn.kind]), [[child, `${brief}~r1`, 'resume']]);
		assert.strictEqual(started[0].turn.prompt.text, RESTART_RESUME_TEXT);
		assert.strictEqual(sim.state.tasks[task].state, 'running', 'the question died with the agent; the task runs again');
		assert.strictEqual(sim.state.tasks[task].restarts, 1);
		assert.strictEqual(sim.state.threads[child].last?.outcome, 'interrupted');
		assert.strictEqual(sim.state.threads.parent.pause, undefined, 'the idle parent keeps waiting for the report');

		sim.complete(child, 'done', 'Finished after the restart.');
		assert.strictEqual(sim.state.tasks[task].state, 'completed');
		assert.strictEqual(sim.state.threads.parent.active?.kind, 'notification');
		assert.ok(sim.state.threads.parent.active?.prompt.text.includes('Finished after the restart.'));
	});

	test('a turn cut off before it reached the agent is sent again as it was, and a crash loop stops after two restarts', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'job').taskId!;
		const child = sim.childOf(task);
		sim.complete('parent');
		const brief = sim.state.threads[child].active!;
		assert.strictEqual(brief.phase, 'dispatching');

		sim.run({ type: 'recover', resume: 'subagents' });
		const again = sim.state.threads[child].active!;
		assert.strictEqual(again.kind, 'brief', 'the brief never reached the agent: it goes again');
		assert.strictEqual(again.prompt.text, brief.prompt.text);

		sim.start(child);
		sim.run({ type: 'recover', resume: 'subagents' });
		assert.strictEqual(sim.state.threads[child].active?.kind, 'resume');
		sim.start(child);
		sim.run({ type: 'recover', resume: 'subagents' });
		assert.strictEqual(sim.state.threads[child].active, undefined, 'a third restart in a row waits for the user');
		assert.strictEqual(sim.state.tasks[task].state, 'interrupted');
		assert.strictEqual(sim.state.tasks[task].delivery, 'pending');
	});

	test('resume all continues interrupted chats and keeps their queues moving; off continues nothing', () => {
		const sim = new OrchSim();
		const first = sim.submit('a', 'one').turnId;
		sim.start('a');
		const second = sim.submit('a', 'two').turnId;
		sim.run({ type: 'recover', resume: 'all' });
		assert.strictEqual(sim.state.threads.a.active?.id, `${first}~r1`);
		assert.strictEqual(sim.state.threads.a.pause, undefined);
		sim.complete('a');
		assert.strictEqual(sim.state.threads.a.active?.id, second, 'the queue goes on after the continued turn');

		sim.start('a');
		sim.run({ type: 'recover', resume: 'off' });
		assert.strictEqual(sim.state.threads.a.active, undefined);
		assert.strictEqual(sim.state.threads.a.pause, 'interrupted');
	});

	test('a review round is a new task that follows the previous one; an unknown or foreign round is refused', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const first = sim.spawn('parent', 'review the auth change', { role: 'review' }).taskId!;
		sim.complete(sim.childOf(first), 'done', '2 issues: missing null check, no test');
		const second = sim.spawn('parent', 'review again: both fixed', { role: 'review', previousTaskId: first });
		assert.strictEqual(second.rejected, undefined);
		const round = sim.state.tasks[second.taskId!];
		assert.strictEqual(round.previousTaskId, first);
		assert.strictEqual(round.iteration, 2);
		assert.notStrictEqual(round.childId, sim.state.tasks[first].childId, 'a new round runs in a fresh chat');
		assert.deepStrictEqual([agentRow(round).iteration, agentRow(round).role], [2, 'review'], 'its row reads "Review round 2"');
		assert.strictEqual(agentRow(sim.state.tasks[first]).iteration, undefined);
		const third = sim.spawn('parent', 'and again', { previousTaskId: second.taskId! });
		assert.strictEqual(sim.state.tasks[third.taskId!].iteration, 3);

		assert.match(sim.spawn('parent', 'x', { previousTaskId: 't-nope' }).rejected ?? '', /No task t-nope/);
		sim.submit('other', 'go');
		sim.start('other');
		assert.match(sim.spawn('other', 'x', { previousTaskId: first }).rejected ?? '', /No task/);
	});

	test('the event log replays to the same state', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		const task = sim.spawn('parent', 'job').taskId!;
		sim.submit('parent', 'queued');
		sim.complete(sim.childOf(task), 'done', 'r');
		sim.settle('parent', 'done');
		sim.complete('parent');
		const replayed = applyOrchEvents(emptyOrchState(), sim.log.map(envelope => envelope.event));
		assert.deepStrictEqual(replayed.threads, sim.state.threads);
		assert.deepStrictEqual(replayed.tasks, sim.state.tasks);
		assert.deepStrictEqual(sim.log.map(envelope => envelope.seq), sim.log.map((_, index) => index + 1));
	});

	test('a root survives a save and load, and damaged parts of a file are dropped one by one', () => {
		const sim = new OrchSim();
		sim.submit('parent', 'go');
		sim.start('parent');
		sim.spawn('parent', 'job');
		sim.submit('other', 'unrelated');
		const snapshot = extractRoot(sim.state, 'parent', sim.log, 5);
		const parsed = parseRootSnapshot(JSON.parse(JSON.stringify(snapshot)));
		assert.ok(parsed);
		const merged = mergeRoot(emptyOrchState(), parsed);
		assert.deepStrictEqual(Object.keys(merged.threads).sort(), Object.values(sim.state.threads).filter(thread => thread.rootId === 'parent').map(thread => thread.id).sort());
		assert.deepStrictEqual(merged.threads.parent, sim.state.threads.parent);
		assert.ok(isRootLive(merged, 'parent'));

		const damaged = JSON.parse(JSON.stringify(snapshot));
		damaged.threads.push({ id: 'broken' }, null, 42);
		damaged.tasks.push({ id: 'x', state: 'exploded' });
		const recovered = parseRootSnapshot(damaged);
		assert.strictEqual(recovered?.threads.length, snapshot.threads.length);
		assert.strictEqual(recovered?.tasks.length, snapshot.tasks.length);
		assert.strictEqual(parseRootSnapshot({ rootId: '../../etc', version: 1 }), undefined, 'ids that are not safe file names are refused');
	});

	test('a queued prompt held for editing when the window closed runs after a reload', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		sim.start('a');
		const held = sim.submit('a', 'being edited');
		sim.run({ type: 'queue.hold', threadId: 'a', itemId: held.turnId, held: true });
		const parsed = parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, 'a', sim.log, 5))));
		assert.ok(parsed);
		assert.deepStrictEqual(parsed.threads.find(thread => thread.id === 'a')?.queue.map(item => [item.id, !!item.held]), [[held.turnId, false]]);
	});

	test('the scheduler is idempotent after every command', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one');
		sim.submit('a', 'two');
		sim.start('a');
		sim.spawn('a', 'x');
		sim.settle('a', 'done');
		assert.deepStrictEqual(scheduleOrch(sim.state, sim.now), []);
	});
});

suite('Volt orchestrator: views', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lineage shows the parent from a subagent chat, running agents, and previous ones newest first', () => {
		const sim = new OrchSim();
		sim.run({ type: 'thread.upsert', threadId: 'parent', title: 'Reliable Multi-Agent Orchestration' });
		sim.submit('parent', 'go');
		sim.start('parent');
		const one = sim.spawn('parent', 'one', { title: 'Research paseo' }).taskId!;
		const two = sim.spawn('parent', 'two', { title: 'Research zed' }).taskId!;
		const three = sim.spawn('parent', 'three', { title: 'Research cline' }).taskId!;
		sim.complete(sim.childOf(one));
		sim.complete(sim.childOf(two));
		const view = lineage(sim.state, sim.childOf(three));
		assert.strictEqual(view.parent?.title, 'Reliable Multi-Agent Orchestration');
		assert.deepStrictEqual(view.running.map(row => row.title), []);
		assert.deepStrictEqual(view.previous.map(row => row.title), ['Research zed', 'Research paseo']);
		const fromParent = lineage(sim.state, 'parent');
		assert.deepStrictEqual(fromParent.running.map(row => row.title), ['Research cline']);
	});

	test('elapsed time reads like Cursor and T3', () => {
		assert.strictEqual(formatElapsed(40_000), '40s');
		assert.strictEqual(formatElapsed(74_000), '1m 14s');
		assert.strictEqual(formatElapsed(367_000), '6m 07s');
		assert.strictEqual(formatElapsed(3_720_000), '1h 02m');
	});
});
