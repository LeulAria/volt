/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AgentServerMethod, AgentServerRole, IAgentServerClientInfo } from '../../../../platform/voltAgentServer/common/protocolServer.js';
import { IVoltHostMcpService, IVoltHostMcpToolInfo } from '../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VoltHostMcpBridge } from '../../../../workbench/contrib/voltAgent/common/voltHostMcpBridge.js';
// The agent server runs this same service (agentServerMain.ts); it has no DOM dependency.
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { VoltHostToolService } from '../../../../workbench/services/voltRuntime/browser/host/hostToolService.js';
import { IVoltBrowserAccessService } from '../../../../workbench/services/voltRuntime/common/browserAccess.js';
import { CODE_INTELLIGENCE_TOOLS } from '../../../../workbench/services/voltRuntime/common/codeIntelligence.js';
import { BROWSER_TOOL_NAMES } from '../../../../workbench/services/voltRuntime/common/hostTools.js';
import { DEV_ENVIRONMENT_FEATURE_ID, IDE_TOOL_NAMES, IDE_TOOLS } from '../../../../workbench/services/voltRuntime/common/ide/ideTools.js';
import { JOB_WATCH_TOOL_NAMES, JOB_WATCH_TOOLS } from '../../../../workbench/services/voltRuntime/common/jobs/jobWatch.js';
import { VOLT_MEMORY_TOOLS } from '../../../../workbench/services/voltRuntime/common/memory/voltMemory.js';
import { ORCHESTRA_FEATURE_ID, ORCHESTRA_TOOL_NAMES, ORCHESTRA_TOOLS, SPAWN_TEAM_TOOL_NAME } from '../../../../workbench/services/voltRuntime/common/orchestration/orchestra.js';
import { IAgentRuntimeService } from '../../../../workbench/services/voltRuntime/common/runtime.js';
import { IAgentHistoryService } from '../../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { DISABLED_FEATURES_STORAGE_KEY, IFeatureEnablementProtocol, ServerFeatureEnablement } from '../../../node/voltAgent/serverFeatureEnablement.js';

/**
 * M1, server-side enablement mirror (spec H.11, customize.md 6.1d): a feature turned off in a
 * window loses its tools on volt-server, where the agents run with the server's own tools.
 */
suite('Agent server feature enablement mirror', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function hostTools() {
		const commands = { _serviceBrand: undefined, onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async () => undefined } as unknown as ICommandService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService;
		const access = { blockReason: () => undefined } as unknown as IVoltBrowserAccessService;
		const files = { readFile: async () => { throw new Error('missing'); } } as unknown as IFileService;
		const service = store.add(new VoltHostToolService(commands, files, workspace, access));
		// The server's memory service serves its tools here, as it does in agentServerMain.
		store.add(service.registerToolProvider({ tools: VOLT_MEMORY_TOOLS, invoke: async name => ({ text: `ran ${name}` }) }));
		return service;
	}

	/** The host MCP server: what a new session's agent lists is the last `start` call's tools. */
	function mcpServer(service: VoltHostToolService) {
		const lists: (readonly IVoltHostMcpToolInfo[])[] = [];
		const mcp: IVoltHostMcpService = {
			_serviceBrand: undefined,
			onDidCall: Event.None,
			onDidCancel: Event.None,
			start: async (_serverId, tools) => {
				lists.push(tools);
				return { url: 'http://127.0.0.1:1/mcp', token: 't' };
			},
			respond: async () => { },
			revokeSession: async () => { },
			stop: async () => { },
		};
		const runtime = { chatFor: (id: string) => id } as unknown as IAgentRuntimeService;
		const history = { onDidChange: Event.None, get: () => undefined } as unknown as IAgentHistoryService;
		store.add(new VoltHostMcpBridge(mcp, service, new NullLogService(), runtime, history));
		return { newSessionTools: () => (lists.at(-1) ?? []).map(tool => tool.name) };
	}

	function protocol() {
		const methods = new Map<string, AgentServerMethod>();
		const clients: IAgentServerClientInfo[] = [];
		const changed = store.add(new Emitter<void>());
		const server: IFeatureEnablementProtocol = {
			registerMethod: (name, method) => {
				methods.set(name, method);
				return toDisposable(() => methods.delete(name));
			},
			listClients: () => [...clients],
			onDidChangeClients: changed.event,
		};
		return {
			server,
			connect(connectionId: number, role: AgentServerRole) {
				const client: IAgentServerClientInfo = { connectionId, role, kind: role === 'owner' ? 'desktop' : 'mobile', clientId: `c${connectionId}`, capabilities: [], connectedAt: connectionId };
				clients.push(client);
				changed.fire();
				return {
					setDisabled: (global: string[], workspace: string[] = []) => methods.get('features.setDisabled')!({ client }, { global, workspace }),
					disconnect: () => {
						clients.splice(clients.findIndex(client => client.connectionId === connectionId), 1);
						changed.fire();
					},
				};
			},
		};
	}

	const memoryTool = VOLT_MEMORY_TOOLS[0].name;
	const browserTool = BROWSER_TOOL_NAMES[0];
	const flush = () => new Promise(resolve => setTimeout(resolve, 0));

	test('a feature disabled in the window is absent from a new session\'s tool list on the server, and refused', async () => {
		const storage = store.add(new InMemoryStorageService());
		const tools = hostTools();
		const mcp = mcpServer(tools);
		const { server, connect } = protocol();
		store.add(new ServerFeatureEnablement(server, tools, storage));
		await flush();
		assert.ok(mcp.newSessionTools().includes(memoryTool));
		assert.ok(mcp.newSessionTools().includes(browserTool));

		const window = connect(1, 'owner');
		window.setDisabled(['memory', 'browser']);
		await flush();
		assert.ok(!mcp.newSessionTools().includes(memoryTool), 'memory tools still listed');
		assert.ok(!mcp.newSessionTools().includes(browserTool), 'browser tools still listed');
		assert.ok(mcp.newSessionTools().includes('ask_question'), 'core tools stay');
		const refused = await tools.invokeTool(memoryTool, {}, { sessionId: 's1' });
		assert.match(refused.error ?? '', /turned off/);

		// Turned back on in the window: back on the server.
		window.setDisabled(['browser']);
		await flush();
		assert.ok(mcp.newSessionTools().includes(memoryTool));
		assert.ok(!mcp.newSessionTools().includes(browserTool));
		assert.deepStrictEqual((await tools.invokeTool(memoryTool, {}, { sessionId: 's1' })).text, `ran ${memoryTool}`);
	});

	test('the global choice outlives the window and a server restart', async () => {
		const storage = store.add(new InMemoryStorageService());
		const first = protocol();
		const firstTools = hostTools();
		store.add(new ServerFeatureEnablement(first.server, firstTools, storage));
		const window = first.connect(1, 'owner');
		window.setDisabled(['memory']);
		window.disconnect();
		assert.ok(!firstTools.listTools().some(tool => tool.name === memoryTool), 'a closed window keeps its global choice');
		assert.strictEqual(storage.get(DISABLED_FEATURES_STORAGE_KEY, StorageScope.APPLICATION), '["memory"]');

		// A restarted server with no window connected.
		const tools = hostTools();
		const mcp = mcpServer(tools);
		store.add(new ServerFeatureEnablement(protocol().server, tools, storage));
		await flush();
		assert.ok(!mcp.newSessionTools().includes(memoryTool));
	});

	test('a workspace-only choice holds while its window is connected; a paired device can only turn more off', async () => {
		const storage = store.add(new InMemoryStorageService());
		storage.store(DISABLED_FEATURES_STORAGE_KEY, '["memory"]', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const tools = hostTools();
		const listed = (name: string) => tools.listTools().some(tool => tool.name === name);
		const { server, connect } = protocol();
		const mirror = store.add(new ServerFeatureEnablement(server, tools, storage));

		const phone = connect(2, 'device');
		phone.setDisabled([], []);
		assert.ok(!listed(memoryTool), 'a device must not turn a feature back on');
		phone.setDisabled(['browser']);
		assert.ok(!listed(browserTool));
		assert.strictEqual(storage.get(DISABLED_FEATURES_STORAGE_KEY, StorageScope.APPLICATION), '["memory"]', 'a device never writes the global choice');
		phone.disconnect();
		assert.ok(listed(browserTool));

		const window = connect(3, 'owner');
		window.setDisabled(['memory'], ['browser']);
		assert.ok(!listed(browserTool));
		window.disconnect();
		assert.ok(listed(browserTool));
		assert.ok(!listed(memoryTool));

		// Core features have no switch, and unknown ids are dropped.
		const other = connect(4, 'owner');
		other.setDisabled(['threads', 'nonsense']);
		assert.deepStrictEqual([...mirror.disabledFeatures()], []);
		assert.ok(listed('ask_question'));
		assert.ok(listed(memoryTool));
		assert.strictEqual(storage.get(DISABLED_FEATURES_STORAGE_KEY, StorageScope.APPLICATION), undefined);
	});

	test('FEAT-R4-4: turning Orchestra, Dev environment or Code Intelligence off takes each one\'s tools away, and only its own; job waits stay', async () => {
		const storage = store.add(new InMemoryStorageService());
		const tools = hostTools();
		// Where they run, these services serve them through the same tool service.
		for (const served of [ORCHESTRA_TOOLS, IDE_TOOLS, CODE_INTELLIGENCE_TOOLS, JOB_WATCH_TOOLS]) {
			store.add(tools.registerToolProvider({ tools: served, invoke: async name => ({ text: `ran ${name}` }) }));
		}
		const mcp = mcpServer(tools);
		const { server, connect } = protocol();
		store.add(new ServerFeatureEnablement(server, tools, storage));
		await flush();
		const names = (list: readonly { readonly name: string }[]) => list.map(tool => tool.name);
		const all = [...ORCHESTRA_TOOL_NAMES, ...IDE_TOOL_NAMES, ...names(CODE_INTELLIGENCE_TOOLS), ...JOB_WATCH_TOOL_NAMES];
		assert.deepStrictEqual(all.filter(name => !mcp.newSessionTools().includes(name)), [], 'all served while every feature is on');

		const window = connect(1, 'owner');
		const cases: readonly { readonly feature: string; readonly tools: readonly string[] }[] = [
			{ feature: ORCHESTRA_FEATURE_ID, tools: ORCHESTRA_TOOL_NAMES },
			{ feature: DEV_ENVIRONMENT_FEATURE_ID, tools: IDE_TOOL_NAMES },
			{ feature: 'codeIntelligence', tools: names(CODE_INTELLIGENCE_TOOLS) },
		];
		for (const { feature, tools: owned } of cases) {
			window.setDisabled([feature]);
			await flush();
			const listed = mcp.newSessionTools();
			assert.deepStrictEqual(owned.filter(name => listed.includes(name)), [], `${feature} off: its tools are gone`);
			assert.deepStrictEqual(all.filter(name => !owned.includes(name) && !listed.includes(name)), [], `${feature} off: every other tool stays`);
			for (const name of owned) {
				const refused = await tools.invokeTool(name, {}, { sessionId: 's1' });
				assert.match(refused.error ?? '', /turned off/, `${name} is refused`);
			}
		}
		// Job waits are core (Terminals): no switch, and an id the window sends for them is dropped.
		window.setDisabled(['terminals', ORCHESTRA_FEATURE_ID, DEV_ENVIRONMENT_FEATURE_ID, 'codeIntelligence']);
		await flush();
		assert.deepStrictEqual(JOB_WATCH_TOOL_NAMES.filter(name => !mcp.newSessionTools().includes(name)), []);
		assert.strictEqual((await tools.invokeTool(JOB_WATCH_TOOL_NAMES[0], {}, { sessionId: 's1' })).text, `ran ${JOB_WATCH_TOOL_NAMES[0]}`);
		// Back on: back on the server.
		window.setDisabled([]);
		await flush();
		assert.deepStrictEqual(all.filter(name => !mcp.newSessionTools().includes(name)), []);
		assert.strictEqual((await tools.invokeTool(SPAWN_TEAM_TOOL_NAME, {}, { sessionId: 's1' })).text, `ran ${SPAWN_TEAM_TOOL_NAME}`);
	});
});
