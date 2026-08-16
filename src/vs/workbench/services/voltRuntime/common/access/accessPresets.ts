/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltAccessMode } from './accessModes.js';
import { IPermissionRule } from './accessTypes.js';
import { modePolicy, VoltMode } from '../modes.js';

export const SYSTEM_HARD_DENY: readonly IPermissionRule[] = [
	{ action: 'shell', resource: 'rm -rf /', effect: 'deny', source: 'system' },
	{ action: 'shell', resource: 'rm -rf /*', effect: 'deny', source: 'system' },
	{ action: 'shell', resource: 'sudo rm -rf /', effect: 'deny', source: 'system' },
	{ action: 'shell', resource: 'git push --force*', effect: 'deny', source: 'system' },
	{ action: 'shell', resource: 'git push -f *', effect: 'deny', source: 'system' },
	{ action: 'git', resource: 'git push --force*', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '*.env', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '*.env.*', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '**/.env', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '**/.env.*', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '**/.ssh/**', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '**/id_rsa*', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '**/*.pem', effect: 'deny', source: 'system' },
	{ action: 'edit', resource: '*.env', effect: 'deny', source: 'system' },
	{ action: 'edit', resource: '**/.env', effect: 'deny', source: 'system' },
	{ action: 'edit', resource: '**/.ssh/**', effect: 'deny', source: 'system' },
	{ action: 'read', resource: '*.env.example', effect: 'allow', source: 'system' },
	{ action: 'read', resource: '**/.env.example', effect: 'allow', source: 'system' },
];

const SUPERVISED: readonly IPermissionRule[] = [
	{ action: 'read', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'search', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'question', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'edit', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'shell', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'git', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'mcp', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'browser', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'network', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'web', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'subagent', resource: '*', effect: 'ask', source: 'preset' },
];

const AUTO_ACCEPT_EDITS: readonly IPermissionRule[] = [
	{ action: 'read', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'search', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'question', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'edit', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'shell', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'git', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'mcp', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'browser', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'network', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'web', resource: '*', effect: 'ask', source: 'preset' },
	{ action: 'subagent', resource: '*', effect: 'ask', source: 'preset' },
];

const AUTO: readonly IPermissionRule[] = [
	{ action: 'read', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'search', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'question', resource: '*', effect: 'allow', source: 'preset' },
	{ action: 'edit', resource: '*', effect: 'allow', source: 'preset' },
	{ action: '*', resource: '*', effect: 'ask', source: 'preset' },
];

const FULL_ACCESS: readonly IPermissionRule[] = [
	{ action: '*', resource: '*', effect: 'allow', source: 'preset' },
];

export const ACCESS_PRESETS: Record<VoltAccessMode, readonly IPermissionRule[]> = {
	supervised: SUPERVISED,
	'auto-accept-edits': AUTO_ACCEPT_EDITS,
	auto: AUTO,
	'full-access': FULL_ACCESS,
};

export function presetRules(mode: VoltAccessMode): readonly IPermissionRule[] {
	return ACCESS_PRESETS[mode];
}

/**
 * Interaction-mode overlay. Can only tighten the effective policy.
 * Plan/Ask deny writes and mutating shell even under Full access.
 */
export function modeOverlay(mode: VoltMode): IPermissionRule[] {
	const policy = modePolicy(mode);
	const rules: IPermissionRule[] = [];
	if (!policy.allowWrites) {
		rules.push({ action: 'edit', resource: '*', effect: 'deny', source: 'overlay' });
	}
	if (!policy.allowTerminal) {
		rules.push({ action: 'shell', resource: '*', effect: 'deny', source: 'overlay' });
		rules.push({ action: 'git', resource: '*', effect: 'deny', source: 'overlay' });
	} else if (mode === 'plan') {
		rules.push({ action: 'shell', resource: '*', effect: 'deny', source: 'overlay' });
		rules.push({ action: 'git', resource: '*', effect: 'deny', source: 'overlay' });
	}
	if (!policy.allowMcp) {
		rules.push({ action: 'mcp', resource: '*', effect: 'deny', source: 'overlay' });
	} else if (mode === 'plan') {
		rules.push({ action: 'mcp', resource: '*', effect: 'deny', source: 'overlay' });
	}
	if (mode === 'plan' || mode === 'ask') {
		rules.push({ action: 'network', resource: '*', effect: 'deny', source: 'overlay' });
		rules.push({ action: 'browser', resource: '*', effect: 'deny', source: 'overlay' });
		rules.push({ action: 'web', resource: '*', effect: 'deny', source: 'overlay' });
		rules.push({ action: 'subagent', resource: '*', effect: 'deny', source: 'overlay' });
	}
	return rules;
}
