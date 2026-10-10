/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltDesktopService, VOLT_DESKTOP_CHANNEL_NAME } from '../../../../platform/voltDesktop/common/voltDesktop.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AgentDesktopTools } from '../browser/desktop/agentDesktopTools.js';

registerMainProcessRemoteService(IVoltDesktopService, VOLT_DESKTOP_CHANNEL_NAME);

/** Offers the desktop_* tools (reading and driving other apps on a Mac) to the window's agents. */
class VoltDesktopContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltDesktop';

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._register(instantiationService.createInstance(AgentDesktopTools));
	}
}

registerWorkbenchContribution2(VoltDesktopContribution.ID, VoltDesktopContribution, WorkbenchPhase.AfterRestored);
