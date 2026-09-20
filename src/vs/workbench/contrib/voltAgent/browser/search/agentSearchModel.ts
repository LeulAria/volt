/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { matchesFuzzy2 } from '../../../../../base/common/filters.js';
import { localize } from '../../../../../nls.js';

export type AgentSearchFilter = 'all' | 'agents' | 'files' | 'actions' | 'settings';

export const AGENT_SEARCH_FILTERS: readonly AgentSearchFilter[] = ['all', 'agents', 'files', 'actions', 'settings'];

export const AGENT_SEARCH_FILTER_LABELS: Record<AgentSearchFilter, string> = {
	all: localize('voltAgent.search.filterAll', "All"),
	agents: localize('voltAgent.search.filterAgents', "Agents"),
	files: localize('voltAgent.search.filterFiles', "Files"),
	actions: localize('voltAgent.search.filterActions', "Actions"),
	settings: localize('voltAgent.search.filterSettings', "Settings"),
};

export interface IAgentSearchItem {
	readonly id: string;
	readonly kind: 'agent' | 'file' | 'action' | 'setting';
	readonly label: string;
	readonly meta?: string;
	readonly extra?: string;
}

export interface IAgentSearchSection {
	readonly title: string;
	readonly items: readonly IAgentSearchItem[];
}

const RECENT_LIMIT = 5;
const ALL_QUERY_LIMIT = 6;

export function nextSearchFilter(current: AgentSearchFilter): AgentSearchFilter {
	return AGENT_SEARCH_FILTERS[(AGENT_SEARCH_FILTERS.indexOf(current) + 1) % AGENT_SEARCH_FILTERS.length];
}

export function previousSearchFilter(current: AgentSearchFilter): AgentSearchFilter {
	return AGENT_SEARCH_FILTERS[(AGENT_SEARCH_FILTERS.indexOf(current) + AGENT_SEARCH_FILTERS.length - 1) % AGENT_SEARCH_FILTERS.length];
}

export function matchesSearchQuery(query: string, ...fields: string[]): boolean {
	const needle = query.trim();
	if (!needle) {
		return true;
	}
	return fields.some(field => !!field && !!matchesFuzzy2(needle, field));
}

export function agentSearchTitle(session: { title: string; preview: string; id: string }): string {
	return session.title.trim() || session.preview.trim() || session.id;
}

export function fileParentPath(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
	const index = normalized.lastIndexOf('/');
	return index <= 0 ? '' : normalized.slice(0, index);
}

export function settingDisplayName(key: string, description?: string): string {
	if (!description) {
		return key;
	}
	const first = description.replace(/[`*]/g, '').split('\n')[0].trim();
	if (first.length > 0 && first.length <= 72) {
		return first.endsWith('.') ? first.slice(0, -1) : first;
	}
	return key;
}

export function formatCompactAge(from: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - from) / 1000));
	if (seconds < 60) {
		return localize('voltAgent.search.now', "now");
	}
	if (seconds < 3600) {
		return `${Math.floor(seconds / 60)}m`;
	}
	if (seconds < 86400) {
		return `${Math.floor(seconds / 3600)}h`;
	}
	if (seconds < 86400 * 7) {
		return `${Math.floor(seconds / 86400)}d`;
	}
	if (seconds < 86400 * 30) {
		return `${Math.floor(seconds / (86400 * 7))}w`;
	}
	if (seconds < 86400 * 365) {
		return `${Math.floor(seconds / (86400 * 30))}mo`;
	}
	return `${Math.floor(seconds / (86400 * 365))}y`;
}

export function flattenSearchItems(sections: readonly IAgentSearchSection[]): IAgentSearchItem[] {
	return sections.flatMap(section => section.items);
}

export function buildSearchSections(
	filter: AgentSearchFilter,
	query: string,
	agents: readonly IAgentSearchItem[],
	files: readonly IAgentSearchItem[],
	actions: readonly IAgentSearchItem[],
	settings: readonly IAgentSearchItem[],
): IAgentSearchSection[] {
	const searching = !!query.trim();
	const recent = filter === 'all' && !searching;
	const limit = recent ? RECENT_LIMIT : filter === 'all' ? ALL_QUERY_LIMIT : Number.POSITIVE_INFINITY;
	const sections: IAgentSearchSection[] = [];

	if (filter === 'all' || filter === 'agents') {
		pushSection(sections, !searching && (filter === 'all' || filter === 'agents')
			? localize('voltAgent.search.recentAgents', "Recent Agents")
			: localize('voltAgent.search.filterAgents', "Agents"), agents, limit);
	}
	if (filter === 'all' || filter === 'files') {
		pushSection(sections, !searching && (filter === 'all' || filter === 'files')
			? localize('voltAgent.search.recentFiles', "Recent Files")
			: localize('voltAgent.search.filterFiles', "Files"), files, limit);
	}
	if ((filter === 'all' && searching) || filter === 'actions') {
		pushSection(sections, localize('voltAgent.search.filterActions', "Actions"), actions, limit);
	}
	if ((filter === 'all' && searching) || filter === 'settings') {
		pushSection(sections, localize('voltAgent.search.filterSettings', "Settings"), settings, limit);
	}
	return sections;
}

function pushSection(sections: IAgentSearchSection[], title: string, items: readonly IAgentSearchItem[], limit: number): void {
	if (!items.length) {
		return;
	}
	sections.push({ title, items: items.slice(0, limit) });
}
