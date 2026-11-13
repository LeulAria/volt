/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { classifyMessage, encodeMessage, FrameDecoder, IPluginMethod, IRpcRequest, IRpcResponse, PLUGIN_PROTOCOL_LIMITS, PluginProtocolError, PluginProtocolLimits, PluginSchema, RpcMessage, validatePluginValue, VoltPluginError } from './pluginProtocol.js';

/**
 * One end of a `volt-plugin/1` channel (spec H.3): the same class runs in core and in the host.
 *
 * - Incoming requests: an unknown method is `NotFound`; over 64 in flight or over the call rate
 *   (a token bucket) is `RateLimited`; params that fail their schema (unknown fields, identity
 *   fields, non-NFC strings) are `InvalidArgument`. A handler gets an `AbortSignal` that fires on
 *   `$/cancel` or when the channel closes.
 * - Outgoing requests: at most 64 in flight (the 65th is `RateLimited` here, never sent), each with
 *   a deadline (30 s default, at most 10 min), after which it is `DeadlineExceeded` and the other
 *   end gets `$/cancel`. A result is checked against the method's result schema.
 * - A malformed stream (a frame over 16 MiB, bytes that are not JSON-RPC) is fatal: `onFatal`,
 *   and every pending request fails with `Cancelled`.
 */

export interface IPluginRpcHandlers {
	/** What this end serves: each method's schemas and its handler. */
	readonly methods: Readonly<Record<string, IPluginMethod>>;
	readonly notifications: Readonly<Record<string, PluginSchema>>;
	handleRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
	handleNotification?(method: string, params: unknown): void;
}

export interface IPluginRpcOptions {
	/** Writes bytes to the transport. */
	readonly write: (bytes: Uint8Array) => void;
	readonly handlers: IPluginRpcHandlers;
	/** What the other end serves: the schemas results are checked with. */
	readonly remote: Readonly<Record<string, IPluginMethod>>;
	readonly limits?: Partial<PluginProtocolLimits>;
	readonly now?: () => number;
	/** The stream is broken: close the channel. */
	readonly onFatal?: (error: PluginProtocolError) => void;
	/** Any message either way (idle accounting). */
	readonly onActivity?: () => void;
	readonly setTimer?: (fn: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
}

export interface IPluginRequestOptions {
	readonly deadlineMs?: number;
	readonly signal?: AbortSignal;
}

interface IPending {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: VoltPluginError) => void;
	readonly timer: unknown;
	readonly cleanup: () => void;
}

export class PluginRpc {

	private readonly decoder: FrameDecoder;
	private readonly limits: PluginProtocolLimits;
	private readonly pending = new Map<number, IPending>();
	private readonly incoming = new Map<number, AbortController>();
	private nextId = 1;
	private nextBinary = 1;
	private tokens: number;
	private refilledAt: number;
	private closed = false;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(private readonly options: IPluginRpcOptions) {
		this.limits = { ...PLUGIN_PROTOCOL_LIMITS, ...options.limits };
		this.decoder = new FrameDecoder(this.limits);
		this.now = options.now ?? Date.now;
		this.tokens = this.limits.burst;
		this.refilledAt = this.now();
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Requests this end sent that have no answer yet. */
	get inFlight(): number {
		return this.pending.size;
	}

	/** Requests the other end sent that are being handled. */
	get handling(): number {
		return this.incoming.size;
	}

	/** Bytes from the transport. */
	receive(chunk: Uint8Array): void {
		if (this.closed) {
			return;
		}
		let messages: unknown[];
		try {
			messages = this.decoder.push(chunk);
		} catch (err) {
			this.fail(err instanceof PluginProtocolError ? err : new PluginProtocolError(String(err)));
			return;
		}
		for (const value of messages) {
			if (this.closed) {
				return;
			}
			const message = classifyMessage(value);
			if (!message) {
				this.fail(new PluginProtocolError('a frame is not a JSON-RPC 2.0 message'));
				return;
			}
			this.options.onActivity?.();
			switch (message.kind) {
				case 'request': this.onRequest(message.message); break;
				case 'notification': this.onNotification(message.message.method, message.message.params); break;
				case 'response': this.onResponse(message.message); break;
			}
		}
	}

	request(method: string, params: unknown, options: IPluginRequestOptions = {}): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new VoltPluginError('Cancelled', 'the channel is closed'));
		}
		const schema = this.options.remote[method];
		if (!schema) {
			return Promise.reject(new VoltPluginError('NotFound', `the other end has no method ${method}`));
		}
		if (this.pending.size >= this.limits.maxInFlight) {
			return Promise.reject(new VoltPluginError('RateLimited', `${this.limits.maxInFlight} requests are in flight already`));
		}
		if (options.signal?.aborted) {
			return Promise.reject(new VoltPluginError('Cancelled', 'cancelled'));
		}
		const id = this.nextId++;
		const deadline = Math.min(Math.max(1, options.deadlineMs ?? this.limits.defaultDeadlineMs), this.limits.maxDeadlineMs);
		return new Promise<unknown>((resolve, reject) => {
			const onAbort = () => this.abandon(id, new VoltPluginError('Cancelled', 'cancelled'));
			options.signal?.addEventListener('abort', onAbort);
			const timer = this.setTimer(() => this.abandon(id, new VoltPluginError('DeadlineExceeded', `${method} did not answer within ${deadline} ms`)), deadline);
			this.pending.set(id, {
				method,
				timer,
				cleanup: () => options.signal?.removeEventListener('abort', onAbort),
				resolve: value => {
					try {
						validatePluginValue(value, schema.result, 'result', this.limits);
					} catch (err) {
						reject(new VoltPluginError('Internal', `${method} answered with a malformed result: ${(err as Error).message}`));
						return;
					}
					resolve(value);
				},
				reject,
			});
			try {
				this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
			} catch (err) {
				this.settle(id);
				reject(VoltPluginError.from(err));
			}
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.closed) {
			this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
		}
	}

	/** The channel closed: every pending request fails, every handler's signal fires. */
	close(reason = 'the channel closed'): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const id of [...this.pending.keys()]) {
			this.settle(id)?.reject(new VoltPluginError('Cancelled', reason));
		}
		for (const controller of this.incoming.values()) {
			controller.abort();
		}
		this.incoming.clear();
	}

	private send(message: RpcMessage): void {
		for (const frame of encodeMessage(message, () => this.nextBinary++, this.limits)) {
			this.options.write(frame);
		}
		this.options.onActivity?.();
	}

	private fail(error: PluginProtocolError): void {
		this.close(error.message);
		this.options.onFatal?.(error);
	}

	private settle(id: number): IPending | undefined {
		const entry = this.pending.get(id);
		if (entry) {
			this.pending.delete(id);
			this.clearTimer(entry.timer);
			entry.cleanup();
		}
		return entry;
	}

	/** Gives up on request `id` (deadline, cancel) and tells the other end. */
	private abandon(id: number, error: VoltPluginError): void {
		const entry = this.settle(id);
		if (entry) {
			entry.reject(error);
			this.notify('$/cancel', { id });
		}
	}

	private takeToken(): boolean {
		const now = this.now();
		this.tokens = Math.min(this.limits.burst, this.tokens + (now - this.refilledAt) * this.limits.callsPerSecond / 1000);
		this.refilledAt = now;
		if (this.tokens < 1) {
			return false;
		}
		this.tokens--;
		return true;
	}

	private reply(id: number, outcome: { result: unknown } | { error: VoltPluginError }): void {
		if (this.closed) {
			return;
		}
		const response: IRpcResponse = 'error' in outcome
			? { jsonrpc: '2.0', id, error: outcome.error.toJSON() }
			: { jsonrpc: '2.0', id, result: outcome.result ?? {} };
		try {
			this.send(response);
		} catch (err) {
			// A result too large to send is the handler's error, not the channel's.
			this.send({ jsonrpc: '2.0', id, error: VoltPluginError.from(err).toJSON() });
		}
	}

	private onRequest(message: IRpcRequest): void {
		const { id, method, params } = message;
		if (this.incoming.has(id)) {
			this.fail(new PluginProtocolError(`request id ${id} is already in flight`));
			return;
		}
		const schema = Object.prototype.hasOwnProperty.call(this.options.handlers.methods, method) ? this.options.handlers.methods[method] : undefined;
		if (!schema) {
			this.reply(id, { error: new VoltPluginError('NotFound', `no method ${method}`) });
			return;
		}
		if (this.incoming.size >= this.limits.maxInFlight) {
			this.reply(id, { error: new VoltPluginError('RateLimited', `${this.limits.maxInFlight} requests are in flight already: wait for one to finish`) });
			return;
		}
		if (!this.takeToken()) {
			this.reply(id, { error: new VoltPluginError('RateLimited', `more than ${this.limits.callsPerSecond} calls per second`) });
			return;
		}
		try {
			validatePluginValue(params ?? {}, schema.params, '', this.limits);
		} catch (err) {
			this.reply(id, { error: VoltPluginError.from(err) });
			return;
		}
		const controller = new AbortController();
		this.incoming.set(id, controller);
		let handled: Promise<unknown>;
		try {
			handled = this.options.handlers.handleRequest(method, params ?? {}, controller.signal);
		} catch (err) {
			handled = Promise.reject(err);
		}
		handled.then(result => {
			if (this.incoming.get(id) === controller) {
				this.incoming.delete(id);
				this.reply(id, controller.signal.aborted ? { error: new VoltPluginError('Cancelled', 'cancelled') } : { result });
			}
		}, err => {
			if (this.incoming.get(id) === controller) {
				this.incoming.delete(id);
				this.reply(id, { error: controller.signal.aborted ? new VoltPluginError('Cancelled', 'cancelled') : VoltPluginError.from(err) });
			}
		});
	}

	private onNotification(method: string, params: unknown): void {
		const schema = Object.prototype.hasOwnProperty.call(this.options.handlers.notifications, method) ? this.options.handlers.notifications[method] : undefined;
		if (!schema) {
			return; // Unknown notifications are dropped (JSON-RPC 2.0).
		}
		try {
			validatePluginValue(params ?? {}, schema, '', this.limits);
		} catch {
			return;
		}
		if (method === '$/cancel') {
			const id = (params as { id: number }).id;
			const controller = this.incoming.get(id);
			if (controller) {
				this.incoming.delete(id);
				controller.abort();
				this.reply(id, { error: new VoltPluginError('Cancelled', 'cancelled') });
			}
			return;
		}
		this.options.handlers.handleNotification?.(method, params ?? {});
	}

	private onResponse(message: IRpcResponse): void {
		const entry = this.settle(message.id);
		if (!entry) {
			return; // Late (past its deadline or cancelled): dropped.
		}
		if (message.error) {
			entry.reject(VoltPluginError.fromObject(message.error));
		} else {
			entry.resolve(message.result);
		}
	}
}
