/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { IVoltHttpStreamEvent } from '../../common/voltHttpStreams.js';
import { VoltStreamEmit } from '../../node/voltStreamConnection.js';

export type RecordedEvent = Omit<IVoltHttpStreamEvent, 'id' | 'at'>;

export function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Waits until `condition` holds, failing with `what` when it does not within the time. */
export async function waitUntil(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await delay(5);
	}
}

/** Collects what a protocol module emits and lets a test wait for the next event of a kind. */
export class EventLog {

	readonly events: RecordedEvent[] = [];
	private cursor = 0;
	private waiters: (() => void)[] = [];

	readonly emit: VoltStreamEmit = event => {
		this.events.push(event);
		for (const waiter of this.waiters.splice(0)) {
			waiter();
		}
	};

	/** The next event (after the last one returned) that matches. */
	async next(predicate: RecordedEvent['type'] | ((event: RecordedEvent) => boolean), timeoutMs = 5000): Promise<RecordedEvent> {
		const matches = typeof predicate === 'string' ? (event: RecordedEvent) => event.type === predicate : predicate;
		const end = Date.now() + timeoutMs;
		while (true) {
			for (let i = this.cursor; i < this.events.length; i++) {
				if (matches(this.events[i])) {
					this.cursor = i + 1;
					return this.events[i];
				}
			}
			const left = end - Date.now();
			if (left <= 0) {
				throw new Error(`Timed out waiting for ${typeof predicate === 'string' ? `a "${predicate}" event` : 'an event'}; got ${JSON.stringify(this.events)}`);
			}
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, left);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	types(): string[] {
		return this.events.map(event => event.type);
	}
}

export interface ITestWsFrame {
	readonly opcode: number;
	readonly payload: Buffer;
	readonly fin: boolean;
	readonly masked: boolean;
}

/** One client connected to the test WebSocket server. */
export interface ITestWsPeer {
	readonly request: http.IncomingMessage;
	readonly socket: Duplex;
	/** Every frame the client sent, in order. */
	readonly frames: ITestWsFrame[];
	/** Called per data frame (text 1, binary 2) the client sends. */
	onFrame: ((frame: ITestWsFrame) => void) | undefined;
	/** Writes one unmasked frame; `chunkSize` splits it over several writes. */
	sendFrame(opcode: number, payload: Buffer | string, fin?: boolean, chunkSize?: number): Promise<void>;
	sendText(text: string): void;
	sendClose(code: number, reason: string): void;
	texts(): string[];
}

export interface ITestWsServer {
	readonly port: number;
	readonly peers: ITestWsPeer[];
	close(): Promise<void>;
}

export interface ITestWsServerOptions {
	onPeer?(peer: ITestWsPeer): void;
	/** Answers the upgrade request itself (a refusal, say). Returns true when it did. */
	refuse?(request: http.IncomingMessage, socket: Duplex): boolean;
	/** The subprotocol to select in the handshake answer. */
	protocol?: string;
}

export function encodeWsFrame(opcode: number, payload: Buffer, fin = true): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([(fin ? 0x80 : 0) | opcode, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

/** Just enough of a WebSocket server: the handshake, frames in both directions, the close echo. */
export async function startWsTestServer(options: ITestWsServerOptions = {}): Promise<ITestWsServer> {
	const sockets = new Set<Duplex>();
	const peers: ITestWsPeer[] = [];
	const server = http.createServer((_request, response) => {
		response.writeHead(426);
		response.end('upgrade required');
	});

	server.on('upgrade', (request: http.IncomingMessage, socket: Duplex) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => { /* the client went away */ });
		if (options.refuse?.(request, socket)) {
			return;
		}
		const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
		socket.write([
			'HTTP/1.1 101 Switching Protocols',
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Accept: ${accept}`,
			...(options.protocol ? [`Sec-WebSocket-Protocol: ${options.protocol}`] : []),
			'X-Test-Server: volt',
			'', ''
		].join('\r\n'));

		let closeSent = false;
		const peer: ITestWsPeer = {
			request,
			socket,
			frames: [],
			onFrame: undefined,
			sendFrame: async (opcode, payload, fin = true, chunkSize) => {
				const frame = encodeWsFrame(opcode, typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload, fin);
				if (!chunkSize) {
					socket.write(frame);
					return;
				}
				// The first pieces are small (they end inside the header), the rest goes out at once.
				let offset = 0;
				for (const size of [1, chunkSize, chunkSize]) {
					socket.write(frame.subarray(offset, offset + size));
					offset += size;
					await delay(2);
				}
				socket.write(frame.subarray(offset));
			},
			sendText: text => {
				socket.write(encodeWsFrame(1, Buffer.from(text, 'utf8')));
			},
			sendClose: (code, reason) => {
				closeSent = true;
				const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
				payload.writeUInt16BE(code, 0);
				payload.write(reason, 2);
				socket.write(encodeWsFrame(8, payload));
			},
			texts: () => peer.frames.filter(frame => frame.opcode === 1).map(frame => frame.payload.toString('utf8'))
		};
		peers.push(peer);

		let buffer: Buffer = Buffer.alloc(0);
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 2) {
				const masked = (buffer[1] & 0x80) !== 0;
				let length = buffer[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < 4) {
						return;
					}
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.length < 10) {
						return;
					}
					length = Number(buffer.readBigUInt64BE(2));
					offset = 10;
				}
				const maskOffset = offset;
				if (masked) {
					offset += 4;
				}
				if (buffer.length < offset + length) {
					return;
				}
				const payload = Buffer.from(buffer.subarray(offset, offset + length));
				if (masked) {
					for (let i = 0; i < payload.length; i++) {
						payload[i] ^= buffer[maskOffset + (i & 3)];
					}
				}
				const frame: ITestWsFrame = { opcode: buffer[0] & 0x0f, payload, fin: (buffer[0] & 0x80) !== 0, masked };
				buffer = buffer.subarray(offset + length);
				peer.frames.push(frame);
				if (frame.opcode === 8) {
					if (!closeSent) {
						closeSent = true;
						socket.write(encodeWsFrame(8, payload));
					}
					socket.end();
				} else if (frame.opcode === 1 || frame.opcode === 2) {
					peer.onFrame?.(frame);
				}
			}
		});
		options.onPeer?.(peer);
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as AddressInfo).port,
		peers,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	};
}
