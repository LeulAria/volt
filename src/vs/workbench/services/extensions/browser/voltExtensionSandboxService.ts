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
import { INotificationService, IPromptChoice, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { effectiveExtensionSandboxMode, extensionListed, VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IHostService } from '../../host/browser/host.js';
import { affectsVoltExtensionSandbox, IVoltExtensionSandboxService, voltPlatform, VoltExtensionSandboxState } from '../common/voltExtensionSandbox.js';

/** Extensions the user chose to keep off after a refusal under `required` (per profile): not asked again. */
const KEPT_OFF_KEY = 'volt.extensions.sandbox.keptOff';

/**
 * Per-extension sandboxing in the window: the scope (`required` by default on macOS and Linux, or
 * the opt-in list, per profile in user or remote user settings), what each extension's sandboxed
 * host is doing, and the P8 choice after a refusal, asked once per extension until answered.
 */
export class VoltExtensionSandboxService extends Disposable implements IVoltExtensionSandboxService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;
	private readonly states = new Map<string, VoltExtensionSandboxState>();
	private readonly notified = new Set<string>();
	/** A choice made before the extension is installed (the install review) needs no reload. */
	private quiet = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (affectsVoltExtensionSandbox(e) && !this.quiet) {
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
		return this.required() || extensionListed(this.configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING), extensionId);
	}

	private required(): boolean {
		return effectiveExtensionSandboxMode(this.configurationService.getValue(VOLT_EXTENSION_SANDBOX_MODE_SETTING), voltPlatform()) === 'required';
	}

	async setOptedIn(extensionId: string, sandboxed: boolean, options?: { readonly beforeInstall?: boolean }): Promise<void> {
		if (options?.beforeInstall) {
			this.quiet++;
			try {
				return await this.setOptedIn(extensionId, sandboxed);
			} finally {
				this.quiet--;
			}
		}
		const lower = extensionId.toLowerCase();
		if (this.required()) {
			// Every third-party extension is in scope: in clears an earlier "run without sandbox", out is that choice (asked first).
			if (!sandboxed) {
				await this.runWithoutSandbox(extensionId);
				return;
			}
			const unsandboxed = this.list(VOLT_UNSANDBOXED_EXTENSIONS_SETTING);
			if (unsandboxed.some(id => id.toLowerCase() === lower)) {
				await this.configurationService.updateValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING, unsandboxed.filter(id => id.toLowerCase() !== lower), ConfigurationTarget.USER);
			}
			this.setKeptOff(extensionId, false);
			this.states.delete(lower);
			this._onDidChange.fire(extensionId);
			return;
		}
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

	async runWithoutSandbox(extensionId: string, options?: { readonly confirmed?: boolean; readonly beforeInstall?: boolean }): Promise<boolean> {
		if (!options?.confirmed && !await this.confirmRunWithout(extensionId)) {
			return false;
		}
		if (options?.beforeInstall) {
			this.quiet++;
		}
		try {
			const unsandboxed = this.list(VOLT_UNSANDBOXED_EXTENSIONS_SETTING).filter(id => id.toLowerCase() !== extensionId.toLowerCase());
			await this.configurationService.updateValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING, [...unsandboxed, extensionId], ConfigurationTarget.USER);
		} finally {
			if (options?.beforeInstall) {
				this.quiet--;
			}
		}
		this.setKeptOff(extensionId, false);
		this.logService.info(`[volt-sandbox] the user chose to run ${extensionId} without the sandbox`);
		this._onDidChange.fire(extensionId);
		return true;
	}

	keepOff(extensionId: string): void {
		this.setKeptOff(extensionId, true);
		this.logService.info(`[volt-sandbox] the user chose to keep ${extensionId} off rather than run it without the sandbox`);
		this._onDidChange.fire(extensionId);
	}

	isKeptOff(extensionId: string): boolean {
		return this.keptOff().includes(extensionId.toLowerCase());
	}

	private keptOff(): string[] {
		try {
			const value = JSON.parse(this.storageService.get(KEPT_OFF_KEY, StorageScope.PROFILE, '[]'));
			return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		} catch {
			return [];
		}
	}

	private setKeptOff(extensionId: string, off: boolean): void {
		const lower = extensionId.toLowerCase();
		const before = this.keptOff();
		const rest = before.filter(id => id !== lower);
		if (!off && rest.length === before.length) {
			return;
		}
		this.storageService.store(KEPT_OFF_KEY, JSON.stringify(off ? [...rest, lower] : rest), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private async confirmRunWithout(extensionId: string): Promise<boolean> {
		const state = this.state(extensionId);
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: localize('voltSandbox.runWithout', "Run {0} without the sandbox?", extensionId),
			detail: localize('voltSandbox.runWithoutDetail', "{0}\n\nWithout the sandbox it runs like any other extension, with the same access as Volt: your files, the network and your credentials.", state.kind === 'refused' ? state.reason : localize('voltSandbox.cantSandbox', "Volt can't run it in a sandbox here.")),
			primaryButton: localize({ key: 'voltSandbox.runWithoutButton', comment: ['&& denotes a mnemonic'] }, "&&Run Without Sandbox"),
		});
		return confirmed;
	}

	async setKillSwitch(on: boolean): Promise<boolean> {
		if (on) {
			const { confirmed } = await this.dialogService.confirm({
				type: Severity.Warning,
				message: localize('voltSandbox.killSwitch', "Switch off the extension sandbox?"),
				detail: localize('voltSandbox.killSwitchDetail', "Extensions that run in a sandbox stop after a reload and stay off. Each asks you whether to run it without the sandbox; none runs unsandboxed until you say so."),
				primaryButton: localize({ key: 'voltSandbox.killSwitchButton', comment: ['&& denotes a mnemonic'] }, "&&Switch Off"),
			});
			if (!confirmed) {
				return false;
			}
		}
		await this.configurationService.updateValue(VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, on, ConfigurationTarget.USER);
		this.logService.info(`[volt-sandbox] the extension sandbox kill switch is ${on ? 'on: sandboxed extensions ask first' : 'off'}`);
		this._onDidChange.fire('');
		return true;
	}

	report(extensionId: string, state: VoltExtensionSandboxState): void {
		const key = extensionId.toLowerCase();
		this.states.set(key, state);
		this._onDidChange.fire(extensionId);
		if (state.kind === 'refused') {
			this.logService.warn(`[volt-sandbox] ${extensionId} stays off: no sandboxed host (${state.code}): ${state.reason}`);
			// Asked once per window until answered. In scope only by the `required` default, the other
			// answer is "Keep It Off", which is remembered (per profile): no prompt at every start.
			const byDefault = state.code !== 'kill-switch' && this.required() && !extensionListed(this.configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING), extensionId);
			if (!this.notified.has(key) && !(byDefault && this.isKeptOff(extensionId))) {
				this.notified.add(key);
				const message = state.code === 'kill-switch'
					? localize('voltSandbox.held', "{0} stays off: the extension sandbox is switched off. Run it without the sandbox?", extensionId)
					: byDefault
						? localize('voltSandbox.refusedDefault', "{0} stays off: Volt runs extensions in a sandbox and can't run this one in one here. {1} Run it without the sandbox, or keep it off?", extensionId, state.reason)
						: localize('voltSandbox.refused', "{0} stays off: Volt can't run it in a sandbox here. {1}", extensionId, state.reason);
				const runWithout: IPromptChoice = { label: localize('voltSandbox.runWithoutAction', "Run Without Sandbox"), run: () => this.runWithoutSandbox(extensionId) };
				const other: IPromptChoice = byDefault
					? { label: localize('voltSandbox.keepOff', "Keep It Off"), run: () => this.keepOff(extensionId) }
					: { label: localize('voltSandbox.stopSandboxing', "Stop Sandboxing It"), run: () => this.setOptedIn(extensionId, false) };
				this.notificationService.prompt(Severity.Warning, message, [runWithout, other], { priority: NotificationPriority.URGENT, sticky: true });
			}
		}
	}

	private list(setting: string): string[] {
		const value = this.configurationService.getValue(setting);
		return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
	}
}

registerSingleton(IVoltExtensionSandboxService, VoltExtensionSandboxService, InstantiationType.Delayed);
