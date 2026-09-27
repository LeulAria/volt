/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { adaptModelStream } from '../../../common/deepseek/llmAdapter.js';
import { runDeepseekLoop } from '../../../common/deepseek/loop.js';
import { IVoltEvent } from '../../../common/events.js';
import { buildAnthropicRequest } from '../../../common/harness/anthropicRequest.js';
import { AnthropicStreamParser, IAnthropicStreamJson } from '../../../common/harness/anthropicToolStream.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import { nativeToModelMessages } from '../../../common/harness/providerMessages.js';
import { claudeModelMeta } from '../../../common/models/claudeModels.js';
import { IVoltTool } from '../../../common/tools/tool.js';

/**
 * Record/replay: captured Anthropic SSE runs through the real parser, adapter, loop, and request
 * builder. No network, no model variance: it pins the harness's side of the contract.
 */

const MODEL = 'claude-opus-5';

const TURN_1: IAnthropicStreamJson[] = [
	{ type: 'message_start', message: { usage: { input_tokens: 40, cache_creation_input_tokens: 2100, cache_read_input_tokens: 0, output_tokens: 1 } } },
	{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the file first.' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCkYI' } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading it.' } },
	{ type: 'content_block_stop', index: 1 },
	{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'read_file' } },
	{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
	{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
	{ type: 'content_block_stop', index: 2 },
	{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 57 } },
	{ type: 'message_stop' },
];

const TURN_2: IAnthropicStreamJson[] = [
	{ type: 'message_start', message: { usage: { input_tokens: 30, cache_creation_input_tokens: 120, cache_read_input_tokens: 2100, output_tokens: 1 } } },
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '`a.ts` exports `a`.' } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
];

suite('Anthropic record/replay through the native loop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('thinking is replayed in place, tool results pair up, and usage reports the cache', async () => {
		const bodies: Record<string, unknown>[] = [];
		const events: IVoltEvent[] = [];
		const turns = [TURN_1, TURN_2];
		const readFile: IVoltTool = {
			name: 'read_file', group: 'read', kind: 'read', description: 'read', parallelSafe: true, snippet: 'read_file',
			schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			execute: async () => ({ callId: '', name: 'read_file', kind: 'read', text: 'export const a = 1;' }),
		};
		const system: INativeLoopMessage = { role: 'system', content: 'You are Volt.' };
		const result = await runDeepseekLoop({
			stream: messages => {
				const request = buildAnthropicRequest({
					modelId: MODEL,
					meta: claudeModelMeta(MODEL),
					messages: nativeToModelMessages([system, ...messages]),
					tools: [{ name: 'read_file', description: 'read', parameters: readFile.schema }],
					maxTokens: 64_000,
					effort: 'medium',
					firstParty: true,
				});
				bodies.push(JSON.parse(JSON.stringify(request.body)));
				const parser = new AnthropicStreamParser(MODEL, 'r');
				const recorded = turns[bodies.length - 1] ?? [];
				return adaptModelStream((async function* () {
					for (const json of recorded) {
						yield* parser.apply(json);
					}
					yield* parser.finish();
				})());
			},
			execute: async calls => Promise.all(calls.map(async call => ({ ...(await readFile.execute(call.args, { signal: new AbortController().signal })), callId: call.id }))),
			authorize: async () => 'allowed-once',
			preauthorize: () => 'allowed-once',
			emit: event => events.push(event),
			tool: name => name === 'read_file' ? readFile : undefined,
		}, { messages: [{ role: 'user', content: 'what does a.ts export?' }], token: { isCancellationRequested: false } });

		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, '`a.ts` exports `a`.');
		assert.strictEqual(bodies.length, 2);

		const second = bodies[1] as { messages: { role: string; content: { type: string; signature?: string; tool_use_id?: string; cache_control?: unknown }[] }[]; output_config?: unknown; thinking?: unknown };
		const assistant = second.messages[1];
		assert.deepStrictEqual(assistant.content.map(block => block.type), ['thinking', 'text', 'tool_use']);
		assert.strictEqual(assistant.content[0].signature, 'EqQBCkYI');
		const results = second.messages[2];
		assert.strictEqual(results.content[0].type, 'tool_result');
		assert.strictEqual(results.content[0].tool_use_id, 'toolu_01');
		assert.ok(results.content.at(-1)?.cache_control, 'the newest block carries a cache breakpoint');
		assert.deepStrictEqual(second.thinking, { type: 'adaptive', display: 'summarized' });
		assert.deepStrictEqual(second.output_config, { effort: 'medium' });

		const usage = events.filter((event): event is Extract<IVoltEvent, { type: 'usage' }> => event.type === 'usage');
		assert.deepStrictEqual(usage.map(event => [event.input, event.output, event.cache, event.cacheWrite]), [[40, 57, 0, 2100], [30, 12, 2100, 120]]);
	});
});
