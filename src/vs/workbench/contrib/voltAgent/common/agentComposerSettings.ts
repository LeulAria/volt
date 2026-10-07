/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Arrow Up in the agent composer brings back earlier prompts, newest first; Arrow Down walks back. */
export const AGENT_PROMPT_HISTORY_SETTING = 'volt.agent.composer.promptHistory';

/** New Agent reopens the project's chat that only holds unsent text, instead of starting another empty one. */
export const AGENT_NEW_CHAT_DRAFT_SETTING = 'volt.agent.composer.restoreUnsentDraft';

/** The model a new chat starts on (a catalog ref). Empty: the model picked last. A project's own default wins. */
export const AGENT_DEFAULT_MODEL_SETTING = 'volt.agent.defaultModel';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.agent.composer',
	title: localize('voltAgent.composerConfigTitle', "Agent Composer"),
	type: 'object',
	properties: {
		[AGENT_PROMPT_HISTORY_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.promptHistory', "Press Arrow Up in an empty agent composer to load your previous prompts. Arrow Down goes back to newer ones and then to the text you were typing."),
		},
		[AGENT_NEW_CHAT_DRAFT_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.restoreUnsentDraft', "When a new chat was left with text that was never sent, New Agent opens that chat again with the text still in the composer."),
		},
		[AGENT_DEFAULT_MODEL_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voltAgent.defaultModel', "The model new chats start on. Empty uses the model you picked last. A project's own default model wins over this."),
		},
	},
});
