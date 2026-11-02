/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError } from '../../../../base/common/json.js';
import { getParseErrorMessage } from '../../../../base/common/jsonErrorMessages.js';
import { clampVoltLookValue, VOLT_LOOK_ALIASES, VOLT_LOOK_TOKENS, voltLookAlias, voltLookSettingId, voltLookToken } from './voltLookTokens.js';
import { isVoltSlotId, isVoltSlotItemId, VOLT_SLOT_ITEMS, VOLT_SLOTS, VOLT_VSCODE_ACTIVITY_BAR } from './voltSlots.js';

/**
 * Looks and layouts as files.
 *
 * A **look** is a set of values: tokens (`composer.radius`), theme colors (`sideBar.background`)
 * and other window settings. A **layout** is how the agent window is arranged (sidebar, chat width,
 * files sidebar, right panel) and may carry a look of its own. Both may `extends` another one and
 * change only what differs, so a user's copy of an extension's layout keeps working, and keeps its
 * changes, when the extension updates.
 *
 * Both are applied as configuration defaults (like an extension's `configurationDefaults`): what
 * the user writes in settings.json always wins.
 */

/** Where a look or layout comes from: Volt itself, the customize folder, or an extension id. */
export type VoltCustomizeSource = string;
export const VOLT_BUILTIN_SOURCE = 'volt';
export const VOLT_HOME_SOURCE = 'home';

export const VOLT_DEFAULT_LAYOUT_ID = 'volt/default';

/** The settings that pick the active look and layout. */
export const VOLT_CUSTOMIZE_LOOK_SETTING = 'volt.customize.look';
export const VOLT_CUSTOMIZE_LAYOUT_SETTING = 'volt.customize.layout';

const COLOR_ID = /^\w+(\.\w+)*$/;
const COLOR_VALUE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_EXTENDS_DEPTH = 8;

export type VoltFilesSidebarView = 'explorer' | 'scm' | 'search' | 'pullRequests' | 'debug' | 'extensions';
const FILES_SIDEBAR_VIEWS: readonly VoltFilesSidebarView[] = ['explorer', 'scm', 'search', 'pullRequests', 'debug', 'extensions'];

export interface IVoltLook {
	readonly label?: string;
	readonly description?: string;
	readonly extends?: string;
	/** Token id → value, already range-checked. */
	readonly tokens?: Readonly<Record<string, unknown>>;
	/** Theme color id → `#rrggbb[aa]`. */
	readonly colors?: Readonly<Record<string, string>>;
	/** Any window-scoped setting → value. */
	readonly settings?: Readonly<Record<string, unknown>>;
}

export interface IVoltLayout extends IVoltLook {
	/** A look id this layout brings; the look picked in Settings wins over it. */
	readonly look?: string;
	readonly sidebar?: { readonly visible?: boolean; readonly width?: number; readonly rail?: boolean };
	readonly chat?: { readonly width?: string | number };
	readonly filesSidebar?: { readonly open?: boolean; readonly view?: VoltFilesSidebarView };
	readonly rightPanel?: { readonly open?: boolean; readonly commands?: readonly string[] };
	/** Slot id → the items it holds, in order (voltSlots.ts): moves, reorders and hides Volt's buttons. */
	readonly slots?: Readonly<Record<string, readonly string[]>>;
	/** Root only: a picture for the Settings picker, a path next to the layout file. */
	readonly preview?: string;
}

export interface IVoltCustomizeEntry<T extends IVoltLook> {
	/** `<source>/<name>`, e.g. `volt/focus`, `home/desk`, `acme.board/board`. */
	readonly id: string;
	readonly source: VoltCustomizeSource;
	readonly name: string;
	readonly label: string;
	readonly description?: string;
	/** The file it was read from (a URI string); none for Volt's own. */
	readonly file?: string;
	readonly value: T;
	/** Problems found reading it; the last good value is used while there are any. */
	readonly errors: readonly string[];
}

/** How a setting may be overridden: only settings a window may change are accepted. */
export type VoltSettingScopeLookup = (settingId: string) => 'window' | 'other' | 'unknown';

export function voltCustomizeId(source: VoltCustomizeSource, name: string): string {
	return `${source}/${name}`;
}

export function splitVoltCustomizeId(id: string): { source: string; name: string } | undefined {
	const slash = id.lastIndexOf('/');
	if (slash <= 0 || slash === id.length - 1) {
		return undefined;
	}
	return { source: id.slice(0, slash), name: id.slice(slash + 1) };
}

/** A file name stem that is safe as a look, layout or draft name. */
export function voltCustomizeSlug(text: string): string {
	const slug = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
	return slug || 'untitled';
}

// --- Parsing ---------------------------------------------------------------------------------

/** JSON with comments and trailing commas, as settings.json. Errors carry line and column. */
export function parseVoltCustomizeJson(text: string): { value: Record<string, unknown> | undefined; errors: string[] } {
	const parseErrors: ParseError[] = [];
	const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
	const errors = parseErrors.map(error => `${position(text, error.offset)}: ${getParseErrorMessage(error.error)}`);
	if (!errors.length && !isRecord(value)) {
		errors.push('The file must hold one JSON object.');
	}
	return { value: errors.length ? undefined : value as Record<string, unknown>, errors };
}

function position(text: string, offset: number): string {
	const before = text.slice(0, offset);
	const line = before.split('\n').length;
	const column = offset - before.lastIndexOf('\n');
	return `line ${line}, column ${column}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(raw: Record<string, unknown>, key: string, errors: string[]): string | undefined {
	const value = raw[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string') {
		errors.push(`"${key}" must be a string.`);
		return undefined;
	}
	return value;
}

function optionalBoolean(raw: Record<string, unknown>, key: string, where: string, errors: string[]): boolean | undefined {
	const value = raw[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		errors.push(`"${where}.${key}" must be true or false.`);
		return undefined;
	}
	return value;
}

function lookFields(raw: Record<string, unknown>, scopeOf: VoltSettingScopeLookup, errors: string[]): IVoltLook {
	const look: { -readonly [K in keyof IVoltLook]: IVoltLook[K] } = {};
	look.label = optionalString(raw, 'label', errors);
	look.description = optionalString(raw, 'description', errors);
	look.extends = optionalString(raw, 'extends', errors);

	if (raw.tokens !== undefined) {
		if (!isRecord(raw.tokens)) {
			errors.push('"tokens" must be an object of token ids, e.g. { "composer.radius": 12 }.');
		} else {
			const tokens: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(raw.tokens)) {
				// null removes a value an `extends` parent set.
				if (value === null) {
					tokens[id] = null;
					continue;
				}
				const entry = voltLookToken(id);
				if (entry) {
					const number = clampVoltLookValue(entry, value);
					if (number === undefined) {
						errors.push(`"tokens.${id}" must be a number (${entry.minimum} to ${entry.maximum}).`);
					} else {
						tokens[id] = number;
					}
					continue;
				}
				if (voltLookAlias(id)) {
					tokens[id] = value;
					continue;
				}
				errors.push(`"tokens.${id}" is not a Volt token. Known tokens are listed in reference/tokens.json.`);
			}
			look.tokens = tokens;
		}
	}

	if (raw.colors !== undefined) {
		if (!isRecord(raw.colors)) {
			errors.push('"colors" must be an object of theme color ids, e.g. { "sideBar.background": "#1e3a8a" }.');
		} else {
			const colors: Record<string, string> = {};
			for (const [id, value] of Object.entries(raw.colors)) {
				if (value === null) {
					(colors as Record<string, unknown>)[id] = null;
				} else if (!COLOR_ID.test(id)) {
					errors.push(`"colors.${id}" is not a theme color id.`);
				} else if (typeof value !== 'string' || !COLOR_VALUE.test(value)) {
					errors.push(`"colors.${id}" must be a hex color like #1e3a8a or #1e3a8a80.`);
				} else {
					colors[id] = value;
				}
			}
			look.colors = colors;
		}
	}

	if (raw.settings !== undefined) {
		if (!isRecord(raw.settings)) {
			errors.push('"settings" must be an object of setting ids, e.g. { "workbench.tree.indent": 12 }.');
		} else {
			const settings: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(raw.settings)) {
				const scope = scopeOf(id);
				if (scope === 'unknown') {
					errors.push(`"settings.${id}" is not a registered setting.`);
				} else if (scope === 'other') {
					errors.push(`"settings.${id}" applies to the whole app or machine; a look can only change window settings. Set it in settings.json.`);
				} else {
					settings[id] = value;
				}
			}
			look.settings = settings;
		}
	}
	return look;
}

/** Reads a look file's object; unknown or bad values are dropped and reported. */
export function validateVoltLook(raw: Record<string, unknown>, scopeOf: VoltSettingScopeLookup): { value: IVoltLook; errors: string[] } {
	const errors: string[] = [];
	const value = lookFields(raw, scopeOf, errors);
	return { value, errors };
}

/** Reads a layout file's object; unknown or bad values are dropped and reported. */
export function validateVoltLayout(raw: Record<string, unknown>, scopeOf: VoltSettingScopeLookup): { value: IVoltLayout; errors: string[] } {
	const errors: string[] = [];
	const layout: { -readonly [K in keyof IVoltLayout]: IVoltLayout[K] } = { ...lookFields(raw, scopeOf, errors) };
	layout.look = optionalString(raw, 'look', errors);
	layout.preview = optionalString(raw, 'preview', errors);

	if (raw.sidebar !== undefined) {
		if (!isRecord(raw.sidebar)) {
			errors.push('"sidebar" must be an object: { "visible", "width", "rail" }.');
		} else {
			const width = raw.sidebar.width;
			if (width !== undefined && (typeof width !== 'number' || width < 160 || width > 800)) {
				errors.push('"sidebar.width" must be a number of pixels from 160 to 800.');
			}
			layout.sidebar = {
				visible: optionalBoolean(raw.sidebar, 'visible', 'sidebar', errors),
				width: typeof width === 'number' && width >= 160 && width <= 800 ? Math.round(width) : undefined,
				rail: optionalBoolean(raw.sidebar, 'rail', 'sidebar', errors),
			};
		}
	}
	if (raw.chat !== undefined) {
		if (!isRecord(raw.chat)) {
			errors.push('"chat" must be an object: { "width" }.');
		} else {
			const width = raw.chat.width;
			if (width !== undefined && typeof width !== 'string' && typeof width !== 'number') {
				errors.push('"chat.width" must be narrow, default, wide, full or a number of pixels.');
			}
			layout.chat = { width: typeof width === 'string' || typeof width === 'number' ? width : undefined };
		}
	}
	if (raw.filesSidebar !== undefined) {
		if (!isRecord(raw.filesSidebar)) {
			errors.push('"filesSidebar" must be an object: { "open", "view" }.');
		} else {
			const view = raw.filesSidebar.view;
			if (view !== undefined && !FILES_SIDEBAR_VIEWS.includes(view as VoltFilesSidebarView)) {
				errors.push(`"filesSidebar.view" must be one of ${FILES_SIDEBAR_VIEWS.join(', ')}.`);
			}
			layout.filesSidebar = {
				open: optionalBoolean(raw.filesSidebar, 'open', 'filesSidebar', errors),
				view: FILES_SIDEBAR_VIEWS.includes(view as VoltFilesSidebarView) ? view as VoltFilesSidebarView : undefined,
			};
		}
	}
	if (raw.rightPanel !== undefined) {
		if (!isRecord(raw.rightPanel)) {
			errors.push('"rightPanel" must be an object: { "open", "commands" }.');
		} else {
			const commands = raw.rightPanel.commands;
			if (commands !== undefined && (!Array.isArray(commands) || commands.some(command => typeof command !== 'string'))) {
				errors.push('"rightPanel.commands" must be a list of command ids.');
			}
			layout.rightPanel = {
				open: optionalBoolean(raw.rightPanel, 'open', 'rightPanel', errors),
				commands: Array.isArray(commands) ? commands.filter((command): command is string => typeof command === 'string') : undefined,
			};
		}
	}
	if (raw.slots !== undefined) {
		if (!isRecord(raw.slots)) {
			errors.push('"slots" must be an object of slot id → item ids, e.g. { "sidebar.header": ["volt.settings"] }.');
		} else {
			const slots: Record<string, string[]> = {};
			for (const [slot, items] of Object.entries(raw.slots)) {
				if (!isVoltSlotId(slot)) {
					errors.push(`"slots.${slot}" is not a slot. Slots: ${VOLT_SLOTS.map(entry => entry.id).join(', ')}.`);
					continue;
				}
				if (!Array.isArray(items)) {
					errors.push(`"slots.${slot}" must be a list of item ids.`);
					continue;
				}
				slots[slot] = [];
				for (const item of items) {
					if (typeof item === 'string' && isVoltSlotItemId(item)) {
						slots[slot].push(item);
					} else {
						errors.push(`"slots.${slot}": ${JSON.stringify(item)} is not an item. Items: ${VOLT_SLOT_ITEMS.map(entry => entry.id).join(', ')}.`);
					}
				}
			}
			layout.slots = slots;
		}
	}
	const known = new Set(['$schema', 'label', 'description', 'extends', 'look', 'tokens', 'colors', 'settings', 'sidebar', 'chat', 'filesSidebar', 'rightPanel', 'slots', 'preview']);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) {
			errors.push(`"${key}" is not a layout field. Fields: ${[...known].filter(field => field !== '$schema').join(', ')}.`);
		}
	}
	return { value: layout, errors };
}

// --- Inheritance -----------------------------------------------------------------------------

/**
 * `patch` over `base`: objects merge key by key, anything else replaces, and `null` removes the
 * key. This is how a user's layout that `extends` an extension's changes only what it names.
 */
export function mergeVoltCustomize<T>(base: T, patch: unknown): T {
	if (!isRecord(base) || !isRecord(patch)) {
		return (patch === undefined ? base : patch) as T;
	}
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) {
			continue;
		}
		if (value === null) {
			delete result[key];
		} else if (isRecord(value) && isRecord(result[key])) {
			result[key] = mergeVoltCustomize(result[key], value);
		} else {
			result[key] = value;
		}
	}
	return result as T;
}

/**
 * Follows `extends` from `id` up to its root and merges down, the child last. Unknown parents and
 * loops are reported and cut.
 */
export function resolveVoltCustomize<T extends IVoltLook>(id: string, lookup: (id: string) => T | undefined): { value: T | undefined; chain: string[]; errors: string[] } {
	const chain: string[] = [];
	const errors: string[] = [];
	const values: T[] = [];
	let next: string | undefined = id;
	while (next !== undefined) {
		if (chain.includes(next)) {
			errors.push(`"${chain[chain.length - 1]}" extends "${next}", which extends it back.`);
			break;
		}
		if (chain.length >= MAX_EXTENDS_DEPTH) {
			errors.push(`"${id}" extends more than ${MAX_EXTENDS_DEPTH} levels deep.`);
			break;
		}
		const value = lookup(next);
		if (!value) {
			if (chain.length) {
				errors.push(`"${chain[chain.length - 1]}" extends "${next}", which is not installed.`);
			}
			break;
		}
		chain.push(next);
		values.push(value);
		next = value.extends;
	}
	if (!values.length) {
		return { value: undefined, chain, errors };
	}
	let merged: unknown = {};
	for (const value of values.reverse()) {
		const { extends: _parent, ...rest } = value;
		merged = mergeVoltCustomize(merged, rest);
	}
	return { value: merged as T, chain, errors };
}

// --- Applying --------------------------------------------------------------------------------

/**
 * The configuration defaults a look and layout stand for: tokens become `volt.look.*` (or the
 * setting an alias names), colors become `workbench.colorCustomizations`, `chat.width` becomes
 * `volt.chat.width`. The look wins over the layout's own values.
 */
export function voltCustomizeOverrides(layout: IVoltLayout | undefined, look: IVoltLook | undefined): Record<string, unknown> {
	const overrides: Record<string, unknown> = {};
	const colors: Record<string, string> = {};
	const apply = (source: IVoltLook | undefined) => {
		if (!source) {
			return;
		}
		for (const [id, value] of Object.entries(source.settings ?? {})) {
			if (value !== null && value !== undefined) {
				overrides[id] = value;
			}
		}
		for (const [id, value] of Object.entries(source.tokens ?? {})) {
			if (value === null || value === undefined) {
				continue;
			}
			if (voltLookToken(id)) {
				overrides[voltLookSettingId(id)] = value;
			} else {
				const alias = voltLookAlias(id);
				if (alias) {
					overrides[alias.setting] = value;
				}
			}
		}
		for (const [id, value] of Object.entries(source.colors ?? {})) {
			if (typeof value === 'string') {
				colors[id] = value;
			}
		}
	};
	apply(layout);
	if (layout?.chat?.width !== undefined) {
		overrides['volt.chat.width'] = layout.chat.width;
	}
	apply(look);
	if (Object.keys(colors).length) {
		overrides['workbench.colorCustomizations'] = colors;
	}
	return overrides;
}

/** The parts of a layout that are window state rather than settings: applied when it is picked or its file changes. */
export interface IVoltLayoutWindowState {
	readonly sidebarVisible?: boolean;
	readonly sidebarWidth?: number;
	readonly sidebarRail?: boolean;
	readonly filesSidebarOpen?: boolean;
	readonly filesSidebarView?: VoltFilesSidebarView;
	readonly rightPanelOpen?: boolean;
	readonly rightPanelCommands?: readonly string[];
}

export function voltLayoutWindowState(layout: IVoltLayout | undefined): IVoltLayoutWindowState {
	return {
		sidebarVisible: layout?.sidebar?.visible,
		sidebarWidth: layout?.sidebar?.width,
		sidebarRail: layout?.sidebar?.rail,
		filesSidebarOpen: layout?.filesSidebar?.open,
		filesSidebarView: layout?.filesSidebar?.view,
		rightPanelOpen: layout?.rightPanel?.open,
		rightPanelCommands: layout?.rightPanel?.commands,
	};
}

/** A stable key for a layout's window state: a changed file applies again, an unchanged one keeps the user's clicks. */
export function voltLayoutStateKey(id: string, state: IVoltLayoutWindowState): string {
	return `${id}:${JSON.stringify(state, Object.keys(state).sort())}`;
}

// --- Volt's own ------------------------------------------------------------------------------

/** Volt's own layouts. `default` sets nothing: it is Volt as it ships. */
export const VOLT_BUILTIN_LAYOUTS: readonly { name: string; value: IVoltLayout }[] = [
	{
		name: 'default',
		value: {
			label: 'Volt',
			description: 'The agent sidebar on the left, the chat in the middle, tools on the right when you open them.',
		},
	},
	{
		name: 'focus',
		value: {
			label: 'Focus',
			description: 'Only the chat: no sidebar, no files, a wider column.',
			sidebar: { visible: false },
			chat: { width: 'wide' },
			filesSidebar: { open: false },
			rightPanel: { open: false },
		},
	},
	{
		name: 'review',
		value: {
			label: 'Review',
			description: 'The chat beside its changes: Source Control in the files sidebar and the tools panel open.',
			sidebar: { visible: true },
			filesSidebar: { open: true, view: 'scm' },
			rightPanel: { open: true },
		},
	},
	{
		name: 'vscode',
		value: {
			label: 'VS Code',
			description: 'VS Code\'s activity bar at the left edge: Explorer, Search, Source Control, Run and Debug, Pull Requests and Extensions open in the files sidebar.',
			slots: { 'activityBar.top': [...VOLT_VSCODE_ACTIVITY_BAR['activityBar.top']], 'activityBar.bottom': [...VOLT_VSCODE_ACTIVITY_BAR['activityBar.bottom']] },
		},
	},
];

/** Volt's own looks. None is picked by default. */
export const VOLT_BUILTIN_LOOKS: readonly { name: string; value: IVoltLook }[] = [
	{
		name: 'soft',
		value: {
			label: 'Soft',
			description: 'Rounder corners everywhere.',
			tokens: { 'composer.radius': 26, 'chat.cardRadius': 16, 'chat.userBubbleRadius': 14, 'chat.codeBlockRadius': 16, 'chat.tableRadius': 16, 'chat.inlineCodeRadius': 6 },
		},
	},
	{
		name: 'compact',
		value: {
			label: 'Compact',
			description: 'Smaller text and tighter spacing, more chat on screen.',
			tokens: {
				'chat.fontSize': 13, 'chat.lineHeight': 1.45, 'chat.gutter': 14, 'chat.turnGap': 14, 'chat.messageGap': 4,
				'chat.userBubblePaddingY': 6, 'chat.userBubblePaddingX': 10, 'composer.minHeight': 34, 'composer.chipHeight': 26,
				'composer.sendSize': 24, 'sidebar.fontSize': 12, 'sidebar.rowGap': 6, 'toolbar.buttonSize': 24,
			},
		},
	},
	{
		name: 'square',
		value: {
			label: 'Square',
			description: 'Square corners, like a terminal.',
			tokens: {
				'composer.radius': 4, 'composer.pillRadius': 4, 'composer.chipRadius': 4, 'chat.cardRadius': 4, 'chat.userBubbleRadius': 4,
				'chat.codeBlockRadius': 4, 'chat.tableRadius': 4, 'chat.inlineCodeRadius': 2,
			},
		},
	},
];

// --- Reference files -------------------------------------------------------------------------

/** reference/tokens.json: every token and alias, for agents and editors. */
export function voltTokensReference(): object {
	return {
		tokens: VOLT_LOOK_TOKENS.map(entry => ({
			id: entry.id,
			setting: voltLookSettingId(entry.id),
			unit: entry.unit,
			default: entry.default,
			minimum: entry.minimum,
			maximum: entry.maximum,
			description: entry.description,
		})),
		aliases: VOLT_LOOK_ALIASES.map(alias => ({ id: alias.id, setting: alias.setting, description: alias.description })),
	};
}

const tokenSchema = () => ({
	type: 'object',
	description: 'Token id → value. reference/tokens.json lists every token, its default and range.',
	properties: Object.fromEntries([
		...VOLT_LOOK_TOKENS.map(entry => [entry.id, { type: ['number', 'null'], minimum: entry.minimum, maximum: entry.maximum, default: entry.default, description: entry.description }]),
		...VOLT_LOOK_ALIASES.map(alias => [alias.id, { description: `${alias.description} (setting ${alias.setting})` }]),
	]),
	additionalProperties: false,
});

const lookSchemaProperties = () => ({
	label: { type: 'string', description: 'The name Settings shows.' },
	description: { type: 'string' },
	extends: { type: 'string', description: 'Another look or layout id to start from, e.g. "volt/soft" or "acme.board/board". Only what you name here changes.' },
	tokens: tokenSchema(),
	colors: { type: 'object', description: 'Theme color id → hex color, as workbench.colorCustomizations.', additionalProperties: { type: ['string', 'null'], pattern: COLOR_VALUE.source } },
	settings: { type: 'object', description: 'Any window-scoped setting → value, as configurationDefaults.' },
});

/** reference/look.schema.json */
export function voltLookSchema(): object {
	return { $schema: 'http://json-schema.org/draft-07/schema#', title: 'Volt look', type: 'object', properties: { $schema: { type: 'string' }, ...lookSchemaProperties() }, additionalProperties: false };
}

/** reference/layout.schema.json */
export function voltLayoutSchema(): object {
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		title: 'Volt layout',
		type: 'object',
		properties: {
			$schema: { type: 'string' },
			...lookSchemaProperties(),
			look: { type: 'string', description: 'A look id this layout uses, e.g. "volt/compact". The look picked in Settings wins.' },
			preview: { type: 'string', description: 'A picture of the layout, relative to this file.' },
			sidebar: { type: 'object', properties: { visible: { type: 'boolean' }, width: { type: 'number', minimum: 160, maximum: 800 }, rail: { type: 'boolean', description: 'Fold the sidebar to its icon rail.' } }, additionalProperties: false },
			chat: { type: 'object', properties: { width: { anyOf: [{ enum: ['narrow', 'default', 'wide', 'full'] }, { type: 'number', minimum: 480, maximum: 2400 }] } }, additionalProperties: false },
			filesSidebar: { type: 'object', properties: { open: { type: 'boolean' }, view: { enum: [...FILES_SIDEBAR_VIEWS] } }, additionalProperties: false },
			rightPanel: { type: 'object', properties: { open: { type: 'boolean' }, commands: { type: 'array', items: { type: 'string' }, description: 'Commands run when the layout is applied, e.g. one that opens an extension\'s tab.' } }, additionalProperties: false },
			slots: {
				type: 'object',
				description: 'Moves, reorders or hides Volt\'s buttons: slot id → item ids in order. Items not named stay where Volt puts them.',
				properties: Object.fromEntries(VOLT_SLOTS.map(slot => [slot.id, { type: 'array', description: slot.description, items: { enum: VOLT_SLOT_ITEMS.map(item => item.id) }, uniqueItems: true }])),
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	};
}
