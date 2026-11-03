/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { WORKFLOW_MAX_LOG_ENTRIES, createSimulationHost, startWorkflowRun } from '../../../common/workflows/workflowEngine.js';
import {
	IWorkflowDefinition, IWorkflowEdge, IWorkflowEngineHost, IWorkflowExecution, IWorkflowNode, IWorkflowNodeContext, IWorkflowNodeResult, IWorkflowRun, IWorkflowRunOptions,
	WorkflowNodeError, WorkflowRecord, WorkflowRunEvent, WorkflowValue,
} from '../../../common/workflows/workflowTypes.js';

/**
 * A virtual clock: delays resolve in due order, one per macrotask turn (after the engine's
 * microtasks settle), so timing is exact and tests take milliseconds.
 */
class FakeClock {
	time = 1000;
	private readonly timers: { at: number; seq: number; resolve: () => void; listener?: IDisposable }[] = [];
	private seq = 0;
	private scheduled = false;

	readonly now = () => this.time;

	readonly delay = (ms: number, token: CancellationToken): Promise<void> => new Promise<void>((resolve, reject) => {
		const timer: { at: number; seq: number; resolve: () => void; listener?: IDisposable } = { at: this.time + ms, seq: this.seq++, resolve };
		timer.listener = token.onCancellationRequested(() => {
			const index = this.timers.indexOf(timer);
			if (index >= 0) {
				this.timers.splice(index, 1);
			}
			timer.listener?.dispose();
			reject(new CancellationError());
		});
		this.timers.push(timer);
		this.schedule();
	});

	private schedule(): void {
		if (!this.scheduled) {
			this.scheduled = true;
			setTimeout(() => this.tick(), 0);
		}
	}

	private tick(): void {
		this.scheduled = false;
		if (!this.timers.length) {
			return;
		}
		this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
		const timer = this.timers.shift()!;
		this.time = Math.max(this.time, timer.at);
		timer.listener?.dispose();
		timer.resolve();
		if (this.timers.length) {
			this.schedule();
		}
	}
}

type NodeSpec = [id: string, type: string, config?: WorkflowRecord, extra?: Partial<IWorkflowNode>];

/** Edges as `from.port->to`. */
function workflow(nodes: readonly NodeSpec[], edges: readonly string[], extra: Partial<IWorkflowDefinition> = {}): IWorkflowDefinition {
	return {
		version: 1, id: 'wf', name: 'WF', trigger: { type: 'manual' },
		nodes: nodes.map(([id, type, config, more]) => ({ id, type, position: { x: 0, y: 0 }, config: config ?? {}, ...more })),
		edges: edges.map((spec): IWorkflowEdge => {
			const match = /^([^.]+)\.(.+)->(.+)$/.exec(spec)!;
			return { id: spec, from: match[1], port: match[2], to: match[3] };
		}),
		...extra,
	};
}

type Exec = (context: IWorkflowNodeContext) => IWorkflowNodeResult | Promise<IWorkflowNodeResult>;

function makeHost(clock: FakeClock, executors: { readonly [type: string]: Exec } = {}, extra: Partial<IWorkflowEngineHost> = {}): IWorkflowEngineHost {
	return {
		executor: type => executors[type] ? { execute: async context => executors[type](context) } : undefined,
		requestApproval: () => new Promise(() => { }),
		runSubworkflow: () => Promise.reject(new Error('No sub-workflows here')),
		now: clock.now,
		delay: clock.delay,
		newId: () => 'run-1',
		...extra,
	};
}

async function run(definition: IWorkflowDefinition, host: IWorkflowEngineHost, options: IWorkflowRunOptions, watch?: (execution: IWorkflowExecution, event: WorkflowRunEvent) => void): Promise<IWorkflowRun> {
	const execution = startWorkflowRun(definition, host, options);
	const listener = watch ? execution.onDidChange(event => watch(execution, event)) : undefined;
	try {
		return await execution.done;
	} finally {
		listener?.dispose();
		execution.dispose();
	}
}

function until(execution: IWorkflowExecution, predicate: (run: IWorkflowRun) => boolean): Promise<IWorkflowRun> {
	if (predicate(execution.run)) {
		return Promise.resolve(execution.run);
	}
	return new Promise(resolve => {
		const listener = execution.onDidChange(event => {
			if (predicate(event.run)) {
				listener.dispose();
				resolve(event.run);
			}
		});
	});
}

function states(run: IWorkflowRun): string[] {
	return run.steps.map(step => `${step.id}:${step.state}`);
}

function lastStep(run: IWorkflowRun, nodeId: string) {
	return [...run.steps].reverse().find(step => step.nodeId === nodeId);
}

function outputOf(run: IWorkflowRun, nodeId: string): WorkflowValue | undefined {
	return lastStep(run, nodeId)?.output;
}

const passing: Exec = () => ({ output: { exitCode: 0 }, port: 'passed' });

suite('Volt workflow engine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('linear run: templates, inputs, records, events, tokens, logs', async () => {
		const clock = new FakeClock();
		const definition = workflow(
			[['start', 'start'], ['check', 'shell', { command: 'echo {{ inputs.task }}' }], ['done', 'end', { output: '{{ nodes.check.stdout }}' }]],
			['start.next->check', 'check.passed->done'],
			{ inputs: [{ name: 'task', type: 'string', required: true }, { name: 'n', type: 'number', default: 2 }] },
		);
		const host = makeHost(clock, {
			shell: async context => {
				await clock.delay(500, context.token);
				context.reportTokens({ input: 10, output: 5, costUsd: 0.01 });
				context.log('info', `ran ${context.config.command}`);
				return { output: { exitCode: 0, stdout: 'hi' }, port: 'passed' };
			},
		});
		const kinds = new Set<string>();
		const result = await run(definition, host, { mode: 'execute', inputs: { task: 'hi', n: '3' } }, (_execution, event) => kinds.add(event.kind));
		assert.strictEqual(result.status, 'succeeded');
		assert.strictEqual(result.outcome, 'success');
		assert.strictEqual(result.endNodeId, 'done');
		assert.deepStrictEqual(states(result), ['start#1:success', 'check#1:success', 'done#1:success']);
		assert.deepStrictEqual(result.inputs, { task: 'hi', n: 3 }, 'inputs are coerced to their types');
		const check = lastStep(result, 'check')!;
		assert.deepStrictEqual(check.input, { payload: null, inputs: { task: 'hi', n: 3 } });
		assert.strictEqual(check.resolvedConfig?.command, 'echo hi');
		assert.strictEqual(check.port, 'passed');
		assert.strictEqual(check.startedAt, 1000);
		assert.strictEqual(check.finishedAt, 1500);
		assert.deepStrictEqual(check.tokens, { input: 10, output: 5, costUsd: 0.01 });
		assert.deepStrictEqual(result.tokens, { input: 10, output: 5, costUsd: 0.01 });
		assert.strictEqual(outputOf(result, 'done'), 'hi');
		assert.deepStrictEqual(result.traversed, ['start.next->check', 'check.passed->done']);
		assert.ok(result.logs.some(entry => entry.message === 'ran echo hi' && entry.nodeId === 'check' && entry.stepId === 'check#1'));
		assert.deepStrictEqual([...kinds].sort(), ['edge', 'log', 'run', 'step']);
		assert.strictEqual(result.startedAt, 1000);
		assert.strictEqual(result.finishedAt, 1500);

		const missing = await run(definition, host, { mode: 'execute' });
		assert.strictEqual(missing.status, 'failed');
		assert.match(missing.error!, /Missing required input "task"/);
		const simulated = await run(definition, createSimulationHost({ now: clock.now }), { mode: 'simulate', simulation: { speed: 0 } });
		assert.strictEqual(simulated.status, 'succeeded', 'simulations fill missing inputs');
		assert.strictEqual(simulated.inputs.task, '<task>');
	});

	test('if: the path not taken is skipped and a join does not wait for it', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'],
			['gate', 'if', { condition: 'inputs.n > 1' }],
			['a', 'transform', { fields: { v: 'A' } }],
			['b', 'transform', { fields: { v: 'B' } }],
			['c', 'transform', { fields: { v: '{{ input.v }}C' } }],
			['join', 'join'],
			['end', 'end', { output: '{{ input }}' }],
		], ['start.next->gate', 'gate.true->a', 'gate.false->b', 'b.next->c', 'a.next->join', 'c.next->join', 'join.next->end']);
		const high = await run(definition, makeHost(clock), { mode: 'execute', inputs: { n: 2 } });
		assert.strictEqual(high.status, 'succeeded');
		assert.deepStrictEqual(states(high), ['start#1:success', 'gate#1:success', 'b#1:skipped', 'c#1:skipped', 'a#1:success', 'join#1:success', 'end#1:success']);
		assert.deepStrictEqual(outputOf(high, 'gate'), { result: true });
		assert.deepStrictEqual(lastStep(high, 'a')!.input, { payload: null, inputs: { n: 2 } }, 'if passes its input through');
		assert.deepStrictEqual(outputOf(high, 'end'), { a: { v: 'A' } });

		const low = await run(definition, makeHost(clock), { mode: 'execute', inputs: { n: 0 } });
		assert.deepStrictEqual(outputOf(low, 'end'), { c: { v: 'BC' } });
		assert.strictEqual(lastStep(low, 'a')!.state, 'skipped');
	});

	test('switch picks the matching case, else default', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['route', 'switch', { value: 'inputs.kind', cases: ['bug', 'feature'] }],
			['bug', 'log', { message: 'bug' }], ['feature', 'log', { message: 'feature' }], ['other', 'log', { message: 'other' }],
		], ['start.next->route', 'route.bug->bug', 'route.feature->feature', 'route.default->other']);
		const feature = await run(definition, makeHost(clock), { mode: 'execute', inputs: { kind: 'feature' } });
		assert.deepStrictEqual(states(feature).slice(2).sort(), ['bug#1:skipped', 'feature#1:success', 'other#1:skipped']);
		assert.deepStrictEqual(outputOf(feature, 'route'), { value: 'feature', case: 'feature' });
		const unknown = await run(definition, makeHost(clock), { mode: 'execute', inputs: { kind: 'chore' } });
		assert.strictEqual(lastStep(unknown, 'other')!.state, 'success');
	});

	test('loop: bounded passes, while, and the fix-until-it-passes pattern', async () => {
		const clock = new FakeClock();
		const bounded = workflow([
			['start', 'start'], ['loop', 'loop', { max: 3 }], ['work', 'transform', { fields: { i: '{{ loop.index }}', of: '{{ loop.max }}' } }], ['end', 'end', { output: '{{ nodes.work.i }}' }],
		], ['start.next->loop', 'loop.repeat->work', 'work.next->loop', 'loop.exhausted->end']);
		const result = await run(bounded, makeHost(clock), { mode: 'execute' });
		assert.strictEqual(result.status, 'succeeded');
		const work = result.steps.filter(step => step.nodeId === 'work');
		assert.deepStrictEqual(work.map(step => [step.iteration, step.output]), [[0, { i: 0, of: 3 }], [1, { i: 1, of: 3 }], [2, { i: 2, of: 3 }]]);
		assert.deepStrictEqual(result.steps.filter(step => step.nodeId === 'loop').map(step => step.port), ['repeat', 'repeat', 'repeat', 'exhausted']);
		assert.strictEqual(outputOf(result, 'end'), 2);
		assert.strictEqual(result.steps.filter(step => step.nodeId === 'end').length, 1, 'nodes after exhausted wait for the loop to end');

		const whileLoop = workflow([
			['start', 'start'], ['loop', 'loop', { max: 10, while: 'vars.n < 2' }], ['inc', 'set_variables', { variables: { n: '{{ vars.n + 1 }}' } }], ['end', 'end'],
		], ['start.next->loop', 'loop.repeat->inc', 'inc.next->loop', 'loop.exhausted->end'], { variables: { n: 0 } });
		const counted = await run(whileLoop, makeHost(clock), { mode: 'execute' });
		assert.strictEqual(counted.steps.filter(step => step.nodeId === 'inc').length, 2);
		assert.strictEqual(counted.variables.n, 2);

		let checks = 0;
		const fixLoop = (alwaysFail: boolean) => workflow([
			['start', 'start'], ['loop', 'loop', { max: alwaysFail ? 2 : 3 }], ['fix', 'agent', { prompt: 'Fix: {{ input.stdout }}' }], ['check', 'shell', { command: 'npm test' }],
			['ok', 'end'], ['ko', 'end', { status: 'failure' }],
		], ['start.next->loop', 'loop.repeat->fix', 'fix.done->check', 'check.failed->loop', 'check.passed->ok', 'loop.exhausted->ko']);
		const executors = (alwaysFail: boolean): { [type: string]: Exec } => ({
			agent: context => ({ output: { summary: `fixed ${context.attempt}`, prompt: context.config.prompt } }),
			shell: () => ++checks < 3 || alwaysFail ? { output: { exitCode: 1, stdout: `failure ${checks}` }, port: 'failed' } : { output: { exitCode: 0, stdout: 'ok' }, port: 'passed' },
		});
		const fixed = await run(fixLoop(false), makeHost(clock, executors(false)), { mode: 'execute' });
		assert.strictEqual(fixed.status, 'succeeded');
		assert.strictEqual(fixed.endNodeId, 'ok');
		assert.deepStrictEqual(fixed.steps.filter(step => step.nodeId === 'check').map(step => step.state), ['failed', 'failed', 'success']);
		assert.deepStrictEqual(lastStep(fixed, 'fix')!.input, { exitCode: 1, stdout: 'failure 2' }, 'the failure comes back into the body through the loop');
		assert.strictEqual((outputOf(fixed, 'fix') as WorkflowRecord).prompt, 'Fix: failure 2');
		assert.ok(!fixed.steps.some(step => step.nodeId === 'ko'), 'exhausted never fired');

		checks = 0;
		const exhausted = await run(fixLoop(true), makeHost(clock, executors(true)), { mode: 'execute' });
		assert.strictEqual(exhausted.status, 'failed');
		assert.strictEqual(exhausted.outcome, 'failure');
		assert.strictEqual(exhausted.endNodeId, 'ko');
		assert.match(exhausted.error!, /Ended as a failure/);
	});

	test('the step budget stops runaway loops', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['loop', 'loop', { max: 100 }], ['work', 'log', { message: 'again' }],
		], ['start.next->loop', 'loop.repeat->work', 'work.next->loop'], { settings: { maxSteps: 5 } });
		const result = await run(definition, makeHost(clock), { mode: 'execute' });
		assert.strictEqual(result.status, 'failed');
		assert.strictEqual(result.error, 'Step budget exhausted (5 steps)');
		assert.strictEqual(result.steps.filter(step => step.state === 'success').length, 5);
	});

	test('fork and join: all and any, within the concurrency limit', async () => {
		const clock = new FakeClock();
		const durations: { [command: string]: number } = { p1: 300, p2: 100, p3: 200 };
		let active = 0;
		let peak = 0;
		const executors = {
			shell: async (context: IWorkflowNodeContext) => {
				active++;
				peak = Math.max(peak, active);
				try {
					await clock.delay(durations[context.config.command as string], context.token);
					return { output: { name: context.config.command }, port: 'passed' };
				} finally {
					active--;
				}
			},
		};
		const definition = (mode: 'all' | 'any') => workflow([
			['start', 'start'], ['fork', 'fork', { branches: 3 }],
			['p1', 'shell', { command: 'p1' }], ['p2', 'shell', { command: 'p2' }], ['p3', 'shell', { command: 'p3' }],
			['join', 'join', { mode }], ['end', 'end', { output: '{{ input }}' }],
		], ['start.next->fork', 'fork.branch1->p1', 'fork.branch2->p2', 'fork.branch3->p3', 'p1.passed->join', 'p2.passed->join', 'p3.passed->join', 'join.next->end'], { settings: { concurrency: 2 } });

		const all = await run(definition('all'), makeHost(clock, executors), { mode: 'execute' });
		assert.strictEqual(all.status, 'succeeded');
		assert.strictEqual(peak, 2);
		assert.deepStrictEqual(Object.keys(outputOf(all, 'end') as WorkflowRecord), ['p1', 'p2', 'p3']);
		assert.strictEqual(all.steps.filter(step => step.nodeId === 'join').length, 1);
		assert.strictEqual(lastStep(all, 'p3')!.startedAt, lastStep(all, 'p1')!.startedAt, 'p3 waits for a slot (queued, then running)');
		assert.strictEqual(all.finishedAt! - all.startedAt, 300);

		peak = 0;
		const any = await run(definition('any'), makeHost(clock, executors), { mode: 'execute' });
		assert.strictEqual(any.status, 'succeeded');
		assert.deepStrictEqual(outputOf(any, 'end'), { p2: { name: 'p2' } }, 'the first branch to arrive');
		assert.strictEqual(any.steps.filter(step => step.nodeId === 'end').length, 1);
		assert.deepStrictEqual(any.steps.filter(step => step.nodeId.startsWith('p')).map(step => step.state), ['success', 'success', 'success'], 'the other branches still finish');
	});

	test('for each: one pass per item, results, back-edges, empty lists, limits', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['each', 'for_each', { items: '{{ inputs.files }}' }],
			['shape', 'transform', { fields: { name: '{{ upper(item) }}', i: '{{ loop.index }}' } }],
			['end', 'end', { output: '{{ nodes.each.results }}' }],
		], ['start.next->each', 'each.item->shape', 'each.done->end']);
		const result = await run(definition, makeHost(clock), { mode: 'execute', inputs: { files: ['a', 'b', 'c'] } });
		assert.strictEqual(result.status, 'succeeded');
		assert.deepStrictEqual(result.steps.filter(step => step.nodeId === 'shape').map(step => step.iteration), [0, 1, 2]);
		assert.deepStrictEqual(outputOf(result, 'end'), [{ name: 'A', i: 0 }, { name: 'B', i: 1 }, { name: 'C', i: 2 }]);
		assert.strictEqual((outputOf(result, 'each') as WorkflowRecord).count, 3);

		const returning = workflow([
			['start', 'start'], ['each', 'for_each', { items: 'inputs.files', maxItems: 2 }],
			['shape', 'transform', { fields: { name: '{{ item }}' } }], ['say', 'template', { text: 'file {{ input.name }}' }],
			['end', 'end', { output: '{{ nodes.each.results }}' }],
		], ['start.next->each', 'each.item->shape', 'shape.next->say', 'say.next->each', 'each.done->end']);
		const back = await run(returning, makeHost(clock), { mode: 'execute', inputs: { files: ['x', 'y', 'z'] } });
		assert.deepStrictEqual(outputOf(back, 'end'), [{ text: 'file x' }, { text: 'file y' }], 'values sent back into the for-each are the results');
		assert.ok(back.logs.some(entry => /3 items, running the first 2/.test(entry.message)));

		const empty = await run(definition, makeHost(clock), { mode: 'execute', inputs: { files: [] } });
		assert.deepStrictEqual(outputOf(empty, 'end'), []);
		assert.strictEqual(lastStep(empty, 'shape')!.state, 'skipped');

		const wrong = await run(definition, makeHost(clock), { mode: 'execute', inputs: { files: { a: 1 } } });
		assert.strictEqual(wrong.status, 'failed');
		assert.match(wrong.error!, /Items must be a list/);
	});

	test('retries with exponential backoff for retryable errors only', async () => {
		const clock = new FakeClock();
		const definition = (retryable: boolean) => workflow([
			['start', 'start'], ['flaky', 'shell', { command: 'x' }, { retry: { attempts: 3, delayMs: 100 } }], ['end', 'end'],
		], ['start.next->flaky', 'flaky.passed->end']);
		const attempts: number[] = [];
		const host = (retryable: boolean) => makeHost(clock, {
			shell: context => {
				attempts.push(context.attempt);
				if (context.attempt < 3) {
					throw new WorkflowNodeError('busy', retryable);
				}
				return passing(context);
			},
		});
		const started = clock.time;
		const result = await run(definition(true), host(true), { mode: 'execute' });
		assert.strictEqual(result.status, 'succeeded');
		assert.deepStrictEqual(attempts, [1, 2, 3]);
		assert.strictEqual(lastStep(result, 'flaky')!.attempt, 3);
		assert.strictEqual(clock.time - started, 300, '100ms then 200ms');
		assert.deepStrictEqual(result.logs.filter(entry => entry.level === 'warn').map(entry => entry.message), ['Shell: attempt 1 failed (busy); retrying in 100ms', 'Shell: attempt 2 failed (busy); retrying in 200ms']);

		attempts.length = 0;
		const permanent = await run(definition(false), host(false), { mode: 'execute' });
		assert.strictEqual(permanent.status, 'failed');
		assert.deepStrictEqual(attempts, [1]);
		assert.strictEqual(permanent.error, 'Shell: busy');
	});

	test('node timeouts cancel the executor and can be retried', async () => {
		const clock = new FakeClock();
		const tokens: CancellationToken[] = [];
		const host = makeHost(clock, {
			shell: async context => {
				tokens.push(context.token);
				await clock.delay(10_000, context.token);
				return passing(context);
			},
		});
		const definition = (retry?: number) => workflow([['start', 'start'], ['slow', 'shell', { command: 'sleep' }, { timeoutMs: 1000, retry: retry ? { attempts: retry, delayMs: 50 } : undefined }], ['end', 'end']], ['start.next->slow', 'slow.passed->end']);
		const result = await run(definition(), host, { mode: 'execute' });
		assert.strictEqual(result.status, 'failed');
		assert.strictEqual(lastStep(result, 'slow')!.error, 'Timed out after 1s');
		assert.ok(tokens[0].isCancellationRequested, 'the executor\'s token is cancelled');
		assert.strictEqual(clock.time, 2000);

		tokens.length = 0;
		const retried = await run(definition(1), host, { mode: 'execute' });
		assert.strictEqual(lastStep(retried, 'slow')!.attempt, 2);
		assert.strictEqual(tokens.length, 2);
	});

	test('cancel mid-step: running steps are cancelled, nothing else runs', async () => {
		const clock = new FakeClock();
		const tokens: CancellationToken[] = [];
		let started: (() => void) | undefined;
		const host = makeHost(clock, {
			shell: async context => {
				tokens.push(context.token);
				started?.();
				// An executor that ignores its token: the engine stops waiting anyway.
				await new Promise(() => { });
				return passing(context);
			},
		});
		const definition = workflow([['start', 'start'], ['slow', 'shell', { command: 'x' }], ['end', 'end']], ['start.next->slow', 'slow.passed->end']);
		const execution = startWorkflowRun(definition, host, { mode: 'execute' });
		started = () => execution.cancel();
		const cancelled = await execution.done;
		execution.dispose();
		started = undefined;
		assert.strictEqual(cancelled.status, 'cancelled');
		assert.deepStrictEqual(states(cancelled), ['start#1:success', 'slow#1:cancelled']);
		assert.ok(tokens[0].isCancellationRequested);

		const source = new CancellationTokenSource();
		const viaToken = await run(definition, host, { mode: 'execute', token: source.token }, (_execution, event) => {
			if (event.kind === 'step' && event.step.nodeId === 'slow' && event.step.state === 'running') {
				source.cancel();
			}
		});
		source.dispose();
		assert.strictEqual(viaToken.status, 'cancelled');
	});

	test('approvals: host decisions, resolveApproval, timeouts, auto-approve in simulations', async () => {
		const clock = new FakeClock();
		const definition = (wired = true) => workflow([
			['start', 'start'], ['gate', 'approval', { title: 'Ship {{ inputs.v }}?', timeout: '1m' }], ['yes', 'end'], ['no', 'end', { status: 'failure' }],
		], ['start.next->gate', 'gate.approved->yes', ...(wired ? ['gate.rejected->no'] : [])]);
		const requests: string[] = [];
		const statuses = new Set<string>();
		const approved = await run(definition(), makeHost(clock, {}, { requestApproval: async request => { requests.push(request.title); return 'approve'; } }), { mode: 'execute', inputs: { v: '1.0' } }, (_execution, event) => statuses.add(event.run.status));
		assert.strictEqual(approved.status, 'succeeded');
		assert.deepStrictEqual(requests, ['Ship 1.0?']);
		assert.strictEqual((outputOf(approved, 'gate') as WorkflowRecord).decision, 'approve');
		assert.ok(statuses.has('waiting'), 'the run waits while the approval is open');

		const rejected = await run(definition(), makeHost(clock), { mode: 'execute' }, (execution, event) => {
			if (event.kind === 'step' && event.step.nodeId === 'gate' && event.step.state === 'waiting') {
				assert.strictEqual(event.step.waitingFor, 'Approval');
				execution.resolveApproval('gate', 'reject');
			}
		});
		assert.strictEqual(rejected.endNodeId, 'no');
		assert.strictEqual(lastStep(rejected, 'gate')!.port, 'rejected');

		const unanswered = await run(definition(), makeHost(clock), { mode: 'execute' });
		assert.strictEqual((outputOf(unanswered, 'gate') as WorkflowRecord).decision, 'timeout');
		assert.strictEqual(unanswered.endNodeId, 'no');

		const unwired = await run(definition(false), makeHost(clock, {}, { requestApproval: async () => 'reject' }), { mode: 'execute' });
		assert.strictEqual(unwired.status, 'failed');
		assert.strictEqual(unwired.error, 'Approval: Rejected');

		const auto = await run(definition(), createSimulationHost({ now: clock.now, delay: clock.delay }, { autoApprove: 'approve' }), { mode: 'simulate', simulation: { speed: 0, autoApprove: 'approve' } });
		assert.strictEqual(auto.endNodeId, 'yes');
		const hostOnly = await run(definition(), createSimulationHost({ now: clock.now }, { autoApprove: 'reject' }), { mode: 'simulate', simulation: { speed: 0 } });
		assert.strictEqual(hostOnly.endNodeId, 'no', 'createSimulationHost answers from autoApprove');
	});

	test('onError: continue, route, fail, the default, and failure ports returned by executors', async () => {
		const clock = new FakeClock();
		const definition = (onError: 'continue' | 'route' | 'fail' | undefined, wireFailed = true) => workflow([
			['start', 'start'], ['x', 'shell', { command: 'x' }, { onError }], ['p', 'log', { message: 'passed' }], ['f', 'log', { message: 'failed' }],
		], ['start.next->x', 'x.passed->p', ...(wireFailed ? ['x.failed->f'] : [])]);
		const throwing = makeHost(clock, { shell: () => { throw new WorkflowNodeError('boom', false, { exitCode: 2 }); } });
		const taken = (result: IWorkflowRun) => result.steps.filter(step => step.state === 'success' && (step.nodeId === 'p' || step.nodeId === 'f')).map(step => step.nodeId);

		const cont = await run(definition('continue'), throwing, { mode: 'execute' });
		assert.strictEqual(cont.status, 'succeeded');
		assert.deepStrictEqual(taken(cont), ['p']);
		assert.strictEqual(lastStep(cont, 'x')!.state, 'failed');
		assert.deepStrictEqual(lastStep(cont, 'p')!.input, { exitCode: 2 }, 'the error\'s output travels on');

		assert.deepStrictEqual(taken(await run(definition('route'), throwing, { mode: 'execute' })), ['f']);
		assert.deepStrictEqual(taken(await run(definition(undefined), throwing, { mode: 'execute' })), ['f'], 'by default a wired failure port catches errors');

		const failed = await run(definition('fail'), throwing, { mode: 'execute' });
		assert.strictEqual(failed.status, 'failed');
		assert.strictEqual(failed.error, 'Shell: boom');
		assert.deepStrictEqual(taken(failed), []);
		assert.strictEqual((await run(definition(undefined, false), throwing, { mode: 'execute' })).status, 'failed');

		const returning = makeHost(clock, { shell: () => ({ output: { exitCode: 1, error: 'tests failed' }, port: 'failed' }) });
		const routed = await run(definition(undefined), returning, { mode: 'execute' });
		assert.strictEqual(routed.status, 'succeeded');
		assert.deepStrictEqual(taken(routed), ['f']);
		assert.strictEqual(lastStep(routed, 'x')!.state, 'failed');
		assert.strictEqual(lastStep(routed, 'x')!.error, 'tests failed');
		const unwired = await run(definition('fail', false), returning, { mode: 'execute' });
		assert.strictEqual(unwired.status, 'failed');
		assert.strictEqual(unwired.error, 'Shell: tests failed');
	});

	test('disabled nodes are skipped and pass their input through', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['a', 'transform', { fields: { v: 1 } }, { disabled: true }], ['b', 'transform', { fields: { got: '{{ input.inputs.x }}' } }], ['end', 'end'],
		], ['start.next->a', 'a.next->b', 'b.next->end'], { settings: { maxSteps: 3 } });
		const result = await run(definition, makeHost(clock), { mode: 'execute', inputs: { x: 'through' } });
		assert.strictEqual(result.status, 'succeeded', 'disabled nodes do not count against the budget');
		assert.strictEqual(lastStep(result, 'a')!.state, 'skipped');
		assert.deepStrictEqual(outputOf(result, 'b'), { got: 'through' });
	});

	test('sub-workflows: results, and the nesting limit', async () => {
		const clock = new FakeClock();
		const child = workflow([['start', 'start'], ['end', 'end', { output: 'child says {{ inputs.x }}' }]], ['start.next->end'], { id: 'child' });
		const parent = workflow([
			['start', 'start'], ['sub', 'subworkflow', { workflow: 'child', inputs: { x: '{{ inputs.task }}' } }], ['end', 'end', { output: '{{ nodes.sub.output }}' }],
		], ['start.next->sub', 'sub.done->end']);
		const self = workflow([['start', 'start'], ['sub', 'subworkflow', { workflow: 'wf' }], ['end', 'end']], ['start.next->sub', 'sub.done->end']);
		const library: { [id: string]: IWorkflowDefinition } = { child, wf: self };
		const depths: number[] = [];
		const host: IWorkflowEngineHost = makeHost(clock, {}, {
			runSubworkflow: async (id, inputs, parentRun, token) => {
				depths.push(parentRun.depth);
				const execution = startWorkflowRun(library[id], host, { mode: parentRun.mode, inputs, depth: parentRun.depth, token, trigger: { kind: 'subworkflow', parentRunId: parentRun.runId } });
				try {
					return await execution.done;
				} finally {
					execution.dispose();
				}
			},
		});
		const result = await run(parent, host, { mode: 'execute', inputs: { task: 'hello' } });
		assert.strictEqual(result.status, 'succeeded');
		assert.strictEqual(outputOf(result, 'end'), 'child says hello');
		assert.strictEqual((outputOf(result, 'sub') as WorkflowRecord).status, 'succeeded');

		depths.length = 0;
		const deep = await run(self, host, { mode: 'execute' });
		assert.strictEqual(deep.status, 'failed');
		assert.deepStrictEqual(depths, [1, 2, 3, 4, 5]);
		assert.match(deep.error!, /Sub-workflows nest at most 5 deep/);
	});

	test('stepping: pause before each node, step one, resume; breakpoints', async () => {
		const clock = new FakeClock();
		const definition = workflow([['start', 'start'], ['a', 'transform', { fields: { v: 1 } }], ['b', 'transform', { fields: { v: 2 } }], ['end', 'end']], ['start.next->a', 'a.next->b', 'b.next->end']);
		const execution = startWorkflowRun(definition, makeHost(clock), { mode: 'execute', stepping: true });
		try {
			let snapshot = await until(execution, current => current.status === 'paused');
			assert.deepStrictEqual(states(snapshot), ['start#1:queued']);
			assert.ok(execution.paused);
			execution.step();
			snapshot = await until(execution, current => current.status === 'paused' && current.steps.length === 2);
			assert.deepStrictEqual(states(snapshot), ['start#1:success', 'a#1:queued']);
			execution.step();
			snapshot = await until(execution, current => current.status === 'paused' && current.steps.length === 3);
			assert.deepStrictEqual(states(snapshot), ['start#1:success', 'a#1:success', 'b#1:queued']);
			execution.resume();
			assert.ok(!execution.paused);
			const done = await execution.done;
			assert.strictEqual(done.status, 'succeeded');
			assert.strictEqual(done.steps.length, 4);
		} finally {
			execution.dispose();
		}

		const withBreakpoint = startWorkflowRun(definition, makeHost(clock), { mode: 'execute', breakpoints: ['b'] });
		try {
			const snapshot = await until(withBreakpoint, current => current.status === 'paused');
			assert.deepStrictEqual(states(snapshot), ['start#1:success', 'a#1:success', 'b#1:queued']);
			withBreakpoint.resume();
			assert.strictEqual((await withBreakpoint.done).status, 'succeeded');
		} finally {
			withBreakpoint.dispose();
		}
	});

	test('execute one step (onlyNode) and retry from a node', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['a', 'transform', { fields: { v: '{{ inputs.task }}' } }], ['b', 'shell', { command: 'test {{ nodes.a.v }} {{ input.v }}' }], ['end', 'end'],
		], ['start.next->a', 'a.next->b', 'b.passed->end']);
		let pass = false;
		const host = makeHost(clock, { shell: (context): IWorkflowNodeResult => pass ? { output: { ran: context.config.command }, port: 'passed' } : { output: { error: 'red' }, port: 'failed' } });
		const first = await run(definition, host, { mode: 'execute', inputs: { task: 'x' } });
		assert.strictEqual(first.status, 'failed');

		pass = true;
		const only = await run(definition, host, { mode: 'execute', onlyNode: 'b', previousRun: first });
		assert.strictEqual(only.status, 'succeeded');
		assert.deepStrictEqual(states(only), ['b#1:success']);
		assert.deepStrictEqual(outputOf(only, 'b'), { ran: 'test x x' });
		assert.deepStrictEqual(lastStep(only, 'b')!.input, { v: 'x' });
		assert.deepStrictEqual(only.traversed, []);

		const retried = await run(definition, host, { mode: 'execute', retryFrom: 'b', previousRun: first });
		assert.strictEqual(retried.status, 'succeeded');
		assert.deepStrictEqual(states(retried), ['b#1:success', 'end#1:success']);
		assert.deepStrictEqual(retried.traversed, ['start.next->a', 'a.next->b', 'b.passed->end']);

		pass = false;
		assert.strictEqual((await run(definition, host, { mode: 'execute', onlyNode: 'b', previousRun: first })).status, 'failed');
	});

	test('retry from a branch keeps the other branch\'s output at the join', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['fork', 'fork'], ['a', 'transform', { fields: { side: 'a' } }], ['b', 'shell', { command: 'b' }], ['join', 'join'], ['end', 'end', { output: '{{ input }}' }],
		], ['start.next->fork', 'fork.branch1->a', 'fork.branch2->b', 'a.next->join', 'b.passed->join', 'join.next->end']);
		let pass = false;
		const host = makeHost(clock, { shell: (): IWorkflowNodeResult => pass ? { output: { side: 'b' }, port: 'passed' } : { output: { error: 'no' }, port: 'failed' } });
		const first = await run(definition, host, { mode: 'execute' });
		assert.strictEqual(first.status, 'failed');
		pass = true;
		const retried = await run(definition, host, { mode: 'execute', retryFrom: 'b', previousRun: first });
		assert.strictEqual(retried.status, 'succeeded');
		assert.deepStrictEqual(outputOf(retried, 'end'), { a: { side: 'a' }, b: { side: 'b' } });
	});

	test('simulation: failure injection, pinned outputs, pacing, no executors', async () => {
		const clock = new FakeClock();
		const definition = workflow([
			['start', 'start'], ['work', 'agent', { prompt: 'Fix it' }], ['check', 'shell', { command: 'npm test' }],
			['ok', 'end', { output: '{{ nodes.work.summary }}' }], ['fix', 'agent', { prompt: 'Fix the failure' }], ['ko', 'end', { status: 'failure' }],
		], ['start.next->work', 'work.done->check', 'check.passed->ok', 'check.failed->fix', 'fix.done->ko']);
		const host = createSimulationHost({ now: clock.now, delay: clock.delay });

		const injected = await run(definition, host, { mode: 'simulate', simulation: { speed: 0, failNodes: ['check'] } });
		assert.strictEqual(injected.endNodeId, 'ko');
		assert.strictEqual(lastStep(injected, 'check')!.error, 'Simulated failure');
		assert.strictEqual(lastStep(injected, 'fix')!.state, 'success');
		assert.ok(injected.tokens && injected.tokens.input > 0, 'simulated agents report tokens');

		const pinned: IWorkflowDefinition = { ...definition, nodes: definition.nodes.map(node => node.id === 'work' ? { ...node, pinnedOutput: { summary: 'pinned!' } } : node) };
		const startedAt = clock.time;
		const paced = await run(pinned, host, { mode: 'simulate' });
		assert.strictEqual(paced.endNodeId, 'ok');
		assert.strictEqual(outputOf(paced, 'ok'), 'pinned!');
		assert.strictEqual(clock.time - startedAt, 150 + 1600 + 700 + 150, 'start, agent, shell and end pacing at speed 1');

		const real = await run(definition, makeHost(clock), { mode: 'execute' });
		assert.strictEqual(real.status, 'failed');
		assert.match(lastStep(real, 'work')!.error!, /No executor for Agent nodes/);
	});

	test('big outputs are truncated in records, logs are capped, the run timeout and End failures', async () => {
		const clock = new FakeClock();
		const big = workflow([['start', 'start'], ['t', 'transform', { fields: { big: '{{ inputs.big }}' } }], ['end', 'end', { output: '{{ len(nodes.t.big) }}' }]], ['start.next->t', 't.next->end']);
		const result = await run(big, makeHost(clock), { mode: 'execute', inputs: { big: 'x'.repeat(300 * 1024) } });
		const stored = outputOf(result, 't') as WorkflowRecord;
		assert.strictEqual(stored.truncated, true);
		assert.ok((stored.bytes as number) > 300 * 1024);
		assert.strictEqual(outputOf(result, 'end'), 300 * 1024, 'templates still read the full value');

		const chatty = workflow([['start', 'start'], ['x', 'shell', { command: 'x' }]], ['start.next->x']);
		const logged = await run(chatty, makeHost(clock, { shell: context => { for (let i = 0; i < 1500; i++) { context.log('info', `line ${i}`); } return passing(context); } }), { mode: 'execute' });
		assert.strictEqual(logged.logs.length, WORKFLOW_MAX_LOG_ENTRIES);
		assert.strictEqual(logged.logs[logged.logs.length - 1].message, 'line 1499');

		const slow = workflow([['start', 'start'], ['x', 'shell', { command: 'x' }]], ['start.next->x'], { settings: { timeoutMs: 5000 } });
		const timedOut = await run(slow, makeHost(clock, { shell: async context => { await clock.delay(60_000, context.token); return passing(context); } }), { mode: 'execute' });
		assert.strictEqual(timedOut.status, 'failed');
		assert.strictEqual(timedOut.error, 'Run timed out after 5s');
		assert.strictEqual(lastStep(timedOut, 'x')!.state, 'cancelled');

		const ending = await run(workflow([['start', 'start'], ['stop', 'end', { status: 'failure', output: 'nope' }]], ['start.next->stop']), makeHost(clock), { mode: 'execute' });
		assert.strictEqual(ending.status, 'failed');
		assert.strictEqual(ending.outcome, 'failure');
		assert.match(ending.error!, /Ended as a failure at End/);
	});

	test('runs are immutable snapshots; invalid graphs fail before running', async () => {
		const clock = new FakeClock();
		const definition = workflow([['start', 'start'], ['a', 'log', { message: 'x' }]], ['start.next->a']);
		const execution = startWorkflowRun(definition, makeHost(clock), { mode: 'execute' });
		const before = execution.run;
		assert.strictEqual(before.status, 'queued');
		const after = await execution.done;
		execution.dispose();
		assert.strictEqual(before.status, 'queued');
		assert.deepStrictEqual(before.steps, []);
		assert.strictEqual(after.steps.length, 2);
		assert.notStrictEqual(before, after);

		const cyclic = await run(workflow([['start', 'start'], ['a', 'log', { message: 'x' }], ['b', 'log', { message: 'y' }]], ['start.next->a', 'a.next->b', 'b.next->a']), makeHost(clock), { mode: 'execute' });
		assert.strictEqual(cyclic.status, 'failed');
		assert.match(cyclic.error!, /closes a cycle/);
		assert.deepStrictEqual(cyclic.steps, []);
		const noStart = await run(workflow([['a', 'log', { message: 'x' }]], []), makeHost(clock), { mode: 'execute' });
		assert.match(noStart.error!, /needs a Start node/);
	});
});
