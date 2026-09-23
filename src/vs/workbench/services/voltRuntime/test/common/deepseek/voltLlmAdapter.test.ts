/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltEvent } from '../../../common/events.js';
import { adaptModelStream, assertUsageBeforeFinish } from '../../../common/deepseek/llmAdapter.js';
import { StreamChunk } from '../../../common/deepseek/protocol.js';

suite('Volt LLM adapter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps text, raw tool arguments, and puts usage before finish', async () => {
		const chunks = await collect(adaptModelStream(from<IVoltEvent>([
			{ type: 'text.delta', id: 'a', delta: 'Looking it up. ' },
			{ type: 'tool.start', callId: 'c1', name: 'web_search', input: '' },
			{ type: 'tool.input.delta', callId: 'c1', delta: '{"query":"Nissan Kicks UAE"}' },
			{ type: 'finish', reason: 'tool_calls' },
			{ type: 'usage', input: 12, output: 4 },
			{ type: 'text.delta', id: 'a', delta: 'too late' },
		])));

		assertUsageBeforeFinish(chunks);
		assert.strictEqual(chunks.at(-1)?.type, 'finish');
		const usageAt = chunks.findIndex(chunk => chunk.type === 'usage');
		const finishAt = chunks.findIndex(chunk => chunk.type === 'finish');
		assert.ok(usageAt >= 0 && usageAt < finishAt);

		const toolEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
		assert.ok(toolEnd && toolEnd.type === 'block-end' && toolEnd.block.type === 'tool-call');
		if (toolEnd && toolEnd.type === 'block-end' && toolEnd.block.type === 'tool-call') {
			assert.strictEqual(toolEnd.block.arguments, '{"query":"Nissan Kicks UAE"}');
			assert.strictEqual(toolEnd.block.name, 'web_search');
		}
		assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Looking it up. '));
		assert.ok(!chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'too late'));
	});

	test('a text-only reply still finishes, with no chunk after finish', async () => {
		const chunks = await collect(adaptModelStream(from<IVoltEvent>([
			{ type: 'reasoning.delta', id: 'r', delta: 'think' },
			{ type: 'text.delta', id: 'a', delta: '4' },
			{ type: 'usage', input: 1, output: 1 },
			{ type: 'finish', reason: 'stop' },
		])));
		assertUsageBeforeFinish(chunks);
		assert.deepStrictEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.type === 'text-delta' ? chunk.text : ''), ['4']);
		assert.strictEqual(chunks.find(chunk => chunk.type === 'finish') && (chunks.find(chunk => chunk.type === 'finish') as Extract<StreamChunk, { type: 'finish' }>).reason, 'stop');
	});
});

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of source) {
		chunks.push(chunk);
	}
	return chunks;
}

async function* from<T>(items: readonly T[]): AsyncGenerator<T> {
	for (const item of items) {
		yield item;
	}
}
