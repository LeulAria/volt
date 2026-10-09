/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How wide the transcript and composer may grow: a preset or a number of pixels. */
export const AGENT_CHAT_WIDTH_SETTING = 'volt.chat.width';

export type AgentChatWidthPreset = 'narrow' | 'default' | 'wide' | 'full';

export const AGENT_CHAT_WIDTH_PRESETS: Readonly<Record<AgentChatWidthPreset, number | undefined>> = {
	narrow: 600,
	// The width the chat CSS was drawn for.
	default: 728,
	wide: 960,
	// No cap: the column's own padding is the only limit.
	full: undefined,
};

export const AGENT_CHAT_MIN_WIDTH = 480;
export const AGENT_CHAT_MAX_WIDTH = 2400;

export interface IAgentChatWidth {
	/** The preset it resolved to, or `custom` for a number. */
	readonly preset: AgentChatWidthPreset | 'custom';
	/** The cap in pixels; undefined for `full`. */
	readonly px: number | undefined;
}

/**
 * Reads the setting: a preset name, a number, or a numeric string ("900", "900px").
 * Numbers are clamped to 480 to 2400; anything else falls back to the default width.
 */
export function resolveAgentChatWidth(value: unknown): IAgentChatWidth {
	if (typeof value === 'string') {
		const name = value.trim().toLowerCase();
		if (Object.prototype.hasOwnProperty.call(AGENT_CHAT_WIDTH_PRESETS, name)) {
			const preset = name as AgentChatWidthPreset;
			return { preset, px: AGENT_CHAT_WIDTH_PRESETS[preset] };
		}
		const match = /^(\d+(?:\.\d+)?)\s*(?:px)?$/.exec(name);
		if (match) {
			return customWidth(Number(match[1]));
		}
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return customWidth(value);
	}
	return { preset: 'default', px: AGENT_CHAT_WIDTH_PRESETS.default };
}

function customWidth(px: number): IAgentChatWidth {
	const clamped = Math.round(Math.min(AGENT_CHAT_MAX_WIDTH, Math.max(AGENT_CHAT_MIN_WIDTH, px)));
	return { preset: 'custom', px: clamped };
}

/** The CSS value for `--volt-chat-max-width`. */
export function agentChatWidthCss(width: IAgentChatWidth): string {
	return width.px === undefined ? 'none' : `${width.px}px`;
}
