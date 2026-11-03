/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IVoltEvent, IVoltEventEnvelope } from '../../../../workbench/services/voltRuntime/common/events.js';
import { StreamDeltaCoalescer } from '../../../node/voltAgent/streamDeltaCoalescer.js';

suite('Agent server stream delta coalescer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let seq = 0;
	const envelope = (sessionId: string, event: IVoltEvent, runId = 'r1'): IVoltEventEnvelope => ({ seq: ++seq, runId, sessionId, timestamp: seq, event });

	function setup() {
		const out: IVoltEventEnvelope[] = [];
		// Flushed by hand: the timer would only fire after the test.
		const coalescer = store.add(new StreamDeltaCoalescer(e => out.push(e), 60_000));
		return { out, coalescer };
	}

	test('a chat\'s back-to-back text deltas go out as one, before its next event', () => {
		const { out, coalescer } = setup();
		coalescer.push(envelope('a', { type: 'text.delta', id: 't', delta: 'Hel' }));
		coalescer.push(envelope('a', { type: 'text.delta', id: 't', delta: 'lo' }));
		assert.strictEqual(out.length, 0);
		coalescer.push(envelope('a', { type: 'tool.start', callId: 'c1', name: 'read' } as IVoltEvent));
		assert.deepStrictEqual(out.map(e => e.event), [{ type: 'text.delta', id: 't', delta: 'Hello' }, { type: 'tool.start', callId: 'c1', name: 'read' }]);
	});

	test('chats gather apart; deltas of another kind, text block or run are not joined', () => {
		const { out, coalescer } = setup();
		coalescer.push(envelope('a', { type: 'text.delta', id: 't', delta: 'a1' }));
		coalescer.push(envelope('b', { type: 'reasoning.delta', id: 'r', delta: 'b1' }));
		coalescer.push(envelope('a', { type: 'text.delta', id: 't', delta: 'a2' }));
		coalescer.push(envelope('b', { type: 'reasoning.delta', id: 'r', delta: 'b2' }));
		coalescer.push(envelope('a', { type: 'text.delta', id: 'u', delta: 'a3' }));
		coalescer.push(envelope('b', { type: 'reasoning.delta', id: 'r', delta: 'b3' }, 'r2'));
		coalescer.flush();
		assert.deepStrictEqual(out.map(e => [e.sessionId, (e.event as { delta?: string }).delta]), [['a', 'a1a2'], ['b', 'b1b2'], ['a', 'a3'], ['b', 'b3']]);
	});

	test('appended tool input joins; a tool\'s progress keeps its latest line; replaced input is sent as is', () => {
		const { out, coalescer } = setup();
		coalescer.push(envelope('a', { type: 'tool.input.delta', callId: 'c', delta: '{"pa', append: true }));
		coalescer.push(envelope('a', { type: 'tool.input.delta', callId: 'c', delta: 'th":1}', append: true }));
		coalescer.push(envelope('a', { type: 'tool.input.delta', callId: 'c', delta: '{"path":2}' }));
		coalescer.push(envelope('a', { type: 'tool.progress', callId: 'c', status: '10%' }));
		coalescer.push(envelope('a', { type: 'tool.progress', callId: 'c', status: '20%' }));
		coalescer.dispose();
		assert.deepStrictEqual(out.map(e => e.event), [
			{ type: 'tool.input.delta', callId: 'c', delta: '{"path":1}', append: true },
			{ type: 'tool.input.delta', callId: 'c', delta: '{"path":2}' },
			{ type: 'tool.progress', callId: 'c', status: '20%' },
		]);
	});
});
