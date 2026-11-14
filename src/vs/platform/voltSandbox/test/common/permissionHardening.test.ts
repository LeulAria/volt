/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Permission bypasses found by review (2026-11-09), each pinned by the input that triggered it:
 * host coverage by the broker's own rules (child chats, data flows, third-party manifests), the
 * managed policy's host, family and class rules, the credential floor's spellings, and the
 * "Allow folder" check.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chatCovers, egressWithin, evaluate, IChatView, IManifestView, IPolicySnapshotInput, parseAdminPolicy, PolicySnapshot } from '../../common/authority.js';
import { IGrant } from '../../common/grants.js';
import { networkEntryWithin } from '../../common/networkRules.js';
import { chatSubject, corePrincipal, ICallContext, isChatSubject, SubjectKey } from '../../common/principals.js';
import { folderGrantError, inheritedSandboxSettings } from '../../common/sandboxInheritance.js';
import { IVoltSandboxSettings } from '../../common/sandboxPolicy.js';

const NOW = 1_800_000_000_000;
const HOME = '/Users/me';
const PLUGIN: SubjectKey = 'plugin:acme.wild@local';

function ctx(subject: SubjectKey): ICallContext {
	return { principal: corePrincipal(`p:${subject}`, subject, isChatSubject(subject) ? 'agent' : 't3', NOW), onBehalfOf: [], requestId: 'r' };
}

function snap(extra: Partial<IPolicySnapshotInput> = {}): PolicySnapshot {
	return PolicySnapshot.build({ epoch: 1, asOf: NOW, home: HOME, ...extra });
}

function grantOf(capability: string, targets?: readonly string[]): IGrant {
	return { id: `g:${capability}`, subject: PLUGIN, capability, scope: targets ? { targets } : {}, kind: 'persistent', source: 'user', grantedAt: NOW - 1000, lastUsedAt: NOW - 1000, epoch: 1 };
}

function chat(name: string, settings: IVoltSandboxSettings, folders: readonly string[] = ['/ws']): IChatView {
	return { subject: chatSubject(name), settings, folders };
}

suite('Volt permission hardening (review 2026-11-09)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('networkEntryWithin: a parent covers a child only for what the broker lets the parent reach', () => {
		const cases: [string, readonly string[], boolean][] = [
			['evil.com', ['*'], true],
			['evil.com:22', ['*'], false],
			['pastebin.com', ['*'], false],
			['1.2.3.4:22', ['*'], false],
			['93.184.216.34', ['*'], false],
			['api.example.com', ['*.example.com'], true],
			['example.com', ['*.example.com'], false],
			['api.example.com:8443', ['*.example.com'], false],
			['*.api.example.com', ['*.example.com'], true],
			['*.example.com', ['example.com'], false],
			['*', ['*.example.com'], false],
			['*', ['*'], true],
			['http://example.com', ['example.com'], false],
			['http://example.com', ['example.com:80'], true],
			['10.0.1.0/24:5432', ['10.0.0.0/16:5432'], true],
			['10.0.0.0/8:5432', ['10.0.0.0/16:5432'], false],
			['10.0.1.0/24:5432', ['10.0.0.0/16:3306'], false],
			['*.com', [], true],
			['not a rule', ['*'], false],
		];
		for (const [child, parents, expected] of cases) {
			assert.strictEqual(networkEntryWithin(child, parents), expected, `${child} within ${JSON.stringify(parents)}`);
		}
	});

	test('a child chat never reaches a host its parent can\'t (ports, paste sites, addresses, the wildcard base)', () => {
		const parent = chat('parent', { level: 'workspace-write', network: false, allowedDomains: ['*'] });
		for (const host of ['evil.com:22', 'pastebin.com', '1.2.3.4:22']) {
			const child = chat('child', { level: 'workspace-write', network: false, allowedDomains: [host] });
			assert.strictEqual(chatCovers(child, parent), false, host);
			assert.deepStrictEqual(inheritedSandboxSettings(parent.settings, child.settings)?.allowedDomains ?? [], [], `${host} is not kept`);
		}
		const narrow = chat('narrow', { level: 'workspace-write', network: false, allowedDomains: ['*.acme.dev'] });
		assert.strictEqual(chatCovers(chat('base', { level: 'workspace-write', network: false, allowedDomains: ['acme.dev'] }), narrow), false, '*.acme.dev does not reach acme.dev');
		assert.strictEqual(chatCovers(chat('sub', { level: 'workspace-write', network: false, allowedDomains: ['api.acme.dev'] }), narrow), true);
		assert.strictEqual(chatCovers(chat('local', { level: 'workspace-write', network: false, allowedDomains: ['localhost'] }), narrow), true, 'loopback is not egress');
	});

	test('a folder with `..` is never inside another chat\'s folder', () => {
		const parent = chat('p', { level: 'workspace-write', network: false }, ['/ws']);
		assert.strictEqual(chatCovers(chat('c', { level: 'workspace-write', network: false }, ['/ws/../Users/me']), parent), false);
		assert.strictEqual(chatCovers(chat('c2', { level: 'workspace-write', network: false, extraWritableRoots: ['/ws/../etc'] }, ['/ws']), parent), false);
		assert.strictEqual(chatCovers(chat('c3', { level: 'workspace-write', network: false }, ['/ws/sub']), parent), true);
	});

	test('data flows: `*` egress does not cover a port, a paste site or an address', () => {
		assert.strictEqual(egressWithin(['evil.com:6379'], ['*']), false);
		assert.strictEqual(egressWithin(['pastebin.com'], ['*']), false);
		assert.strictEqual(egressWithin(['gist.example.org'], ['*.example.org']), true);
		assert.strictEqual(egressWithin(['plugin:acme.linear@local'], ['plugin:acme.linear@local']), true, 'subject keys match themselves');
		assert.strictEqual(egressWithin(['plugin:acme.linear@local'], ['*']), false, 'a host pattern never matches a subject');
	});

	test('a third party\'s manifest wildcards name hosts by the broker\'s rules, never the whole web', () => {
		for (const pattern of ['**', '*.*', '*.com', '*example.com', '*', 'exam*le.com']) {
			const manifests: IManifestView[] = [{ subject: PLUGIN, declared: [{ id: 'net.connect', targets: [pattern] }], network: 'broker' }];
			const decision = evaluate(snap({ manifests }), { capability: 'net.connect', target: 'attacker-evil-example.com', port: 443, surface: 'broker' }, ctx(PLUGIN));
			assert.strictEqual(decision.allow, false, `${pattern} must not open attacker-evil-example.com`);
		}
		const named: IManifestView[] = [{ subject: PLUGIN, declared: [{ id: 'net.connect', targets: ['*.example.com'] }], network: 'broker' }];
		assert.strictEqual(evaluate(snap({ manifests: named }), { capability: 'net.connect', target: 'api.example.com', port: 443, surface: 'broker' }, ctx(PLUGIN)).allow, true);
		assert.strictEqual(evaluate(snap({ manifests: named }), { capability: 'net.connect', target: 'evil-example.com', port: 443, surface: 'broker' }, ctx(PLUGIN)).allow, false);
		assert.strictEqual(evaluate(snap({ manifests: named }), { capability: 'net.connect', target: 'api.example.com', port: 80, surface: 'broker' }, ctx(PLUGIN)).allow, false, 'no port is 443; port 80 needs http://');
	});

	test('managed policy: a trailing dot, a wildcard request, a capability family, an exfil host\'s class, a typo', () => {
		const manifests: IManifestView[] = [{ subject: PLUGIN, declared: [{ id: 'net.connect', targets: ['evil.com', 'pastebin.com'] }, { id: 'net.listen:*' }], network: 'broker' }];
		// The user granted what needs consent, so the managed policy is the layer that answers.
		const grants = [grantOf('net.listen:3000'), grantOf('net.connect', ['pastebin.com'])];
		const admin = (policy: object) => snap({ manifests, grants, admin: parseAdminPolicy(policy) });
		for (const target of ['evil.com.', 'https://evil.com./x', 'EVIL.com']) {
			assert.deepStrictEqual(evaluate(admin({ denyHosts: ['evil.com'] }), { capability: 'net.connect', target }, ctx(PLUGIN)).code, 'admin-host', target);
		}
		const open = chat('open', { level: 'workspace-write', network: true });
		assert.strictEqual(evaluate(snap({ chats: [open], admin: { denyHosts: ['evil.com'] } }), { capability: 'net.connect', target: '*', surface: 'launch' }, ctx(open.subject)).code, 'admin-host', 'a launch that reaches every host reaches the denied one');
		assert.strictEqual(evaluate(admin({ denyCapabilities: ['net.listen'] }), { capability: 'net.listen:3000' }, ctx(PLUGIN)).code, 'admin-capability', 'a family covers its parameters');
		assert.strictEqual(evaluate(admin({ maxThirdPartyClass: 'low' }), { capability: 'net.connect', target: 'pastebin.com' }, ctx(PLUGIN)).code, 'admin-class', 'an exfil host is high for a third party');
		assert.deepStrictEqual(parseAdminPolicy({ denyCapabilities: ['net.conect'] }), { unreadable: true }, 'a misspelled deny fails closed');
		assert.deepStrictEqual(parseAdminPolicy({ denyCapabilities: ['net.listen', 'secrets.use:*'] }), { denyCapabilities: ['net.listen', 'secrets.use:*'] });
	});

	test('the credential floor sees every spelling of a credential folder', () => {
		const manifests: IManifestView[] = [{ subject: PLUGIN, declared: [{ id: 'files.read:picked' }], network: 'broker' }];
		for (const target of [`${HOME}/././.ssh/id_rsa`, `${HOME}/.SSH/id_rsa`, `${HOME}//.ssh/id_rsa`, `${HOME}/x/../.ssh/id_rsa`]) {
			assert.strictEqual(evaluate(snap({ manifests }), { capability: 'files.read:picked', target }, ctx(PLUGIN)).code, 'credential', target);
		}
	});

	test('"Allow folder" sees through `..` and case', () => {
		const context = { home: HOME, workspaceRoots: ['/Users/me/proj'] };
		for (const folder of ['/Users/me/proj/../Library/LaunchAgents', '/Users/me/LIBRARY/LaunchAgents', '/Users/me/proj/../..', '/Users/me/.SSH', '/Users/me/proj/.GIT/hooks', '/LIBRARY/Preferences']) {
			assert.ok(folderGrantError(folder, context), `${folder} is refused`);
		}
		assert.strictEqual(folderGrantError('/Users/me/proj/out', context), undefined);
		assert.strictEqual(folderGrantError('/Users/me/other-project', context), undefined);
	});
});
