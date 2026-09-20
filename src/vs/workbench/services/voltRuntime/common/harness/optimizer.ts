/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOptimizerHint } from './observability.js';
import { IStrategyPlan } from './strategy.js';
import { IToolPlan } from './toolPlanner.js';

/**
 * Execution optimizer. Eval and observability emit *hints*; this is the only place those
 * hints become a change to the next run. The router still picks the model, the planner
 * still owns the DAG - we only tighten contingency, compact earlier, and rerank tools.
 *
 * Measured, not intuited: a hint that has not shown up in the ledger does nothing.
 */

export interface IOptimizedRun {
	readonly strategy: IStrategyPlan;
	readonly tools: IToolPlan;
	readonly forceCompact: boolean;
	readonly preferEscalate: boolean;
}

export function applyEvalHints(
	strategy: IStrategyPlan,
	tools: IToolPlan,
	hints: readonly IOptimizerHint[],
): IOptimizedRun {
	if (!hints.length) {
		return { strategy, tools, forceCompact: false, preferEscalate: false };
	}

	let forceCompact = false;
	let preferEscalate = false;
	let nextStrategy = strategy;
	let nextTools = tools;

	for (const hint of hints) {
		if (hint.target === 'context') {
			forceCompact = true;
		}
		if (hint.target === 'model') {
			preferEscalate = true;
			nextStrategy = {
				...nextStrategy,
				contingency: {
					...nextStrategy.contingency,
					onFail: 'escalate',
					onBudget: 'escalate',
				},
			};
		}
		if (hint.target === 'tools') {
			nextTools = saferTools(nextTools);
			if (/looped|doom/i.test(hint.message)) {
				nextStrategy = {
					...nextStrategy,
					contingency: { ...nextStrategy.contingency, onStuck: 'switch' },
				};
			}
			if (/regress/i.test(hint.message)) {
				nextStrategy = {
					...nextStrategy,
					contingency: { ...nextStrategy.contingency, onRegression: 'rollback' },
				};
			}
		}
	}

	return { strategy: nextStrategy, tools: nextTools, forceCompact, preferEscalate };
}

function saferTools(plan: IToolPlan): IToolPlan {
	const hints = plan.hints.map(hint => {
		let score = hint.score;
		if (hint.parallelSafe) {
			score += 0.12;
		}
		if (hint.group === 'edit' || hint.group === 'shell') {
			score -= 0.08;
		}
		return { ...hint, score: Math.round(score * 100) / 100 };
	}).sort((a, b) => b.score - a.score);
	return {
		...plan,
		hints,
		suggested: hints.filter(hint => hint.group !== 'meta').slice(0, 4).map(hint => hint.name),
	};
}
