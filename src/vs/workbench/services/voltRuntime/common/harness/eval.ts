/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltLane } from './lanes.js';
import { IOptimizerHint } from './observability.js';
import { RunStrategy } from './strategy.js';

/**
 * Eval engine. Cursor's harness work is measured, not intuited - Volt scores every
 * finished run on the same meters so routing, strategy, and tool ranking can move
 * from "feels better" to "this lane's success rate went up".
 *
 * This is a first-class engine, not a later dashboard. Production records a sample
 * at `run.end`; tests and offline benches feed the same `scoreSample`.
 */

export interface IEvalSample {
	readonly lane: VoltLane;
	readonly strategy: RunStrategy;
	readonly outcome: 'done' | 'abort' | 'fail' | 'budget';
	readonly complete: boolean;
	readonly steps: number;
	readonly tools: number;
	readonly toolErrors: number;
	readonly tokens: number;
	readonly durationMs: number;
	readonly recoveries: number;
	readonly doom: boolean;
	readonly regression: boolean;
	readonly stuck: boolean;
	readonly confidence: number;
}

export interface IEvalMeters {
	readonly successRate: number;
	readonly stepsPerTask: number;
	readonly tokensPerTask: number;
	readonly latencyMs: number;
	readonly toolAccuracy: number;
	readonly recoveryRate: number;
	readonly doomRate: number;
	readonly regressionRate: number;
}

export interface IEvalReport {
	readonly sample: IEvalSample;
	readonly meters: IEvalMeters;
	readonly score: number;
	readonly hints: readonly IOptimizerHint[];
}

export function scoreSample(sample: IEvalSample): IEvalReport {
	const success = sample.outcome === 'done' && sample.complete ? 1 : 0;
	const toolAccuracy = sample.tools ? 1 - (sample.toolErrors / sample.tools) : 1;
	const recoveryRate = sample.recoveries ? (sample.outcome === 'done' ? 1 : 0.3) : (sample.stuck || sample.doom ? 0 : 1);
	const meters: IEvalMeters = {
		successRate: success,
		stepsPerTask: sample.steps,
		tokensPerTask: sample.tokens,
		latencyMs: sample.durationMs,
		toolAccuracy: round3(clamp01(toolAccuracy)),
		recoveryRate: round3(clamp01(recoveryRate)),
		doomRate: sample.doom ? 1 : 0,
		regressionRate: sample.regression ? 1 : 0,
	};
	const score = round3(clamp01(
		0.40 * success +
		0.20 * meters.toolAccuracy +
		0.15 * meters.recoveryRate +
		0.10 * sample.confidence +
		0.15 * (1 - meters.doomRate) * (1 - meters.regressionRate),
	));
	return { sample, meters, score, hints: hintsOf(sample, meters) };
}

export class EvalLedger {

	private readonly samples: IEvalReport[] = [];

	record(sample: IEvalSample): IEvalReport {
		const report = scoreSample(sample);
		this.samples.push(report);
		return report;
	}

	all(): readonly IEvalReport[] {
		return this.samples;
	}

	aggregate(lane?: VoltLane): IEvalMeters | undefined {
		const rows = lane ? this.samples.filter(item => item.sample.lane === lane) : this.samples;
		if (!rows.length) {
			return undefined;
		}
		return {
			successRate: avg(rows, item => item.meters.successRate),
			stepsPerTask: avg(rows, item => item.meters.stepsPerTask),
			tokensPerTask: avg(rows, item => item.meters.tokensPerTask),
			latencyMs: avg(rows, item => item.meters.latencyMs),
			toolAccuracy: avg(rows, item => item.meters.toolAccuracy),
			recoveryRate: avg(rows, item => item.meters.recoveryRate),
			doomRate: avg(rows, item => item.meters.doomRate),
			regressionRate: avg(rows, item => item.meters.regressionRate),
		};
	}

	hints(): readonly IOptimizerHint[] {
		const meters = this.aggregate();
		if (!meters) {
			return [];
		}
		const hints: IOptimizerHint[] = [];
		if (meters.successRate < 0.5 && this.samples.length >= 3) {
			hints.push({ target: 'model', message: 'Success rate is below half; escalate the default coding model.' });
		}
		if (meters.doomRate > 0.1) {
			hints.push({ target: 'tools', message: 'Doom loops are showing up; rank novel tools ahead of repeats.' });
		}
		if (meters.tokensPerTask > 80_000 && meters.stepsPerTask < 4) {
			hints.push({ target: 'context', message: 'Tokens are high for short runs; compact earlier.' });
		}
		if (meters.toolAccuracy < 0.7) {
			hints.push({ target: 'tools', message: 'Tool accuracy is low; tighten schemas and drop unused groups.' });
		}
		return hints;
	}
}

function hintsOf(sample: IEvalSample, meters: IEvalMeters): IOptimizerHint[] {
	const hints: IOptimizerHint[] = [];
	if (sample.doom) {
		hints.push({ target: 'tools', message: 'This run looped; the next attempt should switch tools before retrying.' });
	}
	if (sample.regression) {
		hints.push({ target: 'model', message: 'A passing check regressed; prefer rollback before another edit.' });
	}
	if (meters.toolAccuracy < 0.5 && sample.tools >= 3) {
		hints.push({ target: 'tools', message: 'Most tool calls failed; rank safer tools first.' });
	}
	if (sample.outcome === 'budget') {
		hints.push({ target: 'model', message: 'The lane budget ran out; a stronger model or a mission lane is cheaper than another retry.' });
	}
	return hints;
}

function avg(rows: readonly IEvalReport[], pick: (row: IEvalReport) => number): number {
	return round3(rows.reduce((total, row) => total + pick(row), 0) / rows.length);
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round3(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}
