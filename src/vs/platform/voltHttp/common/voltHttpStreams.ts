/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** The main process channel the Volt Client's long-lived connections go through. */
export const VOLT_HTTP_STREAMS_CHANNEL_NAME = 'voltHttpStreams';

export const IVoltHttpStreams = createDecorator<IVoltHttpStreams>('voltHttpStreams');

/** The connection kinds that stay open and exchange messages. */
export type VoltHttpStreamKind = 'ws' | 'sse' | 'socketio' | 'mqtt' | 'grpc';

export interface IVoltHttpStreamSpec {
	readonly kind: VoltHttpStreamKind;
	/**
	 * Where to connect, variables already filled in.
	 * - ws: `ws://` / `wss://` (`http(s)://` is taken as `ws(s)://`).
	 * - sse: `http(s)://`.
	 * - socketio: `http(s)://host[:port][/namespace]` (`ws(s)://` too). The engine path is `socketio.path`.
	 * - mqtt: `mqtt://`, `mqtts://`, `tcp://`, `ssl://`, or `ws(s)://` for MQTT over WebSocket.
	 * - grpc: `host:port`, `http://host:port` (plaintext, h2c) or `https://` / `grpcs://` (TLS). No path: the method is in `grpc`.
	 */
	readonly url: string;
	/** Request headers (ws / sse / socketio handshake), or gRPC metadata. */
	readonly headers?: Readonly<Record<string, string>>;
	/** sse: the method (GET when absent) and a body to send with it. */
	readonly method?: string;
	readonly body?: string;
	/** How long connecting may take before it fails (ms). 15000 when absent. */
	readonly connectTimeoutMs?: number;
	readonly socketio?: {
		/** The engine.io path, `/socket.io` when absent. */
		readonly path?: string;
		/** The `auth` payload of the namespace connect packet, as JSON text. */
		readonly auth?: string;
	};
	readonly mqtt?: {
		readonly clientId?: string;
		readonly username?: string;
		readonly password?: string;
		/** Topic filters subscribed once connected. */
		readonly subscribe?: readonly string[];
		readonly keepAliveSeconds?: number;
		readonly qos?: 0 | 1;
	};
	readonly grpc?: {
		/** `package.Service`. */
		readonly service: string;
		readonly method: string;
		/**
		 * The `.proto` sources by file name (the first is the entry; the others are its imports, keyed
		 * by the path the import statement names). When absent the server's reflection service is asked.
		 */
		readonly protos?: Readonly<Record<string, string>>;
		/** The first request message as JSON text, sent as soon as the call opens. */
		readonly message?: string;
	};
}

/**
 * What happens on a connection, in order.
 * - `open`: connected. `status` and `headers` are the handshake's (ws, sse, socketio) or the call's
 *   response headers (grpc); `text` says what was connected to in a few words.
 * - `message`: one received. `target` is the Socket.IO event, MQTT topic, SSE event name or gRPC
 *   method; `data` its payload as text (JSON text for socketio args and gRPC messages); `binary`
 *   means `data` is base64.
 * - `sent`: one this side sent (the same fields), reported once it is written.
 * - `info`: something worth a line in the log (subscribed, ping, reconnect hint, trailers).
 * - `error`: it failed; a `close` follows.
 * - `close`: over. `code` and `text` are the close code and reason (ws), the grpc-status and
 *   grpc-message (grpc), or nothing.
 */
export interface IVoltHttpStreamEvent {
	readonly id: string;
	readonly type: 'open' | 'message' | 'sent' | 'info' | 'error' | 'close';
	/** `Date.now()` in the main process. */
	readonly at: number;
	readonly target?: string;
	readonly data?: string;
	readonly binary?: boolean;
	readonly text?: string;
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly code?: number;
	/** Bytes on the wire for a message, when known. */
	readonly size?: number;
}

export interface IVoltHttpStreamMessage {
	/** Text to send (JSON text for a Socket.IO event's arguments array or single value, and for a gRPC message). */
	readonly data: string;
	/** The Socket.IO event name (`message` when absent) or the MQTT topic (required). */
	readonly target?: string;
	/** `data` is base64 and goes out as bytes (ws binary frame, MQTT payload). */
	readonly binary?: boolean;
	/** MQTT: retain flag and QoS for this publish. */
	readonly retain?: boolean;
	readonly qos?: 0 | 1;
	/** gRPC: no more request messages after this one (half-close). */
	readonly end?: boolean;
}

/**
 * Long-lived connections for the Volt Client, made from the main process so no page rules (CORS,
 * forbidden headers, mixed content) apply. The window names each connection with an id of its own;
 * everything that happens on it comes back through `onDidStreamEvent` with that id.
 */
export interface IVoltHttpStreams {
	readonly _serviceBrand: undefined;
	readonly onDidStreamEvent: Event<IVoltHttpStreamEvent>;
	/** Starts connecting and returns at once; `open` or `error` + `close` follow as events. */
	open(id: string, spec: IVoltHttpStreamSpec): Promise<void>;
	/** Sends on an open connection. Rejects when it is not open or the kind cannot send (sse). */
	send(id: string, message: IVoltHttpStreamMessage): Promise<void>;
	/** Closes (a `close` event follows). Closing an unknown id is not an error. */
	close(id: string): Promise<void>;
	/**
	 * gRPC only: what the server at `url` offers, from the given protos or its reflection service.
	 * Each method says whether either side streams.
	 */
	describeGrpc(url: string, headers: Readonly<Record<string, string>> | undefined, protos: Readonly<Record<string, string>> | undefined): Promise<readonly IVoltGrpcServiceInfo[]>;
}

export interface IVoltGrpcServiceInfo {
	/** `package.Service`. */
	readonly name: string;
	readonly methods: readonly {
		readonly name: string;
		readonly clientStreaming: boolean;
		readonly serverStreaming: boolean;
		/** A request message with every field at its default, as JSON text: what the editor starts from. */
		readonly template: string;
	}[];
}
