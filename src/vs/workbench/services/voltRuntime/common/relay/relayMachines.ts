/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Machines that can run work, as the relay reports them from heartbeats: runners (containers,
 * servers, CI boxes) and Volt clients (this Mac). The relay decides where work goes (its
 * apps/relay/src/placement.mjs): this file only describes what the relay reports, so the desktop
 * never second-guesses the choice.
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

export interface IRelayPlacement {
	readonly eligible: boolean;
	/** Why the machine cannot take the agent's task, from the relay. */
	readonly reason: string | null;
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
	/** The relay's load score: lower is less loaded. */
	readonly score?: number;
	/** Whether the relay lets this machine take each agent's task, and why not. */
	readonly placement?: Partial<Record<RelayAgentId, IRelayPlacement>>;
	/** Whether this is the machine the relay would pick for Auto, per agent, right now. */
	readonly autoPick?: Partial<Record<RelayAgentId, boolean>>;
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

/** Whether the relay lets the machine take the agent's task. A machine the relay did not report on cannot. */
export function canTakeAgent(machine: Pick<IRelayMachine, 'placement'>, agent: RelayAgentId): boolean {
	return machine.placement?.[agent]?.eligible === true;
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
