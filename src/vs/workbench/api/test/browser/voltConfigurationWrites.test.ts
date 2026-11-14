/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt B-09: which settings an extension host may write. EXT-CFG-1: no extension changes where
// extensions run (it could take itself out of its sandbox at the next reload). EXT-CFG-2: a host that
// runs a sandboxed extension writes only that extension's own settings (`git.path` pointed into its
// storage would make the unsandboxed Git extension run its file). EXT-CFG-3: other hosts as before.

import assert from 'assert';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier, IExtensionDescription, TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { voltConfigurationWriteRefusal } from '../../../services/extensions/common/voltExtensionSandbox.js';
import { MainThreadConfiguration } from '../../browser/mainThreadConfiguration.js';
import { IExtHostContext } from '../../../services/extensions/common/extHostCustomers.js';

function extension(id: string, properties: Record<string, object> = {}): IExtensionDescription {
	const [publisher, name] = id.split('.');
	return {
		identifier: new ExtensionIdentifier(id), name, publisher, version: '1.0.0', engines: { vscode: '*' }, main: './extension.js',
		extensionLocation: URI.file(`/ext/${id}`), isBuiltin: false, isUserBuiltin: false, isUnderDevelopment: false, targetPlatform: TargetPlatform.UNDEFINED, preRelease: false,
		contributes: { configuration: { properties } },
	} as unknown as IExtensionDescription;
}

suite('Volt: settings extension hosts may write (B-09)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const probe = extension('pub.probe', { 'probe.level': { type: 'number' }, 'probe.options': { type: 'object' } });

	test('EXT-CFG-1: no extension host writes where extensions run, whole section or part', () => {
		for (const key of [VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, 'volt.extensions', 'volt']) {
			assert.ok(voltConfigurationWriteRefusal(key, []), `unsandboxed host wrote ${key}`);
			assert.ok(voltConfigurationWriteRefusal(key, [probe]), `sandboxed host wrote ${key}`);
		}
	});

	test('EXT-CFG-2: a sandboxed extension writes only its own settings', () => {
		assert.strictEqual(voltConfigurationWriteRefusal('probe.level', [probe]), undefined);
		assert.strictEqual(voltConfigurationWriteRefusal('probe.options.depth', [probe]), undefined);
		for (const key of ['git.path', 'terminal.integrated.profiles.osx', 'python.defaultInterpreterPath', 'probe', 'probe.levelX', '[python]', 'editor.fontSize']) {
			assert.ok(voltConfigurationWriteRefusal(key, [probe]), `sandboxed host wrote ${key}`);
		}
	});

	test('EXT-CFG-3: a host with no sandboxed extension writes other settings as before', () => {
		for (const key of ['git.path', 'editor.fontSize', 'volt.agent.defaultModel', 'volt.extensionsX']) {
			assert.strictEqual(voltConfigurationWriteRefusal(key, []), undefined, key);
		}
	});

	test('EXT-CFG-2: the main thread refuses through the extension API and writes nothing', async () => {
		const config = new TestConfigurationService();
		config.setUserConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING, [probe.identifier.value]);
		let written = 0;
		config.updateValue = async () => { written++; };
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IConfigurationService, config);
		instantiation.stub(IEnvironmentService, { isBuilt: true, isExtensionDevelopment: false });
		instantiation.stub(IWorkspaceContextService, { getWorkbenchState: () => WorkbenchState.FOLDER });
		instantiation.stub(IExtensionService, new class extends mock<IExtensionService>() { override extensions = [probe]; });
		const context = {
			getProxy: () => ({ $initializeConfiguration() { }, $acceptConfigurationChanged() { } }),
			hostsExtension: (id: string | ExtensionIdentifier) => ExtensionIdentifier.equals(id, probe.identifier),
		} as unknown as IExtHostContext;
		const main = instantiation.createInstance(MainThreadConfiguration, context);
		try {
			await assert.rejects(main.$updateConfigurationOption(null, 'git.path', '/tmp/evil', undefined, undefined), /only its own settings/);
			await assert.rejects(main.$updateConfigurationOption(null, VOLT_UNSANDBOXED_EXTENSIONS_SETTING, [probe.identifier.value], undefined, undefined), /where extensions run/);
			await assert.rejects(main.$removeConfigurationOption(null, VOLT_SANDBOXED_EXTENSIONS_SETTING, undefined, undefined), /where extensions run/);
			assert.strictEqual(written, 0);
			await main.$updateConfigurationOption(null, 'probe.level', 2, undefined, undefined);
			assert.strictEqual(written, 1);
		} finally {
			main.dispose();
		}
	});
});
