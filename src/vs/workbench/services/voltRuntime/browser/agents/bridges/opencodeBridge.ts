/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lastMatch } from '../../../common/access/policyCompiler.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission, pickAdvertised } from '../../../common/access/providerAccessBridge.js';

export class OpenCodeAccessBridge implements IProviderAccessBridge {

	readonly id = 'opencode';
	readonly authority = 'hybrid' as const;

	translate(policy: ICompiledPolicy, caps: IAcpSessionCapabilities): IProviderAccessConfig {
		const shell = lastMatch(policy.configured, 'shell', '*').effect;
		const edit = lastMatch(policy.configured, 'edit', '*').effect;
		const permission = shell === 'allow' && edit === 'allow' ? 'allow' : 'ask';
		return {
			configOptions: pickAdvertised(caps, [
				{ id: 'permission', value: permission },
				{ id: 'permissions', value: permission },
			]),
		};
	}

	normalize(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined {
		return normalizeAcpPermission(method, params, context);
	}

	toNativeResponse(decision: IAccessDecision, params: unknown): unknown {
		return acpPermissionResponse(decision, params);
	}
}
