/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions } from '../../../../common/editor.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltApi, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { IVoltPluginManifest } from '../../../../services/voltPlugins/common/voltContributions.js';
import { IVoltFeatureModule, IVoltFeatureModuleEntry } from '../../browser/voltFeatureModules.js';
import { VoltFeatureModuleService } from '../../browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../browser/voltFeatureModuleTable.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../common/voltFeatures.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { AGENT_USAGE_EDITOR_ID, AGENT_USAGE_INPUT_ID, OPEN_AGENT_USAGE_COMMAND_ID, USAGE_DOCK_SECTION_ID, USAGE_FEATURE_ID, USAGE_SECTION_ID, USAGE_SLOT_ITEM_ID } from '../../../voltUsage/common/voltUsage.js';

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

/**
 * The extension's context. Its `volt` API records every call: the Usage module reads through Volt's
 * own services, so in report mode it must make none (no would-be denial).
 */
class FakePlugins {
	readonly calls: string[] = [];
	private readonly contexts = new Map<string, IVoltPluginContext>();
	getContext(extensionId: string): IVoltPluginContext | undefined {
		let context = this.contexts.get(extensionId);
		if (!context) {
			const manifest: IVoltPluginManifest = VOLT_FEATURE_MANIFESTS.find(candidate => `${candidate.publisher}.${candidate.name}` === extensionId)!;
			const volt = new Proxy({}, { get: (_target, key) => { this.calls.push(String(key)); return undefined; } }) as IVoltApi;
			context = { extensionId, manifest, volt, subscriptions: new DisposableStore() };
			this.contexts.set(extensionId, context);
		}
		return context;
	}
	dispose(): void {
		for (const context of this.contexts.values()) {
			context.subscriptions.dispose();
		}
	}
}

suite('Volt Usage module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(entry: IVoltFeatureModuleEntry = VOLT_FEATURE_MODULES.find(candidate => candidate.feature === USAGE_FEATURE_ID)!) {
		const features = new FakeFeatures();
		const plugins = new FakePlugins();
		store.add({ dispose: () => { features.dispose(); plugins.dispose(); } });
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, plugins as unknown as IVoltPluginService);
		instantiation.stub(IExtensionService, { whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry]));
		return { service, features, plugins };
	}

	const palette = () => MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && item.command.id === OPEN_AGENT_USAGE_COMMAND_ID).length;
	const usagePane = () => Registry.as<EditorPaneRegistry>(EditorExtensions.EditorPane).getEditorPanes().some(pane => pane.typeId === AGENT_USAGE_EDITOR_ID);

	// The module's files register icons and colors when imported, once per window: import them
	// before the leak check starts, as the window does before anything runs.
	suiteSetup(async () => {
		await VOLT_FEATURE_MODULES.find(candidate => candidate.feature === USAGE_FEATURE_ID)!.load();
	});

	test('USAGE-MOD-1: the manifest names the module folder, and the table lists its command and tab', () => {
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => candidate.contributes?.voltModule?.feature === USAGE_FEATURE_ID);
		assert.strictEqual(manifest?.contributes?.voltModule?.entry, 'voltUsage');
		const entry = VOLT_FEATURE_MODULES.find(candidate => candidate.feature === USAGE_FEATURE_ID);
		assert.deepStrictEqual(entry?.commands?.map(command => command.id), manifest?.contributes?.voltModule?.commands);
		assert.deepStrictEqual(entry?.editors, [AGENT_USAGE_INPUT_ID]);
	});

	test('USAGE-MOD-2: nothing loads until a part is asked for; then its page, card, section, tab and command are there', async () => {
		const { service, plugins } = setup();
		assert.strictEqual(service.isActive(USAGE_FEATURE_ID), false);
		assert.strictEqual(service.partOwner('settingsPage', USAGE_SECTION_ID), USAGE_FEATURE_ID, 'core knows the owner without loading it');
		assert.ok(CommandsRegistry.getCommand(OPEN_AGENT_USAGE_COMMAND_ID), 'a stub stands in for its command');
		assert.strictEqual(palette(), 1);
		assert.strictEqual(usagePane(), false);

		assert.ok(await service.part('settingsPage', USAGE_SECTION_ID));
		assert.ok(service.isActive(USAGE_FEATURE_ID));
		assert.ok(await service.part('itemHover', USAGE_SLOT_ITEM_ID));
		assert.ok(await service.part('dockSection', USAGE_DOCK_SECTION_ID));
		assert.ok(CommandsRegistry.getCommand(OPEN_AGENT_USAGE_COMMAND_ID));
		assert.strictEqual(palette(), 1, 'the real command\'s palette entry replaced the stub\'s');
		assert.ok(usagePane(), 'the old Usage tab opens');
		assert.deepStrictEqual(plugins.calls, [], 'report mode: no volt API call, so no would-be denial');
	});

	test('USAGE-MOD-3: disabling volt.usage unloads it all; enabling it again works without a reload', async () => {
		const { service, features } = setup();
		await service.part('settingsPage', USAGE_SECTION_ID);
		await features.setEnabled(USAGE_FEATURE_ID, false);
		assert.strictEqual(service.isActive(USAGE_FEATURE_ID), false);
		assert.strictEqual(service.partOwner('settingsPage', USAGE_SECTION_ID), undefined);
		assert.strictEqual(await service.part('settingsPage', USAGE_SECTION_ID), undefined);
		assert.strictEqual(CommandsRegistry.getCommand(OPEN_AGENT_USAGE_COMMAND_ID), undefined, 'its command is gone, stub included');
		assert.strictEqual(palette(), 0);
		assert.strictEqual(usagePane(), false, 'its tab is gone');

		await features.setEnabled(USAGE_FEATURE_ID, true);
		assert.ok(CommandsRegistry.getCommand(OPEN_AGENT_USAGE_COMMAND_ID), 'the stub is back');
		assert.strictEqual(service.isActive(USAGE_FEATURE_ID), false, 'loading waits for a use');
		assert.ok(await service.part('dockSection', USAGE_DOCK_SECTION_ID));
		assert.ok(usagePane());
	});

	test('MOD-PART-1: a module draws only the parts its manifest contributes', async () => {
		const page = { create: () => { throw new Error('not drawn here'); } };
		const module: IVoltFeatureModule = { activate: host => host.registerPart('settingsPage', 'automations', page) };
		const { service } = setup({ feature: USAGE_FEATURE_ID, load: async () => module });
		assert.strictEqual(service.partOwner('settingsPage', 'automations'), undefined, 'another feature\'s page');
		await assert.rejects(service.activate(USAGE_FEATURE_ID), /doesn't contribute/);
		assert.strictEqual(service.isActive(USAGE_FEATURE_ID), false);
	});
});
