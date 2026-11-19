/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as perfHooks from 'perf_hooks';
import * as tls from 'tls';
import { Worker } from 'worker_threads';
import { IVoltLoadHistogramData, IVoltLoadPlan, IVoltLoadProgress, IVoltLoadResult, IVoltLoadSample, IVoltLoadSpec, IVoltLoadTargetResult, planVoltLoad, VoltLoadErrorKind } from '../common/voltHttpLoad.js';

export interface IVoltLoadHooks {
	onSample(sample: IVoltLoadSample): void;
	/** Called exactly once, when the run's time or request count is reached or it was stopped. */
	onDone(result: IVoltLoadResult): void;
}

export interface IVoltLoadHandle {
	/** Ends the run now; `onDone` gets what was measured so far. */
	stop(): void;
}

/**
 * The load generator. ONE self-contained function: it runs in a worker thread made from its own
 * source text (`voltLoadWorkerSource`), so nothing in it may refer to an import or to anything else
 * at module scope. Node's modules come through `nodeRequire`. The histogram's bucket layout is the
 * one of `voltLoadBucketIndex` (common/voltHttpLoad.ts) written out again; a test holds them together.
 *
 * Everything is driven by I/O callbacks and timers, so run inline (no worker) it still yields to
 * the event loop between requests.
 */
export function voltLoadEngine(plan: IVoltLoadPlan, hooks: IVoltLoadHooks, nodeRequire: (name: string) => unknown): IVoltLoadHandle {
	const http = nodeRequire('http') as typeof import('http');
	const https = nodeRequire('https') as typeof import('https');
	const net = nodeRequire('net') as typeof import('net');
	const tls = nodeRequire('tls') as typeof import('tls');
	const crypto = nodeRequire('crypto') as typeof import('crypto');
	const perf = (nodeRequire('perf_hooks') as typeof import('perf_hooks')).performance;
	const now = () => perf.now();

	// --- Hard limits, whatever the plan says -----------------------------------------------------
	const MAX_USERS = 2000;
	const MAX_MS = 30 * 60 * 1000;
	const MAX_BODY = 5 * 1024 * 1024;
	const MAX_OPENS_PER_STEP = 200;
	const RETRY_MS = 1000;

	const mode = plan.mode === 'ws' || plan.mode === 'sse' ? plan.mode : 'http';
	const maxUsers = Math.min(MAX_USERS, Math.max(1, Math.floor(plan.users) || 1));
	const warmupMs = Math.max(0, plan.warmupSec || 0) * 1000;
	const totalMs = Math.min(MAX_MS, warmupMs + Math.max(1, plan.durationSec || 10) * 1000);
	const maxRequests = mode === 'http' && plan.requests && plan.requests > 0 ? Math.floor(plan.requests) : 0;
	const timeoutMs = Math.max(50, plan.timeoutMs || 10000);
	const thinkMs = Math.max(0, plan.thinkMs || 0);
	const stepMs = Math.max(50, plan.stepMs || 250);
	const steps = plan.steps && plan.steps.length ? plan.steps : [maxUsers];
	const rpsGap = mode === 'http' && plan.rps && plan.rps > 0 ? 1000 / plan.rps : 0;
	const sequence = plan.order === 'sequence';

	// --- Histogram -------------------------------------------------------------------------------
	const BITS = 6;
	const SUB = 64;
	const MAX_EXPONENT = 26;
	const BUCKETS = SUB + (MAX_EXPONENT - BITS) * SUB;
	const TOP = 2 ** MAX_EXPONENT;
	interface IHist { c: Uint32Array; n: number; min: number; max: number; sum: number; sumSq: number }
	const newHist = (): IHist => ({ c: new Uint32Array(BUCKETS), n: 0, min: Infinity, max: 0, sum: 0, sumSq: 0 });
	const bucketOf = (ms: number): number => {
		const value = Math.round(ms * 1000);
		if (value < SUB) {
			return value < 0 ? 0 : value;
		}
		if (value >= TOP) {
			return BUCKETS - 1;
		}
		const exponent = 31 - Math.clz32(value);
		return SUB + (exponent - BITS) * SUB + ((value >>> (exponent - BITS)) - SUB);
	};
	const record = (hist: IHist, raw: number): void => {
		const ms = raw > 0 ? raw : 0;
		hist.c[bucketOf(ms)]++;
		hist.n++;
		hist.sum += ms;
		hist.sumSq += ms * ms;
		if (ms < hist.min) {
			hist.min = ms;
		}
		if (ms > hist.max) {
			hist.max = ms;
		}
	};
	const valueOf = (index: number): number => {
		if (index < SUB) {
			return index / 1000;
		}
		const width = 2 ** Math.floor((index - SUB) / SUB);
		const low = (SUB + ((index - SUB) % SUB)) * width;
		return (width === 1 ? low : low + width / 2) / 1000;
	};
	const percentile = (hist: IHist, percent: number): number => {
		if (!hist.n) {
			return 0;
		}
		const rank = Math.max(1, Math.ceil(hist.n * percent / 100));
		let seen = 0;
		for (let index = 0; index < BUCKETS; index++) {
			seen += hist.c[index];
			if (seen >= rank) {
				return Math.min(hist.max, Math.max(hist.min, valueOf(index)));
			}
		}
		return hist.max;
	};
	const pack = (hist: IHist): IVoltLoadHistogramData => {
		const b: number[] = [];
		for (let index = 0; index < BUCKETS; index++) {
			if (hist.c[index]) {
				b.push(index, hist.c[index]);
			}
		}
		return { n: hist.n, min: hist.n ? hist.min : 0, max: hist.max, sum: hist.sum, sumSq: hist.sumSq, b };
	};
	const clear = (hist: IHist): void => {
		hist.c.fill(0);
		hist.n = 0;
		hist.min = Infinity;
		hist.max = 0;
		hist.sum = 0;
		hist.sumSq = 0;
	};

	// --- Dynamic tokens --------------------------------------------------------------------------
	const TOKEN = /\{\{\s*\$(guid|timestamp|isoTimestamp|randomInt|vu|iteration)(?:\s+(-?\d+))?(?:\s+(-?\d+))?\s*\}\}/g;
	const hasToken = (text: string | undefined): boolean => !!text && /\{\{\s*\$/.test(text);
	const fill = (text: string, vu: number, iteration: number): string => text.replace(TOKEN, (_whole: string, name: string, a: string | undefined, b: string | undefined) => {
		switch (name) {
			case 'guid': return crypto.randomUUID();
			case 'timestamp': return String(Math.floor(Date.now() / 1000));
			case 'isoTimestamp': return new Date().toISOString();
			case 'randomInt': {
				const min = a !== undefined ? Number(a) : 0;
				const max = b !== undefined ? Number(b) : 1000;
				return String(Math.floor(min + Math.random() * (max - min)));
			}
			case 'vu': return String(vu + 1);
			default: return String(iteration + 1);
		}
	});

	// --- Targets ---------------------------------------------------------------------------------
	interface ITarget {
		readonly name: string;
		readonly method: string;
		readonly rawUrl: string;
		readonly url: URL | undefined;
		readonly dynamicUrl: boolean;
		readonly headers: Record<string, string>;
		readonly dynamicHeaders: boolean;
		readonly rawBody: string | undefined;
		readonly body: Buffer | undefined;
		readonly dynamicBody: boolean;
		readonly upTo: number;
		readonly hist: IHist;
		readonly codes: Record<string, number>;
		count: number;
		errors: number;
		bytesIn: number;
	}
	const parseUrl = (text: string): URL | undefined => {
		try {
			return new URL(text);
		} catch {
			return undefined;
		}
	};
	let weightSum = 0;
	const targets: ITarget[] = (plan.targets || []).map(target => {
		const headers: Record<string, string> = {};
		let dynamicHeaders = false;
		for (const [key, value] of target.headers || []) {
			headers[key] = value;
			dynamicHeaders = dynamicHeaders || hasToken(value);
		}
		const rawBody = target.body !== undefined && target.body !== '' && target.method !== 'GET' && target.method !== 'HEAD' ? target.body : undefined;
		let body = rawBody !== undefined ? Buffer.from(rawBody, 'utf8') : undefined;
		if (body && body.length > MAX_BODY) {
			body = body.subarray(0, MAX_BODY);
		}
		const dynamicUrl = hasToken(target.url);
		weightSum += Math.max(0, target.weight === undefined ? 1 : target.weight);
		return {
			name: target.name, method: target.method || 'GET', rawUrl: target.url, url: dynamicUrl ? undefined : parseUrl(target.url), dynamicUrl,
			headers, dynamicHeaders, rawBody, body, dynamicBody: hasToken(rawBody), upTo: weightSum,
			hist: newHist(), codes: {}, count: 0, errors: 0, bytesIn: 0,
		};
	});
	const pickTarget = (iteration: number): ITarget => {
		if (targets.length === 1) {
			return targets[0];
		}
		if (sequence || weightSum <= 0) {
			return targets[iteration % targets.length];
		}
		const at = Math.random() * weightSum;
		for (const target of targets) {
			if (at < target.upTo) {
				return target;
			}
		}
		return targets[targets.length - 1];
	};

	// --- State -----------------------------------------------------------------------------------
	const startedAt = Date.now();
	const t0 = now();
	let finished = false;
	let wanted = 0;
	let active = 0;
	let peakUsers = 0;
	let measuredStarted = 0;
	let measuredDone = 0;
	const totals = { count: 0, errors: 0, httpErrors: 0, bytesIn: 0, bytesOut: 0, sent: 0, connects: 0, connectFailures: 0, closes: 0, reconnects: 0 };
	const latency = newHist();
	const connectHist = newHist();
	const dnsHist = newHist();
	const tcpHist = newHist();
	const tlsHist = newHist();
	const ttfbHist = newHist();
	const downloadHist = newHist();
	const codes: Record<string, number> = {};
	const kinds: Partial<Record<VoltLoadErrorKind, number>> = {};
	const second = { hist: newHist(), count: 0, errors: 0, bytesIn: 0, bytesOut: 0, sent: 0 };
	const series: IVoltLoadSample[] = [];
	let secondsOut = 0;

	const kindOf = (error: unknown, timedOut: boolean): VoltLoadErrorKind => {
		if (timedOut) {
			return 'timeout';
		}
		const code = String((error as { code?: unknown } | undefined)?.code ?? '');
		const message = String((error as { message?: unknown } | undefined)?.message ?? '');
		if (code === 'ECONNREFUSED') {
			return 'refused';
		}
		if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
			return 'timeout';
		}
		if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || /socket hang up|aborted/i.test(message)) {
			return 'reset';
		}
		if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
			return 'dns';
		}
		if (/^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/.test(code) || /certificate|\bssl\b|\btls\b/i.test(message)) {
			return 'tls';
		}
		return 'other';
	};
	const countKind = (kind: VoltLoadErrorKind): void => {
		kinds[kind] = (kinds[kind] || 0) + 1;
	};
	const countCode = (into: Record<string, number>, status: number): void => {
		const key = String(status);
		into[key] = (into[key] || 0) + 1;
	};
	const measuring = (at: number): boolean => at - t0 >= warmupMs;

	interface IUser {
		readonly id: number;
		running: boolean;
		iteration: number;
		timer: ReturnType<typeof setTimeout> | undefined;
		/** A connection test's way to close this user's connection (the run ended, or the profile went down). */
		close: (() => void) | undefined;
	}
	const users: IUser[] = [];
	const cleanups = new Set<() => void>();

	// --- HTTP ------------------------------------------------------------------------------------
	const agentOptions = { keepAlive: true, maxSockets: maxUsers, maxFreeSockets: maxUsers };
	const httpAgent = mode === 'http' ? new http.Agent(agentOptions) : undefined;
	const httpsAgent = mode === 'http' ? new https.Agent({ ...agentOptions, rejectUnauthorized: !plan.insecure }) : undefined;
	let nextSlot = t0;

	const park = (user: IUser): void => {
		if (user.running) {
			user.running = false;
			active--;
		}
	};

	const schedule = (user: IUser, wait: number): void => {
		let delay = wait;
		if (rpsGap) {
			const at = now();
			const ready = at + delay;
			// Each send takes the next slot of the global schedule. A send that is late (a slow
			// answer, a late timer) still takes its slot, so the rate catches up; but the schedule
			// never lags more than 100 ms, so a long stall is not made up for with a burst.
			const slot = Math.max(nextSlot, ready - 100);
			nextSlot = slot + rpsGap;
			delay = Math.max(ready, slot) - at;
		}
		if (delay >= 1) {
			user.timer = setTimeout(() => go(user), delay);
		} else {
			setImmediate(() => go(user));
		}
	};

	const go = (user: IUser): void => {
		user.timer = undefined;
		if (finished) {
			return;
		}
		if (user.id >= wanted || (maxRequests && measuredStarted >= maxRequests)) {
			park(user);
			return;
		}
		sendOne(user);
	};

	const sendOne = (user: IUser): void => {
		const iteration = user.iteration++;
		const target = pickTarget(iteration);
		const begun = now();
		const measured = measuring(begun);
		if (measured) {
			measuredStarted++;
		}
		let done = false;
		let timedOut = false;
		let socket: import('net').Socket | undefined;
		let written0 = 0;
		let read0 = 0;
		let bodyIn = 0;
		let tDns = -1;
		let tTcp = -1;
		let tTls = -1;
		let tFirst = -1;
		// Not const: `finish` (above the one assignment) can run before it, and must see undefined, not a TDZ error.
		// eslint-disable-next-line prefer-const
		let timer: ReturnType<typeof setTimeout> | undefined;
		let request: import('http').ClientRequest | undefined;

		const body = target.dynamicBody && target.rawBody !== undefined ? Buffer.from(fill(target.rawBody, user.id, iteration), 'utf8') : target.body;

		const finish = (status: number, error: unknown): void => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			if (request) {
				cleanups.delete(abort);
			}
			if (finished) {
				return;
			}
			const end = now();
			const ms = end - begun;
			const bytesIn = socket ? Math.max(bodyIn, (socket.bytesRead || 0) - read0) : bodyIn;
			const bytesOut = socket ? Math.max(0, (socket.bytesWritten || 0) - written0) : (body ? body.length : 0);
			const failed = !!error || status >= 400;
			second.count++;
			second.bytesIn += bytesIn;
			second.bytesOut += bytesOut;
			if (failed) {
				second.errors++;
			}
			if (!error) {
				record(second.hist, ms);
			}
			if (measured) {
				measuredDone++;
				totals.count++;
				totals.bytesIn += bytesIn;
				totals.bytesOut += bytesOut;
				target.count++;
				target.bytesIn += bytesIn;
				if (error) {
					totals.errors++;
					target.errors++;
					countKind(kindOf(error, timedOut));
				} else {
					// Latency is of the requests that were answered; a timeout would only repeat the limit.
					record(latency, ms);
					record(target.hist, ms);
					countCode(codes, status);
					countCode(target.codes, status);
					if (status >= 400) {
						totals.httpErrors++;
						target.errors++;
					}
					if (tDns >= 0) {
						record(dnsHist, tDns - begun);
					}
					if (tTcp >= 0) {
						record(tcpHist, tTcp - (tDns >= 0 ? tDns : begun));
					}
					if (tTls >= 0 && tTcp >= 0) {
						record(tlsHist, tTls - tTcp);
					}
					if (tFirst >= 0) {
						record(ttfbHist, tFirst - Math.max(begun, tTcp, tTls));
						record(downloadHist, end - tFirst);
					}
				}
				if (maxRequests && measuredDone >= maxRequests) {
					end$('completed');
					return;
				}
			}
			// A server that is not there answers at once: do not spin on it.
			schedule(user, thinkMs + (error && !timedOut ? 5 : 0));
		};
		const abort = (): void => {
			request?.destroy();
		};

		const url = target.dynamicUrl ? parseUrl(fill(target.rawUrl, user.id, iteration)) : target.url;
		if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
			finish(0, new Error('Invalid URL'));
			return;
		}
		let headers = target.headers;
		if (target.dynamicHeaders) {
			headers = {};
			for (const key in target.headers) {
				headers[key] = fill(target.headers[key], user.id, iteration);
			}
		}
		const secure = url.protocol === 'https:';
		try {
			request = (secure ? https : http).request({
				protocol: url.protocol,
				hostname: url.hostname.replace(/^\[|\]$/g, ''),
				port: url.port || (secure ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: target.method,
				headers,
				agent: secure ? httpsAgent : httpAgent,
			});
		} catch (error) {
			finish(0, error);
			return;
		}
		cleanups.add(abort);
		timer = setTimeout(() => {
			timedOut = true;
			request?.destroy(new Error('timeout'));
		}, timeoutMs);
		request.on('socket', (assigned: import('net').Socket) => {
			socket = assigned;
			written0 = assigned.bytesWritten || 0;
			read0 = assigned.bytesRead || 0;
			if (assigned.connecting) {
				assigned.once('lookup', () => { tDns = now(); });
				assigned.once('connect', () => { tTcp = now(); });
				if (secure) {
					assigned.once('secureConnect', () => { tTls = now(); });
				}
			}
		});
		request.on('response', (response: import('http').IncomingMessage) => {
			tFirst = now();
			response.on('data', (chunk: Buffer) => { bodyIn += chunk.length; });
			response.on('end', () => finish(response.statusCode || 0, undefined));
			response.on('error', (error: Error) => finish(0, error));
			response.on('aborted', () => finish(0, new Error('aborted')));
		});
		request.on('error', (error: Error) => finish(0, error));
		request.end(body);
	};

	// --- WebSocket -------------------------------------------------------------------------------
	const wsFrame = (opcode: number, payload: Buffer): Buffer => {
		const length = payload.length;
		const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
		const frame = Buffer.allocUnsafe(head + 4 + length);
		frame[0] = 0x80 | opcode;
		if (length < 126) {
			frame[1] = 0x80 | length;
		} else if (length < 65536) {
			frame[1] = 0x80 | 126;
			frame.writeUInt16BE(length, 2);
		} else {
			frame[1] = 0x80 | 127;
			frame.writeUInt32BE(Math.floor(length / 4294967296), 2);
			frame.writeUInt32BE(length >>> 0, 6);
		}
		const mask = crypto.randomBytes(4);
		mask.copy(frame, head);
		for (let at = 0; at < length; at++) {
			frame[head + 4 + at] = payload[at] ^ mask[at & 3];
		}
		return frame;
	};
	const wsMessage = plan.ws?.message || '';
	const wsInterval = Math.max(10, plan.ws?.intervalMs || 1000);
	const wsExpectReply = !!plan.ws?.expectReply;
	const wsStatic = wsMessage && !hasToken(wsMessage) ? Buffer.from(wsMessage, 'utf8').subarray(0, MAX_BODY) : undefined;

	/** Opens the user's connection again after a pause, when the run still wants it. */
	const retry = (user: IUser, open: (user: IUser) => void, reconnect: boolean): void => {
		user.close = undefined;
		if (finished || user.id >= wanted) {
			user.running = false;
			return;
		}
		user.timer = setTimeout(() => {
			user.timer = undefined;
			if (finished || user.id >= wanted) {
				user.running = false;
				return;
			}
			if (reconnect) {
				totals.reconnects++;
			}
			open(user);
		}, RETRY_MS);
	};

	const openWs = (user: IUser): void => {
		const iteration = user.iteration++;
		const target = targets[user.id % targets.length];
		const url = parseUrl(target.dynamicUrl ? fill(target.rawUrl, user.id, iteration) : target.rawUrl);
		const begun = now();
		if (!url) {
			totals.connectFailures++;
			countKind('other');
			retry(user, openWs, false);
			return;
		}
		const secure = url.protocol === 'wss:' || url.protocol === 'https:';
		const host = url.hostname.replace(/^\[|\]$/g, '');
		const port = Number(url.port) || (secure ? 443 : 80);
		const key = crypto.randomBytes(16).toString('base64');
		let state: 'connecting' | 'open' | 'closed' = 'connecting';
		let expected = false;
		let timedOut = false;
		let lastError: unknown;
		let buffer: Buffer = Buffer.alloc(0);
		let sendTimer: ReturnType<typeof setInterval> | undefined;
		let sends = 0;
		const pending: number[] = [];
		let socket: import('net').Socket;
		try {
			socket = secure ? tls.connect({ host, port, rejectUnauthorized: !plan.insecure, ...(net.isIP(host) ? {} : { servername: host }) }) : net.connect({ host, port });
		} catch (error) {
			totals.connectFailures++;
			countKind(kindOf(error, false));
			retry(user, openWs, false);
			return;
		}
		socket.setNoDelay(true);
		const connectTimer = setTimeout(() => {
			timedOut = true;
			socket.destroy();
		}, timeoutMs);
		const write = (frame: Buffer): void => {
			socket.write(frame);
			second.bytesOut += frame.length;
			totals.bytesOut += frame.length;
		};
		const sendMessage = (): void => {
			if (state !== 'open') {
				return;
			}
			const at = now();
			while (pending.length && at - pending[0] > timeoutMs) {
				pending.shift();
				second.errors++;
				if (measuring(at)) {
					totals.errors++;
					countKind('timeout');
				}
			}
			const payload = wsStatic ?? Buffer.from(fill(wsMessage, user.id, sends), 'utf8').subarray(0, MAX_BODY);
			sends++;
			write(wsFrame(1, payload));
			second.sent++;
			if (measuring(at)) {
				totals.sent++;
			}
			if (wsExpectReply) {
				pending.push(at);
			}
		};
		const onMessage = (): void => {
			const at = now();
			const measured = measuring(at);
			second.count++;
			if (measured) {
				totals.count++;
				target.count++;
			}
			const sentAt = wsExpectReply ? pending.shift() : undefined;
			if (sentAt !== undefined) {
				record(second.hist, at - sentAt);
				if (measured) {
					record(latency, at - sentAt);
					record(target.hist, at - sentAt);
				}
			}
		};
		const opened = (): void => {
			state = 'open';
			clearTimeout(connectTimer);
			active++;
			totals.connects++;
			record(connectHist, now() - begun);
			countCode(codes, 101);
			if (wsMessage) {
				sendMessage();
				sendTimer = setInterval(sendMessage, wsInterval);
			}
		};
		const frames = (): void => {
			while (buffer.length >= 2) {
				const opcode = buffer[0] & 0x0f;
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
					length = buffer.readUInt32BE(2) * 4294967296 + buffer.readUInt32BE(6);
					offset = 10;
				}
				if (masked) {
					offset += 4;
				}
				if (buffer.length < offset + length) {
					return;
				}
				const fin = (buffer[0] & 0x80) !== 0;
				const payload = buffer.subarray(offset, offset + length);
				buffer = buffer.subarray(offset + length);
				if (opcode === 0x8) {
					// The server is closing: answer and let the socket end.
					socket.write(wsFrame(0x8, payload.subarray(0, 2)));
					socket.end();
					return;
				}
				if (opcode === 0x9) {
					write(wsFrame(0xA, Buffer.from(payload)));
				} else if (opcode <= 0x2 && fin) {
					onMessage();
				}
			}
		};
		user.close = () => {
			expected = true;
			if (state === 'open') {
				try {
					socket.write(wsFrame(0x8, Buffer.from([0x03, 0xe8])));
				} catch {
					// It is being dropped either way.
				}
			}
			socket.destroy();
		};
		socket.once(secure ? 'secureConnect' : 'connect', () => {
			const lines = [`GET ${url.pathname || '/'}${url.search} HTTP/1.1`, `Host: ${url.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
			for (const name in target.headers) {
				if (!/^(host|upgrade|connection|sec-websocket-key|sec-websocket-version)$/i.test(name)) {
					lines.push(`${name}: ${target.dynamicHeaders ? fill(target.headers[name], user.id, iteration) : target.headers[name]}`);
				}
			}
			const handshake = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
			write(handshake);
		});
		socket.on('data', (chunk: Buffer) => {
			second.bytesIn += chunk.length;
			totals.bytesIn += chunk.length;
			buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
			if (state === 'connecting') {
				const end = buffer.indexOf('\r\n\r\n');
				if (end < 0) {
					if (buffer.length > 65536) {
						socket.destroy();
					}
					return;
				}
				const head = buffer.subarray(0, end).toString('latin1');
				buffer = buffer.subarray(end + 4);
				const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1] ?? 0);
				const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
				const wantedAccept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
				if (status !== 101 || accept !== wantedAccept) {
					if (status && status !== 101) {
						countCode(codes, status);
					}
					lastError = new Error(status === 101 ? 'Bad handshake' : `Unexpected status ${status}`);
					socket.destroy();
					return;
				}
				opened();
			}
			if (state === 'open') {
				frames();
			}
		});
		socket.on('error', (error: Error) => { lastError = error; });
		socket.on('close', () => {
			clearTimeout(connectTimer);
			clearInterval(sendTimer);
			const was = state;
			state = 'closed';
			if (was === 'open') {
				active--;
			}
			if (finished || expected) {
				user.close = undefined;
				user.running = false;
				return;
			}
			if (was === 'connecting') {
				totals.connectFailures++;
				second.errors++;
				countKind(kindOf(lastError, timedOut));
			} else {
				totals.closes++;
			}
			retry(user, openWs, was === 'open');
		});
	};

	// --- Server-sent events ----------------------------------------------------------------------
	const openSse = (user: IUser): void => {
		const iteration = user.iteration++;
		const target = targets[user.id % targets.length];
		const url = parseUrl(target.dynamicUrl ? fill(target.rawUrl, user.id, iteration) : target.rawUrl);
		const begun = now();
		if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
			totals.connectFailures++;
			countKind('other');
			retry(user, openSse, false);
			return;
		}
		const secure = url.protocol === 'https:';
		const headers: Record<string, string> = { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' };
		for (const name in target.headers) {
			headers[name] = target.dynamicHeaders ? fill(target.headers[name], user.id, iteration) : target.headers[name];
		}
		let state: 'connecting' | 'open' | 'closed' = 'connecting';
		let expected = false;
		let timedOut = false;
		let first = true;
		// The stream is read byte by byte: an event ends at an empty line and counts when it had a `data` line.
		let lineLength = 0;
		let lineIsData = true;
		let eventHasData = false;
		let request: import('http').ClientRequest;
		const closed = (error: unknown): void => {
			if (state === 'closed') {
				return;
			}
			clearTimeout(connectTimer);
			const was = state;
			state = 'closed';
			if (was === 'open') {
				active--;
			}
			if (finished || expected) {
				user.close = undefined;
				user.running = false;
				return;
			}
			if (was === 'connecting') {
				totals.connectFailures++;
				second.errors++;
				countKind(kindOf(error, timedOut));
			} else {
				totals.closes++;
			}
			retry(user, openSse, was === 'open');
		};
		try {
			request = (secure ? https : http).request({
				protocol: url.protocol,
				hostname: url.hostname.replace(/^\[|\]$/g, ''),
				port: url.port || (secure ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: target.method || 'GET',
				headers,
				agent: false,
				...(secure ? { rejectUnauthorized: !plan.insecure } : {}),
			});
		} catch (error) {
			totals.connectFailures++;
			countKind(kindOf(error, false));
			retry(user, openSse, false);
			return;
		}
		const connectTimer = setTimeout(() => {
			timedOut = true;
			request.destroy(new Error('timeout'));
		}, timeoutMs);
		user.close = () => {
			expected = true;
			request.destroy();
		};
		request.on('response', (response: import('http').IncomingMessage) => {
			const status = response.statusCode || 0;
			countCode(codes, status);
			if (status < 200 || status >= 300) {
				response.resume();
				closed(new Error(`Unexpected status ${status}`));
				request.destroy();
				return;
			}
			clearTimeout(connectTimer);
			state = 'open';
			active++;
			totals.connects++;
			record(connectHist, now() - begun);
			response.on('data', (chunk: Buffer) => {
				second.bytesIn += chunk.length;
				totals.bytesIn += chunk.length;
				let events = 0;
				for (let at = 0; at < chunk.length; at++) {
					const byte = chunk[at];
					if (byte === 10) {
						if (lineLength === 0) {
							if (eventHasData) {
								events++;
							}
							eventHasData = false;
						} else if (lineIsData && lineLength >= 4) {
							eventHasData = true;
						}
						lineLength = 0;
						lineIsData = true;
					} else if (byte !== 13) {
						// "data" as the line's first four bytes: 100 97 116 97.
						if (lineLength < 4 && byte !== (lineLength === 0 ? 100 : lineLength === 2 ? 116 : 97)) {
							lineIsData = false;
						}
						lineLength++;
					}
				}
				if (!events) {
					return;
				}
				const at = now();
				const measured = measuring(at);
				second.count += events;
				if (measured) {
					totals.count += events;
					target.count += events;
				}
				if (first) {
					first = false;
					record(second.hist, at - begun);
					record(latency, at - begun);
					record(target.hist, at - begun);
				}
			});
			response.on('end', () => closed(undefined));
			response.on('error', (error: Error) => closed(error));
			response.on('close', () => closed(undefined));
		});
		request.on('error', (error: Error) => closed(error));
		request.end(target.body);
	};

	// --- The clock -------------------------------------------------------------------------------
	const sample = (t: number): void => {
		const users$ = active;
		const item: IVoltLoadSample = {
			t, users: users$, count: second.count, errors: second.errors,
			mean: second.hist.n ? second.hist.sum / second.hist.n : 0,
			p50: percentile(second.hist, 50), p95: percentile(second.hist, 95), p99: percentile(second.hist, 99),
			bytesIn: second.bytesIn, bytesOut: second.bytesOut,
			...(mode === 'ws' ? { sent: second.sent } : {}),
			...(t * 1000 <= warmupMs ? { warmup: true } : {}),
		};
		clear(second.hist);
		second.count = 0;
		second.errors = 0;
		second.bytesIn = 0;
		second.bytesOut = 0;
		second.sent = 0;
		series.push(item);
		try {
			hooks.onSample(item);
		} catch {
			// A listener's trouble is not the run's.
		}
	};

	const scale = (elapsed: number): void => {
		wanted = Math.min(maxUsers, Math.max(0, Math.floor(steps[Math.min(steps.length - 1, Math.floor(elapsed / stepMs))] || 0)));
		let opens = 0;
		for (let id = 0; id < wanted; id++) {
			let user = users[id];
			if (!user) {
				user = users[id] = { id, running: false, iteration: 0, timer: undefined, close: undefined };
			}
			if (user.running) {
				continue;
			}
			if (mode === 'http') {
				if (maxRequests && measuredStarted >= maxRequests) {
					break;
				}
				user.running = true;
				active++;
				schedule(user, 0);
			} else {
				if (opens++ >= MAX_OPENS_PER_STEP) {
					break;
				}
				user.running = true;
				(mode === 'ws' ? openWs : openSse)(user);
			}
		}
		if (mode !== 'http') {
			// The profile went down: the connections above it close (HTTP users park after their request).
			for (let id = wanted; id < users.length; id++) {
				const user = users[id];
				if (user?.close) {
					user.close();
				} else if (user?.timer) {
					clearTimeout(user.timer);
					user.timer = undefined;
					user.running = false;
				}
			}
		}
		if (active > peakUsers) {
			peakUsers = active;
		}
	};

	const end$ = (ended: 'completed' | 'stopped'): void => {
		if (finished) {
			return;
		}
		const elapsed = now() - t0;
		if (active > peakUsers) {
			peakUsers = active;
		}
		// The last, partial second is only worth a point when it is all there is.
		if (!series.length && (second.count || second.errors)) {
			sample(Math.max(1, Math.ceil(elapsed / 1000)));
		}
		finished = true;
		clearInterval(ticker);
		for (const user of users) {
			if (user) {
				clearTimeout(user.timer);
				user.timer = undefined;
				user.close?.();
			}
		}
		for (const cleanup of [...cleanups]) {
			cleanup();
		}
		cleanups.clear();
		httpAgent?.destroy();
		httpsAgent?.destroy();
		const measuredSec = Math.max(0.001, (elapsed - warmupMs) / 1000);
		const some = (hist: IHist): IVoltLoadHistogramData | undefined => hist.n ? pack(hist) : undefined;
		const targetResults: IVoltLoadTargetResult[] = targets.map(target => ({
			name: target.name, method: target.method, url: target.rawUrl, count: target.count, errors: target.errors, bytesIn: target.bytesIn,
			latency: pack(target.hist), statusCodes: target.codes,
		}));
		const dns = some(dnsHist);
		const tcp = some(tcpHist);
		const tlsData = some(tlsHist);
		const ttfb = some(ttfbHist);
		const download = some(downloadHist);
		const connect = some(connectHist);
		const result: IVoltLoadResult = {
			mode, startedAt, durationMs: Math.round(elapsed), measuredSec, ended,
			count: totals.count, errors: totals.errors, httpErrors: totals.httpErrors, bytesIn: totals.bytesIn, bytesOut: totals.bytesOut,
			rate: elapsed > warmupMs ? totals.count / measuredSec : 0,
			peakUsers, sent: totals.sent, connects: totals.connects, connectFailures: totals.connectFailures, closes: totals.closes, reconnects: totals.reconnects,
			latency: pack(latency),
			...(connect ? { connect } : {}), ...(dns ? { dns } : {}), ...(tcp ? { tcp } : {}), ...(tlsData ? { tls: tlsData } : {}), ...(ttfb ? { ttfb } : {}), ...(download ? { download } : {}),
			statusCodes: codes, errorKinds: kinds, targets: targetResults, series,
		};
		hooks.onDone(result);
	};

	const ticker = setInterval(() => {
		const elapsed = now() - t0;
		const whole = Math.floor(elapsed / 1000);
		while (secondsOut < whole && !finished) {
			secondsOut++;
			sample(secondsOut);
		}
		if (elapsed >= totalMs || !targets.length) {
			end$('completed');
			return;
		}
		scale(elapsed);
		if (mode === 'http' && maxRequests && measuredStarted >= maxRequests && active === 0 && measuredDone >= measuredStarted) {
			end$('completed');
		}
	}, Math.min(stepMs, 250));
	if (targets.length) {
		scale(0);
	}

	return { stop: () => end$('stopped') };
}

/** What the engine asks `nodeRequire` for, when it runs on the caller's thread. */
const INLINE_MODULES: Readonly<Record<string, unknown>> = { http, https, net, tls, crypto, perf_hooks: perfHooks };

export function voltLoadInlineRequire(name: string): unknown {
	return INLINE_MODULES[name];
}

/** The script of the worker thread: the engine's own source, fed the plan and reporting by message. */
export function voltLoadWorkerSource(): string {
	return [
		`'use strict';`,
		// A bundler that keeps function names wraps them in a helper of its own module scope.
		'const __name = value => value;',
		`const { parentPort, workerData } = require('worker_threads');`,
		`const engine = (${voltLoadEngine.toString()});`,
		`const handle = engine(workerData, { onSample: sample => parentPort.postMessage({ type: 'sample', sample }), onDone: result => parentPort.postMessage({ type: 'done', result }) }, require);`,
		`parentPort.on('message', message => { if (message === 'stop') { handle.stop(); } });`,
	].join('\n');
}

export type VoltLoadEvent = Omit<IVoltLoadProgress, 'id'>;

export interface IVoltLoadRun extends IVoltLoadHandle {
	/** Whether the run is in a worker thread (false: inline, on the caller's event loop). */
	readonly threaded: boolean;
}

/** How long a worker has to hand over its result after it was told to stop. */
const STOP_GRACE_MS = 1500;

/**
 * Starts a run: in a worker thread when one can be made, else inline. Throws for a spec that
 * cannot run. `emit` gets a `sample` each second, then exactly one `done` or `error`.
 */
export function startVoltLoad(spec: IVoltLoadSpec, emit: (event: VoltLoadEvent) => void, options?: { readonly inline?: boolean }): IVoltLoadRun {
	const plan = planVoltLoad(spec);
	let over = false;
	const finish = (event: VoltLoadEvent) => {
		if (!over) {
			over = true;
			emit(event);
		}
	};

	let worker: Worker | undefined;
	if (!options?.inline) {
		try {
			worker = new Worker(voltLoadWorkerSource(), { eval: true, workerData: plan });
		} catch {
			worker = undefined;
		}
	}
	if (!worker) {
		const handle = voltLoadEngine(plan, {
			onSample: sample => !over && emit({ type: 'sample', sample }),
			onDone: result => finish({ type: 'done', result }),
		}, voltLoadInlineRequire);
		return { threaded: false, stop: () => handle.stop() };
	}

	const thread = worker;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	thread.on('message', (message: { type: 'sample'; sample: IVoltLoadSample } | { type: 'done'; result: IVoltLoadResult }) => {
		if (message.type === 'sample') {
			if (!over) {
				emit({ type: 'sample', sample: message.sample });
			}
		} else {
			clearTimeout(killTimer);
			finish({ type: 'done', result: message.result });
			void thread.terminate();
		}
	});
	thread.on('error', error => {
		clearTimeout(killTimer);
		finish({ type: 'error', error: error instanceof Error ? error.message : String(error) });
	});
	thread.on('exit', () => {
		clearTimeout(killTimer);
		finish({ type: 'error', error: 'The load worker ended without a result.' });
	});
	return {
		threaded: true,
		stop: () => {
			if (over) {
				return;
			}
			thread.postMessage('stop');
			killTimer ??= setTimeout(() => {
				finish({ type: 'error', error: 'The load worker did not stop in time and was ended.' });
				void thread.terminate();
			}, STOP_GRACE_MS);
		},
	};
}
