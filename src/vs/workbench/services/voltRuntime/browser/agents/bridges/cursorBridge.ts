/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, advertisedModeId, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission } from '../../../common/access/providerAccessBridge.js';

export class CursorAccessBridge implements IProviderAccessBridge {

	readonly authority = 'hybrid' as const;

	constructor(readonly id: string = 'cursor-acp') { }

	translate(_policy: ICompiledPolicy, caps: IAcpSessionCapabilities): IProviderAccessConfig {
		return {
			sessionModeId: advertisedModeId(caps, ['implement', 'agent', 'default', 'approval']),
		};
	}

	normalize(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined {
		return normalizeAcpPermission(method, params, context);
	}

	toNativeResponse(decision: IAccessDecision, params: unknown): unknown {
		return acpPermissionResponse(decision, params);
	}
}
