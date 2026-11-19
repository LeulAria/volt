/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import type { Duplex } from 'stream';
import { IVoltHttpStreamMessage, IVoltHttpStreamSpec } from '../common/voltHttpStreams.js';
import { IVoltStreamConnection, VoltStreamEmit } from './voltStreamConnection.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A message larger than this ends the connection (close code 1009). */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** How long the other side has to answer our close frame before the socket is dropped. */
const CLOSE_HANDSHAKE_TIMEOUT_MS = 2000;
/** How much of a refused handshake's body goes into the error. */
const REFUSAL_EXCERPT_BYTES = 2048;
/** At most one `info` line about pings per this long. */
const PING_INFO_INTERVAL_MS = 30000;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;

/** Headers the handshake owns; a caller's values for them are dropped. */
const RESERVED_HEADERS = new Set(['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']);

export interface IVoltWebSocketOptions {
	/** `ws://` or `wss://`; `http(s)://` is taken as `ws(s)://`. */
	readonly url: string;
	/** Extra handshake headers. A `Sec-WebSocket-Protocol` here is sent as is. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Subprotocols to offer, when `headers` names none. */
	readonly protocols?: readonly string[];
}

/**
 * What a WebSocket reports. `onClose` comes exactly once, whatever happened; `onError` is always
 * followed by it.
 */
export interface IVoltWebSocketHandlers {
	onOpen(status: number, headers: Record<string, string>, protocol: string | undefined): void;
	/** One whole message (fragments already joined). */
	onMessage(data: Buffer, binary: boolean): void;
	/** A ping arrived (the pong is already sent). */
	onPing?(data: Buffer): void;
	/** `status` and `headers` are there when the server answered the handshake with something else than 101. */
	onError(message: string, status?: number, headers?: Record<string, string>): void;
	/** `code` is the close frame's (1005 when it had none), 1006 when the socket just ended, nothing when it never opened. */
	onClose(code: number | undefined, reason: string): void;
}

/** Response headers as one string each (repeated headers joined with a comma). */
export function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined) {
			result[name] = Array.isArray(value) ? value.join(', ') : value;
		}
	}
	return result;
}

/** The `Sec-WebSocket-Accept` value a server must answer a `Sec-WebSocket-Key` with (RFC 6455, 4.2.2). */
export function webSocketAcceptKey(key: string): string {
	return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
}

/** `ws(s)://` for a URL that may have been written as `http(s)://`. Throws for any other scheme. */
export function toWebSocketUrl(url: string): URL {
	const parsed = new URL(url);
	if (parsed.protocol === 'http:') {
		parsed.protocol = 'ws:';
	} else if (parsed.protocol === 'https:') {
		parsed.protocol = 'wss:';
	}
	if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
		throw new Error(`Not a WebSocket URL: ${url} (expected ws:// or wss://)`);
	}
	return parsed;
}

/** The host name as `http.request` wants it: an IPv6 literal without its brackets. */
export function requestHostname(url: URL): string {
	return url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * A small RFC 6455 client: the upgrade handshake on `http`/`https`, text and binary messages,
 * fragmentation, masked client frames, ping -> pong and the close handshake. No extensions are
 * offered (so no permessage-deflate).
 */
export class VoltWebSocketClient {

	private state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
	private readonly request: http.ClientRequest;
	private socket: Duplex | undefined;

	/** Received bytes not yet parsed, and how many are needed before parsing can go on. */
	private chunks: Buffer[] = [];
	private buffered = 0;
	private needed = 2;

	/** The message being put together from fragments. */
	private fragments: Buffer[] = [];
	private fragmentOpcode = 0;
	private fragmentBytes = 0;

	private closeSent = false;
	private receivedClose: { readonly code: number; readonly reason: string } | undefined;
	private closeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: IVoltWebSocketOptions, private readonly handlers: IVoltWebSocketHandlers) {
		const url = toWebSocketUrl(options.url);
		const secure = url.protocol === 'wss:';
		const key = randomBytes(16).toString('base64');

		const headers: Record<string, string> = {};
		let offersProtocol = false;
		for (const [name, value] of Object.entries(options.headers ?? {})) {
			const lower = name.toLowerCase();
			if (RESERVED_HEADERS.has(lower)) {
				continue;
			}
			offersProtocol = offersProtocol || lower === 'sec-websocket-protocol';
			headers[name] = value;
		}
		if (!offersProtocol && options.protocols?.length) {
			headers['Sec-WebSocket-Protocol'] = options.protocols.join(', ');
		}
		headers['Connection'] = 'Upgrade';
		headers['Upgrade'] = 'websocket';
		headers['Sec-WebSocket-Version'] = '13';
		headers['Sec-WebSocket-Key'] = key;

		const requestOptions: https.RequestOptions = {
			protocol: secure ? 'https:' : 'http:',
			hostname: requestHostname(url),
			port: url.port || (secure ? 443 : 80),
			path: url.pathname + url.search,
			method: 'GET',
			headers,
			agent: false
		};
		if (url.username) {
			requestOptions.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
		}

		this.request = (secure ? https : http).request(requestOptions);
		this.request.on('upgrade', (response, socket, head) => this.onUpgrade(response, socket, head, key));
		this.request.on('response', response => this.onRefused(response));
		this.request.on('error', error => this.fail(error.message));
		this.request.end();
	}

	get isOpen(): boolean {
		return this.state === 'open';
	}

	/** Sends one message. Throws when the socket is not open; `callback` runs once it is written. */
	send(data: string | Buffer, binary: boolean, callback?: (error?: Error | null) => void): void {
		if (this.state !== 'open') {
			throw new Error(this.state === 'connecting' ? 'The WebSocket is still connecting' : 'The WebSocket is closed');
		}
		this.writeFrame(binary ? OPCODE_BINARY : OPCODE_TEXT, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, callback);
	}

	/** Starts the close handshake (or gives up connecting). `onClose` follows. */
	close(code = 1000, reason = ''): void {
		if (this.state === 'connecting') {
			this.finish(undefined, '');
		} else if (this.state === 'open') {
			this.state = 'closing';
			this.writeClose(code, reason);
			this.closeTimer = setTimeout(() => this.finish(1006, ''), CLOSE_HANDSHAKE_TIMEOUT_MS);
		}
	}

	/** Drops the connection at once, without a close handshake. `onClose` still comes. */
	destroy(): void {
		this.finish(this.state === 'connecting' ? undefined : 1006, '');
	}

	//#region Handshake

	private onUpgrade(response: http.IncomingMessage, socket: Duplex, head: Buffer, key: string): void {
		if (this.state !== 'connecting') {
			socket.destroy();
			return;
		}
		const expected = webSocketAcceptKey(key);
		if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) {
			socket.destroy();
			this.fail('The server\'s handshake answer is not a valid WebSocket upgrade (bad Sec-WebSocket-Accept)', response.statusCode, flattenHeaders(response.headers));
			return;
		}
		this.socket = socket;
		this.state = 'open';
		socket.on('data', (chunk: Buffer) => this.onData(chunk));
		socket.on('error', (error: Error) => this.fail(error.message));
		socket.on('close', () => this.finish(this.receivedClose?.code ?? 1006, this.receivedClose?.reason ?? ''));

		const protocol = response.headers['sec-websocket-protocol'];
		this.handlers.onOpen(101, flattenHeaders(response.headers), typeof protocol === 'string' && protocol ? protocol : undefined);
		if (head.length) {
			this.onData(head);
		}
	}

	/** The server answered the upgrade request like a plain HTTP request. */
	private onRefused(response: http.IncomingMessage): void {
		const status = response.statusCode ?? 0;
		const headers = flattenHeaders(response.headers);
		const parts: Buffer[] = [];
		let size = 0;
		let reported = false;
		const report = () => {
			if (reported) {
				return;
			}
			reported = true;
			clearTimeout(timer);
			const excerpt = Buffer.concat(parts).subarray(0, REFUSAL_EXCERPT_BYTES).toString('utf8').trim();
			const statusText = response.statusMessage ? `${status} ${response.statusMessage}` : String(status);
			this.fail(`The server answered ${statusText} instead of switching to WebSocket${excerpt ? `: ${excerpt}` : ''}`, status, headers);
		};
		// A body that never ends (an event stream, say) must not hold the answer back.
		const timer = setTimeout(report, 1000);
		response.on('data', (chunk: Buffer) => {
			parts.push(chunk);
			size += chunk.length;
			if (size >= REFUSAL_EXCERPT_BYTES) {
				report();
			}
		});
		response.on('end', report);
		response.on('error', report);
		response.on('close', report);
	}

	//#endregion

	//#region Receiving

	private onData(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.buffered += chunk.length;
		while (this.state !== 'closed' && this.buffered >= this.needed) {
			if (!this.readFrame()) {
				break;
			}
		}
	}

	/** Parses one frame off the buffer. False when more bytes are needed (`needed` says how many). */
	private readFrame(): boolean {
		const buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
		this.chunks = [buffer];

		const first = buffer[0];
		const second = buffer[1];
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (buffer.length < 4) {
				this.needed = 4;
				return false;
			}
			length = buffer.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buffer.length < 10) {
				this.needed = 10;
				return false;
			}
			const long = buffer.readBigUInt64BE(2);
			if (long > BigInt(MAX_MESSAGE_BYTES)) {
				this.protocolError(1009, 'The server sent a message that is too large');
				return false;
			}
			length = Number(long);
			offset = 10;
		}
		if (masked) {
			offset += 4;
		}
		if (buffer.length < offset + length) {
			this.needed = offset + length;
			return false;
		}

		let payload = buffer.subarray(offset, offset + length);
		if (masked) {
			// A server must not mask, but unmasking costs nothing.
			const mask = buffer.subarray(offset - 4, offset);
			payload = Buffer.from(payload);
			for (let i = 0; i < payload.length; i++) {
				payload[i] ^= mask[i & 3];
			}
		}
		const rest = buffer.subarray(offset + length);
		this.chunks = rest.length ? [rest] : [];
		this.buffered = rest.length;
		this.needed = 2;

		if (first & 0x70) {
			this.protocolError(1002, 'The server sent a frame with reserved bits set (an extension that was not negotiated)');
			return false;
		}
		this.onFrame((first & 0x80) !== 0, first & 0x0f, payload);
		return true;
	}

	private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
		if (opcode >= OPCODE_CLOSE) {
			if (!fin || payload.length > 125) {
				this.protocolError(1002, 'The server sent a malformed control frame');
				return;
			}
			if (opcode === OPCODE_PING) {
				if (this.state === 'open') {
					this.writeFrame(OPCODE_PONG, payload);
				}
				this.handlers.onPing?.(payload);
			} else if (opcode === OPCODE_CLOSE) {
				this.onCloseFrame(payload);
			} else if (opcode !== OPCODE_PONG) {
				this.protocolError(1002, `The server sent an unknown control frame (opcode ${opcode})`);
			}
			return;
		}

		if (opcode === OPCODE_CONTINUATION) {
			if (!this.fragmentOpcode) {
				this.protocolError(1002, 'The server sent a continuation frame with nothing to continue');
				return;
			}
		} else if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
			if (this.fragmentOpcode) {
				this.protocolError(1002, 'The server started a new message before finishing the fragmented one');
				return;
			}
			if (fin) {
				this.handlers.onMessage(payload, opcode === OPCODE_BINARY);
				return;
			}
			this.fragmentOpcode = opcode;
		} else {
			this.protocolError(1002, `The server sent an unknown frame (opcode ${opcode})`);
			return;
		}

		this.fragments.push(payload);
		this.fragmentBytes += payload.length;
		if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
			this.protocolError(1009, 'The server sent a message that is too large');
			return;
		}
		if (fin) {
			const message = Buffer.concat(this.fragments, this.fragmentBytes);
			const binary = this.fragmentOpcode === OPCODE_BINARY;
			this.fragments = [];
			this.fragmentBytes = 0;
			this.fragmentOpcode = 0;
			this.handlers.onMessage(message, binary);
		}
	}

	private onCloseFrame(payload: Buffer): void {
		const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
		const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
		this.receivedClose = { code, reason };
		if (!this.closeSent) {
			this.writeClose(payload.length >= 2 ? code : undefined, '');
		}
		this.state = 'closing';
		clearTimeout(this.closeTimer);
		// The socket's own `close` normally ends it; the timer covers a server that keeps it open.
		this.closeTimer = setTimeout(() => this.finish(code, reason), CLOSE_HANDSHAKE_TIMEOUT_MS);
		this.socket?.end();
	}

	//#endregion

	//#region Sending

	private writeFrame(opcode: number, payload: Buffer, callback?: (error?: Error | null) => void): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			callback?.(new Error('The WebSocket is closed'));
			return;
		}
		const length = payload.length;
		const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
		const frame = Buffer.allocUnsafe(2 + lengthBytes + 4 + length);
		frame[0] = 0x80 | opcode;
		if (lengthBytes === 0) {
			frame[1] = 0x80 | length;
		} else if (lengthBytes === 2) {
			frame[1] = 0x80 | 126;
			frame.writeUInt16BE(length, 2);
		} else {
			frame[1] = 0x80 | 127;
			frame.writeBigUInt64BE(BigInt(length), 2);
		}
		const maskOffset = 2 + lengthBytes;
		const mask = randomBytes(4);
		mask.copy(frame, maskOffset);
		const start = maskOffset + 4;
		for (let i = 0; i < length; i++) {
			frame[start + i] = payload[i] ^ mask[i & 3];
		}
		socket.write(frame, callback);
	}

	private writeClose(code: number | undefined, reason: string): void {
		this.closeSent = true;
		let payload: Buffer = Buffer.alloc(0);
		if (code !== undefined) {
			const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
			payload = Buffer.allocUnsafe(2 + reasonBytes.length);
			payload.writeUInt16BE(code, 0);
			reasonBytes.copy(payload, 2);
		}
		this.writeFrame(OPCODE_CLOSE, payload);
	}

	//#endregion

	private protocolError(code: number, message: string): void {
		if (this.state === 'open') {
			this.writeClose(code, '');
		}
		this.fail(message);
	}

	private fail(message: string, status?: number, headers?: Record<string, string>): void {
		if (this.state === 'closed') {
			return;
		}
		const wasConnecting = this.state === 'connecting';
		this.handlers.onError(message, status, headers);
		this.finish(wasConnecting ? undefined : (this.receivedClose?.code ?? 1006), this.receivedClose?.reason ?? '');
	}

	private finish(code: number | undefined, reason: string): void {
		if (this.state === 'closed') {
			return;
		}
		this.state = 'closed';
		clearTimeout(this.closeTimer);
		this.request.destroy();
		this.socket?.destroy();
		this.chunks = [];
		this.fragments = [];
		this.handlers.onClose(code, reason);
	}
}

/** A WebSocket as the Volt Client shows it: text frames as text, binary frames as base64. */
export function openWebSocket(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
	const url = toWebSocketUrl(spec.url);
	let pings = 0;
	let lastPingInfo = 0;

	const client = new VoltWebSocketClient({ url: spec.url, headers: spec.headers }, {
		onOpen: (status, headers, protocol) => {
			emit({ type: 'open', status, headers, text: `Connected to ${url.host}${protocol ? ` (subprotocol ${protocol})` : ''}` });
		},
		onMessage: (data, binary) => {
			if (binary) {
				emit({ type: 'message', data: data.toString('base64'), binary: true, size: data.length });
			} else {
				emit({ type: 'message', data: data.toString('utf8'), size: data.length });
			}
		},
		onPing: () => {
			pings++;
			const now = Date.now();
			if (now - lastPingInfo >= PING_INFO_INTERVAL_MS) {
				lastPingInfo = now;
				emit({ type: 'info', text: pings === 1 ? 'Ping received, pong sent' : `Ping received, pong sent (${pings} pings so far)` });
			}
		},
		onError: (message, status, headers) => {
			emit({ type: 'error', text: message, ...(status !== undefined ? { status } : {}), ...(headers ? { headers } : {}) });
		},
		onClose: (code, reason) => {
			emit({ type: 'close', ...(code !== undefined ? { code } : {}), ...(reason ? { text: reason } : {}) });
		}
	});

	return {
		send(message: IVoltHttpStreamMessage): void {
			const payload = message.binary ? Buffer.from(message.data, 'base64') : Buffer.from(message.data, 'utf8');
			client.send(payload, !!message.binary, error => {
				if (!error) {
					emit({ type: 'sent', data: message.data, ...(message.binary ? { binary: true } : {}), size: payload.length });
				}
			});
		},
		close(): void {
			client.close();
		}
	};
}
