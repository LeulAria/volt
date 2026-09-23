/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { presentCall, presentResult, toolEndFromView, toolStartFromView } from '../../../common/deepseek/presentation.js';
import { IToolResult, IVoltTool } from '../../../common/tools/tool.js';

suite('DeepSeek tool presentation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shell, write, and edit declare terminal and diff cards', () => {
		const shell = presentCall(fake('shell', 'shell', 'execute'), { command: 'npm test', cwd: '/repo' });
		assert.strictEqual(shell.card, 'terminal');
		if (shell.card === 'terminal') {
			assert.strictEqual(shell.title, 'npm test');
			assert.strictEqual(shell.cwd, '/repo');
		}

		const write = presentCall(fake('write_file', 'edit', 'edit'), { path: 'a.ts', contents: 'export const a = 1\n' });
		assert.strictEqual(write.card, 'diff');
		if (write.card === 'diff') {
			assert.strictEqual(write.diffs[0].oldText, null);
			assert.strictEqual(write.diffs[0].newText, 'export const a = 1\n');
		}

		const edit = presentCall(fake('edit_file', 'edit', 'edit'), { path: 'a.ts', old_string: 'a', new_string: 'b' });
		assert.strictEqual(edit.card, 'diff');
		const start = toolStartFromView({ id: 'c', name: 'edit_file', args: {} }, fake('edit_file', 'edit', 'edit'), edit);
		assert.strictEqual(start.type, 'tool.start');
		if (start.type === 'tool.start') {
			assert.strictEqual(start.card, 'diff');
			assert.strictEqual(start.kind, 'edit');
		}
	});

	test('grep, glob, read, and web results keep their cards', () => {
		const grep = presentResult(fake('grep', 'search', 'search'), { pattern: 'kicks' }, result('grep', 'search', 'src/a.ts:3: kicks\nsrc/a.ts:9: more'));
		assert.strictEqual(grep.card, 'search');
		if (grep.card === 'search' && grep.shape === 'matches') {
			assert.strictEqual(grep.files[0].path, 'src/a.ts');
			assert.strictEqual(grep.files[0].matches.length, 2);
			assert.strictEqual(grep.total, 2);
		}
		const searchEnd = toolEndFromView(result('grep', 'search', 'src/a.ts:3: kicks\nsrc/a.ts:9: more'), grep);
		assert.strictEqual(searchEnd.type, 'tool.end');
		if (searchEnd.type === 'tool.end' && searchEnd.view?.card === 'search' && searchEnd.view.shape === 'matches') {
			assert.strictEqual(searchEnd.view.files[0].path, 'src/a.ts');
		}

		const glob = presentResult(fake('glob', 'search', 'search'), { pattern: '*.ts' }, result('glob', 'search', 'a.ts\nb.ts'));
		assert.strictEqual(glob.card, 'search');
		if (glob.card === 'search' && glob.shape === 'paths') {
			assert.deepStrictEqual(glob.paths, ['a.ts', 'b.ts']);
		}

		const read = presentResult(fake('read_file', 'read', 'read'), { path: 'a.ts' }, result('read_file', 'read', 'a.ts lines 1-1 of 1\n1 | hello'));
		assert.strictEqual(read.card, 'read');
		if (read.card === 'read') {
			assert.strictEqual(read.path, 'a.ts');
			assert.strictEqual(read.lines[0].text, 'hello');
			assert.strictEqual(read.totalLines, 1);
		}

		const search = presentResult(fake('web_search', 'web', 'fetch'), { query: 'Nissan Kicks' }, result('web_search', 'fetch', 'About 120000 AED\nhttps://example.com/kicks'));
		assert.strictEqual(search.card, 'web');
		if (search.card === 'web' && search.kind === 'search') {
			assert.strictEqual(search.sources[0].url, 'https://example.com/kicks');
		}

		const fetched = presentResult(fake('web_fetch', 'web', 'fetch'), { url: 'https://example.com' }, result('web_fetch', 'fetch', 'https://example.com\n\nbody'));
		assert.strictEqual(fetched.card, 'web');
		if (fetched.card === 'web' && fetched.kind === 'fetch') {
			assert.strictEqual(fetched.statusCode, 200);
		}

		const end = toolEndFromView(result('shell', 'execute', 'ok', false, 'c1'), { card: 'terminal', output: 'ok', exitCode: 0 });
		assert.strictEqual(end.type, 'tool.end');
		if (end.type === 'tool.end') {
			assert.strictEqual(end.card, 'terminal');
			assert.strictEqual(end.exitCode, 0);
			assert.strictEqual(end.output, 'ok');
		}
	});
});

function fake(name: string, group: IVoltTool['group'], kind: IVoltTool['kind']): IVoltTool {
	return {
		name,
		group,
		kind,
		description: name,
		schema: {},
		parallelSafe: true,
		snippet: name,
		execute: async () => result(name, kind, ''),
	};
}

function result(name: string, kind: IToolResult['kind'], text: string, isError = false, callId = 'c'): IToolResult {
	return { callId, name, kind, text, ...(isError ? { isError: true } : {}) };
}
