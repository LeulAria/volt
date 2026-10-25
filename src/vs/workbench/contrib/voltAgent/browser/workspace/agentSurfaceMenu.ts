/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { AGENT_HOME_AUTOMATIONS_ICON_PATH, AGENT_HOME_SCRATCH_ICON_PATHS } from '../home/agentHomeIcons.js';

/** Registered in electron-browser/voltDevices.contribution.ts, which browser/ can't import. */
export const OPEN_DEVICE_PREVIEW_COMMAND_ID = 'volt.devices.openPreview';

/** Registered in scratchBoard.contribution.ts, which imports this host: a chat's board as a tab. */
export const OPEN_SCRATCH_IN_TOOLS_COMMAND_ID = 'workbench.action.voltScratchBoard.openInTools';

/** Registered in electron-browser/agentVisuals.contribution.ts, which browser/ can't import: a chat's design canvas as a tab. */
export const OPEN_CANVAS_IN_TOOLS_COMMAND_ID = 'volt.canvas.openInTools';

/** Registered in automations.contribution.ts, which imports this host: Automations as a tab. */
export const OPEN_AUTOMATIONS_IN_TOOLS_COMMAND_ID = 'voltAgent.automations.openInTools';

/** A painter's palette: the design canvas, as its tab and the Designs rows show it (the + menu). */
export const CANVAS_ICON_SHAPES: SvgIconShapes = [
	['path', { d: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z' }],
	['circle', { cx: 13.5, cy: 6.5, r: 0.75, fill: 'currentColor' }],
	['circle', { cx: 17.5, cy: 10.5, r: 0.75, fill: 'currentColor' }],
	['circle', { cx: 8.5, cy: 7.5, r: 0.75, fill: 'currentColor' }],
	['circle', { cx: 6.5, cy: 12.5, r: 0.75, fill: 'currentColor' }],
];

/** The Scratch notebook (the + menu, the chat's back-to-board rail). */
export const SCRATCH_ICON_SHAPES: SvgIconShapes = AGENT_HOME_SCRATCH_ICON_PATHS.map(d => ['path', { d }] as const);

/** Speech bubble with two text lines. */
/** The +/- stroke the agent window uses for Changes (the window's tools list, the + menu). */
export const CHANGES_ICON_PATH = 'M12 3v14m7-7H5m14 11H5';

/** An icon's shapes on a 24 grid, as [tag, attributes]. */
export type SvgIconShapes = readonly (readonly [string, Record<string, string | number>])[];

/** A closed folder: the Explorer in the right panel's sidebar, the window's tools list and the + menu. */
export const EXPLORER_ICON_SHAPES: SvgIconShapes = [
	['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }],
	['path', { d: 'M2 10h20' }],
];

export const SIDE_CHAT_ICON_PATH = 'M7 7H15M7 11H11M5 3H19C20.1046 3 21 3.89543 21 5V15C21 16.1046 20.1046 17 19 17H16L12.3536 20.6464C12.1583 20.8417 11.8417 20.8417 11.6464 20.6464L8 17H5C3.89543 17 3 16.1046 3 15V5C3 3.89543 3.89543 3 5 3Z';

/** Right-rail / tab-bar + menu rows that open an agent surface. */
export type AgentSurfaceMenuActionId = 'file' | 'terminal' | 'browser' | 'device' | 'changes' | 'scratch' | 'canvas' | 'automations' | 'sideChat';

/** Each row's own command, registered in agentSurfaceHost.ts: opens it in the right panel of the chat on screen. */
export function surfaceOpenCommandId(id: AgentSurfaceMenuActionId): string {
	return `workbench.action.voltAgentTools.open.${id}`;
}

/**
 * The letter after Ctrl+Option (Ctrl+Alt+Shift off a Mac, where Ctrl+Alt is AltGr) that opens each row in the
 * agent layout: its first letter, Canvas taking V since Changes has C.
 */
export const SURFACE_OPEN_KEYS: Readonly<Record<AgentSurfaceMenuActionId, KeyCode>> = {
	file: KeyCode.KeyF,
	terminal: KeyCode.KeyT,
	browser: KeyCode.KeyB,
	device: KeyCode.KeyD,
	changes: KeyCode.KeyC,
	scratch: KeyCode.KeyS,
	canvas: KeyCode.KeyV,
	automations: KeyCode.KeyA,
	sideChat: KeyCode.KeyN,
};

export interface IAgentSurfaceMenuItem {
	readonly id: AgentSurfaceMenuActionId;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Stroke path or shapes on a 24x24 box, drawn instead of `icon`. */
	readonly svgPath?: string | SvgIconShapes;
	/** Command id used only to look up a keybinding label (the row's own Ctrl+Option command). */
	readonly keybindingCommand?: string;
}

/** Hide the vertical Quick Open rail while the tabbed tools pane is showing. */
export function shouldHideAgentQuickOpenRail(surfacePaneOpen: boolean): boolean {
	return surfacePaneOpen;
}

/** Menu rows for the surface tab-bar +. */
export function agentSurfaceMenuItems(): readonly IAgentSurfaceMenuItem[] {
	const items: readonly IAgentSurfaceMenuItem[] = [
		{
			// Opens the Explorer in the files sidebar; typing in the menu's box still finds a file.
			id: 'file',
			label: localize('voltAgent.surfaceMenu.file', "File"),
			icon: Codicon.file,
			svgPath: EXPLORER_ICON_SHAPES,
		},
		{
			id: 'terminal',
			label: localize('voltAgent.surfaceMenu.terminal', "Terminal"),
			icon: Codicon.terminal,
		},
		{
			id: 'browser',
			label: localize('voltAgent.surfaceMenu.browser', "Browser"),
			icon: Codicon.globe,
		},
		{
			// The iOS Simulator / Android Emulator preview.
			id: 'device',
			label: localize('voltAgent.surfaceMenu.device', "Device"),
			icon: Codicon.deviceMobile,
		},
		{
			id: 'changes',
			label: localize('voltAgent.surfaceMenu.changes', "Changes"),
			icon: Codicon.diff,
			svgPath: CHANGES_ICON_PATH,
		},
		{
			// The chat's board (or a clean one), drawn on in the chat's project.
			id: 'scratch',
			label: localize('voltAgent.surfaceMenu.scratch', "Scratch"),
			icon: Codicon.notebook,
			svgPath: SCRATCH_ICON_SHAPES,
		},
		{
			// The chat's newest design canvas (or an empty one).
			id: 'canvas',
			label: localize('voltAgent.surfaceMenu.canvas', "Canvas"),
			icon: Codicon.symbolColor,
			svgPath: CANVAS_ICON_SHAPES,
		},
		{
			id: 'automations',
			label: localize('voltAgent.surfaceMenu.automations', "Automations"),
			icon: Codicon.zap,
			svgPath: AGENT_HOME_AUTOMATIONS_ICON_PATH,
		},
		{
			id: 'sideChat',
			label: localize('voltAgent.surfaceMenu.sideChat', "New Side Chat"),
			icon: Codicon.commentDiscussion,
			svgPath: SIDE_CHAT_ICON_PATH,
		},
	];
	return items.map(item => ({ ...item, keybindingCommand: surfaceOpenCommandId(item.id) }));
}

/** Maps a + menu action to the surface kind it opens (file uses the file opener, not a draft alone). */
export function surfaceKindForMenuAction(id: AgentSurfaceMenuActionId): 'file' | 'terminal' | 'browser' | 'device' | 'changes' | 'scratch' | 'canvas' | 'automations' | 'chat' {
	switch (id) {
		case 'file':
			return 'file';
		case 'terminal':
			return 'terminal';
		case 'browser':
			return 'browser';
		case 'device':
			return 'device';
		case 'changes':
			return 'changes';
		case 'scratch':
			return 'scratch';
		case 'canvas':
			return 'canvas';
		case 'automations':
			return 'automations';
		case 'sideChat':
			return 'chat';
		default: {
			const unknown: never = id;
			return unknown;
		}
	}
}

/** A 16px stroke glyph from a 24x24 path or shapes, colored by the text around it. */
export function createSurfaceStrokeIcon(doc: Document, shape: string | SvgIconShapes): SVGElement {
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('volt-agent-surface-stroke-icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	// 1.5 in the 24 grid matches a codicon's line (1px at 16px) at whatever size the icon is drawn.
	svg.setAttribute('stroke-width', '1.5');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const [tag, attributes] of typeof shape === 'string' ? [['path', { d: shape }] as const] : shape) {
		const element = doc.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const [name, value] of Object.entries(attributes)) {
			element.setAttribute(name, String(value));
		}
		svg.appendChild(element);
	}
	return svg;
}
