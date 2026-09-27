/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';

/** True inside an agent chat's tools editor area (the right side of the agent window). */
export const AgentToolsPartContext = new RawContextKey<boolean>('voltAgentToolsPart', false, localize('voltAgent.toolsPartContext', "Whether focus is in the tools beside an agent chat."));

const PART_ID_PREFIX = 'workbench.parts.voltAgentTools.';
/** Where `EditorPart` keeps its grid; see `Memento` and `EditorPart.saveState`. */
const MEMENTO_PREFIX = 'memento/';
const UI_STATE_KEY = 'editorpart.state';

export function agentToolsPartId(sessionId: string): string {
	return PART_ID_PREFIX + sessionId;
}

/** Whether a chat left tabs in its tools area last time, without creating the area to find out. */
export function hasSavedAgentTools(storageService: IStorageService, sessionId: string): boolean {
	const raw = storageService.get(MEMENTO_PREFIX + agentToolsPartId(sessionId), StorageScope.WORKSPACE);
	if (!raw) {
		return false;
	}
	try {
		const memento = JSON.parse(raw) as Record<string, unknown>;
		return !!memento[UI_STATE_KEY];
	} catch {
		return false;
	}
}

/**
 * The tools beside one agent chat: a real editor part, so tabs, the tab menu,
 * drag to reorder, and drag to split behave like the IDE's main editor area.
 * Its grid is saved under the chat's id.
 */
export class AgentToolsEditorPart extends EditorPart {

	constructor(
		editorPartsView: IEditorPartsView,
		sessionId: string,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(editorPartsView, agentToolsPartId(sessionId), localize('voltAgent.toolsGroupsLabel', "Tools"), mainWindow.vscodeWindowId, instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);
	}

	/** Write the grid now. Parts dropped from memory would otherwise lose it until the next global save. */
	persist(): void {
		this.saveState();
	}
}
