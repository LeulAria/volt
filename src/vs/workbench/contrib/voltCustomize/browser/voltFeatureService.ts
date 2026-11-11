/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IGlobalExtensionEnablementService, ILocalExtension } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EnablementState, IWorkbenchExtensionEnablementService, IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltFeatureService, VOLT_FEATURES, voltFeature, voltFeatureContextKey, voltFeatureOwning, VoltFeaturePart } from '../common/voltFeatures.js';

/**
 * A feature is off when the user disabled its built-in extension (globally or for this workspace). An extension that isn't there at all (a build that doesn't ship it) leaves its
 * feature on, so a missing manifest can never take Volt apart.
 *
 * Until the installed list is read, the global disabled list stands in, so a feature the user
 * turned off doesn't flash on at startup.
 */
export class VoltFeatureService extends Disposable implements IVoltFeatureService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private disabled: ReadonlySet<string>;
	/** Of `disabled`, the features turned off only for this workspace. */
	private disabledInWorkspace: ReadonlySet<string> = new Set();
	private readonly contextKeys = new Map<string, IContextKey<boolean>>();
	private readonly recompute = this._register(new RunOnceScheduler(() => void this.read(), 50));

	constructor(
		@IGlobalExtensionEnablementService globalEnablement: IGlobalExtensionEnablementService,
		@IWorkbenchExtensionEnablementService private readonly enablement: IWorkbenchExtensionEnablementService,
		@IWorkbenchExtensionManagementService private readonly management: IWorkbenchExtensionManagementService,
		@IExtensionService extensionService: IExtensionService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const globallyDisabled = globalEnablement.getDisabledExtensions();
		this.disabled = new Set(VOLT_FEATURES.filter(feature => feature.extensionId && globallyDisabled.some(id => areSameExtensions(id, { id: feature.extensionId! }))).map(feature => feature.id));
		for (const feature of VOLT_FEATURES) {
			// `voltFeature.usage`: for when clauses on menus and commands.
			this.contextKeys.set(feature.id, new RawContextKey<boolean>(voltFeatureContextKey(feature.id), true).bindTo(contextKeyService));
		}
		this.apply();
		this._register(this.enablement.onEnablementChanged(() => this.recompute.schedule()));
		this._register(extensionService.onDidChangeExtensions(() => this.recompute.schedule()));
		this._register(this.management.onDidInstallExtensions(() => this.recompute.schedule()));
		this._register(this.management.onDidUninstallExtension(() => this.recompute.schedule()));
		void this.read();
	}

	isEnabled(featureId: string): boolean {
		return !this.disabled.has(featureId);
	}

	isOn(part: VoltFeaturePart, id: string): boolean {
		const owner = voltFeatureOwning(part, id);
		return !owner || !this.disabled.has(owner);
	}

	async setEnabled(featureId: string, enabled: boolean): Promise<void> {
		const feature = voltFeature(featureId);
		if (!feature?.extensionId) {
			return;
		}
		const local = (await this.featureExtensions()).get(featureId);
		if (!local) {
			throw new Error(`The extension ${feature.extensionId} that carries ${feature.label} is not installed.`);
		}
		await this.enablement.setEnablement([local], enabled ? EnablementState.EnabledGlobally : EnablementState.DisabledGlobally);
		await this.read();
	}

	private async featureExtensions(): Promise<Map<string, ILocalExtension>> {
		const installed = await this.management.getInstalled(ExtensionType.System);
		const byFeature = new Map<string, ILocalExtension>();
		for (const feature of VOLT_FEATURES) {
			const local = feature.extensionId ? installed.find(extension => areSameExtensions(extension.identifier, { id: feature.extensionId! })) : undefined;
			if (local) {
				byFeature.set(feature.id, local);
			}
		}
		return byFeature;
	}

	private async read(): Promise<void> {
		try {
			const extensions = await this.featureExtensions();
			const disabled = new Set<string>();
			const workspace = new Set<string>();
			for (const [featureId, local] of extensions) {
				// Only the user's choice turns a feature off, not a state the environment puts the
				// extension in (an untrusted workspace, a remote window's extension kind).
				const state = this.enablement.getEnablementState(local);
				if (state === EnablementState.DisabledGlobally || state === EnablementState.DisabledWorkspace) {
					disabled.add(featureId);
				}
				if (state === EnablementState.DisabledWorkspace) {
					workspace.add(featureId);
				}
			}
			const changed = disabled.size !== this.disabled.size || [...disabled].some(id => !this.disabled.has(id));
			this.disabled = disabled;
			this.disabledInWorkspace = workspace;
			this.apply();
			if (changed) {
				this._onDidChange.fire();
			}
		} catch (error) {
			this.logService.warn('[volt features] could not read the feature extensions', error);
		}
	}

	private apply(): void {
		for (const [featureId, key] of this.contextKeys) {
			key.set(!this.disabled.has(featureId));
		}
		this.hostTools.setDisabledTools(VOLT_FEATURES.filter(feature => this.disabled.has(feature.id)).flatMap(feature => feature.tools ?? []));
		// The agent server's own tools too (customize.md 6.1d): it keeps the global choice while no window is open.
		this.hostTools.mirrorFeatureEnablement({
			global: [...this.disabled].filter(id => !this.disabledInWorkspace.has(id)),
			workspace: [...this.disabledInWorkspace],
		});
	}
}
