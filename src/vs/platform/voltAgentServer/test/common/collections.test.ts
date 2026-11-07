/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CollectionMirror, ReplicatedCollection } from '../../common/collections.js';
import { ICollectionDelta } from '../../common/protocol.js';
import { applySessionEdits, applySessionPatch, reconcile, SessionPatcher, sessionEdits } from '../../common/sessionPatch.js';

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

	interface ITestMessage {
		kind: string;
		text?: string;
		segments?: { kind: string; text?: string; block?: { id: string; output: string } }[];
		activity?: { streaming?: boolean; label?: string };
		uri?: { $mid: number; path: string };
	}

	const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

	test('compact patches carry a streaming reply as what changed in it, and apply to the same result', () => {
		const patcher = new SessionPatcher('s1');
		const output = 'x'.repeat(4000);
		const server: ITestMessage[] = [
			{ kind: 'user', text: 'hi' },
			{ kind: 'agent', segments: [{ kind: 'block', block: { id: 'b1', output } }, { kind: 'text', text: 'He' }], activity: { streaming: true, label: 'Writing' } },
		];
		patcher.reset(server);
		const viaFull: unknown[] = copy(server);
		const viaEdits: unknown[] = copy(server);
		let rev = 0;
		const step = (expectEdits: unknown) => {
			const patches = patcher.diffPatches(server)!;
			assert.deepStrictEqual(patches.compact.edit, expectEdits);
			assert.deepStrictEqual(patches.compact.set, []);
			assert.ok(applySessionPatch(viaFull, rev, patches.full));
			assert.ok(applySessionPatch(viaEdits, rev, patches.compact));
			rev = patches.full.rev;
			assert.deepStrictEqual(viaFull, server);
			assert.deepStrictEqual(viaEdits, server);
		};

		server[1].segments![1].text = 'Hello';
		step([{ i: 1, edits: [{ p: ['segments', 1, 'text'], s: 'llo', at: 2 }] }]);

		server[1].segments!.push({ kind: 'text', text: ' there' });
		delete server[1].activity!.label;
		step([{ i: 1, edits: [{ p: ['segments', 2], v: { kind: 'text', text: ' there' } }, { p: ['activity', 'label'], x: 1 }] }]);

		server[1].segments!.length = 1;
		server[1].activity!.streaming = false;
		step([{ i: 1, edits: [{ p: ['segments'], n: 1 }, { p: ['activity', 'streaming'], v: false }] }]);

		// A new message, and one that changed everywhere, go whole.
		server.push({ kind: 'user', text: 'next' });
		server[0] = { kind: 'notice', text: 'x' };
		const patches = patcher.diffPatches(server)!;
		assert.deepStrictEqual(patches.compact.set.map(s => s.i), [0, 2]);
		assert.strictEqual(patches.compact.edit, undefined);
		assert.ok(applySessionPatch(viaEdits, rev, patches.compact));
		assert.deepStrictEqual(viaEdits, server);
	});

	test('a value encoded for the wire changes whole', () => {
		const patcher = new SessionPatcher('s1');
		const server: ITestMessage[] = [{ kind: 'agent', text: 'a long enough reply to make edits worth it', uri: { $mid: 1, path: '/a' } }];
		patcher.reset(server);
		server[0].uri = { $mid: 1, path: '/b' };
		assert.deepStrictEqual(patcher.diffPatches(server)!.compact.edit, [{ i: 0, edits: [{ p: ['uri'], v: { $mid: 1, path: '/b' } }] }]);
	});

	test('a streaming diff reads only the current turn until the whole transcript is compared', () => {
		const encoded: number[] = [];
		const server: ITestMessage[] = [{ kind: 'user', text: 'one' }, { kind: 'agent', text: 'two' }, { kind: 'user', text: 'three' }, { kind: 'agent', text: 'fo' }];
		const patcher = new SessionPatcher('s1', message => {
			encoded.push(server.indexOf(message as ITestMessage));
			return message;
		});
		patcher.reset(server);
		encoded.length = 0;
		server[1].text = 'two, edited';
		server[3].text = 'four';
		const tail = patcher.diffPatches(server, undefined, 2)!;
		assert.deepStrictEqual(encoded, [2, 3]);
		assert.deepStrictEqual(tail.full.set.map(s => s.i), [3]);
		const whole = patcher.diffPatches(server)!;
		assert.deepStrictEqual(whole.full.set.map(s => s.i), [1]);
	});

	test('edits that do not fit what the client holds are refused', () => {
		assert.strictEqual(applySessionEdits({ t: 'ab' }, [{ p: ['t'], s: 'c', at: 3 }]), false, 'text of another length');
		assert.strictEqual(applySessionEdits({ t: 'ab' }, [{ p: ['missing', 't'], v: 1 }]), false, 'no such parent');
		assert.strictEqual(applySessionEdits({ a: [1] }, [{ p: ['a', 'x'], v: 1 }]), false, 'a key on an array');
		assert.strictEqual(applySessionEdits({ a: [1] }, [{ p: ['a', 3], v: 1 }]), false, 'a hole in an array');
		assert.strictEqual(applySessionEdits({}, [{ p: ['__proto__', 'polluted'], v: true }]), false);
		assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);
		assert.strictEqual(sessionEdits('a', 'b'), undefined, 'a changed root is a whole replacement');
	});
});
