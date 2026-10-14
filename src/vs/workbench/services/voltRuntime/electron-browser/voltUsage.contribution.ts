/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltUsageService, VOLT_USAGE_ACCOUNT_DIRS_SETTING, VOLT_USAGE_CHANNEL_NAME } from '../../../../platform/voltUsage/common/voltUsage.js';

registerMainProcessRemoteService(IVoltUsageService, VOLT_USAGE_CHANNEL_NAME);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.usage',
	title: localize('voltUsage', "Volt Usage"),
	type: 'object',
	properties: {
		[VOLT_USAGE_ACCOUNT_DIRS_SETTING]: {
			type: 'object',
			scope: ConfigurationScope.APPLICATION,
			default: { claude: [], codex: [] },
			properties: {
				claude: { type: 'array', items: { type: 'string' }, description: localize('voltUsage.claudeDirs', "Extra Claude Code config directories (each a `CLAUDE_CONFIG_DIR`), one per account.") },
				codex: { type: 'array', items: { type: 'string' }, description: localize('voltUsage.codexDirs', "Extra Codex homes (each a `CODEX_HOME`), one per account.") },
			},
			additionalProperties: false,
			markdownDescription: localize('voltUsage.accountDirs', "Other Claude Code and Codex logins to include on the Usage page, besides each agent's default. Their limits are pooled with the default account's and their transcripts count toward cost. `CLAUDE_CONFIG_DIR` from your shell is included automatically. Paths may start with `~/`."),
		},
	},
});
