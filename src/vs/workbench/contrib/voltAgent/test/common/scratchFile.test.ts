/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseIndex } from '../../common/scratchBoard/scratchDocument.js';
import { parseScratchFile, scratchAssetIds, serializeScratchFile } from '../../common/scratchBoard/scratchFile.js';
import { isUntitledBoardTitle } from '../../common/scratchBoard/scratchIndex.js';

suite('Scratch board files', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a board file round-trips, images included, as tab-indented JSON', () => {
		const elements = [{ id: 'a', type: 'image', assetId: 'abc.png', mime: 'image/png' }, { id: 'b', type: 'text', text: 'Hello' }];
		const text = serializeScratchFile({ title: 'Plan', elements, settings: { grid: 'dots' }, assets: { 'abc.png': { mime: 'image/png', data: 'AAAA' } } });
		assert.ok(text.startsWith('{\n\t"type": "volt-scratch"'));
		assert.ok(text.endsWith('\n'));
		const parsed = parseScratchFile(text)!;
		assert.strictEqual(parsed.title, 'Plan');
		assert.deepStrictEqual(parsed.elements, elements);
		assert.deepStrictEqual(parsed.settings, { grid: 'dots' });
		assert.deepStrictEqual(parsed.assets, { 'abc.png': { mime: 'image/png', data: 'AAAA' } });
		assert.deepStrictEqual(scratchAssetIds(parsed.elements), ['abc.png']);
	});

	test('the older Save Board File export still opens; other files do not', () => {
		const old = parseScratchFile(JSON.stringify({ type: 'volt-scratch', version: 1, title: 'Old', elements: [], settings: {} }));
		assert.deepStrictEqual(old, { title: 'Old', elements: [], settings: {}, assets: {} });
		assert.strictEqual(parseScratchFile('not json'), undefined);
		assert.strictEqual(parseScratchFile(JSON.stringify({ type: 'excalidraw', elements: [] })), undefined);
		assert.strictEqual(parseScratchFile(JSON.stringify({ type: 'volt-scratch', version: 2, elements: [] })), undefined);
		assert.strictEqual(parseScratchFile(JSON.stringify([])), undefined);
	});

	test('asset ids that could escape the assets folder are dropped', () => {
		const parsed = parseScratchFile(JSON.stringify({ type: 'volt-scratch', version: 1, elements: [], assets: { '../x.png': { mime: 'image/png', data: 'AA' }, 'ok.png': { mime: 'image/png', data: 'AA' } } }))!;
		assert.deepStrictEqual(Object.keys(parsed.assets), ['ok.png']);
	});

	test('only default names count as untitled', () => {
		assert.ok(isUntitledBoardTitle(''));
		assert.ok(isUntitledBoardTitle('Untitled board'));
		assert.ok(isUntitledBoardTitle('untitled board 12'));
		assert.ok(!isUntitledBoardTitle('Untitled board ideas'));
		assert.ok(!isUntitledBoardTitle('OAuth sign-in flow'));
	});

	test('the board list keeps the file a board is saved to', () => {
		const index = parseIndex({ schema: 1, boards: [{ id: 'b1', title: 'Plan', file: 'file:///repo/plan.scratch' }, { id: 'b2', title: 'Other' }], folders: [] });
		assert.strictEqual(index.boards.find(b => b.id === 'b1')?.file, 'file:///repo/plan.scratch');
		assert.strictEqual(index.boards.find(b => b.id === 'b2')?.file, undefined);
	});
});
