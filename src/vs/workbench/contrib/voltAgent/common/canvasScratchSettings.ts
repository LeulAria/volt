/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { DEFAULT_SCRATCH_SETTINGS, IScratchBoardSettings, SCRATCH_BACKGROUNDS, ScratchGrid, ScratchTheme } from './scratchBoard/scratchTypes.js';

/** Scratch in the home bar and the rail, and the Open Scratch command. */
export const SCRATCH_ENABLED_SETTING = 'volt.scratch.enabled';
/** scratch_read and scratch_draw on Volt's MCP server. */
export const SCRATCH_AGENT_TOOLS_SETTING = 'volt.scratch.agentTools';
/** Put the chats list away while Scratch shows in the agent layout. */
export const SCRATCH_HIDE_CHATS_SETTING = 'volt.scratch.hideChatsList';
/** Hovering a shape lights up its connectors (and fades the rest); hovering a connector, its two ends. */
export const SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING = 'volt.scratch.highlightConnections';
export const SCRATCH_NEW_THEME_SETTING = 'volt.scratch.newBoard.theme';
export const SCRATCH_NEW_GRID_SETTING = 'volt.scratch.newBoard.grid';
export const SCRATCH_NEW_BACKGROUND_SETTING = 'volt.scratch.newBoard.background';
export const SCRATCH_NEW_SNAP_OBJECTS_SETTING = 'volt.scratch.newBoard.snapToObjects';
export const SCRATCH_NEW_SNAP_GRID_SETTING = 'volt.scratch.newBoard.snapToGrid';
/** Minutes of editing between a board's saved versions; 0 keeps none. */
export const SCRATCH_SNAPSHOT_MINUTES_SETTING = 'volt.scratch.snapshotMinutes';
/** Days a deleted board stays in the trash. */
export const SCRATCH_TRASH_DAYS_SETTING = 'volt.scratch.trashDays';

/** canvas_render, canvas_update and canvas_read on Volt's MCP server. */
export const CANVAS_ENABLED_SETTING = 'volt.canvas.enabled';
/** The look frames open in when the agent set none: auto follows the Volt theme. */
export const CANVAS_FRAME_THEME_SETTING = 'volt.canvas.frameTheme';
/** Open a new canvas in a tab beside the chat as well as inline. */
export const CANVAS_OPEN_BESIDE_SETTING = 'volt.canvas.openBeside';

export const SCRATCH_SNAPSHOT_MINUTES = [0, 5, 10, 30, 60] as const;
export const SCRATCH_TRASH_DAYS = [7, 30, 90, 365] as const;
export const SCRATCH_THEMES: readonly ScratchTheme[] = ['auto', 'light', 'dark'];
export const SCRATCH_GRIDS: readonly ScratchGrid[] = ['dots', 'lines', 'none'];
export type CanvasFrameTheme = 'auto' | 'light' | 'dark';
export const CANVAS_FRAME_THEMES: readonly CanvasFrameTheme[] = ['auto', 'light', 'dark'];

const DEFAULT_SNAPSHOT_MINUTES = 10;
const DEFAULT_TRASH_DAYS = 30;

function oneOf<T extends string | number>(value: unknown, options: readonly T[], fallback: T): T {
	return (options as readonly unknown[]).includes(value) ? value as T : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** What a new board starts with. */
export function readNewBoardSettings(get: (key: string) => unknown): IScratchBoardSettings {
	const d = DEFAULT_SCRATCH_SETTINGS;
	return {
		theme: oneOf(get(SCRATCH_NEW_THEME_SETTING), SCRATCH_THEMES, d.theme),
		grid: oneOf(get(SCRATCH_NEW_GRID_SETTING), SCRATCH_GRIDS, d.grid),
		background: oneOf(get(SCRATCH_NEW_BACKGROUND_SETTING), SCRATCH_BACKGROUNDS, d.background as typeof SCRATCH_BACKGROUNDS[number]),
		snapToObjects: bool(get(SCRATCH_NEW_SNAP_OBJECTS_SETTING), d.snapToObjects),
		snapToGrid: bool(get(SCRATCH_NEW_SNAP_GRID_SETTING), d.snapToGrid),
	};
}

export function readSnapshotMinutes(value: unknown): number {
	return oneOf(value, SCRATCH_SNAPSHOT_MINUTES, DEFAULT_SNAPSHOT_MINUTES);
}

export function readTrashDays(value: unknown): number {
	return oneOf(value, SCRATCH_TRASH_DAYS, DEFAULT_TRASH_DAYS);
}

export function readCanvasFrameTheme(value: unknown): CanvasFrameTheme {
	return oneOf(value, CANVAS_FRAME_THEMES, 'auto');
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.canvasScratch',
	title: localize('voltCanvasScratch.configTitle', "Canvas & Scratch"),
	type: 'object',
	properties: {
		[SCRATCH_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.enabled', "Show Scratch, the whiteboard, in the home bar and the sidebar rail."),
		},
		[SCRATCH_AGENT_TOOLS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.agentTools', "Let agents read Scratch boards and draw diagrams on them (scratch_read, scratch_draw)."),
		},
		[SCRATCH_HIDE_CHATS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.hideChats', "Put the chats list away while Scratch is open, and bring it back on leaving."),
		},
		[SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.highlightConnections', "Hovering a shape on a Scratch board highlights the connectors joined to it and fades the others; hovering a connector highlights what it joins."),
		},
		[SCRATCH_NEW_THEME_SETTING]: {
			type: 'string',
			enum: [...SCRATCH_THEMES],
			default: DEFAULT_SCRATCH_SETTINGS.theme,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.newTheme', "The look of new Scratch boards. Auto follows the Volt theme."),
		},
		[SCRATCH_NEW_GRID_SETTING]: {
			type: 'string',
			enum: [...SCRATCH_GRIDS],
			default: DEFAULT_SCRATCH_SETTINGS.grid,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.newGrid', "The grid new Scratch boards show."),
		},
		[SCRATCH_NEW_BACKGROUND_SETTING]: {
			type: 'string',
			enum: [...SCRATCH_BACKGROUNDS],
			default: DEFAULT_SCRATCH_SETTINGS.background,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.newBackground', "The background colour of new Scratch boards (light-space; dark boards invert it)."),
		},
		[SCRATCH_NEW_SNAP_OBJECTS_SETTING]: {
			type: 'boolean',
			default: DEFAULT_SCRATCH_SETTINGS.snapToObjects,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.newSnapObjects', "New Scratch boards snap moved elements to the edges and centres of others."),
		},
		[SCRATCH_NEW_SNAP_GRID_SETTING]: {
			type: 'boolean',
			default: DEFAULT_SCRATCH_SETTINGS.snapToGrid,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.newSnapGrid', "New Scratch boards snap elements to the grid."),
		},
		[SCRATCH_SNAPSHOT_MINUTES_SETTING]: {
			type: 'number',
			enum: [...SCRATCH_SNAPSHOT_MINUTES],
			default: DEFAULT_SNAPSHOT_MINUTES,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.snapshotMinutes', "Minutes of editing between the versions Volt keeps of each Scratch board. 0 keeps none besides the one a session starts from."),
		},
		[SCRATCH_TRASH_DAYS_SETTING]: {
			type: 'number',
			enum: [...SCRATCH_TRASH_DAYS],
			default: DEFAULT_TRASH_DAYS,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltScratch.trashDays', "Days a deleted Scratch board stays in the trash before it is removed for good."),
		},
		[CANVAS_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCanvas.enabled', "Let agents show design canvases: boards of live screens you pan, play and comment on (canvas_render, canvas_update, canvas_read)."),
		},
		[CANVAS_FRAME_THEME_SETTING]: {
			type: 'string',
			enum: [...CANVAS_FRAME_THEMES],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCanvas.frameTheme', "The look canvas frames open in when the agent fixed none. Auto follows the Volt theme."),
		},
		[CANVAS_OPEN_BESIDE_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCanvas.openBeside', "Open a new design canvas in a tab beside the chat as well as in the reply."),
		},
	},
});
