/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent, IVoltEventEnvelope, isLiveOnlyEvent } from '../events.js';
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
