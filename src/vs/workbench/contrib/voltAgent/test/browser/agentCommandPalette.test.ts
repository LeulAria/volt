/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentPaletteEntries, IAgentPaletteContext, isAgentPaletteKey, registerAgentPaletteEntry } from '../../browser/editor/agentCommandPalette.js';

suite('Agent command palette', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Only this suite's rows: the real ones may be registered by other modules in the run. */
	const ids = (context: IAgentPaletteContext) => agentPaletteEntries(context).map(entry => entry.id).filter(id => id.startsWith('test.'));

	test('rows come in order, hide when not enabled, and go away when disposed', () => {
		const rows = store.add(new DisposableStore());
		rows.add(registerAgentPaletteEntry({ id: 'test.last', label: 'Last', commandId: 'c.last' }));
		rows.add(registerAgentPaletteEntry({ id: 'test.second', label: 'Second', commandId: 'c.second', order: 20 }));
		rows.add(registerAgentPaletteEntry({ id: 'test.first', label: 'First', commandId: 'c.first', order: 10 }));
		const restart = registerAgentPaletteEntry({ id: 'test.chatOnly', label: 'Chat only', commandId: 'c.chat', order: 15, enabled: context => !!context.sessionId });

		assert.deepStrictEqual(ids({ sessionId: 'chat', running: false }), ['test.first', 'test.chatOnly', 'test.second', 'test.last']);
		assert.deepStrictEqual(ids({ sessionId: undefined, running: false }), ['test.first', 'test.second', 'test.last']);

		restart.dispose();
		assert.deepStrictEqual(ids({ sessionId: 'chat', running: false }), ['test.first', 'test.second', 'test.last']);

		// Same id: the newer row replaces the older; disposing the older leaves the newer.
		const old = registerAgentPaletteEntry({ id: 'test.replace', label: 'Old', commandId: 'c.old', order: 1 });
		rows.add(registerAgentPaletteEntry({ id: 'test.replace', label: 'New', commandId: 'c.new', order: 1 }));
		old.dispose();
		assert.strictEqual(agentPaletteEntries({ sessionId: 'chat', running: false }).find(entry => entry.id === 'test.replace')?.label, 'New');
		rows.dispose();
		assert.deepStrictEqual(ids({ sessionId: 'chat', running: false }), []);
	});

	test('Cmd+K on the Mac, Ctrl+K elsewhere, with nothing else held', () => {
		const key = (extra: Partial<KeyboardEvent>) => ({ key: 'k', code: 'KeyK', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
		assert.strictEqual(isAgentPaletteKey(key({ metaKey: true }), true), true);
		assert.strictEqual(isAgentPaletteKey(key({ ctrlKey: true }), true), false);
		assert.strictEqual(isAgentPaletteKey(key({ ctrlKey: true }), false), true);
		assert.strictEqual(isAgentPaletteKey(key({ metaKey: true, shiftKey: true }), true), false);
		assert.strictEqual(isAgentPaletteKey(key({ metaKey: true, altKey: true }), true), false);
		assert.strictEqual(isAgentPaletteKey(key({ metaKey: true, key: 'l', code: 'KeyL' }), true), false);
		assert.strictEqual(isAgentPaletteKey(key({}), true), false);
	});
});
