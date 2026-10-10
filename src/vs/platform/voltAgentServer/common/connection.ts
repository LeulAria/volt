/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import {
	AGENT_SERVER_PROTOCOL_VERSION, AgentServerCapability, AgentServerClientKind, AgentServerCloseCode, AgentServerRemoteError, AgentServerServerFrame, AgentServerTopic,
	IAgentServerCall, IAgentServerEvent, IAgentServerHello, IAgentServerReturn, IAgentServerSnapshot, IAgentServerWelcome, parseFrame, toAgentServerError
} from './protocol.js';

/** The subset of the browser `WebSocket` the connection uses (Node 22 and Electron have it). */
export interface IWebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { readonly data: unknown }) => void) | null;
	onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export interface IAgentServerEndpoint {
	/** `ws://127.0.0.1:<port>/ws` */
	readonly url: string;
	readonly token: string;
}

export interface IConnectionTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
	random(): number;
}

export interface IAgentServerConnectionOptions {
	/** Where to connect; asked again before every attempt (the server may have moved port). */
	readonly endpoint: () => Promise<IAgentServerEndpoint | undefined>;
	readonly createSocket: (url: string) => IWebSocketLike;
	readonly client: {
		readonly kind: AgentServerClientKind;
		readonly id: string;
		readonly capabilities?: readonly AgentServerCapability[];
		readonly topics?: readonly AgentServerTopic[];
	};
	readonly backoff?: Partial<IBackoff>;
	/** An attempt that hasn't been welcomed by then is abandoned. */
	readonly connectTimeoutMs?: number;
	readonly timers?: IConnectionTimers;
}

export interface IBackoff {
	readonly initialMs: number;
	readonly maxMs: number;
	/** A connection that stayed up this long resets the backoff. */
	readonly stableMs: number;
}

export const DEFAULT_BACKOFF: IBackoff = { initialMs: 200, maxMs: 5_000, stableMs: 10_000 };

/**
 * Delay before reconnect attempt `attempt` (0-based): the ceiling doubles from `initialMs` to `maxMs`
 * and the delay is a random point in its upper half, so many clients don't retry in lockstep.
 */
export function backoffDelay(attempt: number, backoff: IBackoff, random: () => number): number {
	const ceiling = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(attempt, 30));
	return Math.round(ceiling / 2 + random() * ceiling / 2);
}

export type AgentServerConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

export interface IAgentServerWelcomeEvent {
	readonly epoch: string;
	readonly seq: number;
	/** The gap since the last connection was replayed; when false `snapshot` replaces all state. */
	readonly resumed: boolean;
	/** First connection of this client object, or the server's epoch changed (it restarted). */
	readonly newEpoch: boolean;
	readonly snapshot?: IAgentServerSnapshot;
	readonly serverVersion: string;
	readonly pid: number;
}

class Disconnected extends AgentServerRemoteError {
	constructor() {
		super('Disconnected', 'The connection to the Volt agent server dropped before it answered.');
	}
}

interface IPendingCall {
	readonly method: string;
	readonly params: readonly unknown[];
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: unknown) => void;
	/** Sent on the current socket: a drop rejects it (it may or may not have run). */
	sent: boolean;
}

const OPEN = 1;

const realTimers: IConnectionTimers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
	random: () => Math.random(),
};

/**
 * One client's link to the agent server. Connects, authenticates, resumes from the last applied
 * event after a drop, detects holes in the event stream (and reconnects to fill them), and
 * reconnects forever with backoff until disposed.
 *
 * Calls made while disconnected wait for the next connection. A call already sent when the socket
 * drops is rejected with `Disconnected`: it may have run, so it is never sent twice.
 */
export class AgentServerConnection extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<AgentServerConnectionState>());
	readonly onDidChangeState: Event<AgentServerConnectionState> = this._onDidChangeState.event;

	private readonly _onDidWelcome = this._register(new Emitter<IAgentServerWelcomeEvent>());
	/** Fires before the replayed or live events of a connection. */
	readonly onDidWelcome: Event<IAgentServerWelcomeEvent> = this._onDidWelcome.event;

	private readonly _onEvent = this._register(new Emitter<IAgentServerEvent>());
	/** Every event, in `seq` order, exactly once per epoch. */
	readonly onEvent: Event<IAgentServerEvent> = this._onEvent.event;

	private readonly _onDidFail = this._register(new Emitter<{ readonly code: number; readonly reason: string }>());
	/** A connection closed with an error the client can't fix by retrying (bad token, protocol). */
	readonly onDidFail: Event<{ readonly code: number; readonly reason: string }> = this._onDidFail.event;

	private _state: AgentServerConnectionState = 'idle';
	private socket: IWebSocketLike | undefined;
	private epoch: string | undefined;
	private lastSeq = 0;
	private welcomed = false;
	private attempt = 0;
	private openedAt = 0;
	private retryHandle: unknown;
	private connectTimer: unknown;
	private nextCallId = 1;
	private readonly pending = new Map<number, IPendingCall>();
	private readonly handlers = new Map<string, (...params: unknown[]) => unknown>();
	private readonly backoff: IBackoff;
	private readonly timers: IConnectionTimers;
	private disposed = false;

	constructor(private readonly options: IAgentServerConnectionOptions) {
		super();
		this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
		this.timers = options.timers ?? realTimers;
		this._register(toDisposable(() => this.shutdown()));
	}

	get state(): AgentServerConnectionState {
		return this._state;
	}

	/** The last event applied (0 before any). */
	get seq(): number {
		return this.lastSeq;
	}

	get serverEpoch(): string | undefined {
		return this.epoch;
	}

	get isOpen(): boolean {
		return this._state === 'open';
	}

	connect(): void {
		if (this.disposed || this._state === 'connecting' || this._state === 'open') {
			return;
		}
		this.cancelRetry();
		void this.open();
	}

	/** Drops the current socket and reconnects now (skips the backoff wait). */
	reconnect(): void {
		if (this.disposed) {
			return;
		}
		this.attempt = 0;
		if (this.socket) {
			this.dropSocket(false);
		} else {
			this.cancelRetry();
			void this.open();
		}
	}

	whenOpen(): Promise<void> {
		if (this.isOpen) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const store = this._register(this.onDidChangeState(state => {
				if (state === 'open') {
					store.dispose();
					resolve();
				} else if (state === 'closed' && this.disposed) {
					store.dispose();
					reject(new Disconnected());
				}
			}));
		});
	}

	call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new Disconnected());
		}
		return new Promise<T>((resolve, reject) => {
			const id = this.nextCallId++;
			const call: IPendingCall = { method, params, resolve: resolve as (value: unknown) => void, reject, sent: false };
			this.pending.set(id, call);
			if (this.isOpen) {
				this.sendCall(id, call);
			}
		});
	}

	/** Answers server → client calls (capabilities). */
	registerHandler(method: string, handler: (...params: unknown[]) => unknown): IDisposable {
		this.handlers.set(method, handler);
		return toDisposable(() => {
			if (this.handlers.get(method) === handler) {
				this.handlers.delete(method);
			}
		});
	}

	private async open(): Promise<void> {
		this.setState('connecting');
		let endpoint: IAgentServerEndpoint | undefined;
		try {
			endpoint = await this.options.endpoint();
		} catch {
			endpoint = undefined;
		}
		if (this.disposed) {
			return;
		}
		if (!endpoint) {
			this.scheduleRetry();
			return;
		}
		let socket: IWebSocketLike;
		try {
			socket = this.options.createSocket(endpoint.url);
		} catch {
			this.scheduleRetry();
			return;
		}
		this.socket = socket;
		this.welcomed = false;
		const token = endpoint.token;
		this.connectTimer = this.timers.setTimeout(() => {
			if (this.socket === socket && !this.welcomed) {
				this.dropSocket(false);
			}
		}, this.options.connectTimeoutMs ?? 10_000);
		socket.onopen = () => {
			if (this.socket !== socket) {
				return;
			}
			const hello: IAgentServerHello = {
				t: 'hello',
				protocol: AGENT_SERVER_PROTOCOL_VERSION,
				token,
				client: this.options.client,
				...(this.epoch ? { resume: { epoch: this.epoch, seq: this.lastSeq } } : {}),
			};
			socket.send(JSON.stringify(hello));
		};
		socket.onmessage = ev => {
			if (this.socket === socket && typeof ev.data === 'string') {
				this.onFrame(ev.data);
			}
		};
		socket.onerror = () => { /* onclose follows */ };
		socket.onclose = ev => {
			if (this.socket !== socket) {
				return;
			}
			this.socket = undefined;
			this.afterClose(ev.code, ev.reason);
		};
	}

	private onFrame(text: string): void {
		const frame = parseFrame<AgentServerServerFrame>(text);
		if (!frame) {
			return;
		}
		switch (frame.t) {
			case 'welcome':
				this.onWelcome(frame);
				break;
			case 'evt':
				this.onEventFrame(frame);
				break;
			case 'ret':
				this.onReturn(frame);
				break;
			case 'call':
				void this.onServerCall(frame);
				break;
		}
	}

	private onWelcome(welcome: IAgentServerWelcome): void {
		this.timers.clearTimeout(this.connectTimer);
		const newEpoch = welcome.epoch !== this.epoch;
		this.epoch = welcome.epoch;
		this.welcomed = true;
		this.openedAt = this.timers.now();
		if (!welcome.resumed) {
			// The snapshot is the state as of welcome.seq; only later events apply on top of it.
			this.lastSeq = welcome.seq;
		}
		this._onDidWelcome.fire({
			epoch: welcome.epoch,
			seq: welcome.seq,
			resumed: welcome.resumed,
			newEpoch,
			snapshot: welcome.snapshot,
			serverVersion: welcome.serverVersion,
			pid: welcome.pid,
		});
		this.setState('open');
		for (const [id, call] of this.pending) {
			if (!call.sent) {
				this.sendCall(id, call);
			}
		}
	}

	private onEventFrame(event: IAgentServerEvent): void {
		if (!this.welcomed) {
			return;
		}
		if (event.seq <= this.lastSeq) {
			return; // already applied (a replay overlapping the live stream)
		}
		if ((event.after ?? event.seq - 1) !== this.lastSeq) {
			// A hole: reconnect and resume from what we have; the server replays or sends a snapshot.
			this.dropSocket(false);
			return;
		}
		this.lastSeq = event.seq;
		this._onEvent.fire(event);
	}

	private onReturn(ret: IAgentServerReturn): void {
		const call = this.pending.get(ret.id);
		if (!call) {
			return;
		}
		this.pending.delete(ret.id);
		if (ret.ok) {
			call.resolve(ret.result);
		} else {
			call.reject(new AgentServerRemoteError(ret.error?.code ?? 'Error', ret.error?.message ?? 'The agent server call failed.'));
		}
	}

	private async onServerCall(call: IAgentServerCall): Promise<void> {
		const socket = this.socket;
		const handler = this.handlers.get(call.method);
		let ret: IAgentServerReturn;
		if (!handler) {
			ret = { t: 'ret', id: call.id, ok: false, error: { code: 'NoHandler', message: `This client does not handle ${call.method}.` } };
		} else {
			try {
				ret = { t: 'ret', id: call.id, ok: true, result: await handler(...(call.params ?? [])) };
			} catch (err) {
				ret = { t: 'ret', id: call.id, ok: false, error: toAgentServerError(err) };
			}
		}
		if (socket && this.socket === socket && socket.readyState === OPEN) {
			socket.send(JSON.stringify(ret));
		}
	}

	private sendCall(id: number, call: IPendingCall): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== OPEN) {
			return;
		}
		call.sent = true;
		const frame: IAgentServerCall = { t: 'call', id, method: call.method, params: call.params };
		socket.send(JSON.stringify(frame));
	}

	private afterClose(code: number, reason: string): void {
		this.timers.clearTimeout(this.connectTimer);
		this.welcomed = false;
		for (const [id, call] of this.pending) {
			if (call.sent) {
				this.pending.delete(id);
				call.reject(new Disconnected());
			}
		}
		if (this.disposed) {
			this.setState('closed');
			return;
		}
		if (this._state === 'open' && this.timers.now() - this.openedAt >= this.backoff.stableMs) {
			this.attempt = 0;
		}
		if (code === AgentServerCloseCode.Unauthorized || code === AgentServerCloseCode.ProtocolMismatch || code === AgentServerCloseCode.BadHello) {
			this._onDidFail.fire({ code, reason });
		}
		this.setState('connecting');
		this.scheduleRetry();
	}

	private dropSocket(final: boolean): void {
		const socket = this.socket;
		if (!socket) {
			return;
		}
		this.socket = undefined;
		socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
		try {
			socket.close(1000, final ? 'dispose' : 'reconnect');
		} catch {
			// already closed
		}
		this.afterClose(final ? 1000 : 4000, final ? 'dispose' : 'reconnect');
	}

	private scheduleRetry(): void {
		if (this.disposed) {
			return;
		}
		this.cancelRetry();
		const delay = this.attempt === 0 ? 0 : backoffDelay(this.attempt - 1, this.backoff, this.timers.random);
		this.attempt++;
		this.retryHandle = this.timers.setTimeout(() => {
			this.retryHandle = undefined;
			void this.open();
		}, delay);
	}

	private cancelRetry(): void {
		if (this.retryHandle !== undefined) {
			this.timers.clearTimeout(this.retryHandle);
			this.retryHandle = undefined;
		}
	}

	private setState(state: AgentServerConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	private shutdown(): void {
		this.disposed = true;
		this.cancelRetry();
		this.dropSocket(true);
		for (const call of this.pending.values()) {
			call.reject(new Disconnected());
		}
		this.pending.clear();
		this.setState('closed');
	}
}
