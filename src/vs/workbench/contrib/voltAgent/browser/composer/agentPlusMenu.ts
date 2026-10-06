/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { createModeIcon, createStrokeIcon, ModeIconId } from '../chrome/agentModeIcons.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';

export interface IAgentPlusMenuMode {
	readonly id: string;
	readonly label: string;
	readonly icon: ModeIconId;
	readonly description?: string;
}

export type AgentPlusMenuAction = 'files' | 'image' | 'video' | 'openFile' | 'terminal' | 'browser' | 'model' | 'mcp' | 'schedule';

export interface IAgentPlusMenuOptions {
	/** The composer box: the menu spans it and opens above it, like the @ panel. */
	readonly anchor: HTMLElement;
	readonly modes: readonly IAgentPlusMenuMode[];
	readonly currentMode: string;
	readonly actions: readonly AgentPlusMenuAction[];
	/** Shown after "Model". */
	readonly modelName?: string;
	readonly onMode: (id: string) => void;
	readonly onAction: (action: AgentPlusMenuAction) => void;
	readonly onHide?: () => void;
}

type PlusPick = { readonly kind: 'mode'; readonly id: string } | { readonly kind: 'action'; readonly id: AgentPlusMenuAction };

/** Space between the menu and the composer, as the @ panel leaves. */
const ANCHOR_GAP = 6;

/** The composer's "+" menu: modes, then context and tools, in a Volt menu list with a search field. */
export function showAgentPlusMenu(contextViewService: IContextViewService, options: IAgentPlusMenuOptions): IVoltMenuHandle {
	const modes: IVoltMenuItem<PlusPick>[] = options.modes.map(mode => ({
		id: `mode:${mode.id}`,
		label: mode.label,
		detail: mode.description,
		keywords: mode.description,
		icon: () => createModeIcon(mode.icon),
		checked: mode.id === options.currentMode,
		data: { kind: 'mode', id: mode.id },
	}));
	const actions = options.actions.map(action => actionItem(action, options.modelName));
	const sections: IVoltMenuSection<PlusPick>[] = [
		{ id: 'modes', items: modes },
		{ id: 'actions', items: actions },
	];
	return showVoltMenu<PlusPick>(contextViewService, {
		anchor: options.anchor,
		position: 'above',
		gap: ANCHOR_GAP,
		width: options.anchor.getBoundingClientRect().width,
		className: 'volt-agent-plus-menu',
		ariaLabel: localize('voltAgent.plusMenu', "Add"),
		search: { placeholder: localize('voltAgent.plusSearch', "Search skills, context, chats...") },
		sections,
		onPick: item => {
			if (item.data.kind === 'mode') {
				options.onMode(item.data.id);
			} else {
				options.onAction(item.data.id);
			}
		},
		onHide: options.onHide,
	});
}

function actionItem(action: AgentPlusMenuAction, modelName: string | undefined): IVoltMenuItem<PlusPick> {
	const data: PlusPick = { kind: 'action', id: action };
	switch (action) {
		case 'files':
			return { id: action, label: localize('voltAgent.plusFiles', "Files"), keywords: 'file attach', icon: createPaperclipIcon, data };
		case 'image':
			return { id: action, label: localize('voltAgent.plusImage', "Image"), keywords: 'picture screenshot photo attach', icon: createImageIcon, data };
		case 'video':
			return { id: action, label: localize('voltAgent.plusVideo', "Video"), keywords: 'screen recording movie clip attach trim', icon: createVideoIcon, data };
		case 'openFile':
			return { id: action, label: localize('voltAgent.plusOpenFile', "Open File"), keywords: 'open file editor', icon: Codicon.file, data };
		case 'terminal':
			return { id: action, label: localize('voltAgent.plusTerminal', "Terminal"), keywords: 'shell', icon: Codicon.terminal, data };
		case 'browser':
			return { id: action, label: localize('voltAgent.plusBrowser', "Browser"), keywords: 'preview', icon: Codicon.globe, data };
		case 'model':
			return { id: action, label: localize('voltAgent.plusModel', "Model"), detail: modelName, icon: createCubeIcon, data };
		case 'mcp':
			return { id: action, label: localize('voltAgent.plusMcp', "MCP"), icon: createPlugIcon, trailingIcon: Codicon.chevronRight, data };
		case 'schedule':
			return { id: action, label: localize('voltAgent.plusSchedule', "Schedule…"), keywords: 'recurring repeat cron timer later automation', icon: Codicon.history, data };
	}
}

function createPaperclipIcon(): HTMLElement {
	return createStrokeIcon('paperclip', ['M16 6v9.5a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9']);
}

function createImageIcon(): HTMLElement {
	return createStrokeIcon('image', ['M4 6.5a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z', 'M4.5 16.5l4.3-4.3a1.5 1.5 0 0 1 2.1 0l5.6 5.6', 'M14 14.5l1.3-1.3a1.5 1.5 0 0 1 2.1 0l2.1 2.1', 'M15.5 8.5h.01']);
}

function createVideoIcon(): HTMLElement {
	return createStrokeIcon('video', ['M3.5 7.5A2.5 2.5 0 0 1 6 5h8a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 14 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z', 'M16.5 10.2l3.2-2.1a.8.8 0 0 1 1.3.7v6.4a.8.8 0 0 1-1.3.7l-3.2-2.1']);
}

function createCubeIcon(): HTMLElement {
	return createStrokeIcon('cube', ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5']);
}

function createPlugIcon(): HTMLElement {
	return createStrokeIcon('plug', ['M9 2v4M15 2v4M7 6h10v5a5 5 0 0 1-10 0V6Z', 'M12 16v6']);
}
