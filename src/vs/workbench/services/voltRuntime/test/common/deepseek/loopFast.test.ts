/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IDeepseekHost, runDeepseekLoop } from '../../../common/deepseek/loop.js';
import { StreamChunk } from '../../../common/deepseek/protocol.js';
import { IVoltEvent } from '../../../common/events.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import { ProviderError } from '../../../common/providerError.js';
import { IToolCall, IToolResult, IVoltTool } from '../../../common/tools/tool.js';

suite('DeepSeek loop: speed and reliability', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const token = { isCancellationRequested: false };

	test('a read-only call starts while the model is still streaming', async () => {
		const order: string[] = [];
		const stream: IDeepseekHost['stream'] = scripted([
			async function* () {
				yield { type: 'tool-call-delta', index: 0, id: 'r1', name: 'read_file', argumentsDelta: '{"path":"a.ts"}' };
				yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'r1', name: 'read_file', arguments: '{"path":"a.ts"}' } };
				await tick();
				order.push('stream-still-open');
				yield { type: 'text-delta', index: 1, text: 'reading' };
				yield { type: 'finish', reason: 'tool_calls' };
			},
			async function* () {
				yield { type: 'text-delta', index: 0, text: 'done' };
				yield { type: 'finish', reason: 'stop' };
			},
		]);
		const result = await runDeepseekLoop(host({
			stream,
			preauthorize: () => 'allowed-once',
			tool: name => tools[name],
			execute: async (calls, onResult) => {
				order.push(`exec:${calls.map(call => call.id).join(',')}`);
				const results = calls.map(call => ok(call));
				results.forEach(result => onResult?.(result));
				return results;
			},
		}), { messages: [{ role: 'user', content: 'read a' }], token });
		assert.strictEqual(result.outcome, 'done');
		assert.deepStrictEqual(order.slice(0, 2), ['exec:r1', 'stream-still-open']);
	});

	test('nothing after a mutating call starts early, so order holds', async () => {
		const executed: string[] = [];
		const result = await runDeepseekLoop(host({
			stream: scripted([
				chunks([
					{ type: 'tool-call-delta', index: 0, id: 'e1', name: 'edit_file', argumentsDelta: '{"path":"a.ts"}' },
					{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'e1', name: 'edit_file', arguments: '{"path":"a.ts"}' } },
					{ type: 'tool-call-delta', index: 1, id: 'r1', name: 'read_file', argumentsDelta: '{"path":"a.ts"}' },
					{ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'r1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
					{ type: 'finish', reason: 'tool_calls' },
				]),
				chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: 'stop' }]),
			]),
			preauthorize: () => 'allowed-once',
			tool: name => tools[name],
			execute: async calls => {
				executed.push(calls.map(call => call.id).join('+'));
				return calls.map(call => ok(call));
			},
		}), { messages: [{ role: 'user', content: 'edit then read' }], token });
		assert.strictEqual(result.outcome, 'done');
		assert.deepStrictEqual(executed, ['e1+r1']);
	});

	test('invalid arguments fail before approval, with the parameters the tool takes', async () => {
		let asked = 0;
		const events: IVoltEvent[] = [];
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'read' }];
		await runDeepseekLoop(host({
			stream: scripted([
				chunks([
					{ type: 'tool-call-delta', index: 0, id: 'r1', name: 'read_file', argumentsDelta: '{"offset":1}' },
					{ type: 'finish', reason: 'tool_calls' },
				]),
				chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: 'stop' }]),
			]),
			authorize: async () => {
				asked++;
				return 'allowed-once';
			},
			tool: name => tools[name],
			emit: event => events.push(event),
		}), { messages, token });
		assert.strictEqual(asked, 0);
		const result = messages.find(message => message.role === 'tool');
		assert.ok(result?.isError);
		assert.ok(/Parameters: \{path: string/.test(result!.content), result!.content);
	});

	test('a file_path alias is accepted instead of rejected', async () => {
		const seen: unknown[] = [];
		await runDeepseekLoop(host({
			stream: scripted([
				chunks([
					{ type: 'tool-call-delta', index: 0, id: 'r1', name: 'read_file', argumentsDelta: '{"file_path":"a.ts","limit":"20"}' },
					{ type: 'finish', reason: 'tool_calls' },
				]),
				chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: 'stop' }]),
			]),
			tool: name => tools[name],
			execute: async calls => {
				seen.push(...calls.map(call => call.args));
				return calls.map(call => ok(call));
			},
		}), { messages: [{ role: 'user', content: 'read' }], token });
		assert.deepStrictEqual(seen, [{ path: 'a.ts', limit: 20 }]);
	});

	test('a retryable stream failure before any output is retried transparently', async () => {
		let attempts = 0;
		const events: IVoltEvent[] = [];
		const result = await runDeepseekLoop(host({
			stream: async function* () {
				attempts++;
				if (attempts === 1) {
					throw new ProviderError('overloaded_error: Overloaded', 529);
				}
				yield { type: 'text-delta', index: 0, text: 'fine' };
				yield { type: 'finish', reason: 'stop' };
			},
			emit: event => events.push(event),
		}), { messages: [{ role: 'user', content: 'hi' }], token });
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(attempts, 2);
		assert.ok(events.some(event => event.type === 'retry'));
	});

	test('an overflowing prompt is compacted once and the step runs again', async () => {
		let attempts = 0;
		let compacted = 0;
		const result = await runDeepseekLoop(host({
			stream: async function* () {
				attempts++;
				if (attempts === 1) {
					throw new ProviderError('400 invalid_request_error: prompt is too long: 1200000 tokens > 1000000 maximum', 400, 'invalid_request_error');
				}
				yield { type: 'text-delta', index: 0, text: 'fits now' };
				yield { type: 'finish', reason: 'stop' };
			},
			recoverOverflow: async () => {
				compacted++;
				return true;
			},
		}), { messages: [{ role: 'user', content: 'go' }], token });
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(compacted, 1);
	});

	test('the completion review sends the model back once, then accepts', async () => {
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'fix it' }];
		let reviews = 0;
		const result = await runDeepseekLoop(host({
			stream: scripted([
				chunks([{ type: 'text-delta', index: 0, text: 'Fixed.' }, { type: 'finish', reason: 'stop' }]),
				chunks([{ type: 'text-delta', index: 0, text: 'Fixed the type error too.' }, { type: 'finish', reason: 'stop' }]),
			]),
			reviewCompletion: async () => reviews++ === 0 ? 'Before you finish: 1 new error in a.ts' : undefined,
		}), { messages, token });
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, 'Fixed the type error too.');
		assert.ok(messages.some(message => message.role === 'user' && message.content.startsWith('Before you finish')));
	});

	test('reasoning blocks are kept, in order, on the assistant message for replay', async () => {
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'think' }];
		await runDeepseekLoop(host({
			stream: scripted([
				chunks([
					{ type: 'block-start', index: 0, blockType: 'reasoning' },
					{ type: 'reasoning-delta', index: 0, text: 'hmm' },
					{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm', provider: 'anthropic', model: 'm', opaque: { type: 'thinking', thinking: 'hmm', signature: 's' } } },
					{ type: 'text-delta', index: 1, text: 'answer' },
					{ type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
					{ type: 'finish', reason: 'stop' },
				]),
			]),
		}), { messages, token });
		const assistant = messages.find(message => message.role === 'assistant');
		assert.deepStrictEqual(assistant?.parts?.map(part => part.type), ['reasoning', 'text']);
	});
});

const tools: Record<string, IVoltTool> = {
	read_file: stub('read_file', 'read', true, { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] }),
	edit_file: stub('edit_file', 'edit', false, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
};

function stub(name: string, group: IVoltTool['group'], parallelSafe: boolean, schema: object): IVoltTool {
	return {
		name,
		group,
		kind: group === 'edit' ? 'edit' : 'read',
		description: name,
		schema,
		parallelSafe,
		snippet: name,
		execute: async () => ({ callId: '', name, kind: 'read', text: '' }),
	};
}

function ok(call: IToolCall): IToolResult {
	return { callId: call.id, name: call.name, kind: 'read', text: `ran ${call.id}` };
}

function host(partial: Partial<IDeepseekHost> & Pick<IDeepseekHost, 'stream'>): IDeepseekHost {
	return {
		execute: async calls => calls.map(call => ok(call)),
		authorize: async () => 'allowed-once',
		emit: () => undefined,
		tool: () => undefined,
		...partial,
	};
}

function chunks(list: StreamChunk[]): () => AsyncGenerator<StreamChunk> {
	return async function* () {
		yield* list;
	};
}

function scripted(turns: (() => AsyncGenerator<StreamChunk>)[]): IDeepseekHost['stream'] {
	let turn = 0;
	return () => (turns[turn++] ?? chunks([{ type: 'finish', reason: 'stop' }]))();
}

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 5));
}
