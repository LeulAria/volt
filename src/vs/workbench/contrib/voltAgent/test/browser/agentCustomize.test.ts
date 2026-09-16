/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeMarkdown, hookEventsFrom, mcpServersFrom, newItemLocation, parseFrontmatter, safeItemName } from '../../browser/agentCustomize.js';

suite('Agent customize parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses scalar front matter and strips it from the body', () => {
		const { data, body } = parseFrontmatter('---\nname: my-skill\ndescription: "Does things"\nglobs: *.ts\n---\n# Title\nBody');
		assert.deepStrictEqual(data, { name: 'my-skill', description: 'Does things', globs: '*.ts' });
		assert.strictEqual(body, '# Title\nBody');
	});

	test('tolerates missing or unterminated front matter', () => {
		assert.deepStrictEqual(parseFrontmatter('# Just markdown').data, {});
		assert.strictEqual(parseFrontmatter('---\nname: x\nno end').body, '---\nname: x\nno end');
	});

	test('describes markdown from front matter, else first prose line', () => {
		assert.deepStrictEqual(describeMarkdown('---\nname: a\ndescription: From meta\n---\n# H\nProse'), { name: 'a', description: 'From meta' });
		assert.deepStrictEqual(describeMarkdown('# Heading\n\n<!-- c -->\n**Bold** prose here.\nMore'), { name: undefined, description: 'Bold prose here.' });
		assert.deepStrictEqual(describeMarkdown('# Only heading', 'fallback'), { name: undefined, description: 'fallback' });
	});

	test('lists MCP servers with a command or url summary', () => {
		const servers = mcpServersFrom({
			mcpServers: {
				fs: { command: 'npx', args: ['-y', '@mcp/fs', 42] },
				remote: { url: 'https://mcp.example.com/sse' },
				bare: {},
			},
		});
		assert.deepStrictEqual(servers, [
			{ name: 'fs', description: 'npx -y @mcp/fs' },
			{ name: 'remote', description: 'https://mcp.example.com/sse' },
			{ name: 'bare', description: '' },
		]);
		assert.deepStrictEqual(mcpServersFrom({ servers: { a: { command: 'x' } } }).map(s => s.name), ['a']);
		assert.deepStrictEqual(mcpServersFrom(null), []);
		assert.deepStrictEqual(mcpServersFrom({ mcpServers: 'nope' }), []);
	});

	test('lists hook events that have handlers', () => {
		assert.deepStrictEqual(hookEventsFrom({ hooks: { beforeShellExecution: [{ command: 'x' }], afterFileEdit: [], other: { command: 'y' } } }), ['beforeShellExecution', 'other']);
		assert.deepStrictEqual(hookEventsFrom({}), []);
	});

	test('creates new items under .volt with safe names', () => {
		const base = URI.file('/repo');
		assert.strictEqual(newItemLocation('rule', 'code-style', base).path, '/repo/.volt/rules/code-style.md');
		assert.strictEqual(newItemLocation('skill', 'deploy', base).path, '/repo/.volt/skills/deploy/SKILL.md');
		assert.strictEqual(newItemLocation('mcp', '', base).path, '/repo/.volt/mcp.json');
		assert.strictEqual(newItemLocation('hook', '', base).path, '/repo/.volt/hooks.json');
		assert.strictEqual(safeItemName('  My Rule! v2 '), 'my-rule-v2');
		assert.strictEqual(safeItemName('***'), '');
	});
});
