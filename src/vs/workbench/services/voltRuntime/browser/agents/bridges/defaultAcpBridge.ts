/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission } from '../../../common/access/providerAccessBridge.js';

export class DefaultAcpBridge implements IProviderAccessBridge {

	readonly authority = 'volt' as const;

	constructor(readonly id: string = 'acp-generic') { }

	translate(_policy: ICompiledPolicy, _caps: IAcpSessionCapabilities): IProviderAccessConfig {
		return {};
	}

	normalize(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined {
		return normalizeAcpPermission(method, params, context);
	}

	toNativeResponse(decision: IAccessDecision, params: unknown): unknown {
		return acpPermissionResponse(decision, params);
	}
}
