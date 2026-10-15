/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	nativeToModelMessages,
	toAnthropicMessages,
	toGeminiContents,
	toOllamaMessages,
	toOpenAiMessages,
	toOpenAiTools,
} from '../../../common/harness/providerMessages.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import type { IModelMessage } from '../../../common/providers.js';

suite('Volt provider message transforms', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const turn: INativeLoopMessage[] = [
		{ role: 'system', content: 'You are Volt.' },
		{ role: 'user', content: 'read a.ts' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
		{ role: 'tool', content: 'export const a = 1', callId: 'c1', name: 'read_file' },
	];

	test('OpenAI keeps tool_call_id on tool results', () => {
		const messages = toOpenAiMessages(nativeToModelMessages(turn));
		const tool = messages.find(message => (message as { role: string }).role === 'tool') as { tool_call_id: string; content: string };
		assert.strictEqual(tool.tool_call_id, 'c1');
		assert.strictEqual(tool.content, 'export const a = 1');
		const assistant = messages.find(message => (message as { tool_calls?: unknown }).tool_calls) as { tool_calls: { function: { name: string; arguments: string } }[] };
		assert.strictEqual(assistant.tool_calls[0].function.name, 'read_file');
		assert.strictEqual(assistant.tool_calls[0].function.arguments, '{"path":"a.ts"}');
	});

	test('Anthropic merges consecutive tool results into one user message', () => {
		const messages = toAnthropicMessages(nativeToModelMessages([
			turn[0],
			turn[1],
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }, { id: 'c2', name: 'read_file', args: { path: 'b.ts' } }] },
			turn[3],
			{ role: 'tool', content: 'also', callId: 'c2', name: 'read_file' },
		]));
		assert.ok(!messages.some(message => (message as { role?: string }).role === 'system'));
		const user = messages.find(message => message.role === 'user' && Array.isArray(message.content));
		assert.ok(Array.isArray(user?.content));
		assert.strictEqual((user?.content as { type: string }[]).filter(part => part.type === 'tool_result').length, 2);
	});

	test('Gemini maps tool results to functionResponse', () => {
		const contents = toGeminiContents(nativeToModelMessages(turn));
		assert.ok(contents.every(content => content.role === 'user' || content.role === 'model'));
		const response = contents.find(content => content.parts.some(part => 'functionResponse' in part));
		assert.ok(response);
	});

	test('OpenAI tools wrap the JSON schema', () => {
		const tools = toOpenAiTools([{ name: 'read_file', description: 'read', parameters: { type: 'object' } }]);
		assert.deepStrictEqual(tools, [{
			type: 'function',
			function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
		}]);
	});
	test('images the user attached reach every provider format', () => {
		const messages: IModelMessage[] = [{ role: 'user', content: 'match this', images: [{ mediaType: 'image/png', data: 'AAAA' }] }];
		assert.deepStrictEqual(toAnthropicMessages(messages), [{ role: 'user', content: [{ type: 'text', text: 'match this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]);
		assert.deepStrictEqual(toOpenAiMessages(messages, { vision: true }), [{ role: 'user', content: [{ type: 'text', text: 'match this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
		assert.deepStrictEqual(toOpenAiMessages(messages), [{ role: 'user', content: 'match this' }]);
		assert.deepStrictEqual(toGeminiContents(messages), [{ role: 'user', parts: [{ text: 'match this' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }]);
	});

	test('Ollama gets tool-call arguments as an object, results by tool name, and images only for vision models', () => {
		const shot: INativeLoopMessage[] = [
			...turn,
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'browser_screenshot', args: {} }] },
			{ role: 'tool', content: 'screenshot', callId: 'c2', name: 'browser_screenshot', images: [{ mediaType: 'image/png', data: 'AAAA' }] },
		];
		const messages = toOllamaMessages(nativeToModelMessages(shot), { vision: true }) as { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string; images?: string[] }[];
		assert.deepStrictEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
		assert.deepStrictEqual(messages[2].tool_calls, [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }]);
		assert.strictEqual(messages[3].tool_name, 'read_file');
		assert.deepStrictEqual(messages[6].images, ['AAAA'], 'raw base64, after the results');
		const blind = toOllamaMessages(nativeToModelMessages(shot)) as { images?: string[] }[];
		assert.ok(blind.every(message => !message.images), 'a model without vision gets no images');
	});
});
