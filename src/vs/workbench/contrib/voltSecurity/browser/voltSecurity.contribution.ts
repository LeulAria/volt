/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SANDBOX_SUPERVISOR_SETTING } from '../../../../platform/voltSandbox/common/sandboxWorkloads.js';

/**
 * Volt's Security page (spec M.3 C5): the sandboxed processes section is
 * `sandboxWorkloadsSection.ts`, drawn on Volt Settings' Security page. This registers the
 * supervisor's rollback flag.
 */

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.sandbox.supervisor',
	title: localize('voltSecurity.supervisor.title', "Sandbox Supervisor"),
	type: 'object',
	properties: {
		[SANDBOX_SUPERVISOR_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltSecurity.supervisor.enabled', "Run long-lived sandboxed hosts (plugin hosts, helpers) under Volt's supervisor, which restarts them after a crash, stops idle ones and ends them when Volt quits. When off, no sandboxed host starts. Takes effect for hosts started after the change; reaping hosts left by a crash needs a restart."),
		},
	},
});
