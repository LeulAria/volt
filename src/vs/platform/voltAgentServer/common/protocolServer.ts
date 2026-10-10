/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { AgentServerEventLog, IEventLogLimits } from './eventLog.js';
import {
	AGENT_SERVER_PROTOCOL_VERSION, AgentServerCapability, AgentServerClientFrame, AgentServerCloseCode, AgentServerRemoteError, AgentServerTopic, DEFAULT_TOPICS,
	IAgentServerCall, IAgentServerHello, IAgentServerReturn, IAgentServerSnapshot, IAgentServerWelcome, isValidHello, parseFrame, toAgentServerError
} from './protocol.js';

/** One accepted socket, whatever carries it (WebSocket in production, in-memory in tests). */
export interface IServerSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
	/** Bytes queued and not yet written; used to cut off clients that can't keep up. */
	readonly bufferedAmount: number;
	readonly onMessage: Event<string>;
	readonly onClose: Event<void>;
}

export interface IAgentServerClientInfo {
	readonly connectionId: number;
	readonly kind: IAgentServerHello['client']['kind'];
	readonly clientId: string;
	readonly capabilities: readonly AgentServerCapability[];
	readonly connectedAt: number;
}

/** What a method handler gets besides its params. */
export interface IAgentServerCallContext {
	readonly client: IAgentServerClientInfo;
}

export type AgentServerMethod = (ctx: IAgentServerCallContext, ...params: unknown[]) => unknown;

export interface IAgentServerProtocolOptions {
	readonly token: string;
	readonly epoch: string;
	readonly serverVersion: string;
	readonly pid: number;
	/** The full replicated state; taken synchronously so no event can slip between it and the stream. */
	readonly snapshot: () => Omit<IAgentServerSnapshot, 'seq' | 'epoch'>;
	readonly logLimits?: IEventLogLimits;
	/** A client whose unsent bytes exceed this is disconnected and resumes later. */
	readonly maxBufferedBytes?: number;
	/** A socket that hasn't said hello by then is closed. */
	readonly helloTimeoutMs?: number;
	readonly now?: () => number;
}

interface IClient {
	readonly info: IAgentServerClientInfo;
	readonly socket: IServerSocket;
	readonly topics: ReadonlySet<AgentServerTopic>;
	/** The seq of the last event sent to this client (the next one's `after`). */
	lastSent: number;
}

interface IPendingClientCall {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: unknown) => void;
	readonly connectionId: number;
}

/** Compares token strings without leaking where they differ through timing. */
export function tokensEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

/**
 * The server half of the protocol: authenticates sockets, welcomes them with a replay or a
 * snapshot, publishes sequenced events to every client, routes calls to registered methods, and
 * calls clients that advertised a capability.
 */
export class AgentServerProtocol extends Disposable {

	readonly log: AgentServerEventLog;
	private readonly clients = new Map<number, IClient>();
	/** Listeners of every accepted socket, said hello or not; released on close or dispose. */
	private readonly socketListeners = new Map<number, IDisposable[]>();
	private readonly methods = new Map<string, AgentServerMethod>();
	private readonly pendingClientCalls = new Map<number, IPendingClientCall>();
	private nextConnectionId = 1;
	private nextClientCallId = 1;
	private readonly now: () => number;

	private readonly _onDidChangeClients = this._register(new Emitter<void>());
	readonly onDidChangeClients: Event<void> = this._onDidChangeClients.event;

	constructor(private readonly options: IAgentServerProtocolOptions) {
		super();
		this.log = new AgentServerEventLog(options.epoch, options.logLimits);
		this.now = options.now ?? Date.now;
	}

	get epoch(): string {
		return this.options.epoch;
	}

	listClients(): IAgentServerClientInfo[] {
		return [...this.clients.values()].map(client => client.info);
	}

	registerMethod(name: string, method: AgentServerMethod): IDisposable {
		this.methods.set(name, method);
		return toDisposable(() => {
			if (this.methods.get(name) === method) {
				this.methods.delete(name);
			}
		});
	}

	registerMethods(service: string, methods: Record<string, AgentServerMethod>): IDisposable {
		const disposables = Object.entries(methods).map(([name, method]) => this.registerMethod(`${service}.${name}`, method));
		return toDisposable(() => disposables.forEach(d => d.dispose()));
	}

	hasMethod(name: string): boolean {
		return this.methods.has(name);
	}

	/** Appends an event to the log and sends it to every client subscribed to its topic. */
	publish(topic: AgentServerTopic, data: unknown): number {
		const stored = this.log.append(topic, data);
		for (const client of this.clients.values()) {
			if (client.topics.has(topic)) {
				this.sendEvent(client, stored.event.seq, stored.text);
			}
		}
		return stored.event.seq;
	}

	/** The newest connected client that can do `capability`, preferring desktop windows. */
	clientWith(capability: AgentServerCapability): IAgentServerClientInfo | undefined {
		let best: IAgentServerClientInfo | undefined;
		for (const { info } of this.clients.values()) {
			if (!info.capabilities.includes(capability)) {
				continue;
			}
			if (!best || (info.kind === 'desktop' && best.kind !== 'desktop') || (info.kind === best.kind && info.connectedAt >= best.connectedAt)) {
				best = info;
			}
		}
		return best;
	}

	/** Calls a client that advertised `capability`. Rejects when none is connected or it drops. */
	callClient<T>(capability: AgentServerCapability, method: string, params: readonly unknown[]): Promise<T> {
		const target = this.clientWith(capability);
		return this.callConnection<T>(target?.connectionId ?? -1, method, params);
	}

	/** Calls one connected client (the one that offered what is being asked for). */
	callConnection<T>(connectionId: number, method: string, params: readonly unknown[]): Promise<T> {
		const client = this.clients.get(connectionId);
		if (!client) {
			return Promise.reject(new AgentServerRemoteError('NoClient', `No Volt window is connected that can handle ${method}. Open Volt and try again.`));
		}
		return new Promise<T>((resolve, reject) => {
			const id = this.nextClientCallId++;
			this.pendingClientCalls.set(id, { resolve: resolve as (value: unknown) => void, reject, connectionId: client.info.connectionId });
			const frame: IAgentServerCall = { t: 'call', id, method, params };
			this.sendText(client, JSON.stringify(frame));
		});
	}

	/** Takes ownership of a new socket; it must say hello first. */
	accept(socket: IServerSocket): void {
		const connectionId = this.nextConnectionId++;
		let client: IClient | undefined;
		const timer = setTimeout(() => {
			if (!client) {
				socket.close(AgentServerCloseCode.BadHello, 'no hello');
			}
		}, this.options.helloTimeoutMs ?? 10_000);
		const listeners: IDisposable[] = [];
		this.socketListeners.set(connectionId, listeners);
		listeners.push(socket.onMessage(text => {
			if (!client) {
				client = this.onHello(connectionId, socket, text);
				if (client) {
					clearTimeout(timer);
				}
				return;
			}
			this.onClientFrame(client, text);
		}));
		listeners.push(toDisposable(() => clearTimeout(timer)));
		listeners.push(socket.onClose(() => {
			this.releaseSocket(connectionId);
			if (client && this.clients.get(connectionId) === client) {
				this.clients.delete(connectionId);
				for (const [id, call] of this.pendingClientCalls) {
					if (call.connectionId === connectionId) {
						this.pendingClientCalls.delete(id);
						call.reject(new AgentServerRemoteError('Disconnected', 'The Volt window that was handling this call disconnected.'));
					}
				}
				this._onDidChangeClients.fire();
			}
		}));
	}

	private releaseSocket(connectionId: number): void {
		const listeners = this.socketListeners.get(connectionId);
		this.socketListeners.delete(connectionId);
		listeners?.forEach(l => l.dispose());
	}

	/** Closes every client (the server is stopping). */
	closeAll(reason = 'server shutting down'): void {
		for (const client of [...this.clients.values()]) {
			client.socket.close(AgentServerCloseCode.ShuttingDown, reason);
		}
	}

	private onHello(connectionId: number, socket: IServerSocket, text: string): IClient | undefined {
		const frame = parseFrame<AgentServerClientFrame>(text);
		if (!isValidHello(frame)) {
			socket.close(AgentServerCloseCode.BadHello, 'expected hello');
			return undefined;
		}
		if (!tokensEqual(frame.token, this.options.token)) {
			socket.close(AgentServerCloseCode.Unauthorized, 'bad token');
			return undefined;
		}
		if (frame.protocol !== AGENT_SERVER_PROTOCOL_VERSION) {
			socket.close(AgentServerCloseCode.ProtocolMismatch, `server speaks protocol ${AGENT_SERVER_PROTOCOL_VERSION}`);
			return undefined;
		}
		const client: IClient = {
			info: {
				connectionId,
				kind: frame.client.kind,
				clientId: frame.client.id,
				capabilities: [...(frame.client.capabilities ?? [])],
				connectedAt: this.now(),
			},
			socket,
			topics: new Set(frame.client.topics ?? DEFAULT_TOPICS),
			lastSent: 0,
		};
		// Welcome and replay synchronously: nothing else runs on this thread in between, so the
		// client sees every event exactly once whether it resumed or loaded the snapshot.
		const decision = this.log.resume(frame.resume);
		if (decision.kind === 'replay') {
			const welcome: IAgentServerWelcome = { t: 'welcome', epoch: this.log.epoch, seq: this.log.seq, resumed: true, serverVersion: this.options.serverVersion, pid: this.options.pid };
			socket.send(JSON.stringify(welcome));
			client.lastSent = frame.resume!.seq;
			for (const stored of decision.events) {
				if (client.topics.has(stored.event.topic)) {
					this.sendEvent(client, stored.event.seq, stored.text);
				}
			}
		} else {
			const snapshot: IAgentServerSnapshot = { ...this.options.snapshot(), seq: this.log.seq, epoch: this.log.epoch };
			const welcome: IAgentServerWelcome = { t: 'welcome', epoch: this.log.epoch, seq: this.log.seq, resumed: false, snapshot, serverVersion: this.options.serverVersion, pid: this.options.pid };
			socket.send(JSON.stringify(welcome));
			client.lastSent = this.log.seq;
		}
		this.clients.set(connectionId, client);
		this._onDidChangeClients.fire();
		return client;
	}

	private onClientFrame(client: IClient, text: string): void {
		const frame = parseFrame<AgentServerClientFrame>(text);
		if (!frame) {
			return;
		}
		if (frame.t === 'call') {
			void this.onCall(client, frame);
		} else if (frame.t === 'ret') {
			this.onClientReturn(client, frame);
		}
	}

	private async onCall(client: IClient, call: IAgentServerCall): Promise<void> {
		let ret: IAgentServerReturn;
		const method = typeof call.method === 'string' ? this.methods.get(call.method) : undefined;
		if (!method) {
			ret = { t: 'ret', id: call.id, ok: false, error: { code: 'NoMethod', message: `Unknown method ${String(call.method)}.` } };
		} else {
			try {
				const result = await method({ client: client.info }, ...(Array.isArray(call.params) ? call.params : []));
				ret = { t: 'ret', id: call.id, ok: true, result };
			} catch (err) {
				ret = { t: 'ret', id: call.id, ok: false, error: toAgentServerError(err) };
			}
		}
		if (this.clients.get(client.info.connectionId) === client) {
			this.sendText(client, JSON.stringify(ret));
		}
	}

	private onClientReturn(client: IClient, ret: IAgentServerReturn): void {
		const pending = this.pendingClientCalls.get(ret.id);
		if (!pending || pending.connectionId !== client.info.connectionId) {
			return;
		}
		this.pendingClientCalls.delete(ret.id);
		if (ret.ok) {
			pending.resolve(ret.result);
		} else {
			pending.reject(new AgentServerRemoteError(ret.error?.code ?? 'Error', ret.error?.message ?? 'The client call failed.'));
		}
	}

	/** Sends a stored event frame with this client's `after` spliced in (no re-serialization). */
	private sendEvent(client: IClient, seq: number, text: string): void {
		const after = client.lastSent;
		client.lastSent = seq;
		this.sendText(client, `{"after":${after},${text.slice(1)}`);
	}

	private sendText(client: IClient, text: string): void {
		const max = this.options.maxBufferedBytes ?? 32 * 1024 * 1024;
		if (client.socket.bufferedAmount > max) {
			// It resumes from its last applied event once it reconnects.
			this.clients.delete(client.info.connectionId);
			client.socket.close(AgentServerCloseCode.Overflow, 'client too slow');
			this._onDidChangeClients.fire();
			return;
		}
		client.socket.send(text);
	}

	override dispose(): void {
		this.closeAll();
		for (const call of this.pendingClientCalls.values()) {
			call.reject(new AgentServerRemoteError('ShuttingDown', 'The agent server is stopping.'));
		}
		this.pendingClientCalls.clear();
		for (const connectionId of [...this.socketListeners.keys()]) {
			this.releaseSocket(connectionId);
		}
		this.clients.clear();
		super.dispose();
	}
}
