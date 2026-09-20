/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Execution lanes. The intent router picks one per `send()`; the lane decides which capability
 * groups the model may see, how much work it may do before the harness intervenes, and which
 * durability features (compaction, checkpoints, verification, synthesis) run.
 *
 *   chat     answer a question; read-only + web; brief Q&A or researched answers
 *   fast     small, named edit; a handful of tool calls; no planning ceremony
 *   agent    default coding loop
 *   mission  persistent goal, planner/workers/validators, checkpoints, resume
 */
export type VoltLane = 'chat' | 'fast' | 'agent' | 'mission';

export const VOLT_LANES: readonly VoltLane[] = ['chat', 'fast', 'agent', 'mission'];

/**
 * Capability groups. Tools declare one; lanes, modes, and the access policy grant them. A tool
 * whose group is not granted is stripped from the schema list the model sees, never merely
 * forbidden in prose.
 */
export type CapabilityGroup =
	| 'read'      // read_file, list_dir
	| 'search'    // grep, glob
	| 'edit'      // edit_file, write_file
	| 'shell'     // shell
	| 'web'       // web_fetch, web_search
	| 'browser'   // browser_snapshot, navigation
	| 'git'       // reserved
	| 'mcp'       // MCP servers
	| 'agents'    // task (spawn child run)
	| 'memory'    // reserved
	| 'meta';     // todo, request_capabilities, finish - always available

export const ALL_CAPABILITY_GROUPS: readonly CapabilityGroup[] = ['read', 'search', 'edit', 'shell', 'web', 'browser', 'git', 'mcp', 'agents', 'memory', 'meta'];

export interface ILaneBudget {
	/** Tool executions before the loop asks to escalate or stop. */
	readonly maxToolCalls: number;
	/** Model requests (steps) before the loop asks to escalate or stop. */
	readonly maxModelCalls: number;
}

export interface ILaneDefinition {
	readonly lane: VoltLane;
	readonly groups: readonly CapabilityGroup[];
	readonly budget: ILaneBudget;
	readonly compaction: boolean;
	readonly checkpoints: boolean;
	readonly verify: boolean;
	readonly synthesize: boolean;
	/** One line the context pack uses to frame the lane for the model. */
	readonly framing: string;
}

const LANES: Record<VoltLane, ILaneDefinition> = {
	chat: {
		lane: 'chat',
		groups: ['read', 'search', 'web', 'meta'],
		budget: { maxToolCalls: 24, maxModelCalls: 12 },
		compaction: false,
		checkpoints: false,
		verify: false,
		synthesize: false,
		framing: 'This is a question. Answer it. Look things up when the answer depends on current or external facts. Match the form they asked for. Do not modify the workspace and do not run commands.',
	},
	fast: {
		lane: 'fast',
		groups: ['read', 'search', 'edit', 'web', 'meta'],
		budget: { maxToolCalls: 10, maxModelCalls: 6 },
		compaction: false,
		checkpoints: true,
		verify: false,
		synthesize: true,
		framing: 'This is a small, well-scoped change. Make it directly: inspect only what you need, edit, and stop. No plans, no summaries of unrelated code. If it turns out to be larger than it looks, call request_capabilities.',
	},
	agent: {
		lane: 'agent',
		groups: ['read', 'search', 'edit', 'shell', 'web', 'browser', 'git', 'mcp', 'agents', 'meta'],
		budget: { maxToolCalls: 80, maxModelCalls: 40 },
		compaction: true,
		checkpoints: true,
		verify: true,
		synthesize: true,
		framing: 'Work the task end to end. Verify with the project\'s own checks before you finish.',
	},
	mission: {
		lane: 'mission',
		groups: ['read', 'search', 'edit', 'shell', 'web', 'browser', 'git', 'mcp', 'agents', 'memory', 'meta'],
		budget: { maxToolCalls: 5000, maxModelCalls: 2000 },
		compaction: true,
		checkpoints: true,
		verify: true,
		synthesize: true,
		framing: 'This is a mission. Completion requires evidence for every acceptance criterion; the harness will keep going until the budget is spent or every gate is sealed.',
	},
};

export function laneDefinition(lane: VoltLane): ILaneDefinition {
	return LANES[lane];
}

export function normalizeLane(value: string | undefined): VoltLane | undefined {
	const id = (value ?? '').toLowerCase();
	return (VOLT_LANES as readonly string[]).includes(id) ? id as VoltLane : undefined;
}

/** Strict ordering used when the model asks to move up a lane. */
export function laneRank(lane: VoltLane): number {
	return VOLT_LANES.indexOf(lane);
}
