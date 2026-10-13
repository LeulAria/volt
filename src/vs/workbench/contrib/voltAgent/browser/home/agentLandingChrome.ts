/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService, Verbosity } from '../../../../../platform/label/common/label.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AgentRunOn, agentRunOnStorageKey, AgentWorktreeTarget, normalizeAgentRunOn } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { CLOUD_AUTO, cloudMachineStorageKey, normalizeCloudMachine } from '../../../../services/voltRuntime/common/cloud/cloudTasks.js';
import { canTakeAgent, cpuPressure, describeMachineLoad, IRelayMachine, memoryPressure } from '../../../../services/voltRuntime/common/relay/relayMachines.js';
import { IAgentCloudTasksService } from '../../../../services/voltRuntime/browser/cloud/agentCloudTasksService.js';
import { IVoltQuery, IVoltQueryCache } from '../../../../services/voltRuntime/browser/queryCache.js';
import { VOLT_RELAY_CONNECT_COMMAND_ID } from '../automations/automationHooks.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { IVoltProjectsService } from '../../../voltProjects/common/projects.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { showAgentBranchMenu } from '../picker/agentBranchMenu.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { showAgentProjectMenu } from './agentHomeWorkspaceActions.js';
import { landingWorkspaceName } from './agentLandingModel.js';

export interface IAgentBranchState {
	readonly name?: string;
	readonly detached?: string;
	readonly unborn?: boolean;
}

const THIS_MACHINE = isMacintosh ? localize('voltAgent.env.thisMac', "This Mac") : localize('voltAgent.env.thisPC', "This PC");

/**
 * The three dropdowns above a new agent's composer, as in Cursor: Project, Branch and
 * Environment. Each opens an anchored menu; the data and actions are VS Code's (recents, SCM
 * refs, git.checkout) with Volt's own git plumbing when the project is not an open SCM repo.
 */
export class AgentLandingChrome extends Disposable {

	readonly element: HTMLElement;

	private readonly projectButton: HTMLButtonElement;
	private readonly projectLabel: HTMLElement;
	private readonly branchButton: HTMLButtonElement;
	private readonly branchLabel: HTMLElement;
	private readonly envButton: HTMLButtonElement;
	private readonly envLabel: HTMLElement;
	private readonly envIcon: HTMLElement;
	private readonly repositoryWatch = this._register(new MutableDisposable());
	/** `unborn`: the branch has no commits yet, as right after `git init`. */
	private branch: { readonly name?: string; readonly detached?: string; readonly unborn?: boolean } = {};
	private repository: ISCMRepository | undefined;
	private runOn: AgentRunOn = 'same-branch';
	/** Cloud location: a runner's machine id, or `auto` (the relay picks the least loaded runner). */
	private cloudMachine = CLOUD_AUTO;
	/** In Worktree mode: the branch the new checkout uses. None means a fresh branch from the current one. */
	private worktreeTarget: AgentWorktreeTarget | undefined;
	private branchRequest = 0;
	private lastProjectState: string | undefined;

	private readonly _onDidChangeBranch = this._register(new Emitter<void>());
	/** The project's checked-out branch changed. */
	readonly onDidChangeBranch: Event<void> = this._onDidChangeBranch.event;

	constructor(
		/** Loads a picked folder into this new chat. */
		private readonly openProject: (folder: URI) => Promise<void>,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IStorageService private readonly storageService: IStorageService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
		@IVoltGitService private readonly gitService: IVoltGitService,
		@IAgentCloudTasksService private readonly cloud: IAgentCloudTasksService,
		@IVoltQueryCache private readonly cache: IVoltQueryCache,
	) {
		super();
		this.element = $('.volt-agent-landing-chrome');

		this.projectButton = this.trigger();
		this.projectLabel = this.projectButton.querySelector<HTMLElement>('.label')!;
		this.branchButton = this.trigger();
		this.branchLabel = this.branchButton.querySelector<HTMLElement>('.label')!;
		this.envButton = this.trigger(Codicon.deviceDesktop);
		this.envLabel = this.envButton.querySelector<HTMLElement>('.label')!;
		this.envIcon = this.envButton.querySelector<HTMLElement>('.trigger-icon')!;

		this.onClick(this.projectButton, () => this.openProjectMenu());
		this.onClick(this.branchButton, () => this.openBranchMenu());
		this.onClick(this.envButton, () => this.openEnvironmentMenu());

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.onProjectChanged()));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.onProjectChanged()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this.renderProject()));
		this._register(this.sessionContext.onDidChangeActiveProject(() => this.onProjectChanged()));
		this._register(this.projects.onDidChange(() => {
			this.renderProject();
			// A clone just finished: its branch exists now.
			const root = this.projectRoot();
			const state = root ? this.projects.getByUri(root)?.state.kind : undefined;
			if (this.lastProjectState === 'cloning' && state !== 'cloning') {
				this.bindRepository();
				void this.refreshBranch();
			}
			this.lastProjectState = state;
		}));
		this._register(this.scmService.onDidAddRepository(() => this.bindRepository()));
		this._register(this.scmService.onDidRemoveRepository(() => this.bindRepository()));
		this._register(autorun(reader => {
			this.scmViewService.activeRepository.read(reader);
			this.bindRepository();
		}));
		this._register(addDisposableListener(getWindow(this.element), 'focus', () => {
			if (!this.repository) {
				void this.refreshBranch();
			}
		}));

		this.renderProject();
		this.renderEnvironment();
	}

	/** Like Cursor: plain text for project and branch, an icon only where it says something (the machine). */
	private trigger(icon?: ThemeIcon): HTMLButtonElement {
		const button = append(this.element, $('button.volt-agent-landing-pick')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		if (icon) {
			append(button, $('span.trigger-icon')).appendChild(renderIcon(icon));
		}
		append(button, $('span.label'));
		button.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');
		return button;
	}

	private onClick(button: HTMLButtonElement, open: () => void | Promise<void>): void {
		this._register(addDisposableListener(button, 'click', e => {
			EventHelper.stop(e, true);
			if (!button.disabled) {
				void open();
			}
		}));
	}

	/** The runner a Cloud run goes to: a machine id, or `auto`. */
	getCloudMachine(): string {
		return this.cloudMachine;
	}

	/** The branch a new worktree should use, when Run on is Worktree and one was picked. */
	getWorktreeTarget(): AgentWorktreeTarget | undefined {
		return this.runOn === 'worktree' ? this.worktreeTarget : undefined;
	}

	/** A new chat starts from the current branch again. */
	resetWorktreeTarget(): void {
		if (this.worktreeTarget) {
			this.worktreeTarget = undefined;
			this.renderEnvironment();
		}
	}

	private onProjectChanged(): void {
		this.worktreeTarget = undefined;
		this.renderProject();
		this.renderEnvironment();
		this.bindRepository();
	}

	// ---- Project ------------------------------------------------------------------------

	projectRoot(): URI | undefined {
		return this.sessionContext.activeProject?.root ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
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

	private renderProject(): void {
		const name = this.currentProjectName();
		const root = this.projectRoot();
		const project = root ? this.projects.getByUri(root) : undefined;
		const cloning = project?.state.kind === 'cloning' ? project.state : undefined;
		this.projectLabel.textContent = name
			? cloning ? localize('voltAgent.projectCloning', "{0} · Cloning {1}%", name, cloning.percent) : name
			: localize('voltAgent.selectProject', "Select project");
		this.projectButton.classList.toggle('empty', !name);
		setAgentTooltip(this.projectButton, name
			? localize('voltAgent.switchProject', "Project: {0}", root ? this.labelService.getUriLabel(root, { noPrefix: true }) : name)
			: localize('voltAgent.chooseProject', "Choose a project"));
	}

	/** The sidebar's project menu, as in Cursor; a single folder loads into this new chat. */
	private async openProjectMenu(): Promise<void> {
		await showAgentProjectMenu(this.instantiationService, this.projectButton, this.projectRoot(), this.openProject);
	}

	// ---- Branch -------------------------------------------------------------------------

	/** The SCM repository for this agent's project, when VS Code has it open. */
	private findRepository(): ISCMRepository | undefined {
		const root = this.projectRoot();
		if (root) {
			for (const repository of this.scmService.repositories) {
				if (repository.provider.rootUri && isEqual(repository.provider.rootUri, root)) {
					return repository;
				}
			}
		}
		return this.sessionContext.activeProject ? undefined : this.scmViewService.activeRepository.get();
	}

	private bindRepository(): void {
		const repository = this.findRepository();
		if (repository === this.repository && this.repositoryWatch.value) {
			return;
		}
		this.repository = repository;
		if (!repository) {
			this.repositoryWatch.clear();
			void this.refreshBranch();
			return;
		}
		this.repositoryWatch.value = autorun(reader => {
			const ref = repository.provider.historyProvider.read(reader)?.historyItemRef.read(reader);
			const name = ref?.name?.replace(/^refs\/heads\//, '');
			this.branch = name ? { name, unborn: !ref?.revision } : ref?.revision ? { detached: ref.revision.slice(0, 7) } : {};
			this.renderBranch();
			this.renderEnvironment();
			this._onDidChangeBranch.fire();
		});
	}

	/** Reads the project's branch again, as after a checkout the SCM view does not see. */
	async refreshBranch(): Promise<void> {
		const root = this.projectRoot();
		const request = ++this.branchRequest;
		if (!root || root.scheme !== 'file') {
			this.branch = {};
		} else {
			const branches = await this.gitService.listBranches({ repoRoot: root.fsPath }).catch(() => undefined);
			if (request !== this.branchRequest) {
				return;
			}
			this.branch = branches ? { name: branches.head, detached: branches.detached, unborn: branches.unborn } : {};
		}
		this.renderBranch();
		this.renderEnvironment();
		this._onDidChangeBranch.fire();
	}

	/** The project checkout's branch, ignoring any branch picked for a new worktree. */
	getBranch(): IAgentBranchState {
		return this.branch;
	}

	private hasRepository(): boolean {
		return !!this.repository || !!this.branch.name || !!this.branch.detached;
	}

	private renderBranch(): void {
		const target = this.getWorktreeTarget();
		if (target) {
			this.branchLabel.textContent = target.name;
			this.branchButton.classList.remove('empty');
			setAgentTooltip(this.branchButton, target.kind === 'new'
				? localize('voltAgent.worktreeNewBranch', "The worktree gets a new branch: {0}", target.name)
				: localize('voltAgent.worktreeBranch', "The worktree checks out {0}", target.name));
			return;
		}
		const { name, detached, unborn } = this.branch;
		this.branchLabel.textContent = name
			? unborn ? localize('voltAgent.unbornBranch', "{0} (no commits)", name) : name
			: detached ? localize('voltAgent.detached', "{0} (detached)", detached) : localize('voltAgent.noBranch', "No branch");
		this.branchButton.classList.toggle('empty', !name && !detached);
		setAgentTooltip(this.branchButton, name
			? unborn ? localize('voltAgent.unbornBranchTooltip', "Branch: {0}. It has no commits yet.", name) : localize('voltAgent.switchBranch', "Branch: {0}", name)
			: detached ? localize('voltAgent.detachedTooltip', "Detached at {0}", detached) : localize('voltAgent.noRepository', "No git repository"));
	}

	/** Run on is Worktree, but a worktree starts from a commit and this repo has none yet. */
	worktreeNeedsCommit(): boolean {
		// A picked branch, tag or ref has a commit of its own; only HEAD is empty.
		const target = this.worktreeTarget;
		return this.runOn === 'worktree' && !!this.branch.unborn && (!target || (target.kind === 'new' && !target.from));
	}

	/**
	 * Before a new chat's first send, when {@link worktreeNeedsCommit}: looks again, as a commit
	 * may have been made in a terminal since, then says why the send waits.
	 */
	async confirmWorktreeReady(): Promise<boolean> {
		if (this.worktreeNeedsCommit() && !this.repository) {
			await this.refreshBranch();
		}
		if (!this.worktreeNeedsCommit()) {
			return true;
		}
		this.notificationService.prompt(Severity.Warning, localize('voltAgent.worktreeNeedsCommit', "This repository has no commits yet. Make a first commit to use a worktree."), [{
			label: localize('voltAgent.runOnMachine', "Run on {0}", THIS_MACHINE),
			run: () => this.setRunOn('same-branch'),
		}]);
		return false;
	}

	/** VS Code's branch picker as a dropdown under the pill, shared with the changes header and the dock. */
	private openBranchMenu(): void {
		this.instantiationService.invokeFunction(showAgentBranchMenu, {
			anchor: this.branchButton,
			root: this.projectRoot(),
			repository: this.repository,
			// With Run on Worktree, picks choose the worktree's branch and leave this checkout alone.
			worktree: this.runOn === 'worktree' ? {
				target: this.worktreeTarget,
				pick: target => {
					this.worktreeTarget = target;
					this.renderEnvironment();
				},
			} : undefined,
			onDidChange: async change => {
				if (change === 'init') {
					this.repository = undefined;
				}
				if (!this.repository) {
					await this.refreshBranch();
				}
			},
		});
	}

	// ---- Environment --------------------------------------------------------------------

	private renderEnvironment(): void {
		this.runOn = normalizeAgentRunOn(this.storageService.get(agentRunOnStorageKey(this.sessionContext.activeProject?.id), StorageScope.APPLICATION));
		this.cloudMachine = normalizeCloudMachine(this.storageService.get(cloudMachineStorageKey(this.sessionContext.activeProject?.id), StorageScope.APPLICATION));
		const worktree = this.runOn === 'worktree';
		const cloud = this.runOn === 'cloud';
		const blocked = this.worktreeNeedsCommit();
		this.envLabel.textContent = worktree ? localize('voltAgent.env.worktree', "Worktree") : cloud ? localize('voltAgent.env.cloud', "Cloud") : THIS_MACHINE;
		this.envIcon.replaceChildren(renderIcon(blocked ? Codicon.warning : worktree ? Codicon.repoForked : cloud ? Codicon.cloud : Codicon.deviceDesktop));
		this.envButton.classList.toggle('worktree', worktree);
		this.envButton.classList.toggle('cloud', cloud);
		this.envButton.classList.toggle('blocked', blocked);
		setAgentTooltip(this.envButton, blocked
			? localize('voltAgent.worktreeNeedsCommit', "This repository has no commits yet. Make a first commit to use a worktree.")
			: worktree
				? localize('voltAgent.env.worktreeTooltip', "Runs in a new worktree, so your checkout is untouched")
				: cloud
					? localize('voltAgent.env.cloudTooltip', "Runs on a Volt Relay runner; your checkout goes along as a bundle")
					: localize('voltAgent.env.localTooltip', "Runs in your checkout"));
		// The branch button shows the worktree's branch only in Worktree mode.
		this.renderBranch();
		if (cloud && this.cloudMachine !== CLOUD_AUTO) {
			void this.cache.read(this.runnersQuery()).then(runners => {
				const machine = runners?.find(candidate => candidate.id === this.cloudMachine);
				this.envLabel.textContent = machine ? `${localize('voltAgent.env.cloud', "Cloud")} · ${machine.name}` : this.envLabel.textContent;
			}, () => undefined);
		}
	}

	/**
	 * The relay's runners, cached so the Run on menu opens on the last list while it is asked again.
	 * Undefined (cached too) means the relay could not be reached: the menu offers to connect.
	 */
	private runnersQuery(): IVoltQuery<IRelayMachine[] | undefined> {
		return { key: 'cloud.runners', staleTime: 30_000, maxAge: 24 * 60 * 60_000, fetch: () => this.cloud.runners().catch(() => undefined) };
	}

	/** "Run on", as in Cursor: this machine, a new worktree, or a Volt Relay runner in the cloud. */
	private async openEnvironmentMenu(): Promise<void> {
		const repo = this.hasRepository();
		const unborn = !!this.branch.unborn;
		// Runners and their load come from the relay; without a connection the Cloud section offers to connect.
		const runners = await this.cache.read(this.runnersQuery()).catch(() => undefined);
		const cloudItem = (machineId: string, label: string, extra: Partial<IVoltMenuItem<RunOnPick>> = {}): IVoltMenuItem<RunOnPick> => ({
			id: `cloud:${machineId}`,
			label,
			checked: this.runOn === 'cloud' && this.cloudMachine === machineId,
			disabled: !repo,
			tooltip: !repo ? localize('voltAgent.env.cloudNeedsGit', "Needs a git repository") : undefined,
			data: { runOn: 'cloud', machineId },
			...extra,
		});
		const cloudSection: IVoltMenuSection<RunOnPick> = runners === undefined
			? { id: 'cloud', title: localize('voltAgent.env.cloudTitle', "Cloud"), items: [{ id: 'connect', label: localize('voltAgent.env.connectRelay', "Connect to Volt Relay…"), icon: Codicon.plug, trailingIcon: Codicon.arrowRight, data: { connect: true } }] }
			: {
				id: 'cloud',
				title: localize('voltAgent.env.cloudTitle', "Cloud"),
				items: [
					cloudItem(CLOUD_AUTO, localize('voltAgent.env.cloudAuto', "Auto (least loaded)"), {
						icon: Codicon.sparkle,
						detail: localize('voltAgent.env.cloudAutoDetail', "The runner with the most free capacity"),
					}),
					...runners.map(machine => cloudRunnerItem(machine, cloudItem)),
				],
				emptyMessage: localize('voltAgent.env.noRunners', "No runners yet. Start volt-runner and it shows up here."),
			};
		showVoltMenu<RunOnPick>(this.contextViewService, {
			anchor: this.envButton,
			ariaLabel: localize('voltAgent.env.runOn', "Run on"),
			width: 260,
			sections: [
				{ id: 'machine', title: localize('voltAgent.env.runOn', "Run on"), items: [{ id: 'local', label: THIS_MACHINE, icon: Codicon.deviceDesktop, checked: this.runOn === 'same-branch', data: { runOn: 'same-branch' } }] },
				{
					id: 'worktree',
					items: [{
						id: 'worktree',
						label: localize('voltAgent.env.newWorktree', "New Worktree"),
						icon: Codicon.add,
						checked: this.runOn === 'worktree',
						disabled: !repo || unborn,
						tooltip: !repo
							? localize('voltAgent.env.needsGit', "Needs a git repository")
							: unborn
								? localize('voltAgent.env.needsCommit', "Needs a first commit")
								: localize('voltAgent.env.worktreeDescription', "An isolated copy of the repo; review the changes to apply them"),
						data: { runOn: 'worktree' },
					}],
				},
				cloudSection,
			],
			onPick: item => {
				if ('connect' in item.data) {
					void this.commandService.executeCommand(VOLT_RELAY_CONNECT_COMMAND_ID);
				} else {
					this.setRunOn(item.data.runOn, item.data.machineId);
				}
			},
		});
	}

	private setRunOn(runOn: AgentRunOn, machineId?: string): void {
		this.storageService.store(agentRunOnStorageKey(this.sessionContext.activeProject?.id), runOn, StorageScope.APPLICATION, StorageTarget.USER);
		if (machineId) {
			this.storageService.store(cloudMachineStorageKey(this.sessionContext.activeProject?.id), machineId, StorageScope.APPLICATION, StorageTarget.USER);
		}
		this.renderEnvironment();
	}
}

/** What a Run on item picks: a location, or Cloud with a runner (`auto` for the least loaded). */
type RunOnPick = { readonly runOn: AgentRunOn; readonly machineId?: string } | { readonly connect: true };

/** One runner in the Cloud section: its load bars, and why it cannot take the chat's agent when it cannot. */
function cloudRunnerItem(machine: IRelayMachine, item: (machineId: string, label: string, extra?: Partial<IVoltMenuItem<RunOnPick>>) => IVoltMenuItem<RunOnPick>): IVoltMenuItem<RunOnPick> {
	const eligible = machine.online && (canTakeAgent(machine, 'codex') || canTakeAgent(machine, 'claude'));
	const reason = machine.placement?.codex?.reason ?? machine.placement?.claude?.reason;
	return item(machine.id, machine.name, {
		icon: Codicon.server,
		detail: describeMachineLoad(machine),
		load: { cpu: cpuPressure(machine.load), memory: memoryPressure(machine.load) },
		disabled: !eligible,
		tooltip: eligible ? undefined : !machine.online ? localize('voltAgent.env.runnerOffline', "Offline")
			: reason ? localize('voltAgent.env.runnerReason', "The relay does not place work here: {0}", reason)
				: localize('voltAgent.env.runnerNoAgent', "This runner has no Codex or Claude Code login"),
	});
}
