/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentTaskToolName, bareTaskToolName, DELEGATE_TASK_TOOL_NAME } from './agentTasks.js';

/**
 * Recognizes a harness's own subagent in its tool calls (captured 2026-10-04, see
 * .aInsp/research/cursor-subagents-protocol.md):
 *
 * - Cursor: `Task: <description>`, raw input `{_toolName: "task", description, prompt, subagentType}`.
 * - Claude (legacy ACP): an Agent/Task call with `{description, prompt, subagent_type}`.
 * - Codex (legacy ACP): separate "Start subagent <name>" / "Complete subagent <name>" calls
 *   keyed by `agentThreadId`.
 *
 * Volt's own `delegate_task` calls are not harness subagents: the orchestrator owns those.
 */

export interface IHarnessSubagentCall {
	/** `start`: a subagent begins (or this call is the subagent). `end`: a Codex completion bookend. */
	readonly phase: 'start' | 'end';
	/** The key the subagent is tracked by: the call id, or Codex's thread id for its bookends. */
	readonly key?: string;
	readonly title: string;
	readonly kind?: string;
	readonly brief?: string;
	readonly model?: string;
}

const SUBAGENT_NAME = /^(task|agent|subagent|run_agent|spawn_agent)$/i;

/**
 * One of Volt's own task tools behind a tool call, however the agent names it: `volt-delegate_task`,
 * `mcp__volt__delegate_task`, Cursor's "MCP: delegate_task" with `{providerIdentifier: 'volt', toolName}`.
 */
export function voltTaskToolOf(name: string | undefined, title: string | undefined, inputText?: string): AgentTaskToolName | undefined {
	const direct = bareTaskToolName(name) ?? bareTaskToolName(title);
	if (direct) {
		return direct;
	}
	const input = parseToolInput(inputText);
	return input && typeof input.toolName === 'string' && (input.providerIdentifier === 'volt' || input.args !== undefined) ? bareTaskToolName(input.toolName) : undefined;
}

/** A call that starts a subagent: a harness's own Task, or Volt's delegate_task. Decided from names only. */
export function isSubagentToolName(name: string | undefined, title: string | undefined): boolean {
	if (voltTaskToolOf(name, title) === DELEGATE_TASK_TOOL_NAME) {
		return true;
	}
	return SUBAGENT_NAME.test((name ?? '').trim()) || /^task\b/i.test((title ?? '').trim()) || /^(start|complete) subagent\b/i.test((title ?? '').trim());
}

export function parseToolInput(input: string | undefined): Record<string, unknown> | undefined {
	if (!input?.trim()) {
		return undefined;
	}
	try {
		const value = JSON.parse(input);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The subagent type as a word: Cursor sends `{unspecified: {}}` or `{custom: {...}}`. */
function kindOf(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() && value !== 'unspecified' ? value.trim() : undefined;
	}
	if (value && typeof value === 'object') {
		const key = Object.keys(value)[0];
		if (key === 'custom') {
			return kindOf((value as Record<string, unknown>).custom);
		}
		return key && key !== 'unspecified' ? key : undefined;
	}
	return undefined;
}

export function harnessSubagentCall(name: string | undefined, title: string | undefined, inputText: string | undefined): IHarnessSubagentCall | undefined {
	if (bareTaskToolName(name) || bareTaskToolName(title)) {
		return undefined;
	}
	const input = parseToolInput(inputText);
	const codex = /^(start|complete) subagent\s+(.+)$/i.exec(title?.trim() ?? '');
	if (codex) {
		const key = str(input?.agentThreadId);
		return {
			phase: codex[1].toLowerCase() === 'start' ? 'start' : 'end',
			...(key ? { key } : {}),
			title: humanize(codex[2]),
		};
	}
	const toolName = str(input?._toolName);
	const looksLikeTask = toolName?.toLowerCase() === 'task'
		|| SUBAGENT_NAME.test(name ?? '')
		|| /^task\b/i.test(title ?? '')
		|| (!!input && typeof input.prompt === 'string' && ('subagent_type' in input || 'subagentType' in input));
	if (!looksLikeTask) {
		return undefined;
	}
	const titled = title?.replace(/^task:\s*/i, '').trim();
	const description = str(input?.description) ?? (titled && !/^(task|subagent task|agent)$/i.test(titled) ? titled : undefined);
	return {
		phase: 'start',
		title: description ?? 'Subagent',
		...(kindOf(input?.subagent_type ?? input?.subagentType) ? { kind: kindOf(input?.subagent_type ?? input?.subagentType) } : {}),
		...(str(input?.prompt) ? { brief: str(input?.prompt) } : {}),
		...(str(input?.model) ? { model: str(input?.model) } : {}),
	};
}

/**
 * Claude's Agent tool launches children asynchronously: the call "completes" at launch with this
 * text while the child keeps working (the adapter holds the turn open until it is done).
 */
export function isAsyncLaunchResult(result: unknown): boolean {
	const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
	return /async agent launched|async_launched/i.test(text);
}

/** Cursor marks a failed Task as completed with `rawOutput.error`. */
export function harnessFailure(result: unknown): string | undefined {
	if (result && typeof result === 'object') {
		const error = (result as Record<string, unknown>).error;
		if (typeof error === 'string' && error.trim()) {
			return error.trim();
		}
	}
	return undefined;
}

function humanize(name: string): string {
	const last = name.split('/').filter(Boolean).at(-1) ?? name;
	const words = last.replace(/[_-]+/g, ' ').trim();
	return words ? words[0].toUpperCase() + words.slice(1) : 'Subagent';
}
