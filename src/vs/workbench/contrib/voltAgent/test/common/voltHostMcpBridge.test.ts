/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltHostMcpCall, IVoltHostMcpService } from '../../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { VoltHostMcpBridge } from '../../common/voltHostMcpBridge.js';

suite('Volt host MCP bridge: token revocation (B-07)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const stub = <T>(value: object) => value as unknown as T;

	test('IPC-2: a revoked chat reaches the server, and a deleted chat\'s sessions are revoked', async () => {
		const onDidCall = store.add(new Emitter<IVoltHostMcpCall>());
		const onDidRevoke = store.add(new Emitter<{ sessionId: string; epoch: number }>());
		const onDidChangeHistory = store.add(new Emitter<void>());
		const serverRevocations: [string, string, number][] = [];
		let serverId = '';
		const mcp = stub<IVoltHostMcpService>({
			onDidCall: onDidCall.event,
			onDidCancel: Event.None,
			start: async (id: string) => { serverId = id; return { url: 'http://127.0.0.1:1/mcp', token: 'secret' }; },
			respond: async () => { },
			revokeSession: async (id: string, sessionId: string, epoch: number) => { serverRevocations.push([id, sessionId, epoch]); },
			stop: async () => { },
		});
		const revokedHere: string[] = [];
		const hostTools = stub<IVoltHostToolService>({
			onDidRevokeMcpSession: onDidRevoke.event,
			onDidChangeTools: Event.None,
			listTools: () => [],
			setSandboxResolver: () => { },
			setMcpEndpoint: () => { },
			invokeTool: async () => ({ text: 'ok' }),
			revokeMcpSession: (sessionId: string) => revokedHere.push(sessionId),
		});
		const stored = new Set(['chat-1', 'chat-2']);
		const history = stub<IAgentHistoryService>({ onDidChange: onDidChangeHistory.event, get: (id: string) => stored.has(id) ? { id } : undefined });
		// `spare-1` is a warm spare agent the first chat adopted.
		const runtime = stub<IAgentRuntimeService>({ chatFor: (id: string) => id === 'spare-1' ? 'chat-1' : id, getSandboxSettings: () => undefined, workingFolder: () => undefined });

		store.add(new VoltHostMcpBridge(mcp, hostTools, new NullLogService(), runtime, history));
		await Promise.resolve();
		assert.ok(serverId);

		onDidRevoke.fire({ sessionId: 'chat-2', epoch: 42 });
		assert.deepStrictEqual(serverRevocations, [[serverId, 'chat-2', 42]]);

		// Agents of both chats called in; then the first chat is deleted.
		for (const sessionId of ['spare-1', 'chat-1', 'chat-2']) {
			onDidCall.fire({ id: sessionId, serverId, sessionId, name: 'ask_question', args: {} });
		}
		await new Promise(resolve => setTimeout(resolve, 0));
		onDidChangeHistory.fire();
		assert.deepStrictEqual(revokedHere, [], 'nothing deleted yet');
		stored.delete('chat-1');
		onDidChangeHistory.fire();
		assert.deepStrictEqual(revokedHere.sort(), ['chat-1', 'spare-1']);
		onDidChangeHistory.fire();
		assert.strictEqual(revokedHere.length, 2, 'revoked once');
	});
});
