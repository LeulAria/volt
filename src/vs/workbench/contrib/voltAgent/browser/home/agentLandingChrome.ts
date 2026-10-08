/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
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
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltGitBranches, IVoltGitBranchRef, IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AgentRunOn, agentRunOnStorageKey, AgentWorktreeTarget, normalizeAgentRunOn } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { CLOUD_AUTO, cloudMachineStorageKey, normalizeCloudMachine } from '../../../../services/voltRuntime/common/cloud/cloudTasks.js';
import { cpuPressure, describeMachineLoad, IRelayMachine, machineEligibility, memoryPressure } from '../../../../services/voltRuntime/common/relay/relayMachines.js';
import { IAgentCloudTasksService } from '../../../../services/voltRuntime/browser/cloud/agentCloudTasksService.js';
import { VOLT_RELAY_CONNECT_COMMAND_ID } from '../schedules/agentWebhookRelay.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { IVoltProjectsService } from '../../../voltProjects/common/projects.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuPrompt, IVoltMenuSection, IVoltSubmenu, showVoltMenu } from '../ui/menu/voltMenu.js';
import { INIT_TIMEOUT_MS, runGit, showAgentProjectMenu } from './agentHomeWorkspaceActions.js';
import { landingWorkspaceName } from './agentLandingModel.js';

type BranchPick =
	| { readonly kind: 'ref'; readonly name: string; readonly ref: 'local' | 'remote' | 'tag' }
	| { readonly kind: 'detached'; readonly ref: string }
	| { readonly kind: 'init' }
	/** Rows that open a flyout or a prompt; never picked. */
	| { readonly kind: 'none' };

const NO_PICK: BranchPick = { kind: 'none' };
/** What `git check-ref-format --branch` refuses, checked while typing. */
export const BAD_BRANCH_NAME = /^-|\.\.|[\s~^:?*[\\]|@\{|\/$|\.lock$|^\/|\/\//;

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
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IAgentCloudTasksService private readonly cloud: IAgentCloudTasksService,
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

	/** Volt's git (with each ref's latest commit), else the SCM view's refs for a project it cannot reach. */
	private async loadBranches(): Promise<IVoltGitBranches | undefined> {
		const root = this.projectRoot();
		if (root?.scheme === 'file') {
			const branches = await this.gitService.listBranches({ repoRoot: root.fsPath }).catch(() => undefined);
			if (branches && (branches.head || branches.detached || branches.refs.length)) {
				return branches;
			}
		}
		const refs = await this.repository?.provider.historyProvider.get()?.provideHistoryItemRefs().catch(() => undefined);
		if (!refs) {
			return undefined;
		}
		const all: IVoltGitBranchRef[] = [];
		for (const ref of refs) {
			const kind = ref.id.startsWith('refs/heads/') ? 'local'
				: ref.id.startsWith('refs/remotes/') && !ref.id.endsWith('/HEAD') ? 'remote'
					: ref.id.startsWith('refs/tags/') ? 'tag' : undefined;
			if (kind) {
				all.push({ kind, name: ref.name, ref: ref.id, subject: '', author: '', date: 0 });
			}
		}
		const names = (kind: IVoltGitBranchRef['kind']) => all.filter(ref => ref.kind === kind).map(ref => ref.name);
		return { head: this.branch.name, unborn: this.branch.unborn, detached: this.branch.detached, local: names('local'), remote: names('remote'), tags: names('tag'), refs: all };
	}

	/**
	 * VS Code's branch picker (the status bar's Checkout to...) in the Open Workspace menu's
	 * look: create a branch, create one from a ref, check out detached, then every branch,
	 * remote branch and tag with its latest commit.
	 */
	private openBranchMenu(): void {
		const root = this.projectRoot();
		const repoRoot = root?.scheme === 'file' ? root.fsPath : undefined;
		// With Run on Worktree, picks choose the worktree's branch and leave this checkout alone.
		const worktree = this.runOn === 'worktree';
		showVoltMenu<BranchPick>(this.contextViewService, {
			anchor: this.branchButton,
			ariaLabel: localize('voltAgent.branchMenu', "Branches"),
			search: {
				placeholder: worktree
					? localize('voltAgent.searchWorktreeBranches', "Select a branch for the worktree")
					: localize('voltAgent.searchBranches', "Select a branch or tag to checkout"),
			},
			width: 380,
			sections: async () => {
				const branches = await this.loadBranches();
				if (!branches || (!branches.head && !branches.detached && !branches.local.length)) {
					return [{ id: 'none', items: [{ id: 'init', label: localize('voltAgent.initRepository', "Initialize Repository"), icon: Codicon.repo, tooltip: localize('voltAgent.noRepository', "No git repository"), data: { kind: 'init' } }] }];
				}
				const current = branches.head;
				const target = worktree ? this.worktreeTarget : undefined;
				const existing = new Set(branches.local);
				const ofKind = (kind: IVoltGitBranchRef['kind']) => branches.refs.filter(ref => ref.kind === kind);
				// The checked-out branch first, then the rest by latest commit.
				const local = [...ofKind('local')].sort((a, b) => Number(b.name === current) - Number(a.name === current));
				const isPicked = (ref: IVoltGitBranchRef) => target
					? target.kind !== 'new' && target.name === ref.name && (target.kind === 'branch' ? ref.kind === 'local' : target.kind === ref.kind)
					: ref.kind === 'local' && ref.name === current;
				const checkout = (ref: IVoltGitBranchRef) => refItem(ref, { kind: 'ref', name: ref.name, ref: ref.kind }, isPicked(ref));
				const newTarget: IVoltMenuItem<BranchPick>[] = target?.kind === 'new'
					? [{ id: 'new-target', label: target.name, icon: Codicon.gitBranch, detail: localize('voltAgent.worktreeNewBranchDetail', "new branch for the worktree"), checked: true, data: NO_PICK }]
					: [];
				const hasRefs = branches.refs.length > 0;
				const actions: IVoltMenuItem<BranchPick>[] = repoRoot ? [
					// Before the first commit a new branch has nothing to start from, except in this checkout.
					worktree && branches.unborn ? {
						id: 'needsCommit',
						label: localize('voltAgent.worktreeNeedsCommitShort', "Make a first commit to use a worktree"),
						icon: Codicon.warning,
						alwaysShow: true,
						disabled: true,
						data: NO_PICK,
					} : {
						id: 'create',
						label: localize('voltAgent.createBranch', "Create new branch..."),
						icon: Codicon.add,
						alwaysShow: true,
						prompt: this.branchPrompt(repoRoot, existing, worktree),
						data: NO_PICK,
					},
					...hasRefs ? [{
						id: 'createFrom',
						label: localize('voltAgent.createBranchFrom', "Create new branch from..."),
						icon: Codicon.add,
						submenu: refMenu(branches.refs, localize('voltAgent.createBranchFromPlaceholder', "Select a ref to create the branch from"), ref => refItem(ref, NO_PICK, false, this.branchPrompt(repoRoot, existing, worktree, ref))),
						data: NO_PICK,
					} satisfies IVoltMenuItem<BranchPick>] : [],
					// A worktree needs a branch; detached checkouts stay a This Mac thing.
					...worktree || !hasRefs ? [] : [{
						id: 'detached',
						label: localize('voltAgent.checkoutDetached', "Checkout detached..."),
						icon: Codicon.debugDisconnect,
						submenu: refMenu(branches.refs, localize('voltAgent.checkoutDetachedPlaceholder', "Select a ref to checkout in detached mode"), ref => refItem(ref, { kind: 'detached', ref: ref.ref })),
						data: NO_PICK,
					} satisfies IVoltMenuItem<BranchPick>],
				] : [];
				const head: IVoltMenuItem<BranchPick>[] = !current && branches.detached
					? [{ id: 'detached-head', label: localize('voltAgent.detached', "{0} (detached)", branches.detached), icon: Codicon.gitCommit, checked: !target, disabled: true, data: NO_PICK }]
					// A branch with no commits has no ref, so it is not among the rest.
					: current && branches.unborn
						? [{ id: 'unborn-head', label: current, icon: Codicon.gitBranch, detail: localize('voltAgent.noCommitsYet', "no commits yet"), checked: !target, disabled: true, data: NO_PICK }]
						: [];
				return [
					{ id: 'actions', items: actions },
					{ id: 'local', title: localize('voltAgent.branches', "Branches"), items: [...newTarget, ...head, ...local.map(checkout)] },
					{ id: 'remote', title: localize('voltAgent.remoteBranches', "Remote branches"), items: ofKind('remote').map(checkout) },
					{ id: 'tags', title: localize('voltAgent.tags', "Tags"), items: ofKind('tag').map(checkout) },
				];
			},
			emptyMessage: localize('voltAgent.noBranches', "No matching branches"),
			onPick: item => this.pickBranch(item.data),
		});
	}

	/**
	 * Asked in the menu's search field, as VS Code asks after Create new branch. For a worktree
	 * the name is kept for the first send, which makes the branch along with the checkout.
	 */
	private branchPrompt(repoRoot: string, existing: ReadonlySet<string>, worktree: boolean, from?: IVoltGitBranchRef): IVoltMenuPrompt {
		return {
			placeholder: from
				? localize('voltAgent.branchNameFrom', "Branch name (from {0})", from.name)
				: localize('voltAgent.branchName', "Branch name"),
			hint: worktree
				? from
					? localize('voltAgent.worktreeBranchFromHint', "Press Enter to give the worktree a new branch from {0}", from.name)
					: localize('voltAgent.worktreeBranchHint', "Press Enter to give the worktree a new branch")
				: from
					? localize('voltAgent.branchFromHint', "Press Enter to create the branch from {0} and switch to it", from.name)
					: localize('voltAgent.branchHint', "Press Enter to create the branch and switch to it"),
			useQuery: !from,
			validate: value => BAD_BRANCH_NAME.test(value)
				? localize('voltAgent.badBranchName', "Not a valid branch name")
				: existing.has(value) ? localize('voltAgent.branchExists', "A branch named {0} already exists", value) : undefined,
			onSubmit: async name => {
				if (worktree) {
					this.worktreeTarget = { kind: 'new', name, from: from?.ref };
					this.renderEnvironment();
					return;
				}
				await this.gitService.createBranch({ repoRoot, name, from: from?.ref });
				await this.afterCheckout();
			},
		};
	}

	/** Worktree mode: remember the branch for the first send. The current branch means the default. */
	private pickWorktreeBranch(pick: BranchPick): void {
		if (pick.kind !== 'ref') {
			return;
		}
		this.worktreeTarget = pick.ref === 'local'
			? pick.name === this.branch.name ? undefined : { kind: 'branch', name: pick.name }
			: { kind: pick.ref, name: pick.name };
		this.renderEnvironment();
	}

	private async pickBranch(pick: BranchPick): Promise<void> {
		const root = this.projectRoot();
		if (!root) {
			return;
		}
		try {
			if (pick.kind === 'init') {
				// The agent window has no git extension, so git runs in the user's shell, as Start from scratch does.
				const result = await runGit(this.stdio, root.fsPath, ['init'], INIT_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					throw new Error(result.timedOut
						? localize('voltAgent.initTimedOut', "git init did not finish in time")
						: result.stderr.trim() || localize('voltAgent.initFailed', "git init failed"));
				}
				this.repository = undefined;
				await this.refreshBranch();
				return;
			}
			if (this.runOn === 'worktree') {
				this.pickWorktreeBranch(pick);
				return;
			}
			if (pick.kind === 'detached') {
				await this.gitService.checkout({ repoRoot: root.fsPath, ref: pick.ref, kind: 'detached' });
				await this.afterCheckout();
				return;
			}
			if (pick.kind !== 'ref' || (pick.ref === 'local' && pick.name === this.branch.name)) {
				return;
			}
			if (this.repository?.provider.rootUri && pick.ref !== 'remote') {
				// The git extension's checkout: same errors and dirty-tree handling as the SCM view.
				await this.commandService.executeCommand('git.checkout', this.repository.provider.rootUri, pick.ref === 'tag' ? `refs/tags/${pick.name}` : pick.name);
			} else {
				await this.gitService.checkout({ repoRoot: root.fsPath, ref: pick.name, kind: pick.ref });
			}
			await this.afterCheckout();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private async afterCheckout(): Promise<void> {
		if (!this.repository) {
			await this.refreshBranch();
		}
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
			void this.cloud.runners().then(runners => {
				const machine = runners.find(candidate => candidate.id === this.cloudMachine);
				this.envLabel.textContent = machine ? `${localize('voltAgent.env.cloud', "Cloud")} · ${machine.name}` : this.envLabel.textContent;
			}, () => undefined);
		}
	}

	/** "Run on", as in Cursor: this machine, a new worktree, or a Volt Relay runner in the cloud. */
	private async openEnvironmentMenu(): Promise<void> {
		const repo = this.hasRepository();
		const unborn = !!this.branch.unborn;
		// Runners and their load come from the relay; without a connection the Cloud section offers to connect.
		const runners = await this.cloud.runners().catch(() => undefined);
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
	const eligible = machine.online && (machineEligibility(machine, { agent: 'codex' }).eligible || machineEligibility(machine, { agent: 'claude' }).eligible);
	return item(machine.id, machine.name, {
		icon: Codicon.server,
		detail: describeMachineLoad(machine),
		load: { cpu: cpuPressure(machine.load), memory: memoryPressure(machine.load) },
		disabled: !eligible,
		tooltip: eligible ? undefined : machine.online ? localize('voltAgent.env.runnerNoAgent', "This runner has no Codex or Claude Code login") : localize('voltAgent.env.runnerOffline', "Offline"),
	});
}

/** A branch, remote branch or tag: its name, then its latest commit's subject and age, as in VS Code. */
function refItem(ref: IVoltGitBranchRef, data: BranchPick, checked = false, prompt?: IVoltMenuPrompt): IVoltMenuItem<BranchPick> {
	const commit = [ref.author, ref.subject].filter(Boolean).join(' \u2022 ');
	return {
		id: `${ref.kind}:${ref.name}`,
		label: ref.name,
		icon: ref.kind === 'remote' ? Codicon.cloud : ref.kind === 'tag' ? Codicon.tag : Codicon.gitBranch,
		detail: ref.subject || undefined,
		keybinding: ref.date ? fromNow(ref.date, true, true) : undefined,
		tooltip: commit ? `${ref.name}\n${commit}` : ref.name,
		checked,
		prompt,
		data,
	};
}

/** Every ref, grouped like the main list, for Create new branch from and Checkout detached. */
function refMenu(refs: readonly IVoltGitBranchRef[], placeholder: string, item: (ref: IVoltGitBranchRef) => IVoltMenuItem<BranchPick>): IVoltSubmenu<BranchPick> {
	const group = (id: string, title: string, kind: IVoltGitBranchRef['kind']) => ({ id, title, items: refs.filter(ref => ref.kind === kind).map(item) });
	return {
		search: { placeholder },
		width: 380,
		emptyMessage: localize('voltAgent.noRefs', "No matching refs"),
		sections: [
			group('local', localize('voltAgent.branches', "Branches"), 'local'),
			group('remote', localize('voltAgent.remoteBranches', "Remote branches"), 'remote'),
			group('tags', localize('voltAgent.tags', "Tags"), 'tag'),
		],
	};
}
