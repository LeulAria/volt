/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentServerProtocol } from '../../../../platform/voltAgentServer/common/protocolServer.js';
import { IVoltHostToolCall, IVoltHostToolProvider, IVoltHostToolService } from '../../../../workbench/services/voltRuntime/common/hostTools.js';
import { IClientToolCall, ServerClientTools } from '../../../node/voltAgent/serverClientTools.js';

/**
 * A sandboxed chat's search tools run in a window, and the chat's read rule (a function) stays in
 * the server: the window asks for it by key. Found in the e2e review: the rule was dropped on the
 * way, so instant_grep, find_symbol and find_files refused every sandboxed chat.
 */
suite('ServerClientTools read rule relay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(onInvoke: (call: IClientToolCall | undefined, tools: ServerClientTools) => Promise<unknown>) {
		const changed = store.add(new Emitter<void>());
		let provider: IVoltHostToolProvider | undefined;
		const hostTools = {
			onDidChangeTools: changed.event,
			listTools: () => [],
			registerToolProvider: (p: IVoltHostToolProvider) => {
				provider = p;
				return toDisposable(() => provider = undefined);
			},
		} as unknown as IVoltHostToolService;
		const protocol = {
			callConnection: async (_connection: number, method: string, params: unknown[]) => method === 'hostTools.invoke' ? onInvoke(params[2] as IClientToolCall | undefined, tools) : undefined,
		} as unknown as AgentServerProtocol;
		const tools: ServerClientTools = store.add(new ServerClientTools(protocol, hostTools));
		tools.set(1, [{ name: 'instant_grep', title: 'Searched code', description: '', inputSchema: {} }]);
		return { invoke: (call: IVoltHostToolCall) => provider!.invoke('instant_grep', {}, call), tools };
	}

	test('the window can ask the sandboxed call\'s read rule while the call runs, and not after', async () => {
		let key: string | undefined;
		let answers: (string | undefined)[] = [];
		const { invoke, tools } = setup(async (call, server) => {
			key = call?.readRuleKey;
			answers = await server.readRefusals(key!, ['/repo/a.ts', '/secret/b.ts', 42]);
			return { text: 'done' };
		});
		const source = new CancellationTokenSource();
		const result = await invoke({ sessionId: 's', token: source.token, readRefusal: async path => path.startsWith('/repo/') ? undefined : 'outside the workspace' });
		source.dispose();
		assert.deepStrictEqual(result, { text: 'done' });
		assert.ok(key);
		assert.deepStrictEqual(answers, [undefined, 'outside the workspace', 'not a path']);
		assert.deepStrictEqual(await tools.readRefusals(key!, ['/repo/a.ts']), ['the call that asked has ended']);
	});

	test('an unsandboxed call carries no key, and a made-up key refuses everything', async () => {
		let call: IClientToolCall | undefined;
		const { invoke, tools } = setup(async c => {
			call = c;
			return { text: 'ok' };
		});
		await invoke({ sessionId: 's' });
		assert.strictEqual(call?.readRuleKey, undefined);
		assert.deepStrictEqual(await tools.readRefusals('guess', ['/repo/a.ts']), ['the call that asked has ended']);
	});
});

/**
 * Found in the 2026-11-12 IDE round 2: under load the window answered "does instant_grep need
 * approval?" after the server's 15 s wait, so the chat asked the user "instant_grep: acts in a Volt
 * window". A window marks the tools whose provider never asks; the server does not ask it about them.
 */
suite('ServerClientTools approval check', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const changed = store.add(new Emitter<void>());
		let provider: IVoltHostToolProvider | undefined;
		const hostTools = {
			onDidChangeTools: changed.event,
			listTools: () => [],
			registerToolProvider: (p: IVoltHostToolProvider) => {
				provider = p;
				return toDisposable(() => provider = undefined);
			},
		} as unknown as IVoltHostToolService;
		const asked: string[] = [];
		const protocol = {
			callConnection: async (_connection: number, method: string, params: unknown[]) => {
				if (method === 'hostTools.needsApproval') {
					asked.push(String(params[0]));
					return 'moves the mouse';
				}
				return undefined;
			},
		} as unknown as AgentServerProtocol;
		const tools = store.add(new ServerClientTools(protocol, hostTools));
		return { tools, asked, needsApproval: (name: string) => provider!.needsApproval!(name, {}, { sessionId: 's' }) };
	}

	test('a tool every window marks neverAsks runs without asking the window', async () => {
		const { tools, asked, needsApproval } = setup();
		tools.set(1, [
			{ name: 'instant_grep', title: 'Searched code', description: '', inputSchema: {}, neverAsks: true },
			{ name: 'desktop_act', title: 'Desktop', description: '', inputSchema: {} },
		]);
		assert.strictEqual(await needsApproval('instant_grep'), undefined);
		assert.strictEqual(await needsApproval('desktop_act'), 'moves the mouse');
		assert.deepStrictEqual(asked, ['desktop_act']);
	});

	test('one window that may ask (an older one sends no mark) keeps the check', async () => {
		const { tools, asked, needsApproval } = setup();
		tools.set(1, [{ name: 'instant_grep', title: 'Searched code', description: '', inputSchema: {}, neverAsks: true }]);
		tools.set(2, [{ name: 'instant_grep', title: 'Searched code', description: '', inputSchema: {} }]);
		assert.strictEqual(await needsApproval('instant_grep'), 'moves the mouse');
		assert.deepStrictEqual(asked, ['instant_grep']);
	});
});
