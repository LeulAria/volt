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
import { VOLT_WINDOW_TRANSPARENCY_SETTING } from '../common/agentAppearanceSettings.js';
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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();
		this.apply();
		this._register(onDidChangeLayoutMode(() => this.apply()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.sideBar.location') || e.affectsConfiguration(VOLT_WINDOW_TRANSPARENCY_SETTING)) {
				this.apply();
			}
		}));
	}

	/**
	 * The see-through material (vibrancy / acrylic) is opt-in: it costs GPU memory. Without it the
	 * window paints the theme background, and `volt-window-transparent` missing from the workbench
	 * makes the agent layout's translucent fills opaque (agentHomePane.css).
	 */
	private apply(): void {
		const transparent = getLayoutMode(this.layoutService) === 'agent' && this.configurationService.getValue<boolean>(VOLT_WINDOW_TRANSPARENCY_SETTING) === true;
		this.layoutService.mainContainer.classList.toggle('volt-window-transparent', transparent);
		void this.nativeHostService.setWindowTransparentChrome(transparent);
	}
}

registerWorkbenchContribution2(VoltAgentWindowChromeContribution.ID, VoltAgentWindowChromeContribution, WorkbenchPhase.AfterRestored);
