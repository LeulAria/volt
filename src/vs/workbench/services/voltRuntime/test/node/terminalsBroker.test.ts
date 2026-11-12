/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The terminals broker (spec I.7) over real managed terminals and a backend that records launches.
 *
 * TERM-1: a plugin's terminal always runs sandboxed, scoped to its folders, writable only with
 * `files.write`, its network limited to its hosts. TERM-2: acting for a chat it is never wider than
 * the chat. LIFE-PATH-1 (broker): a sandboxed chat's terminal runs in the chat's own sandbox and
 * never starts in a folder outside it. TERM-3: reads cover the caller's own terminals; another
 * chat's need `agents.read:other`; the user's never. TERM-4: send and stop only on its own; a
 * revoked principal's terminals stop; a forged principal is refused; every call is audited.
 */

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICallContext, IPrincipal, SubjectKey } from '../../../../../platform/voltSandbox/common/principals.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { VoltExecReason } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { BrokerHost, grant, outcome } from '../../../../../platform/voltSandbox/test/node/brokerFixture.js';
import { chatExec, IChatExec, userExec } from '../../common/execContext.js';
import { IAgentRuntimeService } from '../../common/runtime.js';
import { IManagedTerminalBackend, IManagedTerminalExit, IManagedTerminalLaunch, IManagedTerminalProcess, ManagedTerminals } from '../../common/terminals/managedTerminals.js';
import { ITerminalsScope, narrowerSandbox, TerminalsBroker } from '../../common/terminals/terminalsBroker.js';

const PLUGIN: SubjectKey = 'plugin:acme.runner@local';
const WRITER: SubjectKey = 'plugin:acme.builder@local';
const SPY: SubjectKey = 'plugin:acme.spy@local';
const NO_RUN: SubjectKey = 'plugin:acme.nothing@local';
const CHAT_RO = 'chat-ro';
const CHAT_WRITE = 'chat-write';
const CHAT_OFF = 'chat-off';
const SETTINGS: Record<string, IVoltSandboxSettings> = {
	[CHAT_RO]: { level: 'read-only', network: false },
	[CHAT_WRITE]: { level: 'workspace-write', network: true, allowedDomains: ['registry.npmjs.org'] },
	[CHAT_OFF]: { level: 'off', network: true },
};

class RecordingBackend implements IManagedTerminalBackend {
	readonly launches: IManagedTerminalLaunch[] = [];
	readonly typed: string[] = [];
	readonly output = new Map<string, Emitter<string>>();
	private readonly store = new DisposableStore();

	async spawn(launch: IManagedTerminalLaunch): Promise<IManagedTerminalProcess> {
		this.launches.push(launch);
		const data = this.store.add(new Emitter<string>());
		const exit = this.store.add(new Emitter<IManagedTerminalExit>());
		this.output.set(launch.id, data);
		return {
			onData: data.event,
			onExit: exit.event,
			onClosed: Event.None,
			ready: Promise.resolve(),
			viewable: true,
			sendText: async value => {
				if (value === '\u0003') {
					exit.fire({ code: 130 });
					return;
				}
				this.typed.push(value);
			},
			kill: () => exit.fire({ code: 137 }),
		};
	}

	dispose(): void {
		this.store.dispose();
	}
}

suite('Volt terminals broker (I.7)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let store: DisposableStore;
	let host: BrokerHost;
	let backend: RecordingBackend;
	let terminals: ManagedTerminals;
	let broker: TerminalsBroker;

	const chatExecOf = (id: string, reason: VoltExecReason = 'terminal'): IChatExec | undefined => SETTINGS[id] ? chatExec(id, SETTINGS[id], [`/ws/${id}`], reason) : undefined;

	function scope(principal: IPrincipal): ITerminalsScope | undefined {
		return principal.subject.startsWith('plugin:') ? { roots: [`/ws/${CHAT_WRITE}`, '/ws/plugin'], allowedDomains: ['api.acme.example'] } : undefined;
	}

	setup(() => {
		store = disposables.add(new DisposableStore());
		backend = new RecordingBackend();
		store.add({ dispose: () => backend.dispose() });
		host = new BrokerHost(store, {
			manifests: [
				{ subject: PLUGIN, declared: [{ id: 'terminals.run' }, { id: 'terminals.read' }], network: 'broker' },
				{ subject: WRITER, declared: [{ id: 'terminals.run' }, { id: 'terminals.read' }, { id: 'files.write' }], network: 'broker' },
				{ subject: SPY, declared: [{ id: 'terminals.read' }, { id: 'agents.read:other' }], network: 'none' },
				{ subject: NO_RUN, declared: [{ id: 'terminals.read' }], network: 'none' },
			],
			grants: [grant(PLUGIN, 'terminals.run'), grant(PLUGIN, 'terminals.read'), grant(WRITER, 'terminals.run'), grant(WRITER, 'terminals.read'), grant(WRITER, 'files.write'), grant(SPY, 'terminals.read'), grant(NO_RUN, 'terminals.read')],
			chats: Object.entries(SETTINGS).map(([id, settings]) => ({ subject: `chat:${id}` as SubjectKey, settings })),
		});
		const runtime = {
			onDidChangeAgentBackgroundTask: Event.None,
			chatFor: (id: string) => id,
			chatExec: (id: string, reason: VoltExecReason) => chatExecOf(id, reason),
		} as unknown as IAgentRuntimeService;
		terminals = store.add(new ManagedTerminals(backend, runtime, {} as IFileService, () => '/ws'));
		broker = new TerminalsBroker({ authority: host.authority, callers: host.registry, audit: host.audit, terminals, chatExec: id => chatExecOf(id), scope });
		store.add(broker);
	});

	const lastLaunch = () => backend.launches[backend.launches.length - 1];

	test('TERM-1: a plugin\'s terminal always runs sandboxed in its folders; writable only with files.write; network only to its hosts', async () => {
		const reader = host.connect(PLUGIN);
		await broker.run(reader.context, { command: 'npm test' });
		const sandbox = lastLaunch().exec.sandbox;
		assert.ok(sandbox, 'a plugin terminal without a sandbox');
		assert.strictEqual(sandbox.level, 'read-only');
		assert.strictEqual(sandbox.network, false);
		assert.deepStrictEqual(sandbox.allowedDomains, ['api.acme.example']);
		assert.deepStrictEqual(sandbox.workspaceRoots, [`/ws/${CHAT_WRITE}`, '/ws/plugin']);
		assert.strictEqual(lastLaunch().exec.context.sandboxed, true);
		assert.strictEqual(lastLaunch().cwd, `/ws/${CHAT_WRITE}`);

		const writer = host.connect(WRITER);
		await broker.run(writer.context, { command: 'npm run build', cwd: '/ws/plugin/sub' });
		assert.strictEqual(lastLaunch().exec.sandbox?.level, 'workspace-write');
		assert.strictEqual(await outcome(broker.run(writer.context, { command: 'ls', cwd: '/etc' })), 'denied');
		assert.strictEqual(await outcome(broker.run(writer.context, { command: 'ls', cwd: '/ws/plugin/../../etc' })), 'denied');

		const none = host.connect(NO_RUN);
		assert.strictEqual(await outcome(broker.run(none.context, { command: 'ls' })), 'denied');
	});

	test('TERM-2: acting for a chat, a plugin\'s terminal is never wider than the chat', async () => {
		const writer = host.connect(WRITER);
		const readOnly = host.connect(`chat:${CHAT_RO}`, 'agent');
		const writing = host.connect(`chat:${CHAT_WRITE}`, 'agent');
		const off = host.connect(`chat:${CHAT_OFF}`, 'agent');

		// The read-only chat shares no folder with the plugin: nothing runs.
		assert.strictEqual(await outcome(broker.run(host.registry.route(readOnly.context, writer.channel, 'r1')!, { command: 'ls' })), 'denied');

		await broker.run(host.registry.route(writing.context, writer.channel, 'r2')!, { command: 'npm i' });
		const narrowed = lastLaunch().exec.sandbox!;
		assert.deepStrictEqual(narrowed.workspaceRoots, [`/ws/${CHAT_WRITE}`]);
		assert.strictEqual(narrowed.network, false, 'the plugin\'s network is off, so the chat\'s on does not widen it');
		assert.strictEqual(narrowed.allowedDomains, undefined, 'no host both may reach');
		assert.strictEqual(lastLaunch().exec.context.onBehalfOf, CHAT_WRITE);

		// An unsandboxed chat does not unsandbox the plugin.
		await broker.run(host.registry.route(off.context, writer.channel, 'r3')!, { command: 'ls' });
		assert.ok(lastLaunch().exec.sandbox, 'a plugin acting for an unsandboxed chat still runs sandboxed');

		assert.deepStrictEqual(narrowerSandbox(
			{ level: 'workspace-write', network: true, providerId: '', workspaceRoots: ['/a', '/b/c'], allowedDomains: ['x.example', 'y.example'] },
			{ level: 'read-only', network: true, providerId: 'claude-code', workspaceRoots: ['/b'], allowedDomains: ['y.example'] },
		), { level: 'read-only', network: true, providerId: '', workspaceRoots: ['/b/c'], allowedDomains: ['y.example'] });
	});

	test('LIFE-PATH-1 (broker): a sandboxed chat\'s terminal runs in the chat\'s own sandbox; a folder outside it is refused', async () => {
		const chat = host.connect(`chat:${CHAT_RO}`, 'agent');
		await broker.run(chat.context, { command: 'touch /etc/x' });
		assert.deepStrictEqual(lastLaunch().exec, chatExecOf(CHAT_RO));
		assert.strictEqual(lastLaunch().exec.sandbox?.level, 'read-only');
		assert.strictEqual(await outcome(broker.run(chat.context, { command: 'ls', cwd: '/Users/me' })), 'denied');
		// The chat's own terminals include those its agent started with terminal_start.
		await terminals.start(CHAT_RO, { command: 'npm run dev', exec: chatExecOf(CHAT_RO)! });
		const listed = await broker.list(chat.context);
		assert.strictEqual(listed.length, 2);
	});

	test('TERM-3: reads cover the caller\'s own terminals; another chat\'s need agents.read:other; the user\'s never', async () => {
		const plugin = host.connect(PLUGIN);
		const mine = await broker.run(plugin.context, { command: 'npm test' });
		backend.output.get(mine.id)!.fire('ok 1 passed\n');
		const own = await broker.read(plugin.context, { id: mine.id });
		assert.ok(own.text.includes('ok 1 passed'));

		const chatTerminal = await terminals.start(CHAT_WRITE, { command: 'npm run dev', exec: chatExecOf(CHAT_WRITE)! });
		backend.output.get(chatTerminal.id)!.fire('TOKEN=secret-from-chat\n');
		const userTerminal = await terminals.start(CHAT_WRITE, { command: 'zsh', exec: userExec() });
		const unknownOwner = await terminals.start(CHAT_WRITE, { command: 'zsh' });

		assert.strictEqual(await outcome(broker.read(plugin.context, { id: chatTerminal.id })), 'denied', 'another chat needs agents.read:other');
		const spy = host.connect(SPY);
		assert.strictEqual(await outcome(broker.read(spy.context, { id: chatTerminal.id })), 'denied', 'declared but not granted');
		host.update({ grants: [...host.grants, grant(SPY, 'agents.read:other')] });
		assert.ok((await broker.read(spy.context, { id: chatTerminal.id })).text.includes('TOKEN'));
		for (const id of [userTerminal.id, unknownOwner.id, mine.id, 'term-404']) {
			assert.strictEqual(await outcome(broker.read(spy.context, { id })), 'handle', id);
		}
		// The chat itself reads its own; a sandboxed chat may not read another chat's.
		const owner = host.connect(`chat:${CHAT_WRITE}`, 'agent');
		assert.strictEqual(await outcome(broker.read(owner.context, { id: chatTerminal.id })), 'ok');
		const other = host.connect(`chat:${CHAT_RO}`, 'agent');
		assert.strictEqual(await outcome(broker.read(other.context, { id: chatTerminal.id })), 'denied');
	});

	test('TERM-4: send and stop only on its own; a revoked principal\'s terminals stop; a forged principal is refused; audited', async () => {
		const plugin = host.connect(PLUGIN);
		const other = host.connect(WRITER);
		const mine = await broker.run(plugin.context, { command: 'node repl.js' });
		await broker.send(plugin.context, { id: mine.id, text: '1+1' });
		assert.deepStrictEqual(backend.typed, ['1+1']);
		assert.strictEqual(await outcome(broker.send(other.context, { id: mine.id, text: 'rm -rf ~' })), 'handle');
		assert.strictEqual(await outcome(broker.stop(other.context, { id: mine.id })), 'handle');
		assert.deepStrictEqual(backend.typed, ['1+1']);

		const forged: ICallContext = { principal: { ...plugin.principal }, onBehalfOf: [], requestId: 'forged' };
		assert.strictEqual(await outcome(broker.run(forged, { command: 'ls' })), 'unauthenticated');

		host.registry.revoke(plugin.principal.id);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(terminals.managed(mine.id)?.status, 'stopped');

		// A revoked grant: the next run is refused.
		host.update({ grants: host.grants.filter(g => g.subject !== WRITER) });
		assert.strictEqual(await outcome(broker.run(other.context, { command: 'ls' })), 'denied');

		const methods = host.audit.events.map(event => `${event.method}:${event.decision}`);
		assert.deepStrictEqual(methods, ['run:allow', 'send:allow', 'send:deny', 'stop:deny', 'run:deny', 'run:deny']);
		assert.ok(host.audit.events.every(event => !event.target || !event.target.includes('node repl.js')), 'targets are redacted by the sink');
	});
});
