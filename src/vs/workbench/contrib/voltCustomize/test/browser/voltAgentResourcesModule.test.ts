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
import { VoltFeatureModuleService } from '../../browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../browser/voltFeatureModuleTable.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../common/voltFeatures.js';
import { AGENT_RESOURCES_EDITOR_ID, AGENT_RESOURCES_FEATURE_ID, AGENT_RESOURCES_INPUT_ID, OPEN_AGENT_RESOURCES_COMMAND_ID } from '../../../voltAgentResources/common/voltAgentResources.js';

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
	dispose(): void {
		for (const context of this.contexts.values()) {
			context.subscriptions.dispose();
		}
	}
}

suite('Volt Agent Resources module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const entry = () => VOLT_FEATURE_MODULES.find(candidate => candidate.feature === AGENT_RESOURCES_FEATURE_ID)!;

	// The module's files register icons and colors once per window when imported: import them first.
	suiteSetup(async () => {
		await entry().load();
	});

	function setup() {
		const features = new FakeFeatures();
		const plugins = new FakePlugins();
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, plugins as unknown as IVoltPluginService);
		instantiation.stub(IExtensionService, { whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry()]));
		store.add({ dispose: () => { features.dispose(); plugins.dispose(); } });
		return { service, features, plugins };
	}

	const commandIds = () => entry().commands!.map(command => command.id);
	const registered = () => commandIds().filter(id => CommandsRegistry.getCommand(id)).length;
	const palette = () => MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && commandIds().includes(item.command.id)).length;
	const pane = () => Registry.as<EditorPaneRegistry>(EditorExtensions.EditorPane).getEditorPanes().some(descriptor => descriptor.typeId === AGENT_RESOURCES_EDITOR_ID);

	test('AR-MOD-1: the manifest names the module folder; the table stubs its commands and keeps its tab', () => {
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => candidate.contributes?.voltModule?.feature === AGENT_RESOURCES_FEATURE_ID);
		assert.strictEqual(manifest?.contributes?.voltModule?.entry, 'voltAgentResources');
		for (const id of manifest?.contributes?.voltModule?.commands ?? []) {
			assert.ok(commandIds().includes(id), `${id} has a stub`);
		}
		assert.ok(commandIds().length > 1, 'the section shortcuts too');
		assert.deepStrictEqual(entry().editors, [AGENT_RESOURCES_INPUT_ID]);
	});

	test('AR-MOD-2: nothing loads until it is used; then its page and commands are there', async () => {
		const { service, plugins } = setup();
		assert.strictEqual(service.isActive(AGENT_RESOURCES_FEATURE_ID), false);
		assert.strictEqual(registered(), commandIds().length, 'stubs stand in for every command');
		assert.strictEqual(palette(), commandIds().length);
		assert.strictEqual(pane(), false);
		await service.activate(AGENT_RESOURCES_FEATURE_ID);
		assert.ok(service.isActive(AGENT_RESOURCES_FEATURE_ID));
		assert.strictEqual(registered(), commandIds().length);
		assert.strictEqual(palette(), commandIds().length, 'the real commands\' palette entries replaced the stubs\'');
		assert.ok(pane());
		assert.ok(CommandsRegistry.getCommand(OPEN_AGENT_RESOURCES_COMMAND_ID));
		assert.deepStrictEqual(plugins.calls, [], 'report mode: no volt API call, so no would-be denial');
	});

	test('AR-MOD-3: disabling volt.agent-resources takes its page and commands away; enabling it again works without a reload', async () => {
		const { service, features } = setup();
		await service.activate(AGENT_RESOURCES_FEATURE_ID);
		await features.setEnabled(AGENT_RESOURCES_FEATURE_ID, false);
		assert.strictEqual(service.isActive(AGENT_RESOURCES_FEATURE_ID), false);
		assert.strictEqual(registered(), 0, 'its commands are gone, stubs included');
		assert.strictEqual(palette(), 0);
		assert.strictEqual(pane(), false);
		await features.setEnabled(AGENT_RESOURCES_FEATURE_ID, true);
		assert.strictEqual(registered(), commandIds().length, 'the stubs are back');
		assert.strictEqual(service.isActive(AGENT_RESOURCES_FEATURE_ID), false);
		await service.activate(AGENT_RESOURCES_FEATURE_ID);
		assert.ok(pane());
	});
});
