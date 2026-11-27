/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VOLT_VIEW_LOCATIONS } from '../../../../services/voltPlugins/common/voltContributions.js';
import { VOLT_LAYOUT_GLYPH_TARGETS, voltLayoutGlyphSvg } from '../../common/voltLayoutGlyphs.js';
import { injectVoltWebviewKit, resolveVoltViewSize, VOLT_ICON_STROKE, VOLT_WEBVIEW_KIT_CSS, voltIconStrokeSvg } from '../../common/voltPluginDesign.js';
import { VOLT_SLOTS } from '../../common/voltSlots.js';

suite('Volt plugin design', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a view gets the size it asks for inside the placement\'s bounds', () => {
		assert.deepStrictEqual(resolveVoltViewSize('aboveComposer', undefined), { width: undefined, height: 160 });
		assert.deepStrictEqual(resolveVoltViewSize('aboveComposer', { height: 240 }), { width: undefined, height: 240 });
		assert.deepStrictEqual(resolveVoltViewSize('aboveComposer', { height: 2000, width: 1200 }), { width: undefined, height: 320 });
		assert.deepStrictEqual(resolveVoltViewSize('popover', { width: 100, height: Number.NaN }), { width: 280, height: 420 });
		assert.deepStrictEqual(resolveVoltViewSize('sidebarSection', { height: 10 }), { width: undefined, height: 96 });
		// The right panel, a page and the files sidebar are the user's to size.
		assert.deepStrictEqual(resolveVoltViewSize('rightPanel', { width: 900, height: 900 }), { width: undefined, height: undefined });
	});

	test('the kit goes first in <head>, before the page\'s CSP, and the placement on <html>', () => {
		const page = '<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="style-src x"><link rel="stylesheet" href="a.css"></head><body></body></html>';
		const out = injectVoltWebviewKit(page, 'aboveComposer');
		assert.ok(out.startsWith('<!DOCTYPE html><html data-volt-placement="aboveComposer" lang="en"><head><style id="_voltKit">'));
		assert.ok(out.indexOf('_voltKit') < out.indexOf('Content-Security-Policy'));
		assert.ok(out.indexOf('_voltKit') < out.indexOf('a.css'));
	});

	test('a page without <head> or <html> still gets the kit', () => {
		assert.ok(injectVoltWebviewKit('<html><body>x</body></html>', undefined).startsWith('<html><head><style id="_voltKit">'));
		assert.ok(injectVoltWebviewKit('<div>x</div>', undefined).startsWith('<style id="_voltKit">'));
		assert.ok(injectVoltWebviewKit('<div>x</div>', 'popover').startsWith('<html data-volt-placement="popover"><head><style id="_voltKit">'));
	});

	test('a page turns the kit off on purpose, and keeps its placement', () => {
		const page = '<html><head><meta name="volt-kit" content="off"></head><body></body></html>';
		assert.strictEqual(injectVoltWebviewKit(page, 'page'), '<html data-volt-placement="page"><head><meta name="volt-kit" content="off"></head><body></body></html>');
	});

	test('the kit is one cascade layer, so any rule of the page beats it', () => {
		assert.ok(VOLT_WEBVIEW_KIT_CSS.trim().startsWith('@layer volt-kit {'));
		assert.ok(VOLT_WEBVIEW_KIT_CSS.trim().endsWith('}'));
		assert.ok(!VOLT_WEBVIEW_KIT_CSS.includes('</style'));
	});

	test('every slot and view location has its map of the window', () => {
		const targets = [...VOLT_SLOTS.map(slot => slot.id), ...VOLT_VIEW_LOCATIONS];
		assert.deepStrictEqual([...VOLT_LAYOUT_GLYPH_TARGETS].sort(), [...targets].sort());
		for (const target of targets) {
			const svg = voltLayoutGlyphSvg(target);
			assert.ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/.test(svg), target);
			assert.ok(svg.endsWith('</svg>'), target);
			// The window plus at least one mark of its own.
			assert.ok((svg.match(/<(rect|path)\b/g) ?? []).length > 3, target);
		}
	});

	test('outline icons get Volt\'s icon line, filled icons stay as they are', () => {
		const lucide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18"/></svg>';
		const drawn = voltIconStrokeSvg(lucide);
		assert.ok(drawn.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><style>'));
		assert.ok(drawn.includes(`stroke-width:${VOLT_ICON_STROKE};vector-effect:non-scaling-stroke`));
		assert.strictEqual(voltIconStrokeSvg(drawn), drawn, 'once');
		const filled = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24H0z"/></svg>';
		assert.strictEqual(voltIconStrokeSvg(filled), filled);
	});
});
