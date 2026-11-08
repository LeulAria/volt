/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { OPEN_AUTOMATIONS_IN_TOOLS_COMMAND_ID, OPEN_WORKFLOWS_IN_TOOLS_COMMAND_ID } from '../../voltAgent/browser/workspace/agentSurfaceMenu.js';
import { CLAUDE_ACCOUNTS_FEATURE_ID } from '../../voltClaudeAccounts/common/voltClaudeAccounts.js';
import {
	AUTOMATIONS_EDITOR_INPUT_TYPE_ID, AUTOMATIONS_FEATURE_ID, NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_COMMAND_ID,
	OPEN_AUTOMATIONS_ROUTE_COMMAND_ID,
} from '../../voltAutomations/common/voltAutomations.js';
import { REMOTE_DEVICES_FEATURE_ID } from '../../voltRemoteDevices/common/voltRemoteDevices.js';
import { OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID, SKILLS_EDITOR_INPUT_TYPE_ID, SKILLS_FEATURE_ID } from '../../voltSkills/common/voltSkills.js';
import { IVoltFeatureModuleEntry } from './voltFeatureModules.js';

const AGENT_CATEGORY = localize2('voltAgent.category', "Agent");

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
		feature: AUTOMATIONS_FEATURE_ID,
		load: async () => (await import('../../voltAutomations/browser/voltAutomations.module.js')).voltAutomationsModule,
		commands: [
			{ id: OPEN_AUTOMATIONS_COMMAND_ID, visibility: 'public', f1: true, title: localize2('voltAutomations.open', "Show Automations"), category: AGENT_CATEGORY },
			{ id: NEW_AUTOMATION_COMMAND_ID, f1: true, title: localize2('voltAutomations.newCommand', "New Automation…"), category: AGENT_CATEGORY },
			{ id: OPEN_AUTOMATION_RUNS_COMMAND_ID, visibility: 'public', f1: true, title: localize2('voltAutomations.runsCommand', "Show All Automation Runs"), category: AGENT_CATEGORY },
			{ id: OPEN_AUTOMATIONS_ROUTE_COMMAND_ID },
			{ id: OPEN_AUTOMATIONS_IN_TOOLS_COMMAND_ID, visibility: 'public' },
			{ id: OPEN_WORKFLOWS_IN_TOOLS_COMMAND_ID, visibility: 'public' },
		],
		editors: [AUTOMATIONS_EDITOR_INPUT_TYPE_ID],
	},
	{
		// No commands or editors: Providers & Models asks for its section. The broker is core.
		feature: CLAUDE_ACCOUNTS_FEATURE_ID,
		load: async () => (await import('../../voltClaudeAccounts/browser/voltClaudeAccounts.module.js')).voltClaudeAccountsModule,
	},
	{
		// No commands or editors: Volt Settings asks for its page. Pair a Phone or Browser is core.
		feature: REMOTE_DEVICES_FEATURE_ID,
		load: async () => (await import('../../voltRemoteDevices/browser/voltRemoteDevices.module.js')).voltRemoteDevicesModule,
	},
	{
		feature: SKILLS_FEATURE_ID,
		load: async () => (await import('../../voltSkills/browser/voltSkills.module.js')).voltSkillsModule,
		commands: [
			{ id: OPEN_SKILLS_COMMAND_ID, visibility: 'public', f1: true, title: localize2('voltAgent.customize', "Customize Agent"), category: Categories.View },
			{ id: OPEN_SKILLS_MARKETPLACE_COMMAND_ID, visibility: 'public', f1: true, title: localize2('voltAgent.marketplace', "Browse Skills and Plugins Marketplace"), category: Categories.View },
		],
		editors: [SKILLS_EDITOR_INPUT_TYPE_ID],
	},
];
