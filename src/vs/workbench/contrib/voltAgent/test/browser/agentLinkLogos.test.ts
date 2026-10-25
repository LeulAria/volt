/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LINK_BRANDS } from '../../browser/blocks/agentLinkBrands.js';
import { fillBrandLink, linkBrandForHref, splitTextLinks } from '../../browser/blocks/agentLinkLogos.js';

suite('Agent link logos', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('covers 30 well-known sites', () => {
		assert.strictEqual(Object.keys(LINK_BRANDS).length, 30);
	});

	test('splits a pasted link out of a sentence, leaving trailing punctuation as text', () => {
		assert.deepStrictEqual(splitTextLinks('let\'s use this song https://www.youtube.com/watch?v=yfO7S5dtuvs&list=RDyfO7S5dtuvs&start_radio=1'), [
			'let\'s use this song ',
			{ url: 'https://www.youtube.com/watch?v=yfO7S5dtuvs&list=RDyfO7S5dtuvs&start_radio=1' },
		]);
		assert.deepStrictEqual(splitTextLinks('see https://x.com/a. (and https://en.wikipedia.org/wiki/Foo_(bar))'), [
			'see ',
			{ url: 'https://x.com/a' },
			'. (and ',
			{ url: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
			')',
		]);
		assert.deepStrictEqual(splitTextLinks('no links here'), ['no links here']);
	});

	test('knows a site by its host and subdomains, not by look-alikes', () => {
		const id = (href: string) => linkBrandForHref(href)?.id;
		assert.strictEqual(id('https://youtu.be/yfO7S5dtuvs'), 'youtube');
		assert.strictEqual(id('https://music.youtube.com/watch?v=1'), 'youtube');
		assert.strictEqual(id('https://gist.github.com/a/b'), 'github');
		assert.strictEqual(id('https://twitter.com/jack'), 'x');
		assert.strictEqual(id('https://docs.google.com/document/d/abc'), 'googledrive');
		assert.strictEqual(id('https://www.google.com/search?q=volt'), 'google');
		assert.strictEqual(id('https://notgithub.com/a'), undefined);
		assert.strictEqual(id('https://example.com/a'), undefined);
		assert.strictEqual(id('ftp://github.com/a'), undefined);
	});

	test('a link keeps its URL as text, led by the logo of a known site', () => {
		const known = mainWindow.document.createElement('span');
		fillBrandLink(known, 'https://github.com/LeulAria/volt/pull/7');
		assert.strictEqual(known.textContent, 'https://github.com/LeulAria/volt/pull/7');
		assert.ok(known.querySelector('.volt-link-brand-icon.github svg'));

		const other = mainWindow.document.createElement('span');
		fillBrandLink(other, 'https://example.com/a');
		assert.strictEqual(other.textContent, 'https://example.com/a');
		assert.strictEqual(other.querySelector('.volt-link-brand-icon'), null);
	});
});
