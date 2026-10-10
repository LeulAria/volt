/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
// Desktop-only: the app icon badge for chats that finished in the background.
import './voltBadge.contribution.js';
// Desktop-only: Lid-Closed Mode (stay awake while agents work, also with the lid shut).
import './voltAwake.contribution.js';
// Desktop-only Volt diagnostics (tracing, stall log, heap snapshots).
import '../../voltDiagnostics/electron-browser/voltDiagnostics.contribution.js';

class VoltAgentWindowChromeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWindowChrome';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();
		this.apply();
		this._register(onDidChangeLayoutMode(() => this.apply()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.sideBar.location')) {
				this.apply();
			}
		}));
	}

	private apply(): void {
		const agent = getLayoutMode(this.layoutService) === 'agent';
		void this.nativeHostService.setWindowTransparentChrome(agent);
	}
}

registerWorkbenchContribution2(VoltAgentWindowChromeContribution.ID, VoltAgentWindowChromeContribution, WorkbenchPhase.AfterRestored);
