/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVoltAccountsService, VOLT_ACCOUNTS_CHANNEL_NAME } from '../../../../platform/voltAccounts/common/voltAccounts.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../host/browser/host.js';
import { IAgentRuntimeService } from '../common/runtime.js';

registerMainProcessRemoteService(IVoltAccountsService, VOLT_ACCOUNTS_CHANNEL_NAME);

/** Says so when Volt moved Claude to another saved account, and re-reads who Claude is signed in as. */
class VoltClaudeAutoSwitchNotifier extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltClaudeAutoSwitchNotifier';

	constructor(
		@IVoltAccountsService accounts: IVoltAccountsService,
		@INotificationService notificationService: INotificationService,
		@IHostService hostService: IHostService,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
	) {
		super();
		this._register(accounts.onDidAutoSwitchClaudeAccount(event => {
			void runtime.refreshProviders();
			// Every window hears the switch; the one in front tells the user.
			if (!hostService.hasFocus) {
				return;
			}
			notificationService.notify({
				severity: Severity.Info,
				message: event.detail
					? localize('voltAccounts.autoSwitched', "Claude switched to {0}. {1} on {2}.", event.toEmail, event.detail, event.fromEmail ?? localize('voltAccounts.previous', "the previous account"))
					: localize('voltAccounts.autoSwitchedPlain', "Claude switched to {0}.", event.toEmail),
			});
		}));
	}
}

registerWorkbenchContribution2(VoltClaudeAutoSwitchNotifier.ID, VoltClaudeAutoSwitchNotifier, WorkbenchPhase.AfterRestored);
