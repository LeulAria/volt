/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Work that must finish before a turn's first change to the workspace, such as the checkpoint
 * snapshot taken at send. The turn starts without waiting for it; only writes do.
 */
const gates = new Map<string, Promise<unknown>>();

/** Longest a write waits for a gate: past this the write goes ahead (the gate's work is best effort). */
const MAX_GATE_WAIT_MS = 5_000;

/** Registers `ready` as the gate of `sessionId`'s current turn. Disposing clears it if it is still this one. */
export function setTurnWriteGate(sessionId: string, ready: Promise<unknown>): IDisposable {
	const settled = ready.then(() => undefined, () => undefined);
	gates.set(sessionId, settled);
	void settled.then(() => {
		if (gates.get(sessionId) === settled) {
			gates.delete(sessionId);
		}
	});
	return toDisposable(() => {
		if (gates.get(sessionId) === settled) {
			gates.delete(sessionId);
		}
	});
}

/** Resolves once the session's gate settled (at once when it has none). Never rejects. */
export function turnWriteGate(sessionId: string | undefined): Promise<void> {
	const gate = sessionId ? gates.get(sessionId) : undefined;
	if (!gate) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		const timer = setTimeout(resolve, MAX_GATE_WAIT_MS);
		void gate.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** Whether a write in `sessionId` would wait right now. */
export function hasTurnWriteGate(sessionId: string | undefined): boolean {
	return !!sessionId && gates.has(sessionId);
}
