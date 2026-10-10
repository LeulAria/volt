/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildDictationPrompt, cleanDictationReply, DICTATION_SYSTEM_PROMPT, dictationReplyIsComplete } from '../../common/prediction/dictationCleanup.js';
import { PREDICTOR_SKILL, predictorPrimer, predictorRequest, PredictorTask } from '../../common/prediction/predictorSkill.js';

suite('Volt prediction: the predictor agent skill', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every task has its own section', () => {
		const tasks: PredictorTask[] = ['code', 'writing', 'composer', 'next-edit', 'voice'];
		for (const task of tasks) {
			assert.ok(PREDICTOR_SKILL.includes(`<task>${task}</task>`), task);
		}
	});

	test('a request is the task and its context, without the rules the skill holds', () => {
		const text = predictorRequest('code', [
			{ role: 'system', content: 'RULES' },
			{ role: 'user', content: 'CONTEXT' },
		]);
		assert.strictEqual(text, '<task>code</task>\n\nCONTEXT');
	});

	test('the primer teaches the skill and asks for a one-word reply', () => {
		const primer = predictorPrimer();
		assert.ok(primer.startsWith(PREDICTOR_SKILL));
		assert.ok(primer.endsWith('Reply with exactly: ready'));
	});
});

suite('Volt prediction: dictation cleanup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the prompt carries the draft before the cursor when there is one', () => {
		const [system, user] = buildDictationPrompt({ transcript: ' fix it ', before: 'Then ' });
		assert.strictEqual(system.content, DICTATION_SYSTEM_PROMPT);
		assert.ok(user.content.includes('## Text before the cursor\nThen '));
		assert.ok(user.content.includes('## Transcript\nfix it'));
		assert.ok(!buildDictationPrompt({ transcript: 'fix it' })[1].content.includes('Text before'));
	});

	test('a reply is complete once the text tag closes', () => {
		assert.strictEqual(dictationReplyIsComplete('<text>So'), false);
		assert.strictEqual(dictationReplyIsComplete('<text>So.</text>'), true);
	});

	test('the tagged text replaces the transcript', () => {
		assert.strictEqual(cleanDictationReply('<text>So can you fix the bug?</text>', 'um so can you fix the the bug'), 'So can you fix the bug?');
	});

	test('an untagged reply is used as it is, without quotes around it', () => {
		assert.strictEqual(cleanDictationReply('Run the tests again.', 'run the tests again'), 'Run the tests again.');
		assert.strictEqual(cleanDictationReply('"Fix the build."', 'fix the build'), 'Fix the build.');
	});

	test('a reply about the task is dropped, unless the developer said those words', () => {
		assert.strictEqual(cleanDictationReply('Sure, here is the cleaned text.', 'fix the bug'), undefined);
		assert.strictEqual(cleanDictationReply('<text>Okay, ship it.</text>', 'okay ship it'), 'Okay, ship it.');
	});

	test('nothing but fillers cleans up to nothing; a long transcript never does', () => {
		assert.strictEqual(cleanDictationReply('<text></text>', 'um uh'), '');
		assert.strictEqual(cleanDictationReply('<text></text>', 'please run the whole test suite now'), undefined);
	});

	test('an answer to the transcript is not a cleanup', () => {
		assert.strictEqual(cleanDictationReply(`<text>${'Two plus two is four. '.repeat(10)}</text>`, 'what is two plus two'), undefined);
	});
});
