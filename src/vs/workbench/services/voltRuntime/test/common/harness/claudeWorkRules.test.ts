/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CLAUDE_MAIN_RULES, CLAUDE_OPEN_TASKS_REASON, CLAUDE_SUBAGENT_PLAN_MODE, CLAUDE_SUBAGENT_RULES, claudeWorkRulesMeta, stopHookCommand, subagentStartHookCommand } from '../../../common/harness/claudeWorkRules.js';

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

	test('a subagent session starts lean: no memory index, short skill descriptions, no Agent tool; the main session keeps them', () => {
		type Meta = { claudeCode: { options: { disallowedTools?: string[]; settings: { autoMemoryEnabled?: boolean; skillListingMaxDescChars?: number; hooks: { Stop: unknown[] } } } } };
		const main = claudeWorkRulesMeta('claude-haiku-5-5') as Meta;
		const lean = claudeWorkRulesMeta('claude-haiku-5-5', { subagent: true }) as Meta;
		assert.strictEqual(main.claudeCode.options.disallowedTools, undefined);
		assert.strictEqual(main.claudeCode.options.settings.autoMemoryEnabled, undefined);
		assert.deepStrictEqual(lean.claudeCode.options.disallowedTools, ['Agent']);
		assert.strictEqual((lean.claudeCode.options as { planModeInstructions?: string }).planModeInstructions, CLAUDE_SUBAGENT_PLAN_MODE);
		assert.strictEqual((lean.claudeCode.options as { title?: string }).title, 'Volt subagent');
		assert.strictEqual((main.claudeCode.options as { title?: string }).title, undefined);
		assert.strictEqual(lean.claudeCode.options.settings.autoMemoryEnabled, false);
		assert.strictEqual(lean.claudeCode.options.settings.skillListingMaxDescChars, 160);
		// The hooks (work rules, open tasks) apply to subagents too.
		assert.strictEqual(lean.claudeCode.options.settings.hooks.Stop.length, 1);
		assert.strictEqual(JSON.stringify(claudeWorkRulesMeta('claude-haiku-5-5', { subagent: false })), JSON.stringify(main));
	});
});
