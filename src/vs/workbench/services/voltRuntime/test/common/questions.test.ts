/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { answeredQuestions, cursorAskQuestionResult, elicitationResult, elicitationToQuestions, IAgentQuestionResponse, parseQuestionDraft, questionResponseText } from '../../common/questions.js';

suite('Agent questions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const draft = parseQuestionDraft({
		title: 'Game setup',
		questions: [
			{ id: 'mode', prompt: 'Who plays?', options: [{ id: 'hot', label: 'Two players' }, { id: 'cpu', label: 'Vs computer' }] },
			{ id: 'extras', prompt: 'Which extras?', allow_multiple: true, options: [{ id: 'score', label: 'Scoreboard' }, { id: 'strike', label: 'Win line' }] },
		],
	})!;

	const answered: IAgentQuestionResponse = {
		outcome: 'answered',
		answers: [
			{ questionId: 'mode', optionIds: ['cpu'] },
			{ questionId: 'extras', optionIds: ['score', 'strike'], other: 'Responsive' },
		],
		note: 'Chalk font please',
	};

	test('parses the ask_question tool input', () => {
		assert.strictEqual(draft.title, 'Game setup');
		assert.deepStrictEqual(draft.questions.map(q => [q.id, q.multiple, q.options.length, q.allowOther]), [['mode', false, 2, true], ['extras', true, 2, true]]);
		assert.strictEqual(parseQuestionDraft({ questions: [] }), undefined);
		assert.strictEqual(parseQuestionDraft('nope'), undefined);
	});

	test('accepts Cursor\'s ask_question shape and fills missing ids', () => {
		const cursor = parseQuestionDraft({ toolCallId: 't', questions: [{ prompt: 'Color?', options: [{ label: 'Red' }, { label: 'Red' }], allowMultiple: true }] })!;
		assert.strictEqual(cursor.questions[0].id, 'q1');
		assert.strictEqual(cursor.questions[0].multiple, true);
		assert.notStrictEqual(cursor.questions[0].options[0].id, cursor.questions[0].options[1].id);
	});

	test('the Answers card joins multi-select picks and Other like Cursor', () => {
		assert.deepStrictEqual(answeredQuestions(draft, answered), [
			{ question: 'Who plays?', answer: 'Vs computer' },
			{ question: 'Which extras?', answer: 'Scoreboard, Win line, Responsive' },
		]);
		assert.deepStrictEqual(answeredQuestions(draft, { outcome: 'skipped', answers: [] }), []);
	});

	test('tool text carries every answer and the extra details', () => {
		const text = questionResponseText(draft, answered);
		assert.ok(text.includes('Who plays? → Vs computer'));
		assert.ok(text.includes('Which extras? → Scoreboard, Win line, Responsive'));
		assert.ok(text.includes('Additional details from the user: Chalk font please'));
		assert.ok(questionResponseText(draft, { outcome: 'skipped', answers: [] }).includes('skipped'));
	});

	test('Cursor extension result uses option ids and rides free text along', () => {
		const result = cursorAskQuestionResult(draft, answered);
		assert.deepStrictEqual(result, {
			outcome: {
				outcome: 'answered',
				answers: [
					{ questionId: 'mode', selectedOptionIds: ['cpu'] },
					{ questionId: 'extras', selectedOptionIds: ['score', 'strike', 'Other: Responsive', 'Additional details: Chalk font please'] },
				],
			},
		});
		assert.deepStrictEqual(cursorAskQuestionResult(draft, { outcome: 'cancelled', answers: [] }), { outcome: { outcome: 'cancelled' } });
	});

	test('reads claude-agent-acp\'s AskUserQuestion form and answers it', () => {
		const form = elicitationToQuestions({
			mode: 'form',
			message: 'Please answer the following questions.',
			requestedSchema: {
				type: 'object',
				properties: {
					question_0: { type: 'string', title: 'Mode', description: 'Who plays?', oneOf: [{ const: 'Two players', title: 'Two players' }, { const: 'Vs computer', title: 'Vs computer' }] },
					question_0_custom: { type: 'string', title: 'Other' },
					question_1: { type: 'array', description: 'Extras?', items: { anyOf: [{ const: 'Score', title: 'Score' }, { const: 'Undo', title: 'Undo' }] } },
					question_1_custom: { type: 'string', title: 'Other' },
				},
			},
		})!;
		assert.deepStrictEqual(form.questions.map(q => [q.id, q.prompt, q.multiple, q.allowOther, q.options.map(o => o.id)]), [
			['question_0', 'Who plays?', false, true, ['Two players', 'Vs computer']],
			['question_1', 'Extras?', true, true, ['Score', 'Undo']],
		]);
		const result = elicitationResult(form, {
			outcome: 'answered',
			answers: [{ questionId: 'question_0', optionIds: ['Vs computer'] }, { questionId: 'question_1', optionIds: ['Undo'], other: 'Hints' }],
			note: 'Fast please',
		});
		assert.deepStrictEqual(result, { action: 'accept', content: { question_0: 'Vs computer', question_1: ['Undo'], question_1_custom: 'Hints\nFast please' } });
		assert.deepStrictEqual(elicitationResult(form, { outcome: 'skipped', answers: [] }), { action: 'decline' });
	});

	test('leaves forms with free-form fields to the agent', () => {
		assert.strictEqual(elicitationToQuestions({ mode: 'form', message: 'Token?', requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } }), undefined);
		assert.strictEqual(elicitationToQuestions({ mode: 'url', url: 'https://x' }), undefined);
	});
});
