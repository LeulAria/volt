/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { AGENT_STATUS_BAR_VISIBLE_KEY } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { activeAgentSessionId } from '../editor/agentSessionCommands.js';
import { AGENT_RUN_SHOW_IN_VOLT_SETTING, AGENT_RUN_STATUS_ITEMS_SETTING } from '../../common/agentRunSettings.js';
import { AGENT_RUN_START_COMMAND_ID, IAgentRunService } from './agentRunService.js';
import './agentRunToolbar.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.agent.run',
	title: localize('agentRun.configTitle', "Agent Run and Debug"),
	type: 'object',
	properties: {
		[AGENT_STATUS_BAR_VISIBLE_KEY]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('agentRun.statusBar', "Show the status bar at the bottom of the agent window, as in the IDE layout. Off, extensions' status bar items (Live Server's Go Live, the Flutter device) still show under Run in the chat side toolbar. `#workbench.statusBar.visible#` turned off hides it in both layouts."),
			tags: ['statusBar'],
		},
		[AGENT_RUN_STATUS_ITEMS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentRun.statusItems.setting', "Show the status bar items extensions add (Live Server's Go Live, the Flutter device) under Run in the chat side toolbar."),
			tags: ['statusBar'],
		},
		[AGENT_RUN_SHOW_IN_VOLT_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentRun.showInVolt', "Show simulators and emulators that a run, a debug session or an agent starts in Volt's device panel beside the chat, and open local pages (a run's dev server, a localhost page an extension or debug session opens) in Volt's browser instead of the system browser."),
		},
	},
});

function target(accessor: ServicesAccessor) {
	const runService = accessor.get(IAgentRunService);
	return { runService, target: runService.targetFor(activeAgentSessionId(accessor)) };
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: AGENT_RUN_START_COMMAND_ID, visibility: 'internal', title: localize2('agentRun.start', "Run Project"), category: localize2('volt', "Volt"), f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> | void {
		const { runService, target: runTarget } = target(accessor);
		return runTarget && runService.start(runTarget);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agent.run.pick', visibility: 'internal', title: localize2('agentRun.pick', "Select How to Run the Project"), category: localize2('volt', "Volt"), f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> | void {
		const { runService, target: runTarget } = target(accessor);
		return runTarget && runService.pickRunner(runTarget);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agent.run.pickDevice', visibility: 'internal', title: localize2('agentRun.pickDeviceCommand', "Select a Device to Run On"), category: localize2('volt', "Volt"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { runService, target: runTarget } = target(accessor);
		if (runTarget) {
			await runService.pickDevice(runTarget);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agent.run.askAgent', visibility: 'internal', title: localize2('agentRun.askAgentCommand', "Let Agent Debug and Run the App"), category: localize2('volt', "Volt"), f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> | void {
		const { runService, target: runTarget } = target(accessor);
		return runTarget && runService.askAgent(runTarget);
	}
});
