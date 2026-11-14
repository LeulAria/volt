/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { AgentCaretRest, CARET_REST_MS, caretBlinking } from '../../browser/composer/agentCaretRest.js';

suite('agentCaretRest', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('blinks as configured while input is recent, then holds still', () => {
		assert.deepStrictEqual(caretBlinking('blink', 0), { blinking: 'blink', recheckIn: CARET_REST_MS });
		assert.deepStrictEqual(caretBlinking('phase', 4_000), { blinking: 'phase', recheckIn: CARET_REST_MS - 4_000 });
		assert.deepStrictEqual(caretBlinking(undefined, CARET_REST_MS), { blinking: 'solid' });
		assert.deepStrictEqual(caretBlinking('solid', 0), { blinking: 'solid' }, 'a solid caret never needs a timer');
	});

	function fakeEditor(disposables: DisposableStore) {
		const focus = disposables.add(new Emitter<void>());
		const blur = disposables.add(new Emitter<void>());
		const content = disposables.add(new Emitter<unknown>());
		const never = disposables.add(new Emitter<never>());
		const updates: IEditorOptions[] = [];
		let focused = true;
		const editor = {
			onDidFocusEditorText: focus.event,
			onDidBlurEditorText: blur.event,
			onDidChangeModelContent: content.event,
			onDidChangeCursorPosition: never.event,
			onKeyDown: never.event,
			onMouseDown: never.event,
			hasTextFocus: () => focused,
			getDomNode: () => null,
			updateOptions: (options: IEditorOptions) => updates.push(options),
		} as unknown as ICodeEditor;
		return { editor, updates, type: () => content.fire(undefined), blur: () => { focused = false; blur.fire(); }, focus: () => { focused = true; focus.fire(); } };
	}

	test('a focused composer left alone rests its caret, and the next key wakes it', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const disposables = store.add(new DisposableStore());
		const fake = fakeEditor(disposables);
		const rest = disposables.add(new AgentCaretRest(fake.editor, () => 'blink'));
		await timeout(CARET_REST_MS / 2);
		fake.type();
		await timeout(CARET_REST_MS / 2 + 1);
		assert.deepStrictEqual(fake.updates, [], 'a key half way through restarts the wait');
		assert.strictEqual(rest.override(), 'blink');
		await timeout(CARET_REST_MS / 2);
		assert.deepStrictEqual(fake.updates, [{ cursorBlinking: 'solid' }]);
		assert.strictEqual(rest.override(), 'solid', 'a full option update keeps the rest');
		fake.type();
		assert.deepStrictEqual(fake.updates, [{ cursorBlinking: 'solid' }, { cursorBlinking: 'blink' }]);
		assert.strictEqual(rest.override(), 'blink');
	}));

	test('an unfocused composer keeps no timer', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const disposables = store.add(new DisposableStore());
		const fake = fakeEditor(disposables);
		disposables.add(new AgentCaretRest(fake.editor, () => 'blink'));
		fake.blur();
		await timeout(CARET_REST_MS * 2);
		assert.deepStrictEqual(fake.updates, []);
		fake.focus();
		await timeout(CARET_REST_MS);
		assert.deepStrictEqual(fake.updates, [{ cursorBlinking: 'solid' }]);
	}));
});
