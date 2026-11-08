/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IGrant } from '../../common/grants.js';
import { accessSubjects, describeGrantScope, GestureTokenRegistry, PromptBudget, trustChangeRefusal } from '../../common/trust.js';

function grant(id: string, subject: IGrant['subject'], overrides: Partial<IGrant> = {}): IGrant {
	return { id, subject, capability: 'net.connect@1', scope: { targets: ['a.test'] }, kind: 'persistent', source: 'user', grantedAt: 1, lastUsedAt: 1, epoch: 1, ...overrides };
}

suite('Volt permission UX model (P4, G.7, G.12)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('UX-3: budgets: one prompt a minute, three a day, coalesced over 2 s, auto-deny after two refusals until reset', () => {
		let now = 0;
		const budget = new PromptBudget(undefined, () => now);
		const s = 'plugin:a.b@local';
		assert.ok(budget.take(s));
		now = 1_000;
		assert.ok(budget.take(s), 'within 2 s it is the same prompt');
		assert.strictEqual(budget.state(s).promptsToday, 1);
		now = 3_000;
		assert.ok(!budget.take(s), 'a second prompt within the minute is refused');
		assert.ok(budget.state(s).exhausted);
		now = 61_000;
		assert.ok(budget.take(s));
		now = 122_000;
		assert.ok(budget.take(s));
		now = 183_000;
		assert.ok(!budget.take(s), 'three a day');
		assert.deepStrictEqual(budget.spent(), [s]);
		assert.ok(budget.take('plugin:other.one@local'), 'per subject');
		now = 24 * 60 * 60 * 1000 + 1;
		assert.ok(budget.take(s), 'a new day');
		budget.refused(s);
		budget.refused(s);
		now += 120_000;
		assert.ok(!budget.take(s), 'two refusals auto-deny');
		assert.ok(budget.state(s).autoDenied);
		budget.reset(s);
		assert.ok(budget.take(s), 'opening the Access page resets it');
	});

	test('UX-5 / UX-FORGE-2: a gesture token counts once, for its principal, under 1 s, and only if core minted it', () => {
		let now = 1_000;
		const registry = new GestureTokenRegistry(() => now);
		const token = registry.mint('chat:a');
		assert.ok(!registry.consume({ ...token, id: 'forged' }, 'chat:a'), 'an object of the same shape is not a token');
		assert.ok(!registry.consume({ id: token.id, principal: 'chat:b', issuedAt: token.issuedAt, consumed: false }, 'chat:b'), 'another principal\'s');
		const second = registry.mint('chat:a');
		assert.ok(registry.consume(second, 'chat:a'));
		assert.ok(!registry.consume(second, 'chat:a'), 'single use');
		const late = registry.mint('chat:a');
		now += 1_001;
		assert.ok(!registry.consume(late, 'chat:a'), 'older than 1 s');
		assert.ok(!registry.consume(undefined, 'chat:a'));
		const altered = registry.mint('chat:a');
		assert.ok(!registry.consume({ ...altered, issuedAt: altered.issuedAt + 500 }, 'chat:a'), 'its time can\'t be moved');
	});

	test('UX-STORE-2: a window change may only carry user grants for third parties and chats', () => {
		const base = { id: 'x', capability: 'agents.send@1', scope: {}, kind: 'persistent' as const, grantedAt: 1, lastUsedAt: 1, source: 'user' as const };
		assert.strictEqual(trustChangeRefusal({ add: [{ ...base, subject: 'chat:a' }] }), undefined);
		assert.ok(trustChangeRefusal({ add: [{ ...base, subject: 'firstparty:volt.usage' }] }));
		assert.ok(trustChangeRefusal({ add: [{ ...base, subject: 'user' }] }));
		assert.ok(trustChangeRefusal({ add: [{ ...base, subject: 'plugin:a.b@local', source: 'admin' }] }));
		assert.strictEqual(trustChangeRefusal({ revoke: ['anything'] }), undefined, 'narrowing is always fine');
	});

	test('UX-ACCESS-1: every subject with its grants: built-ins with their ceilings, extensions, chats with standing grants', () => {
		const state = {
			grants: [grant('g1', 'chat:c1', { lastUsedAt: 5 }), grant('g2', 'plugin:acme.notes@local', { capability: 'agents.send@1', scope: {} }), grant('g3', 'plugin:gone.ext@local')],
			refusals: [{ subject: 'plugin:acme.notes@local' as const, capability: 'git.read@1', at: 2 }],
		};
		const subjects = accessSubjects(state, [
			{ subject: 'firstparty:volt.usage', label: 'Usage', kind: 'builtin', ceiling: ['usage.report'] },
			{ subject: 'plugin:acme.notes@local', label: 'Acme Notes', kind: 'extension' },
			{ subject: 'plugin:quiet.ext@local', label: 'Quiet', kind: 'extension' },
		], [{ at: 9, source: 'network', subject: 'chat:c1', action: 'CONNECT', decision: 'allow' }], subject => `label of ${subject}`);
		assert.deepStrictEqual(subjects.map(entry => `${entry.kind} ${entry.label} ${entry.grants.length} ${entry.refusals.length} ${entry.lastUsedAt ?? '-'}`), [
			'extension Acme Notes 1 1 1',
			'extension label of plugin:gone.ext@local 1 0 1',
			'extension Quiet 0 0 -',
			'chat label of chat:c1 1 0 9',
			'builtin Usage 0 0 -',
		]);
		assert.strictEqual(describeGrantScope(state.grants[0]), 'net.connect a.test');
		assert.strictEqual(describeGrantScope({ capability: 'flow.send@1', scope: { targets: ['plugin:x.y@local'], hosts: ['*'] } }), 'flow.send plugin:x.y@local (any host)');
	});
});
