/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CollectionMirror, ReplicatedCollection } from '../../common/collections.js';
import { ICollectionDelta } from '../../common/protocol.js';
import { applySessionPatch, reconcile, SessionPatcher } from '../../common/sessionPatch.js';

suite('Agent server replicated state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a collection publishes only what changed', () => {
		const deltas: ICollectionDelta[] = [];
		const col = new ReplicatedCollection('threads', d => deltas.push(d));
		col.update({ a: { n: 1 }, b: { n: 2 } });
		col.update({ a: { n: 1 } });
		col.update({ a: { n: 3 }, b: undefined, c: undefined });
		assert.deepStrictEqual(deltas, [
			{ col: 'threads', put: { a: { n: 1 }, b: { n: 2 } } },
			{ col: 'threads', put: { a: { n: 3 } }, del: ['b'] },
		]);
	});

	test('a published value is a copy the caller cannot change afterwards', () => {
		const deltas: ICollectionDelta[] = [];
		const col = new ReplicatedCollection('x', d => deltas.push(d));
		const value = { list: [1] };
		col.update({ k: value });
		value.list.push(2);
		col.update({ k: value });
		assert.deepStrictEqual(deltas.map(d => d.put?.k), [{ list: [1] }, { list: [1, 2] }]);
	});

	test('replace deletes missing keys', () => {
		const deltas: ICollectionDelta[] = [];
		const col = new ReplicatedCollection('h', d => deltas.push(d));
		col.update({ a: 1, b: 2 });
		col.replace({ b: 2, c: 3 });
		assert.deepStrictEqual(deltas[1], { col: 'h', put: { c: 3 }, del: ['a'] });
		assert.deepStrictEqual(col.snapshot(), { b: 2, c: 3 });
	});

	test('a mirror follows deltas and snapshots', () => {
		const mirror = new CollectionMirror();
		const changes: string[] = [];
		const listener = mirror.onDidChange(e => changes.push(`${e.col}:${[...e.keys].sort().join(',')}:${e.reset}`));
		mirror.applySnapshot({ t: { a: 1, b: 2 } });
		mirror.applyDelta({ col: 't', put: { c: 3 }, del: ['a', 'zz'] });
		assert.deepStrictEqual(mirror.entries('t'), [['b', 2], ['c', 3]]);
		mirror.applySnapshot({ u: { x: 1 } });
		assert.deepStrictEqual(mirror.values('t'), []);
		assert.deepStrictEqual(mirror.get('u', 'x'), 1);
		assert.deepStrictEqual(changes, ['t:a,b:true', 't:a,c:false', 't:b,c:true', 'u:x:true']);
		listener.dispose();
		mirror.dispose();
	});

	test('session patches carry only changed messages and apply in order', () => {
		const patcher = new SessionPatcher('s1');
		const server = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'He' }];
		patcher.reset(server);
		const client: unknown[] = JSON.parse(JSON.stringify(server));
		let rev = 0;

		server[1].text = 'Hello';
		const p1 = patcher.diff(server)!;
		assert.deepStrictEqual(p1.set.map(s => s.i), [1]);
		assert.ok(applySessionPatch(client, rev, p1));
		rev = p1.rev;

		assert.strictEqual(patcher.diff(server), undefined, 'no change, no patch');

		server.push({ role: 'user', text: 'again' });
		const p2 = patcher.diff(server)!;
		server.length = 1;
		const p3 = patcher.diff(server)!;
		assert.strictEqual(p3.len, 1);

		assert.strictEqual(applySessionPatch(client, rev, p3), false, 'skipping a revision is refused');
		assert.ok(applySessionPatch(client, rev, p2));
		assert.ok(applySessionPatch(client, p2.rev, p3));
		assert.deepStrictEqual(client, server);
	});

	test('reconcile keeps surviving objects as the same instances', () => {
		const block = { type: 'tool', status: 'streaming' };
		const message = { segments: [{ kind: 'text', text: 'a' }, { kind: 'block', block }], extra: true };
		const next = JSON.parse(JSON.stringify(message));
		next.segments[0].text = 'ab';
		next.segments[1].block.status = 'complete';
		next.segments.push({ kind: 'text', text: 'c' });
		delete next.extra;
		const result = reconcile(message, next) as typeof message;
		assert.strictEqual(result, message);
		assert.strictEqual(result.segments[1].block, block);
		assert.strictEqual(block.status, 'complete');
		assert.deepStrictEqual(result, next);
	});
});
