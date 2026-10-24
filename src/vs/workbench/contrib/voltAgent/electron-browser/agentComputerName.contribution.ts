/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { setComputerName } from '../browser/usage/agentComputerName.js';

/** Hands the computer's name to the browser side (the title bar's machine label). */
class AgentComputerNameContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltComputerName';

	constructor(@INativeHostService nativeHostService: INativeHostService) {
		try {
			void nativeHostService.getComputerName().then(setComputerName, () => undefined);
		} catch {
			// Older main process without getComputerName. The fallback label stays.
		}
	}
}

registerWorkbenchContribution2(AgentComputerNameContribution.ID, AgentComputerNameContribution, WorkbenchPhase.BlockRestore);
