/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type VoltMode = 'agent' | 'plan' | 'ask' | 'debug' | 'multitask';

export const VOLT_MODES: readonly VoltMode[] = ['agent', 'plan', 'ask', 'debug', 'multitask'];

export function normalizeVoltMode(value: string | undefined): VoltMode {
	const id = (value ?? 'agent').toLowerCase();
	return (VOLT_MODES as readonly string[]).includes(id) ? id as VoltMode : 'agent';
}

export interface IModePolicy {
	readonly mode: VoltMode;
	readonly allowWrites: boolean;
	readonly allowTerminal: boolean;
	readonly allowMcp: boolean;
	readonly routingHint: 'fast' | 'balanced' | 'reasoning';
}

export function modePolicy(mode: VoltMode): IModePolicy {
	switch (mode) {
		case 'ask':
			return { mode, allowWrites: false, allowTerminal: false, allowMcp: false, routingHint: 'fast' };
		case 'plan':
			return { mode, allowWrites: false, allowTerminal: false, allowMcp: true, routingHint: 'reasoning' };
		case 'debug':
			return { mode, allowWrites: true, allowTerminal: true, allowMcp: true, routingHint: 'reasoning' };
		case 'multitask':
			return { mode, allowWrites: true, allowTerminal: true, allowMcp: true, routingHint: 'balanced' };
		case 'agent':
		default:
			return { mode: 'agent', allowWrites: true, allowTerminal: true, allowMcp: true, routingHint: 'balanced' };
	}
}
