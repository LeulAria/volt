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
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltApi, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { IVoltPluginManifest } from '../../../../services/voltPlugins/common/voltContributions.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../common/voltFeatures.js';
import { IVoltFeatureModule, IVoltFeatureModuleEntry, IVoltFeatureModuleHost, IVoltFeatureModuleService } from '../../browser/voltFeatureModules.js';
import { createVoltFeatureModuleEditorSerializer, VoltFeatureModuleEditorPlaceholder, VoltFeatureModuleService } from '../../browser/voltFeatureModuleService.js';

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

/** One extension's context, as `VoltPluginService` keeps it: disposing it is the extension going away. */
class FakePlugins {
	contexts = new Map<string, IVoltPluginContext>();
	asked: string[] = [];
	getContext(extensionId: string): IVoltPluginContext | undefined {
		this.asked.push(extensionId);
		let context = this.contexts.get(extensionId);
		if (!context) {
			const manifest: IVoltPluginManifest = { publisher: 'volt', name: extensionId.slice('volt.'.length) };
			context = { extensionId, manifest, volt: {} as IVoltApi, subscriptions: new DisposableStore() };
			this.contexts.set(extensionId, context);
		}
		return context;
	}
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

class NoteInput extends EditorInput {
	static readonly TypeID = 'test.input.voltModuleNote';
	readonly resource = undefined;
	constructor(readonly note: string) { super(); }
	override get typeId(): string { return NoteInput.TypeID; }
}

suite('Volt feature modules', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** A module of the `automations` feature that registers one command and one editor serializer. */
	function setup() {
		const features = new FakeFeatures();
		const plugins = new FakePlugins();
		store.add({ dispose: () => { features.dispose(); plugins.dispose(); } });
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, plugins as unknown as IVoltPluginService);
		instantiation.stub(IExtensionService, { whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => instantiation.invokeFunction(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args)),
		} as unknown as ICommandService);
		const events = { loads: 0, activations: 0, ran: [] as unknown[], hosts: [] as IVoltFeatureModuleHost[] };
		const module: IVoltFeatureModule = {
			activate(host) {
				events.activations++;
				events.hosts.push(host);
				host.subscriptions.add(CommandsRegistry.registerCommand('test.voltModule.open', (_accessor, arg: unknown) => {
					events.ran.push(arg);
					return `opened ${String(arg)}`;
				}));
				host.registerEditorSerializer(NoteInput.TypeID, new class implements IEditorSerializer {
					canSerialize() { return true; }
					serialize(input: EditorInput) { return (input as NoteInput).note; }
					deserialize(_instantiation: IInstantiationService, raw: string) { return new NoteInput(raw); }
				});
			},
		};
		const entry: IVoltFeatureModuleEntry = {
			feature: 'automations',
			load: async () => { events.loads++; return module; },
			commands: [{ id: 'test.voltModule.open', title: { value: 'Open Notes', original: 'Open Notes' }, f1: true }],
			editors: [NoteInput.TypeID],
		};
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry]));
		instantiation.stub(IVoltFeatureModuleService, service);
		return { service, features, plugins, events, instantiation };
	}

	const palette = () => MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && item.command.id === 'test.voltModule.open').length;

	test('MOD-LAZY-1: nothing loads at startup; a stub runs the command by loading the module', async () => {
		const { service, events, instantiation } = setup();
		assert.strictEqual(events.loads, 0, 'constructing the service loads no module');
		assert.ok(CommandsRegistry.getCommand('test.voltModule.open'), 'a stub stands in for the command');
		assert.strictEqual(palette(), 1, 'and the Command Palette lists it');
		const result = await instantiation.invokeFunction(accessor => accessor.get(ICommandService).executeCommand('test.voltModule.open', 'first'));
		assert.strictEqual(result, 'opened first');
		assert.deepStrictEqual(events.ran, ['first']);
		assert.strictEqual(events.loads, 1);
		assert.ok(service.isActive('automations'));
		assert.strictEqual(palette(), 0, 'the stub\'s palette entry went with it');
		assert.strictEqual(await service.activate('automations'), await service.activate('automations'), 'activates once');
		assert.strictEqual(events.activations, 1);
	});

	test('MOD-TOGGLE-1: disabling the extension unloads the module; enabling it again works without a reload', async () => {
		const { service, features, events } = setup();
		await service.activate('automations');
		assert.ok(CommandsRegistry.getCommand('test.voltModule.open'));
		await features.setEnabled('automations', false);
		assert.strictEqual(service.isActive('automations'), false);
		assert.strictEqual(CommandsRegistry.getCommand('test.voltModule.open'), undefined, 'its command is gone, stub included');
		assert.strictEqual(events.hosts[0].subscriptions.isDisposed, true);
		assert.strictEqual(await service.activate('automations'), undefined, 'an off feature does not load');
		await features.setEnabled('automations', true);
		assert.ok(CommandsRegistry.getCommand('test.voltModule.open'), 'the stub is back');
		assert.strictEqual(service.isActive('automations'), false, 'and loading waits for a use');
		await service.activate('automations');
		assert.strictEqual(events.activations, 2);
		assert.ok(service.isActive('automations'));
	});

	test('MOD-TOGGLE-2: the extension going away (its context disposed) unloads the module', async () => {
		const { service, plugins } = setup();
		await service.activate('automations');
		plugins.remove('volt.automations');
		assert.strictEqual(service.isActive('automations'), false);
		assert.ok(CommandsRegistry.getCommand('test.voltModule.open'), 'still on: the stub stands in again');
	});

	test('MOD-EDITOR-1: a tab restored before the module loads is kept as a placeholder and saved unchanged', async () => {
		const { service, instantiation } = setup();
		const serializer = createVoltFeatureModuleEditorSerializer('automations', NoteInput.TypeID);
		const placeholder = serializer.deserialize(instantiation, 'monday');
		assert.ok(placeholder instanceof VoltFeatureModuleEditorPlaceholder);
		assert.strictEqual(placeholder.typeId, NoteInput.TypeID, 'saved under the module\'s own type');
		assert.strictEqual(serializer.serialize(placeholder), 'monday');
		assert.strictEqual(placeholder.resolveModuleEditor(instantiation), undefined, 'nothing to swap in before the module loads');
		await service.activate('automations');
		const real = placeholder.resolveModuleEditor(instantiation);
		assert.ok(real instanceof NoteInput);
		assert.strictEqual(real.note, 'monday');
		const direct = serializer.deserialize(instantiation, 'tuesday');
		assert.ok(direct instanceof NoteInput, 'once loaded, the module deserializes its tabs itself');
		assert.strictEqual(serializer.serialize(direct), 'tuesday');
		placeholder.dispose();
		real.dispose();
		direct.dispose();
	});

	test('MOD-EDITOR-2: with the feature off, a restored tab of its editor is dropped', () => {
		const { features, instantiation } = setup();
		features.off.add('automations');
		const serializer = createVoltFeatureModuleEditorSerializer('automations', NoteInput.TypeID);
		assert.strictEqual(serializer.deserialize(instantiation, 'monday'), undefined);
	});
});
