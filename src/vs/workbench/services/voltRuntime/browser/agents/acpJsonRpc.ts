/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';

interface IPending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export interface IAcpNotification {
	method: string;
	params: unknown;
}

export interface IAcpIncomingRequest {
	id: string | number;
	method: string;
	params: unknown;
}

export class AcpJsonRpcClient extends Disposable {

	private nextId = 1;
	private buffer = '';
	private readonly pending = new Map<string | number, IPending>();
	private readonly _onNotification = this._register(new Emitter<IAcpNotification>());
	private readonly _onRequest = this._register(new Emitter<IAcpIncomingRequest>());
	readonly onNotification: Event<IAcpNotification> = this._onNotification.event;
	readonly onRequest: Event<IAcpIncomingRequest> = this._onRequest.event;

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
				this.failAll(new Error(`ACP process exited (${e.code ?? 'null'})`));
			}
		}));
	}

	async request<T>(method: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		const payload = { jsonrpc: '2.0', id, method, params };
		const result = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: value => resolve(value as T),
				reject,
			});
		});
		await this.stdio.write(this.processId, JSON.stringify(payload) + '\n');
		return result;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.stdio.write(this.processId, JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
	}

	async respond(id: string | number, result: unknown): Promise<void> {
		await this.stdio.write(this.processId, JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
	}

	async respondError(id: string | number, message: string): Promise<void> {
		await this.stdio.write(this.processId, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
	}

	private push(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			this.dispatch(trimmed);
		}
	}

	private dispatch(line: string): void {
		let msg: { jsonrpc?: string; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
		try {
			msg = JSON.parse(line);
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
				pending.reject(new Error(msg.error.message || 'ACP error'));
			} else {
				pending.resolve(msg.result);
			}
		}
	}

	private failAll(err: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
	}

	override dispose(): void {
		this.failAll(new Error('ACP client disposed'));
		super.dispose();
	}
}
