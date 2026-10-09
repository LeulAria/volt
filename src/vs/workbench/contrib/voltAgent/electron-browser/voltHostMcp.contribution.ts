/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltBrowserService, VOLT_BROWSER_CHANNEL_NAME } from '../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltHostMcpService, VOLT_HOST_MCP_CHANNEL_NAME } from '../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { agentServerEnabled } from '../../../services/voltAgentServer/common/agentServerClient.js';
import { VoltHostMcpBridge } from '../common/voltHostMcpBridge.js';
// The device and window capture host tools (and their UI) are served on this window's MCP server too.
import './voltDevices.contribution.js';

registerMainProcessRemoteService(IVoltHostMcpService, VOLT_HOST_MCP_CHANNEL_NAME);
// The in-app browser's session and DevTools protocol live in the main process too.
registerMainProcessRemoteService(IVoltBrowserService, VOLT_BROWSER_CHANNEL_NAME);

/**
 * Serves Volt's host tools to the agents this window launches. The HTTP server lives in the main
 * process (the renderer is sandboxed). With the agent server on, agents run there and the server
 * serves the tools itself (the tools only a window has are forwarded to it).
 */
class VoltHostMcpContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltHostMcp';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		if (!agentServerEnabled(configurationService)) {
			this._register(instantiationService.createInstance(VoltHostMcpBridge));
		}
	}
}

registerWorkbenchContribution2(VoltHostMcpContribution.ID, VoltHostMcpContribution, WorkbenchPhase.AfterRestored);
