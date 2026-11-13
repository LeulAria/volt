/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IIdeCapability } from '../../voltAgent/browser/ide/capabilities/capability.js';
import type { IVoltFeatureService } from '../../voltCustomize/common/voltFeatures.js';
import { HTTP_CLIENT_FEATURE_ID } from '../common/voltHttp.js';

/** What an agent's `ide http` call answers while the user has the HTTP client turned off. */
export const HTTP_CLIENT_OFF = 'The HTTP client belongs to a Volt feature the user turned off (Capabilities or Extensions), so no request was sent and no request file was read. Do not use ide http again in this chat; if the task needs a request, send it with curl from your shell.';

/**
 * The `ide` gateway's `http` capability, as agents reach the HTTP client: while the HTTP client
 * feature (`volt.http-client`) is off, every op is refused before it reads a request file or sends
 * anything. Its other parts (views, commands, CodeLens) follow the same switch in voltHttp.contribution.ts.
 */
export function whileHttpClientOn(capability: IIdeCapability, features: IVoltFeatureService | undefined): IIdeCapability {
	return {
		id: capability.id,
		invoke: async (op, args, ctx) => features?.isEnabled(HTTP_CLIENT_FEATURE_ID) === false ? { text: HTTP_CLIENT_OFF, isError: true } : capability.invoke(op, args, ctx),
	};
}
