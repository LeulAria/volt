/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Busy chats fold into a collapsed Working shelf and come back to the inbox when they need the user. */
export const AGENT_HOME_WORKING_SECTION_SETTING = 'volt.agent.home.workingSection';

/** Days a chat sits idle before it moves to Settled on its own; 0 turns that off. */
export const AGENT_HOME_AUTO_SETTLE_DAYS_SETTING = 'volt.agent.home.autoSettleDays';

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
		[AGENT_HOME_AUTO_SETTLE_DAYS_SETTING]: {
			type: 'number',
			default: 3,
			minimum: 0,
			description: localize('voltAgent.autoSettleDays', "Move a chat to Settled after it sits this many days without a message from you. Running chats, chats waiting on an approval, an answer or their subagents, unsent drafts, and chats with Auto-settle turned off stay put. Set to 0 to turn this off."),
		},
	},
});
