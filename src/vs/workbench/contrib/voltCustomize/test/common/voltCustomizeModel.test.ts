/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VOLT_LAYOUTS_EXTENSION_POINT, VOLT_LOOKS_EXTENSION_POINT, VOLT_PLAYGROUND_MARKER, voltCustomizeAgentsMd, voltPlaygroundDraft } from '../../common/voltCustomizeDocs.js';
import {
	IVoltLayout, IVoltLook, mergeVoltCustomize, parseVoltCustomizeJson, resolveVoltCustomize, splitVoltCustomizeId, validateVoltLayout, validateVoltLook,
	VOLT_BUILTIN_LAYOUTS, VOLT_BUILTIN_LOOKS, voltCustomizeOverrides, voltCustomizeSlug, voltLayoutStateKey, voltLayoutWindowState, VoltSettingScopeLookup,
} from '../../common/voltCustomizeModel.js';
import { clampVoltLookValue, VOLT_LOOK_TOKENS, voltLookCssVariable, voltLookCssVariables, voltLookTargetSetting, voltLookToken } from '../../common/voltLookTokens.js';
import { defaultVoltSlotPlacement, resolveVoltSlotPlacement, unplacedVoltSlotItems } from '../../common/voltSlots.js';
import { decodeVoltContextDrag, encodeVoltContextDrag, voltPartContext, voltPartIdFromContext } from '../../common/voltCustomizeContext.js';
import { allVoltCustomizeParts } from '../../common/voltCustomizeParts.js';

const scopeOf: VoltSettingScopeLookup = id => id === 'workbench.tree.indent' ? 'window' : id === 'update.mode' ? 'other' : 'unknown';

suite('Volt customize: look tokens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('CSS variable names are kebab case under --volt-look-', () => {
		assert.strictEqual(voltLookCssVariable('composer.radius'), '--volt-look-composer-radius');
		assert.strictEqual(voltLookCssVariable('chat.userBubblePaddingY'), '--volt-look-chat-user-bubble-padding-y');
		assert.strictEqual(voltLookCssVariable('chat.inlineCodeFontSize'), '--volt-look-chat-inline-code-font-size');
	});

	test('token ids and CSS variables are unique', () => {
		const ids = VOLT_LOOK_TOKENS.map(entry => entry.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		assert.strictEqual(new Set(ids.map(voltLookCssVariable)).size, ids.length);
		for (const entry of VOLT_LOOK_TOKENS) {
			assert.ok(entry.default >= entry.minimum && entry.default <= entry.maximum, entry.id);
		}
	});

	test('values are clamped and strings with px are read', () => {
		const radius = voltLookToken('composer.radius')!;
		assert.strictEqual(clampVoltLookValue(radius, 12), 12);
		assert.strictEqual(clampVoltLookValue(radius, '14px'), 14);
		assert.strictEqual(clampVoltLookValue(radius, 500), radius.maximum);
		assert.strictEqual(clampVoltLookValue(radius, -3), 0);
		assert.strictEqual(clampVoltLookValue(radius, 'round'), undefined);
		assert.strictEqual(clampVoltLookValue(radius, Number.NaN), undefined);
	});

	test('an untouched Volt sets no CSS variable', () => {
		const defaults = new Map(VOLT_LOOK_TOKENS.map(entry => [`volt.look.${entry.id}`, entry.default]));
		assert.strictEqual(voltLookCssVariables(id => defaults.get(id)).size, 0);
		const changed = voltLookCssVariables(id => id === 'volt.look.composer.radius' ? 12 : id === 'volt.look.chat.lineHeight' ? 1.7 : defaults.get(id));
		assert.deepStrictEqual([...changed], [['--volt-look-chat-line-height', '1.7'], ['--volt-look-composer-radius', '12px']]);
	});

	test('aliases point at the settings that own them', () => {
		assert.strictEqual(voltLookTargetSetting('chat.width'), 'volt.chat.width');
		assert.strictEqual(voltLookTargetSetting('composer.radius'), 'volt.look.composer.radius');
		assert.strictEqual(voltLookTargetSetting('nope'), undefined);
	});
});

suite('Volt customize: files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('JSON with comments and trailing commas parses; errors carry a position', () => {
		assert.deepStrictEqual(parseVoltCustomizeJson('{ // a look\n "tokens": { "composer.radius": 12, }, }').value, { tokens: { 'composer.radius': 12 } });
		const broken = parseVoltCustomizeJson('{\n "tokens": { "composer.radius": }\n}');
		assert.strictEqual(broken.value, undefined);
		assert.match(broken.errors[0], /^line 2, column \d+: /);
		assert.deepStrictEqual(parseVoltCustomizeJson('[1]').errors, ['The file must hold one JSON object.']);
	});

	test('a look keeps good values and reports the rest', () => {
		const { value, errors } = validateVoltLook({
			label: 'Ocean',
			tokens: { 'composer.radius': 99, 'chat.width': 'wide', 'chat.gutter': 'wide', 'nope.token': 1 },
			colors: { 'sideBar.background': '#0b2a57', 'editor.background': 'blue', 'bad id!': '#000000' },
			settings: { 'workbench.tree.indent': 12, 'update.mode': 'none', 'made.up': 1 },
		}, scopeOf);
		assert.deepStrictEqual(value.tokens, { 'composer.radius': 40, 'chat.width': 'wide' });
		assert.deepStrictEqual(value.colors, { 'sideBar.background': '#0b2a57' });
		assert.deepStrictEqual(value.settings, { 'workbench.tree.indent': 12 });
		assert.strictEqual(errors.length, 6);
		assert.ok(errors.some(error => error.includes('"tokens.chat.gutter" must be a number')));
		assert.ok(errors.some(error => error.includes('applies to the whole app')));
	});

	test('a layout reads its window state and rejects unknown fields', () => {
		const { value, errors } = validateVoltLayout({
			label: 'Desk',
			sidebar: { visible: false, width: 260 },
			filesSidebar: { open: true, view: 'scm' },
			rightPanel: { open: true, commands: ['a.b'] },
			chat: { width: 'wide' },
			bottomPanel: {},
		}, scopeOf);
		assert.deepStrictEqual(value.sidebar, { visible: false, width: 260, rail: undefined });
		assert.deepStrictEqual(value.filesSidebar, { open: true, view: 'scm' });
		assert.deepStrictEqual(errors, [`"bottomPanel" is not a layout field. Fields: label, description, extends, look, tokens, colors, settings, sidebar, chat, filesSidebar, rightPanel, slots, preview.`]);
		assert.strictEqual(validateVoltLayout({ sidebar: { width: 40 } }, scopeOf).errors.length, 1);
		assert.strictEqual(validateVoltLayout({ filesSidebar: { view: 'terminal' } }, scopeOf).errors.length, 1);
	});
});

suite('Volt customize: inheritance and overrides', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('merge: objects key by key, null removes, anything else replaces', () => {
		assert.deepStrictEqual(
			mergeVoltCustomize({ tokens: { a: 1, b: 2 }, colors: { x: '#000000' }, label: 'Base' }, { tokens: { b: 3, a: null }, label: 'Mine' }),
			{ tokens: { b: 3 }, colors: { x: '#000000' }, label: 'Mine' },
		);
	});

	test('extends chains merge parent first and report loops and missing parents', () => {
		const files: Record<string, IVoltLayout> = {
			'ext/board': { label: 'Board', sidebar: { visible: true, width: 240 }, tokens: { 'composer.radius': 8 } },
			'home/mine': { extends: 'ext/board', sidebar: { width: 300 }, tokens: { 'chat.gutter': 30 } },
			'home/loop-a': { extends: 'home/loop-b' },
			'home/loop-b': { extends: 'home/loop-a' },
			'home/orphan': { extends: 'ext/gone', label: 'Orphan' },
		};
		const mine = resolveVoltCustomize('home/mine', id => files[id]);
		assert.deepStrictEqual(mine.chain, ['home/mine', 'ext/board']);
		assert.deepStrictEqual(mine.value, { label: 'Board', sidebar: { visible: true, width: 300 }, tokens: { 'composer.radius': 8, 'chat.gutter': 30 } });
		assert.match(resolveVoltCustomize('home/loop-a', id => files[id]).errors[0], /extends it back/);
		const orphan = resolveVoltCustomize('home/orphan', id => files[id]);
		assert.deepStrictEqual(orphan.value, { label: 'Orphan' });
		assert.match(orphan.errors[0], /not installed/);
		assert.strictEqual(resolveVoltCustomize('home/none', id => files[id]).value, undefined);
	});

	test('overrides: tokens become settings, colors become colorCustomizations, the look wins', () => {
		const layout: IVoltLayout = { chat: { width: 'wide' }, tokens: { 'composer.radius': 8, 'chat.gutter': 30 }, colors: { 'sideBar.background': '#111111' } };
		const look: IVoltLook = { tokens: { 'composer.radius': 24, 'font.ui': 'Inter' }, colors: { 'editor.background': '#222222' }, settings: { 'workbench.tree.indent': 12 } };
		assert.deepStrictEqual(voltCustomizeOverrides(layout, look), {
			'volt.look.composer.radius': 24,
			'volt.look.chat.gutter': 30,
			'volt.chat.width': 'wide',
			'volt.appearance.uiFontFamily': 'Inter',
			'workbench.tree.indent': 12,
			'workbench.colorCustomizations': { 'sideBar.background': '#111111', 'editor.background': '#222222' },
		});
		assert.deepStrictEqual(voltCustomizeOverrides(undefined, undefined), {});
	});

	test('the default layout and Volt with nothing picked set nothing', () => {
		const builtin = VOLT_BUILTIN_LAYOUTS.find(entry => entry.name === 'default')!.value;
		assert.deepStrictEqual(voltCustomizeOverrides(builtin, undefined), {});
		assert.deepStrictEqual(voltLayoutWindowState(builtin), { sidebarVisible: undefined, sidebarWidth: undefined, sidebarRail: undefined, filesSidebarOpen: undefined, filesSidebarView: undefined, rightPanelOpen: undefined, rightPanelCommands: undefined });
	});

	test('Volt\'s own looks and layouts are valid files', () => {
		for (const entry of VOLT_BUILTIN_LOOKS) {
			assert.deepStrictEqual(validateVoltLook(entry.value as Record<string, unknown>, scopeOf).errors, [], entry.name);
		}
		for (const entry of VOLT_BUILTIN_LAYOUTS) {
			assert.deepStrictEqual(validateVoltLayout(entry.value as Record<string, unknown>, scopeOf).errors, [], entry.name);
		}
	});

	test('the window state key changes with the file, not with the window', () => {
		const a = voltLayoutStateKey('home/desk', voltLayoutWindowState({ sidebar: { visible: true } }));
		assert.strictEqual(a, voltLayoutStateKey('home/desk', voltLayoutWindowState({ sidebar: { visible: true }, tokens: { 'chat.gutter': 4 } })));
		assert.notStrictEqual(a, voltLayoutStateKey('home/desk', voltLayoutWindowState({ sidebar: { visible: false } })));
	});

	test('ids and slugs', () => {
		assert.deepStrictEqual(splitVoltCustomizeId('acme.board/board'), { source: 'acme.board', name: 'board' });
		assert.strictEqual(splitVoltCustomizeId('nope'), undefined);
		assert.strictEqual(voltCustomizeSlug('  My Blue Volt! '), 'my-blue-volt');
		assert.strictEqual(voltCustomizeSlug('???'), 'untitled');
	});
});

suite('Volt customize: slots', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every item starts in its own slot', () => {
		const placement = defaultVoltSlotPlacement();
		assert.deepStrictEqual(placement['sidebar.header'], ['volt.filter', 'volt.openWorkspace', 'volt.newChat']);
		assert.deepStrictEqual(placement['sidebar.footer'], ['volt.settings', 'volt.usage', 'volt.pullRequestsPage', 'volt.automations', 'volt.customize']);
		assert.deepStrictEqual(placement.hidden, []);
	});

	test('a named item moves; the rest keep their slot and order', () => {
		const placement = resolveVoltSlotPlacement({ 'sidebar.header': ['volt.settings', 'volt.newChat'], hidden: ['volt.automations'] });
		assert.deepStrictEqual(placement['sidebar.header'], ['volt.settings', 'volt.newChat', 'volt.filter', 'volt.openWorkspace']);
		assert.deepStrictEqual(placement['sidebar.footer'], ['volt.usage', 'volt.pullRequestsPage', 'volt.customize']);
		assert.deepStrictEqual(placement.hidden, ['volt.automations']);
	});

	test('unknown ids are dropped and an item is placed once', () => {
		const placement = resolveVoltSlotPlacement({ 'sidebar.header': ['volt.settings', 'nope'], 'sidebar.footer': ['volt.settings'] });
		assert.deepStrictEqual(placement['sidebar.header'].filter(id => id === 'volt.settings').length, 1);
		assert.ok(!placement['sidebar.footer'].includes('volt.settings'));
		assert.ok(!Object.values(placement).flat().includes('nope'));
	});

	test('layouts validate slots and items', () => {
		const ok = validateVoltLayout({ slots: { 'sidebar.header': ['volt.settings'] } }, scopeOf);
		assert.deepStrictEqual(ok.errors, []);
		assert.deepStrictEqual(ok.value.slots, { 'sidebar.header': ['volt.settings'] });
		const bad = validateVoltLayout({ slots: { 'titlebar.left': ['volt.settings'], 'sidebar.footer': ['volt.gear'] } }, scopeOf);
		assert.strictEqual(bad.errors.length, 2);
		assert.match(bad.errors[0], /is not a slot/);
		assert.match(bad.errors[1], /is not an item/);
	});

	test('the activity bar is empty until a layout fills it; its views wait unplaced', () => {
		const placement = defaultVoltSlotPlacement();
		assert.deepStrictEqual(placement['activityBar.top'], []);
		assert.deepStrictEqual(placement['activityBar.bottom'], []);
		assert.deepStrictEqual(unplacedVoltSlotItems(placement), ['volt.explorer', 'volt.search', 'volt.sourceControl', 'volt.runAndDebug', 'volt.pullRequests', 'volt.extensions']);
	});

	test('volt/vscode puts VS Code\'s activity bar together, Settings moving from the footer to its bottom', () => {
		const vscode = VOLT_BUILTIN_LAYOUTS.find(entry => entry.name === 'vscode')!.value;
		const placement = resolveVoltSlotPlacement(vscode.slots);
		assert.deepStrictEqual(placement['activityBar.top'], ['volt.explorer', 'volt.search', 'volt.sourceControl', 'volt.runAndDebug', 'volt.pullRequests', 'volt.extensions']);
		assert.deepStrictEqual(placement['activityBar.bottom'], ['volt.settings']);
		assert.deepStrictEqual(placement['sidebar.footer'], ['volt.usage', 'volt.pullRequestsPage', 'volt.automations', 'volt.customize']);
		assert.deepStrictEqual(unplacedVoltSlotItems(placement), []);
	});

	test('any button can join the activity bar', () => {
		const placement = resolveVoltSlotPlacement({ 'activityBar.top': ['volt.newChat', 'volt.explorer'], 'activityBar.bottom': ['volt.usage'] });
		assert.deepStrictEqual(placement['activityBar.top'], ['volt.newChat', 'volt.explorer']);
		assert.deepStrictEqual(placement['sidebar.header'], ['volt.filter', 'volt.openWorkspace']);
		assert.ok(!placement['sidebar.footer'].includes('volt.usage'));
	});

	test('a child layout replaces a parent\'s list for the slots it names', () => {
		const files: Record<string, IVoltLayout> = {
			'ext/a': { slots: { 'sidebar.header': ['volt.newChat'], hidden: ['volt.usage'] } },
			'home/b': { extends: 'ext/a', slots: { 'sidebar.header': ['volt.settings'] } },
		};
		assert.deepStrictEqual(resolveVoltCustomize('home/b', id => files[id]).value?.slots, { 'sidebar.header': ['volt.settings'], hidden: ['volt.usage'] });
	});
});

suite('Volt customize: devtools context', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a dragged part round-trips and bad data is ignored', () => {
		const drag = { label: 'Message box', value: '<volt_part id="composer">x</volt_part>' };
		assert.deepStrictEqual(decodeVoltContextDrag(encodeVoltContextDrag(drag)), drag);
		assert.strictEqual(decodeVoltContextDrag('not json'), undefined);
		assert.strictEqual(decodeVoltContextDrag(JSON.stringify({ label: 1 })), undefined);
		assert.strictEqual(decodeVoltContextDrag(undefined), undefined);
	});

	test('a chip\'s block gives back the part it came from', () => {
		const composer = allVoltCustomizeParts().find(part => part.id === 'composer')!;
		assert.strictEqual(voltPartIdFromContext(voltPartContext(composer, () => undefined)), 'composer');
		assert.strictEqual(voltPartIdFromContext('<volt_part id="volt.settings" label="Settings">'), 'volt.settings');
		assert.strictEqual(voltPartIdFromContext('```browser_element\n{}\n```'), undefined);
		assert.strictEqual(voltPartIdFromContext(undefined), undefined);
	});

	test('a part\'s context names its element, current values, colors and slot items', () => {
		const composer = allVoltCustomizeParts().find(part => part.id === 'composer')!;
		const text = voltPartContext(composer, setting => setting === 'volt.look.composer.radius' ? 12 : undefined);
		assert.ok(text.startsWith('<volt_part id="composer" label="Message box">'));
		assert.ok(text.includes('`.volt-agent-input-box`'));
		assert.ok(text.includes('composer.radius = 12 (default 20'));
		assert.ok(text.includes('--volt-look-composer-radius'));
		const header = allVoltCustomizeParts().find(part => part.id === 'sidebar.header')!;
		assert.ok(voltPartContext(header, () => undefined, ['volt.settings']).includes('volt.settings (Settings)'));
	});

	test('every part names known tokens and a selector', () => {
		for (const part of allVoltCustomizeParts()) {
			assert.ok(part.selector, part.id);
			for (const id of part.tokens ?? []) {
				assert.ok(voltLookTargetSetting(id), `${part.id}: ${id}`);
			}
		}
	});
});

suite('Volt customize: docs and drafts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('AGENTS.md names every token, the paths and the escape hatch', () => {
		const text = voltCustomizeAgentsMd({ home: '/Users/me/.volt/customize', settings: '/Users/me/settings.json', keybindings: '/Users/me/keybindings.json' });
		for (const entry of VOLT_LOOK_TOKENS) {
			assert.ok(text.includes(`\`${entry.id}\``), entry.id);
			assert.ok(text.includes(voltLookCssVariable(entry.id)), entry.id);
		}
		assert.ok(text.includes('/Users/me/settings.json'));
		assert.ok(text.includes('Reset Customizations'));
		assert.ok(text.includes(VOLT_LOOKS_EXTENSION_POINT) && text.includes(VOLT_LAYOUTS_EXTENSION_POINT));
	});

	test('a draft is an extension that starts from the layout and look in use', () => {
		const files = voltPlaygroundDraft('Blue Sidebar', 'volt/review', 'volt/soft');
		const manifest = JSON.parse(files['package.json']);
		assert.strictEqual(manifest.name, 'blue-sidebar');
		assert.strictEqual(manifest.publisher, 'local');
		assert.deepStrictEqual(manifest.contributes[VOLT_LOOKS_EXTENSION_POINT], [{ id: 'blue-sidebar', label: 'Blue Sidebar', path: './look.json' }]);
		assert.deepStrictEqual(manifest[VOLT_PLAYGROUND_MARKER], { baseLayout: 'volt/review', baseLook: 'volt/soft' });
		assert.strictEqual(JSON.parse(files['layout.json']).extends, 'volt/review');
		assert.strictEqual(JSON.parse(files['look.json']).extends, 'volt/soft');
		assert.deepStrictEqual(validateVoltLook(JSON.parse(files['look.json']), scopeOf).errors, []);
		assert.deepStrictEqual(validateVoltLayout(JSON.parse(files['layout.json']), scopeOf).errors, []);
		assert.strictEqual(files['CLAUDE.md'], '@AGENTS.md\n');
	});
});
