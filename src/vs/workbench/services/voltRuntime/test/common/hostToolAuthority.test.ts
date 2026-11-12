/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The host-tool gate on the Policy Authority (spec C2, M.3 shadow -> switch). SHADOW-1: for every
 * one of Volt's own tools, argument shape and chat sandbox, and for random chats a `delegates`
 * call prompts, the Authority decides exactly what the earlier rules did (0 shadow differences).
 * PERM-FLOW-1 at the gate: an extension's tool from a network-off chat, the flow approval and its
 * revocation. Mode switching and decision-log replay.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { replayDecision } from '../../../../../platform/voltSandbox/common/authority.js';
import { IVoltSandboxSettings, SandboxStrategy } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { forAll } from '../../../../../platform/voltSandbox/test/common/seededGen.js';
import { HostToolAuthority, IGateChat, IGateToolOwner, readPolicyAuthorityMode } from '../../common/hostToolAuthority.js';
import { HOST_TOOL_SANDBOX_CLASSES, hostToolSandboxUse, legacyHostToolRefusal, legacySandboxCovers, sandboxCovers } from '../../common/hostToolSandbox.js';

const NOW = 1_800_000_000_000;
const WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: false };
const READ: IVoltSandboxSettings = { level: 'read-only', network: false };

suite('Volt host-tool gate on the Policy Authority (C2)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('SHADOW-1: the Authority and the earlier rules agree on every class decision for Volt\'s own tools', () => {
		const authority = store.add(new HostToolAuthority(() => NOW));
		const names = [...Object.keys(HOST_TOOL_SANDBOX_CLASSES), 'brand_new_tool'];
		const argShapes: Record<string, unknown>[] = [
			{}, { action: 'create' }, { action: 'list' }, { action: 'run_now' }, { action: 'send_slack' }, { action: 'memory_read' }, { action: 'open_pr' },
			{ thread_id: 's1' }, { query: 'token' }, { query: 'token', project: 'this' }, { prompt: 'go', workspace: { type: 'worktree' } },
			{ script: 'launch com.example.app' }, { run: 'login' }, { url: 'https://example.com' },
		];
		const sandboxes: IVoltSandboxSettings[] = [WRITE, READ, { ...WRITE, network: true }, { ...WRITE, allowedDomains: ['*.allowed.dev'] }, { ...READ, listenPorts: [3000] }];
		let compared = 0;
		for (const name of names) {
			for (const args of argShapes) {
				for (const sandbox of sandboxes) {
					const use = hostToolSandboxUse(name, args);
					const caller: IGateChat = { id: 's1', settings: sandbox };
					const other = use?.kind === 'delegates' && use.target && use.target !== 's1';
					// A chat the gate has no record of: refused by both.
					authority.compare(name, 'chat:s1', legacyHostToolRefusal(use, 's1', sandbox, !other), authority.classDecision(use, caller));
					compared++;
				}
			}
		}
		// Chats a sandboxed chat prompts (INV-11): random settings, agents and folders on both sides.
		const LEVELS = ['off', 'workspace-write', 'read-only'] as const;
		const STRATEGIES: (SandboxStrategy | undefined)[] = [undefined, 'wrap', 'native', 'none'];
		const FOLDERS = [undefined, '/ws', '/ws/a', '/ws/b', '/other'];
		forAll('SHADOW-1 delegates', gen => {
			const settings = (): IVoltSandboxSettings => ({
				level: gen.pick(LEVELS),
				network: gen.bool(0.3),
				...(gen.bool(0.3) ? { allowedDomains: gen.some(['github.com', '*.linear.app', 'api.linear.app']) } : {}),
				...(gen.bool(0.3) ? { listenPorts: gen.some([3000, 5432]) } : {}),
				...(gen.bool(0.3) ? { extraWritableRoots: gen.some(['/ws', '/ws/a', '/tmp/out']) } : {}),
			});
			const chat = (id: string, chatSettings: IVoltSandboxSettings): IGateChat => {
				const strategy = gen.pick(STRATEGIES);
				const folder = gen.pick(FOLDERS);
				return { id, settings: chatSettings, ...(strategy ? { strategy } : {}), ...(folder ? { folder } : {}) };
			};
			const callerSettings = { ...settings(), level: gen.pick(['workspace-write', 'read-only'] as const) };
			const caller = chat('s1', callerSettings);
			const target = gen.bool(0.9) ? chat('peer', settings()) : undefined;
			const name = gen.pick(['thread_send', 'queue_edit', 'queue_send_now', 'queue_resume']);
			const use = hostToolSandboxUse(name, { thread_id: 'peer', item_id: 'q', message: 'x', text: 'x' });
			const covers = target ? legacySandboxCovers(target.settings, callerSettings, { targetStrategy: target.strategy, callerStrategy: caller.strategy, target: target.folder, caller: caller.folder }) : false;
			authority.compare(name, 'chat:s1', legacyHostToolRefusal(use, 's1', callerSettings, covers), authority.classDecision(use, caller, target));
			// The public helper is the Authority's rule now: the same answer as before.
			assert.strictEqual(sandboxCovers(target?.settings, callerSettings, { targetStrategy: target?.strategy, callerStrategy: caller.strategy, target: target?.folder, caller: caller.folder }), covers);
			compared++;
		}, 3000);
		assert.deepStrictEqual(authority.diffs.map(diff => `${diff.what} (${diff.legacy} before): ${diff.authority.reason}`), []);
		assert.ok(compared > 3000, `${compared} decisions compared`);
	});

	test('PERM-FLOW-1 (gate): an extension\'s tool from a network-off chat needs the flow approved; for this chat it holds until revoked; once is spent', () => {
		const authority = store.add(new HostToolAuthority(() => NOW));
		const linear: IGateToolOwner = { extensionId: 'acme.linear', label: 'Linear', firstParty: false, toolClass: 'network', declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }], sandboxed: true };
		const offline: IGateChat = { id: 'c1', settings: WRITE };
		const refused = authority.extensionToolDecision('linear_sync', linear, offline);
		assert.deepStrictEqual([refused.deniedBy, refused.promptable?.flow], ['egress-compat', { from: 'chat:c1', to: 'plugin:acme.linear@local', hosts: ['api.linear.app'] }]);
		// Unsandboxed extension code (the default for third parties, N.1) can reach anything: the card says so.
		assert.strictEqual(authority.extensionToolDecision('linear_sync', { ...linear, sandboxed: false }, offline).promptable?.flow?.hosts, 'all');
		// Compatible: a chat that reaches the host, or one with the network on.
		assert.ok(authority.extensionToolDecision('linear_sync', linear, { id: 'c2', settings: { ...WRITE, allowedDomains: ['api.linear.app'] } }).allow);
		assert.ok(authority.extensionToolDecision('linear_sync', linear, { id: 'c3', settings: { ...WRITE, network: true } }).allow);
		// A tool class beyond what the chat may do itself (attenuation): refused, no card.
		const remember = authority.extensionToolDecision('remember', { extensionId: 'volt.memory', label: 'Memory', firstParty: true, toolClass: 'persists', declared: [{ id: 'agents.context' }] }, offline);
		assert.deepStrictEqual([remember.deniedBy, remember.promptable], ['caller', undefined]);

		const once = authority.approveFlow('c1', 'plugin:acme.linear@local', ['api.linear.app'], 'once');
		assert.ok(authority.extensionToolDecision('linear_sync', linear, offline).allow);
		authority.consume(once);
		assert.ok(!authority.extensionToolDecision('linear_sync', linear, offline).allow, 'once is spent by the call it allowed');

		authority.approveFlow('c1', 'plugin:acme.linear@local', ['api.linear.app'], 'session');
		assert.ok(authority.extensionToolDecision('linear_sync', linear, offline).allow);
		assert.ok(authority.extensionToolDecision('linear_sync', linear, offline).allow, 'for this chat: still allowed');
		assert.ok(!authority.extensionToolDecision('linear_sync', linear, { id: 'c9', settings: WRITE }).allow, 'only this chat');
		assert.deepStrictEqual(authority.flowApprovals('c1').map(g => [g.kind, g.scope.hosts]), [['session', ['api.linear.app']]], 'visible');
		assert.strictEqual(authority.revokeFlowApprovals('c1'), 1);
		assert.ok(!authority.extensionToolDecision('linear_sync', linear, offline).allow, 'revocable');
		// Every decision the gate made replays from its log record (POL-DET-1).
		for (const { snapshot, record } of authority.decisionLog()) {
			assert.deepStrictEqual(replayDecision(snapshot, record), record.decision);
		}
	});

	test('mode: enforce acts on the Authority, shadow on the earlier rule; both record the difference', () => {
		const authority = store.add(new HostToolAuthority(() => NOW));
		const allow = authority.extensionToolDecision('linear_sync', { extensionId: 'acme.notes', label: 'Notes', firstParty: false, toolClass: 'safe', declared: [{ id: 'tools.register' }], sandboxed: true }, { id: 'c1', settings: WRITE });
		assert.ok(allow.allow);
		const seen: string[] = [];
		store.add(authority.onDidDiff(diff => seen.push(`${diff.mode}:${diff.legacy}`)));
		assert.strictEqual(authority.compare('linear_sync', 'chat:c1', true, allow), false, 'enforce: the Authority allows');
		authority.mode = 'shadow';
		assert.strictEqual(authority.compare('linear_sync', 'chat:c1', true, allow), true, 'shadow: the earlier refusal stands');
		assert.deepStrictEqual(seen, ['enforce:deny', 'shadow:deny']);
		assert.strictEqual(readPolicyAuthorityMode('shadow'), 'shadow');
		assert.strictEqual(readPolicyAuthorityMode('anything else'), 'enforce');
	});
});
