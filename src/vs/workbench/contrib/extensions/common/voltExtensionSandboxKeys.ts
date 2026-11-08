/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IVoltExtensionSandboxService } from '../../../services/extensions/common/voltExtensionSandbox.js';

/** Set on the extension context menu's overlay (P2): whether this extension is opted into the sandbox. */
export const VOLT_EXTENSION_SANDBOXED = new RawContextKey<boolean>('voltExtensionSandboxed', false);
/** The opted-in extension's sandbox state: `starting`, `sandboxed`, `refused`, `unsandboxed`, `not-needed`. */
export const VOLT_EXTENSION_SANDBOX_STATE = new RawContextKey<string>('voltExtensionSandboxState', '');

/** The context menu overlay entries for an extension. */
export function voltSandboxContextOverlay(service: IVoltExtensionSandboxService, extensionId: string): [string, unknown][] {
	return [[VOLT_EXTENSION_SANDBOXED.key, service.isOptedIn(extensionId)], [VOLT_EXTENSION_SANDBOX_STATE.key, service.state(extensionId).kind]];
}
