/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_KEY_BAR_KEYS, editorKeybindingLabel, KeyBarKey, parseKeyBarKey, terminalSequence, terminalText } from '../../browser/web/mobile/voltMobileKeyBar.js';

suite('Volt mobile key bar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const none = { ctrl: false, alt: false, shift: false };
	const key = (token: string) => parseKeyBarKey(token) as KeyBarKey;

	test('reads named keys, modifiers, commands and text', () => {
		assert.deepStrictEqual(key('ctrl'), { kind: 'modifier', modifier: 'ctrl', label: 'ctrl' });
		assert.strictEqual(key('Left').kind, 'key');
		assert.strictEqual(key('esc').kind, 'key');
		assert.deepStrictEqual(key('command:workbench.action.files.save'), { kind: 'command', command: 'workbench.action.files.save', label: 'workbench.action.files.save' });
		assert.deepStrictEqual(key('=>'), { kind: 'text', text: '=>', label: '=>' });
		assert.strictEqual(parseKeyBarKey(''), undefined);
		assert.ok(DEFAULT_KEY_BAR_KEYS.every(token => parseKeyBarKey(token)));
	});

	test('editor chords use the platform modifier', () => {
		assert.strictEqual(editorKeybindingLabel('left', { ...none, shift: true }, OperatingSystem.Linux), 'shift+left');
		assert.strictEqual(editorKeybindingLabel('s', { ...none, ctrl: true }, OperatingSystem.Linux), 'ctrl+s');
		assert.strictEqual(editorKeybindingLabel('s', { ...none, ctrl: true }, OperatingSystem.Macintosh), 'cmd+s');
		assert.strictEqual(editorKeybindingLabel('esc', none, OperatingSystem.Linux), 'escape');
	});

	test('terminal keys are the sequences a keyboard sends', () => {
		assert.strictEqual(terminalSequence(key('esc'), none), '\x1b');
		assert.strictEqual(terminalSequence(key('tab'), none), '\t');
		assert.strictEqual(terminalSequence(key('tab'), { ...none, shift: true }), '\x1b[Z');
		assert.strictEqual(terminalSequence(key('up'), none), '\x1b[A');
		assert.strictEqual(terminalSequence(key('up'), none, true), '\x1bOA');
		assert.strictEqual(terminalSequence(key('left'), { ...none, ctrl: true }), '\x1b[1;5D');
		assert.strictEqual(terminalSequence(key('pageup'), none), '\x1b[5~');
		assert.strictEqual(terminalSequence(key('pagedown'), { ...none, shift: true }), '\x1b[6;2~');
		assert.strictEqual(terminalSequence(key('undo'), none), undefined);
	});

	test('Ctrl makes control characters and Alt an Esc prefix', () => {
		assert.strictEqual(terminalText('c', { ...none, ctrl: true }), '\x03');
		assert.strictEqual(terminalText('[', { ...none, ctrl: true }), '\x1b');
		assert.strictEqual(terminalText('b', { ...none, alt: true }), '\x1bb');
		assert.strictEqual(terminalText('x', { ...none, shift: true }), 'X');
		assert.strictEqual(terminalText('=>', { ...none, ctrl: true }), '=>');
	});
});
