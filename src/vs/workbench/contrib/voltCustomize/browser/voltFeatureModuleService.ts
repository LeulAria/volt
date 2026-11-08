/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVoltPluginContext, IVoltPluginService } from '../../../services/voltPlugins/common/voltApi.js';
import { IVoltFeatureService, voltFeature } from '../common/voltFeatures.js';
import { VOLT_FEATURE_MANIFESTS } from '../common/voltFeatureManifests.generated.js';
import { IVoltFeatureModule, IVoltFeatureModuleEntry, IVoltFeatureModuleHost, IVoltFeatureModuleService } from './voltFeatureModules.js';

/** The serializers loaded modules gave for their editors, by editor type id. */
const moduleSerializers = new Map<string, IEditorSerializer>();

interface IActiveModule {
	readonly module: IVoltFeatureModule;
	readonly store: DisposableStore;
}

/**
 * Loads a feature's module the first time something uses it (one of its commands, a restored tab,
 * a page core hosts) and unloads it when the feature's built-in extension is disabled or goes away.
 * While the feature is on and its module isn't loaded, a stub stands in for each of its commands.
 */
export class VoltFeatureModuleService extends Disposable implements IVoltFeatureModuleService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly entries = new Map<string, IVoltFeatureModuleEntry>();
	private readonly active = new Map<string, IActiveModule>();
	private readonly loading = new Map<string, Promise<IVoltFeatureModule | undefined>>();
	private readonly stubs = this._register(new DisposableMap<string>());

	constructor(
		entries: readonly IVoltFeatureModuleEntry[],
		@IVoltFeatureService private readonly features: IVoltFeatureService,
		@IVoltPluginService private readonly plugins: IVoltPluginService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		for (const entry of entries) {
			this.entries.set(entry.feature, entry);
		}
		this.update();
		this._register(features.onDidChange(() => this.update()));
		this._register(toDisposable(() => {
			for (const feature of [...this.active.keys()]) {
				this.deactivate(feature);
			}
		}));
	}

	isActive(feature: string): boolean {
		return this.active.has(feature);
	}

	async activate<T extends IVoltFeatureModule = IVoltFeatureModule>(feature: string): Promise<T | undefined> {
		const entry = this.entries.get(feature);
		if (!entry || !this.features.isEnabled(feature)) {
			return undefined;
		}
		const active = this.active.get(feature);
		if (active) {
			return active.module as T;
		}
		let loading = this.loading.get(feature);
		if (!loading) {
			loading = this.load(entry).finally(() => this.loading.delete(feature));
			this.loading.set(feature, loading);
		}
		return await loading as T | undefined;
	}

	private async load(entry: IVoltFeatureModuleEntry): Promise<IVoltFeatureModule | undefined> {
		const context = await this.contextFor(entry.feature);
		const module = await entry.load();
		// Turned off while it loaded, or loaded twice by a race: keep the first.
		if (!context || !this.features.isEnabled(entry.feature)) {
			return undefined;
		}
		const existing = this.active.get(entry.feature);
		if (existing) {
			return existing.module;
		}
		const store = new DisposableStore();
		const serializers: string[] = [];
		const host: IVoltFeatureModuleHost = {
			plugin: context,
			instantiationService: this.instantiationService,
			subscriptions: store,
			registerEditorSerializer: (typeId, serializer) => {
				if (!entry.editors?.includes(typeId)) {
					throw new Error(`${entry.feature} serializes ${typeId}, which its module table entry doesn't list`);
				}
				moduleSerializers.set(typeId, serializer);
				serializers.push(typeId);
			},
		};
		store.add(toDisposable(() => {
			for (const typeId of serializers) {
				moduleSerializers.delete(typeId);
			}
		}));
		this.active.set(entry.feature, { module, store });
		this.stubs.deleteAndDispose(entry.feature);
		// The extension going away (uninstalled, its manifest changed) disposes its context, and the module with it.
		context.subscriptions.add(toDisposable(() => this.deactivate(entry.feature)));
		try {
			await module.activate(host);
		} catch (error) {
			this.logService.error(`[volt modules] ${entry.feature} failed to activate`, error);
			this.deactivate(entry.feature);
			throw error;
		}
		this._onDidChange.fire(entry.feature);
		return module;
	}

	/** The built-in extension's context; its compiled manifest stands in for a build that doesn't ship the extension. */
	private async contextFor(feature: string): Promise<IVoltPluginContext | undefined> {
		const extensionId = voltFeature(feature)?.extensionId;
		if (!extensionId) {
			return undefined;
		}
		await this.extensionService.whenInstalledExtensionsRegistered();
		const context = this.plugins.getContext(extensionId);
		if (context) {
			return context;
		}
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => `${candidate.publisher}.${candidate.name}` === extensionId);
		return manifest ? this.plugins.getBuiltinContext?.(manifest) : undefined;
	}

	private deactivate(feature: string): void {
		const active = this.active.get(feature);
		if (!active) {
			return;
		}
		this.active.delete(feature);
		active.store.dispose();
		this._onDidChange.fire(feature);
		this.update();
	}

	/** Unloads what was turned off; puts stubs in for the commands of what is on and not loaded. */
	private update(): void {
		for (const entry of this.entries.values()) {
			const on = this.features.isEnabled(entry.feature);
			if (!on) {
				this.stubs.deleteAndDispose(entry.feature);
				this.deactivate(entry.feature);
			} else if (!this.active.has(entry.feature) && !this.stubs.has(entry.feature) && entry.commands?.length) {
				this.stubs.set(entry.feature, this.registerStubs(entry));
			}
		}
	}

	private registerStubs(entry: IVoltFeatureModuleEntry): IDisposable {
		const store = new DisposableStore();
		for (const command of entry.commands ?? []) {
			const handler = async (_accessor: unknown, ...args: unknown[]) => {
				const module = await this.activate(entry.feature);
				if (!module) {
					return undefined;
				}
				// The module registered the real command over this stub.
				return this.commandService.executeCommand(command.id, ...args);
			};
			// Who may run the stub is who may run the command.
			store.add(command.registerStub
				? command.registerStub(handler)
				: command.visibility === 'public'
					? CommandsRegistry.registerCommand({ id: command.id, visibility: 'public', handler })
					: CommandsRegistry.registerCommand({ id: command.id, visibility: 'internal', handler }));
			if (!command.title) {
				continue;
			}
			const shown = {
				id: command.id,
				title: command.title,
				...(command.category ? { category: command.category } : {}),
				...(command.icon ? { icon: command.icon } : {}),
				...(command.precondition ? { precondition: command.precondition } : {}),
			};
			if (command.f1) {
				store.add(MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: shown }));
			}
			for (const menu of command.menus ?? []) {
				store.add(MenuRegistry.appendMenuItem(menu.id, { command: shown, group: menu.group, order: menu.order, when: menu.when }));
			}
		}
		return store;
	}
}

/**
 * Keeps a module's editor type known to VS Code's editor registry from startup: a tab restored
 * before its module loads comes back as a placeholder, which loads the module when shown and
 * replaces itself with the real editor.
 */
export function registerVoltFeatureModuleEditors(entries: readonly IVoltFeatureModuleEntry[]): IDisposable {
	const store = new DisposableStore();
	const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);
	for (const entry of entries) {
		for (const typeId of entry.editors ?? []) {
			const serializer = createVoltFeatureModuleEditorSerializer(entry.feature, typeId);
			store.add(registry.registerEditorSerializer(typeId, class implements IEditorSerializer {
				canSerialize(editor: EditorInput): boolean {
					return serializer.canSerialize(editor);
				}
				serialize(editor: EditorInput): string | undefined {
					return serializer.serialize(editor);
				}
				deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
					return serializer.deserialize(instantiationService, serialized);
				}
			}));
		}
	}
	store.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(VoltFeatureModulePlaceholderPane, VoltFeatureModulePlaceholderPane.ID, localize('voltModules.placeholder', "Loading")),
		[new SyncDescriptor(VoltFeatureModuleEditorPlaceholder)]
	));
	return store;
}

/** What core registers for a module's editor type: the module's own serializer once it is loaded, a placeholder until then. */
export function createVoltFeatureModuleEditorSerializer(feature: string, typeId: string): IEditorSerializer {
	return {
		canSerialize: editor => editor instanceof VoltFeatureModuleEditorPlaceholder || !!moduleSerializers.get(typeId)?.canSerialize(editor),
		serialize: editor => editor instanceof VoltFeatureModuleEditorPlaceholder ? editor.serialized : moduleSerializers.get(typeId)?.serialize(editor),
		deserialize: (instantiationService, serialized) => {
			const own = moduleSerializers.get(typeId);
			if (own) {
				return own.deserialize(instantiationService, serialized);
			}
			// Off: the tab goes, like any editor whose contribution is gone.
			return instantiationService.invokeFunction(accessor => accessor.get(IVoltFeatureService).isEnabled(feature))
				? new VoltFeatureModuleEditorPlaceholder(feature, typeId, serialized)
				: undefined;
		},
	};
}

/** A restored tab of a module that isn't loaded yet. It keeps the module's type id and data, so it saves as it was. */
export class VoltFeatureModuleEditorPlaceholder extends EditorInput {

	readonly resource = undefined;

	constructor(
		readonly feature: string,
		private readonly moduleTypeId: string,
		readonly serialized: string,
	) {
		super();
	}

	override get typeId(): string {
		return this.moduleTypeId;
	}

	override get editorId(): string {
		return VoltFeatureModulePlaceholderPane.ID;
	}

	override getName(): string {
		return voltFeature(this.feature)?.label ?? this.feature;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other === this || (other instanceof VoltFeatureModuleEditorPlaceholder && other.typeId === this.typeId && other.serialized === this.serialized);
	}

	/** The module's editor for this tab, once the module is loaded. */
	resolveModuleEditor(instantiationService: IInstantiationService): EditorInput | undefined {
		return moduleSerializers.get(this.moduleTypeId)?.deserialize(instantiationService, this.serialized);
	}
}

/** Shows a placeholder for the moment its module loads, then swaps in the module's editor. */
class VoltFeatureModulePlaceholderPane extends EditorPane {

	static readonly ID = 'workbench.editor.voltFeatureModulePlaceholder';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IVoltFeatureModuleService private readonly modules: IVoltFeatureModuleService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(VoltFeatureModulePlaceholderPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		append(parent, $('.volt-feature-module-placeholder'));
	}

	override async setInput(input: VoltFeatureModuleEditorPlaceholder, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const module = await this.modules.activate(input.feature).catch(() => undefined);
		if (token.isCancellationRequested || this.input !== input) {
			return;
		}
		const replacement = module ? input.resolveModuleEditor(this.instantiationService) : undefined;
		if (replacement) {
			await this.group.replaceEditors([{ editor: input, replacement, options: { ...options, pinned: this.group.isPinned(input) } }]);
		} else {
			await this.group.closeEditor(input);
		}
	}

	override layout(): void { }
}
