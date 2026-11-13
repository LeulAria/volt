/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Policy Authority (spec C2, Part G): the G.2 layers one by one, prompt eligibility (G.3), the
 * egress-compatibility rule (G.6, PERM-FLOW-1), cross-plugin calls (XPL-1..4), and the laws
 * AUTH-PROP-1..3, POL-PROP-5/6/7 (at the Authority) and POL-DET-1 on seeded random inputs, plus the
 * performance budget (`evaluate` p95 <= 50 us, snapshot rebuild <= 5 ms).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { capabilityClass } from '../../../voltPlugins/common/capabilityCatalog.js';
import { ceilingCovers } from '../../../voltPlugins/common/firstPartyCeilings.js';
import { chatCovers, decisionRecord, egressOf, egressWithin, evaluate, flowApprovals, IAccessRequest, IAdminPolicy, IChatView, IDecision, IManifestView, IPolicySnapshotInput, IWorkspaceRestriction, parseAdminPolicy, PolicyAuthority, PolicySnapshot, replayDecision, unionEgress } from '../../common/authority.js';
import { canonicalJson, FLOW_CAPABILITY, IGrant, IRefusal } from '../../common/grants.js';
import { chatSubject, corePrincipal, ICallContext, IPrincipal, isChatSubject, SubjectKey, subjectExtensionId } from '../../common/principals.js';
import { CREDENTIAL_HOME_PATHS } from '../../common/sandboxProfiles.js';
import { SandboxDimension } from '../../common/sandboxSchema.js';
import { forAll, Gen, PROPERTY_RUNS, rng } from './seededGen.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HOME = '/Users/me';

function principal(subject: SubjectKey): IPrincipal {
	return corePrincipal(`p:${subject}`, subject, isChatSubject(subject) ? 'agent' : 't3', NOW);
}

function ctx(subject: SubjectKey, chain: readonly SubjectKey[] = [], extra: Partial<ICallContext> = {}): ICallContext {
	return { principal: principal(subject), onBehalfOf: chain.map(principal), requestId: 'r', ...extra };
}

function grant(subject: SubjectKey, capability: string, extra: Partial<IGrant> = {}): IGrant {
	return { id: `g:${subject}:${capability}:${extra.kind ?? 'persistent'}:${extra.sessionId ?? ''}`, subject, capability, scope: {}, kind: 'persistent', source: 'user', grantedAt: NOW - DAY, lastUsedAt: NOW - DAY, epoch: 1, ...extra };
}

const LINEAR: SubjectKey = 'plugin:acme.linear@local';
const OTHER: SubjectKey = 'plugin:acme.other@local';
const MEMORY: SubjectKey = 'firstparty:volt.memory';
const USAGE: SubjectKey = 'firstparty:volt.usage';
const ROUTER: SubjectKey = 'firstparty:volt.provider-openrouter';
const CHAT_OFF = chatSubject('net-off');
const CHAT_ON = chatSubject('net-on');
const CHAT_FREE = chatSubject('unconfined');

const BASE_CHATS: IChatView[] = [
	{ subject: CHAT_OFF, settings: { level: 'workspace-write', network: false, allowedDomains: ['github.com'] }, folder: '/ws/a' },
	{ subject: CHAT_ON, settings: { level: 'workspace-write', network: true }, folder: '/ws' },
	{ subject: CHAT_FREE, settings: { level: 'off', network: true } },
];

const BASE_MANIFESTS: IManifestView[] = [
	{ subject: LINEAR, declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }, { id: 'agents.send', optional: true }], network: 'broker' },
	{ subject: OTHER, declared: [{ id: 'tools.register' }], network: 'broker' },
	{ subject: MEMORY, declared: [{ id: 'tools.register' }, { id: 'agents.context' }], network: 'broker' },
	{ subject: USAGE, declared: [{ id: 'usage.report' }, { id: 'net.connect' }], network: 'broker' },
	{ subject: ROUTER, declared: [{ id: 'net.connect', targets: ['openrouter.ai'] }], network: 'broker' },
];

function snap(extra: Partial<IPolicySnapshotInput> = {}): PolicySnapshot {
	return PolicySnapshot.build({ epoch: 3, asOf: NOW, chats: BASE_CHATS, manifests: BASE_MANIFESTS, home: HOME, ...extra });
}

const TOOL: IAccessRequest = { capability: 'tools.register', target: 'linear_sync', edge: 'tool', surface: 'host-tool' };

suite('Volt Policy Authority (C2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('G.2 layers', () => {

		test('1 floor: unknown capabilities, critical ones on the extension API, credential targets', () => {
			const s = snap();
			assert.strictEqual(evaluate(s, { capability: 'teleport' }, ctx(LINEAR)).deniedBy, 'floor');
			const critical = evaluate(s, { capability: 'secrets.manage', surface: 'extension-api' }, ctx('firstparty:volt.claude-accounts'));
			assert.deepStrictEqual([critical.deniedBy, critical.code], ['floor', 'critical']);
			for (const target of ['~/.ssh/id_ed25519', `${HOME}/.aws/credentials`, `${HOME}/.volt/trust/grants.json`, `${HOME}/work/../.ssh/x`]) {
				const decision = evaluate(s, { capability: 'files.write', target }, ctx(CHAT_FREE));
				assert.deepStrictEqual([decision.deniedBy, decision.code], ['floor', 'credential'], target);
			}
			assert.ok(evaluate(s, { capability: 'files.write', target: `${HOME}/work/a.ts` }, ctx(CHAT_FREE)).allow);
		});

		test('2 manifest: undeclared, other targets, unknown subjects (INV-13)', () => {
			const s = snap();
			assert.deepStrictEqual(pick(evaluate(s, { capability: 'git.read' }, ctx(LINEAR))), ['manifest', 'undeclared']);
			assert.deepStrictEqual(pick(evaluate(s, { capability: 'net.connect', target: 'evil.com' }, ctx(LINEAR))), ['manifest', 'undeclared-target']);
			assert.ok(evaluate(s, { capability: 'net.connect', target: 'api.linear.app' }, ctx(LINEAR)).allow, 'a declared low capability is an install-time grant');
			assert.deepStrictEqual(pick(evaluate(s, { capability: 'tools.register' }, ctx('plugin:ghost.x@local'))), ['manifest', 'unknown-subject']);
			assert.deepStrictEqual(pick(evaluate(s, { capability: 'tools.register' }, ctx(chatSubject('ghost')))), ['manifest', 'unknown-subject']);
			assert.ok(evaluate(s, { capability: 'storage.own' }, ctx(OTHER)).allow, 'class none is automatic');
			// A sandboxed chat's built-in manifest has no persisting, spawning, other chats or escapes.
			for (const capability of ['agents.context', 'agents.create', 'agents.read:other', 'spawn.unsandboxed', 'desktop.control']) {
				assert.deepStrictEqual(pick(evaluate(s, { capability }, ctx(CHAT_ON))), ['manifest', 'chat-sandbox'], capability);
				assert.ok(evaluate(s, { capability }, ctx(CHAT_FREE)).allow, `${capability}: an unconfined chat`);
			}
		});

		test('3 grants: first party is its ceiling; third party needs a valid grant for medium and high', () => {
			const s = snap({ grants: [grant(LINEAR, 'agents.send@1')] });
			assert.ok(evaluate(s, { capability: 'agents.context' }, ctx(MEMORY)).allow);
			assert.ok(evaluate(s, { capability: 'net.connect', target: 'openrouter.ai' }, ctx(ROUTER)).allow);
			const beyond = snap({ manifests: [...BASE_MANIFESTS.filter(m => m.subject !== MEMORY), { subject: MEMORY, declared: [{ id: 'net.connect' }], network: 'broker' }] });
			assert.deepStrictEqual(pick(evaluate(beyond, { capability: 'net.connect', target: 'x.com' }, ctx(MEMORY))), ['authority', 'ceiling'], 'declared but beyond the ceiling');
			assert.ok(evaluate(s, { capability: 'agents.send', target: 'chat:x' }, ctx(LINEAR)).allow);
			const none = evaluate(snap(), { capability: 'agents.send' }, ctx(LINEAR, [], { foreground: true }));
			assert.deepStrictEqual(pick(none), ['authority', 'consent']);
			assert.ok(none.promptable && none.promptable.class === 'medium');
			// Expired, other workspace, other session, later epoch: not valid.
			for (const bad of [
				grant(LINEAR, 'agents.send@1', { expiresAt: NOW - 1 }),
				grant(LINEAR, 'agents.send@1', { kind: 'workspace', workspace: '/other' }),
				grant(LINEAR, 'agents.send@1', { kind: 'session', sessionId: 'another-chat' }),
				grant(LINEAR, 'agents.send@1', { epoch: 4 }),
				grant(LINEAR, 'agents.send@1', { revoked: true }),
				grant(LINEAR, 'agents.send@1', { lastUsedAt: NOW - 31 * DAY }),
			]) {
				assert.ok(!evaluate(snap({ grants: [bad] }), { capability: 'agents.send' }, ctx(LINEAR)).allow, JSON.stringify(bad));
			}
			assert.ok(evaluate(snap({ grants: [grant(LINEAR, 'agents.send@1', { kind: 'workspace', workspace: '/ws' })], workspace: { root: '/ws' } }), { capability: 'agents.send' }, ctx(LINEAR)).allow);
		});

		test('4 workspace and 5 admin only ever restrict', () => {
			const trustGated = snap({ manifests: [...BASE_MANIFESTS, { subject: OTHER, declared: [{ id: 'files.read:workspace' }], network: 'broker' }], workspace: { trusted: false } });
			assert.deepStrictEqual(pick(evaluate(trustGated, { capability: 'files.read:workspace' }, ctx(OTHER))), ['workspace', 'untrusted-workspace']);
			assert.deepStrictEqual(pick(evaluate(snap({ workspace: { denyCapabilities: ['tools.register'] } }), TOOL, ctx(LINEAR))), ['workspace', 'workspace-policy']);
			assert.deepStrictEqual(pick(evaluate(snap({ admin: { denyCapabilities: ['net.connect'] } }), { capability: 'net.connect', target: 'api.linear.app' }, ctx(LINEAR))), ['admin', 'admin-capability']);
			assert.deepStrictEqual(pick(evaluate(snap({ admin: { denyHosts: ['*.linear.app'] } }), { capability: 'net.connect', target: 'api.linear.app' }, ctx(LINEAR))), ['admin', 'admin-host']);
			assert.deepStrictEqual(pick(evaluate(snap({ admin: { maxThirdPartyClass: 'none' } }), TOOL, ctx(LINEAR))), ['admin', 'admin-class']);
			assert.deepStrictEqual(pick(evaluate(snap({ admin: { unreadable: true } }), TOOL, ctx(LINEAR))), ['admin', 'admin-unreadable']);
			assert.ok(evaluate(snap({ admin: { unreadable: true } }), { capability: 'tools.register' }, ctx(MEMORY)).allow, 'first party keeps its ceiling');
			assert.deepStrictEqual(parseAdminPolicy({ denyCapabilities: 'all' }), { unreadable: true });
			assert.deepStrictEqual(parseAdminPolicy({ denyHosts: ['x.com'], maxThirdPartyClass: 'low' }), { denyHosts: ['x.com'], maxThirdPartyClass: 'low' });
		});

		test('8 platform: a dimension the backend cannot enforce refuses confined principals only', () => {
			const s = snap({ platform: { unenforced: ['network.listen'] } });
			const chats: IChatView[] = [...BASE_CHATS, { subject: chatSubject('dev'), settings: { level: 'workspace-write', network: false, listenPorts: [3000] } }];
			assert.deepStrictEqual(pick(evaluate(PolicySnapshot.build({ ...s.input, chats }), { capability: 'net.listen:3000' }, ctx(chatSubject('dev')))), ['platform', 'unenforced']);
			assert.ok(evaluate(s, { capability: 'net.listen:3000' }, ctx(CHAT_FREE)).allow, 'an unconfined chat has no sandbox to fall short');
		});

		test('G.3: prompts only with a gesture or foreground, for low to high, declared, unrefused, within budget', () => {
			const ask = (s: PolicySnapshot, c: ICallContext, capability = 'agents.send') => evaluate(s, { capability }, c).promptable;
			const me = principal(LINEAR);
			const gesture = { id: 'g', principal: me.id, issuedAt: NOW - 500, consumed: false };
			assert.ok(ask(snap(), { principal: me, onBehalfOf: [], requestId: 'r', gesture }));
			assert.ok(!ask(snap(), { principal: me, onBehalfOf: [], requestId: 'r' }), 'no gesture, not in front');
			assert.ok(!ask(snap(), { principal: me, onBehalfOf: [], requestId: 'r', gesture: { ...gesture, issuedAt: NOW - 1500 } }), 'gesture older than 1 s');
			assert.ok(!ask(snap(), { principal: me, onBehalfOf: [], requestId: 'r', gesture: { ...gesture, consumed: true } }), 'consumed gesture');
			assert.ok(!ask(snap(), { principal: me, onBehalfOf: [], requestId: 'r', gesture: { ...gesture, principal: 'someone-else' } }), 'gesture for another principal');
			const refusals: IRefusal[] = [{ subject: LINEAR, capability: 'agents.send@1', at: NOW }];
			assert.ok(!ask(snap({ refusals }), ctx(LINEAR, [], { foreground: true })), 'refused: no more prompts');
			assert.ok(!ask(snap({ promptBudgetExhausted: [LINEAR] }), ctx(LINEAR, [], { foreground: true })), 'budget spent');
			const critical = snap({ manifests: [...BASE_MANIFESTS, { subject: OTHER, declared: [{ id: 'desktop.control' }], network: 'broker' }] });
			assert.ok(!ask(critical, ctx(OTHER, [], { foreground: true }), 'desktop.control'), 'critical never prompts');
			assert.ok(!ask(snap(), ctx(LINEAR, [], { foreground: true }), 'git.read'), 'undeclared: the manifest denies, no prompt');
		});

		test('time-explicit: expiry is judged at the snapshot time, never the clock', () => {
			const expiring = grant(LINEAR, 'agents.send@1', { expiresAt: NOW + 1000 });
			const before = snap({ grants: [expiring] });
			const after = PolicySnapshot.build({ ...before.input, asOf: NOW + 1000 });
			const realNow = Date.now;
			Date.now = () => { throw new Error('evaluate read the clock'); };
			try {
				assert.ok(evaluate(before, { capability: 'agents.send' }, ctx(LINEAR)).allow);
				assert.ok(!evaluate(after, { capability: 'agents.send' }, ctx(LINEAR)).allow);
			} finally {
				Date.now = realNow;
			}
			assert.strictEqual(before.rebuildAt, NOW + 1000, 'rebuilt when the earliest grant expires');
		});
	});

	suite('PERM-FLOW-1: egress compatibility (G.6, B-22)', () => {

		test('a network-off chat calling a tool of a plugin with hosts is refused with a card; allowed once or for this chat; revocable', () => {
			const refused = evaluate(snap(), TOOL, ctx(LINEAR, [CHAT_OFF]));
			assert.deepStrictEqual(pick(refused), ['egress-compat', 'egress']);
			assert.deepStrictEqual(refused.promptable?.flow, { from: CHAT_OFF, to: LINEAR, hosts: ['api.linear.app'] });
			assert.deepStrictEqual(refused.promptable?.choices, ['once', 'session']);
			const forChat = grant(CHAT_OFF, FLOW_CAPABILITY, { kind: 'session', sessionId: 'net-off', scope: { targets: [LINEAR], hosts: ['api.linear.app'] } });
			assert.ok(evaluate(snap({ grants: [forChat] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'after "Allow for this chat"');
			assert.ok(evaluate(snap({ grants: [{ ...forChat, kind: 'once', sessionId: undefined }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'after "Allow once"');
			assert.ok(!evaluate(snap({ grants: [{ ...forChat, revoked: true }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'revoked');
			assert.ok(!evaluate(snap({ grants: [{ ...forChat, scope: { targets: [OTHER], hosts: ['*'] } }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'an approval for another plugin');
			assert.ok(!evaluate(snap({ grants: [{ ...forChat, scope: { targets: [LINEAR], hosts: ['api.other.app'] } }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'an approval for other hosts');
		});

		test('compatible without a card: network on, unconfined, hosts the chat reaches, or a plugin with no egress', () => {
			assert.ok(evaluate(snap(), TOOL, ctx(LINEAR, [CHAT_ON])).allow);
			assert.ok(evaluate(snap(), TOOL, ctx(LINEAR, [CHAT_FREE])).allow);
			const reach = snap({ chats: [{ subject: CHAT_OFF, settings: { level: 'workspace-write', network: false, allowedDomains: ['*.linear.app'] } }] });
			assert.ok(evaluate(reach, TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'egress within the chat\'s allowed hosts');
			assert.ok(evaluate(snap(), { ...TOOL, target: 'remember' }, ctx(MEMORY, [CHAT_OFF])).allow, 'first party with no egress (memory) is always compatible');
		});

		test('an unsandboxed extension reaches everything: a network-off chat always gets the card', () => {
			const host = snap({ manifests: BASE_MANIFESTS.map(m => m.subject === LINEAR ? { ...m, network: 'host' as const } : m) });
			const refused = evaluate(host, TOOL, ctx(LINEAR, [CHAT_OFF]));
			assert.deepStrictEqual(refused.promptable?.flow?.hosts, 'all');
			const approved = grant(CHAT_OFF, FLOW_CAPABILITY, { kind: 'session', sessionId: 'net-off', scope: { targets: [LINEAR], hosts: ['*'] } });
			assert.ok(evaluate(PolicySnapshot.build({ ...host.input, grants: [approved] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow);
		});

		test('PERM-FLOW-2: a plugin\'s "Allow host" grants (the broker\'s) are part of its egress; revoked or expired ones are not; a chat\'s are never', () => {
			const reach = { chats: [{ subject: CHAT_OFF, settings: { level: 'workspace-write' as const, network: false, allowedDomains: ['api.linear.app'] } }] };
			assert.ok(evaluate(snap(reach), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'its declared host only: within the chat');
			// The broker's grant: a session grant of the plugin's running process, any session.
			const allowHost = grant(LINEAR, 'net.connect@1', { kind: 'session', sessionId: 'p:host-run-7', scope: { targets: ['paste.evil.com'] } });
			const refused = evaluate(snap({ ...reach, grants: [allowHost] }), TOOL, ctx(LINEAR, [CHAT_OFF]));
			assert.deepStrictEqual(pick(refused), ['egress-compat', 'egress']);
			assert.deepStrictEqual(refused.promptable?.flow?.hosts, ['paste.evil.com'], 'the card names what the chat does not reach');
			assert.ok(evaluate(snap({ ...reach, grants: [{ ...allowHost, revoked: true }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'revoked');
			assert.ok(evaluate(snap({ ...reach, grants: [{ ...allowHost, expiresAt: NOW - 1 }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow, 'expired');
			assert.deepStrictEqual(evaluate(snap({ ...reach, grants: [{ ...allowHost, scope: {} }] }), TOOL, ctx(LINEAR, [CHAT_OFF])).promptable?.flow?.hosts, 'all', 'a grant with no target reaches anything');
			// A chat's own network grants widen what the chat reaches, not what it is judged to send.
			assert.ok(evaluate(snap({ ...reach, grants: [grant(CHAT_OFF, 'net.connect@1', { scope: { targets: ['x.com'] } })] }), TOOL, ctx(LINEAR, [CHAT_OFF])).allow);
		});

		test('a chat prompting another chat: the target must be confined at least as much (INV-11)', () => {
			const send: IAccessRequest = { capability: 'agents.send', target: CHAT_ON, edge: 'send' };
			assert.deepStrictEqual(pick(evaluate(snap(), send, ctx(CHAT_OFF))), ['egress-compat', 'covers']);
			assert.ok(evaluate(snap(), { ...send, target: CHAT_OFF }, ctx(CHAT_ON)).allow);
			assert.ok(!evaluate(snap(), { ...send, target: chatSubject('ghost') }, ctx(CHAT_ON)).allow, 'a chat Volt has no record of');
		});
	});

	suite('XPL: no amplification across principals (INV-02)', () => {

		test('XPL-1: plugin A calling plugin B on its behalf gets only what A may do', () => {
			const decision = evaluate(snap(), { capability: 'net.connect', target: 'api.linear.app' }, ctx(LINEAR, [OTHER]));
			assert.deepStrictEqual([decision.deniedBy, decision.subject], ['caller', OTHER]);
		});

		test('XPL-2: egress is checked on every edge of the chain, not only the first', () => {
			// The chat may reach github.com; OTHER has no egress; LINEAR reaches api.linear.app.
			const decision = evaluate(snap(), TOOL, ctx(LINEAR, [CHAT_OFF, OTHER]));
			assert.deepStrictEqual([decision.deniedBy, decision.subject], ['egress-compat', LINEAR]);
		});

		test('XPL-3: first party acting for a third party is attenuated to the third party', () => {
			const decision = evaluate(snap(), { capability: 'agents.context' }, ctx(MEMORY, [OTHER]));
			assert.deepStrictEqual([decision.deniedBy, decision.subject], ['caller', OTHER]);
		});

		test('XPL-4: a callee never borrows its caller\'s authority', () => {
			const decision = evaluate(snap(), { capability: 'net.connect', target: 'x.com' }, ctx(OTHER, [USAGE]));
			assert.deepStrictEqual(pick(decision), ['manifest', 'undeclared']);
			assert.deepStrictEqual(pick(evaluate(snap(), TOOL, ctx(LINEAR, Array.from({ length: 8 }, () => CHAT_ON)))), ['caller', 'chain-too-long']);
		});
	});

	suite('laws (K.2)', () => {

		test('AUTH-PROP-1: adding a deny anywhere never turns a deny into an allow', () => {
			forAll('AUTH-PROP-1', gen => {
				const { input, request, context } = randomCase(gen);
				const before = evaluate(PolicySnapshot.build(input), request, context);
				if (before.allow) {
					return;
				}
				const { input: denied, context: deniedContext } = addDeny(gen, input, context);
				const after = evaluate(PolicySnapshot.build(denied), request, deniedContext);
				assert.ok(!after.allow, `${JSON.stringify(request)} became allowed after adding a deny (${before.deniedBy})`);
			});
		});

		test('AUTH-PROP-2: allow(P via chain) implies allow(C) for every C in the chain', () => {
			let checked = 0;
			forAll('AUTH-PROP-2', gen => {
				const { input, request, context } = chainedCase(gen);
				const snapshot = PolicySnapshot.build(input);
				if (!evaluate(snapshot, request, context).allow) {
					return;
				}
				context.onBehalfOf.forEach((caller, i) => {
					checked++;
					// C in its own context: the callers before it in the chain.
					const own = evaluate(snapshot, { ...request, edge: undefined }, { principal: caller, onBehalfOf: context.onBehalfOf.slice(0, i), requestId: 'r' });
					assert.ok(own.allow, `${caller.subject} may not ${request.capability} on its own (${own.reason}) but its callee could for it`);
				});
			});
			assert.ok(checked > 100, `the law was exercised (${checked} callers)`);
		});

		test('AUTH-PROP-3: every allowed data-flow edge is egress-compatible', () => {
			let checked = 0;
			forAll('AUTH-PROP-3', gen => {
				const { input, request, context } = chainedCase(gen);
				const snapshot = PolicySnapshot.build(input);
				if (!request.edge || !evaluate(snapshot, request, context).allow) {
					return;
				}
				const nodes = [...context.onBehalfOf, context.principal].map(p => p.subject);
				if (request.target?.startsWith('chat:') && request.target !== nodes[nodes.length - 1]) {
					nodes.push(request.target as SubjectKey);
				}
				for (let i = 0; i + 1 < nodes.length; i++) {
					const [from, to] = [nodes[i], nodes[i + 1]];
					if (from === to) {
						continue;
					}
					checked++;
					if (isChatSubject(from) && isChatSubject(to)) {
						const caller = snapshot.chat(from)!;
						assert.ok(caller.settings.level === 'off' || chatCovers(snapshot.chat(to), caller), `${from} -> ${to} not covered`);
					} else {
						const ours = unionEgress(egressOf(snapshot, from, context), flowApprovals(snapshot, from, to, context));
						assert.ok(egressWithin(egressOf(snapshot, to, context), ours), `${from} -> ${to}: egress not within`);
					}
				}
			}, PROPERTY_RUNS * 2);
			assert.ok(checked > 100, `the law was exercised (${checked} edges)`);
		});

		test('POL-PROP-5 (Authority): no input allows a floor-denied request', () => {
			forAll('POL-PROP-5', gen => {
				const { input, context } = randomCase(gen);
				const request = gen.pick<IAccessRequest>([
					{ capability: gen.pick(['teleport', 'files.read:everything', 'net.connect2']) },
					{ capability: gen.pick(['desktop.control', 'secrets.read', 'full', 'spawn.unsandboxed']), surface: 'extension-api' },
					{ capability: gen.pick(['files.write', 'files.read:workspace', 'files.read:home']), target: `${gen.pick(['~', HOME])}/${gen.pick(CREDENTIAL_HOME_PATHS)}/${gen.pick(['', 'x', 'a/b'])}` },
				]);
				const decision = evaluate(PolicySnapshot.build(input), request, context);
				assert.ok(!decision.allow, `${JSON.stringify(request)} allowed`);
			});
		});

		test('POL-PROP-6 (Authority): what a first party is allowed lies within its ceiling', () => {
			let allowed = 0;
			forAll('POL-PROP-6', gen => {
				const { input, request } = randomCase(gen);
				const subject = gen.pick<SubjectKey>([MEMORY, USAGE, ROUTER, 'firstparty:volt.browser', 'firstparty:volt.not-a-feature']);
				const manifest: IManifestView = { subject, declared: gen.some(DECLARATIONS, 6), network: 'broker' };
				const snapshot = PolicySnapshot.build({ ...input, manifests: [...(input.manifests ?? []).filter(m => m.subject !== subject), manifest] });
				const own = manifest.declared.length && gen.bool(0.7) ? gen.pick(manifest.declared) : undefined;
				const asked: IAccessRequest = own ? { capability: own.id.replace(/:\*$/, ':3000'), ...(own.targets?.length ? { target: gen.pick(own.targets).replace('*.', 'api.') } : gen.bool() ? { target: gen.pick(['openrouter.ai', 'evil.com', 'linear_sync']) } : {}) } : request;
				const decision = evaluate(snapshot, asked, ctx(subject));
				if (decision.allow && capabilityClass(asked.capability) !== 'none') {
					allowed++;
					assert.ok(ceilingCovers(subjectExtensionId(subject)!, asked.capability, asked.target), `${subject} got ${asked.capability} on ${asked.target}`);
				}
			});
			assert.ok(allowed > 20, `the law was exercised (${allowed} allows)`);
		});

		test('POL-PROP-7 (Authority): credential paths are denied for every subject and every grant', () => {
			forAll('POL-PROP-7', gen => {
				const { input, context } = randomCase(gen);
				const everything = PolicySnapshot.build({ ...input, grants: [...input.grants ?? [], ...(input.manifests ?? []).map(m => grant(m.subject, 'files.write@1'))] });
				const target = `${HOME}/${gen.pick(CREDENTIAL_HOME_PATHS)}${gen.pick(['', '/x', '/deep/er'])}`;
				const decision = evaluate(everything, { capability: gen.pick(['files.write', 'files.read:workspace', 'files.read:home', 'files.read:picked']), target }, context);
				assert.deepStrictEqual([decision.allow, decision.deniedBy], [false, 'floor'], target);
			});
		});

		test('POL-DET-1: logged decisions replay to the same decision from the stored snapshot', () => {
			const log: { snapshot: string; record: string }[] = [];
			forAll('POL-DET-1 (log)', gen => {
				const { input, request, context } = randomCase(gen);
				const snapshot = PolicySnapshot.build(input);
				const decision = evaluate(snapshot, request, context);
				log.push({ snapshot: JSON.stringify(snapshot.toJSON()), record: JSON.stringify(decisionRecord(snapshot, request, context, decision)) });
			}, 300);
			for (const entry of log) {
				const snapshot = PolicySnapshot.fromJSON(JSON.parse(entry.snapshot));
				const record = JSON.parse(entry.record);
				assert.strictEqual(canonicalJson(replayDecision(snapshot, record)), canonicalJson(record.decision));
			}
			// A tampered snapshot or context is caught, not silently replayed.
			const record = JSON.parse(log[0].record);
			const other = PolicySnapshot.fromJSON({ ...JSON.parse(log[0].snapshot), epoch: 999 });
			assert.throws(() => replayDecision(other, record), /is not the logged/);
			assert.throws(() => replayDecision(PolicySnapshot.fromJSON(JSON.parse(log[0].snapshot)), { ...record, context: { ...record.context, requestId: 'forged' } }), /does not match/);
		});
	});

	test('PolicyAuthority: epochs only grow, changes are announced, decisions are offered to the log', () => {
		const logged: IDecision[] = [];
		const authority = new PolicyAuthority({ epoch: 1, asOf: NOW, manifests: BASE_MANIFESTS }, (_record, decision) => logged.push(decision));
		const changes: number[] = [];
		const listener = authority.onDidChange(e => changes.push(e.epoch));
		assert.ok(authority.evaluate(TOOL, ctx(LINEAR)).allow);
		authority.update({ epoch: 2, asOf: NOW, manifests: [] }, { subjects: [LINEAR], narrowed: true });
		assert.ok(!authority.evaluate(TOOL, ctx(LINEAR)).allow);
		assert.throws(() => authority.update({ epoch: 1, asOf: NOW }), /older/);
		assert.deepStrictEqual(changes, [2]);
		assert.strictEqual(logged.length, 2);
		assert.strictEqual(authority.launchView(principal(LINEAR)).manifest, undefined);
		listener.dispose();
		authority.dispose();
	});

	test('performance: evaluate p95 <= 50 us, snapshot rebuild <= 5 ms (CI margin x5)', () => {
		const gen = new Gen(rng(42));
		const input = bigInput(gen);
		const rebuilds: number[] = [];
		for (let i = 0; i < 30; i++) {
			const start = performance.now();
			PolicySnapshot.build({ ...input, epoch: input.epoch + i });
			rebuilds.push(performance.now() - start);
		}
		const snapshot = PolicySnapshot.build(input);
		const cases = Array.from({ length: 4000 }, () => randomRequest(gen, input));
		for (const c of cases.slice(0, 400)) {
			evaluate(snapshot, c.request, c.context); // warm up
		}
		// The renderer's clock is coarse: time batches of 50 calls and take the per-call mean of each.
		const BATCH = 50;
		const perCall: number[] = [];
		for (let i = 0; i + BATCH <= cases.length; i += BATCH) {
			const start = performance.now();
			for (let j = i; j < i + BATCH; j++) {
				evaluate(snapshot, cases[j].request, cases[j].context);
			}
			perCall.push((performance.now() - start) * 1000 / BATCH);
		}
		const p95 = percentile(perCall, 0.95);
		const rebuild = percentile(rebuilds, 0.95);
		const measured = `evaluate p50 ${percentile(perCall, 0.5).toFixed(1)} us, p95 ${p95.toFixed(1)} us; snapshot rebuild p95 ${rebuild.toFixed(2)} ms (${input.grants?.length} grants, ${input.manifests?.length} manifests, ${input.chats?.length} chats)`;
		assert.ok(p95 <= 250, `${measured}; budget 50 us`);
		assert.ok(rebuild <= 25, `${measured}; budget 5 ms`);
	});
});

function pick(decision: IDecision): [string | undefined, string | undefined] {
	return [decision.deniedBy, decision.code];
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// --- random inputs ---------------------------------------------------------------------------

const CAPABILITIES = ['tools.register', 'storage.own', 'net.connect', 'files.read:workspace', 'files.write', 'agents.send', 'agents.read:current', 'agents.read:other', 'agents.context', 'agents.create', 'git.read', 'git.write', 'browser.drive', 'terminals.run', 'net.listen:3000', 'net.loopback.connect:5432', 'secrets.use:github', 'usage.report', 'spawn.unsandboxed', 'desktop.control', 'full', 'teleport'];
const DECLARATIONS = [
	{ id: 'tools.register' }, { id: 'net.connect' }, { id: 'net.connect', targets: ['api.linear.app'] }, { id: 'net.connect', targets: ['*.example.com'] },
	{ id: 'files.read:workspace' }, { id: 'files.write' }, { id: 'agents.send', optional: true }, { id: 'agents.context' }, { id: 'git.read' },
	{ id: 'browser.drive' }, { id: 'secrets.use:*' }, { id: 'net.listen:*' }, { id: 'usage.report' }, { id: 'desktop.control' }, { id: 'terminals.run' },
];
const TARGETS = [undefined, 'api.linear.app', 'x.example.com', 'evil.com', 'github.com', 'linear_sync', '/ws/a/file.ts', `${HOME}/notes.txt`, `${HOME}/.ssh/id_rsa`, 'chat:c0', 'chat:c1', 'chat:c2'];
const PLUGINS: SubjectKey[] = ['plugin:acme.p0@local', 'plugin:acme.p1@local', 'plugin:acme.p2@signer', MEMORY, USAGE, ROUTER, 'firstparty:volt.browser'];
const CHATS: SubjectKey[] = ['chat:c0', 'chat:c1', 'chat:c2'];
const DIMENSIONS: SandboxDimension[] = ['network.listen', 'network.proxy', 'filesystem.write', 'filesystem.read', 'network.loopbackPorts'];

function randomChat(gen: Gen, subject: SubjectKey): IChatView {
	const level = gen.pick(['off', 'workspace-write', 'read-only'] as const);
	return {
		subject,
		settings: {
			level,
			network: gen.bool(0.4),
			...(gen.bool(0.4) ? { allowedDomains: gen.some(['github.com', '*.linear.app', 'api.linear.app', '*.example.com', 'openrouter.ai']) } : {}),
			...(gen.bool(0.3) ? { listenPorts: gen.some([3000, 5432, 8080]) } : {}),
			...(gen.bool(0.3) ? { extraWritableRoots: gen.some(['/ws', '/ws/a', '/tmp/out']) } : {}),
		},
		...(gen.bool(0.3) ? { strategy: gen.pick(['wrap', 'native', 'none'] as const) } : {}),
		...(gen.bool(0.7) ? { folder: gen.pick(['/ws/a', '/ws/b', '/ws', '/other']) } : {}),
	};
}

function randomGrant(gen: Gen, subjects: readonly SubjectKey[], index: number): IGrant {
	const kind = gen.pick(['once', 'session', 'workspace', 'persistent'] as const);
	const subject = gen.pick(subjects);
	const flow = isChatSubject(subject) && gen.bool(0.6);
	return {
		id: `g${index}`,
		subject,
		capability: flow ? FLOW_CAPABILITY : `${gen.pick(CAPABILITIES.filter(c => capabilityClass(c) !== undefined))}@1`,
		scope: flow
			? { targets: [gen.pick([...PLUGINS, ...CHATS])], hosts: gen.some(['api.linear.app', '*', 'evil.com', '*.example.com'], 2) }
			: gen.bool(0.4) ? { targets: gen.some(['api.linear.app', 'evil.com', 'linear_sync', '*'], 2) } : {},
		kind,
		...(kind === 'workspace' ? { workspace: gen.pick(['/ws', '/other']) } : {}),
		...(kind === 'session' ? { sessionId: gen.pick(['c0', 'c1', 'c2', 'x']) } : {}),
		...(gen.bool(0.2) ? { expiresAt: NOW + gen.pick([-1, 1, DAY]) } : {}),
		source: gen.pick(['user', 'preset', 'admin'] as const),
		grantedAt: NOW - gen.int(100) * DAY,
		lastUsedAt: NOW - gen.int(40) * DAY,
		epoch: gen.int(6),
		...(gen.bool(0.1) ? { revoked: true } : {}),
		...(gen.bool(0.3) ? { confirmed: true } : {}),
	};
}

function randomInput(gen: Gen): IPolicySnapshotInput {
	const chats = CHATS.map(subject => randomChat(gen, subject));
	const manifests: IManifestView[] = PLUGINS.filter(() => gen.bool(0.85)).map(subject => ({ subject, declared: gen.some(DECLARATIONS, 6), network: gen.pick(['host', 'broker', 'none'] as const) }));
	const subjects = [...PLUGINS, ...CHATS];
	const grants = Array.from({ length: gen.int(10) }, (_, i) => randomGrant(gen, subjects, i));
	const refusals: IRefusal[] = gen.bool(0.3) ? [{ subject: gen.pick(PLUGINS), capability: `${gen.pick(CAPABILITIES.filter(c => capabilityClass(c) !== undefined))}@1`, at: NOW }] : [];
	const workspace: IWorkspaceRestriction | undefined = gen.bool(0.2) ? { root: gen.pick(['/ws', '/other']), ...(gen.bool() ? { trusted: gen.bool() } : {}), ...(gen.bool(0.3) ? { denyCapabilities: gen.some(CAPABILITIES, 2) } : {}) } : undefined;
	const admin: IAdminPolicy | undefined = gen.bool(0.2) ? {
		...(gen.bool(0.4) ? { denyCapabilities: gen.some(CAPABILITIES, 2) } : {}),
		...(gen.bool(0.3) ? { denyHosts: gen.some(['evil.com', '*.linear.app']) } : {}),
		...(gen.bool(0.3) ? { maxThirdPartyClass: gen.pick(['none', 'low', 'medium', 'high'] as const) } : {}),
		...(gen.bool(0.1) ? { unreadable: true } : {}),
	} : undefined;
	return {
		epoch: 5,
		asOf: NOW,
		grants,
		refusals,
		manifests,
		chats,
		home: HOME,
		...(workspace ? { workspace } : {}),
		...(admin ? { admin } : {}),
		...(gen.bool(0.15) ? { platform: { unenforced: gen.some(DIMENSIONS, 2) } } : {}),
	};
}

function randomRequest(gen: Gen, input: IPolicySnapshotInput): { request: IAccessRequest; context: ICallContext } {
	const subjects: SubjectKey[] = [...(input.manifests ?? []).map(m => m.subject), ...(input.chats ?? []).map(c => c.subject)];
	const chain = Array.from({ length: gen.int(4) }, () => gen.pick(subjects));
	const subject = gen.pick(subjects);
	// Mostly what the principal declares (so the laws see allows), sometimes anything.
	const declared = (input.manifests ?? []).find(m => m.subject === subject)?.declared ?? [];
	const own = declared.length && gen.bool(0.6) ? gen.pick(declared) : undefined;
	const capability = own ? own.id.replace(/:\*$/, ':3000') : gen.pick(CAPABILITIES);
	const target = own?.targets?.length ? gen.pick(own.targets).replace('*.', 'api.') : gen.bool(0.6) ? gen.pick(TARGETS.filter((t): t is string => !!t)) : undefined;
	const request: IAccessRequest = {
		capability,
		...(target !== undefined ? { target } : {}),
		...(gen.bool(0.5) ? { edge: gen.pick(['tool', 'send', 'context', 'hook'] as const) } : {}),
		...(gen.bool(0.3) ? { surface: gen.pick(['extension-api', 'host-tool', 'broker'] as const) } : {}),
	};
	return { request, context: { principal: principal(subject), onBehalfOf: chain.map(principal), requestId: 'r', ...(gen.bool(0.3) ? { foreground: true } : {}) } };
}

function randomCase(gen: Gen): { input: IPolicySnapshotInput; request: IAccessRequest; context: ICallContext } {
	const input = randomInput(gen);
	return { input, ...randomRequest(gen, input) };
}

/**
 * A case whose callers may each make the request on their own (so the chain laws see allows through
 * chains, not only refusals), half the time; otherwise a random one.
 */
function chainedCase(gen: Gen): { input: IPolicySnapshotInput; request: IAccessRequest; context: ICallContext } {
	const random = randomCase(gen);
	if (gen.bool()) {
		return random;
	}
	const { input, request, context } = random;
	const snapshot = PolicySnapshot.build(input);
	const subjects: SubjectKey[] = [...(input.manifests ?? []).map(m => m.subject), ...(input.chats ?? []).map(c => c.subject)];
	const able = subjects.filter(subject => evaluate(snapshot, { ...request, edge: undefined }, { principal: principal(subject), onBehalfOf: [], requestId: 'r' }).allow);
	if (!able.length) {
		return random;
	}
	const chain = Array.from({ length: 1 + gen.int(3) }, () => gen.pick(able));
	// Mostly a data-flow edge, so the egress law sees allowed edges too.
	const edged: IAccessRequest = !request.edge && gen.bool(0.6) ? { ...request, edge: gen.pick(['tool', 'send', 'context', 'hook'] as const) } : request;
	return { input, request: edged, context: { ...context, onBehalfOf: chain.map(principal) } };
}

/** One more deny somewhere: a layer rule, a lost grant, a refusal, a platform gap, or one more caller. */
function addDeny(gen: Gen, input: IPolicySnapshotInput, context: ICallContext): { input: IPolicySnapshotInput; context: ICallContext } {
	const capability = gen.pick(CAPABILITIES);
	switch (gen.int(7)) {
		case 0: return { input: { ...input, admin: { ...input.admin, denyCapabilities: [...input.admin?.denyCapabilities ?? [], capability] } }, context };
		case 1: return { input: { ...input, workspace: { ...input.workspace, denyCapabilities: [...input.workspace?.denyCapabilities ?? [], capability] } }, context };
		case 2: return { input: { ...input, workspace: { ...input.workspace, trusted: false } }, context };
		case 3: return { input: { ...input, platform: { unenforced: [...input.platform?.unenforced ?? [], gen.pick(DIMENSIONS)] } }, context };
		case 4: {
			// A capability grant goes away. (A flow approval going away is not a deny for the law: a
			// subject that may pass data on to fewer places is a safer recipient, as a narrower chat is.)
			const grants = [...input.grants ?? []];
			const capabilityGrants = grants.map((g, i) => g.capability === FLOW_CAPABILITY ? -1 : i).filter(i => i >= 0);
			if (capabilityGrants.length) {
				grants.splice(gen.pick(capabilityGrants), 1);
			}
			return { input: { ...input, grants }, context };
		}
		case 5: return { input: { ...input, refusals: [...input.refusals ?? [], { subject: context.principal.subject, capability: `${capability}@1`, at: NOW }] }, context };
		default: {
			const subjects: SubjectKey[] = [...(input.manifests ?? []).map(m => m.subject), ...(input.chats ?? []).map(c => c.subject)];
			const at = gen.int(context.onBehalfOf.length + 1);
			const chain = [...context.onBehalfOf];
			chain.splice(at, 0, principal(gen.pick(subjects)));
			return { input, context: { ...context, onBehalfOf: chain } };
		}
	}
}

/** A large snapshot for the benchmark: 400 grants, 60 manifests, 40 chats. */
function bigInput(gen: Gen): IPolicySnapshotInput {
	const plugins = Array.from({ length: 60 }, (_, i): SubjectKey => `plugin:pub.p${i}@local`);
	const chats: SubjectKey[] = Array.from({ length: 40 }, (_, i) => chatSubject(`c${i}`));
	return {
		epoch: 9,
		asOf: NOW,
		home: HOME,
		manifests: plugins.map(subject => ({ subject, declared: gen.some(DECLARATIONS, 8), network: gen.pick(['host', 'broker'] as const) })),
		chats: chats.map(subject => randomChat(gen, subject)),
		grants: Array.from({ length: 400 }, (_, i) => randomGrant(gen, [...plugins, ...chats], i)),
		admin: { denyHosts: ['evil.com'] },
	};
}
