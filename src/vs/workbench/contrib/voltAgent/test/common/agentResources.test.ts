/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyAgentResource, matchAgentResource, readFrontmatter, stripTomlComment, tomlTableKeys } from '../../common/agentResources.js';

function group(path: string, content?: string): string | undefined {
	return classifyAgentResource(path, content ?? 'x')?.group;
}

suite('agentResources', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('instruction files stay separate files with their own ecosystem', () => {
		assert.deepStrictEqual(
			['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md'].map(path => {
				const match = matchAgentResource(path)!;
				return [match.group, match.ecosystem];
			}),
			[['instructions', 'agents'], ['instructions', 'claude'], ['instructions', 'gemini'], ['instructions', 'cursor'], ['instructions', 'copilot']],
		);
	});

	test('scope: project at the root, nested under a folder, local for personal files', () => {
		assert.strictEqual(matchAgentResource('AGENTS.md')!.scope, 'project');
		assert.strictEqual(matchAgentResource('packages/api/AGENTS.md')!.scope, 'nested');
		assert.strictEqual(matchAgentResource('CLAUDE.local.md')!.scope, 'local');
		assert.strictEqual(matchAgentResource('.claude/settings.local.json')!.scope, 'local');
		assert.strictEqual(matchAgentResource('apps/web/.cursor/rules/style.mdc')!.scope, 'nested');
	});

	test('configuration files are not mixed with what they configure', () => {
		assert.strictEqual(group('.mcp.json', '{"mcpServers":{"a":{}}}'), 'integrations');
		assert.strictEqual(group('.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Reviews code\n---\n'), 'skills');
		assert.strictEqual(group('.claude/agents/planner.md', '---\nname: planner\ndescription: Plans\n---\n'), 'subagents');
		assert.strictEqual(group('.claude/commands/ship.md'), 'commands');
		assert.strictEqual(group('.cursor/hooks.json', '{"hooks":{"afterFileEdit":[]}}'), 'hooks');
		assert.strictEqual(group('.cursor/rules/style.mdc', '---\nalwaysApply: true\n---\n'), 'instructions');
		assert.strictEqual(group('.github/prompts/release.prompt.md'), 'commands');
		assert.strictEqual(group('.gemini/commands/review.toml', 'description = "Review"\nprompt = "x"'), 'commands');
	});

	test('a skill\'s other files are not listed, only SKILL.md', () => {
		assert.strictEqual(matchAgentResource('.claude/skills/review/reference.md'), undefined);
		assert.strictEqual(matchAgentResource('.claude/skills/review/scripts/run.sh'), undefined);
		assert.strictEqual(matchAgentResource('plugins/acme/skills/deploy/SKILL.md')!.ecosystem, 'agents');
	});

	test('settings files are grouped by what they configure', () => {
		assert.strictEqual(group('.claude/settings.json', '{"permissions":{}}'), 'config');
		assert.strictEqual(group('.claude/settings.json', '{"hooks":{"PostToolUse":[]}}'), 'hooks');
		assert.strictEqual(group('.gemini/settings.json', '{"mcpServers":{"gh":{}}}'), 'integrations');
		assert.strictEqual(group('.codex/config.toml', 'model = "gpt-5"'), 'config');
		const codex = classifyAgentResource('.codex/config.toml', '[mcp_servers.github]\ncommand = "x"\n[mcp_servers.linear]\nurl = "y"\n')!;
		assert.deepStrictEqual([codex.group, codex.description], ['integrations', '2 MCP servers']);
	});

	test('only each harness\'s own MCP key counts as servers', () => {
		// Gemini's `mcp` block is allow and deny lists.
		assert.strictEqual(group('.gemini/settings.json', '{"mcp":{"allowed":[],"excluded":[]}}'), 'config');
		const opencode = classifyAgentResource('opencode.json', '{"mcp":{"fs":{"type":"local","command":["fs-mcp"]}}}')!;
		assert.deepStrictEqual([opencode.group, opencode.description], ['integrations', '1 MCP server']);
		assert.strictEqual(classifyAgentResource('.vscode/mcp.json', '{"servers":{"a":{},"b":{}}}')!.description, '2 MCP servers');
	});

	test('Codex TOML: quoted table keys and trailing comments', () => {
		const codex = classifyAgentResource('.codex/config.toml', '[mcp_servers."a.b"] # dotted name\ncommand = "x"\n[mcp_servers.\'x\']\nurl = "y"\n[mcp_servers."a.b".env]\nK = "v"\n')!;
		assert.deepStrictEqual([codex.group, codex.description], ['integrations', '2 MCP servers']);
		assert.deepStrictEqual(tomlTableKeys('[mcp_servers."a.b"]'), ['mcp_servers', 'a.b']);
		assert.deepStrictEqual(tomlTableKeys('[[hooks.Stop]]'), undefined);
		assert.strictEqual(stripTomlComment('command = "npx # not a comment" # run it'), 'command = "npx # not a comment"');
	});

	test('a folder named like an object property is not a config folder', () => {
		assert.strictEqual(matchAgentResource('constructor/settings.json'), undefined);
		assert.strictEqual(matchAgentResource('toString/skills/x/SKILL.md')!.ecosystem, 'agents');
		assert.strictEqual(matchAgentResource('constructor/AGENTS.md')!.ecosystem, 'agents');
	});

	test('a CI workflow counts only when it runs an agent', () => {
		assert.strictEqual(classifyAgentResource('.github/workflows/ci.yml', 'name: CI\njobs:\n  test:\n    steps:\n      - run: npm test\n'), undefined);
		const claude = classifyAgentResource('.github/workflows/claude.yml', 'name: Claude Review\njobs:\n  r:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n')!;
		assert.deepStrictEqual([claude.group, claude.ecosystem, claude.description], ['hooks', 'claude', 'Claude Review']);
	});

	test('status flags what an agent cannot use', () => {
		assert.strictEqual(classifyAgentResource('AGENTS.md', '  \n')!.status.message, 'Empty file');
		assert.strictEqual(classifyAgentResource('.mcp.json', '{ nope')!.status.kind, 'error');
		assert.strictEqual(classifyAgentResource('.claude/skills/a/SKILL.md', '# A skill')!.status.kind, 'warning');
		assert.strictEqual(classifyAgentResource('.claude/skills/a/SKILL.md', '---\nname: a\ndescription: Does a\n---\nBody')!.status.kind, 'ok');
		assert.strictEqual(classifyAgentResource('.cursor/rules/x.mdc', '---\ndescription:\n---\nBody')!.status.kind, 'warning');
		assert.strictEqual(classifyAgentResource('.cursor/rules/x.mdc', '---\nglobs: src/**\n---\nBody')!.status.kind, 'ok');
	});

	test('unknown files are not resources', () => {
		assert.strictEqual(matchAgentResource('README.md'), undefined);
		assert.strictEqual(matchAgentResource('src/agents/planner.md'), undefined);
		assert.strictEqual(matchAgentResource('.claude/todos.json'), undefined);
	});

	test('front matter is read with quoted and folded values', () => {
		assert.deepStrictEqual(readFrontmatter('---\nName: "x"\ndescription: first\n  second\n---\nbody'), { name: 'x', description: 'first second' });
		assert.strictEqual(readFrontmatter('# no front matter'), undefined);
		assert.deepStrictEqual(readFrontmatter('---\ndescription: >\n  Folded\n  text\n---\n'), { description: 'Folded text' });
	});
});
