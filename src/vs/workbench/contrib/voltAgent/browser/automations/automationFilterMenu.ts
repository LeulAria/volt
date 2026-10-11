/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { AUTOMATION_RUN_TOOLS, AUTOMATION_TOOL_STATUSES, AutomationRunToolKind, AutomationToolStatus, RUN_STATUS_BUCKETS, RunStatusBucket } from '../../../../services/voltRuntime/common/automations/automations.js';
import { AUTOMATION_TRIGGER_GROUPS, AutomationTriggerGroup, triggerGroupLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { IVoltMenuHandle, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { providerIcon, statusIcon, toolKindIcon } from './automationIcons.js';

/** The filter the Run History table applies; the menu edits it in place. */
export interface IMutableRunFilter {
	readonly statuses: Set<RunStatusBucket>;
	readonly triggers: Set<AutomationTriggerGroup>;
	readonly tools: Map<AutomationRunToolKind, Set<AutomationToolStatus>>;
	text: string;
}

export function newRunFilter(): IMutableRunFilter {
	return { statuses: new Set(), triggers: new Set(), tools: new Map(), text: '' };
}

export function statusLabel(status: RunStatusBucket | AutomationToolStatus): string {
	switch (status) {
		case 'running': return localize('voltAutomations.running', "Running");
		case 'failed': return localize('voltAutomations.failed', "Failed");
		case 'succeeded': return localize('voltAutomations.succeeded', "Succeeded");
		case 'skipped': return localize('voltAutomations.skipped', "Skipped");
		case 'success': return localize('voltAutomations.success', "Success");
		case 'pending': return localize('voltAutomations.pending', "Pending");
	}
}

export function runToolLabel(kind: AutomationRunToolKind): string {
	switch (kind) {
		case 'pr_comment': return localize('voltAutomations.prComment', "PR Comment");
		case 'slack': return localize('voltAutomations.slack', "Slack");
		case 'slack_read': return localize('voltAutomations.readSlackShort', "Read Slack");
		case 'teams': return localize('voltAutomations.teams', "Microsoft Teams");
		case 'teams_read': return localize('voltAutomations.readTeamsShort', "Read Microsoft Teams");
		case 'pull_request': return localize('voltAutomations.pullRequest', "Pull Request");
		case 'reviewers': return localize('voltAutomations.reviewers', "Reviewers");
		case 'mcp': return localize('voltAutomations.mcp', "MCP");
		case 'memories': return localize('voltAutomations.memories', "Memories");
	}
}

type FilterPick =
	| { readonly kind: 'status'; readonly status: RunStatusBucket }
	| { readonly kind: 'trigger'; readonly group: AutomationTriggerGroup }
	| { readonly kind: 'tool'; readonly tool: AutomationRunToolKind; readonly status: AutomationToolStatus }
	| { readonly kind: 'clear' }
	| { readonly kind: 'none' };

function toggle<T>(set: Set<T>, value: T): void {
	if (set.has(value)) {
		set.delete(value);
	} else {
		set.add(value);
	}
}

function badge(count: number): { badge?: string } {
	return count ? { badge: String(count) } : {};
}

/**
 * Filter by: Status, Trigger or Tools, each a flyout of checks (a Tools row opens to its
 * statuses). Picks toggle, the menu stays open and the table follows at once; a row's chip counts
 * what is picked under it.
 */
export function showRunFilterMenu(contextView: IContextViewService, anchor: HTMLElement, filter: IMutableRunFilter, onChange: () => void): IVoltMenuHandle {
	const none: FilterPick = { kind: 'none' };
	const clear: FilterPick = { kind: 'clear' };
	const toolCount = (kind?: AutomationRunToolKind) => kind ? filter.tools.get(kind)?.size ?? 0 : [...filter.tools.values()].reduce((sum, set) => sum + set.size, 0);
	const statusItems = (): IVoltMenuSection<FilterPick>[] => [{
		id: 'status',
		items: RUN_STATUS_BUCKETS.map(status => ({ id: status, label: statusLabel(status), icon: () => statusIcon(status), checked: filter.statuses.has(status), keepOpen: true, data: { kind: 'status', status } })),
	}];
	const triggerItems = (): IVoltMenuSection<FilterPick>[] => [{
		id: 'trigger',
		items: AUTOMATION_TRIGGER_GROUPS.map(group => ({ id: group, label: triggerGroupLabel(group), icon: () => providerIcon(group), checked: filter.triggers.has(group), keepOpen: true, data: { kind: 'trigger', group } })),
	}];
	const toolItems = (): IVoltMenuSection<FilterPick>[] => [{
		id: 'tools',
		items: AUTOMATION_RUN_TOOLS.map(tool => ({
			id: tool,
			label: runToolLabel(tool),
			icon: () => toolKindIcon(tool),
			...badge(toolCount(tool)),
			data: none,
			submenu: {
				width: 180,
				sections: () => [{
					id: `${tool}-status`,
					items: AUTOMATION_TOOL_STATUSES.map(status => ({ id: status, label: statusLabel(status), icon: () => statusIcon(status), checked: !!filter.tools.get(tool)?.has(status), keepOpen: true, data: { kind: 'tool', tool, status } })),
				}],
			},
		})),
	}];
	const active = () => filter.statuses.size + filter.triggers.size + toolCount() > 0;
	anchor.classList.add('open');
	const handle: IVoltMenuHandle = showVoltMenu<FilterPick>(contextView, {
		anchor,
		align: 'right',
		gap: 6,
		width: 220,
		className: 'volt-auto-menu volt-auto-filter-menu',
		ariaLabel: localize('voltAutomations.filterBy', "Filter by"),
		sections: () => [
			{
				id: 'filters',
				title: localize('voltAutomations.filterBy', "Filter by"),
				items: [
					{ id: 'status', label: localize('voltAutomations.status', "Status"), ...badge(filter.statuses.size), data: none, submenu: { width: 180, sections: () => statusItems() } },
					{ id: 'trigger', label: localize('voltAutomations.trigger', "Trigger"), ...badge(filter.triggers.size), data: none, submenu: { width: 220, search: { placeholder: localize('voltAutomations.searchTrigger', "Search trigger...") }, sections: () => triggerItems() } },
					{ id: 'tools', label: localize('voltAutomations.tools', "Tools"), ...badge(toolCount()), data: none, submenu: { width: 240, sections: () => toolItems() } },
				],
			},
			...(active() ? [{ id: 'clear', items: [{ id: 'clear', label: localize('voltAutomations.clearFilters', "Clear Filters"), icon: Codicon.clearAll, keepOpen: true, data: clear }] }] : []),
		],
		onPick: item => {
			const pick = item.data;
			switch (pick.kind) {
				case 'status': toggle(filter.statuses, pick.status); break;
				case 'trigger': toggle(filter.triggers, pick.group); break;
				case 'tool': {
					const set = filter.tools.get(pick.tool) ?? new Set<AutomationToolStatus>();
					filter.tools.set(pick.tool, set);
					toggle(set, pick.status);
					break;
				}
				case 'clear':
					filter.statuses.clear();
					filter.triggers.clear();
					filter.tools.clear();
					break;
				case 'none':
					return;
			}
			onChange();
			handle.refresh();
		},
		onHide: () => anchor.classList.remove('open'),
	});
	return handle;
}
