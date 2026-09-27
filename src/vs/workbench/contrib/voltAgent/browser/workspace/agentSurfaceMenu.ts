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
export const SIDE_CHAT_ICON_PATH = 'M7 7H15M7 11H11M5 3H19C20.1046 3 21 3.89543 21 5V15C21 16.1046 20.1046 17 19 17H16L12.3536 20.6464C12.1583 20.8417 11.8417 20.8417 11.6464 20.6464L8 17H5C3.89543 17 3 16.1046 3 15V5C3 3.89543 3.89543 3 5 3Z';

/** Right-rail / tab-bar + menu rows that open an agent surface. */
export type AgentSurfaceMenuActionId = 'file' | 'terminal' | 'browser' | 'changes' | 'sideChat';

export interface IAgentSurfaceMenuItem {
	readonly id: AgentSurfaceMenuActionId;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Stroke path on a 24x24 box, drawn instead of `icon`. */
	readonly svgPath?: string;
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
			id: 'file',
			label: localize('voltAgent.surfaceMenu.file', "File"),
			icon: Codicon.file,
			keybindingCommand: 'workbench.action.quickOpen',
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

/** A 16px stroke glyph from a 24x24 path, colored by the text around it. */
export function createSurfaceStrokeIcon(doc: Document, pathD: string): SVGElement {
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('volt-agent-surface-stroke-icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	return svg;
}
