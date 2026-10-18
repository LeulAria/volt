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
].join('\n');

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
 * `session/new` (and `session/resume`) `_meta` for a Claude Code session: the main agent's rules
 * appended to Claude Code's prompt, and a SubagentStart hook that hands every subagent its rules.
 * Kept identical across sessions so a resumed session is not rebuilt for a changed fingerprint.
 */
export function claudeWorkRulesMeta(): Record<string, unknown> {
	return {
		systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_MAIN_RULES },
		claudeCode: {
			options: {
				settings: {
					hooks: {
						SubagentStart: [{ hooks: [{ type: 'command', command: subagentStartHookCommand(), timeout: 10 }] }],
					},
				},
			},
		},
	};
}
