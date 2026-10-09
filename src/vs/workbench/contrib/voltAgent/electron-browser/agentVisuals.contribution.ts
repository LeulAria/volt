/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltVisualPreviewService, VOLT_VISUAL_PREVIEW_CHANNEL_NAME } from '../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { disposeLiveVisuals } from '../browser/visuals/agentVisuals.js';
import { AgentVisualToolProvider } from '../browser/visuals/agentVisualTools.js';

// Pages are measured and screenshotted offscreen in the main process.
registerMainProcessRemoteService(IVoltVisualPreviewService, VOLT_VISUAL_PREVIEW_CHANNEL_NAME);

/** Puts render_chart, render_html and preview_html on Volt's MCP server, before any agent connects. */
class AgentVisualsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentVisuals';

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const provider = this._register(instantiationService.createInstance(AgentVisualToolProvider));
		this._register(hostTools.registerToolProvider(provider));
		this._register(disposeLiveVisuals());
	}
}

registerWorkbenchContribution2(AgentVisualsContribution.ID, AgentVisualsContribution, WorkbenchPhase.BlockRestore);
