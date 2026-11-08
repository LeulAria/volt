/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './automationHooks.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAutomationService } from '../../../../services/voltRuntime/common/automations/automations.js';
import { AutomationService } from './automationService.js';

// The scheduler is core (it runs on volt-server too). The Automations pages and their commands are
// a module of the `volt.automations` built-in extension: `contrib/voltAutomations/`.
registerSingleton(IAutomationService, AutomationService, InstantiationType.Delayed);

/** Starts the clock and the webhook queue once the window is up (runs need the orchestrator and history). */
class AutomationsContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAutomations';
	constructor(@IAutomationService automations: IAutomationService) {
		void automations.whenReady;
	}
}
registerWorkbenchContribution2(AutomationsContribution.ID, AutomationsContribution, WorkbenchPhase.AfterRestored);
