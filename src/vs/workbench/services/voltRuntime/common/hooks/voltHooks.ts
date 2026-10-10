/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IVoltTool } from '../tools/tool.js';

/**
 * Hooks: commands that run when the agent does something (before a shell command, after a file
 * edit, when it stops), and can watch, block, rewrite or follow up.
 *
 * Volt reads three layouts so an existing setup works unchanged:
 * - Volt and Cursor `hooks.json`: `{ "version": 1, "hooks": { "beforeShellExecution": [{ "command": "..." }] } }`
 * - Claude Code `settings.json`: `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "..." }] }] } }`
 * - plugin `hooks/hooks.json` files in either shape.
 *
 * Each hook speaks the protocol of the layout it came from: the event JSON on stdin in that
 * tool's field names, and its answer (exit code 2 or a JSON decision) read the same way.
 */

/** Volt's event names (Cursor's names; Claude Code's are mapped onto them). */
export type VoltHookEvent =
	| 'sessionStart' | 'sessionEnd'
	| 'beforeSubmitPrompt'
	| 'preToolUse' | 'postToolUse' | 'postToolUseFailure'
	| 'beforeShellExecution' | 'afterShellExecution'
	| 'beforeMCPExecution' | 'afterMCPExecution'
	| 'beforeReadFile' | 'afterFileEdit'
	| 'subagentStart' | 'subagentStop'
	| 'stop' | 'afterAgentResponse' | 'preCompact';

export const VOLT_HOOK_EVENTS: readonly VoltHookEvent[] = [
	'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure',
	'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile',
	'afterFileEdit', 'subagentStart', 'subagentStop', 'stop', 'afterAgentResponse', 'preCompact',
];

const CLAUDE_EVENTS: Record<string, VoltHookEvent> = {
	PreToolUse: 'preToolUse',
	PostToolUse: 'postToolUse',
	PostToolUseFailure: 'postToolUseFailure',
	UserPromptSubmit: 'beforeSubmitPrompt',
	Stop: 'stop',
	SubagentStart: 'subagentStart',
	SubagentStop: 'subagentStop',
	SessionStart: 'sessionStart',
	SessionEnd: 'sessionEnd',
	PreCompact: 'preCompact',
};

const CLAUDE_EVENT_NAMES: Partial<Record<VoltHookEvent, string>> = Object.fromEntries(Object.entries(CLAUDE_EVENTS).map(([claude, volt]) => [volt, claude]));

export type VoltHookProtocol = 'cursor' | 'claude';
export type VoltHookScope = 'user' | 'workspace' | 'plugin';

export interface IVoltHookDefinition {
	readonly event: VoltHookEvent;
	/** How it was spelled in its file ("PreToolUse"). */
	readonly sourceEvent: string;
	readonly protocol: VoltHookProtocol;
	readonly command: string;
	/** Tool-name pattern (Claude `matcher`, Cursor `matcher`); empty matches every tool. */
	readonly matcher?: string;
	readonly timeoutMs: number;
	readonly scope: VoltHookScope;
	/** Which app's layout it is written in. */
	readonly origin: 'volt' | 'cursor' | 'claude';
	/** The file it was read from (a path). */
	readonly file: string;
	/** Where the command runs. */
	readonly cwd?: string;
	/** A plugin's folder, exposed as `CLAUDE_PLUGIN_ROOT`. */
	readonly pluginRoot?: string;
	/** A crash or timeout of the hook blocks the action instead of letting it through. */
	readonly failClosed: boolean;
	/** Section label for the Hooks list: "Claude User", "my-repo / deploy-on-aws". */
	readonly label: string;
}

export interface IVoltHookFileContext {
	readonly scope: VoltHookScope;
	readonly origin: IVoltHookDefinition['origin'];
	readonly file: string;
	readonly cwd?: string;
	readonly pluginRoot?: string;
	readonly label: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/** Every hook in a `hooks.json` or `settings.json`, in either app's shape (entry by entry). */
export function parseHookFile(json: unknown, context: IVoltHookFileContext): IVoltHookDefinition[] {
	if (!json || typeof json !== 'object') {
		return [];
	}
	const hooks = (json as { hooks?: unknown }).hooks;
	if (!hooks || typeof hooks !== 'object') {
		return [];
	}
	const result: IVoltHookDefinition[] = [];
	for (const [sourceEvent, raw] of Object.entries(hooks as Record<string, unknown>)) {
		const event = CLAUDE_EVENTS[sourceEvent] ?? (VOLT_HOOK_EVENTS.includes(sourceEvent as VoltHookEvent) ? sourceEvent as VoltHookEvent : undefined);
		if (!event) {
			continue;
		}
		const pascal = sourceEvent in CLAUDE_EVENTS;
		for (const entry of Array.isArray(raw) ? raw : [raw]) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const record = entry as { hooks?: unknown; matcher?: unknown; command?: unknown; timeout?: unknown; type?: unknown; failClosed?: unknown; fail_closed?: unknown };
			const failClosed = record.failClosed === true || record.fail_closed === true;
			if (Array.isArray(record.hooks)) {
				// Claude's shape: a matcher group with its handlers.
				const matcher = typeof record.matcher === 'string' ? record.matcher : undefined;
				for (const handler of record.hooks) {
					const command = (handler as { command?: unknown })?.command;
					const type = (handler as { type?: unknown })?.type;
					if (typeof command !== 'string' || (type !== undefined && type !== 'command')) {
						continue;
					}
					result.push({
						event, sourceEvent, protocol: 'claude', command, matcher, failClosed,
						timeoutMs: timeoutOf((handler as { timeout?: unknown }).timeout),
						scope: context.scope, origin: context.origin, file: context.file, cwd: context.cwd, pluginRoot: context.pluginRoot, label: context.label,
					});
				}
			} else if (typeof record.command === 'string' && (record.type === undefined || record.type === 'command')) {
				result.push({
					event, sourceEvent,
					// A flat handler under a Claude event name still talks Claude's protocol.
					protocol: pascal ? 'claude' : 'cursor',
					command: record.command,
					matcher: typeof record.matcher === 'string' ? record.matcher : undefined,
					failClosed,
					timeoutMs: timeoutOf(record.timeout),
					scope: context.scope, origin: context.origin, file: context.file, cwd: context.cwd, pluginRoot: context.pluginRoot, label: context.label,
				});
			}
		}
	}
	return result;
}

/** Hook timeouts are written in seconds. */
function timeoutOf(value: unknown): number {
	return typeof value === 'number' && value > 0 ? Math.min(MAX_TIMEOUT_MS, Math.round(value * 1000)) : DEFAULT_TIMEOUT_MS;
}

//#region Tools as each app names them

const CLAUDE_TOOL_NAMES: Record<string, string> = {
	shell: 'Bash',
	read_file: 'Read',
	edit_file: 'Edit',
	write_file: 'Write',
	delete_file: 'Delete',
	list_dir: 'LS',
	grep: 'Grep',
	glob: 'Glob',
	web_fetch: 'WebFetch',
	web_search: 'WebSearch',
	task: 'Task',
	todo: 'TodoWrite',
	skill: 'Skill',
};

const CURSOR_TOOL_NAMES: Record<string, string> = {
	shell: 'Shell',
	read_file: 'Read',
	edit_file: 'Write',
	write_file: 'Write',
	delete_file: 'Delete',
	list_dir: 'LS',
	grep: 'Grep',
	glob: 'Glob',
	web_fetch: 'WebFetch',
	web_search: 'WebSearch',
	task: 'Task',
	todo: 'TodoWrite',
};

export function isMcpTool(name: string): boolean {
	return name.startsWith('mcp__');
}

/** `mcp__github__create_issue` → `{ server: 'github', tool: 'create_issue' }`. */
export function mcpParts(name: string): { server: string; tool: string } | undefined {
	const match = /^mcp__(.+?)__(.+)$/.exec(name);
	return match ? { server: match[1], tool: match[2] } : undefined;
}

export function hookToolName(protocol: VoltHookProtocol, name: string): string {
	if (isMcpTool(name)) {
		const parts = mcpParts(name);
		return protocol === 'claude' || !parts ? name : `MCP:${parts.tool}`;
	}
	return (protocol === 'claude' ? CLAUDE_TOOL_NAMES : CURSOR_TOOL_NAMES)[name] ?? name;
}

function absolute(path: unknown, cwd: string | undefined): string | undefined {
	if (typeof path !== 'string' || !path) {
		return undefined;
	}
	if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || !cwd) {
		return path;
	}
	return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`;
}

/** Long strings (file contents) are cut so the event fits in a process environment. */
function clip(value: unknown, max = 64_000): unknown {
	return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}\n[truncated ${value.length - max} characters]` : value;
}

/** A Volt tool call's arguments in the field names the hook's app uses. */
export function hookToolInput(protocol: VoltHookProtocol, name: string, args: unknown, cwd: string | undefined): Record<string, unknown> {
	const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
	const path = absolute(record.path, cwd);
	switch (name) {
		case 'shell':
			return protocol === 'claude'
				? { command: record.command, description: record.description, timeout: record.timeout_ms, run_in_background: record.background }
				: { command: record.command, cwd: absolute(record.cwd, cwd) ?? cwd };
		case 'read_file':
			return { file_path: path, offset: record.offset, limit: record.limit };
		case 'edit_file':
			return Array.isArray(record.edits)
				? { file_path: path, edits: record.edits.map(edit => ({ old_string: clip((edit as Record<string, unknown>).old_string), new_string: clip((edit as Record<string, unknown>).new_string), replace_all: (edit as Record<string, unknown>).replace_all })) }
				: { file_path: path, old_string: clip(record.old_string), new_string: clip(record.new_string), replace_all: record.replace_all };
		case 'write_file':
			return { file_path: path, content: clip(record.contents) };
		case 'delete_file':
			return { file_path: path };
		case 'grep':
			return { pattern: record.pattern, path, glob: record.include ?? record.glob };
		case 'glob':
			return { pattern: record.pattern, path };
		case 'task':
			return { description: record.description, prompt: clip(record.prompt), subagent_type: record.agent ?? 'explore' };
		default:
			return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, clip(value)]));
	}
}

/** A hook's rewritten input back in Volt's argument names, merged over the original call's. */
export function voltToolArgs(name: string, original: unknown, updated: Record<string, unknown>): unknown {
	const base = (original && typeof original === 'object' ? { ...(original as Record<string, unknown>) } : {}) as Record<string, unknown>;
	const set = (key: string, value: unknown) => {
		if (value !== undefined) {
			base[key] = value;
		}
	};
	switch (name) {
		case 'shell':
			set('command', updated.command);
			set('cwd', updated.cwd);
			set('description', updated.description);
			return base;
		case 'read_file':
		case 'delete_file':
			set('path', updated.file_path ?? updated.path);
			return base;
		case 'edit_file':
			set('path', updated.file_path ?? updated.path);
			set('old_string', updated.old_string);
			set('new_string', updated.new_string);
			set('replace_all', updated.replace_all);
			set('edits', updated.edits);
			return base;
		case 'write_file':
			set('path', updated.file_path ?? updated.path);
			set('contents', updated.content ?? updated.contents);
			return base;
		case 'grep':
		case 'glob':
			set('pattern', updated.pattern);
			set('path', updated.path);
			return base;
		default:
			return { ...base, ...updated };
	}
}

/** Whether a hook's matcher picks this tool. Claude matchers are regexes over its tool names; `*` and empty match all. */
export function hookMatches(definition: IVoltHookDefinition, toolName: string | undefined): boolean {
	const matcher = definition.matcher?.trim();
	if (!matcher || matcher === '*' || toolName === undefined) {
		return true;
	}
	const name = hookToolName(definition.protocol, toolName);
	try {
		return new RegExp(`^(?:${matcher})$`).test(name) || new RegExp(`^(?:${matcher})$`).test(toolName);
	} catch {
		return matcher.split('|').map(part => part.trim()).some(part => part === name || part === toolName);
	}
}

//#endregion

//#region Payloads

export interface IVoltHookRunContext {
	readonly sessionId: string;
	readonly runId?: string;
	/** The project root the agent works in. */
	readonly root?: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly mode?: string;
	/** A hook answered "stop": end the run. */
	stop?(reason: string): void;
}

/** The JSON a hook reads on stdin: common fields in its app's spelling, plus the event's own. */
export function hookPayload(definition: IVoltHookDefinition, context: IVoltHookRunContext, fields: Record<string, unknown>): Record<string, unknown> {
	if (definition.protocol === 'claude') {
		return {
			session_id: context.sessionId,
			transcript_path: '',
			cwd: context.cwd ?? context.root ?? '',
			permission_mode: context.mode === 'ask' || context.mode === 'plan' ? 'plan' : 'default',
			hook_event_name: CLAUDE_EVENT_NAMES[definition.event] ?? definition.sourceEvent,
			...fields,
		};
	}
	return {
		conversation_id: context.sessionId,
		generation_id: context.runId ?? '',
		model: context.model ?? '',
		hook_event_name: definition.event,
		workspace_roots: context.root ? [context.root] : [],
		...fields,
	};
}

//#endregion

//#region Answers

export interface IVoltHookAnswer {
	/** The action must not happen; tell the model why. */
	readonly block?: string;
	/** Shown to the user instead of (or with) the model's message. */
	readonly userMessage?: string;
	/** End the whole run. */
	readonly stopRun?: string;
	readonly updatedInput?: Record<string, unknown>;
	/** Text added to the model's context. */
	readonly context?: string;
	/** `stop`/`subagentStop`: keep going with this message. */
	readonly followup?: string;
	/** `sessionStart`: environment for later commands of the session. */
	readonly env?: Record<string, string>;
}

const BLOCKING_EVENTS = new Set<VoltHookEvent>(['beforeSubmitPrompt', 'preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'subagentStart']);

/** Whether a hook on this event can stop the action it precedes. */
export function isBlockingEvent(event: VoltHookEvent): boolean {
	return BLOCKING_EVENTS.has(event);
}

function parseJson(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const value = JSON.parse(trimmed);
		return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Reads what a hook printed and how it exited, in its app's protocol. */
export function interpretHookAnswer(definition: IVoltHookDefinition, exitCode: number | null, stdout: string, stderr: string): IVoltHookAnswer {
	const event = definition.event;
	const json = parseJson(stdout);
	if (exitCode === 2) {
		// Both apps: exit 2 is "no", with the reason on stderr.
		const reason = str(stderr) ?? str(stdout) ?? 'Blocked by a hook.';
		if (event === 'stop' || event === 'subagentStop') {
			return { followup: reason };
		}
		return isBlockingEvent(event) ? { block: reason } : { context: reason };
	}
	if (exitCode !== 0) {
		return {};
	}
	if (definition.protocol === 'claude') {
		const specific = (json?.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput : {}) as Record<string, unknown>;
		const answer: { -readonly [K in keyof IVoltHookAnswer]: IVoltHookAnswer[K] } = {};
		if (json?.continue === false) {
			answer.stopRun = str(json.stopReason) ?? 'A hook stopped the run.';
		}
		const decision = str(specific.permissionDecision) ?? str(json?.decision);
		const reason = str(specific.permissionDecisionReason) ?? str(json?.reason);
		if (decision === 'deny' || decision === 'block') {
			if (event === 'stop' || event === 'subagentStop') {
				answer.followup = reason ?? 'Keep going.';
			} else if (isBlockingEvent(event)) {
				answer.block = reason ?? 'Blocked by a hook.';
			} else {
				answer.context = reason;
			}
		}
		if (specific.updatedInput && typeof specific.updatedInput === 'object') {
			answer.updatedInput = specific.updatedInput as Record<string, unknown>;
		}
		const extra = str(specific.additionalContext);
		if (extra) {
			answer.context = [answer.context, extra].filter(Boolean).join('\n');
		} else if (!json && (event === 'beforeSubmitPrompt' || event === 'sessionStart') && str(stdout)) {
			// Plain output of these two events is context for the model.
			answer.context = str(stdout);
		}
		if (str(json?.systemMessage)) {
			answer.userMessage = str(json?.systemMessage);
		}
		return answer;
	}
	if (!json) {
		return {};
	}
	const answer: { -readonly [K in keyof IVoltHookAnswer]: IVoltHookAnswer[K] } = {};
	const permission = str(json.permission) ?? str(json.decision);
	const agentMessage = str(json.agent_message) ?? str(json.agentMessage) ?? str(json.reason);
	const userMessage = str(json.user_message) ?? str(json.userMessage);
	if (permission === 'deny' || permission === 'block' || (event === 'beforeSubmitPrompt' && json.continue === false)) {
		answer.block = agentMessage ?? userMessage ?? 'Blocked by a hook.';
		answer.userMessage = userMessage;
	} else if (json.continue === false) {
		answer.stopRun = userMessage ?? agentMessage ?? 'A hook stopped the run.';
	}
	const updated = json.updated_input ?? json.updatedInput;
	if (updated && typeof updated === 'object') {
		answer.updatedInput = updated as Record<string, unknown>;
	}
	const followup = str(json.followup_message) ?? str(json.followupMessage);
	if (followup) {
		answer.followup = followup;
	}
	const context = str(json.additional_context) ?? str(json.additionalContext);
	if (context) {
		answer.context = context;
	}
	if (json.env && typeof json.env === 'object') {
		answer.env = Object.fromEntries(Object.entries(json.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
	}
	if (!answer.block && userMessage) {
		answer.userMessage = userMessage;
	}
	return answer;
}

//#endregion

//#region Service

export interface IVoltHookExecution {
	readonly id: string;
	readonly event: VoltHookEvent;
	readonly sourceEvent: string;
	readonly label: string;
	readonly command: string;
	readonly sessionId?: string;
	readonly toolName?: string;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly outcome: 'ok' | 'blocked' | 'rewrote' | 'followup' | 'error';
	/** What the hook said (its reason, or the start of its stderr). */
	readonly message?: string;
}

/** The combined answer of every hook on one event. */
export interface IVoltHookResult {
	readonly blocked?: string;
	readonly userMessage?: string;
	readonly stopRun?: string;
	readonly updatedInput?: Record<string, unknown>;
	readonly context: readonly string[];
	readonly followup?: string;
	readonly env?: Record<string, string>;
}

export const IVoltHooksService = createDecorator<IVoltHooksService>('voltHooksService');

export interface IVoltHooksService {
	readonly _serviceBrand: undefined;

	/** Recent hook runs, newest first. */
	readonly executions: readonly IVoltHookExecution[];
	readonly onDidChangeExecutions: Event<void>;
	clearExecutions(): void;

	/** The hooks that apply to a project (its own only when the workspace is trusted) and to the user. */
	definitions(root: string | undefined): Promise<readonly IVoltHookDefinition[]>;

	/** Runs every hook for `event` in order; a blocking answer stops the rest. */
	run(event: VoltHookEvent, context: IVoltHookRunContext, fields: Record<string, unknown> | ((protocol: VoltHookProtocol) => Record<string, unknown>), toolName?: string): Promise<IVoltHookResult>;

	/** The tool with its before/after hooks around every call. */
	wrapTool(tool: IVoltTool, context: () => IVoltHookRunContext): IVoltTool;
}

export const EMPTY_HOOK_RESULT: IVoltHookResult = { context: [] };

//#endregion
