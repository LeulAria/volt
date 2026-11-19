/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IVoltGrpcServiceInfo, IVoltHttpStreamEvent, IVoltHttpStreamMessage, IVoltHttpStreams, IVoltHttpStreamSpec } from '../common/voltHttpStreams.js';
import { describeGrpc, openGrpcCall } from '../node/voltGrpc.js';
import { openMqtt } from '../node/voltMqtt.js';
import { openSocketIo } from '../node/voltSocketIo.js';
import { openSse } from '../node/voltSse.js';
import { IVoltStreamConnection, VoltStreamEmit } from '../node/voltStreamConnection.js';
import { openWebSocket } from '../node/voltWebSocket.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
/** The most of one message's `data` that goes to the window (characters). */
const MAX_DATA_LENGTH = 1024 * 1024;
/** How long a connection has to report its own `close` after it was asked to, or after an `error`. */
const CLOSE_GRACE_MS = 3000;

interface IStreamEntry {
	readonly id: string;
	connection: IVoltStreamConnection | undefined;
	closed: boolean;
	connectTimer: ReturnType<typeof setTimeout> | undefined;
	readonly grpc: boolean;
	closeTimer: ReturnType<typeof setTimeout> | undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The Volt Client's long-lived connections, made from the main process. Each protocol lives in its
 * own module under `../node`; this keeps the connections by id and makes sure the window sees every
 * one of them end with exactly one `close`.
 */
export class VoltHttpStreamsMainService extends Disposable implements IVoltHttpStreams {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidStreamEvent = this._register(new Emitter<IVoltHttpStreamEvent>());
	readonly onDidStreamEvent: Event<IVoltHttpStreamEvent> = this._onDidStreamEvent.event;

	private readonly entries = new Map<string, IStreamEntry>();

	async open(id: string, spec: IVoltHttpStreamSpec): Promise<void> {
		const previous = this.entries.get(id);
		if (previous) {
			this.endNow(previous);
		}

		const entry: IStreamEntry = { id, connection: undefined, closed: false, connectTimer: undefined, closeTimer: undefined, grpc: spec.kind === 'grpc' };
		this.entries.set(id, entry);
		const emit: VoltStreamEmit = event => this.onEvent(entry, event);

		const timeout = Math.max(1, spec.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		entry.connectTimer = setTimeout(() => {
			emit({ type: 'error', text: `Timed out connecting after ${timeout} ms` });
			this.endNow(entry);
		}, timeout);

		try {
			entry.connection = this.connect(spec, emit);
		} catch (error) {
			emit({ type: 'error', text: errorMessage(error) });
			emit({ type: 'close' });
			return;
		}
		if (entry.closed) {
			// It ended while it was being set up; nothing is left to hold on to.
			entry.connection = undefined;
		}
	}

	async send(id: string, message: IVoltHttpStreamMessage): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry || entry.closed || !entry.connection) {
			throw new Error(`Cannot send: connection ${id} is not open`);
		}
		entry.connection.send(message);
	}

	async close(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry || entry.closed) {
			return;
		}
		this.requestClose(entry);
	}

	describeGrpc(url: string, headers: Readonly<Record<string, string>> | undefined, protos: Readonly<Record<string, string>> | undefined): Promise<readonly IVoltGrpcServiceInfo[]> {
		return describeGrpc(url, headers, protos);
	}

	/** Makes the connection for a spec. Throws for a spec no module can take. */
	protected connect(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
		switch (spec.kind) {
			case 'ws': return openWebSocket(spec, emit);
			case 'sse': return openSse(spec, emit);
			case 'socketio': return openSocketIo(spec, emit);
			case 'mqtt': return openMqtt(spec, emit);
			case 'grpc': return openGrpcCall(spec, emit);
			default: throw new Error(`Unknown connection kind: ${String((spec as { kind?: unknown }).kind)}`);
		}
	}

	private onEvent(entry: IStreamEntry, event: Omit<IVoltHttpStreamEvent, 'id' | 'at'>): void {
		if (entry.closed) {
			return;
		}
		// A gRPC call is connected once its stream starts (its first `info`): the response headers behind `open` may wait for the first answer.
		if (event.type === 'open' || event.type === 'error' || event.type === 'close' || (event.type === 'info' && entry.grpc)) {
			clearTimeout(entry.connectTimer);
			entry.connectTimer = undefined;
		}
		if (event.type === 'close') {
			entry.closed = true;
			clearTimeout(entry.closeTimer);
			entry.closeTimer = undefined;
			entry.connection = undefined;
			if (this.entries.get(entry.id) === entry) {
				this.entries.delete(entry.id);
			}
		}

		const at = Date.now();
		if (event.data !== undefined && event.data.length > MAX_DATA_LENGTH) {
			this._onDidStreamEvent.fire({ ...event, data: event.data.slice(0, MAX_DATA_LENGTH), id: entry.id, at });
			this._onDidStreamEvent.fire({ type: 'info', id: entry.id, at, text: `The message was cut to 1 MB (it had ${event.data.length} characters)` });
		} else {
			this._onDidStreamEvent.fire({ ...event, id: entry.id, at });
		}

		if (event.type === 'error' && !entry.closed && !entry.closeTimer) {
			// An error ends the connection. The module closes by itself; this covers one that does not.
			entry.closeTimer = setTimeout(() => this.endNow(entry), CLOSE_GRACE_MS);
		}
	}

	/** Asks the connection to close and gives it a moment to say so itself (a close code, a status). */
	private requestClose(entry: IStreamEntry): void {
		const connection = entry.connection;
		if (!connection) {
			this.endNow(entry);
			return;
		}
		clearTimeout(entry.closeTimer);
		entry.closeTimer = setTimeout(() => this.endNow(entry), CLOSE_GRACE_MS);
		try {
			connection.close();
		} catch {
			this.endNow(entry);
		}
	}

	/** Closes the connection and reports `close` now if the connection has not done so by itself. */
	private endNow(entry: IStreamEntry): void {
		if (entry.closed) {
			return;
		}
		try {
			entry.connection?.close();
		} catch {
			// It is being dropped either way.
		}
		this.onEvent(entry, { type: 'close' });
	}

	override dispose(): void {
		for (const entry of [...this.entries.values()]) {
			this.endNow(entry);
			clearTimeout(entry.connectTimer);
			clearTimeout(entry.closeTimer);
		}
		this.entries.clear();
		super.dispose();
	}
}
