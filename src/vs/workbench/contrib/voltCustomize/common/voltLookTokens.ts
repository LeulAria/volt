/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Look tokens: the sizes, radii and spacing the agent window was drawn with, as values a user, a
 * look, a layout or an extension can change. Each token is a setting (`volt.look.<id>`) and a CSS
 * variable (`--volt-look-<kebab id>`). The CSS reads `var(--volt-look-…, <default>)`, so with
 * nothing set Volt draws exactly as before; only values that differ from the default are written.
 *
 * Pure data and functions: the workbench, webviews, the agent server and tests all import this.
 */

export type VoltLookTokenUnit = 'px' | 'number';

export type VoltLookTokenGroup = 'chat' | 'composer' | 'sidebar' | 'toolbar';

export interface IVoltLookToken {
	/** `composer.radius`: what looks, layouts and AGENTS.md call it. */
	readonly id: string;
	readonly group: VoltLookTokenGroup;
	readonly unit: VoltLookTokenUnit;
	/** Today's value: what the CSS falls back to. */
	readonly default: number;
	readonly minimum: number;
	readonly maximum: number;
	/** What it changes, for the Settings editor and AGENTS.md. */
	readonly description: string;
}

/**
 * Tokens that are existing settings under another name. Looks and layouts may set them like any
 * token; the feature that owns the setting applies it.
 */
export interface IVoltLookAlias {
	readonly id: string;
	readonly setting: string;
	readonly description: string;
}

export const VOLT_LOOK_SETTING_PREFIX = 'volt.look.';
export const VOLT_LOOK_CSS_PREFIX = '--volt-look-';

const token = (id: string, group: VoltLookTokenGroup, unit: VoltLookTokenUnit, defaultValue: number, minimum: number, maximum: number, description: string): IVoltLookToken =>
	({ id, group, unit, default: defaultValue, minimum, maximum, description });

export const VOLT_LOOK_TOKENS: readonly IVoltLookToken[] = [
	token('chat.fontSize', 'chat', 'px', 14, 10, 24, 'Text size of messages in the chat.'),
	token('chat.lineHeight', 'chat', 'number', 1.55, 1, 2.4, 'Line height of messages in the chat, as a multiple of the text size.'),
	token('chat.gutter', 'chat', 'px', 20, 0, 96, 'Space between the chat column and the window edges, also used by the composer.'),
	token('chat.turnGap', 'chat', 'px', 20, 0, 96, 'Space between one exchange and the next sent message.'),
	token('chat.messageGap', 'chat', 'px', 6, 0, 48, 'Space between the parts of one exchange (your message, the answer, tool cards).'),
	token('chat.userBubbleRadius', 'chat', 'px', 8, 0, 32, 'Corner radius of your sent messages and of the box you edit them in.'),
	token('chat.userBubblePaddingY', 'chat', 'px', 8, 0, 32, 'Space above and below the text in your sent messages.'),
	token('chat.userBubblePaddingX', 'chat', 'px', 12, 0, 48, 'Space left and right of the text in your sent messages.'),
	token('chat.cardRadius', 'chat', 'px', 12, 0, 32, 'Corner radius of cards in the chat: tool cards, terminal blocks, changed files, the running and queued cards.'),
	token('chat.codeBlockRadius', 'chat', 'px', 12, 0, 32, 'Corner radius of code blocks in answers.'),
	token('chat.tableRadius', 'chat', 'px', 12, 0, 32, 'Corner radius of tables in answers.'),
	token('chat.inlineCodeRadius', 'chat', 'px', 5, 0, 16, 'Corner radius of `inline code` in answers.'),
	token('chat.inlineCodeFontSize', 'chat', 'px', 12.5, 8, 24, 'Text size of `inline code` in answers.'),
	token('composer.radius', 'composer', 'px', 20, 0, 40, 'Corner radius of the message box.'),
	token('composer.pillRadius', 'composer', 'px', 999, 0, 999, 'Corner radius of the one-line follow-up message box (999 draws a pill).'),
	token('composer.minHeight', 'composer', 'px', 40, 28, 120, 'Smallest height of the one-line follow-up message box.'),
	token('composer.borderWidth', 'composer', 'px', 1, 0, 4, 'Border width of the message box.'),
	token('composer.inputPaddingY', 'composer', 'px', 8, 0, 32, 'Space above and below the text you type.'),
	token('composer.inputPaddingX', 'composer', 'px', 10, 0, 48, 'Space left and right of the text you type.'),
	token('composer.chipHeight', 'composer', 'px', 30, 20, 48, 'Height of the chips above the message box.'),
	token('composer.chipRadius', 'composer', 'px', 999, 0, 999, 'Corner radius of the chips above the message box (999 draws a pill).'),
	token('composer.sendSize', 'composer', 'px', 26, 18, 48, 'Size of the send button.'),
	token('sidebar.fontSize', 'sidebar', 'px', 13, 10, 20, 'Text size of rows in the agent sidebar.'),
	token('sidebar.rowGap', 'sidebar', 'px', 8, 0, 24, 'Space between the icon and the text of a sidebar row.'),
	token('toolbar.buttonSize', 'toolbar', 'px', 28, 20, 44, 'Size of the title bar and rail icon buttons.'),
	token('activityBar.width', 'toolbar', 'px', 48, 32, 72, 'Width of the activity bar (VS Code\'s icon column, shown when a layout puts items in it); its icons scale with it.'),
];

export const VOLT_LOOK_ALIASES: readonly IVoltLookAlias[] = [
	{ id: 'chat.width', setting: 'volt.chat.width', description: 'How wide the chat may grow: `narrow`, `default`, `wide`, `full` or a number of pixels.' },
	{ id: 'font.ui', setting: 'volt.appearance.uiFontFamily', description: 'The interface font family; empty is the system font.' },
	{ id: 'sidebar.compact', setting: 'volt.agent.sidebar.compactList', description: 'Denser chat rows in the agent sidebar (true or false).' },
];

const TOKENS_BY_ID = new Map(VOLT_LOOK_TOKENS.map(entry => [entry.id, entry]));
const ALIASES_BY_ID = new Map(VOLT_LOOK_ALIASES.map(entry => [entry.id, entry]));

export function voltLookToken(id: string): IVoltLookToken | undefined {
	return TOKENS_BY_ID.get(id);
}

export function voltLookAlias(id: string): IVoltLookAlias | undefined {
	return ALIASES_BY_ID.get(id);
}

/** `composer.radius` → `volt.look.composer.radius`. */
export function voltLookSettingId(tokenId: string): string {
	return VOLT_LOOK_SETTING_PREFIX + tokenId;
}

/** The setting a token or alias id writes, or undefined for an unknown id. */
export function voltLookTargetSetting(id: string): string | undefined {
	if (TOKENS_BY_ID.has(id)) {
		return voltLookSettingId(id);
	}
	return ALIASES_BY_ID.get(id)?.setting;
}

/** `composer.inputPaddingY` → `--volt-look-composer-input-padding-y`. */
export function voltLookCssVariable(tokenId: string): string {
	return VOLT_LOOK_CSS_PREFIX + tokenId.replace(/\./g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The number a token takes from an untrusted value (a setting, a look file), clamped to its range;
 * undefined when the value is not a finite number.
 */
export function clampVoltLookValue(entry: IVoltLookToken, value: unknown): number | undefined {
	const number = typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*(px)?\s*$/.test(value) ? parseFloat(value) : value;
	if (typeof number !== 'number' || !Number.isFinite(number)) {
		return undefined;
	}
	return Math.min(entry.maximum, Math.max(entry.minimum, number));
}

export function voltLookCssValue(entry: IVoltLookToken, value: number): string {
	return entry.unit === 'px' ? `${value}px` : String(value);
}

/**
 * The CSS variables to set for the given token values: only tokens whose value differs from the
 * default, so an untouched Volt sets nothing. `read` returns the effective setting value.
 */
export function voltLookCssVariables(read: (settingId: string) => unknown): Map<string, string> {
	const variables = new Map<string, string>();
	for (const entry of VOLT_LOOK_TOKENS) {
		const value = clampVoltLookValue(entry, read(voltLookSettingId(entry.id)));
		if (value !== undefined && value !== entry.default) {
			variables.set(voltLookCssVariable(entry.id), voltLookCssValue(entry, value));
		}
	}
	return variables;
}

/** Every token as a CSS variable, defaults included: what extension webviews get. */
export function voltLookAllCssVariables(read: (settingId: string) => unknown): Record<string, string> {
	const variables: Record<string, string> = {};
	for (const entry of VOLT_LOOK_TOKENS) {
		const value = clampVoltLookValue(entry, read(voltLookSettingId(entry.id))) ?? entry.default;
		// Webview styles are keyed without the leading dashes.
		variables[voltLookCssVariable(entry.id).slice(2)] = voltLookCssValue(entry, value);
	}
	return variables;
}
