/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILabelService, Verbosity } from '../../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ISCMViewService } from '../../../scm/common/scm.js';
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
	private branchName: string | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
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
		this._register(autorun(reader => {
			const repository = this.scmViewService.activeRepository.read(reader);
			const ref = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader);
			this.branchName = ref?.name?.replace(/^refs\/heads\//, '') || undefined;
			this.renderBranch();
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.renderProject()));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.renderProject()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this.renderProject()));

		this.renderProject();
		this.renderBranch();
	}

	private renderProject(): void {
		const name = this.currentProjectName();
		this.projectLabel.textContent = name || localize('voltAgent.noFolder', "No folder");
		this.projectButton.classList.toggle('empty', !name);
		setAgentTooltip(this.projectButton, name
			? localize('voltAgent.switchProject', "Project: {0}", name)
			: localize('voltAgent.openFolder', "Open folder"));
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
		const workspace = this.workspaceContextService.getWorkspace();
		return landingWorkspaceName({
			folderName: workspace.folders[0]?.name,
			workspaceLabel: this.labelService.getWorkspaceLabel(workspace, { verbose: Verbosity.SHORT }),
			multiRoot: workspace.folders.length > 1 || !!workspace.configuration,
		});
	}

	private currentProject(): ILandingProject | undefined {
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
		const openable = project.workspace
			? { workspaceUri: project.uri }
			: { folderUri: project.uri };
		await this.hostService.openWindow([openable], { parkAndSwitch: true });
	}

	private async openBranchPicker(): Promise<void> {
		try {
			await this.commandService.executeCommand('git.checkout');
		} catch {
			await this.commandService.executeCommand('workbench.view.scm');
		}
	}

	private currentKeys(): Set<string> {
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
