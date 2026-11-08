/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { effectiveExtensionSandboxMode, extensionListed, extensionSandboxPlan, extensionSandboxTier, IT3ExportsFacts, IT3ExtensionFacts, T3_REQUIRED_PLATFORMS, t3BrokenExports, t3ExtensionHostPolicy, t3ManifestView, t3Subject } from '../../common/extensionHostSandbox.js';
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

	test('P8-TIER-1: opt-in is the default; required covers third-party code on macOS and Linux only; built-ins, code-less and "Run Without Sandbox" stay shared', () => {
		const settings = (overrides: Partial<{ mode: unknown; killSwitch: unknown; sandboxed: unknown; unsandboxed: unknown }> = {}) => ({ mode: undefined, killSwitch: undefined, sandboxed: [], unsandboxed: [], ...overrides });
		const ext = facts();
		// Default (no mode set): only the opt-in list.
		assert.strictEqual(extensionSandboxTier(settings(), ext, 'darwin'), 'shared', 'not opted in: as before');
		assert.strictEqual(extensionSandboxTier(settings({ sandboxed: ['pub.ext'] }), ext, 'darwin'), 'sandbox');
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'optIn' }), ext, 'linux'), 'shared');
		// The per-OS flip.
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'required' }), ext, 'darwin'), 'sandbox');
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'required' }), ext, 'linux'), 'sandbox');
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'required' }), ext, 'win32'), 'shared', 'Windows waits for C7');
		assert.strictEqual(effectiveExtensionSandboxMode('required', 'win32'), 'optIn');
		assert.strictEqual(effectiveExtensionSandboxMode('bogus', 'darwin'), 'optIn');
		assert.ok(!T3_REQUIRED_PLATFORMS.has('win32'));
		// Never moved, in any mode.
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'required' }), facts({ builtin: true }), 'darwin'), 'shared', 'built-in');
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'required' }), facts({ main: false }), 'darwin'), 'shared', 'a theme');
		assert.strictEqual(extensionSandboxTier(settings({ mode: 'required', unsandboxed: ['PUB.EXT'] }), ext, 'darwin'), 'shared', 'the user chose Run Without Sandbox');
	});

	test('P8-KILL-2: the kill switch moves the tier to ask, never to off; nothing out of scope changes', () => {
		const on = { mode: 'required', killSwitch: true, sandboxed: [], unsandboxed: [] };
		assert.strictEqual(extensionSandboxTier(on, facts(), 'darwin'), 'ask', 'held, not unsandboxed');
		assert.strictEqual(extensionSandboxTier({ ...on, mode: 'optIn', sandboxed: ['pub.ext'] }, facts(), 'linux'), 'ask');
		assert.strictEqual(extensionSandboxTier({ ...on, mode: 'optIn' }, facts(), 'darwin'), 'shared', 'not in scope: as before');
		assert.strictEqual(extensionSandboxTier({ ...on, unsandboxed: ['pub.ext'] }, facts(), 'darwin'), 'shared', 'the user already answered');
		assert.strictEqual(extensionSandboxTier({ ...on, killSwitch: 'true' }, facts(), 'darwin'), 'sandbox', 'only a real true switches it');
	});

	test('T3-EXPORTS-1: the exports edges a sandboxed host breaks, both ways, first party marked; code-less and unrelated edges ignored', () => {
		const all: IT3ExportsFacts[] = [
			{ id: 'pub.lens', builtin: false, code: true, extensionDependencies: ['vscode.git', 'pub.core'] },
			{ id: 'pub.core', builtin: false, code: true },
			{ id: 'pub.addon', builtin: false, code: true, extensionDependencies: ['Pub.Lens'] },
			{ id: 'pub.pack', builtin: false, code: true, extensionDependencies: ['pub.theme'] },
			{ id: 'pub.theme', builtin: false, code: false },
			{ id: 'vscode.git', builtin: true, code: true },
			{ id: 'pub.other', builtin: false, code: true, extensionDependencies: ['pub.core'] },
		];
		assert.deepStrictEqual(t3BrokenExports(['pub.lens'], all), [
			{ from: 'pub.lens', to: 'vscode.git', firstParty: true },
			{ from: 'pub.lens', to: 'pub.core', firstParty: false },
			{ from: 'pub.addon', to: 'pub.lens', firstParty: false },
		]);
		assert.deepStrictEqual(t3BrokenExports(['pub.pack'], all), [], 'a code-less dependency has no exports to lose');
		assert.deepStrictEqual(t3BrokenExports([], all), [], 'nothing sandboxed: nothing breaks');
	});

	test('the opt-in list matches ids case-insensitively and ignores junk', () => {
		assert.ok(extensionListed(['Pub.Ext'], 'pub.ext'));
		assert.ok(!extensionListed(['pub.other', 3], 'pub.ext'));
		assert.ok(!extensionListed('pub.ext', 'pub.ext'));
	});
});
