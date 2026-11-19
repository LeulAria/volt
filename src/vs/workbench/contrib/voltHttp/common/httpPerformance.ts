/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { evaluateVoltLoadThresholds, IVoltLoadHistogramData, IVoltLoadProfile, IVoltLoadResult, IVoltLoadSample, IVoltLoadSpec, IVoltLoadTarget, IVoltLoadTargetResult, IVoltLoadThreshold, IVoltLoadVerdict, VOLT_LOAD_MAX_DURATION_SEC, VOLT_LOAD_MAX_USERS, VOLT_LOAD_METRICS, VOLT_LOAD_OPERATORS, VoltLoadErrorKind, VoltLoadHistogram, VoltLoadMetric, voltLoadMetrics, VoltLoadMetrics, VoltLoadMode, VoltLoadOperator, voltLoadPercentiles, VoltLoadProfileKind } from '../../../../platform/voltHttp/common/voltHttpLoad.js';

/**
 * A performance test of the Volt Client: a `*.volt-perf.json` file in the project. It names what
 * gets the load (requests of the project's collections by reference, or typed URLs), how much
 * load and for how long, the pass/fail thresholds, the hosts the user confirmed they may load,
 * and the summaries of the last runs.
 */

export const HTTP_PERF_FILE_SUFFIX = '.volt-perf.json';
export const HTTP_PERF_FILE_PATTERN = `**/*${HTTP_PERF_FILE_SUFFIX}`;
export const HTTP_PERF_FOLDER = 'performance';
/** How many runs a file keeps. */
export const HTTP_PERF_MAX_RUNS = 10;
/** The most points a stored series has: a long run is folded into this many. */
export const HTTP_PERF_MAX_SERIES_POINTS = 300;
/** What an agent's run may ask for at most. */
export const HTTP_PERF_AGENT_MAX_USERS = 200;
export const HTTP_PERF_AGENT_MAX_SECONDS = 120;

export interface IHttpPerfRef {
	/** The collection file, relative to the project. */
	readonly collection: string;
	/** The request's name path in the collection (`["Users", "Create user"]`). */
	readonly path: readonly string[];
}

export interface IHttpPerfInline {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
}

export interface IHttpPerfTarget {
	readonly id: string;
	/** Shown in the list and the results; the request's own name when absent. */
	readonly name?: string;
	readonly ref?: IHttpPerfRef;
	readonly inline?: IHttpPerfInline;
	readonly weight: number;
}

export interface IHttpPerfLoad {
	readonly users: number;
	/** How long the measured part runs. When absent, `requests` ends the run (HTTP only). */
	readonly durationSec?: number;
	readonly requests?: number;
	readonly profile: VoltLoadProfileKind;
	readonly baseUsers?: number;
	readonly startSec?: number;
	readonly rampUpSec?: number;
	readonly holdSec?: number;
	readonly rampDownSec?: number;
	readonly rps?: number;
	readonly warmupSec: number;
	readonly thinkMs: number;
	readonly timeoutMs: number;
	readonly order: 'weighted' | 'sequence';
	/** Do not verify TLS certificates. Off by default. */
	readonly insecure?: boolean;
}

export interface IHttpPerfWsOptions {
	readonly message: string;
	readonly intervalMs: number;
	readonly expectReply: boolean;
}

export interface IHttpPerfConfirmedHost {
	readonly host: string;
	readonly at: string;
}

/** What a run was asked to do, kept with its numbers. */
export interface IHttpPerfRunConfig {
	readonly users: number;
	readonly durationSec?: number;
	readonly requests?: number;
	readonly profile: VoltLoadProfileKind;
	readonly rps?: number;
	readonly warmupSec: number;
	readonly targets: number;
	/** Who started it: the user in the client, or an agent (capped). */
	readonly by?: 'user' | 'agent';
}

/** A finished run as a file keeps it: the engine's result with its series folded, the verdict, the metrics. */
export interface IHttpPerfRun {
	readonly id: string;
	readonly mode: VoltLoadMode;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly measuredSec: number;
	readonly ended: 'completed' | 'stopped';
	readonly config: IHttpPerfRunConfig;
	readonly count: number;
	readonly errors: number;
	readonly httpErrors: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	readonly rate: number;
	readonly peakUsers: number;
	readonly sent: number;
	readonly connects: number;
	readonly connectFailures: number;
	readonly closes: number;
	readonly reconnects: number;
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
	/** One point a second, or folded to at most `HTTP_PERF_MAX_SERIES_POINTS` (values stay per second). */
	readonly series: readonly IVoltLoadSample[];
	readonly metrics: VoltLoadMetrics;
	readonly thresholds: readonly IVoltLoadThreshold[];
	readonly verdict: IVoltLoadVerdict;
	/** A model's reading of the numbers, when one was asked. */
	readonly analysis?: { readonly text: string; readonly model: string; readonly at: number };
}

export interface IHttpPerfFile {
	volt: 'perf';
	version: 1;
	name: string;
	description: string;
	mode: VoltLoadMode;
	targets: IHttpPerfTarget[];
	load: IHttpPerfLoad;
	ws: IHttpPerfWsOptions;
	thresholds: IVoltLoadThreshold[];
	confirmedHosts: IHttpPerfConfirmedHost[];
	runs: IHttpPerfRun[];
}

export const HTTP_PERF_PROFILES: readonly VoltLoadProfileKind[] = ['fixed', 'rampUp', 'spike', 'peak'];

export function defaultHttpPerfLoad(): IHttpPerfLoad {
	return { users: 10, durationSec: 30, profile: 'fixed', warmupSec: 0, thinkMs: 0, timeoutMs: 10_000, order: 'weighted' };
}

export function emptyHttpPerfFile(name: string): IHttpPerfFile {
	return {
		volt: 'perf', version: 1, name: name || 'Performance test', description: '', mode: 'http', targets: [], load: defaultHttpPerfLoad(),
		ws: { message: '', intervalMs: 1000, expectReply: false },
		thresholds: [{ metric: 'p95', op: 'lt', value: 500 }, { metric: 'errorRate', op: 'lt', value: 1 }],
		confirmedHosts: [], runs: [],
	};
}

// --- Reading and writing --------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = '', max = 10_000): string {
	return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function number(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined {
	const parsed = number(value, min, max, NaN);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseHeaders(value: unknown): [string, string][] {
	if (Array.isArray(value)) {
		return value.filter((row): row is unknown[] => Array.isArray(row) && typeof row[0] === 'string' && !!row[0].trim()).map(row => [String(row[0]).trim(), String(row[1] ?? '')] as [string, string]).slice(0, 100);
	}
	if (isRecord(value)) {
		return Object.entries(value).filter(([key]) => key.trim()).map(([key, item]) => [key.trim(), String(item ?? '')] as [string, string]).slice(0, 100);
	}
	return [];
}

function parseTarget(value: unknown, index: number): IHttpPerfTarget | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const id = text(value.id, '', 80) || `target-${index + 1}-${generateUuid().slice(0, 8)}`;
	const name = text(value.name, '', 200).trim();
	const weight = number(value.weight, 0, 1000, 1);
	const rawRef = isRecord(value.ref) ? value.ref : undefined;
	if (rawRef && typeof rawRef.collection === 'string' && rawRef.collection.trim()) {
		const path = Array.isArray(rawRef.path) ? rawRef.path.filter((part): part is string => typeof part === 'string' && !!part) : typeof rawRef.path === 'string' ? rawRef.path.split('/').filter(Boolean) : [];
		return { id, ...(name ? { name } : {}), ref: { collection: rawRef.collection.trim(), path }, weight };
	}
	const rawInline = isRecord(value.inline) ? value.inline : typeof value.url === 'string' ? value : undefined;
	if (rawInline) {
		const body = text(rawInline.body, '', 5 * 1024 * 1024);
		return {
			id, ...(name ? { name } : {}),
			inline: { method: text(rawInline.method, 'GET', 20).toUpperCase() || 'GET', url: text(rawInline.url, '', 4000).trim(), headers: parseHeaders(rawInline.headers), ...(body ? { body } : {}) },
			weight,
		};
	}
	return undefined;
}

function parseLoad(value: unknown): IHttpPerfLoad {
	const input = isRecord(value) ? value : {};
	const defaults = defaultHttpPerfLoad();
	const profile = HTTP_PERF_PROFILES.includes(input.profile as VoltLoadProfileKind) ? input.profile as VoltLoadProfileKind : 'fixed';
	const requests = optionalNumber(input.requests, 1, 100_000_000);
	const durationSec = optionalNumber(input.durationSec, 1, VOLT_LOAD_MAX_DURATION_SEC);
	const rps = optionalNumber(input.rps, 0, 1_000_000);
	const out: IHttpPerfLoad = {
		users: Math.round(number(input.users, 1, VOLT_LOAD_MAX_USERS, defaults.users)),
		...(durationSec !== undefined || requests === undefined ? { durationSec: Math.round(durationSec ?? defaults.durationSec ?? 30) } : {}),
		...(requests !== undefined && durationSec === undefined ? { requests: Math.round(requests) } : {}),
		profile,
		...optionalFields(input, ['baseUsers', 'startSec', 'rampUpSec', 'holdSec', 'rampDownSec']),
		...(rps ? { rps } : {}),
		warmupSec: Math.round(number(input.warmupSec, 0, 300, 0)),
		thinkMs: Math.round(number(input.thinkMs, 0, 600_000, 0)),
		timeoutMs: Math.round(number(input.timeoutMs, 50, 600_000, defaults.timeoutMs)),
		order: input.order === 'sequence' ? 'sequence' : 'weighted',
		...(input.insecure === true ? { insecure: true } : {}),
	};
	return out;
}

function optionalFields(input: Record<string, unknown>, keys: readonly ('baseUsers' | 'startSec' | 'rampUpSec' | 'holdSec' | 'rampDownSec')[]): Partial<IHttpPerfLoad> {
	const out: { -readonly [K in keyof IHttpPerfLoad]?: IHttpPerfLoad[K] } = {};
	for (const key of keys) {
		const value = optionalNumber(input[key], 0, key === 'baseUsers' ? VOLT_LOAD_MAX_USERS : VOLT_LOAD_MAX_DURATION_SEC);
		if (value !== undefined) {
			out[key] = Math.round(value);
		}
	}
	return out;
}

export function parseHttpPerfThresholds(value: unknown): IVoltLoadThreshold[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(isRecord).filter(item => VOLT_LOAD_METRICS.includes(item.metric as VoltLoadMetric) && VOLT_LOAD_OPERATORS.includes(item.op as VoltLoadOperator) && Number.isFinite(Number(item.value)))
		.map(item => ({ metric: item.metric as VoltLoadMetric, op: item.op as VoltLoadOperator, value: Number(item.value) })).slice(0, 20);
}

function isHistogram(value: unknown): value is IVoltLoadHistogramData {
	return isRecord(value) && typeof value.n === 'number' && Array.isArray(value.b);
}

function parseRun(value: unknown): IHttpPerfRun | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.startedAt !== 'number' || !isHistogram(value.latency) || !Array.isArray(value.series) || !isRecord(value.metrics) || !isRecord(value.verdict)) {
		return undefined;
	}
	// Written by this file's own serializer: taken as it is, the shapes checked above.
	return value as unknown as IHttpPerfRun;
}

/** Reads a file. Throws for one that is not a performance test. */
export function parseHttpPerfFile(content: string, fallbackName: string): IHttpPerfFile {
	const json: unknown = JSON.parse(content);
	if (!isRecord(json) || (json.volt !== undefined && json.volt !== 'perf')) {
		throw new Error('Not a Volt performance test file.');
	}
	const mode: VoltLoadMode = json.mode === 'ws' || json.mode === 'sse' ? json.mode : 'http';
	const ws = isRecord(json.ws) ? json.ws : {};
	return {
		volt: 'perf',
		version: 1,
		name: text(json.name, '', 200).trim() || fallbackName,
		description: text(json.description, '', 4000),
		mode,
		targets: (Array.isArray(json.targets) ? json.targets : []).map(parseTarget).filter((target): target is IHttpPerfTarget => !!target).slice(0, 50),
		load: parseLoad(json.load),
		ws: { message: text(ws.message, '', 1024 * 1024), intervalMs: Math.round(number(ws.intervalMs, 10, 600_000, 1000)), expectReply: ws.expectReply === true },
		thresholds: Array.isArray(json.thresholds) ? parseHttpPerfThresholds(json.thresholds) : [],
		confirmedHosts: (Array.isArray(json.confirmedHosts) ? json.confirmedHosts : [])
			.map(item => typeof item === 'string' ? { host: item, at: '' } : isRecord(item) && typeof item.host === 'string' ? { host: item.host, at: text(item.at, '', 40) } : undefined)
			.filter((item): item is IHttpPerfConfirmedHost => !!item && !!item.host.trim()).map(item => ({ host: item.host.trim().toLowerCase(), at: item.at })),
		runs: (Array.isArray(json.runs) ? json.runs : []).map(parseRun).filter((run): run is IHttpPerfRun => !!run).slice(0, HTTP_PERF_MAX_RUNS),
	};
}

/** The file as text: the definition indented, each run on one line (a run is mostly numbers). */
export function serializeHttpPerfFile(file: IHttpPerfFile): string {
	const { runs, volt: _volt, version: _version, ...definition } = file;
	const head = JSON.stringify({ volt: 'perf', version: 1, ...definition }, null, '\t');
	const lines = runs.slice(0, HTTP_PERF_MAX_RUNS).map(run => `\t\t${JSON.stringify(run)}`);
	return `${head.slice(0, head.lastIndexOf('\n}'))},\n\t"runs": [${lines.length ? `\n${lines.join(',\n')}\n\t` : ''}]\n}\n`;
}

/**
 * A definition as an agent (or an import) gives it, read with the same checks as a file. Confirmed
 * hosts and runs are never taken from it.
 */
export function parseHttpPerfDefinition(definition: unknown, fallbackName: string): Omit<IHttpPerfFile, 'confirmedHosts' | 'runs'> {
	if (!isRecord(definition)) {
		throw new Error('A performance test definition is a JSON object: { name, mode, targets, load, ws, thresholds }.');
	}
	const parsed = parseHttpPerfFile(JSON.stringify({ ...definition, volt: 'perf', confirmedHosts: [], runs: [] }), fallbackName);
	const { confirmedHosts: _hosts, runs: _runs, ...rest } = parsed;
	return rest;
}

// --- Hosts ------------------------------------------------------------------------------------------

/** The host (no port) a URL goes to, lowercase; undefined for what is not a URL. */
export function httpPerfHostOf(url: string): string | undefined {
	const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
	try {
		return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

/** This machine, a private network, or a name only a local resolver answers: no confirmation needed. */
export function isHttpPerfLocalHost(host: string): boolean {
	const name = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (name === 'localhost' || name === '::1' || name === '0.0.0.0' || name === '::' || /\.(?:localhost|local|test|internal|lan|home\.arpa)$/.test(name)) {
		return true;
	}
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
	}
	// IPv6 unique local (fc00::/7), link local (fe80::/10), and IPv4-mapped private addresses.
	if (/^f[cd][0-9a-f]{2}:/.test(name) || /^fe[89ab][0-9a-f]:/.test(name)) {
		return true;
	}
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
	return !!mapped && isHttpPerfLocalHost(mapped[1]);
}

/** The hosts of `urls` that are neither local nor already confirmed in the file. */
export function httpPerfHostsToConfirm(urls: readonly string[], confirmed: readonly IHttpPerfConfirmedHost[]): string[] {
	const known = new Set(confirmed.map(item => item.host.toLowerCase()));
	const out = new Set<string>();
	for (const url of urls) {
		const host = httpPerfHostOf(url);
		if (host && !isHttpPerfLocalHost(host) && !known.has(host)) {
			out.add(host);
		}
	}
	return [...out].sort();
}

// --- From the file to the engine ------------------------------------------------------------------

/** The engine's dynamic tokens (`{{$guid}}`, `{{$vu}}`, ...): filled on every send, so never by the client. */
export const HTTP_PERF_ENGINE_TOKEN = /\{\{\s*\$(?:guid|timestamp|isoTimestamp|randomInt|vu|iteration)(?:\s+-?\d+){0,2}\s*\}\}/g;

/**
 * Fills `{{variables}}` with `resolve`, leaving the engine's dynamic tokens as written.
 * `resolve` is the client's variable resolution (environment, collection, globals).
 */
export function resolveHttpPerfText(template: string, resolve: (text: string) => string): string {
	let out = '';
	let at = 0;
	for (const match of template.matchAll(HTTP_PERF_ENGINE_TOKEN)) {
		out += resolve(template.slice(at, match.index)) + match[0];
		at = match.index + match[0].length;
	}
	return out + resolve(template.slice(at));
}

/** The `{{names}}` still in `text` that are not the engine's tokens. */
export function httpPerfUnresolved(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.replace(HTTP_PERF_ENGINE_TOKEN, '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
		names.add(match[1]);
	}
	return [...names];
}

/** What a run is limited to beyond the file (an agent's run). */
export interface IHttpPerfCaps {
	readonly maxUsers: number;
	readonly maxSeconds: number;
}

/** The engine's spec for the file and its prepared targets; `caps` lower users and time (an agent's run). */
export function httpPerfSpec(file: Pick<IHttpPerfFile, 'mode' | 'load' | 'ws'>, targets: readonly IVoltLoadTarget[], caps?: IHttpPerfCaps): IVoltLoadSpec {
	const load = file.load;
	const users = Math.min(load.users, caps?.maxUsers ?? VOLT_LOAD_MAX_USERS);
	const byCount = file.mode === 'http' && !load.durationSec && !!load.requests;
	const warmupSec = caps ? Math.min(load.warmupSec, Math.floor(caps.maxSeconds / 4)) : load.warmupSec;
	const room = caps ? Math.max(1, caps.maxSeconds - warmupSec) : undefined;
	const durationSec = byCount ? room : Math.min(load.durationSec ?? 30, room ?? Infinity);
	const profile: IVoltLoadProfile | undefined = byCount ? undefined : {
		kind: load.profile,
		...(load.baseUsers !== undefined ? { baseUsers: Math.min(load.baseUsers, users) } : {}),
		...(load.startSec !== undefined ? { startSec: load.startSec } : {}),
		...(load.rampUpSec !== undefined ? { rampUpSec: load.rampUpSec } : {}),
		...(load.holdSec !== undefined ? { holdSec: load.holdSec } : {}),
		...(load.rampDownSec !== undefined ? { rampDownSec: load.rampDownSec } : {}),
	};
	return {
		mode: file.mode,
		targets,
		order: load.order,
		users,
		...(durationSec !== undefined ? { durationSec } : {}),
		...(byCount ? { requests: load.requests } : {}),
		...(profile ? { profile } : {}),
		...(load.rps && file.mode === 'http' ? { rps: load.rps } : {}),
		warmupSec,
		thinkMs: load.thinkMs,
		timeoutMs: load.timeoutMs,
		...(load.insecure ? { insecure: true } : {}),
		...(file.mode === 'ws' ? { ws: { ...(file.ws.message ? { message: file.ws.message } : {}), intervalMs: file.ws.intervalMs, expectReply: file.ws.expectReply } } : {}),
	};
}

// --- Results ----------------------------------------------------------------------------------------

/**
 * A series folded to at most `max` points: each point stands for consecutive seconds, its counts
 * and bytes averaged per second (so a point still reads "per second"), mean and p50 weighted by
 * count, p95, p99 and users the highest of the seconds (a spike stays visible).
 */
export function downsampleHttpPerfSeries(series: readonly IVoltLoadSample[], max = HTTP_PERF_MAX_SERIES_POINTS): IVoltLoadSample[] {
	if (series.length <= max) {
		return [...series];
	}
	const size = Math.ceil(series.length / max);
	const out: IVoltLoadSample[] = [];
	for (let start = 0; start < series.length; start += size) {
		const chunk = series.slice(start, start + size);
		const n = chunk.length;
		const weight = chunk.reduce((sum, sample) => sum + sample.count, 0);
		const weighted = (pick: (sample: IVoltLoadSample) => number) => weight ? chunk.reduce((sum, sample) => sum + pick(sample) * sample.count, 0) / weight : 0;
		const sent = chunk.some(sample => sample.sent !== undefined) ? chunk.reduce((sum, sample) => sum + (sample.sent ?? 0), 0) / n : undefined;
		out.push({
			t: chunk[n - 1].t,
			users: Math.max(...chunk.map(sample => sample.users)),
			count: weight / n,
			errors: chunk.reduce((sum, sample) => sum + sample.errors, 0) / n,
			mean: weighted(sample => sample.mean),
			p50: weighted(sample => sample.p50),
			p95: Math.max(...chunk.map(sample => sample.p95)),
			p99: Math.max(...chunk.map(sample => sample.p99)),
			bytesIn: chunk.reduce((sum, sample) => sum + sample.bytesIn, 0) / n,
			bytesOut: chunk.reduce((sum, sample) => sum + sample.bytesOut, 0) / n,
			...(sent !== undefined ? { sent } : {}),
			...(chunk.every(sample => sample.warmup) ? { warmup: true } : {}),
		});
	}
	return out;
}

/** A finished run as the file keeps it. */
export function summarizeHttpPerfRun(result: IVoltLoadResult, thresholds: readonly IVoltLoadThreshold[], config: IHttpPerfRunConfig, id = generateUuid()): IHttpPerfRun {
	const metrics = voltLoadMetrics(result);
	const { series, ...rest } = result;
	return {
		...rest,
		id,
		config,
		series: downsampleHttpPerfSeries(series),
		metrics,
		thresholds: [...thresholds],
		verdict: evaluateVoltLoadThresholds(thresholds, metrics),
	};
}

/** Runs newest first, at most `HTTP_PERF_MAX_RUNS`. */
export function addHttpPerfRun(runs: readonly IHttpPerfRun[], run: IHttpPerfRun): IHttpPerfRun[] {
	return [run, ...runs.filter(item => item.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, HTTP_PERF_MAX_RUNS);
}

export type HttpPerfCompareKey = 'rps' | 'mean' | 'p50' | 'p95' | 'p99' | 'max' | 'errorRate' | 'count' | 'bytesIn' | 'peakUsers';

export interface IHttpPerfDelta {
	readonly key: HttpPerfCompareKey;
	readonly before: number;
	readonly after: number;
	/** after - before. */
	readonly delta: number;
	/** The change in percent of `before`; undefined when `before` is 0. */
	readonly percent?: number;
	/** Whether the change is for the better; undefined when nothing changed or it is neither (a count). */
	readonly better?: boolean;
}

const HIGHER_IS_BETTER: Partial<Record<HttpPerfCompareKey, boolean>> = { rps: true, mean: false, p50: false, p95: false, p99: false, max: false, errorRate: false };

export function httpPerfValue(run: IHttpPerfRun, key: HttpPerfCompareKey): number {
	switch (key) {
		case 'count': return run.count;
		case 'bytesIn': return run.bytesIn;
		case 'peakUsers': return run.peakUsers;
		default: return run.metrics[key];
	}
}

/** How `after` differs from `before`, metric by metric. */
export function compareHttpPerfRuns(before: IHttpPerfRun, after: IHttpPerfRun): IHttpPerfDelta[] {
	const keys: HttpPerfCompareKey[] = ['rps', 'mean', 'p50', 'p95', 'p99', 'max', 'errorRate', 'count', 'bytesIn', 'peakUsers'];
	return keys.map(key => {
		const a = httpPerfValue(before, key);
		const b = httpPerfValue(after, key);
		const delta = b - a;
		const higher = HIGHER_IS_BETTER[key];
		// Less than half a percent either way is noise, not a change.
		const same = Math.abs(delta) <= Math.max(1e-9, Math.abs(a) * 0.005);
		return {
			key, before: a, after: b, delta,
			...(a !== 0 ? { percent: delta / Math.abs(a) * 100 } : {}),
			...(higher !== undefined && !same ? { better: higher ? delta > 0 : delta < 0 } : {}),
		};
	});
}

/** The live numbers of a run in progress, from its seconds so far. */
export interface IHttpPerfLiveNumbers {
	readonly rate: number;
	readonly mean: number;
	readonly p95: number;
	readonly p99: number;
	readonly errorRate: number;
	readonly count: number;
	readonly bytesIn: number;
	readonly peakUsers: number;
}

/** What a run in progress looks like so far (warm-up left out). Percentiles are the seconds' own, weighted: close, not exact. */
export function httpPerfLiveNumbers(samples: readonly IVoltLoadSample[]): IHttpPerfLiveNumbers {
	const measured = samples.filter(sample => !sample.warmup);
	const count = measured.reduce((sum, sample) => sum + sample.count, 0);
	const weighted = (pick: (sample: IVoltLoadSample) => number) => count ? measured.reduce((sum, sample) => sum + pick(sample) * sample.count, 0) / count : 0;
	const errors = measured.reduce((sum, sample) => sum + sample.errors, 0);
	return {
		rate: measured.length ? count / measured.length : 0,
		mean: weighted(sample => sample.mean),
		p95: weighted(sample => sample.p95),
		p99: measured.reduce((max, sample) => Math.max(max, sample.p99), 0),
		errorRate: count ? Math.min(100, errors / count * 100) : 0,
		count,
		bytesIn: measured.reduce((sum, sample) => sum + sample.bytesIn, 0),
		peakUsers: samples.reduce((max, sample) => Math.max(max, sample.users), 0),
	};
}

// --- Formatting -------------------------------------------------------------------------------------

export function formatHttpPerfMs(ms: number): string {
	if (!Number.isFinite(ms)) {
		return '-';
	}
	if (ms >= 10_000) {
		return `${(ms / 1000).toFixed(1)} s`;
	}
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(2)} s`;
	}
	if (ms >= 100) {
		return `${Math.round(ms)} ms`;
	}
	if (ms >= 10) {
		return `${ms.toFixed(1)} ms`;
	}
	return `${ms.toFixed(2)} ms`;
}

export function formatHttpPerfNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return '-';
	}
	const abs = Math.abs(value);
	if (abs >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
	}
	if (abs >= 10_000) {
		return `${(value / 1000).toFixed(1)}k`;
	}
	return abs >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(abs >= 10 ? 1 : 2);
}

export function formatHttpPerfBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	}
	if (bytes >= 1024 * 1024) {
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes)} B`;
}

export function formatHttpPerfPercent(value: number): string {
	return value === 0 ? '0%' : value < 0.01 ? '<0.01%' : value < 10 ? `${value.toFixed(2)}%` : `${value.toFixed(1)}%`;
}

export function formatHttpPerfSeconds(seconds: number): string {
	const whole = Math.max(0, Math.round(seconds));
	return whole >= 60 ? `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s` : `${whole}s`;
}

const METRIC_LABELS: Readonly<Record<VoltLoadMetric, string>> = { p50: 'p50', p95: 'p95', p99: 'p99', mean: 'Mean', max: 'Max', errorRate: 'Error rate', rps: 'Requests/s' };
const OPERATOR_TEXT: Readonly<Record<VoltLoadOperator, string>> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

export function httpPerfMetricLabel(metric: VoltLoadMetric, mode: VoltLoadMode = 'http'): string {
	return metric === 'rps' && mode !== 'http' ? (mode === 'ws' ? 'Messages/s' : 'Events/s') : METRIC_LABELS[metric];
}

export function formatHttpPerfMetric(metric: VoltLoadMetric, value: number): string {
	return metric === 'errorRate' ? formatHttpPerfPercent(value) : metric === 'rps' ? `${formatHttpPerfNumber(value)}/s` : formatHttpPerfMs(value);
}

export function httpPerfThresholdText(threshold: IVoltLoadThreshold, mode: VoltLoadMode = 'http'): string {
	return `${httpPerfMetricLabel(threshold.metric, mode)} ${OPERATOR_TEXT[threshold.op]} ${formatHttpPerfMetric(threshold.metric, threshold.value)}`;
}

export function httpPerfOperatorText(op: VoltLoadOperator): string {
	return OPERATOR_TEXT[op];
}

/** What one unit of the run's count is. */
export function httpPerfUnit(mode: VoltLoadMode): { readonly one: string; readonly many: string; readonly rate: string } {
	return mode === 'ws' ? { one: 'message', many: 'messages', rate: 'msg/s' } : mode === 'sse' ? { one: 'event', many: 'events', rate: 'events/s' } : { one: 'request', many: 'requests', rate: 'req/s' };
}

/** The sidebar's second line: "50 users, 30 s" or "WebSocket, 200 connections, 1m 00s". */
export function httpPerfDetail(file: IHttpPerfFile): string {
	const load = file.load;
	const who = file.mode === 'http' ? `${load.users} ${load.users === 1 ? 'user' : 'users'}` : `${load.users} ${load.users === 1 ? 'connection' : 'connections'}`;
	const length = file.mode === 'http' && !load.durationSec && load.requests ? `${formatHttpPerfNumber(load.requests)} requests` : formatHttpPerfSeconds(load.durationSec ?? 30);
	const last = file.runs[0];
	const verdict = last ? (last.verdict.passed ? ', passed' : ', failed') : '';
	return `${file.mode === 'ws' ? 'WebSocket, ' : file.mode === 'sse' ? 'SSE, ' : ''}${who}, ${length}${verdict}`;
}

export function httpPerfStatusClass(code: string): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
	const status = Number(code);
	return status >= 200 && status < 300 || status === 101 ? '2xx' : status >= 300 && status < 400 ? '3xx' : status >= 400 && status < 500 ? '4xx' : status >= 500 && status < 600 ? '5xx' : 'other';
}

export function httpPerfStatusClasses(codes: Readonly<Record<string, number>>): Record<'2xx' | '3xx' | '4xx' | '5xx' | 'other', number> {
	const out = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
	for (const [code, count] of Object.entries(codes)) {
		out[httpPerfStatusClass(code)] += count;
	}
	return out;
}

const ERROR_KIND_LABELS: Readonly<Record<VoltLoadErrorKind, string>> = { timeout: 'Timeout', refused: 'Connection refused', reset: 'Connection reset', dns: 'DNS lookup failed', tls: 'TLS / certificate', other: 'Other' };

export function httpPerfErrorKindLabel(kind: VoltLoadErrorKind): string {
	return ERROR_KIND_LABELS[kind] ?? kind;
}

export const HTTP_PERF_PHASES: readonly { readonly key: 'dns' | 'tcp' | 'tls' | 'ttfb' | 'download' | 'connect'; readonly label: string }[] = [
	{ key: 'connect', label: 'Connect' },
	{ key: 'dns', label: 'DNS lookup' },
	{ key: 'tcp', label: 'TCP connect' },
	{ key: 'tls', label: 'TLS handshake' },
	{ key: 'ttfb', label: 'Time to first byte' },
	{ key: 'download', label: 'Download' },
];

/** What the latency of a mode measures. */
export function httpPerfLatencyLabel(mode: VoltLoadMode): string {
	return mode === 'ws' ? 'Round trip' : mode === 'sse' ? 'Time to first event' : 'Latency';
}

// --- Text summaries ---------------------------------------------------------------------------------

/** A run in a few lines of plain text: for agents and for the model that reads the numbers. */
export function httpPerfRunText(file: Pick<IHttpPerfFile, 'name' | 'mode'>, run: IHttpPerfRun): string {
	const unit = httpPerfUnit(run.mode);
	const p = voltLoadPercentiles(run.latency);
	const lines = [
		`${file.name}: ${run.verdict.passed ? 'PASSED' : 'FAILED'}${run.ended === 'stopped' ? ' (stopped early)' : ''}`,
		`Run ${new Date(run.startedAt).toISOString()}, ${run.mode.toUpperCase()}, ${run.config.users} ${run.mode === 'http' ? 'users' : 'connections'} (${run.config.profile}), ${formatHttpPerfSeconds(run.measuredSec)} measured${run.config.warmupSec ? ` after ${run.config.warmupSec}s warm-up` : ''}${run.config.rps ? `, capped at ${run.config.rps} req/s` : ''}, peak ${run.peakUsers} active.`,
		`Throughput: ${formatHttpPerfNumber(run.rate)} ${unit.rate}, ${run.count} ${unit.many} in total.`,
		`${httpPerfLatencyLabel(run.mode)}: min ${formatHttpPerfMs(p.min)}, mean ${formatHttpPerfMs(p.mean)} (sd ${formatHttpPerfMs(p.stddev)}), p50 ${formatHttpPerfMs(p.p50)}, p90 ${formatHttpPerfMs(p.p90)}, p95 ${formatHttpPerfMs(p.p95)}, p99 ${formatHttpPerfMs(p.p99)}, p99.9 ${formatHttpPerfMs(p.p999)}, max ${formatHttpPerfMs(p.max)} (${p.count} samples).`,
		`Errors: ${formatHttpPerfPercent(run.metrics.errorRate)}${run.mode === 'http' ? ` (${run.errors} network, ${run.httpErrors} HTTP 4xx/5xx)` : ` (${run.connectFailures} failed connects)`}.`,
		`Data: ${formatHttpPerfBytes(run.bytesIn)} in, ${formatHttpPerfBytes(run.bytesOut)} out.`,
	];
	const codes = Object.entries(run.statusCodes).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code} x${count}`);
	if (codes.length) {
		lines.push(`Status codes: ${codes.join(', ')}.`);
	}
	const kinds = Object.entries(run.errorKinds).filter(([, count]) => count).map(([kind, count]) => `${httpPerfErrorKindLabel(kind as VoltLoadErrorKind)} x${count}`);
	if (kinds.length) {
		lines.push(`Error kinds: ${kinds.join(', ')}.`);
	}
	if (run.mode !== 'http') {
		lines.push(`Connections: ${run.connects} opened, ${run.connectFailures} failed, ${run.closes} closed by the server, ${run.reconnects} reconnects${run.mode === 'ws' ? `; ${run.sent} messages sent` : ''}.`);
	}
	const phases = HTTP_PERF_PHASES.filter(phase => run[phase.key]?.n).map(phase => `${phase.label} p50 ${formatHttpPerfMs(voltLoadPercentiles(run[phase.key]).p50)} / p95 ${formatHttpPerfMs(voltLoadPercentiles(run[phase.key]).p95)}`);
	if (phases.length) {
		lines.push(`Phases: ${phases.join('; ')}.`);
	}
	if (run.targets.length > 1) {
		lines.push('Per target:');
		for (const target of run.targets) {
			const tp = voltLoadPercentiles(target.latency);
			lines.push(`- ${target.name}: ${target.count} ${unit.many}, ${target.errors} errors, p50 ${formatHttpPerfMs(tp.p50)}, p95 ${formatHttpPerfMs(tp.p95)}, p99 ${formatHttpPerfMs(tp.p99)}`);
		}
	}
	if (run.verdict.results.length) {
		lines.push('Thresholds:');
		for (const item of run.verdict.results) {
			lines.push(`- ${httpPerfThresholdText(item.threshold, run.mode)}: ${item.passed ? 'pass' : 'FAIL'} (actual ${formatHttpPerfMetric(item.threshold.metric, item.actual)})`);
		}
	}
	return lines.join('\n');
}

/**
 * What the model is asked to read: numbers only (no URLs' secrets, no headers or bodies), with the
 * shape of the run over time and the run before for comparison.
 */
export function httpPerfAnalysisPrompt(file: Pick<IHttpPerfFile, 'name' | 'mode'>, run: IHttpPerfRun, previous?: IHttpPerfRun): string {
	const step = Math.max(1, Math.ceil(run.series.length / 30));
	const timeline = run.series.filter((_sample, index) => index % step === 0 || index === run.series.length - 1)
		.map(sample => `t=${sample.t}s users=${sample.users} rate=${formatHttpPerfNumber(sample.count)}/s errors=${formatHttpPerfNumber(sample.errors)}/s mean=${formatHttpPerfMs(sample.mean)} p95=${formatHttpPerfMs(sample.p95)} p99=${formatHttpPerfMs(sample.p99)}${sample.warmup ? ' (warm-up)' : ''}`);
	const parts = [
		'Read the results of this load test and give a short assessment (at most 200 words, plain sentences, a few short bullet points allowed):',
		'1. What the numbers say (throughput, latency spread, errors, and whether latency grows with load).',
		'2. The likely bottlenecks, with the numbers that point to them.',
		'3. What to try next (a change to the system or to the test).',
		'Do not repeat the numbers back as a table. Say plainly when the data is too thin to tell.',
		'',
		httpPerfRunText({ ...file, name: 'The test' }, { ...run, targets: run.targets.map((target, index) => ({ ...target, name: `Target ${index + 1} (${target.method})` })) }),
		'',
		'Over time:',
		...timeline,
	];
	if (previous) {
		parts.push('', 'Compared with the run before:');
		for (const delta of compareHttpPerfRuns(previous, run).filter(item => ['rps', 'p50', 'p95', 'p99', 'errorRate'].includes(item.key))) {
			parts.push(`- ${delta.key}: ${formatHttpPerfNumber(delta.before)} -> ${formatHttpPerfNumber(delta.after)}`);
		}
	}
	return parts.join('\n');
}

// --- Reports ----------------------------------------------------------------------------------------

function mdCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
	return [`| ${head.map(mdCell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(mdCell).join(' | ')} |`)].join('\n');
}

function deltaText(delta: IHttpPerfDelta | undefined): string {
	if (!delta || delta.percent === undefined || delta.better === undefined) {
		return '';
	}
	return `${delta.percent >= 0 ? '+' : ''}${delta.percent.toFixed(1)}% (${delta.better ? 'better' : 'worse'})`;
}

/** The run as a Markdown report. */
export function httpPerfMarkdownReport(file: Pick<IHttpPerfFile, 'name' | 'description' | 'mode'>, run: IHttpPerfRun, previous?: IHttpPerfRun): string {
	const unit = httpPerfUnit(run.mode);
	const p = voltLoadPercentiles(run.latency);
	const deltas = previous ? compareHttpPerfRuns(previous, run) : [];
	const delta = (key: HttpPerfCompareKey) => deltaText(deltas.find(item => item.key === key));
	const out: string[] = [
		`# ${file.name}: performance report`,
		'',
		...(file.description.trim() ? [file.description.trim(), ''] : []),
		`**${run.verdict.passed ? 'Passed' : 'Failed'}**${run.ended === 'stopped' ? ' (stopped early)' : ''} - ${new Date(run.startedAt).toISOString()} - ${run.mode.toUpperCase()} - ${run.config.users} ${run.mode === 'http' ? 'virtual users' : 'connections'}, ${run.config.profile} profile, ${formatHttpPerfSeconds(run.measuredSec)} measured${run.config.warmupSec ? ` after a ${run.config.warmupSec}s warm-up` : ''}`,
		'',
		'## Summary',
		'',
		mdTable(['Metric', 'Value', ...(previous ? ['vs previous run'] : [])], [
			[`${unit.many[0].toUpperCase()}${unit.many.slice(1)}/s`, formatHttpPerfNumber(run.rate), ...(previous ? [delta('rps')] : [])],
			['Mean', formatHttpPerfMs(p.mean), ...(previous ? [delta('mean')] : [])],
			['p95', formatHttpPerfMs(p.p95), ...(previous ? [delta('p95')] : [])],
			['p99', formatHttpPerfMs(p.p99), ...(previous ? [delta('p99')] : [])],
			['Error rate', formatHttpPerfPercent(run.metrics.errorRate), ...(previous ? [delta('errorRate')] : [])],
			[`Total ${unit.many}`, String(run.count), ...(previous ? [delta('count')] : [])],
			['Data received', formatHttpPerfBytes(run.bytesIn), ...(previous ? [delta('bytesIn')] : [])],
			['Data sent', formatHttpPerfBytes(run.bytesOut), ...(previous ? [''] : [])],
			['Peak users', String(run.peakUsers), ...(previous ? [delta('peakUsers')] : [])],
		]),
	];
	if (run.verdict.results.length) {
		out.push('', '## Thresholds', '', mdTable(['Threshold', 'Actual', 'Result'], run.verdict.results.map(item => [httpPerfThresholdText(item.threshold, run.mode), formatHttpPerfMetric(item.threshold.metric, item.actual), item.passed ? 'Pass' : 'Fail'])));
	}
	out.push('', `## ${httpPerfLatencyLabel(run.mode)}`, '', mdTable(['min', 'p50', 'p75', 'p90', 'p95', 'p97.5', 'p99', 'p99.9', 'max', 'mean', 'stddev'], [[p.min, p.p50, p.p75, p.p90, p.p95, p.p975, p.p99, p.p999, p.max, p.mean, p.stddev].map(formatHttpPerfMs)]));
	if (run.targets.length) {
		out.push('', '## Targets', '', mdTable(['Target', 'Method', unit.many, 'Errors', 'p50', 'p95', 'p99', 'Received'], run.targets.map(target => {
			const tp = voltLoadPercentiles(target.latency);
			return [target.name, target.method, String(target.count), String(target.errors), formatHttpPerfMs(tp.p50), formatHttpPerfMs(tp.p95), formatHttpPerfMs(tp.p99), formatHttpPerfBytes(target.bytesIn)];
		})));
	}
	const codes = Object.entries(run.statusCodes).sort((a, b) => a[0].localeCompare(b[0]));
	if (codes.length) {
		out.push('', '## Status codes', '', mdTable(['Status', 'Count'], codes.map(([code, count]) => [code, String(count)])));
	}
	const kinds = Object.entries(run.errorKinds).filter(([, count]) => count);
	if (kinds.length) {
		out.push('', '## Errors', '', mdTable(['Kind', 'Count'], kinds.map(([kind, count]) => [httpPerfErrorKindLabel(kind as VoltLoadErrorKind), String(count)])));
	}
	const phases = HTTP_PERF_PHASES.filter(phase => run[phase.key]?.n);
	if (phases.length) {
		out.push('', '## Timing phases', '', mdTable(['Phase', 'Samples', 'p50', 'p95', 'p99', 'max'], phases.map(phase => {
			const pp = voltLoadPercentiles(run[phase.key]);
			return [phase.label, String(pp.count), formatHttpPerfMs(pp.p50), formatHttpPerfMs(pp.p95), formatHttpPerfMs(pp.p99), formatHttpPerfMs(pp.max)];
		})));
	}
	if (run.mode !== 'http') {
		out.push('', '## Connections', '', mdTable(['Opened', 'Failed', 'Closed by server', 'Reconnects', ...(run.mode === 'ws' ? ['Messages sent'] : [])], [[String(run.connects), String(run.connectFailures), String(run.closes), String(run.reconnects), ...(run.mode === 'ws' ? [String(run.sent)] : [])]]));
	}
	if (run.series.length) {
		const step = Math.max(1, Math.ceil(run.series.length / 30));
		out.push('', '## Over time', '', mdTable(['Second', 'Users', unit.rate, 'Errors/s', 'Mean', 'p95', 'p99'], run.series.filter((_s, index) => index % step === 0 || index === run.series.length - 1).map(sample => [`${sample.t}${sample.warmup ? ' (warm-up)' : ''}`, String(sample.users), formatHttpPerfNumber(sample.count), formatHttpPerfNumber(sample.errors), formatHttpPerfMs(sample.mean), formatHttpPerfMs(sample.p95), formatHttpPerfMs(sample.p99)])));
	}
	if (run.analysis?.text) {
		out.push('', '## Assessment', '', `_${run.analysis.model}_`, '', run.analysis.text.trim());
	}
	return `${out.join('\n')}\n`;
}

/** The run as JSON: the definition's name and mode, the run, and the comparison with the one before. */
export function httpPerfJsonReport(file: Pick<IHttpPerfFile, 'name' | 'description' | 'mode'>, run: IHttpPerfRun, previous?: IHttpPerfRun): string {
	const latency = voltLoadPercentiles(run.latency);
	return `${JSON.stringify({
		name: file.name, description: file.description, mode: run.mode, verdict: run.verdict.passed ? 'passed' : 'failed',
		latency, phases: Object.fromEntries(HTTP_PERF_PHASES.filter(phase => run[phase.key]?.n).map(phase => [phase.key, voltLoadPercentiles(run[phase.key])])),
		targets: run.targets.map(target => ({ name: target.name, method: target.method, count: target.count, errors: target.errors, bytesIn: target.bytesIn, statusCodes: target.statusCodes, latency: voltLoadPercentiles(target.latency) })),
		...(previous ? { comparedWith: previous.id, deltas: compareHttpPerfRuns(previous, run) } : {}),
		run,
	}, null, '\t')}\n`;
}

// --- The HTML report: one file, its charts inline SVG ----------------------------------------------

function esc(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function niceMax(value: number): number {
	if (!(value > 0)) {
		return 1;
	}
	const power = 10 ** Math.floor(Math.log10(value));
	for (const step of [1, 2, 2.5, 5, 10]) {
		if (step * power >= value) {
			return step * power;
		}
	}
	return 10 * power;
}

interface ISvgSeries { readonly label: string; readonly color: string; readonly values: readonly number[]; readonly dashed?: boolean }

function svgLineChart(title: string, xs: readonly number[], series: readonly ISvgSeries[], format: (value: number) => string): string {
	const width = 640, height = 220, left = 56, right = 12, top = 12, bottom = 26;
	const plotW = width - left - right, plotH = height - top - bottom;
	const maxX = Math.max(1, ...xs);
	const maxY = niceMax(Math.max(0, ...series.flatMap(item => item.values.filter(Number.isFinite))));
	const x = (value: number) => left + value / maxX * plotW;
	const y = (value: number) => top + plotH - value / maxY * plotH;
	const grid: string[] = [];
	for (let at = 0; at <= 4; at++) {
		const value = maxY * at / 4;
		grid.push(`<line x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="grid"/><text x="${left - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${esc(format(value))}</text>`);
	}
	for (let at = 0; at <= 4; at++) {
		const value = maxX * at / 4;
		grid.push(`<text x="${x(value).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(formatHttpPerfSeconds(value))}</text>`);
	}
	const lines = series.map(item => {
		const points = item.values.map((value, index) => `${x(xs[index]).toFixed(1)},${y(Number.isFinite(value) ? value : 0).toFixed(1)}`).join(' ');
		return `<polyline fill="none" stroke="${item.color}" stroke-width="2" stroke-linejoin="round"${item.dashed ? ' stroke-dasharray="4 3"' : ''} points="${points}"/>`;
	});
	const legend = series.map(item => `<span class="key"><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join('');
	return `<figure><figcaption>${esc(title)}</figcaption><div class="legend">${legend}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${grid.join('')}${lines.join('')}</svg></figure>`;
}

function svgHistogram(title: string, run: IHttpPerfRun): string {
	const histogram = VoltLoadHistogram.from(run.latency);
	const bins = httpPerfHistogramBins(histogram, 40);
	if (!bins.length) {
		return '';
	}
	const width = 640, height = 200, left = 48, right = 12, top = 22, bottom = 26;
	const plotW = width - left - right, plotH = height - top - bottom;
	const maxCount = niceMax(Math.max(...bins.map(bin => bin.count)));
	const barW = plotW / bins.length;
	const bars = bins.map((bin, index) => {
		const h = bin.count / maxCount * plotH;
		return `<rect x="${(left + index * barW + 1).toFixed(1)}" y="${(top + plotH - h).toFixed(1)}" width="${Math.max(1, barW - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#4f8cff"><title>${esc(`${formatHttpPerfMs(bin.from)} to ${formatHttpPerfMs(bin.to)}: ${bin.count}`)}</title></rect>`;
	});
	const p = voltLoadPercentiles(histogram);
	const position = (value: number) => {
		const index = bins.findIndex(bin => value < bin.to);
		const bin = bins[index < 0 ? bins.length - 1 : index];
		const within = bin.to > bin.from ? Math.min(1, Math.max(0, (value - bin.from) / (bin.to - bin.from))) : 0.5;
		return left + ((index < 0 ? bins.length - 1 : index) + within) * barW;
	};
	const markers = ([['p50', p.p50], ['p95', p.p95], ['p99', p.p99]] as const).map(([label, value]) => {
		const at = position(value).toFixed(1);
		return `<line x1="${at}" x2="${at}" y1="${top - 4}" y2="${top + plotH}" class="marker"/><text x="${at}" y="${top - 8}" text-anchor="middle">${label}</text>`;
	});
	const axis = [0, Math.floor(bins.length / 2), bins.length - 1].map(index => `<text x="${(left + (index + 0.5) * barW).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(formatHttpPerfMs(bins[index].from))}</text>`);
	return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}"><line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" class="grid"/>${bars.join('')}${markers.join('')}${axis.join('')}<text x="${left - 6}" y="${top + 4}" text-anchor="end">${maxCount}</text></svg></figure>`;
}

/** A histogram's values gathered into at most `max` bins on a log scale (a latency's spread reads best that way). */
export function httpPerfHistogramBins(histogram: VoltLoadHistogram, max = 40): { readonly from: number; readonly to: number; readonly count: number }[] {
	const buckets = histogram.buckets();
	if (!buckets.length) {
		return [];
	}
	const low = Math.max(0.001, buckets[0].from);
	const high = Math.max(low * 1.0001, buckets[buckets.length - 1].to);
	const count = Math.max(1, Math.min(max, buckets.length));
	const ratio = Math.log(high / low);
	const bins = Array.from({ length: count }, (_value, index) => ({ from: low * Math.exp(ratio * index / count), to: low * Math.exp(ratio * (index + 1) / count), count: 0 }));
	for (const bucket of buckets) {
		const middle = Math.max(low, (bucket.from + bucket.to) / 2);
		const index = Math.min(count - 1, Math.max(0, Math.floor(Math.log(middle / low) / ratio * count)));
		bins[index].count += bucket.count;
	}
	return bins;
}

function htmlTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
	return `<table><thead><tr>${head.map(cell => `<th>${esc(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/**
 * The run as one self-contained HTML page (styles and SVG charts inline, no scripts): written to a
 * file the user opens in a browser or shares. Never put into Volt's own DOM.
 */
export function httpPerfHtmlReport(file: Pick<IHttpPerfFile, 'name' | 'description' | 'mode'>, run: IHttpPerfRun, previous?: IHttpPerfRun): string {
	const unit = httpPerfUnit(run.mode);
	const p = voltLoadPercentiles(run.latency);
	const deltas = previous ? compareHttpPerfRuns(previous, run) : [];
	const card = (label: string, value: string, key?: HttpPerfCompareKey) => {
		const delta = key ? deltas.find(item => item.key === key) : undefined;
		const note = deltaText(delta);
		return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="delta ${delta?.better ? 'good' : 'bad'}">${esc(note)}</div>` : ''}</div>`;
	};
	const xs = run.series.map(sample => sample.t);
	const charts = run.series.length ? [
		svgLineChart(`Throughput (${unit.rate}) and active users`, xs, [
			{ label: unit.rate, color: '#4f8cff', values: run.series.map(sample => sample.count) },
			{ label: 'errors/s', color: '#f85149', values: run.series.map(sample => sample.errors) },
			{ label: 'users', color: '#8b949e', values: run.series.map(sample => sample.users), dashed: true },
		], formatHttpPerfNumber),
		svgLineChart(`${httpPerfLatencyLabel(run.mode)} over time`, xs, [
			{ label: 'mean', color: '#8b949e', values: run.series.map(sample => sample.mean), dashed: true },
			{ label: 'p50', color: '#3fb950', values: run.series.map(sample => sample.p50) },
			{ label: 'p95', color: '#d29922', values: run.series.map(sample => sample.p95) },
			{ label: 'p99', color: '#f85149', values: run.series.map(sample => sample.p99) },
		], formatHttpPerfMs),
	] : [];
	const classes = httpPerfStatusClasses(run.statusCodes);
	const total = Object.values(classes).reduce((sum, value) => sum + value, 0);
	const colors: Record<string, string> = { '2xx': '#3fb950', '3xx': '#4f8cff', '4xx': '#d29922', '5xx': '#f85149', other: '#8b949e' };
	const statusBar = total ? `<figure><figcaption>Status codes</figcaption><div class="bar">${Object.entries(classes).filter(([, count]) => count).map(([name, count]) => `<span style="flex:${count};background:${colors[name]}" title="${esc(`${name}: ${count}`)}"></span>`).join('')}</div><div class="legend">${Object.entries(classes).filter(([, count]) => count).map(([name, count]) => `<span class="key"><i style="background:${colors[name]}"></i>${esc(`${name} ${count} (${formatHttpPerfPercent(count / total * 100)})`)}</span>`).join('')}</div></figure>` : '';
	const sections: string[] = [];
	if (run.verdict.results.length) {
		sections.push(`<h2>Thresholds</h2>${htmlTable(['Threshold', 'Actual', 'Result'], run.verdict.results.map(item => [httpPerfThresholdText(item.threshold, run.mode), formatHttpPerfMetric(item.threshold.metric, item.actual), item.passed ? 'Pass' : 'Fail']))}`);
	}
	sections.push(`<h2>${esc(httpPerfLatencyLabel(run.mode))}</h2>${htmlTable(['min', 'p50', 'p75', 'p90', 'p95', 'p97.5', 'p99', 'p99.9', 'max', 'mean', 'stddev'], [[p.min, p.p50, p.p75, p.p90, p.p95, p.p975, p.p99, p.p999, p.max, p.mean, p.stddev].map(formatHttpPerfMs)])}`);
	if (run.targets.length) {
		sections.push(`<h2>Targets</h2>${htmlTable(['Target', 'Method', unit.many, 'Errors', 'p50', 'p95', 'p99', 'Received'], run.targets.map(target => {
			const tp = voltLoadPercentiles(target.latency);
			return [target.name, target.method, String(target.count), String(target.errors), formatHttpPerfMs(tp.p50), formatHttpPerfMs(tp.p95), formatHttpPerfMs(tp.p99), formatHttpPerfBytes(target.bytesIn)];
		}))}`);
	}
	const kinds = Object.entries(run.errorKinds).filter(([, count]) => count);
	if (kinds.length) {
		sections.push(`<h2>Errors</h2>${htmlTable(['Kind', 'Count'], kinds.map(([kind, count]) => [httpPerfErrorKindLabel(kind as VoltLoadErrorKind), String(count)]))}`);
	}
	const phases = HTTP_PERF_PHASES.filter(phase => run[phase.key]?.n);
	if (phases.length) {
		sections.push(`<h2>Timing phases</h2>${htmlTable(['Phase', 'Samples', 'p50', 'p95', 'p99', 'max'], phases.map(phase => {
			const pp = voltLoadPercentiles(run[phase.key]);
			return [phase.label, String(pp.count), formatHttpPerfMs(pp.p50), formatHttpPerfMs(pp.p95), formatHttpPerfMs(pp.p99), formatHttpPerfMs(pp.max)];
		}))}`);
	}
	if (run.analysis?.text) {
		sections.push(`<h2>Assessment</h2><p class="muted">${esc(run.analysis.model)}</p>${run.analysis.text.trim().split(/\n{2,}/).map(paragraph => `<p>${esc(paragraph).replace(/\n/g, '<br>')}</p>`).join('')}`);
	}
	const style = [
		':root{color-scheme:light dark;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--bg:#fff;--card:#f6f8fa}',
		'@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--bg:#0d1117;--card:#161b22}}',
		'body{margin:0;padding:32px;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}',
		'main{max-width:1080px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 8px}.muted{color:var(--muted)}',
		'.verdict{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:600}.verdict.pass{color:#1a7f37;background:rgba(63,185,80,.16)}.verdict.fail{color:#cf222e;background:rgba(248,81,73,.16)}',
		'.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:16px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:3px;padding:10px 12px}',
		'.card .label{color:var(--muted);font-size:12px}.card .value{font-size:20px;font-weight:600}.delta{font-size:11px}.delta.good{color:#1a7f37}.delta.bad{color:#cf222e}',
		'.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}figure{margin:0;border:1px solid var(--line);border-radius:3px;padding:12px}figcaption{font-weight:600;margin-bottom:4px}',
		'svg{width:100%;height:auto;font-size:10px;fill:var(--muted)}svg .grid{stroke:var(--line)}svg .marker{stroke:var(--fg);stroke-dasharray:3 3}',
		'.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);margin:4px 0}.key i{display:inline-block;width:10px;height:3px;margin-right:5px;vertical-align:middle}',
		'.bar{display:flex;gap:2px;height:14px;border-radius:3px;overflow:hidden;margin:8px 0}',
		'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left}th{color:var(--muted);font-weight:600}',
	].join('\n');
	return [
		'<!DOCTYPE html>',
		`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(`${file.name}: performance report`)}</title><style>${style}</style></head><body><main>`,
		`<h1>${esc(file.name)}</h1>`,
		file.description.trim() ? `<p class="muted">${esc(file.description.trim())}</p>` : '',
		`<p><span class="verdict ${run.verdict.passed ? 'pass' : 'fail'}">${run.verdict.passed ? 'Passed' : 'Failed'}</span> <span class="muted">${esc(`${new Date(run.startedAt).toISOString()} - ${run.mode.toUpperCase()} - ${run.config.users} ${run.mode === 'http' ? 'virtual users' : 'connections'}, ${run.config.profile} profile, ${formatHttpPerfSeconds(run.measuredSec)} measured${run.ended === 'stopped' ? ', stopped early' : ''}`)}</span></p>`,
		`<div class="cards">${[
			card(`${unit.rate}`, formatHttpPerfNumber(run.rate), 'rps'),
			card('Mean', formatHttpPerfMs(p.mean), 'mean'),
			card('p95', formatHttpPerfMs(p.p95), 'p95'),
			card('p99', formatHttpPerfMs(p.p99), 'p99'),
			card('Error rate', formatHttpPerfPercent(run.metrics.errorRate), 'errorRate'),
			card(`Total ${unit.many}`, formatHttpPerfNumber(run.count), 'count'),
			card('Data received', formatHttpPerfBytes(run.bytesIn), 'bytesIn'),
			card('Peak users', String(run.peakUsers), 'peakUsers'),
		].join('')}</div>`,
		`<div class="charts">${charts.join('')}${svgHistogram(`${httpPerfLatencyLabel(run.mode)} distribution`, run)}${statusBar}</div>`,
		sections.join(''),
		`<p class="muted" style="margin-top:32px">Volt Client performance report</p>`,
		'</main></body></html>',
		'',
	].join('\n');
}
