/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FixedContainingBlock } from '../../../browser/view/fixedContainingBlock.js';

suite('Fixed containing block', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let host: HTMLElement;

	setup(() => {
		host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
	});

	teardown(() => {
		host.remove();
	});

	test('fixed elements count from the viewport when no ancestor takes over', () => {
		const parent = host.appendChild(mainWindow.document.createElement('div'));
		const block = new FixedContainingBlock(parent);
		assert.strictEqual(block.measure(), undefined);
		block.dispose();
	});

	test('an ancestor with paint containment is the box, and its corner the origin', () => {
		const area = host.appendChild(mainWindow.document.createElement('div'));
		area.style.cssText = 'position:fixed;left:120px;top:30px;width:200px;height:100px;contain:paint;';
		const parent = area.appendChild(mainWindow.document.createElement('div'));
		const block = new FixedContainingBlock(parent);

		assert.deepStrictEqual(block.measure(), { left: 120, top: 30, width: 200, height: 100 });

		// The corner follows the ancestor when it moves.
		area.style.left = '40px';
		assert.deepStrictEqual(block.measure(), { left: 40, top: 30, width: 200, height: 100 });

		block.dispose();
		assert.strictEqual(parent.childElementCount, 0, 'the probe is removed');
	});

	test('a transform takes over too', () => {
		const area = host.appendChild(mainWindow.document.createElement('div'));
		area.style.cssText = 'position:absolute;left:0;top:0;width:150px;height:90px;transform:translate(10px, 20px);';
		const parent = area.appendChild(mainWindow.document.createElement('div'));
		const block = new FixedContainingBlock(parent);

		assert.deepStrictEqual(block.measure(), { left: 10, top: 20, width: 150, height: 90 });
		block.dispose();
	});

	test('nothing is measured while the parent is not in a document', () => {
		const parent = mainWindow.document.createElement('div');
		const block = new FixedContainingBlock(parent);
		assert.strictEqual(block.measure(), undefined);
		block.dispose();
	});
});
