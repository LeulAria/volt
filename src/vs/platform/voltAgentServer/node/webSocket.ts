/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { Emitter, Event } from '../../../base/common/event.js';
import { IServerSocket } from '../common/protocolServer.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const enum Op {
	Continuation = 0x0,
	Text = 0x1,
	Binary = 0x2,
	Close = 0x8,
	Ping = 0x9,
	Pong = 0xA,
}

export interface IWebSocketOptions {
	/** Largest message accepted from a client. */
	readonly maxMessageBytes?: number;
	/** Ping interval; a client that misses two pongs is dropped (laptop slept, network gone). */
	readonly pingIntervalMs?: number;
}

/**
 * Completes the HTTP upgrade and returns the socket, or answers 400 and returns undefined.
 * Text frames only (JSON); no extensions, so no permessage-deflate (the link is local).
 */
export function acceptWebSocket(req: IncomingMessage, socket: Socket, options: IWebSocketOptions = {}): NodeWebSocket | undefined {
	const key = req.headers['sec-websocket-key'];
	if ((req.headers['upgrade'] ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
		socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
		return undefined;
	}
	const accept = createHash('sha1').update(key + GUID).digest('base64'); // CodeQL [SM04514] SHA1 is required by RFC 6455
	socket.write([
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Accept: ${accept}`,
		'', '',
	].join('\r\n'));
	socket.setNoDelay(true);
	socket.setTimeout(0);
	return new NodeWebSocket(socket, options);
}

/** One server-side WebSocket over a raw TCP socket. */
export class NodeWebSocket implements IServerSocket {

	private readonly _onMessage = new Emitter<string>();
	readonly onMessage: Event<string> = this._onMessage.event;

	private readonly _onClose = new Emitter<void>();
	readonly onClose: Event<void> = this._onClose.event;

	private pending: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentBytes = 0;
	private fragmentOp: Op | undefined;
	private closed = false;
	private closeSent = false;
	private missedPongs = 0;
	private readonly pingTimer: ReturnType<typeof setInterval> | undefined;
	private readonly maxMessageBytes: number;

	constructor(private readonly socket: Socket, options: IWebSocketOptions = {}) {
		this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024 * 1024;
		socket.on('data', data => this.onData(data));
		socket.on('close', () => this.finish());
		socket.on('error', () => this.finish());
		const interval = options.pingIntervalMs ?? 20_000;
		if (interval > 0) {
			this.pingTimer = setInterval(() => {
				if (this.missedPongs >= 2) {
					this.socket.destroy();
					return;
				}
				this.missedPongs++;
				this.writeFrame(Op.Ping, Buffer.alloc(0));
			}, interval);
			(this.pingTimer as unknown as { unref?(): void }).unref?.();
		}
	}

	get bufferedAmount(): number {
		return this.socket.writableLength;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	send(text: string): void {
		if (!this.closed && !this.closeSent) {
			this.writeFrame(Op.Text, Buffer.from(text, 'utf8'));
		}
	}

	close(code: number, reason: string): void {
		if (this.closed || this.closeSent) {
			return;
		}
		this.closeSent = true;
		const reasonBytes = Buffer.from(reason.slice(0, 100), 'utf8');
		const payload = Buffer.alloc(2 + reasonBytes.length);
		payload.writeUInt16BE(code, 0);
		reasonBytes.copy(payload, 2);
		this.writeFrame(Op.Close, payload);
		this.socket.end();
		// A peer that never answers the close must not hold the socket.
		(setTimeout(() => this.socket.destroy(), 2_000) as unknown as { unref?(): void }).unref?.();
	}

	private writeFrame(op: Op, payload: Buffer): void {
		const length = payload.length;
		let header: Buffer;
		if (length < 126) {
			header = Buffer.alloc(2);
			header[1] = length;
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		header[0] = 0x80 | op;
		try {
			this.socket.write(Buffer.concat([header, payload]));
		} catch {
			this.finish();
		}
	}

	private onData(data: Buffer): void {
		this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
		while (!this.closed) {
			const consumed = this.readFrame();
			if (consumed === 0) {
				break;
			}
			this.pending = this.pending.subarray(consumed);
		}
	}

	/** Parses one frame from `pending`; returns the bytes it used, 0 when the frame is incomplete. */
	private readFrame(): number {
		const buf = this.pending;
		if (buf.length < 2) {
			return 0;
		}
		const fin = (buf[0] & 0x80) !== 0;
		const op = buf[0] & 0x0F;
		const masked = (buf[1] & 0x80) !== 0;
		let length = buf[1] & 0x7F;
		let offset = 2;
		if (length === 126) {
			if (buf.length < 4) {
				return 0;
			}
			length = buf.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buf.length < 10) {
				return 0;
			}
			const big = buf.readBigUInt64BE(2);
			if (big > BigInt(this.maxMessageBytes)) {
				this.fail(1009, 'message too big');
				return 0;
			}
			length = Number(big);
			offset = 10;
		}
		if (!masked) {
			// RFC 6455 5.1: clients must mask every frame.
			this.fail(1002, 'unmasked frame');
			return 0;
		}
		if (buf.length < offset + 4 + length) {
			return 0;
		}
		const mask = buf.subarray(offset, offset + 4);
		const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
		for (let i = 0; i < payload.length; i++) {
			payload[i] ^= mask[i & 3];
		}
		this.onFrame(fin, op, payload);
		return offset + 4 + length;
	}

	private onFrame(fin: boolean, op: Op, payload: Buffer): void {
		switch (op) {
			case Op.Ping:
				this.writeFrame(Op.Pong, payload);
				return;
			case Op.Pong:
				this.missedPongs = 0;
				return;
			case Op.Close:
				if (!this.closeSent) {
					this.closeSent = true;
					this.writeFrame(Op.Close, payload.subarray(0, 2));
				}
				this.socket.end();
				return;
			case Op.Text:
			case Op.Binary:
			case Op.Continuation: {
				if (op !== Op.Continuation) {
					this.fragments = [];
					this.fragmentBytes = 0;
					this.fragmentOp = op;
				}
				this.fragments.push(payload);
				this.fragmentBytes += payload.length;
				if (this.fragmentBytes > this.maxMessageBytes) {
					this.fail(1009, 'message too big');
					return;
				}
				if (fin) {
					const message = Buffer.concat(this.fragments);
					const kind = this.fragmentOp;
					this.fragments = [];
					this.fragmentBytes = 0;
					this.fragmentOp = undefined;
					this.missedPongs = 0;
					if (kind === Op.Text) {
						this._onMessage.fire(message.toString('utf8'));
					}
				}
				return;
			}
			default:
				this.fail(1002, 'unknown opcode');
		}
	}

	private fail(code: number, reason: string): void {
		this.close(code, reason);
		this.finish();
	}

	private finish(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
		}
		this.socket.destroy();
		this._onClose.fire();
		this._onClose.dispose();
		this._onMessage.dispose();
	}
}
