/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ILabelService, Verbosity } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltGitBranches, IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AgentRunOn, agentRunOnStorageKey, normalizeAgentRunOn } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { IVoltProjectsService, VoltProjectCommands } from '../../../voltProjects/common/projects.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { landingWorkspaceName } from './agentLandingModel.js';

type BranchPick =
	| { readonly kind: 'ref'; readonly name: string; readonly ref: 'local' | 'remote' | 'tag' }
	| { readonly kind: 'create' }
	| { readonly kind: 'init' };

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
	private branch: { readonly name?: string; readonly detached?: string } = {};
	private repository: ISCMRepository | undefined;
	private runOn: AgentRunOn = 'same-branch';
	private branchRequest = 0;
	private lastProjectState: string | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
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

	private onProjectChanged(): void {
		this.renderProject();
		this.renderEnvironment();
		this.bindRepository();
	}

	// ---- Project ------------------------------------------------------------------------

	private projectRoot(): URI | undefined {
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

	/** The same menu as Add Project, as in Cursor: pick a project, or add one from This PC, Git or GitHub. */
	private async openProjectMenu(): Promise<void> {
		await this.commandService.executeCommand(VoltProjectCommands.addProject, { anchor: this.projectButton, current: this.projectRoot() });
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
			this.branch = name ? { name } : ref?.revision ? { detached: ref.revision.slice(0, 7) } : {};
			this.renderBranch();
			this.renderEnvironment();
		});
	}

	private async refreshBranch(): Promise<void> {
		const root = this.projectRoot();
		const request = ++this.branchRequest;
		if (!root || root.scheme !== 'file') {
			this.branch = {};
		} else {
			const branches = await this.gitService.listBranches({ repoRoot: root.fsPath }).catch(() => undefined);
			if (request !== this.branchRequest) {
				return;
			}
			this.branch = branches ? { name: branches.head, detached: branches.detached } : {};
		}
		this.renderBranch();
		this.renderEnvironment();
	}

	private hasRepository(): boolean {
		return !!this.repository || !!this.branch.name || !!this.branch.detached;
	}

	private renderBranch(): void {
		const { name, detached } = this.branch;
		this.branchLabel.textContent = name ?? (detached ? localize('voltAgent.detached', "{0} (detached)", detached) : localize('voltAgent.noBranch', "No branch"));
		this.branchButton.classList.toggle('empty', !name && !detached);
		setAgentTooltip(this.branchButton, name
			? localize('voltAgent.switchBranch', "Branch: {0}", name)
			: detached ? localize('voltAgent.detachedTooltip', "Detached at {0}", detached) : localize('voltAgent.noRepository', "No git repository"));
	}

	private async loadBranches(): Promise<IVoltGitBranches | undefined> {
		const repository = this.repository;
		const history = repository?.provider.historyProvider.get();
		if (history) {
			const refs = await history.provideHistoryItemRefs().catch(() => undefined);
			if (refs) {
				const local: string[] = [];
				const remote: string[] = [];
				const tags: string[] = [];
				for (const ref of refs) {
					if (ref.id.startsWith('refs/heads/')) {
						local.push(ref.name);
					} else if (ref.id.startsWith('refs/remotes/') && !ref.id.endsWith('/HEAD')) {
						remote.push(ref.name);
					} else if (ref.id.startsWith('refs/tags/')) {
						tags.push(ref.name);
					}
				}
				return { head: this.branch.name, detached: this.branch.detached, local, remote, tags };
			}
		}
		const root = this.projectRoot();
		return root?.scheme === 'file' ? this.gitService.listBranches({ repoRoot: root.fsPath }).catch(() => undefined) : undefined;
	}

	private openBranchMenu(): void {
		const root = this.projectRoot();
		showVoltMenu<BranchPick>(this.contextViewService, {
			anchor: this.branchButton,
			ariaLabel: localize('voltAgent.branchMenu', "Branches"),
			search: { placeholder: localize('voltAgent.searchBranches', "Search branches...") },
			width: 260,
			sections: async () => {
				const branches = await this.loadBranches();
				if (!branches || (!branches.head && !branches.detached && !branches.local.length)) {
					return [{ id: 'none', items: [{ id: 'init', label: localize('voltAgent.initRepository', "Initialize Repository"), icon: Codicon.repo, tooltip: localize('voltAgent.noRepository', "No git repository"), data: { kind: 'init' } }] }];
				}
				const current = branches.head;
				const item = (name: string, ref: 'local' | 'remote' | 'tag', checked = false): IVoltMenuItem<BranchPick> => ({ id: `${ref}:${name}`, label: name, checked, tooltip: name, data: { kind: 'ref', name, ref } });
				const head: IVoltMenuItem<BranchPick>[] = current
					? [item(current, 'local', true)]
					: branches.detached ? [{ id: 'detached', label: localize('voltAgent.detached', "{0} (detached)", branches.detached), checked: true, disabled: true, data: { kind: 'ref', name: branches.detached, ref: 'tag' } }] : [];
				// Cursor lists local branches; remote branches and tags join in once you search.
				return [
					{ id: 'local', items: [...head, ...branches.local.filter(name => name !== current).map(name => item(name, 'local'))] },
					{ id: 'remote', title: localize('voltAgent.remoteBranches', "Remote"), searchOnly: true, items: branches.remote.map(name => item(name, 'remote')) },
					{ id: 'tags', title: localize('voltAgent.tags', "Tags"), searchOnly: true, items: branches.tags.map(name => item(name, 'tag')) },
				];
			},
			footer: root ? [{ id: 'create', label: localize('voltAgent.createBranch', "Create new branch..."), icon: Codicon.add, data: { kind: 'create' } }] : [],
			inlineInput: root ? {
				itemId: 'create',
				placeholder: localize('voltAgent.branchName', "Branch name, then Enter"),
				validate: value => /^-|\.\.|[\s~^:?*[\\]|@\{|\/$|\.lock$|^\/|\/\//.test(value) ? localize('voltAgent.badBranchName', "Not a valid branch name") : undefined,
				onSubmit: async name => {
					await this.gitService.createBranch({ repoRoot: root.fsPath, name });
					await this.afterCheckout();
				},
			} : undefined,
			emptyMessage: localize('voltAgent.noBranches', "No matching branches"),
			onPick: item => this.pickBranch(item.data),
		});
	}

	private async pickBranch(pick: BranchPick): Promise<void> {
		const root = this.projectRoot();
		if (!root) {
			return;
		}
		try {
			if (pick.kind === 'init') {
				await this.commandService.executeCommand('git.init');
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
		const worktree = this.runOn === 'worktree';
		this.envLabel.textContent = worktree ? localize('voltAgent.env.worktree', "Worktree") : THIS_MACHINE;
		this.envIcon.replaceChildren(renderIcon(worktree ? Codicon.repoForked : Codicon.deviceDesktop));
		this.envButton.classList.toggle('worktree', worktree);
		setAgentTooltip(this.envButton, worktree
			? localize('voltAgent.env.worktreeTooltip', "Runs in a new worktree, so your checkout is untouched")
			: localize('voltAgent.env.localTooltip', "Runs in your checkout"));
	}

	/** "Run on", as in Cursor: this machine, or a new worktree. */
	private openEnvironmentMenu(): void {
		const repo = this.hasRepository();
		showVoltMenu<AgentRunOn>(this.contextViewService, {
			anchor: this.envButton,
			ariaLabel: localize('voltAgent.env.runOn', "Run on"),
			width: 220,
			sections: [
				{ id: 'machine', title: localize('voltAgent.env.runOn', "Run on"), items: [{ id: 'local', label: THIS_MACHINE, icon: Codicon.deviceDesktop, checked: this.runOn === 'same-branch', data: 'same-branch' }] },
				{
					id: 'worktree',
					items: [{
						id: 'worktree',
						label: localize('voltAgent.env.newWorktree', "New Worktree"),
						icon: Codicon.add,
						checked: this.runOn === 'worktree',
						disabled: !repo,
						tooltip: repo ? localize('voltAgent.env.worktreeDescription', "An isolated copy of the repo; review the changes to apply them") : localize('voltAgent.env.needsGit', "Needs a git repository"),
						data: 'worktree',
					}],
				},
			],
			onPick: item => {
				this.storageService.store(agentRunOnStorageKey(this.sessionContext.activeProject?.id), item.data, StorageScope.APPLICATION, StorageTarget.USER);
				this.renderEnvironment();
			},
		});
	}
}
