/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, advertisedModeId, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission } from '../../../common/access/providerAccessBridge.js';

/**
 * fx runs in its `ask` mode, so every edit and command comes to Volt as a permission request and
 * Volt's access rules answer it, the same rules every other agent follows. fx's `code` (auto) mode
 * is not used: its own reviewer escalates only what it refused, and Volt's Full Access would then
 * approve exactly those.
 */
export class FxAccessBridge implements IProviderAccessBridge {

	readonly id = 'fx';
	readonly authority = 'volt' as const;

	translate(_policy: ICompiledPolicy, caps: IAcpSessionCapabilities): IProviderAccessConfig {
		return { sessionModeId: advertisedModeId(caps, ['ask']) };
	}

	normalize(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined {
		return normalizeAcpPermission(method, params, context);
	}

	toNativeResponse(decision: IAccessDecision, params: unknown): unknown {
		return acpPermissionResponse(decision, params);
	}
}
