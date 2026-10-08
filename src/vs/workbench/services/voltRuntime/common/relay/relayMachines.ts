/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Machines that can run work, as the relay reports them from heartbeats: runners (containers,
 * servers, CI boxes) and Volt clients (this Mac). Pure rules for Auto placement live here; the
 * relay service feeds them and the machine picker shows their result.
 */

export type RelayAgentId = 'claude' | 'codex';
export const RELAY_AGENT_IDS: readonly RelayAgentId[] = ['claude', 'codex'];

export interface IRelayMachineLoad {
	/** Usable CPUs (the container's quota inside a container). */
	readonly cpus?: number;
	readonly load1?: number;
	readonly load5?: number;
	/** Measured busy fraction of `cpus`, 0..1 (cgroup counter in containers, CPU times elsewhere). */
	readonly cpu?: number;
	readonly memFree?: number;
	readonly memTotal?: number;
	/** Tasks running now, and free task slots. */
	readonly running?: number;
	readonly slots?: number;
	readonly battery?: { readonly percent?: number; readonly charging?: boolean };
	readonly thermal?: 'nominal' | 'fair' | 'serious' | 'critical';
	readonly container?: boolean;
}

export interface IRelayAgentCapability {
	readonly installed: boolean;
	readonly credentials: boolean;
	readonly version?: string;
}

export interface IRelayMachine {
	readonly id: string;
	readonly kind: 'runner' | 'client';
	readonly name: string;
	readonly online: boolean;
	readonly lastSeenAt: number;
	readonly load: IRelayMachineLoad;
	readonly caps: {
		readonly agents: Partial<Record<RelayAgentId, IRelayAgentCapability>>;
		readonly os?: string;
		readonly arch?: string;
		readonly gitPush?: boolean;
		readonly labels?: readonly string[];
	};
	/** Tasks the relay has queued for or assigned to it (so two quick picks do not pile up). */
	readonly reserved?: number;
	readonly version?: string;
}

export interface IMachineRequirement {
	readonly agent: RelayAgentId;
}

/** Busy fraction of the CPU, 0..1 (can pass 1 when the run queue is longer than the cores). */
export function cpuPressure(load: IRelayMachineLoad): number {
	if (typeof load.cpu === 'number') {
		return Math.max(0, load.cpu);
	}
	if (typeof load.load1 === 'number' && load.cpus) {
		return Math.max(0, load.load1 / load.cpus);
	}
	return 0;
}

/** Used fraction of memory, 0..1. */
export function memoryPressure(load: IRelayMachineLoad): number {
	return load.memTotal && typeof load.memFree === 'number' ? Math.min(1, Math.max(0, 1 - load.memFree / load.memTotal)) : 0;
}

/** Where the machine's load bar sits, 0..1: the busier of CPU and memory. */
export function machineLoadLevel(machine: Pick<IRelayMachine, 'load'>): number {
	return Math.min(1, Math.max(cpuPressure(machine.load), memoryPressure(machine.load) * 0.8));
}

/** Can it take this task at all? Why not, in a few words, when it cannot. */
export function machineEligibility(machine: IRelayMachine, requirement: IMachineRequirement): { readonly eligible: boolean; readonly reason?: string } {
	if (machine.kind !== 'runner') {
		return { eligible: false, reason: 'Not a runner' };
	}
	if (!machine.online) {
		return { eligible: false, reason: 'Offline' };
	}
	const agent = machine.caps.agents[requirement.agent];
	const label = requirement.agent === 'codex' ? 'Codex' : 'Claude Code';
	if (!agent?.installed) {
		return { eligible: false, reason: `No ${label}` };
	}
	if (!agent.credentials) {
		return { eligible: false, reason: `No ${label} login` };
	}
	if (machine.load.thermal === 'critical') {
		return { eligible: false, reason: 'Overheating' };
	}
	return { eligible: true };
}

/**
 * Lower is better. CPU weighs most, then queued work against the machine's task slots, then
 * memory; a laptop on battery or running hot pays extra so plugged-in boxes are preferred.
 */
export function scoreMachine(machine: IRelayMachine): number {
	const load = machine.load;
	const capacity = Math.max(1, (load.slots ?? 0) + (load.running ?? 0));
	const queued = Math.max(load.running ?? 0, machine.reserved ?? 0);
	let score = 0.55 * Math.min(1.5, cpuPressure(load)) + 0.25 * memoryPressure(load) + 0.6 * (queued / capacity);
	if (load.battery && load.battery.charging === false) {
		score += 0.15 + ((load.battery.percent ?? 100) < 20 ? 0.3 : 0);
	}
	if (load.thermal === 'fair') {
		score += 0.1;
	} else if (load.thermal === 'serious') {
		score += 0.4;
	}
	return Math.round(score * 1000) / 1000;
}

export interface IRankedMachine {
	readonly machine: IRelayMachine;
	readonly score: number;
	readonly eligible: boolean;
	readonly reason?: string;
}

export interface IMachinePick {
	/** Undefined when no machine can take the task. */
	readonly machine?: IRelayMachine;
	/** Every machine, eligible first by score, then the others. */
	readonly ranked: readonly IRankedMachine[];
	/** "Least loaded", "Stays on X (within 12% of Y)", or why nothing fits. */
	readonly why: string;
}

/** A previous Auto pick stays while it is within this much of the best score. */
export const AUTO_HYSTERESIS = 0.12;

/**
 * Auto placement: the least-loaded machine that can run the agent. With `previousId`, the last
 * Auto pick is kept unless another machine is better by more than `hysteresis`, so tasks do not
 * flap between two near-equal runners as their load wobbles.
 */
export function pickMachine(machines: readonly IRelayMachine[], requirement: IMachineRequirement, options: { readonly previousId?: string; readonly hysteresis?: number } = {}): IMachinePick {
	const ranked = machines.map(machine => {
		const { eligible, reason } = machineEligibility(machine, requirement);
		return { machine, score: scoreMachine(machine), eligible, ...(reason ? { reason } : {}) };
	}).sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.score - b.score || a.machine.name.localeCompare(b.machine.name));
	const best = ranked[0]?.eligible ? ranked[0] : undefined;
	if (!best) {
		const runners = ranked.filter(entry => entry.machine.kind === 'runner');
		const why = !runners.length ? 'No runners are connected to the relay.'
			: runners.every(entry => entry.reason === 'Offline') ? 'Every runner is offline.'
				: `No runner can run ${requirement.agent === 'codex' ? 'Codex' : 'Claude Code'} (${[...new Set(runners.map(entry => entry.reason))].join(', ')}).`;
		return { ranked, why };
	}
	const hysteresis = options.hysteresis ?? AUTO_HYSTERESIS;
	const previous = options.previousId ? ranked.find(entry => entry.machine.id === options.previousId && entry.eligible) : undefined;
	if (previous && previous !== best && previous.score - best.score <= hysteresis) {
		return { machine: previous.machine, ranked, why: `Stays on ${previous.machine.name} (within ${Math.round(hysteresis * 100)}% of ${best.machine.name})` };
	}
	return { machine: best.machine, ranked, why: 'Least loaded' };
}

/** "8 cores · 23% CPU · 4.1 of 16 GB" for a machine row. */
export function describeMachineLoad(machine: Pick<IRelayMachine, 'load' | 'online' | 'lastSeenAt'>, now = Date.now()): string {
	if (!machine.online) {
		const minutes = Math.max(1, Math.round((now - machine.lastSeenAt) / 60_000));
		return minutes >= 60 ? `Offline ${Math.round(minutes / 60)} h` : `Offline ${minutes} min`;
	}
	const load = machine.load;
	const parts: string[] = [];
	if (load.cpus) {
		parts.push(`${Math.round(load.cpus * 10) / 10} ${load.cpus === 1 ? 'core' : 'cores'}`);
	}
	parts.push(`${Math.round(Math.min(1, cpuPressure(load)) * 100)}% CPU`);
	if (load.memTotal && typeof load.memFree === 'number') {
		const gb = (bytes: number) => bytes / 1024 ** 3;
		parts.push(`${gb(load.memTotal - load.memFree).toFixed(1)} of ${Math.round(gb(load.memTotal))} GB`);
	}
	if (load.running) {
		parts.push(`${load.running} running`);
	}
	if (load.battery && load.battery.charging === false && typeof load.battery.percent === 'number') {
		parts.push(`battery ${Math.round(load.battery.percent)}%`);
	}
	if (load.thermal && load.thermal !== 'nominal') {
		parts.push(`thermal ${load.thermal}`);
	}
	return parts.join(' · ');
}
