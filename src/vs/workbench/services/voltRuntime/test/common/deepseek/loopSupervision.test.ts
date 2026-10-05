/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IDeepseekHost, IDeepseekStep, IDeepseekStreamOptions, runDeepseekLoop } from '../../../common/deepseek/loop.js';
import { StreamChunk } from '../../../common/deepseek/protocol.js';
import { IVoltEvent } from '../../../common/events.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import { IToolCall, IToolResult, IVoltTool } from '../../../common/tools/tool.js';

/**
 * The production loop under a scripted model: loop detection, the controller hook, the stream
 * watchdog and runaway-text cut-off, end to end through `runDeepseekLoop`.
 */
suite('DeepSeek loop: supervision', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const token = { isCancellationRequested: false };

	test('a repeated call with the same result gets one corrective nudge, and the run recovers', async () => {
		const events: IVoltEvent[] = [];
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'what does a.ts export?', turn: true }];
		const result = await runDeepseekLoop(host({
			stream: model([call('read_file', { path: 'a.ts' }), call('read_file', { path: 'a.ts' }), call('read_file', { path: 'a.ts' }), text('It exports `answer`.')]),
			execute: async calls => calls.map(item => result_(item, 'export const answer = 42;')),
			emit: event => events.push(event),
		}), { messages, token });

		assert.strictEqual(result.outcome, 'done');
		const nudges = messages.filter(message => message.role === 'user' && /You called read_file a\.ts 3 times \(steps 1, 2, 3\)/.test(message.content));
		assert.strictEqual(nudges.length, 1);
		const notice = events.find(event => event.type === 'notice' && event.severity === 'warning');
		assert.ok(notice && notice.type === 'notice' && /read_file a\.ts ran 3 times with the same result \(steps 1, 2, 3\)/.test(notice.description ?? ''), JSON.stringify(notice));
		assert.ok(!events.some(event => event.type === 'error'), 'a nudge is a notice, not an error');
	});

	test('a model that keeps looping after the nudge is stopped with a reason', async () => {
		const events: IVoltEvent[] = [];
		const turns = Array.from({ length: 10 }, () => call('shell', { command: 'git status' }));
		const result = await runDeepseekLoop(host({
			stream: model(turns),
			execute: async calls => calls.map(item => result_(item, '$ git status\nnothing to commit\n[exit 0 · 0.1s]', 'execute')),
			emit: event => events.push(event),
		}), { messages: [{ role: 'user', content: 'commit my work', turn: true }], token });

		assert.strictEqual(result.outcome, 'fail');
		assert.strictEqual(result.stopped?.by, 'loop');
		assert.strictEqual(result.stopped?.signal, 'repeat');
		assert.deepStrictEqual(result.stopped?.evidence, [1, 2, 3, 4, 5]);
		const error = events.find(event => event.type === 'error');
		assert.ok(error && error.type === 'error' && /^Stopped: the agent kept looping/.test(error.message) && error.retryable === false, JSON.stringify(error));
		assert.strictEqual(events.filter(event => event.type === 'step.start').length, 5, 'stopped right after the fifth repeat');
	});

	test('a normal edit, test, fix cycle is never flagged', async () => {
		const events: IVoltEvent[] = [];
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'fix the failing test', turn: true }];
		let source = 'export const add = (a, b) => a - b;';
		let runs = 0;
		const result = await runDeepseekLoop(host({
			stream: model([
				call('read_file', { path: 'src/add.ts' }),
				call('shell', { command: 'npm test' }),
				call('edit_file', { path: 'src/add.ts', old_string: 'a - b', new_string: 'a + b + 0' }),
				call('read_file', { path: 'src/add.ts' }),
				call('shell', { command: 'npm test' }),
				call('edit_file', { path: 'src/add.ts', old_string: 'a + b + 0', new_string: 'a + b' }),
				call('read_file', { path: 'src/add.ts' }),
				call('shell', { command: 'npm test' }),
				call('shell', { command: 'npm test' }),
				text('Fixed `add`.'),
			]),
			execute: async calls => calls.map(item => {
				const args = item.args as Record<string, string>;
				if (item.name === 'edit_file') {
					source = source.replace(args.old_string, args.new_string);
					return result_(item, 'Edited src/add.ts: 1 replacement.', 'edit');
				}
				if (item.name === 'shell') {
					runs++;
					const passing = source.includes('a + b;');
					return { ...result_(item, `$ npm test\n${passing ? 'PASS 3 tests' : 'FAIL add: expected 3, got -1'}\n[exit ${passing ? 0 : 1} · ${runs}.2s]`, 'execute'), ...(passing ? {} : { isError: true }) };
				}
				return result_(item, source);
			}),
			emit: event => events.push(event),
		}), { messages, token });

		assert.strictEqual(result.outcome, 'done');
		assert.ok(!events.some(event => event.type === 'notice' || event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'notice' || event.type === 'error')));
		assert.ok(!messages.some(message => message.role === 'user' && /You called|same failure|back and forth|no new information/.test(message.content)));
	});

	test('a stream that never sends its first chunk times out, is aborted, and is retried', async () => {
		const events: IVoltEvent[] = [];
		const signals: AbortSignal[] = [];
		let attempts = 0;
		const result = await runDeepseekLoop(host({
			streamTimeouts: { firstChunkMs: 40, idleMs: 40 },
			stream: (_messages, _token, options) => {
				attempts++;
				signals.push(options!.signal!);
				return attempts === 1 ? hang(options) : chunks([{ type: 'text-delta', index: 0, text: 'Hello.' }, { type: 'finish', reason: 'stop' }]);
			},
			emit: event => events.push(event),
		}), { messages: [{ role: 'user', content: 'hi', turn: true }], token });

		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, 'Hello.');
		assert.strictEqual(attempts, 2);
		assert.strictEqual(signals[0].aborted, true, 'the stalled request was told to stop');
		assert.strictEqual(signals[1].aborted, false);
		const retry = events.find(event => event.type === 'retry');
		assert.ok(retry && retry.type === 'retry' && /no data for 0s; the stream timed out/.test(retry.message), JSON.stringify(retry));
	});

	test('a stream that stalls after output continues from where it left off', async () => {
		const events: IVoltEvent[] = [];
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'write a story', turn: true }];
		let attempts = 0;
		const result = await runDeepseekLoop(host({
			streamTimeouts: { firstChunkMs: 1_000, idleMs: 40 },
			stream: (_messages, _token, options) => {
				attempts++;
				if (attempts === 1) {
					return (async function* () {
						yield { type: 'text-delta', index: 0, text: 'Once upon a time' } satisfies StreamChunk;
						yield* hang(options);
					})();
				}
				return chunks([{ type: 'text-delta', index: 0, text: ', the end.' }, { type: 'finish', reason: 'stop' }]);
			},
			emit: event => events.push(event),
		}), { messages, token });

		assert.strictEqual(result.outcome, 'done');
		assert.ok(messages.some(message => message.role === 'assistant' && message.content === 'Once upon a time'));
		assert.ok(messages.some(message => message.role === 'user' && message.content.startsWith('Your last response was cut off because the model stream stalled')));
		assert.ok(events.some(event => event.type === 'retry' && /Continuing from where it left off/.test(event.message)));
	});

	test('a reply that starts repeating itself is cut off and nudged; a second runaway stops the run', async () => {
		const events: IVoltEvent[] = [];
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'explain', turn: true }];
		const signals: AbortSignal[] = [];
		const result = await runDeepseekLoop(host({
			stream: (_messages, _token, options) => {
				signals.push(options!.signal!);
				return runaway(options!.signal!);
			},
			emit: event => events.push(event),
		}), { messages, token });

		assert.strictEqual(result.outcome, 'fail');
		assert.strictEqual(result.stopped?.signal, 'runaway');
		assert.strictEqual(signals.length, 2);
		assert.ok(signals.every(signal => signal.aborted), 'both streams were cut');
		const kept = messages.find(message => message.role === 'assistant');
		assert.ok(kept && kept.content.length < 100, `the repeated tail is not replayed: ${kept?.content.length}`);
		assert.ok(messages.some(message => message.role === 'user' && /started repeating the same text/.test(message.content)));
		assert.ok(events.some(event => event.type === 'notice' && /repeating itself/.test(event.title)));
		assert.ok(events.some(event => event.type === 'error' && /^Stopped/.test(event.message)));
	});

	test('the controller sees every step with the loop verdict, and can inject or stop', async () => {
		const seen: IDeepseekStep[] = [];
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'go', turn: true }];
		const result = await runDeepseekLoop(host({
			stream: model([call('read_file', { path: 'a.ts' }), call('read_file', { path: 'a.ts' }), call('read_file', { path: 'a.ts' }), call('read_file', { path: 'b.ts' })]),
			execute: async calls => calls.map(item => result_(item, 'same')),
		}), {
			messages,
			token,
			controller: {
				afterStep: step => {
					seen.push(step);
					if (step.step === 1) {
						return { kind: 'inject', message: 'Remember the style guide.' };
					}
					return step.step === 4 ? { kind: 'stop', reason: 'Enough for now.' } : { kind: 'continue' };
				},
			},
		});

		assert.deepStrictEqual(seen.map(step => step.loop.kind), ['ok', 'ok', 'warn', 'ok']);
		assert.ok(messages.some(message => message.role === 'user' && message.content === 'Remember the style guide.'));
		assert.strictEqual(result.outcome, 'done');
		assert.deepStrictEqual(result.stopped, { by: 'controller', reason: 'Enough for now.' });
	});

	test('the controller can send a finishing model back, but only a bounded number of times', async () => {
		let streams = 0;
		const result = await runDeepseekLoop(host({
			stream: () => {
				streams++;
				return chunks([{ type: 'text-delta', index: 0, text: `Done ${streams}.` }, { type: 'finish', reason: 'stop' }]);
			},
		}), {
			messages: [{ role: 'user', content: 'go', turn: true }],
			token,
			controller: { afterStep: step => step.wantsToFinish ? { kind: 'inject', message: 'Run the tests first.' } : { kind: 'continue' } },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(streams, 3);
	});

	test('a controller that throws is reported and ignored', async () => {
		const events: IVoltEvent[] = [];
		const result = await runDeepseekLoop(host({
			stream: model([call('read_file', { path: 'a.ts' }), text('ok')]),
			execute: async calls => calls.map(item => result_(item, 'x')),
			emit: event => events.push(event),
		}), {
			messages: [{ role: 'user', content: 'go', turn: true }],
			token,
			controller: { afterStep: () => { throw new Error('broken check'); } },
		});
		assert.strictEqual(result.outcome, 'done');
		assert.ok(events.some(event => event.type === 'notice' && event.description === 'broken check'));
	});

	test('loop detection can be turned off', async () => {
		const result = await runDeepseekLoop(host({
			stream: model([...Array.from({ length: 6 }, () => call('read_file', { path: 'a.ts' })), text('ok')]),
			execute: async calls => calls.map(item => result_(item, 'same')),
		}), { messages: [{ role: 'user', content: 'go', turn: true }], token, loopDetection: false });
		assert.strictEqual(result.outcome, 'done');
	});
});

const tools: Record<string, IVoltTool> = {
	read_file: stub('read_file', 'read', 'read', true),
	shell: stub('shell', 'shell', 'execute', false),
	edit_file: stub('edit_file', 'edit', 'edit', false),
};

function stub(name: string, group: IVoltTool['group'], kind: IVoltTool['kind'], parallelSafe: boolean): IVoltTool {
	return { name, group, kind, description: name, schema: {}, parallelSafe, snippet: name, execute: async () => ({ callId: '', name, kind, text: '' }) };
}

function host(partial: Partial<IDeepseekHost> & Pick<IDeepseekHost, 'stream'>): IDeepseekHost {
	return {
		execute: async calls => calls.map(item => result_(item, 'ok')),
		authorize: async () => 'allowed-once',
		emit: () => undefined,
		tool: name => tools[name],
		...partial,
	};
}

function result_(item: IToolCall, text: string, kind: IToolResult['kind'] = 'read'): IToolResult {
	return { callId: item.id, name: item.name, kind, text };
}

type Turn = (id: string) => StreamChunk[];

function call(name: string, args: object): Turn {
	return id => {
		const json = JSON.stringify(args);
		return [
			{ type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
			{ type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
			{ type: 'finish', reason: 'tool_calls' },
		];
	};
}

function text(reply: string): Turn {
	return () => [{ type: 'text-delta', index: 0, text: reply }, { type: 'finish', reason: 'stop' }];
}

/** One scripted turn per model call, with fresh call ids. */
function model(turns: Turn[]): IDeepseekHost['stream'] {
	let turn = 0;
	return () => {
		const next = turns[turn] ?? text('done');
		turn++;
		return chunks(next(`c${turn}`));
	};
}

async function* chunks(list: StreamChunk[]): AsyncGenerator<StreamChunk> {
	yield* list;
}

/** A connection that goes silent and only ends when the loop aborts it. */
async function* hang(options: IDeepseekStreamOptions | undefined): AsyncGenerator<StreamChunk> {
	await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
	throw new Error('aborted');
}

/** A degenerate reply: a short opener, then the same syllable forever, until aborted. */
async function* runaway(signal: AbortSignal): AsyncGenerator<StreamChunk> {
	yield { type: 'text-delta', index: 0, text: 'Here is why. ' };
	for (let i = 0; i < 2_000 && !signal.aborted; i++) {
		yield { type: 'text-delta', index: 0, text: 'na'.repeat(16) };
	}
	yield { type: 'finish', reason: 'stop' };
}
