/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which machine a cloud task goes to when the user picks "Auto". Pure: no clocks, no I/O. The
 * caller passes `now`. A machine is eligible when its heartbeat is fresh, it has the task's agent
 * installed with credentials, and it has a free slot. Among eligible machines the lowest load score
 * wins; the machine that ran the chat's last task keeps the work unless another is clearly less
 * loaded (hysteresis), so tasks do not bounce between two busy runners.
 */

export const HEARTBEAT_FRESH_MS = 30_000;
/** A challenger must beat the incumbent by this much to take the task. */
export const SWITCH_MARGIN = 0.25;

/** 0 = idle. About 1 = saturated (load equals the core count). Higher is worse. */
export function loadScore(machine) {
	const load = machine.load ?? {};
	const cpus = Math.max(1, Number(load.cpus) || 1);
	const cpuPart = Math.max(0, Number(load.load1) || 0) / cpus;
	const memTotal = Number(load.memTotal) || 0;
	const memPart = memTotal > 0 ? 1 - Math.min(1, Math.max(0, (Number(load.memFree) || 0) / memTotal)) : 0;
	const runningPart = (Number(load.running) || 0) * 0.25;
	const thermalPart = load.thermal === 'serious' || load.thermal === 'critical' ? 1 : 0;
	return cpuPart + memPart * 0.5 + runningPart + thermalPart;
}

/** Why a machine cannot take the task, or undefined when it can. */
export function ineligibleReason(machine, task, now) {
	if (now - (machine.at ?? 0) > HEARTBEAT_FRESH_MS) {
		return 'stale heartbeat';
	}
	const agent = machine.caps?.agents?.[task.agent];
	if (!agent?.installed) {
		return `${task.agent} is not installed`;
	}
	if (!agent.credentials) {
		return `${task.agent} has no credentials`;
	}
	const max = Number(machine.caps?.maxParallel) || 1;
	if ((machine.running?.length ?? 0) >= max) {
		return 'no free slot';
	}
	if (task.machineId && task.machineId !== machine.id) {
		return 'task is aimed at another machine';
	}
	return undefined;
}

/**
 * The machine for a task, or `{ machineId: undefined, reasons }` when none can take it.
 * `previousId` is the machine that last ran this chat's task, if any.
 */
export function pickMachine(machines, task, { now, previousId } = {}) {
	const reasons = {};
	const eligible = [];
	for (const machine of machines) {
		const reason = ineligibleReason(machine, task, now);
		if (reason) {
			reasons[machine.id] = reason;
		} else {
			eligible.push({ machine, score: loadScore(machine) });
		}
	}
	if (!eligible.length) {
		return { machineId: undefined, reasons };
	}
	eligible.sort((a, b) => a.score - b.score || a.machine.id.localeCompare(b.machine.id));
	const best = eligible[0];
	const incumbent = previousId ? eligible.find(entry => entry.machine.id === previousId) : undefined;
	const chosen = incumbent && incumbent.score <= best.score + SWITCH_MARGIN ? incumbent : best;
	return { machineId: chosen.machine.id, score: chosen.score, reasons };
}
