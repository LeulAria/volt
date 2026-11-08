/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt extension API (spec G.8, G.10): the enforcing policy behind `vscode.volt`.
// EXT-CAP-1..7: built-ins within their ceiling, beyond it, third-party undeclared / low / medium
// (consent) / critical, and revocation. EXT-CEIL-1: the ceiling table's checks.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ceilingCovers, declarationsOutsideCeiling, firstPartyCeiling } from '../../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { ICapabilityRequest, IVoltPluginPrincipal } from '../../common/capabilities.js';
import { IVoltConsentStore, VoltConsentState, VoltExtensionCapabilityPolicy } from '../../common/extensionCapabilityPolicy.js';
import { IVoltCapabilitiesContribution } from '../../common/voltContributions.js';

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
