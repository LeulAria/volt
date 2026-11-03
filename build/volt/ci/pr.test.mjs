/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkBody, checkTitle, descriptionText, sizeOf } from './pr.mjs';

test('conventional titles pass', () => {
	for (const title of [
		'feat(new-chat): show recent projects under the composer',
		'fix: keep the composer focused',
		'chore(release): Volt 0.0.5',
		'build(deps): Bump actions/checkout from 5 to 7',
		'refactor(agent-server)!: drop the legacy transcript renderer',
		'ci(pr-review): review only the new commits',
		'Revert "feat(agent): a change"',
	]) {
		assert.deepEqual(checkTitle(title), [], title);
	}
});

test('other titles fail with a reason', () => {
	assert.equal(checkTitle('Drag chats into order, Draft above Pinned').length, 1);
	assert.equal(checkTitle('feature: add a thing').length, 1);
	assert.equal(checkTitle('fix(Agent): uppercase scope').length, 1);
	assert.equal(checkTitle('fix:no space').length, 1);
	assert.match(checkTitle('fix: ends with a period.')[0], /period/);
	assert.match(checkTitle(`fix: ${'x'.repeat(120)}`)[0], /characters/);
	assert.match(checkTitle('feat: WIP the new thing')[0], /draft/);
	assert.match(checkTitle('[WIP] feat: the new thing').join(' '), /draft/);
});

test('the template alone is not a description', () => {
	const template = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', '.github', 'pull_request_template.md'), 'utf8');
	assert.equal(descriptionText(template), '');
	assert.equal(checkBody(template).length, 1);
	assert.equal(checkBody('').length, 1);
	assert.deepEqual(checkBody(`${template}\n\nFixes the composer losing focus after a send. Tested by sending twice.`), []);
});

test('size excludes tests, lockfiles and generated files', () => {
	const file = (/** @type {string} */ filename, /** @type {number} */ additions, deletions = 0) => ({ filename, additions, deletions });
	assert.deepEqual(sizeOf([file('src/a.ts', 5, 2)]), { label: 'size:XS', lines: 7, counted: 1, excluded: 0 });
	assert.deepEqual(sizeOf([file('src/a.ts', 20), file('src/test/common/a.test.ts', 900), file('package-lock.json', 4000)]), { label: 'size:S', lines: 20, counted: 1, excluded: 2 });
	assert.equal(sizeOf([file('src/a.ts', 99)]).label, 'size:M');
	assert.equal(sizeOf([file('src/a.ts', 100)]).label, 'size:L');
	assert.equal(sizeOf([file('src/a.ts', 999)]).label, 'size:XL');
	assert.equal(sizeOf([file('src/a.ts', 1000)]).label, 'size:XXL');
	// Only tests: sized by the tests.
	assert.deepEqual(sizeOf([file('src/vs/x/test/node/a.test.ts', 40)]), { label: 'size:M', lines: 40, counted: 0, excluded: 1 });
});
