/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { createModeIcon, createStrokeIcon, ModeIconId } from '../chrome/agentModeIcons.js';
import { createHomeAutomationsIcon } from '../home/agentHomeIcons.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';

export interface IAgentPlusMenuMode {
	readonly id: string;
	readonly label: string;
	readonly icon: ModeIconId;
	readonly description?: string;
}

export type AgentPlusMenuAction = 'files' | 'attachFile' | 'image' | 'video' | 'openFile' | 'terminal' | 'browser' | 'model' | 'mcp' | 'schedule';

export interface IAgentPlusMenuOptions {
	/** The composer box: the menu spans it and opens above it, like the @ panel. */
	readonly anchor: HTMLElement;
	/** Shown on top of the anchor (the chips); the menu opens above it. */
	readonly above?: () => HTMLElement | undefined;
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
		above: options.above,
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
			return { id: action, label: localize('voltAgent.plusFiles', "Files"), keywords: 'file folder attach', icon: createFolderIcon, data };
		case 'attachFile':
			return { id: action, label: localize('voltAgent.plusAttachFile', "File\u2026"), detail: localize('voltAgent.plusAttachFileDetail', "From your computer"), keywords: 'attach upload pdf zip document archive computer disk', icon: createUploadFileIcon, data };
		case 'image':
			return { id: action, label: localize('voltAgent.plusImage', "Image"), keywords: 'picture screenshot photo attach', icon: createImageIcon, data };
		case 'video':
			return { id: action, label: localize('voltAgent.plusVideo', "Video"), keywords: 'screen recording movie clip attach trim', icon: createVideoIcon, data };
		case 'openFile':
			return { id: action, label: localize('voltAgent.plusOpenFile', "Open File"), keywords: 'open file editor', icon: createOpenFileIcon, data };
		case 'terminal':
			return { id: action, label: localize('voltAgent.plusTerminal', "Terminal"), keywords: 'shell', icon: createTerminalIcon, data };
		case 'browser':
			return { id: action, label: localize('voltAgent.plusBrowser', "Browser"), keywords: 'preview', icon: createGlobeIcon, data };
		case 'model':
			return { id: action, label: localize('voltAgent.plusModel', "Model"), detail: modelName, icon: createCubeIcon, data };
		case 'mcp':
			return { id: action, label: localize('voltAgent.plusMcp', "MCP"), icon: createPlugIcon, trailingIcon: Codicon.chevronRight, data };
		case 'schedule':
			return { id: action, label: localize('voltAgent.plusAutomation', "Automate…"), keywords: 'schedule recurring repeat cron timer later automation webhook trigger', icon: () => createHomeAutomationsIcon(), data };
	}
}

/** Basicons folder-file: files and folders from the project. */
function createFolderIcon(): HTMLElement {
	return createStrokeIcon('folder', ['M4 21h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-9L9.297 3.445A1 1 0 0 0 8.465 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z']);
}

/** Basicons upload-share-upload: a file uploaded from the computer. */
function createUploadFileIcon(): HTMLElement {
	return createStrokeIcon('upload', ['M17 12h1a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3h1', 'M8 7l4-4 4 4', 'M12 3v12']);
}

/** Basicons image-photo-picture. */
function createImageIcon(): HTMLElement {
	return createStrokeIcon('image', ['M5 21l9.586-9.586a2 2 0 0 1 2.828 0L21 15', 'M5 21h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z', 'M10 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z']);
}

/** Basicons video-camera. */
function createVideoIcon(): HTMLElement {
	return createStrokeIcon('video', ['M16.118 12L22 7.333v9.334L16.118 12Z', 'M16.118 12V7.333A2.343 2.343 0 0 0 13.765 5H4.353A2.343 2.343 0 0 0 2 7.333v9.334A2.343 2.343 0 0 0 4.353 19h9.412a2.343 2.343 0 0 0 2.353-2.333V12Z']);
}

/** Basicons paper-file: a file opened in the editor. */
function createOpenFileIcon(): HTMLElement {
	return createStrokeIcon('open-file', ['M13.5 2.505V8.5h5.995', 'M18 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h6.172a2 2 0 0 1 1.414.586l5.828 5.828A2 2 0 0 1 20 9.828V20a2 2 0 0 1-2 2Z']);
}

/** Basicons terminal-code-dev. */
function createTerminalIcon(): HTMLElement {
	return createStrokeIcon('terminal', ['M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z', 'M7 8.5l3.864 3.682L7 15.5', 'M12 16h5']);
}

/** Basicons globe-world-earth: the in-app browser. */
function createGlobeIcon(): HTMLElement {
	return createStrokeIcon('globe', ['M22 12a10 10 0 0 1-20 0 10 10 0 0 1 20 0Z', 'M2 12h20', 'M12 22c2.474-2.525 4-6.186 4-10s-1.526-7.475-4-10', 'M12 22c-2.474-2.525-4-6.186-4-10s1.526-7.475 4-10']);
}

function createCubeIcon(): HTMLElement {
	return createStrokeIcon('cube', ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5']);
}

function createPlugIcon(): HTMLElement {
	return createStrokeIcon('plug', ['M9 2v4M15 2v4M7 6h10v5a5 5 0 0 1-10 0V6Z', 'M12 16v6']);
}
