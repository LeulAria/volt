/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveTitle } from '../../common/history/agentHistoryLog.js';
import { buildTitlePrompt, sanitizeTitle, titleCommandFor } from '../../common/history/titleGeneration.js';

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

	test('replies are cleaned into one short line', () => {
		assert.strictEqual(sanitizeTitle('"Run command card border fix."\n'), 'Run command card border fix');
		assert.strictEqual(sanitizeTitle('Title: **GitHub OAuth login**'), 'GitHub OAuth login');
		assert.strictEqual(sanitizeTitle('<think>hmm</think>\n\nci test hang'), 'Ci test hang');
		assert.strictEqual(sanitizeTitle('{"title":"Sidebar chat titles"}'), 'Sidebar chat titles');
		assert.strictEqual(sanitizeTitle('   \n'), undefined);
		assert.strictEqual(sanitizeTitle('New chat'), undefined);
		assert.ok(sanitizeTitle('word '.repeat(30))!.length <= 48);
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
