/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWeb, isWindows } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'update',
	order: 15,
	title: localize('updateConfigurationTitle', "Update"),
	type: 'object',
	properties: {
		'update.mode': {
			type: 'string',
			enum: ['none', 'manual', 'start', 'default'],
			default: 'default',
			scope: ConfigurationScope.APPLICATION,
			description: localize('updateMode', "Configure whether you receive automatic updates. Requires a restart after change. The updates are fetched from a Microsoft online service."),
			tags: ['usesOnlineServices'],
			enumDescriptions: [
				localize('none', "Disable updates."),
				localize('manual', "Disable automatic background update checks. Updates will be available if you manually check for updates."),
				localize('start', "Check for updates only on startup. Disable automatic background update checks."),
				localize('default', "Enable automatic update checks. Code will check for updates automatically and periodically.")
			],
			policy: {
				name: 'UpdateMode',
				minimumVersion: '1.67',
			}
		},
		'update.channel': {
			type: 'string',
			default: 'default',
			scope: ConfigurationScope.APPLICATION,
			description: localize('updateMode', "Configure whether you receive automatic updates. Requires a restart after change. The updates are fetched from a Microsoft online service."),
			deprecationMessage: localize('deprecated', "This setting is deprecated, please use '{0}' instead.", 'update.mode')
		},
		'update.releaseChannel': {
			type: 'string',
			enum: ['default', 'stable', 'beta', 'nightly'],
			default: 'default',
			scope: ConfigurationScope.APPLICATION,
			title: localize('releaseChannelTitle', "Release Channel"),
			markdownDescription: localize('releaseChannel', "The Volt release channel to follow. Each channel is a separate app (Volt, Volt Beta, Volt Nightly) with its own settings folder, so choosing another channel offers its download instead of replacing this app. Updates are fetched from GitHub Releases."),
			enumDescriptions: [
				localize('releaseChannel.default', "Follow the channel this app was built for."),
				localize('releaseChannel.stable', "Tested releases."),
				localize('releaseChannel.beta', "Early access to the next release."),
				localize('releaseChannel.nightly', "Built every night from the main branch.")
			],
			tags: ['usesOnlineServices']
		},
		'update.enableWindowsBackgroundUpdates': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			title: localize('enableWindowsBackgroundUpdatesTitle', "Enable Background Updates on Windows"),
			description: localize('enableWindowsBackgroundUpdates', "Enable to download and install new VS Code versions in the background on Windows."),
			included: isWindows && !isWeb
		},
		'update.showReleaseNotes': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('showReleaseNotes', "Show Release Notes after an update. The Release Notes are fetched from a Microsoft online service."),
			tags: ['usesOnlineServices']
		}
	}
});
