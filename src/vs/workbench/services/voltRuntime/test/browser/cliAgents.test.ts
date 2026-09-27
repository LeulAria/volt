/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltExecResult, IVoltJobOutput, IVoltStdioService, IVoltStdioSpawnOptions } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { acpLaunchFor, cliAgentDefinition, runCli } from '../../browser/agents/cliAgents.js';

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

	async spawn(_options: IVoltStdioSpawnOptions): Promise<string> {
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

	test('Claude launches the ACP adapter, never `claude acp`', () => {
		const claude = cliAgentDefinition('claude-code');
		assert.deepStrictEqual(acpLaunchFor(claude, 'claude', ['acp'], true), { command: 'claude-agent-acp', args: [] });
		const viaNpx = acpLaunchFor(claude, 'claude', [], false);
		assert.ok(/^npx(\.cmd)?$/.test(viaNpx.command));
		assert.deepStrictEqual(viaNpx.args, ['-y', '@agentclientprotocol/claude-agent-acp@0.81.2']);
	});

	test('Codex launches the ACP adapter, never `codex acp`', () => {
		const codex = cliAgentDefinition('codex');
		assert.deepStrictEqual(acpLaunchFor(codex, 'codex', ['acp'], true), { command: 'codex-acp', args: [] });
		const viaNpx = acpLaunchFor(codex, 'codex', ['acp'], false);
		assert.ok(/^npx(\.cmd)?$/.test(viaNpx.command));
		assert.deepStrictEqual(viaNpx.args, ['-y', '@agentclientprotocol/codex-acp@1.13.1']);
	});

	test('custom commands and agents without an adapter are left alone', () => {
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('claude-code'), '/opt/my-acp', ['--x'], false), { command: '/opt/my-acp', args: ['--x'] });
		assert.deepStrictEqual(acpLaunchFor(cliAgentDefinition('cursor-acp'), 'cursor-agent', ['acp'], false), { command: 'cursor-agent', args: ['acp'] });
	});
});
