/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Busy chats fold into a collapsed Working shelf and come back to the inbox when they need the user. */
export const AGENT_HOME_WORKING_SECTION_SETTING = 'volt.agent.home.workingSection';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.agent.home',
	title: localize('voltAgent.homeConfigTitle', "Agent Sidebar"),
	type: 'object',
	properties: {
		[AGENT_HOME_WORKING_SECTION_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.workingSection', "Move chats that are working, or waiting on their subagents, into a collapsed Working section below the active list. A chat comes back to the top when it finishes, fails, or needs an approval or an answer. Pinned chats stay pinned."),
		},
	},
});
