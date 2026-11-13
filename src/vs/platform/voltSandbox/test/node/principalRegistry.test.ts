/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Principal Registry (spec F.1, INV-01): identity is the channel. A payload can't name its
 * principal, extend its on-behalf-of chain, reuse a closed channel or present a context the
 * registry didn't build (IPC-1, IPC-3..5 at the registry).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { evaluate, PolicySnapshot } from '../../common/authority.js';
import { ICallContext, IPrincipal, MAX_CALL_CHAIN } from '../../common/principals.js';
import { PrincipalRegistry } from '../../node/principalRegistry.js';

const NOW = 1_800_000_000_000;

suite('Volt principal registry (C2)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const registry = store.add(new PrincipalRegistry('server-1', () => NOW));
		const chat = registry.mint({ subject: 'chat:c1', kind: 'agent', launchPolicyHash: 'h-chat' });
		const plugin = registry.mint({ subject: 'plugin:acme.linear@local', kind: 't3', launchPolicyHash: 'h-plugin', signer: 'local' });
		const other = registry.mint({ subject: 'plugin:acme.other@local', kind: 't3', launchPolicyHash: 'h-other' });
		registry.bind('ch-chat', chat);
		registry.bind('ch-plugin', plugin);
		registry.bind('ch-other', other);
		return { registry, chat, plugin, other };
	}

	test('mint: 128-bit random ids, frozen records, the execution host and time from core; the user subject is never minted', () => {
		const { registry, chat, plugin } = setup();
		assert.match(chat.id, /^[A-Za-z0-9_-]{22}$/);
		assert.notStrictEqual(chat.id, plugin.id);
		assert.deepStrictEqual([chat.executionHost, chat.createdAt, chat.launchPolicyHash], ['server-1', NOW, 'h-chat']);
		assert.ok(Object.isFrozen(chat));
		assert.throws(() => registry.mint({ subject: 'user', kind: 'task', launchPolicyHash: '' }), /never minted/);
		assert.throws(() => registry.mint({ subject: 'chat:c2', kind: 'task', launchPolicyHash: '', parent: 'nobody' }), /not live/);
		const ids = new Set(Array.from({ length: 500 }, () => registry.mint({ subject: 'chat:many', kind: 'agent', launchPolicyHash: '' }).id));
		assert.strictEqual(ids.size, 500);
	});

	test('IPC-1 (registry): the context of a request is the principal on its channel, whatever the payload claims', () => {
		const { registry, plugin, other } = setup();
		const context = registry.contextFor('ch-plugin', 'r1')!;
		assert.strictEqual(context.principal, plugin);
		assert.deepStrictEqual(context.onBehalfOf, []);
		// A payload naming another extension is not an input; copying the context with another principal is a forgery.
		const forged: ICallContext = { ...context, principal: other };
		assert.ok(registry.verify(context));
		assert.ok(!registry.verify(forged));
		assert.strictEqual(registry.route(forged, 'ch-chat', 'r2'), undefined);
	});

	test('IPC-3 (registry): the on-behalf-of chain is built by core only; a payload can\'t extend or forge it', () => {
		const { registry, chat, plugin, other } = setup();
		const fromChat = registry.contextFor('ch-chat', 'r1')!;
		const toPlugin = registry.route(fromChat, 'ch-plugin', 'r2')!;
		assert.deepStrictEqual([toPlugin.principal, toPlugin.onBehalfOf], [plugin, [chat]]);
		const onward = registry.route(toPlugin, 'ch-other', 'r3')!;
		assert.deepStrictEqual([onward.principal, onward.onBehalfOf], [other, [chat, plugin]]);
		// Frozen: nothing can push a principal into a chain core built.
		assert.throws(() => (toPlugin.onBehalfOf as IPrincipal[]).push(other));
		assert.throws(() => { (toPlugin as { principal: IPrincipal }).principal = other; });
		// A chain written by the caller (e.g. dropping the chat to shed its attenuation) is not one core built.
		const shed: ICallContext = { ...onward, onBehalfOf: [plugin] };
		const extended: ICallContext = { ...toPlugin, onBehalfOf: [...toPlugin.onBehalfOf, other] };
		for (const forged of [shed, extended]) {
			assert.ok(!registry.verify(forged));
			assert.strictEqual(registry.route(forged, 'ch-chat', 'r4'), undefined);
		}
		// Longer than core walks: refused.
		let context: ICallContext | undefined = fromChat;
		let hops = 0;
		while (context) {
			context = registry.route(context, hops % 2 ? 'ch-plugin' : 'ch-other', `hop${hops}`);
			hops++;
		}
		assert.strictEqual(hops, MAX_CALL_CHAIN);
	});

	test('IPC-3 (Authority): a chain the registry built attenuates; the chain a payload would like is not what is evaluated', () => {
		const { registry } = setup();
		const snapshot = PolicySnapshot.build({
			epoch: 1, asOf: NOW,
			chats: [{ subject: 'chat:c1', settings: { level: 'workspace-write', network: false } }],
			manifests: [{ subject: 'plugin:acme.linear@local', declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }], network: 'broker' }],
		});
		const routed = registry.route(registry.contextFor('ch-chat', 'r1')!, 'ch-plugin', 'r2')!;
		const decision = evaluate(snapshot, { capability: 'net.connect', target: 'api.linear.app' }, routed);
		assert.deepStrictEqual([decision.deniedBy, decision.subject], ['caller', 'chat:c1'], 'the plugin acting for a network-off chat can\'t use its own host');
		assert.ok(evaluate(snapshot, { capability: 'net.connect', target: 'api.linear.app' }, registry.contextFor('ch-plugin', 'r3')!).allow, 'on its own it can');
	});

	test('IPC-4 (registry): closing a channel revokes its principal; the channel is never bound again', () => {
		const { registry, plugin } = setup();
		const context = registry.contextFor('ch-plugin', 'r1')!;
		const revoked: IPrincipal[] = [];
		store.add(registry.onDidRevoke(p => revoked.push(p)));
		registry.closeChannel('ch-plugin');
		assert.deepStrictEqual(revoked, [plugin]);
		assert.strictEqual(registry.principalOf('ch-plugin'), undefined);
		assert.strictEqual(registry.contextFor('ch-plugin', 'r2'), undefined);
		assert.ok(!registry.verify(context), 'a context made before the revocation is dead');
		const fresh = registry.mint({ subject: 'plugin:acme.linear@local', kind: 't3', launchPolicyHash: 'h2' });
		assert.throws(() => registry.bind('ch-plugin', fresh), /already belongs/);
		assert.throws(() => registry.bind('ch-new', plugin), /revoked/);
	});

	test('IPC-5 (registry): an unknown channel or a principal minted elsewhere has no context', () => {
		const { registry, plugin } = setup();
		assert.strictEqual(registry.contextFor('ch-unknown', 'r1'), undefined);
		assert.throws(() => registry.bind('ch-x', { ...plugin }), /not minted here/);
		assert.throws(() => registry.bind('ch-chat', registry.mint({ subject: 'chat:c9', kind: 'agent', launchPolicyHash: '' })), /already belongs/);
		const twice = registry.mint({ subject: 'chat:c8', kind: 'agent', launchPolicyHash: '' });
		registry.bind('ch-a', twice);
		assert.throws(() => registry.bind('ch-b', twice), /already bound/);
		const other = store.add(new PrincipalRegistry('server-2'));
		const theirs = other.contextFor('nothing', 'r');
		assert.strictEqual(theirs, undefined);
		assert.ok(!other.verify(registry.contextFor('ch-plugin', 'r2')!), 'a context from another registry');
	});

	test('revoking a principal revokes everything started for it', () => {
		const { registry, chat } = setup();
		const task = registry.mint({ subject: 'chat:c1', kind: 'task', launchPolicyHash: 'h-task', parent: chat.id });
		const grandchild = registry.mint({ subject: 'chat:c1', kind: 'task', launchPolicyHash: 'h-sub', parent: task.id });
		registry.bind('ch-task', task);
		registry.revoke(chat.id);
		assert.ok(!registry.isLive(task.id) && !registry.isLive(grandchild.id));
		assert.strictEqual(registry.principalOf('ch-task'), undefined);
		assert.throws(() => registry.mint({ subject: 'chat:c1', kind: 'task', launchPolicyHash: '', parent: chat.id }), /not live/);
	});
});
