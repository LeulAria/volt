/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltDiagnosticsService = createDecorator<IVoltDiagnosticsService>('voltDiagnosticsService');
export const VOLT_DIAGNOSTICS_CHANNEL_NAME = 'voltDiagnostics';

//#region Settings

/** Opt-in OpenTelemetry tracing. Off by default; nothing is sent anywhere while it is off. */
export const VOLT_TRACING_ENABLED_SETTING = 'volt.tracing.enabled';
/** Base URL of an OTLP/HTTP collector; spans go to `{endpoint}/v1/traces`. */
export const VOLT_TRACING_ENDPOINT_SETTING = 'volt.tracing.otlpEndpoint';
/** Extra HTTP headers for the collector (API keys). */
export const VOLT_TRACING_HEADERS_SETTING = 'volt.tracing.headers';
/** Share of traces kept, 0 to 1. Child spans follow their trace's decision. */
export const VOLT_TRACING_SAMPLE_RATE_SETTING = 'volt.tracing.sampleRate';
/** Event-loop stalls at least this long (ms) are logged to the Volt Diagnostics log. 0 turns it off. */
export const VOLT_STALL_THRESHOLD_SETTING = 'volt.diagnostics.eventLoopStallThreshold';

export const VOLT_TRACING_DEFAULT_ENDPOINT = 'http://localhost:4318';
export const VOLT_STALL_THRESHOLD_DEFAULT = 300;

/** The main process has no configuration registry for workbench settings, so both sides read through this. */
export interface IVoltTracingConfig {
	readonly enabled: boolean;
	readonly endpoint: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly sampleRate: number;
}

export function readTracingConfig(getValue: (key: string) => unknown): IVoltTracingConfig {
	const enabled = getValue(VOLT_TRACING_ENABLED_SETTING) === true;
	const rawEndpoint = getValue(VOLT_TRACING_ENDPOINT_SETTING);
	const endpoint = typeof rawEndpoint === 'string' && rawEndpoint.trim() ? rawEndpoint.trim() : VOLT_TRACING_DEFAULT_ENDPOINT;
	const headers: Record<string, string> = {};
	const rawHeaders = getValue(VOLT_TRACING_HEADERS_SETTING);
	if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
		for (const [key, value] of Object.entries(rawHeaders)) {
			if (typeof value === 'string' || typeof value === 'number') {
				headers[key] = String(value);
			}
		}
	}
	const rawRate = getValue(VOLT_TRACING_SAMPLE_RATE_SETTING);
	const sampleRate = typeof rawRate === 'number' && Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : 1;
	return { enabled, endpoint, headers, sampleRate };
}

export function readStallThreshold(getValue: (key: string) => unknown): number {
	const raw = getValue(VOLT_STALL_THRESHOLD_SETTING);
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return VOLT_STALL_THRESHOLD_DEFAULT;
	}
	return raw <= 0 ? 0 : Math.max(50, Math.round(raw));
}

//#endregion

//#region Spans

export type VoltAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
export type VoltAttributes = Record<string, VoltAttributeValue | undefined>;

/** OTLP span kinds (the protobuf enum values). */
export const enum VoltSpanKind {
	Internal = 1,
	Server = 2,
	Client = 3,
	Producer = 4,
	Consumer = 5,
}

/** OTLP status codes. */
export const enum VoltSpanStatusCode {
	Unset = 0,
	Ok = 1,
	Error = 2,
}

export interface IVoltSpanEvent {
	readonly name: string;
	/** Epoch milliseconds, fractions allowed. */
	readonly time: number;
	readonly attributes?: VoltAttributes;
}

/** A finished span. Plain data, so renderers can hand it to the main process over IPC. */
export interface IVoltSpanData {
	/** 32 lowercase hex characters. */
	readonly traceId: string;
	/** 16 lowercase hex characters. */
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: VoltSpanKind;
	/** Epoch milliseconds, fractions allowed. */
	readonly startTime: number;
	readonly endTime: number;
	readonly attributes: VoltAttributes;
	readonly events?: readonly IVoltSpanEvent[];
	readonly status?: { readonly code: VoltSpanStatusCode; readonly message?: string };
}

//#endregion

//#region Stalls

/** What was running when the event loop stalled, as far as the process could tell. */
export interface IVoltStallAttribution {
	/** Where the time went: an IPC call, a script, a command. */
	readonly kind: 'ipc' | 'script' | 'command' | 'unknown';
	readonly detail: string;
	/** Share of the stall the attributed work took, when known. */
	readonly durationMs?: number;
}

export interface IVoltStallReport {
	readonly process: 'main' | 'renderer';
	readonly windowId?: number;
	/** Epoch milliseconds. */
	readonly startTime: number;
	readonly durationMs: number;
	/** The part of a renderer frame that blocked input (Long Animation Frame `blockingDuration`). */
	readonly blockingMs?: number;
	readonly attribution: readonly IVoltStallAttribution[];
	/** Earlier stalls this process held back under the rate limit. */
	readonly suppressed?: number;
}

//#endregion

export interface IVoltHeapSnapshotResult {
	readonly folder: string;
	readonly files: readonly string[];
	readonly errors: readonly string[];
}

export interface IVoltDiagnosticsService {
	readonly _serviceBrand: undefined;

	/** Spans finished in a renderer. Dropped unless tracing is on. */
	exportSpans(spans: readonly IVoltSpanData[]): Promise<void>;
	/** A renderer stall (already rate limited there): logged to Volt Diagnostics, traced when tracing is on. */
	reportStall(report: IVoltStallReport): Promise<void>;
	/** Writes `main-<time>.heapsnapshot` and one snapshot per window into the session's logs folder. */
	writeHeapSnapshots(): Promise<IVoltHeapSnapshotResult>;
}
