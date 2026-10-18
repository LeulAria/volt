/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { cueSimilarity, experienceRecord, lessonMemory, MAX_PROJECT_LESSONS, parseExperience, shouldReflect } from '../../../common/harness/experience.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import { IVoltMemory, renderMemoryIndex } from '../../../common/memory/voltMemory.js';

suite('Experience reflector', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const entry = [
		'<experience>',
		'cue: running the unit tests of this repository after changing a browser/ file',
		'lesson: in this project the tests run with `npm run test-node -- --grep <name>`; plain `npm test` needs an Electron build and fails with "out/ missing".',
		'evidence: steps 4-6 failed with "out/ missing"; step 9 ran test-node and passed',
		'confidence: high, the same command passed after two failures',
		'</experience>',
	].join('\n');

	test('only a substantial run that changed things is reflected on', () => {
		assert.strictEqual(shouldReflect({ outcome: 'done', toolCalls: 20, toolErrors: 0, writes: true }), true);
		assert.strictEqual(shouldReflect({ outcome: 'done', toolCalls: 8, toolErrors: 3, writes: true }), true, 'got past errors');
		assert.strictEqual(shouldReflect({ outcome: 'done', toolCalls: 5, toolErrors: 0, writes: true }), false, 'too short to teach anything');
		assert.strictEqual(shouldReflect({ outcome: 'fail', toolCalls: 40, toolErrors: 9, writes: true }), false);
		assert.strictEqual(shouldReflect({ outcome: 'done', toolCalls: 40, toolErrors: 0, writes: false }), false, 'Ask mode');
	});

	test('an entry needs a cue, a lesson, evidence and more than low confidence; NO_ENTRY keeps nothing', () => {
		const parsed = parseExperience(`Reading the record...\n${entry}`);
		assert.ok(parsed);
		assert.ok(parsed.lesson.includes('npm run test-node'));
		assert.strictEqual(parsed.confidence, 'high');
		assert.ok(parsed.evidence.startsWith('steps 4-6'));
		assert.strictEqual(parseExperience('NO_ENTRY'), undefined);
		assert.strictEqual(parseExperience(entry.replace(/^evidence:.*$/m, '')), undefined, 'no evidence, no lesson');
		assert.strictEqual(parseExperience(entry.replace('confidence: high', 'confidence: low')), undefined, 'a guess is worse than nothing');
	});

	test('the lesson becomes a project memory; the same cue updates it; a full library adds nothing', () => {
		const experience = parseExperience(entry)!;
		const draft = lessonMemory(experience, [], Date.UTC(2026, 9, 18));
		assert.ok(draft);
		assert.ok(draft.name.startsWith('lesson-'));
		assert.strictEqual(draft.scope, 'project');
		assert.ok(draft.description.startsWith('When running the unit tests'));
		assert.ok(draft.body.includes('Evidence (a run on 2026-10-18)'));
		const saved: IVoltMemory = { name: draft.name, description: draft.description, type: 'project', body: draft.body, scope: 'project' };
		assert.strictEqual(lessonMemory(experience, [saved])?.name, draft.name, 'updates the lesson with the same cue');
		const full: IVoltMemory[] = Array.from({ length: MAX_PROJECT_LESSONS }, (_, i) => ({ ...saved, name: `lesson-other-${i}`, description: `When something unrelated number ${i} happens` }));
		assert.strictEqual(lessonMemory({ ...experience, cue: 'deploying the docs site to staging' }, full), undefined);
		assert.ok(cueSimilarity('running the unit tests', 'when running unit tests of the repo') >= 0.7);
	});

	test('learned lessons come after the notes people saved in the memory index', () => {
		const lines = renderMemoryIndex([
			{ name: 'lesson-build', description: 'When building', type: 'project', body: 'x', scope: 'project' },
			{ name: 'zz-user-note', description: 'A note', type: 'user', body: 'y', scope: 'user' },
		]);
		assert.ok(lines[0].includes('zz-user-note') && lines[1].includes('lesson-build'));
	});

	test('the record keeps the request, every error in full, and the answer', () => {
		const messages: INativeLoopMessage[] = [
			{ role: 'user', content: 'fix the failing test', turn: true },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'shell', args: { command: 'npm test' } }] },
			{ role: 'tool', content: 'Error: out/ missing', callId: 'a', name: 'shell', isError: true },
			{ role: 'assistant', content: 'Fixed: the test now passes.' },
		];
		const record = experienceRecord(messages, 1);
		assert.ok(record.includes('fix the failing test'));
		assert.ok(record.includes('call shell {"command":"npm test"}'));
		assert.ok(record.includes('ERROR from shell: Error: out/ missing'));
		assert.ok(record.endsWith('Fixed: the test now passes.'));
	});
});
