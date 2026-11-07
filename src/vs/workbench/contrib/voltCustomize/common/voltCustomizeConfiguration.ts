/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { VOLT_CUSTOMIZE_LAYOUT_SETTING, VOLT_CUSTOMIZE_LOOK_SETTING, VOLT_DEFAULT_LAYOUT_ID } from './voltCustomizeModel.js';
import { VOLT_LOOK_TOKENS, voltLookCssVariable, voltLookSettingId } from './voltLookTokens.js';

/**
 * The agent window's own surfaces as theme colors. Unset by default (the window derives them from
 * `sideBar.background`, as before); a theme, a look's `colors` or colorCustomizations can set them.
 */
export const VOLT_AGENT_BACKGROUND_COLOR = registerColor('voltAgent.background', null, localize('voltAgent.background', "Background of the agent window: the chat, the title bar and the tools. Unset, the side bar background is used."));
export const VOLT_AGENT_ACTIVITY_BAR_BACKGROUND_COLOR = registerColor('voltAgent.activityBarBackground', null, localize('voltAgent.activityBarBackground', "Background of the agent window's activity bar (the icon column a layout can turn on). Unset, the agent sidebar shows through."));
export const VOLT_AGENT_SIDEBAR_BACKGROUND_COLOR = registerColor('voltAgent.sidebarBackground', null, localize('voltAgent.sidebarBackground', "Background of the agent sidebar (the chat list on the left). Unset, a shade of the agent window background is used."));

const tokenProperties: Record<string, IConfigurationPropertySchema> = {};
for (const entry of VOLT_LOOK_TOKENS) {
	tokenProperties[voltLookSettingId(entry.id)] = {
		type: 'number',
		default: entry.default,
		minimum: entry.minimum,
		maximum: entry.maximum,
		// Window scope: a project may have its own look in .vscode/settings.json.
		scope: ConfigurationScope.WINDOW,
		markdownDescription: localize(
			{ key: 'voltLook.token', comment: ['{0} is what the value changes, {1} its unit, {2} the CSS variable name'] },
			"{0} In {1}. CSS: `{2}`.",
			entry.description,
			entry.unit === 'px' ? localize('voltLook.px', "pixels") : localize('voltLook.number', "a plain number"),
			voltLookCssVariable(entry.id),
		),
	};
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.look',
	order: 6,
	title: localize('voltLook.configTitle', "Volt Look"),
	type: 'object',
	properties: {
		[VOLT_CUSTOMIZE_LAYOUT_SETTING]: {
			type: 'string',
			default: VOLT_DEFAULT_LAYOUT_ID,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('voltCustomize.layout', "How the agent window is arranged: `volt/default`, `volt/focus`, `volt/review`, `volt/vscode`, `home/<name>` for `~/.volt/customize/layouts/<name>.json`, or `<extension id>/<id>` for a layout an extension contributes. Pick one in Settings > Customize Volt."),
		},
		[VOLT_CUSTOMIZE_LOOK_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('voltCustomize.look', "A look over the layout: `volt/soft`, `volt/compact`, `volt/square`, `home/<name>` for `~/.volt/customize/looks/<name>.json`, or `<extension id>/<id>`. Empty uses the layout's own. Values you set in `volt.look.*` always win."),
		},
		...tokenProperties,
	},
});
