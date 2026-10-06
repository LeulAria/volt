/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltMode } from '../modes.js';
import type { IOrchTask, OrchTaskState } from './orchestrator.js';

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

/** Children per parent that run at once; more wait their turn. */
export const MAX_RUNNING_TASKS_PER_CHAT = 4;
/** Children across the window that run at once. */
export const MAX_RUNNING_TASKS = 8;
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

/** Agents prefix MCP tool names with the server (`volt-delegate_task`, `mcp__volt__delegate_task`). */
export function bareTaskToolName(name: string | undefined): AgentTaskToolName | undefined {
	if (!name) {
		return undefined;
	}
	const bare = name.replace(/^(?:mcp__volt__|volt[-_:.])/i, '').replace(/^.*?:\s*/, '');
	return isAgentTaskTool(bare) ? bare : undefined;
}

const MODEL_ARG = {
	type: 'string',
	description: 'Model to run it on: a `model` value from list_models (exact id or ref, or a label such as "Claude Opus 5.5"). Omit to use this chat\'s model.',
};

export interface IAgentTaskToolInfo {
	readonly name: AgentTaskToolName;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
}

export const AGENT_TASK_TOOLS: readonly IAgentTaskToolInfo[] = [
	{
		name: LIST_MODELS_TOOL_NAME,
		title: 'Listed models',
		description: 'List the agents and models Volt can run delegated tasks on (the same list as the user\'s model picker), with the model this chat is on. Use it before delegate_task or handoff when you want a specific model.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: DELEGATE_TASK_TOOL_NAME,
		title: 'Delegated task',
		description: [
			'Run one task on a Volt subagent: a separate chat, on any model from list_models, that starts with only your brief (it does not see this conversation). Use it to work in parallel (several independent tasks at once), to get a second opinion from a different model (review, research), or to give a self-contained piece of work to a model better suited to it.',
			'Write the brief like a hand-off to a capable colleague who knows nothing: the goal, the relevant files and facts you already found, constraints, and what the report should contain. Do not delegate work that depends on finishing something else first, and do not delegate trivial lookups you can do faster yourself.',
			'Returns a task_id at once (wait=false, the default). Several tasks run in parallel. When a task finishes its report is delivered to this chat as a new message, so after starting tasks you may end your turn instead of polling; call wait_tasks only when you need the results before you can continue in this turn. task_status reads progress.',
			'Review rounds: for each new round of a review (or any work you send back after changes), call delegate_task again with previous_task_id set to the last round and a fresh client_request_id (keep that id when you retry the same round). Do not use message_task for a new round: a fresh subagent reviews the current code without the previous reviewer\'s assumptions. Tasks and their reports survive a Volt restart.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'The complete brief for the subagent.' },
				previous_task_id: {
					type: 'string',
					description: 'Start the next round of earlier work as a new task: the task_id of the previous round (e.g. a second review after you fixed what the first review found). Volt gives the new subagent that round\'s brief and report; your `task` should add what changed since, your responses to its findings, and the objections still open.',
				},
				title: { type: 'string', description: 'A short title shown in Volt (3-6 words).' },
				model: MODEL_ARG,
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
			required: ['task'],
		},
	},
	{
		name: TASK_STATUS_TOOL_NAME,
		title: 'Checked task',
		description: 'Read a delegated task: status (queued, running, completed, failed, cancelled, interrupted), what it is doing now, the files it changed and, once finished, its report. Without task_id, lists every task this chat started. Reading a finished report here means it is not delivered again as a message.',
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

//#endregion

//#region Prompts

const ROLE_GUIDANCE: Readonly<Record<AgentTaskRole, string>> = {
	general: 'Do what the brief asks. Change files only if the brief asks for changes.',
	research: 'Research only: read, search and run read-only commands. Do not change files. Report what you found with file paths and line numbers.',
	implementation: 'Implement the change, run the relevant checks (build, tests, lint) and fix what they find.',
	review: 'Review only: do not change files. Report concrete problems in order of severity, each with file, line, why it is wrong and a suggested fix. Say plainly when you find nothing.',
	test: 'Write or run tests as the brief asks. Make tests pass by fixing code only when the brief says so; never weaken assertions.',
	design: 'Work on the UI or design the brief describes, and check the result visually when you can.',
};

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
}

/**
 * What the child model receives: Volt's subagent framing around the brief. The child chat shows
 * only the brief; this text is the model-facing prompt.
 */
export function buildTaskPrompt(brief: string, context: ITaskBriefContext): string {
	const lines = [
		`[Volt subagent] Another agent delegated this task to you${context.parentTitle ? ` from the chat "${context.parentTitle}"` : ''}. You do not see that conversation: the brief below is everything you get, so read the code you need instead of assuming.`,
		`[Volt subagent] ${ROLE_GUIDANCE[context.role]}`,
		'[Volt subagent] Work on your own; ask the user only if you are blocked. Stay within the task. Your final message is returned to the other agent as your report: start with the outcome in one or two sentences, then what you did or found (with file paths), the files you changed, how you checked it, and anything left undone or uncertain.',
	];
	if (context.isolation === 'worktree') {
		lines.push(`[Volt subagent] You work in your own git worktree${context.worktreeBranch ? ` on branch ${context.worktreeBranch}` : ' (a separate checkout on its own branch)'}. Commit your changes there when done and name the branch in your report, so the other agent can merge it.`);
	}
	if (context.depth >= MAX_TASK_DEPTH) {
		lines.push('[Volt subagent] Do the work yourself: do not delegate it further.');
	}
	if (context.previous) {
		const previous = context.previous;
		lines.push(`[Volt subagent] This is round ${previous.iteration + 1} of this work. Round ${previous.iteration} (task ${previous.id}) had the brief and report below; the code may have changed since. Check whether each earlier finding still applies instead of repeating it, and say which are resolved.`);
		lines.push('', `<previous_round task_id="${previous.id}" status="${previous.state}">`, '<brief>', previous.brief.trim(), '</brief>', '<report>', previous.result?.trim() ? clip(previous.result, TASK_RESULT_CHARS) : '(no report)', '</report>', '</previous_round>');
	}
	lines.push('', '<task>', brief.trim(), '</task>');
	return lines.join('\n');
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

/**
 * The turn that wakes a parent once its tasks finish. Model-facing; the transcript shows a card.
 * `others` are tasks of the same parent still running, so the agent knows more will come.
 */
export function buildTaskNotification(finished: readonly IOrchTask[], others: readonly IOrchTask[], now: number): string {
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
