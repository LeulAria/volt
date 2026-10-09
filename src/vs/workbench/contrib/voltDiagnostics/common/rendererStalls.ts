/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltStallAttribution } from '../../../../platform/voltDiagnostics/common/voltDiagnostics.js';

/** The parts of Chromium's Long Animation Frame entry Volt reads (not in lib.dom yet). */
export interface ILongAnimationFrameScript {
	readonly duration: number;
	readonly invoker?: string;
	readonly invokerType?: string;
	readonly sourceURL?: string;
	readonly sourceFunctionName?: string;
	readonly sourceCharPosition?: number;
}

export interface ILongFrameEntry {
	readonly entryType: string;
	/** Relative to `performance.timeOrigin`. */
	readonly startTime: number;
	readonly duration: number;
	readonly blockingDuration?: number;
	readonly scripts?: readonly ILongAnimationFrameScript[];
}

export interface ILastCommand {
	readonly id: string;
	/** Epoch milliseconds. */
	readonly time: number;
}

/** `out/vs/workbench/foo.js` from a full `vscode-file://` or `file://` URL; other URLs as they are. */
export function shortSource(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	const marker = url.search(/\/(out|src)\/vs\//);
	return marker >= 0 ? url.slice(marker + 1) : url;
}

function describeScript(script: ILongAnimationFrameScript): string {
	const fn = script.sourceFunctionName || script.invoker || script.invokerType || 'script';
	const source = shortSource(script.sourceURL);
	const where = source ? ` (${source}${script.sourceCharPosition !== undefined && script.sourceCharPosition >= 0 ? `:${script.sourceCharPosition}` : ''})` : '';
	const invoker = script.invoker && script.invoker !== fn ? ` from ${script.invoker}` : '';
	return `${fn}${where}${invoker}`;
}

/**
 * What a long frame spent its time on: its longest scripts (Long Animation Frame attribution),
 * and the command that started inside or just before it.
 */
export function attributeLongFrame(entry: ILongFrameEntry, timeOrigin: number, lastCommand: ILastCommand | undefined, maxScripts = 2): IVoltStallAttribution[] {
	const result: IVoltStallAttribution[] = [];
	const scripts = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, maxScripts);
	for (const script of scripts) {
		if (script.duration >= 1) {
			result.push({ kind: 'script', detail: describeScript(script), durationMs: script.duration });
		}
	}
	const start = timeOrigin + entry.startTime;
	if (lastCommand && lastCommand.time >= start - 50 && lastCommand.time <= start + entry.duration) {
		result.push({ kind: 'command', detail: lastCommand.id });
	}
	return result;
}
