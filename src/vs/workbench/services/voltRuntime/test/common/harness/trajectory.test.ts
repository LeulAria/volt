/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { StreamChunk } from '../../../common/deepseek/protocol.js';
import { applyTrajectorySync, cacheHitRatio, closeOpenToolRuns, diffRequests, endToolRun, ITrajectoryRequestInput, newTrajectoryRequest, recordStream, startToolRun, summarize, syncTrajectory } from '../../../common/harness/trajectory.js';

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
