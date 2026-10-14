/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FFF_VERSION, fffAsset, parseFffFindFiles, parseFffVersion } from '../../common/fff.js';

suite('Volt code index: FFF', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('find_files output: hint, count, annotated paths and cursor', () => {
		const text = [
			'\u2192 Read src/a.ts (exact match!)',
			'3/2870 matches',
			'src/a.ts - hot git:modified',
			'src/My Folder/b.ts git:untracked',
			'lib/c.ts - frequent',
			'cursor: 1',
		].join('\n');
		assert.deepStrictEqual(parseFffFindFiles(text), { paths: ['src/a.ts', 'src/My Folder/b.ts', 'lib/c.ts'], total: 2870 });
	});

	test('find_files output: every match listed, no count', () => {
		assert.deepStrictEqual(parseFffFindFiles('src/a.ts\r\nsrc/b.ts\r\n'), { paths: ['src/a.ts', 'src/b.ts'] });
	});

	test('find_files output: no results', () => {
		assert.deepStrictEqual(parseFffFindFiles('0 results (10270 indexed)'), { paths: [], total: 0 });
		assert.deepStrictEqual(parseFffFindFiles(''), { paths: [] });
	});

	test('version output', () => {
		assert.strictEqual(parseFffVersion('fff-mcp 0.11.0 (95fd777c2529fc7b4d7572dabff64cc07268f2c5)\n'), '0.11.0');
		assert.strictEqual(parseFffVersion('command not found'), undefined);
	});

	test('release assets are pinned per platform and missing where FFF ships none', () => {
		const mac = fffAsset('darwin', 'arm64');
		assert.strictEqual(mac?.name, 'fff-mcp-aarch64-apple-darwin');
		assert.strictEqual(mac?.url, `https://github.com/dmtrKovalenko/fff/releases/download/v${FFF_VERSION}/fff-mcp-aarch64-apple-darwin`);
		assert.match(mac?.sha256 ?? '', /^[0-9a-f]{64}$/);
		assert.strictEqual(fffAsset('linux', 'x64', true)?.name, 'fff-mcp-x86_64-unknown-linux-musl');
		assert.strictEqual(fffAsset('win32', 'x64')?.name, 'fff-mcp-x86_64-pc-windows-msvc.exe');
		assert.strictEqual(fffAsset('linux', 'ia32'), undefined);
		assert.strictEqual(fffAsset('freebsd', 'x64'), undefined);
	});
});
