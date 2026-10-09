/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../base/common/lifecycle.js';
import { IVoltSpanData, VoltAttributes, VoltAttributeValue, VoltSpanStatusCode } from './voltDiagnostics.js';

/**
 * A small OTLP/HTTP JSON trace exporter (no OpenTelemetry SDK in the product). Encoding follows
 * opentelemetry-proto's JSON mapping: hex trace and span ids, unix-nano times and 64-bit ints as
 * decimal strings, attributes as typed `AnyValue`s.
 */

//#region Encoding

export type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly boolValue: boolean }
	| { readonly intValue: string }
	| { readonly doubleValue: number }
	| { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } };

export interface OtlpKeyValue {
	readonly key: string;
	readonly value: OtlpAnyValue;
}

export interface OtlpSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: number;
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes: readonly OtlpKeyValue[];
	readonly events?: readonly { readonly timeUnixNano: string; readonly name: string; readonly attributes: readonly OtlpKeyValue[] }[];
	readonly status: { readonly code: number; readonly message?: string };
}

export interface OtlpTraceRequest {
	readonly resourceSpans: readonly {
		readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
		readonly scopeSpans: readonly {
			readonly scope: { readonly name: string; readonly version?: string };
			readonly spans: readonly OtlpSpan[];
		}[];
	}[];
}

export interface IOtlpScope {
	readonly name: string;
	readonly version?: string;
}

const NANOS_PER_MS = 1_000_000n;

/** Epoch milliseconds (fractions allowed) as a unix-nano decimal string, without losing precision past 2^53. */
export function toUnixNanos(epochMs: number): string {
	if (!Number.isFinite(epochMs) || epochMs <= 0) {
		return '0';
	}
	const whole = Math.floor(epochMs);
	const fraction = Math.round((epochMs - whole) * 1_000_000);
	return (BigInt(whole) * NANOS_PER_MS + BigInt(fraction)).toString();
}

export function toAnyValue(value: VoltAttributeValue): OtlpAnyValue {
	if (typeof value === 'string') {
		return { stringValue: value };
	}
	if (typeof value === 'boolean') {
		return { boolValue: value };
	}
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
	}
	return { arrayValue: { values: (value as readonly (string | number | boolean)[]).map(item => toAnyValue(item)) } };
}

/** Undefined values are left out; non-finite numbers become strings so a collector never rejects the batch. */
export function toKeyValues(attributes: VoltAttributes | undefined): OtlpKeyValue[] {
	const result: OtlpKeyValue[] = [];
	if (!attributes) {
		return result;
	}
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined) {
			continue;
		}
		if (typeof value === 'number' && !Number.isFinite(value)) {
			result.push({ key, value: { stringValue: String(value) } });
			continue;
		}
		result.push({ key, value: toAnyValue(value) });
	}
	return result;
}

export function encodeSpan(span: IVoltSpanData): OtlpSpan {
	const encoded: OtlpSpan = {
		traceId: span.traceId,
		spanId: span.spanId,
		...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
		name: span.name,
		kind: span.kind,
		startTimeUnixNano: toUnixNanos(span.startTime),
		endTimeUnixNano: toUnixNanos(Math.max(span.startTime, span.endTime)),
		attributes: toKeyValues(span.attributes),
		...(span.events?.length ? {
			events: span.events.map(event => ({ timeUnixNano: toUnixNanos(event.time), name: event.name, attributes: toKeyValues(event.attributes) })),
		} : {}),
		status: span.status
			? { code: span.status.code, ...(span.status.code === VoltSpanStatusCode.Error && span.status.message ? { message: span.status.message } : {}) }
			: { code: VoltSpanStatusCode.Unset },
	};
	return encoded;
}

export function encodeTraceRequest(resource: VoltAttributes, scope: IOtlpScope, spans: readonly IVoltSpanData[]): OtlpTraceRequest {
	return {
		resourceSpans: [{
			resource: { attributes: toKeyValues(resource) },
			scopeSpans: [{
				scope: scope.version ? { name: scope.name, version: scope.version } : { name: scope.name },
				spans: spans.map(encodeSpan),
			}],
		}],
	};
}

/** `{endpoint}/v1/traces`, unless the setting already names the traces path. */
export function tracesUrl(endpoint: string): string {
	const trimmed = endpoint.trim().replace(/\/+$/, '');
	return /\/v1\/traces$/.test(trimmed) ? trimmed : `${trimmed}/v1/traces`;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO = /^0+$/;

/** A span with ids a collector would reject (wrong length, upper case, all zero) is not exported. */
export function hasValidIds(span: IVoltSpanData): boolean {
	return TRACE_ID.test(span.traceId) && !ZERO.test(span.traceId)
		&& SPAN_ID.test(span.spanId) && !ZERO.test(span.spanId)
		&& (span.parentSpanId === undefined || (SPAN_ID.test(span.parentSpanId) && !ZERO.test(span.parentSpanId)));
}

//#endregion

//#region Batch exporter

export interface IOtlpTransportResult {
	readonly status: number;
	readonly body?: string;
}

/** Posts one JSON body. Rejects on network errors; the exporter enforces its own timeout through `signal`. */
export type OtlpTransport = (url: string, body: string, headers: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<IOtlpTransportResult>;

export interface IOtlpExporterOptions {
	readonly endpoint: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly resource: VoltAttributes;
	readonly scope: IOtlpScope;
	readonly transport: OtlpTransport;
	/** Spans waiting to be sent. New spans are dropped while it is full. */
	readonly maxQueueSize?: number;
	readonly maxBatchSize?: number;
	/** How long a span may wait before a batch goes out. */
	readonly flushIntervalMs?: number;
	readonly exportTimeoutMs?: number;
	/** Export failures and drops, already rate limited by the exporter. */
	readonly onError?: (message: string) => void;
	readonly setTimer?: (callback: () => void, ms: number) => IDisposable;
	readonly now?: () => number;
}

export interface IOtlpExporterStats {
	readonly exported: number;
	readonly dropped: number;
	readonly failedBatches: number;
}

const ERROR_LOG_INTERVAL_MS = 60_000;

function defaultTimer(callback: () => void, ms: number): IDisposable {
	const handle = setTimeout(callback, ms);
	(handle as { unref?: () => void }).unref?.();
	return { dispose: () => clearTimeout(handle) };
}

/**
 * Queues finished spans and posts them in batches: when a batch fills, after `flushIntervalMs`,
 * and on `flush()`. One request is in flight at a time. A failed batch is dropped and logged; the
 * caller never waits on the network.
 */
export class OtlpBatchExporter implements IDisposable {

	private readonly url: string;
	private readonly maxQueueSize: number;
	private readonly maxBatchSize: number;
	private readonly flushIntervalMs: number;
	private readonly exportTimeoutMs: number;
	private readonly setTimer: (callback: () => void, ms: number) => IDisposable;
	private readonly now: () => number;

	private queue: IVoltSpanData[] = [];
	private timer: IDisposable | undefined;
	private sending: Promise<void> | undefined;
	private disposed = false;

	private exported = 0;
	private dropped = 0;
	private failedBatches = 0;
	private lastErrorLogAt = Number.NEGATIVE_INFINITY;
	private unloggedFailures = 0;
	private droppedSinceLog = 0;

	constructor(private readonly options: IOtlpExporterOptions) {
		this.url = tracesUrl(options.endpoint);
		this.maxQueueSize = options.maxQueueSize ?? 2048;
		this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 256);
		this.flushIntervalMs = options.flushIntervalMs ?? 5000;
		this.exportTimeoutMs = options.exportTimeoutMs ?? 10_000;
		this.setTimer = options.setTimer ?? defaultTimer;
		this.now = options.now ?? Date.now;
	}

	get stats(): IOtlpExporterStats {
		return { exported: this.exported, dropped: this.dropped, failedBatches: this.failedBatches };
	}

	get pending(): number {
		return this.queue.length;
	}

	add(spans: readonly IVoltSpanData[]): void {
		if (this.disposed) {
			return;
		}
		for (const span of spans) {
			if (!hasValidIds(span)) {
				this.drop(1, 'invalid ids');
				continue;
			}
			if (this.queue.length >= this.maxQueueSize) {
				this.drop(1, 'queue full');
				continue;
			}
			this.queue.push(span);
		}
		if (this.queue.length >= this.maxBatchSize) {
			void this.drain();
		} else if (this.queue.length && !this.timer) {
			this.timer = this.setTimer(() => {
				this.timer = undefined;
				void this.drain();
			}, this.flushIntervalMs);
		}
	}

	/** Sends everything queued now. Resolves when the queue is empty (or every batch failed). */
	async flush(): Promise<void> {
		this.timer?.dispose();
		this.timer = undefined;
		await this.drain();
	}

	dispose(): void {
		this.disposed = true;
		this.timer?.dispose();
		this.timer = undefined;
		this.queue = [];
	}

	private drain(): Promise<void> {
		if (!this.sending) {
			this.sending = this.sendAll().finally(() => this.sending = undefined);
		}
		return this.sending;
	}

	private async sendAll(): Promise<void> {
		while (this.queue.length && !this.disposed) {
			const batch = this.queue.splice(0, this.maxBatchSize);
			await this.send(batch);
		}
	}

	private async send(batch: readonly IVoltSpanData[]): Promise<void> {
		let body: string;
		try {
			body = JSON.stringify(encodeTraceRequest(this.options.resource, this.options.scope, batch));
		} catch (error) {
			this.fail(batch.length, `could not encode ${batch.length} spans: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const controller = new AbortController();
		const timeout = this.setTimer(() => controller.abort(), this.exportTimeoutMs);
		try {
			const result = await this.options.transport(this.url, body, { 'Content-Type': 'application/json', ...this.options.headers }, controller.signal);
			if (result.status >= 200 && result.status < 300) {
				this.exported += batch.length;
				return;
			}
			const detail = result.body ? `: ${result.body.slice(0, 200)}` : '';
			this.fail(batch.length, `${this.url} answered HTTP ${result.status}${detail}`);
		} catch (error) {
			const message = controller.signal.aborted ? `timed out after ${this.exportTimeoutMs} ms` : error instanceof Error ? error.message : String(error);
			this.fail(batch.length, `could not reach ${this.url}: ${message}`);
		} finally {
			timeout.dispose();
		}
	}

	private fail(count: number, message: string): void {
		this.failedBatches++;
		this.dropped += count;
		this.unloggedFailures++;
		this.droppedSinceLog += count;
		this.maybeLog(message);
	}

	private drop(count: number, reason: string): void {
		this.dropped += count;
		this.droppedSinceLog += count;
		this.maybeLog(`dropped spans (${reason})`);
	}

	private maybeLog(message: string): void {
		const now = this.now();
		if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) {
			return;
		}
		this.lastErrorLogAt = now;
		const failures = this.unloggedFailures > 1 ? `, ${this.unloggedFailures} failed exports` : '';
		this.options.onError?.(`Tracing export: ${message} (${this.droppedSinceLog} spans dropped${failures} since the last report)`);
		this.unloggedFailures = 0;
		this.droppedSinceLog = 0;
	}
}

//#endregion
