/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CLAUDE_MAIN_ASK_RULE, CLAUDE_MAIN_DISALLOWED_TOOLS, CLAUDE_MAIN_RULES, CLAUDE_OPEN_TASKS_REASON, CLAUDE_SESSION_TITLE, CLAUDE_READONLY_SUBAGENT_PROMPT, CLAUDE_SUBAGENT_DISALLOWED_TOOLS, CLAUDE_SUBAGENT_PLAN_MODE, CLAUDE_SUBAGENT_RULES, CLAUDE_WORK_SUBAGENT_RULES, claudeWorkRulesMeta, isClaudePlaceholderTitle, stopHookCommand, subagentStartHookCommand } from '../../../common/harness/claudeWorkRules.js';

/** What a POSIX shell passes to printf for `printf '%s' '<quoted>'`: single quotes, with `'\''` for a quote inside. */
function shellArgument(command: string): string {
	const match = /^printf '%s' '([\s\S]*)'$/.exec(command);
	assert.ok(match, command);
	return match[1].replace(/'\\''/g, '\'');
}

suite('Volt Claude work rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the SubagentStart hook prints the subagent rules as its additional context', () => {
		const output = JSON.parse(shellArgument(subagentStartHookCommand()));
		assert.deepStrictEqual(output, { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_SUBAGENT_RULES } });
	});

	test('quotes in the context survive the shell', () => {
		const context = 'it\'s "quoted" \\ and $HOME `x`';
		assert.strictEqual(JSON.parse(shellArgument(subagentStartHookCommand(context))).hookSpecificOutput.additionalContext, context);
	});

	test('the Stop hook keeps the turn going once while the task list has open tasks', () => {
		const stop = stopHookCommand();
		assert.ok(stop.includes('stop_hook_active'), 'the second stop always ends the turn');
		assert.ok(stop.includes('/tasks/$sid/'));
		const reply = /printf '%s' '([\s\S]*)'$/.exec(stop);
		assert.ok(reply);
		assert.deepStrictEqual(JSON.parse(reply[1].replace(/'\\''/g, '\'')), { decision: 'block', reason: CLAUDE_OPEN_TASKS_REASON });
	});

	test('session meta appends the main rules to Claude Code\'s prompt and installs the hook, the same every time', () => {
		const meta = claudeWorkRulesMeta() as { systemPrompt: unknown; claudeCode: { options: { settings: { hooks: { SubagentStart: { hooks: { type: string; command: string }[] }[] } } } } };
		assert.deepStrictEqual(meta.systemPrompt, { type: 'preset', preset: 'claude_code', append: CLAUDE_MAIN_RULES });
		const hook = meta.claudeCode.options.settings.hooks.SubagentStart[0].hooks[0];
		assert.strictEqual(hook.type, 'command');
		assert.strictEqual(hook.command, subagentStartHookCommand());
		// A resumed session compares this against the one it was created with.
		assert.strictEqual(JSON.stringify(claudeWorkRulesMeta()), JSON.stringify(meta));
	});

	test('a subagent session starts lean: no memory index, connectors, skill sync or git workflow, short skill descriptions, no Agent tool; the main session keeps them', () => {
		type Options = { disallowedTools?: string[]; strictMcpConfig?: boolean; planModeInstructions?: string; title?: string; settings: Record<string, unknown> & { hooks: { Stop: unknown[] } } };
		type Meta = { systemPrompt: unknown; claudeCode: { options: Options } };
		const main = claudeWorkRulesMeta('claude-haiku-5-5') as Meta;
		const lean = claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work' }) as Meta;
		assert.strictEqual(main.claudeCode.options.disallowedTools, undefined);
		assert.strictEqual(main.claudeCode.options.settings.autoMemoryEnabled, undefined);
		assert.strictEqual(main.claudeCode.options.settings.disableClaudeAiConnectors, undefined);
		assert.strictEqual(main.claudeCode.options.title, CLAUDE_SESSION_TITLE, 'Volt names the chat: no title call of Claude Code\'s own');
		assert.deepStrictEqual(lean.claudeCode.options.disallowedTools, [...CLAUDE_SUBAGENT_DISALLOWED_TOOLS]);
		for (const tool of ['Agent', 'AskUserQuestion', 'Workflow', 'ScheduleWakeup']) {
			assert.ok(lean.claudeCode.options.disallowedTools?.includes(tool), tool);
		}
		assert.ok(!lean.claudeCode.options.disallowedTools?.includes('Edit'), 'a working subagent edits');
		assert.strictEqual(lean.claudeCode.options.strictMcpConfig, undefined, 'a working subagent keeps the user\'s own MCP servers');
		assert.deepStrictEqual(lean.systemPrompt, { type: 'preset', preset: 'claude_code', append: CLAUDE_WORK_SUBAGENT_RULES });
		assert.strictEqual(lean.claudeCode.options.planModeInstructions, CLAUDE_SUBAGENT_PLAN_MODE);
		assert.strictEqual(lean.claudeCode.options.title, 'Volt subagent');
		const settings = lean.claudeCode.options.settings;
		assert.deepStrictEqual([settings.autoMemoryEnabled, settings.skillListingMaxDescChars, settings.disableClaudeAiConnectors, settings.syncClaudeAiSkills, settings.syncClaudeAiPlugins, settings.includeGitInstructions], [false, 160, true, false, false, false]);
		// The hooks (work rules, open tasks) apply to subagents too.
		assert.strictEqual(settings.hooks.Stop.length, 1);
		assert.strictEqual(JSON.stringify(claudeWorkRulesMeta('claude-haiku-5-5', { subagent: false })), JSON.stringify(main));
		// `true` (an older build, or a caller without a role) is a working subagent.
		assert.strictEqual(JSON.stringify(claudeWorkRulesMeta('claude-haiku-5-5', { subagent: true })), JSON.stringify(lean));
	});

	test('a main session with Volt\'s ask_question goes without AskUserQuestion; without it, it keeps it', () => {
		type Meta = { claudeCode: { options: { disallowedTools?: string[] } } };
		const asks = claudeWorkRulesMeta('claude-haiku-5-5', { voltAsks: true }) as Meta;
		assert.deepStrictEqual(asks.claudeCode.options.disallowedTools, [...CLAUDE_MAIN_DISALLOWED_TOOLS]);
		assert.ok(CLAUDE_MAIN_DISALLOWED_TOOLS.includes('AskUserQuestion'));
		assert.strictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { voltAsks: false }) as Meta).claudeCode.options.disallowedTools, undefined);
		// A subagent's own list wins either way.
		assert.deepStrictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work', voltAsks: true }) as Meta).claudeCode.options.disallowedTools, [...CLAUDE_SUBAGENT_DISALLOWED_TOOLS]);
	});

	test('without AskUserQuestion the main rules say how to ask through ask_question', () => {
		type Meta = { systemPrompt: { append: string } };
		assert.deepStrictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { voltAsks: true }) as Meta).systemPrompt.append, `${CLAUDE_MAIN_RULES}\n${CLAUDE_MAIN_ASK_RULE}`);
		assert.ok(CLAUDE_MAIN_ASK_RULE.includes('select:mcp__volt__ask_question'));
		assert.strictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { voltAsks: false }) as Meta).systemPrompt.append, CLAUDE_MAIN_RULES);
		assert.strictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work', voltAsks: true }) as Meta).systemPrompt.append, CLAUDE_WORK_SUBAGENT_RULES);
	});

	test('every session skips Claude Code\'s own title and next-prompt calls, which Volt never shows', () => {
		type Meta = { claudeCode: { options: { promptSuggestions?: boolean; title?: string } } };
		for (const subagent of [false, 'work', 'readonly'] as const) {
			const options = (claudeWorkRulesMeta('claude-haiku-5-5', { subagent }) as Meta).claudeCode.options;
			assert.strictEqual(options.promptSuggestions, false, String(subagent));
			assert.ok(options.title && isClaudePlaceholderTitle(options.title), String(subagent));
		}
		assert.ok(!isClaudePlaceholderTitle('Fix sidebar list jumping to top'));
	});

	test('a read-only subagent runs on its own short prompt, with no file tools and only Volt\'s MCP server', () => {
		type Meta = { systemPrompt: unknown; claudeCode: { options: { disallowedTools?: string[]; strictMcpConfig?: boolean; settings: Record<string, unknown> } } };
		const meta = claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'readonly' }) as Meta;
		assert.strictEqual(meta.systemPrompt, CLAUDE_READONLY_SUBAGENT_PROMPT);
		assert.ok(CLAUDE_READONLY_SUBAGENT_PROMPT.length < 3000, 'a fraction of Claude Code\'s ~4.9k-token prompt');
		assert.ok(/report/i.test(CLAUDE_READONLY_SUBAGENT_PROMPT) && /Change nothing/.test(CLAUDE_READONLY_SUBAGENT_PROMPT));
		for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Agent']) {
			assert.ok(meta.claudeCode.options.disallowedTools?.includes(tool), tool);
		}
		assert.strictEqual(meta.claudeCode.options.strictMcpConfig, true);
		assert.strictEqual(meta.claudeCode.options.settings.includeGitInstructions, false);
	});
});
