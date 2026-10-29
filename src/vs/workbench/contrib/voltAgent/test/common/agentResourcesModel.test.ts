/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentResourceScope, matchAgentResource } from '../../common/agentResources.js';
import { agentResourceReaders, IInstructionChainInput, instructionChains, parseHookEvents, parseMcpServers } from '../../common/agentResourcesModel.js';

function file(relativePath: string, scope: AgentResourceScope): IInstructionChainInput {
	const match = matchAgentResource(relativePath);
	return { group: match?.group ?? 'instructions', ecosystem: match?.ecosystem ?? 'agents', scope, relativePath };
}

suite('agentResourcesModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Claude Code reads AGENTS.md only without a CLAUDE.md', () => {
		const withClaude = instructionChains([file('CLAUDE.md', 'project'), file('AGENTS.md', 'project'), file('.claude/CLAUDE.md', 'global')]).find(chain => chain.ecosystem === 'claude')!;
		const project = withClaude.steps.find(step => step.id === 'project')!;
		assert.deepStrictEqual([project.items.map(item => item.relativePath), project.skipped.map(item => item.relativePath)], [['CLAUDE.md'], ['AGENTS.md']]);
		assert.deepStrictEqual(withClaude.steps.find(step => step.id === 'global')!.items.map(item => item.relativePath), ['.claude/CLAUDE.md']);

		const agentsOnly = instructionChains([file('AGENTS.md', 'project')]).find(chain => chain.ecosystem === 'claude')!;
		assert.deepStrictEqual(agentsOnly.steps.find(step => step.id === 'project')!.items.map(item => item.relativePath), ['AGENTS.md']);
	});

	test('Codex takes AGENTS.override.md over AGENTS.md in the same folder', () => {
		const codex = instructionChains([file('AGENTS.md', 'project'), file('AGENTS.override.md', 'project')]).find(chain => chain.ecosystem === 'codex')!;
		const project = codex.steps.find(step => step.id === 'project')!;
		assert.deepStrictEqual([project.items.map(item => item.relativePath), project.skipped.map(item => item.relativePath)], [['AGENTS.override.md'], ['AGENTS.md']]);
	});

	test('a missing step offers the file to create', () => {
		const gemini = instructionChains([]).find(chain => chain.ecosystem === 'gemini')!;
		assert.deepStrictEqual(gemini.steps.map(step => step.create), [{ scope: 'global', path: '.gemini/GEMINI.md' }, { scope: 'workspace', path: 'GEMINI.md' }, undefined]);
	});

	test('MCP servers keep variable names, never values', () => {
		const servers = parseMcpServers('.mcp.json', JSON.stringify({
			mcpServers: {
				github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'ghp_secret' } },
				linear: { url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer ${LINEAR_KEY}' } },
			},
		}));
		assert.deepStrictEqual(servers.map(server => [server.name, server.transport, server.target, server.envRefs, server.hasHeaders]), [
			['github', 'stdio', 'npx -y gh-mcp', ['GITHUB_TOKEN'], false],
			['linear', 'http', 'mcp.linear.app', ['LINEAR_KEY'], true],
		]);
		assert.ok(!JSON.stringify(servers).includes('ghp_secret'));
	});

	test('MCP servers from VS Code, Codex TOML and ~/.claude.json projects', () => {
		assert.deepStrictEqual(parseMcpServers('.vscode/mcp.json', '{ // comment\n "servers": { "fs": { "command": "fs-mcp" } } }').map(server => server.name), ['fs']);
		const toml = parseMcpServers('.codex/config.toml', '[mcp_servers.docs]\ncommand = "docs-mcp"\nenabled = false\n\n[mcp_servers.docs.env]\nAPI_KEY = "x"\n');
		assert.deepStrictEqual(toml.map(server => [server.name, server.transport, server.disabled, server.envRefs]), [['docs', 'stdio', true, ['API_KEY']]]);
		const claudeJson = JSON.stringify({ mcpServers: { a: { command: 'a' } }, projects: { '/repo': { mcpServers: { b: { command: 'b' } } }, '/other': { mcpServers: { c: {} } } } });
		assert.deepStrictEqual(parseMcpServers('.claude.json', claudeJson, '/repo').map(server => server.name), ['a', 'b']);
	});

	test('hook events from settings and hooks files', () => {
		assert.deepStrictEqual(parseHookEvents('.claude/settings.json', '{"hooks":{"PreToolUse":[],"Stop":[]}}'), ['PreToolUse', 'Stop']);
		assert.deepStrictEqual(parseHookEvents('.codex/config.toml', '[[hooks.PreToolUse]]\ncommand = "x"\n'), ['PreToolUse']);
	});

	test('who reads a skill, an agent and an MCP file', () => {
		const readers = (path: string, scope: AgentResourceScope = 'project') => agentResourceReaders(file(path, scope));
		assert.deepStrictEqual(readers('.agents/skills/x/SKILL.md'), ['codex', 'gemini', 'cursor', 'copilot', 'volt']);
		assert.deepStrictEqual(readers('.gemini/skills/x/SKILL.md'), ['gemini']);
		assert.deepStrictEqual(readers('.claude/agents/planner.md'), ['claude', 'cursor', 'copilot', 'volt']);
		assert.ok(readers('.mcp.json')!.includes('volt'));
		// ~/.claude.json is classified by the service (it is not a project file), so it is built by hand.
		assert.deepStrictEqual(agentResourceReaders({ group: 'integrations', ecosystem: 'claude', scope: 'global', relativePath: '.claude.json' }), ['claude']);
	});

	test('home and Copilot files the docs list', () => {
		const group = (path: string) => matchAgentResource(path)?.group;
		assert.deepStrictEqual(
			['.gemini/GEMINI.md', '.codex/AGENTS.override.md', '.copilot/mcp-config.json', '.copilot/instructions/style.instructions.md', '.codex/rules/default.rules', '.github/hooks/lint.json', '.gemini/extensions/acme/gemini-extension.json', '.github/skills/review/SKILL.md'].map(group),
			['instructions', 'instructions', 'integrations', 'instructions', 'config', 'hooks', 'integrations', 'skills'],
		);
		assert.strictEqual(matchAgentResource('.github/skills/review/SKILL.md')!.ecosystem, 'copilot');
	});
});
