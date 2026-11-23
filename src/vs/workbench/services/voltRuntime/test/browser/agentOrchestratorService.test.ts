/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentOrchestratorService } from '../../browser/orchestration/agentOrchestratorService.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../common/events.js';
import { IVoltHostToolProvider } from '../../common/hostTools.js';
import { IOrchStartTurnRequest, IOrchTurnHost } from '../../common/orchestration/orchestrator.js';
import { IVoltSendRequest } from '../../common/session.js';
import { DEFAULT_SANDBOX_SETTINGS, IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { VoltAccessMode } from '../../common/access/accessModes.js';

/** A runtime that runs nothing: the test starts and ends runs and says what the reply was. */
class FakeRuntime {
	private readonly emitter = new Emitter<IVoltEventEnvelope>();
	readonly onDidEmit = this.emitter.event;
	private seq = 0;
	private runs = 0;
	readonly sends: { threadId: string; request: IVoltSendRequest; runId: string }[] = [];
	readonly replies = new Map<string, string>();
	readonly cancelled: string[] = [];

	listCatalog() {
		return [
			{ ref: 'agent:claude', kind: 'agent', providerId: 'claude', profileId: 'p', id: 'opus', label: 'Claude Opus 5.5', enabled: true },
			{ ref: 'agent:cursor', kind: 'agent', providerId: 'cursor', profileId: 'p', id: 'grok', label: 'Cursor Grok 4.6', enabled: true },
		];
	}
	listProviderStatuses() { return [{ profileId: 'p', label: 'Claude' }]; }
	canSteer() { return false; }
	steer() { return false; }
	chatFor(id: string) { return id; }
	getModelOptions() { return {}; }
	rememberWorktree() { }
	readonly sandboxes = new Map<string, IVoltSandboxSettings>();
	getSandboxSettings(threadId: string): IVoltSandboxSettings { return this.sandboxes.get(threadId) ?? DEFAULT_SANDBOX_SETTINGS; }
	async setSandboxSettings(threadId: string, settings: IVoltSandboxSettings) { this.sandboxes.set(threadId, settings); }
	readonly access = new Map<string, VoltAccessMode>();
	getAccessMode(threadId?: string): VoltAccessMode { return (threadId ? this.access.get(threadId) : undefined) ?? 'supervised'; }
	async setAccessMode(mode: VoltAccessMode, threadId?: string) { this.access.set(threadId ?? '', mode); }
	getOrCreateSession(threadId: string) {
		const reply = this.replies.get(threadId);
		return { providerRef: undefined, messages: reply ? [{ role: 'assistant', content: reply }] : [] };
	}
	async send(threadId: string, request: IVoltSendRequest): Promise<string> {
		const runId = `run${++this.runs}`;
		this.sends.push({ threadId, request, runId });
		this.emit(threadId, runId, { type: 'run.start', runId, mode: request.mode });
		return runId;
	}
	async cancel(threadId: string) {
		this.cancelled.push(threadId);
		const last = [...this.sends].reverse().find(send => send.threadId === threadId);
		if (last) {
			this.emit(threadId, last.runId, { type: 'run.end', runId: last.runId, reason: 'abort' });
		}
	}
	emit(threadId: string, runId: string, event: IVoltEvent): void {
		this.emitter.fire({ seq: ++this.seq, runId, sessionId: threadId, timestamp: Date.now(), event });
	}
	/** Ends the newest run of a chat. */
	finish(threadId: string, reply = 'done', reason: 'done' | 'fail' = 'done'): void {
		const last = [...this.sends].reverse().find(send => send.threadId === threadId);
		assert.ok(last, `no run in ${threadId}`);
		this.replies.set(threadId, reply);
		if (reason === 'fail') {
			// Not a passing error (an overload, a 5xx, a dropped connection): those continue the turn by themselves (isTransientFailure).
			this.emit(threadId, last.runId, { type: 'error', message: 'Provider returned 400' });
		}
		this.emit(threadId, last.runId, { type: 'run.end', runId: last.runId, reason });
	}
	dispose() {
		this.emitter.dispose();
	}
}

/** The chat UI's side: records the turns it is asked to start and hands them to the runtime. */
class FakeHost implements IOrchTurnHost {
	readonly started: IOrchStartTurnRequest[] = [];
	gate: Promise<void> | undefined;
	constructor(private readonly runtime: FakeRuntime) { }
	async startTurn(request: IOrchStartTurnRequest): Promise<string | undefined> {
		this.started.push(request);
		await this.gate;
		if (!request.isCurrent()) {
			return undefined;
		}
		return this.runtime.send(request.threadId, { text: request.turn.prompt.text, mode: 'agent', ...(request.turn.prompt.modelRef ? { providerRef: request.turn.prompt.modelRef } : {}) });
	}
}

suite('Agent orchestrator service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(existing?: { fileService?: FileService; resume?: string }) {
		const disposables = store.add(new DisposableStore());
		let fileService = existing?.fileService;
		if (!fileService) {
			fileService = disposables.add(new FileService(new NullLogService()));
			disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		}
		const runtime = new FakeRuntime();
		disposables.add(toDisposable(() => runtime.dispose()));
		let tools: IVoltHostToolProvider | undefined;
		const stub = <T>(value: object) => value as unknown as T;
		const service = disposables.add(new AgentOrchestratorService(
			stub(runtime),
			fileService,
			stub({ userRoamingDataHome: URI.file('/user') }),
			new NullLogService(),
			stub({ whenReady: Promise.resolve(), get: () => undefined, sessionParent: () => undefined, open: () => ({ setMeta: () => undefined }) }),
			stub({ registerToolProvider: (provider: IVoltHostToolProvider) => { tools = provider; return toDisposable(() => tools = undefined); } }),
			stub({ create: async () => ({ path: '/wt/a', branch: 'volt/a' }), ensure: async (_root: string, path: string) => ({ path, recreated: false }) }),
			stub({ rootFor: () => URI.file('/repo') }),
			stub({ getValue: () => existing?.resume ?? 'off', onDidChangeConfiguration: () => toDisposable(() => undefined) }),
			stub({ run: async () => undefined, needsRetry: () => false }),
			stub({ onWillShutdown: () => toDisposable(() => undefined) }),
			stub({ invokeFunction: () => undefined }),
			stub({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '', timedOut: false }), cancelExec: async () => undefined }),
		));
		await service.whenReady;
		const host = new FakeHost(runtime);
		disposables.add(service.setTurnHost(host));
		const tool = async (threadId: string, name: string, args: Record<string, unknown>) => {
			const result = await tools!.invoke(name, args, { sessionId: threadId });
			return result.error ?? result.text ?? '';
		};
		return { service, runtime, host, fileService, tool };
	}

	/** Effects run after the batch that caused them is written; let that happen. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await timeout(0);
		}
	}

	test('a prompt starts a turn through the host; one sent while busy runs when the turn ends', async () => {
		const { service, runtime, host } = await setup();
		await service.submit('chat', { text: 'one', mode: 'Agent' }, 'auto', 't1');
		await settle();
		assert.deepStrictEqual(host.started.map(request => request.turn.id), ['t1']);
		assert.strictEqual(service.getThread('chat')?.active?.runId, 'run1', 'the run is bound to its turn');
		const second = await service.submit('chat', { text: 'two', mode: 'Agent' }, 'auto', 't2');
		assert.strictEqual(second.outcome, 'queued');
		runtime.finish('chat');
		await settle();
		assert.deepStrictEqual(host.started.map(request => request.turn.id), ['t1', 't2']);
		assert.strictEqual(service.getThread('chat')?.active?.id, 't2');
	});

	test('a prompt sent without a turn id gets one, also when it arrives as null from a window', async () => {
		const { service, runtime, host } = await setup();
		await service.submit('chat', { text: 'one' }, 'auto');
		await settle();
		runtime.finish('chat');
		await settle();
		// What a call through the agent server's socket makes of an omitted argument.
		await service.submit('chat', { text: 'two' }, 'auto', null as unknown as string);
		await settle();
		const ids = host.started.map(request => request.turn.id);
		assert.strictEqual(ids.length, 2);
		assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), JSON.stringify(ids));
		assert.notStrictEqual(ids[0], ids[1]);
	});

	test('a failed run pauses the queue instead of resending into the failing provider', async () => {
		const { service, runtime, host } = await setup();
		await service.submit('chat', { text: 'one' }, 'auto', 't1');
		await settle();
		await service.submit('chat', { text: 'two' }, 'auto', 't2');
		runtime.finish('chat', '', 'fail');
		await settle();
		assert.strictEqual(host.started.length, 1);
		assert.strictEqual(service.getThread('chat')?.pause, 'failed');
		assert.strictEqual(service.getThread('chat')?.last?.error, 'Provider returned 400');
	});

	test('Stop while a turn is still starting ends it without sending anything', async () => {
		const { service, runtime, host } = await setup();
		const gate = new DeferredPromise<void>();
		host.gate = gate.p;
		await service.submit('chat', { text: 'one' }, 'auto', 't1');
		await settle();
		await service.cancel('chat');
		gate.complete();
		await settle();
		assert.strictEqual(runtime.sends.length, 0);
		assert.strictEqual(service.getThread('chat')?.active, undefined);
		assert.strictEqual(service.getThread('chat')?.last?.outcome, 'cancelled');
	});

	test('delegate_task starts a subagent chat; its report wakes the idle parent', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'build the site' }, 'auto', 'p1');
		await settle();
		const started = await tool('parent', 'delegate_task', { task: 'Write the README', title: 'README', model: 'Cursor Grok 4.6' });
		assert.match(started, /Started task t-[0-9a-f]{6}/);
		await settle();
		const task = service.tasksOf('parent')[0];
		assert.strictEqual(task.modelLabel, 'Cursor Grok 4.6');
		const brief = host.started.find(request => request.threadId === task.childId);
		assert.strictEqual(brief?.turn.kind, 'brief');
		assert.strictEqual(runtime.sends.find(send => send.threadId === task.childId)?.request.providerRef, 'agent:cursor', 'the child runs on the model it was given');

		runtime.finish('parent', 'Started a subagent for the README.');
		await settle();
		runtime.finish(task.childId!, 'README written: 40 lines.');
		await settle();
		const wake = host.started.at(-1);
		assert.strictEqual(wake?.threadId, 'parent');
		assert.strictEqual(wake?.turn.kind, 'notification');
		assert.ok(wake?.turn.prompt.text.includes('README written: 40 lines.'));
	});

	test('the parts of one delegate_task call wake the idle parent once, with both reports', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'do both' }, 'auto', 'p1');
		await settle();
		const started = await tool('parent', 'delegate_task', { tasks: [{ task: 'Fix a.ts', title: 'Fix a' }, { task: 'Review b.ts', title: 'Review b' }] });
		assert.match(started, /delivered to this chat together once all of them have finished/);
		await settle();
		const [first, second] = service.tasksOf('parent');
		assert.ok(first.batch && first.batch === second.batch, 'both parts carry the call\'s batch id');
		await tool('parent', 'delegate_task', { task: 'Count the tests' });
		assert.notStrictEqual(service.tasksOf('parent')[2].batch, first.batch, 'a call of its own is not part of the other call');

		runtime.finish('parent', 'Started them.');
		await settle();
		runtime.finish(first.childId!, 'a.ts fixed.');
		await settle();
		const wakes = () => host.started.filter(request => request.threadId === 'parent' && request.turn.kind === 'notification');
		assert.strictEqual(wakes().length, 0, 'one part done: the parent sleeps on');
		runtime.finish(second.childId!, 'b.ts has one bug.');
		await settle();
		assert.strictEqual(wakes().length, 1);
		assert.ok(wakes()[0].turn.prompt.text.includes('a.ts fixed.') && wakes()[0].turn.prompt.text.includes('b.ts has one bug.'));
	});

	test('a subagent of a sandboxed chat is confined at least as tightly before its first turn', async () => {
		const { service, runtime, host, tool } = await setup();
		runtime.sandboxes.set('parent', { level: 'read-only', network: false });
		runtime.sandboxes.set('other', { level: 'workspace-write', network: true });
		const gate = new DeferredPromise<void>();
		await service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		host.gate = gate.p;
		await tool('parent', 'delegate_task', { task: 'Count the tests' });
		await settle();
		const task = service.tasksOf('parent')[0];
		assert.ok(host.started.some(request => request.threadId === task.childId), 'its brief turn is starting');
		assert.deepStrictEqual(runtime.getSandboxSettings(task.childId!), { level: 'read-only', network: false }, 'confined before the host starts it');
		gate.complete();
		await settle();
	});

	test('a subagent asks for approval as its parent chat does: a Full access parent\'s subagent does not stop for approvals', async () => {
		const { service, runtime, host, tool } = await setup();
		runtime.access.set('parent', 'full-access');
		const gate = new DeferredPromise<void>();
		await service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		host.gate = gate.p;
		await tool('parent', 'delegate_task', { task: 'Fix a.ts' });
		await settle();
		const task = service.tasksOf('parent')[0];
		assert.ok(host.started.some(request => request.threadId === task.childId), 'its brief turn is starting');
		assert.strictEqual(runtime.getAccessMode(task.childId!), 'full-access', 'set before the host starts it');
		gate.complete();
		await settle();
		// The user tightens the parent: the next round follows.
		runtime.access.set('parent', 'supervised');
		runtime.finish(task.childId!, 'Fixed.');
		await settle();
		await tool('parent', 'message_task', { task_id: task.id, message: 'Also b.ts' });
		await settle();
		assert.strictEqual(runtime.getAccessMode(task.childId!), 'supervised');
	});

	test('a delegate_task call without arguments (schema not loaded yet) is told the arguments, so the next call is right', async () => {
		const { service, host, tool } = await setup();
		await service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		const refused = await tool('parent', 'delegate_task', {});
		assert.match(refused, /called without arguments/);
		assert.match(refused, /no ToolSearch needed/);
		assert.match(refused, /"task": "<the complete brief>"/);
		assert.match(refused, /"tasks": \[/);
		// A chat that meant another Volt tool (a stray first call on a one-tool request) is told to load it.
		assert.match(refused, /another Volt tool .*ToolSearch "select:mcp__volt__<name>"/);
		assert.strictEqual(service.tasksOf('parent').length, 0);
		// A call with other arguments but no brief gets the short refusal.
		assert.match(await tool('parent', 'delegate_task', { title: 'x' }), /^delegate_task needs a `task`/);
		// A one-word brief ("noop") starts no subagent either.
		const stray = await tool('parent', 'delegate_task', { task: 'noop' });
		assert.match(stray, /"noop" is not a brief, so no subagent started/);
		assert.match(stray, /select:mcp__volt__<name>/);
		assert.match(await tool('parent', 'delegate_task', { tasks: [{ task: 'test' }] }), /not a brief/);
		assert.strictEqual(service.tasksOf('parent').length, 0);
		// The retry the refusal describes starts the task at once.
		assert.match(await tool('parent', 'delegate_task', { task: 'Read a.ts and report', title: 'Read a' }), /Started task t-/);
		await settle();
		assert.strictEqual(host.started.at(-1)?.turn.kind, 'brief');
	});

	test('a delegated task starts its agent lean: read-only for research and review, working for the rest', async () => {
		const { service, host, tool } = await setup();
		await service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		await tool('parent', 'delegate_task', { tasks: [{ task: 'Research a.ts', role: 'research' }, { task: 'Review b.ts', role: 'review' }, { task: 'Fix c.ts', role: 'implementation' }, { task: 'Do d' }] });
		await settle();
		const profiles = service.tasksOf('parent').map(task => host.started.find(request => request.threadId === task.childId)?.subagent);
		assert.deepStrictEqual(profiles, ['readonly', 'readonly', 'work', 'work']);
	});

	test('delegate_task takes the names agents use for a brief and a model, and a refusal lists the models', async () => {
		const { service, tool } = await setup();
		await service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		const started = await tool('parent', 'delegate_task', { tasks: [{ prompt: 'In /tmp/repo: fix a.ts', model: 'Claude Opus 5.5' }, { prompt: 'Review b.ts', description: 'Review b', model: 'cursor grok 4.6' }] });
		assert.match(started, /Started 2 of 2 tasks/);
		assert.deepStrictEqual(service.tasksOf('parent').map(task => [task.title, task.modelLabel]), [['Fix a.ts', 'Claude Opus 5.5'], ['Review b', 'Cursor Grok 4.6']]);
		assert.match(await tool('parent', 'delegate_task', { task: 'x', model: 'GPT 9' }), /No connected model matches "GPT 9". Pass one of: "Claude Opus 5.5" \(Claude\), "Cursor Grok 4.6"/);
	});

	test('a subagent\'s checks run in its checkout before its report wakes the parent', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'fix it' }, 'auto', 'p1');
		await settle();
		await tool('parent', 'delegate_task', { task: 'Fix a.ts', verify: ['npm test -- a'] });
		await settle();
		const task = service.tasksOf('parent')[0];
		runtime.finish('parent', 'Delegated.');
		await settle();
		runtime.finish(task.childId!, 'Fixed a.ts.');
		await settle();
		const wake = host.started.at(-1);
		assert.strictEqual(wake?.threadId, 'parent');
		assert.ok(wake?.turn.prompt.text.includes('Fixed a.ts.'));
		assert.ok(wake?.turn.prompt.text.includes('Volt verification'), 'the report says the checks passed');
		assert.strictEqual(service.getTask(task.id)?.verification?.state, 'passed');
	});

	test('parts started in calls of their own in one turn wake the idle parent once; a later turn\'s part reports by itself', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'fix both' }, 'auto', 'p1');
		await settle();
		await tool('parent', 'delegate_task', { task: 'Fix a.ts' });
		await tool('parent', 'delegate_task', { task: 'Fix b.ts' });
		await settle();
		const [first, second] = service.tasksOf('parent');
		runtime.finish('parent', 'Started them.');
		await settle();
		const wakes = () => host.started.filter(request => request.threadId === 'parent' && request.turn.kind === 'notification');
		runtime.finish(first.childId!, 'a.ts fixed.');
		await settle();
		assert.strictEqual(wakes().length, 0, 'one part done: the parent sleeps on');
		runtime.finish(second.childId!, 'b.ts fixed.');
		await settle();
		assert.strictEqual(wakes().length, 1);
		assert.ok(wakes()[0].turn.prompt.text.includes('a.ts fixed.') && wakes()[0].turn.prompt.text.includes('b.ts fixed.'));

		// The wake-up turn starts one more part: it is not held back by the first turn's parts.
		await tool('parent', 'delegate_task', { task: 'Fix c.ts' });
		await settle();
		const third = service.tasksOf('parent')[2];
		assert.notStrictEqual(third.batch, first.batch);
		runtime.finish('parent', 'Started c.');
		await settle();
		runtime.finish(third.childId!, 'c.ts fixed.');
		await settle();
		assert.strictEqual(wakes().length, 2);
	});

	test('a waiting delegate_task call stops waiting when the parent starts writing another one, so the next part is not held back', async () => {
		const { service, runtime, tool } = await setup();
		await service.submit('parent', { text: 'fix both' }, 'auto', 'p1');
		await settle();
		const parentRun = runtime.sends.find(send => send.threadId === 'parent')!.runId;
		runtime.emit('parent', parentRun, { type: 'tool.start', callId: 'call-1', name: 'mcp__volt__delegate_task', title: 'delegate_task' });
		const waiting = tool('parent', 'delegate_task', { task: 'Fix a.ts', wait: true });
		await settle();
		runtime.emit('parent', parentRun, { type: 'tool.start', callId: 'call-2', name: 'mcp__volt__delegate_task', title: 'delegate_task' });
		const result = await waiting;
		assert.match(result, /Not waited for: you are starting another task/);
		assert.strictEqual(service.tasksOf('parent')[0].state, 'running');
		const alone = tool('parent', 'delegate_task', { task: 'Fix b.ts', wait: true });
		await settle();
		runtime.finish(service.tasksOf('parent')[1].childId!, 'b.ts fixed.');
		assert.ok((await alone).includes('b.ts fixed.'), 'a call nothing follows still waits for its report');
	});

	test('a waiting delegate_task call returns its upstream parts\' reports with its own, so no wait_tasks call is needed for them', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'answer Q1-Q4' }, 'auto', 'p1');
		await settle();
		await tool('parent', 'delegate_task', { task: 'Q1' });
		await tool('parent', 'delegate_task', { task: 'Q2' });
		await settle();
		const [q1, q2] = service.tasksOf('parent');
		const waiting = tool('parent', 'delegate_task', { task: 'Q3 from the reports', after: [q1.id, q2.id], wait: true });
		await settle();
		runtime.finish(q1.childId!, 'Q1 answer.');
		runtime.finish(q2.childId!, 'Q2 answer.');
		await settle();
		const q3 = service.tasksOf('parent')[2];
		runtime.finish(q3.childId!, 'Q3 answer.');
		const result = await waiting;
		for (const answer of ['Q1 answer.', 'Q2 answer.', 'Q3 answer.']) {
			assert.ok(result.includes(answer), answer);
		}
		assert.deepStrictEqual(service.tasksOf('parent').map(task => task.delivery), ['acknowledged', 'acknowledged', 'acknowledged']);
		runtime.finish('parent', 'Q1-Q3.');
		await settle();
		assert.ok(!host.started.some(request => request.turn.kind === 'notification'), 'no wake-up for reports already read');
	});

	test('wait_tasks returns the report as soon as the subagent finishes, and it is not delivered again', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		await tool('parent', 'delegate_task', { task: 'Count the tests' });
		await settle();
		const task = service.tasksOf('parent')[0];
		const waiting = tool('parent', 'wait_tasks', {});
		await settle();
		runtime.finish(task.childId!, '412 tests.');
		const report = await waiting;
		assert.ok(report.includes('412 tests.'));
		assert.strictEqual(service.getTask(task.id)?.delivery, 'acknowledged');
		runtime.finish('parent');
		await settle();
		assert.ok(!host.started.some(request => request.turn.kind === 'notification'), 'no wake-up for a report already read');
	});

	test('after a restart the chat is interrupted, its queue held, and nothing starts on its own', async () => {
		const first = await setup();
		await first.service.submit('chat', { text: 'one' }, 'auto', 't1');
		await settle();
		await first.service.submit('chat', { text: 'two' }, 'auto', 't2');
		await settle();
		await timeout(300);
		const second = await setup({ fileService: first.fileService });
		await settle();
		const thread = second.service.getThread('chat');
		assert.strictEqual(thread?.active, undefined);
		assert.strictEqual(thread?.pause, 'interrupted');
		assert.strictEqual(thread?.last?.outcome, 'interrupted');
		assert.deepStrictEqual(thread?.queue.map(item => item.id), ['t2']);
		assert.strictEqual(second.host.started.length, 0);
		await second.service.dispatch({ type: 'queue.resume', threadId: 'chat' });
		await settle();
		assert.deepStrictEqual(second.host.started.map(request => request.turn.id), ['t2']);
	});

	test('after a restart a delegated task that was running continues by itself and still reports to its parent', async () => {
		const first = await setup();
		await first.service.submit('parent', { text: 'go' }, 'auto', 'p1');
		await settle();
		await first.tool('parent', 'delegate_task', { task: 'Audit the API', title: 'Audit' });
		await settle();
		first.runtime.finish('parent', 'Delegated.');
		await settle();
		const task = first.service.tasksOf('parent')[0];
		assert.strictEqual(first.service.getTask(task.id)?.state, 'running');
		await timeout(300);

		const second = await setup({ fileService: first.fileService, resume: 'subagents' });
		await settle();
		const resumed = second.host.started.find(request => request.threadId === task.childId);
		assert.strictEqual(resumed?.turn.kind, 'resume');
		assert.ok(resumed?.turn.prompt.text.includes('Volt restarted'));
		assert.strictEqual(second.service.getTask(task.id)?.restarts, 1);
		assert.ok(!second.host.started.some(request => request.threadId === 'parent'), 'the parent does not run until the report comes');
		second.runtime.finish(task.childId!, 'API audited: 3 findings.');
		await settle();
		const wake = second.host.started.at(-1);
		assert.strictEqual(wake?.threadId, 'parent');
		assert.ok(wake?.turn.prompt.text.includes('API audited: 3 findings.'));
		assert.match(await second.tool('parent', 'task_status', { task_id: task.id }), /continued after a Volt restart/);
	});

	test('delegate_task with previous_task_id starts the next round with the previous brief and report', async () => {
		const { service, runtime, host, tool } = await setup();
		await service.submit('parent', { text: 'ship it' }, 'auto', 'p1');
		await settle();
		await tool('parent', 'delegate_task', { task: 'Review src/auth.ts', role: 'review', model: 'Cursor Grok 4.6', client_request_id: 'review-1' });
		await settle();
		const round1 = service.tasksOf('parent')[0];
		runtime.finish(round1.childId!, 'Found: missing null check in login().');
		await settle();
		const started = await tool('parent', 'delegate_task', { task: 'I added the null check. Review again.', previous_task_id: round1.id, client_request_id: 'review-2' });
		assert.match(started, /iteration: 2 \(follows t-/);
		await settle();
		const round2 = service.tasksOf('parent')[1];
		assert.strictEqual(round2.previousTaskId, round1.id);
		assert.strictEqual(round2.role, 'review', 'the round keeps the reviewer role');
		assert.strictEqual(round2.modelLabel, 'Cursor Grok 4.6', 'and the reviewer model');
		const brief = host.started.find(request => request.threadId === round2.childId);
		assert.ok(brief?.turn.prompt.text.includes('Found: missing null check in login().'), 'the new reviewer sees the previous report');
		assert.ok(brief?.turn.prompt.text.includes('round 2'));
		assert.match(await tool('parent', 'delegate_task', { task: 'x', previous_task_id: 't-000000' }), /No task t-000000/);
	});

	test('a batch of subagents is saved in a couple of writes, each started once its own state is on disk, and a restart reads every one back', async () => {
		const first = await setup();
		await first.service.submit('parent', { text: 'split it' }, 'auto', 'p1');
		await settle();
		const rootFile = URI.file('/user/voltOrchestrator/roots/parent.json');
		let writes = 0;
		const write = first.fileService.writeFile.bind(first.fileService);
		first.fileService.writeFile = (...args: Parameters<FileService['writeFile']>) => {
			writes++;
			return write(...args);
		};
		// No child starts before the saved tree holds its task.
		const unsaved: string[] = [];
		const startTurn = first.host.startTurn.bind(first.host);
		first.host.startTurn = async request => {
			const saved = (await first.fileService.readFile(rootFile)).value.toString();
			if (!saved.includes(request.threadId)) {
				unsaved.push(request.threadId);
			}
			return startTurn(request);
		};
		const brief = 'x'.repeat(2_000);
		const result = await first.tool('parent', 'delegate_task', { tasks: Array.from({ length: 6 }, (_, i) => ({ task: `${brief} part ${i}`, title: `Part ${i}` })) });
		assert.match(result, /Started 6 of 6 tasks/);
		await settle();
		await timeout(50);
		const tasks = first.service.tasksOf('parent');
		assert.strictEqual(tasks.filter(task => task.state === 'running').length, 6);
		assert.deepStrictEqual(unsaved, []);
		assert.ok(writes <= 3, `6 spawns took ${writes} writes`);
		assert.ok(first.service.getThread(tasks[0].childId!)?.active?.prompt.text.includes(brief), 'the turn itself keeps the whole brief');
		await timeout(300);

		const saved = JSON.parse((await first.fileService.readFile(rootFile)).value.toString()) as { events: { event: { turn?: { prompt: { text: string } }; item?: { prompt: { text: string } } } }[] };
		const prompts = saved.events.map(envelope => envelope.event.turn?.prompt.text ?? envelope.event.item?.prompt.text).filter((text): text is string => !!text);
		assert.ok(prompts.length > 0);
		assert.ok(prompts.every(text => text.length < 500), 'the audit trail keeps prompts short');
		const second = await setup({ fileService: first.fileService });
		await settle();
		assert.strictEqual(second.service.tasksOf('parent').length, 6, 'every task was saved');
	});

	test('a harness subagent is tracked from the Task call and ends with its parent turn', async () => {
		const { service, runtime } = await setup();
		await service.submit('chat', { text: 'explore' }, 'auto', 't1');
		await settle();
		runtime.emit('chat', 'run1', { type: 'tool.start', callId: 'tool_1', name: 'Task: Map the API', title: 'Task: Map the API', input: JSON.stringify({ _toolName: 'task', description: 'Map the API', prompt: 'List every route', subagentType: { explore: {} } }) });
		runtime.emit('chat', 'run1', { type: 'tool.start', callId: 'toolu_2', name: 'Task', title: 'Task', input: JSON.stringify({ description: 'Audit auth', prompt: 'Read auth.ts', subagent_type: 'general-purpose' }) });
		runtime.emit('chat', 'run1', { type: 'tool.end', callId: 'toolu_2', result: [{ type: 'text', text: 'Async agent launched successfully. agentId: a1' }] });
		runtime.emit('chat', 'run1', { type: 'tool.end', callId: 'tool_1', result: { durationMs: 6219, isBackground: false } });
		const tasks = service.tasksOf('chat');
		assert.deepStrictEqual(tasks.map(task => [task.title, task.kind, task.state]), [['Map the API', 'explore', 'completed'], ['Audit auth', 'general-purpose', 'running']]);
		runtime.finish('chat');
		await settle();
		assert.strictEqual(service.getTask(tasks[1].id)?.state, 'completed', 'the async child ended with its turn');
	});

	test('a native harness subagent whose end never comes settles once it has been quiet, while its parent turn still runs', async () => {
		const { service, runtime } = await setup();
		await service.submit('chat', { text: 'run the packages' }, 'auto', 't1');
		await settle();
		runtime.emit('chat', 'run1', { type: 'subagent.spawned', childId: 'h7', title: 'Resume H7 backend hardening', source: 'claude' });
		runtime.emit('chat', 'run1', { type: 'subagent.spawned', childId: 'h8', title: 'H8 tests', source: 'claude' });
		runtime.emit('chat', 'run1', { type: 'subagent.event', childId: 'h7', event: { type: 'tool.start', callId: 'c1', name: 'Bash' } });
		runtime.emit('chat', 'run1', { type: 'subagent.event', childId: 'h7', event: { type: 'tool.end', callId: 'c1' } });
		runtime.emit('chat', 'run1', { type: 'subagent.event', childId: 'h7', event: { type: 'text.delta', id: 'm1', delta: '9 files changed.' } });
		// H8 sits in a long test run: an open tool call is not silence.
		runtime.emit('chat', 'run1', { type: 'subagent.event', childId: 'h8', event: { type: 'tool.start', callId: 'c2', name: 'Bash' } });
		const [h7, h8] = service.tasksOf('chat');
		const tick = (service as unknown as { checkLiveness(): void });
		const realNow = Date.now;
		let now = realNow();
		Date.now = () => now;
		try {
			// The watchdog ticks every 20 s; a bigger jump would read as the machine sleeping.
			for (let elapsed = 0; elapsed < 14 * 60_000; elapsed += 20_000) {
				now += 20_000;
				tick.checkLiveness();
			}
			assert.strictEqual(service.getTask(h7.id)?.state, 'running', 'not settled before it was quiet for long');
			for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 20_000) {
				now += 20_000;
				tick.checkLiveness();
			}
		} finally {
			Date.now = realNow;
		}
		await settle();
		assert.deepStrictEqual([service.getTask(h7.id)?.state, service.getTask(h7.id)?.result], ['completed', '9 files changed.']);
		assert.strictEqual(service.getTask(h8.id)?.state, 'running', 'a subagent in a long tool call keeps running');
		assert.ok(service.getThread('chat')?.active, 'the parent turn still runs');
	});
});
