/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isLiveTaskState, isTerminalTaskState } from '../../../common/orchestration/agentTasks.js';
import { DEFAULT_ORCH_LIMITS, emptyOrchState, IOrchLimits, IOrchState, OrchCommandBody, OrchEffect, OrchOutcome } from '../../../common/orchestration/orchestrator.js';
import { extractRoot, mergeRoot, parseRootSnapshot, rootIdsOf } from '../../../common/orchestration/orchestratorCodec.js';
import { scheduleOrch } from '../../../common/orchestration/orchestratorDecider.js';
import { applyOrchEvents } from '../../../common/orchestration/orchestratorProjector.js';
import { threadStatus } from '../../../common/orchestration/orchestratorViews.js';
import { OrchSim, prompt, seededRandom } from './orchestratorSim.js';

/**
 * Chaos tests: seeded random interleavings of everything that can happen to the orchestrator
 * (users typing, the runtime starting and settling runs late, twice or for the wrong turn,
 * agents delegating and cancelling, harness subagents, approvals, handoffs, crashes, retried
 * commands), with invariants checked after every command and liveness checked at the end.
 */

const ROOTS = ['r0', 'r1', 'r2'];
/** `VOLT_CHAOS_SCALE=20` runs twenty times the seeds (a long hunt); default 1. */
const SCALE = Math.max(1, Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VOLT_CHAOS_SCALE) || 1);
const BRIEFS = ['research auth', 'write tests', 'fix the header', 'audit API', 'update docs'];
const MODELS = ['claude', 'cursor', 'gpt'];
const FILES = ['/repo/a.ts', '/repo/b.ts', '/repo/src/c.ts'];

interface IRuntimeRun {
	readonly threadId: string;
	readonly turnId?: string;
	readonly runId: string;
}

/** What the effect worker and the runtime would do, played out of order on purpose. */
class ChaosWorld {

	readonly sim: OrchSim;
	private effectCursor = 0;
	/** startTurn effects the runtime has not picked up yet. */
	readonly pendingStarts = new Map<string, string>();
	/** Runs the runtime has started and not settled. */
	readonly runs = new Map<string, IRuntimeRun>();
	readonly pendingWorktrees = new Set<string>();
	readonly history: OrchCommandBody[] = [];
	private runCounter = 0;
	private toolCounter = 0;
	private readonly usedCommandIds: string[] = [];

	constructor(readonly random: () => number, limits: IOrchLimits) {
		this.sim = new OrchSim(limits);
	}

	pick<T>(items: readonly T[]): T | undefined {
		return items.length ? items[Math.floor(this.random() * items.length)] : undefined;
	}

	chance(p: number): boolean {
		return this.random() < p;
	}

	run(body: OrchCommandBody, id?: string): void {
		this.history.push(body);
		const commandId = id ?? `k${this.history.length}`;
		this.usedCommandIds.push(commandId);
		this.sim.run(body, commandId);
		this.absorbEffects();
	}

	/** Effects are consumed like the worker would: starts become runtime work, cancels end runs. */
	private absorbEffects(): void {
		const effects = this.sim.effects.slice(this.effectCursor);
		this.effectCursor = this.sim.effects.length;
		for (const effect of effects) {
			this.onEffect(effect);
		}
	}

	private onEffect(effect: OrchEffect): void {
		switch (effect.kind) {
			case 'startTurn':
				this.pendingStarts.set(effect.threadId, effect.turn.id);
				break;
			case 'cancelTurn': {
				// The worker: a turn the runtime never took is settled as cancelled right away.
				const pending = this.pendingStarts.get(effect.threadId);
				if (pending === effect.turnId) {
					this.pendingStarts.delete(effect.threadId);
					this.run({ type: 'run.settled', threadId: effect.threadId, turnId: effect.turnId, outcome: 'cancelled' });
				}
				// A started run settles as cancelled later (see `step`).
				break;
			}
			case 'prepareWorktree':
				this.pendingWorktrees.add(effect.taskId);
				break;
			case 'steer':
			case 'tasksChanged':
				break;
		}
	}

	state(): IOrchState {
		return this.sim.state;
	}

	threads(): string[] {
		return Object.keys(this.state().threads).sort();
	}

	activeThreads(): string[] {
		return this.threads().filter(id => this.state().threads[id].active);
	}

	/** One random thing happens. */
	step(): void {
		const r = this.random();
		const state = this.state();
		if (r < 0.14) {
			const root = this.pick(ROOTS)!;
			const delivery = this.pick(['auto', 'auto', 'auto', 'queue', 'now'] as const)!;
			this.run({ type: 'thread.submit', threadId: root, turnId: this.sim.nextId('u'), prompt: prompt(`msg ${this.history.length}`, this.chance(0.2) ? { modelRef: this.pick(MODELS) } : {}), delivery, canSteer: this.chance(0.3) });
		} else if (r < 0.30) {
			// The runtime picks up a dispatched turn (sometimes for a turn that is no longer current).
			const entry = this.pick([...this.pendingStarts.entries()]);
			if (entry) {
				const [threadId, turnId] = entry;
				this.pendingStarts.delete(threadId);
				const runId = `run${++this.runCounter}`;
				this.runs.set(runId, { threadId, turnId, runId });
				this.run({ type: 'run.started', threadId, runId, turnId, steerable: this.chance(0.3) });
				if (this.chance(0.1)) {
					this.run({ type: 'run.started', threadId, runId, turnId });
				}
				if (this.state().threads[threadId]?.active?.runId !== runId) {
					// The orchestrator refused the run (its turn already ended): the worker stops it.
					this.runs.delete(runId);
				}
			}
		} else if (r < 0.46) {
			// A run settles (cancelling runs always settle as cancelled).
			const run = this.pick([...this.runs.values()]);
			if (run) {
				this.runs.delete(run.runId);
				const active = this.state().threads[run.threadId]?.active;
				const outcome: OrchOutcome = active?.runId === run.runId && active.phase === 'cancelling'
					? 'cancelled'
					: this.pick(['done', 'done', 'done', 'done', 'failed', 'cancelled'] as const)!;
				this.run({ type: 'run.settled', threadId: run.threadId, runId: run.runId, turnId: run.turnId, outcome, reply: `reply ${run.runId}`, ...(outcome === 'failed' ? { error: 'boom' } : {}) });
				if (this.chance(0.1)) {
					// A duplicate settle arrives late.
					this.run({ type: 'run.settled', threadId: run.threadId, runId: run.runId, turnId: run.turnId, outcome: 'done' });
				}
			}
		} else if (r < 0.56) {
			// An agent delegates from a running turn.
			const parent = this.pick(this.activeThreads());
			if (parent) {
				const taskId = this.sim.nextId('t-');
				this.run({
					type: 'task.spawn',
					spawn: {
						parentId: parent,
						brief: this.pick(BRIEFS)!,
						title: 'task',
						role: 'general',
						origin: this.chance(0.2) ? 'user' : 'agent',
						isolation: this.chance(0.15) ? 'worktree' : 'shared',
						taskId,
						childId: `child-${taskId}`,
						childPrompt: prompt('brief'),
						...(this.chance(0.5) ? { modelRef: this.pick(MODELS) } : {}),
						...(this.chance(0.3) ? { clientRequestId: `req-${Math.floor(this.random() * 4)}` } : {}),
					},
				});
			}
		} else if (r < 0.61) {
			const task = this.pick(Object.values(state.tasks));
			if (task) {
				this.run({ type: 'task.cancel', taskId: task.id });
			}
		} else if (r < 0.65) {
			const task = this.pick(Object.values(state.tasks).filter(candidate => candidate.source === 'volt'));
			if (task && state.threads[task.childId!]) {
				this.run({ type: 'task.message', taskId: task.id, turnId: this.sim.nextId('f'), prompt: prompt('follow-up') });
			}
		} else if (r < 0.68) {
			const ids = Object.values(state.tasks).filter(() => this.chance(0.5)).map(task => task.id);
			this.run({ type: 'task.ack', taskIds: ids });
		} else if (r < 0.73) {
			const threadId = this.pick(this.activeThreads());
			if (threadId) {
				const thread = state.threads[threadId];
				if (thread.inputs.length && this.chance(0.6)) {
					this.run({ type: 'input.closed', threadId, inputId: thread.inputs[0].id });
				} else {
					this.run({ type: 'input.opened', threadId, inputId: this.sim.nextId('in'), kind: this.chance(0.5) ? 'approval' : 'question' });
				}
			}
		} else if (r < 0.79) {
			// Harness subagents inside running turns.
			const threadId = this.pick(this.activeThreads());
			if (threadId) {
				const harness = Object.values(state.tasks).filter(task => task.source === 'harness' && task.parentId === threadId && isLiveTaskState(task.state));
				const which = this.random();
				if (which < 0.4 || !harness.length) {
					this.run({ type: 'harness.started', threadId, toolCallId: `call${++this.toolCounter}`, title: 'Explore', kind: 'explore' });
				} else if (which < 0.7) {
					this.run({ type: 'harness.progress', threadId, toolCallId: this.pick(harness)!.toolCallId!, activity: `step ${this.history.length}` });
				} else {
					this.run({ type: 'harness.ended', threadId, toolCallId: this.pick(harness)!.toolCallId!, ok: this.chance(0.8) });
				}
			}
		} else if (r < 0.84) {
			// Queue editing.
			const threadId = this.pick(this.threads().filter(id => state.threads[id].queue.length));
			if (threadId) {
				const queue = state.threads[threadId].queue;
				const item = this.pick(queue)!;
				const op = this.random();
				if (op < 0.2) {
					this.run({ type: 'queue.remove', threadId, itemId: item.id });
				} else if (op < 0.4) {
					this.run({ type: 'queue.reorder', threadId, ids: [...queue].reverse().map(entry => entry.id) });
				} else if (op < 0.6) {
					this.run({ type: 'queue.hold', threadId, itemId: item.id, held: !item.held });
				} else if (op < 0.7) {
					this.run({ type: 'queue.update', threadId, itemId: item.id, prompt: prompt('edited') });
				} else if (op < 0.85) {
					this.run({ type: 'queue.sendNow', threadId, itemId: item.id, canSteer: this.chance(0.3) });
				} else {
					this.run({ type: 'queue.clear', threadId });
				}
			}
		} else if (r < 0.88) {
			const threadId = this.pick(this.threads());
			if (threadId) {
				this.run({ type: 'turn.cancel', threadId, ...(this.chance(0.5) ? { cascade: this.chance(0.5) ? 'turn' : 'all' } : {}) } as OrchCommandBody);
			}
		} else if (r < 0.90) {
			const threadId = this.pick(this.threads().filter(id => state.threads[id].pause));
			if (threadId) {
				this.run({ type: 'queue.resume', threadId });
			}
		} else if (r < 0.92) {
			const threadId = this.pick(this.threads());
			if (threadId) {
				const to = this.pick(MODELS)!;
				this.run({ type: 'thread.handoff', threadId, to, toLabel: to.toUpperCase(), by: this.chance(0.5) ? 'agent' : 'user' });
			}
		} else if (r < 0.94) {
			const taskId = this.pick([...this.pendingWorktrees]);
			if (taskId) {
				this.pendingWorktrees.delete(taskId);
				this.run(this.chance(0.8)
					? { type: 'task.worktree', taskId, path: `/wt/${taskId}`, branch: `volt/${taskId}` }
					: { type: 'task.error', taskId, error: 'git worktree add failed' });
			}
		} else if (r < 0.96) {
			const threadId = this.pick(this.activeThreads());
			if (threadId) {
				this.run({ type: 'file.changed', threadId, path: this.pick(FILES)! });
			}
		} else if (r < 0.955) {
			const root = this.pick(ROOTS)!;
			this.run({ type: 'thread.block', threadId: root, reason: state.threads[root]?.blocked ? undefined : 'cloning' });
		} else if (r < 0.97) {
			// A watched pull request changed: Volt wakes the chat (or queues the news behind its work).
			const threadId = this.pick(this.chance(0.7) ? ROOTS : this.threads());
			if (threadId) {
				this.run({ type: 'thread.notify', threadId, turnId: this.sim.nextId('pr'), prompt: prompt(`pr update ${this.history.length}`) });
			}
		} else if (r < 0.975) {
			// A crash: every agent process is gone, then the orchestrator recovers.
			this.pendingStarts.clear();
			this.runs.clear();
			this.run({ type: 'recover' });
		} else if (r < 0.99) {
			// A retried command id must act at most once.
			// Receipts are bounded; only ids still inside the window must be recognized.
			const id = this.pick(this.usedCommandIds.slice(-Math.floor(this.sim.limits.receipts / 2)));
			if (id) {
				const before = this.state();
				this.sim.run({ type: 'queue.resume', threadId: 'r0' }, id);
				assert.strictEqual(this.state(), before, `command ${id} acted twice`);
			}
		} else {
			// An external run (Volt did not dispatch it) on an idle root.
			const root = this.pick(ROOTS.filter(id => state.threads[id] && !state.threads[id].active));
			if (root) {
				const runId = `ext${++this.runCounter}`;
				this.runs.set(runId, { threadId: root, runId });
				this.run({ type: 'run.started', threadId: root, runId });
			}
		}
	}

	/** Lets everything finish: the runtime completes every run, the user resumes and unblocks. */
	quiesce(): void {
		for (let round = 0; round < 2_000; round++) {
			const state = this.state();
			const run = [...this.runs.values()][0];
			if (run) {
				this.runs.delete(run.runId);
				this.run({ type: 'run.settled', threadId: run.threadId, runId: run.runId, turnId: run.turnId, outcome: 'done', reply: 'final' });
				continue;
			}
			const start = [...this.pendingStarts.entries()][0];
			if (start) {
				const [threadId, turnId] = start;
				this.pendingStarts.delete(threadId);
				const runId = `run${++this.runCounter}`;
				this.runs.set(runId, { threadId, turnId, runId });
				this.run({ type: 'run.started', threadId, runId, turnId });
				if (this.state().threads[threadId]?.active?.runId !== runId) {
					this.runs.delete(runId);
				}
				continue;
			}
			const worktree = [...this.pendingWorktrees][0];
			if (worktree) {
				this.pendingWorktrees.delete(worktree);
				this.run({ type: 'task.worktree', taskId: worktree, path: `/wt/${worktree}`, branch: `volt/${worktree}` });
				continue;
			}
			const held = this.threads().flatMap(id => state.threads[id].queue.filter(item => item.held).map(item => ({ id, item })))[0];
			if (held) {
				this.run({ type: 'queue.hold', threadId: held.id, itemId: held.item.id, held: false });
				continue;
			}
			const blocked = this.threads().find(id => state.threads[id].blocked === 'cloning');
			if (blocked) {
				this.run({ type: 'thread.block', threadId: blocked, reason: undefined });
				continue;
			}
			const paused = this.threads().find(id => state.threads[id].pause && !state.threads[id].active);
			if (paused) {
				this.run({ type: 'queue.resume', threadId: paused });
				continue;
			}
			const stuck = this.threads().find(id => state.threads[id].active && !this.isTracked(id));
			if (stuck) {
				// A dispatched turn whose start the world lost (a recovery raced it): the worker fails it.
				this.run({ type: 'dispatch.failed', threadId: stuck, turnId: state.threads[stuck].active!.id, error: 'lost' });
				continue;
			}
			return;
		}
		assert.fail('the world did not quiesce');
	}

	private isTracked(threadId: string): boolean {
		const active = this.state().threads[threadId]?.active;
		if (!active) {
			return true;
		}
		return this.pendingStarts.get(threadId) === active.id || [...this.runs.values()].some(run => run.threadId === threadId && (run.runId === active.runId || run.turnId === active.id));
	}
}

function checkInvariants(state: IOrchState, limits: IOrchLimits, context: string): void {
	const fail = (message: string) => assert.fail(`${context}: ${message}`);
	const runningVolt = Object.values(state.tasks).filter(task => task.source === 'volt' && (task.state === 'running' || task.state === 'waiting'));
	if (runningVolt.length > limits.runningTotal) {
		fail(`${runningVolt.length} subagents run at once (limit ${limits.runningTotal})`);
	}
	for (const thread of Object.values(state.threads)) {
		const ids = thread.queue.map(item => item.id);
		if (new Set(ids).size !== ids.length) {
			fail(`thread ${thread.id} has duplicate queue ids`);
		}
		if (thread.active && ids.includes(thread.active.id)) {
			fail(`thread ${thread.id} runs a turn that is still queued`);
		}
		if (!thread.active && thread.inputs.length) {
			fail(`thread ${thread.id} waits for input with no turn`);
		}
		if (thread.parentId && !state.threads[thread.parentId]) {
			fail(`thread ${thread.id} lost its parent ${thread.parentId}`);
		}
		const perParent = runningVolt.filter(task => task.parentId === thread.id).length;
		if (perParent > limits.runningPerParent) {
			fail(`thread ${thread.id} runs ${perParent} subagents (limit ${limits.runningPerParent})`);
		}
	}
	const requestKeys = new Set<string>();
	for (const task of Object.values(state.tasks)) {
		if (!state.threads[task.parentId]) {
			fail(`task ${task.id} lost its parent`);
		}
		if (task.depth > limits.maxDepth + (task.source === 'harness' ? 1 : 0)) {
			fail(`task ${task.id} is ${task.depth} deep`);
		}
		if (task.source === 'volt' && isLiveTaskState(task.state) && (!task.childId || !state.threads[task.childId])) {
			fail(`live task ${task.id} has no chat`);
		}
		if (task.state === 'queued' && task.childId && state.threads[task.childId]?.active && state.threads[task.childId].active!.phase !== 'cancelling') {
			fail(`queued task ${task.id} is running`);
		}
		if (task.source === 'harness' && isLiveTaskState(task.state)) {
			const parent = state.threads[task.parentId];
			if (parent?.active?.id !== task.parentTurnId) {
				fail(`harness task ${task.id} outlived its turn`);
			}
		}
		if (task.delivery === 'pending' && (task.source !== 'volt' || !isTerminalTaskState(task.state))) {
			fail(`task ${task.id} is pending delivery while ${task.state}`);
		}
		if (isTerminalTaskState(task.state) && task.childId) {
			const child = state.threads[task.childId];
			if (child?.active && child.active.phase !== 'cancelling') {
				fail(`finished task ${task.id} still runs a turn`);
			}
		}
		if (task.clientRequestId) {
			const key = `${task.parentId}\0${task.clientRequestId}`;
			if (requestKeys.has(key)) {
				fail(`two tasks for one client request ${task.clientRequestId}`);
			}
			requestKeys.add(key);
		}
	}
	if (scheduleOrch(state, 0, limits).length) {
		fail('the scheduler was not at a fixed point');
	}
}

function runChaos(seed: number, steps: number, limits: IOrchLimits): ChaosWorld {
	const world = new ChaosWorld(seededRandom(seed), limits);
	for (let index = 0; index < steps; index++) {
		world.step();
		checkInvariants(world.state(), limits, `seed ${seed} step ${index} after ${JSON.stringify(world.history.at(-1))}`);
	}
	world.quiesce();
	checkInvariants(world.state(), limits, `seed ${seed} after quiesce`);
	return world;
}

suite('Volt orchestrator: chaos', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const limits: IOrchLimits = { ...DEFAULT_ORCH_LIMITS, runningPerParent: 2, runningTotal: 3, finishedTasksPerRoot: 12 };

	test('invariants hold after every command, and everything finishes', function () {
		this.timeout(60_000 * SCALE);
		for (let seed = 1; seed <= 160 * SCALE; seed++) {
			const world = runChaos(seed, 260, limits);
			const state = world.state();
			for (const thread of Object.values(state.threads)) {
				assert.strictEqual(thread.active, undefined, `seed ${seed}: ${thread.id} still runs after quiesce`);
				assert.deepStrictEqual(thread.queue.filter(item => !item.held), [], `seed ${seed}: ${thread.id} kept a queue ${JSON.stringify({ thread, task: thread.taskId ? state.tasks[thread.taskId] : undefined })}`);
				assert.ok(!threadStatus(state, thread.id).busy, `seed ${seed}: ${thread.id} looks busy`);
			}
			for (const task of Object.values(state.tasks)) {
				assert.ok(isTerminalTaskState(task.state), `seed ${seed}: task ${task.id} is ${task.state} after quiesce ${JSON.stringify({ task, child: task.childId ? state.threads[task.childId] : undefined })}`);
				assert.notStrictEqual(task.delivery, 'pending', `seed ${seed}: task ${task.id} never reached its parent ${JSON.stringify({ task, parent: state.threads[task.parentId], parentTask: state.threads[task.parentId]?.taskId ? state.tasks[state.threads[task.parentId].taskId!] : undefined })}`);
			}
			assert.deepStrictEqual(state.conflicts, {}, `seed ${seed}: conflicts outlived their tasks`);
		}
	});

	test('the log replays to the same state, and every root survives a save and load', function () {
		this.timeout(60_000 * SCALE);
		for (let seed = 500; seed <= 500 + 40 * SCALE; seed++) {
			const world = runChaos(seed, 200, limits);
			const state = world.state();
			const replayed = applyOrchEvents(emptyOrchState(), world.sim.log.map(envelope => envelope.event));
			assert.deepStrictEqual(replayed.threads, state.threads, `seed ${seed}: threads differ after replay`);
			assert.deepStrictEqual(replayed.tasks, state.tasks, `seed ${seed}: tasks differ after replay`);
			let loaded = emptyOrchState();
			for (const rootId of rootIdsOf(state)) {
				const parsed = parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(state, rootId, world.sim.log, 0))));
				assert.ok(parsed, `seed ${seed}: root ${rootId} did not parse`);
				loaded = mergeRoot(loaded, parsed);
			}
			assert.deepStrictEqual(loaded.threads, state.threads, `seed ${seed}: threads differ after save and load`);
			assert.deepStrictEqual(loaded.tasks, state.tasks, `seed ${seed}: tasks differ after save and load`);
		}
	});

	test('the same seed gives the same state', () => {
		const a = runChaos(42, 300, limits).state();
		const b = runChaos(42, 300, limits).state();
		assert.deepStrictEqual(a, b);
	});

	test('a crash at any point recovers to a state with nothing running and nothing lost', function () {
		this.timeout(60_000 * SCALE);
		for (let seed = 900; seed <= 900 + 60 * SCALE; seed++) {
			const world = new ChaosWorld(seededRandom(seed), limits);
			const crashAt = 20 + (seed % 120);
			for (let index = 0; index < crashAt; index++) {
				world.step();
			}
			const before = world.state();
			const queued = Object.values(before.threads).reduce((count, thread) => count + thread.queue.length, 0);
			const undeliveredOrLive = Object.values(before.tasks).filter(task => task.source === 'volt' && (task.delivery === 'pending' || isLiveTaskState(task.state))).map(task => task.id);
			// Persist every root, "restart" from disk, recover.
			let loaded = emptyOrchState();
			for (const rootId of rootIdsOf(before)) {
				loaded = mergeRoot(loaded, parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(before, rootId, [], 0))))!);
			}
			world.sim.state = loaded;
			world.pendingStarts.clear();
			world.runs.clear();
			world.run({ type: 'recover' });
			const after = world.state();
			checkInvariants(after, limits, `seed ${seed} after recover`);
			assert.ok(Object.values(after.threads).every(thread => !thread.active), `seed ${seed}: something still runs after recovery`);
			assert.strictEqual(world.sim.effectsOf('startTurn').filter(effect => after.threads[effect.threadId]?.active?.id === effect.turn.id).length, 0, `seed ${seed}: recovery started work`);
			assert.strictEqual(Object.values(after.threads).reduce((count, thread) => count + thread.queue.length, 0), queued, `seed ${seed}: recovery lost queued prompts`);
			for (const id of undeliveredOrLive) {
				const task = after.tasks[id];
				assert.ok(task && (task.delivery === 'pending' || task.state === 'queued' || task.delivery === 'none'), `seed ${seed}: task ${id} lost its report`);
			}
			world.quiesce();
			checkInvariants(world.state(), limits, `seed ${seed} after recovery quiesce`);
		}
	});
});
