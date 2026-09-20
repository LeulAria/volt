/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { applyPatch, draftMission, evaluateMissionGate, IMissionTask, submitPlan } from '../../../common/harness/mission.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';

suite('Volt mission', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('draft assigns each assertion to exactly one work owner', () => {
		const intel = analyzeTask('add login and add signup and make sure the tests pass', classifyIntent('add login and add signup and make sure the tests pass', 'multitask', { hasWorkspace: true }));
		const draft = draftMission('m1', intel);
		const submitted = submitPlan(draft);
		assert.ok(!('error' in submitted), 'error' in submitted ? submitted.error : '');
		const work = submitted.tasks.filter(task => task.type === 'work');
		const counts = new Map<string, number>();
		for (const task of work) {
			for (const target of task.targets) {
				counts.set(target, (counts.get(target) ?? 0) + 1);
			}
		}
		assert.ok([...counts.values()].every(count => count === 1));
	});

	test('submitPlan refuses over-covered assertions', () => {
		const intel = analyzeTask('add login and make sure the tests pass', classifyIntent('add login and make sure the tests pass', 'multitask', { hasWorkspace: true }));
		const draft = draftMission('m1', intel);
		const patched = applyPatch(draft, {
			add: [{ id: 'T99', type: 'work', body: 'also do it', targets: draft.tasks[0]?.targets ?? ['c0'], dependsOn: [] }],
		}, 'duplicate owner');
		const submitted = submitPlan(patched);
		assert.ok('error' in submitted);
		assert.ok(/Over-covered/.test(submitted.error));
	});

	test('AND-gate fails when a validator is missing or dissenting', () => {
		const intel = analyzeTask('add login and make sure the tests pass', classifyIntent('add login and make sure the tests pass', 'multitask', { hasWorkspace: true }));
		const draft = draftMission('m1', intel);
		const withGate = applyPatch(draft, {
			add: [
				{ id: 'V1', type: 'validate', body: 'check tests', targets: ['c0'], dependsOn: ['T1'] },
				{ id: 'G1', type: 'gate', body: 'seal', targets: ['c0'], dependsOn: ['V1'] },
			],
		}, 'validators');
		const gate = withGate.tasks.find(task => task.id === 'G1')!;
		assert.deepStrictEqual(evaluateMissionGate(withGate, gate), { ok: false, missing: [], dissent: ['c0'] });

		const passed: IMissionTask = { ...withGate.tasks.find(task => task.id === 'V1')!, status: 'passed' };
		const sealed = { ...withGate, tasks: withGate.tasks.map(task => task.id === 'V1' ? passed : task) };
		assert.deepStrictEqual(evaluateMissionGate(sealed, gate), { ok: true, missing: [], dissent: [] });
	});
});
