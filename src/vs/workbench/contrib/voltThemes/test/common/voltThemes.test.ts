/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Color } from '../../../../../base/common/color.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { adjustColorForContrast, clampContrast, contrastOverrides, contrastRole } from '../../common/voltThemeContrast.js';
import { compareVersions, extensionFolderName, importableThemeSettings, installedFolders, newestCandidates, parseThemeExtension } from '../../common/voltThemeImport.js';
import { extractThemeSwatches, tokenForeground } from '../../common/voltThemeSwatches.js';

const hex = (value: string) => Color.fromHex(value);

suite('Volt themes: contrast', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sorts colors into text, borders and surfaces, leaving palettes alone', () => {
		assert.strictEqual(contrastRole('foreground'), 'text');
		assert.strictEqual(contrastRole('descriptionForeground'), 'text');
		assert.strictEqual(contrastRole('list.inactiveSelectionForeground'), 'text');
		assert.strictEqual(contrastRole('widget.border'), 'border');
		assert.strictEqual(contrastRole('sideBar.border'), 'border');
		assert.strictEqual(contrastRole('menu.separatorBackground'), 'border');
		assert.strictEqual(contrastRole('editor.background'), 'surface');
		assert.strictEqual(contrastRole('sideBar.background'), 'surface');
		assert.strictEqual(contrastRole('list.hoverBackground'), undefined);
		assert.strictEqual(contrastRole('terminal.ansiRed'), undefined);
		assert.strictEqual(contrastRole('charts.blue'), undefined);
		assert.strictEqual(contrastRole('editorBracketHighlight.foreground1'), undefined);
	});

	test('clamps the setting to whole steps in range', () => {
		assert.strictEqual(clampContrast(250), 100);
		assert.strictEqual(clampContrast(-250), -100);
		assert.strictEqual(clampContrast(12.6), 13);
		assert.strictEqual(clampContrast('20'), 0);
		assert.strictEqual(clampContrast(Number.NaN), 0);
	});

	test('zero leaves every color as the theme made it', () => {
		const color = hex('#cccccc99');
		assert.strictEqual(adjustColorForContrast(color, 'text', 0, true), color);
		assert.deepStrictEqual(contrastOverrides([['foreground', color]], 0, true, id => id), []);
	});

	test('more contrast moves text away from a dark background, less brings it closer', () => {
		const bg = hex('#1e1e1e');
		const fg = hex('#cccccc');
		const ratio = (c: Color) => c.makeOpaque(bg).getContrastRatio(bg);
		const base = ratio(fg);
		const high = ratio(adjustColorForContrast(fg, 'text', 1, true));
		const low = ratio(adjustColorForContrast(fg, 'text', -1, true));
		assert.ok(high > base, `${high} > ${base}`);
		assert.ok(low < base, `${low} < ${base}`);
		// Half way sits between.
		const half = ratio(adjustColorForContrast(fg, 'text', 0.5, true));
		assert.ok(half > base && half < high);
	});

	test('on a light theme more contrast darkens text', () => {
		const fg = hex('#616161');
		const adjusted = adjustColorForContrast(fg, 'text', 1, false);
		assert.ok(adjusted.getRelativeLuminance() < fg.getRelativeLuminance());
	});

	test('muted (translucent) text gets firmer with more contrast and fainter with less', () => {
		const muted = hex('#cccccc99');
		assert.ok(adjustColorForContrast(muted, 'text', 0.6, true).rgba.a > muted.rgba.a);
		assert.ok(adjustColorForContrast(muted, 'text', -0.6, true).rgba.a < muted.rgba.a);
	});

	test('colored text keeps its hue', () => {
		const link = hex('#3794ff');
		const adjusted = adjustColorForContrast(link, 'text', 1, true);
		assert.ok(Math.abs(adjusted.hsla.h - link.hsla.h) < 6, `${adjusted.hsla.h} vs ${link.hsla.h}`);
	});

	test('borders strengthen and fade; switched-off colors stay off', () => {
		const border = hex('#ffffff1a');
		assert.ok(adjustColorForContrast(border, 'border', 1, true).rgba.a > border.rgba.a);
		assert.ok(adjustColorForContrast(border, 'border', -1, true).rgba.a < border.rgba.a);
		const off = hex('#00000000');
		assert.strictEqual(adjustColorForContrast(off, 'border', 1, true), off);
	});

	test('surfaces deepen on a dark theme and lift on a light one', () => {
		const dark = hex('#252526');
		assert.ok(adjustColorForContrast(dark, 'surface', 1, true).getRelativeLuminance() < dark.getRelativeLuminance());
		const light = hex('#f3f3f3');
		assert.ok(adjustColorForContrast(light, 'surface', 1, false).getRelativeLuminance() > light.getRelativeLuminance());
	});

	test('overrides list only the colors that moved, as CSS variables', () => {
		const overrides = contrastOverrides([
			['foreground', hex('#cccccc')],
			['list.hoverBackground', hex('#2a2d2e')],
			['widget.border', undefined],
		], 0.5, true, id => `--vscode-${id.replace(/\./g, '-')}`);
		assert.deepStrictEqual(overrides.map(([name]) => name), ['--vscode-foreground']);
	});
});

suite('Volt themes: swatches', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const rules = [
		{ settings: { foreground: '#d4d4d4' } },
		{ scope: 'keyword', settings: { foreground: '#569cd6' } },
		{ scope: 'keyword.control', settings: { foreground: '#c586c0' } },
		{ scope: ['string', 'string.quoted.single'], settings: { foreground: '#ce9178' } },
		{ scope: 'comment, punctuation.definition.comment', settings: { foreground: '#6a9955' } },
		{ scope: 'source.js entity.name.function', settings: { foreground: '#dcdcaa' } },
	];

	test('the most specific selector wins, later rules break ties', () => {
		assert.strictEqual(tokenForeground(rules, 'keyword.control.flow'), '#c586c0');
		assert.strictEqual(tokenForeground(rules, 'keyword.operator'), '#569cd6');
		assert.strictEqual(tokenForeground([...rules, { scope: 'keyword', settings: { foreground: '#ffffff' } }], 'keyword.operator'), '#ffffff');
		assert.strictEqual(tokenForeground(rules, 'comment.line'), '#6a9955');
		assert.strictEqual(tokenForeground(rules, 'entity.name.function'), '#dcdcaa');
		assert.strictEqual(tokenForeground(rules, 'variable'), undefined);
	});

	test('a selector only matches whole scope segments', () => {
		assert.strictEqual(tokenForeground([{ scope: 'key', settings: { foreground: '#111111' } }], 'keyword'), undefined);
	});

	test('reads the tile colors with fallbacks', () => {
		const colors: Record<string, string> = { 'editor.background': '#1e1e1e', 'editor.foreground': '#d4d4d4', 'focusBorder': '#007fd4' };
		const swatches = extractThemeSwatches(id => colors[id], rules, true);
		assert.deepStrictEqual(swatches, {
			background: '#1e1e1e',
			surface: '#1e1e1e',
			foreground: '#d4d4d4',
			accent: '#007fd4',
			keyword: '#c586c0',
			string: '#ce9178',
			func: '#dcdcaa',
			comment: '#6a9955',
		});
	});

	test('a sparse theme still gets a full tile', () => {
		const swatches = extractThemeSwatches(() => undefined, [], false);
		assert.strictEqual(swatches.background, '#ffffff');
		assert.strictEqual(swatches.keyword, swatches.foreground);
	});
});

suite('Volt themes: import', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const gruvbox = {
		name: 'gruvbox', publisher: 'jdinhlife', version: '1.29.1', displayName: 'Gruvbox Theme', categories: ['Themes'],
		contributes: { themes: [{ label: 'Gruvbox Dark Medium', uiTheme: 'vs-dark', path: './themes/gruvbox-dark-medium.json' }, { label: 'Gruvbox Light Hard', uiTheme: 'vs', path: './themes/gruvbox-light-hard.json' }] },
	};

	test('reads a theme extension manifest', () => {
		const candidate = parseThemeExtension(gruvbox, 'jdinhlife.gruvbox-1.29.1', 'vscode');
		assert.deepStrictEqual(candidate, {
			id: 'jdinhlife.gruvbox', displayName: 'Gruvbox Theme', publisher: 'jdinhlife', version: '1.29.1', source: 'vscode', folderName: 'jdinhlife.gruvbox-1.29.1',
			themes: [{ label: 'Gruvbox Dark Medium', uiTheme: 'vs-dark' }, { label: 'Gruvbox Light Hard', uiTheme: 'vs' }],
		});
		assert.strictEqual(extensionFolderName(candidate!), 'jdinhlife.gruvbox-1.29.1');
	});

	test('skips language extensions that also ship a theme, and non-theme packages', () => {
		const csharp = { name: 'csharp', publisher: 'ms-dotnettools', version: '2.130.5', categories: ['Programming Languages'], main: './dist/extension', contributes: { themes: [{ label: 'Visual Studio 2019 Dark', path: './themes/vs2019_dark.json' }], languages: [] } };
		assert.strictEqual(parseThemeExtension(csharp, 'x', 'vscode'), undefined);
		assert.strictEqual(parseThemeExtension({ name: 'a', publisher: 'b', version: '1.0.0', contributes: { commands: [] } }, 'x', 'vscode'), undefined);
		assert.strictEqual(parseThemeExtension('nope', 'x', 'vscode'), undefined);
		// No category, but nothing except themes: still a theme package.
		const bare = { name: 'owl', publisher: 'sdras', version: '2.1.1', displayName: '%displayName%', contributes: { themes: [{ id: 'Night Owl', path: './t.json' }] } };
		assert.strictEqual(parseThemeExtension(bare, 'x', 'cursor')?.displayName, 'owl');
	});

	test('compares versions like semver', () => {
		assert.ok(compareVersions('1.29.1', '1.29.0') > 0);
		assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
		assert.strictEqual(compareVersions('2.0', '2.0.0'), 0);
		assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
	});

	test('keeps the newest copy of each extension, VS Code on a tie', () => {
		const a = parseThemeExtension(gruvbox, 'jdinhlife.gruvbox-1.29.1', 'cursor')!;
		const b = parseThemeExtension({ ...gruvbox, version: '1.29.0' }, 'jdinhlife.gruvbox-1.29.0', 'vscode')!;
		const c = parseThemeExtension(gruvbox, 'jdinhlife.gruvbox-1.29.1', 'vscode')!;
		assert.deepStrictEqual(newestCandidates([b, a]).map(x => [x.version, x.source]), [['1.29.1', 'cursor']]);
		assert.deepStrictEqual(newestCandidates([a, c, b]).map(x => [x.version, x.source]), [['1.29.1', 'vscode']]);
	});

	test('reads which folders an editor still has installed', () => {
		const { installed, obsolete } = installedFolders(
			JSON.stringify([{ relativeLocation: 'jdinhlife.gruvbox-1.29.1' }, { location: { path: '/u/.vscode/extensions/pmndrs.pmndrs-0.3.7' } }]),
			JSON.stringify({ 'jdinhlife.gruvbox-1.29.0': true }),
		);
		assert.deepStrictEqual([...installed!], ['jdinhlife.gruvbox-1.29.1', 'pmndrs.pmndrs-0.3.7']);
		assert.deepStrictEqual([...obsolete], ['jdinhlife.gruvbox-1.29.0']);
		assert.strictEqual(installedFolders(undefined, 'not json').installed, undefined);
	});

	test('picks only the theme settings worth bringing over', () => {
		assert.deepStrictEqual(importableThemeSettings({
			'workbench.colorTheme': 'poimandres-noitalics',
			'workbench.colorCustomizations': {},
			'editor.tokenColorCustomizations': { comments: '#888888' },
			'editor.fontSize': 14,
		}), {
			'workbench.colorTheme': 'poimandres-noitalics',
			'editor.tokenColorCustomizations': { comments: '#888888' },
		});
		assert.deepStrictEqual(importableThemeSettings([]), {});
	});
});
