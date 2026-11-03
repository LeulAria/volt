/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { fromWire, toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IVoltExternalCaller, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';

/** What a window gets with a forwarded tool call. The token stays here; `cancelKey` names the call for `hostTools.cancel`. */
export interface IClientToolCall {
	readonly sessionId?: string;
	readonly mode?: string;
	readonly cwd?: string;
	readonly source?: 'mcp' | 'native';
	readonly external?: IVoltExternalCaller;
	readonly cancelKey?: string;
}

function toClientToolCall(call: IVoltHostToolCall | undefined, cancelKey?: string): IClientToolCall | undefined {
	if (!call) {
		return cancelKey ? { cancelKey } : undefined;
	}
	return {
		...(call.sessionId ? { sessionId: call.sessionId } : {}),
		...(call.mode ? { mode: call.mode } : {}),
		...(call.cwd ? { cwd: call.cwd } : {}),
		...(call.source ? { source: call.source } : {}),
		...(call.external ? { external: call.external } : {}),
		...(cancelKey ? { cancelKey } : {}),
	};
}

/** What a window that cannot say whether its tool needs approval gets asked anyway. */
const UNKNOWN_APPROVAL_REASON = 'acts in a Volt window';
/** A window that has not said whether a tool needs approval by then is treated as "it does". */
const APPROVAL_CHECK_TIMEOUT_MS = 15_000;
/** Notices (approved, cancel) need no answer; this only frees the pending call. */
const NOTICE_TIMEOUT_MS = 30_000;

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
	private nextCancelKey = 1;
	/** Unique to this server process: a window still running a call from a server that restarted keeps it apart. */
	private readonly cancelPrefix = generateUuid().slice(0, 8);

	constructor(
		private readonly protocol: AgentServerProtocol,
		private readonly hostTools: IVoltHostToolService,
		/** The connections that have a chat open: its tools run in its own window when that window serves them. */
		private readonly holders: (sessionId: string) => ReadonlySet<number> = () => new Set(),
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
			// Every window that serves a name, newest first: the chat's own window, else the newest.
			const owners = new Map<string, { readonly connectionIds: number[]; tool: IVoltHostToolInfo }>();
			for (const [connectionId, tools] of [...this.byConnection].sort((a, b) => b[0] - a[0])) {
				for (const tool of tools) {
					if (!own.has(tool.name)) {
						const owner = owners.get(tool.name);
						if (owner) {
							owner.connectionIds.push(connectionId);
						} else {
							owners.set(tool.name, { connectionIds: [connectionId], tool });
						}
					}
				}
			}
			if (!owners.size) {
				return;
			}
			const ownerOf = (name: string, call: IVoltHostToolCall | undefined): { readonly connectionId: number } | undefined => {
				const live = owners.get(name)?.connectionIds.filter(connectionId => this.byConnection.has(connectionId)) ?? [];
				const holders = call?.sessionId ? this.holders(call.sessionId) : undefined;
				const connectionId = live.find(id => holders?.has(id)) ?? live[0];
				return connectionId === undefined ? undefined : { connectionId };
			};
			this.registration = this.hostTools.registerToolProvider({
				tools: [...owners.values()].map(owner => owner.tool),
				// The window's provider decides (desktop control asks every time); the approval itself
				// is asked here, in the chat, before the window runs anything.
				needsApproval: async (name, args, call) => {
					const owner = ownerOf(name, call);
					if (!owner) {
						return undefined; // invoke reports that no window serves it
					}
					try {
						const reason = await this.protocol.callConnection<unknown>(owner.connectionId, 'hostTools.needsApproval', [name, toWire(args), toClientToolCall(call)], APPROVAL_CHECK_TIMEOUT_MS);
						return typeof reason === 'string' && reason ? reason : undefined;
					} catch {
						return UNKNOWN_APPROVAL_REASON;
					}
				},
				approved: (name, args, call) => {
					const owner = ownerOf(name, call);
					if (owner) {
						this.protocol.callConnection(owner.connectionId, 'hostTools.approved', [name, toWire(args), toClientToolCall(call)], NOTICE_TIMEOUT_MS).catch(() => { /* older window */ });
					}
				},
				invoke: async (name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> => {
					const owner = ownerOf(name, call);
					if (!owner) {
						return { error: `${name} needs an open Volt window. Open Volt and try again.` };
					}
					if (call?.token?.isCancellationRequested) {
						return { error: `${name} was cancelled.` };
					}
					const cancelKey = call?.token ? `${this.cancelPrefix}.${this.nextCancelKey++}` : undefined;
					const cancel = cancelKey ? call!.token!.onCancellationRequested(() => {
						this.protocol.callConnection(owner.connectionId, 'hostTools.cancel', [cancelKey], NOTICE_TIMEOUT_MS).catch(() => { /* gone */ });
					}) : undefined;
					try {
						return fromWire<IVoltHostToolResult>(await this.protocol.callConnection(owner.connectionId, 'hostTools.invoke', [name, toWire(args), toClientToolCall(call, cancelKey)]));
					} catch (err) {
						return { error: err instanceof Error ? err.message : String(err) };
					} finally {
						cancel?.dispose();
					}
				},
			});
		} finally {
			this.updating = false;
		}
	}
}
