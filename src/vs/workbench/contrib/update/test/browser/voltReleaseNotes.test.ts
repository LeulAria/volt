/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatVoltReleaseDate, parseVoltReleaseNotes, renderVoltReleaseNotesBody, voltReleaseNotesFileVersion } from '../../browser/voltReleaseNotes.js';

const SPARKLE = String.fromCodePoint(0x2726);

const NOTES = [
	'Volt 0.0.6 is released: a headline.',
	'',
	`${SPARKLE} https://github.com/LeulAria/volt`,
	'',
	'+ first change',
	'+ second change',
	'',
	'---',
	'',
	'## Added',
	'',
	'- Everything.',
].join('\n');

suite('Volt release notes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('splits the summary, its link lines and the details at the first ---', () => {
		const parts = parseVoltReleaseNotes(NOTES);
		assert.strictEqual(parts.lead, 'Volt 0.0.6 is released: a headline.');
		assert.deepStrictEqual(parts.links, ['https://github.com/LeulAria/volt']);
		assert.strictEqual(parts.summary, '+ first change\n+ second change');
		assert.strictEqual(parts.details, '## Added\n\n- Everything.');
	});

	test('drops the fetched title and the publish header, keeping its commit', () => {
		const old = parseVoltReleaseNotes(`# Volt 0.0.5\n\nVolt 0.0.5 (\`58a45b6a\`)\n\n${NOTES}`);
		assert.strictEqual(old.commit, '58a45b6a');
		assert.strictEqual(old.lead, 'Volt 0.0.6 is released: a headline.');
		const current = parseVoltReleaseNotes(`Volt 0.0.6 | Nov 4, 2026 | \`abcdef12\`\n\n${NOTES}`);
		assert.strictEqual(current.commit, 'abcdef12');
		assert.strictEqual(current.lead, 'Volt 0.0.6 is released: a headline.');
	});

	test('notes without a summary are all details; a --- under text is a heading, not the divider', () => {
		const parts = parseVoltReleaseNotes('Some text\n---\n\n## Highlights\n\n```\n---\n```\n');
		assert.strictEqual(parts.lead, '');
		assert.strictEqual(parts.summary, '');
		assert.ok(parts.details.startsWith('Some text\n---'));
	});

	test('reads the version from a notes file name and formats the date', () => {
		assert.strictEqual(voltReleaseNotesFileVersion('/repo/docs/release-notes/0.0.6.md'), '0.0.6');
		assert.strictEqual(voltReleaseNotesFileVersion('/repo/docs/release-notes/0.0.7-beta.1.md'), '0.0.7-beta.1');
		assert.strictEqual(voltReleaseNotesFileVersion('/repo/README.md'), undefined);
		assert.strictEqual(formatVoltReleaseDate('2026-10-31T11:30:57Z', 'en-US'), 'Oct 31, 2026');
		assert.strictEqual(formatVoltReleaseDate(undefined, 'en-US'), undefined);
	});

	test('the page draws the base version and escapes what it shows', () => {
		const parts = parseVoltReleaseNotes(NOTES);
		const html = renderVoltReleaseNotesBody({ version: '0.0.7-beta.1', url: 'https://example.com/"x"' }, parts, { lead: '<p>lead</p>', summary: '<ul></ul>', details: '<h2>Added</h2>' }, undefined, { draft: 'Draft', details: 'Details', viewOnGitHub: 'View on GitHub' });
		assert.ok(html.includes('data-glyphs="0.0.7"'));
		assert.ok(html.includes('BETA'));
		assert.ok(html.includes('<span class="date">Draft</span>'));
		assert.ok(html.includes('href="https://example.com/&quot;x&quot;"'));
		assert.ok(html.indexOf('volt-release-link') < html.indexOf('<ul></ul>'), 'the link sits between the headline and the list');
	});
});
