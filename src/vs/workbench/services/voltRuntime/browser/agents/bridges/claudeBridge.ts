/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lastMatch } from '../../../common/access/policyCompiler.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy } from '../../../common/access/accessTypes.js';
import { acpPermissionResponse, advertisedModeId, IAccessNormalizeContext, IAcpSessionCapabilities, IProviderAccessBridge, IProviderAccessConfig, normalizeAcpPermission, pickAdvertised } from '../../../common/access/providerAccessBridge.js';

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
		// Claude's ACP adapter names its permission mode `mode` (a config option and the session's
		// modes); asked only for `permissionMode`, a Full access chat stayed in the adapter's default,
		// Claude Code's `auto`, which also holds every MCP call until the model's message ends.
		const configOptions = pickAdvertised(caps, [
			{ id: 'permissionMode', value: permissionMode },
			{ id: 'permission_mode', value: permissionMode },
			...(caps.modes?.some(mode => mode.id === permissionMode) ? [{ id: 'mode', value: permissionMode }] : []),
		]);
		const sessionModeId = configOptions.length ? undefined : advertisedModeId(caps, [permissionMode]);
		return { configOptions, ...(sessionModeId ? { sessionModeId } : {}) };
	}

	normalize(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined {
		return normalizeAcpPermission(method, params, context);
	}

	toNativeResponse(decision: IAccessDecision, params: unknown): unknown {
		return acpPermissionResponse(decision, params);
	}
}
