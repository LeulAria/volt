/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IVoltBrowserPreflightRequest, IVoltBrowserPreflightResult, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolInvocation, IVoltHostToolProvider, IVoltHostToolResult, IVoltHostToolService, IVoltMcpServer, VOLT_HOST_TOOLS, VoltHostToolGroup } from '../../voltRuntime/common/hostTools.js';
import { VoltMode } from '../../voltRuntime/common/modes.js';
import { IAgentServerClientService } from './agentServerClient.js';

/** A host tool call as it crosses the socket (no cancellation token). */
export interface IRemoteHostToolCall {
	readonly sessionId?: string;
	readonly mode?: string;
	readonly cwd?: string;
	readonly source?: 'mcp' | 'native';
	readonly external?: IVoltHostToolCall['external'];
}

export function toRemoteHostToolCall(call: IVoltHostToolCall | undefined): IRemoteHostToolCall | undefined {
	if (!call) {
		return undefined;
	}
	return {
		...(call.sessionId ? { sessionId: call.sessionId } : {}),
		...(call.mode ? { mode: call.mode } : {}),
		...(call.cwd ? { cwd: call.cwd } : {}),
		...(call.source ? { source: call.source } : {}),
		...(call.external ? { external: call.external } : {}),
	};
}

/**
 * Volt's host tools live with the agents, in the agent server. This window sees the server's tool
 * list and its invocations (to attach page state to rows). Tools that parts of this window serve
 * (devices, window capture, visuals, pull requests, ...) are listed to the server, which offers
 * the ones it does not serve itself to its agents and runs them here; they go away with the window.
 */
export class RemoteVoltHostToolService extends Disposable implements IVoltHostToolService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMcp = this._register(new Emitter<void>());
	readonly onDidChangeMcp = this._onDidChangeMcp.event;
	private readonly _onDidInvokeTool = this._register(new Emitter<IVoltHostToolInvocation>());
	readonly onDidInvokeTool = this._onDidInvokeTool.event;
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools = this._onDidChangeTools.event;

	/** Providers registered in this window. */
	private readonly providers = new Set<IVoltHostToolProvider>();
	private readonly publishTools: RunOnceScheduler;

	constructor(@IAgentServerClientService private readonly client: IAgentServerClientService) {
		super();
		this.publishTools = this._register(new RunOnceScheduler(() => this.sendTools(), 50));
		this._register(client.onHostToolsEvent(event => {
			const e = event as { kind?: string } & IVoltHostToolInvocation;
			if (e.kind === 'invoked') {
				this._onDidInvokeTool.fire({ sessionId: e.sessionId, name: e.name, args: e.args, result: e.result });
			} else if (e.kind === 'mcp') {
				this._onDidChangeMcp.fire();
			}
		}));
		this._register(client.onDidChangeCollection(e => {
			if (e.col === 'runtime' && (e.reset || e.keys.includes('hostTools'))) {
				this._onDidChangeTools.fire();
			}
		}));
		// A new connection (or a restarted server) learns this window's tools again.
		this._register(client.onDidResync(() => this.sendTools()));
		this._register(client.registerHandler('hostTools.invoke', (name, args, call) => this.invokeLocal(String(name), args, call as IRemoteHostToolCall | undefined)));
	}

	listTools(): readonly IVoltHostToolInfo[] {
		return this.client.mirror.get<IVoltHostToolInfo[]>('runtime', 'hostTools') ?? VOLT_HOST_TOOLS;
	}

	registerToolProvider(provider: IVoltHostToolProvider): IDisposable {
		this.providers.add(provider);
		this.publishTools.schedule();
		return toDisposable(() => {
			if (this.providers.delete(provider)) {
				this.publishTools.schedule();
			}
		});
	}

	private sendTools(): void {
		if (!this.client.isReady) {
			return; // onDidResync sends them once connected
		}
		const tools = [...this.providers].flatMap(provider => provider.tools);
		this.client.send('hostTools.setClientTools', tools);
	}

	/** The server runs a tool one of this window's providers serves. */
	private async invokeLocal(name: string, args: unknown, call: IRemoteHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const provider = [...this.providers].find(candidate => candidate.tools.some(tool => tool.name === name));
		if (!provider) {
			return { error: `This Volt window no longer serves ${name}.` };
		}
		const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
		return provider.invoke(name, record, call ? { ...call, mode: call.mode as VoltMode | undefined, token: CancellationToken.None } : undefined);
	}

	/** The turn primer runs with the agents, in the server; a window has nothing to add to it. */
	async preflightBrowser(_sessionId: string, _request: IVoltBrowserPreflightRequest, _token: CancellationToken): Promise<IVoltBrowserPreflightResult> {
		return { lines: [] };
	}

	invokeTool(name: string, input?: unknown, call?: IVoltHostToolCall): Promise<IVoltHostToolResult> {
		return this.client.call('hostTools.invokeTool', name, input, toRemoteHostToolCall(call));
	}

	/** Agents are launched by the server, which hands them its own MCP server. */
	getMcpServers(_sessionId?: string, _options?: { readonly groups?: readonly VoltHostToolGroup[] }): readonly IVoltMcpServer[] {
		return [];
	}

	// The server's own runtime answers questions, resolves sessions and approves calls; a window
	// does not take those roles while its agents run there.
	setMcpEndpoint(): void { }
	setQuestionHandler(): void { }
	setSessionResolver(): void { }
	setApprover(): void { }
}
