/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { orchHeadline } from '../../../common/orchestration/orchestratorViews.js';

suite('Orchestrator row headline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a subagent report shows the sentence under "## Outcome", not the heading', () => {
		assert.strictEqual(orchHeadline('## Outcome\nDone: the project root has README.md and src/.\n\n## Evidence\n- ls'), 'Done: the project root has README.md and src/.');
		assert.strictEqual(orchHeadline('**Outcome:**\nPartly done.'), 'Partly done.');
	});

	test('a preamble before the report gives way to the sentence under "Outcome"', () => {
		// Reports seen live from Haiku 5.5 subagents: what it was about to do, then the report.
		assert.strictEqual(orchHeadline('Running the ping command now; it only sends packets to localhost and changes no files.\n\n## Outcome\nDone. `ping -c 20 127.0.0.1 | tail -1` printed the summary line.\n\n## Findings\n- x'), 'Done. ping -c 20 127.0.0.1 | tail -1 printed the summary line.');
		assert.strictEqual(orchHeadline('I will check.\n**Outcome:**\nPartly done.'), 'Partly done.');
		// No Outcome section: the first sentence still leads.
		assert.strictEqual(orchHeadline('All good.\n\n## Evidence\n- ls'), 'All good.');
		// An Outcome heading with nothing under it: the preamble is better than the heading.
		assert.strictEqual(orchHeadline('Checked the files.\n## Outcome'), 'Checked the files.');
	});

	test('a report of headings alone still shows something', () => {
		assert.strictEqual(orchHeadline('## Outcome'), 'Outcome');
	});

	test('markdown marks go, underscores inside names stay', () => {
		assert.strictEqual(orchHeadline('Fixed `apply_discount` in **math_utils.ts**'), 'Fixed apply_discount in math_utils.ts');
		assert.strictEqual(orchHeadline('It was _not_ needed'), 'It was not needed');
		assert.strictEqual(orchHeadline('- first item'), 'first item');
	});

	test('nothing to show', () => {
		assert.strictEqual(orchHeadline(undefined), undefined);
		assert.strictEqual(orchHeadline('\n  \n'), undefined);
	});

	test('long lines are cut', () => {
		const line = orchHeadline('x'.repeat(300))!;
		assert.strictEqual(line.length, 140);
		assert.ok(line.endsWith('…'));
	});
});
