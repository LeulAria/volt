/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IExtensionPointUser } from '../../../services/extensions/common/extensionsRegistry.js';
import { ReportModeCapabilityReporter } from '../../../services/voltPlugins/common/capabilities.js';
import { createVoltApi, IVoltApiBackend, IVoltPluginContext, IVoltPluginEntry, IVoltPluginService } from '../../../services/voltPlugins/common/voltApi.js';
import { IVoltContributes, IVoltPluginManifest, validateVoltContribution, VOLT_CONTRIBUTION_POINTS } from '../../../services/voltPlugins/common/voltContributions.js';
import { VOLT_EXTENSION_POINTS } from '../../../services/voltPlugins/common/voltExtensionPoints.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltFeatureService } from '../common/voltFeatures.js';

/**
 * Reads Volt's contribution points from every enabled extension (an invalid entry is reported on
 * the extension and left out) and hands each extension one `IVoltPluginContext` whose `volt` API
 * runs in report mode: calls go to Volt's services as today, and what the manifest doesn't declare
 * is logged. An extension that goes away (disabled, uninstalled) has its context's registrations
 * disposed.
 */
export class VoltPluginService extends Disposable implements IVoltPluginService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	readonly reporter: ReportModeCapabilityReporter;

	private readonly users = new Map<keyof IVoltContributes, readonly IExtensionPointUser<unknown>[]>();
	private entries = new Map<string, IVoltPluginEntry>();
	private readonly contexts = this._register(new DisposableMap<string, VoltPluginContextHandle>());
	private readonly builtinContexts = this._register(new DisposableMap<string, VoltPluginContextHandle>());
	private readonly rebuild = this._register(new RunOnceScheduler(() => this.build(), 0));
	private readonly backend: IVoltApiBackend;

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IVoltFeatureService featureService: IVoltFeatureService,
		@ILogService logService: ILogService,
	) {
		super();
		this.reporter = new ReportModeCapabilityReporter(message => logService.warn(message));
		this._register(toDisposable(() => this.reporter.dispose()));
		this.backend = {
			registerTool: (info, invoke) => hostTools.registerToolProvider({
				tools: [info],
				invoke: (_name, args, call) => invoke(args, call?.sessionId),
			}),
			invokeTool: (name, args) => hostTools.invokeTool(name, args),
			storageGet: key => storageService.get(key, StorageScope.PROFILE),
			storageSet: (key, value) => value === undefined ? storageService.remove(key, StorageScope.PROFILE) : storageService.store(key, value, StorageScope.PROFILE, StorageTarget.MACHINE),
			storageKeys: prefix => storageService.keys(StorageScope.PROFILE, StorageTarget.MACHINE).filter(key => key.startsWith(prefix)),
			getSetting: key => configurationService.getValue(key),
			updateSetting: (key, value) => configurationService.updateValue(key, value),
			onDidChangeSettings: Event.map(configurationService.onDidChangeConfiguration, e => ({ affects: (key: string) => e.affectsConfiguration(key) })),
			executeCommand: (id, args) => commandService.executeCommand(id, ...args),
			// A plugin's commands are its own: private to Volt until a capability exports them (I.14).
			registerCommand: (id, handler) => CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...args), 'internal'),
			isOn: (part, id) => featureService.isOn(part, id),
		};
		for (const point of VOLT_CONTRIBUTION_POINTS) {
			this._register(VOLT_EXTENSION_POINTS[point].setHandler(extensions => {
				this.users.set(point, extensions as readonly IExtensionPointUser<unknown>[]);
				this.rebuild.schedule();
			}));
		}
	}

	plugins(): readonly IVoltPluginEntry[] {
		return [...this.entries.values()];
	}

	plugin(extensionId: string): IVoltPluginEntry | undefined {
		return this.entries.get(ExtensionIdentifier.toKey(extensionId));
	}

	getContext(extensionId: string): IVoltPluginContext | undefined {
		// Extension points that just arrived count already (a feature module asks right after registration).
		if (this.rebuild.isScheduled()) {
			this.rebuild.flush();
		}
		const key = ExtensionIdentifier.toKey(extensionId);
		const existing = this.contexts.get(key);
		if (existing) {
			return existing.context;
		}
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		const handle = new VoltPluginContextHandle(entry, this.backend, this.reporter);
		this.contexts.set(key, handle);
		return handle.context;
	}

	getBuiltinContext(manifest: IVoltPluginManifest): IVoltPluginContext | undefined {
		const extensionId = `${manifest.publisher}.${manifest.name}`;
		const loaded = this.getContext(extensionId);
		if (loaded) {
			return loaded;
		}
		// The caller asks only for a feature that is on (`IVoltFeatureService`), so this is a build
		// without the extension. Kept apart from `contexts`, which follow the extension registry.
		const key = ExtensionIdentifier.toKey(extensionId);
		let handle = this.builtinContexts.get(key);
		if (!handle) {
			handle = new VoltPluginContextHandle({ extensionId, firstParty: true, manifest, problems: [] }, this.backend, this.reporter);
			this.builtinContexts.set(key, handle);
		}
		return handle.context;
	}

	private build(): void {
		const byExtension = new Map<string, { description: IExtensionDescription; contributes: Record<string, unknown>; problems: string[] }>();
		for (const [point, users] of this.users) {
			for (const user of users) {
				const key = ExtensionIdentifier.toKey(user.description.identifier);
				let record = byExtension.get(key);
				if (!record) {
					record = { description: user.description, contributes: {}, problems: [] };
					byExtension.set(key, record);
				}
				const problems = validateVoltContribution(point, user.value);
				if (problems.length) {
					for (const problem of problems) {
						user.collector.error(problem);
					}
					record.problems.push(...problems);
				} else {
					record.contributes[point] = user.value;
				}
			}
		}
		const next = new Map<string, IVoltPluginEntry>();
		for (const [key, record] of byExtension) {
			const description = record.description;
			const engines: Readonly<Record<string, unknown>> = description.engines ?? {};
			const manifest: IVoltPluginManifest = {
				publisher: description.publisher,
				name: description.name,
				...(typeof engines.volt === 'string' ? { engines: { volt: engines.volt } } : {}),
				contributes: record.contributes,
			};
			next.set(key, { extensionId: description.identifier.value, firstParty: description.isBuiltin && description.publisher === 'volt', manifest, problems: record.problems });
		}
		// A context outlives no change to its manifest: the extension went away or contributes something else.
		for (const key of [...this.contexts.keys()]) {
			const before = this.entries.get(key);
			const after = next.get(key);
			if (!after || JSON.stringify(before?.manifest) !== JSON.stringify(after.manifest)) {
				this.contexts.deleteAndDispose(key);
			}
		}
		this.entries = next;
		this._onDidChange.fire();
	}
}

/** One extension's live context; disposing it unloads what the extension registered through it. */
class VoltPluginContextHandle implements IDisposable {

	readonly context: IVoltPluginContext;
	private readonly subscriptions = new DisposableStore();

	constructor(entry: IVoltPluginEntry, backend: IVoltApiBackend, reporter: ReportModeCapabilityReporter) {
		const principal = { extensionId: entry.extensionId, firstParty: entry.firstParty, capabilities: entry.manifest.contributes?.voltCapabilities ?? {} };
		this.context = Object.freeze({
			extensionId: entry.extensionId,
			...(entry.manifest.contributes?.voltModule ? { featureId: entry.manifest.contributes.voltModule.feature } : {}),
			manifest: entry.manifest,
			volt: createVoltApi(principal, entry.manifest, backend, reporter, this.subscriptions),
			subscriptions: this.subscriptions,
		});
	}

	dispose(): void {
		this.subscriptions.dispose();
	}
}
