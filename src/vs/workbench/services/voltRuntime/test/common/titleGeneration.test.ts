/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveTitle } from '../../common/history/agentHistoryLog.js';
import { buildTitlePrompt, isNeutralTitle, isVagueMessage, sanitizeTitle, titleCommandFor } from '../../common/history/titleGeneration.js';

suite('Volt chat title generation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the first-line title drops attachment chips', () => {
		assert.strictEqual(deriveTitle('[Image #1: image.png] for this section i want tabs'), 'For this section i want tabs');
		assert.strictEqual(deriveTitle('[Image #1 "a.png" is saved at: /tmp/a.png]\nfix the border'), 'Fix the border');
	});

	test('the prompt carries the message without saved-at lines, and the attachment names', () => {
		const prompt = buildTitlePrompt('fix the border\n[Image #1 "shot.png" is saved at: /tmp/shot.png]', ['shot.png']);
		assert.ok(prompt.includes('User message:\nfix the border'));
		assert.ok(!prompt.includes('/tmp/shot.png'));
		assert.ok(prompt.endsWith('Attached: shot.png'));
	});

	test('a long message keeps its head and tail', () => {
		const prompt = buildTitlePrompt(`start ${'x'.repeat(10_000)} end`);
		assert.ok(prompt.includes('start'));
		assert.ok(prompt.includes('end'));
		assert.ok(prompt.length < 6000);
	});

	test('the prompt asks for a title that says what the task is', () => {
		const prompt = buildTitlePrompt('hi');
		assert.ok(prompt.includes('start with a verb (Fix, Add, Speed up, Refactor, Debug, Explain, Compare, Write)'));
		assert.ok(prompt.includes('3 to 7 words, under 50 characters, sentence case'));
		assert.ok(prompt.includes('title the main task (the first or the largest), not a list'));
		assert.ok(prompt.includes('"How the stash restores chats"'));
		assert.ok(prompt.includes('-> Fix doubled run command card borders'));
		assert.ok(prompt.includes('such as "Quick question"'));
	});

	test('a retry carries the first and the latest message, the latest with the room left', () => {
		const prompt = buildTitlePrompt(['hey\n[Image #1 "a.png" is saved at: /tmp/a.png]', 'skip', `the sidebar jumps ${'y'.repeat(10_000)} on finish`], ['b.png']);
		assert.ok(prompt.includes('First message:\nhey\n\nLatest message:\nthe sidebar jumps'));
		assert.ok(prompt.includes('on finish'));
		assert.ok(!prompt.includes('User message:'));
		assert.ok(!prompt.includes('skip'));
		assert.ok(!prompt.includes('/tmp/a.png'));
		assert.ok(prompt.endsWith('Attached: b.png'));
		assert.ok(prompt.length < 6000);
		assert.ok(buildTitlePrompt(['', 'fix it']).includes('First message:\n(no text)'));
	});

	test('a message of a few words is vague, and so is a neutral title', () => {
		assert.strictEqual(isVagueMessage('hi'), true);
		assert.strictEqual(isVagueMessage('[Image #1: shot.png] fix this'), true);
		assert.strictEqual(isVagueMessage('[Image #1 "a.png" is saved at: /tmp/a.png]\ncontinue please ?'), true);
		assert.strictEqual(isVagueMessage('fix the doubled card borders'), false);
		assert.strictEqual(isNeutralTitle('Quick question'), true);
		assert.strictEqual(isNeutralTitle(' quick question '), true);
		assert.strictEqual(isNeutralTitle('Fix doubled run command card borders'), false);
	});

	test('replies are cleaned into one short line', () => {
		assert.strictEqual(sanitizeTitle('"Run command card border fix."\n'), 'Run command card border fix');
		assert.strictEqual(sanitizeTitle('Title: **GitHub OAuth login**'), 'GitHub OAuth login');
		assert.strictEqual(sanitizeTitle('<think>hmm</think>\n\nci test hang'), 'Ci test hang');
		assert.strictEqual(sanitizeTitle('{"title":"Sidebar chat titles"}'), 'Sidebar chat titles');
		assert.strictEqual(sanitizeTitle('   \n'), undefined);
		assert.strictEqual(sanitizeTitle('New chat'), undefined);
		assert.strictEqual(sanitizeTitle('<traced_as_tool_call>'), undefined);
		assert.strictEqual(sanitizeTitle('<tool_call name="x"></tool_call>'), undefined);
		assert.strictEqual(sanitizeTitle('Fix <Button> focus ring'), 'Fix <Button> focus ring');
		const long = sanitizeTitle('word '.repeat(30))!;
		assert.ok(long.length <= 56 && long.length > 48, 'cut at 56 characters');
		assert.ok(long.endsWith('word…'), 'at a word boundary');
		assert.strictEqual(sanitizeTitle('Add GitHub OAuth login to the settings page header'), 'Add GitHub OAuth login to the settings page header');
	});

	test('only agents with a print mode get a title command', () => {
		assert.strictEqual(titleCommandFor('claude-code', undefined, 'p')?.[0], 'claude');
		assert.strictEqual(titleCommandFor('cursor-acp', 'agent', 'p')?.[0], 'agent');
		assert.strictEqual(titleCommandFor('codex', undefined, 'p')?.at(-1), 'p');
		assert.strictEqual(titleCommandFor('grok', undefined, 'p'), undefined);
	});

	test('a pinned text generation model reaches the CLI', () => {
		const claude = titleCommandFor('claude-code', undefined, 'p', 'sonnet') ?? [];
		assert.strictEqual(claude[claude.indexOf('--model') + 1], 'sonnet');
		assert.deepStrictEqual(titleCommandFor('codex', undefined, 'p', 'gpt-5')?.slice(-3), ['-m', 'gpt-5', 'p']);
		assert.deepStrictEqual(titleCommandFor('cursor-acp', undefined, 'p', 'gpt-5')?.slice(-3), ['--model', 'gpt-5', 'p']);
		assert.ok(!titleCommandFor('cursor-acp', undefined, 'p')?.includes('--model'));
	});
});
