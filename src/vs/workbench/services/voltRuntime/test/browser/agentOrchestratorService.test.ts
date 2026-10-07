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
	canSteer() { return false; }
	steer() { return false; }
	chatFor(id: string) { return id; }
	getModelOptions() { return {}; }
	rememberWorktree() { }
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
			this.emit(threadId, last.runId, { type: 'error', message: 'Provider returned 529' });
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
			stub({ create: async () => ({ path: '/wt/a', branch: 'volt/a' }), ensure: async () => false }),
			stub({ rootFor: () => URI.file('/repo') }),
			stub({ getValue: () => existing?.resume ?? 'off' }),
			stub({ run: async () => undefined, needsRetry: () => false }),
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

	test('a failed run pauses the queue instead of resending into the failing provider', async () => {
		const { service, runtime, host } = await setup();
		await service.submit('chat', { text: 'one' }, 'auto', 't1');
		await settle();
		await service.submit('chat', { text: 'two' }, 'auto', 't2');
		runtime.finish('chat', '', 'fail');
		await settle();
		assert.strictEqual(host.started.length, 1);
		assert.strictEqual(service.getThread('chat')?.pause, 'failed');
		assert.strictEqual(service.getThread('chat')?.last?.error, 'Provider returned 529');
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
});
