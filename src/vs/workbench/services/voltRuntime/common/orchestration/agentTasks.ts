/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltMode } from '../modes.js';
import type { VoltSubagentProfile } from '../providers.js';
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
/**
 * The same budget for a Claude parent: Claude Code's MCP client waits for a tool far longer than 60 s
 * (an HTTP call is cut at 5 min by Node's fetch). A 45 s cap made a Claude lead building for minutes
 * call wait_tasks again and again, each a whole request on its full context (ADEMark C1-style run).
 */
export const TASK_WAIT_LONG_MS = 240_000;

/** How long one waiting call may block: TASK_WAIT_LONG_MS for a Claude parent, TASK_WAIT_MS for any other. */
export function taskWaitMs(longWaits: boolean): number {
	return longWaits ? TASK_WAIT_LONG_MS : TASK_WAIT_MS;
}

/** A report longer than this is clipped in the parent's notification; the full text stays in the child chat. */
export const TASK_RESULT_CHARS = 12_000;
/** An upstream task's report as a dependent task receives it (`after`). */
export const UPSTREAM_REPORT_CHARS = 6_000;
/** Reports one notification carries in full; past that they share `BATCH_REPORT_CHARS`. */
const BATCH_REPORTS_FULL = 4;
const BATCH_REPORT_CHARS = 32_000;
const BATCH_REPORT_MIN_CHARS = 600;

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

/**
 * `after` of a delegate_task call that starts one task: task_ids, or 1-based positions of this
 * chat's own tasks in the order it started them ("1" is its first task). Models write a writer,
 * then its reviewer in a second call with `after: ["1"]`, as they would inside one `tasks` call;
 * that was refused ("not a task of this chat"), and the parent then waited for the writer itself
 * and started the reviewer a turn later. A position with no task stays as given (the decider
 * refuses it with the list of tasks).
 */
export function resolveChatTaskRefs(value: unknown, chatTasks: readonly { readonly id: string }[]): string[] {
	const items = typeof value === 'string' || typeof value === 'number' ? [value] : Array.isArray(value) ? value : [];
	const refs = items
		.map(item => typeof item === 'number' && Number.isInteger(item) ? String(item) : typeof item === 'string' ? item.trim().slice(0, 40) : '')
		.filter(Boolean)
		.slice(0, 16);
	return [...new Set(refs.map(ref => /^\d+$/.test(ref) ? chatTasks[Number(ref) - 1]?.id ?? ref : ref))];
}

/** At most this many `verify` commands per task: they run one after another before every report. */
export const MAX_VERIFY_COMMANDS = 6;

/** The `verify` commands from delegate_task's arguments: one line each, no blanks. */
export function verifyFromArgs(args: Record<string, unknown>): string[] {
	return stringListArg(args.verify, MAX_VERIFY_COMMANDS, 500).filter(command => !/[\r\n]/.test(command));
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
	description: 'A model from list_models (id, ref or label), or "auto" (the user\'s model for this role). Default: this chat\'s model.',
};

const STRING = { type: 'string' };
const STRINGS = { type: 'array', items: STRING };

/**
 * The schemas of delegate_task, wait_tasks and message_task are in every request of a top-level
 * chat (`alwaysLoad: 'top'`; round 3: 5.7 KB, about 2K tokens). So each says a thing once, the
 * fields carry types only, and the options long or risky work needs are named in the description
 * instead of typed: models write them as named, and the handler reads them as before (also on a
 * `tasks` entry).
 */
const DELEGATE_ARGS = {
	task: STRING,
	title: STRING,
	role: STRING,
	after: STRINGS,
	model: STRING,
	previous_task_id: STRING,
	wait: { type: 'boolean' },
	// Typed, not only named: with isolation in the description alone, Opus leads made their own git
	// worktrees for parallel edits (4 of 4: two C1 runs, two lead probes) instead of Volt's.
	isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'worktree: its own branch and checkout, for parallel edits of the same files; merge the branch it names.' },
};

export interface IAgentTaskToolInfo {
	readonly name: AgentTaskToolName;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
	/** `top`: in the prompt of top-level chats, not behind the tool search (`IVoltHostToolInfo.alwaysLoad`). */
	readonly alwaysLoad?: 'top';
}

/**
 * delegate_task. It starts one subagent per call: Claude Code runs the calls of one message one
 * after another, each as soon as it is written, so the first subagent starts while the parent still
 * writes the next brief (a `tasks` list held every part until the whole list was written). The
 * handler still takes `tasks` (at most `maxPerCall` entries, the user's setting) from callers that
 * send one.
 */
function delegateTaskTool(): IAgentTaskToolInfo {
	return {
		name: DELEGATE_TASK_TOOL_NAME,
		title: 'Delegated task',
		alwaysLoad: 'top',
		description: [
			'Run work on a Volt subagent (its own chat; the report comes back to you): parallel parts, a second opinion, self-contained work; not quick lookups.',
			'Brief: the files and facts you found, exactly what to do.',
			'Several parts: one call each, in one message (each starts once written).',
			'after: task_ids, or 1-based positions of this chat\'s tasks, that must finish first (their reports join the brief).',
			'Reports arrive as a message: end your turn or call wait_tasks (wait=true: wait here).',
			'role: research or review (read-only), implementation, test, design, general. previous_task_id: next review round.',
			'Also: models (2-4, same brief), goal, scope (only files it may change), files, constraints, done_when, verify (commands run on its report), context (brief/full/none), budget_usd, fallback_models.',
		].join(' '),
		inputSchema: { type: 'object', properties: DELEGATE_ARGS },
	};
}

export const AGENT_TASK_TOOLS: readonly IAgentTaskToolInfo[] = [
	{
		name: LIST_MODELS_TOOL_NAME,
		title: 'Listed models',
		description: 'List the agents and models Volt can run delegated tasks on (the same list as the user\'s model picker), with the model this chat is on. Use it before delegate_task or handoff when you want a specific model.',
		inputSchema: { type: 'object', properties: {} },
	},
	delegateTaskTool(),
	{
		name: TASK_STATUS_TOOL_NAME,
		title: 'Checked task',
		description: 'Read a delegated task: status (queued, running, completed, failed, cancelled, interrupted), what it is doing now, the files it changed, what it spent and, once finished, its report. Without task_id, lists every task this chat started and the subagent spend of this request. Reading a finished report here means it is not delivered again as a message.',
		inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } },
	},
	{
		name: WAIT_TASKS_TOOL_NAME,
		title: 'Waited for tasks',
		alwaysLoad: 'top',
		description: 'Wait for delegated tasks (default: all running; any=true: the first) and return their reports. Returns early after 45 s-4 min: call again, or end your turn.',
		inputSchema: { type: 'object', properties: { task_ids: STRINGS } },
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
		alwaysLoad: 'top',
		description: 'Send a finished delegated task a follow-up in its own chat, which keeps its context (answer it, ask for fixes). wait=true waits for the new report.',
		inputSchema: { type: 'object', properties: { task_id: STRING, message: STRING }, required: ['task_id', 'message'] },
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

/** The task tools. The cap on a `tasks` list (`_maxPerCall`) is the handler's: the schema lists no `tasks`. */
export function agentTaskTools(_maxPerCall: number): readonly IAgentTaskToolInfo[] {
	return AGENT_TASK_TOOLS;
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

/** How a delegated task's agent starts (`VoltSubagentProfile`): read-only for research, review and tasks in Ask or Plan mode. */
export function subagentProfileForTask(task: Pick<IOrchTask, 'role' | 'mode'>): VoltSubagentProfile {
	return task.role === 'research' || task.role === 'review' || task.mode === 'ask' || task.mode === 'plan' ? 'readonly' : 'work';
}

/**
 * The whole request is read-only: a sentence of its own ("Do not edit any file."), not one part
 * ("Reviewer (never edits files)") or the parent ("Do not edit files yourself"), or a read-only task.
 */
const READ_ONLY_REQUEST = /(?:^|[.!?:]\s+|\n\s*)(?:do not|don't|never|you must not)\s+(?:edit|change|modify)\s+(?:any\s+|the\s+)?(?:files?|code)\b(?!\s+yourself)|\bread[- ]only\s+(?:task|request|audit|review|question|investigation)s?\b/i;
/** Parts of the request that run read-only (`subagentProfileForTask`: research and review). */
const READ_ONLY_PARTS = /\b(?:review(?:er|ers|s)?|research(?:er|ers)?|audit(?:or|s)?|investigate)\b/i;

/**
 * Which spares to start while a chat writes its delegate_task call (`prewarmSubagents`), before its
 * tasks' roles are known: the request the chat is working on says it best. A research request in an
 * Agent chat warmed `work` spares, and every research subagent started cold (1.2-1.4 s each on the
 * critical path, harness bench rounds 2 and 3).
 */
export function subagentSpareKinds(allowWrites: boolean, request: string | undefined, total: number): { readonly work: number; readonly readonly: number } {
	if (!allowWrites || (request && READ_ONLY_REQUEST.test(request))) {
		return { work: 0, readonly: total };
	}
	if (request && total > 1 && READ_ONLY_PARTS.test(request)) {
		return { work: total - 1, readonly: 1 };
	}
	return { work: total, readonly: 0 };
}

const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };
/** "four work items", "up to 4 agents", "3 subagents", "two parallel tasks". */
const NAMED_COUNT = /\b(two|three|four|five|six|[2-6])\s+(?:[a-z-]+\s+){0,2}?(?:sub-?agents?|agents|work\s+items|items|tasks|parts)\b/i;

/**
 * How many spares a chat about to delegate warms (`prewarmSubagents`): as many as the request
 * names parts or agents, within `max`, else `fallback`. With three, the fourth worker of a
 * four-part request started its agent cold, on the critical path (ADEMark C1).
 */
export function subagentSpareCount(request: string | undefined, fallback: number, max: number): number {
	return Math.max(1, Math.min(max, namedSubagentCount(request) ?? fallback));
}

/** The number of parts or agents a request names ("four work items", "up to 4 agents"), if it names one. */
export function namedSubagentCount(request: string | undefined): number | undefined {
	const named = request ? NAMED_COUNT.exec(request)?.[1].toLowerCase() : undefined;
	return named ? COUNT_WORDS[named] ?? Number(named) : undefined;
}

/** Words of a request that asks for subagents outright (`requestAsksForSubagents`). */
const ASKS_FOR_SUBAGENTS = /\b(?:sub-?agents?|delegate_task|delegate\s+(?:it|them|this|these|each(?:\s+\w+)?|the\s+\w+)\s+to|(?:parallel|separate)\s+agents?|agents?\s+in\s+parallel)\b/i;

/**
 * True when the request itself asks for subagents ("with three subagents", "use delegate_task"):
 * their spares can start with the run instead of when the delegate_task call starts streaming.
 * Since delegate_task is loaded up front (no tool search first), that call starts about 3-5 s
 * before the tasks exist, less than an agent takes to start on a busy machine.
 */
export function requestAsksForSubagents(request: string | undefined): boolean {
	return !!request && ASKS_FOR_SUBAGENTS.test(request);
}

/**
 * What goes up as a subagent's report: its final message (the text after its last tool call), as
 * its brief says, not the notes it wrote between tool calls (`whole`). A final message that is not
 * the report (a "Done." after one last check, with the "## Outcome" report written before that
 * call) does not replace it: then the report runs from the last "## Outcome" heading. Undefined:
 * the whole reply is the report.
 */
export function subagentReport(whole: string, final: string): string | undefined {
	const text = whole.trim();
	const last = final.trim();
	if (!last || last === text) {
		return undefined;
	}
	const outcome = /^#{1,3}\s*Outcome\b/gm;
	if (outcome.test(last)) {
		return last;
	}
	let from = -1;
	outcome.lastIndex = 0;
	for (let match = outcome.exec(text); match; match = outcome.exec(text)) {
		from = match.index;
	}
	return from < 0 ? last : from === 0 ? undefined : text.slice(from);
}

/**
 * The refusal of a `delegate_task` call without a brief. Claude Code defers MCP tools behind Tool
 * Search, so its first call may come before it loaded the schema, with no arguments at all (5.9 s
 * and a ToolSearch round trip in a measured run). Naming the arguments lets the next call be right
 * without loading the schema first.
 */
export function delegateTaskMissingBrief(args: Record<string, unknown>): string {
	if (Object.values(args).some(value => value !== undefined)) {
		return 'delegate_task needs a `task`: the complete brief for the subagent (or `tasks`, one entry per part).';
	}
	return [
		'delegate_task was called without arguments: its parameters were probably not loaded yet. Call it again now with them (no ToolSearch needed):',
		'- one subagent: {"task": "<the complete brief>", "title": "<3-6 words>"}',
		'- several at once: {"tasks": [{"task": "...", "title": "..."}, {"task": "...", "after": ["1"]}]} (`after`: 1-based positions of parts that must finish first; their reports join the brief)',
		'Optional on the call or on each part: `model` (a name from list_models, e.g. "claude-code:claude-haiku-5-5"), `role` (research and review are read-only; implementation, test, design, general), `context` ("brief" | "full" | "none"), `done_when` (checks), `files`, `scope`, `fallback_models`, `isolation` ("shared" | "worktree"), and on the call `client_request_id` and `wait`.',
	].join('\n');
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
	/** Commands Volt runs before its report goes up (`IOrchTask.verify`). */
	readonly verify?: readonly string[];
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
	if (context.verify?.length) {
		lines.push('', `[Volt subagent] When you report done, Volt itself runs ${context.verify.length === 1 ? 'this command' : 'these commands'} in your checkout before your report goes up: ${context.verify.map(command => `\`${command}\``).join(', ')}. A failure comes back to you with its output, so run ${context.verify.length === 1 ? 'it' : 'them'} yourself first and fix what fails. Never weaken, skip or delete a check to make it pass.`);
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
		? '"## Verification" (each done_when check: met or not met, and how you know)'
		: '"## Verification" (one line: what you ran or read to check it)';
	const middle = EDITING_ROLES.has(role)
		? '"## Changes" (each file you changed and what changed, a line each; "None" if nothing)'
		: '"## Findings" (what you found, with file paths and line numbers)';
	// Short on purpose: the parent reads every report in each of its later requests, and a report is
	// output the subagent writes on the critical path (round-3 bench: reports of 1.3-3.4 KB that
	// restated the brief and every check took 2-5 s to write).
	return `[Volt subagent] Your final message is your report to the agent that delegated this task; nothing else you wrote reaches it. Keep it as short as the facts allow: no restating the brief, no narration. Use these headings: "## Outcome" (done, partly done or blocked, in one sentence), ${middle}, ${verification}, and "## Open issues" only when something is left or uncertain.`;
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
	// A brief that names its files is specific enough to finish on: asking for done_when on every small
	// edit only made the next call's arguments longer.
	if (editing && !contract?.doneWhen?.length && !namesFiles) {
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
/** Anonymized upstream reports: labels by place in `pool`, presented in an order of the reader's own (`seed`). */
export interface IBlindReports {
	readonly pool: readonly string[];
	readonly seed: string;
}

export function withUpstreamReports(text: string, upstream: readonly IOrchTask[], blind?: IBlindReports): string {
	if (!upstream.length) {
		return text;
	}
	const parts = [text, '', '<upstream_reports>'];
	if (blind) {
		// Anonymized (council critique): no ids, titles or models. Labels come from the shared pool, so
		// every judge names an answer the same way; the order is the reader's own, so no answer is
		// always read first (judges favour position as well as authorship).
		// Reports outside the pool (a later round's reviews) are numbered on their own.
		let review = 0;
		for (const task of blindOrder(upstream, blind.seed)) {
			const place = blind.pool.indexOf(task.id);
			const label = place >= 0 ? `Response ${blindLabel(place)}` : `Review ${++review}`;
			parts.push(`<report label="${label}"${task.state === 'completed' ? '' : ` status="${task.state}"`}>`, task.result?.trim() && task.state === 'completed' ? clip(task.result, UPSTREAM_REPORT_CHARS) : '(no report: this member did not finish)', '</report>');
		}
	} else {
		for (const task of upstream) {
			parts.push(`<report task_id="${task.id}" title="${task.title.replace(/"/g, '\'')}" status="${task.state}"${task.modelLabel ? ` model="${task.modelLabel.replace(/"/g, '\'')}"` : ''}>`, task.result?.trim() ? clip(task.result, UPSTREAM_REPORT_CHARS) : '(no report)', '</report>');
		}
	}
	parts.push('</upstream_reports>');
	return parts.join('\n');
}

/** "A", "B", … "Z", "AA": the anonymous label of the `index`th blind report. */
export function blindLabel(index: number): string {
	let label = '';
	let rest = index;
	do {
		label = String.fromCharCode(65 + (rest % 26)) + label;
		rest = Math.floor(rest / 26) - 1;
	} while (rest >= 0);
	return label;
}

/** Tasks in an order fixed by `seed` and their ids (the same on every replay) but not by spawn order. */
export function blindOrder<T extends Pick<IOrchTask, 'id'>>(tasks: readonly T[], seed = ''): T[] {
	const key = (id: string) => {
		const text = `${seed}\u0000${id}`;
		let value = 2166136261;
		for (let i = 0; i < text.length; i++) {
			value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0;
		}
		return value;
	};
	return [...tasks].sort((a, b) => key(a.id) - key(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

/** The subagent's checks failed: what it gets back (model-facing) instead of its report going up. */
export function verifyFailedText(summary: string, round: number, maxRounds: number): string {
	const left = maxRounds - round;
	return [
		`[Volt] Volt ran your task's checks after your report, and they failed (round ${round} of ${maxRounds}). Your report has not gone to the other agent yet.`,
		'',
		summary.trim(),
		'',
		`Find the cause and fix it, run the failing check yourself until it passes, then end with an updated report. Never weaken, skip or delete a check to make it pass. ${left > 1 ? `Volt checks again after your report (${left} more tries).` : 'Volt checks once more; if it still fails, your report goes up saying so.'}`,
	].join('\n');
}

/** The report as the parent reads it: the subagent's own, then what Volt's run of its checks found. */
export function withVerification(report: string | undefined, verification: { readonly state: 'passed' | 'failed' | 'skipped' | 'running'; readonly round: number; readonly summary?: string }): string {
	const head = verification.state === 'passed'
		? `## Volt verification\nPassed: Volt ran the checks itself after the report${verification.round > 1 ? ` (it took ${verification.round} rounds)` : ''}.`
		: verification.state === 'failed'
			? `## Volt verification\nFAILED after ${verification.round} round${verification.round === 1 ? '' : 's'}: the checks still fail. Treat the report's claims with care.`
			: '## Volt verification\nNot run.';
	return [report?.trim() || '(no report)', '', head, ...(verification.summary?.trim() ? [verification.summary.trim()] : [])].join('\n');
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
export function describeTask(task: IOrchTask, now: number, options: { readonly includeResult: boolean; readonly resultChars?: number }): string {
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
	if (task.verify?.length) {
		const verification = task.verification;
		const state = !verification ? 'not run yet (they run when it reports done)'
			: verification.state === 'running' ? `Volt is running them (round ${verification.round}); its report waits for them`
				: verification.state === 'failed' && isLiveTaskState(task.state) ? `failed in round ${verification.round}; it is fixing what they found`
					: `${verification.state} (round ${verification.round})`;
		lines.push(`checks: ${state}`);
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
		lines.push('report:', task.result?.trim() ? clip(task.result, options.resultChars ?? TASK_RESULT_CHARS) : '(no report)');
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
	// Many reports at once (a team): each gets its share of one budget, so 30 reports do not flood
	// the context; the full text stays in task_status and the team board.
	const share = finished.length > BATCH_REPORTS_FULL ? Math.max(BATCH_REPORT_MIN_CHARS, Math.floor(BATCH_REPORT_CHARS / finished.length)) : undefined;
	for (const task of finished) {
		parts.push('<task>', describeTask(task, now, { includeResult: true, ...(share ? { resultChars: share } : {}) }), '</task>');
	}
	parts.push('</task_results>', '');
	if (share) {
		parts.push(`Reports are shortened to about ${share.toLocaleString('en-US')} characters each here; task_status with a task_id reads one in full${finished.some(task => task.team) ? ', and team_board read shows the result of every item' : ''}.`);
	}
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

/**
 * delegate_task arguments with the names other harnesses use for the same thing: Claude Code's own
 * Agent tool takes `prompt` and `description`, and Claude wrote those into delegate_task's `tasks`
 * entries (a refused call and a retry before any subagent started). `prompt`/`brief` count as
 * `task`, and `description` as `title` when there is none.
 */
export function delegateArgsWithAliases(args: Record<string, unknown>): Record<string, unknown> {
	const fix = (entry: Record<string, unknown>): Record<string, unknown> => {
		if (typeof entry.task === 'string' && entry.task.trim()) {
			return entry;
		}
		const task = [entry.prompt, entry.brief].find((value): value is string => typeof value === 'string' && !!value.trim());
		if (!task) {
			return entry;
		}
		const { prompt: _prompt, brief: _brief, ...rest } = entry;
		return { ...rest, task, ...(rest.title === undefined && typeof entry.description === 'string' ? { title: entry.description } : {}) };
	};
	const top = fix(args);
	return Array.isArray(top.tasks)
		? { ...top, tasks: top.tasks.map(entry => entry && typeof entry === 'object' && !Array.isArray(entry) ? fix(entry as Record<string, unknown>) : entry) }
		: top;
}

/** A model a task may run on, as `model` arguments name it. */
export interface ITaskModelCandidate {
	readonly ref: string;
	readonly id: string;
	readonly label: string;
	readonly qualifier?: string;
	/** The provider's name as the user sees it ("Claude", "Cursor"). */
	readonly providerLabel?: string;
	readonly providerId?: string;
}

/**
 * The model a `model` argument names: its ref, id or label exactly, else by words, so the names
 * agents write ("Claude Haiku 4.5", "claude-haiku-4-5", "Sonnet 5.5") find "Haiku 4.5" of the
 * Claude provider instead of costing a failed call and a list_models round trip.
 */
export function matchTaskModel<T extends ITaskModelCandidate>(items: readonly T[], value: string): T | undefined {
	const wanted = value.trim().toLowerCase();
	const exact = items.find(item => item.ref.toLowerCase() === wanted)
		?? items.find(item => item.id.toLowerCase() === wanted)
		?? items.find(item => item.label.toLowerCase() === wanted)
		?? items.find(item => `${item.label} ${item.qualifier ?? ''}`.trim().toLowerCase() === wanted);
	if (exact) {
		return exact;
	}
	const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const w = words(value);
	if (!w) {
		return undefined;
	}
	const hits = items.filter(item => [item.label, `${item.label} ${item.qualifier ?? ''}`, `${item.providerLabel ?? ''} ${item.label}`, item.id].map(words).some(name =>
		!!name && (name === w || name.startsWith(`${w} `) || (name.length >= 4 && w.endsWith(` ${name}`)))));
	// The same model under two providers: the one the name mentions.
	const named = hits.find(item => [item.providerLabel, item.providerId].some(provider => provider && w.includes(words(provider))));
	return named ?? hits[0] ?? items.find(item => item.label.toLowerCase().includes(wanted) || item.ref.toLowerCase().includes(wanted));
}

/** First line of the brief, trimmed to a title, when the caller gave none. */
export function titleFromBrief(brief: string, max = 60): string {
	const line = brief.trim().split('\n').map(text => text.trim()).find(Boolean) ?? 'Task';
	// Briefs often open with where to work ("In /tmp/repo: edit src/a.js ..."): the title is the work.
	const unplaced = line.replace(/^(?:working\s+)?in\s+(?:the\s+)?(?:repo\s+|project\s+)?[`'"]?[~.]?\/[^\s`'"]*[`'"]?\s*[:,]\s*(?=\S)/i, '');
	const plain = (unplaced.charAt(0).toUpperCase() + unplaced.slice(1)).replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '');
	return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
