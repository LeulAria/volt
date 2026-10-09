/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { planDocument, planFileName, planModeInstruction, planProposalFromArgs, planSlug, withPlanModeInstruction } from '../../common/plans.js';

suite('Agent plans', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('propose_plan and create_plan arguments read the same way', () => {
		assert.deepStrictEqual(planProposalFromArgs({ title: 'Dark mode', plan: '  ## Steps\n1. Add a toggle  ', open_questions: ['Follow the system setting?', '  ', 3] }), {
			title: 'Dark mode',
			markdown: '## Steps\n1. Add a toggle',
			openQuestions: ['Follow the system setting?'],
		});
		assert.deepStrictEqual(planProposalFromArgs({ name: 'Cursor plan', markdown: 'Do it' }), { title: 'Cursor plan', markdown: 'Do it', openQuestions: [] });
		assert.deepStrictEqual(planProposalFromArgs(undefined), { title: undefined, markdown: '', openQuestions: [] });
	});

	test('a plan is saved under a slug of its title', () => {
		assert.strictEqual(planSlug('Add dark mode toggle!'), 'add-dark-mode-toggle');
		assert.strictEqual(planSlug('  --  '), 'plan');
		assert.strictEqual(planSlug(undefined), 'plan');
		assert.strictEqual(planSlug('a'.repeat(100)).length, 60);
		assert.strictEqual(planFileName('Dark mode'), 'dark-mode.md');
		assert.strictEqual(planFileName('Dark mode', new Set(['dark-mode.md'])), 'dark-mode-2.md');
		assert.strictEqual(planFileName('Dark mode', new Set(['dark-mode.md', 'dark-mode-2.md'])), 'dark-mode-3.md');
	});

	test('the document has the title, the plan and the open questions', () => {
		assert.strictEqual(planDocument({ title: 'Dark mode', markdown: 'Add a toggle.', openQuestions: ['Follow the system?'] }), '# Dark mode\n\nAdd a toggle.\n\n## Open questions\n- Follow the system?\n');
		// A plan that already starts with its own heading is not given a second one.
		assert.strictEqual(planDocument({ title: 'Dark mode', markdown: '# Dark mode plan\n\nSteps', openQuestions: [] }), '# Dark mode plan\n\nSteps\n');
	});

	test('plan-mode turns carry the instruction once', () => {
		const text = withPlanModeInstruction('Plan the export');
		assert.ok(text.startsWith('Plan the export\n\n'));
		assert.ok(text.includes('propose_plan'));
		assert.strictEqual(withPlanModeInstruction(text), text);
		assert.ok(planModeInstruction().includes('Then stop'));
	});
});
