/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { AgentResourceGroupId, AgentResourceIconShapes, agentResourceGroup } from '../../common/agentResources.js';
import { IAgentResource } from './agentResourcesService.js';

/** Opens Agent Resources; args: a section id, and the folder it is about (a chat's worktree). */
export const OPEN_AGENT_RESOURCES_COMMAND_ID = 'volt.agent.openAgentResources';

/** The section that manages a group's files. */
export function agentResourcesSectionFor(group: AgentResourceGroupId): AgentResourcesSectionId {
	switch (group) {
		case 'instructions': return 'instructions';
		case 'skills': return 'skills';
		case 'subagents': return 'agents';
		case 'commands':
		case 'hooks': return 'workflows';
		case 'integrations': return 'integrations';
		case 'config': return 'harness';
	}
}

/** The Agent Resources page's sections, in the left nav's order. */
export type AgentResourcesSectionId = 'overview' | 'instructions' | 'skills' | 'agents' | 'integrations' | 'workflows' | 'marketplace' | 'harness';

export interface IAgentResourcesSection {
	readonly id: AgentResourcesSectionId;
	readonly label: string;
	readonly lead: string;
	readonly icon: AgentResourceIconShapes;
}

/** Lucide layout-grid (via Aria Icons). */
const OVERVIEW_ICON: AgentResourceIconShapes = [
	['rect', { width: 7, height: 7, x: 3, y: 3, rx: 1 }],
	['rect', { width: 7, height: 7, x: 14, y: 3, rx: 1 }],
	['rect', { width: 7, height: 7, x: 14, y: 14, rx: 1 }],
	['rect', { width: 7, height: 7, x: 3, y: 14, rx: 1 }],
];

/** Lucide store (via Aria Icons). */
const MARKETPLACE_ICON: AgentResourceIconShapes = [
	['path', { d: 'M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5' }],
	['path', { d: 'M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244' }],
	['path', { d: 'M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05' }],
];

/** Lucide gauge (via Aria Icons). */
const HARNESS_ICON: AgentResourceIconShapes = [
	['path', { d: 'm12 14 4-4' }],
	['path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' }],
];

export const AGENT_RESOURCES_SECTIONS: readonly IAgentResourcesSection[] = [
	{ id: 'overview', label: localize('agentResources.section.overview', "Overview"), lead: localize('agentResources.section.overviewLead', "Everything that shapes your agents in this project and on this machine, and what needs attention."), icon: OVERVIEW_ICON },
	{ id: 'instructions', label: localize('agentResources.section.instructions', "Instructions & Rules"), lead: localize('agentResources.section.instructionsLead', "What agents are told: AGENTS.md, CLAUDE.md, GEMINI.md and editor rules, for this project and for you."), icon: agentResourceGroup('instructions').icon },
	{ id: 'skills', label: localize('agentResources.section.skills', "Skills"), lead: localize('agentResources.section.skillsLead', "Procedures agents load when a task calls for them. Skills with scripts run code: review them like packages."), icon: agentResourceGroup('skills').icon },
	{ id: 'agents', label: localize('agentResources.section.agents', "Agents"), lead: localize('agentResources.section.agentsLead', "Specialized subagents, each with its own context, model and tools."), icon: agentResourceGroup('subagents').icon },
	{ id: 'integrations', label: localize('agentResources.section.integrations', "MCP & Integrations"), lead: localize('agentResources.section.integrationsLead', "The external tools agents can reach: MCP servers, plugins and extensions, and whether Volt connects them."), icon: agentResourceGroup('integrations').icon },
	{ id: 'workflows', label: localize('agentResources.section.workflows', "Hooks & Workflows"), lead: localize('agentResources.section.workflowsLead', "Reusable commands and prompts, lifecycle hooks that run code around agent actions, and CI workflows that run agents."), icon: agentResourceGroup('hooks').icon },
	{ id: 'marketplace', label: localize('agentResources.section.marketplace', "Marketplace"), lead: localize('agentResources.section.marketplaceLead', "Skills from skills.sh and plugins from trusted marketplaces."), icon: MARKETPLACE_ICON },
	{ id: 'harness', label: localize('agentResources.section.harness', "Harness"), lead: localize('agentResources.section.harnessLead', "How Volt runs agents: models, tools, orchestration, context, permissions and observability. Other harnesses' settings are shown, never changed."), icon: HARNESS_ICON },
];

export function agentResourcesSection(id: AgentResourcesSectionId): IAgentResourcesSection {
	return AGENT_RESOURCES_SECTIONS.find(section => section.id === id)!;
}

/** What a section is given to render with. */
export interface IAgentResourcesSectionContext {
	/** Cleared before every render of the page. */
	readonly store: DisposableStore;
	/** The project the page shows (a workspace folder or a chat's worktree). */
	readonly folder: URI | undefined;
	/** The home folder, for `~` paths and Global files. */
	readonly home: URI | undefined;
	/** Every discovered resource after the page's scope filter and search. */
	readonly items: readonly IAgentResource[];
	/** Every discovered resource, before filters (counts, load order). */
	readonly allItems: readonly IAgentResource[];
	/** Opens a file beside the page, in its right panel. */
	openResource(resource: URI): void;
	/** Opens two files side by side in the right panel. */
	openDiff(original: URI, modified: URI, label: string): void;
	navigate(section: AgentResourcesSectionId): void;
	/** Renders the page again (after a change the page cannot see, such as a setting). */
	rerender(): void;
}
