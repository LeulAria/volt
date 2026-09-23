/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { runDeepseekLoop, IDeepseekHost } from '../../../common/deepseek/loop.js';
import { StreamChunk } from '../../../common/deepseek/protocol.js';
import { IVoltEvent } from '../../../common/events.js';
import { IToolResult, IVoltTool } from '../../../common/tools/tool.js';

suite('DeepSeek loop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a price question streams text and does not invent a lane, plan, or prefetch', async () => {
		const events: IVoltEvent[] = [];
		let sawTextBeforeStepEnd = false;
		const result = await runDeepseekLoop(host({
			stream: script([
				[
					{ type: 'text-delta', index: 0, text: 'About 120000 AED in the UAE.' },
					{ type: 'finish', reason: 'stop' },
				],
			]),
			emit: event => {
				if (event.type === 'text.delta' && !events.some(item => item.type === 'step.end')) {
					sawTextBeforeStepEnd = true;
				}
				events.push(event);
			},
		}), {
			messages: [{ role: 'user', content: 'how much is a Nissan Kicks in the UAE' }],
			token: { isCancellationRequested: false },
		});

		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, 'About 120000 AED in the UAE.');
		assert.strictEqual(sawTextBeforeStepEnd, true);
		assert.ok(!events.some(event => event.type === 'lane' || event.type === 'plan' || event.type === 'prefetch' || event.type === 'clarify'));
	});

	test('shell is presented as a terminal card before it runs', async () => {
		const events: IVoltEvent[] = [];
		let executed = 0;
		await runDeepseekLoop(host({
			stream: script([
				[
					{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'shell', argumentsDelta: '{"command":"npm test"}' },
					{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'shell', arguments: '{"command":"npm test"}' } },
					{ type: 'finish', reason: 'tool_calls' },
				],
				[
					{ type: 'text-delta', index: 0, text: 'Tests passed.' },
					{ type: 'finish', reason: 'stop' },
				],
			]),
			execute: async () => {
				executed++;
				return [{ callId: 'c1', name: 'shell', kind: 'execute', text: 'ok' }];
			},
			tool: name => name === 'shell' ? tool('shell', 'shell', 'execute') : undefined,
			emit: event => events.push(event),
		}), {
			messages: [{ role: 'user', content: 'run the tests' }],
			token: { isCancellationRequested: false },
		});

		const presented = events.find(event => event.type === 'tool.start' && event.card === 'terminal');
		assert.ok(presented && presented.type === 'tool.start');
		assert.strictEqual(presented.title, 'npm test');
		assert.strictEqual(executed, 1);
		const end = events.find(event => event.type === 'tool.end' && event.callId === 'c1' && event.card === 'terminal');
		assert.ok(end && end.type === 'tool.end' && end.output === 'ok');
	});

	test('a successful finish tool ends the turn', async () => {
		let streams = 0;
		const events: IVoltEvent[] = [];
		const result = await runDeepseekLoop(host({
			stream: async function* () {
				streams++;
				yield { type: 'tool-call-delta', index: 0, id: 'f1', name: 'finish', argumentsDelta: '{"summary":"Shipped the header."}' };
				yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'f1', name: 'finish', arguments: '{"summary":"Shipped the header."}' } };
				yield { type: 'finish', reason: 'tool_calls' };
			} as IDeepseekHost['stream'],
			execute: async (calls): Promise<readonly IToolResult[]> => calls.map(call => ({
				callId: call.id,
				name: call.name,
				kind: 'think',
				text: JSON.stringify({ summary: 'Shipped the header.' }),
			})),
			tool: name => name === 'finish' ? tool('finish', 'meta', 'think') : undefined,
			emit: event => events.push(event),
		}), {
			messages: [{ role: 'user', content: 'add a header' }],
			token: { isCancellationRequested: false },
		});

		assert.strictEqual(streams, 1);
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, 'Shipped the header.');
		assert.ok(events.some(event => event.type === 'text.delta' && event.delta === 'Shipped the header.'));
	});

	test('tool contexts reach the next model call', async () => {
		let followUp = '';
		await runDeepseekLoop(host({
			stream: (() => {
				let turn = 0;
				return async function* (messages) {
					turn++;
					if (turn === 1) {
						yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read_file', argumentsDelta: '{"path":"a.ts"}' };
						yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } };
						yield { type: 'finish', reason: 'tool_calls' };
						return;
					}
					followUp = messages.map(message => message.content).join('\n');
					yield { type: 'text-delta', index: 0, text: 'Done.' };
					yield { type: 'finish', reason: 'stop' };
				};
			})(),
			execute: async () => [{ callId: 'c1', name: 'read_file', kind: 'read', text: 'a.ts lines 1-1 of 1\n1 | hello', contexts: ['The user is looking at a.ts.'] }],
			tool: name => name === 'read_file' ? tool('read_file', 'read', 'read') : undefined,
		}), {
			messages: [{ role: 'user', content: 'what is in a.ts' }],
			token: { isCancellationRequested: false },
		});
		assert.ok(followUp.includes('The user is looking at a.ts.'));
	});

	test('a truncated tool call is closed and not executed', async () => {
		let executed = 0;
		const events: IVoltEvent[] = [];
		const result = await runDeepseekLoop(host({
			stream: script([
				[
					{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'shell', argumentsDelta: '{"command":' },
					{ type: 'finish', reason: 'length' },
				],
				[
					{ type: 'text-delta', index: 0, text: 'Done.' },
					{ type: 'finish', reason: 'stop' },
				],
			]),
			execute: async () => {
				executed++;
				return [];
			},
			tool: () => tool('shell', 'shell', 'execute'),
			emit: event => events.push(event),
		}), {
			messages: [{ role: 'user', content: 'run it' }],
			token: { isCancellationRequested: false },
			budget: { maxToolCalls: 10, maxModelCalls: 4 },
		});

		assert.strictEqual(executed, 0);
		assert.ok(events.some(event => event.type === 'tool.end' && event.callId === 'c1' && !!event.error?.includes('truncated')));
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(result.assistant, 'Done.');
	});
});

function host(partial: Partial<IDeepseekHost> & Pick<IDeepseekHost, 'stream'>): IDeepseekHost {
	return {
		execute: async () => [],
		authorize: async () => 'allowed-once',
		emit: () => undefined,
		tool: () => undefined,
		...partial,
	};
}

function script(turns: StreamChunk[][]): IDeepseekHost['stream'] {
	let turn = 0;
	return async function* () {
		const chunks = turns[turn] ?? [];
		turn++;
		for (const chunk of chunks) {
			yield chunk;
		}
	};
}

function tool(name: string, group: IVoltTool['group'], kind: IVoltTool['kind']): IVoltTool {
	return {
		name,
		group,
		kind,
		description: name,
		schema: {},
		parallelSafe: true,
		snippet: name,
		execute: async () => ({ callId: '', name, kind, text: '' }),
	};
}
