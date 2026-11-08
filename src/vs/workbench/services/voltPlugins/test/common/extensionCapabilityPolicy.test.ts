/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt extension API (spec G.8, G.10): the enforcing policy behind `vscode.volt`.
// EXT-CAP-1..7: built-ins within their ceiling, beyond it, third-party undeclared / low / medium
// (consent) / critical, and revocation. EXT-CEIL-1: the ceiling table's checks.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ceilingCovers, declarationsOutsideCeiling, FIRST_PARTY_CEILINGS, firstPartyCeiling } from '../../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { forAll } from '../../../../../platform/voltSandbox/test/common/seededGen.js';
import { ICapabilityRequest, IVoltPluginPrincipal } from '../../common/capabilities.js';
import { IVoltConsentStore, VoltConsentState, VoltExtensionCapabilityPolicy } from '../../common/extensionCapabilityPolicy.js';
import { IVoltCapabilitiesContribution } from '../../common/voltContributions.js';

/** The shadow differences the spec makes on purpose (C2 report): each explained where it is listed. */
const EXPECTED_EXTENSION_DIFFS: RegExp[] = [
	// D-EXT-1: a `files.*` call aimed at a credential folder is refused by the floor (G.2 step 1,
	// POL-PROP-7, INV-14). Before, the API only checked the capability, so a granted (or `none`-class
	// `files.read:picked`) call there was allowed; calls refused anyway now name the floor (it runs first).
	/^files\.[\w:]+ on ~\/\.(?:ssh|volt\/trust)\/[\w.]+: before (?:allow|manifest|ceiling|consent), now floor$/,
];

suite('Volt extension API: capability policy', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const answers = new Map<string, VoltConsentState>();
		const consents: IVoltConsentStore = { state: (extensionId, capability) => answers.get(`${extensionId}/${capability}`) };
		const policy = store.add(new VoltExtensionCapabilityPolicy(consents));
		const reported: string[] = [];
		store.add(policy.onDidReport(denial => reported.push(`${denial.capability}:${denial.deniedBy}`)));
		return { policy, answers, reported };
	}

	function principal(extensionId: string, firstParty: boolean, capabilities: IVoltCapabilitiesContribution): IVoltPluginPrincipal {
		return { extensionId, firstParty, capabilities };
	}

	const request = (capability: string, target?: string): ICapabilityRequest => ({ api: 'test', capability, ...(target !== undefined ? { target } : {}) });

	test('EXT-CAP-1: a built-in gets what it declares within its ceiling, with no consent', () => {
		const { policy } = setup();
		const memory = principal('volt.memory', true, { required: [{ id: 'tools.register', class: 'low' }, { id: 'agents.context', class: 'high' }] });
		assert.deepStrictEqual(policy.check(memory, request('agents.context', 'note')), { allowed: true });
		assert.deepStrictEqual(policy.check(memory, request('tools.register', 'memory_list')), { allowed: true });
		const openrouter = principal('volt.provider-openrouter', true, { required: [{ id: 'net.connect', class: 'low', targets: ['openrouter.ai'] }] });
		assert.deepStrictEqual(policy.check(openrouter, request('net.connect', 'openrouter.ai')), { allowed: true });
	});

	test('EXT-CAP-2: a built-in beyond its ceiling is refused, even when its manifest declares it', () => {
		const { policy, reported } = setup();
		// A tampered manifest: volt.memory now says it may send to chats. The compiled ceiling doesn't.
		const tampered = principal('volt.memory', true, { required: [{ id: 'agents.context', class: 'high' }, { id: 'agents.send', class: 'medium' }] });
		const verdict = policy.check(tampered, request('agents.send', 'chat-1'));
		assert.strictEqual(verdict.allowed, false);
		assert.strictEqual(verdict.denial?.deniedBy, 'ceiling');
		assert.ok(!verdict.denial?.promptable, 'never asked: a built-in is widened only by a core release');
		// Not declared at all: the manifest refuses first.
		assert.strictEqual(policy.check(principal('volt.memory', true, {}), request('agents.context')).denial?.deniedBy, 'manifest');
		// A ceiling entry limited to targets holds only those.
		const openrouter = principal('volt.provider-openrouter', true, { required: [{ id: 'net.connect', class: 'low' }] });
		assert.strictEqual(policy.check(openrouter, request('net.connect', 'exfil.example.com')).denial?.deniedBy, 'ceiling');
		// An extension that isn't in the table gets nothing as first party.
		assert.strictEqual(policy.check(principal('volt.notreal', true, { required: [{ id: 'usage.report', class: 'low' }] }), request('usage.report')).denial?.deniedBy, 'ceiling');
		assert.deepStrictEqual(reported, ['agents.send:ceiling', 'agents.context:manifest', 'net.connect:ceiling', 'usage.report:ceiling']);
	});

	test('EXT-CAP-3: a third party\'s undeclared capability is refused; none-class needs no declaration', () => {
		const { policy } = setup();
		const acme = principal('acme.notes', false, {});
		const denial = policy.check(acme, request('agents.read:any')).denial;
		assert.strictEqual(denial?.deniedBy, 'manifest');
		assert.ok(!denial?.promptable, 'undeclared is never asked');
		assert.strictEqual(policy.check(acme, request('mind.read')).denial?.deniedBy, 'catalog');
		assert.deepStrictEqual(policy.check(acme, request('storage.own', 'k')), { allowed: true });
		assert.deepStrictEqual(policy.check(acme, request('ui.contribute')), { allowed: true });
	});

	test('EXT-CAP-4: a third party\'s declared low capability is allowed while it is enabled', () => {
		const { policy } = setup();
		const acme = principal('acme.notes', false, { required: [{ id: 'agents.read:current', class: 'low' }, { id: 'usage.report', class: 'low' }] });
		assert.deepStrictEqual(policy.check(acme, request('agents.read:current', 'chat-1')), { allowed: true });
		assert.deepStrictEqual(policy.check(acme, request('usage.report')), { allowed: true });
	});

	test('EXT-CAP-5: a declared medium or high capability needs the user\'s consent, once', () => {
		const { policy, answers } = setup();
		const acme = principal('acme.notes', false, { required: [{ id: 'agents.send', class: 'medium' }], optional: [{ id: 'agents.create', class: 'high' }] });
		const first = policy.check(acme, request('agents.send', 'chat-1')).denial;
		assert.deepStrictEqual([first?.deniedBy, first?.promptable], ['consent', true]);
		assert.strictEqual(policy.check(acme, request('agents.create')).denial?.promptable, true);
		answers.set('acme.notes/agents.send', 'granted');
		assert.deepStrictEqual(policy.check(acme, request('agents.send', 'chat-1')), { allowed: true });
		assert.deepStrictEqual(policy.check(acme, request('agents.send', 'chat-2')), { allowed: true }, 'one consent per capability, any target');
		// Another extension's consent is not this one's.
		const other = principal('evil.copycat', false, { required: [{ id: 'agents.send', class: 'medium' }] });
		assert.strictEqual(policy.check(other, request('agents.send', 'chat-1')).denial?.deniedBy, 'consent');
		// A refusal is kept and not asked again.
		answers.set('acme.notes/agents.create', 'refused');
		const refused = policy.check(acme, request('agents.create')).denial;
		assert.deepStrictEqual([refused?.deniedBy, refused?.promptable], ['consent', undefined]);
	});

	test('EXT-CAP-6: critical capabilities are never granted through the API, whoever declares them', () => {
		const { policy, answers } = setup();
		const acme = principal('acme.notes', false, { required: [{ id: 'secrets.read', class: 'critical' }, { id: 'spawn.unsandboxed', class: 'critical' }] });
		answers.set('acme.notes/secrets.read', 'granted');
		assert.strictEqual(policy.check(acme, request('secrets.read')).denial?.deniedBy, 'critical');
		assert.strictEqual(policy.check(acme, request('full', 'undeclared tool x')).denial?.deniedBy, 'critical');
		// volt.automations declares spawn.unsandboxed within its ceiling: still not through the API.
		const automations = principal('volt.automations', true, { required: [{ id: 'spawn.unsandboxed', class: 'critical' }] });
		assert.strictEqual(policy.check(automations, request('spawn.unsandboxed')).denial?.deniedBy, 'critical');
	});

	test('EXT-CAP-7: revoking a consent refuses the next call', () => {
		const { policy, answers } = setup();
		const acme = principal('acme.notes', false, { required: [{ id: 'browser.read', class: 'medium' }] });
		answers.set('acme.notes/browser.read', 'granted');
		assert.deepStrictEqual(policy.check(acme, request('browser.read', 'chat-1')), { allowed: true });
		answers.set('acme.notes/browser.read', 'refused');
		assert.strictEqual(policy.check(acme, request('browser.read', 'chat-1')).denial?.deniedBy, 'consent');
	});

	test('SHADOW-2: the Authority-backed policy and the earlier rules agree on every extension API call (differences listed and explained)', () => {
		const answers = new Map<string, VoltConsentState>();
		const diffs = new Set<string>();
		const policy = store.add(new VoltExtensionCapabilityPolicy({ state: (extensionId, capability) => answers.get(`${extensionId}/${capability}`) }, {
			onDiff: diff => diffs.add(`${diff.capability}${diff.target !== undefined ? ` on ${diff.target}` : ''}: before ${diff.legacy?.deniedBy ?? 'allow'}, now ${diff.authority?.deniedBy ?? 'allow'}`),
		}));
		const IDS = [
			'ui.contribute', 'storage.own', 'config.own', 'commands.own', 'files.read:picked', 'files.read:workspace', 'net.connect', 'net.connect@1',
			'agents.read:current', 'tools.register', 'usage.report', 'agents.read:any', 'agents.send', 'git.read', 'hosting.read', 'files.write',
			'terminals.read', 'terminals.run', 'browser.read', 'clipboard.read', 'agents.create', 'agents.context', 'agents.hooks', 'agents.read:other',
			'git.write', 'git.push', 'hosting.write', 'net.local.connect', 'browser.drive', 'devices.drive', 'automations.schedule', 'desktop.control',
			'screen.capture', 'secrets.read', 'secrets.manage', 'files.read:home', 'spawn.unsandboxed', 'network.host', 'commands.execute:*', 'full',
			'secrets.use:claude', 'secrets.use:github', 'net.loopback.connect:11434', 'net.listen:3000', 'commands.execute:git.sync', 'mind.read',
		];
		const TARGETS = [undefined, 'chat-1', 'openrouter.ai', 'exfil.example.com', 'github.com', '~/.volt/customize/looks/a.json', '~/.claude/settings.json', 'memory_list', '~/.ssh/id_ed25519', '~/.volt/trust/grants.json', '*'];
		const outcomes = new Set<string>();
		store.add(policy.onDidReport(denial => outcomes.add(denial.deniedBy)));
		const EXTENSIONS: [string, boolean][] = [...Object.keys(FIRST_PARTY_CEILINGS).map((id): [string, boolean] => [id, true]), ['volt.notreal', true], ['acme.notes', false], ['evil.copycat', false]];
		forAll('SHADOW-2', gen => {
			const [extensionId, firstParty] = gen.pick(EXTENSIONS);
			const declare = () => gen.some(IDS, 6).map(id => ({ id, class: 'low' as const, ...(gen.bool(0.3) ? { targets: gen.some(TARGETS.filter((t): t is string => !!t), 2) } : {}) }));
			const who = principal(extensionId, firstParty, { required: declare(), optional: declare() });
			const capability = gen.bool(0.7) && who.capabilities.required?.length ? gen.pick(who.capabilities.required).id : gen.pick(IDS);
			answers.set(`${extensionId}/${capability.replace(/@\d+$/, '')}`, gen.pick([undefined, 'granted', 'refused'] as const));
			policy.check(who, request(capability, gen.pick(TARGETS)));
		}, 5000);
		// Every difference is a change the spec makes; anything else fails here.
		const unexplained = [...diffs].filter(diff => !EXPECTED_EXTENSION_DIFFS.some(pattern => pattern.test(diff)));
		assert.deepStrictEqual(unexplained, []);
		// The run reached every layer, so agreement means something.
		assert.deepStrictEqual([...outcomes].sort(), ['catalog', 'ceiling', 'consent', 'critical', 'floor', 'manifest']);
	});

	test('EXT-CAP shadow mode: the earlier rule acts, the difference is reported in both modes', () => {
		const seen: string[] = [];
		let mode: 'enforce' | 'shadow' = 'shadow';
		const policy = store.add(new VoltExtensionCapabilityPolicy({ state: () => 'granted' }, { mode: () => mode, onDiff: diff => seen.push(`${diff.legacy?.deniedBy ?? 'allow'}->${diff.authority?.deniedBy ?? 'allow'}`) }));
		// A third party the user allowed to write files, aiming at a credential folder: the Authority's floor refuses it.
		const acme = principal('acme.notes', false, { required: [{ id: 'files.write', class: 'medium' }] });
		assert.deepStrictEqual(policy.check(acme, request('files.write', '~/.ssh/authorized_keys')), { allowed: true }, 'shadow: the earlier rule allowed it');
		mode = 'enforce';
		assert.strictEqual(policy.check(acme, request('files.write', '~/.ssh/authorized_keys')).denial?.deniedBy, 'floor');
		assert.deepStrictEqual(policy.check(acme, request('files.write', 'notes/today.md')), { allowed: true });
		assert.deepStrictEqual(seen, ['allow->floor', 'allow->floor']);
	});

	test('EXT-CEIL-1: the ceiling table: families, targets and what a manifest may declare', () => {
		assert.ok(firstPartyCeiling('VOLT.Memory'), 'ids are case-insensitive');
		assert.strictEqual(firstPartyCeiling('acme.notes'), undefined);
		assert.ok(ceilingCovers('volt.usage', 'secrets.use:claude', undefined), 'a family entry holds its members');
		assert.ok(!ceilingCovers('volt.provider-claude', 'secrets.use:codex', undefined));
		assert.ok(ceilingCovers('volt.customize', 'files.write', '~/.volt/customize/looks/a.json'));
		assert.ok(!ceilingCovers('volt.customize', 'files.write', '~/.ssh/config'));
		assert.ok(!ceilingCovers('volt.customize', 'files.write', undefined), 'a limited entry needs a target');
		assert.deepStrictEqual(declarationsOutsideCeiling('volt.provider-claude', [{ id: 'secrets.use:claude' }]), []);
		assert.deepStrictEqual(declarationsOutsideCeiling('volt.provider-claude', [{ id: 'secrets.use:*' }]), ['volt.provider-claude declares secrets.use:* beyond its first-party ceiling']);
		assert.deepStrictEqual(declarationsOutsideCeiling('volt.customize', [{ id: 'files.write' }]), ['volt.customize declares files.write beyond its first-party ceiling'], 'no targets asks for every target');
		assert.deepStrictEqual(declarationsOutsideCeiling('volt.customize', [{ id: 'files.write', targets: ['~/.volt/customize/*'] }]), []);
		assert.deepStrictEqual(declarationsOutsideCeiling('volt.memory', [{ id: 'agents.send' }]), ['volt.memory declares agents.send beyond its first-party ceiling']);
		assert.deepStrictEqual(declarationsOutsideCeiling('volt.notreal', [{ id: 'usage.report' }]), ['volt.notreal has no first-party ceiling']);
	});
});
