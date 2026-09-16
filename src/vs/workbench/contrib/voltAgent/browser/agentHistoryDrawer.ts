/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentSessionMeta } from '../../../services/voltRuntime/common/agentHistory.js';
import { NEW_AGENT_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from './agentEditorInput.js';
import { AgentHistoryList } from './agentHistoryList.js';
import { setAgentTooltip } from './agentTooltip.js';

const ALL_WORKSPACES_KEY = 'volt.agent.history.allWorkspaces';

/**
 * The agents side drawer: search, New Agent, Customize and the full history
 * list grouped by date. Lives beside the agent editors inside the side panel.
 */
export class AgentHistoryDrawer extends Disposable {

	readonly element: HTMLElement;
	private readonly list: AgentHistoryList;
	private readonly scopeButton: HTMLButtonElement;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.element = append(container, $('.volt-agent-drawer'));
		this._register(toDisposable(() => this.element.remove()));

		// Spacer so the panel toggle sits in the tab row at the far right.
		append(this.element, $('.volt-agent-drawer-header'));

		this.list = this._register(instantiationService.createInstance(AgentHistoryList, this.element, {
			search: true,
			pageSize: 6,
			allWorkspaces: this.storageService.getBoolean(ALL_WORKSPACES_KEY, StorageScope.PROFILE, false),
			onOpen: (session: IAgentSessionMeta) => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, session.id),
			renderHeader: parent => {
				const actions = append(parent, $('.volt-agent-drawer-actions'));
				this.row(actions, Codicon.add, localize('voltAgent.drawer.newAgent', "New Agent"), NEW_AGENT_COMMAND_ID);
				this.row(actions, Codicon.extensions, localize('voltAgent.drawer.customize', "Customize"), OPEN_AGENT_CUSTOMIZE_COMMAND_ID);
			},
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

	private row(parent: HTMLElement, icon: ThemeIcon, label: string, commandId: string): void {
		const row = append(parent, $('button.volt-agent-drawer-row')) as HTMLButtonElement;
		row.appendChild(renderIcon(icon));
		append(row, $('span.label')).textContent = label;
		const keybinding = this.keybindingService.lookupKeybinding(commandId)?.getLabel();
		if (keybinding) {
			append(row, $('span.keybinding')).textContent = keybinding;
		}
		this._register(addDisposableListener(row, EventType.CLICK, e => {
			e.preventDefault();
			void this.commandService.executeCommand(commandId);
		}));
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
