/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Native control loop as an explicit OODA cycle:
 *
 *   observe  workspace · tool results · tests · state
 *   orient   update beliefs · context · task state
 *   reason   choose strategy
 *   decide   next action
 *   act      tools / model
 *   reflect  was the action useful?
 *   learn    update task strategy
 *
 * The stream→tools loop is the *act*. This module names the phases around it so the event
 * log, the UI, and the recovery controller can talk about the same turn without guessing
 * from tool names.
 */

export type OodaPhase = 'observe' | 'orient' | 'reason' | 'decide' | 'act' | 'reflect' | 'learn';

export const OODA_PHASES: readonly OodaPhase[] = ['observe', 'orient', 'reason', 'decide', 'act', 'reflect', 'learn'];

export interface IOodaState {
	readonly phase: OodaPhase;
	readonly cycle: number;
	readonly history: readonly OodaPhase[];
}

const NEXT: Readonly<Record<OodaPhase, OodaPhase>> = {
	observe: 'orient',
	orient: 'reason',
	reason: 'decide',
	decide: 'act',
	act: 'reflect',
	reflect: 'learn',
	learn: 'observe',
};

export function createOoda(): IOodaState {
	return { phase: 'observe', cycle: 1, history: ['observe'] };
}

export function advanceOoda(state: IOodaState, to?: OodaPhase): IOodaState {
	const phase = to ?? NEXT[state.phase];
	const wrapped = state.phase === 'learn' && phase === 'observe';
	return {
		phase,
		cycle: wrapped ? state.cycle + 1 : state.cycle,
		history: [...state.history, phase].slice(-24),
	};
}

/**
 * Where a loop event sits in the cycle. The controller uses this to emit one `ooda` event
 * per interesting moment rather than one per function call.
 */
export function phaseFor(event: 'step-start' | 'tools-done' | 'progress' | 'recovery' | 'directive' | 'finish'): OodaPhase {
	switch (event) {
		case 'step-start': return 'act';
		case 'tools-done': return 'observe';
		case 'progress': return 'orient';
		case 'recovery': return 'reason';
		case 'directive': return 'decide';
		case 'finish': return 'learn';
	}
}

export function oodaLabel(phase: OodaPhase): string {
	switch (phase) {
		case 'observe': return 'Observe workspace, tool results, and state';
		case 'orient': return 'Update beliefs, context, and task state';
		case 'reason': return 'Choose strategy';
		case 'decide': return 'Pick the next action';
		case 'act': return 'Act';
		case 'reflect': return 'Was the action useful?';
		case 'learn': return 'Update the task strategy';
	}
}
