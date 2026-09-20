/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltEvent } from '../../../common/events.js';
import { runNativeLoop, INativeLoopHost, INativeLoopMessage, NativeFinishReason } from '../../../common/harness/nativeLoop.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt native loop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('answers without tools', async () => {
		const host = new FakeHost([[text('4'), finish('stop')]]);
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'what is 2+2' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, '4');
		assert.strictEqual(host.executed.length, 0);
		assert.ok(host.events.some(event => event.type === 'text.delta' && event.delta === '4'));
		assert.ok(host.events.some(event => event.type === 'step.end'));
	});

	test('executes one tool then stops', async () => {
		const host = new FakeHost([
			[tool('read_file', { path: 'a.ts' }), finish('tool_calls')],
			[text('done'), finish('stop')],
		]);
		host.results.set('read_file', { callId: 'c0', name: 'read_file', kind: 'read', text: 'export const a = 1' });
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'what is in a.ts' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.deepStrictEqual(host.executed.map(call => call.name), ['read_file']);
		assert.ok(host.events.some(event => event.type === 'tool.end' && event.callId === 'c0'));
	});

	test('does not execute truncated tool arguments', async () => {
		const host = new FakeHost([
			[tool('shell', { command: 'rm -rf /' }), finish('length')],
			[text('stopped'), finish('stop')],
		]);
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'clean up' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(host.executed.length, 0);
		assert.ok(host.streams[1].some(message => /cut off/.test(message.content)));
		assert.ok(result.messages.some(message => message.role === 'tool' && /truncated/.test(message.content)));
	});

	test('asks once on a doom loop instead of killing the run', async () => {
		const host = new FakeHost([
			[tool('grep', { pattern: 'x' }), finish('tool_calls')],
			[tool('grep', { pattern: 'x' }), finish('tool_calls')],
			[tool('grep', { pattern: 'x' }), finish('tool_calls')],
			[text('backing off'), finish('stop')],
		]);
		host.results.set('grep', { callId: 'g', name: 'grep', kind: 'search', text: '' });
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'find x' }],
			budget: { maxToolCalls: 80, maxModelCalls: 40 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(host.executed.length, 2);
		assert.ok(host.events.some(event => event.type === 'error' && /three times/.test(event.message)));
		assert.ok(host.streams.some(stream => stream.some(message => /doom loop|different approach/.test(message.content))));
	});

	test('merges streamed tool argument deltas', async () => {
		const host = new FakeHost([
			[
				{ type: 'tool.start', callId: 'c1', name: 'read_file', input: '' },
				{ type: 'tool.input.delta', callId: 'c1', delta: '{"pa' },
				{ type: 'tool.input.delta', callId: 'c1', delta: 'th":"a.ts"}' },
				finish('tool_calls'),
			],
			[text('ok'), finish('stop')],
		]);
		host.results.set('read_file', { callId: 'c1', name: 'read_file', kind: 'read', text: 'export const a = 1' });
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'read a.ts' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.deepStrictEqual(host.executed[0]?.args, { path: 'a.ts' });
	});

	test('finish tool ends the loop without another model call', async () => {
		const host = new FakeHost([
			[tool('finish', { summary: 'Edited a.ts' }), finish('tool_calls')],
		]);
		host.results.set('finish', { callId: 'f', name: 'finish', kind: 'think', text: '{"summary":"Edited a.ts"}' });
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'rename foo' }],
			budget: { maxToolCalls: 10, maxModelCalls: 6 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(host.streams.length, 1);
		assert.ok(result.assistant.includes('Edited a.ts') || host.executed[0]?.name === 'finish');
	});

	test('prepareTurn may rewrite the transcript before a model call', async () => {
		const host = new FakeHost([[text('ok'), finish('stop')]]);
		const result = await runNativeLoop(host, {
			messages: [
				{ role: 'system', content: 'you are volt' },
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi' },
				{ role: 'user', content: 'again' },
			],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
			prepareTurn: messages => messages.filter(message => message.role !== 'assistant'),
		});
		assert.strictEqual(result.outcome, 'done');
		assert.ok(host.streams[0].every(message => message.role !== 'assistant'));
	});

	test('injects additional tool contexts before the next model turn', async () => {
		const host = new FakeHost([
			[tool('read_file', { path: 'a.ts' }), finish('tool_calls')],
			[text('ok'), finish('stop')],
		]);
		host.results.set('read_file', { callId: 'c0', name: 'read_file', kind: 'read', text: 'src', contexts: ['also look at the tests'] });
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'read a.ts' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.ok(host.streams[1].some(message => message.role === 'user' && message.content === 'also look at the tests'));
	});

	test('retries a thrown stream error and then succeeds', async () => {
		let attempts = 0;
		const host = new FakeHost([[text('ok'), finish('stop')]]);
		const original = host.stream.bind(host);
		host.stream = async function* (messages) {
			attempts++;
			if (attempts === 1) {
				throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
			}
			yield* original(messages, { isCancellationRequested: false });
		};
		const delays: number[] = [];
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'hi' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
			delay: async ms => { delays.push(ms); },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, 'ok');
		assert.strictEqual(attempts, 2);
		assert.ok(delays.length === 1 && delays[0] > 0);
		assert.ok(host.events.some(event => event.type === 'retry' && event.attempt === 1));
	});

	test('does not retry a context-overflow error', async () => {
		const host = new FakeHost([]);
		host.stream = async function* () {
			throw new Error('This model\'s maximum context length was exceeded');
		};
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'hi' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'fail');
		assert.ok(!host.events.some(event => event.type === 'retry'));
		assert.ok(host.events.some(event => event.type === 'error' && event.retryable === false));
	});

	test('settles aborted tool pairs when the stream is cancelled', async () => {
		const token = { isCancellationRequested: false };
		const host = new FakeHost([]);
		host.stream = async function* () {
			yield tool('read_file', { path: 'a.ts' });
			token.isCancellationRequested = true;
			yield finish('abort');
		};
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'read a.ts' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token,
		});
		assert.strictEqual(result.outcome, 'abort');
		assert.strictEqual(host.executed.length, 0);
		assert.ok(result.messages.some(message => message.role === 'tool' && /interrupted/.test(message.content)));
	});

	test('claims inbox that arrived during prepareTurn', async () => {
		const inbox: string[] = [];
		const host = new FakeHost([[text('ok'), finish('stop')]]);
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'hello' }],
			budget: { maxToolCalls: 4, maxModelCalls: 3 },
			token: { isCancellationRequested: false },
			prepareTurn: messages => {
				inbox.push('steer from the user');
				return messages;
			},
			claimInboxBatch: () => {
				if (!inbox.length) {
					return { texts: [], opensTurn: false };
				}
				return { texts: inbox.splice(0, inbox.length), opensTurn: false };
			},
		});
		assert.strictEqual(result.outcome, 'done');
		assert.ok(host.streams[0].some(message => message.content === 'steer from the user'));
	});

	test('respects the model-call budget', async () => {
		const host = new FakeHost([
			[tool('read_file', { path: 'a' }), finish('tool_calls')],
			[tool('read_file', { path: 'b' }), finish('tool_calls')],
		]);
		host.results.set('read_file', { callId: 'r', name: 'read_file', kind: 'read', text: 'ok' });
		const result = await runNativeLoop(host, {
			messages: [{ role: 'user', content: 'read things' }],
			budget: { maxToolCalls: 80, maxModelCalls: 1 },
			token: { isCancellationRequested: false },
		});
		assert.strictEqual(result.outcome, 'budget');
		assert.strictEqual(host.executed.length, 1);
	});
});

type StreamEvent = IVoltEvent | { type: 'finish'; reason: NativeFinishReason };

class FakeHost implements INativeLoopHost {
	readonly executed: IToolCall[] = [];
	readonly events: IVoltEvent[] = [];
	readonly streams: INativeLoopMessage[][] = [];
	readonly results = new Map<string, IToolResult>();
	private callSeq = 0;

	constructor(private readonly script: StreamEvent[][]) { }

	async *stream(messages: readonly INativeLoopMessage[]): AsyncIterable<StreamEvent> {
		this.streams.push(messages.slice());
		const events = this.script.shift() ?? [finish('stop')];
		for (const event of events) {
			if (event.type === 'tool.start') {
				yield { ...event, callId: event.callId || `c${this.callSeq++}` };
			} else {
				yield event;
			}
		}
	}

	async execute(calls: readonly IToolCall[]): Promise<readonly IToolResult[]> {
		this.executed.push(...calls);
		return calls.map(call => this.results.get(call.name) ?? { callId: call.id, name: call.name, kind: 'other', text: '', isError: true });
	}

	emit(event: IVoltEvent): void {
		this.events.push(event);
	}
}

function text(delta: string): IVoltEvent {
	return { type: 'text.delta', id: 't', delta };
}

function tool(name: string, args: unknown): IVoltEvent {
	return { type: 'tool.start', callId: '', name, input: JSON.stringify(args) };
}

function finish(reason: NativeFinishReason): { type: 'finish'; reason: NativeFinishReason } {
	return { type: 'finish', reason };
}
