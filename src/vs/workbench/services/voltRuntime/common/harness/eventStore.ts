/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IVoltEvent, IVoltEventEnvelope, isLiveOnlyEvent } from '../events.js';
import type { IRunMetrics } from './runMetrics.js';
import { VoltLane } from './lanes.js';
import { TaskPhase } from './lifecycle.js';

/**
 * Event store and state reducer. The live stream is lossy on purpose (`*.delta` is never
 * persisted); the durable log is what resume and the UI replay from.
 *
 * The reducer is a pure function of the durable envelopes. That is the whole contract:
 * given the same log, every subscriber reconstructs the same projection. Side effects
 * (opening a preview, asking for approval) belong to the renderer, not here.
 */

export interface IStoredEnvelope {
	readonly seq: number;
	readonly runId: string;
	readonly sessionId: string;
	readonly timestamp: number;
	readonly event: IVoltEvent;
}

export interface IRunProjection {
	readonly runId: string;
	readonly sessionId: string;
	readonly phase: TaskPhase;
	readonly lane?: VoltLane;
	readonly signals: readonly string[];
	readonly assistant: string;
	readonly error?: string;
	readonly reason?: 'done' | 'abort' | 'fail';
	readonly usage: { input: number; output: number; cache: number };
	readonly tools: readonly { callId: string; name: string; done: boolean; error?: string }[];
	readonly plan: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
	readonly files: readonly { path: string; kind: 'edit' | 'create' | 'delete' }[];
	readonly startedAt: number;
	readonly endedAt?: number;
}

export class EventStore {

	private readonly durable: IStoredEnvelope[] = [];
	private seq = 0;

	append(envelope: Omit<IVoltEventEnvelope, 'seq'>): IStoredEnvelope | undefined {
		if (isLiveOnlyEvent(envelope.event)) {
			return undefined;
		}
		const stored: IStoredEnvelope = {
			seq: ++this.seq,
			runId: envelope.runId,
			sessionId: envelope.sessionId,
			timestamp: envelope.timestamp,
			event: envelope.event,
		};
		this.durable.push(stored);
		return stored;
	}

	all(runId?: string): readonly IStoredEnvelope[] {
		return runId ? this.durable.filter(item => item.runId === runId) : this.durable;
	}

	project(runId: string): IRunProjection | undefined {
		const log = this.all(runId);
		if (!log.length) {
			return undefined;
		}
		return reduceRun(log);
	}
}

export function reduceRun(log: readonly IStoredEnvelope[]): IRunProjection {
	const first = log[0];
	const projection: MutableRun = {
		runId: first.runId,
		sessionId: first.sessionId,
		phase: 'created',
		signals: [],
		assistant: '',
		usage: { input: 0, output: 0, cache: 0 },
		tools: [],
		plan: [],
		files: [],
		startedAt: first.timestamp,
	};

	for (const item of log) {
		apply(projection, item);
	}
	return projection;
}

interface MutableRun {
	runId: string;
	sessionId: string;
	phase: TaskPhase;
	lane?: VoltLane;
	signals: string[];
	assistant: string;
	error?: string;
	reason?: 'done' | 'abort' | 'fail';
	usage: { input: number; output: number; cache: number };
	tools: { callId: string; name: string; done: boolean; error?: string }[];
	plan: { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
	files: { path: string; kind: 'edit' | 'create' | 'delete' }[];
	startedAt: number;
	endedAt?: number;
}

function apply(state: MutableRun, item: IStoredEnvelope): void {
	const event = item.event;
	switch (event.type) {
		case 'run.start':
			state.phase = 'running';
			state.startedAt = item.timestamp;
			break;
		case 'lane':
			state.lane = event.lane;
			state.signals = [...event.signals];
			break;
		case 'lifecycle':
			state.phase = event.phase;
			break;
		case 'text.end':
			if (event.delta) {
				state.assistant += event.delta;
			}
			break;
		case 'error':
			state.error = event.message;
			break;
		case 'tool.start':
			state.tools.push({ callId: event.callId, name: event.name, done: false });
			break;
		case 'tool.end': {
			const tool = state.tools.find(entry => entry.callId === event.callId);
			if (tool) {
				tool.done = true;
				if (event.error) {
					tool.error = event.error;
				}
			}
			break;
		}
		case 'plan':
			state.plan = event.entries.map(entry => ({ content: entry.content, status: entry.status }));
			break;
		case 'file.change':
			state.files.push({ path: event.uri.path || event.uri.fsPath, kind: event.kind });
			break;
		case 'usage':
			state.usage.input += event.input;
			state.usage.output += event.output;
			state.usage.cache += event.cache ?? 0;
			break;
		case 'run.end':
			state.reason = event.reason;
			state.endedAt = item.timestamp;
			state.phase = event.reason === 'done' ? 'completed' : event.reason === 'abort' ? 'cancelled' : 'failed';
			break;
		default:
			break;
	}
}

// --- persisted trace ---------------------------------------------------------------------------

/**
 * One line of a session's trace file. Events are the durable envelopes; live-only deltas are
 * folded away, except streamed text, which is kept as one `text.end` per text block so a trace
 * still says what the agent answered. `metrics` closes each run with its timings.
 */
export type ITraceRecord =
	| { readonly kind: 'event'; readonly seq: number; readonly runId: string; readonly ts: number; readonly event: IVoltEvent }
	| { readonly kind: 'metrics'; readonly runId: string; readonly ts: number; readonly metrics: IRunMetrics };

/** Folds a live envelope stream into trace records. One recorder per session. */
export class TraceRecorder {

	/** Streamed text per `runId\0blockId`, until its block ends. */
	private readonly text = new Map<string, { readonly runId: string; readonly id: string; value: string; readonly ts: number }>();

	push(envelope: IVoltEventEnvelope): ITraceRecord[] {
		const event = envelope.event;
		const out: ITraceRecord[] = [];
		if (event.type === 'text.delta') {
			if (event.delta) {
				const key = `${envelope.runId}\0${event.id}`;
				const open = this.text.get(key);
				if (open) {
					open.value += event.delta;
				} else {
					this.text.set(key, { runId: envelope.runId, id: event.id, value: event.delta, ts: envelope.timestamp });
				}
			}
			return out;
		}
		if (event.type === 'text.end') {
			const key = `${envelope.runId}\0${event.id}`;
			const open = this.text.get(key);
			this.text.delete(key);
			const value = `${open?.value ?? ''}${event.delta ?? ''}`;
			out.push({ kind: 'event', seq: envelope.seq, runId: envelope.runId, ts: envelope.timestamp, event: { type: 'text.end', id: event.id, ...(value ? { delta: value } : {}) } });
			return out;
		}
		if (isLiveOnlyEvent(event)) {
			return out;
		}
		if (event.type === 'run.end') {
			// Providers that never close their text blocks still leave their answer in the trace.
			out.push(...this.flush(envelope.runId, envelope.seq));
		}
		out.push({ kind: 'event', seq: envelope.seq, runId: envelope.runId, ts: envelope.timestamp, event });
		return out;
	}

	/** Open text blocks of `runId` as `text.end` records. */
	flush(runId: string, seq: number): ITraceRecord[] {
		const out: ITraceRecord[] = [];
		for (const [key, open] of this.text) {
			if (open.runId === runId) {
				this.text.delete(key);
				out.push({ kind: 'event', seq, runId, ts: open.ts, event: { type: 'text.end', id: open.id, delta: open.value } });
			}
		}
		return out;
	}
}

export function encodeTraceRecord(record: ITraceRecord): string {
	// `URI.toJSON` runs before a replacer sees the value, so look at the holder's original.
	return JSON.stringify(record, function (this: Record<string, unknown>, key: string, value: unknown) {
		const raw = key ? this[key] : value;
		return URI.isUri(raw) ? raw.toString() : value;
	});
}

/** Records from a trace file; unreadable lines are skipped. URIs come back as strings. */
export function decodeTrace(text: string): ITraceRecord[] {
	const out: ITraceRecord[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const record = JSON.parse(line) as ITraceRecord;
			if (record && (record.kind === 'event' || record.kind === 'metrics')) {
				out.push(record);
			}
		} catch {
			// A torn last line after a crash.
		}
	}
	return out;
}

/** The trace's events as stored envelopes, for `reduceRun` / `replay`. */
export function traceEnvelopes(records: readonly ITraceRecord[], sessionId: string, runId?: string): IStoredEnvelope[] {
	return records.flatMap(record => record.kind === 'event' && (!runId || record.runId === runId)
		? [{ seq: record.seq, runId: record.runId, sessionId, timestamp: record.ts, event: record.event }]
		: []);
}
