/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { NEW_AGENT_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from '../editor/agentEditorInput.js';
import { AgentHistoryList } from './agentHistoryList.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

const ALL_WORKSPACES_KEY = 'volt.agent.history.allWorkspaces';
const TREE_VIEW_KEY = 'volt.agent.history.treeView';

/**
 * The agents side drawer: search, New Agent, Customize and the full history
 * list grouped by date. Lives beside the agent editors inside the side panel.
 */
export class AgentHistoryDrawer extends Disposable {

	readonly element: HTMLElement;
	readonly header: HTMLElement;
	private readonly list: AgentHistoryList;
	private readonly scopeButton: HTMLButtonElement;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.element = append(container, $('.volt-agent-drawer'));
		this._register(toDisposable(() => this.element.remove()));

		this.header = append(this.element, $('.volt-agent-drawer-header'));

		this.list = this._register(instantiationService.createInstance(AgentHistoryList, this.element, {
			search: true,
			pageSize: 22,
			treeView: this.storageService.getBoolean(TREE_VIEW_KEY, StorageScope.PROFILE, true),
			allWorkspaces: this.storageService.getBoolean(ALL_WORKSPACES_KEY, StorageScope.PROFILE, false),
			onOpen: (session: IAgentSessionMeta) => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, session.id),
			actions: [
				{
					id: NEW_AGENT_COMMAND_ID,
					label: localize('voltAgent.drawer.newAgent', "New Agent"),
					icon: Codicon.add,
					keybinding: keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? undefined,
					run: () => void this.commandService.executeCommand(NEW_AGENT_COMMAND_ID),
				},
				{
					id: OPEN_AGENT_CUSTOMIZE_COMMAND_ID,
					label: localize('voltAgent.drawer.customize', "Customize"),
					icon: Codicon.extensions,
					keybinding: keybindingService.lookupKeybinding(OPEN_AGENT_CUSTOMIZE_COMMAND_ID)?.getLabel() ?? undefined,
					run: () => void this.commandService.executeCommand(OPEN_AGENT_CUSTOMIZE_COMMAND_ID),
				},
			],
		}));

		const footer = append(this.element, $('.volt-agent-drawer-footer'));
		this.scopeButton = append(footer, $('button.volt-agent-drawer-scope')) as HTMLButtonElement;
		this.updateScope();
		this._register(addDisposableListener(this.scopeButton, EventType.CLICK, e => {
			e.preventDefault();
			const next = !this.list.showsAllWorkspaces;
			this.list.setAllWorkspaces(next);
			this.storageService.store(ALL_WORKSPACES_KEY, next, StorageScope.PROFILE, StorageTarget.USER);
			this.updateScope();
		}));
	}

	get treeView(): boolean {
		return this.list.treeView;
	}

	get canCollapse(): boolean {
		return this.list.canCollapse;
	}

	get onDidChangeView(): Event<void> {
		return this.list.onDidChangeView;
	}

	setTreeView(value: boolean): void {
		this.list.setTreeView(value);
		this.storageService.store(TREE_VIEW_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	collapseAll(): void {
		this.list.collapseAll();
	}

	expandAll(): void {
		this.list.expandAll();
	}

	private updateScope(): void {
		const all = this.list.showsAllWorkspaces;
		this.scopeButton.replaceChildren(renderIcon(Codicon.filter));
		append(this.scopeButton, $('span')).textContent = all
			? localize('voltAgent.drawer.allWorkspaces', "All Workspaces")
			: localize('voltAgent.drawer.thisWorkspace', "This Workspace");
		setAgentTooltip(this.scopeButton, all
			? localize('voltAgent.drawer.showThisWorkspace', "Show only this workspace's agents")
			: localize('voltAgent.drawer.showAllWorkspaces', "Show agents from every workspace"));
	}

	setActiveSession(id: string | undefined): void {
		this.list.setActiveSession(id);
	}

	focus(): void {
		this.list.focus();
	}

	layout(): void {
		this.list.layout();
	}
}
