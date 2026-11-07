/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { StreamChunk } from '../../../common/deepseek/protocol.js';
import { IVoltEvent } from '../../../common/events.js';
import { AgentTrajectoryRecorder, applyTrajectorySync, cacheHitRatio, closeOpenToolRuns, diffRequests, endToolRun, IAgentTrajectorySink, IAgentTrajectoryTarget, ITrajectoryRequest, ITrajectoryRequestInput, newTrajectoryRequest, recordStream, startToolRun, summarize, syncTrajectory } from '../../../common/harness/trajectory.js';

function input(overrides: Partial<ITrajectoryRequestInput> = {}): ITrajectoryRequestInput {
	return {
		id: 'r1',
		sessionId: 's',
		runId: 'run',
		index: 1,
		provider: 'anthropic',
		model: 'claude',
		system: 'You are Volt.',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ name: 'read', description: 'Reads a file.', parameters: { type: 'object' } }],
		...overrides,
	};
}

async function* chunks(list: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
	yield* list;
}

suite('Trajectory', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('records the response while passing every chunk through', async () => {
		const request = newTrajectoryRequest(input());
		const source: StreamChunk[] = [
			{ type: 'block-start', index: 0, blockType: 'reasoning' },
			{ type: 'reasoning-delta', index: 0, text: 'think' },
			{ type: 'block-start', index: 1, blockType: 'text' },
			{ type: 'text-delta', index: 1, text: 'Hel' },
			{ type: 'text-delta', index: 1, text: 'lo' },
			{ type: 'block-end', index: 2, block: { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' } },
			{ type: 'event', event: { type: 'retry', attempt: 1, delayMs: 1000, message: 'overloaded' } },
			{ type: 'usage', usage: { input: 10, output: 5, cache: 90 } },
			{ type: 'finish', reason: 'tool_calls' },
		];
		const seen: StreamChunk[] = [];
		for await (const chunk of recordStream(chunks(source), request, () => { })) {
			seen.push(chunk);
		}
		assert.deepStrictEqual(seen, source);
		assert.strictEqual(request.response.text, 'Hello');
		assert.strictEqual(request.response.reasoning, 'think');
		assert.deepStrictEqual(request.response.toolCalls, [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }]);
		assert.strictEqual(request.finish, 'tool_calls');
		assert.strictEqual(request.notes[0].kind, 'retry');
		assert.ok(request.endedAt !== undefined && request.firstChunkAt !== undefined);
		assert.strictEqual(cacheHitRatio(request.usage), 0.9);
	});

	test('a thrown stream is recorded as an error and still throws', async () => {
		const request = newTrajectoryRequest(input());
		async function* failing(): AsyncGenerator<StreamChunk> {
			yield { type: 'text-delta', index: 0, text: 'x' };
			throw new Error('boom');
		}
		await assert.rejects(async () => {
			for await (const _ of recordStream(failing(), request, () => { })) { /* drain */ }
		}, /boom/);
		assert.strictEqual(request.error, 'boom');
		assert.ok(request.endedAt !== undefined);
	});

	test('diff: appended messages keep the cache; a rewritten one or a new tool breaks it', () => {
		const first = newTrajectoryRequest(input());
		const appended = newTrajectoryRequest(input({ id: 'r2', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] }));
		const kept = diffRequests(first, appended);
		assert.strictEqual(kept.cacheBreak, undefined);
		assert.strictEqual(kept.sharedPrefix, 1);
		assert.strictEqual(kept.added, 1);

		const compacted = newTrajectoryRequest(input({ id: 'r3', messages: [{ role: 'user', content: 'summary' }] }));
		assert.match(diffRequests(appended, compacted).cacheBreak ?? '', /2 earlier messages changed/);

		const moreTools = newTrajectoryRequest(input({ id: 'r4', tools: [...first.tools, { name: 'grep', description: '', parameters: {} }] }));
		const tools = diffRequests(first, moreTools);
		assert.deepStrictEqual(tools.toolsAdded, ['grep']);
		assert.strictEqual(tools.cacheBreak, 'the tool list changed');
	});

	test('tool runs are timed against their request; open ones close as cancelled', () => {
		const request = newTrajectoryRequest(input());
		startToolRun(request, { id: 'a', name: 'read', args: {} }, 100);
		startToolRun(request, { id: 'b', name: 'grep', args: {} }, 100);
		endToolRun(request, { callId: 'a', name: 'read', kind: 'read', text: 'contents', isError: true }, 350);
		closeOpenToolRuns(request, 500);
		assert.strictEqual(request.toolRuns[0].durationMs, 250);
		assert.strictEqual(request.toolRuns[0].isError, true);
		assert.strictEqual(request.toolRuns[1].cancelled, true);
		const summary = summarize([request]);
		assert.strictEqual(summary.toolCalls, 2);
		assert.strictEqual(summary.toolErrors, 1);
	});

	test('sync: a window gets new requests whole, then only what grew, and ends up with the same requests', () => {
		const first = newTrajectoryRequest(input());
		const second = newTrajectoryRequest(input({ id: 'r2', index: 2 }));
		const initial = syncTrajectory([first, second], {});
		assert.deepStrictEqual(initial.ids, ['r1', 'r2']);
		assert.strictEqual(initial.requests.length, 2);
		// Over the wire, as the agent server sends it.
		let held = applyTrajectorySync([], JSON.parse(JSON.stringify(initial)));
		assert.deepStrictEqual(held, JSON.parse(JSON.stringify([first, second])));

		second.response.text = 'streamed';
		startToolRun(second, { id: 'c', name: 'read', args: { path: 'a' } }, 10);
		const grown = syncTrajectory([first, second], initial.revisions);
		assert.deepStrictEqual(grown.requests.map(request => request.id), ['r2']);
		assert.strictEqual(grown.requests[0].messages, undefined, 'the messages it went out with are not sent again');
		held = applyTrajectorySync(held, JSON.parse(JSON.stringify(grown)));
		assert.strictEqual(held[1].response.text, 'streamed');
		assert.strictEqual(held[1].toolRuns.length, 1);
		assert.deepStrictEqual(held[1].messages, second.messages);

		// Nothing changed: nothing sent. Dropped from the server (cap, clear): dropped here.
		assert.strictEqual(syncTrajectory([first, second], grown.revisions).requests.length, 0);
		const trimmed = syncTrajectory([second], grown.revisions);
		assert.deepStrictEqual(applyTrajectorySync(held, trimmed).map(request => request.id), ['r2']);
	});
});

suite('Trajectory of an agent Volt does not run', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A recorder over an in-memory chat (as the trajectory service keeps it), on a clock the test moves. */
	function recorder(options: { enabled?: boolean } = {}) {
		const requests: ITrajectoryRequest[] = [];
		let clock = 1_000;
		let changes = 0;
		const sink: IAgentTrajectorySink = {
			begin: request => {
				if (options.enabled === false) {
					return undefined;
				}
				const recorded = newTrajectoryRequest({ ...request, id: `r${requests.length + 1}`, index: requests.length + 1 }, clock);
				requests.push(recorded);
				return recorded;
			},
			changed: () => changes++,
		};
		const target: IAgentTrajectoryTarget = { sessionId: 's', runId: 'run', provider: 'claude-code', model: 'opus', modelLabel: 'Opus 5.5', harness: 'Claude' };
		const trace = new AgentTrajectoryRecorder(sink, target, undefined, () => clock);
		return {
			trace,
			requests,
			changes: () => changes,
			at: (time: number, ...events: IVoltEvent[]) => {
				clock = time;
				for (const event of events) {
					trace.event(event);
				}
			},
		};
	}

	test('each answer is a request: it ends where it asks for tools, the next starts when their results are in', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('Fix the bug');
		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual(requests[0].messages, [{ role: 'user', content: 'Fix the bug' }]);
		assert.strictEqual(requests[0].harness, 'Claude');
		assert.strictEqual(requests[0].system, '');
		assert.deepStrictEqual(requests[0].tools, []);

		at(1_400, { type: 'reasoning.delta', id: 't', delta: 'Look at a.ts' });
		at(1_500, { type: 'text.delta', id: 'm1', delta: 'Reading.' });
		assert.strictEqual(requests[0].firstChunkAt, 1_400, 'time to first token counts from the prompt');
		assert.strictEqual(requests[0].endedAt, undefined, 'still answering');
		// One answer asks for two tools at once.
		at(1_600, { type: 'tool.start', callId: 'a', name: 'Read a.ts', input: '{"path":"a.ts"}' });
		at(1_650, { type: 'tool.start', callId: 'b', name: 'Read b.ts' });
		at(1_660, { type: 'tool.input.delta', callId: 'b', delta: '{"path":"b.ts"}' });
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].endedAt, 1_650);
		assert.strictEqual(requests[0].finish, 'tool_calls');
		assert.deepStrictEqual(requests[0].response.toolCalls.map(call => call.arguments), ['{"path":"a.ts"}', '{"path":"b.ts"}']);
		assert.deepStrictEqual(requests[0].toolRuns[1].args, { path: 'b.ts' }, 'input sent after the call is announced');

		at(1_900, { type: 'tool.end', callId: 'a', result: [{ type: 'content', content: { type: 'text', text: 'export const a = 1;' } }] });
		at(2_300, { type: 'tool.end', callId: 'b', result: 'no such file', error: 'Tool failed' });
		assert.strictEqual(requests.length, 1, 'tool results alone do not start a request');
		assert.strictEqual(requests[0].toolRuns[0].durationMs, 300);
		assert.strictEqual(requests[0].toolRuns[0].result, 'export const a = 1;');
		assert.strictEqual(requests[0].toolRuns[1].isError, true);
		assert.strictEqual(requests[0].toolRuns[1].result, 'Tool failed\nno such file');

		at(3_000, { type: 'text.delta', id: 'm2', delta: 'Fixed it.' });
		assert.strictEqual(requests.length, 2);
		const second = requests[1];
		assert.strictEqual(second.startedAt, 2_300, 'went out when the last result came back');
		assert.strictEqual(second.firstChunkAt, 3_000);
		assert.deepStrictEqual(second.messages.map(message => [message.role, message.name ?? '', message.content]), [
			['assistant', '', 'Reading.'],
			['tool', 'Read a.ts', 'export const a = 1;'],
			['tool', 'Read b.ts', 'Tool failed\nno such file'],
		]);
		assert.deepStrictEqual(second.messages[0].toolCalls, [{ id: 'a', name: 'Read a.ts', args: { path: 'a.ts' } }, { id: 'b', name: 'Read b.ts', args: { path: 'b.ts' } }]);
		assert.strictEqual(second.messages[2].isError, true);

		at(3_200, { type: 'text.delta', id: 'm2', delta: ' Done.' });
		trace.end('done');
		assert.strictEqual(second.response.text, 'Fixed it. Done.');
		assert.strictEqual(second.endedAt, 3_200);
		assert.strictEqual(second.finish, 'stop');
		assert.strictEqual(requests[0].finish, 'tool_calls');
	});

	test('an answer that starts with a tool call after results is a new request too', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'tool.start', callId: 'a', name: 'ls' });
		at(1_200, { type: 'tool.end', callId: 'a', result: 'a.ts' });
		at(1_500, { type: 'tool.start', callId: 'b', name: 'cat a.ts' });
		at(1_600, { type: 'tool.end', callId: 'b', result: 'x' });
		at(1_700, { type: 'tool.start', callId: 'b', name: 'cat a.ts' });
		trace.end('done');
		assert.deepStrictEqual(requests.map(request => request.toolRuns.map(run => run.callId)), [['a'], ['b']], 'a repeated tool_call for a known id is not a new call');
		assert.strictEqual(requests[1].startedAt, 1_200);
		assert.strictEqual(requests[1].firstChunkAt, 1_500);
		assert.deepStrictEqual(requests[1].messages.map(message => message.role), ['assistant', 'tool']);
	});

	test('a result that comes back after the model spoke again goes to the request after', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'tool.start', callId: 'bg', name: 'npm run dev' });
		at(1_150, { type: 'tool.start', callId: 'a', name: 'ls' });
		at(1_200, { type: 'tool.end', callId: 'a', result: 'a.ts' });
		at(1_300, { type: 'text.delta', id: 'm', delta: 'Started.' });
		at(1_400, { type: 'tool.end', callId: 'bg', result: 'ready on :3000' });
		assert.strictEqual(requests[0].toolRuns[0].endedAt, 1_400, 'the long call still ends on the request that asked for it');
		assert.strictEqual(requests[0].toolRuns[0].cancelled, undefined);
		at(1_500, { type: 'tool.start', callId: 'c', name: 'curl :3000' });
		at(1_600, { type: 'tool.end', callId: 'c', result: 'ok' });
		at(1_700, { type: 'text.delta', id: 'm2', delta: 'Works.' });
		trace.end('done');
		assert.strictEqual(requests.length, 3);
		assert.deepStrictEqual(requests[2].messages.filter(message => message.role === 'tool').map(message => message.content), ['ready on :3000', 'ok']);
	});

	test('usage: tokens once a turn on its last request, context size on the request it followed', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'tool.start', callId: 'a', name: 'ls' });
		at(1_150, { type: 'usage', input: 0, output: 0, used: 21_000, size: 200_000 });
		at(1_200, { type: 'tool.end', callId: 'a', result: 'a.ts' });
		at(1_300, { type: 'text.delta', id: 'm', delta: 'Done.' });
		at(1_400, { type: 'usage', input: 0, output: 0, used: 22_500, size: 200_000, costUsd: 0.4 });
		at(1_450, { type: 'usage', input: 120, output: 900, cache: 41_000, cacheWrite: 2_000, costUsd: 0.4 });
		trace.end('done');
		assert.strictEqual(requests[0].contextTokens, 21_000);
		assert.strictEqual(requests[0].contextWindow, 200_000);
		assert.strictEqual(requests[0].usage, undefined);
		assert.strictEqual(requests[1].contextTokens, 22_500);
		assert.deepStrictEqual(requests[1].usage, { input: 120, output: 900, cache: 41_000, cacheWrite: 2_000 });
		assert.strictEqual(requests[1].usageScope, 'turn');
		assert.strictEqual(requests[1].costUsd, undefined, "Claude's cost is a running session total, not this request's");
		const summary = summarize(requests);
		assert.deepStrictEqual([summary.input, summary.output, summary.cache, summary.cacheWrite], [120, 900, 41_000, 2_000], 'the panel totals count the turn once');
	});

	test('a one-request turn owns its usage outright', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('hi');
		at(1_200, { type: 'text.delta', id: 'm', delta: 'Hello' });
		at(1_300, { type: 'usage', input: 10, output: 5 });
		trace.end('done');
		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual(requests[0].usage, { input: 10, output: 5, cache: 0, cacheWrite: 0 });
		assert.strictEqual(requests[0].usageScope, undefined);
	});

	test('a stopped turn ends its request and the calls that never reported', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'tool.start', callId: 'a', name: 'sleep 60' });
		at(5_000);
		trace.end('abort');
		assert.strictEqual(requests[0].finish, 'tool_calls', 'it did answer: it asked for a tool');
		assert.strictEqual(requests[0].toolRuns[0].cancelled, true);
		assert.strictEqual(requests[0].toolRuns[0].endedAt, 5_000);

		const streaming = recorder();
		streaming.trace.prompt('go');
		streaming.at(1_100, { type: 'text.delta', id: 'm', delta: 'Wri' });
		streaming.at(1_200);
		streaming.trace.end('abort');
		assert.strictEqual(streaming.requests[0].finish, 'aborted');
		assert.strictEqual(streaming.requests[0].endedAt, 1_200);
	});

	test('a failed turn says why on its last request', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'retry', attempt: 1, delayMs: 2_000, message: 'overloaded' });
		at(1_200, { type: 'error', message: 'Usage limit reached' });
		trace.end('fail');
		assert.strictEqual(requests[0].finish, 'error');
		assert.strictEqual(requests[0].error, 'Usage limit reached');
		assert.deepStrictEqual(requests[0].notes.map(note => note.kind), ['retry', 'error']);
		assert.strictEqual(summarize(requests).errors, 1);
		assert.strictEqual(summarize(requests).retries, 1);
	});

	test("subagents' answers are requests of their own, named for the subagent", () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'tool.start', callId: 'task', name: 'Task' });
		at(1_150, { type: 'subagent.spawned', childId: 'c1', parentToolCallId: 'task', title: 'Explore', prompt: 'Find the config', source: 'claude' });
		at(1_200, { type: 'subagent.event', childId: 'c1', event: { type: 'tool.start', callId: 'g', name: 'Grep config' } });
		at(1_300, { type: 'subagent.event', childId: 'c1', event: { type: 'tool.end', callId: 'g', result: 'config.ts' } });
		at(1_400, { type: 'subagent.event', childId: 'c1', event: { type: 'text.delta', id: 'x', delta: 'It is config.ts' } });
		at(1_500, { type: 'subagent.completed', childId: 'c1', status: 'completed' });
		at(1_600, { type: 'tool.end', callId: 'task', result: 'It is config.ts' });
		at(1_700, { type: 'text.delta', id: 'm', delta: 'Found it.' });
		trace.end('done');
		assert.deepStrictEqual(requests.map(request => [request.agent ?? 'main', request.messages.map(message => message.role).join('+')]), [
			['main', 'user'],
			['Explore', 'user'],
			['Explore', 'assistant+tool'],
			['main', 'assistant+tool'],
		]);
		assert.strictEqual(requests[1].messages[0].content, 'Find the config');
		assert.strictEqual(requests[2].finish, 'stop');
		assert.strictEqual(requests[2].endedAt, 1_500);
	});

	test('records nothing while recording is off', () => {
		const { trace, requests, at, changes } = recorder({ enabled: false });
		trace.prompt('go');
		at(1_100, { type: 'text.delta', id: 'm', delta: 'x' }, { type: 'tool.start', callId: 'a', name: 'ls' }, { type: 'tool.end', callId: 'a' });
		trace.end('done');
		assert.strictEqual(requests.length, 0);
		assert.strictEqual(changes(), 0);
	});

	test('a window syncing while the agent works sees its tool input, context size and turn usage arrive', () => {
		const { trace, requests, at } = recorder();
		trace.prompt('go');
		at(1_100, { type: 'tool.start', callId: 'a', name: 'Edit' });
		const first = syncTrajectory(requests, {});
		at(1_150, { type: 'tool.input.delta', callId: 'a', delta: '{"file":"a.ts"}' });
		const input = syncTrajectory(requests, first.revisions);
		assert.strictEqual(input.requests.length, 1, 'the tool input changes the revision');
		at(1_200, { type: 'usage', input: 0, output: 0, used: 9_000 });
		const context = syncTrajectory(requests, input.revisions);
		assert.strictEqual(context.requests.length, 1, 'the context size changes the revision');
		at(1_300, { type: 'usage', input: 1, output: 2 });
		trace.end('done');
		let held = applyTrajectorySync([], JSON.parse(JSON.stringify(first)));
		held = applyTrajectorySync(held, JSON.parse(JSON.stringify(syncTrajectory(requests, first.revisions))));
		assert.deepStrictEqual(held, JSON.parse(JSON.stringify(requests)));
		assert.strictEqual(held[0].harness, 'Claude');
	});
});
