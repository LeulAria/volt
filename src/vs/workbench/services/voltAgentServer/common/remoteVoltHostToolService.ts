/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolInvocation, IVoltHostToolProvider, IVoltHostToolResult, IVoltHostToolService, IVoltMcpServer, VOLT_HOST_TOOLS, VoltHostToolGroup } from '../../voltRuntime/common/hostTools.js';
import { IAgentServerClientService } from './agentServerClient.js';

/**
 * Volt's host tools live with the agents, in the agent server. This window sees the tool list and
 * the invocations (to attach page state to rows); tools it can run itself (the in-app browser)
 * are run at the server's request through the window's capabilities.
 */
export class RemoteVoltHostToolService extends Disposable implements IVoltHostToolService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMcp = this._register(new Emitter<void>());
	readonly onDidChangeMcp = this._onDidChangeMcp.event;
	private readonly _onDidInvokeTool = this._register(new Emitter<IVoltHostToolInvocation>());
	readonly onDidInvokeTool = this._onDidInvokeTool.event;
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools = this._onDidChangeTools.event;

	constructor(@IAgentServerClientService private readonly client: IAgentServerClientService) {
		super();
		this._register(client.onHostToolsEvent(event => {
			const e = event as { kind?: string } & IVoltHostToolInvocation;
			if (e.kind === 'invoked') {
				this._onDidInvokeTool.fire({ sessionId: e.sessionId, name: e.name, args: e.args, result: e.result });
			} else if (e.kind === 'mcp') {
				this._onDidChangeMcp.fire();
			}
		}));
		this._register(client.onDidChangeCollection(e => {
			if (e.col === 'runtime' && e.keys.includes('hostTools')) {
				this._onDidChangeTools.fire();
			}
		}));
	}

	listTools(): readonly IVoltHostToolInfo[] {
		return this.client.mirror.get<IVoltHostToolInfo[]>('runtime', 'hostTools') ?? VOLT_HOST_TOOLS;
	}

	registerToolProvider(_provider: IVoltHostToolProvider): IDisposable {
		return toDisposable(() => { });
	}

	invokeTool(name: string, input?: unknown, call?: IVoltHostToolCall): Promise<IVoltHostToolResult> {
		return this.client.call('hostTools.invokeTool', name, input, call?.sessionId);
	}

	getMcpServers(_sessionId?: string, _options?: { readonly groups?: readonly VoltHostToolGroup[] }): readonly IVoltMcpServer[] {
		return [];
	}

	setMcpEndpoint(): void { }
	setQuestionHandler(): void { }
	setSessionResolver(): void { }
	setApprover(): void { }
}
