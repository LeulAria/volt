/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { acpRpcErrorMessage } from '../../common/acpNotices.js';

interface IPending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export interface IAcpNotification {
	method: string;
	params: unknown;
}

export interface IAcpRequestOptions {
	/** Bounds requests that must answer promptly (setup). A prompt turn has its own watchdog. */
	readonly timeoutMs?: number;
	/** Gives up on the reply: the pending request rejects with {@link AcpRequestAbandonedError} and a late answer is ignored. */
	readonly token?: CancellationToken;
}

/** The caller stopped waiting for this reply (a stalled or superseded `session/prompt`); the agent was not told. */
export class AcpRequestAbandonedError extends Error {
	constructor(method: string) {
		super(`Stopped waiting for ${method}.`);
		this.name = 'AcpRequestAbandonedError';
	}
}

export interface IAcpIncomingRequest {
	id: string | number;
	method: string;
	params: unknown;
}

export class AcpJsonRpcClient extends Disposable {

	private nextId = 1;
	/** Chunks of the line still being received, joined once its newline arrives. */
	private readonly partial: string[] = [];
	private dead = false;
	private readonly pending = new Map<string | number, IPending>();
	private readonly _onNotification = this._register(new Emitter<IAcpNotification>());
	private readonly _onRequest = this._register(new Emitter<IAcpIncomingRequest>());
	private readonly _onDead = this._register(new Emitter<Error>());
	readonly onNotification: Event<IAcpNotification> = this._onNotification.event;
	readonly onRequest: Event<IAcpIncomingRequest> = this._onRequest.event;
	readonly onDead: Event<Error> = this._onDead.event;

	get isDead(): boolean {
		return this.dead;
	}

	constructor(
		private readonly stdio: IVoltStdioService,
		readonly processId: string,
	) {
		super();
		this._register(stdio.onData(e => {
			if (e.id === processId) {
				this.push(e.data);
			}
		}));
		this._register(stdio.onExit(e => {
			if (e.id === processId) {
				const detail = e.stderr?.trim();
				this.die(new Error(detail
					? `ACP process exited (${e.code ?? 'null'}): ${detail.split(/\r?\n/).filter(Boolean).at(-1)}`
					: `ACP process exited (${e.code ?? 'null'})`));
			}
		}));
	}

	handleRequests(handler: (req: IAcpIncomingRequest) => void): void {
		this._register(this.onRequest(handler));
	}

	/** Listens for the client's lifetime (released with the client). */
	handleNotifications(handler: (note: IAcpNotification) => void): void {
		this._register(this.onNotification(handler));
	}

	whenDead(handler: (err: Error) => void): void {
		this._register(this.onDead(handler));
	}

	/** A number is `timeoutMs`, kept for the setup calls that predate {@link IAcpRequestOptions}. */
	async request<T>(method: string, params?: unknown, options?: number | IAcpRequestOptions): Promise<T> {
		const { timeoutMs, token } = typeof options === 'number' ? { timeoutMs: options, token: undefined } : options ?? {};
		const id = this.nextId++;
		const payload = { jsonrpc: '2.0', id, method, params };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abandon: IDisposable | undefined;
		const settle = () => {
			clearTimeout(timer);
			abandon?.dispose();
		};
		const result = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: value => {
					settle();
					resolve(value as T);
				},
				reject: err => {
					settle();
					reject(err);
				},
			});
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (this.pending.delete(id)) {
						settle();
						reject(new Error(`The agent did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
					}
				}, timeoutMs);
			}
			if (token) {
				const giveUp = () => {
					if (this.pending.delete(id)) {
						settle();
						reject(new AcpRequestAbandonedError(method));
					}
				};
				if (token.isCancellationRequested) {
					giveUp();
				} else {
					abandon = token.onCancellationRequested(giveUp);
				}
			}
		});
		if (!this.pending.has(id)) {
			// Abandoned before it was written: never send it.
			return result;
		}
		await this.writeLine(payload);
		return result;
	}

	/** Requests still waiting for the agent's reply. */
	get pendingCount(): number {
		return this.pending.size;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.writeLine({ jsonrpc: '2.0', method, params });
	}

	async respond(id: string | number, result: unknown): Promise<void> {
		await this.writeLine({ jsonrpc: '2.0', id, result });
	}

	async respondError(id: string | number, message: string): Promise<void> {
		await this.writeLine({ jsonrpc: '2.0', id, error: { code: -32000, message } });
	}

	private async writeLine(payload: unknown): Promise<void> {
		try {
			await this.stdio.write(this.processId, JSON.stringify(payload) + '\n');
		} catch (err) {
			this.die(err instanceof Error ? err : new Error(String(err)));
			throw err;
		}
	}

	/**
	 * Frames newline-delimited messages. Each chunk is scanned only for its own newlines; a line
	 * split over many chunks (a large tool output) is joined once, so framing stays linear.
	 */
	private push(chunk: string): void {
		let start = 0;
		for (let newline = chunk.indexOf('\n'); newline !== -1; newline = chunk.indexOf('\n', start)) {
			const tail = chunk.slice(start, newline);
			let line = tail;
			if (this.partial.length) {
				this.partial.push(tail);
				line = this.partial.join('');
				this.partial.length = 0;
			}
			start = newline + 1;
			// trim() also drops the `\r` of a CRLF line ending.
			const trimmed = line.trim();
			if (trimmed) {
				this.dispatch(trimmed);
			}
		}
		if (start < chunk.length) {
			this.partial.push(start ? chunk.slice(start) : chunk);
		}
	}

	private dispatch(line: string): void {
		let msg: { jsonrpc?: string; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { message?: string; data?: unknown } };
		try {
			msg = JSON.parse(line) as typeof msg;
		} catch {
			return;
		}
		if (msg.id !== undefined && msg.method) {
			this._onRequest.fire({ id: msg.id, method: msg.method, params: msg.params });
			return;
		}
		if (msg.method && msg.id === undefined) {
			this._onNotification.fire({ method: msg.method, params: msg.params });
			return;
		}
		if (msg.id !== undefined) {
			const pending = this.pending.get(msg.id);
			if (!pending) {
				return;
			}
			this.pending.delete(msg.id);
			if (msg.error) {
				pending.reject(new Error(acpRpcErrorMessage(msg.error)));
			} else {
				pending.resolve(msg.result);
			}
		}
	}

	private die(err: Error): void {
		if (this.dead) {
			this.failAll(err);
			return;
		}
		this.dead = true;
		this.failAll(err);
		this._onDead.fire(err);
	}

	private failAll(err: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
	}

	override dispose(): void {
		this.die(new Error('ACP client disposed'));
		super.dispose();
	}
}
