/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { IEditorGroupView } from '../../../../browser/parts/editor/editor.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { CANVAS_ENABLED_SETTING, SCRATCH_ENABLED_SETTING } from '../../common/canvasScratchSettings.js';
import { OPEN_AUTOMATIONS_COMMAND_ID } from '../automations/automationCommands.js';
import { NEW_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { OPEN_BROWSER_COMMAND_ID } from '../preview/browserEditorInput.js';
import { OPEN_SCRATCH_BOARD_COMMAND_ID } from '../scratchBoard/scratchBoardInput.js';
import { ISurfaceOpenListItem, renderSurfaceOpenList, visibleSurfaceMenuItems } from './agentSurfaceAddMenu.js';
import { OPEN_CANVAS_IN_TOOLS_COMMAND_ID, OPEN_DEVICE_PREVIEW_COMMAND_ID, OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID, OPEN_WORKFLOWS_IN_TOOLS_COMMAND_ID, SIDE_CHAT_ICON_PATH, type AgentSurfaceMenuActionId } from './agentSurfaceMenu.js';

const MAXIMIZE_CHAT_COMMAND_ID = 'workbench.action.maximizeChat';
const MAXIMIZE_ICON_PATH = 'M4 9V4H9M15 4H20V9M20 15V20H15M9 20H4V15';

/**
 * What each tools row runs in the IDE layout, where it opens as an editor tab. The "beside chat"
 * commands open a tab when no chat is on screen. No side chat: the IDE has no chat on screen.
 */
const IDE_COMMANDS: Readonly<Record<Exclude<AgentSurfaceMenuActionId, 'sideChat'>, string>> = {
	file: 'workbench.action.quickOpen',
	terminal: 'workbench.action.togglePanel',
	browser: OPEN_BROWSER_COMMAND_ID,
	device: OPEN_DEVICE_PREVIEW_COMMAND_ID,
	changes: 'workbench.view.scm',
	gitGraph: OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID,
	scratch: OPEN_SCRATCH_BOARD_COMMAND_ID,
	canvas: OPEN_CANVAS_IN_TOOLS_COMMAND_ID,
	automations: OPEN_AUTOMATIONS_COMMAND_ID,
	workflows: OPEN_WORKFLOWS_IN_TOOLS_COMMAND_ID,
};

/**
 * The IDE layout's empty editor lists what the agent window's empty tools area lists, drawn the
 * same way under the bolt (agentEditor.css hides the stock shortcuts), with New Agent first and
 * Maximize Chat last. Each row runs its command, so it shows that command's own keys.
 */
class IdeWatermarkOpenListContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltIdeWatermarkOpenList';

	private readonly lists = this._register(new DisposableMap<IEditorGroupView>());

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const part = this.editorGroupsService.mainPart;
		if (!(part instanceof EditorPart)) {
			return;
		}
		this.renderAll(part);
		this._register(part.onDidAddGroup(() => this.renderAll(part)));
		this._register(part.onDidRemoveGroup(() => this.renderAll(part)));
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.renderAll(part, true)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.tips.enabled') || e.affectsConfiguration(SCRATCH_ENABLED_SETTING) || e.affectsConfiguration(CANVAS_ENABLED_SETTING)) {
				this.renderAll(part, true);
			}
		}));
	}

	private renderAll(part: EditorPart, rebuild = false): void {
		if (rebuild) {
			this.lists.clearAndDisposeAll();
		}
		const groups = new Set(part.groups);
		for (const group of [...this.lists.keys()]) {
			if (!groups.has(group)) {
				this.lists.deleteAndDispose(group);
			}
		}
		if (!this.configurationService.getValue<boolean>('workbench.tips.enabled')) {
			return;
		}
		const items = this.items();
		for (const group of groups) {
			const watermark = group.element.querySelector<HTMLElement>(':scope > .editor-group-watermark');
			if (!watermark || this.lists.has(group)) {
				continue;
			}
			watermark.classList.add('volt-ide-open-list');
			this.lists.set(group, renderSurfaceOpenList(watermark, items, this.keybindingService, command => void this.commandService.executeCommand(command)));
		}
	}

	/** Rows keyed by the command they run. */
	private items(): ISurfaceOpenListItem<string>[] {
		const rows: ISurfaceOpenListItem<string>[] = [{
			id: NEW_AGENT_COMMAND_ID,
			label: localize('voltIdeWatermark.newAgent', "New Agent"),
			icon: Codicon.commentDiscussion,
			svgPath: SIDE_CHAT_ICON_PATH,
			keybindingCommand: NEW_AGENT_COMMAND_ID,
		}];
		for (const item of visibleSurfaceMenuItems(this.configurationService)) {
			if (item.id === 'sideChat') {
				continue;
			}
			const command = IDE_COMMANDS[item.id];
			rows.push({ ...item, id: command, keybindingCommand: command });
		}
		rows.push({
			id: MAXIMIZE_CHAT_COMMAND_ID,
			label: localize('voltIdeWatermark.maximizeChat', "Maximize Chat"),
			icon: Codicon.screenFull,
			svgPath: MAXIMIZE_ICON_PATH,
			keybindingCommand: MAXIMIZE_CHAT_COMMAND_ID,
		});
		// The device preview is desktop only.
		return rows.filter(row => !!CommandsRegistry.getCommand(row.id));
	}
}

registerWorkbenchContribution2(IdeWatermarkOpenListContribution.ID, IdeWatermarkOpenListContribution, WorkbenchPhase.AfterRestored);
