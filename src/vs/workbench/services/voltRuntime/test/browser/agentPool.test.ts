/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentPool, ISpareRequest } from '../../browser/agentPool.js';
import { IAgentSessionHandle } from '../../common/providers.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeAgents {
	readonly started: string[] = [];
	readonly disposed: string[] = [];
	readonly dead = new Set<string>();
	readonly pending = new Map<string, DeferredPromise<IAgentSessionHandle>>();
	manual = false;
	fail = false;

	request(key: string): ISpareRequest {
		return {
			key,
			providerId: 'cursor-acp',
			start: async alias => {
				this.started.push(alias);
				if (this.fail) {
					throw new Error('spawn failed');
				}
				if (this.manual) {
					const deferred = new DeferredPromise<IAgentSessionHandle>();
					this.pending.set(alias, deferred);
					return deferred.p;
				}
				return { id: `h-${alias}` };
			},
			dispose: async handle => { this.disposed.push(handle.id); },
			isLive: handle => !this.dead.has(handle.id),
		};
	}
}

suite('Agent pool', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let aliases = 0;
	let now = 0;
	const pool = (maxSpares = 2, ttlMs = 1_000) => store.add(new AgentPool({ maxSpares, ttlMs, newAlias: () => `a${++aliases}`, now: () => now }));

	setup(() => {
		aliases = 0;
		now = 0;
	});

	test('a new chat adopts the ready spare; the pool does not start a second one for the same key', async () => {
		const agents = new FakeAgents();
		const p = pool();
		p.ensure(agents.request('k'));
		p.ensure(agents.request('k'));
		await flush();
		assert.deepStrictEqual(agents.started, ['a1']);
		const spare = await p.take('k');
		assert.deepStrictEqual({ alias: spare?.alias, handle: spare?.handle.id, waited: spare?.waitedMs }, { alias: 'a1', handle: 'h-a1', waited: 0 });
		assert.strictEqual(p.has('k'), false);
		assert.strictEqual(await p.take('k'), undefined);
	});

	test('a spare still starting is awaited rather than starting another', async () => {
		const agents = new FakeAgents();
		agents.manual = true;
		const p = pool();
		p.ensure(agents.request('k'));
		const taking = p.take('k');
		now = 700;
		await Promise.resolve();
		agents.pending.get('a1')!.complete({ id: 'h-a1' });
		const spare = await taking;
		assert.strictEqual(spare?.handle.id, 'h-a1');
		assert.strictEqual(spare?.waitedMs, 700);
	});

	test('a dead or failed spare is never handed out', async () => {
		const agents = new FakeAgents();
		const p = pool();
		p.ensure(agents.request('k'));
		await flush();
		agents.dead.add('h-a1');
		assert.strictEqual(await p.take('k'), undefined);
		assert.deepStrictEqual(agents.disposed, ['h-a1']);

		agents.fail = true;
		p.ensure(agents.request('j'));
		assert.strictEqual(await p.take('j'), undefined);
	});

	test('evicts the oldest spare past the cap and stops spares past their time to live', async () => {
		const agents = new FakeAgents();
		const p = pool(1, 1_000);
		p.ensure(agents.request('k1'));
		await flush();
		now = 10;
		p.ensure(agents.request('k2'));
		await flush();
		assert.deepStrictEqual([p.has('k1'), p.has('k2')], [false, true]);
		assert.deepStrictEqual(agents.disposed, ['h-a1']);
		now = 2_000;
		p.sweep();
		assert.strictEqual(p.size, 0);
		assert.deepStrictEqual(agents.disposed, ['h-a1', 'h-a2']);
	});

	test('a spare dropped while starting is disposed once it arrives; dispose clears everything', async () => {
		const agents = new FakeAgents();
		agents.manual = true;
		const p = pool(1);
		p.ensure(agents.request('k1'));
		p.ensure(agents.request('k2'));
		agents.pending.get('a1')!.complete({ id: 'h-a1' });
		agents.pending.get('a2')!.complete({ id: 'h-a2' });
		await flush();
		assert.deepStrictEqual(agents.disposed, ['h-a1']);
		assert.deepStrictEqual(p.readySpares().map(spare => spare.handle.id), ['h-a2']);
		p.clear();
		assert.deepStrictEqual(agents.disposed, ['h-a1', 'h-a2']);
	});
});
