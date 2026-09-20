/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CapabilityGroup } from './lanes.js';
import { IIntent } from './intent.js';
import { IProjectChecks } from './verification.js';

/**
 * Environment understanding + capability resolver. The intent router grants groups from the
 * *request*; this takes groups away from the *world*. A chat that wants the browser still
 * cannot have it if Volt has no browser host, and a mission that wants git cannot have it
 * in a folder that is not a repository.
 *
 * Stripping happens here, not in the prompt. A tool the environment cannot support must
 * never appear in the schema list.
 */

export interface IEnvironmentUnderstanding {
	readonly hasWorkspace: boolean;
	readonly cwd?: string;
	readonly platform?: string;
	readonly shell?: string;
	readonly hasGit: boolean;
	readonly gitBranch?: string;
	readonly packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
	readonly languages: readonly string[];
	readonly checks: IProjectChecks;
	readonly hasBrowserHost: boolean;
	readonly hasNetwork: boolean;
	readonly hasMcp: boolean;
	readonly date?: string;
}

export interface ICapabilityResolution {
	readonly granted: readonly CapabilityGroup[];
	readonly denied: readonly { readonly group: CapabilityGroup; readonly reason: string }[];
}

export function understandEnvironment(partial: Partial<IEnvironmentUnderstanding> = {}): IEnvironmentUnderstanding {
	return {
		hasWorkspace: partial.hasWorkspace ?? false,
		hasGit: partial.hasGit ?? false,
		languages: partial.languages ?? [],
		checks: partial.checks ?? {},
		hasBrowserHost: partial.hasBrowserHost ?? false,
		hasNetwork: partial.hasNetwork ?? true,
		hasMcp: partial.hasMcp ?? false,
		...(partial.cwd ? { cwd: partial.cwd } : {}),
		...(partial.platform ? { platform: partial.platform } : {}),
		...(partial.shell ? { shell: partial.shell } : {}),
		...(partial.gitBranch ? { gitBranch: partial.gitBranch } : {}),
		...(partial.packageManager ? { packageManager: partial.packageManager } : {}),
		...(partial.date ? { date: partial.date } : {}),
	};
}

/**
 * Intersect the intent's granted groups with what this environment can actually do.
 * Mode policy has already tightened the intent; this can only tighten further.
 */
export function resolveCapabilities(intent: IIntent, env: IEnvironmentUnderstanding): ICapabilityResolution {
	const denied: { group: CapabilityGroup; reason: string }[] = [];
	const granted: CapabilityGroup[] = [];

	for (const group of intent.groups) {
		const reason = denyReason(group, env);
		if (reason) {
			denied.push({ group, reason });
		} else {
			granted.push(group);
		}
	}

	if (!granted.includes('meta')) {
		granted.push('meta');
	}

	return { granted, denied };
}

function denyReason(group: CapabilityGroup, env: IEnvironmentUnderstanding): string | undefined {
	switch (group) {
		case 'edit':
		case 'shell':
		case 'agents':
			return env.hasWorkspace ? undefined : 'No workspace is open.';
		case 'git':
			if (!env.hasWorkspace) {
				return 'No workspace is open.';
			}
			return env.hasGit ? undefined : 'This folder is not a git repository.';
		case 'browser':
			return env.hasBrowserHost ? undefined : 'No in-app browser host is available.';
		case 'web':
			return env.hasNetwork ? undefined : 'Network access is disabled.';
		case 'mcp':
			return env.hasMcp ? undefined : 'No MCP servers are connected.';
		case 'read':
		case 'search':
			return env.hasWorkspace || group === 'search' ? undefined : 'No workspace is open.';
		default:
			return undefined;
	}
}

export function environmentFacts(env: IEnvironmentUnderstanding): {
	cwd?: string;
	platform?: string;
	shell?: string;
	date?: string;
	gitBranch?: string;
} {
	return {
		...(env.cwd ? { cwd: env.cwd } : {}),
		...(env.platform ? { platform: env.platform } : {}),
		...(env.shell ? { shell: env.shell } : {}),
		...(env.date ? { date: env.date } : {}),
		...(env.gitBranch ? { gitBranch: env.gitBranch } : {}),
	};
}
