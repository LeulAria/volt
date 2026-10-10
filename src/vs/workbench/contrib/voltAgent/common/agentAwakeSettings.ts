/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { AWAKE_BATTERY_FLOOR_SETTING, AWAKE_GRACE_MINUTES_SETTING, AWAKE_LID_CLOSED_MODE_SETTING, AWAKE_MAX_HOURS_SETTING, AWAKE_WHILE_AGENTS_WORK_SETTING, DEFAULT_AWAKE_PREFS } from '../../../../platform/voltAwake/common/voltAwake.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.awake',
	title: localize('voltAwake.configTitle', "Lid-Closed Mode"),
	type: 'object',
	properties: {
		[AWAKE_WHILE_AGENTS_WORK_SETTING]: {
			type: 'boolean',
			default: DEFAULT_AWAKE_PREFS.whileAgentsWork,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAwake.whileAgentsWork', "Keep the computer from going to sleep while an agent is working, and for a short while after."),
		},
		[AWAKE_LID_CLOSED_MODE_SETTING]: {
			type: 'boolean',
			default: DEFAULT_AWAKE_PREFS.lidClosedMode,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAwake.lidClosedMode', "Lid-Closed Mode: agents keep working when you close the laptop lid. It lets go when agents finish, when the battery runs low, if the computer gets too hot, or after the time limit. On macOS it needs a one-time administrator approval. Use it on a hard, ventilated surface, never in a bag."),
		},
		[AWAKE_GRACE_MINUTES_SETTING]: {
			type: 'number',
			default: DEFAULT_AWAKE_PREFS.graceMinutes,
			minimum: 0,
			maximum: 60,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAwake.graceMinutes', "Minutes the computer stays awake after the last agent finishes, so queued messages and subagent reports still land."),
		},
		[AWAKE_MAX_HOURS_SETTING]: {
			type: 'number',
			default: DEFAULT_AWAKE_PREFS.maxHours,
			minimum: 1,
			maximum: 72,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAwake.maxHours', "Lid-Closed Mode lets the computer sleep after agents have worked this many hours without a break."),
		},
		[AWAKE_BATTERY_FLOOR_SETTING]: {
			type: 'number',
			default: DEFAULT_AWAKE_PREFS.batteryFloorPercent,
			minimum: 0,
			maximum: 90,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAwake.batteryFloor', "On battery, Lid-Closed Mode lets the computer sleep below this charge (percent). 0 turns the floor off."),
		},
	},
});
