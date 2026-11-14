/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltExecResult, IVoltJobOutput, IVoltStdioService, IVoltStdioSpawnOptions } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { acpLaunchFor, cliAgentDefinition, cliLoginForNotice, grokAcpArgs, npxCachedLaunchScript, runCli } from '../../browser/agents/cliAgents.js';
import { taskWaitMs } from '../../common/orchestration/agentTasks.js';
import { acpAdapterPreload } from '../../common/claudeAcpPatch.js';

/** Emits the process output from inside spawn(), before the caller learns the id: the IPC race. */
class FastStdio implements IVoltStdioService {
	declare readonly _serviceBrand: undefined;
	private readonly data: Emitter<{ id: string; data: string }>;
	private readonly exit: Emitter<{ id: string; code: number | null }>;
	readonly onData;
	readonly onExit;
	private next = 0;

	constructor(store: DisposableStore, private readonly output: string, private readonly exits = true) {
		this.data = store.add(new Emitter());
		this.exit = store.add(new Emitter());
		this.onData = this.data.event;
		this.onExit = this.exit.event;
	}

	readonly spawns: IVoltStdioSpawnOptions[] = [];

	async spawn(options: IVoltStdioSpawnOptions): Promise<string> {
		this.spawns.push(options);
		const id = `p${this.next++}`;
		this.data.fire({ id: 'other', data: 'noise' });
		this.data.fire({ id, data: this.output });
		if (this.exits) {
			this.exit.fire({ id, code: 0 });
		}
		return id;
	}
	async write(): Promise<void> { }
	async kill(): Promise<void> { }
	async which(): Promise<string | undefined> { return undefined; }
	async exec(): Promise<IVoltExecResult> { throw new Error('not used'); }
	async cancelExec(): Promise<void> { }
	async jobOutput(): Promise<IVoltJobOutput | undefined> { return undefined; }
	async jobWait(): Promise<IVoltJobOutput | undefined> { return undefined; }
	async listJobs(): Promise<readonly IVoltJobOutput[]> { return []; }
}

function assertNpxLaunch(launch: { command: string; args: string[] }, command: string, pkg: string): void {
	if (isWindows) {
		assert.deepStrictEqual(launch, { command: 'npx.cmd', args: ['-y', '--prefer-offline', pkg] });
		return;
	}
	assert.strictEqual(launch.command, '/bin/sh');
	assert.strictEqual(launch.args[0], '-c');
	assert.ok(launch.args[1].endsWith(`exec npx -y --prefer-offline '${pkg}' "$@"`));
	assert.strictEqual(launch.args[2], command);
}

suite('runCli', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps output from a command that finishes before spawn() resolves', async () => {
		const disposables = store.add(new DisposableStore());
		const auth = JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } });
		assert.strictEqual(await runCli(new FastStdio(disposables, auth), 'cat', []), auth);
	});

	test('early output still counts when the exit arrives later or times out', async () => {
		const disposables = store.add(new DisposableStore());
		assert.strictEqual(await runCli(new FastStdio(disposables, 'partial', false), 'slow', [], 10), 'partial');
	});

	test('LIFE-PATH-6: a probe is Volt\'s own question for no chat, with a fixed command line, and says so', async () => {
		const disposables = store.add(new DisposableStore());
		const stdio = new FastStdio(disposables, '1.0.0');
		await runCli(stdio, 'claude', ['--version']);
		assert.deepStrictEqual(stdio.spawns.map(spawn => ({ command: spawn.command, args: spawn.args, context: spawn.context, sandbox: spawn.sandbox })), [
			{ command: 'claude', args: ['--version'], context: { principal: 'volt', reason: 'probe', sandboxed: false }, sandbox: undefined },
		]);
	});

	test('Claude launches the ACP adapter, never `claude acp`', () => {
		const claude = cliAgentDefinition('claude-code');
		assert.deepStrictEqual(acpLaunchFor(claude, 'claude', ['acp'], true), { command: 'claude-agent-acp', args: [] });
		assertNpxLaunch(acpLaunchFor(claude, 'claude', [], false), 'claude-agent-acp', '@agentclientprotocol/claude-agent-acp@0.106.0');
	});

	test('Claude waits for an MCP tool longer than Volt\'s longest task wait', () => {
		// Claude Code's own limit is 60 s ("The operation timed out."): a wait_tasks long-poll of
		// TASK_WAIT_LONG_MS would be cut every minute and the lead woken for nothing.
		const timeout = Number(cliAgentDefinition('claude-code')?.acpEnv?.MCP_TOOL_TIMEOUT);
		assert.ok(timeout > taskWaitMs(true) + 30_000, `MCP_TOOL_TIMEOUT ${timeout} must outlast ${taskWaitMs(true)} ms`);
	});

	test('Codex launches the ACP adapter, never `codex acp`', () => {
		const codex = cliAgentDefinition('codex');
		assert.deepStrictEqual(acpLaunchFor(codex, 'codex', ['acp'], true), { command: 'codex-acp', args: [] });
		assertNpxLaunch(acpLaunchFor(codex, 'codex', ['acp'], false), 'codex-acp', '@agentclientprotocol/codex-acp@1.13.1');
	});

	test('Claude\'s adapter from npx\'s cache runs on node with Volt\'s preload; other adapters run as they are', () => {
		const bin = '/home/u/.npm/_npx/abc/node_modules/.bin/claude-agent-acp';
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('claude-code'), 'claude', [], false, bin), { command: 'node', args: ['--import', acpAdapterPreload('@agentclientprotocol/claude-agent-acp@0.106.0')!, bin] });
		const codexBin = '/home/u/.npm/_npx/def/node_modules/.bin/codex-acp';
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('codex'), 'codex', [], false, codexBin), { command: codexBin, args: [] });
	});

	test('FIRSTWORD-PATH-1: Claude\'s adapter found on PATH runs on node with Volt\'s preload too (compile cache, after-turn patches); a path-less PATH hit runs by name', () => {
		// Round 6: a global `claude-agent-acp` on PATH skipped the preload, which cost the cold start its compile
		// cache and every prompt the deferred skill-file read and sign-in probe.
		const global = '/opt/homebrew/bin/claude-agent-acp';
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('claude-code'), 'claude', [], global), { command: 'node', args: ['--import', acpAdapterPreload('@agentclientprotocol/claude-agent-acp@0.106.0')!, global] });
		// A path on PATH wins over npx's copy.
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('claude-code'), 'claude', [], global, '/home/u/.npm/_npx/abc/node_modules/.bin/claude-agent-acp').args[2], global);
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('claude-code'), 'claude', [], true), { command: 'claude-agent-acp', args: [] });
		// Codex has no preload: its global adapter runs as the file it is.
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('codex'), 'codex', [], '/opt/homebrew/bin/codex-acp'), { command: '/opt/homebrew/bin/codex-acp', args: [] });
	});

	test('an adapter cached by npx runs directly, without npx as its parent', () => {
		const script = npxCachedLaunchScript({ command: 'codex-acp', package: '@agentclientprotocol/codex-acp@1.13.1' });
		assert.ok(script.includes(`bin="$root/node_modules/.bin/"'codex-acp'`));
		assert.ok(script.includes(`pkg="$root/node_modules/"'@agentclientprotocol/codex-acp'"/package.json"`));
		assert.ok(script.includes(`'"version": *"''1.13.1''"'`));
		assert.ok(script.includes('then exec "$bin" "$@"; fi'));
		assert.ok(script.endsWith(`exec npx -y --prefer-offline '@agentclientprotocol/codex-acp@1.13.1' "$@"`));
	});

	test('Grok launches `agent stdio`, never the old `grok acp` profile args', () => {
		const grok = cliAgentDefinition('grok');
		assert.deepStrictEqual(grok?.acpArgs, ['agent', 'stdio']);
		assert.deepStrictEqual(acpLaunchFor(grok, 'grok', ['acp'], false), { command: 'grok', args: ['agent', 'stdio'] });
		assert.deepStrictEqual(acpLaunchFor(grok, 'grok', [], false), { command: 'grok', args: ['agent', 'stdio'] });
		assert.deepStrictEqual(grokAcpArgs(['agent', 'stdio', '--debug']), ['agent', 'stdio', '--debug']);
	});

	test('custom commands and agents without an adapter are left alone', () => {
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('claude-code'), '/opt/my-acp', ['--x'], false), { command: '/opt/my-acp', args: ['--x'] });
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('cursor-acp'), 'cursor-agent', ['acp'], false), { command: 'cursor-agent', args: ['acp'] });
	});

	test('a sign-in notice names the CLI login, and other notices do not', () => {
		assert.deepStrictEqual(cliLoginForNotice('Sign in to continue using Claude.', 'Failed to authenticate: OAuth session expired', 'codex'), {
			providerId: 'claude-code',
			label: 'Claude',
			command: 'claude auth login',
		});
		assert.deepStrictEqual(cliLoginForNotice('Sign in to continue', 'OAuth session expired', 'codex'), {
			providerId: 'codex',
			label: 'Codex',
			command: 'codex login',
		});
		assert.strictEqual(cliLoginForNotice('Usage limit reached', 'Try again later', 'claude-code'), undefined);
		assert.strictEqual(cliLoginForNotice('Sign in to continue', undefined, 'antigravity'), undefined);
	});
});
