/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltWorktreeLimits } from '../../../../platform/voltStorage/common/voltStorage.js';

/** How many checkouts `~/.volt/worktrees` keeps, across every project. */
export const WORKTREE_MAX_COUNT_SETTING = 'volt.worktrees.maxCount';
/** How many gigabytes they may take together; 0 turns the size limit off. */
export const WORKTREE_MAX_SIZE_GB_SETTING = 'volt.worktrees.maxTotalSizeGB';

export const WORKTREE_MAX_COUNT = { default: 25, min: 1, max: 500 } as const;
export const WORKTREE_MAX_SIZE_GB = { default: 50, min: 0, max: 10_000 } as const;

const GB = 1024 * 1024 * 1024;

function clamp(value: unknown, range: { readonly default: number; readonly min: number; readonly max: number }): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(range.min, Math.min(range.max, Math.round(value))) : range.default;
}

export function clampWorktreeMaxCount(value: unknown): number {
	return clamp(value, WORKTREE_MAX_COUNT);
}

export function clampWorktreeMaxSizeGB(value: unknown): number {
	return clamp(value, WORKTREE_MAX_SIZE_GB);
}

export function readWorktreeLimits(get: (key: string) => unknown): IVoltWorktreeLimits {
	return {
		maxCount: clampWorktreeMaxCount(get(WORKTREE_MAX_COUNT_SETTING)),
		maxBytes: clampWorktreeMaxSizeGB(get(WORKTREE_MAX_SIZE_GB_SETTING)) * GB,
	};
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.worktrees',
	title: localize('voltWorktrees.configTitle', "Worktrees"),
	type: 'object',
	properties: {
		[WORKTREE_MAX_COUNT_SETTING]: {
			type: 'number',
			default: WORKTREE_MAX_COUNT.default,
			minimum: WORKTREE_MAX_COUNT.min,
			maximum: WORKTREE_MAX_COUNT.max,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltWorktrees.maxCount', "Maximum number of Volt-managed worktrees to retain across all projects. Older worktrees are removed first; ones with uncommitted changes or a running agent stay."),
		},
		[WORKTREE_MAX_SIZE_GB_SETTING]: {
			type: 'number',
			default: WORKTREE_MAX_SIZE_GB.default,
			minimum: WORKTREE_MAX_SIZE_GB.min,
			maximum: WORKTREE_MAX_SIZE_GB.max,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltWorktrees.maxTotalSize', "Maximum total size in GB across all Volt-managed worktrees. Set to 0 to disable the size limit."),
		},
	},
});
