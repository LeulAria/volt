/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { summarizeReleaseNotes } from '../../common/agentUpdateNotes.js';

suite('Agent update notes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads GitHub generated notes', () => {
		const body = [
			'Volt 0.0.2 (`abcdef12`)',
			'',
			'## What\'s Changed',
			'* fix(release): unblock nightly browser tests by @maria-rcks in https://github.com/LeulAria/VOLT/pull/16515',
			'* feat(preview): run the **browser** on the `environment` server by @a in https://github.com/LeulAria/VOLT/pull/15328',
			'  * nested detail',
			'',
			'**Full Changelog**: https://github.com/LeulAria/VOLT/compare/v0.0.1...v0.0.2',
		].join('\n');
		assert.deepStrictEqual(summarizeReleaseNotes(body), {
			items: [
				'fix(release): unblock nightly browser tests by @maria-rcks in #16515',
				'feat(preview): run the browser on the environment server by @a in #15328',
			],
			total: 2,
		});
	});

	test('reads the nightly commit list and caps the items', () => {
		const body = ['### Latest commits', '', '- one (1a2b3c4)', '- two [docs](https://x.y) (1a2b3c4d)', '- three'].join('\n');
		assert.deepStrictEqual(summarizeReleaseNotes(body, 2), { items: ['one', 'two docs'], total: 3 });
	});

	test('handles missing notes', () => {
		assert.deepStrictEqual(summarizeReleaseNotes(undefined), { items: [], total: 0 });
		assert.deepStrictEqual(summarizeReleaseNotes('Just a paragraph.'), { items: [], total: 0 });
	});
});
