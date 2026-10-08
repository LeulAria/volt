/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IVoltPrRepo, IVoltPullRequest, voltPrErrorCode, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { isTrunkBranch } from '../../common/agentPullRequests.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { problemText, signInWithGh } from './agentPullRequestUi.js';

/**
 * The form for a new pull request from the folder's branch: base, title and description (written
 * by the text generation model from the branch's commits and diff), draft. Creating pushes the
 * branch first when it has commits the remote lacks, then links the pull request to the chat.
 */
export class AgentPullRequestCreateView extends Disposable {

	readonly element: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly _onDidCreate = this._register(new Emitter<IVoltPullRequest>());
	readonly onDidCreate = this._onDidCreate.event;

	private folder: string | undefined;
	private sessionId: string | undefined;
	private repo: IVoltPrRepo | undefined;
	private branches: string[] = [];
	/** The repository's default branch (the first remoteBranches returns). */
	private defaultBranch: string | undefined;
	/** An open pull request this branch already has: offered instead of a second one. */
	private existing: IVoltPullRequest | undefined;
	private base: string | undefined;
	private title = '';
	private body = '';
	private draft = false;
	private error: unknown;
	private loading = false;
	private generating = false;
	private creating = false;
	private loadSeq = 0;
	/** The user edited the text: generation must not overwrite it. */
	private touched = false;
	/** A render put off while the user typed; it runs when they leave the field. */
	private renderPending = false;

	constructor(
		parent: HTMLElement,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.element = append(parent, $('.volt-pr-view.volt-pr-create'));
		this._register(addDisposableListener(this.element, 'focusout', () => {
			setTimeout(() => {
				const active = this.element.ownerDocument.activeElement;
				if (this.renderPending && !(active && this.element.contains(active))) {
					this.render();
				}
			}, 0);
		}));
	}

	setTarget(folder: string | undefined, sessionId: string | undefined): void {
		if (this.folder === folder && this.sessionId === sessionId) {
			void this.refreshIfStale();
			return;
		}
		this.folder = folder;
		this.sessionId = sessionId;
		this.repo = undefined;
		this.branches = [];
		this.base = undefined;
		this.existing = undefined;
		this.title = '';
		this.body = '';
		this.touched = false;
		this.error = undefined;
		void this.load();
	}

	/**
	 * The tab can stay open while the checkout moves on (another branch checked out, a push).
	 * Shown again, it reads the repository again; a new branch starts the form over.
	 */
	async refreshIfStale(): Promise<void> {
		const folder = this.folder;
		if (!folder || this.loading || this.creating) {
			return;
		}
		const repo = await this.pullRequests.repoForFolder(folder, true);
		if (folder !== this.folder || this.loading || this.creating) {
			return;
		}
		if (repo?.branch !== this.repo?.branch || !this.repo) {
			this.title = '';
			this.body = '';
			this.touched = false;
			this.existing = undefined;
			this.error = undefined;
			await this.load();
		} else if (repo && (repo.ahead !== this.repo.ahead || repo.upstream !== this.repo.upstream)) {
			this.repo = repo;
			this.render();
		}
	}

	private async load(): Promise<void> {
		const folder = this.folder;
		if (!folder) {
			return;
		}
		const seq = ++this.loadSeq;
		this.loading = true;
		this.render();
		try {
			const repo = await this.pullRequests.repoForFolder(folder, true);
			if (!repo) {
				throw new Error(localize('voltPr.create.noRepo', "This folder has no GitHub remote."));
			}
			const [branches, existing] = await Promise.all([
				this.pullRequests.api.remoteBranches({ repo }),
				repo.branch ? this.pullRequests.api.forBranch({ repo, branch: repo.branch }).catch(() => []) : Promise.resolve([]),
			]);
			if (seq !== this.loadSeq) {
				return;
			}
			this.repo = repo;
			this.defaultBranch = branches[0];
			this.existing = existing.find(pr => pr.state === 'open' || pr.state === 'draft');
			this.branches = branches.filter(branch => branch !== repo.branch);
			this.base = this.branches[0];
			const parent = repo.branch ? (await this.pullRequests.stack(folder, repo.branch).catch(() => undefined))?.stack.layers.find(layer => layer.branch === repo.branch)?.parent : undefined;
			if (parent && this.branches.includes(parent)) {
				this.base = parent;
			}
			this.error = undefined;
		} catch (err) {
			if (seq === this.loadSeq) {
				this.error = err;
			}
		} finally {
			if (seq === this.loadSeq) {
				this.loading = false;
				this.render();
			}
		}
		if (seq === this.loadSeq && this.repo && this.base && !this.touched && !this.existing && this.repo.branch !== this.defaultBranch) {
			void this.generate();
		}
	}

	private async generate(): Promise<void> {
		const folder = this.folder;
		const base = this.base;
		if (!folder || !base || this.generating) {
			return;
		}
		this.generating = true;
		this.render();
		try {
			const text = await this.pullRequests.generatePullRequestText(folder, base, this.sessionId);
			if (text && !this.touched) {
				this.title = text.title;
				this.body = text.body;
			}
		} catch (err) {
			this.error = err;
		} finally {
			this.generating = false;
			// The user took over the fields while it wrote: leave them be (rebuilding would take the caret).
			const active = this.element.ownerDocument.activeElement;
			const typing = this.touched && !!active && this.element.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
			if (typing) {
				this.renderPending = true;
			} else {
				this.render();
			}
		}
	}

	private async create(): Promise<void> {
		const folder = this.folder;
		if (!folder || !this.base || !this.title.trim() || this.creating) {
			return;
		}
		this.creating = true;
		this.error = undefined;
		this.render();
		try {
			const pr = await this.pullRequests.create(this.sessionId, folder, { title: this.title, body: this.body, base: this.base, draft: this.draft });
			this._onDidCreate.fire(pr);
		} catch (err) {
			this.error = err;
		} finally {
			this.creating = false;
			this.render();
		}
	}

	private render(): void {
		this.renderPending = false;
		this.renderStore.clear();
		clearNode(this.element);
		const header = append(this.element, $('.volt-pr-header'));
		const top = append(header, $('.volt-pr-header-row'));
		append(top, $('span.volt-pr-icon.state-open')).appendChild(renderIcon(Codicon.gitPullRequestCreate));
		append(top, $('span.volt-pr-repo')).textContent = this.repo ? `${this.repo.owner}/${this.repo.name}` : localize('voltPr.create.title', "New Pull Request");
		append(header, $('h1.volt-pr-title')).textContent = localize('voltPr.create.heading', "Open a pull request");
		const body = append(this.element, $('.volt-pr-body'));

		if (this.loading) {
			const skeleton = append(body, $('.volt-pr-skeleton'));
			for (const width of [50, 90, 70]) {
				append(skeleton, $('.volt-pr-skeleton-line')).style.width = `${width}%`;
			}
			return;
		}
		const repo = this.repo;
		if (!repo) {
			this.renderProblem(body);
			return;
		}
		if (repo.provider === 'unknown') {
			this.renderProblem(body, localize('voltPr.create.onlyKnown', "Volt opens pull requests on GitHub, GitLab, Bitbucket, Gitea, Forgejo and Azure DevOps. Sign in to this server first."));
			return;
		}
		if (!repo.branch) {
			this.renderProblem(body, localize('voltPr.detachedLong', "HEAD is detached. Check out a branch to open a pull request from it."));
			return;
		}

		if (repo.branch === this.defaultBranch) {
			this.renderProblem(body, localize('voltPr.create.onDefault', "You are on {0}, the default branch. Check out a feature branch (or start the chat on a new worktree) to open a pull request from it.", repo.branch));
			return;
		}
		const existing = this.existing;
		if (existing) {
			const card = append(body, $('.volt-pr-card.volt-pr-existing'));
			const row = append(card, $('.volt-pr-status-row'));
			append(row, $(`span.volt-pr-icon.state-${existing.state}`)).appendChild(renderIcon(existing.state === 'draft' ? Codicon.gitPullRequestDraft : Codicon.gitPullRequest));
			const text = append(row, $('.volt-pr-status-text'));
			append(text, $('.volt-pr-status-title')).textContent = localize('voltPr.create.exists', "{0} already has an open pull request", repo.branch);
			append(text, $('.volt-pr-status-detail')).textContent = `#${existing.number} ${existing.title}`;
			const open = append(row, $('button.volt-pr-button.primary')) as HTMLButtonElement;
			open.textContent = localize('voltPr.create.openExisting', "Open #{0}", existing.number);
			this.on(open, async () => {
				if (this.sessionId && !this.pullRequests.links(this.sessionId).some(link => link.key === existing.key && link.source !== 'dismissed')) {
					await this.pullRequests.link(this.sessionId, { repo: existing.repo, number: existing.number }, 'manual').catch(() => undefined);
				}
				this._onDidCreate.fire(existing);
			});
			return;
		}

		const branches = append(body, $('.volt-pr-create-branches'));
		const baseButton = append(branches, $('button.volt-pr-branch.picker')) as HTMLButtonElement;
		baseButton.type = 'button';
		append(baseButton, $('span.muted')).textContent = localize('voltPr.create.base', "base: ");
		append(baseButton, $('span')).textContent = this.base ?? localize('voltPr.create.pickBase', "pick a branch");
		baseButton.appendChild(renderIcon(Codicon.chevronDown));
		this.on(baseButton, () => showVoltMenu<string>(this.contextViewService, {
			anchor: baseButton,
			ariaLabel: localize('voltPr.create.base', "base: "),
			width: 300,
			search: { placeholder: localize('voltPr.create.filterBranches', "Filter branches") },
			sections: [{ id: 'b', items: this.branches.map(branch => ({ id: branch, label: branch, checked: branch === this.base, icon: Codicon.gitBranch, data: branch })) }],
			onPick: item => {
				this.base = item.data;
				this.render();
				if (!this.touched) {
					void this.generate();
				}
			},
		}));
		append(branches, renderIcon(Codicon.arrowLeft)).classList.add('muted');
		const head = append(branches, $('span.volt-pr-branch'));
		append(head, $('span.muted')).textContent = localize('voltPr.create.compare', "compare: ");
		append(head, $('span')).textContent = repo.branch;

		const push = append(body, $('.volt-pr-create-note'));
		if (isTrunkBranch(repo.branch, this.branches[0])) {
			push.classList.add('warning');
			push.appendChild(renderIcon(Codicon.warning));
			append(push, $('span')).textContent = localize('voltPr.create.trunk', "You are on {0}. Pull requests usually come from a feature branch.", repo.branch);
		} else if (!repo.upstream) {
			push.appendChild(renderIcon(Codicon.cloudUpload));
			append(push, $('span')).textContent = localize('voltPr.create.firstPush', "{0} is pushed to {1} first.", repo.branch, repo.remote);
		} else if ((repo.ahead ?? 0) > 0) {
			push.appendChild(renderIcon(Codicon.cloudUpload));
			append(push, $('span')).textContent = repo.ahead === 1
				? localize('voltPr.create.pushOne', "1 unpushed commit is pushed first.")
				: localize('voltPr.create.pushMany', "{0} unpushed commits are pushed first.", repo.ahead);
		} else {
			push.remove();
		}

		const titleRow = append(body, $('.volt-pr-field'));
		append(titleRow, $('label.volt-pr-field-label')).textContent = localize('voltPr.create.titleLabel', "Title");
		const titleWrap = append(titleRow, $('.volt-pr-input-row'));
		const titleInput = append(titleWrap, $('input.volt-pr-input')) as HTMLInputElement;
		titleInput.value = this.title;
		titleInput.placeholder = this.generating ? localize('voltPr.create.writing', "Writing a title…") : localize('voltPr.create.titlePlaceholder', "What does this change do?");
		const generate = append(titleWrap, $('button.volt-pr-icon-button.generate')) as HTMLButtonElement;
		generate.type = 'button';
		generate.appendChild(renderIcon(this.generating ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.sparkle));
		generate.disabled = this.generating || !this.base;
		setAgentTooltip(generate, localize('voltPr.create.generate', "Write the title and description from the branch's commits and diff"));
		this.on(generate, () => {
			this.touched = false;
			void this.generate();
		});

		const bodyRow = append(body, $('.volt-pr-field'));
		append(bodyRow, $('label.volt-pr-field-label')).textContent = localize('voltPr.create.bodyLabel', "Description");
		const bodyInput = append(bodyRow, $('textarea.volt-pr-textarea.tall')) as HTMLTextAreaElement;
		bodyInput.value = this.body;
		bodyInput.placeholder = this.generating ? localize('voltPr.create.writingBody', "Writing a description from the branch's commits and diff…") : localize('voltPr.create.bodyPlaceholder', "Markdown: what changed, why, how it was tested.");
		bodyInput.classList.toggle('shimmer', this.generating);

		const options = append(body, $('.volt-pr-create-actions'));
		const draftToggle = append(options, $('label.volt-pr-checkbox'));
		const draftBox = append(draftToggle, $('input')) as HTMLInputElement;
		draftBox.type = 'checkbox';
		draftBox.checked = this.draft;
		append(draftToggle, $('span')).textContent = localize('voltPr.create.draft', "Create as draft");
		append(options, $('.volt-pr-spacer'));
		const submit = append(options, $('button.volt-pr-button.primary')) as HTMLButtonElement;
		submit.type = 'button';
		submit.appendChild(renderIcon(this.creating ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.gitPullRequestCreate));
		append(submit, $('span')).textContent = this.creating ? localize('voltPr.create.creating', "Creating…") : this.draft ? localize('voltPr.create.submitDraft', "Create Draft Pull Request") : localize('voltPr.create.submit', "Create Pull Request");
		const syncSubmit = () => submit.disabled = this.creating || !this.base || !this.title.trim();
		syncSubmit();

		this.renderStore.add(addDisposableListener(titleInput, 'input', () => {
			this.title = titleInput.value;
			this.touched = true;
			syncSubmit();
		}));
		this.renderStore.add(addDisposableListener(bodyInput, 'input', () => {
			this.body = bodyInput.value;
			this.touched = true;
		}));
		this.renderStore.add(addDisposableListener(draftBox, 'change', () => {
			this.draft = draftBox.checked;
			this.render();
		}));
		this.renderStore.add(addDisposableListener(bodyInput, 'keydown', e => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				EventHelper.stop(e, true);
				void this.create();
			}
		}));
		this.on(submit, () => this.create());

		if (this.error) {
			this.renderProblem(body);
		}
	}

	private renderProblem(parent: HTMLElement, message?: string): void {
		const err = this.error;
		const problem = message ? { title: localize('voltPr.create.cannot', "Cannot open a pull request here"), detail: message, action: undefined } : problemText(voltPrErrorCode(err), voltPrErrorMessage(err ?? localize('voltPr.create.unknown', "Something went wrong.")));
		const card = append(parent, $('.volt-pr-problem'));
		append(card, $('.volt-pr-problem-title')).textContent = problem.title;
		append(card, $('.volt-pr-problem-detail')).textContent = problem.detail;
		const actions = append(card, $('.volt-pr-problem-actions'));
		if (problem.action === 'signIn') {
			const button = append(actions, $('button.volt-pr-button.primary')) as HTMLButtonElement;
			button.textContent = localize('voltPr.signInButton', "Sign In with GitHub CLI");
			this.on(button, () => this.instantiationService.invokeFunction(accessor => signInWithGh(accessor, this.repo?.host ?? 'github.com')));
		} else if (problem.action === 'install') {
			const button = append(actions, $('button.volt-pr-button.primary')) as HTMLButtonElement;
			button.textContent = localize('voltPr.install', "Get the GitHub CLI");
			this.on(button, () => this.openerService.open('https://cli.github.com/'));
		}
		if (!message) {
			const retry = append(actions, $('button.volt-pr-button.secondary')) as HTMLButtonElement;
			retry.textContent = localize('voltPr.retry', "Retry");
			this.on(retry, async () => {
				await this.pullRequests.api.refreshAccounts();
				this.error = undefined;
				await this.load();
			});
		}
	}

	private on(element: HTMLElement, handler: () => unknown): void {
		this.renderStore.add(addDisposableListener(element, 'click', e => {
			EventHelper.stop(e, true);
			void handler();
		}));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}
