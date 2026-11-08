/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { OperatingSystem, OS } from '../../../../base/common/platform.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ExtensionSandboxRefusalCode, ExtensionSandboxTier, extensionSandboxTier, IExtensionSandboxSettings, IT3ExtensionFacts, VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';

/**
 * The window's side of per-extension sandboxing (spec P2, P6, P8; N.1 #22: opt-in per extension).
 * An extension the user did not opt in runs exactly as before. An opted-in one runs alone in its
 * own sandboxed extension host on the agent server; when that can't happen it stays off and says
 * why, until the user chooses "Run Without Sandbox" (never silently unsandboxed).
 */

/** The P2/P8 settings, as configuration holds them. */
export function voltExtensionSandboxSettings(configurationService: IConfigurationService): IExtensionSandboxSettings {
	return {
		mode: configurationService.getValue(VOLT_EXTENSION_SANDBOX_MODE_SETTING),
		killSwitch: configurationService.getValue(VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING),
		sandboxed: configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING),
		unsandboxed: configurationService.getValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING),
	};
}

/** Whether any of the P2/P8 settings changed (where extensions run follows them after a reload). */
export function affectsVoltExtensionSandbox(e: IConfigurationChangeEvent): boolean {
	return [VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING].some(key => e.affectsConfiguration(key));
}

/**
 * `extension`'s tier in this window (P2, P8). The platform is this machine's: the desktop runs
 * sandboxed hosts on its local agent server, and a browser workbench's server refuses with
 * `platform` where it can't sandbox.
 */
export function voltExtensionSandboxTier(configurationService: IConfigurationService, extension: IExtensionDescription, platform: string = voltPlatform()): ExtensionSandboxTier {
	return extensionSandboxTier(voltExtensionSandboxSettings(configurationService), { id: extension.identifier.value, builtin: extension.isBuiltin, main: !!extension.main, browser: !!extension.browser }, platform);
}

/** Whether `extension` gets a host of its own in this window: sandboxed, or held off by the kill switch (`ask`). Never the shared host. */
export function voltRunsSandboxed(configurationService: IConfigurationService, extension: IExtensionDescription): boolean {
	return voltExtensionSandboxTier(configurationService, extension) !== 'shared';
}

/** Whether `extension` runs in a sandboxed host now (not held by the kill switch). */
export function voltIsSandboxed(configurationService: IConfigurationService, extension: IExtensionDescription): boolean {
	return voltExtensionSandboxTier(configurationService, extension) === 'sandbox';
}

/** Whether the kill switch is on (P8): every extension that would run sandboxed is held and asks. */
export function voltExtensionSandboxKillSwitch(configurationService: IConfigurationService): boolean {
	return configurationService.getValue(VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING) === true;
}

/** This machine's platform, as Node names it. */
export function voltPlatform(): string {
	return OS === OperatingSystem.Macintosh ? 'darwin' : OS === OperatingSystem.Linux ? 'linux' : 'win32';
}

/** The facts the sandbox decides on, from the scanned description. */
export function voltExtensionFacts(extension: IExtensionDescription, extensionKind: readonly string[]): IT3ExtensionFacts {
	return {
		id: extension.identifier.value,
		builtin: extension.isBuiltin,
		main: !!extension.main,
		browser: !!extension.browser,
		extensionKind,
	};
}

export type VoltExtensionSandboxState =
	/** Not opted in: runs as before, in the shared host. */
	| { readonly kind: 'shared' }
	/** Opted in; its host is starting. */
	| { readonly kind: 'starting' }
	| { readonly kind: 'sandboxed' }
	/** Opted in, but nothing to confine (no code, or built-in). */
	| { readonly kind: 'not-needed' }
	/** Opted in, and it can't be sandboxed here (or the kill switch holds it, code `kill-switch`): it stays off. */
	| { readonly kind: 'refused'; readonly code: ExtensionSandboxRefusalCode | string; readonly reason: string }
	/** The user chose "Run Without Sandbox" after a refusal. */
	| { readonly kind: 'unsandboxed' };

export const IVoltExtensionSandboxService = createDecorator<IVoltExtensionSandboxService>('voltExtensionSandboxService');

export interface IVoltExtensionSandboxService {
	readonly _serviceBrand: undefined;
	/** An extension's state changed (by id). */
	readonly onDidChange: Event<string>;
	state(extensionId: string): VoltExtensionSandboxState;
	/** In scope for the sandbox: opted in, or every third-party extension when the mode is `required` (P8). */
	isOptedIn(extensionId: string): boolean;
	/** Opts it in or out (per profile; a window reload moves it). Under `required`, out means "Run Without Sandbox" (asks first). */
	setOptedIn(extensionId: string, sandboxed: boolean): Promise<void>;
	/** P8's kill switch: on moves the tier to `ask` (asks to confirm); off returns to sandboxing. */
	setKillSwitch(on: boolean): Promise<boolean>;
	/** P8: after a refusal, the user's explicit choice to run it without the sandbox (asks first). */
	runWithoutSandbox(extensionId: string): Promise<boolean>;
	/** From the extension host layer: its sandboxed host is starting, runs, or was refused. */
	report(extensionId: string, state: VoltExtensionSandboxState): void;
}
