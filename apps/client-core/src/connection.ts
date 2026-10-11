/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from './events';
import {
	AGENT_SERVER_PROTOCOL_VERSION, CloseCode, type IEvent, type IHello, type IRemoteError, type IReturn, type IWelcome, parseFrame, RemoteError, type Topic, type ClientKind
} from './protocol';

/** The subset of `WebSocket` the connection uses (browsers and React Native both have it). */
export interface IWebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { readonly data: unknown }) => void) | null;
	onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

/**
 * - `connecting`: opening the socket and waiting for the welcome.
 * - `open`: welcomed; events and calls flow.
 * - `waiting`: between attempts (`retryAt`).
 * - `offline`: the device has no network; retried when it comes back.
 * - `blocked`: retrying cannot help (the device was removed, the protocol changed).
 */
export type ConnectionPhase = 'idle' | 'connecting' | 'open' | 'waiting' | 'offline' | 'blocked' | 'stopped';

export interface IConnectionStatus {
	readonly phase: ConnectionPhase;
	readonly attempt: number;
	readonly retryAt?: number;
	readonly error?: IRemoteError;
	readonly openedAt?: number;
	readonly serverVersion?: string;
}

export interface IWelcomeEvent {
	readonly welcome: IWelcome;
	/** The first welcome of this connection object, or the server restarted. */
	readonly newEpoch: boolean;
}

export interface IConnectionOptions {
	/** The `ws://host:port/ws` URL, asked before every attempt (a better route may have appeared). */
	readonly resolveUrl: () => Promise<string>;
	readonly token: string;
	readonly client: { readonly kind: ClientKind; readonly id: string; readonly topics?: readonly Topic[] };
	readonly createSocket?: (url: string) => IWebSocketLike;
	readonly backoff?: { readonly initialMs: number; readonly maxMs: number; readonly stableMs: number };
	readonly openTimeoutMs?: number;
	readonly log?: (message: string) => void;
}

interface IPendingCall {
	readonly id: number;
	readonly method: string;
	readonly params: readonly unknown[];
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: unknown) => void;
	readonly deadline: number;
	sent: boolean;
}

export interface ICallOptions {
	/** Give up after this long, connected or not (default 45 s). */
	readonly timeoutMs?: number;
	/** Fail at once instead of waiting for a connection. */
	readonly requireOpen?: boolean;
}

const OPEN = 1;
const HEARTBEAT_EVERY_MS = 15_000;
/** Silence after which a ping goes out; twice that and the socket is replaced. */
const SILENCE_PING_MS = 25_000;

/**
 * Delay before attempt `n` (0-based): the ceiling doubles from `initialMs` to `maxMs` and the delay
 * is a random point in its upper half, so many clients don't retry in lockstep (T3's supervisor).
 */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number): number {
	const ceiling = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 20));
	return Math.round(ceiling / 2 + Math.random() * ceiling / 2);
}

/**
 * One client's link to the agent server: authenticates, resumes from the last event after a drop,
 * reconnects when the event stream has a hole, and retries with backoff until stopped.
 *
 * Calls made while disconnected wait for the next connection. A call already sent when the socket
 * drops is rejected with `Disconnected`: it may have run, so it is never sent twice.
 */
export class VoltConnection {

	private readonly _onStatus = new Emitter<IConnectionStatus>();
	readonly onStatus = this._onStatus.event;
	private readonly _onWelcome = new Emitter<IWelcomeEvent>();
	readonly onWelcome = this._onWelcome.event;
	private readonly _onEvent = new Emitter<IEvent>();
	readonly onEvent = this._onEvent.event;

	private _status: IConnectionStatus = { phase: 'idle', attempt: 0 };
	private socket: IWebSocketLike | undefined;
	private epoch: string | undefined;
	private lastSeq = 0;
	private attempt = 0;
	private welcomed = false;
	private lastFrameAt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private openTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private stableTimer: ReturnType<typeof setTimeout> | undefined;
	private nextCallId = 1;
	private readonly pending = new Map<number, IPendingCall>();
	private stopped = false;
	private offline = false;
	private readonly backoff: { readonly initialMs: number; readonly maxMs: number; readonly stableMs: number };

	constructor(private readonly options: IConnectionOptions) {
		this.backoff = options.backoff ?? { initialMs: 500, maxMs: 30_000, stableMs: 20_000 };
	}

	get status(): IConnectionStatus {
		return this._status;
	}

	get isOpen(): boolean {
		return this._status.phase === 'open';
	}

	get seq(): number {
		return this.lastSeq;
	}

	start(): void {
		this.stopped = false;
		if (this.socket || this._status.phase === 'connecting' || this._status.phase === 'open') {
			return;
		}
		this.clearRetry();
		void this.open();
	}

	/** Drops the current socket (if any) and connects again now, skipping the backoff. */
	retryNow(): void {
		if (this.stopped) {
			return;
		}
		this.attempt = 0;
		if (this._status.phase === 'blocked') {
			this.setStatus({ phase: 'idle', attempt: 0 });
		}
		if (this.socket) {
			this.drop('retry');
		} else {
			this.clearRetry();
			void this.open();
		}
	}

	/** The app came back to the foreground: check the socket is alive instead of trusting it. */
	probe(): void {
		if (this.isOpen) {
			const silentFor = Date.now() - this.lastFrameAt;
			if (silentFor > 8_000) {
				this.ping(4_000);
			}
		} else if (this._status.phase === 'waiting' || this._status.phase === 'offline') {
			this.retryNow();
		}
	}

	/** The device lost (false) or regained (true) its network. */
	setNetworkAvailable(available: boolean): void {
		const wasOffline = this.offline;
		this.offline = !available;
		if (!available) {
			if (!this.isOpen && this._status.phase !== 'blocked' && this._status.phase !== 'stopped') {
				this.clearRetry();
				this.setStatus({ phase: 'offline', attempt: this.attempt });
			}
		} else if (wasOffline) {
			this.retryNow();
		}
	}

	stop(): void {
		this.stopped = true;
		this.clearRetry();
		this.stopHeartbeat();
		if (this.socket) {
			const socket = this.socket;
			this.socket = undefined;
			this.detach(socket);
			try {
				socket.close(1000, 'client stopped');
			} catch {
				// already closed
			}
		}
		for (const call of this.pending.values()) {
			call.reject(new RemoteError('Stopped', 'The connection was closed.'));
		}
		this.pending.clear();
		this.setStatus({ phase: 'stopped', attempt: 0 });
	}

	call<T>(method: string, params: readonly unknown[] = [], options: ICallOptions = {}): Promise<T> {
		if (this.stopped) {
			return Promise.reject(new RemoteError('Stopped', 'The connection was closed.'));
		}
		if (options.requireOpen && !this.isOpen) {
			return Promise.reject(new RemoteError('Offline', 'Not connected to Volt.'));
		}
		return new Promise<T>((resolve, reject) => {
			const id = this.nextCallId++;
			const call: IPendingCall = {
				id, method, params,
				resolve: resolve as (value: unknown) => void,
				reject,
				deadline: Date.now() + (options.timeoutMs ?? 45_000),
				sent: false,
			};
			this.pending.set(id, call);
			if (this.isOpen) {
				this.sendCall(call);
			}
			this.ensureHeartbeat();
		});
	}

	//#region Socket lifecycle

	private async open(): Promise<void> {
		if (this.stopped || this.socket) {
			return;
		}
		if (this.offline) {
			this.setStatus({ phase: 'offline', attempt: this.attempt });
			return;
		}
		this.setStatus({ phase: 'connecting', attempt: this.attempt });
		let url: string;
		try {
			url = await this.options.resolveUrl();
		} catch (err) {
			this.scheduleRetry({ code: 'Unreachable', message: err instanceof Error ? err.message : String(err) });
			return;
		}
		if (this.stopped || this.socket) {
			return;
		}
		let socket: IWebSocketLike;
		try {
			socket = (this.options.createSocket ?? defaultCreateSocket)(url);
		} catch (err) {
			this.scheduleRetry({ code: 'SocketError', message: err instanceof Error ? err.message : String(err) });
			return;
		}
		this.socket = socket;
		this.welcomed = false;
		this.openTimer = setTimeout(() => {
			if (this.socket === socket && !this.welcomed) {
				this.options.log?.('[volt] the server did not answer in time');
				this.drop('timeout', { code: 'Timeout', message: 'Volt did not answer in time.' });
			}
		}, this.options.openTimeoutMs ?? 15_000);
		socket.onopen = () => {
			const hello: IHello = {
				t: 'hello',
				protocol: AGENT_SERVER_PROTOCOL_VERSION,
				token: this.options.token,
				client: this.options.client,
				...(this.epoch ? { resume: { epoch: this.epoch, seq: this.lastSeq } } : {}),
			};
			socket.send(JSON.stringify(hello));
		};
		socket.onmessage = ev => {
			if (this.socket === socket) {
				this.onFrame(ev.data);
			}
		};
		socket.onerror = () => {
			// onclose follows with the code.
		};
		socket.onclose = ev => {
			if (this.socket === socket) {
				this.onClosed(ev.code, ev.reason);
			}
		};
	}

	private onFrame(data: unknown): void {
		this.lastFrameAt = Date.now();
		const frame = parseFrame(data);
		if (!frame) {
			return;
		}
		switch (frame.t) {
			case 'welcome':
				this.onWelcomeFrame(frame);
				return;
			case 'evt':
				if (!this.welcomed) {
					return;
				}
				if (frame.after !== undefined && frame.after !== this.lastSeq) {
					// A hole: reconnect and let the server replay what was missed.
					this.options.log?.(`[volt] missed events between ${this.lastSeq} and ${frame.after}; resuming`);
					this.drop('gap');
					return;
				}
				if (frame.seq <= this.lastSeq) {
					return;
				}
				this.lastSeq = frame.seq;
				this._onEvent.fire(frame);
				return;
			case 'ret':
				this.onReturn(frame);
				return;
			case 'call':
				// A remote client offers nothing the server can call back into.
				this.socket?.send(JSON.stringify({ t: 'ret', id: frame.id, ok: false, error: { code: 'NoMethod', message: `${frame.method} is not available on this client.` } } satisfies IReturn));
				return;
		}
	}

	private onWelcomeFrame(welcome: IWelcome): void {
		if (this.openTimer) {
			clearTimeout(this.openTimer);
			this.openTimer = undefined;
		}
		const newEpoch = welcome.epoch !== this.epoch;
		this.epoch = welcome.epoch;
		this.lastSeq = welcome.resumed ? this.lastSeq : welcome.seq;
		this.welcomed = true;
		this.stableTimer = setTimeout(() => this.attempt = 0, this.backoff.stableMs);
		this.setStatus({ phase: 'open', attempt: this.attempt, openedAt: Date.now(), serverVersion: welcome.serverVersion });
		this._onWelcome.fire({ welcome, newEpoch });
		for (const call of this.pending.values()) {
			if (!call.sent) {
				this.sendCall(call);
			}
		}
		this.ensureHeartbeat();
	}

	private onReturn(ret: IReturn): void {
		const call = this.pending.get(ret.id);
		if (!call) {
			return;
		}
		this.pending.delete(ret.id);
		if (ret.ok) {
			call.resolve(ret.result);
		} else {
			call.reject(new RemoteError(ret.error?.code ?? 'Error', ret.error?.message ?? `${call.method} failed.`));
		}
	}

	private onClosed(code: number, reason: string): void {
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			this.detach(socket);
		}
		this.afterDrop();
		if (this.stopped) {
			return;
		}
		switch (code) {
			case CloseCode.Unauthorized:
				this.block({ code: 'Unauthorized', message: 'This device was removed from Volt. Pair it again to reconnect.' });
				return;
			case CloseCode.ProtocolMismatch:
				this.block({ code: 'ProtocolMismatch', message: reason ? `Volt and this app don't match (${reason}). Update both to the latest version.` : 'Volt and this app don\'t match. Update both to the latest version.' });
				return;
			case CloseCode.BadHello:
				this.block({ code: 'BadHello', message: 'Volt refused this app\'s greeting. Update the app.' });
				return;
			case CloseCode.Overflow:
				// The server cut us off for falling behind: resume right away.
				this.attempt = 0;
				void this.open();
				return;
			default:
				this.scheduleRetry(code === CloseCode.ShuttingDown
					? { code: 'Restarting', message: 'Volt is restarting.' }
					: { code: 'Disconnected', message: 'Can\'t reach Volt.' });
		}
	}

	/** Closes the socket on purpose and reconnects (now for a gap or retry, else with backoff). */
	private drop(reason: 'gap' | 'retry' | 'timeout', error?: IRemoteError): void {
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			this.detach(socket);
			try {
				socket.close(1000, reason);
			} catch {
				// already closed
			}
		}
		this.afterDrop();
		if (this.stopped) {
			return;
		}
		if (reason === 'timeout') {
			this.scheduleRetry(error ?? { code: 'Timeout', message: 'Volt did not answer in time.' });
		} else {
			void this.open();
		}
	}

	private afterDrop(): void {
		if (this.openTimer) {
			clearTimeout(this.openTimer);
			this.openTimer = undefined;
		}
		if (this.stableTimer) {
			clearTimeout(this.stableTimer);
			this.stableTimer = undefined;
		}
		this.welcomed = false;
		for (const [id, call] of this.pending) {
			if (call.sent) {
				this.pending.delete(id);
				call.reject(new RemoteError('Disconnected', 'The connection dropped before Volt answered.'));
			}
		}
	}

	private detach(socket: IWebSocketLike): void {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onclose = null;
		socket.onerror = null;
	}

	private block(error: IRemoteError): void {
		this.clearRetry();
		this.stopHeartbeat();
		for (const call of this.pending.values()) {
			call.reject(new RemoteError(error.code, error.message));
		}
		this.pending.clear();
		this.setStatus({ phase: 'blocked', attempt: this.attempt, error });
	}

	private scheduleRetry(error: IRemoteError): void {
		if (this.stopped) {
			return;
		}
		if (this.offline) {
			this.setStatus({ phase: 'offline', attempt: this.attempt, error });
			return;
		}
		const delay = backoffDelay(this.attempt, this.backoff.initialMs, this.backoff.maxMs);
		this.attempt++;
		this.clearRetry();
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.open();
		}, delay);
		this.setStatus({ phase: 'waiting', attempt: this.attempt, retryAt: Date.now() + delay, error });
	}

	private clearRetry(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	//#endregion

	//#region Calls and heartbeat

	private sendCall(call: IPendingCall): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== OPEN) {
			return;
		}
		call.sent = true;
		socket.send(JSON.stringify({ t: 'call', id: call.id, method: call.method, params: call.params }));
	}

	private ensureHeartbeat(): void {
		this.heartbeatTimer ??= setInterval(() => this.heartbeat(), HEARTBEAT_EVERY_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private heartbeat(): void {
		const now = Date.now();
		for (const [id, call] of this.pending) {
			if (call.deadline <= now) {
				this.pending.delete(id);
				call.reject(new RemoteError('Timeout', `${call.method} took too long.`));
			}
		}
		if (this.isOpen && now - this.lastFrameAt > SILENCE_PING_MS) {
			this.ping(10_000);
		}
		if (!this.isOpen && !this.pending.size && this._status.phase !== 'connecting') {
			this.stopHeartbeat();
		}
	}

	private pinging = false;

	/** Asks the server something cheap; no answer in `timeoutMs` and the socket is replaced. */
	private ping(timeoutMs: number): void {
		if (this.pinging) {
			return;
		}
		this.pinging = true;
		const socket = this.socket;
		this.call('server.info', [], { timeoutMs, requireOpen: true })
			.catch(err => {
				if (this.socket === socket && err instanceof RemoteError && err.code === 'Timeout') {
					this.options.log?.('[volt] no answer to a ping; reconnecting');
					this.drop('retry');
				}
			})
			.finally(() => this.pinging = false);
	}

	//#endregion

	private setStatus(status: IConnectionStatus): void {
		this._status = status;
		this._onStatus.fire(status);
	}
}

function defaultCreateSocket(url: string): IWebSocketLike {
	const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => IWebSocketLike }).WebSocket;
	if (!ctor) {
		throw new Error('WebSocket is not available.');
	}
	return new ctor(url);
}
