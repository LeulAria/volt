/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltDesktopService, VOLT_COMPUTER_USE_ENABLED_SETTING, VOLT_DESKTOP_CHANNEL_NAME } from '../../../../platform/voltDesktop/common/voltDesktop.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AgentDesktopTools } from '../browser/desktop/agentDesktopTools.js';

registerMainProcessRemoteService(IVoltDesktopService, VOLT_DESKTOP_CHANNEL_NAME);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.computerUse',
	title: localize('voltComputerUse.configTitle', "Volt Computer Use"),
	type: 'object',
	properties: {
		[VOLT_COMPUTER_USE_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('voltComputerUse.enabled', "Let agents read and drive other apps on this computer (macOS, Windows and Linux) with the `desktop_*` tools: buttons and fields through accessibility, keys, menus, windows, drawing. Each chat still asks before it takes control. Off: agents do not get the tools, so nothing starts the helper."),
		},
	},
});

/** Offers the desktop_* tools (reading and driving other apps) to the window's agents, while `volt.computerUse.enabled` is on. */
class VoltDesktopContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltDesktop';

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._register(instantiationService.createInstance(AgentDesktopTools));
	}
}

registerWorkbenchContribution2(VoltDesktopContribution.ID, VoltDesktopContribution, WorkbenchPhase.AfterRestored);
