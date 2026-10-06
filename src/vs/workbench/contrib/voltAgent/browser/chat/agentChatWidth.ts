/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentChatWidth.css';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { AGENT_CHAT_WIDTH_SETTING, agentChatWidthCss, resolveAgentChatWidth } from '../../common/agentChatWidth.js';

/** Set on the workbench root when the chat is not at its drawn width; agentChatWidth.css reads the variable. */
const CUSTOM_WIDTH_CLASS = 'volt-chat-width-custom';
const WIDTH_VARIABLE = '--volt-chat-max-width';

/**
 * `volt.chat.width`: how wide the transcript and the composer may grow. The default leaves the
 * chat's own CSS alone; any other width sets one variable on the workbench root, live.
 */
export class AgentChatWidthContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentChatWidth';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this.apply();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_CHAT_WIDTH_SETTING)) {
				this.apply();
			}
		}));
	}

	private apply(): void {
		const width = resolveAgentChatWidth(this.configurationService.getValue(AGENT_CHAT_WIDTH_SETTING));
		const root = this.layoutService.mainContainer;
		const custom = width.preset !== 'default';
		root.classList.toggle(CUSTOM_WIDTH_CLASS, custom);
		if (custom) {
			root.style.setProperty(WIDTH_VARIABLE, agentChatWidthCss(width));
		} else {
			root.style.removeProperty(WIDTH_VARIABLE);
		}
	}
}
