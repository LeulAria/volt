/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltEvent } from '../../../common/events.js';
import { AnthropicStreamParser, IAnthropicStreamJson } from '../../../common/harness/anthropicToolStream.js';
import { ProviderError } from '../../../common/providerError.js';

suite('Volt Anthropic stream parser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(events: IAnthropicStreamJson[]): IVoltEvent[] {
		const parser = new AnthropicStreamParser('claude-opus-5', 't');
		return [...events.flatMap(event => parser.apply(event)), ...parser.finish()];
	}

	test('a tool call streams its input and ends at its own content_block_stop', () => {
		const out = run([
			{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
		]);
		assert.deepStrictEqual(out.map(event => event.type), ['tool.start', 'tool.input.delta', 'tool.input.delta', 'tool.input.end', 'finish']);
		assert.deepStrictEqual(out.at(-1), { type: 'finish', reason: 'tool_calls' });
	});

	test('usage merges input and cache from message_start with output from message_delta', () => {
		const out = run([
			{ type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
			{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
		]);
		const usage = out.filter(event => event.type === 'usage').at(-1);
		assert.deepStrictEqual(usage, { type: 'usage', input: 120, output: 42, cache: 9000, cacheWrite: 300, used: 9420 });
	});

	test('a thinking block keeps its signature for verbatim replay', () => {
		const out = run([
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan: ' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'read first.' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
			{ type: 'content_block_stop', index: 0 },
		]);
		const block = out.find(event => event.type === 'reasoning.block');
		assert.deepStrictEqual(block, {
			type: 'reasoning.block',
			provider: 'anthropic',
			model: 'claude-opus-5',
			text: 'Plan: read first.',
			opaque: { type: 'thinking', thinking: 'Plan: read first.', signature: 'sig-abc' },
		});
	});

	test('redacted thinking is replayed as-is', () => {
		const out = run([
			{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-data' } },
			{ type: 'content_block_stop', index: 0 },
		]);
		const block = out.find(event => event.type === 'reasoning.block');
		assert.ok(block && block.type === 'reasoning.block');
		assert.deepStrictEqual(block.opaque, { type: 'redacted_thinking', data: 'opaque-data' });
	});

	test('max_tokens maps to length', () => {
		const out = run([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]);
		assert.deepStrictEqual(out.at(-1), { type: 'finish', reason: 'length' });
	});

	test('a refusal surfaces as a non-retryable error and an error finish', () => {
		const out = run([{ type: 'message_delta', delta: { stop_reason: 'refusal' }, stop_details: { category: 'cyber', explanation: null } }]);
		assert.deepStrictEqual(out.slice(-2), [
			{ type: 'error', message: 'The model declined this request (cyber).', retryable: false },
			{ type: 'finish', reason: 'error' },
		]);
	});

	test('a mid-stream error event throws a retryable provider error', () => {
		const parser = new AnthropicStreamParser('claude-opus-5');
		assert.throws(() => parser.apply({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), (err: unknown) => err instanceof ProviderError && err.retryable);
	});
});
