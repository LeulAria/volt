/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { loopCallRecord, LoopDetector } from './doomLoop.js';
import { createLoopDetector } from './recovery.js';
import { ILoopDetector, ILoopSignal, ISupervisedCall, ToolLoopDetector } from './supervisor.js';
import { ToolKind } from './workLog.js';

/**
 * The ACP run supervisor's loop detector, built from both detectors Volt has. The supervisor's
 * own `ToolLoopDetector` works on what an ACP tool call reports (failures, alternation, identical
 * results); the native loop's `LoopDetector` adds near-duplicate calls (same call modulo spacing
 * and numbers, same result) and runs of calls that learn nothing new. The supervisor only hands
 * over a call's key and result fingerprint, not its raw arguments or edits, so only those two
 * native signals are used; both map to a `repeat`, which the supervisor asks about once and then
 * treats as intended if the agent carries on.
 */

const KINDS: ReadonlySet<string> = new Set<ToolKind>(['read', 'search', 'edit', 'execute', 'fetch', 'browser', 'think', 'delegate', 'other']);

export class AcpLoopDetector implements ILoopDetector {

	private readonly calls = new ToolLoopDetector();
	private steps: LoopDetector;
	private step = 0;

	constructor(private readonly request?: string) {
		this.steps = createLoopDetector({ request });
	}

	record(call: ISupervisedCall): ILoopSignal | undefined {
		const primary = this.calls.record(call);
		const verdict = this.steps.observe({
			step: ++this.step,
			calls: [loopCallRecord({
				tool: call.tool,
				args: { key: call.key, ...(call.target ? { path: call.target } : {}) },
				ok: !call.failed,
				text: call.error ? `${call.outcome}\n${call.error}` : call.outcome,
				...(KINDS.has(call.tool) ? { kind: call.tool as ToolKind } : {}),
				...(call.target ? { file: call.target } : {}),
			})],
		});
		if (primary) {
			return primary;
		}
		if (verdict.kind === 'ok' || (verdict.signal !== 'near-repeat' && verdict.signal !== 'no-progress')) {
			return undefined;
		}
		return { kind: 'repeat', count: verdict.count, subject: `${verdict.signal}:${verdict.subject}`, label: call.label };
	}

	reset(): void {
		this.calls.reset();
		this.steps = createLoopDetector({ request: this.request });
		this.step = 0;
	}
}
