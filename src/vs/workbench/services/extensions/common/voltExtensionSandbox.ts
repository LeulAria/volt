/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ExtensionSandboxRefusalCode, extensionListed, IT3ExtensionFacts, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';

/**
 * The window's side of per-extension sandboxing (spec P2, P6, P8; N.1 #22: opt-in per extension).
 * An extension the user did not opt in runs exactly as before. An opted-in one runs alone in its
 * own sandboxed extension host on the agent server; when that can't happen it stays off and says
 * why, until the user chooses "Run Without Sandbox" (never silently unsandboxed).
 */

/** Whether `extension` gets its own sandboxed host in this window (the opt-in, minus built-ins, code-less ones and the user's "run without sandbox"). */
export function voltRunsSandboxed(configurationService: IConfigurationService, extension: IExtensionDescription): boolean {
	if (extension.isBuiltin || (!extension.main && !extension.browser)) {
		return false;
	}
	const id = extension.identifier.value;
	return extensionListed(configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING), id)
		&& !extensionListed(configurationService.getValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING), id);
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
	/** Opted in, and it can't be sandboxed here: it stays off. */
	| { readonly kind: 'refused'; readonly code: ExtensionSandboxRefusalCode | string; readonly reason: string }
	/** The user chose "Run Without Sandbox" after a refusal. */
	| { readonly kind: 'unsandboxed' };

export const IVoltExtensionSandboxService = createDecorator<IVoltExtensionSandboxService>('voltExtensionSandboxService');

export interface IVoltExtensionSandboxService {
	readonly _serviceBrand: undefined;
	/** An extension's state changed (by id). */
	readonly onDidChange: Event<string>;
	state(extensionId: string): VoltExtensionSandboxState;
	isOptedIn(extensionId: string): boolean;
	/** Opts it in or out (per profile; a window reload moves it). */
	setOptedIn(extensionId: string, sandboxed: boolean): Promise<void>;
	/** P8: after a refusal, the user's explicit choice to run it without the sandbox (asks first). */
	runWithoutSandbox(extensionId: string): Promise<boolean>;
	/** From the extension host layer: its sandboxed host is starting, runs, or was refused. */
	report(extensionId: string, state: VoltExtensionSandboxState): void;
}
