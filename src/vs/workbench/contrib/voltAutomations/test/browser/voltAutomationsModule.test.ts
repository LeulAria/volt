/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorIdentifier } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ReportModeCapabilityReporter } from '../../../../services/voltPlugins/common/capabilities.js';
import { createVoltApi, IVoltApiBackend, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { VOLT_FEATURE_MANIFESTS } from '../../../voltCustomize/common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../../voltCustomize/common/voltFeatures.js';
import { createVoltFeatureModuleEditorSerializer, VoltFeatureModuleEditorPlaceholder, VoltFeatureModuleService } from '../../../voltCustomize/browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../../voltCustomize/browser/voltFeatureModuleTable.js';
import { AUTOMATIONS_EDITOR_INPUT_TYPE_ID, AUTOMATIONS_FEATURE_ID, NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_COMMAND_ID, OPEN_AUTOMATIONS_ROUTE_COMMAND_ID } from '../../common/voltAutomations.js';
import { AutomationsEditorInput } from '../../browser/automationsEditor.js';
// Evaluated with the test file, so what its imports register at load time isn't counted as a test's leak.
import '../../browser/voltAutomations.module.js';

class FakeFeatures extends mock<IVoltFeatureService>() {
	private readonly emitter = new Emitter<void>();
	override readonly onDidChange = this.emitter.event;
	readonly off = new Set<string>();
	override isEnabled(featureId: string): boolean { return !this.off.has(featureId); }
	override isOn(_part: VoltFeaturePart, _id: string): boolean { return true; }
	override async setEnabled(featureId: string, enabled: boolean): Promise<void> {
		if (enabled) {
			this.off.delete(featureId);
		} else {
			this.off.add(featureId);
		}
		this.emitter.fire();
	}
	dispose(): void { this.emitter.dispose(); }
}

const COMMANDS = [OPEN_AUTOMATIONS_COMMAND_ID, NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_ROUTE_COMMAND_ID, 'voltAgent.automations.openInTools', 'voltAgent.workflows.openInTools'];

suite('Volt Automations module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Core's loader with the real Automations entry, over a context made from the real manifest in report mode. */
	function setup() {
		const features = new FakeFeatures();
		const reporter = new ReportModeCapabilityReporter(() => { });
		const subscriptions = new DisposableStore();
		store.add({ dispose: () => { subscriptions.dispose(); features.dispose(); reporter.dispose(); } });
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => candidate.name === 'automations')!;
		const context: IVoltPluginContext = {
			extensionId: 'volt.automations',
			featureId: AUTOMATIONS_FEATURE_ID,
			manifest,
			volt: createVoltApi({ extensionId: 'volt.automations', firstParty: true, capabilities: manifest.contributes?.voltCapabilities ?? {} }, manifest, new class extends mock<IVoltApiBackend>() { }, reporter, subscriptions),
			subscriptions,
		};
		const open: IEditorIdentifier[] = [];
		const closed: IEditorIdentifier[] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, new class extends mock<IVoltPluginService>() {
			override getContext() { return context; }
		});
		instantiation.stub(IExtensionService, new class extends mock<IExtensionService>() {
			override async whenInstalledExtensionsRegistered() { return true; }
		});
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, new class extends mock<ICommandService>() { });
		instantiation.stub(ILifecycleService, new class extends mock<ILifecycleService>() { override readonly willShutdown = false; });
		instantiation.stub(IEditorService, new class extends mock<IEditorService>() {
			override getEditors() { return open; }
			override async closeEditors(editors: readonly IEditorIdentifier[]) { closed.push(...editors); }
		});
		const entry = VOLT_FEATURE_MODULES.find(candidate => candidate.feature === AUTOMATIONS_FEATURE_ID)!;
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry]));
		return { service, features, reporter, instantiation, open, closed };
	}

	const palette = (id: string) => MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && item.command.id === id).length;
	const pane = () => {
		const input = new AutomationsEditorInput();
		const descriptor = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).getEditorPane(input);
		input.dispose();
		return descriptor;
	};

	test('MOD-AUTOMATIONS-1: nothing loads at startup; its commands stand in, and the first use loads it', async () => {
		const { service } = setup();
		assert.strictEqual(service.isActive(AUTOMATIONS_FEATURE_ID), false);
		const stubs = COMMANDS.map(id => CommandsRegistry.getCommand(id));
		assert.ok(stubs.every(Boolean), 'a stub stands in for each of its commands');
		assert.strictEqual(palette(OPEN_AUTOMATIONS_COMMAND_ID), 1, 'Show Automations is in the Command Palette before it loads');
		assert.strictEqual(pane(), undefined, 'no editor pane until it loads');

		await service.activate(AUTOMATIONS_FEATURE_ID);
		assert.ok(service.isActive(AUTOMATIONS_FEATURE_ID));
		COMMANDS.forEach((id, i) => assert.notStrictEqual(CommandsRegistry.getCommand(id), stubs[i], `${id} is the module's own now`));
		assert.strictEqual(palette(OPEN_AUTOMATIONS_COMMAND_ID), 1, 'listed once (the module\'s action, not the stub)');
		assert.ok(pane(), 'its editor pane is registered');
	});

	test('MOD-AUTOMATIONS-TOGGLE: disabling the extension unloads the pages and closes their tabs; enabling it needs no reload', async () => {
		const { service, features, open, closed } = setup();
		await service.activate(AUTOMATIONS_FEATURE_ID);
		const tab = new AutomationsEditorInput();
		open.push({ groupId: 1, editor: tab });

		await features.setEnabled(AUTOMATIONS_FEATURE_ID, false);
		assert.strictEqual(service.isActive(AUTOMATIONS_FEATURE_ID), false);
		assert.deepStrictEqual(COMMANDS.filter(id => CommandsRegistry.getCommand(id)), [], 'its commands are gone, stubs included');
		assert.strictEqual(palette(OPEN_AUTOMATIONS_COMMAND_ID), 0);
		assert.strictEqual(pane(), undefined, 'its editor pane is gone');
		assert.deepStrictEqual(closed.map(identifier => identifier.editor), [tab], 'its open tab closed');

		await features.setEnabled(AUTOMATIONS_FEATURE_ID, true);
		assert.ok(COMMANDS.every(id => CommandsRegistry.getCommand(id)), 'stubs are back');
		assert.strictEqual(service.isActive(AUTOMATIONS_FEATURE_ID), false, 'loading waits for a use');
		await service.activate(AUTOMATIONS_FEATURE_ID);
		assert.ok(pane());
		tab.dispose();
	});

	test('MOD-AUTOMATIONS-RESTORE: a restored Automations tab waits as a placeholder and comes back on its page', async () => {
		const { service, instantiation } = setup();
		const serializer = createVoltFeatureModuleEditorSerializer(AUTOMATIONS_FEATURE_ID, AUTOMATIONS_EDITOR_INPUT_TYPE_ID);
		const placeholder = serializer.deserialize(instantiation, JSON.stringify({ runs: true }));
		assert.ok(placeholder instanceof VoltFeatureModuleEditorPlaceholder);
		await service.activate(AUTOMATIONS_FEATURE_ID);
		const real = placeholder.resolveModuleEditor(instantiation);
		assert.ok(real instanceof AutomationsEditorInput);
		assert.deepStrictEqual(real.route, { page: 'runs' });
		assert.strictEqual(serializer.serialize(real), JSON.stringify({ runs: true }));
		placeholder.dispose();
		real.dispose();
	});

	test('MOD-AUTOMATIONS-GRANTS: it runs with only its manifest\'s grants (report mode: no would-be denial)', async () => {
		const { service, reporter } = setup();
		await service.activate(AUTOMATIONS_FEATURE_ID);
		assert.deepStrictEqual(reporter.reports, []);
	});
});
