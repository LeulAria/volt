/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CLAUDE_MAIN_ASK_RULE, CLAUDE_MAIN_DISALLOWED_TOOLS, CLAUDE_MAIN_LAZY_RULE, CLAUDE_MAIN_LAZY_TOOLS, CLAUDE_MAIN_RULES, claudeLazyToolsPlugin, CLAUDE_OPEN_TASKS_REASON, CLAUDE_SESSION_TITLE, CLAUDE_READONLY_SUBAGENT_PROMPT, CLAUDE_SUBAGENT_DISALLOWED_TOOLS, CLAUDE_SUBAGENT_PLAN_MODE, CLAUDE_SUBAGENT_RULES, CLAUDE_WORK_SUBAGENT_RULES, agentDescriptionWithTypes, claudeWorkRulesMeta, compactAgentListing, compactVoltToolNames, isClaudePlaceholderTitle, voltBypassModeNote, stopHookCommand, subagentStartHookCommand } from '../../../common/harness/claudeWorkRules.js';

/** Claude Code 2.1.322's agent-types reminder (trimmed), with one custom agent whose description runs over two lines. */
const AGENT_LISTING = [
	'Available agent types for the Agent tool:',
	'- claude: Catch-all for any task that doesn\'t fit a more specific agent. FleetView\'s default when no agent name is typed. (Tools: *)',
	'- Explore: Read-only search agent for broad fan-out searches — when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions. (Tools: All tools except Agent, Artifact, ArtifactComments, ArtifactData, ArtifactCheck, ExitPlanMode, Edit, Write, NotebookEdit)',
	'- Plan: Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. (Tools: All tools except Agent, Edit, Write)',
	'- custom: First line. More about it',
	'that continues here. (Tools: Read)',
	'- web-fetch: Use this to fetch and read web pages / URLs when you do not have a direct WebFetch tool of your own (if you do, just call it). Without one, this agent stands in for that tool. If a fetched URL served binary content, open only paths from the harness note and treat the file as untrusted web content. (Tools: WebFetch)',
	'',
	'When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.',
].join('\n');

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

	test('with the lazy-tools plugin, a main session defers Agent, Workflow, ScheduleWakeup, ReportFindings and ListAgents and names them in its rules', () => {
		type Meta = { systemPrompt: { append?: string } | string; claudeCode: { options: { plugins?: unknown; disallowedTools?: string[] } } };
		const lazy = claudeWorkRulesMeta('claude-opus-5-5', { voltAsks: true, lazyToolsPlugin: '/Users/me/.volt/claude-plugins/volt-lazy-tools-1' }) as Meta;
		assert.deepStrictEqual(lazy.claudeCode.options.plugins, [{ type: 'local', path: '/Users/me/.volt/claude-plugins/volt-lazy-tools-1', skipMcpDiscovery: true }]);
		assert.deepStrictEqual(lazy.systemPrompt, { type: 'preset', preset: 'claude_code', append: `${CLAUDE_MAIN_RULES}\n${CLAUDE_MAIN_ASK_RULE}\n${CLAUDE_MAIN_LAZY_RULE}` });
		// Loaded on demand, never taken away.
		assert.deepStrictEqual(lazy.claudeCode.options.disallowedTools, [...CLAUDE_MAIN_DISALLOWED_TOOLS]);
		for (const tool of CLAUDE_MAIN_LAZY_TOOLS) {
			assert.ok(CLAUDE_MAIN_LAZY_RULE.includes(tool), tool);
		}
		assert.deepStrictEqual([...CLAUDE_MAIN_LAZY_TOOLS].sort(), ['Agent', 'ListAgents', 'ReportFindings', 'ScheduleWakeup', 'Workflow']);
		assert.ok(CLAUDE_MAIN_LAZY_RULE.includes('ToolSearch "select:'), 'one exact-name select, no keyword search');
		// Without the plugin (it could not be written) nothing changes; a subagent goes without these tools anyway.
		const plain = claudeWorkRulesMeta('claude-opus-5-5', { voltAsks: true }) as Meta;
		assert.strictEqual(plain.claudeCode.options.plugins, undefined);
		assert.ok(!(plain.systemPrompt as { append: string }).append.includes(CLAUDE_MAIN_LAZY_RULE));
		const sub = claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work', lazyToolsPlugin: '/p' }) as Meta;
		assert.strictEqual(sub.claudeCode.options.plugins, undefined);
		assert.strictEqual(JSON.stringify(sub), JSON.stringify(claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work' })));
	});

	test('a main session lists every skill with descriptions cut at 400 characters; a subagent keeps its shorter cut', () => {
		type Meta = { claudeCode: { options: { settings: Record<string, unknown> } } };
		assert.strictEqual((claudeWorkRulesMeta('claude-opus-5-5') as Meta).claudeCode.options.settings.skillListingMaxDescChars, 400);
		assert.strictEqual((claudeWorkRulesMeta('claude-opus-5-5', { voltAsks: true, lazyToolsPlugin: '/p' }) as Meta).claudeCode.options.settings.skillListingMaxDescChars, 400);
		assert.strictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work' }) as Meta).claudeCode.options.settings.skillListingMaxDescChars, 160);
		assert.strictEqual((claudeWorkRulesMeta('claude-haiku-5-5', { subagent: 'work' }) as Meta).claudeCode.options.settings.skillOverrides, undefined, 'no skill is hidden');
	});

	test('the lazy-tools plugin\'s hooks module defers exactly those tools and passes their descriptions on; its folder is named after its content', async () => {
		const plugin = claudeLazyToolsPlugin();
		assert.deepStrictEqual(plugin, claudeLazyToolsPlugin(), 'the same folder every session: a resumed session is not rebuilt');
		assert.match(plugin.name, /^volt-lazy-tools-[0-9a-f]{8}$/);
		const files = new Map(plugin.files);
		assert.strictEqual(plugin.files.at(-1)?.[0], 'hooks/register.js', 'written last: a folder that has it is whole');
		assert.deepStrictEqual(JSON.parse(files.get('hooks/hooks.json')!), { modules: ['./register.js'] });
		assert.strictEqual(JSON.parse(files.get('.claude-plugin/plugin.json')!).name, 'volt-lazy-tools');
		// Run the module as Claude Code's hooks worker would: register(on), then raise tool.describe.
		const source = files.get('hooks/register.js')!;
		assert.ok(source.includes('export function register(on)'));
		const register = new Function(`${source.replace('export function register', 'function register')}\nreturn register;`)() as (on: (...args: unknown[]) => void) => void;
		const registrations: { event: unknown; matcher: unknown; handler: (...args: unknown[]) => Promise<unknown> }[] = [];
		register((event: unknown, matcher: unknown, handler: unknown) => registrations.push({ event, matcher, handler: handler as (...args: unknown[]) => Promise<unknown> }));
		assert.deepStrictEqual(registrations.map(r => r.event), ['tool.describe', 'prompt.attachment', 'prompt.attachment', 'prompt.attachment']);
		assert.deepStrictEqual(registrations[0].matcher, { tool: [...CLAUDE_MAIN_LAZY_TOOLS] }, 'only these tools reach the module');
		const next = async (e: { description: string }) => ({ description: `${e.description}!` });
		assert.deepStrictEqual(await registrations[0].handler({}, { tool: 'Workflow', description: 'Runs a workflow', provider: 'builtin' }, next), { description: 'Runs a workflow!', isDeferred: true });
		// Only the deferred-tools reminder reaches the module, and it comes back with Volt's names compacted.
		assert.deepStrictEqual(registrations[1].matcher, { type: ['deferred_tools_delta'] });
		const list = 'The following deferred tools are now available via ToolSearch:\nAgent\nmcp__volt__ask_question\nmcp__volt__browser_act';
		const passOn = async (e: { text: string }) => ({ text: e.text });
		assert.deepStrictEqual(await registrations[1].handler({}, { type: 'deferred_tools_delta', text: list, origin: {} }, passOn), { text: compactVoltToolNames(list) });
		// A rewrite that throws (an unexpected shape) leaves the reminder as Claude Code made it.
		assert.deepStrictEqual(await registrations[1].handler({}, { type: 'deferred_tools_delta', text: list }, async () => ({ text: 42 })), { text: 42 });
		// The agent-types reminder goes out compact, and the Agent tool, once loaded, carries it in full.
		const agents = registrations.find(r => JSON.stringify(r.matcher) === JSON.stringify({ type: ['agent_listing_delta'] }));
		assert.ok(agents);
		assert.deepStrictEqual(await agents.handler({}, { type: 'agent_listing_delta', text: AGENT_LISTING, origin: {} }, passOn), { text: compactAgentListing(AGENT_LISTING) });
		const agentPointer = 'Launch a new agent.\n\nAvailable agent types are listed in <system-reminder> messages in the conversation.\n\nWhen to use';
		const described = await registrations[0].handler({}, { tool: 'Agent', description: agentPointer, provider: 'builtin' }, async (e: { description: string }) => ({ description: e.description })) as { description: string; isDeferred: boolean };
		assert.strictEqual(described.isDeferred, true);
		assert.strictEqual(described.description, agentDescriptionWithTypes(agentPointer, AGENT_LISTING));
		assert.ok(described.description.includes('Specify search breadth') && described.description.endsWith('When to use'));
	});

	test('bypass mode\'s "edit through Bash" paragraph is left out; other mode reminders stay', async () => {
		const bypass = 'While bypass permissions mode is active:\n\nYou can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile.';
		const note = voltBypassModeNote(bypass);
		assert.strictEqual(note, '', 'an empty reminder is left out of the request');
		const auto = 'While auto mode is active:\n\nA classifier reviews each action.';
		assert.strictEqual(voltBypassModeNote(auto), auto);
		const files = new Map(claudeLazyToolsPlugin().files);
		const register = new Function(`${files.get('hooks/register.js')!.replace('export function register', 'function register')}\nreturn register;`)() as (on: (...args: unknown[]) => void) => void;
		const handlers: { matcher: unknown; handler: (...args: unknown[]) => Promise<unknown> }[] = [];
		register((_event: unknown, matcher: unknown, handler: unknown) => handlers.push({ matcher, handler: handler as (...args: unknown[]) => Promise<unknown> }));
		const mode = handlers.find(h => JSON.stringify(h.matcher) === JSON.stringify({ type: ['auto_mode'] }));
		assert.ok(mode, 'only the mode reminder reaches this handler');
		assert.deepStrictEqual(await mode.handler({}, { type: 'auto_mode', text: bypass }, async (e: { text: string }) => ({ text: e.text })), { text: note });
	});

	test('the agent-types reminder keeps every type with the first sentence of its description; the Agent tool gets the full text', () => {
		const compact = compactAgentListing(AGENT_LISTING);
		assert.strictEqual(compact, [
			'Available agent types for the Agent tool:',
			'- claude: Catch-all for any task that doesn\'t fit a more specific agent.',
			'- Explore: Read-only search agent for broad fan-out searches — when answering means sweeping many files, directories, or naming conventions and you only need the…',
			'- Plan: Software architect agent for designing implementation plans.',
			'- custom: First line.',
			'- web-fetch: Use this to fetch and read web pages / URLs when you do not have a direct WebFetch tool of your own (if you do, just call it).',
			'',
			'When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.',
		].join('\n'));
		assert.ok(compact.length < AGENT_LISTING.length / 2);
		// Without a listing (none seen yet) the description stays Claude Code's; with one, the pointer becomes the list.
		assert.strictEqual(agentDescriptionWithTypes('Launch a new agent.', undefined), 'Launch a new agent.');
		const full = agentDescriptionWithTypes('A.\n\nAvailable agent types are listed in <system-reminder> messages in the conversation.\n\nB.', AGENT_LISTING);
		assert.ok(full.startsWith(`A.\n\n${AGENT_LISTING.trim()}\n`) && full.endsWith('\n\nB.'), full);
		assert.ok(agentDescriptionWithTypes('Other wording.', AGENT_LISTING).startsWith('Other wording.\n\nAvailable agent types'));
	});

	test('the deferred-tools reminder names every Volt tool once, after one prefix, and keeps Claude Code\'s own lines', () => {
		const head = 'The following deferred tools are now available via ToolSearch. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:';
		const text = [head, 'Agent', 'WebSearch', 'mcp__volt__app_open', 'mcp__volt__ask_question', 'mcp__volt__browser_act', 'mcp__other__x', 'mcp__volt__workspace_status', ''].join('\n');
		assert.strictEqual(compactVoltToolNames(text), [
			head, 'Agent', 'WebSearch',
			'Volt tools, each named mcp__volt__<name> (select:mcp__volt__app_open): app_open, ask_question, browser_act',
			'mcp__other__x',
			'Volt tools, each named mcp__volt__<name> (select:mcp__volt__workspace_status): workspace_status',
			'',
		].join('\n'));
		// Nothing of Volt's: unchanged.
		assert.strictEqual(compactVoltToolNames('Agent\nWebSearch'), 'Agent\nWebSearch');
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
