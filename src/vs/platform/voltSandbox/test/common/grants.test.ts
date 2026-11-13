/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Grants and the grant-store file format (spec G.4, G.9, F.11): expiry, validity, pure schema and
 * capability migrations (narrowing applies, widening drops), a newer Volt's store (read-only, third
 * party absent), malformed entries, and consents becoming grants.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { canonicalJson, consentsToGrants, emptyGrantStore, FLOW_CAPABILITY, grantExpiry, grantValid, GRANT_STORE_SCHEMA, hasRefusal, HIGH_GRANT_TTL_MS, IGrant, loadGrantStore, migrateCapability, nextGrantExpiry, serializeGrantStore, UNUSED_GRANT_TTL_MS } from '../../common/grants.js';
import { SubjectKey } from '../../common/principals.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PLUGIN: SubjectKey = 'plugin:acme.linear@local';
const MEMORY: SubjectKey = 'firstparty:volt.memory';
const CHAT: SubjectKey = 'chat:c1';

function grant(subject: SubjectKey, capability: string, extra: Partial<IGrant> = {}): IGrant {
	return { id: `g:${subject}:${capability}`, subject, capability, scope: {}, kind: 'persistent', source: 'user', grantedAt: NOW, lastUsedAt: NOW, epoch: 1, ...extra };
}

function file(grants: readonly unknown[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ schemaVersion: GRANT_STORE_SCHEMA, epoch: 4, grants, refusals: [], ...extra });
}

const CONTEXT = { asOf: NOW, epoch: 5, workspace: '/ws', sessionIds: ['c1'] };

suite('Volt grants (G.4, G.9)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('G.4 expiry: third-party persistent grants 30 days unused, high ones 90 days regardless; first party, admin and ceilings never', () => {
		assert.strictEqual(grantExpiry(grant(PLUGIN, 'agents.send@1', { lastUsedAt: NOW })), NOW + UNUSED_GRANT_TTL_MS);
		assert.strictEqual(grantExpiry(grant(PLUGIN, 'agents.create@1', { grantedAt: NOW - 80 * DAY, lastUsedAt: NOW })), NOW - 80 * DAY + HIGH_GRANT_TTL_MS, 'high: from the grant, used or not');
		assert.strictEqual(grantExpiry(grant(PLUGIN, 'agents.send@1', { expiresAt: NOW + DAY })), NOW + DAY, 'its own expiry when earlier');
		assert.strictEqual(grantExpiry(grant(MEMORY, 'agents.context@1', { lastUsedAt: NOW - 400 * DAY })), undefined);
		assert.strictEqual(grantExpiry(grant(PLUGIN, 'agents.send@1', { source: 'admin', lastUsedAt: NOW - 400 * DAY })), undefined);
		assert.strictEqual(grantExpiry(grant(PLUGIN, 'agents.send@1', { kind: 'session', sessionId: 'c1', lastUsedAt: NOW - 400 * DAY })), undefined, 'a session grant ends with its session');
		assert.ok(!grantValid(grant(PLUGIN, 'agents.send@1', { lastUsedAt: NOW - 31 * DAY }), CONTEXT));
		assert.ok(grantValid(grant(PLUGIN, 'agents.send@1', { lastUsedAt: NOW - 29 * DAY }), CONTEXT));
		assert.strictEqual(nextGrantExpiry([grant(PLUGIN, 'agents.send@1', { lastUsedAt: NOW - 29 * DAY }), grant(PLUGIN, 'git.read@1', { id: 'x', expiresAt: NOW + 5 })], NOW), NOW + 5);
	});

	test('G.2 step 3 validity: revoked, later epoch, other workspace or session, critical without a typed confirmation or from a preset', () => {
		assert.ok(grantValid(grant(PLUGIN, 'agents.send@1'), CONTEXT));
		assert.ok(!grantValid(grant(PLUGIN, 'agents.send@1', { revoked: true }), CONTEXT));
		assert.ok(!grantValid(grant(PLUGIN, 'agents.send@1', { epoch: 6 }), CONTEXT), 'a snapshot at an earlier epoch does not see it');
		assert.ok(grantValid(grant(PLUGIN, 'agents.send@1', { kind: 'workspace', workspace: '/ws' }), CONTEXT));
		assert.ok(!grantValid(grant(PLUGIN, 'agents.send@1', { kind: 'workspace', workspace: '/other' }), CONTEXT));
		assert.ok(grantValid(grant(PLUGIN, 'agents.send@1', { kind: 'session', sessionId: 'c1' }), CONTEXT));
		assert.ok(!grantValid(grant(PLUGIN, 'agents.send@1', { kind: 'session', sessionId: 'c2' }), CONTEXT));
		assert.ok(!grantValid(grant(PLUGIN, 'desktop.control@1'), CONTEXT));
		assert.ok(grantValid(grant(PLUGIN, 'desktop.control@1', { confirmed: true }), CONTEXT));
		assert.ok(!grantValid(grant(PLUGIN, 'desktop.control@1', { confirmed: true, source: 'preset' }), CONTEXT), 'critical never by preset');
	});

	test('GS-LOAD-1: a missing, torn or foreign file loads empty, never "allow all"', () => {
		assert.deepStrictEqual(loadGrantStore(undefined), { data: emptyGrantStore(), status: 'missing', readOnly: false, notes: [] });
		for (const text of ['', '{"schemaVersion":1,"epoch":3,"grants":[{"id"', 'null', '[]', '{"schemaVersion":1}', '{"schemaVersion":1,"epoch":-1,"grants":[]}', '{"schemaVersion":"1","epoch":1,"grants":[]}']) {
			const loaded = loadGrantStore(text);
			assert.strictEqual(loaded.status, 'torn', text);
			assert.deepStrictEqual(loaded.data.grants, [], text);
			assert.ok(loaded.notes.length, 'says permissions were reset');
		}
	});

	test('GS-LOAD-2: malformed entries are dropped one by one, each with a note', () => {
		const loaded = loadGrantStore(file([
			grant(PLUGIN, 'agents.send@1'),
			grant(PLUGIN, 'agents.send@1'), // the same id again
			{ ...grant(PLUGIN, 'git.read@1'), subject: 'user' },
			{ ...grant(PLUGIN, 'git.read@1'), subject: 'someone' },
			grant(PLUGIN, 'teleport@1', { id: 'unknown' }),
			grant(PLUGIN, 'secrets.read@1', { id: 'critical' }),
			grant(PLUGIN, 'agents.read:any@1', { id: 'session', kind: 'session' }),
			{ ...grant(PLUGIN, 'git.read@1', { id: 'scope' }), scope: { targets: 'all' } },
			{ ...grant(PLUGIN, 'git.read@1', { id: 'kind' }), kind: 'forever' },
			'not a grant',
			grant(PLUGIN, 'desktop.control@1', { id: 'confirmed', confirmed: true }),
		]));
		assert.strictEqual(loaded.status, 'ok');
		assert.deepStrictEqual(loaded.data.grants.map(g => g.id), [`g:${PLUGIN}:agents.send@1`, 'confirmed']);
		assert.strictEqual(loaded.notes.length, 8);
	});

	test('GS-MIGRATE-1: schema migrations are pure and run in order; a schema with no migration is torn, its epoch kept', () => {
		const v0 = { schemaVersion: 0, epoch: 7, entries: [grant(PLUGIN, 'agents.send@1')] };
		const frozen = JSON.parse(JSON.stringify(v0));
		Object.freeze(frozen);
		const migrations = { 0: (raw: Readonly<Record<string, unknown>>) => ({ schemaVersion: 1, epoch: raw.epoch, grants: raw.entries, refusals: [] }) };
		const loaded = loadGrantStore(JSON.stringify(v0), { schemaMigrations: migrations });
		assert.strictEqual(loaded.status, 'migrated');
		assert.deepStrictEqual(loaded.data.grants.map(g => g.capability), ['agents.send@1']);
		assert.strictEqual(loaded.data.epoch, 7);
		assert.deepStrictEqual(migrations[0](frozen).grants, frozen.entries, 'the migration does not need to mutate its input');
		const missing = loadGrantStore(JSON.stringify(v0));
		assert.deepStrictEqual([missing.status, missing.data.grants.length, missing.data.epoch], ['torn', 0, 7]);
		const broken = loadGrantStore(JSON.stringify(v0), { schemaMigrations: { 0: () => ({ nothing: true }) } });
		assert.strictEqual(broken.status, 'torn');
	});

	test('GS-MIGRATE-2: capability migrations: narrowing ones apply, widening ones drop the grant so it is asked again', () => {
		const table = {
			'net.connect@1': { to: 'net.connect@2', narrowing: true },
			'agents.send@1': { to: 'agents.send@2', narrowing: false },
		};
		assert.strictEqual(migrateCapability('net.connect', table), 'net.connect@2');
		assert.strictEqual(migrateCapability('agents.send@1', table), undefined);
		assert.strictEqual(migrateCapability('git.read', table), 'git.read@1');
		assert.strictEqual(migrateCapability(FLOW_CAPABILITY, table), FLOW_CAPABILITY);
		assert.strictEqual(migrateCapability('a@1', { 'a@1': { to: 'a@2', narrowing: true }, 'a@2': { to: 'a@1', narrowing: true } }), 'a@1', 'a cycle ends');
		const loaded = loadGrantStore(file([grant(PLUGIN, 'net.connect@1', { id: 'n', scope: { targets: ['api.linear.app'] } }), grant(PLUGIN, 'agents.send@1', { id: 's' })]), { capabilityMigrations: table });
		assert.strictEqual(loaded.status, 'migrated');
		assert.deepStrictEqual(loaded.data.grants.map(g => [g.id, g.capability]), [['n', 'net.connect@2']]);
		assert.ok(loaded.notes.some(note => /widened/.test(note)));
	});

	test('GS-NEWER-1: a store from a newer Volt is read-only, with every third-party grant absent', () => {
		const loaded = loadGrantStore(file([grant(PLUGIN, 'agents.send@1'), grant(CHAT, FLOW_CAPABILITY, { kind: 'session', sessionId: 'c1', scope: { targets: [PLUGIN], hosts: ['api.linear.app'] } }), grant(MEMORY, 'agents.context@1')], { schemaVersion: GRANT_STORE_SCHEMA + 1, refusals: [{ subject: PLUGIN, capability: 'git.read@1', at: NOW }] }));
		assert.deepStrictEqual([loaded.status, loaded.readOnly], ['newer', true]);
		assert.deepStrictEqual(loaded.data.grants.map(g => g.subject), [CHAT, MEMORY]);
	});

	test('GS-FORMAT-1: the file is canonical JSON: the same store writes the same bytes and reads back the same', () => {
		const data = { schemaVersion: GRANT_STORE_SCHEMA, epoch: 9, grants: [grant(PLUGIN, 'agents.send@1', { scope: { targets: ['b', 'a'] } })], refusals: [{ subject: PLUGIN, capability: 'git.read@1', at: NOW }] };
		const text = serializeGrantStore(data);
		const loaded = loadGrantStore(text);
		assert.strictEqual(loaded.status, 'ok');
		assert.strictEqual(serializeGrantStore(loaded.data), text);
		assert.strictEqual(canonicalJson({ b: 1, a: [undefined, { d: undefined, c: 2 }] }), '{"a":[null,{"c":2}],"b":1}');
	});

	test('consents become grants: granted is a persistent user grant, refused a refusal', () => {
		const { grants, refusals } = consentsToGrants(PLUGIN, [{ capability: 'agents.send', granted: true }, { capability: 'git.read@1', granted: false }, { capability: 'teleport', granted: true }], NOW, 3);
		assert.deepStrictEqual(grants.map(g => [g.capability, g.kind, g.source, g.epoch]), [['agents.send@1', 'persistent', 'user', 3]]);
		assert.deepStrictEqual(refusals, [{ subject: PLUGIN, capability: 'git.read@1', at: NOW }]);
		assert.ok(hasRefusal(refusals, PLUGIN, 'git.read'));
		assert.ok(!hasRefusal(refusals, MEMORY, 'git.read'));
	});
});
