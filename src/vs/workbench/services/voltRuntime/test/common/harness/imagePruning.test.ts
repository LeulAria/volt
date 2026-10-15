/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { applyCompaction, pruneImages, PRUNED_IMAGE_NOTE } from '../../../common/harness/nativeCompaction.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import type { IModelAssistantPart } from '../../../common/providers.js';

const claudeThinking: IModelAssistantPart = { type: 'reasoning', block: { provider: 'anthropic', model: 'claude-sonnet-5-5', text: 't', opaque: { type: 'thinking', thinking: 't', signature: 's' } } };
const geminiSignature: IModelAssistantPart = { type: 'reasoning', block: { provider: 'gemini', model: 'gemini-3-pro', text: '', opaque: { callId: 'c', thoughtSignature: 'sig' } } };

function shot(i: number, size = 10): INativeLoopMessage {
	return { role: 'tool', callId: `c${i}`, name: 'browser_screenshot', content: `shot ${i}`, images: [{ mediaType: 'image/png', data: 'x'.repeat(size) }] };
}

suite('Native image pruning', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('does nothing until the batch threshold, so the cached prefix stays put', () => {
		const messages = [1, 2, 3, 4, 5].map(i => shot(i));
		assert.strictEqual(pruneImages(messages, { keep: 2, pruneAt: 5, maxChars: 1_000 }), 0);
		assert.ok(messages.every(message => message.images?.length === 1));
	});

	test('past the threshold, keeps only the newest images and leaves a note', () => {
		const messages = [1, 2, 3, 4, 5, 6].map(i => shot(i));
		assert.strictEqual(pruneImages(messages, { keep: 2, pruneAt: 5, maxChars: 1_000 }), 4);
		assert.deepStrictEqual(messages.map(message => message.images?.length ?? 0), [0, 0, 0, 0, 1, 1]);
		assert.strictEqual(messages[0].content, `shot 1\n${PRUNED_IMAGE_NOTE}`);
		assert.strictEqual(messages[0].callId, 'c1');
	});

	test('a character budget prunes even below the count threshold', () => {
		const messages = [shot(1, 600), shot(2, 600)];
		assert.strictEqual(pruneImages(messages, { keep: 4, pruneAt: 10, maxChars: 1_000 }), 1);
		assert.deepStrictEqual(messages.map(message => message.images?.length ?? 0), [0, 1]);
	});

	test('compaction drops old pixels from the kept tail', () => {
		const messages: INativeLoopMessage[] = [
			{ role: 'user', content: 'old', turn: true },
			{ role: 'user', content: 'go', turn: true },
			...[1, 2, 3, 4, 5, 6].map(i => shot(i)),
		];
		const next = applyCompaction(messages, 1, 'summary');
		assert.strictEqual(next.reduce((total, message) => total + (message.images?.length ?? 0), 0), 4);
	});

	test('pruning drops Claude reasoning after the first pruned image, so the next request is not rejected', () => {
		const thinking = (text: string): INativeLoopMessage => ({ role: 'assistant', content: text, parts: [claudeThinking, geminiSignature, { type: 'text', text }] });
		const messages: INativeLoopMessage[] = [thinking('before'), ...[1, 2, 3].flatMap(i => [shot(i), thinking(`after ${i}`)])];
		assert.strictEqual(pruneImages(messages, { keep: 1, pruneAt: 2, maxChars: 1_000 }), 2);
		assert.strictEqual(messages[0].parts?.length, 3, 'before the edit the prefix is unchanged');
		const after = messages.slice(1).filter(message => message.role === 'assistant');
		assert.ok(after.every(message => message.parts?.every(part => part !== claudeThinking) && message.parts?.includes(geminiSignature)));
	});

	test('compaction keeps reasoning other providers need back on the kept tool calls', () => {
		const messages: INativeLoopMessage[] = [
			{ role: 'user', content: 'old', turn: true },
			{ role: 'user', content: 'go', turn: true },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_file', args: {} }], parts: [claudeThinking, geminiSignature, { type: 'tool_call', callId: 'c' }] },
		];
		const next = applyCompaction(messages, 1, 'summary');
		assert.deepStrictEqual(next.at(-1)?.parts, [geminiSignature, { type: 'tool_call', callId: 'c' }]);
	});
});
