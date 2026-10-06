/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isEqualOrParent, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IVoltExecRequest, IVoltExecResult, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { AgentRuntimeService } from '../../browser/voltRuntimeService.js';
import { DEFAULT_ACP_CAPABILITIES, DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../common/events.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentMessage, IAgentProvider, IAgentSessionHandle, IAgentStartRequest, IModelProvider, IModelRequest, IVoltCatalogItem } from '../../common/providers.js';

const ROOT = URI.file('/w');

type Turn<T> = (input: T, token: CancellationToken) => AsyncIterable<IVoltEvent>;

/** A native model whose turns the test scripts; default turn: "ok". */
class FakeModel implements IModelProvider {
	readonly id = 'fake-model';
	readonly label = 'Fake model';
	readonly turns: Turn<IModelRequest>[] = [];
	readonly requests: IModelRequest[] = [];
	async detect() { return { available: true, authenticated: true }; }
	async listModels() { return [{ id: 'fm', label: 'FM', capabilities: DEFAULT_MODEL_CAPABILITIES }]; }
	async *stream(request: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		this.requests.push(request);
		const turn = this.turns.shift();
		if (turn) {
			yield* turn(request, token);
			return;
		}
		yield { type: 'text.delta', id: 't', delta: 'ok' };
		yield { type: 'finish', reason: 'stop' };
	}
}

/** An ACP agent: records starts and prompts, and how many prompts ever ran at once on one handle. */
class FakeAgent implements IAgentProvider {
	readonly id = 'fake-agent';
	readonly label = 'Fake agent';
	readonly starts: IAgentStartRequest[] = [];
	readonly prompts: IAgentMessage[] = [];
	/** The handle each prompt went to. */
	readonly promptHandles: string[] = [];
	readonly disposed: string[] = [];
	readonly turns: Turn<IAgentMessage>[] = [];
	private readonly live = new Map<string, number>();
	maxConcurrent = 0;
	async detect() { return { available: true, authenticated: true }; }
	async listModels() { return [{ id: 'm1', label: 'M1', capabilities: DEFAULT_ACP_CAPABILITIES }]; }
	async start(request: IAgentStartRequest): Promise<IAgentSessionHandle> {
		this.starts.push(request);
		return { id: `h${this.starts.length}` };
	}
	isLive() { return true; }
	async *send(handle: IAgentSessionHandle, message: IAgentMessage, _profile: IProviderProfile, token: CancellationToken): AsyncIterable<IVoltEvent> {
		this.prompts.push(message);
		this.promptHandles.push(handle.id);
		const running = (this.live.get(handle.id) ?? 0) + 1;
		this.live.set(handle.id, running);
		this.maxConcurrent = Math.max(this.maxConcurrent, running);
		try {
			const turn = this.turns.shift();
			if (turn) {
				yield* turn(message, token);
			} else {
				yield { type: 'text.delta', id: 't', delta: 'done' };
				yield { type: 'run.end', runId: handle.id, reason: 'done' };
			}
		} finally {
			this.live.set(handle.id, (this.live.get(handle.id) ?? 1) - 1);
		}
	}
	async interrupt() { }
	async dispose(handle: IAgentSessionHandle) { this.disposed.push(handle.id); }
}

/** Shell: answers the project's test command from a script; everything else is "not found". */
class FakeStdio {
	readonly execs: IVoltExecRequest[] = [];
	readonly checkOutputs: { output: string; exitCode: number }[] = [];
	readonly checkRan = new DeferredPromise<void>();
	asService(): IVoltStdioService {
		return {
			onData: Event.None,
			onExit: Event.None,
			spawn: async () => { throw new Error('no spawn in tests'); },
			write: async () => { },
			kill: async () => { },
			which: async () => undefined,
			exec: async (request: IVoltExecRequest): Promise<IVoltExecResult> => {
				this.execs.push(request);
				const scripted = request.command === 'npm test' ? this.checkOutputs.shift() : undefined;
				if (request.command === 'npm test') {
					this.checkRan.complete();
				}
				const output = scripted?.output ?? '';
				return { id: request.id, exitCode: scripted?.exitCode ?? 127, stdout: output, stderr: '', combined: output, truncated: false, durationMs: 5, timedOut: false, cancelled: false, running: false };
			},
			cancelExec: async () => { },
			jobOutput: async () => undefined,
			jobWait: async () => undefined,
			listJobs: async () => [],
		} as unknown as IVoltStdioService;
	}
}

interface IRuntimeInternals {
	modelProviders: Map<string, IModelProvider>;
	agentProviders: Map<string, IAgentProvider>;
	profiles: IProviderProfile[];
	catalog: IVoltCatalogItem[];
	deepseek?: never;
	sessions: Map<string, { deepseek?: { messages: { role: string; content: string }[] } }>;
}

const BEFORE = '✔ mean (0.3ms)\n✖ median sorts numerically (0.3ms)\nℹ pass 1\nℹ fail 1';
const REGRESSED = '✖ mean (0.3ms)\n✖ median sorts numerically (0.3ms)\nℹ pass 0\nℹ fail 2';

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (predicate()) {
			return;
		}
		await timeout(5);
	}
	assert.fail(`timed out waiting for ${what}`);
}

suite('Agent runtime orchestration', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(kind: 'model' | 'agent', files: Record<string, string> = {}) {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		await fileService.createFolder(ROOT);
		for (const [path, content] of Object.entries(files)) {
			await fileService.writeFile(joinPath(ROOT, path), VSBuffer.fromString(content));
		}
		const stdio = new FakeStdio();
		const model = new FakeModel();
		const agent = new FakeAgent();
		const stub = <T>(value: object) => value as unknown as T;
		const service = disposables.add(new AgentRuntimeService(
			disposables.add(new InMemoryStorageService()),
			stub({ get: async () => undefined, set: async () => { }, delete: async () => { } }),
			stub({ request: async () => { throw new Error('offline'); } }),
			stub({ getWorkspace: () => ({ folders: [{ uri: ROOT }] }), isInsideWorkspace: (uri: URI) => isEqualOrParent(uri, ROOT) }),
			fileService as IFileService,
			new NullLogService(),
			stdio.asService(),
			stub({ setQuestionHandler: () => { }, setApprover: () => { }, setSessionResolver: () => { }, onDidInvokeTool: Event.None, onDidChangeMcp: Event.None, getMcpServers: () => [], listTools: () => [], invokeTool: async () => ({}) }),
			stub({}),
			stub({ rootFor: () => undefined }),
			stub({ open: () => ({ setMeta: () => { } }), setAgentTitle: async () => { } }),
			stub({}),
			stub({ files: { get: () => undefined } }),
			stub({ userHome: async () => { throw new Error('no home'); } }),
			stub({}),
			stub({}),
			stub({}),
			stub({ userRoamingDataHome: URI.file('/user') }),
		));
		await service.refreshProviders();
		const internals = service as unknown as IRuntimeInternals;
		internals.modelProviders.set(model.id, model);
		internals.agentProviders.set(agent.id, agent);
		internals.profiles = [];
		const profile = await service.upsertProfile(kind === 'model'
			? { kind: 'model', label: 'Fake', providerId: model.id, transport: 'http', authKind: 'none' }
			: { kind: 'agent', label: 'Fake', providerId: agent.id, transport: 'stdio', authKind: 'cli' });
		await service.refreshCatalog();
		const ref = kind === 'model' ? `model:${profile.id}:fm` : `agent:${profile.id}:m1`;
		assert.ok(service.listCatalog().some(item => item.ref === ref), 'fake model is in the catalog');
		const events: IVoltEventEnvelope[] = [];
		disposables.add(service.onEvent('chat', envelope => events.push(envelope)));
		const ended = (runId: string) => events.find(envelope => envelope.runId === runId && envelope.event.type === 'run.end');
		const waitEnd = async (runId: string) => {
			await waitFor(() => !!ended(runId), `run ${runId} to end`);
			return ended(runId)!.event as Extract<IVoltEvent, { type: 'run.end' }>;
		};
		return { service, internals, model, agent, stdio, events, ref, waitEnd, ended };
	}

	test('a native run streams, ends done, keeps the reply and records its timings', async () => {
		const { service, ref, waitEnd } = await setup('model');
		const runId = await service.send('chat', { text: 'hi', mode: 'agent', providerRef: ref });
		assert.strictEqual((await waitEnd(runId)).reason, 'done');
		assert.deepStrictEqual(service.getOrCreateSession('chat').messages.map(message => `${message.role}:${message.content}`), ['user:hi', 'assistant:ok']);
		const [metrics] = service.getRunMetrics('chat');
		assert.strictEqual(metrics.engine, 'native');
		assert.strictEqual(metrics.outcome, 'done');
		assert.ok(metrics.firstTextMs !== undefined && metrics.totalMs !== undefined && metrics.firstTextMs <= metrics.totalMs);
	});

	test('cancel then immediate resend (native): the cancelled loop cannot write into the new run', async () => {
		const { service, internals, model, events, ref, waitEnd } = await setup('model');
		const release = new DeferredPromise<void>();
		// A provider that ignores cancellation and answers late.
		model.turns.push(async function* () {
			await release.p;
			yield { type: 'text.delta', id: 'late', delta: 'LATE' };
			yield { type: 'finish', reason: 'stop' };
		});
		const first = await service.send('chat', { text: 'one', mode: 'agent', providerRef: ref });
		await waitFor(() => model.requests.length === 1, 'the first model call');
		await service.cancel('chat');
		assert.strictEqual((await waitEnd(first)).reason, 'abort');
		const second = await service.send('chat', { text: 'two', mode: 'agent', providerRef: ref });
		release.complete();
		assert.strictEqual((await waitEnd(second)).reason, 'done');
		await timeout(20);
		const afterEnd = events.findIndex(envelope => envelope.runId === first && envelope.event.type === 'run.end');
		assert.ok(!events.slice(afterEnd + 1).some(envelope => envelope.runId === first), 'no events from the cancelled run after its end');
		assert.deepStrictEqual(service.getOrCreateSession('chat').messages.map(message => message.content), ['one', 'two', 'ok']);
		const transcript = internals.sessions.get('chat')!.deepseek!.messages.map(message => message.content);
		assert.ok(!transcript.includes('LATE'), 'the late reply stays out of the transcript');
		assert.deepStrictEqual(transcript.filter(content => content === 'one' || content === 'two'), ['one', 'two']);
	});

	test('a failed run does not poison the next send', async () => {
		const { service, agent, ref, waitEnd } = await setup('agent');
		agent.turns.push(async function* () {
			yield { type: 'error', message: 'Model quota exceeded', retryable: false };
			yield { type: 'run.end', runId: 'x', reason: 'fail' };
		});
		const first = await service.send('chat', { text: 'one', mode: 'agent', providerRef: ref });
		assert.strictEqual((await waitEnd(first)).reason, 'fail');
		assert.strictEqual(service.getOrCreateSession('chat').activeRun?.status, 'failed');
		const second = await service.send('chat', { text: 'two', mode: 'agent', providerRef: ref });
		assert.strictEqual((await waitEnd(second)).reason, 'done');
		assert.strictEqual(agent.starts.length, 1, 'the live agent is reused, and a failed run leaves no spare behind');
		assert.deepStrictEqual(service.getOrCreateSession('chat').messages.map(message => message.content), ['one', 'two', 'done']);
	});

	test('cancel then resend (ACP): the next prompt waits for the cancelled one, whose late text is dropped', async () => {
		const { service, agent, ref, waitEnd } = await setup('agent');
		agent.turns.push(async function* (_message, token) {
			yield { type: 'text.delta', id: 't', delta: 'partial ' };
			await new Promise<void>(resolve => {
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					resolve();
				});
			});
			await timeout(30);
			yield { type: 'text.delta', id: 't', delta: 'LATE' };
			yield { type: 'run.end', runId: 'x', reason: 'abort' };
		});
		const first = await service.send('chat', { text: 'one', mode: 'agent', providerRef: ref });
		await waitFor(() => agent.prompts.length === 1, 'the first prompt');
		await service.cancel('chat');
		const second = await service.send('chat', { text: 'two', mode: 'agent', providerRef: ref });
		assert.strictEqual((await waitEnd(first)).reason, 'abort');
		assert.strictEqual((await waitEnd(second)).reason, 'done');
		assert.strictEqual(agent.maxConcurrent, 1, 'prompts never overlap on one agent session');
		const messages = service.getOrCreateSession('chat').messages.map(message => message.content);
		assert.deepStrictEqual(messages, ['one', 'two', 'done']);
		assert.strictEqual(agent.prompts[1].lead?.includes('<conversation_so_far>') ?? false, false, 'the agent saw the cancelled prompt, so nothing is recapped');
	});

	test('prewarm fills the pool; a new chat adopts the spare and another is started for the next one', async () => {
		const { service, agent, ref, waitEnd } = await setup('agent');
		service.prewarmAgent('chat', ref, 'agent');
		await waitFor(() => agent.starts.length === 1, 'the spare to start');
		assert.ok(agent.starts[0].sessionId?.startsWith('volt-pool-'), 'spares run under an alias');
		const runId = await service.send('chat', { text: 'hi', mode: 'agent', providerRef: ref });
		assert.strictEqual((await waitEnd(runId)).reason, 'done');
		assert.strictEqual(service.getRunMetrics('chat')[0].agentSource, 'pool');
		await waitFor(() => agent.starts.length === 2, 'a replacement spare');
		const followUp = await service.send('chat', { text: 'again', mode: 'agent', providerRef: ref });
		await waitEnd(followUp);
		assert.strictEqual(agent.starts.length, 2, 'a follow-up reuses the chat\'s own agent');
		assert.strictEqual(service.getRunMetrics('chat')[1].agentSource, 'live');
	});

	test('a regression against the baseline sends the agent back once, with the evidence', async () => {
		const { service, agent, stdio, events, ref, waitEnd } = await setup('agent', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
		await service.setAccessMode('full-access');
		stdio.checkOutputs.push({ output: BEFORE, exitCode: 1 }, { output: REGRESSED, exitCode: 1 });
		agent.turns.push(async function* () {
			await stdio.checkRan.p;
			await timeout(5);
			yield { type: 'tool.start', callId: 'e1', name: 'Edit', kind: 'edit' };
			yield { type: 'file.change', uri: joinPath(ROOT, 'src/stats.js'), kind: 'edit' };
			yield { type: 'tool.end', callId: 'e1' };
			yield { type: 'text.delta', id: 't', delta: 'Changed it.' };
			yield { type: 'run.end', runId: 'x', reason: 'done' };
		});
		const runId = await service.send('chat', { text: 'Refactor mean()', mode: 'agent', providerRef: ref });
		assert.strictEqual((await waitEnd(runId)).reason, 'done');
		assert.strictEqual(stdio.execs.filter(exec => exec.command === 'npm test').length, 2, 'baseline and after');
		assert.strictEqual(agent.prompts.length, 2);
		assert.ok(agent.prompts[1].text.includes('- mean'));
		assert.ok(!agent.prompts[1].text.includes('- median sorts numerically'), 'the pre-existing failure is not blamed on the run');
		assert.ok(events.some(envelope => envelope.event.type === 'notice' && envelope.event.title.startsWith('1 test that passed before now fails')));
		assert.strictEqual(service.getRunMetrics('chat')[0].continuations, 1);
	});

	test('pre-existing failures alone never send the agent back', async () => {
		const { service, agent, stdio, ref, waitEnd } = await setup('agent', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
		await service.setAccessMode('full-access');
		stdio.checkOutputs.push({ output: BEFORE, exitCode: 1 }, { output: BEFORE, exitCode: 1 });
		agent.turns.push(async function* () {
			await stdio.checkRan.p;
			await timeout(5);
			yield { type: 'file.change', uri: joinPath(ROOT, 'src/a.js'), kind: 'edit' };
			yield { type: 'run.end', runId: 'x', reason: 'done' };
		});
		await waitEnd(await service.send('chat', { text: 'tweak', mode: 'agent', providerRef: ref }));
		assert.strictEqual(agent.prompts.length, 1);
	});

	test('Ask mode and supervised access never run project checks', async () => {
		const { service, stdio, ref, waitEnd } = await setup('agent', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
		await waitEnd(await service.send('chat', { text: 'explain', mode: 'agent', providerRef: ref }));
		await service.setAccessMode('full-access');
		await waitEnd(await service.send('chat', { text: 'why?', mode: 'ask', providerRef: ref }));
		assert.strictEqual(stdio.execs.filter(exec => exec.command === 'npm test').length, 0);
	});

	test('open to-dos at the end get one nudge', async () => {
		const { service, agent, ref, waitEnd } = await setup('agent');
		agent.turns.push(async function* () {
			yield { type: 'plan', entries: [{ content: 'Write the route', status: 'completed' }, { content: 'Add tests', status: 'pending' }] };
			yield { type: 'run.end', runId: 'x', reason: 'done' };
		});
		agent.turns.push(async function* () {
			yield { type: 'text.delta', id: 't', delta: 'Tests are out of scope.' };
			yield { type: 'run.end', runId: 'x', reason: 'done' };
		});
		await waitEnd(await service.send('chat', { text: 'add a route', mode: 'agent', providerRef: ref }));
		assert.strictEqual(agent.prompts.length, 2);
		assert.ok(agent.prompts[1].text.includes('- Add tests'));
		assert.ok(!agent.prompts[1].text.includes('Write the route'));
		assert.strictEqual(service.getOrCreateSession('chat').messages.at(-1)?.content, 'Tests are out of scope.');
	});

	test('restart: the idle agent is let go and the next prompt starts a fresh one with the conversation', async () => {
		const { service, agent, ref, waitEnd } = await setup('agent');
		await waitEnd(await service.send('chat', { text: 'one', mode: 'agent', providerRef: ref }));
		const [first] = agent.promptHandles;
		// The first run leaves a spare behind for the next chat; it was started with the old setup.
		await waitFor(() => agent.starts.length === 2, 'the replacement spare');
		const spare = `h${agent.starts.length}`;

		assert.strictEqual(await service.restartAgent('chat'), true);
		assert.ok(agent.disposed.includes(first), 'the old agent process is stopped');
		await waitFor(() => agent.disposed.includes(spare), 'the stale spare to stop');

		assert.strictEqual((await waitEnd(await service.send('chat', { text: 'two', mode: 'agent', providerRef: ref }))).reason, 'done');
		assert.notStrictEqual(agent.promptHandles[1], first, 'a fresh agent');
		assert.notStrictEqual(agent.promptHandles[1], spare, 'not the stale spare either');
		const lead = agent.prompts[1].lead ?? '';
		assert.ok(lead.includes('<conversation_so_far>') && lead.includes('User: one') && lead.includes('Assistant'), 'the fresh agent gets the conversation');
		assert.deepStrictEqual(service.getOrCreateSession('chat').messages.map(message => message.content), ['one', 'done', 'two', 'done']);
		assert.strictEqual(await service.restartAgent('never-used'), true, 'a chat with no agent yet has nothing to stop');
	});

	test('restart refuses while a turn runs; with cancel it stops the turn first', async () => {
		const { service, agent, ref, waitEnd } = await setup('agent');
		agent.turns.push(async function* (_message, token) {
			yield { type: 'text.delta', id: 't', delta: 'working ' };
			await new Promise<void>(resolve => {
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					resolve();
				});
			});
			yield { type: 'run.end', runId: 'x', reason: 'abort' };
		});
		const first = await service.send('chat', { text: 'one', mode: 'agent', providerRef: ref });
		await waitFor(() => agent.prompts.length === 1, 'the first prompt');
		const [working] = agent.promptHandles;
		assert.strictEqual(await service.restartAgent('chat'), false);
		assert.ok(!agent.disposed.includes(working), 'nothing stopped while the turn runs');

		assert.strictEqual(await service.restartAgent('chat', { cancel: true }), true);
		assert.strictEqual((await waitEnd(first)).reason, 'abort');
		assert.ok(agent.disposed.includes(working));
		await waitEnd(await service.send('chat', { text: 'two', mode: 'agent', providerRef: ref }));
		assert.notStrictEqual(agent.promptHandles[1], working, 'the next prompt starts a fresh agent');
		assert.strictEqual(agent.maxConcurrent, 1);
	});

	test('steering a live native run is not a user turn', async () => {
		const { service, model, ref, waitEnd } = await setup('model');
		const release = new DeferredPromise<void>();
		model.turns.push(async function* () {
			await release.p;
			yield { type: 'text.delta', id: 't', delta: 'first' };
			yield { type: 'finish', reason: 'stop' };
		});
		assert.strictEqual(service.canSteer('chat'), false);
		const runId = await service.send('chat', { text: 'one', mode: 'agent', providerRef: ref });
		await waitFor(() => model.requests.length === 1, 'the model call');
		assert.strictEqual(service.canSteer('chat'), true);
		assert.strictEqual(service.steer('chat', 'also this'), true);
		release.complete();
		await waitEnd(runId);
		assert.strictEqual(service.steer('chat', 'too late'), false);
		// The steer arrived while the model was answering; it still reached the model before the run ended.
		assert.ok(model.requests.at(-1)!.messages.some(message => message.role === 'user' && message.content === 'also this'));
		await waitEnd(await service.send('chat', { text: 'two', mode: 'agent', providerRef: ref }));
		const session = service.getOrCreateSession('chat');
		assert.deepStrictEqual(session.messages.map(message => `${message.content}${message.steer ? ' (steer)' : ''}`), ['one', 'also this (steer)', 'ok', 'two', 'ok']);
		service.truncateSession('chat', 1);
		assert.deepStrictEqual(session.messages.map(message => message.content), ['one', 'also this', 'ok']);
	});
});
