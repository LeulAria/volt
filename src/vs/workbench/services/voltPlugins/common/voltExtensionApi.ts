/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SubjectKey } from '../../../../platform/voltSandbox/common/principals.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICapabilityReporter, IWouldBeDenial } from './capabilities.js';
import { IVoltPluginContext } from './voltApi.js';

export const IVoltExtensionApiService = createDecorator<IVoltExtensionApiService>('voltExtensionApiService');

/** One answer the user gave about one capability of one extension. */
export interface IVoltExtensionConsent {
	readonly capability: string;
	readonly granted: boolean;
}

/**
 * The `volt` API for code running in an extension host (`vscode.volt`, `MainThreadVolt`). Unlike
 * the in-process feature contexts (`IVoltPluginService`, trusted core, report mode) every call is
 * enforced by `policy`: built-in `volt.*` extensions within their compiled ceilings, third parties
 * by their declared `voltCapabilities` and the user's one-time consent for medium and high ones.
 */
export interface IVoltExtensionApiService {
	readonly _serviceBrand: undefined;
	/** The enforcing check (`VoltExtensionCapabilityPolicy` until the Policy Authority replaces it). */
	readonly policy: ICapabilityReporter;
	/** A consent was given, refused or revoked. */
	readonly onDidChangeConsent: Event<{ readonly extensionId: string; readonly capability: string }>;
	/**
	 * The API for `extension`, whose description core read itself (its id was checked against the
	 * calling extension host first). What it registers goes into `subscriptions`.
	 */
	createContext(extension: IExtensionDescription, subscriptions: DisposableStore): IVoltPluginContext;
	/**
	 * Asks the user, in Volt's words, to allow a promptable denial (a declared medium or high
	 * capability of a third party). Concurrent asks for the same capability share one dialog. The
	 * answer is kept until the user changes it on the extension's page.
	 */
	requestConsent(extension: IExtensionDescription, denial: IWouldBeDenial): Promise<boolean>;
	consents(extensionId: string): readonly IVoltExtensionConsent[];
	/** Takes a consent back: later uses are refused until the user allows it again on the extension's page. */
	revokeConsent(extensionId: string, capability: string): void;
	/** The grant store's subject of a third-party extension (`plugin:<id>@<signer>`, P4), for the Access page. */
	subjectOf?(extensionId: string): SubjectKey;
}
