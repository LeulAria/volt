/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { EditorPart, IEditorPartUIState } from '../../../../browser/parts/editor/editorPart.js';
import { ISerializedNode } from '../../../../../base/browser/ui/grid/grid.js';
import { GroupIdentifier } from '../../../../common/editor.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';

/** True inside an agent chat's tools editor area (the right side of the agent window). */
export const AgentToolsPartContext = new RawContextKey<boolean>('voltAgentToolsPart', false, localize('voltAgent.toolsPartContext', "Whether focus is in the tools beside an agent chat."));

const PART_ID_PREFIX = 'workbench.parts.voltAgentTools.';
/** Where `EditorPart` keeps its grid; see `Memento` and `EditorPart.saveState`. */
const MEMENTO_PREFIX = 'memento/';
const UI_STATE_KEY = 'editorpart.state';

/**
 * Each chat's tabs, by chat, for every window. A window keeps its own copy too, but after a restart
 * only one window comes back: a chat opened there must still find the Scratch board, canvas, files
 * and pages it had beside it in whichever window showed it last.
 */
const APP_STATE_PREFIX = 'volt.agent.toolsTabs/';

let toolsLentOut: () => boolean = () => false;
/** The IDE layout borrows the chats' tabs into its own editor area meanwhile: what is saved stays as it was. */
export function setAgentToolsLentOut(check: () => boolean): void {
	toolsLentOut = check;
}

function readAppToolsState(storageService: IStorageService, sessionId: string): IEditorPartUIState | undefined {
	const raw = storageService.get(APP_STATE_PREFIX + sessionId, StorageScope.APPLICATION);
	if (!raw) {
		return undefined;
	}
	try {
		const state = JSON.parse(raw) as IEditorPartUIState;
		return state?.serializedGrid ? state : undefined;
	} catch {
		return undefined;
	}
}

export function agentToolsPartId(sessionId: string): string {
	return PART_ID_PREFIX + sessionId;
}

/** Whether a chat left tabs in its tools area last time, without creating the area to find out. */
export function hasSavedAgentTools(storageService: IStorageService, sessionId: string): boolean {
	if (readAppToolsState(storageService, sessionId)) {
		return true;
	}
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
 * An editor area that saves its grid on its own (a chat's tools, the agent side panel) can restore a
 * group id that another area's group took meanwhile. Restoring it as saved would fail and lose every
 * tab, so those groups come back under new ids.
 */
export function withFreeGroupIds(state: IEditorPartUIState | undefined, isTaken: (id: GroupIdentifier) => boolean): IEditorPartUIState | undefined {
	if (!state?.serializedGrid) {
		return state;
	}
	let clash = false;
	const free = (node: ISerializedNode): ISerializedNode => {
		if (node.type === 'branch') {
			return { ...node, data: node.data.map(free) };
		}
		const group = node.data as { id?: unknown } | null;
		if (group && typeof group.id === 'number' && isTaken(group.id)) {
			clash = true;
			const { id: _taken, ...rest } = group;
			return { ...node, data: rest };
		}
		return node;
	};
	const root = free(state.serializedGrid.root);
	if (!clash) {
		return state;
	}
	return { serializedGrid: { ...state.serializedGrid, root }, activeGroup: -1, mostRecentActiveGroups: [] };
}

/**
 * The tools beside one agent chat: a real editor part, so tabs, the tab menu,
 * drag to reorder, and drag to split behave like the IDE's main editor area.
 * Its grid is saved under the chat's id.
 */
export class AgentToolsEditorPart extends EditorPart {

	constructor(
		editorPartsView: IEditorPartsView,
		private readonly sessionId: string,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(editorPartsView, agentToolsPartId(sessionId), localize('voltAgent.toolsGroupsLabel', "Tools"), mainWindow.vscodeWindowId, instantiationService, themeService, configurationService, storage, layoutService, hostService, contextKeyService);
	}

	/** The chat's tabs as any window last left them, else as this window did (before they were kept by chat). */
	protected override loadState(): IEditorPartUIState | undefined {
		return withFreeGroupIds(readAppToolsState(this.storage, this.sessionId) ?? super.loadState(), id => !!this.editorPartsView.getGroup(id));
	}

	protected override saveState(): void {
		super.saveState();
		if (toolsLentOut()) {
			return;
		}
		// What the window's copy now holds: the grid, or nothing when the tools are empty.
		const state = this.getMemento(StorageScope.WORKSPACE, StorageTarget.USER)[UI_STATE_KEY] as IEditorPartUIState | undefined;
		if (state?.serializedGrid) {
			this.storage.store(APP_STATE_PREFIX + this.sessionId, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storage.remove(APP_STATE_PREFIX + this.sessionId, StorageScope.APPLICATION);
		}
	}

	/** Write the grid now. Parts dropped from memory would otherwise lose it until the next global save. */
	persist(): void {
		this.saveState();
	}
}
