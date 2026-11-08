/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { extensionListed, extensionSandboxPlan, IT3ExtensionFacts, t3ExtensionHostPolicy, t3ManifestView, t3Subject } from '../../common/extensionHostSandbox.js';
import { parseSandboxPolicy } from '../../common/sandboxSchema.js';

/** H.7 / H.8 / F.13 for the T3 extension host, as pure decisions. */
suite('Volt T3 extension host policy (H.7)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const facts = (overrides: Partial<IT3ExtensionFacts> = {}): IT3ExtensionFacts => ({ id: 'pub.ext', builtin: false, main: true, browser: false, extensionKind: ['workspace'], ...overrides });

	test('T3-PLAN-1: what can be sandboxed, what needs nothing, and what is refused with its reason', () => {
		assert.deepStrictEqual(extensionSandboxPlan(facts(), 'darwin'), { kind: 'sandbox' });
		assert.deepStrictEqual(extensionSandboxPlan(facts(), 'linux'), { kind: 'sandbox' });
		assert.strictEqual(extensionSandboxPlan(facts({ builtin: true }), 'darwin').kind, 'not-needed', 'built-ins are unaffected');
		assert.strictEqual(extensionSandboxPlan(facts({ main: false }), 'darwin').kind, 'not-needed', 'a theme has no code');
		const ui = extensionSandboxPlan(facts({ extensionKind: ['ui', 'workspace'] }), 'darwin');
		assert.ok(ui.kind === 'refuse' && ui.code === 'ui-full-access', 'extensionKind ui without a browser entry needs the critical grant');
		assert.strictEqual(extensionSandboxPlan(facts({ extensionKind: ['ui'], browser: true }), 'darwin').kind, 'sandbox', 'ui with a browser entry');
		const browserOnly = extensionSandboxPlan(facts({ main: false, browser: true }), 'darwin');
		assert.ok(browserOnly.kind === 'refuse' && browserOnly.code === 'browser-only');
		const windows = extensionSandboxPlan(facts(), 'win32');
		assert.ok(windows.kind === 'refuse' && windows.code === 'platform', 'never silently unsandboxed on an OS without a host sandbox');
	});

	test('T3-POL-1: reads its folder, toolchains and a trusted workspace; writes storage and tmp only; network through the broker with nothing allowed', () => {
		const input = { platform: 'darwin', home: '/Users/u', extensionDir: '/Users/u/.volt/extensions/pub.ext-1.0.0', appRoots: ['/Applications/Volt.app/Contents/Resources/app/out'], workspaceTrusted: true };
		const policy = t3ExtensionHostPolicy(input);
		assert.ok(parseSandboxPolicy(policy).ok, 'a valid policy');
		assert.ok(policy.filesystem.read.includes(input.extensionDir));
		assert.ok(policy.filesystem.read.includes('${workspace}'));
		assert.ok(policy.filesystem.read.includes('/Users/u/.cargo'));
		assert.ok(!policy.filesystem.read.includes('/Users/u'), 'not the home folder');
		assert.deepStrictEqual(policy.filesystem.write, ['${storage}', '${tmp}'], 'no raw workspace write');
		assert.ok(policy.filesystem.deny.some(entry => entry.includes('.ssh')), 'the credential floor');
		assert.deepStrictEqual(policy.network, { mode: 'proxy', allow: [], loopbackPorts: [], listen: false });
		assert.strictEqual(policy.process.limits?.memoryMB, 1024);
		assert.strictEqual(policy.process.limits?.processes, 64);
		assert.strictEqual(policy.process.limits?.cpuSeconds, undefined, 'a long-lived host has no CPU-seconds cap');
		assert.strictEqual(policy.process.limits?.wallClockSeconds, undefined, 'nor a wall clock');
		const untrusted = t3ExtensionHostPolicy({ ...input, workspaceTrusted: false });
		assert.ok(!untrusted.filesystem.read.includes('${workspace}'), 'an untrusted workspace is not readable');
	});

	test('T3-NET-1: the broker manifest names only declared hosts, never *', () => {
		assert.deepStrictEqual(t3ManifestView('Pub.Ext'), { subject: 'plugin:pub.ext@local', network: 'broker', declared: [] });
		assert.deepStrictEqual(t3ManifestView('pub.ext', ['api.x.test', '*']).declared, [{ id: 'net.connect', targets: ['api.x.test'] }]);
		assert.strictEqual(t3Subject('pub.ext'), 'plugin:pub.ext@local');
	});

	test('the opt-in list matches ids case-insensitively and ignores junk', () => {
		assert.ok(extensionListed(['Pub.Ext'], 'pub.ext'));
		assert.ok(!extensionListed(['pub.other', 3], 'pub.ext'));
		assert.ok(!extensionListed('pub.ext', 'pub.ext'));
	});
});
