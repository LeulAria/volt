/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { OPEN_BROWSER_COMMAND_ID } from '../preview/browserEditorInput.js';
import { OPEN_AGENT_CHANGES_COMMAND_ID } from '../review/agentChangesEditor.js';

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
export type AgentSurfaceMenuActionId = 'file' | 'terminal' | 'browser' | 'changes' | 'sideChat';

export interface IAgentSurfaceMenuItem {
	readonly id: AgentSurfaceMenuActionId;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Stroke path or shapes on a 24x24 box, drawn instead of `icon`. */
	readonly svgPath?: string | SvgIconShapes;
	/** Existing command id used only to look up a keybinding label. */
	readonly keybindingCommand?: string;
}

/** Hide the vertical Quick Open rail while the tabbed tools pane is showing. */
export function shouldHideAgentQuickOpenRail(surfacePaneOpen: boolean): boolean {
	return surfacePaneOpen;
}

/** Menu rows for the surface tab-bar +. Canvas is omitted until an opener exists. */
export function agentSurfaceMenuItems(): readonly IAgentSurfaceMenuItem[] {
	return [
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
			keybindingCommand: 'workbench.action.terminal.new',
		},
		{
			id: 'browser',
			label: localize('voltAgent.surfaceMenu.browser', "Browser"),
			icon: Codicon.globe,
			keybindingCommand: OPEN_BROWSER_COMMAND_ID,
		},
		{
			id: 'changes',
			label: localize('voltAgent.surfaceMenu.changes', "Changes"),
			icon: Codicon.diff,
			svgPath: CHANGES_ICON_PATH,
			keybindingCommand: OPEN_AGENT_CHANGES_COMMAND_ID,
		},
		{
			id: 'sideChat',
			label: localize('voltAgent.surfaceMenu.sideChat', "New Side Chat"),
			icon: Codicon.commentDiscussion,
			svgPath: SIDE_CHAT_ICON_PATH,
		},
	];
}

/** Maps a + menu action to the surface kind it opens (file uses the file opener, not a draft alone). */
export function surfaceKindForMenuAction(id: AgentSurfaceMenuActionId): 'file' | 'terminal' | 'browser' | 'changes' | 'chat' {
	switch (id) {
		case 'file':
			return 'file';
		case 'terminal':
			return 'terminal';
		case 'browser':
			return 'browser';
		case 'changes':
			return 'changes';
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
	svg.setAttribute('stroke-width', '1');
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
