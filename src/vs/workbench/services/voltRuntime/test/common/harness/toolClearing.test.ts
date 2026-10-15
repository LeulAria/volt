/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { clearOldToolResults, DEFAULT_TOOL_CLEAR, toolClearTrigger } from '../../../common/harness/nativeCompaction.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';

/** A read of `path` and its (large) result. */
function read(i: number, chars: number): INativeLoopMessage[] {
	return [
		{ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `src/file${i}.ts` } }] },
		{ role: 'tool', callId: `c${i}`, name: 'read_file', content: 'x'.repeat(chars) },
	];
}

suite('Native tool result clearing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const window = 128_000;

	test('does nothing below the trigger', () => {
		const messages = [{ role: 'user' as const, content: 'go' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(i => read(i, 20_000))];
		assert.strictEqual(clearOldToolResults(messages, toolClearTrigger(window) - 1, window), 0);
		assert.ok(messages.every(message => !message.content.startsWith('[Old tool result')));
	});

	test('stubs every large result but the newest few in one batch, naming the call', () => {
		const messages = [{ role: 'user' as const, content: 'go' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(i => read(i, 40_000))];
		const freed = clearOldToolResults(messages, 100_000, window);
		assert.ok(freed > DEFAULT_TOOL_CLEAR.clearAtLeast);
		const tools = messages.filter(message => message.role === 'tool');
		const cleared = tools.filter(message => message.content.startsWith('[Old tool result'));
		assert.strictEqual(cleared.length, 10 - DEFAULT_TOOL_CLEAR.keep);
		assert.ok(cleared[0].content.includes('read_file') && cleared[0].content.includes('src/file1.ts'));
		assert.ok(tools.slice(-DEFAULT_TOOL_CLEAR.keep).every(message => message.content.length === 40_000), 'the newest stay whole');
		assert.strictEqual(clearOldToolResults(messages, 100_000, window), 0, 'nothing left worth a pass');
	});

	test('skips a pass that would free too little to pay for the cache rewrite', () => {
		const messages = [{ role: 'user' as const, content: 'go' }, ...[1, 2, 3, 4, 5, 6, 7].flatMap(i => read(i, 4_000))];
		assert.strictEqual(clearOldToolResults(messages, 100_000, window), 0);
	});
});
