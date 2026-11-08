/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { makeBoxDraggable } from '../../browser/chrome/voltDraggableBox.js';

suite('voltDraggableBox', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(canDrag?: () => boolean) {
		const doc = mainWindow.document;
		const parent = doc.body.appendChild(doc.createElement('div'));
		parent.style.position = 'relative';
		const box = parent.appendChild(doc.createElement('div'));
		box.style.cssText = 'position: absolute; left: 40px; top: 30px; width: 200px; height: 80px;';
		const blank = box.appendChild(doc.createElement('div'));
		blank.style.height = '40px';
		const button = box.appendChild(doc.createElement('button'));
		const moves: { left: number; top: number }[] = [];
		store.add(makeBoxDraggable(box, position => moves.push(position), canDrag));
		const pointer = (target: Element, type: string, x: number, y: number, buttons = 1) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons, clientX: x, clientY: y }));
		return { parent, box, blank, button, moves, pointer };
	}

	test('a press on a blank part moves the box once the pointer passes the threshold', () => {
		const { parent, box, blank, moves, pointer } = setup();
		pointer(blank, 'pointerdown', 100, 100);
		pointer(blank, 'pointermove', 101, 101);
		assert.deepStrictEqual(moves, [], 'a click that wobbles a pixel is still a click');
		pointer(blank, 'pointermove', 120, 90);
		assert.deepStrictEqual(moves, [{ left: 60, top: 20 }]);
		assert.ok(box.classList.contains('volt-box-dragging'));
		pointer(box, 'pointerup', 120, 90, 0);
		assert.ok(!box.classList.contains('volt-box-dragging'));
		pointer(blank, 'pointermove', 150, 150, 0);
		assert.strictEqual(moves.length, 1, 'nothing moves after the release');
		parent.remove();
	});

	test('presses on buttons and folded boxes stay theirs', () => {
		const { parent, button, moves, pointer } = setup();
		pointer(button, 'pointerdown', 100, 100);
		pointer(button, 'pointermove', 140, 140);
		assert.deepStrictEqual(moves, []);
		parent.remove();

		const folded = setup(() => false);
		folded.pointer(folded.blank, 'pointerdown', 100, 100);
		folded.pointer(folded.blank, 'pointermove', 140, 140);
		assert.deepStrictEqual(folded.moves, []);
		folded.parent.remove();
	});

	test('a press let go outside the box before it became a drag ends there', () => {
		const { parent, blank, moves, pointer } = setup();
		pointer(blank, 'pointerdown', 100, 100);
		// The release happened elsewhere: the next move over the box has no button held.
		pointer(blank, 'pointermove', 140, 140, 0);
		pointer(blank, 'pointermove', 160, 160, 1);
		assert.deepStrictEqual(moves, []);
		parent.remove();
	});
});
