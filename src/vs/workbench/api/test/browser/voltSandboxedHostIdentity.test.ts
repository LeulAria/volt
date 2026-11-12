/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P2/P6 (spec H.1, H.6, B-08; N.1 #22): where extensions run when one is opted into the sandbox.
// T3-ROUTE-1..4: an opted-in extension gets a host of its own and nothing else joins it; extensions
// not opted in run where they ran before (parity). XEXT-SECRET-1: with those hosts, one host can't
// read another's SecretStorage or call the main thread as another extension.

import assert from 'assert';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionKind } from '../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier, IExtensionDescription, TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../platform/secrets/test/common/testSecretStorageService.js';
import { T3_REQUIRED_PLATFORMS, VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { voltPlatform } from '../../../services/extensions/common/voltExtensionSandbox.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ExtensionNotInHostError } from '../../../services/extensions/common/extHostCustomers.js';
import { ExtensionHostKind, IExtensionHostKindPicker } from '../../../services/extensions/common/extensionHostKind.js';
import { IExtensionManifestPropertiesService } from '../../../services/extensions/common/extensionManifestPropertiesService.js';
import { ExtensionRunningLocation, isVoltSandboxedRunningLocation, LocalProcessRunningLocation, RemoteRunningLocation } from '../../../services/extensions/common/extensionRunningLocation.js';
import { ExtensionRunningLocationTracker } from '../../../services/extensions/common/extensionRunningLocationTracker.js';
import { ExtensionHostExtensions } from '../../../services/extensions/common/extensions.js';
import { MainThreadSecretState } from '../../browser/mainThreadSecretState.js';
import { ExtHostContext, ExtHostSecretStateShape } from '../../common/extHost.protocol.js';
import { TestRPCProtocol } from '../common/testRPCProtocol.js';

function extension(id: string, overrides: Partial<IExtensionDescription> = {}): IExtensionDescription {
	const [publisher, name] = id.split('.');
	return {
		identifier: new ExtensionIdentifier(id), name, publisher, version: '1.0.0', engines: { vscode: '*' }, main: './extension.js',
		extensionLocation: URI.file(`/ext/${id}`), isBuiltin: false, isUserBuiltin: false, isUnderDevelopment: false, targetPlatform: TargetPlatform.UNDEFINED, preRelease: false,
		...overrides,
	} as IExtensionDescription;
}

suite('Volt: sandboxed extension hosts in the window (P2, P6)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const lint = extension('pub.lint');
	const other = extension('pub.other');
	const formatter = extension('pub.formatter');
	const git = extension('vscode.git', { isBuiltin: true });
	const theme = extension('pub.theme', { main: undefined });
	const all = [lint, other, formatter, git, theme];

	function tracker(settings: { sandboxed?: string[]; unsandboxed?: string[]; mode?: string; killSwitch?: boolean }, kind: ExtensionHostKind = ExtensionHostKind.LocalProcess, affinity: Record<string, number> = {}): ExtensionRunningLocationTracker {
		const config = new TestConfigurationService();
		config.setUserConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING, settings.sandboxed ?? []);
		config.setUserConfiguration(VOLT_UNSANDBOXED_EXTENSIONS_SETTING, settings.unsandboxed ?? []);
		config.setUserConfiguration(VOLT_EXTENSION_SANDBOX_MODE_SETTING, settings.mode);
		config.setUserConfiguration(VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, settings.killSwitch);
		config.setUserConfiguration('extensions.experimental.affinity', affinity);
		const picker: IExtensionHostKindPicker = { pickExtensionHostKind: () => kind };
		const registry = { getAllExtensionDescriptions: () => all } as never;
		return new ExtensionRunningLocationTracker(
			registry,
			picker,
			new class extends mock<IWorkbenchEnvironmentService>() { override isExtensionDevelopment = false; },
			config,
			new NullLogService(),
			new class extends mock<IExtensionManifestPropertiesService>() { override getExtensionKind(): ExtensionKind[] { return ['workspace']; } },
		);
	}

	function place(t: ExtensionRunningLocationTracker, kind: ExtensionHostKind = ExtensionHostKind.LocalProcess): void {
		if (kind === ExtensionHostKind.Remote) {
			t.initializeRunningLocation([], all.map(e => ({ ...e, extensionLocation: e.extensionLocation.with({ scheme: 'vscode-remote', authority: 'server' }) })));
		} else {
			t.initializeRunningLocation(all, []);
		}
	}

	/** The extensions a host at `location` would hold, as its init data says (and so its B-08 set). */
	function hostSet(t: ExtensionRunningLocationTracker, location: ExtensionRunningLocation): ExtensionHostExtensions {
		const mine = t.filterByRunningLocation(all, location);
		return new ExtensionHostExtensions(1, all, mine.map(e => e.identifier));
	}

	test('T3-ROUTE-1: nothing opted in: every extension where it ran before, no sandboxed host (parity)', () => {
		const t = tracker({});
		place(t);
		assert.deepStrictEqual(t.sandboxedRunningLocations, []);
		assert.strictEqual(t.maxLocalProcessAffinity, 0);
		for (const e of all.filter(e => e.main)) {
			assert.ok(t.getRunningLocation(e.identifier)?.equals(new LocalProcessRunningLocation(0)), e.identifier.value);
		}
		// Today's affinity setting still works as before.
		const withAffinity = tracker({}, ExtensionHostKind.LocalProcess, { 'pub.other': 1 });
		place(withAffinity);
		assert.ok(withAffinity.getRunningLocation(other.identifier)?.equals(new LocalProcessRunningLocation(1)));
		assert.strictEqual(withAffinity.maxLocalProcessAffinity, 1);
	});

	test('T3-ROUTE-2: an opted-in extension gets a host of its own; nothing else joins it; the shared host count is unchanged', () => {
		const t = tracker({ sandboxed: ['Pub.Lint'] });
		place(t);
		const location = t.getRunningLocation(lint.identifier);
		assert.ok(isVoltSandboxedRunningLocation(location), `sandboxed: ${location?.asString()}`);
		assert.deepStrictEqual(t.sandboxedRunningLocations.map(l => l.asString()), [location!.asString()]);
		assert.strictEqual(t.maxLocalProcessAffinity, 0, 'no extra shared hosts');
		assert.deepStrictEqual(t.filterByRunningLocation(all, location!).map(e => e.identifier.value), ['pub.lint'], 'alone (H.6)');
		assert.deepStrictEqual(t.filterByRunningLocation(all, new LocalProcessRunningLocation(0)).map(e => e.identifier.value), ['pub.other', 'pub.formatter', 'vscode.git', 'pub.theme'], 'the shared host no longer holds it');
	});

	test('T3-ROUTE-3: built-ins and code-less extensions are never moved; "Run Without Sandbox" moves it back', () => {
		const t = tracker({ sandboxed: ['vscode.git', 'pub.theme', 'pub.other'], unsandboxed: ['pub.other'] });
		place(t);
		assert.deepStrictEqual(t.sandboxedRunningLocations, []);
		assert.ok(t.getRunningLocation(git.identifier)?.equals(new LocalProcessRunningLocation(0)), 'built-in Volt and VS Code extensions are unaffected');
		assert.ok(t.getRunningLocation(other.identifier)?.equals(new LocalProcessRunningLocation(0)), 'the user chose to run it without the sandbox');
	});

	test('T3-ROUTE-4: in a browser workbench (remote) each opted-in extension is its own remote host on the server', () => {
		const t = tracker({ sandboxed: ['pub.lint', 'pub.formatter'] }, ExtensionHostKind.Remote);
		place(t, ExtensionHostKind.Remote);
		const lintAt = t.getRunningLocation(lint.identifier)!;
		const formatterAt = t.getRunningLocation(formatter.identifier)!;
		assert.strictEqual(lintAt.kind, ExtensionHostKind.Remote);
		assert.ok(isVoltSandboxedRunningLocation(lintAt) && isVoltSandboxedRunningLocation(formatterAt));
		assert.ok(!lintAt.equals(formatterAt), 'one host each');
		assert.ok(t.getRunningLocation(other.identifier)?.equals(new RemoteRunningLocation()), 'the shared remote host');
		assert.ok(!new RemoteRunningLocation().equals(lintAt));
	});

	test('P8-ROUTE-1: under required (where the flip applies) every third-party extension with code runs alone; built-ins and themes stay; the default is opt-in', () => {
		const defaults = tracker({});
		place(defaults);
		assert.deepStrictEqual(defaults.sandboxedRunningLocations, [], 'opt-in by default: nothing moves');
		const t = tracker({ mode: 'required', unsandboxed: ['pub.formatter'] });
		place(t);
		if (!T3_REQUIRED_PLATFORMS.has(voltPlatform())) {
			assert.deepStrictEqual(t.sandboxedRunningLocations, [], 'Windows reads required as opt-in');
			return;
		}
		assert.ok(isVoltSandboxedRunningLocation(t.getRunningLocation(lint.identifier)));
		assert.ok(isVoltSandboxedRunningLocation(t.getRunningLocation(other.identifier)));
		assert.ok(!t.getRunningLocation(lint.identifier)!.equals(t.getRunningLocation(other.identifier)!), 'one host each');
		assert.strictEqual(t.sandboxedRunningLocations.length, 2);
		assert.ok(t.getRunningLocation(formatter.identifier)?.equals(new LocalProcessRunningLocation(0)), 'Run Without Sandbox');
		assert.ok(t.getRunningLocation(git.identifier)?.equals(new LocalProcessRunningLocation(0)), 'built-in');
	});

	test('T3-GIT-1: in a browser workbench (/code/) the built-in Git extension stays in the shared remote host, whatever is sandboxed, so its sync, askpass and SCM run as before', () => {
		for (const settings of [{ sandboxed: ['pub.lint', 'pub.other'] }, { mode: 'required' }, { mode: 'required', killSwitch: true }]) {
			const t = tracker(settings, ExtensionHostKind.Remote);
			place(t, ExtensionHostKind.Remote);
			const shared = new RemoteRunningLocation();
			assert.ok(t.getRunningLocation(git.identifier)?.equals(shared), `${JSON.stringify(settings)}: git on the shared remote host`);
			// The shared host's init data (what it activates, and its B-08 id set) still holds Git.
			assert.ok(hostSet(t, shared).containsExtension(git.identifier), 'in the shared host\'s set');
			for (const location of t.sandboxedRunningLocations) {
				assert.ok(!hostSet(t, location).containsExtension(git.identifier), 'never in a sandboxed host');
			}
		}
	});

	test('P8-KILL-4: with the kill switch on an in-scope extension keeps its own (held) location, never the shared host', () => {
		const t = tracker({ sandboxed: ['pub.lint'], killSwitch: true });
		place(t);
		const location = t.getRunningLocation(lint.identifier);
		assert.ok(isVoltSandboxedRunningLocation(location), 'held where the factory refuses it with kill-switch');
		assert.deepStrictEqual(t.filterByRunningLocation(all, new LocalProcessRunningLocation(0)).map(e => e.identifier.value), ['pub.other', 'pub.formatter', 'vscode.git', 'pub.theme']);
	});

	test('XEXT-SECRET-1: a sandboxed host can\'t read another extension\'s secrets or act as it, and the shared host can\'t act as the sandboxed one', async () => {
		const t = tracker({ sandboxed: ['pub.lint', 'pub.formatter'] });
		place(t);
		const secrets = new TestSecretStorageService();
		await secrets.set(JSON.stringify({ extensionId: 'pub.other', key: 'token' }), 'other-secret');
		await secrets.set(JSON.stringify({ extensionId: 'pub.formatter', key: 'token' }), 'formatter-secret');
		const mainThreadFor = (location: ExtensionRunningLocation) => {
			const set = hostSet(t, location);
			const rpc = new TestRPCProtocol();
			// What ExtensionHostManager gives its customers: the host's own extension set.
			rpc.hostsExtension = id => set.containsExtension(new ExtensionIdentifier(typeof id === 'string' ? id : id.value));
			rpc.set(ExtHostContext.ExtHostSecretState, new class extends mock<ExtHostSecretStateShape>() { override async $onDidChangePassword() { } });
			return store.add(new MainThreadSecretState(rpc, secrets, new NullLogService(), undefined! as IBrowserWorkbenchEnvironmentService));
		};
		const lintHost = mainThreadFor(t.getRunningLocation(lint.identifier)!);
		const sharedHost = mainThreadFor(new LocalProcessRunningLocation(0));
		const notInHost = (id: string) => (err: unknown) => err instanceof ExtensionNotInHostError && err.extensionId === id;
		// The sandboxed host: only its own id.
		await assert.rejects(lintHost.$getPassword('pub.other', 'token'), notInHost('pub.other'), 'a shared-host extension\'s secret');
		await assert.rejects(lintHost.$getPassword('pub.formatter', 'token'), notInHost('pub.formatter'), 'another sandboxed extension\'s secret');
		await assert.rejects(lintHost.$setPassword('pub.formatter', 'token', 'x'), notInHost('pub.formatter'));
		await assert.rejects(lintHost.$getKeys('vscode.git'), notInHost('vscode.git'), 'not even a built-in');
		await lintHost.$setPassword('pub.lint', 'token', 'lint-secret');
		assert.strictEqual(await lintHost.$getPassword('pub.lint', 'token'), 'lint-secret', 'its own work');
		// The shared host can no longer act as the sandboxed extension.
		await assert.rejects(sharedHost.$getPassword('pub.lint', 'token'), notInHost('pub.lint'));
		await assert.rejects(sharedHost.$getPassword('pub.formatter', 'token'), notInHost('pub.formatter'));
		assert.strictEqual(await sharedHost.$getPassword('pub.other', 'token'), 'other-secret', 'shared-host extensions as before');
		assert.strictEqual(await secrets.get(JSON.stringify({ extensionId: 'pub.formatter', key: 'token' })), 'formatter-secret', 'untouched');
	});
});
