/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lastMatch } from '../../../common/access/policyCompiler.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission, pickAdvertised } from '../../../common/access/providerAccessBridge.js';

export class ClaudeAccessBridge implements IProviderAccessBridge {

	readonly id = 'claude-code';
	readonly authority = 'hybrid' as const;
	readonly delegatesMediumReview = true;

	translate(policy: ICompiledPolicy, caps: IAcpSessionCapabilities): IProviderAccessConfig {
		const shell = lastMatch(policy.configured, 'shell', '*').effect;
		const edit = lastMatch(policy.configured, 'edit', '*').effect;
		const permissionMode = shell === 'allow' && edit === 'allow'
			? 'bypassPermissions'
			: shell === 'ask' && edit === 'allow'
				? 'auto'
				: edit === 'allow'
					? 'acceptEdits'
					: 'default';
		return {
			configOptions: pickAdvertised(caps, [
				{ id: 'permissionMode', value: permissionMode },
				{ id: 'permission_mode', value: permissionMode },
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
