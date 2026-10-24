/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltMode } from '../modes.js';
import type { IOrchSpend, IOrchTask, IOrchTaskUsage, OrchTaskState } from './orchestrator.js';

/**
 * Delegated tasks. A chat's agent (or the user) hands one task to another model; the task runs in
 * its own child chat with only the brief it was given, and its report comes back to the parent:
 * read by the agent mid-turn (`task_status`, `wait_tasks`), or delivered as a new turn once the
 * parent is idle. Several tasks can run at once, so one chat holds many pieces of work.
 *
 * Modeled on T3 Code's orchestrator (app-owned children, completion that wakes the parent, reading
 * a result acknowledges its delivery) and Cursor's subagents (role-shaped briefs, a final report
 * returned verbatim, parallel launches).
 */

export type AgentTaskRole = 'general' | 'research' | 'implementation' | 'review' | 'test' | 'design';

export const AGENT_TASK_ROLES: readonly AgentTaskRole[] = ['general', 'research', 'implementation', 'review', 'test', 'design'];

/**
 * - `pending`: the parent has not seen the result; it is delivered when the parent goes idle.
 * - `delivered`: sent to the parent as a notification turn.
 * - `acknowledged`: the parent's agent read the result itself, so no notification is sent.
 * - `none`: nothing to deliver (still running, or delivery was disposed by a cancel).
 */
export type AgentTaskDelivery = 'pending' | 'delivered' | 'acknowledged' | 'none';

/** Who started the task: the parent's agent through a tool, or the user from the composer. */
export type AgentTaskOrigin = 'agent' | 'user';

/** Where the child works: the parent's checkout, or a new worktree branched from it. */
export type AgentTaskIsolation = 'shared' | 'worktree';

export function isTerminalTaskState(state: OrchTaskState): boolean {
	return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted';
}

export function isLiveTaskState(state: OrchTaskState): boolean {
	return state === 'queued' || state === 'running' || state === 'waiting';
}

/** Children per parent that run at once; more wait their turn (the default; Settings can change it). */
export const MAX_RUNNING_TASKS_PER_CHAT = 6;
/** Children across the window that run at once (the default; Settings can change it). */
export const MAX_RUNNING_TASKS = 12;
/** Tasks one delegate_task call may start with `tasks` (the default, as `DEFAULT_ORCH_LIMITS.spawnsPerCall`; Settings can change it). */
export const MAX_BATCH_TASKS = 8;
/** A task may start tasks of its own, one level down. */
export const MAX_TASK_DEPTH = 2;
/**
 * Long-poll budget for `delegate_task` with `wait` and for `wait_tasks`. Agents' MCP clients time a
 * call out after 60 s and do not reset on progress (cursor-agent), so a call returns before that
 * and tells the agent to call again.
 */
export const TASK_WAIT_MS = 45_000;
/** A report longer than this is clipped in the parent's notification; the full text stays in the child chat. */
export const TASK_RESULT_CHARS = 12_000;
/** An upstream task's report as a dependent task receives it (`after`). */
export const UPSTREAM_REPORT_CHARS = 6_000;

/**
 * What "done" means for a task, beyond its brief: the handoff contract. A child sees only what it
 * is given, so the parent states the outcome, the rules, the files and the checks that prove the
 * work (Roo's todos, zenith's task body, paseo's handoff brief). The files it owns are its `scope`.
 */
export interface ITaskContract {
	/** The outcome wanted, in a sentence or two. */
	readonly goal?: string;
	/** Rules the work must keep (must / must not). */
	readonly constraints?: readonly string[];
	/** The checks that prove it is done: a test passing, a type-check, what the page shows. */
	readonly doneWhen?: readonly string[];
	/** Files to read before starting; owned files (that it may change) are the task's `scope`. */
	readonly files?: readonly string[];
}

/**
 * How much of the parent chat a child gets besides its brief: none, a short digest (the user's
 * request, the parent's plan and latest reply, what sibling subagents do), or a longer one.
 */
export type TaskContextLevel = 'none' | 'brief' | 'full';

export function normalizeContextLevel(value: unknown): TaskContextLevel {
	return value === 'none' || value === 'full' ? value : 'brief';
}

/** A string list from tool input: one string, or an array of them; blanks dropped, each clipped. */
export function stringListArg(value: unknown, max = 24, chars = 600): string[] {
	const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
	return items
		.filter((item): item is string => typeof item === 'string' && !!item.trim())
		.map(item => item.trim().slice(0, chars))
		.slice(0, max);
}

/** The contract from delegate_task's arguments (one task or one `tasks` entry); undefined when it names nothing. */
export function contractFromArgs(args: Record<string, unknown>): ITaskContract | undefined {
	const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim().slice(0, 1_000) : undefined;
	const constraints = stringListArg(args.constraints);
	const doneWhen = stringListArg(args.done_when);
	const files = stringListArg(args.files, 40, 300);
	if (!goal && !constraints.length && !doneWhen.length && !files.length) {
		return undefined;
	}
	return {
		...(goal ? { goal } : {}),
		...(constraints.length ? { constraints } : {}),
		...(doneWhen.length ? { doneWhen } : {}),
		...(files.length ? { files } : {}),
	};
}

//#region Tool names and schemas

export const LIST_MODELS_TOOL_NAME = 'list_models';
export const DELEGATE_TASK_TOOL_NAME = 'delegate_task';
export const TASK_STATUS_TOOL_NAME = 'task_status';
export const WAIT_TASKS_TOOL_NAME = 'wait_tasks';
export const CANCEL_TASK_TOOL_NAME = 'cancel_task';
export const MESSAGE_TASK_TOOL_NAME = 'message_task';
export const HANDOFF_TOOL_NAME = 'handoff';

export const AGENT_TASK_TOOL_NAMES = [
	LIST_MODELS_TOOL_NAME,
	DELEGATE_TASK_TOOL_NAME,
	TASK_STATUS_TOOL_NAME,
	WAIT_TASKS_TOOL_NAME,
	CANCEL_TASK_TOOL_NAME,
	MESSAGE_TASK_TOOL_NAME,
	HANDOFF_TOOL_NAME,
] as const;

export type AgentTaskToolName = typeof AGENT_TASK_TOOL_NAMES[number];

export function isAgentTaskTool(name: string | undefined): name is AgentTaskToolName {
	return !!name && (AGENT_TASK_TOOL_NAMES as readonly string[]).includes(name);
}

/** Agents prefix MCP tool names with the server (`volt-delegate_task`, `mcp__volt__delegate_task`, `volt__delegate_task`). */
export function bareTaskToolName(name: string | undefined): AgentTaskToolName | undefined {
	if (!name) {
		return undefined;
	}
	const bare = name.trim().replace(/^(?:mcp__volt__|volt__|volt[-_:.])/i, '').replace(/^.*?:\s*/, '');
	return isAgentTaskTool(bare) ? bare : undefined;
}

const MODEL_ARG = {
	type: 'string',
	description: 'Model to run it on: a `model` value from list_models (exact id or ref, or a label such as "Claude Opus 5.5"), or "auto" for the model the user set for this role. Omit to use this chat\'s model.',
};

/** The handoff contract and run options, the same for one task and for each `tasks` entry. */
const CONTRACT_ARGS = {
	goal: { type: 'string', description: 'The outcome you want, in a sentence or two (what is true when the work is done).' },
	constraints: { type: 'array', items: { type: 'string' }, description: 'Rules the work must keep: what must not change, APIs to keep, style to follow.' },
	done_when: { type: 'array', items: { type: 'string' }, description: 'The checks that prove it is done (a test that passes, a type-check, what the page shows). The subagent checks each one and reports met or not met.' },
	files: { type: 'array', items: { type: 'string' }, description: 'Files to read before starting (paths), so it does not explore to find them.' },
	scope: { type: 'array', items: { type: 'string' }, description: 'Files or folders this task owns: the only ones it may change. Volt flags two tasks claiming the same paths.' },
	context: { type: 'string', enum: ['brief', 'full', 'none'], description: 'How much of this chat the subagent gets besides your brief. brief (default): the user\'s request, your plan and latest reply, and what the other subagents are doing. full: more of the conversation. none: only your brief (an unbiased second opinion).' },
	budget_usd: { type: 'number', description: 'Stop this task when it has spent this much (US dollars, at list price when the agent does not report a cost).' },
	fallback_models: { type: 'array', items: { type: 'string' }, description: 'Models to retry on, in order, when the task fails on its model (provider error, usage limit). The retry gets the same brief.' },
};

export interface IAgentTaskToolInfo {
	readonly name: AgentTaskToolName;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
}

/** delegate_task, with `tasks` taking at most `maxPerCall` entries (the user's setting). */
function delegateTaskTool(maxPerCall: number): IAgentTaskToolInfo {
	return {
		name: DELEGATE_TASK_TOOL_NAME,
		title: 'Delegated task',
		description: [
			'Run one task on a Volt subagent: a separate chat, on any model from list_models, that starts with your brief plus a short digest of this chat (the user\'s request, your plan, what other subagents do). Use it to work in parallel (several independent tasks at once), to get a second opinion from a different model (review, research), or to give a self-contained piece of work to a model better suited to it.',
			'Write the brief like a hand-off to a capable colleague: the relevant files and facts you already found, and what to do with them. Fill the contract: `goal` (the outcome), `scope` (files it owns and may change), `files` (files to read first), `constraints`, and `done_when` (the checks that prove it is done; it reports each as met or not met). For work that edits code, name the files to change and what to change in each (paths, symbols, line numbers you saw), so the subagent can start editing at once instead of exploring again. Do not delegate trivial lookups you can do faster yourself.',
			'To run several parts at once, start them all in ONE call with `tasks` (one entry per part, each with its own complete brief) instead of one call per part. A part that needs another part\'s result names it in `after` (that part\'s 1-based position in `tasks`, or a task_id): it starts once those finish, with their reports added to its brief.',
			'Returns a task_id at once (wait=false, the default). Several tasks run in parallel. When a task finishes its report is delivered to this chat as a new message, so after starting tasks you may end your turn instead of polling; call wait_tasks only when you need the results before you can continue in this turn. task_status reads progress and spend. Subagent spend counts against the user\'s budget for this request; a task over its budget is stopped.',
			'Review rounds: for each new round of a review (or any work you send back after changes), call delegate_task again with previous_task_id set to the last round and a fresh client_request_id (keep that id when you retry the same round). Do not use message_task for a new round: a fresh subagent reviews the current code without the previous reviewer\'s assumptions. Tasks and their reports survive a Volt restart.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'The complete brief for the subagent. Give `task` for one subagent, or `tasks` for several.' },
				tasks: {
					type: 'array',
					maxItems: maxPerCall,
					description: `Start up to ${maxPerCall} subagents in one call, one entry per part of the work. Each entry takes the same fields as a single task (task, title, model, role, isolation, goal, scope, files, constraints, done_when, context, budget_usd, fallback_models) plus \`after\`; fields left out use this call's top-level values. Use instead of \`task\`.`,
					items: {
						type: 'object',
						properties: {
							task: { type: 'string', description: 'The complete brief for this subagent.' },
							title: { type: 'string', description: 'A short title shown in Volt (3-6 words).' },
							model: MODEL_ARG,
							role: { type: 'string', enum: AGENT_TASK_ROLES },
							isolation: { type: 'string', enum: ['shared', 'worktree'] },
							...CONTRACT_ARGS,
							after: { type: 'array', items: { type: 'string' }, description: 'Parts that must finish first: 1-based positions of earlier entries in `tasks` ("1", "2"), or task_ids. Their reports are added to this part\'s brief when it starts.' },
						},
						required: ['task'],
					},
				},
				...CONTRACT_ARGS,
				after: { type: 'array', items: { type: 'string' }, description: 'task_ids of this chat\'s tasks that must finish first; their reports are added to the brief when this one starts.' },
				previous_task_id: {
					type: 'string',
					description: 'Start the next round of earlier work as a new task: the task_id of the previous round (e.g. a second review after you fixed what the first review found). Volt gives the new subagent that round\'s brief and report; your `task` should add what changed since, your responses to its findings, and the objections still open.',
				},
				title: { type: 'string', description: 'A short title shown in Volt (3-6 words).' },
				model: MODEL_ARG,
				models: {
					type: 'array',
					items: { type: 'string' },
					description: 'Run the same brief on 2-4 models at once, one task each (independent reviews, competing designs, a second opinion from another vendor). Each report comes back on its own. Use instead of `model`.',
				},
				role: {
					type: 'string',
					enum: AGENT_TASK_ROLES,
					description: 'research and review run read-only and report back; implementation, test and design may edit files; general decides from the brief.',
				},
				isolation: {
					type: 'string',
					enum: ['shared', 'worktree'],
					description: 'shared (default, use it unless two tasks would edit the same files): works in this chat\'s checkout, so its edits land where the user sees them. worktree: works on a new git branch in its own checkout so parallel edits cannot collide; its edits do not reach this checkout until you merge that branch (the report names it).',
				},
				wait: { type: 'boolean', description: 'Wait for the result in this call (up to about 45 s, then call wait_tasks). Default false.' },
				client_request_id: { type: 'string', description: 'Optional idempotency key: a retry with the same key returns the same task instead of starting another.' },
			},
		},
	};
}

export const AGENT_TASK_TOOLS: readonly IAgentTaskToolInfo[] = [
	{
		name: LIST_MODELS_TOOL_NAME,
		title: 'Listed models',
		description: 'List the agents and models Volt can run delegated tasks on (the same list as the user\'s model picker), with the model this chat is on. Use it before delegate_task or handoff when you want a specific model.',
		inputSchema: { type: 'object', properties: {} },
	},
	delegateTaskTool(MAX_BATCH_TASKS),
	{
		name: TASK_STATUS_TOOL_NAME,
		title: 'Checked task',
		description: 'Read a delegated task: status (queued, running, completed, failed, cancelled, interrupted), what it is doing now, the files it changed, what it spent and, once finished, its report. Without task_id, lists every task this chat started and the subagent spend of this request. Reading a finished report here means it is not delivered again as a message.',
		inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } },
	},
	{
		name: WAIT_TASKS_TOOL_NAME,
		title: 'Waited for tasks',
		description: 'Wait for delegated tasks to finish and return their reports. Waits for all of task_ids (default: every running task of this chat), or for the first one when any=true. Returns after about 45 s even if some are still running; call it again to keep waiting, or end your turn and the reports will be delivered as a message.',
		inputSchema: {
			type: 'object',
			properties: {
				task_ids: { type: 'array', items: { type: 'string' } },
				any: { type: 'boolean', description: 'Return as soon as one of them finishes.' },
			},
		},
	},
	{
		name: CANCEL_TASK_TOOL_NAME,
		title: 'Cancelled task',
		description: 'Stop a queued or running delegated task. Its partial work stays in its chat; nothing is delivered to this chat afterwards.',
		inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id'] },
	},
	{
		name: MESSAGE_TASK_TOOL_NAME,
		title: 'Messaged task',
		description: 'Send a follow-up to a finished delegated task: it continues in the same chat with everything it already learned (answer its question, ask it to fix what review found, ask for more detail). Starts another round; the new report is delivered like the first.',
		inputSchema: {
			type: 'object',
			properties: {
				task_id: { type: 'string' },
				message: { type: 'string' },
				wait: { type: 'boolean', description: 'Wait for the new report in this call (up to about 45 s).' },
			},
			required: ['task_id', 'message'],
		},
	},
	{
		name: HANDOFF_TOOL_NAME,
		title: 'Handed off',
		description: 'Hand the rest of this conversation to another model: when your turn ends, Volt switches this chat to that model and it continues from your brief plus the conversation so far. Use it when the remaining work suits another model better (deep reasoning, a large refactor, UI work, a cheaper model for mechanical edits). Write the brief for the next model: the goal, what is done, what is left, and anything it must not redo. Then finish your turn with a short note to the user.',
		inputSchema: {
			type: 'object',
			properties: {
				model: { ...MODEL_ARG, description: 'The model to hand off to, from list_models.' },
				brief: { type: 'string', description: 'What the next model needs to continue: goal, state, next steps, pitfalls.' },
				reason: { type: 'string', description: 'One line for the user: why this model.' },
			},
			required: ['model', 'brief'],
		},
	},
];

/** The task tools, with delegate_task's `tasks` capped at `maxPerCall`. */
export function agentTaskTools(maxPerCall: number): readonly IAgentTaskToolInfo[] {
	return maxPerCall === MAX_BATCH_TASKS ? AGENT_TASK_TOOLS : AGENT_TASK_TOOLS.map(tool => tool.name === DELEGATE_TASK_TOOL_NAME ? delegateTaskTool(maxPerCall) : tool);
}

//#endregion

//#region Prompts

const ROLE_GUIDANCE: Readonly<Record<AgentTaskRole, string>> = {
	general: 'Do what the brief asks. Change files only if the brief asks for changes.',
	research: 'Research only: read, search and run read-only commands. Do not change files. Report what you found with file paths and line numbers.',
	implementation: 'Implement the change and check the files you changed for errors. Run tests, a type-check or a build only when other code depends on the change, you are unsure it works, or the brief asks; fix what they find.',
	review: 'Review only: do not change files. Report concrete problems in order of severity, each with file, line, why it is wrong and a suggested fix. Say plainly when you find nothing.',
	test: 'Write or run tests as the brief asks. Make tests pass by fixing code only when the brief says so; never weaken assertions.',
	design: 'Work on the UI or design the brief describes, and check the result visually when you can.',
};

/** Roles whose subagent may change files: these are told to start editing early. */
const EDITING_ROLES: ReadonlySet<AgentTaskRole> = new Set(['general', 'implementation', 'test', 'design']);

/**
 * A subagent that edits starts editing early. Without this, some models spent most of a task
 * (20+ minutes) re-exploring and reasoning before their first edit, though the brief already had
 * the facts.
 */
const EDIT_FAST = '[Volt subagent] Move fast. The brief already has what the other agent found: trust it. Read only the files you will change, all in one parallel batch, then start editing within your first few steps. Do not re-explore the codebase, write a long plan, or reason through every case before the first edit: make the change, check it, and adjust. Keep your thinking between tool calls short; if you notice you have been thinking for a while without a tool call, make the next edit.';

/** Read-only roles run in Ask mode so agents with a read-only mode are held to it. */
export function modeForTaskRole(role: AgentTaskRole, requested: VoltMode | undefined): VoltMode {
	if (role === 'research' || role === 'review') {
		return 'ask';
	}
	return requested === 'plan' || requested === 'ask' || requested === 'debug' ? requested : 'agent';
}

export function normalizeTaskRole(value: unknown): AgentTaskRole {
	return typeof value === 'string' && (AGENT_TASK_ROLES as readonly string[]).includes(value) ? value as AgentTaskRole : 'general';
}

export interface ITaskBriefContext {
	readonly parentTitle?: string;
	readonly role: AgentTaskRole;
	readonly depth: number;
	readonly isolation: AgentTaskIsolation;
	readonly worktreeBranch?: string;
	/** The round this task follows (`previous_task_id`): its brief and report go along. */
	readonly previous?: { readonly id: string; readonly iteration: number; readonly brief: string; readonly result?: string; readonly state: OrchTaskState };
	readonly contract?: ITaskContract;
	/** Paths the task owns: the only ones it may change. */
	readonly scope?: readonly string[];
	/** The digest of the parent chat (see taskContext.ts), already formatted. */
	readonly capsule?: string;
	/** Spend the task may still use: this request's subagent budget left, and its own cap. */
	readonly budget?: { readonly requestLeftUsd?: number; readonly taskUsd?: number };
	/** The tasks it waits for (`after`); their reports are added when it starts. */
	readonly after?: readonly string[];
}

/**
 * What the child model receives: Volt's subagent framing around the brief and its contract. The
 * child chat shows only the brief; this text is the model-facing prompt.
 */
export function buildTaskPrompt(brief: string, context: ITaskBriefContext): string {
	const readOnly = !EDITING_ROLES.has(context.role);
	const lines = [
		`[Volt subagent] Another agent delegated this task to you${context.parentTitle ? ` from the chat "${context.parentTitle}"` : ''}. You do not see that conversation: the brief${context.contract ? ', its contract' : ''}${context.capsule ? ' and the digest of that chat' : ''} below are everything you get, so read the code you need instead of assuming.`,
		`[Volt subagent] ${ROLE_GUIDANCE[context.role]}`,
		...(EDITING_ROLES.has(context.role) ? [EDIT_FAST] : []),
		'[Volt subagent] Work on your own; ask the user only if you are blocked. Do only this task: the digest of the other chat is background, not more work for you.',
	];
	if (context.scope?.length && !readOnly) {
		lines.push(`[Volt subagent] You own these paths and may change only them: ${context.scope.join(', ')}. Other subagents may be editing other files at the same time; if the task needs a change elsewhere, say so in your report instead of making it.`);
	}
	const budget = context.budget;
	if (budget && (budget.requestLeftUsd !== undefined || budget.taskUsd !== undefined)) {
		const caps = [
			...(budget.taskUsd !== undefined ? [`this task may spend up to ${formatUsd(budget.taskUsd)}`] : []),
			...(budget.requestLeftUsd !== undefined ? [`the subagents of this request have ${formatUsd(budget.requestLeftUsd)} left`] : []),
		];
		lines.push(`[Volt subagent] Budget: ${caps.join('; ')}. Volt stops the work at the limit, so work efficiently and report early if the task needs much more.`);
	}
	if (context.after?.length) {
		lines.push(`[Volt subagent] This task waited for ${context.after.join(', ')}; their reports are at the end. Treat their claims as leads to check, not as facts.`);
	}
	if (context.isolation === 'worktree') {
		lines.push(`[Volt subagent] You work in your own git worktree${context.worktreeBranch ? ` on branch ${context.worktreeBranch}` : ' (a separate checkout on its own branch)'}. Commit your changes there when done and name the branch in your report, so the other agent can merge it.`);
	}
	if (context.depth >= MAX_TASK_DEPTH) {
		lines.push('[Volt subagent] Do the work yourself: do not delegate it further.');
	} else {
		lines.push('[Volt subagent] If your task splits into independent parts, you may run them in parallel with delegate_task (one level down, all parts in one call with `tasks`). Never hand your whole task to another subagent, and never delegate the same brief again after it ran: read its report instead.');
	}
	if (context.previous) {
		const previous = context.previous;
		lines.push(`[Volt subagent] This is round ${previous.iteration + 1} of this work. Round ${previous.iteration} (task ${previous.id}) had the brief and report below; the code may have changed since. Check whether each earlier finding still applies instead of repeating it, and say which are resolved.`);
		lines.push('', `<previous_round task_id="${previous.id}" status="${previous.state}">`, '<brief>', previous.brief.trim(), '</brief>', '<report>', previous.result?.trim() ? clip(previous.result, TASK_RESULT_CHARS) : '(no report)', '</report>', '</previous_round>');
	}
	if (context.capsule) {
		lines.push('', context.capsule);
	}
	lines.push('', '<task>', brief.trim(), '</task>');
	const contract = contractLines(context.contract, readOnly ? undefined : context.scope);
	if (contract.length) {
		lines.push('', '<contract>', ...contract, '</contract>');
	}
	lines.push('', reportFormat(context.role, !!context.contract?.doneWhen?.length));
	return lines.join('\n');
}

function contractLines(contract: ITaskContract | undefined, scope: readonly string[] | undefined): string[] {
	const lines: string[] = [];
	const list = (tag: string, items: readonly string[] | undefined) => {
		if (items?.length) {
			lines.push(`<${tag}>`, ...items.map(item => `- ${item}`), `</${tag}>`);
		}
	};
	if (contract?.goal) {
		lines.push('<goal>', contract.goal, '</goal>');
	}
	list('owned_files', scope);
	list('read_first', contract?.files);
	list('constraints', contract?.constraints);
	list('done_when', contract?.doneWhen);
	return lines;
}

/**
 * The report the parent gets back: fixed headings, so reports from different models merge
 * without guessing (zenith's worker report, pi's scout format).
 */
function reportFormat(role: AgentTaskRole, checks: boolean): string {
	const verification = checks
		? '"## Verification" (each done_when check: met or not met, with the command you ran or what you saw)'
		: '"## Verification" (how you checked your work: commands run and their result, or what you read)';
	const middle = EDITING_ROLES.has(role)
		? '"## Changes" (each file you changed and what changed; "None" if nothing)'
		: '"## Findings" (what you found, with file paths and line numbers)';
	return `[Volt subagent] Your final message is your report to the agent that delegated this task; nothing else you wrote reaches it. Use these headings: "## Outcome" (done, partly done or blocked, in one or two sentences), ${middle}, ${verification}, "## Open issues" (what is left, risks, anything you were unsure of; "None" if nothing).`;
}

/**
 * What to tell the parent about a brief before the child starts on it. Advice, never a refusal:
 * the brief may still be fine, but these are the gaps that most often send a child exploring for
 * minutes or reporting "done" on the wrong thing.
 */
export function lintTaskBrief(brief: string, role: AgentTaskRole, contract: ITaskContract | undefined, scope: readonly string[] | undefined, context: TaskContextLevel): string[] {
	const notes: string[] = [];
	const words = brief.trim().split(/\s+/).filter(Boolean).length;
	const editing = EDITING_ROLES.has(role) && role !== 'general';
	const namesFiles = !!scope?.length || !!contract?.files?.length || /[\w-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|css|scss|html|json|md|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|vue|svelte|sql|yml|yaml|toml)\b/.test(brief);
	if (editing && !contract?.doneWhen?.length) {
		notes.push('no done_when: the subagent decides on its own when it is finished. Name the checks that prove the work (a test, a type-check, what the page shows).');
	}
	if (editing && !namesFiles) {
		notes.push('no files named: it will spend its first minutes finding them. Give `scope` (files it may change) or `files` (files to read first).');
	}
	if (words < 25 && !contract && context === 'none') {
		notes.push(`the brief is ${words} words and context is none, so that is all the subagent sees.`);
	}
	return notes;
}

/**
 * A dependent task's brief once the tasks it waited for (`after`) are done: their reports go
 * after its own prompt (pi's chain `{previous}`, cline's team `dependsOn`).
 */
export function withUpstreamReports(text: string, upstream: readonly IOrchTask[]): string {
	if (!upstream.length) {
		return text;
	}
	const parts = [text, '', '<upstream_reports>'];
	for (const task of upstream) {
		parts.push(`<report task_id="${task.id}" title="${task.title.replace(/"/g, '\'')}" status="${task.state}"${task.modelLabel ? ` model="${task.modelLabel.replace(/"/g, '\'')}"` : ''}>`, task.result?.trim() ? clip(task.result, UPSTREAM_REPORT_CHARS) : '(no report)', '</report>');
	}
	parts.push('</upstream_reports>');
	return parts.join('\n');
}

export function formatUsd(value: number): string {
	if (value > 0 && value < 0.01) {
		return '<$0.01';
	}
	return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	}
	if (value >= 1_000) {
		return `${Math.round(value / 1_000)}k`;
	}
	return String(Math.round(value));
}

/** A follow-up round in an existing child chat. */
export function buildTaskFollowUp(message: string): string {
	return `[Volt] The agent that delegated your task sent a follow-up. Answer it, then end with an updated report.\n\n${message.trim()}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) {
		return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n[... report clipped; the full text is in the task's chat]` : trimmed;
}

function statusWord(task: IOrchTask): string {
	switch (task.state) {
		case 'completed': return 'completed';
		case 'failed': return 'failed';
		case 'cancelled': return 'was cancelled';
		case 'interrupted': return 'was interrupted (Volt restarted while it ran)';
		case 'queued': return 'is queued';
		case 'running': return 'is running';
		case 'waiting': return 'is waiting for the user';
	}
}

/** One task as tools report it: compact, quotable, with the report once there is one. */
export function describeTask(task: IOrchTask, now: number, options: { readonly includeResult: boolean }): string {
	const elapsed = task.startedAt ? formatDuration((task.endedAt ?? now) - task.startedAt) : undefined;
	const lines = [
		`task_id: ${task.id}`,
		`title: ${task.title}`,
		`model: ${task.modelLabel ?? task.modelRef ?? 'this chat\'s model'}`,
		`status: ${task.state}${elapsed ? ` (${elapsed})` : ''}`,
	];
	if (task.role !== 'general') {
		lines.push(`role: ${task.role}`);
	}
	if (task.iteration && task.iteration > 1) {
		lines.push(`iteration: ${task.iteration}${task.previousTaskId ? ` (follows ${task.previousTaskId})` : ''}`);
	}
	if (task.rounds > 1) {
		lines.push(`round: ${task.rounds}`);
	}
	if (task.restarts) {
		lines.push(`continued after ${task.restarts === 1 ? 'a Volt restart' : `${task.restarts} Volt restarts`}`);
	}
	if (task.waitingOn) {
		lines.push(`waiting for: the user (${task.waitingOn === 'approval' ? 'an approval' : 'an answer to a question'}) in the subagent's chat`);
	}
	if (isLiveTaskState(task.state) && task.activity) {
		lines.push(`now: ${task.activity}`);
	}
	if (task.state === 'queued' && task.after?.length) {
		lines.push(`waits for: ${task.after.join(', ')} (it starts once they finish, with their reports)`);
	}
	if (task.failedOn?.length) {
		lines.push(`failed on: ${task.failedOn.join(', ')}; continued on ${task.modelLabel ?? task.modelRef ?? 'the next model'}`);
	}
	if (task.usage && (task.usage.tokens || task.usage.costUsd)) {
		lines.push(`spent: ${describeUsage(task.usage)}${task.budgetUsd !== undefined ? ` (budget ${formatUsd(task.budgetUsd)})` : ''}`);
	} else if (task.budgetUsd !== undefined) {
		lines.push(`budget: ${formatUsd(task.budgetUsd)}`);
	}
	if (task.worktreeBranch) {
		lines.push(`branch: ${task.worktreeBranch}${task.worktreePath ? ` (${task.worktreePath})` : ''}`);
	}
	if (task.files.length) {
		lines.push(`files changed: ${task.files.slice(0, 30).join(', ')}${task.files.length > 30 ? `, +${task.files.length - 30} more` : ''}`);
	}
	if (task.error) {
		lines.push(`error: ${task.error}`);
	}
	if (options.includeResult && isTerminalTaskState(task.state)) {
		lines.push('report:', task.result?.trim() ? clip(task.result, TASK_RESULT_CHARS) : '(no report)');
	}
	return lines.join('\n');
}

/** Tokens and cost, as tools and notifications show them. */
export function describeUsage(usage: IOrchTaskUsage): string {
	const tokens = `${formatTokens(usage.tokens)} tokens${usage.cacheRead ? ` (+${formatTokens(usage.cacheRead)} cached)` : ''}`;
	return usage.costUsd !== undefined ? `${tokens} · ${formatUsd(usage.costUsd)}${usage.priced === 'list' ? ' at list price' : ''}` : `${tokens} · no price known`;
}

/** This request's subagent spend against the budget, or undefined before anything was spent. */
export function describeSpend(spend: IOrchSpend | undefined, limits: { readonly budgetUsd: number; readonly budgetTokens: number }): string | undefined {
	if (!spend || (!spend.usd && !spend.tokens)) {
		return undefined;
	}
	const usd = limits.budgetUsd > 0 ? `${formatUsd(spend.usd)} of ${formatUsd(limits.budgetUsd)}` : formatUsd(spend.usd);
	const tokens = limits.budgetTokens > 0 ? `${formatTokens(spend.tokens)} of ${formatTokens(limits.budgetTokens)} tokens` : `${formatTokens(spend.tokens)} tokens`;
	const head = `Subagent spend this request: ${usd} (${tokens}).`;
	return spend.capped ? `${head} The budget ran out, so no more subagents start until the user's next message.` : head;
}

/**
 * The turn that wakes a parent once its tasks finish. Model-facing; the transcript shows a card.
 * `others` are tasks of the same parent still running, so the agent knows more will come.
 */
export function buildTaskNotification(finished: readonly IOrchTask[], others: readonly IOrchTask[], now: number, spend?: string): string {
	const head = finished.length === 1
		? `[Volt] Delegated task "${finished[0].title}" ${statusWord(finished[0])}.`
		: `[Volt] ${finished.length} delegated tasks finished.`;
	const parts = [head, '', '<task_results>'];
	for (const task of finished) {
		parts.push('<task>', describeTask(task, now, { includeResult: true }), '</task>');
	}
	parts.push('</task_results>', '');
	if (others.length) {
		parts.push(`Still running: ${others.map(task => `${task.id} "${task.title}"${task.modelLabel ? ` (${task.modelLabel})` : ''}`).join('; ')}. Their reports will arrive the same way.`);
	}
	if (finished.some(task => task.isolation === 'worktree' && task.state === 'completed')) {
		parts.push('Tasks that ran in a worktree left their changes on their branch (listed above); they are not in this checkout until you merge them (git merge <branch>) once you have checked them.');
	}
	if (spend) {
		parts.push(spend);
	}
	parts.push('Continue the work using these results. Check a subagent\'s claims that matter before you rely on them. If a task failed, decide whether to retry it (delegate_task or message_task), do it yourself, or tell the user.');
	return parts.join('\n');
}

/** The short line the transcript shows for a notification turn. */
export function taskNotificationDisplay(finished: readonly IOrchTask[]): string {
	if (finished.length === 1) {
		const task = finished[0];
		return task.state === 'completed' ? `Task finished: ${task.title}` : `Task ${statusWord(task)}: ${task.title}`;
	}
	return `${finished.length} tasks finished: ${finished.map(task => task.title).join(', ')}`;
}

//#endregion

/** `t-` and six hex digits: short enough to quote, unique within a window's lifetime of tasks. */
export function newTaskId(existing: (id: string) => boolean, random: () => number = Math.random): string {
	for (; ;) {
		const id = `t-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
		if (!existing(id)) {
			return id;
		}
	}
}

/** First line of the brief, trimmed to a title, when the caller gave none. */
export function titleFromBrief(brief: string, max = 60): string {
	const line = brief.trim().split('\n').map(text => text.trim()).find(Boolean) ?? 'Task';
	const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '');
	return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
