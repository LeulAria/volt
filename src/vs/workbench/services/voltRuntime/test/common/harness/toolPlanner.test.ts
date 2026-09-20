/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { detectSignals } from '../../../common/harness/intake.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';
import { planTools, speculativeReads } from '../../../common/harness/toolPlanner.js';

suite('Volt tool planner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('explore ranks read/search above edit', () => {
		const text = 'add a logout button to the header';
		const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
		const plan = planTools(intent, analyzeTask(text, intent), 'explore', detectSignals(text, intent));
		const names = plan.hints.map(hint => hint.name);
		assert.ok(names.indexOf('read_file') < names.indexOf('edit_file') || !names.includes('edit_file'));
		assert.ok(plan.suggested.includes('read_file') || plan.suggested.includes('grep'));
	});

	test('a researched question ranks web tools first', () => {
		const text = 'tell me each model and their price give me in a table';
		const intent = classifyIntent(text, 'ask');
		const plan = planTools(intent, analyzeTask(text, intent), 'research', detectSignals(text, intent));
		assert.ok(plan.suggested.includes('web_search'));
		assert.ok(plan.hints.find(hint => hint.name === 'web_search')!.score >= plan.hints.find(hint => hint.name === 'read_file')!.score);
	});

	test('an implement step still sees web tools when the work depends on a lookup', () => {
		const text = 'implement login using the official docs';
		const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
		const plan = planTools(intent, analyzeTask(text, intent), 'implement', detectSignals(text, intent));
		assert.ok(plan.hints.some(hint => hint.name === 'web_search'));
		assert.ok(plan.suggested.includes('web_search'));
	});

	test('speculative reads are only the files the user named', () => {
		const text = 'rename foo in utils.ts';
		const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
		const plan = planTools(intent, analyzeTask(text, intent), 'implement', detectSignals(text, intent), ['src/utils.ts', 'please also']);
		assert.deepStrictEqual(speculativeReads(plan).map(call => call.args.path), ['src/utils.ts']);
	});
});
