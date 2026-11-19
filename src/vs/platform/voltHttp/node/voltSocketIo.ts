/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltHttpStreamMessage, IVoltHttpStreamSpec } from '../common/voltHttpStreams.js';
import { IVoltStreamConnection, VoltStreamEmit } from './voltStreamConnection.js';
import { toWebSocketUrl, VoltWebSocketClient } from './voltWebSocket.js';

/** Engine.IO packet types (the first character of a WebSocket text frame). */
const ENGINE_OPEN = '0';
const ENGINE_CLOSE = '1';
const ENGINE_PING = '2';
const ENGINE_PONG = '3';
const ENGINE_MESSAGE = '4';

/** Socket.IO packet types (the first character of an Engine.IO message). */
const PACKET_CONNECT = 0;
const PACKET_DISCONNECT = 1;
const PACKET_EVENT = 2;
const PACKET_ACK = 3;
const PACKET_CONNECT_ERROR = 4;
const PACKET_BINARY_EVENT = 5;
const PACKET_BINARY_ACK = 6;

interface ISocketIoPacket {
	readonly type: number;
	readonly attachments: number;
	readonly namespace: string;
	readonly ackId: number | undefined;
	/** The JSON after the header, unparsed; empty when there is none. */
	readonly json: string;
}

/** Splits `<type>[<attachments>-][<namespace>,][<ack id>][<json>]`. Undefined when it is not a packet. */
export function parseSocketIoPacket(text: string): ISocketIoPacket | undefined {
	const type = text.charCodeAt(0) - 48;
	if (!(type >= PACKET_CONNECT && type <= PACKET_BINARY_ACK)) {
		return undefined;
	}
	let index = 1;
	let attachments = 0;
	if (type === PACKET_BINARY_EVENT || type === PACKET_BINARY_ACK) {
		const dash = text.indexOf('-', index);
		if (dash === -1 || !/^\d+$/.test(text.slice(index, dash))) {
			return undefined;
		}
		attachments = Number(text.slice(index, dash));
		index = dash + 1;
	}
	let namespace = '/';
	if (text[index] === '/') {
		const comma = text.indexOf(',', index);
		if (comma === -1) {
			namespace = text.slice(index);
			index = text.length;
		} else {
			namespace = text.slice(index, comma);
			index = comma + 1;
		}
	}
	const digits = /^\d+/.exec(text.slice(index));
	let ackId: number | undefined;
	if (digits) {
		ackId = Number(digits[0]);
		index += digits[0].length;
	}
	return { type, attachments, namespace, ackId, json: text.slice(index) };
}

/** The event's arguments as JSON text: the argument itself when there is exactly one, else the list. */
function argumentsText(args: readonly unknown[]): string {
	return JSON.stringify(args.length === 1 ? args[0] : args) ?? 'null';
}

/**
 * A Socket.IO client: Engine.IO v4 on a WebSocket (no long-polling), one namespace per connection
 * (the URL's path). Binary attachments are not shown.
 */
export function openSocketIo(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
	const target = toWebSocketUrl(spec.url);
	const namespace = target.pathname.replace(/\/+$/, '') || '/';
	const prefix = namespace === '/' ? '' : `${namespace},`;

	let enginePath = (spec.socketio?.path || '/socket.io').trim();
	if (!enginePath.startsWith('/')) {
		enginePath = `/${enginePath}`;
	}
	enginePath = enginePath.replace(/\/+$/, '');
	const engineUrl = new URL(target.href);
	engineUrl.pathname = `${enginePath}/`;
	engineUrl.searchParams.set('EIO', '4');
	engineUrl.searchParams.set('transport', 'websocket');
	engineUrl.hash = '';

	let auth: string | undefined;
	if (spec.socketio?.auth?.trim()) {
		try {
			auth = JSON.stringify(JSON.parse(spec.socketio.auth));
		} catch {
			throw new Error('The Socket.IO auth payload is not valid JSON');
		}
	}

	let handshake: { status: number; headers: Record<string, string> } | undefined;
	let connected = false;
	let closed = false;
	let skippedBinaryFrames = 0;
	let pingDeadline: ReturnType<typeof setTimeout> | undefined;
	let pingWindow = 0;

	const fail = (message: string) => {
		if (closed) {
			return;
		}
		emit({ type: 'error', text: message });
		client.destroy();
	};

	const armPingDeadline = () => {
		clearTimeout(pingDeadline);
		if (pingWindow > 0) {
			pingDeadline = setTimeout(() => fail(`No ping from the server for ${pingWindow} ms: the connection is taken as lost`), pingWindow);
		}
	};

	const onSocketIoPacket = (text: string) => {
		const packet = parseSocketIoPacket(text);
		if (!packet) {
			emit({ type: 'info', text: `Unreadable Socket.IO packet: ${text.slice(0, 200)}` });
			return;
		}
		if (packet.namespace !== namespace) {
			return;
		}
		let payload: unknown;
		if (packet.json) {
			try {
				payload = JSON.parse(packet.json);
			} catch {
				emit({ type: 'info', text: `Unreadable Socket.IO packet: ${text.slice(0, 200)}` });
				return;
			}
		}
		switch (packet.type) {
			case PACKET_CONNECT: {
				const sid = typeof payload === 'object' && payload !== null ? (payload as { sid?: unknown }).sid : undefined;
				connected = true;
				emit({
					type: 'open',
					status: handshake?.status ?? 101,
					headers: handshake?.headers ?? {},
					text: `Connected to ${namespace}${typeof sid === 'string' ? ` (sid ${sid})` : ''}`
				});
				break;
			}
			case PACKET_CONNECT_ERROR: {
				const message = typeof payload === 'object' && payload !== null ? (payload as { message?: unknown }).message : payload;
				fail(`The server refused the connection to ${namespace}: ${typeof message === 'string' ? message : packet.json || 'no reason given'}`);
				break;
			}
			case PACKET_DISCONNECT:
				connected = false;
				emit({ type: 'info', text: `The server disconnected ${namespace}` });
				client.close();
				break;
			case PACKET_EVENT: {
				const list = Array.isArray(payload) ? payload : [payload];
				const name = typeof list[0] === 'string' ? list[0] : JSON.stringify(list[0]) ?? '';
				emit({
					type: 'message',
					target: name,
					data: argumentsText(list.slice(1)),
					...(packet.ackId !== undefined ? { text: `The server asks for acknowledgement ${packet.ackId} (not answered)` } : {}),
					size: Buffer.byteLength(text, 'utf8') + 1
				});
				break;
			}
			case PACKET_ACK: {
				const list = Array.isArray(payload) ? payload : [payload];
				emit({
					type: 'message',
					target: 'ack',
					data: argumentsText(list),
					...(packet.ackId !== undefined ? { text: `Acknowledgement ${packet.ackId}` } : {}),
					size: Buffer.byteLength(text, 'utf8') + 1
				});
				break;
			}
			case PACKET_BINARY_EVENT:
			case PACKET_BINARY_ACK: {
				skippedBinaryFrames += packet.attachments;
				const name = Array.isArray(payload) && typeof payload[0] === 'string' && packet.type === PACKET_BINARY_EVENT ? ` "${payload[0]}"` : '';
				emit({ type: 'info', text: `Binary ${packet.type === PACKET_BINARY_EVENT ? 'event' : 'acknowledgement'}${name} received: binary attachments are not shown` });
				break;
			}
		}
	};

	const client: VoltWebSocketClient = new VoltWebSocketClient({ url: engineUrl.href, headers: spec.headers }, {
		onOpen: (status, headers) => {
			handshake = { status, headers };
		},
		onMessage: (data, binary) => {
			if (binary) {
				if (skippedBinaryFrames > 0) {
					skippedBinaryFrames--;
				} else {
					emit({ type: 'info', text: 'Binary frame received: binary attachments are not shown' });
				}
				return;
			}
			const text = data.toString('utf8');
			const rest = text.slice(1);
			switch (text[0]) {
				case ENGINE_OPEN: {
					let sid = '';
					let pingInterval = 0;
					let pingTimeout = 0;
					try {
						const opened = JSON.parse(rest) as { sid?: unknown; pingInterval?: unknown; pingTimeout?: unknown };
						sid = typeof opened.sid === 'string' ? opened.sid : '';
						pingInterval = typeof opened.pingInterval === 'number' ? opened.pingInterval : 0;
						pingTimeout = typeof opened.pingTimeout === 'number' ? opened.pingTimeout : 0;
					} catch {
						// An open packet without readable settings: go on without a ping deadline.
					}
					pingWindow = pingInterval > 0 ? pingInterval + pingTimeout : 0;
					armPingDeadline();
					emit({ type: 'info', text: `Engine.IO session ${sid || '(no sid)'}${pingInterval ? `, ping every ${pingInterval} ms` : ''}` });
					client.send(`${ENGINE_MESSAGE}${PACKET_CONNECT}${prefix}${auth ?? ''}`, false);
					break;
				}
				case ENGINE_PING:
					armPingDeadline();
					if (client.isOpen) {
						client.send(`${ENGINE_PONG}${rest}`, false);
					}
					break;
				case ENGINE_CLOSE:
					client.close();
					break;
				case ENGINE_MESSAGE:
					onSocketIoPacket(rest);
					break;
			}
		},
		onError: (message, status, headers) => {
			emit({ type: 'error', text: message, ...(status !== undefined ? { status } : {}), ...(headers ? { headers } : {}) });
		},
		onClose: (code, reason) => {
			closed = true;
			connected = false;
			clearTimeout(pingDeadline);
			emit({ type: 'close', ...(code !== undefined ? { code } : {}), ...(reason ? { text: reason } : {}) });
		}
	});

	return {
		send(message: IVoltHttpStreamMessage): void {
			if (!connected) {
				throw new Error(closed ? 'The Socket.IO connection is closed' : `Not connected to ${namespace} yet`);
			}
			if (message.binary) {
				throw new Error('Socket.IO binary payloads are not supported');
			}
			const name = message.target || 'message';
			let args: unknown[];
			if (!message.data.trim()) {
				args = [];
			} else {
				args = [message.data];
			}
			try {
				const parsed: unknown = JSON.parse(message.data);
				args = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				// Not JSON: it goes out as one string argument (or as no argument when empty).
			}
			const frame = `${ENGINE_MESSAGE}${PACKET_EVENT}${prefix}${JSON.stringify([name, ...args])}`;
			client.send(frame, false, error => {
				if (!error) {
					emit({ type: 'sent', target: name, data: message.data, size: Buffer.byteLength(frame, 'utf8') });
				}
			});
		},
		close(): void {
			if (connected && client.isOpen) {
				connected = false;
				client.send(`${ENGINE_MESSAGE}${PACKET_DISCONNECT}${prefix}`, false);
			}
			client.close();
		}
	};
}
