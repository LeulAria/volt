/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { NEW_UNTITLED_FILE_COMMAND_ID as filesNewFileCommand } from '../../../files/browser/fileConstants.js';
import { explicitLayoutMode, layoutModeKeybindingConflict, NEW_UNTITLED_FILE_COMMAND_ID as layoutNewFileCommand, withLayoutModeWhen, type ILayoutModeKeybindingRef } from '../../../../browser/parts/titlebar/layoutKeybindingMode.js';

suite('Layout keybinding mode', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('menu command id matches New Untitled File', () => {
		assert.strictEqual(layoutNewFileCommand, filesNewFileCommand);
	});

	test('reads an exclusive agent or IDE when clause', () => {
		assert.strictEqual(explicitLayoutMode(undefined), undefined);
		assert.strictEqual(explicitLayoutMode(''), undefined);
		assert.strictEqual(explicitLayoutMode('editorTextFocus'), undefined);
		assert.strictEqual(explicitLayoutMode("volt.layoutMode == 'agent'"), 'agent');
		assert.strictEqual(explicitLayoutMode("editorTextFocus && volt.layoutMode == 'ide'"), 'ide');
		assert.strictEqual(explicitLayoutMode("volt.layoutMode != 'agent'"), 'ide');
		assert.strictEqual(explicitLayoutMode("volt.layoutMode != 'ide'"), 'agent');
		assert.strictEqual(explicitLayoutMode("volt.layoutMode == 'agent' || editorTextFocus"), undefined);
	});

	test('pins a when clause to one mode and replaces the other', () => {
		assert.strictEqual(withLayoutModeWhen(undefined, 'agent'), "volt.layoutMode == 'agent'");
		assert.strictEqual(withLayoutModeWhen("volt.layoutMode == 'ide'", 'agent'), "volt.layoutMode == 'agent'");
		assertWhen(
			withLayoutModeWhen('editorTextFocus', 'ide'),
			ContextKeyExpr.and(ContextKeyExpr.deserialize('editorTextFocus'), ContextKeyExpr.equals('volt.layoutMode', 'ide')),
		);
		assertWhen(
			withLayoutModeWhen("editorTextFocus && volt.layoutMode == 'agent'", 'ide'),
			ContextKeyExpr.and(ContextKeyExpr.deserialize('editorTextFocus'), ContextKeyExpr.equals('volt.layoutMode', 'ide')),
		);
	});

	test('allows the same key once in each mode', () => {
		const items: ILayoutModeKeybindingRef[] = [
			{ command: 'newFile', commandLabel: 'New File', key: 'cmd+n', when: "volt.layoutMode == 'ide'" },
			{ command: 'newAgent', commandLabel: 'New Agent', key: 'Cmd+N', when: "volt.layoutMode == 'agent'" },
			{ command: 'newChat', commandLabel: 'New Chat', key: 'cmd+n', when: 'inChatSession' },
		];

		assert.strictEqual(layoutModeKeybindingConflict(items, 'cmd+n', 'agent')?.command, 'newAgent');
		assert.strictEqual(layoutModeKeybindingConflict(items, 'cmd+n', 'ide')?.command, 'newFile');
		assert.strictEqual(layoutModeKeybindingConflict(items, 'cmd+p', 'agent'), undefined);
		assert.strictEqual(
			layoutModeKeybindingConflict(items, 'cmd+n', 'agent', { command: 'newAgent', key: 'cmd+n', when: "volt.layoutMode == 'agent'" }),
			undefined,
		);
		assert.strictEqual(
			layoutModeKeybindingConflict(items, 'cmd+n', 'ide', { command: 'newAgent', key: 'cmd+n', when: "volt.layoutMode == 'agent'" })?.command,
			'newFile',
		);
	});
});

function assertWhen(actual: string, expected: ReturnType<typeof ContextKeyExpr.and>): void {
	assert.strictEqual(ContextKeyExpr.deserialize(actual)?.serialize(), expected?.serialize());
}
