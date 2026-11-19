/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import { IVoltHttpStreamMessage, IVoltHttpStreamSpec } from '../common/voltHttpStreams.js';
import { IVoltStreamConnection, VoltStreamEmit } from './voltStreamConnection.js';
import { requestHostname, VoltWebSocketClient } from './voltWebSocket.js';

/** MQTT control packet types (the high four bits of the first byte). */
const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const PUBREC = 5;
const PUBREL = 6;
const PUBCOMP = 7;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

const MAX_REMAINING_LENGTH = 268435455;
const DEFAULT_KEEP_ALIVE_SECONDS = 60;
/** How long the socket may take to end after DISCONNECT before it is dropped. */
const END_TIMEOUT_MS = 1000;

const CONNACK_REFUSALS: Record<number, string> = {
	1: 'unacceptable protocol version',
	2: 'client identifier rejected',
	3: 'server unavailable',
	4: 'bad user name or password',
	5: 'not authorized'
};

/** The MQTT remaining-length field: seven bits per byte, the high bit says another byte follows. */
export function encodeMqttRemainingLength(length: number): Buffer {
	if (length < 0 || length > MAX_REMAINING_LENGTH) {
		throw new Error('The MQTT packet is too large');
	}
	const bytes: number[] = [];
	do {
		let byte = length % 128;
		length = Math.floor(length / 128);
		if (length > 0) {
			byte |= 0x80;
		}
		bytes.push(byte);
	} while (length > 0);
	return Buffer.from(bytes);
}

function mqttPacket(firstByte: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([firstByte]), encodeMqttRemainingLength(body.length), body]);
}

function mqttString(value: string | Buffer): Buffer {
	const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
	if (bytes.length > 65535) {
		throw new Error('An MQTT string may be at most 65535 bytes');
	}
	const result = Buffer.allocUnsafe(2 + bytes.length);
	result.writeUInt16BE(bytes.length, 0);
	bytes.copy(result, 2);
	return result;
}

function uint16(value: number): Buffer {
	const result = Buffer.allocUnsafe(2);
	result.writeUInt16BE(value, 0);
	return result;
}

/** The byte stream MQTT runs on: a TCP or TLS socket, or binary WebSocket frames. */
interface IMqttTransport {
	write(data: Buffer, callback?: (error?: Error | null) => void): void;
	/** Ends after what was written has gone out. */
	end(): void;
	destroy(): void;
}

interface IMqttTransportHandlers {
	onReady(): void;
	onData(chunk: Buffer): void;
	/** Followed by `onClose`. */
	onError(message: string, status?: number, headers?: Record<string, string>): void;
	onClose(): void;
}

function socketTransport(socket: net.Socket, readyEvent: string, handlers: IMqttTransportHandlers): IMqttTransport {
	socket.setNoDelay(true);
	socket.once(readyEvent, () => handlers.onReady());
	socket.on('data', (chunk: Buffer) => handlers.onData(chunk));
	socket.on('error', (error: Error) => handlers.onError(error.message));
	socket.on('close', () => handlers.onClose());
	let endTimer: ReturnType<typeof setTimeout> | undefined;
	socket.once('close', () => clearTimeout(endTimer));
	return {
		write: (data, callback) => {
			socket.write(data, callback);
		},
		end: () => {
			socket.end();
			endTimer = setTimeout(() => socket.destroy(), END_TIMEOUT_MS);
		},
		destroy: () => socket.destroy()
	};
}

function webSocketTransport(spec: IVoltHttpStreamSpec, handlers: IMqttTransportHandlers): IMqttTransport {
	const client = new VoltWebSocketClient({ url: spec.url, headers: spec.headers, protocols: ['mqtt'] }, {
		onOpen: () => handlers.onReady(),
		onMessage: data => handlers.onData(data),
		onError: (message, status, headers) => handlers.onError(message, status, headers),
		onClose: () => handlers.onClose()
	});
	return {
		write: (data, callback) => {
			if (client.isOpen) {
				client.send(data, true, callback);
			} else {
				callback?.(new Error('The WebSocket is closed'));
			}
		},
		end: () => client.close(),
		destroy: () => client.destroy()
	};
}

function isValidUtf8(bytes: Buffer): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * An MQTT 3.1.1 client on TCP, TLS or WebSocket: clean session, the spec's subscriptions once
 * connected, inbound QoS 0/1/2, outbound QoS 0/1.
 */
export function openMqtt(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
	const url = new URL(spec.url);
	const scheme = url.protocol.slice(0, -1).toLowerCase();
	const options = spec.mqtt ?? {};
	const clientId = options.clientId || `volt-${randomBytes(4).toString('hex')}`;
	const username = options.username ?? (url.username ? decodeURIComponent(url.username) : undefined);
	const password = options.password ?? (url.password ? decodeURIComponent(url.password) : undefined);
	const keepAlive = Math.max(0, Math.min(65535, Math.floor(options.keepAliveSeconds ?? DEFAULT_KEEP_ALIVE_SECONDS)));
	const defaultQos = options.qos === 1 ? 1 : 0;

	let state: 'connecting' | 'connected' | 'closing' | 'closed' = 'connecting';
	let buffer: Buffer = Buffer.alloc(0);
	let lastPacketId = 0;
	let pingTimer: ReturnType<typeof setInterval> | undefined;
	const pendingSubscriptions = new Map<number, readonly string[]>();
	/** QoS 1 publishes the broker has not acknowledged yet, by packet id. */
	const pendingPublishes = new Map<number, string>();
	/** QoS 2 publishes received and shown, waiting for the broker's PUBREL. */
	const inboundExactlyOnce = new Set<number>();

	const nextPacketId = () => {
		lastPacketId = lastPacketId >= 65535 ? 1 : lastPacketId + 1;
		return lastPacketId;
	};

	const finish = () => {
		if (state === 'closed') {
			return;
		}
		state = 'closed';
		clearInterval(pingTimer);
		transport.destroy();
		emit({ type: 'close' });
	};

	const fail = (message: string, status?: number, headers?: Record<string, string>) => {
		if (state === 'closed') {
			return;
		}
		emit({ type: 'error', text: message, ...(status !== undefined ? { status } : {}), ...(headers ? { headers } : {}) });
		finish();
	};

	const onReady = () => {
		const flags = 0x02 | (username !== undefined ? 0x80 : 0) | (password !== undefined && username !== undefined ? 0x40 : 0);
		const parts = [mqttString('MQTT'), Buffer.from([4, flags]), uint16(keepAlive), mqttString(clientId)];
		if (username !== undefined) {
			parts.push(mqttString(username));
			if (password !== undefined) {
				parts.push(mqttString(password));
			}
		}
		transport.write(mqttPacket(CONNECT << 4, ...parts));
	};

	const onConnack = (body: Buffer) => {
		const returnCode = body[1];
		if (returnCode !== 0) {
			fail(`The broker refused the connection: ${CONNACK_REFUSALS[returnCode] ?? `return code ${returnCode}`}`);
			return;
		}
		state = 'connected';
		emit({ type: 'open', text: `Connected to ${url.host} as ${clientId}${body[0] & 1 ? ' (session present)' : ''}` });
		if (keepAlive > 0) {
			pingTimer = setInterval(() => transport.write(mqttPacket(PINGREQ << 4)), keepAlive * 500);
		}
		const filters = (options.subscribe ?? []).map(filter => filter.trim()).filter(filter => filter.length > 0);
		if (filters.length) {
			const id = nextPacketId();
			pendingSubscriptions.set(id, filters);
			const parts = [uint16(id)];
			for (const filter of filters) {
				parts.push(mqttString(filter), Buffer.from([defaultQos]));
			}
			transport.write(mqttPacket((SUBSCRIBE << 4) | 0x02, ...parts));
		}
	};

	const onPublish = (flags: number, body: Buffer) => {
		const qos = (flags >> 1) & 0x03;
		const retained = (flags & 0x01) !== 0;
		const topicLength = body.readUInt16BE(0);
		const topic = body.subarray(2, 2 + topicLength).toString('utf8');
		let offset = 2 + topicLength;
		let packetId = 0;
		if (qos > 0) {
			packetId = body.readUInt16BE(offset);
			offset += 2;
		}
		if (offset > body.length || qos === 3) {
			throw new RangeError('malformed PUBLISH');
		}
		const payload = body.subarray(offset);

		if (qos === 1) {
			transport.write(mqttPacket(PUBACK << 4, uint16(packetId)));
		} else if (qos === 2) {
			transport.write(mqttPacket(PUBREC << 4, uint16(packetId)));
			if (inboundExactlyOnce.has(packetId)) {
				// A re-delivery of one already shown.
				return;
			}
			inboundExactlyOnce.add(packetId);
		}

		const text = isValidUtf8(payload);
		const notes = [...(qos > 0 ? [`QoS ${qos}`] : []), ...(retained ? ['retained'] : [])];
		emit({
			type: 'message',
			target: topic,
			...(text !== undefined ? { data: text } : { data: payload.toString('base64'), binary: true }),
			...(notes.length ? { text: notes.join(', ') } : {}),
			size: payload.length
		});
	};

	const onPacket = (first: number, body: Buffer) => {
		const type = first >> 4;
		if (state === 'connecting' && type !== CONNACK) {
			fail('The server did not answer like an MQTT broker (no CONNACK)');
			return;
		}
		switch (type) {
			case CONNACK:
				if (body.length < 2) {
					throw new RangeError('malformed CONNACK');
				}
				if (state === 'connecting') {
					onConnack(body);
				}
				break;
			case PUBLISH:
				onPublish(first & 0x0f, body);
				break;
			case PUBACK: {
				const id = body.readUInt16BE(0);
				const topic = pendingPublishes.get(id);
				if (topic !== undefined) {
					pendingPublishes.delete(id);
					emit({ type: 'info', text: `The broker acknowledged the publish to ${topic} (packet ${id})` });
				}
				break;
			}
			case PUBREL: {
				const id = body.readUInt16BE(0);
				inboundExactlyOnce.delete(id);
				transport.write(mqttPacket(PUBCOMP << 4, uint16(id)));
				break;
			}
			case SUBACK: {
				const id = body.readUInt16BE(0);
				const filters = pendingSubscriptions.get(id) ?? [];
				pendingSubscriptions.delete(id);
				filters.forEach((filter, index) => {
					const granted = body[2 + index];
					if (granted === undefined || granted > 2) {
						emit({ type: 'info', text: `The broker refused the subscription to ${filter}` });
					} else {
						emit({ type: 'info', text: `Subscribed to ${filter} (QoS ${granted})` });
					}
				});
				break;
			}
			case PINGRESP:
			default:
				break;
		}
	};

	const onData = (chunk: Buffer) => {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
		while (state !== 'closed' && buffer.length >= 2) {
			let length = 0;
			let multiplier = 1;
			let index = 1;
			let complete = false;
			while (index < buffer.length && index <= 4) {
				const byte = buffer[index++];
				length += (byte & 0x7f) * multiplier;
				multiplier *= 128;
				if (!(byte & 0x80)) {
					complete = true;
					break;
				}
			}
			if (!complete) {
				if (index > 4) {
					fail('The server sent a malformed MQTT packet (remaining length)');
				}
				return;
			}
			if (buffer.length < index + length) {
				return;
			}
			const first = buffer[0];
			const body = buffer.subarray(index, index + length);
			buffer = buffer.subarray(index + length);
			try {
				onPacket(first, body);
			} catch {
				fail('The server sent a malformed MQTT packet');
			}
		}
	};

	const handlers: IMqttTransportHandlers = {
		onReady,
		onData,
		onError: (message, status, headers) => fail(message, status, headers),
		onClose: () => {
			if (state === 'connecting') {
				fail('The connection ended before the broker answered');
			} else {
				finish();
			}
		}
	};

	let transport: IMqttTransport;
	const host = requestHostname(url);
	switch (scheme) {
		case 'mqtt':
		case 'tcp':
			transport = socketTransport(net.connect({ host, port: Number(url.port) || 1883 }), 'connect', handlers);
			break;
		case 'mqtts':
		case 'ssl':
		case 'tls':
			transport = socketTransport(tls.connect({ host, port: Number(url.port) || 8883, ...(net.isIP(host) ? {} : { servername: host }) }), 'secureConnect', handlers);
			break;
		case 'ws':
		case 'wss':
			transport = webSocketTransport(spec, handlers);
			break;
		default:
			throw new Error(`Not an MQTT URL: ${spec.url} (expected mqtt://, mqtts://, tcp://, ssl://, ws:// or wss://)`);
	}

	return {
		send(message: IVoltHttpStreamMessage): void {
			if (state !== 'connected') {
				throw new Error(state === 'connecting' ? 'Not connected to the broker yet' : 'The MQTT connection is closed');
			}
			const topic = message.target;
			if (!topic) {
				throw new Error('A topic is required to publish');
			}
			if (/[#+]/.test(topic)) {
				throw new Error('A topic to publish to cannot contain the wildcards # or +');
			}
			const qos = (message.qos ?? defaultQos) === 1 ? 1 : 0;
			const payload = message.binary ? Buffer.from(message.data, 'base64') : Buffer.from(message.data, 'utf8');
			const parts = [mqttString(topic)];
			let id = 0;
			if (qos === 1) {
				id = nextPacketId();
				parts.push(uint16(id));
			}
			parts.push(payload);
			const packet = mqttPacket((PUBLISH << 4) | (qos << 1) | (message.retain ? 0x01 : 0), ...parts);
			if (qos === 1) {
				pendingPublishes.set(id, topic);
			}
			const notes = [...(qos > 0 ? [`QoS ${qos}`] : []), ...(message.retain ? ['retained'] : [])];
			transport.write(packet, error => {
				if (!error) {
					emit({
						type: 'sent',
						target: topic,
						data: message.data,
						...(message.binary ? { binary: true } : {}),
						...(notes.length ? { text: notes.join(', ') } : {}),
						size: payload.length
					});
				}
			});
		},
		close(): void {
			if (state === 'connected') {
				state = 'closing';
				clearInterval(pingTimer);
				transport.write(mqttPacket(DISCONNECT << 4));
				transport.end();
			} else if (state === 'connecting') {
				finish();
			}
		}
	};
}
