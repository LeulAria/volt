/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { applyCompaction, clearOldToolResults, compactionBoundary, DEFAULT_TOOL_CLEAR, toolClearTrigger } from '../../../common/harness/nativeCompaction.js';
import type { IModelAssistantPart } from '../../../common/providers.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';

const claudeThinking: IModelAssistantPart = { type: 'reasoning', block: { provider: 'anthropic', model: 'claude-opus-5-5', text: 't', opaque: { type: 'thinking', thinking: 't', signature: 's' } } };
const deepseekThinking: IModelAssistantPart = { type: 'reasoning', block: { provider: 'deepseek', model: 'deepseek-reasoner', text: 't', opaque: { reasoning_content: 't' } } };

/** A write of a large file and its short result. */
function write(i: number, chars: number): INativeLoopMessage[] {
	return [
		{ role: 'assistant', content: '', toolCalls: [{ id: `w${i}`, name: 'write_file', args: { path: `src/new${i}.ts`, content: 'y'.repeat(chars) } }] },
		{ role: 'tool', callId: `w${i}`, name: 'write_file', content: `Wrote src/new${i}.ts` },
	];
}

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

	test('clears the text old writes sent, keeping their paths, and leaves recent calls whole', () => {
		const messages = [{ role: 'user' as const, content: 'go' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(i => write(i, 40_000))];
		const freed = clearOldToolResults(messages, 100_000, window);
		assert.ok(freed > DEFAULT_TOOL_CLEAR.clearAtLeast);
		const args = messages.flatMap(message => message.toolCalls ?? []).map(call => call.args as { path: string; content: string });
		assert.deepStrictEqual(args.map(arg => arg.path), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => `src/new${i}.ts`));
		assert.ok(args.slice(0, 10 - DEFAULT_TOOL_CLEAR.keep).every(arg => arg.content === '[cleared to save context: 40000 characters]'));
		assert.ok(args.slice(-DEFAULT_TOOL_CLEAR.keep).every(arg => arg.content.length === 40_000), 'the newest stay whole');
		assert.strictEqual(clearOldToolResults(messages, 100_000, window), 0, 'stubs are not cleared again');
	});

	test('drops Claude reasoning from the first edit on (it would be rejected) and keeps other providers\' reasoning', () => {
		const messages: INativeLoopMessage[] = [
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: 'early', parts: [claudeThinking, { type: 'text', text: 'early' }] },
			...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(i => read(i, 40_000)).map(message => message.role === 'assistant' ? { ...message, parts: [claudeThinking, deepseekThinking] } : message),
		];
		clearOldToolResults(messages, 100_000, window);
		// [user, early, call 1, result 1 (the first edit), ...]
		assert.deepStrictEqual(messages[1].parts?.map(part => part.type), ['reasoning', 'text'], 'before the first edit nothing changed');
		assert.strictEqual(messages[2].parts?.length, 2);
		const later = messages.slice(3).filter(message => message.role === 'assistant');
		assert.ok(later.every(message => message.parts?.length === 1 && message.parts[0] === deepseekThinking));
	});

	test('one long turn still compacts: the cut lands at a step, and the request survives word for word', () => {
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'migrate every service to the new client', turn: true }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(i => read(i, 4_000))];
		const boundary = compactionBoundary(messages, 3_000);
		assert.ok(boundary > 1 && messages[boundary].role === 'assistant', `boundary ${boundary}`);
		const next = applyCompaction(messages, boundary, 'SUMMARY');
		assert.strictEqual(next[0].role, 'user');
		assert.ok(next[0].content.includes('SUMMARY') && next[0].content.includes('migrate every service to the new client'));
		assert.strictEqual(next[1].role, 'assistant');
		assert.ok(next.slice(1).every((message, index, tail) => message.role !== 'tool' || tail[index - 1]?.toolCalls?.some(call => call.id === message.callId)), 'every kept result follows its call');
	});

	test('a single short exchange has nothing to compact', () => {
		assert.strictEqual(compactionBoundary([{ role: 'user', content: 'hi', turn: true }, { role: 'assistant', content: 'hello' }], 0), 0);
	});
});
