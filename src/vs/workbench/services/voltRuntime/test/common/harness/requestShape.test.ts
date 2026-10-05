/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { detectRequestShape, framingForShape, isThinAnswer, matchesRequestedForm, needsResearch } from '../../../common/harness/requestShape.js';

suite('Volt request shape', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a closed question is brief prose with no lookup', () => {
		const shape = detectRequestShape('what is 2+2');
		assert.strictEqual(shape.form, 'prose');
		assert.strictEqual(shape.lookup, false);
		assert.strictEqual(shape.enumerate, false);
		assert.strictEqual(shape.cite, false);
		assert.strictEqual(shape.depth, 'brief');
		assert.strictEqual(needsResearch(shape), false);
	});

	test('a current-fact question wants a lookup without becoming a research project', () => {
		const shape = detectRequestShape('how much does this cost right now');
		assert.strictEqual(shape.lookup, true);
		assert.strictEqual(shape.depth, 'brief');
		assert.strictEqual(needsResearch(shape), false);
	});

	test('each/every plus a table is a researched answer', () => {
		const shape = detectRequestShape('tell me each model and their price give me in a table');
		assert.strictEqual(shape.form, 'table');
		assert.strictEqual(shape.enumerate, true);
		assert.strictEqual(shape.lookup, true);
		assert.strictEqual(shape.depth, 'full');
		assert.strictEqual(needsResearch(shape), true);
	});

	test('official docs on a coding ask is a cited lookup', () => {
		const shape = detectRequestShape('implement login using the official docs', { coding: true });
		assert.strictEqual(shape.lookup, true);
		assert.strictEqual(shape.cite, true);
		assert.strictEqual(needsResearch(shape), true);
	});

	test('a table of every item is a table even without "in a table"', () => {
		const shape = detectRequestShape('add a table of all routes to the README', { coding: true, referencesWorkspace: true });
		assert.strictEqual(shape.form, 'table');
		assert.strictEqual(shape.enumerate, true);
	});

	test('research framing never forbids writes when the run may edit', () => {
		const shape = detectRequestShape('implement this using the official docs', { coding: true });
		const writing = framingForShape(shape, true, { allowWrites: true }) ?? '';
		assert.ok(/look|search|fetch/i.test(writing));
		assert.ok(!/Do not modify the workspace/.test(writing));
		const reading = framingForShape(shape, true, { allowWrites: false }) ?? '';
		assert.ok(/Do not modify the workspace/.test(reading));
	});

	test('product nouns and file names in a coding task are not research', () => {
		assert.strictEqual(detectRequestShape('Build design/pricing.png as a static page. It should match the reference image closely.', { referencesWorkspace: true, coding: true }).lookup, false);
		assert.strictEqual(detectRequestShape('add a weather widget to src/home.tsx', { referencesWorkspace: true, coding: true }).lookup, false);
		assert.strictEqual(detectRequestShape('upgrade react in this repo to the latest version', { referencesWorkspace: true, coding: true }).lookup, true);
		assert.strictEqual(detectRequestShape('how much is a nissan kicks in the UAE').lookup, true);
	});

	test('a workspace list is not a web lookup', () => {
		const shape = detectRequestShape('list all files in src', { referencesWorkspace: true, coding: false });
		assert.strictEqual(shape.form, 'list');
		assert.strictEqual(shape.enumerate, true);
		assert.strictEqual(shape.lookup, false);
	});

	test('maths with "each" or a table is worked out, not researched', () => {
		const shape = detectRequestShape('Answer without running code: (a) the exact value of 1^3 + 2^3 + ... + 100^3; (b) the exact roots of 3x^2 - 7x + 2 = 0. Show each derivation briefly and put the final answers in a table.');
		assert.strictEqual(shape.form, 'table');
		assert.strictEqual(shape.lookup, false);
		assert.strictEqual(needsResearch(shape), false);
		assert.strictEqual(detectRequestShape('What is the probability that two random points on a circle are closer than 1?').lookup, false);
		// An explicit lookup still wins.
		assert.strictEqual(detectRequestShape('Solve this and cite the official docs for each formula').lookup, true);
	});

	test('matches the asked form, not a paragraph', () => {
		assert.strictEqual(matchesRequestedForm('Prices vary by dealer.', 'table'), false);
		assert.strictEqual(matchesRequestedForm('| A | B |\n| --- | --- |\n| 1 | 2 |', 'table'), true);
		assert.strictEqual(matchesRequestedForm('- one\n- two\n- three', 'list'), true);
		assert.strictEqual(isThinAnswer('Prices vary.', { form: 'prose', enumerate: true, lookup: true, cite: false, depth: 'full' }), true);
	});
});
