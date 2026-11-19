/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { IVoltHttpStreamSpec } from '../common/voltHttpStreams.js';
import { IVoltStreamConnection, VoltStreamEmit } from './voltStreamConnection.js';
import { flattenHeaders, requestHostname } from './voltWebSocket.js';

const MAX_REDIRECTS = 5;
/** How much of a response that is not an event stream is shown. */
const MAX_PLAIN_BODY_BYTES = 256 * 1024;

/** One parsed server-sent event. */
export interface IVoltSseEvent {
	/** The `event:` name; empty for the default (`message`). */
	readonly event: string;
	readonly data: string;
	/** The `id:` this event carried, if it carried one. */
	readonly id: string | undefined;
}

/**
 * The WHATWG event stream parser, fed with bytes as they arrive: lines end with CRLF, LF or CR, a
 * multi-byte character may be split across chunks, `data:` lines are joined with a line feed, lines
 * starting with a colon are comments, and an empty line dispatches the event.
 */
export class VoltSseParser {

	private readonly decoder = new TextDecoder('utf-8');
	private line = '';
	/** The previous chunk ended with CR: a line feed right after it belongs to the same line ending. */
	private skipLineFeed = false;
	private started = false;

	private data: string[] = [];
	private event = '';
	private id: string | undefined;

	constructor(
		private readonly onEvent: (event: IVoltSseEvent) => void,
		private readonly onRetry: (milliseconds: number) => void
	) { }

	push(chunk: Uint8Array): void {
		let text = this.decoder.decode(chunk, { stream: true });
		if (!this.started && text.length) {
			this.started = true;
			if (text.charCodeAt(0) === 0xFEFF) {
				text = text.slice(1);
			}
		}
		let start = 0;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (this.skipLineFeed) {
				this.skipLineFeed = false;
				if (code === 10) {
					start = i + 1;
					continue;
				}
			}
			if (code === 10 || code === 13) {
				this.onLine(this.line + text.slice(start, i));
				this.line = '';
				start = i + 1;
				this.skipLineFeed = code === 13;
			}
		}
		this.line += text.slice(start);
	}

	private onLine(line: string): void {
		if (line === '') {
			this.dispatch();
			return;
		}
		if (line.startsWith(':')) {
			return;
		}
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) {
			value = value.slice(1);
		}
		switch (field) {
			case 'data':
				this.data.push(value);
				break;
			case 'event':
				this.event = value;
				break;
			case 'id':
				if (!value.includes('\u0000')) {
					this.id = value;
				}
				break;
			case 'retry':
				if (/^\d+$/.test(value)) {
					this.onRetry(Number(value));
				}
				break;
		}
	}

	private dispatch(): void {
		const data = this.data;
		const event = this.event;
		const id = this.id;
		this.data = [];
		this.event = '';
		this.id = undefined;
		if (data.length) {
			this.onEvent({ event, data: data.join('\n'), id });
		}
	}
}

/**
 * A server-sent event stream. Whatever comes back is shown: an event stream event by event, any
 * other answer (an error page, JSON) as one message. It never reconnects by itself.
 */
export function openSse(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
	let done = false;
	let request: http.ClientRequest | undefined;

	const finish = (error?: string) => {
		if (done) {
			return;
		}
		done = true;
		request?.destroy();
		if (error !== undefined) {
			emit({ type: 'error', text: error });
		}
		emit({ type: 'close' });
	};

	const start = (url: URL, method: string, body: string | undefined, headers: Record<string, string>, redirectsLeft: number) => {
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error(`Not an HTTP URL: ${url.href} (expected http:// or https://)`);
		}
		const secure = url.protocol === 'https:';
		const sent: Record<string, string> = { ...headers };
		const names = new Set(Object.keys(sent).map(name => name.toLowerCase()));
		if (!names.has('accept')) {
			sent['Accept'] = 'text/event-stream';
		}
		if (!names.has('cache-control')) {
			sent['Cache-Control'] = 'no-cache';
		}
		if (body !== undefined && !names.has('content-length') && !names.has('transfer-encoding')) {
			sent['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
		}

		const current = (secure ? https : http).request({
			protocol: url.protocol,
			hostname: requestHostname(url),
			port: url.port || (secure ? 443 : 80),
			path: url.pathname + url.search,
			method,
			headers: sent,
			agent: false,
			...(url.username ? { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` } : {})
		});
		request = current;
		current.on('error', error => {
			if (request === current) {
				finish(error.message);
			}
		});
		current.on('response', response => {
			if (done) {
				response.destroy();
				return;
			}
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (location && (status === 301 || status === 302 || status === 303 || status === 307 || status === 308)) {
				response.resume();
				if (redirectsLeft <= 0) {
					finish(`Stopped after ${MAX_REDIRECTS} redirects (the last one pointed to ${location})`);
					return;
				}
				let next: URL;
				try {
					next = new URL(location, url);
				} catch {
					finish(`The server redirected to an invalid location: ${location}`);
					return;
				}
				// As a browser does: 303 always becomes GET, 301/302 turn a POST into a GET.
				const toGet = status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === 'POST');
				const nextHeaders: Record<string, string> = {};
				for (const [name, value] of Object.entries(headers)) {
					const lower = name.toLowerCase();
					if (lower === 'host' || (toGet && (lower === 'content-type' || lower === 'content-length'))) {
						continue;
					}
					// Credentials stay with the origin they were given for.
					if (next.origin !== url.origin && (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization')) {
						continue;
					}
					nextHeaders[name] = value;
				}
				emit({ type: 'info', text: `Redirected (${status}) to ${next.href}` });
				try {
					start(next, toGet ? 'GET' : method, toGet ? undefined : body, nextHeaders, redirectsLeft - 1);
				} catch (error) {
					finish(error instanceof Error ? error.message : String(error));
				}
				current.destroy();
				return;
			}

			const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
			const isEventStream = status >= 200 && status < 300 && contentType.includes('text/event-stream');
			emit({
				type: 'open',
				status,
				headers: flattenHeaders(response.headers),
				text: isEventStream ? `Event stream from ${url.host}` : `${status}${response.statusMessage ? ` ${response.statusMessage}` : ''} from ${url.host}, not an event stream`
			});

			let flush: (() => void) | undefined;
			if (isEventStream) {
				const parser = new VoltSseParser(
					event => {
						emit({
							type: 'message',
							...(event.event && event.event !== 'message' ? { target: event.event } : {}),
							data: event.data,
							...(event.id !== undefined && event.id !== '' ? { text: event.id } : {}),
							size: Buffer.byteLength(event.data, 'utf8')
						});
					},
					milliseconds => emit({ type: 'info', text: `The server asks clients to reconnect after ${milliseconds} ms (Volt does not reconnect by itself)` })
				);
				response.on('data', (chunk: Buffer) => {
					if (!done) {
						parser.push(chunk);
					}
				});
			} else {
				const parts: Buffer[] = [];
				let size = 0;
				let reported = false;
				const report = () => {
					if (reported || done) {
						return;
					}
					reported = true;
					const whole = Buffer.concat(parts);
					if (whole.length) {
						emit({ type: 'message', data: whole.subarray(0, MAX_PLAIN_BODY_BYTES).toString('utf8'), size });
					}
					if (size > MAX_PLAIN_BODY_BYTES) {
						emit({ type: 'info', text: 'The response is longer than 256 KB; only its start is shown' });
					}
				};
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (!reported) {
						parts.push(chunk);
						if (size > MAX_PLAIN_BODY_BYTES) {
							report();
							finish();
						}
					}
				});
				flush = report;
			}
			response.on('error', (error: Error) => finish(error.message));
			response.on('end', () => {
				flush?.();
				finish();
			});
			response.on('close', () => {
				flush?.();
				finish();
			});
		});
		current.end(body);
	};

	start(new URL(spec.url), spec.method || 'GET', spec.body, { ...spec.headers }, MAX_REDIRECTS);

	return {
		send(): void {
			throw new Error('A server-sent event stream is one-way: nothing can be sent on it');
		},
		close(): void {
			finish();
		}
	};
}
