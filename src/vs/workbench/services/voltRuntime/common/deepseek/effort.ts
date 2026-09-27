/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltMode } from '../modes.js';

/**
 * How hard the model should think for this message when the user left reasoning on Auto.
 * Deterministic and instant: a greeting is answered at `low` in about a second, a refactor
 * across files gets `high`, and "think hard" gets the top level. The model still decides how
 * much of that budget it uses; this only sets the ceiling it works under.
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface IEffortContext {
	readonly mode: VoltMode;
	/** The level chosen for the previous message, so "continue" keeps the depth it had. */
	readonly previous?: EffortLevel;
	/** The user attached files, selections, or images. */
	readonly attachments?: number;
}

const SMALL_TALK = /^(?:hi|hello|hey|yo|thanks|thank you|thx|ty|ok(?:ay)?|yes|yep|no|nope|sure|cool|great|nice|perfect|got it|sounds good|lgtm)\b[\s!.,:)]*$/i;
const CONTINUE = /^(?:continue|go on|keep going|proceed|carry on|next|do it|go ahead|yes,? (?:do|continue|proceed)|resume)\b/i;
const DEEP = /\b(?:ultrathink|think (?:really |very )?hard|think deeply|think carefully|deep ?dive|be (?:very )?thorough|exhaustive(?:ly)?|rigorous(?:ly)?)\b/i;
const ACTION = /\b(?:fix|implement|add|build|create|write|refactor|rewrite|migrate|port|upgrade|optimi[sz]e|debug|change|update|remove|delete|rename|replace|convert|integrate|wire|set ?up|configure|design|make|generate|scaffold|test)\b/i;
const BROAD = /\b(?:architecture|across|entire|whole|all (?:the )?(?:files|places|usages|callers)|codebase|system|end[- ]to[- ]end|multi[- ]?file|every|redesign|overhaul|performance|security|concurren\w+|race condition|memory leak)\b/i;
const QUESTION = /^(?:what|how|why|where|when|which|who|is|are|does|do|can|could|should|would|explain|describe|tell me|show me)\b|\?\s*$/i;

export function chooseEffort(text: string, context: IEffortContext): EffortLevel {
	const trimmed = text.trim();
	const floor: EffortLevel = context.mode === 'plan' || context.mode === 'debug' ? 'high' : 'low';
	if (DEEP.test(trimmed)) {
		return 'max';
	}
	if (CONTINUE.test(trimmed) && trimmed.length < 60 && context.previous) {
		return atLeast(context.previous, floor);
	}
	if (SMALL_TALK.test(trimmed)) {
		return atLeast('low', floor);
	}
	const lines = trimmed.split('\n').filter(line => line.trim()).length;
	const bullets = trimmed.split('\n').filter(line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
	const action = ACTION.test(trimmed);
	const broad = BROAD.test(trimmed);
	let level: EffortLevel;
	if (!action && QUESTION.test(trimmed) && trimmed.length < 160 && !broad) {
		level = trimmed.length < 60 ? 'low' : 'medium';
	} else if (!action && !broad && trimmed.length < 80) {
		level = 'medium';
	} else if (broad || bullets >= 4 || trimmed.length > 1_500 || lines > 25) {
		level = trimmed.length > 3_000 || bullets >= 8 ? 'xhigh' : 'high';
	} else if (action) {
		level = trimmed.length < 120 && !context.attachments ? 'medium' : 'high';
	} else {
		level = 'medium';
	}
	return atLeast(level, floor);
}

const ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function atLeast(level: EffortLevel, floor: EffortLevel): EffortLevel {
	return ORDER.indexOf(level) >= ORDER.indexOf(floor) ? level : floor;
}
