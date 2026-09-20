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
	toOpenAiMessages,
	toOpenAiTools,
} from '../../../common/harness/providerMessages.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';

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
			...turn,
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
});
