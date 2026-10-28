/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { estimateTokens } from './contextEngine.js';

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

/** Tokens of tool output the model read, by tool and by file (the largest few). */
export interface IRunTokenMeters {
	readonly toolOutput: number;
	readonly byTool: readonly { readonly name: string; readonly calls: number; readonly tokens: number }[];
	readonly byFile: readonly { readonly path: string; readonly tokens: number }[];
	/** Model requests (usage reports) and the largest input among them. */
	readonly requests: number;
	readonly maxRequestInput: number;
}

/** What the context retriever gave the agent before its first step, and how much of it the agent used. */
export interface IRunRetrieval {
	readonly ms: number;
	readonly tokens: number;
	readonly files: number;
	/** Offered files the agent then read, searched in or edited. */
	readonly used: number;
	readonly partial: boolean;
}

/**
 * A native run's evidence as the harness saw it when the model finished: whether the work is
 * proven done (checks ran and passed, the files the task needs changed), and the recoveries the
 * run tried with whether each worked. Kept with the run's metrics and trace, for evals.
 */
export interface IRunEvidence {
	readonly complete: boolean;
	readonly reason: string;
	readonly proven?: boolean;
	readonly confidence?: number;
	readonly changedFiles: number;
	/** `doom → nudge: worked (read_file)`, one per recovery. */
	readonly lessons: readonly string[];
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
	readonly usage?: IRunTokenMeters;
	readonly retrieval?: IRunRetrieval;
	readonly evidence?: IRunEvidence;
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
	private readonly toolTokens = new Map<string, { calls: number; tokens: number }>();
	private readonly fileTokens = new Map<string, number>();
	private readonly callPaths = new Map<string, string>();
	private requests = 0;
	private maxRequestInput = 0;
	private retrieval: { ms: number; tokens: number; files: readonly string[]; partial: boolean } | undefined;
	private readonly usedFiles = new Set<string>();
	private evidence: IRunEvidence | undefined;

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

	noteEvidence(evidence: IRunEvidence): void {
		this.evidence = evidence;
	}

	/** The context retriever's block for this run; later tool calls that touch its files count as used. */
	noteRetrieval(retrieval: { readonly ms: number; readonly tokens: number; readonly files: readonly string[]; readonly partial: boolean }): void {
		this.retrieval = { ...retrieval };
	}

	private noteUse(text: string | undefined): void {
		if (text && this.retrieval) {
			for (const path of this.retrieval.files) {
				if (text.includes(path)) {
					this.usedFiles.add(path);
				}
			}
		}
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
					const path = event.locations?.[0]?.path ?? pathArg(event.input);
					if (path) {
						this.callPaths.set(event.callId, path);
					}
					this.noteUse(event.input);
					this.noteUse(event.locations?.map(location => location.path).join('\n'));
				}
				break;
			case 'tool.end': {
				const open = this.openTools.get(event.callId);
				const output = typeof event.output === 'string' ? event.output : typeof event.result === 'string' ? event.result : '';
				if (open && output) {
					const tokens = estimateTokens(output);
					const meter = this.toolTokens.get(open.name) ?? { calls: 0, tokens: 0 };
					meter.calls++;
					meter.tokens += tokens;
					this.toolTokens.set(open.name, meter);
					const path = this.callPaths.get(event.callId);
					if (path) {
						this.fileTokens.set(path, (this.fileTokens.get(path) ?? 0) + tokens);
					}
				}
				this.callPaths.delete(event.callId);
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
				this.requests++;
				this.maxRequestInput = Math.max(this.maxRequestInput, event.used ?? event.input + (event.cache ?? 0));
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
			usage: {
				toolOutput: [...this.toolTokens.values()].reduce((sum, meter) => sum + meter.tokens, 0),
				byTool: [...this.toolTokens].map(([name, meter]) => ({ name, ...meter })).sort((a, b) => b.tokens - a.tokens).slice(0, 8),
				byFile: [...this.fileTokens].map(([path, tokens]) => ({ path, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 5),
				requests: this.requests,
				maxRequestInput: this.maxRequestInput,
			},
			...(this.retrieval ? { retrieval: { ms: this.retrieval.ms, tokens: this.retrieval.tokens, files: this.retrieval.files.length, used: this.usedFiles.size, partial: this.retrieval.partial } } : {}),
			...(this.evidence ? { evidence: this.evidence } : {}),
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
	const k = (tokens: number) => tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
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
		metrics.usage?.toolOutput ? `tool output ~${k(metrics.usage.toolOutput)} tokens (${metrics.usage.byTool.slice(0, 3).map(meter => `${meter.name} ${k(meter.tokens)}`).join(', ')})` : '',
		metrics.usage?.requests ? `requests ${metrics.usage.requests} (max input ${k(metrics.usage.maxRequestInput)})` : '',
		metrics.retrieval ? `retrieval ${s(metrics.retrieval.ms)} ${k(metrics.retrieval.tokens)} tokens, ${metrics.retrieval.used}/${metrics.retrieval.files} files used${metrics.retrieval.partial ? ', cut short' : ''}` : '',
	].filter(Boolean).join(', ');
	return `${head}: ${phases}; ${tools}${extra ? `; ${extra}` : ''}`;
}

/** The file a tool call is about, from its JSON arguments (`path`, `file_path`, `file`). */
function pathArg(input: string | undefined): string | undefined {
	if (!input || input[0] !== '{') {
		return undefined;
	}
	try {
		const args = JSON.parse(input) as Record<string, unknown>;
		const path = args['path'] ?? args['file_path'] ?? args['file'];
		return typeof path === 'string' ? path : undefined;
	} catch {
		return undefined;
	}
}
