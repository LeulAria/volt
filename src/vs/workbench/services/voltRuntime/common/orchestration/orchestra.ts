/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The orchestra: teams of agents from any provider, councils, and machines, on top of the
 * orchestrator's tasks. Nothing here hard-codes a team shape. The user says what they want ("34
 * agents, half Claude, on these 34 files"; "a council of Claude, Codex and Gemini on this design";
 * "run the tests on the Mac Studio") and the agent turns it into one call; Volt expands it into
 * tasks the orchestrator runs, durably, within what the machine can hold.
 *
 * - A team is a set of tasks sharing a `team` id under one lead chat, plus a board (`teamBoard.ts`):
 *   work items members claim one at a time, and notes everyone reads instead of messaging.
 * - A council is a team whose tasks form three stages through `after`: independent answers, blind
 *   peer review (no judge sees its own answer; labels shared, order shuffled per judge), and a
 *   verdict written by a moderator.
 * - Machines are this one and the relay's runners.
 *
 * Pure: tool schemas, roster arithmetic, briefs and machine rows. The service is
 * `browser/orchestration/agentOrchestraService.ts`.
 */

import { SandboxStrategy, strategyAtLeast, VoltSandboxLevel } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import type { IVoltHostToolInfo } from '../hostTools.js';
import { describeMachineLoad, IRelayMachine, RELAY_AGENT_IDS } from '../relay/relayMachines.js';
import { AGENT_TASK_ROLES } from './agentTasks.js';
import { describeMachine, IMachineCapacity } from './machineCapacity.js';

/**
 * `voltModule.feature` of `extensions/volt-orchestra`: off, its tools, the Orchestration settings
 * page and the @ Agents / @ Machines mentions go away.
 */
export const ORCHESTRA_FEATURE_ID = 'orchestra';

//#region Settings

/** Models a council asks when the request names none. */
export const ORCHESTRA_COUNCIL_PARTICIPANTS_SETTING = 'volt.orchestra.council.participants';
/** The model that writes a council's verdict when the request names none. */
export const ORCHESTRA_COUNCIL_MODERATOR_SETTING = 'volt.orchestra.council.moderator';

//#endregion

//#region Tools

export const ORCHESTRA_STATUS_TOOL_NAME = 'orchestra_status';
export const SPAWN_TEAM_TOOL_NAME = 'spawn_team';
export const TEAM_SEND_TOOL_NAME = 'team_send';
export const TEAM_BOARD_TOOL_NAME = 'team_board';
export const COUNCIL_TOOL_NAME = 'council';
export const MACHINE_RUN_TOOL_NAME = 'machine_run';

export const ORCHESTRA_TOOL_NAMES = [ORCHESTRA_STATUS_TOOL_NAME, SPAWN_TEAM_TOOL_NAME, TEAM_SEND_TOOL_NAME, TEAM_BOARD_TOOL_NAME, COUNCIL_TOOL_NAME, MACHINE_RUN_TOOL_NAME] as const;

export type OrchestraToolName = typeof ORCHESTRA_TOOL_NAMES[number];

/** Members in one council, and critique rounds: every judge's reports must fit one task's `after`. */
export const COUNCIL_MAX_SEATS = 8;
export const COUNCIL_MAX_ROUNDS = 2;
/** Upstream reports one task may wait for (`after`), as `delegate_task` takes them. */
export const MAX_UPSTREAM = 16;

const MODEL_VALUE = 'a `model` value from orchestra_status or list_models (ref, id or label such as "Claude Opus 5.5")';

export const ORCHESTRA_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: ORCHESTRA_STATUS_TOOL_NAME,
		title: 'Checked the orchestra',
		group: 'tasks',
		description: 'What you can orchestrate right now, in one read: the agents and models you can put on a team (grouped by provider), how many agents this machine runs at once (recommended and max) and how many run now, the machines work can go to (This PC and remote servers, with their load), the request\'s budget, and the teams and councils of this request with their boards. Call it before a large spawn, a council, or when the user names providers or machines.',
		inputSchema: { type: 'object', properties: { team_id: { type: 'string', description: 'Show one team in full: every member, the board and its notes.' } } },
	},
	{
		name: SPAWN_TEAM_TOOL_NAME,
		title: 'Started a team',
		group: 'tasks',
		description: [
			'Start a team of agents, from any mix of providers, working toward one goal: "spawn 30 agents, half Claude and half Codex", "five reviewers on these PRs", "one agent per failing test". Each member is a subagent in its own chat (shown in Volt like any delegated task) that gets the shared goal and brief, its own part, the roster, and the team tools.',
			'Describe the mix in `members`: one entry per group with a `model` and either a `count` or a `share` of the total `count` ("half Claude": share 0.5). Give independent work as `items`: they go on the team board, and each member claims the next open item, finishes it, and claims again until none are left (work flows to whoever is free; no static split). Use `assign: "split"` only when each member must own fixed items.',
			'Volt runs as many at once as this machine can hold. Asking for more at once than it runs comfortably asks the user how many to run at a time (recommended, the machine\'s max, or their own number) before anything starts; if that returns WAITING FOR THE USER, call spawn_team again with the same arguments and client_request_id and do nothing else meanwhile.',
			'Returns the team_id and each member\'s task_id at once. Each member\'s report is delivered to this chat when it finishes, so you may end your turn; wait_tasks waits for them, team_board reads progress, team_send messages members. Do not start a team for work one agent does faster.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The team\'s name, shown in Volt (2-4 words): "Auth swarm", "PR reviewers".' },
				goal: { type: 'string', description: 'The outcome the whole team works toward, in a sentence or two.' },
				brief: { type: 'string', description: 'What every member does, written like a hand-off to a capable colleague: the facts and files you already found, how to do one item, and what to report. {{member}}, {{index}}, {{count}} and {{team}} are replaced per member.' },
				members: {
					type: 'array',
					description: 'The mix, one entry per group. Omit for `count` agents on this chat\'s model.',
					items: {
						type: 'object',
						properties: {
							model: { type: 'string', description: `The group's model: ${MODEL_VALUE}, or "auto" for the user's model for its role.` },
							count: { type: 'number', description: 'Agents in this group.' },
							share: { type: 'number', description: 'This group\'s share of `count` (0.5 or 50 for half), for groups without a count.' },
							role: { type: 'string', enum: AGENT_TASK_ROLES, description: 'research and review run read-only; implementation, test and design may edit files.' },
							name: { type: 'string', description: 'Member name for this group ("Reviewer"); numbered when the group has several. Default: the model\'s name.' },
							brief: { type: 'string', description: 'Extra instructions only this group gets (its angle, its part of the work).' },
						},
					},
				},
				count: { type: 'number', description: 'Total members, split over `members` by their shares. Optional when every group has a count.' },
				items: {
					type: 'array',
					description: 'Independent work items (a file, a test, a question each). They go on the team board, where members claim them one at a time. Each item: a string, or { title, detail?, after? } where after lists earlier items (1-based) that must be done first.',
					items: {},
				},
				assign: { type: 'string', enum: ['board', 'split'], description: 'board (default): members claim items as they go. split: items are dealt out round-robin, fixed per member.' },
				parallel: { type: 'number', description: 'How many members run at once. Default: as many as the machine runs comfortably.' },
				isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'shared (default): members work in this chat\'s checkout (give non-overlapping items). worktree: each member gets its own branch and checkout.' },
				constraints: { type: 'array', items: { type: 'string' }, description: 'Rules every member keeps.' },
				done_when: { type: 'array', items: { type: 'string' }, description: 'Checks that prove an item is done.' },
				files: { type: 'array', items: { type: 'string' }, description: 'Files every member reads first.' },
				context: { type: 'string', enum: ['brief', 'full', 'none'], description: 'How much of this chat members get besides the brief (default brief).' },
				budget_usd: { type: 'number', description: 'Each member stops once it has spent this much (USD).' },
				client_request_id: { type: 'string', description: 'Idempotency key: the same key returns the same team instead of starting another (and resumes the "how many at once" question).' },
			},
			required: ['brief'],
		},
	},
	{
		name: TEAM_SEND_TOOL_NAME,
		title: 'Messaged the team',
		group: 'tasks',
		description: 'Send a message to teammates: the lead (the chat that started the team), members by name or task_id, or "all" (the members still working). A running member reads it between its steps; an idle one starts a turn to answer; one that finished resumes its task to answer and reports again. With wait=true (one recipient) the call returns its reply. Messages are marked as coming from an agent: they never count as the user\'s approval. A member waiting on the user\'s answer is not interrupted (the call says so). Prefer team_board notes for anything every member should know; message for questions only that recipient can answer and for blockers.',
		inputSchema: {
			type: 'object',
			properties: {
				team_id: { type: 'string', description: 'Default: your team (members), or this chat\'s only team (the lead).' },
				to: { description: '"lead", "all", a member name or task_id, or a list of them.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
				message: { type: 'string' },
				wait: { type: 'boolean', description: 'Wait for the reply (one recipient, up to about 45 s; call again to keep waiting).' },
			},
			required: ['to', 'message'],
		},
	},
	{
		name: TEAM_BOARD_TOOL_NAME,
		title: 'Used the team board',
		group: 'tasks',
		description: [
			'The team\'s shared board: work items and notes every member and the lead can read. ops:',
			'claim (members): take the next open item whose `after` items are done; one item at a time; returns "nothing left" when the board is done. done: finish your item with a `result` (what you did, files changed, checks run), then claim again. release: give your item back with a `reason` (another member takes it). block: mark an item blocked with a `reason` the lead must resolve.',
			'note: post a finding, decision or blocker everyone reads (kind note|decision|finding|blocker); read the board instead of asking teammates what they found. read: items with owners and results, and recent notes. add (lead, or a member who found more work): new items.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				op: { type: 'string', enum: ['read', 'claim', 'done', 'release', 'block', 'note', 'add'] },
				team_id: { type: 'string', description: 'Default: your team, or this chat\'s only team.' },
				item_id: { type: 'string', description: 'done, release, block: the item (default: the item you hold).' },
				result: { type: 'string', description: 'done: what you did and found.' },
				reason: { type: 'string', description: 'release, block: why.' },
				text: { type: 'string', description: 'note: the note.' },
				kind: { type: 'string', enum: ['note', 'decision', 'finding', 'blocker'] },
				items: { type: 'array', items: {}, description: 'add: strings, or { title, detail?, after? }.' },
			},
			required: ['op'],
		},
	},
	{
		name: COUNCIL_TOOL_NAME,
		title: 'Convened a council',
		group: 'tasks',
		description: [
			'Ask several models from different providers to decide a hard question together: an architecture choice, a risky change, a code review that must be right, build vs buy. Volt runs it in three stages as one durable job: (1) every participant answers on its own, without seeing the others; (2) every participant reviews the others\' answers anonymized ("Response A, B, C", never its own, in its own order), critiques them with evidence and ranks them; (3) the moderator writes the decision: recommendation, where they agreed and disagreed and why, evidence, risks, the ranking tally, and next actions.',
			'Mixing providers is the point (different training catches different mistakes); a council is several times the cost of one answer, so use it for decisions worth that. Give the full question with the facts and files the council needs. Returns at once; the verdict is delivered to this chat as the moderator\'s report (the answers and reviews come with it), so you may end your turn.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				question: { type: 'string', description: 'The question or proposal, with the facts, constraints and files the council needs.' },
				participants: { type: 'array', items: { type: 'string' }, description: `2-${COUNCIL_MAX_SEATS} models (${MODEL_VALUE}). Default: the user's council setting, else one model per connected provider (at most four).` },
				moderator: { type: 'string', description: 'The model that writes the verdict. Default: the user\'s setting, else this chat\'s model.' },
				rounds: { type: 'number', description: `Review rounds (1-${COUNCIL_MAX_ROUNDS}, default 1). A second round lets each participant answer the reviews; worth it only for open design questions.` },
				files: { type: 'array', items: { type: 'string' }, description: 'Files every participant reads first.' },
				context: { type: 'string', enum: ['brief', 'full', 'none'], description: 'How much of this chat participants get besides the question. none (default): only the question, for unbiased answers.' },
				title: { type: 'string', description: 'A short title shown in Volt (3-6 words).' },
				client_request_id: { type: 'string', description: 'Idempotency key: the same key returns the same council.' },
			},
			required: ['question'],
		},
	},
	{
		name: MACHINE_RUN_TOOL_NAME,
		title: 'Ran on a machine',
		group: 'tasks',
		approvalInReadOnlyModes: 'runs an agent on another machine',
		description: [
			'Run a task on another machine: one of the user\'s remote servers (Volt runners) from orchestra_status. The runner checks out this project at its current commit, runs Claude Code or Codex there headlessly, and returns a branch with the changes; the report is delivered to this chat when it finishes. Use it when the user names a machine (@Mac Studio, @build-server), or for long, heavy work that should not load this machine. Work for This PC runs here: use delegate_task or spawn_team instead.',
			'ops: run (default: `task`, optional `machine` id or name or "auto" for the least loaded one, `model`), status (`run_id`, or all runs of this chat), apply (`run_id`: fetches its branch into a new local worktree and returns the path), cancel (`run_id`).',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				op: { type: 'string', enum: ['run', 'status', 'apply', 'cancel'] },
				machine: { type: 'string', description: 'A machine id or name from orchestra_status, or "auto" (default).' },
				task: { type: 'string', description: 'run: the complete brief (the runner sees only this and the code).' },
				title: { type: 'string', description: 'run: a short title.' },
				model: { type: 'string', description: 'run: a Claude or Codex model (default: this chat\'s, when it is one of those).' },
				run_id: { type: 'string' },
			},
		},
	},
];

export function isOrchestraTool(name: string | undefined): name is OrchestraToolName {
	return !!name && (ORCHESTRA_TOOL_NAMES as readonly string[]).includes(name);
}

//#endregion

//#region Roster

export interface IRosterGroupInput {
	readonly count?: number;
	readonly share?: number;
}

/**
 * Members per group. Groups with a `count` get it; the rest of `total` goes to groups with a
 * `share` (largest remainder, so shares of 34 come out 17/17 and thirds of 10 as 4/3/3); groups
 * with neither split the rest evenly. An impossible mix is an error the agent can fix.
 */
export function rosterSizes(groups: readonly IRosterGroupInput[], total: number | undefined, max: number): number[] | string {
	if (!groups.length) {
		return 'members needs at least one group.';
	}
	const fixed = groups.map(group => typeof group.count === 'number' && Number.isFinite(group.count) ? Math.floor(group.count) : undefined);
	if (fixed.some(count => count !== undefined && count < 0)) {
		return 'A group\'s count cannot be negative.';
	}
	const counted = fixed.reduce<number>((sum, count) => sum + (count ?? 0), 0);
	const open = groups.map((group, index) => fixed[index] === undefined ? index : -1).filter(index => index >= 0);
	const wanted = typeof total === 'number' && Number.isFinite(total) ? Math.floor(total) : undefined;
	let sizes: number[];
	if (!open.length) {
		if (wanted !== undefined && wanted !== counted) {
			return `The groups' counts add up to ${counted}, but count is ${wanted}. Give each group a count, or shares of count.`;
		}
		sizes = fixed.map(count => count ?? 0);
	} else {
		if (wanted === undefined) {
			return 'Give each group a count, or give count (the total) and shares.';
		}
		const rest = wanted - counted;
		if (rest < 0) {
			return `The groups' counts add up to ${counted}, more than count (${wanted}).`;
		}
		const shares = open.map(index => {
			const share = groups[index].share;
			if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) {
				return undefined;
			}
			return share > 1 ? share / 100 : share;
		});
		const named = shares.reduce<number>((sum, share) => sum + (share ?? 0), 0);
		const unnamed = shares.filter(share => share === undefined).length;
		// Groups without a share split what the shares leave (all of it when none has a share).
		const leftover = Math.max(0, 1 - named);
		const weights = shares.map(share => share ?? (unnamed ? leftover / unnamed : 0));
		const sum = weights.reduce((a, b) => a + b, 0);
		const exact = weights.map(weight => sum > 0 ? rest * weight / sum : rest / weights.length);
		const floors = exact.map(Math.floor);
		let left = rest - floors.reduce((a, b) => a + b, 0);
		const order = exact.map((value, index) => ({ index, part: value - floors[index] })).sort((a, b) => b.part - a.part || a.index - b.index);
		for (const { index } of order) {
			if (left <= 0) {
				break;
			}
			floors[index]++;
			left--;
		}
		sizes = fixed.map(count => count ?? 0);
		open.forEach((groupIndex, position) => { sizes[groupIndex] = floors[position]; });
	}
	const totalSize = sizes.reduce((a, b) => a + b, 0);
	if (totalSize < 1) {
		return 'The team has no members: give a count.';
	}
	if (totalSize > max) {
		return `That is ${totalSize} agents; one request may start at most ${max} (setting volt.orchestra.maxAgentsPerRequest). Start fewer, or tell the user the limit can be raised.`;
	}
	return sizes;
}

/** "Claude 3" in a group of several, "Reviewer" alone; names stay unique across the team. */
export function memberNames(bases: readonly string[], sizes: readonly number[]): string[][] {
	const used = new Set<string>();
	const unique = (name: string) => {
		let candidate = name;
		for (let n = 2; used.has(candidate.toLowerCase()); n++) {
			candidate = `${name} (${n})`;
		}
		used.add(candidate.toLowerCase());
		return candidate;
	};
	// Two groups on the same base keep counting ("Claude 1..17", then "Claude 18..34").
	const counters = new Map<string, number>();
	const repeated = new Set(bases.filter((base, index) => bases.indexOf(base) !== index).map(base => base.toLowerCase()));
	return bases.map((base, index) => {
		const size = sizes[index];
		const key = base.toLowerCase();
		const several = size > 1 || repeated.has(key);
		return Array.from({ length: size }, () => {
			if (!several) {
				return unique(base);
			}
			const next = (counters.get(key) ?? 0) + 1;
			counters.set(key, next);
			return unique(`${base} ${next}`);
		});
	});
}

/**
 * Why a sandboxed lead may not start these members or seats (INV-11, B-10): those whose agent would
 * run with a weaker sandbox than the lead's at its level (`none`: none on this machine). A member
 * whose provider is not known yet ("auto") is judged when its turn starts. Undefined: all may start.
 */
export function orchestraMemberSandboxRefusal(tool: string, level: VoltSandboxLevel, leadProvider: string | undefined, members: readonly { readonly label: string; readonly providerId?: string }[], strategyOf: (providerId: string, level: VoltSandboxLevel) => SandboxStrategy): string | undefined {
	if (level === 'off') {
		return undefined;
	}
	// A lead whose agent is unknown counts as fully wrapped: its members must be too.
	const lead = leadProvider ? strategyOf(leadProvider, level) : 'wrap';
	const weaker = members.filter(member => member.providerId && !strategyAtLeast(strategyOf(member.providerId, level), lead));
	if (!weaker.length) {
		return undefined;
	}
	const labels = [...new Set(weaker.map(member => member.label))];
	const none = weaker.every(member => strategyOf(member.providerId!, level) === 'none');
	const named = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
	return `${tool} did not start anything: this chat runs in Volt's ${level === 'read-only' ? 'read-only ' : ''}sandbox, and ${named} would run ${none ? 'without a sandbox on this machine' : 'with a weaker sandbox than this chat\'s'}. Pick models that run in this chat's sandbox (orchestra_status lists them), or ask the user to start them.`;
}

/** Items dealt round-robin: member i gets items i, i+n, i+2n… */
export function splitItems<T>(items: readonly T[], members: number): T[][] {
	const parts: T[][] = Array.from({ length: Math.max(0, members) }, () => []);
	items.forEach((item, index) => parts[index % parts.length]?.push(item));
	return parts;
}

/** Replaces {{member}}, {{index}}, {{count}}, {{team}} (unknown placeholders stay). */
export function fillTemplate(text: string, vars: Readonly<Record<string, string | number>>): string {
	return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => key in vars ? String(vars[key]) : match);
}

/** A group's short name from its model's label: "Claude Opus 5.5" -> "Claude Opus 5.5"; cut at 24. */
export function memberBase(label: string): string {
	const clean = label.replace(/\s+/g, ' ').trim();
	return clean.length > 24 ? clean.slice(0, 24).trim() : clean || 'Agent';
}

//#endregion

//#region Briefs

const ROSTER_SHOWN = 12;

export interface IMemberBriefSpec {
	readonly teamId: string;
	readonly teamName: string;
	readonly goal?: string;
	readonly brief: string;
	readonly part?: string;
	readonly member: string;
	readonly index: number;
	readonly count: number;
	readonly teammates: readonly string[];
	/** Items fixed to this member (`assign: split`). */
	readonly items?: readonly string[];
	/** Items wait on the board for members to claim. */
	readonly board: boolean;
	readonly leadTitle?: string;
}

/** What a member reads first: who it is, the work, the roster, and how the team works. */
export function buildMemberBrief(spec: IMemberBriefSpec): string {
	const vars = { member: spec.member, index: spec.index, count: spec.count, team: spec.teamName };
	const lines = [
		`You are ${spec.member}, member ${spec.index} of ${spec.count} of the team "${spec.teamName}" (team_id: ${spec.teamId})${spec.leadTitle ? `, started by the chat "${spec.leadTitle}"` : ''}.`,
	];
	if (spec.goal) {
		lines.push('', `Team goal: ${fillTemplate(spec.goal, vars)}`);
	}
	lines.push('', fillTemplate(spec.brief, vars).trim());
	if (spec.part?.trim()) {
		lines.push('', `Your part: ${fillTemplate(spec.part, vars).trim()}`);
	}
	if (spec.items?.length) {
		lines.push('', 'Your items (yours alone; do them in order):', ...spec.items.map((item, index) => `${index + 1}. ${item}`));
	}
	const shown = spec.teammates.slice(0, ROSTER_SHOWN);
	if (shown.length) {
		const more = spec.teammates.length - shown.length;
		lines.push('', `Teammates: ${shown.join(', ')}${more > 0 ? `, and ${more} more (team_board read lists everyone)` : ''}.`);
	}
	lines.push('', 'How the team works:');
	if (spec.board) {
		lines.push('- The work is on the team board. Call team_board {"op":"claim"} to take the next open item, do it, then team_board {"op":"done","result":"…"} (what you did, files changed, checks run), and claim again. Stop when claim says nothing is left. Hold one item at a time; release it with a reason if you cannot finish it.');
	}
	lines.push(
		'- Share what others need (a finding, a decision, an interface you defined) with team_board {"op":"note"}, and read the board before asking anyone. Message with team_send only for a question only that teammate or the lead can answer, or a blocker. No status chatter.',
		'- Change only what your item needs; another member may be editing the files next to yours. Never undo a teammate\'s change: note the conflict instead.',
		'- Finish with a short report: what you did per item, files changed, checks run and their results, and anything left open.',
	);
	return lines.join('\n');
}

/** Stage 1: an answer of its own, before seeing anyone else's. */
export function councilAnswerBrief(question: string, seats: number): string {
	return [
		`You sit on a council of ${seats} models from different providers. Answer this on your own: the others answer separately and you will not see their answers until the review stage.`,
		'',
		question.trim(),
		'',
		'Investigate as much as the question needs (read the code, run read-only commands). Then answer with:',
		'1. Position: your recommendation, in one or two sentences.',
		'2. Reasoning: why, step by step.',
		'3. Evidence: the files, lines, measurements or sources it rests on.',
		'4. Risks: what could make you wrong, and what would change your mind.',
		'5. Confidence: low, medium or high.',
	].join('\n');
}

/** Stage 2: judge the anonymized answers of the others, then restate a position. */
export function councilReviewBrief(question: string, round: number, rounds: number): string {
	const first = round === 1;
	return [
		first
			? 'You sit on a council deciding the question below. The other members\' answers follow under <upstream_reports>, anonymized as "Response A", "Response B" and so on. Your own answer is not among them.'
			: `Review round ${round} of ${rounds}. The other members' answers follow under <upstream_reports> as "Response A", "Response B" (yours is not among them, and the labels are the same as last round), with the other members' reviews of last round as "Review 1", "Review 2". Answer the criticism that matters, including any of your own last review.`,
		'',
		'Question:',
		question.trim(),
		'',
		'Judge the work, not its style or length. Check the claims you can check (read the files they cite). For each response: what it gets right, what it gets wrong or misses, and whether its evidence holds.',
		'Then give your own position now: keep it or change it, and say what convinced you.',
		'End with your ranking of the responses you reviewed, best first, on its own lines exactly like this:',
		'FINAL RANKING:',
		'1. Response B',
		'2. Response A',
	].join('\n');
}

export interface ICouncilSeatLabel {
	readonly label: string;
	readonly model: string;
}

/** Stage 3: the moderator's decision document. */
export function councilVerdictBrief(question: string, seats: readonly ICouncilSeatLabel[], rounds: number): string {
	return [
		`You moderate a council of ${seats.length} models from different providers. Their answers and ${rounds === 1 ? 'reviews' : `${rounds} rounds of reviews`} follow under <upstream_reports>. The reviewers saw the answers anonymized under these labels:`,
		...seats.map(seat => `- Response ${seat.label}: ${seat.model}`),
		'',
		'Question:',
		question.trim(),
		'',
		'Write the council\'s decision for the user. Weigh evidence over votes and check any claim that decides the outcome yourself. Sections:',
		'1. Decision: the recommendation, in two or three sentences.',
		'2. Agreement: what the council agreed on.',
		'3. Disagreements: where they differed, who held which view, and how you resolved it (or why it stays open).',
		'4. Evidence: the facts the decision rests on, with files and lines.',
		'5. Risks: what could go wrong, and how to detect it early.',
		'6. Ranking: the average position of each response across the reviews (from their FINAL RANKING lines), best first.',
		'7. Next actions: concrete steps the user or an agent can take now, in order.',
		'8. Confidence: low, medium or high, and what would raise it.',
	].join('\n');
}

/** The labels a review ranked, best first ("FINAL RANKING:" then "1. Response B" lines). */
export function parseRanking(text: string | undefined): string[] {
	if (!text) {
		return [];
	}
	const at = text.toUpperCase().lastIndexOf('FINAL RANKING');
	const tail = at >= 0 ? text.slice(at) : '';
	const labels: string[] = [];
	for (const match of tail.matchAll(/^\s*\d+[.)]\s*\**\s*Response\s+([A-Z]{1,2})\b/gim)) {
		const label = match[1].toUpperCase();
		if (!labels.includes(label)) {
			labels.push(label);
		}
	}
	return labels;
}

export interface IRankingTally {
	readonly label: string;
	/** Average place, 1 best. */
	readonly mean: number;
	readonly votes: number;
}

/** Average place of each label over the rankings that include it, best first. */
export function tallyRankings(rankings: readonly (readonly string[])[]): IRankingTally[] {
	const places = new Map<string, number[]>();
	for (const ranking of rankings) {
		ranking.forEach((label, index) => {
			const list = places.get(label) ?? [];
			list.push(index + 1);
			places.set(label, list);
		});
	}
	return [...places.entries()]
		.map(([label, list]) => ({ label, mean: list.reduce((a, b) => a + b, 0) / list.length, votes: list.length }))
		.sort((a, b) => a.mean - b.mean || b.votes - a.votes || (a.label < b.label ? -1 : 1));
}

//#endregion

//#region Machines

export const LOCAL_MACHINE_ID = 'local';

export interface IOrchestraMachine {
	readonly id: string;
	readonly name: string;
	readonly kind: 'local' | 'runner';
	readonly online: boolean;
	/** "64 GB · 12 cores · 3 agents running", for rows and the agent. */
	readonly detail: string;
	/** Agents the machine runs: harness families it has (runners), or every connected one (local). */
	readonly agents?: readonly string[];
	readonly capacity?: Pick<IMachineCapacity, 'recommended' | 'max'>;
	readonly running?: number;
}

export function localMachine(name: string, capacity: IMachineCapacity | undefined, running: number): IOrchestraMachine {
	const parts = [capacity ? describeMachine(capacity) : undefined, capacity ? `${capacity.recommended} agents at once (max ${capacity.max})` : undefined, `${running} running`].filter(Boolean);
	return {
		id: LOCAL_MACHINE_ID,
		name,
		kind: 'local',
		online: true,
		detail: parts.join(' · '),
		...(capacity ? { capacity: { recommended: capacity.recommended, max: capacity.max } } : {}),
		running,
	};
}

export function runnerMachine(machine: IRelayMachine, now: number): IOrchestraMachine {
	const agents = RELAY_AGENT_IDS.filter(agent => machine.caps.agents[agent]?.installed && machine.caps.agents[agent]?.credentials);
	const slots = machine.load.slots;
	return {
		id: machine.id,
		name: machine.name,
		kind: 'runner',
		online: machine.online,
		detail: [describeMachineLoad(machine, now), agents.length ? `runs ${agents.join(', ')}` : 'no agent signed in', machine.caps.os].filter(Boolean).join(' · '),
		agents,
		...(typeof machine.load.running === 'number' ? { running: machine.load.running } : {}),
		...(typeof slots === 'number' ? { capacity: { recommended: slots, max: slots } } : {}),
	};
}

const LOCAL_ALIASES = new Set(['local', 'this pc', 'this mac', 'this computer', 'this machine', 'here', 'localhost', 'thispc', 'thismac']);

/** A machine by id, name or a "this pc" alias; then by a unique name prefix or substring. */
export function resolveMachine(query: string | undefined, machines: readonly IOrchestraMachine[]): IOrchestraMachine | undefined {
	const wanted = query?.trim().replace(/^@/, '').toLowerCase();
	if (!wanted) {
		return undefined;
	}
	if (LOCAL_ALIASES.has(wanted)) {
		return machines.find(machine => machine.kind === 'local');
	}
	const exact = machines.find(machine => machine.id.toLowerCase() === wanted || machine.name.toLowerCase() === wanted);
	if (exact) {
		return exact;
	}
	const squash = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, '');
	const loose = machines.filter(machine => squash(machine.name).startsWith(squash(wanted)) || squash(machine.name).includes(squash(wanted)));
	return loose.length === 1 ? loose[0] : undefined;
}

export function describeMachineRow(machine: IOrchestraMachine): string {
	return `- ${machine.name} (machine: ${machine.id}${machine.kind === 'local' ? ', this machine' : ', remote server'}) · ${machine.online ? 'online' : 'offline'}${machine.detail ? ` · ${machine.detail}` : ''}`;
}

//#endregion

//#region Mentions

/** `@Team` and `@Council` in the composer: agent mentions that stand for a way of working, not a model. */
export const MENTION_TEAM_VALUE = 'orchestra:team';
export const MENTION_COUNCIL_VALUE = 'orchestra:council';

const quote = (text: string) => text.replace(/"/g, '\'');

/**
 * What a machine chip tells the agent: where the user wants the work to run, and how to get it there.
 * In a sandboxed chat (`sandboxed`), a remote server is out of reach: machine_run is refused there.
 */
export function machineMentionBlock(machine: Pick<IOrchestraMachine, 'id' | 'name' | 'kind' | 'online' | 'detail'>, sandboxed = false): string {
	const how = machine.kind === 'local'
		? 'The user wants this work to run here, on this machine: do it yourself, or with delegate_task / spawn_team (they run here). Keep within what it can hold (orchestra_status).'
		: sandboxed
			? 'The user wants this work to run on this remote server, but this chat runs in Volt\'s sandbox and a remote server runs its agent outside it, so Volt does not send work there from this chat (machine_run is refused). Tell the user, and offer to do the work here (yourself, or with delegate_task / spawn_team, which run inside this chat\'s sandbox), or ask them to turn the sandbox off for this chat.'
			: machine.online
				? `The user wants this work to run on this remote server: send it with machine_run {"machine":"${machine.id}","task":"…"} (a complete brief: the runner sees only that and the code). Its report comes back to this chat; machine_run apply brings its changes here.`
				: 'This remote server is offline: tell the user, and ask whether to wait, run the work elsewhere (machine_run with machine "auto"), or here.';
	return `<attached_machine name="${quote(machine.name)}" machine="${machine.id}" kind="${machine.kind === 'local' ? 'this machine' : 'remote server'}">\n${machine.detail ? `${machine.detail}\n` : ''}${how}\n</attached_machine>`;
}

/** What an agent chip tells the agent: which model (or way of working) the user wants on the job. */
export function agentMentionBlock(mention: { readonly label: string; readonly value?: string }, models: readonly string[]): string {
	if (mention.value === MENTION_COUNCIL_VALUE) {
		return `<attached_council>\nThe user wants a council on this: call the council tool with the question and the facts it needs${models.length ? `, participants ${JSON.stringify(models)} (the models the user mentioned)` : ' (it picks one model per connected provider)'}. Then end your turn; the verdict comes back as a report.\n</attached_council>`;
	}
	if (mention.value === MENTION_TEAM_VALUE) {
		return `<attached_team>\nThe user wants a team of agents on this: split the work into independent items and call spawn_team${models.length ? ` with members on ${JSON.stringify(models)} (the models the user mentioned)` : ''}. Use the number and mix of agents the user asked for; Volt asks the user how many run at once when it is more than this machine runs comfortably.\n</attached_team>`;
	}
	return `<attached_agent model="${quote(mention.value ?? mention.label)}" label="${quote(mention.label)}">\nThe user mentioned this agent: give it the part of the work the message names (delegate_task with model "${quote(mention.value ?? mention.label)}"), or put it on the team or council the message asks for. When the message is simply addressed to it, hand the work to it with delegate_task and relay its report.\n</attached_agent>`;
}

//#endregion
