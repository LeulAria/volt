/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Action, IAction, Separator, SubmenuAction } from '../../../../../base/common/actions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltMenuSection } from '../../browser/ui/menu/voltMenu.js';
import { toSections, withoutMnemonic } from '../../browser/web/mobile/voltMobileActions.js';

suite('Volt mobile context menus', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('separators split the actions into sections; submenus drill in', () => {
		const open = store.add(new Action('open', '&&Open'));
		const copy = store.add(new Action('copy', 'Copy'));
		const inner = store.add(new Action('inner', 'Inner'));
		const sub = new SubmenuAction('sub', 'More', [inner]);
		const sections = toSections([open, new Separator(), copy, sub], '');
		assert.deepStrictEqual(sections.map(s => s.items.map(i => i.label)), [['Open'], ['Copy', 'More']]);
		const more = sections[1].items[1];
		assert.ok(more.submenu);
		const children = more.submenu.sections as readonly IVoltMenuSection<IAction>[];
		assert.deepStrictEqual(children.map(s => s.items.map(i => i.data.id)), [['inner']]);
	});

	test('checked and disabled carry over; empty submenus and leading separators drop', () => {
		const on = store.add(new Action('on', 'Word Wrap', undefined, true));
		on.checked = true;
		const off = store.add(new Action('off', 'Minimap', undefined, false));
		const empty = new SubmenuAction('empty', 'Nothing', []);
		const sections = toSections([new Separator(), on, off, empty], 'x/');
		assert.strictEqual(sections.length, 1);
		assert.strictEqual(sections[0].id, 'x/0');
		assert.deepStrictEqual(sections[0].items.map(i => [i.label, !!i.checked, !!i.disabled]), [['Word Wrap', true, false], ['Minimap', false, true]]);
	});

	test('mnemonics are removed, a literal ampersand stays', () => {
		assert.strictEqual(withoutMnemonic('&&Open'), 'Open');
		assert.strictEqual(withoutMnemonic('Open Recent (&&R)'), 'Open Recent');
		assert.strictEqual(withoutMnemonic('Find & Replace'), 'Find & Replace');
	});
});
