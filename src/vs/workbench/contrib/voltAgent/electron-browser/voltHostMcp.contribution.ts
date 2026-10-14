/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltBrowserService, VOLT_BROWSER_CHANNEL_NAME } from '../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltHostMcpService, VOLT_HOST_MCP_CHANNEL_NAME } from '../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { VoltHostMcpBridge } from '../common/voltHostMcpBridge.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AGENT_SERVER_ENABLED_SETTING } from '../../../services/voltAgentServer/common/agentServerClient.js';

registerMainProcessRemoteService(IVoltHostMcpService, VOLT_HOST_MCP_CHANNEL_NAME);
// The in-app browser's session and DevTools protocol live in the main process too.
registerMainProcessRemoteService(IVoltBrowserService, VOLT_BROWSER_CHANNEL_NAME);

/** Serves the host tools to agents this window runs; with the agent server, the server does. */
class VoltHostMcpContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltHostMcp';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		if (configurationService.getValue(AGENT_SERVER_ENABLED_SETTING) !== true) {
			this._register(instantiationService.createInstance(VoltHostMcpBridge));
		}
	}
}

registerWorkbenchContribution2(VoltHostMcpContribution.ID, VoltHostMcpContribution, WorkbenchPhase.AfterRestored);
