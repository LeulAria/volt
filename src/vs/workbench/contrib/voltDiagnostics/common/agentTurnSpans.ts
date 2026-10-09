/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltSpan, VoltTracer } from '../../../../platform/voltDiagnostics/common/tracer.js';
import { VoltAttributes, VoltSpanStatusCode } from '../../../../platform/voltDiagnostics/common/voltDiagnostics.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../services/voltRuntime/common/events.js';
import type { IRunMetrics } from '../../../services/voltRuntime/common/harness/runMetrics.js';

/** What the runtime's events do not carry but the services around it know. */
export interface IAgentTurnLookups {
	/** The chat a runtime session belongs to (warm spares run under an alias). */
	chatFor(sessionId: string): string;
	/** The orchestrator's view of the chat's turn, when it has one. */
	turn(chatId: string): { readonly turnId?: string; readonly kind?: string; readonly modelLabel?: string; readonly depth?: number; readonly subagent?: boolean } | undefined;
	/** The finished run's meters; recorded right after `run.end` is emitted. */
	metrics(sessionId: string, runId: string): IRunMetrics | undefined;
	/** The catalog entry behind a model or agent reference. */
	model(providerRef: string): { readonly providerId: string; readonly modelId: string; readonly label: string } | undefined;
	/** Defers work until the current emit finished (run metrics are pushed after `run.end`). */
	defer(callback: () => void): void;
}

interface IRunSpans {
	readonly turn: IVoltSpan;
	readonly sessionId: string;
	readonly tools: Map<string, IVoltSpan>;
	readonly subagents: Map<string, IVoltSpan>;
	usage?: { input: number; output: number; cache: number; used?: number };
	/** The last error the run reported; a retry may still recover from it. */
	error?: string;
}

const MAX_TEXT = 160;
const SIMPLE_NAME = /^[\w.:\-/]{1,48}$/;

function clip(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
}

/** Span names stay low cardinality: the tool name only when it looks like an identifier. */
export function toolSpanName(name: string): string {
	return SIMPLE_NAME.test(name) ? `execute_tool ${name}` : 'execute_tool';
}

/**
 * Turns runtime events into spans: one `invoke_agent` span per run (send to end), an
 * `execute_tool` child per tool call, and an `invoke_agent` child per harness subagent with its
 * own tool calls under it. Attribute names follow the OpenTelemetry GenAI conventions where one
 * exists; the rest are `volt.*`.
 */
export class AgentTurnSpans {

	private readonly runs = new Map<string, IRunSpans>();

	constructor(
		private readonly tracer: VoltTracer,
		private readonly lookups: IAgentTurnLookups,
	) { }

	get openRuns(): number {
		return this.runs.size;
	}

	handle(envelope: IVoltEventEnvelope): void {
		const event = envelope.event;
		if (event.type === 'run.start') {
			this.startRun(envelope, event.mode);
			return;
		}
		const run = this.runs.get(envelope.runId);
		if (!run) {
			return;
		}
		const at = envelope.timestamp;
		switch (event.type) {
			case 'lane':
				run.turn.setAttribute('volt.agent.lane', event.lane);
				break;
			case 'tool.start':
			case 'tool.update':
			case 'tool.end':
				this.tool(run.turn, run.tools, event, at);
				break;
			case 'usage': {
				const usage = run.usage ??= { input: 0, output: 0, cache: 0 };
				usage.input += event.input;
				usage.output += event.output;
				usage.cache += event.cache ?? 0;
				usage.used = event.used ?? usage.used;
				break;
			}
			case 'retry':
				run.turn.addEvent('retry', { 'volt.retry.attempt': event.attempt, 'volt.retry.delay_ms': event.delayMs, 'volt.retry.message': clip(event.message) }, at);
				break;
			case 'error':
				run.turn.addEvent('exception', { 'exception.message': clip(event.message), 'volt.error.retryable': event.retryable }, at);
				run.error = clip(event.message);
				break;
			case 'notice':
				if (event.severity !== 'info') {
					run.turn.addEvent('notice', { 'volt.notice.severity': event.severity, 'volt.notice.title': clip(event.title) }, at);
				}
				break;
			case 'compaction':
				run.turn.addEvent('compaction', { 'volt.compaction.dropped': event.dropped, 'volt.compaction.stages': [...event.stages] }, at);
				break;
			case 'access.ask':
				run.turn.addEvent('access.ask', { 'volt.access.request_id': event.request.id }, at);
				break;
			case 'access.resolved':
				run.turn.addEvent('access.resolved', { 'volt.access.request_id': event.requestId, 'volt.access.effect': event.effect, 'volt.access.scope': event.scope }, at);
				break;
			case 'question.ask':
				run.turn.addEvent('question.ask', { 'volt.question.request_id': event.request.id }, at);
				break;
			case 'question.resolved':
				run.turn.addEvent('question.resolved', { 'volt.question.request_id': event.requestId, 'volt.question.outcome': event.outcome }, at);
				break;
			case 'finish':
				run.turn.setAttribute('gen_ai.response.finish_reasons', [event.reason]);
				break;
			case 'subagent.spawned': {
				const parent = (event.parentToolCallId && run.tools.get(event.parentToolCallId)) || run.turn;
				run.subagents.set(event.childId, this.tracer.startSpan('invoke_agent', {
					parent,
					startTime: at,
					attributes: {
						'gen_ai.operation.name': 'invoke_agent',
						'gen_ai.agent.name': clip(event.title),
						'gen_ai.request.model': event.model,
						'volt.subagent.source': event.source,
						'volt.subagent.kind': event.kind,
						'volt.subagent.id': event.childId,
					},
				}));
				break;
			}
			case 'subagent.update': {
				const span = run.subagents.get(event.childId);
				span?.setAttribute('gen_ai.request.model', event.model);
				break;
			}
			case 'subagent.event': {
				const span = run.subagents.get(event.childId);
				const inner = event.event;
				if (span && (inner.type === 'tool.start' || inner.type === 'tool.update' || inner.type === 'tool.end')) {
					this.tool(span, run.tools, inner, at, `${event.childId}/`);
				}
				break;
			}
			case 'subagent.completed': {
				const span = run.subagents.get(event.childId);
				if (span) {
					span.setAttribute('volt.subagent.status', event.status);
					if (event.status === 'failed') {
						span.setStatus(VoltSpanStatusCode.Error, clip(event.error));
					} else if (event.status === 'completed') {
						span.setStatus(VoltSpanStatusCode.Ok);
					}
					span.end(at);
					run.subagents.delete(event.childId);
				}
				break;
			}
			case 'run.end':
				this.endRun(envelope.runId, run, event.reason, at);
				break;
		}
	}

	/** Ends every open run (window closing, tracing turned off). */
	endAll(reason: string): void {
		const now = Date.now();
		for (const [runId, run] of [...this.runs]) {
			run.turn.setAttribute('volt.turn.interrupted', reason);
			this.closeChildren(run, now);
			run.turn.end(now);
			this.runs.delete(runId);
		}
	}

	private startRun(envelope: IVoltEventEnvelope, mode: string): void {
		const chatId = this.lookups.chatFor(envelope.sessionId);
		const turn = this.lookups.turn(chatId);
		const attributes: VoltAttributes = {
			'gen_ai.operation.name': 'invoke_agent',
			'volt.run.id': envelope.runId,
			'volt.chat.id': chatId,
			'volt.agent.mode': mode,
			'volt.turn.id': turn?.turnId,
			'volt.turn.kind': turn?.kind,
			'volt.chat.depth': turn?.depth,
			'volt.chat.subagent': turn?.subagent,
			'gen_ai.agent.name': turn?.modelLabel,
		};
		this.runs.get(envelope.runId)?.turn.end(envelope.timestamp);
		this.runs.set(envelope.runId, {
			turn: this.tracer.startSpan('invoke_agent', { startTime: envelope.timestamp, attributes }),
			sessionId: envelope.sessionId,
			tools: new Map(),
			subagents: new Map(),
		});
	}

	private tool(parent: IVoltSpan, tools: Map<string, IVoltSpan>, event: Extract<IVoltEvent, { type: 'tool.start' | 'tool.update' | 'tool.end' }>, at: number, keyPrefix = ''): void {
		const key = keyPrefix + event.callId;
		if (event.type === 'tool.start') {
			const open = tools.get(key);
			if (open) {
				// Some engines announce a call again once its input is complete: same call, one span.
				open.setAttributes({ 'volt.tool.title': clip(event.title), 'volt.tool.kind': event.kind, 'volt.tool.card': event.card });
				return;
			}
			tools.set(key, this.tracer.startSpan(toolSpanName(event.name), {
				parent,
				startTime: at,
				attributes: {
					'gen_ai.operation.name': 'execute_tool',
					'gen_ai.tool.name': clip(event.name),
					'gen_ai.tool.call.id': event.callId,
					'volt.tool.title': clip(event.title),
					'volt.tool.kind': event.kind,
					'volt.tool.card': event.card,
				},
			}));
			return;
		}
		const span = tools.get(key);
		if (!span) {
			return;
		}
		if (event.type === 'tool.update') {
			span.setAttributes({ 'volt.tool.title': clip(event.title), 'volt.tool.kind': event.kind });
			return;
		}
		span.setAttributes({
			'volt.tool.title': clip(event.title),
			'volt.tool.card': event.card,
			'process.exit.code': event.exitCode,
			'volt.tool.duration_ms': event.durationMs,
		});
		if (event.error) {
			span.setStatus(VoltSpanStatusCode.Error, clip(event.error));
		} else {
			span.setStatus(VoltSpanStatusCode.Ok);
		}
		span.end(at);
		tools.delete(key);
	}

	private endRun(runId: string, run: IRunSpans, reason: 'done' | 'abort' | 'fail', at: number): void {
		this.runs.delete(runId);
		const turn = run.turn;
		turn.setAttribute('volt.turn.outcome', reason);
		if (reason === 'done') {
			turn.setStatus(VoltSpanStatusCode.Ok);
		} else if (reason === 'fail') {
			turn.setStatus(VoltSpanStatusCode.Error, run.error ?? 'run failed');
		}
		this.closeChildren(run, at);
		this.lookups.defer(() => {
			const metrics = this.lookups.metrics(run.sessionId, runId);
			const ref = metrics?.providerRef;
			const model = ref ? this.lookups.model(ref) : undefined;
			const usage = run.usage;
			turn.setAttributes({
				'gen_ai.request.model': model?.modelId ?? ref,
				'gen_ai.provider.name': model?.providerId,
				'volt.model.ref': ref,
				'volt.model.label': model?.label,
				'volt.agent.engine': metrics?.engine,
				'volt.agent.source': metrics?.agentSource,
				'gen_ai.usage.input_tokens': metrics?.tokens.input ?? usage?.input,
				'gen_ai.usage.output_tokens': metrics?.tokens.output ?? usage?.output,
				'volt.usage.cache_tokens': metrics?.tokens.cache ?? usage?.cache,
				'volt.usage.context_tokens': usage?.used,
				'volt.run.steps': metrics?.steps,
				'volt.run.tool_calls': metrics?.tools.count,
				'volt.run.tool_errors': metrics?.tools.errors,
				'volt.run.retries': metrics?.retries,
				'volt.run.compactions': metrics?.compactions,
				'volt.run.first_text_ms': metrics?.firstTextMs,
				'volt.run.agent_ready_ms': metrics?.agentReadyMs,
			});
			turn.end(at);
		});
	}

	private closeChildren(run: IRunSpans, at: number): void {
		for (const span of run.tools.values()) {
			span.setAttribute('volt.tool.unfinished', true);
			span.end(at);
		}
		run.tools.clear();
		for (const span of run.subagents.values()) {
			span.setAttribute('volt.subagent.unfinished', true);
			span.end(at);
		}
		run.subagents.clear();
	}
}
