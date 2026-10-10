/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAccessDecision } from '../../common/access/accessTypes.js';
import { AcpAgentProvider, acceptedMcpServers, configValueIsCurrent } from '../../browser/agents/acpProvider.js';
import { IVoltEvent } from '../../common/events.js';
import { ACP_IDLE_TIMINGS } from '../../common/harness/acpStall.js';
import { isAcpTurnRestartable } from '../../common/harness/sessionRetry.js';
import { IVoltHostToolService } from '../../common/hostTools.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentStartRequest } from '../../common/providers.js';
import { FakeWatchdogClock } from '../common/harness/fakeWatchdogClock.js';

type Json = Record<string, unknown>;
interface IWire { readonly id?: number | string; readonly method?: string; readonly params?: Json; readonly result?: unknown; readonly error?: unknown }

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const CONFIG_OPTIONS = [
	{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }] },
	{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'grok-4.7', options: [{ value: 'default', name: 'Auto' }, { value: 'grok-4.7', name: 'Grok 4.7' }] },
	{ id: 'context', name: 'Context', category: 'model_config', type: 'select', currentValue: '256k', options: [{ value: '256k', name: '256K' }, { value: '500k', name: '500K' }] },
	{ id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: ['low', 'medium', 'high', 'xhigh'].map(value => ({ value, name: value })) },
	{ id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
];

/** A scripted ACP agent behind a fake stdio service. Setup calls answer at once; prompts wait for the test. */
class FakeAgentStdio {
	private readonly onDataEmitter: Emitter<{ id: string; data: string }>;
	private readonly onExitEmitter: Emitter<{ id: string; code: number | null }>;
	readonly written: { process: string; msg: IWire }[] = [];
	readonly spawned: { command: string; args: readonly string[] }[] = [];
	capabilities: Json = { mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true } };
	/** Top-level `_meta` of the initialize result (Claude advertises `steering` there). */
	initMeta: Json | undefined;
	steeringOutcome = 'injected';
	/** What each new session starts with; every process gets its own copy. */
	configOptions: Json[] = JSON.parse(JSON.stringify(CONFIG_OPTIONS)) as Json[];
	private readonly sessionConfig = new Map<string, Json[]>();

	constructor(store: Pick<DisposableStore, 'add'>) {
		this.onDataEmitter = store.add(new Emitter());
		this.onExitEmitter = store.add(new Emitter());
	}

	asService(): IVoltStdioService {
		return {
			onData: this.onDataEmitter.event,
			onExit: this.onExitEmitter.event,
			spawn: async (options: { command: string; args: string[] }) => {
				this.spawned.push({ command: options.command, args: options.args });
				return `p${this.spawned.length}`;
			},
			write: async (process: string, data: string) => {
				for (const line of data.split('\n').filter(Boolean)) {
					const msg = JSON.parse(line) as IWire;
					this.written.push({ process, msg });
					this.autoAnswer(process, msg);
				}
			},
			kill: async () => undefined,
			which: async (command: string) => `/usr/bin/${command}`,
		} as unknown as IVoltStdioService;
	}

	private autoAnswer(process: string, msg: IWire): void {
		if (msg.id === undefined || !msg.method) {
			return;
		}
		const reply = (result: unknown) => queueMicrotask(() => this.send(process, { jsonrpc: '2.0', id: msg.id, result }));
		switch (msg.method) {
			case 'initialize':
				return reply({ protocolVersion: 1, agentCapabilities: this.capabilities, ...(this.initMeta ? { _meta: this.initMeta } : {}) });
			case '_session/steering':
				return reply({ outcome: this.steeringOutcome });
			case 'session/new':
				this.sessionConfig.set(process, JSON.parse(JSON.stringify(this.configOptions)) as Json[]);
				return reply({ sessionId: `acp-${process}`, configOptions: this.sessionConfig.get(process), modes: { currentModeId: 'agent', availableModes: [{ id: 'agent' }, { id: 'plan' }, { id: 'ask' }] } });
			case 'session/set_config_option': {
				const config = this.sessionConfig.get(process) ?? [];
				const option = config.find(candidate => candidate.id === msg.params?.configId);
				if (option) {
					option.currentValue = String(msg.params?.value);
				}
				return reply({ configOptions: config });
			}
			case 'session/set_mode':
				return reply({});
		}
	}

	send(process: string, msg: Json): void {
		this.onDataEmitter.fire({ id: process, data: `${JSON.stringify(msg)}\n` });
	}

	update(process: string, update: Json): void {
		this.send(process, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: `acp-${process}`, update } });
	}

	prompts(process = 'p1'): IWire[] {
		return this.written.filter(entry => entry.process === process && entry.msg.method === 'session/prompt').map(entry => entry.msg);
	}

	answerPrompt(index: number, result: Json, process = 'p1'): void {
		this.send(process, { jsonrpc: '2.0', id: this.prompts(process)[index].id, result });
	}

	count(method: string, process = 'p1'): number {
		return this.written.filter(entry => entry.process === process && entry.msg.method === method).length;
	}

	promptText(index: number, process = 'p1'): string {
		const blocks = this.prompts(process)[index].params?.prompt as { type: string; text?: string }[];
		return blocks.map(block => block.text ?? `[${block.type}]`).join('');
	}
}

const PROFILE = { id: 'cursor', providerId: 'cursor-acp', label: 'Cursor', kind: 'agent', enabled: true } as unknown as IProviderProfile;

function request(extra: Partial<IAgentStartRequest> = {}): IAgentStartRequest {
	return { mode: 'agent', profile: PROFILE, cwd: '/w', modelId: 'grok-4.7', options: { reasoning: 'high', fastMode: true, contextWindow: '256k' }, ...extra };
}

async function settle(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

function collect(iterable: AsyncIterable<IVoltEvent>): { events: IVoltEvent[]; done: Promise<void> } {
	const events: IVoltEvent[] = [];
	const done = (async () => {
		for await (const event of iterable) {
			events.push(event);
		}
	})();
	return { events, done };
}

const kinds = (events: readonly IVoltEvent[]) => events.map(event => event.type === 'notice' ? `notice:${event.title}` : event.type === 'run.end' ? `run.end:${event.reason}` : event.type);

suite('ACP provider supervision', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(hostTools?: IVoltHostToolService) {
		const agent = new FakeAgentStdio(store);
		const clock = new FakeWatchdogClock();
		const provider = new AcpAgentProvider('cursor-acp', 'Cursor', 'cursor-agent', ['acp'], agent.asService(),
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
			undefined as unknown as IFileService, new NullLogService(), hostTools);
		provider.setSupervisionOptions({ clock, idle: ACP_IDLE_TIMINGS });
		return { agent, clock, provider };
	}

	async function startTurn(env: ReturnType<typeof setup>, text = 'do it') {
		const handle = await env.provider.start(request());
		const cts = store.add(new CancellationTokenSource());
		const turn = collect(env.provider.send(handle, { text, mode: 'agent' }, PROFILE, cts.token));
		await settle();
		return { handle, cts, turn };
	}

	async function finish(env: ReturnType<typeof setup>, handle: { id: string }) {
		await env.provider.dispose(handle);
	}

	test('setup skips config writes the session already has (each costs cursor-agent ~2 s)', async () => {
		const env = setup();
		const handle = await env.provider.start(request());
		assert.deepStrictEqual(env.agent.spawned[0].args, ['--model', 'grok-4.7', 'acp'], 'the CLI starts on the picked model');
		assert.strictEqual(env.agent.count('session/set_config_option'), 0, 'Grok 4.7 High Fast is already what the session runs');
		await finish(env, handle);

		const changed = await env.provider.start(request({ options: { reasoning: 'medium', fastMode: true, contextWindow: '256k' } }));
		const writes = env.agent.written.filter(entry => entry.process === 'p2' && entry.msg.method === 'session/set_config_option').map(entry => `${entry.msg.params?.configId}=${entry.msg.params?.value}`);
		assert.deepStrictEqual(writes, ['reasoning_effort=medium']);
		await finish(env, changed);

		// cursor-agent rejects a boolean for its two-value `fast` select (-32603); it must go out as text.
		const slow = await env.provider.start(request({ options: { reasoning: 'high', fastMode: false, contextWindow: '256k' } }));
		const fast = env.agent.written.filter(entry => entry.process === 'p3' && entry.msg.method === 'session/set_config_option').map(entry => entry.msg.params?.value);
		assert.deepStrictEqual(fast, ['false']);
		await finish(env, slow);
	});

	test('Auto is the "default" choice; a policy mode that is already current is not re-sent', async () => {
		const env = setup();
		env.agent.configOptions = env.agent.configOptions.map(option => option.id === 'model' ? { ...option, currentValue: 'default' } : option);
		const handle = await env.provider.start(request({ modelId: undefined, options: undefined }));
		await env.provider.applyAccessPolicy(handle, { configured: [] } as never);
		assert.strictEqual(env.agent.count('session/set_config_option'), 0);
		assert.strictEqual(env.agent.count('session/set_mode'), 0);
		assert.strictEqual(configValueIsCurrent({ id: 'model', name: 'Model', currentValue: 'default', options: [{ value: 'grok-4.7', name: 'Grok' }] }, 'auto'), false, 'only when Auto is advertised as default');
		await finish(env, handle);
	});

	test('the host MCP server goes only to agents that declare HTTP MCP', async () => {
		const server = { type: 'http' as const, name: 'volt', url: 'http://127.0.0.1:1/mcp/s1', headers: [] };
		assert.deepStrictEqual(acceptedMcpServers([server], { http: true }), [server]);
		assert.deepStrictEqual(acceptedMcpServers([server], { sse: true }), []);
		assert.deepStrictEqual(acceptedMcpServers([server], undefined), []);
		const env = setup({ getMcpServers: () => [server] } as unknown as IVoltHostToolService);
		env.agent.capabilities = { mcpCapabilities: { http: false } };
		const handle = await env.provider.start(request({ sessionId: 's1' }));
		const created = env.agent.written.find(entry => entry.msg.method === 'session/new')!;
		assert.deepStrictEqual(created.msg.params?.mcpServers, []);
		await finish(env, handle);
	});

	test('a session that missed the current host MCP server is not live, so the next turn gets Volt\'s tools', async () => {
		let endpoint: string | undefined;
		const env = setup({ getMcpServers: (sessionId?: string) => endpoint ? [{ type: 'http', name: 'volt', url: `${endpoint}/${sessionId}`, headers: [] }] : [] } as unknown as IVoltHostToolService);
		const sent = () => env.agent.written.filter(entry => entry.msg.method === 'session/new').map(entry => entry.msg.params?.mcpServers).slice(-1)[0];

		// Started before the window's MCP server was up: no volt server, so no render_chart.
		const early = await env.provider.start(request({ sessionId: 's1' }));
		assert.deepStrictEqual(sent(), []);
		assert.strictEqual(env.provider.isLive(early), true);
		endpoint = 'http://127.0.0.1:4000/mcp';
		assert.strictEqual(env.provider.isLive(early), false);
		await finish(env, early);

		const handle = await env.provider.start(request({ sessionId: 's1' }));
		assert.deepStrictEqual(sent(), [{ type: 'http', name: 'volt', url: 'http://127.0.0.1:4000/mcp/s1', headers: [] }]);
		assert.strictEqual(env.provider.isLive(handle), true, 'an unchanged endpoint keeps the session');
		endpoint = 'http://127.0.0.1:4001/mcp';
		assert.strictEqual(env.provider.isLive(handle), false, 'the server restarted on another port');
		await finish(env, handle);

		// An agent without HTTP MCP never gets the server, so a new endpoint changes nothing for it.
		env.agent.capabilities = { mcpCapabilities: { http: false } };
		const noHttp = await env.provider.start(request({ sessionId: 's1' }));
		endpoint = 'http://127.0.0.1:4002/mcp';
		assert.strictEqual(env.provider.isLive(noHttp), true);
		await finish(env, noHttp);
	});

	test('Stop sends one session/cancel even when the token and interrupt() both fire', async () => {
		const env = setup();
		const { handle, cts, turn } = await startTurn(env);
		assert.strictEqual(env.agent.prompts().length, 1);
		cts.cancel();
		await env.provider.interrupt(handle);
		await settle();
		assert.strictEqual(env.agent.count('session/cancel'), 1);
		env.agent.answerPrompt(0, { stopReason: 'cancelled' });
		await turn.done;
		assert.deepStrictEqual(kinds(turn.events), ['run.end:abort']);
		await finish(env, handle);
	});

	test('a cancelled prompt the agent never answers is let go after the linger', async () => {
		const env = setup();
		const { handle, cts, turn } = await startTurn(env);
		cts.cancel();
		await settle();
		env.clock.advance(6 * SECOND);
		await turn.done;
		assert.deepStrictEqual(kinds(turn.events), ['run.end:abort']);
		await finish(env, handle);
	});

	test('a second send waits for the cancelled prompt and never shares its updates (R4)', async () => {
		const env = setup();
		const first = await startTurn(env, 'first');
		first.cts.cancel();
		await settle();
		const cts = store.add(new CancellationTokenSource());
		const second = collect(env.provider.send(first.handle, { text: 'second', mode: 'agent' }, PROFILE, cts.token));
		await settle();
		assert.strictEqual(env.agent.prompts().length, 1, 'the new prompt waits until the cancelled one is answered');
		env.agent.answerPrompt(0, { stopReason: 'cancelled' });
		await settle();
		assert.strictEqual(env.agent.prompts().length, 2);
		assert.strictEqual(env.agent.promptText(1), 'second');
		env.agent.update('p1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply to second' } });
		env.agent.answerPrompt(1, { stopReason: 'end_turn' });
		await Promise.all([first.turn.done, second.done]);
		assert.deepStrictEqual(kinds(first.turn.events), ['run.end:abort']);
		assert.deepStrictEqual(kinds(second.events), ['text.delta', 'run.end:done']);
		await finish(env, first.handle);
	});

	test('a stalled turn: notice, then cancel and resume, then it completes', async () => {
		const env = setup();
		const { handle, turn } = await startTurn(env);
		env.agent.update('p1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning' } });
		await settle();
		env.clock.advance(2 * MINUTE);
		await settle();
		assert.ok(kinds(turn.events).includes('notice:Taking longer than expected'));
		env.clock.advance(4 * MINUTE);
		await settle();
		assert.strictEqual(env.agent.count('session/cancel'), 1);
		assert.ok(turn.events.some(event => event.type === 'retry'));
		env.agent.answerPrompt(0, { stopReason: 'cancelled' });
		await settle();
		assert.strictEqual(env.agent.prompts().length, 2);
		assert.match(env.agent.promptText(1), /Continue exactly where you left off/);
		env.agent.update('p1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
		env.agent.answerPrompt(1, { stopReason: 'end_turn' });
		await turn.done;
		assert.deepStrictEqual(kinds(turn.events), ['reasoning.delta', 'notice:Taking longer than expected', 'retry', 'text.delta', 'run.end:done']);
		await finish(env, handle);
	});

	test('a stall that does not recover fails with a retryable error that does not restart the process', async () => {
		const env = setup();
		const { handle, turn } = await startTurn(env);
		env.agent.update('p1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } });
		await settle();
		env.clock.advance(6 * MINUTE);
		await settle();
		env.clock.advance(6 * SECOND); // the agent ignores the cancel too
		await settle();
		assert.strictEqual(env.agent.prompts().length, 2, 'the resume prompt still goes out');
		env.clock.advance(3 * MINUTE);
		await turn.done;
		const error = turn.events.find(event => event.type === 'error');
		assert.ok(error?.type === 'error' && error.retryable);
		assert.match(error.type === 'error' ? error.message : '', /stopped responding.*even after Volt asked it to continue/);
		assert.strictEqual(isAcpTurnRestartable(error.type === 'error' ? error.message : ''), false);
		assert.strictEqual(kinds(turn.events).at(-1), 'run.end:fail');
		await finish(env, handle);
	});

	test('a prompt that never produced anything is re-sent, then reported as a restartable stall', async () => {
		const env = setup();
		const { handle, turn } = await startTurn(env, 'original ask');
		env.clock.advance(6 * MINUTE);
		await settle();
		env.agent.answerPrompt(0, { stopReason: 'cancelled' });
		await settle();
		assert.strictEqual(env.agent.promptText(1), 'original ask');
		env.clock.advance(3 * MINUTE);
		await turn.done;
		const error = turn.events.find(event => event.type === 'error');
		assert.ok(error?.type === 'error' && isAcpTurnRestartable(error.message), 'the runtime restarts the process once, as before');
		await finish(env, handle);
	});

	test('an open approval pauses the watchdog', async () => {
		const env = setup();
		let approve: ((decision: IAccessDecision) => void) | undefined;
		env.provider.setAccessGate({ evaluate: () => new Promise<IAccessDecision>(resolve => { approve = resolve; }) });
		const { handle, turn } = await startTurn(env);
		env.agent.send('p1', {
			jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
				sessionId: 'acp-p1', toolCall: { toolCallId: 't1', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build' } },
				options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
			},
		});
		await settle();
		assert.ok(approve, 'the gate was asked');
		env.clock.advance(30 * MINUTE);
		await settle();
		assert.deepStrictEqual(kinds(turn.events), [], 'no stall while the user decides');
		approve!({ requestId: 'r', effect: 'allow', scope: 'once' });
		await settle();
		assert.ok(env.agent.written.some(entry => entry.msg.id === 900 && entry.msg.result !== undefined), 'the answer reached the agent');
		env.clock.advance(2 * MINUTE);
		await settle();
		assert.deepStrictEqual(kinds(turn.events), ['notice:Taking longer than expected']);
		env.agent.answerPrompt(0, { stopReason: 'end_turn' });
		await turn.done;
		await finish(env, handle);
	});

	test('the same failing command three times is steered with a corrective prompt', async () => {
		const env = setup();
		const { handle, turn } = await startTurn(env);
		for (let i = 0; i < 3; i++) {
			const toolCallId = `t${i}`;
			env.agent.update('p1', { sessionUpdate: 'tool_call', toolCallId, title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {} });
			env.agent.update('p1', { sessionUpdate: 'tool_call_update', toolCallId, rawInput: { command: 'npm test' }, title: 'npm test' });
			env.agent.update('p1', { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Error: Cannot find module ./sum' } }] });
		}
		await settle();
		assert.ok(kinds(turn.events).includes('notice:Agent looping detected'));
		assert.strictEqual(env.agent.count('session/cancel'), 1);
		env.agent.answerPrompt(0, { stopReason: 'cancelled' });
		await settle();
		assert.match(env.agent.promptText(1), /You ran npm test 3 times and got the same error each time \("Error: Cannot find module \.\/sum"\)/);
		env.agent.answerPrompt(1, { stopReason: 'end_turn' });
		await turn.done;
		assert.strictEqual(kinds(turn.events).at(-1), 'run.end:done');
		await finish(env, handle);
	});

	test('a warm spare is adopted without starting another process', async () => {
		const env = setup();
		await env.provider.prewarmSpare(request());
		assert.strictEqual(env.agent.spawned.length, 1);
		assert.strictEqual(env.provider.hasSpare(request()), true);
		const handle = await env.provider.start(request());
		assert.strictEqual(env.agent.spawned.length, 1, 'adopted');
		assert.strictEqual(env.provider.hasSpare(request()), false);
		assert.strictEqual(env.provider.isLive(handle), true);
		const other = await env.provider.start(request({ modelId: 'grok-4.6' }));
		assert.strictEqual(env.agent.spawned.length, 2, 'a different setup starts its own process');
		await finish(env, handle);
		await finish(env, other);
		await env.provider.prewarmSpare(request({ cwd: '/elsewhere' }));
		await env.provider.disposeSpares();
		assert.strictEqual(env.provider.hasSpare(request({ cwd: '/elsewhere' })), false);
	});

	test('attached images go out as image blocks when the agent accepts them', async () => {
		const env = setup();
		const handle = await env.provider.start(request());
		const cts = store.add(new CancellationTokenSource());
		const message = { text: 'look', mode: 'agent' as const, images: [{ mediaType: 'image/png', data: 'AAAA' }] };
		const turn = collect(env.provider.send(handle, message, PROFILE, cts.token));
		await settle();
		assert.deepStrictEqual(env.agent.prompts()[0].params?.prompt, [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }]);
		env.agent.answerPrompt(0, { stopReason: 'end_turn' });
		await turn.done;
		await finish(env, handle);
	});

	test('native subagents: spawn, child steps kept apart, and the report from the child\'s own text', async () => {
		const env = setup();
		const { handle, turn } = await startTurn(env, 'two footers in parallel');
		const notify = (sessionId: string, update: Json) => env.agent.send('p1', { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
		notify('acp-p1', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'af4e', name: 'Footer home', task: 'Read src/pages/home.ts first', capabilities: {} });
		notify('acp-p1', { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_agent', _meta: { claudeCode: { toolName: 'Agent', toolResponse: { isAsync: true, status: 'async_launched', agentId: 'af4e', resolvedModel: 'claude-haiku-4-5-20251001' } } } });
		notify('af4e', { sessionUpdate: 'tool_call', toolCallId: 'toolu_read', title: 'Read home.ts', kind: 'read', status: 'pending', _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'toolu_agent' } } });
		notify('af4e', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done! Added the footer.' } });
		notify('acp-p1', { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_agent', status: 'completed', rawOutput: [{ type: 'text', text: 'Async agent launched successfully.' }] });
		notify('acp-p1', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'af4e', state: 'completed' });
		await settle();
		assert.deepStrictEqual(kinds(turn.events), ['subagent.spawned', 'subagent.update', 'subagent.update', 'subagent.event', 'subagent.event', 'subagent.completed'], 'nothing of the child reached the parent\'s own steps');
		const spawned = turn.events[0] as Extract<IVoltEvent, { type: 'subagent.spawned' }>;
		assert.deepStrictEqual([spawned.childId, spawned.title, spawned.prompt], ['af4e', 'Footer home', 'Read src/pages/home.ts first']);
		const linked = turn.events[1] as Extract<IVoltEvent, { type: 'subagent.update' }>;
		assert.deepStrictEqual([linked.parentToolCallId, linked.model], ['toolu_agent', 'claude-haiku-4-5-20251001']);
		const done = turn.events.at(-1) as Extract<IVoltEvent, { type: 'subagent.completed' }>;
		assert.deepStrictEqual([done.status, done.result], ['completed', 'Done! Added the footer.']);
		env.agent.answerPrompt(0, { stopReason: 'end_turn' });
		await turn.done;
		await finish(env, handle);
	});

	test('Cursor: a Task that failed says so, and cursor/task is answered with the model it ran on', async () => {
		const env = setup();
		const { handle, turn } = await startTurn(env);
		env.agent.update('p1', { sessionUpdate: 'tool_call', toolCallId: 'tool_1', title: 'Task: Footer pricing', kind: 'other', status: 'pending', rawInput: { _toolName: 'task', description: 'Footer pricing', prompt: 'add it', subagentType: { unspecified: {} } } });
		env.agent.update('p1', { sessionUpdate: 'tool_call_update', toolCallId: 'tool_1', status: 'completed', rawOutput: { error: 'You\'ve hit your usage limit' } });
		env.agent.send('p1', { jsonrpc: '2.0', id: 77, method: 'cursor/task', params: { toolCallId: 'tool_1', description: 'Footer pricing', model: 'gemini-3.8-flash-high', agentId: '7377' } });
		await settle();
		const end = turn.events.find(event => event.type === 'tool.end') as Extract<IVoltEvent, { type: 'tool.end' }>;
		assert.strictEqual(end.error, 'You\'ve hit your usage limit');
		const update = turn.events.find(event => event.type === 'subagent.update') as Extract<IVoltEvent, { type: 'subagent.update' }>;
		assert.deepStrictEqual([update.childId, update.model], ['tool_1', 'gemini-3.8-flash-high']);
		assert.ok(env.agent.written.some(entry => entry.msg.id === 77 && entry.msg.result !== undefined && !entry.msg.error), 'cursor/task got a plain answer, not an error');
		env.agent.answerPrompt(0, { stopReason: 'end_turn' });
		await turn.done;
		await finish(env, handle);
	});

	test('a permission request after the turn ended is refused without asking anyone', async () => {
		const env = setup();
		let asked = false;
		env.provider.setAccessGate({ evaluate: () => { asked = true; return { requestId: 'r', effect: 'allow', scope: 'once' }; } });
		const { handle, turn } = await startTurn(env);
		env.agent.answerPrompt(0, { stopReason: 'cancelled' });
		await turn.done;
		env.agent.send('p1', {
			jsonrpc: '2.0', id: 901, method: 'session/request_permission', params: {
				sessionId: 'acp-p1', toolCall: { toolCallId: 'stale', title: '`sleep 6`', kind: 'execute' },
				options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }],
			},
		});
		await settle();
		assert.strictEqual(asked, false);
		const answer = env.agent.written.find(entry => entry.msg.id === 901)?.msg.result as { outcome?: { optionId?: string } } | undefined;
		assert.ok(answer && JSON.stringify(answer).includes('reject'), JSON.stringify(answer));
		await finish(env, handle);
	});

	test('an agent that advertises steering takes a message mid-turn without being stopped', async () => {
		const env = setup();
		env.agent.initMeta = { steering: { supported: true } };
		const { handle, turn } = await startTurn(env);
		assert.strictEqual(env.provider.canSteer(handle), true);
		assert.strictEqual(await env.provider.steer(handle, 'use the blue footer instead'), true);
		const steering = env.agent.written.find(entry => entry.msg.method === '_session/steering');
		assert.deepStrictEqual(steering?.msg.params?.prompt, [{ type: 'text', text: 'use the blue footer instead' }]);
		assert.strictEqual(env.agent.count('session/cancel'), 0, 'steering never cancels the turn');
		env.agent.steeringOutcome = 'promptRequired';
		assert.strictEqual(await env.provider.steer(handle, 'and more'), false, 'a refusal is reported, so the message is queued instead');
		env.agent.answerPrompt(0, { stopReason: 'end_turn' });
		await turn.done;
		assert.strictEqual(env.provider.canSteer(handle), false, 'nothing to steer between turns');
		await finish(env, handle);
	});

	test('an advertised slash command is known and goes out without the lead', async () => {
		const env = setup();
		const handle = await env.provider.start(request());
		assert.strictEqual(env.provider.supportsCommand(handle, 'compact'), false);
		env.agent.send('p1', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-p1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Clear history but keep a summary' }] } } });
		await settle();
		assert.strictEqual(env.provider.supportsCommand(handle, 'compact'), true);
		const cts = store.add(new CancellationTokenSource());
		const turn = collect(env.provider.send(handle, { text: '/compact', mode: 'agent', lead: '[Volt] framing' }, PROFILE, cts.token));
		await settle();
		const prompt = env.agent.written.find(entry => entry.msg.method === 'session/prompt');
		assert.deepStrictEqual(prompt?.msg.params?.prompt, [{ type: 'text', text: '/compact' }]);
		env.agent.answerPrompt(0, { stopReason: 'end_turn' });
		await turn.done;
		await finish(env, handle);
	});
});
