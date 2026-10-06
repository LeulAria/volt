/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';

/**
 * Per-run timing and health meters, for both engines. Phases are measured from the moment the
 * user pressed send, so a breakdown reads as "where did the first second go": preparing the run,
 * getting an agent ready (a live one, a warm spare, or a cold start), writing the prompt, the
 * first event back, the first visible text, and the end.
 *
 * Only engine events are observed here (what the model or agent produced), never the runtime's
 * own bookkeeping events, so "first event" is the agent's first sign of life.
 */

export type RunEngine = 'native' | 'agent';

/** Where the ACP agent for this run came from. */
export type AgentSource = 'live' | 'pool' | 'cold' | 'restart';

export type RunPhase = 'prepared' | 'agentReady' | 'prompt';

export interface IRunToolMeters {
	readonly count: number;
	readonly errors: number;
	/** Sum of start-to-end time over finished calls. Parallel calls overlap, so this can exceed wall time. */
	readonly totalMs: number;
	readonly maxMs: number;
	readonly slowest?: string;
}

export interface IRunMetrics {
	readonly runId: string;
	readonly sessionId: string;
	readonly engine: RunEngine;
	readonly mode: string;
	readonly providerRef?: string;
	readonly agentSource?: AgentSource;
	readonly outcome?: 'done' | 'abort' | 'fail';
	/** Epoch ms when send was pressed. */
	readonly startedAt: number;
	/** Milliseconds after `startedAt`. */
	readonly preparedMs?: number;
	readonly agentReadyMs?: number;
	readonly promptMs?: number;
	readonly firstEventMs?: number;
	readonly firstTextMs?: number;
	readonly totalMs?: number;
	readonly steps: number;
	readonly tools: IRunToolMeters;
	readonly retries: number;
	readonly stalls: number;
	readonly loops: number;
	readonly compactions: number;
	/** Turns Volt added after the agent wanted to stop (regression gate, open to-dos). */
	readonly continuations: number;
	readonly errors: number;
	readonly tokens: { readonly input: number; readonly output: number; readonly cache: number };
}

const STALL = /stall|no activity|not responding|taking longer/i;
const LOOP = /loop|called three times|same tools? .*repeat|repeated the same/i;

export class RunMetrics {

	private readonly phases = new Map<RunPhase, number>();
	private firstEventAt: number | undefined;
	private firstTextAt: number | undefined;
	private endedAt: number | undefined;
	private outcome: IRunMetrics['outcome'];
	private agentSource: AgentSource | undefined;
	private readonly openTools = new Map<string, { readonly name: string; readonly at: number }>();
	private readonly seenTools = new Set<string>();
	private toolCount = 0;
	private toolErrors = 0;
	private toolTotalMs = 0;
	private toolMaxMs = 0;
	private slowest: string | undefined;
	private steps = 0;
	private retries = 0;
	private stalls = 0;
	private loops = 0;
	private compactions = 0;
	/** Agents repeat a compaction's terminal update to patch in its token counts: count each id once. */
	private readonly compactionsDone = new Set<string>();
	private continuations = 0;
	private errors = 0;
	private readonly tokens = { input: 0, output: 0, cache: 0 };

	constructor(
		readonly runId: string,
		readonly sessionId: string,
		readonly engine: RunEngine,
		readonly mode: string,
		readonly startedAt: number,
		readonly providerRef?: string,
	) { }

	/** Records a phase the first time it is reached. */
	mark(phase: RunPhase, at = Date.now()): void {
		if (!this.phases.has(phase)) {
			this.phases.set(phase, at);
		}
	}

	setAgentSource(source: AgentSource): void {
		this.agentSource ??= source;
	}

	noteContinuation(): void {
		this.continuations++;
	}

	get hasPrompted(): boolean {
		return this.phases.has('prompt');
	}

	observe(event: IVoltEvent, at = Date.now()): void {
		if (this.endedAt !== undefined) {
			return;
		}
		this.firstEventAt ??= at;
		switch (event.type) {
			case 'text.delta':
				if (event.delta) {
					this.firstTextAt ??= at;
				}
				break;
			case 'step.start':
				this.steps++;
				break;
			case 'tool.start':
				if (!this.seenTools.has(event.callId)) {
					this.seenTools.add(event.callId);
					this.openTools.set(event.callId, { name: event.name, at });
					this.toolCount++;
				}
				break;
			case 'tool.end': {
				const open = this.openTools.get(event.callId);
				if (open) {
					this.openTools.delete(event.callId);
					const ms = event.durationMs ?? Math.max(0, at - open.at);
					this.toolTotalMs += ms;
					if (ms > this.toolMaxMs) {
						this.toolMaxMs = ms;
						this.slowest = open.name;
					}
				}
				if (event.error) {
					this.toolErrors++;
				}
				break;
			}
			case 'retry':
				this.retries++;
				break;
			case 'compaction':
				this.compactions++;
				break;
			case 'context.compaction':
				if (event.status === 'completed' && !this.compactionsDone.has(event.id)) {
					this.compactionsDone.add(event.id);
					this.compactions++;
				}
				break;
			case 'usage':
				this.tokens.input += event.input;
				this.tokens.output += event.output;
				this.tokens.cache += event.cache ?? 0;
				break;
			case 'error':
				this.errors++;
				this.classify(event.message);
				break;
			case 'notice':
				this.classify(event.title);
				break;
		}
	}

	end(outcome: 'done' | 'abort' | 'fail', at = Date.now()): void {
		if (this.endedAt === undefined) {
			this.endedAt = at;
			this.outcome = outcome;
		}
	}

	snapshot(): IRunMetrics {
		const since = (at: number | undefined) => at === undefined ? undefined : Math.max(0, at - this.startedAt);
		return {
			runId: this.runId,
			sessionId: this.sessionId,
			engine: this.engine,
			mode: this.mode,
			...(this.providerRef ? { providerRef: this.providerRef } : {}),
			...(this.agentSource ? { agentSource: this.agentSource } : {}),
			...(this.outcome ? { outcome: this.outcome } : {}),
			startedAt: this.startedAt,
			preparedMs: since(this.phases.get('prepared')),
			agentReadyMs: since(this.phases.get('agentReady')),
			promptMs: since(this.phases.get('prompt')),
			firstEventMs: since(this.firstEventAt),
			firstTextMs: since(this.firstTextAt),
			totalMs: since(this.endedAt),
			steps: this.steps,
			tools: {
				count: this.toolCount,
				errors: this.toolErrors,
				totalMs: this.toolTotalMs,
				maxMs: this.toolMaxMs,
				...(this.slowest ? { slowest: this.slowest } : {}),
			},
			retries: this.retries,
			stalls: this.stalls,
			loops: this.loops,
			compactions: this.compactions,
			continuations: this.continuations,
			errors: this.errors,
			tokens: { ...this.tokens },
		};
	}

	private classify(text: string): void {
		if (STALL.test(text)) {
			this.stalls++;
		}
		if (LOOP.test(text)) {
			this.loops++;
		}
	}
}

/** One log line: `agent/cold agent: prepared 4ms, agent ready 5.6s, prompt 5.6s, first event 6.7s, first text 9.1s, end 9.6s; tools 2 (1.2s, max 0.9s read_file)`. */
export function formatRunMetrics(metrics: IRunMetrics): string {
	const s = (ms: number | undefined) => ms === undefined ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	const head = `${metrics.engine}${metrics.agentSource ? `/${metrics.agentSource}` : ''} ${metrics.mode} ${metrics.outcome ?? 'running'}`;
	const phases = [
		`prepared ${s(metrics.preparedMs)}`,
		...(metrics.engine === 'agent' ? [`agent ready ${s(metrics.agentReadyMs)}`] : []),
		`prompt ${s(metrics.promptMs)}`,
		`first event ${s(metrics.firstEventMs)}`,
		`first text ${s(metrics.firstTextMs)}`,
		`end ${s(metrics.totalMs)}`,
	].join(', ');
	const tools = metrics.tools.count
		? `tools ${metrics.tools.count} (${s(metrics.tools.totalMs)}, max ${s(metrics.tools.maxMs)}${metrics.tools.slowest ? ` ${metrics.tools.slowest}` : ''}${metrics.tools.errors ? `, ${metrics.tools.errors} failed` : ''})`
		: 'tools 0';
	const extra = [
		metrics.steps ? `steps ${metrics.steps}` : '',
		metrics.retries ? `retries ${metrics.retries}` : '',
		metrics.stalls ? `stalls ${metrics.stalls}` : '',
		metrics.loops ? `loops ${metrics.loops}` : '',
		metrics.compactions ? `compactions ${metrics.compactions}` : '',
		metrics.continuations ? `continuations ${metrics.continuations}` : '',
	].filter(Boolean).join(', ');
	return `${head}: ${phases}; ${tools}${extra ? `; ${extra}` : ''}`;
}
