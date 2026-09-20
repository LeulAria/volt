/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIntentSignals } from './intake.js';
import { IIntent } from './intent.js';
import { IStrategyPlan, RunStrategy } from './strategy.js';
import { ITaskIntel } from './taskIntel.js';

/**
 * Decision engine vocabulary. The pipeline still *runs* the left-hand boxes;
 * this names the request the way the flowchart does - chat · answer · edit ·
 * debug · build · research · mission - so routing, eval, and the work log
 * share one word for "what kind of ask this is".
 */

export type RequestKind = 'chat' | 'answer' | 'edit' | 'debug' | 'build' | 'research' | 'mission';

export function requestKindOf(intent: IIntent, signals: IIntentSignals, intel: ITaskIntel, strategy?: RunStrategy | IStrategyPlan): RequestKind {
	const chosen = typeof strategy === 'string' ? strategy : strategy?.strategy;
	if (intent.lane === 'mission' || chosen === 'mission-contract') {
		return 'mission';
	}
	if (chosen === 'debug' || intent.signals.some(signal => /debug/.test(signal))) {
		return 'debug';
	}
	if (chosen === 'research-first' || chosen === 'research-answer' || intel.shape.lookup || (signals.webRequired && intel.complexityScore >= 0.3)) {
		return 'research';
	}
	if (intel.successCriteria.some(criterion => criterion.evidence === 'build' || criterion.evidence === 'test')) {
		return 'build';
	}
	if (intent.lane === 'chat') {
		return signals.webRequired || !intent.referencesWorkspace ? 'answer' : 'chat';
	}
	if (intent.lane === 'fast' || chosen === 'fast-edit') {
		return 'edit';
	}
	return 'edit';
}
