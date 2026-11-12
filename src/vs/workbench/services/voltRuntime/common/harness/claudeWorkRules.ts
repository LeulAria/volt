/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How Claude Code works inside Volt, sent once per session (not per turn, so it stays in the
 * cached prompt).
 *
 * Measured on 30 Claude subagent runs from real Volt chats (2026-10-18): 93% of 2,307 model
 * requests carried a single tool call, files were read and edited through `cat`/`sed`/python,
 * and long checks were waited on with `sleep`/`until` loops. Thinking was close to zero. The time
 * went into one round trip per step, so the rules ask for batched steps, the file tools (Volt
 * tracks and shows their changes), and waiting without polling. Nothing here skips a check.
 */

/** Appended to Claude Code's own system prompt for the main agent. */
export const CLAUDE_MAIN_RULES = [
	'# Working in Volt',
	'- Batch: put every independent tool call of a step in one message (all the reads you need, independent searches, edits to different files). One call per message is the slowest way to work.',
	'- Read and change files with Read, Edit, Write, Grep and Glob; keep Bash for commands (tests, builds, git). Volt tracks and shows changes made with Edit and Write; sed or script rewrites are invisible to it.',
	'- Wait for a long command by running it in the background and reading its output when you need it, not with sleep or until loops.',
	'- When you hand work to subagents: give each one the files to change and what to change in each (paths, symbols, facts you already found) so it starts editing at once instead of exploring again, and start independent subagents together in one message.',
	'- Tasks (TaskCreate/TaskUpdate) show in the user\'s Tasks card. Mark a task in_progress when you start it and completed as soon as it is done, not all at the end. Before you end a turn, every task is completed, deleted (status "deleted") if it no longer applies, or left open only because it waits on the user. When the user moves on to unrelated work, delete the old leftover tasks first.',
].join('\n');

/** Why the Stop hook keeps a turn going: sent to Claude as the reason. No single quotes (see {@link stopHookCommand}). */
export const CLAUDE_OPEN_TASKS_REASON = '[Volt] Your task list still has open tasks, and the user sees them as unfinished. Use TaskList, then TaskUpdate each one: completed if it is done, deleted if it no longer applies or was superseded. Leave a task open only if it waits on the user, and say which. Do not start new work.';

/**
 * A Stop hook (POSIX sh) that keeps the turn going once while Claude's task list has open tasks, so
 * finished work does not stay "in progress" in the Tasks card and come back next turn. Claude Code
 * keeps the list in `<config dir>/tasks/<session id>/<n>.json`. The second stop (`stop_hook_active`)
 * always ends the turn.
 */
export function stopHookCommand(reason: string = CLAUDE_OPEN_TASKS_REASON): string {
	const output = JSON.stringify({ decision: 'block', reason });
	return [
		'input=$(cat)',
		'case "$input" in *\'"stop_hook_active":true\'*|*\'"stop_hook_active": true\'*) exit 0;; esac',
		'sid=$(printf \'%s\' "$input" | sed -n \'s/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p\' | head -n 1)',
		'[ -n "$sid" ] || exit 0',
		'grep -qE \'"status" *: *"(pending|in_progress)"\' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tasks/$sid/"*.json 2>/dev/null || exit 0',
		`printf '%s' '${output.replace(/'/g, `'\\''`)}'`,
	].join('\n');
}

/** Given to every subagent Claude Code starts (its SubagentStart hook's additional context). */
export const CLAUDE_SUBAGENT_RULES = [
	'[Volt] How to work fast without cutting corners:',
	'- Batch: put every independent tool call of a step in one message (read all the files you need together, run independent searches together, edit different files together). One call per message is the slowest way to work.',
	'- Your brief has what the delegating agent found. Read what you will change or must confirm, then start editing; do not explore the codebase again or plan at length first.',
	'- Read and change files with Read, Edit, Write, Grep and Glob; keep Bash for commands (tests, builds, git). Volt tracks and shows changes made with Edit and Write; sed or script rewrites are invisible to it.',
	'- Wait for a long command by running it in the background and reading its output when you need it, not with sleep or until loops.',
	'- Check in proportion: the files you changed, and the tests or checks your brief names or that cover your change.',
].join('\n');

/** A shell command that prints the SubagentStart hook's answer: `printf` quoted for any POSIX shell (Claude Code runs hooks in bash, Git Bash on Windows). */
export function subagentStartHookCommand(context: string = CLAUDE_SUBAGENT_RULES): string {
	const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } });
	return `printf '%s' '${output.replace(/'/g, `'\\''`)}'`;
}

/**
 * Settings that make a Volt subagent's Claude Code session lean. Its brief and contract carry what
 * it needs, so it skips what only the user's own chats use:
 * - `autoMemoryEnabled: false`: the user's memory index (15 KB for a long-used project) is not
 *   loaded; Claude Code's own subagents do not get it either;
 * - `skillListingMaxDescChars`: skills stay listed and callable by name, with short descriptions;
 * - no `Agent` tool: a subagent splits work with Volt's delegate_task, which is depth-limited,
 *   budgeted and shown in Volt, so its own subagent listing is dropped from the prompt.
 *
 * Measured 2026-11-12 (Claude Code 2.1.280, Haiku 5.5, one-file read in the Volt checkout): the
 * first request went from 39.4k to 22.4k prompt tokens, $0.33 to $0.19.
 */
export const CLAUDE_SUBAGENT_SESSION_SETTINGS = {
	autoMemoryEnabled: false,
	skillListingMaxDescChars: 160,
} as const;

export const CLAUDE_SUBAGENT_DISALLOWED_TOOLS: readonly string[] = ['Agent'];

/**
 * Plan mode's workflow for a read-only subagent (research, review, or any task of an Ask chat). Claude
 * Code's default asks for a plan file and ExitPlanMode, which a report never needs; this is also
 * ~1.2k tokens shorter (measured 2026-11-12, same answer).
 */
export const CLAUDE_SUBAGENT_PLAN_MODE = 'This is a read-only task another agent delegated to you. Read and search what you need (batch independent reads), then give your answer as your final message. Do not write a plan file and do not call ExitPlanMode: your final message is the report. Volt\'s coordination tools (team_board, team_send, task_status, wait_tasks, delegate_task) change no files, so use them when your brief asks.';

/** A subagent's chat is named after its task by Volt, so Claude Code's own title request is skipped. */
export const CLAUDE_SUBAGENT_SESSION_TITLE = 'Volt subagent';

/**
 * `session/new` (and `session/resume`) `_meta` for a Claude Code session: the main agent's rules
 * appended to Claude Code's prompt, and a SubagentStart hook that hands every subagent its rules.
 * A Volt subagent's session (`subagent`) also starts lean (see {@link CLAUDE_SUBAGENT_SESSION_SETTINGS}).
 * Kept identical across sessions so a resumed session is not rebuilt for a changed fingerprint.
 */
export function claudeWorkRulesMeta(model?: string, opts?: { readonly subagent?: boolean }): Record<string, unknown> {
	return {
		systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_MAIN_RULES },
		claudeCode: {
			options: {
				// The exact model: the adapter's picker takes only its aliases (default, sonnet, haiku, ...).
				...(model ? { model } : {}),
				...(opts?.subagent ? { disallowedTools: [...CLAUDE_SUBAGENT_DISALLOWED_TOOLS], planModeInstructions: CLAUDE_SUBAGENT_PLAN_MODE, title: CLAUDE_SUBAGENT_SESSION_TITLE } : {}),
				settings: {
					...(opts?.subagent ? CLAUDE_SUBAGENT_SESSION_SETTINGS : {}),
					hooks: {
						SubagentStart: [{ hooks: [{ type: 'command', command: subagentStartHookCommand(), timeout: 10 }] }],
						Stop: [{ hooks: [{ type: 'command', command: stopHookCommand(), timeout: 10 }] }],
					},
				},
			},
		},
	};
}
