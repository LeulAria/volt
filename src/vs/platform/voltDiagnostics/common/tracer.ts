/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltSpanData, IVoltSpanEvent, VoltAttributes, VoltAttributeValue, VoltSpanKind, VoltSpanStatusCode } from './voltDiagnostics.js';

function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	for (; ;) {
		crypto.getRandomValues(buffer);
		// An all-zero id is invalid in OTLP.
		if (buffer.some(byte => byte !== 0)) {
			break;
		}
	}
	let hex = '';
	for (const byte of buffer) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

/** 16 random bytes as 32 lowercase hex characters, never all zero. */
export function newTraceId(): string {
	return randomHex(16);
}

/** 8 random bytes as 16 lowercase hex characters, never all zero. */
export function newSpanId(): string {
	return randomHex(8);
}

/** Epoch milliseconds with sub-millisecond precision where the platform has it. */
export function preciseNow(): number {
	return typeof performance === 'object' && typeof performance.timeOrigin === 'number'
		? performance.timeOrigin + performance.now()
		: Date.now();
}

export interface IVoltSpanContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly sampled: boolean;
}

export interface IVoltSpanOptions {
	/** A parent span or context; without one the span starts a trace and makes the sampling decision. */
	readonly parent?: IVoltSpan | IVoltSpanContext;
	readonly kind?: VoltSpanKind;
	readonly attributes?: VoltAttributes;
	/** Epoch milliseconds; defaults to now. */
	readonly startTime?: number;
}

export interface IVoltSpan {
	readonly context: IVoltSpanContext;
	readonly name: string;
	readonly ended: boolean;
	setAttribute(key: string, value: VoltAttributeValue | undefined): void;
	setAttributes(attributes: VoltAttributes): void;
	addEvent(name: string, attributes?: VoltAttributes, time?: number): void;
	setStatus(code: VoltSpanStatusCode, message?: string): void;
	/** Later calls are ignored. */
	end(endTime?: number): void;
}

/** Span events kept per span; agent turns can emit many retries or notices. */
const MAX_EVENTS = 128;

class VoltSpan implements IVoltSpan {

	private readonly attributes: VoltAttributes;
	private readonly events: IVoltSpanEvent[] = [];
	private status: { code: VoltSpanStatusCode; message?: string } | undefined;
	private _ended = false;

	constructor(
		readonly context: IVoltSpanContext,
		readonly name: string,
		private readonly parentSpanId: string | undefined,
		private readonly kind: VoltSpanKind,
		private readonly startTime: number,
		attributes: VoltAttributes | undefined,
		private readonly sink: (span: IVoltSpanData) => void,
		private readonly now: () => number,
	) {
		this.attributes = { ...attributes };
	}

	get ended(): boolean {
		return this._ended;
	}

	setAttribute(key: string, value: VoltAttributeValue | undefined): void {
		if (!this._ended && value !== undefined) {
			this.attributes[key] = value;
		}
	}

	setAttributes(attributes: VoltAttributes): void {
		for (const [key, value] of Object.entries(attributes)) {
			this.setAttribute(key, value);
		}
	}

	addEvent(name: string, attributes?: VoltAttributes, time?: number): void {
		if (!this._ended && this.events.length < MAX_EVENTS) {
			this.events.push({ name, time: time ?? this.now(), ...(attributes ? { attributes } : {}) });
		}
	}

	setStatus(code: VoltSpanStatusCode, message?: string): void {
		if (this._ended) {
			return;
		}
		// Ok is final; an error does not overwrite it, the same as the OpenTelemetry SDKs.
		if (this.status?.code === VoltSpanStatusCode.Ok) {
			return;
		}
		this.status = { code, ...(message ? { message } : {}) };
	}

	end(endTime?: number): void {
		if (this._ended) {
			return;
		}
		this._ended = true;
		if (!this.context.sampled) {
			return;
		}
		this.sink({
			traceId: this.context.traceId,
			spanId: this.context.spanId,
			...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
			name: this.name,
			kind: this.kind,
			startTime: this.startTime,
			endTime: Math.max(this.startTime, endTime ?? this.now()),
			attributes: this.attributes,
			...(this.events.length ? { events: this.events } : {}),
			...(this.status ? { status: this.status } : {}),
		});
	}
}

export interface IVoltTracerOptions {
	/** Receives finished, sampled spans. */
	readonly sink: (span: IVoltSpanData) => void;
	/** Share of new traces kept, 0 to 1. Read at each root span so setting changes apply at once. */
	readonly sampleRate: () => number;
	/** Added to every span (process type, window id). */
	readonly attributes?: VoltAttributes;
	readonly random?: () => number;
	readonly now?: () => number;
}

/** Makes spans. Unsampled spans still carry ids (so children agree) but never reach the sink. */
export class VoltTracer {

	private readonly now: () => number;
	private readonly random: () => number;

	constructor(private readonly options: IVoltTracerOptions) {
		this.now = options.now ?? preciseNow;
		this.random = options.random ?? Math.random;
	}

	startSpan(name: string, options: IVoltSpanOptions = {}): IVoltSpan {
		const parent = options.parent ? ('context' in options.parent ? options.parent.context : options.parent) : undefined;
		const rate = this.options.sampleRate();
		const sampled = parent ? parent.sampled : rate >= 1 || (rate > 0 && this.random() < rate);
		const context: IVoltSpanContext = { traceId: parent?.traceId ?? newTraceId(), spanId: newSpanId(), sampled };
		return new VoltSpan(
			context,
			name,
			parent?.spanId,
			options.kind ?? VoltSpanKind.Internal,
			options.startTime ?? this.now(),
			{ ...this.options.attributes, ...options.attributes },
			this.options.sink,
			this.now,
		);
	}

	/** A span whose start and end are already known (startup phases, stalls). */
	recordSpan(name: string, startTime: number, endTime: number, options: Omit<IVoltSpanOptions, 'startTime'> & { readonly status?: { readonly code: VoltSpanStatusCode; readonly message?: string } } = {}): IVoltSpan {
		const span = this.startSpan(name, { ...options, startTime });
		if (options.status) {
			span.setStatus(options.status.code, options.status.message);
		}
		span.end(endTime);
		return span;
	}
}
