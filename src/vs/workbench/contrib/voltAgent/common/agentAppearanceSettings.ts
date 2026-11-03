/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/**
 * How much of the agent's tool work a chat shows. Compact folds each stretch of calls into one
 * line ("Edited 2 files, ran 2 commands"), standard lists a line per call, detailed draws edits
 * and commands as cards with their diff or output.
 */
export type AgentToolDensity = 'compact' | 'standard' | 'detailed';

export const AGENT_TOOL_DENSITIES: readonly AgentToolDensity[] = ['compact', 'standard', 'detailed'];

export const AGENT_TOOL_DENSITY_SETTING = 'volt.agent.toolCallDensity';

/** Code cards in replies wrap long lines instead of scrolling sideways. */
export const AGENT_CODE_WRAP_SETTING = 'volt.agent.codeBlockWordWrap';

/** Inline diffs take their line tints from the color theme; off leaves the lines untinted. */
export const AGENT_THEMED_DIFFS_SETTING = 'volt.agent.themedDiffBackgrounds';

/** The interface typeface; empty is the system font. */
export const VOLT_UI_FONT_FAMILY_SETTING = 'volt.appearance.uiFontFamily';

/** The tint mixed into the window's surfaces: its hue (0-360) and how strongly (0-100). */
export const VOLT_TINT_HUE_SETTING = 'volt.appearance.tintHue';
export const VOLT_TINT_INTENSITY_SETTING = 'volt.appearance.tintIntensity';

/** Translucent surfaces (the see-through agent window, its sidebar) paint opaque. */
export const VOLT_REDUCE_TRANSPARENCY_SETTING = 'volt.appearance.reduceTransparency';

/**
 * The agent window shows the desktop through its sidebar (macOS vibrancy, Windows acrylic). Off by
 * default: the see-through material costs GPU memory. Off, the window and its sidebar paint opaque.
 */
export const VOLT_WINDOW_TRANSPARENCY_SETTING = 'volt.appearance.windowTransparency';

export function readToolDensity(configurationService: IConfigurationService): AgentToolDensity {
	const value = configurationService.getValue<string>(AGENT_TOOL_DENSITY_SETTING);
	return AGENT_TOOL_DENSITIES.find(density => density === value) ?? 'compact';
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.appearance',
	title: localize('voltAppearance.configTitle', "Volt Appearance"),
	type: 'object',
	properties: {
		[AGENT_TOOL_DENSITY_SETTING]: {
			type: 'string',
			enum: [...AGENT_TOOL_DENSITIES],
			enumDescriptions: [
				localize('voltAppearance.density.compact', "Each stretch of tool calls folds into one summary line."),
				localize('voltAppearance.density.standard', "One line per tool call."),
				localize('voltAppearance.density.detailed', "Edits and commands as cards, open on their diff or output."),
			],
			default: 'compact',
			description: localize('voltAppearance.density', "How much detail agent chats show for tool calls."),
		},
		[AGENT_CODE_WRAP_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('voltAppearance.codeWrap', "Wrap long lines in agent conversation code blocks."),
		},
		[AGENT_THEMED_DIFFS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAppearance.themedDiffs', "Use the color theme's diff colors as line backgrounds in inline code diffs. Off leaves the lines untinted; the +/- markers keep their colors."),
		},
		[VOLT_UI_FONT_FAMILY_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voltAppearance.uiFontFamily', "The interface font family. Empty uses the system font."),
		},
		[VOLT_TINT_HUE_SETTING]: {
			type: 'number',
			default: 220,
			minimum: 0,
			maximum: 360,
			description: localize('voltAppearance.tintHue', "The hue of the tint mixed into Volt's surfaces."),
		},
		[VOLT_TINT_INTENSITY_SETTING]: {
			type: 'number',
			default: 0,
			minimum: 0,
			maximum: 100,
			description: localize('voltAppearance.tintIntensity', "How strongly the tint is applied, in percent. 0 turns it off."),
		},
		[VOLT_REDUCE_TRANSPARENCY_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('voltAppearance.reduceTransparency', "Replace translucent surfaces with opaque backgrounds."),
		},
		[VOLT_WINDOW_TRANSPARENCY_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('voltAppearance.windowTransparency', "Show the desktop through the agent window's sidebar (macOS vibrancy, Windows acrylic). Uses more GPU memory."),
		},
	},
});
