/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IVoltBadgeService, VOLT_BADGE_CHANNEL_NAME } from '../../../../platform/voltBadge/common/voltBadge.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AGENT_BADGE_SETTING } from '../common/agentThreadAttention.js';
import { IAgentThreadAttentionService } from '../browser/attention/agentThreadAttention.js';

registerMainProcessRemoteService(IVoltBadgeService, VOLT_BADGE_CHANNEL_NAME);

/** This window's share of the app icon badge: its chats that finished out of sight. */
class VoltBadgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltBadge';

	private sent: number | undefined;

	constructor(
		@IVoltBadgeService private readonly badge: IVoltBadgeService,
		@IAgentThreadAttentionService private readonly attention: IAgentThreadAttentionService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// A reloaded window starts from nothing; the count it had before the reload goes.
		this.sync(true);
		this._register(this.attention.onDidChange(() => this.sync()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_BADGE_SETTING)) {
				this.sync();
			}
		}));
	}

	private sync(force = false): void {
		const enabled = this.configurationService.getValue<boolean>(AGENT_BADGE_SETTING) !== false;
		const count = enabled ? this.attention.unreadCount : 0;
		if (!force && count === this.sent) {
			return;
		}
		this.sent = count;
		this.badge.setCount(this.nativeHostService.windowId, count).catch(err => this.logService.warn('[volt] app badge update failed', err));
	}
}

registerWorkbenchContribution2(VoltBadgeContribution.ID, VoltBadgeContribution, WorkbenchPhase.AfterRestored);
