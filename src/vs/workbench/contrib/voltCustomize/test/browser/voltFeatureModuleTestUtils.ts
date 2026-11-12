/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ReportModeCapabilityReporter } from '../../../../services/voltPlugins/common/capabilities.js';
import { createVoltApi, IVoltApiBackend, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../common/voltFeatures.js';
import { VoltFeatureModuleService } from '../../browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../browser/voltFeatureModuleTable.js';

/** The feature switch, as the Extensions view flips it. */
export class FakeVoltFeatures extends mock<IVoltFeatureService>() {
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

/**
 * Core's module loader with a feature's real table entry, over a context made from its real
 * manifest in report mode (`reporter.reports` lists what its code would be denied). `open` is what
 * the editor service says is open; `closed` what was closed.
 */
export function setupVoltFeatureModule(store: Pick<DisposableStore, 'add'>, feature: string) {
	const features = new FakeVoltFeatures();
	const reporter = new ReportModeCapabilityReporter(() => { });
	const subscriptions = new DisposableStore();
	store.add({ dispose: () => { subscriptions.dispose(); features.dispose(); reporter.dispose(); } });
	const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => candidate.contributes?.voltModule?.feature === feature)!;
	const extensionId = `${manifest.publisher}.${manifest.name}`;
	const context: IVoltPluginContext = {
		extensionId,
		featureId: feature,
		manifest,
		volt: createVoltApi({ extensionId, firstParty: true, capabilities: manifest.contributes?.voltCapabilities ?? {} }, manifest, new class extends mock<IVoltApiBackend>() { }, reporter, subscriptions),
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
	const entry = VOLT_FEATURE_MODULES.find(candidate => candidate.feature === feature)!;
	const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry]));
	return { service, features, reporter, instantiation, open, closed, entry };
}

/** How often the Command Palette lists `id`. */
export function paletteEntries(id: string): number {
	return MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && item.command.id === id).length;
}

/** The editor pane registered for `input` (disposed after). */
export function editorPaneFor(input: EditorInput) {
	const descriptor = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).getEditorPane(input);
	input.dispose();
	return descriptor;
}
