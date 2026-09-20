/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CapabilityGroup } from './lanes.js';
import { IIntent } from './intent.js';
import { AgentRole } from './orchestrator.js';
import { ITaskIntel } from './taskIntel.js';
import { IIntentSignals } from './intake.js';

/**
 * Tool intelligence. The model still *calls* tools; this decides which ones it is even allowed
 * to see, and in what order they are listed. Listing order is ranking: providers that honour
 * schema order (and models that skim) try the first tool they recognise, so putting `read_file`
 * ahead of `write_file` on an explore step is a real intervention.
 *
 * Speculative execution is limited to parallel-safe reads the planner is already sure the
 * step will need - typically the files the user attached. Anything more ambitious (guessing
 * a path and reading it before the model asks) is how you leak tokens into the wrong file.
 */

export interface IToolHint {
	readonly name: string;
	readonly group: CapabilityGroup;
	readonly parallelSafe: boolean;
	readonly score: number;
}

export interface IToolPlan {
	readonly hints: readonly IToolHint[];
	/** Tools the step is expected to start with. Shown in the work log, not forced. */
	readonly suggested: readonly string[];
	/** Attached paths that may be read before the first model call. */
	readonly speculate: readonly string[];
}

const ROLE_GROUPS: Readonly<Record<AgentRole, readonly CapabilityGroup[]>> = {
	explore: ['read', 'search', 'meta'],
	research: ['read', 'search', 'web', 'meta'],
	implement: ['read', 'search', 'edit', 'shell', 'git', 'meta'],
	verify: ['read', 'search', 'shell', 'browser', 'meta'],
	review: ['read', 'search', 'meta'],
	ui: ['read', 'search', 'edit', 'browser', 'meta'],
	debug: ['read', 'search', 'shell', 'edit', 'meta'],
	browser: ['read', 'browser', 'meta'],
	general: ['read', 'search', 'edit', 'shell', 'web', 'browser', 'git', 'mcp', 'agents', 'meta'],
};

const GROUP_TOOLS: Readonly<Record<CapabilityGroup, readonly string[]>> = {
	read: ['read_file', 'list_dir'],
	search: ['grep', 'glob'],
	edit: ['edit_file', 'write_file'],
	shell: ['shell'],
	web: ['web_search', 'web_fetch'],
	browser: ['browser_snapshot', 'browser_navigate'],
	git: ['git_status', 'git_diff', 'git_branch'],
	mcp: [],
	agents: ['task'],
	memory: [],
	meta: ['todo', 'finish', 'request_capabilities'],
};

export function planTools(intent: IIntent, intel: ITaskIntel, role: AgentRole, signals: IIntentSignals, attachments: readonly string[] = []): IToolPlan {
	const granted = new Set(intent.groups);
	const wantsLookup = intel.shape.lookup || signals.webRequired;
	const groups = wantsLookup && granted.has('web') && !ROLE_GROUPS[role].includes('web')
		? [...ROLE_GROUPS[role].slice(0, 2), 'web' as const, ...ROLE_GROUPS[role].slice(2)]
		: ROLE_GROUPS[role];
	const preferred = groups.filter(group => granted.has(group) || group === 'meta');
	const hints: IToolHint[] = [];

	preferred.forEach((group, index) => {
		for (const name of GROUP_TOOLS[group]) {
			hints.push({
				name,
				group,
				parallelSafe: group === 'read' || group === 'search' || group === 'web',
				score: round2(1 - index * 0.08 + boost(name, intent, intel, signals)),
			});
		}
	});

	hints.sort((a, b) => b.score - a.score);
	const suggested = hints.filter(hint => hint.group !== 'meta').slice(0, 4).map(hint => hint.name);
	const speculate = attachments.filter(path => looksLikePath(path)).slice(0, 3);

	return { hints, suggested, speculate };
}

/**
 * A speculative read is only legal when the path was named by the user and the tool is
 * parallel-safe. The runtime still has to authorise it through the access broker.
 */
export function speculativeReads(plan: IToolPlan): { name: 'read_file'; args: { path: string } }[] {
	if (!plan.hints.some(hint => hint.name === 'read_file' && hint.parallelSafe)) {
		return [];
	}
	return plan.speculate.map(path => ({ name: 'read_file' as const, args: { path } }));
}

function boost(name: string, intent: IIntent, intel: ITaskIntel, signals: IIntentSignals): number {
	let score = 0;
	if (name === 'web_search' && (signals.webRequired || intel.shape.lookup)) {
		score += 0.3;
	}
	if (name === 'web_fetch' && intel.shape.depth === 'full') {
		score += 0.2;
	}
	if ((name === 'browser_snapshot' || name === 'browser_navigate') && signals.browserRequired) {
		score += 0.25;
	}
	if (name === 'edit_file' && intent.lane !== 'chat' && intel.deliverables.length) {
		score += 0.1;
	}
	if (name === 'shell' && intel.successCriteria.some(criterion => criterion.evidence === 'test' || criterion.evidence === 'build' || criterion.evidence === 'typecheck')) {
		score += 0.15;
	}
	if (name === 'grep' && intent.referencesWorkspace) {
		score += 0.1;
	}
	return score;
}

function looksLikePath(value: string): boolean {
	return /[\\/]|\.[a-z0-9]{1,8}$/i.test(value);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
