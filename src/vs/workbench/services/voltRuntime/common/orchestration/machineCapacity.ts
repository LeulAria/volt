/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How many agents this machine can run at once. Volt measures the machine once (first launch, or
 * Settings > Orchestration > Measure again) and keeps the result in a setting, so every window and
 * the agent server read the same numbers and the user can change them. Pure: the caller supplies
 * the machine's memory and cores.
 *
 * An agent here is one live harness chat: the CLI (Claude Code and OpenCode are Node, Codex is
 * Rust), its ACP adapter, the MCP servers it starts, and the tools it runs between model calls
 * (type checks, test runs). Agents spend most of their time waiting on the model, so memory is
 * the limit that bites first; cores bound how many tool runs can overlap before everything slows.
 */

/** The setting that holds the measured capacity (`IMachineCapacity`). */
export const ORCH_MACHINE_CAPACITY_SETTING = 'volt.orchestra.machineCapacity';

/** Measures this machine again and saves the result (desktop only); resolves with the new capacity. */
export const ORCH_MEASURE_CAPACITY_COMMAND_ID = 'volt.orchestra.measureCapacity';

export interface IMachineProfile {
	/** Physical memory, in MB. */
	readonly totalMemMb: number;
	/** Logical cores. */
	readonly cpus: number;
	readonly cpuModel?: string;
	readonly platform?: string;
	readonly arch?: string;
}

export interface IMachineCapacity {
	/** Agents at once that leave room for the editor, builds and tests: the default per request. */
	readonly recommended: number;
	/** Agents at once before the machine starts swapping or every tool run crawls: the hard default. */
	readonly max: number;
	readonly memoryMb: number;
	readonly cpus: number;
	/** What one agent is counted at for `max` (its share of memory), in MB. */
	readonly perAgentMb: number;
	/** Memory kept for the system, Volt and the user's own work, in MB. */
	readonly reservedMb: number;
	readonly cpuModel?: string;
	readonly platform?: string;
	readonly arch?: string;
	readonly measuredAt: number;
}

/**
 * Memory one agent takes, in MB. Reported footprints (RSS) of a working chat: Claude Code runs at
 * 280-550 MB (170 MB idle), OpenCode 190-380 MB, Codex's Rust CLI 50-60 MB idle and near 1 GB as
 * an app server with MCP; each MCP server a session starts adds 10-135 MB, and the ACP adapter
 * another Node process. `typical` counts toward `max`; `comfortable` adds room for the tool runs
 * an agent starts (tsc, test runners) and counts toward `recommended`.
 */
export const AGENT_MEMORY_MB = { typical: 700, comfortable: 1_200 } as const;

/**
 * Agents per core. Agents mostly wait on the model, so `max` allows two per core; `recommended`
 * keeps two cores for the user and the agents' tool runs (builds compete for cores, not memory).
 */
const AGENTS_PER_CORE_MAX = 2;
const CORES_KEPT = 2;

/** The most either number may be (the orchestrator's own ceiling). */
export const MACHINE_CAPACITY_CEILING = 64;

/** Memory never offered to agents: the system, Volt and the user's own apps. */
export function reservedMemoryMb(totalMemMb: number): number {
	return Math.round(Math.max(3_072, totalMemMb * 0.25));
}

export function computeMachineCapacity(profile: IMachineProfile, measuredAt: number): IMachineCapacity {
	const memoryMb = Math.max(0, Math.round(profile.totalMemMb));
	const cpus = Math.max(1, Math.floor(profile.cpus));
	const reservedMb = reservedMemoryMb(memoryMb);
	const freeForAgents = Math.max(0, memoryMb - reservedMb);
	const clamp = (value: number) => Math.max(1, Math.min(MACHINE_CAPACITY_CEILING, Math.floor(value)));
	const max = clamp(Math.min(freeForAgents / AGENT_MEMORY_MB.typical, cpus * AGENTS_PER_CORE_MAX));
	const recommended = Math.min(max, clamp(Math.min(freeForAgents / AGENT_MEMORY_MB.comfortable, cpus - CORES_KEPT)));
	return {
		recommended,
		max,
		memoryMb,
		cpus,
		perAgentMb: AGENT_MEMORY_MB.typical,
		reservedMb,
		...(profile.cpuModel ? { cpuModel: profile.cpuModel } : {}),
		...(profile.platform ? { platform: profile.platform } : {}),
		...(profile.arch ? { arch: profile.arch } : {}),
		measuredAt,
	};
}

/** The setting's value, or undefined when it is missing or damaged (the limits keep their defaults). */
export function parseMachineCapacity(value: unknown): IMachineCapacity | undefined {
	const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	const count = (key: string) => {
		const item = record?.[key];
		return typeof item === 'number' && Number.isFinite(item) && item >= 1 ? Math.min(MACHINE_CAPACITY_CEILING, Math.floor(item)) : undefined;
	};
	const amount = (key: string) => {
		const item = record?.[key];
		return typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : undefined;
	};
	const text = (key: string) => {
		const item = record?.[key];
		return typeof item === 'string' && item.trim() ? item.trim().slice(0, 120) : undefined;
	};
	const recommended = count('recommended');
	const max = count('max');
	if (recommended === undefined || max === undefined) {
		return undefined;
	}
	const cpuModel = text('cpuModel');
	const platform = text('platform');
	const arch = text('arch');
	return {
		recommended: Math.min(recommended, max),
		max,
		memoryMb: amount('memoryMb') ?? 0,
		cpus: count('cpus') ?? 1,
		perAgentMb: amount('perAgentMb') ?? AGENT_MEMORY_MB.typical,
		reservedMb: amount('reservedMb') ?? 0,
		...(cpuModel ? { cpuModel } : {}),
		...(platform ? { platform } : {}),
		...(arch ? { arch } : {}),
		measuredAt: amount('measuredAt') ?? 0,
	};
}

/** "64 GB · 12 cores", for rows and questions. */
export function describeMachine(capacity: Pick<IMachineCapacity, 'memoryMb' | 'cpus'>): string {
	const parts: string[] = [];
	if (capacity.memoryMb > 0) {
		parts.push(`${Math.round(capacity.memoryMb / 1024)} GB`);
	}
	parts.push(`${capacity.cpus} ${capacity.cpus === 1 ? 'core' : 'cores'}`);
	return parts.join(' · ');
}

export interface IParallelPlan {
	/** The user must choose before anything starts: more at once than the machine runs comfortably. */
	readonly ask: boolean;
	/** At once, when nobody needs to be asked (`ask` false). */
	readonly parallel: number;
	readonly recommended: number;
	readonly max: number;
}

/**
 * How many of `count` new agents run at once. Up to the recommended number (minus agents already
 * running) Volt just starts them; past it the user picks (recommended, the machine's max, or their
 * own number), because a swarm the machine cannot hold makes every agent slow, not just the last.
 * `wanted` is what the request asked for at once (default: all of them).
 */
export function planParallel(count: number, capacity: Pick<IMachineCapacity, 'recommended' | 'max'>, running: number, wanted?: number): IParallelPlan {
	const total = Math.max(1, Math.floor(count));
	const at = Math.max(1, Math.min(total, Math.floor(wanted ?? total)));
	const free = (limit: number) => Math.max(1, limit - Math.max(0, running));
	const recommended = Math.min(total, free(capacity.recommended));
	const max = Math.min(total, Math.max(recommended, free(capacity.max)));
	return at <= recommended
		? { ask: false, parallel: at, recommended, max }
		: { ask: true, parallel: recommended, recommended, max };
}

/** A number the user typed for "how many at once" ("10", "run 12", "all"), within 1..ceiling. */
export function parseParallelAnswer(text: string | undefined, count: number, ceiling: number): number | undefined {
	const value = text?.trim().toLowerCase() ?? '';
	if (!value) {
		return undefined;
	}
	if (/^(all|every|everything)\b/.test(value)) {
		return Math.max(1, Math.min(count, ceiling));
	}
	const match = /\d+/.exec(value);
	if (!match) {
		return undefined;
	}
	return Math.max(1, Math.min(count, ceiling, Number(match[0])));
}
