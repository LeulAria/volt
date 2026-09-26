/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type DevTranspileEngine = 'oxc' | 'rolldown' | 'esbuild' | 'tsc';

export function resolveDevTranspileEngine(explicit?: string): DevTranspileEngine {
	const raw = (explicit || process.env['VOLT_WATCH_ENGINE'] || '').trim().toLowerCase();
	if (process.env['VOLT_WATCH_TSC'] === '1' || raw === 'tsc') {
		return 'tsc';
	}
	if (raw === 'esbuild') {
		return 'esbuild';
	}
	if (raw === 'rolldown') {
		return 'rolldown';
	}
	return 'oxc';
}

export function isFastTranspileEngine(engine: DevTranspileEngine): engine is Exclude<DevTranspileEngine, 'tsc'> {
	return engine !== 'tsc';
}
