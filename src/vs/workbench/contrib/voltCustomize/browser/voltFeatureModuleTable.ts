/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { AGENT_RESOURCES_SECTIONS } from '../../voltAgent/browser/resources/agentResourcesPage.js';
import { AGENT_RESOURCES_FEATURE_ID, AGENT_RESOURCES_INPUT_ID, OPEN_AGENT_RESOURCES_COMMAND_ID } from '../../voltAgentResources/common/voltAgentResources.js';
import { CODE_INTELLIGENCE_FEATURE_ID } from '../../voltCodeIntelligence/common/voltCodeIntelligence.js';
import { AGENT_USAGE_INPUT_ID, OPEN_AGENT_USAGE_COMMAND_ID, USAGE_FEATURE_ID } from '../../voltUsage/common/voltUsage.js';
import { IVoltFeatureModuleEntry } from './voltFeatureModules.js';

/**
 * Volt's feature modules: one entry per built-in extension whose `voltModule.entry` names a
 * feature folder. This is the only file that may import a feature's module entry
 * (`contrib/volt<Feature>/browser/volt<Feature>.module.ts`); the import lint checks it. The
 * import is dynamic, so the module's code runs when the feature is first used.
 *
 * Keep one entry per feature, in the manifests' order; each M3 feature adds its own.
 */
export const VOLT_FEATURE_MODULES: readonly IVoltFeatureModuleEntry[] = [
	{
		feature: AGENT_RESOURCES_FEATURE_ID,
		load: async () => (await import('../../voltAgentResources/browser/voltAgentResources.module.js')).agentResourcesModule,
		commands: [
			{ id: OPEN_AGENT_RESOURCES_COMMAND_ID, title: localize2('agentResources.open', "Open Agent Resources"), category: Categories.View, f1: true, visibility: 'public' },
			// Shortcuts into each section.
			...AGENT_RESOURCES_SECTIONS.filter(section => section.id !== 'overview').map(section => ({
				id: `${OPEN_AGENT_RESOURCES_COMMAND_ID}.${section.id}`,
				title: { value: localize('agentResources.openSection', "Agent Resources: {0}", section.label), original: `Agent Resources: ${section.label}` },
				f1: true,
				visibility: 'public' as const,
			})),
		],
		editors: [AGENT_RESOURCES_INPUT_ID],
	},
	{
		feature: CODE_INTELLIGENCE_FEATURE_ID,
		load: async () => (await import('../../voltCodeIntelligence/browser/voltCodeIntelligence.module.js')).codeIntelligenceModule,
		// Its tools serve agents, which may call them before anyone opens its page.
		activation: 'startup',
	},
	{
		feature: USAGE_FEATURE_ID,
		load: async () => (await import('../../voltUsage/browser/voltUsage.module.js')).usageModule,
		commands: [{ id: OPEN_AGENT_USAGE_COMMAND_ID, title: localize2('voltAgent.usage', "Show Agent Usage and Limits"), category: Categories.View, f1: true, visibility: 'public' }],
		editors: [AGENT_USAGE_INPUT_ID],
	},
];
