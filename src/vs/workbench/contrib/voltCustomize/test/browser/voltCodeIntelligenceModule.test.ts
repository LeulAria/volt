/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltCodeIndexService } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IVoltApi, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { CODE_INTELLIGENCE_TOOLS } from '../../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostToolProvider, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IVoltFeatureModuleEntry } from '../../browser/voltFeatureModules.js';
import { VoltFeatureModuleService } from '../../browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../browser/voltFeatureModuleTable.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../common/voltFeatures.js';
import { CODE_INTELLIGENCE_FEATURE_ID, CODE_INTELLIGENCE_SECTION_ID } from '../../../voltCodeIntelligence/common/voltCodeIntelligence.js';

class FakeFeatures implements IVoltFeatureService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	readonly off = new Set<string>();
	isEnabled(featureId: string): boolean { return !this.off.has(featureId); }
	isOn(_part: VoltFeaturePart, _id: string): boolean { return true; }
	async setEnabled(featureId: string, enabled: boolean): Promise<void> {
		if (enabled) {
			this.off.delete(featureId);
		} else {
			this.off.add(featureId);
		}
		this._onDidChange.fire();
	}
	dispose(): void { this._onDidChange.dispose(); }
}

/** The extension's context; its `volt` API records every call (report mode: there must be none). */
class FakePlugins {
	readonly calls: string[] = [];
	private readonly contexts = new Map<string, IVoltPluginContext>();
	getContext(extensionId: string): IVoltPluginContext | undefined {
		let context = this.contexts.get(extensionId);
		if (!context) {
			const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => `${candidate.publisher}.${candidate.name}` === extensionId)!;
			const volt = new Proxy({}, { get: (_target, key) => { this.calls.push(String(key)); return undefined; } }) as IVoltApi;
			context = { extensionId, manifest, volt, subscriptions: new DisposableStore() };
			this.contexts.set(extensionId, context);
		}
		return context;
	}
	/** The extension went away (updated, reinstalled): its context is disposed. */
	remove(extensionId: string): void {
		this.contexts.get(extensionId)?.subscriptions.dispose();
		this.contexts.delete(extensionId);
	}
	dispose(): void {
		for (const context of this.contexts.values()) {
			context.subscriptions.dispose();
		}
	}
}

suite('Volt Code Intelligence module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const entry = () => VOLT_FEATURE_MODULES.find(candidate => candidate.feature === CODE_INTELLIGENCE_FEATURE_ID)!;

	// The module's files register what they register once per window when imported: import them first.
	suiteSetup(async () => {
		await entry().load();
	});

	function setup(moduleEntry: IVoltFeatureModuleEntry = entry()) {
		const features = new FakeFeatures();
		const plugins = new FakePlugins();
		const providers = new Set<IVoltHostToolProvider>();
		const warmed: string[] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, plugins as unknown as IVoltPluginService);
		instantiation.stub(IExtensionService, { whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
		instantiation.stub(IConfigurationService, new TestConfigurationService());
		instantiation.stub(IWorkspaceContextService, new TestContextService());
		instantiation.stub(ISearchService, new class extends mock<ISearchService>() { });
		instantiation.stub(IFileService, new class extends mock<IFileService>() { override readonly onDidFilesChange = Event.None; });
		instantiation.stub(IVoltCodeIndexService, new class extends mock<IVoltCodeIndexService>() {
			override async warm(root: string): Promise<void> { warmed.push(root); }
		});
		instantiation.stub(ILifecycleService, new class extends mock<ILifecycleService>() { override async when(): Promise<void> { } });
		instantiation.stub(IVoltHostToolService, new class extends mock<IVoltHostToolService>() {
			override registerToolProvider(provider: IVoltHostToolProvider) {
				providers.add(provider);
				return toDisposable(() => providers.delete(provider));
			}
		});
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [moduleEntry]));
		// After the service, as in the window: the extensions outlive the modules they carry.
		store.add({ dispose: () => { features.dispose(); plugins.dispose(); } });
		const tools = () => [...providers].flatMap(provider => provider.tools.map(tool => tool.name));
		return { service, features, plugins, tools, warmed };
	}

	test('CI-MOD-1: it waits for startup, then serves its tools without anyone opening its page', async () => {
		const { service, tools, plugins } = setup();
		assert.strictEqual(service.isActive(CODE_INTELLIGENCE_FEATURE_ID), false, 'not before the window has restored');
		assert.deepStrictEqual(tools(), []);
		service.startupFinished();
		await service.activate(CODE_INTELLIGENCE_FEATURE_ID);
		assert.ok(service.isActive(CODE_INTELLIGENCE_FEATURE_ID));
		assert.deepStrictEqual(tools(), CODE_INTELLIGENCE_TOOLS.map(tool => tool.name), 'instant_grep, find_symbol and find_files on the volt MCP server');
		assert.ok(await service.part('settingsKitPage', CODE_INTELLIGENCE_SECTION_ID), 'its Settings page');
		assert.strictEqual(service.partOwner('settingsKitPage', CODE_INTELLIGENCE_SECTION_ID), CODE_INTELLIGENCE_FEATURE_ID);
		assert.deepStrictEqual(plugins.calls, [], 'report mode: no volt API call, so no would-be denial');
	});

	test('CI-MOD-2: disabling volt.code-intelligence takes its tools and page away; enabling it brings them back without a reload', async () => {
		const { service, features, tools } = setup();
		service.startupFinished();
		await service.activate(CODE_INTELLIGENCE_FEATURE_ID);
		await features.setEnabled(CODE_INTELLIGENCE_FEATURE_ID, false);
		assert.strictEqual(service.isActive(CODE_INTELLIGENCE_FEATURE_ID), false);
		assert.deepStrictEqual(tools(), []);
		assert.strictEqual(await service.part('settingsKitPage', CODE_INTELLIGENCE_SECTION_ID), undefined);
		await features.setEnabled(CODE_INTELLIGENCE_FEATURE_ID, true);
		// A startup module loads again as soon as it is on.
		await service.activate(CODE_INTELLIGENCE_FEATURE_ID);
		assert.ok(service.isActive(CODE_INTELLIGENCE_FEATURE_ID));
		assert.strictEqual(tools().length, CODE_INTELLIGENCE_TOOLS.length, 'one provider, not two');
	});

	test('MOD-STARTUP-2: its extension\'s context going away while the feature stays on loads it again with a fresh one', async () => {
		const { service, plugins, tools } = setup();
		service.startupFinished();
		await service.activate(CODE_INTELLIGENCE_FEATURE_ID);
		plugins.remove('volt.code-intelligence');
		await service.activate(CODE_INTELLIGENCE_FEATURE_ID);
		assert.ok(service.isActive(CODE_INTELLIGENCE_FEATURE_ID));
		assert.strictEqual(tools().length, CODE_INTELLIGENCE_TOOLS.length, 'the old tools went with the old context');
	});

	test('MOD-STARTUP-1: a startup module that fails to load is not retried in a loop', async () => {
		let loads = 0;
		const { service } = setup({ feature: CODE_INTELLIGENCE_FEATURE_ID, activation: 'startup', load: async () => { loads++; throw new Error('broken'); } });
		service.startupFinished();
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.strictEqual(loads, 1);
		assert.strictEqual(service.isActive(CODE_INTELLIGENCE_FEATURE_ID), false);
	});
});
