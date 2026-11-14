/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createThinkingDots } from '../../browser/composer/agentComposerChips.js';

suite('Agent composer chips: working dots', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the dots are one strip with the eight frames as its mask, not nine animated elements', () => {
		const dots = createThinkingDots();
		assert.strictEqual(dots.childElementCount, 1);
		const strip = dots.firstElementChild as HTMLElement;
		assert.ok(strip.classList.contains('volt-browser-dock-dot-strip'));
		const mask = strip.style.getPropertyValue('mask-image') || strip.style.getPropertyValue('-webkit-mask-image');
		assert.ok(mask.startsWith('url("data:image/svg+xml,'), `a data-URI mask: ${mask.slice(0, 40)}`);
		const svg = decodeURIComponent(mask.slice('url("data:image/svg+xml,'.length, -2));
		assert.ok(svg.includes('viewBox="0 0 84 10.5"'), 'eight frames of 10.5 units side by side');
		// The sine_3x3 wave: 36 dots are on across the eight frames (3+3+3+5+5+5+4+4+4 per dot).
		assert.strictEqual(svg.split('<circle').length - 1, 36);
		assert.strictEqual(dots.querySelectorAll('svg, circle').length, 0, 'no SVG in the DOM');
	});
});
