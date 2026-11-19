/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants as cryptoConstants } from 'crypto';
import * as http from 'http';
// Node's own HTTP/2: a request pinned to it (or one that sets TLS options) cannot go through Chromium's stack.
// eslint-disable-next-line local/code-import-patterns
import * as http2 from 'http2';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { bufferToStream, VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { IHeaders, IRequestContext } from '../../../base/parts/request/common/request.js';
import { IVoltHttpNodeOptions, IVoltHttpRequestOptions, VOLT_HTTP_VERSION_HEADER, VoltHttpTlsProtocol } from '../common/voltHttpTransport.js';

/**
 * The HTTP client's requests that set TLS or protocol options, sent with Node's `http`, `tls` and
 * `http2`: Electron's `net.request` takes none of them per request. One connection per request, no
 * proxy, no redirect followed (the client follows hop by hop), the body read whole.
 */

const TLS_VERSIONS: readonly { readonly setting: VoltHttpTlsProtocol; readonly version: tls.SecureVersion; readonly off: number; readonly modern: boolean }[] = [
	{ setting: 'TLSv1', version: 'TLSv1', off: cryptoConstants.SSL_OP_NO_TLSv1, modern: false },
	{ setting: 'TLSv1_1', version: 'TLSv1.1', off: cryptoConstants.SSL_OP_NO_TLSv1_1, modern: false },
	{ setting: 'TLSv1_2', version: 'TLSv1.2', off: cryptoConstants.SSL_OP_NO_TLSv1_2, modern: true },
	{ setting: 'TLSv1_3', version: 'TLSv1.3', off: cryptoConstants.SSL_OP_NO_TLSv1_3, modern: true },
];

export interface IVoltHttpTlsOptions {
	rejectUnauthorized: boolean;
	minVersion?: tls.SecureVersion;
	maxVersion?: tls.SecureVersion;
	secureOptions?: number;
	ciphers?: string;
	honorCipherOrder?: boolean;
}

/**
 * A request's TLS settings as Node's. Disabling protocol versions narrows the range Node offers by
 * default (TLS 1.2 and 1.3); TLS 1.0 and 1.1 are offered only when both of those are disabled.
 * Throws when every version is disabled.
 */
export function voltHttpTlsOptions(options: IVoltHttpNodeOptions): IVoltHttpTlsOptions {
	const out: IVoltHttpTlsOptions = { rejectUnauthorized: options.rejectUnauthorized !== false };
	const disabled = new Set(options.disabledProtocols ?? []);
	if (disabled.size) {
		const enabled = TLS_VERSIONS.filter(item => !disabled.has(item.setting));
		if (!enabled.length) {
			throw new Error('Every TLS version is disabled in the request\'s settings.');
		}
		const range = enabled.some(item => item.modern) ? enabled.filter(item => item.modern) : enabled;
		out.minVersion = range[0].version;
		out.maxVersion = range[range.length - 1].version;
		out.secureOptions = TLS_VERSIONS.filter(item => disabled.has(item.setting)).reduce((bits, item) => bits | item.off, 0);
	}
	const ciphers = (options.ciphers ?? []).map(cipher => cipher.trim()).filter(Boolean);
	if (ciphers.length) {
		out.ciphers = ciphers.join(':');
	}
	if (options.honorCipherOrder) {
		out.honorCipherOrder = true;
	}
	return out;
}

/** Headers HTTP/2 has no place for: the connection is the session's. */
const CONNECTION_HEADERS = new Set(['connection', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

interface IRawResponse {
	readonly statusCode: number;
	readonly headers: IHeaders;
	readonly body: Buffer;
	readonly httpVersion: string;
}

function decoded(body: Buffer, encoding: string | string[] | undefined): Buffer {
	try {
		switch (String(encoding ?? '').trim().toLowerCase()) {
			case 'gzip': case 'x-gzip': return zlib.gunzipSync(body);
			case 'deflate': return zlib.inflateSync(body);
			case 'br': return zlib.brotliDecompressSync(body);
		}
	} catch { /* not what it says it is: the bytes as they came */ }
	return body;
}

function connectTls(host: string, port: number, options: tls.ConnectionOptions): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), ...options });
		socket.once('secureConnect', () => {
			socket.removeListener('error', reject);
			resolve(socket);
		});
		socket.once('error', reject);
	});
}

/** Sends `options` (which has `node`) and resolves with the whole response; the version it went over rides in the headers. */
export async function voltHttpNodeRequest(options: IVoltHttpRequestOptions, token: CancellationToken): Promise<IRequestContext> {
	const node = options.node ?? {};
	const target = new URL(options.url ?? '');
	if (target.protocol !== 'http:' && target.protocol !== 'https:') {
		throw new Error(`Cannot send to a ${target.protocol.replace(/:$/, '')} URL.`);
	}
	const secure = target.protocol === 'https:';
	const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
	const port = target.port ? Number(target.port) : secure ? 443 : 80;
	// The path as it was written (the client encodes it, or not, as the request's settings say).
	const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^#]*)/i.exec(options.url ?? '')?.[1] || '/';
	const method = (options.type ?? 'GET').toUpperCase();
	const body = options.dataBase64 !== undefined ? Buffer.from(options.dataBase64, 'base64') : typeof options.data === 'string' && options.data ? Buffer.from(options.data) : undefined;
	const headers: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(options.headers ?? {})) {
		if (value !== undefined) {
			headers[key] = value;
		}
	}

	const closers: (() => void)[] = [];
	const run = async (): Promise<IRawResponse> => {
		let socket: tls.TLSSocket | undefined;
		let h2 = node.httpVersion === 'http2';
		if (secure) {
			const alpn = node.httpVersion === 'http2' ? ['h2'] : node.httpVersion === 'http1' ? ['http/1.1'] : ['h2', 'http/1.1'];
			try {
				socket = await connectTls(host, port, { ...voltHttpTlsOptions(node), ALPNProtocols: alpn });
			} catch (err) {
				// A server that speaks ALPN refuses a handshake that offers only a protocol it does not have.
				if (node.httpVersion && (err as { code?: unknown }).code === 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL') {
					throw new Error(node.httpVersion === 'http2' ? 'The server does not offer HTTP/2, which the request\'s settings ask for.' : 'The server does not offer HTTP/1.1, which the request\'s settings ask for.');
				}
				throw err;
			}
			const connected = socket;
			closers.push(() => connected.destroy());
			if (node.httpVersion === 'http2' && socket.alpnProtocol !== 'h2') {
				throw new Error('The server does not offer HTTP/2, which the request\'s settings ask for.');
			}
			h2 = socket.alpnProtocol === 'h2';
		}
		return h2 ? overHttp2(socket) : overHttp1(socket);
	};

	const overHttp1 = (socket: tls.TLSSocket | undefined) => new Promise<IRawResponse>((resolve, reject) => {
		const request = http.request({
			host, port, path, method, headers,
			// One connection per request: a kept socket would carry the last request's TLS settings to the next.
			...(socket ? { createConnection: () => socket } : { agent: false }),
			insecureHTTPParser: !!node.insecureHTTPParser,
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('error', reject);
			response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), httpVersion: response.httpVersion }));
		});
		closers.push(() => request.destroy());
		request.on('error', reject);
		request.end(body);
	});

	const overHttp2 = (socket: tls.TLSSocket | undefined) => new Promise<IRawResponse>((resolve, reject) => {
		const session = http2.connect(`${target.protocol}//${target.host}`, socket ? { createConnection: () => socket } : {});
		closers.push(() => session.destroy());
		session.on('error', reject);
		const sent: http2.OutgoingHttpHeaders = { ':method': method, ':path': path, ':scheme': secure ? 'https' : 'http', ':authority': target.host };
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === 'host') {
				sent[':authority'] = String(value);
			} else if (!CONNECTION_HEADERS.has(key.toLowerCase())) {
				sent[key.toLowerCase()] = value;
			}
		}
		const stream = session.request(sent, { endStream: !body });
		let statusCode = 0;
		const responseHeaders: IHeaders = {};
		stream.on('response', received => {
			statusCode = Number(received[':status'] ?? 0);
			for (const [key, value] of Object.entries(received)) {
				if (!key.startsWith(':') && value !== undefined) {
					responseHeaders[key] = value;
				}
			}
		});
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => {
			session.close();
			resolve({ statusCode, headers: responseHeaders, body: Buffer.concat(chunks), httpVersion: '2' });
		});
		if (body) {
			stream.end(body);
		}
	});

	const close = () => closers.forEach(closer => closer());
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled: IDisposable | undefined;
	const exchange = run();
	try {
		const raw = await Promise.race([
			exchange,
			new Promise<never>((_resolve, reject) => {
				if (options.timeout) {
					timer = setTimeout(() => reject(new Error(`Request timeout after ${options.timeout}ms`)), options.timeout);
				}
				if (token.isCancellationRequested) {
					reject(new CancellationError());
				}
				cancelled = token.onCancellationRequested(() => reject(new CancellationError()));
			}),
		]);
		const { 'content-encoding': encoding, ...rest } = raw.headers;
		const text = decoded(raw.body, encoding);
		return {
			res: { statusCode: raw.statusCode, headers: { ...(text === raw.body ? raw.headers : rest), [VOLT_HTTP_VERSION_HEADER]: raw.httpVersion.replace(/\.0$/, '') } },
			stream: bufferToStream(VSBuffer.wrap(text)),
		};
	} catch (err) {
		close();
		// A failure of the race's loser (the socket closed after a timeout) has nowhere to go.
		exchange.catch(() => undefined);
		throw err;
	} finally {
		clearTimeout(timer);
		cancelled?.dispose();
	}
}
