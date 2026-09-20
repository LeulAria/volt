/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent observability. Every interesting decision the harness makes is a span or a metric;
 * the optimizer reads those back and returns *hints*, never commands. A hint that said
 * "switch models" would fight the router; a hint that said "this role keeps timing out"
 * is something the router can take or leave.
 */

export type SpanKind = 'decision' | 'tool' | 'model' | 'plan' | 'recovery' | 'verify';

export interface ISpan {
	readonly id: string;
	readonly kind: SpanKind;
	readonly name: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly ok?: boolean;
	readonly detail?: string;
	readonly tokens?: { readonly input: number; readonly output: number };
	readonly cost?: number;
}

export interface IRuntimeMetrics {
	readonly spans: number;
	readonly errors: number;
	readonly tokensIn: number;
	readonly tokensOut: number;
	readonly cost: number;
	readonly latencyMs: number;
	readonly toolCalls: number;
	readonly recoveries: number;
}

export type OptimizerHintTarget = 'model' | 'tools' | 'context';

export interface IOptimizerHint {
	readonly target: OptimizerHintTarget;
	readonly message: string;
}

export class Observability {

	private readonly spans: ISpan[] = [];
	private seq = 0;

	start(kind: SpanKind, name: string, now = Date.now()): ISpan {
		const span: ISpan = { id: `sp${++this.seq}`, kind, name, startedAt: now };
		this.spans.push(span);
		return span;
	}

	end(id: string, ok = true, detail?: string, now = Date.now(), extra?: Pick<ISpan, 'tokens' | 'cost'>): ISpan | undefined {
		const index = this.spans.findIndex(span => span.id === id);
		if (index < 0) {
			return undefined;
		}
		const next: ISpan = {
			...this.spans[index],
			endedAt: now,
			ok,
			...(detail ? { detail } : {}),
			...(extra?.tokens ? { tokens: extra.tokens } : {}),
			...(extra?.cost ? { cost: extra.cost } : {}),
		};
		this.spans[index] = next;
		return next;
	}

	record(kind: SpanKind, name: string, ok: boolean, detail?: string, now = Date.now()): ISpan {
		const span = this.start(kind, name, now);
		return this.end(span.id, ok, detail, now) ?? span;
	}

	all(): readonly ISpan[] {
		return this.spans;
	}

	metrics(): IRuntimeMetrics {
		let tokensIn = 0;
		let tokensOut = 0;
		let cost = 0;
		let latencyMs = 0;
		let errors = 0;
		let toolCalls = 0;
		let recoveries = 0;
		for (const span of this.spans) {
			tokensIn += span.tokens?.input ?? 0;
			tokensOut += span.tokens?.output ?? 0;
			cost += span.cost ?? 0;
			if (span.endedAt) {
				latencyMs += Math.max(0, span.endedAt - span.startedAt);
			}
			if (span.ok === false) {
				errors++;
			}
			if (span.kind === 'tool') {
				toolCalls++;
			}
			if (span.kind === 'recovery') {
				recoveries++;
			}
		}
		return {
			spans: this.spans.length,
			errors,
			tokensIn,
			tokensOut,
			cost: round4(cost),
			latencyMs,
			toolCalls,
			recoveries,
		};
	}

	optimize(): IOptimizerHint[] {
		const metrics = this.metrics();
		const hints: IOptimizerHint[] = [];
		if (metrics.errors >= 3 && metrics.toolCalls > 0 && metrics.errors / metrics.toolCalls >= 0.5) {
			hints.push({ target: 'tools', message: 'More than half of recent tool calls failed; rank safer tools first.' });
		}
		if (metrics.recoveries >= 2) {
			hints.push({ target: 'model', message: 'The run has recovered twice; a stronger model is likely cheaper than another retry.' });
		}
		if (metrics.tokensIn > 80_000 && metrics.toolCalls < 3) {
			hints.push({ target: 'context', message: 'A large context produced almost no tool work; compact before the next turn.' });
		}
		return hints;
	}
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}
