/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { extensionListed, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IHostService } from '../../host/browser/host.js';
import { IVoltExtensionSandboxService, VoltExtensionSandboxState } from '../common/voltExtensionSandbox.js';

/**
 * Per-extension sandboxing in the window: the opt-in (per profile, in user or remote user
 * settings), what each opted-in extension's host is doing, and the P8 choice after a refusal.
 */
export class VoltExtensionSandboxService extends Disposable implements IVoltExtensionSandboxService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;
	private readonly states = new Map<string, VoltExtensionSandboxState>();
	private readonly notified = new Set<string>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING) || e.affectsConfiguration(VOLT_UNSANDBOXED_EXTENSIONS_SETTING)) {
				// Where an extension runs is decided when its host starts: the change applies after a reload.
				this.notificationService.prompt(Severity.Info, localize('voltSandbox.reload', "Reload the window to apply the change to which extensions run in a sandbox."), [{
					label: localize('voltSandbox.reloadNow', "Reload Window"),
					run: () => this.hostService.reload(),
				}]);
				this._onDidChange.fire('');
			}
		}));
	}

	state(extensionId: string): VoltExtensionSandboxState {
		const key = extensionId.toLowerCase();
		if (!this.isOptedIn(extensionId)) {
			return { kind: 'shared' };
		}
		if (extensionListed(this.configurationService.getValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING), extensionId)) {
			return { kind: 'unsandboxed' };
		}
		return this.states.get(key) ?? { kind: 'starting' };
	}

	isOptedIn(extensionId: string): boolean {
		return extensionListed(this.configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING), extensionId);
	}

	async setOptedIn(extensionId: string, sandboxed: boolean): Promise<void> {
		const lower = extensionId.toLowerCase();
		const current = this.list(VOLT_SANDBOXED_EXTENSIONS_SETTING).filter(id => id.toLowerCase() !== lower);
		await this.configurationService.updateValue(VOLT_SANDBOXED_EXTENSIONS_SETTING, sandboxed ? [...current, extensionId] : current, ConfigurationTarget.USER);
		if (!sandboxed) {
			// Opting out again clears an earlier "run without sandbox": the next opt-in starts sandboxed.
			const unsandboxed = this.list(VOLT_UNSANDBOXED_EXTENSIONS_SETTING);
			if (unsandboxed.some(id => id.toLowerCase() === lower)) {
				await this.configurationService.updateValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING, unsandboxed.filter(id => id.toLowerCase() !== lower), ConfigurationTarget.USER);
			}
		}
		this.states.delete(lower);
		this._onDidChange.fire(extensionId);
	}

	async runWithoutSandbox(extensionId: string): Promise<boolean> {
		const state = this.state(extensionId);
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: localize('voltSandbox.runWithout', "Run {0} without the sandbox?", extensionId),
			detail: localize('voltSandbox.runWithoutDetail', "{0}\n\nWithout the sandbox it runs like any other extension, with the same access as Volt: your files, the network and your credentials.", state.kind === 'refused' ? state.reason : localize('voltSandbox.cantSandbox', "Volt can't run it in a sandbox here.")),
			primaryButton: localize({ key: 'voltSandbox.runWithoutButton', comment: ['&& denotes a mnemonic'] }, "&&Run Without Sandbox"),
		});
		if (!confirmed) {
			return false;
		}
		const unsandboxed = this.list(VOLT_UNSANDBOXED_EXTENSIONS_SETTING).filter(id => id.toLowerCase() !== extensionId.toLowerCase());
		await this.configurationService.updateValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING, [...unsandboxed, extensionId], ConfigurationTarget.USER);
		this.logService.info(`[volt-sandbox] the user chose to run ${extensionId} without the sandbox`);
		this._onDidChange.fire(extensionId);
		return true;
	}

	report(extensionId: string, state: VoltExtensionSandboxState): void {
		const key = extensionId.toLowerCase();
		this.states.set(key, state);
		this._onDidChange.fire(extensionId);
		if (state.kind === 'refused') {
			this.logService.warn(`[volt-sandbox] ${extensionId} stays off: no sandboxed host (${state.code}): ${state.reason}`);
			if (!this.notified.has(key)) {
				this.notified.add(key);
				this.notificationService.prompt(Severity.Warning, localize('voltSandbox.refused', "{0} stays off: Volt can't run it in a sandbox here. {1}", extensionId, state.reason), [{
					label: localize('voltSandbox.runWithoutAction', "Run Without Sandbox"),
					run: () => this.runWithoutSandbox(extensionId),
				}, {
					label: localize('voltSandbox.stopSandboxing', "Stop Sandboxing It"),
					run: () => this.setOptedIn(extensionId, false),
				}], { priority: NotificationPriority.URGENT, sticky: true });
			}
		}
	}

	private list(setting: string): string[] {
		const value = this.configurationService.getValue(setting);
		return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
	}
}

registerSingleton(IVoltExtensionSandboxService, VoltExtensionSandboxService, InstantiationType.Delayed);
