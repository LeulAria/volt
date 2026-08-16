/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lastMatch } from '../../../common/access/policyCompiler.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission, pickAdvertised } from '../../../common/access/providerAccessBridge.js';

export class CodexAccessBridge implements IProviderAccessBridge {

	readonly id = 'codex';
	readonly authority = 'hybrid' as const;
	readonly delegatesMediumReview = true;

	translate(policy: ICompiledPolicy, caps: IAcpSessionCapabilities): IProviderAccessConfig {
		const shell = lastMatch(policy.configured, 'shell', '*').effect;
		const edit = lastMatch(policy.configured, 'edit', '*').effect;
		const approvalPolicy = shell === 'allow' && edit === 'allow'
			? 'never'
			: edit === 'allow'
				? 'on-request'
				: 'untrusted';
		const sandbox = shell === 'allow' && edit === 'allow'
			? 'danger-full-access'
			: edit === 'allow'
				? 'workspace-write'
				: 'read-only';
		const reviewer = shell === 'ask' && edit === 'allow' ? 'auto_review' : 'user';
		return {
			configOptions: pickAdvertised(caps, [
				{ id: 'approval_policy', value: approvalPolicy },
				{ id: 'approvalPolicy', value: approvalPolicy },
				{ id: 'sandbox', value: sandbox },
				{ id: 'approvals_reviewer', value: reviewer },
				{ id: 'approvalsReviewer', value: reviewer },
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
