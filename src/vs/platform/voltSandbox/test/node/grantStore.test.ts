/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The grant store on disk (spec F.9, F.11, G.4, G.9): atomic 0600 writes, a monotonic epoch that
 * survives a lost or torn file, compare-and-swap commits (also across two processes sharing the
 * file), idempotent approvals, expiry, and a torn store that loads as "third party empty, first
 * party its ceiling", never "allow all". Real files in a temp folder.
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { evaluate, PolicySnapshot } from '../../common/authority.js';
import { GRANT_STORE_SCHEMA, IGrant } from '../../common/grants.js';
import { corePrincipal, SubjectKey } from '../../common/principals.js';
import { GrantStore, IGrantDraft, IGrantStoreChangeEvent } from '../../node/grantStore.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PLUGIN: SubjectKey = 'plugin:acme.linear@local';
const MEMORY: SubjectKey = 'firstparty:volt.memory';

function draft(id: string, subject: SubjectKey, capability: string, extra: Partial<IGrantDraft> = {}): IGrantDraft {
	return { id, subject, capability, scope: {}, kind: 'persistent', source: 'user', grantedAt: NOW, lastUsedAt: NOW, ...extra };
}

suite('Volt grant store (C2)', function () {

	this.timeout(20_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let path: string;

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-grants-')));
		path = join(root, 'trust', 'grants.json');
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const open = async (options = {}) => disposables.add(await GrantStore.open(path, options));

	test('GS-ATOMIC-1: commits write the whole store atomically, 0600, with no temp files left and the epoch file first', async () => {
		const store = await open();
		assert.deepStrictEqual([store.status, store.epoch, store.data.grants.length], ['missing', 0, 0]);
		const epoch = await store.update({ add: [draft('a', PLUGIN, 'agents.send@1')] });
		assert.strictEqual(epoch, 1);
		const names = (await fs.readdir(join(root, 'trust'))).sort();
		assert.deepStrictEqual(names, ['grants.epoch', 'grants.json']);
		if (process.platform !== 'win32') {
			assert.strictEqual((await fs.stat(path)).mode & 0o777, 0o600);
			assert.strictEqual((await fs.stat(join(root, 'trust'))).mode & 0o777, 0o700);
		}
		assert.strictEqual(await fs.readFile(join(root, 'trust', 'grants.epoch'), 'utf8'), '1');
		const text = JSON.parse(await fs.readFile(path, 'utf8'));
		assert.deepStrictEqual([text.schemaVersion, text.epoch, text.grants[0].id, text.grants[0].epoch], [GRANT_STORE_SCHEMA, 1, 'a', 1]);
		const again = await open();
		assert.deepStrictEqual([again.status, again.epoch, again.data.grants.map(g => g.id)], ['ok', 1, ['a']]);
	});

	test('GS-TORN-1: a torn store loads empty (third party nothing, first party its ceiling), is kept aside, and the epoch still grows', async () => {
		const store = await open();
		await store.update({ add: [draft('a', PLUGIN, 'agents.send@1'), draft('b', PLUGIN, 'agents.create@1')] });
		await store.update({ add: [draft('c', MEMORY, 'agents.context@1')] });
		await fs.writeFile(path, '{"schemaVersion":1,"epoch":2,"grants":[{"id":"a","sub');
		const torn = await open();
		assert.deepStrictEqual([torn.status, torn.data.grants.length], ['torn', 0]);
		assert.ok(torn.epoch > 2, `epoch ${torn.epoch} restarts above every epoch the store had`);
		assert.ok((await fs.readdir(join(root, 'trust'))).some(name => name.startsWith('grants.json.torn-')), 'kept for inspection');
		// Decisions over the reset store: never "allow all".
		const snapshot = PolicySnapshot.build({
			epoch: torn.epoch, asOf: NOW, grants: torn.data.grants,
			manifests: [
				{ subject: PLUGIN, declared: [{ id: 'agents.send' }, { id: 'agents.create' }], network: 'broker' },
				{ subject: MEMORY, declared: [{ id: 'agents.context' }], network: 'broker' },
			],
		});
		const ask = (subject: SubjectKey, capability: string) => evaluate(snapshot, { capability }, { principal: corePrincipal('p', subject, 't3'), onBehalfOf: [], requestId: 'r' });
		assert.strictEqual(ask(PLUGIN, 'agents.send').deniedBy, 'authority');
		assert.strictEqual(ask(PLUGIN, 'agents.create').deniedBy, 'authority');
		assert.ok(ask(MEMORY, 'agents.context').allow, 'first party keeps its compiled ceiling');
		// The next commit writes a fresh store above the old epochs.
		const next = await torn.update({ add: [draft('d', PLUGIN, 'agents.send@1')] });
		assert.ok(next > 2);
		assert.strictEqual((await open()).status, 'ok');
	});

	test('GS-EPOCH-1: the epoch never goes back, even when the store file is lost', async () => {
		const store = await open();
		for (let i = 0; i < 3; i++) {
			await store.update({ add: [draft(`g${i}`, PLUGIN, 'agents.send@1', { scope: { targets: [`chat:${i}`] } })] });
		}
		assert.strictEqual(store.epoch, 3);
		await fs.rm(path);
		const lost = await open();
		assert.deepStrictEqual([lost.status, lost.data.grants.length], ['torn', 0], 'a store that had grants and vanished says permissions were reset');
		assert.ok(lost.epoch > 3);
		// Present but unreadable (here: a folder where the file should be): torn as well.
		await fs.mkdir(path);
		const unreadable = await open();
		assert.deepStrictEqual([unreadable.status, unreadable.data.grants.length], ['torn', 0]);
		assert.ok(unreadable.epoch > 3);
	});

	test('GS-CAS-1: a commit at a stale epoch is refused; update retries so two approvals for different hosts both land, in order', async () => {
		const store = await open();
		await store.update({ add: [draft('a', PLUGIN, 'net.connect@1', { scope: { targets: ['a.example'] } })] });
		const stale = await store.commit(0, { add: [draft('x', PLUGIN, 'agents.send@1')] });
		assert.deepStrictEqual(stale, { committed: false, epoch: 1 });
		const epochs = await Promise.all([
			store.update({ add: [draft('b', PLUGIN, 'net.connect@1', { scope: { targets: ['b.example'] } })] }),
			store.update({ add: [draft('c', PLUGIN, 'net.connect@1', { scope: { targets: ['c.example'] } })] }),
		]);
		assert.deepStrictEqual(epochs, [2, 3]);
		assert.deepStrictEqual(store.data.grants.map(g => [g.id, g.epoch]), [['a', 1], ['b', 2], ['c', 3]]);
	});

	test('GS-CAS-2: two processes sharing the file never lose each other\'s commits', async () => {
		const a = await open();
		const b = await open();
		await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).update({ add: [draft(`g${i}`, PLUGIN, 'net.connect@1', { scope: { targets: [`h${i}.example`] } })] })));
		const fresh = await open();
		assert.deepStrictEqual(fresh.data.grants.map(g => g.id).sort(), ['g0', 'g1', 'g2', 'g3', 'g4', 'g5']);
		assert.strictEqual(fresh.epoch, 6);
		assert.deepStrictEqual(fresh.data.grants.map(g => g.epoch).sort(), [1, 2, 3, 4, 5, 6], 'every commit its own epoch');
	});

	test('GS-CAS-3: approving the same thing twice is one grant and no new epoch', async () => {
		const store = await open();
		const changes: IGrantStoreChangeEvent[] = [];
		disposables.add(store.onDidChange(e => changes.push(e)));
		await store.update({ add: [draft('a', PLUGIN, 'agents.send@1', { kind: 'session', sessionId: 'c1' })] });
		const again = await store.commit(store.epoch, { add: [draft('b', PLUGIN, 'agents.send@1', { kind: 'session', sessionId: 'c1' })] });
		assert.deepStrictEqual(again, { committed: true, epoch: 1, changed: false });
		assert.strictEqual(store.data.grants.length, 1);
		assert.deepStrictEqual(changes, [{ epoch: 1, subjects: [PLUGIN], narrowed: false }]);
	});

	test('GS-REVOKE-1: revoking is a new epoch announced as narrowing', async () => {
		const store = await open();
		const changes: IGrantStoreChangeEvent[] = [];
		disposables.add(store.onDidChange(e => changes.push(e)));
		await store.update({ add: [draft('a', PLUGIN, 'agents.send@1'), draft('b', MEMORY, 'agents.context@1')] });
		await store.update({ revoke: ['a'] });
		assert.deepStrictEqual(store.data.grants.map(g => g.id), ['b']);
		assert.deepStrictEqual(changes.at(-1), { epoch: 2, subjects: [PLUGIN], narrowed: true });
		assert.deepStrictEqual(await store.commit(2, { revoke: ['a'] }), { committed: true, epoch: 2, changed: false }, 'revoking again changes nothing');
	});

	test('GS-EXPIRY-1: expired grants are dropped at the given time; use moves the unused clock; first party never expires', async () => {
		const store = await open();
		await store.update({
			add: [
				draft('unused', PLUGIN, 'agents.send@1', { lastUsedAt: NOW - 31 * DAY }),
				draft('used', PLUGIN, 'git.read@1', { lastUsedAt: NOW - 29 * DAY }),
				draft('high', PLUGIN, 'agents.create@1', { grantedAt: NOW - 91 * DAY, lastUsedAt: NOW }),
				draft('mine', MEMORY, 'agents.context@1', { lastUsedAt: NOW - 400 * DAY }),
			],
		});
		await store.update({ touch: [{ id: 'used', at: NOW }] });
		assert.strictEqual(store.data.grants.find(g => g.id === 'used')?.lastUsedAt, NOW);
		const changes: IGrantStoreChangeEvent[] = [];
		disposables.add(store.onDidChange(e => changes.push(e)));
		await store.update({ expireAt: NOW + 2 * DAY });
		assert.deepStrictEqual(store.data.grants.map(g => g.id).sort(), ['mine', 'used']);
		assert.deepStrictEqual(changes.map(c => c.narrowed), [true]);
	});

	test('GS-NEWER-2: a newer Volt\'s store is read-only: no commit writes over it', async () => {
		await fs.mkdir(join(root, 'trust'), { recursive: true });
		const grant: IGrant = { ...draft('a', PLUGIN, 'agents.send@1'), epoch: 1 };
		const text = JSON.stringify({ schemaVersion: GRANT_STORE_SCHEMA + 1, epoch: 5, grants: [grant], refusals: [], futureField: true });
		await fs.writeFile(path, text);
		const store = await open();
		assert.deepStrictEqual([store.status, store.readOnly, store.data.grants.length], ['newer', true, 0]);
		await assert.rejects(store.commit(store.epoch, { add: [draft('b', PLUGIN, 'git.read@1')] }), /newer Volt/);
		assert.strictEqual(await fs.readFile(path, 'utf8'), text);
	});

	test('GS-LOCK-1: a lock left by a crashed process is broken after it goes stale; a live one makes the commit wait, then fail', async () => {
		const store = await open({ staleLockMs: 1_000, lockWaitMs: 150 });
		const lock = `${path}.lock`;
		await fs.writeFile(lock, '99999');
		await assert.rejects(store.update({ add: [draft('a', PLUGIN, 'agents.send@1')] }), /locked by another Volt process/);
		const past = new Date(Date.now() - 60_000);
		await fs.utimes(lock, past, past);
		assert.strictEqual(await store.update({ add: [draft('a', PLUGIN, 'agents.send@1')] }), 1);
		assert.strictEqual(await fs.stat(lock).catch(() => undefined), undefined, 'released');
	});

	test('GS-LOCK-2: an old lock whose owner still runs (a slow commit) is never taken over', async () => {
		const store = await open({ staleLockMs: 1_000, lockWaitMs: 150 });
		const lock = `${path}.lock`;
		const owner = `${process.ppid} someone-else`;
		await fs.writeFile(lock, owner);
		const past = new Date(Date.now() - 60_000);
		await fs.utimes(lock, past, past);
		await assert.rejects(store.update({ add: [draft('a', PLUGIN, 'agents.send@1')] }), /locked by another Volt process/);
		assert.strictEqual(await fs.readFile(lock, 'utf8'), owner, 'the live owner keeps its lock');
		assert.strictEqual(await fs.stat(`${lock}.takeover`).catch(() => undefined), undefined, 'no takeover lock is left');
	});
});
