/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltAccessMode } from '../access/accessModes.js';
import { ApprovalOutcome, ApprovalPolicy, SandboxMode } from './protocol.js';

/**
 * Volt's access mode, expressed as DeepSeek's two knobs. There is no workspace picker:
 * the open folder is already the cwd.
 */
export function deepseekKnobs(mode: VoltAccessMode): { readonly sandbox: SandboxMode; readonly approval: ApprovalPolicy } {
	switch (mode) {
		case 'auto':
		case 'full-access':
			return { sandbox: 'danger-full-access', approval: 'never' };
		case 'auto-accept-edits':
		case 'supervised':
		default:
			return { sandbox: 'workspace-write', approval: 'ask' };
	}
}

export interface IApprovalStep {
	/** The human still has to answer. Fail closed if they never do. */
	readonly ask: boolean;
	readonly outcome?: ApprovalOutcome;
}

/**
 * One approval decision. Saved "always allow" rules settle before a prompt.
 * `ask` + `never` is an automatic allow. `ask` with nobody to answer is `unavailable`.
 */
export function resolveApproval(input: {
	readonly policy: ApprovalPolicy;
	readonly effect: 'allow' | 'deny' | 'ask';
	readonly cancelled?: boolean;
	readonly savedAllow?: boolean;
	readonly answererAvailable?: boolean;
}): IApprovalStep {
	if (input.cancelled) {
		return { ask: false, outcome: 'cancelled' };
	}
	if (input.savedAllow || input.effect === 'allow') {
		return { ask: false, outcome: 'allowed-once' };
	}
	if (input.effect === 'deny') {
		return { ask: false, outcome: 'rejected' };
	}
	if (input.policy === 'never') {
		return { ask: false, outcome: 'allowed-once' };
	}
	if (input.answererAvailable === false) {
		return { ask: false, outcome: 'unavailable' };
	}
	return { ask: true };
}
