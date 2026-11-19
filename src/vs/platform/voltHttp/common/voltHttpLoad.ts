/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** The main process channel the Volt Client's performance tests run through. */
export const VOLT_HTTP_LOAD_CHANNEL_NAME = 'voltHttpLoad';

export const IVoltHttpLoad = createDecorator<IVoltHttpLoad>('voltHttpLoad');

// --- Limits (enforced by the engine whatever a caller asks for) ----------------------------------

export const VOLT_LOAD_MAX_USERS = 2000;
export const VOLT_LOAD_MAX_DURATION_SEC = 30 * 60;
/** The most one request body or WebSocket message may weigh (bytes of UTF-8). */
export const VOLT_LOAD_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const VOLT_LOAD_MAX_TARGETS = 50;
export const VOLT_LOAD_DEFAULT_TIMEOUT_MS = 10_000;
/** How often the engine moves the number of users toward the profile (ms). */
export const VOLT_LOAD_STEP_MS = 250;

// --- What to run ----------------------------------------------------------------------------------

export type VoltLoadMode = 'http' | 'ws' | 'sse';
export type VoltLoadProfileKind = 'fixed' | 'rampUp' | 'spike' | 'peak';

/**
 * How many virtual users are active over the run, as Postman's performance runner draws them.
 * - `fixed`: `users` from start to end.
 * - `rampUp`: from `baseUsers` to `users` over `rampUpSec`, then `users` to the end.
 * - `spike`: `baseUsers`, a climb to `users` over `rampUpSec` starting at `startSec`, straight back
 *   down over `rampDownSec`, then `baseUsers` again.
 * - `peak`: `baseUsers`, a climb over `rampUpSec` starting at `startSec`, `users` held for
 *   `holdSec`, down over `rampDownSec`, then `baseUsers`.
 * Absent parameters take Postman's proportions of the duration (see `voltLoadProfileDefaults`).
 */
export interface IVoltLoadProfile {
	readonly kind: VoltLoadProfileKind;
	readonly baseUsers?: number;
	readonly startSec?: number;
	readonly rampUpSec?: number;
	readonly holdSec?: number;
	readonly rampDownSec?: number;
}

/** One prepared request (or the connection of a WebSocket / SSE test): variables already filled in. */
export interface IVoltLoadTarget {
	readonly name: string;
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	/** May carry the engine's dynamic tokens, as the url and header values may. */
	readonly body?: string;
	/** Its share of the sends when `order` is `weighted`. 1 when absent. */
	readonly weight?: number;
}

export interface IVoltLoadSpec {
	readonly mode: VoltLoadMode;
	readonly targets: readonly IVoltLoadTarget[];
	/** `weighted`: each send picks a target by weight. `sequence`: each user walks the targets in order. */
	readonly order?: 'weighted' | 'sequence';
	/** The most virtual users (HTTP) or connections (WebSocket, SSE) at once. */
	readonly users: number;
	/** How long the measured part runs (s). When absent, `requests` ends the run (HTTP only). */
	readonly durationSec?: number;
	/** Stop after this many requests (HTTP only). */
	readonly requests?: number;
	readonly profile?: IVoltLoadProfile;
	/** A cap on requests per second over all users (HTTP only). */
	readonly rps?: number;
	/** Seconds of load before measuring starts; what happens then is in the series but not the statistics. */
	readonly warmupSec?: number;
	/** A pause after each response before the user's next request (ms). */
	readonly thinkMs?: number;
	/** How long one request, or one connect, may take (ms). */
	readonly timeoutMs?: number;
	/** Do not verify TLS certificates. */
	readonly insecure?: boolean;
	readonly ws?: {
		/** Sent on every connection each `intervalMs`; nothing is sent when empty. */
		readonly message?: string;
		readonly intervalMs?: number;
		/** Time each send to the next incoming message (the round trip). */
		readonly expectReply?: boolean;
	};
}

// --- What comes back ------------------------------------------------------------------------------

/** A histogram as it travels and is stored: sparse `[bucket, count, bucket, count, ...]`, times in ms. */
export interface IVoltLoadHistogramData {
	readonly n: number;
	readonly min: number;
	readonly max: number;
	readonly sum: number;
	readonly sumSq: number;
	readonly b: readonly number[];
}

/** One second of a run. Latencies are ms. */
export interface IVoltLoadSample {
	/** Seconds since the run started (1 for the first second). */
	readonly t: number;
	/** Active virtual users, or open connections. */
	readonly users: number;
	/** HTTP: responses and failures. WebSocket: messages received. SSE: events received. */
	readonly count: number;
	/** Failures: network errors, and for HTTP also 4xx and 5xx responses. */
	readonly errors: number;
	readonly mean: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	/** WebSocket: messages sent. */
	readonly sent?: number;
	/** Inside the warm-up: not part of the statistics. */
	readonly warmup?: boolean;
}

export type VoltLoadErrorKind = 'timeout' | 'refused' | 'reset' | 'dns' | 'tls' | 'other';

export interface IVoltLoadTargetResult {
	readonly name: string;
	readonly method: string;
	readonly url: string;
	readonly count: number;
	readonly errors: number;
	readonly bytesIn: number;
	readonly latency: IVoltLoadHistogramData;
	readonly statusCodes: Readonly<Record<string, number>>;
}

export interface IVoltLoadResult {
	readonly mode: VoltLoadMode;
	/** `Date.now()` when the run started. */
	readonly startedAt: number;
	/** Wall time of the whole run, warm-up included. */
	readonly durationMs: number;
	/** The measured time (the warm-up left out), s. */
	readonly measuredSec: number;
	/** How it ended: its time or request count was reached, or it was stopped. */
	readonly ended: 'completed' | 'stopped';
	/** HTTP: requests answered or failed. WebSocket: messages received. SSE: events received. */
	readonly count: number;
	/** Network failures (timeouts, refused or reset connections, DNS, TLS). */
	readonly errors: number;
	/** HTTP responses with a 4xx or 5xx status. */
	readonly httpErrors: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	/** `count` per measured second. */
	readonly rate: number;
	readonly peakUsers: number;
	/** WebSocket: messages sent. */
	readonly sent: number;
	/** WebSocket and SSE: connections opened, attempts that failed, connections the server ended, and re-opens after those. */
	readonly connects: number;
	readonly connectFailures: number;
	readonly closes: number;
	readonly reconnects: number;
	/**
	 * `latency`: the request (HTTP), the round trip of a message (WebSocket, with "expect a reply"),
	 * or the time to the first event (SSE). `connect`: the handshake of a WebSocket, the response
	 * headers of an SSE stream. The others are the phases of HTTP requests where a new connection
	 * was made (`dns`, `tcp`, `tls`) or of every request (`ttfb`, `download`).
	 */
	readonly latency: IVoltLoadHistogramData;
	readonly connect?: IVoltLoadHistogramData;
	readonly dns?: IVoltLoadHistogramData;
	readonly tcp?: IVoltLoadHistogramData;
	readonly tls?: IVoltLoadHistogramData;
	readonly ttfb?: IVoltLoadHistogramData;
	readonly download?: IVoltLoadHistogramData;
	readonly statusCodes: Readonly<Record<string, number>>;
	readonly errorKinds: Readonly<Partial<Record<VoltLoadErrorKind, number>>>;
	readonly targets: readonly IVoltLoadTargetResult[];
	readonly series: readonly IVoltLoadSample[];
}

export interface IVoltLoadProgress {
	readonly id: string;
	readonly type: 'sample' | 'done' | 'error';
	readonly sample?: IVoltLoadSample;
	/** With `done`: everything, the series included. */
	readonly result?: IVoltLoadResult;
	/** With `error`: why the run could not start or broke off. Nothing follows. */
	readonly error?: string;
}

/**
 * Load generation for the Volt Client's performance tests, from a worker thread of the main process:
 * no page rules apply and the window stays responsive.
 */
export interface IVoltHttpLoad {
	readonly _serviceBrand: undefined;
	readonly onDidProgress: Event<IVoltLoadProgress>;
	/** Starts a run and returns its id; a `sample` each second and one `done` (or `error`) follow. Rejects for a spec that cannot run. */
	start(spec: IVoltLoadSpec): Promise<string>;
	/** Ends a run early; its `done` carries what was measured so far. Stopping an unknown id is not an error. */
	stop(id: string): Promise<void>;
}

// --- Histogram ------------------------------------------------------------------------------------

/**
 * The bucket layout (the engine's hot loop repeats it, see `voltLoadEngine`): values are whole
 * microseconds; below 2^BITS each value has its own bucket, above it every power of two is cut
 * into 2^BITS equal buckets. So a bucket is never wider than 1/64 of its lower bound and a value
 * read back from a bucket's middle is within 0.8% of what was recorded.
 */
export const VOLT_LOAD_HISTOGRAM_BITS = 6;
const SUB = 1 << VOLT_LOAD_HISTOGRAM_BITS;
/** The largest value kept apart: 2^26 microseconds, 67 s. Anything above lands in the last bucket. */
const MAX_EXPONENT = 26;
export const VOLT_LOAD_HISTOGRAM_BUCKETS = SUB + (MAX_EXPONENT - VOLT_LOAD_HISTOGRAM_BITS) * SUB;

/** The bucket of a time in microseconds. */
export function voltLoadBucketIndex(microseconds: number): number {
	const value = microseconds < 0 ? 0 : Math.round(microseconds);
	if (value < SUB) {
		return value;
	}
	if (value >= 2 ** MAX_EXPONENT) {
		return VOLT_LOAD_HISTOGRAM_BUCKETS - 1;
	}
	const exponent = 31 - Math.clz32(value);
	return SUB + (exponent - VOLT_LOAD_HISTOGRAM_BITS) * SUB + ((value >>> (exponent - VOLT_LOAD_HISTOGRAM_BITS)) - SUB);
}

/** The lowest microsecond value of a bucket and how many values wide it is. */
export function voltLoadBucketRange(index: number): { readonly low: number; readonly width: number } {
	if (index < SUB) {
		return { low: index, width: 1 };
	}
	const octave = Math.floor((index - SUB) / SUB);
	const width = 2 ** octave;
	return { low: (SUB + ((index - SUB) % SUB)) * width, width };
}

/** The time (ms) a bucket stands for: its middle. */
function bucketValueMs(index: number): number {
	const { low, width } = voltLoadBucketRange(index);
	return (width === 1 ? low : low + width / 2) / 1000;
}

export const EMPTY_VOLT_LOAD_HISTOGRAM: IVoltLoadHistogramData = Object.freeze({ n: 0, min: 0, max: 0, sum: 0, sumSq: 0, b: [] });

/** A latency histogram with a bounded relative error. Times go in and come out as milliseconds. */
export class VoltLoadHistogram {

	private readonly counts = new Map<number, number>();
	private n = 0;
	private lowest = Infinity;
	private highest = 0;
	private sum = 0;
	private sumSq = 0;

	static from(data: IVoltLoadHistogramData | undefined): VoltLoadHistogram {
		const histogram = new VoltLoadHistogram();
		if (data) {
			histogram.merge(data);
		}
		return histogram;
	}

	record(ms: number, times = 1): void {
		if (!(times > 0) || !Number.isFinite(ms)) {
			return;
		}
		const value = Math.max(0, ms);
		const index = voltLoadBucketIndex(value * 1000);
		this.counts.set(index, (this.counts.get(index) ?? 0) + times);
		this.n += times;
		this.sum += value * times;
		this.sumSq += value * value * times;
		this.lowest = Math.min(this.lowest, value);
		this.highest = Math.max(this.highest, value);
	}

	merge(other: VoltLoadHistogram | IVoltLoadHistogramData): void {
		const data = other instanceof VoltLoadHistogram ? other.toJSON() : other;
		if (!data || !(data.n > 0) || !Array.isArray(data.b)) {
			return;
		}
		for (let at = 0; at + 1 < data.b.length; at += 2) {
			const index = Math.min(VOLT_LOAD_HISTOGRAM_BUCKETS - 1, Math.max(0, Math.floor(data.b[at])));
			const count = data.b[at + 1];
			if (count > 0) {
				this.counts.set(index, (this.counts.get(index) ?? 0) + count);
			}
		}
		this.n += data.n;
		this.sum += data.sum;
		this.sumSq += data.sumSq;
		this.lowest = Math.min(this.lowest, data.min);
		this.highest = Math.max(this.highest, data.max);
	}

	get count(): number { return this.n; }
	get min(): number { return this.n ? this.lowest : 0; }
	get max(): number { return this.highest; }
	get mean(): number { return this.n ? this.sum / this.n : 0; }
	get stddev(): number {
		if (this.n < 2) {
			return 0;
		}
		const mean = this.sum / this.n;
		return Math.sqrt(Math.max(0, this.sumSq / this.n - mean * mean));
	}

	/** The time `percent` (0 to 100) of the recorded values are at or under. */
	percentile(percent: number): number {
		if (!this.n) {
			return 0;
		}
		if (percent >= 100) {
			return this.highest;
		}
		const rank = Math.max(1, Math.ceil(this.n * Math.max(0, percent) / 100));
		let seen = 0;
		for (const index of [...this.counts.keys()].sort((a, b) => a - b)) {
			seen += this.counts.get(index)!;
			if (seen >= rank) {
				// Never outside what was really seen: the ends of the range are known exactly.
				return Math.min(this.highest, Math.max(this.lowest, bucketValueMs(index)));
			}
		}
		return this.highest;
	}

	/** The buckets that hold something, lowest first, as ms ranges. */
	buckets(): { readonly from: number; readonly to: number; readonly count: number }[] {
		return [...this.counts.keys()].sort((a, b) => a - b).map(index => {
			const { low, width } = voltLoadBucketRange(index);
			return { from: low / 1000, to: (low + width) / 1000, count: this.counts.get(index)! };
		});
	}

	toJSON(): IVoltLoadHistogramData {
		const b: number[] = [];
		for (const index of [...this.counts.keys()].sort((a, b) => a - b)) {
			b.push(index, this.counts.get(index)!);
		}
		return { n: this.n, min: this.min, max: this.highest, sum: this.sum, sumSq: this.sumSq, b };
	}
}

export interface IVoltLoadPercentiles {
	readonly count: number;
	readonly min: number;
	readonly p50: number;
	readonly p75: number;
	readonly p90: number;
	readonly p95: number;
	readonly p975: number;
	readonly p99: number;
	readonly p999: number;
	readonly max: number;
	readonly mean: number;
	readonly stddev: number;
}

export function voltLoadPercentiles(data: IVoltLoadHistogramData | VoltLoadHistogram | undefined): IVoltLoadPercentiles {
	const histogram = data instanceof VoltLoadHistogram ? data : VoltLoadHistogram.from(data);
	return {
		count: histogram.count,
		min: histogram.min,
		p50: histogram.percentile(50),
		p75: histogram.percentile(75),
		p90: histogram.percentile(90),
		p95: histogram.percentile(95),
		p975: histogram.percentile(97.5),
		p99: histogram.percentile(99),
		p999: histogram.percentile(99.9),
		max: histogram.max,
		mean: histogram.mean,
		stddev: histogram.stddev,
	};
}

// --- Load profiles --------------------------------------------------------------------------------

export interface IVoltLoadProfileShape {
	readonly kind: VoltLoadProfileKind;
	readonly users: number;
	readonly baseUsers: number;
	readonly startSec: number;
	readonly rampUpSec: number;
	readonly holdSec: number;
	readonly rampDownSec: number;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, number));
}

/** A profile with every parameter filled in and inside the run: Postman's proportions where none was given. */
export function voltLoadProfileDefaults(profile: IVoltLoadProfile | undefined, users: number, durationSec: number): IVoltLoadProfileShape {
	const kind: VoltLoadProfileKind = profile?.kind === 'rampUp' || profile?.kind === 'spike' || profile?.kind === 'peak' ? profile.kind : 'fixed';
	const peak = Math.max(1, Math.round(users));
	const duration = Math.max(0, durationSec);
	const baseUsers = kind === 'fixed' ? peak : Math.round(clampNumber(profile?.baseUsers, kind === 'rampUp' ? 1 : 0, peak, Math.max(1, Math.round(peak * (kind === 'rampUp' ? 0.25 : 0.2)))));
	if (kind === 'fixed') {
		return { kind, users: peak, baseUsers, startSec: 0, rampUpSec: 0, holdSec: duration, rampDownSec: 0 };
	}
	if (kind === 'rampUp') {
		const rampUpSec = clampNumber(profile?.rampUpSec, 0, duration, duration * 0.25);
		return { kind, users: peak, baseUsers, startSec: 0, rampUpSec, holdSec: duration - rampUpSec, rampDownSec: 0 };
	}
	if (kind === 'spike') {
		const startSec = clampNumber(profile?.startSec, 0, duration, duration * 0.4);
		const rampUpSec = clampNumber(profile?.rampUpSec, 0, duration - startSec, duration * 0.1);
		const rampDownSec = clampNumber(profile?.rampDownSec, 0, duration - startSec - rampUpSec, duration * 0.1);
		return { kind, users: peak, baseUsers, startSec, rampUpSec, holdSec: 0, rampDownSec };
	}
	const startSec = clampNumber(profile?.startSec, 0, duration, duration * 0.2);
	const rampUpSec = clampNumber(profile?.rampUpSec, 0, duration - startSec, duration * 0.2);
	const holdSec = clampNumber(profile?.holdSec, 0, duration - startSec - rampUpSec, duration * 0.2);
	const rampDownSec = clampNumber(profile?.rampDownSec, 0, duration - startSec - rampUpSec - holdSec, duration * 0.2);
	return { kind, users: peak, baseUsers, startSec, rampUpSec, holdSec, rampDownSec };
}

/** How many virtual users the profile wants `tSec` seconds into a run of `durationSec`. */
export function voltLoadUsersAt(profile: IVoltLoadProfile | undefined, users: number, durationSec: number, tSec: number): number {
	const shape = voltLoadProfileDefaults(profile, users, durationSec);
	const t = Math.max(0, tSec);
	const between = (from: number, to: number, start: number, length: number) => length <= 0 ? to : from + (to - from) * Math.min(1, Math.max(0, (t - start) / length));
	let target: number;
	if (shape.kind === 'fixed') {
		target = shape.users;
	} else if (shape.kind === 'rampUp') {
		target = between(shape.baseUsers, shape.users, 0, shape.rampUpSec);
	} else {
		const top = shape.startSec + shape.rampUpSec;
		const down = top + shape.holdSec;
		if (t < shape.startSec) {
			target = shape.baseUsers;
		} else if (t < top) {
			target = between(shape.baseUsers, shape.users, shape.startSec, shape.rampUpSec);
		} else if (t <= down) {
			target = shape.users;
		} else {
			target = between(shape.users, shape.baseUsers, down, shape.rampDownSec);
		}
	}
	return Math.min(VOLT_LOAD_MAX_USERS, Math.max(0, Math.round(target)));
}

/** The profile as points for a preview: `[second, users]`, at most `points` of them. */
export function voltLoadProfilePoints(profile: IVoltLoadProfile | undefined, users: number, durationSec: number, points = 120): [number, number][] {
	const out: [number, number][] = [];
	const steps = Math.max(2, Math.min(points, Math.ceil(durationSec) + 1));
	for (let at = 0; at < steps; at++) {
		const t = durationSec * at / (steps - 1);
		out.push([t, voltLoadUsersAt(profile, users, durationSec, t)]);
	}
	return out;
}

// --- Summary numbers and thresholds ---------------------------------------------------------------

export type VoltLoadMetric = 'p50' | 'p95' | 'p99' | 'mean' | 'max' | 'errorRate' | 'rps';
export type VoltLoadOperator = 'lt' | 'lte' | 'gt' | 'gte';

export const VOLT_LOAD_METRICS: readonly VoltLoadMetric[] = ['p50', 'p95', 'p99', 'mean', 'max', 'errorRate', 'rps'];
export const VOLT_LOAD_OPERATORS: readonly VoltLoadOperator[] = ['lt', 'lte', 'gt', 'gte'];

export interface IVoltLoadThreshold {
	readonly metric: VoltLoadMetric;
	readonly op: VoltLoadOperator;
	/** ms for the latencies, percent for `errorRate`, per second for `rps`. */
	readonly value: number;
}

export type VoltLoadMetrics = Readonly<Record<VoltLoadMetric, number>>;

/** Failures as a percentage of everything attempted (0 when nothing was). */
export function voltLoadErrorRate(result: Pick<IVoltLoadResult, 'count' | 'errors' | 'httpErrors' | 'mode' | 'connects' | 'connectFailures'>): number {
	if (result.mode === 'http') {
		return result.count > 0 ? Math.min(100, (result.errors + result.httpErrors) / result.count * 100) : 0;
	}
	// A connection test fails by connections: the ones that could not be made.
	const attempts = result.connects + result.connectFailures;
	return attempts > 0 ? result.connectFailures / attempts * 100 : 0;
}

export function voltLoadMetrics(result: IVoltLoadResult): VoltLoadMetrics {
	const latency = VoltLoadHistogram.from(result.latency);
	return {
		p50: latency.percentile(50),
		p95: latency.percentile(95),
		p99: latency.percentile(99),
		mean: latency.mean,
		max: latency.max,
		errorRate: voltLoadErrorRate(result),
		rps: result.rate,
	};
}

export interface IVoltLoadThresholdResult {
	readonly threshold: IVoltLoadThreshold;
	readonly actual: number;
	readonly passed: boolean;
}

export interface IVoltLoadVerdict {
	/** Every threshold held. True when there are none. */
	readonly passed: boolean;
	readonly results: readonly IVoltLoadThresholdResult[];
}

export function voltLoadCompare(actual: number, op: VoltLoadOperator, value: number): boolean {
	switch (op) {
		case 'lt': return actual < value;
		case 'lte': return actual <= value;
		case 'gt': return actual > value;
		case 'gte': return actual >= value;
		default: return false;
	}
}

export function evaluateVoltLoadThresholds(thresholds: readonly IVoltLoadThreshold[], metrics: VoltLoadMetrics): IVoltLoadVerdict {
	const results = thresholds.map(threshold => {
		const actual = metrics[threshold.metric];
		return { threshold, actual, passed: typeof actual === 'number' && Number.isFinite(actual) && voltLoadCompare(actual, threshold.op, threshold.value) };
	});
	return { passed: results.every(result => result.passed), results };
}

// --- Validation -----------------------------------------------------------------------------------

/** The engine's dynamic tokens, filled in on every send. */
export const VOLT_LOAD_TOKENS: readonly string[] = ['$guid', '$timestamp', '$isoTimestamp', '$randomInt', '$vu', '$iteration'];

function utf8Length(text: string): number {
	let bytes = 0;
	for (let at = 0; at < text.length; at++) {
		const code = text.charCodeAt(at);
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (at++, 4) : 3;
	}
	return bytes;
}

/**
 * The spec as the engine runs it: numbers inside the hard limits, defaults filled in. Throws with
 * what is wrong for a spec that cannot run at all (no target, a URL that is not one, a body too big).
 */
export function normalizeVoltLoadSpec(spec: IVoltLoadSpec): IVoltLoadSpec {
	const mode: VoltLoadMode = spec.mode === 'ws' || spec.mode === 'sse' ? spec.mode : 'http';
	const targets = (Array.isArray(spec.targets) ? spec.targets : []).slice(0, VOLT_LOAD_MAX_TARGETS);
	if (!targets.length) {
		throw new Error('A performance test needs at least one target.');
	}
	const schemes = mode === 'ws' ? /^(wss?|https?):\/\//i : /^https?:\/\//i;
	const cleaned = targets.map((target, index): IVoltLoadTarget => {
		const url = String(target.url ?? '').trim();
		if (!schemes.test(url)) {
			throw new Error(`Target ${index + 1} has no usable URL: "${url.slice(0, 120)}" (expected ${mode === 'ws' ? 'ws://, wss://' : 'http:// or https://'}).`);
		}
		if (target.body !== undefined && utf8Length(target.body) > VOLT_LOAD_MAX_BODY_BYTES) {
			throw new Error(`Target ${index + 1}'s body is larger than ${VOLT_LOAD_MAX_BODY_BYTES / 1024 / 1024} MB.`);
		}
		return {
			name: String(target.name || `${target.method || 'GET'} ${url}`).slice(0, 200),
			method: String(target.method || 'GET').toUpperCase(),
			url: mode === 'ws' ? url.replace(/^http/i, 'ws') : url,
			headers: (target.headers ?? []).filter((header: readonly [string, string]) => Array.isArray(header) && typeof header[0] === 'string' && header[0].trim() && !/[\r\n]/.test(`${header[0]}${header[1]}`)).map((header: readonly [string, string]) => [header[0].trim(), String(header[1] ?? '')] as const),
			...(target.body !== undefined && target.body !== '' ? { body: target.body } : {}),
			weight: clampNumber(target.weight, 0, 1000, 1),
		};
	});
	const warmupSec = Math.round(clampNumber(spec.warmupSec, 0, 300, 0));
	const requests = mode === 'http' && typeof spec.requests === 'number' && spec.requests > 0 ? Math.min(100_000_000, Math.round(spec.requests)) : undefined;
	const durationSec = Math.round(clampNumber(spec.durationSec, 1, VOLT_LOAD_MAX_DURATION_SEC - warmupSec, requests ? VOLT_LOAD_MAX_DURATION_SEC - warmupSec : 10));
	const message = spec.ws?.message;
	if (message !== undefined && utf8Length(message) > VOLT_LOAD_MAX_BODY_BYTES) {
		throw new Error(`The message is larger than ${VOLT_LOAD_MAX_BODY_BYTES / 1024 / 1024} MB.`);
	}
	return {
		mode,
		targets: cleaned,
		order: spec.order === 'sequence' ? 'sequence' : 'weighted',
		users: Math.round(clampNumber(spec.users, 1, VOLT_LOAD_MAX_USERS, 10)),
		durationSec,
		...(requests ? { requests } : {}),
		...(spec.profile ? { profile: spec.profile } : {}),
		...(mode === 'http' && typeof spec.rps === 'number' && spec.rps > 0 ? { rps: Math.min(1_000_000, spec.rps) } : {}),
		warmupSec,
		thinkMs: Math.round(clampNumber(spec.thinkMs, 0, 600_000, 0)),
		timeoutMs: Math.round(clampNumber(spec.timeoutMs, 50, 600_000, VOLT_LOAD_DEFAULT_TIMEOUT_MS)),
		insecure: spec.insecure === true,
		...(mode === 'ws' ? { ws: { ...(message ? { message } : {}), intervalMs: Math.round(clampNumber(spec.ws?.intervalMs, 10, 600_000, 1000)), expectReply: spec.ws?.expectReply === true } } : {}),
	};
}

/**
 * What the engine's hot loop takes: a normalized spec and the number of users wanted at every
 * `VOLT_LOAD_STEP_MS` of the run (the warm-up runs at the profile's first value).
 */
export interface IVoltLoadPlan extends IVoltLoadSpec {
	readonly stepMs: number;
	readonly steps: readonly number[];
}

export function planVoltLoad(spec: IVoltLoadSpec): IVoltLoadPlan {
	const normalized = normalizeVoltLoadSpec(spec);
	const duration = normalized.durationSec ?? 10;
	const warmup = normalized.warmupSec ?? 0;
	const steps: number[] = [];
	const total = Math.ceil((warmup + duration) * 1000 / VOLT_LOAD_STEP_MS) + 1;
	for (let at = 0; at < total; at++) {
		const t = at * VOLT_LOAD_STEP_MS / 1000 - warmup;
		steps.push(Math.max(normalized.requests && !spec.durationSec ? normalized.users : 0, voltLoadUsersAt(normalized.requests && !spec.durationSec ? undefined : normalized.profile, normalized.users, duration, Math.max(0, t))));
	}
	return { ...normalized, stepMs: VOLT_LOAD_STEP_MS, steps };
}
