/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { fromWire, toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';

/** What a window sends with a forwarded tool call (the cancellation token stays here). */
export interface IClientToolCall {
	readonly sessionId?: string;
	readonly mode?: string;
	readonly cwd?: string;
	readonly source?: 'mcp' | 'native';
}

/**
 * Host tools only a Volt window serves (devices, window capture, visuals, pull requests, ...):
 * each connected window lists the tools its own providers registered, and the server offers the
 * ones it does not serve itself to its agents, running them in the newest window that has them.
 * When the window goes away, so do its tools.
 */
export class ServerClientTools extends Disposable {

	private readonly byConnection = new Map<number, readonly IVoltHostToolInfo[]>();
	private registration: IDisposable | undefined;
	private updating = false;

	constructor(
		private readonly protocol: AgentServerProtocol,
		private readonly hostTools: IVoltHostToolService,
	) {
		super();
		// A tool the server starts serving itself (a provider registered later) stops being proxied.
		this._register(hostTools.onDidChangeTools(() => {
			if (!this.updating) {
				this.refresh();
			}
		}));
		this._register({ dispose: () => this.registration?.dispose() });
	}

	set(connectionId: number, tools: readonly IVoltHostToolInfo[]): void {
		this.byConnection.set(connectionId, tools.filter(tool => tool && typeof tool.name === 'string'));
		this.refresh();
	}

	/** Only these connections are still there. */
	retain(live: ReadonlySet<number>): void {
		let changed = false;
		for (const connectionId of [...this.byConnection.keys()]) {
			if (!live.has(connectionId)) {
				this.byConnection.delete(connectionId);
				changed = true;
			}
		}
		if (changed) {
			this.refresh();
		}
	}

	private refresh(): void {
		this.updating = true;
		try {
			this.registration?.dispose();
			this.registration = undefined;
			const own = new Set(this.hostTools.listTools().map(tool => tool.name));
			// The newest connection wins a name two windows both serve.
			const owners = new Map<string, { readonly connectionId: number; readonly tool: IVoltHostToolInfo }>();
			for (const [connectionId, tools] of [...this.byConnection].sort((a, b) => a[0] - b[0])) {
				for (const tool of tools) {
					if (!own.has(tool.name)) {
						owners.set(tool.name, { connectionId, tool });
					}
				}
			}
			if (!owners.size) {
				return;
			}
			this.registration = this.hostTools.registerToolProvider({
				tools: [...owners.values()].map(owner => owner.tool),
				invoke: async (name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> => {
					const owner = owners.get(name);
					if (!owner || !this.byConnection.has(owner.connectionId)) {
						return { error: `${name} needs an open Volt window. Open Volt and try again.` };
					}
					const forwarded: IClientToolCall | undefined = call ? {
						...(call.sessionId ? { sessionId: call.sessionId } : {}),
						...(call.mode ? { mode: call.mode } : {}),
						...(call.cwd ? { cwd: call.cwd } : {}),
						...(call.source ? { source: call.source } : {}),
					} : undefined;
					try {
						return fromWire<IVoltHostToolResult>(await this.protocol.callConnection(owner.connectionId, 'hostTools.invoke', [name, toWire(args), forwarded]));
					} catch (err) {
						return { error: err instanceof Error ? err.message : String(err) };
					}
				},
			});
		} finally {
			this.updating = false;
		}
	}
}
