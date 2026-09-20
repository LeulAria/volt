/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFileChangeBlock } from '../../browser/blocks/agentBlocks.js';
import {
	agentChangeKindFromVerb,
	collectLastTurnFileChanges,
	collectSessionFileChanges,
	IAgentChangeTranscriptMessage,
	normalizeAgentChangePath,
	sumAgentChangeStats,
} from '../../browser/review/agentSessionChanges.js';

suite('Agent session changes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes and classifies paths and verbs', () => {
		assert.strictEqual(normalizeAgentChangePath('./src\\app.ts'), 'src/app.ts');
		assert.strictEqual(agentChangeKindFromVerb('Created'), 'added');
		assert.strictEqual(agentChangeKindFromVerb('Deleted'), 'deleted');
		assert.strictEqual(agentChangeKindFromVerb('Edited'), 'modified');
	});

	test('keeps the first original and last modified for a file', () => {
		const messages: IAgentChangeTranscriptMessage[] = [
			{
				kind: 'agent',
				id: 'turn-1',
				segments: [{
					kind: 'block',
					block: createFileChangeBlock({
						id: 'a',
						path: 'src/a.ts',
						verb: 'Edited',
						original: 'one\n',
						modified: 'one\ntwo\n',
						additions: 1,
						deletions: 0,
					}),
				}],
			},
			{
				kind: 'user',
				segments: [],
			},
			{
				kind: 'agent',
				id: 'turn-2',
				segments: [{
					kind: 'block',
					block: createFileChangeBlock({
						id: 'b',
						path: 'src/a.ts',
						verb: 'Edited',
						original: 'one\ntwo\n',
						modified: 'one\ntwo\nthree\n',
						additions: 1,
						deletions: 0,
					}),
				}],
			},
		];
		const files = collectSessionFileChanges(messages);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].path, 'src/a.ts');
		assert.strictEqual(files[0].original, 'one\n');
		assert.strictEqual(files[0].modified, 'one\ntwo\nthree\n');
		assert.strictEqual(files[0].turnId, 'turn-2');
		assert.ok(files[0].additions >= 1);
	});

	test('marks a created file as added even after later edits', () => {
		const messages: IAgentChangeTranscriptMessage[] = [{
			kind: 'agent',
			id: 'turn-1',
			segments: [
				{
					kind: 'block',
					block: createFileChangeBlock({
						id: 'a',
						path: 'src/new.ts',
						verb: 'Created',
						modified: 'export const n = 1;\n',
						additions: 1,
						deletions: 0,
					}),
				},
				{
					kind: 'block',
					block: createFileChangeBlock({
						id: 'b',
						path: 'src/new.ts',
						verb: 'Edited',
						original: 'export const n = 1;\n',
						modified: 'export const n = 2;\n',
						additions: 1,
						deletions: 1,
					}),
				},
			],
		}];
		const files = collectSessionFileChanges(messages);
		assert.strictEqual(files[0].kind, 'added');
	});

	test('collects only the last assistant turn that edited files', () => {
		const messages: IAgentChangeTranscriptMessage[] = [
			{
				kind: 'agent',
				id: 'turn-1',
				segments: [{
					kind: 'block',
					block: createFileChangeBlock({
						id: 'a',
						path: 'src/old.ts',
						verb: 'Edited',
						additions: 4,
						deletions: 1,
					}),
				}],
			},
			{
				kind: 'agent',
				id: 'turn-2',
				segments: [{
					kind: 'block',
					block: createFileChangeBlock({
						id: 'b',
						path: 'src/new.ts',
						verb: 'Created',
						additions: 2,
						deletions: 0,
					}),
				}],
			},
		];
		const last = collectLastTurnFileChanges(messages);
		assert.strictEqual(last.length, 1);
		assert.strictEqual(last[0].path, 'src/new.ts');
		assert.strictEqual(last[0].kind, 'added');
		const all = collectSessionFileChanges(messages);
		assert.strictEqual(all.length, 2);
		assert.deepStrictEqual(sumAgentChangeStats(all), { files: 2, additions: 6, deletions: 1 });
	});

	test('ignores messages without file blocks', () => {
		assert.deepStrictEqual(collectSessionFileChanges([{ kind: 'agent', segments: [] }]), []);
		assert.deepStrictEqual(collectLastTurnFileChanges([{ kind: 'user' }]), []);
	});
});
