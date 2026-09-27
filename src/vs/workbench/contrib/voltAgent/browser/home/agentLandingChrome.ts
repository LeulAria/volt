/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService, Verbosity } from '../../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AGENT_RUN_ON_OPTIONS, AgentRunOn, agentRunOnStorageKey, normalizeAgentRunOn } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMViewService } from '../../../scm/common/scm.js';
import { createAgentHeaderGitIcon } from '../chrome/agentTitlebarHeader.js';
import { activateAgentProject } from '../workspace/agentPanels.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { buildLandingProjectList, ILandingProject, landingWorkspaceName } from './agentLandingModel.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

interface IProjectPick extends IQuickPickItem {
	readonly project?: ILandingProject;
	readonly openOther?: boolean;
}

export class AgentLandingChrome extends Disposable {

	readonly element: HTMLElement;

	private readonly projectButton: HTMLButtonElement;
	private readonly projectLabel: HTMLElement;
	private readonly branchButton: HTMLButtonElement;
	private readonly branchLabel: HTMLElement;
	private readonly runButton: HTMLButtonElement;
	private readonly runLabel: HTMLElement;
	private branchName: string | undefined;
	private runOn: AgentRunOn = 'same-branch';

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILabelService private readonly labelService: ILabelService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
	) {
		super();
		this.element = $('.volt-agent-landing-chrome');

		this.projectButton = append(this.element, $('button.volt-agent-landing-pick')) as HTMLButtonElement;
		this.projectButton.type = 'button';
		this.projectLabel = append(this.projectButton, $('span.label'));
		this.projectButton.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');

		this.branchButton = append(this.element, $('button.volt-agent-landing-pick')) as HTMLButtonElement;
		this.branchButton.type = 'button';
		this.branchLabel = append(this.branchButton, $('span.label'));
		this.branchButton.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');

		this.runButton = append(this.element, $('button.volt-agent-landing-pick')) as HTMLButtonElement;
		this.runButton.type = 'button';
		const runIcon = append(this.runButton, $('span.run-icon'));
		createAgentHeaderGitIcon(runIcon, 14);
		this.runLabel = append(this.runButton, $('span.label'));
		this.runButton.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');

		this._register(addDisposableListener(this.projectButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.openProjectPicker();
		}));
		this._register(addDisposableListener(this.branchButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.openBranchPicker();
		}));
		this._register(addDisposableListener(this.runButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.openRunMenu();
		}));
		this._register(autorun(reader => {
			const repository = this.scmViewService.activeRepository.read(reader);
			const ref = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader);
			this.branchName = ref?.name?.replace(/^refs\/heads\//, '') || undefined;
			this.renderBranch();
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.renderProject()));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.renderProject()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this.renderProject()));
		this._register(this.sessionContext.onDidChangeActiveProject(() => {
			this.renderProject();
			this.renderRun();
		}));
		this._register(this.sessionContext.onDidChangeProjects(() => this.renderProject()));

		this.renderProject();
		this.renderBranch();
		this.renderRun();
	}

	private renderProject(): void {
		const name = this.currentProjectName();
		this.projectLabel.textContent = name || localize('voltAgent.noFolder', "No folder");
		this.projectButton.classList.toggle('empty', !name);
		setAgentTooltip(this.projectButton, name
			? localize('voltAgent.switchProject', "Project: {0}", name)
			: localize('voltAgent.openFolder', "Open folder"));
	}

	private renderRun(): void {
		this.runOn = normalizeAgentRunOn(this.storageService.get(agentRunOnStorageKey(this.sessionContext.activeProject?.id), StorageScope.APPLICATION));
		this.runLabel.textContent = this.runOnLabel(this.runOn);
		this.runButton.classList.toggle('worktree', this.runOn === 'worktree');
		setAgentTooltip(this.runButton, localize('voltAgent.runOn.tooltip', "Run on"));
	}

	private runOnLabel(mode: AgentRunOn): string {
		switch (mode) {
			case 'same-branch':
				return localize('voltAgent.runOn.sameBranch', "Same branch");
			case 'worktree':
				return localize('voltAgent.runOn.worktree', "New Worktree");
			default: {
				const unknown: never = mode;
				return unknown;
			}
		}
	}

	private openRunMenu(): void {
		if (this.runButton.classList.contains('open')) {
			this.contextViewService.hideContextView();
			return;
		}
		this.contextViewService.showContextView({
			getAnchor: () => this.runButton,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.BELOW,
			onDOMEvent: (e: globalThis.Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || this.runButton.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				this.runButton.classList.add('open');
				store.add(toDisposable(() => this.runButton.classList.remove('open')));
				const menu = append(container, $('.volt-agent-dropdown.run-on'));
				const heading = append(menu, $('div.volt-agent-dropdown-item.heading'));
				heading.textContent = localize('voltAgent.runOn.heading', "Run on");
				for (const mode of AGENT_RUN_ON_OPTIONS) {
					const item = append(menu, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
					if (mode === 'worktree') {
						const icon = append(item, $('span.icon'));
						icon.appendChild(renderIcon(Codicon.add));
					}
					append(item, $('span.label')).textContent = this.runOnLabel(mode);
					if (mode === 'worktree' && !this.branchName) {
						item.disabled = true;
						item.title = localize('voltAgent.runOn.noRepository', "No git repository");
					}
					if (mode === this.runOn) {
						const check = append(item, $('span.check'));
						check.appendChild(renderIcon(Codicon.check));
					}
					store.add(addDisposableListener(item, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						if (item.disabled) {
							return;
						}
						this.storageService.store(agentRunOnStorageKey(this.sessionContext.activeProject?.id), mode, StorageScope.APPLICATION, StorageTarget.USER);
						this.renderRun();
						this.contextViewService.hideContextView();
					}));
				}
				store.add(toDisposable(() => menu.remove()));
				return store;
			},
		});
	}

	private renderBranch(): void {
		const name = this.branchName;
		this.branchLabel.textContent = name || localize('voltAgent.noBranch', "No branch");
		this.branchButton.classList.toggle('empty', !name);
		setAgentTooltip(this.branchButton, name
			? localize('voltAgent.switchBranch', "Branch: {0}", name)
			: localize('voltAgent.noRepository', "No git repository"));
	}

	private currentProjectName(): string {
		const active = this.sessionContext.activeProject;
		if (active) {
			return active.displayName;
		}
		const workspace = this.workspaceContextService.getWorkspace();
		return landingWorkspaceName({
			folderName: workspace.folders[0]?.name,
			workspaceLabel: this.labelService.getWorkspaceLabel(workspace, { verbose: Verbosity.SHORT }),
			multiRoot: workspace.folders.length > 1 || !!workspace.configuration,
		});
	}

	private currentProject(): ILandingProject | undefined {
		const active = this.sessionContext.activeProject;
		if (active) {
			return {
				uri: active.root,
				name: active.displayName,
				current: true,
				workspace: false,
			};
		}
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace.configuration) {
			return {
				uri: workspace.configuration,
				name: this.currentProjectName() || this.labelService.getUriBasenameLabel(workspace.configuration),
				current: true,
				workspace: true,
			};
		}
		const folder = workspace.folders[0];
		if (!folder) {
			return undefined;
		}
		return {
			uri: folder.uri,
			name: this.currentProjectName() || folder.name,
			current: true,
			workspace: false,
		};
	}

	private async openProjectPicker(): Promise<void> {
		const recents = await this.workspacesService.getRecentlyOpened();
		const currentKeys = this.currentKeys();
		const recentProjects = recents.workspaces
			.map(recent => this.toProject(recent, currentKeys))
			.filter((project): project is ILandingProject => !!project);
		const projects = buildLandingProjectList(this.currentProject(), recentProjects).slice(0, 20);
		const items: (IProjectPick | IQuickPickSeparator)[] = projects.map(project => ({
			label: project.name,
			description: this.labelService.getUriLabel(project.uri, { noPrefix: true }),
			picked: project.current,
			project,
		}));
		items.push({ type: 'separator' });
		items.push({
			label: localize('voltAgent.openFolderEllipsis', "Open Folder..."),
			openOther: true,
		});
		const picked = await this.quickInputService.pick<IProjectPick>(items, {
			placeHolder: localize('voltAgent.switchProjectPlaceholder', "Switch project"),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}
		if (picked.openOther) {
			await this.openOtherFolder();
			return;
		}
		if (picked.project) {
			await this.openProject(picked.project);
		}
	}

	private async openOtherFolder(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: localize('voltAgent.openFolder', "Open folder"),
			openLabel: localize('voltAgent.openFolder', "Open folder"),
		});
		const folder = picked?.[0];
		if (!folder) {
			return;
		}
		await this.openProject({ uri: folder, name: this.labelService.getUriBasenameLabel(folder), current: false, workspace: false });
	}

	private async openProject(project: ILandingProject): Promise<void> {
		if (project.current) {
			return;
		}
		await activateAgentProject(
			this.sessionContext,
			this.agentWorkspace,
			this.history,
			this.editorGroupsService,
			this.instantiationService,
			project.uri,
			project.name,
		);
	}

	private async openBranchPicker(): Promise<void> {
		try {
			await this.commandService.executeCommand('git.checkout');
		} catch {
			await this.commandService.executeCommand('workbench.view.scm');
		}
	}

	private currentKeys(): Set<string> {
		const active = this.sessionContext.activeProject;
		if (active) {
			return new Set([active.root.toString()]);
		}
		const workspace = this.workspaceContextService.getWorkspace();
		const keys = new Set(workspace.folders.map(folder => folder.uri.toString()));
		if (workspace.configuration) {
			keys.add(workspace.configuration.toString());
		}
		return keys;
	}

	private toProject(recent: IRecentFolder | IRecentWorkspace, current: Set<string>): ILandingProject | undefined {
		if (isRecentFolder(recent)) {
			return {
				uri: recent.folderUri,
				name: recent.label || this.labelService.getUriBasenameLabel(recent.folderUri),
				current: current.has(recent.folderUri.toString()),
				workspace: false,
			};
		}
		if (isRecentWorkspace(recent)) {
			return {
				uri: recent.workspace.configPath,
				name: recent.label || this.labelService.getUriBasenameLabel(recent.workspace.configPath),
				current: current.has(recent.workspace.configPath.toString()),
				workspace: true,
			};
		}
		return undefined;
	}
}
