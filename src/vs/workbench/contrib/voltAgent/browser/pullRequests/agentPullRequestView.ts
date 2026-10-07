/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/path.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { prKey } from '../../../../../platform/voltPullRequests/common/voltPullRequestParse.js';
import {
	IVoltPrCheck,
	IVoltPrFile,
	IVoltPrComment,
	IVoltPrReview,
	IVoltPrReviewThread,
	IVoltPullRequestDetail,
	VoltPrMergeMethod,
	voltPrErrorCode,
	voltPrErrorMessage,
} from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import {
	buildExplainPrompt,
	buildFixChecksPrompt,
	buildFixThreadPrompt,
	buildResolveConflictsPrompt,
	IAgentPrLink,
	isOpenState,
	primaryAction,
	resolveChains,
	resolveMergeMethod,
} from '../../common/agentPullRequests.js';
import { renderMarkdownInto } from '../blocks/agentBlockRenderers.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { openPullRequestDiff } from './agentPullRequestDiff.js';
import { AgentPullRequestEditorInput } from './agentPullRequestEditorInput.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { ago, avatar, checkDuration, checkIcon, checksLabel, composeInChat, iconSpan, MERGE_LABELS, openPullRequest, problemText, prStateIcon, prStateLabel, signInWithGh, visibleChatSession } from './agentPullRequestUi.js';

type Tab = 'overview' | 'files' | 'commits' | 'checks';

/** While the view is on screen, it re-reads the pull request this often. */
const POLL_MS = 20_000;
/** Viewed ticks are sent together after this pause, like T3 Code. */
const VIEWED_FLUSH_MS = 400;
/** The Files tab's layout: directories as a tree, or one flat list. */
const FILES_AS_TREE_KEY = 'volt.pullRequests.filesAsTree';

/**
 * One pull request: header with its state and main action, and Overview, Files, Commits and
 * Checks tabs. Every action re-reads the pull request afterwards, so what is shown is GitHub's.
 */
export class AgentPullRequestView extends Disposable {

	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly body: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly markdownRenderer: MarkdownRenderer;
	private readonly poll = this._register(new RunOnceScheduler(() => void this.load(false), POLL_MS));
	private readonly pendingViewed = new Map<string, boolean>();
	private readonly viewedFlush = this._register(new RunOnceScheduler(() => void this.flushViewed(), VIEWED_FLUSH_MS));

	private input: AgentPullRequestEditorInput | undefined;
	private detail: IVoltPullRequestDetail | undefined;
	private error: unknown;
	private tab: Tab = 'overview';
	private loading = false;
	private visible = false;
	private busy: string | undefined;
	private loadSeq = 0;
	/** When the last read finished; its own change event must not start another. */
	private loadedAt = 0;
	/** Drafts typed into reply boxes, kept across re-renders. */
	private readonly drafts = new Map<string, string>();
	private deleteBranch: boolean | undefined;
	private shiftHeld = false;
	private renderPending = false;
	/** Directories folded in the Files tree, kept across re-renders of the same view. */
	private readonly collapsedDirs = new Set<string>();

	constructor(
		parent: HTMLElement,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IHostService private readonly hostService: IHostService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.element = append(parent, $('.volt-pr-view'));
		this.element.tabIndex = -1;
		this.header = append(this.element, $('.volt-pr-header'));
		this.body = append(this.element, $('.volt-pr-body'));
		this.markdownRenderer = this.instantiationService.createInstance(MarkdownRenderer, {});
		this._register(this.pullRequests.onDidChangePullRequest(key => {
			if (this.input?.target.kind === 'pr' && key === prKey(this.input.target.repo, this.input.target.number) && !this.loading && Date.now() - this.loadedAt > 3_000) {
				void this.load(false);
			}
		}));
		this._register(this.pullRequests.onDidChange(sessionIds => {
			const sessionId = this.sessionId;
			if (!sessionId || sessionIds.includes(sessionId)) {
				this.renderSoon();
			}
		}));
		// Read elsewhere (the diff's Viewed ticks, a watch pass): show it, no second read.
		this._register(this.pullRequests.onDidReadDetail(detail => {
			const target = this.target;
			if (target && detail.key === prKey(target.repo, target.number) && detail !== this.detail && !this.busy) {
				this.detail = detail;
				this.error = undefined;
				this.renderSoon();
			}
		}));
		this._register(addDisposableListener(this.element, 'focusout', () => {
			// Wait for the focus to land: moving between two fields is not leaving them.
			getWindow(this.element).setTimeout(() => {
				if (this.renderPending && !this.isTyping()) {
					this.render();
				}
			}, 0);
		}));
		this._register(this.hostService.onDidChangeFocus(focused => {
			if (focused && this.visible) {
				void this.load(false);
			}
		}));
		const win = getWindow(this.element);
		const shift = (e: KeyboardEvent) => {
			const held = e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
			if (held !== this.shiftHeld) {
				this.shiftHeld = held;
				this.element.classList.toggle('shift-held', held);
			}
		};
		this._register(addDisposableListener(win, 'keydown', shift, true));
		this._register(addDisposableListener(win, 'keyup', shift, true));
		this._register(addDisposableListener(win, 'blur', () => {
			this.shiftHeld = false;
			this.element.classList.remove('shift-held');
		}));
	}

	setInput(input: AgentPullRequestEditorInput | undefined): void {
		if (this.input === input) {
			return;
		}
		// Viewed ticks still waiting go to the pull request they were made on.
		if (this.pendingViewed.size) {
			this.viewedFlush.cancel();
			void this.flushViewed();
		}
		this.input = input;
		this.detail = undefined;
		this.error = undefined;
		this.tab = 'overview';
		this.drafts.clear();
		this.deleteBranch = undefined;
		this.render();
		if (input) {
			void this.load(true);
		}
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) {
			this.poll.schedule();
		} else {
			this.poll.cancel();
		}
	}

	focus(): void {
		this.element.focus();
	}

	private get target() {
		const target = this.input?.target;
		return target?.kind === 'pr' ? target : undefined;
	}

	/** The chat this view acts for: the tab's chat, else the first chat that links the pull request. */
	private get sessionId(): string | undefined {
		const target = this.target;
		if (this.input?.sessionId && this.history.has(this.input.sessionId)) {
			return this.input.sessionId;
		}
		return target ? this.pullRequests.sessionsFor(prKey(target.repo, target.number))[0] : undefined;
	}

	private get link(): IAgentPrLink | undefined {
		const target = this.target;
		const sessionId = this.sessionId;
		if (!target || !sessionId) {
			return undefined;
		}
		const key = prKey(target.repo, target.number);
		return this.pullRequests.links(sessionId).find(link => link.key === key && link.source !== 'dismissed');
	}

	async load(force: boolean): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const seq = ++this.loadSeq;
		this.loading = true;
		if (force) {
			this.render();
		}
		try {
			const detail = await this.pullRequests.detail({ repo: target.repo, number: target.number }, true);
			if (seq !== this.loadSeq) {
				return;
			}
			this.detail = detail;
			this.error = undefined;
		} catch (err) {
			if (seq !== this.loadSeq) {
				return;
			}
			this.error = err;
		} finally {
			if (seq === this.loadSeq) {
				this.loading = false;
				this.loadedAt = Date.now();
				if (force) {
					this.render();
				} else {
					this.renderSoon();
				}
				if (this.visible) {
					this.poll.schedule();
				}
			}
		}
	}

	//#region Render

	/** A text field in the view has focus: rebuilding the view now would take it (and the caret) away. */
	private isTyping(): boolean {
		const active = this.element.ownerDocument.activeElement;
		return !!active && this.element.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
	}

	/** Renders now, or once the user leaves the field they are typing in. */
	private renderSoon(): void {
		if (this.isTyping()) {
			this.renderPending = true;
			return;
		}
		this.render();
	}

	private render(): void {
		this.renderPending = false;
		this.renderStore.clear();
		clearNode(this.header);
		clearNode(this.body);
		const target = this.target;
		if (!target) {
			return;
		}
		const detail = this.detail;
		if (!detail) {
			if (this.error) {
				this.renderProblem(this.body, this.error, target.repo.host);
			} else {
				this.renderSkeleton();
			}
			return;
		}
		this.renderHeader(detail);
		if (this.error) {
			const stale = append(this.body, $('.volt-pr-banner.warning'));
			stale.appendChild(renderIcon(Codicon.warning));
			append(stale, $('span')).textContent = localize('voltPr.stale', "Showing the last copy: {0}", voltPrErrorMessage(this.error));
		}
		switch (this.tab) {
			case 'overview': this.renderOverview(detail); break;
			case 'files': this.renderFiles(detail); break;
			case 'commits': this.renderCommits(detail); break;
			case 'checks': this.renderChecks(detail); break;
		}
	}

	private renderSkeleton(): void {
		const skeleton = append(this.body, $('.volt-pr-skeleton'));
		for (const width of [40, 85, 60, 92, 70]) {
			append(skeleton, $('.volt-pr-skeleton-line')).style.width = `${width}%`;
		}
		skeleton.setAttribute('aria-label', localize('voltPr.loading', "Loading pull request"));
	}

	private renderProblem(parent: HTMLElement, err: unknown, host: string): void {
		const problem = problemText(voltPrErrorCode(err), voltPrErrorMessage(err));
		const card = append(parent, $('.volt-pr-problem'));
		append(card, $('.volt-pr-problem-title')).textContent = problem.title;
		append(card, $('.volt-pr-problem-detail')).textContent = problem.detail;
		const actions = append(card, $('.volt-pr-problem-actions'));
		if (problem.action === 'signIn') {
			this.button(actions, localize('voltPr.signInButton', "Sign In with GitHub CLI"), () => this.instantiationService.invokeFunction(accessor => signInWithGh(accessor, host)), 'primary');
			this.button(actions, localize('voltPr.retry', "Retry"), async () => {
				await this.pullRequests.api.refreshAccounts();
				await this.load(true);
			});
		} else if (problem.action === 'install') {
			this.button(actions, localize('voltPr.install', "Get the GitHub CLI"), () => this.openerService.open('https://cli.github.com/'), 'primary');
			this.button(actions, localize('voltPr.retry', "Retry"), async () => {
				await this.pullRequests.api.refreshAccounts();
				await this.load(true);
			});
		} else if (problem.action === 'retry') {
			this.button(actions, localize('voltPr.retry', "Retry"), () => this.load(true), 'primary');
		}
	}

	private renderHeader(pr: IVoltPullRequestDetail): void {
		const top = append(this.header, $('.volt-pr-header-row'));
		const repo = append(top, $('a.volt-pr-repo')) as HTMLAnchorElement;
		repo.textContent = `${pr.repo.owner}/${pr.repo.name}`;
		repo.href = `https://${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}`;
		this.onClick(repo, () => this.openerService.open(repo.href));
		const number = append(top, $('a.volt-pr-number')) as HTMLAnchorElement;
		number.textContent = `#${pr.number}`;
		number.appendChild(renderIcon(Codicon.linkExternal));
		number.href = pr.url;
		setAgentTooltip(number, localize('voltPr.openOnHost', "Open on GitHub"));
		this.onClick(number, () => this.openerService.open(pr.url));
		append(top, $('.volt-pr-spacer'));
		this.renderStackPill(top, pr);
		this.renderWatchToggle(top, pr);
		this.renderPrimary(top, pr);
		const more = this.iconButton(top, Codicon.ellipsis, localize('voltPr.more', "More Actions"), button => this.showMoreMenu(button, pr));
		more.classList.add('volt-pr-more');

		append(this.header, $('h1.volt-pr-title')).textContent = pr.title;

		const meta = append(this.header, $('.volt-pr-meta'));
		const pill = append(meta, $(`span.volt-pr-state-pill.state-${pr.state}`));
		pill.appendChild(renderIcon(prStateIcon(pr.state)));
		append(pill, $('span')).textContent = prStateLabel(pr.state);
		const sentence = append(meta, $('span.volt-pr-meta-text'));
		append(sentence, $('strong')).textContent = pr.author.login;
		const commits = pr.commits.length;
		const count = commits === 1 ? localize('voltPr.oneCommit', "1 commit") : localize('voltPr.commits', "{0} commits", commits);
		append(sentence, $('span')).textContent = pr.state === 'merged'
			? localize('voltPr.meta.mergedFlow', " merged {0}", count)
			: localize('voltPr.meta.wantsFlow', " wants to merge {0}", count);
		// base ← head, as one flow: where the work lands first, then where it comes from.
		const flow = append(meta, $('span.volt-pr-branch-flow'));
		this.branchChip(flow, pr.baseRefName, pr.mergeState === 'behind');
		const arrow = append(flow, $('span.volt-pr-branch-arrow'));
		arrow.appendChild(renderIcon(Codicon.arrowLeft));
		setAgentTooltip(arrow, pr.state === 'merged'
			? localize('voltPr.flowMerged', "{0} was merged into {1}", pr.headRefName, pr.baseRefName)
			: localize('voltPr.flowInto', "{0} merges into {1}", pr.headRefName, pr.baseRefName));
		this.branchChip(flow, pr.crossRepository && pr.headOwner ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName);
		append(meta, $('span.volt-pr-meta-time')).textContent = localize('voltPr.updated', "updated {0}", ago(pr.updatedAt));

		const tabs = append(this.header, $('.volt-pr-tabs'));
		tabs.setAttribute('role', 'tablist');
		const tabSpecs: { id: Tab; label: string; count?: string; icon?: ThemeIcon; iconClass?: string }[] = [
			{ id: 'overview', label: localize('voltPr.tab.overview', "Overview"), count: pr.comments ? String(pr.comments) : undefined },
			{ id: 'files', label: localize('voltPr.tab.files', "Files"), count: String(pr.files.length || pr.changedFiles) },
			{ id: 'commits', label: localize('voltPr.tab.commits', "Commits"), count: String(pr.commits.length) },
			{ id: 'checks', label: localize('voltPr.tab.checks', "Checks"), count: pr.checkRuns.length ? String(pr.checkRuns.length) : undefined, icon: pr.checks.state !== 'none' ? checkIcon(pr.checks.state) : undefined, iconClass: `check-${pr.checks.state}` },
		];
		for (const spec of tabSpecs) {
			const tab = append(tabs, $('button.volt-pr-tab')) as HTMLButtonElement;
			tab.type = 'button';
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.tab === spec.id));
			tab.classList.toggle('active', this.tab === spec.id);
			if (spec.icon) {
				iconSpan(tab, spec.icon, spec.iconClass ?? '');
			}
			append(tab, $('span')).textContent = spec.label;
			if (spec.count) {
				append(tab, $('span.volt-pr-count')).textContent = spec.count;
			}
			this.onClick(tab, () => {
				this.tab = spec.id;
				this.render();
				this.body.scrollTop = 0;
			});
		}
		append(tabs, $('.volt-pr-spacer'));
		const stats = append(tabs, $('span.volt-pr-stats'));
		append(stats, $('span.add')).textContent = `+${pr.additions}`;
		append(stats, $('span.del')).textContent = `−${pr.deletions}`;
	}

	private branchChip(parent: HTMLElement, name: string, behind = false): void {
		const chip = append(parent, $('button.volt-pr-branch')) as HTMLButtonElement;
		chip.type = 'button';
		chip.textContent = name;
		chip.classList.toggle('behind', behind);
		setAgentTooltip(chip, behind ? localize('voltPr.branchBehind', "{0} has new commits. Copy name", name) : localize('voltPr.copyBranch', "Copy branch name"));
		this.onClick(chip, () => this.copy(name, localize('voltPr.copiedBranch', "Copied {0}", name)));
	}

	/** The stack this pull request sits in, from the chat's links: position and the other layers. */
	private renderStackPill(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		const sessionId = this.sessionId;
		if (!sessionId) {
			return;
		}
		const chains = resolveChains(this.pullRequests.links(sessionId).filter(link => link.source !== 'dismissed'));
		const chain = chains.find(candidate => candidate.length > 1 && candidate.some(link => link.key === pr.key));
		if (!chain) {
			return;
		}
		const position = chain.findIndex(link => link.key === pr.key) + 1;
		const pill = append(parent, $('button.volt-pr-pill')) as HTMLButtonElement;
		pill.type = 'button';
		pill.appendChild(renderIcon(Codicon.layers));
		append(pill, $('span')).textContent = localize('voltPr.stack', "Stack {0}/{1}", position, chain.length);
		append(pill, renderIcon(Codicon.chevronDown)).classList.add('chevron');
		this.onClick(pill, () => {
			type Pick = { kind: 'open'; link: IAgentPrLink } | { kind: 'rebase' } | { kind: 'merge' };
			const layers: IVoltMenuItem<Pick>[] = [...chain].reverse().map(link => ({
				id: link.key,
				label: `#${link.number} ${link.snapshot?.title ?? ''}`,
				description: link.snapshot ? `${link.snapshot.baseRefName} ← ${link.snapshot.headRefName}` : undefined,
				icon: link.snapshot ? prStateIcon(link.snapshot.state) : Codicon.gitPullRequest,
				checked: link.key === pr.key,
				data: { kind: 'open', link },
			}));
			const open = chain.filter(link => isOpenState(link.snapshot?.state));
			showVoltMenu<Pick>(this.contextViewService, {
				anchor: pill,
				ariaLabel: localize('voltPr.stackMenu', "Stack"),
				width: 360,
				sections: [
					{ id: 'layers', title: localize('voltPr.stackLayers', "Layers, top first"), items: layers },
					{
						id: 'actions', items: [
							{ id: 'rebase', label: localize('voltPr.rebaseStack', "Rebase Stack ({0})", open.length), icon: Codicon.sync, disabled: !open.length, data: { kind: 'rebase' } },
							{ id: 'merge', label: localize('voltPr.mergeStack', "Merge Stack up to #{0}", pr.number), icon: Codicon.gitMerge, disabled: !isOpenState(pr.state), data: { kind: 'merge' } },
						],
					},
				],
				onPick: item => {
					const pick = item.data;
					if (pick.kind === 'open') {
						if (pick.link.key !== pr.key) {
							void this.instantiationService.invokeFunction(accessor => openPullRequest(accessor, { kind: 'pr', repo: pick.link.repo, number: pick.link.number }, sessionId));
						}
					} else if (pick.kind === 'rebase') {
						void this.rebaseStack(open);
					} else {
						void this.mergeStack(chain.slice(0, position), pr);
					}
				},
			});
		});
	}

	private renderWatchToggle(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		if (!isOpenState(pr.state) || !this.sessionId) {
			return;
		}
		const watching = !!this.link?.watch;
		const toggle = append(parent, $('button.volt-pr-pill.watch')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.classList.toggle('active', watching);
		toggle.setAttribute('aria-pressed', String(watching));
		toggle.appendChild(renderIcon(watching ? Codicon.eye : Codicon.eyeClosed));
		append(toggle, $('span')).textContent = watching ? localize('voltPr.watching', "Watching") : localize('voltPr.watch', "Watch");
		setAgentTooltip(toggle, watching
			? localize('voltPr.watchingTip', "The chat's agent wakes up when checks fail, a review comes in or the branch conflicts. Click to stop.")
			: localize('voltPr.watchTip', "Wake the chat's agent when checks fail, a review comes in or the branch conflicts"));
		this.onClick(toggle, () => this.toggleWatch(pr));
	}

	private async toggleWatch(pr: IVoltPullRequestDetail): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId) {
			return;
		}
		if (this.link?.watch) {
			this.pullRequests.unwatch(sessionId, pr.key);
			return;
		}
		await this.run(localize('voltPr.watchBusy', "Watching…"), async () => {
			if (!this.link) {
				await this.pullRequests.link(sessionId, { repo: pr.repo, number: pr.number }, 'manual');
			}
			await this.pullRequests.watch(sessionId, pr.key);
		}, false);
	}

	/** Merge (split with the method), Ready for review, Enable auto-merge or Resolve conflicts, as the state calls for. */
	private renderPrimary(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		const action = primaryAction(pr);
		if (action === 'none') {
			return;
		}
		if (action === 'ready') {
			this.button(parent, localize('voltPr.ready', "Ready for Review"), () => this.run(localize('voltPr.readyBusy', "Marking ready…"), () => this.pullRequests.api.setDraft({ repo: pr.repo, number: pr.number, draft: false })), 'primary');
			return;
		}
		if (action === 'resolveConflicts') {
			this.button(parent, localize('voltPr.resolve', "Resolve with Agent"), () => this.toAgent(buildResolveConflictsPrompt(pr)), 'primary', Codicon.sparkle);
			return;
		}
		if (action === 'autoMergeArmed') {
			this.button(parent, localize('voltPr.autoArmed', "Auto-merge On"), () => this.run(localize('voltPr.autoOffBusy', "Turning off auto-merge…"), () => this.pullRequests.api.cancelAutoMerge({ repo: pr.repo, number: pr.number })), 'secondary', Codicon.check);
			return;
		}
		const method = this.mergeMethod(pr);
		const split = append(parent, $('.volt-pr-split'));
		const auto = action === 'autoMerge';
		const main = this.button(split, auto ? localize('voltPr.enableAuto', "Enable Auto-merge") : MERGE_LABELS[method], async e => {
			const quick = !!(e as MouseEvent | undefined)?.shiftKey;
			await this.merge(pr, method, auto, quick);
		}, 'primary');
		main.disabled = !pr.viewerCanMerge || !!this.busy;
		setAgentTooltip(main, auto
			? localize('voltPr.autoTip', "Merge with {0} once checks pass and reviews allow", MERGE_LABELS[method].toLowerCase())
			: localize('voltPr.mergeTip', "{0} into {1}. Hold Shift to skip the confirmation.", MERGE_LABELS[method], pr.baseRefName));
		const chevron = this.iconButton(split, Codicon.chevronDown, localize('voltPr.mergeOptions', "Merge Options"), button => this.showMergeMenu(button, pr));
		chevron.classList.add('primary');
	}

	private mergeMethod(pr: IVoltPullRequestDetail): VoltPrMergeMethod {
		return resolveMergeMethod(pr.mergeOptions, this.pullRequests.lastMergeMethod(pr.repo));
	}

	private showMergeMenu(anchor: HTMLElement, pr: IVoltPullRequestDetail): void {
		type Pick = { kind: 'method'; method: VoltPrMergeMethod } | { kind: 'deleteBranch' } | { kind: 'auto' } | { kind: 'mergeNow' };
		const current = this.mergeMethod(pr);
		const deleteBranch = this.deleteBranch ?? pr.mergeOptions.deleteBranchOnMerge;
		const methods = (['squash', 'merge', 'rebase'] as const).filter(method => pr.mergeOptions[method]).map((method): IVoltMenuItem<Pick> => ({
			id: method,
			label: MERGE_LABELS[method],
			checked: method === current,
			data: { kind: 'method', method },
		}));
		const extra: IVoltMenuItem<Pick>[] = [
			{ id: 'delete', label: localize('voltPr.deleteBranch', "Delete Branch After Merge"), checked: deleteBranch, disabled: pr.crossRepository, data: { kind: 'deleteBranch' } },
		];
		if (pr.mergeOptions.autoMergeAllowed && !pr.autoMerge) {
			extra.push({ id: 'auto', label: localize('voltPr.enableAutoItem', "Enable Auto-merge"), icon: Codicon.clock, data: { kind: 'auto' } });
		}
		if (primaryAction(pr) === 'autoMerge') {
			extra.push({ id: 'now', label: localize('voltPr.mergeNow', "Merge Now"), icon: Codicon.gitMerge, data: { kind: 'mergeNow' } });
		}
		showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			align: 'right',
			ariaLabel: localize('voltPr.mergeOptions', "Merge Options"),
			width: 260,
			sections: [{ id: 'methods', title: localize('voltPr.mergeMethod', "Merge method"), items: methods }, { id: 'extra', items: extra }],
			onPick: item => {
				const pick = item.data;
				switch (pick.kind) {
					case 'method':
						this.pullRequests.rememberMergeMethod(pr.repo, pick.method);
						this.render();
						return;
					case 'deleteBranch':
						this.deleteBranch = !deleteBranch;
						return;
					case 'auto':
						return this.merge(pr, current, true, false);
					case 'mergeNow':
						return this.merge(pr, current, false, false);
				}
			},
		});
	}

	private showMoreMenu(anchor: HTMLElement, pr: IVoltPullRequestDetail): void {
		type Pick = () => unknown;
		const sessionId = this.sessionId;
		const link = this.link;
		const open = isOpenState(pr.state);
		const agent: IVoltMenuItem<Pick>[] = [
			{ id: 'explain', label: localize('voltPr.explain', "Explain This Pull Request"), icon: Codicon.sparkle, data: () => this.toAgent(buildExplainPrompt(pr)) },
		];
		if (pr.checks.failed) {
			agent.push({ id: 'fixChecks', label: localize('voltPr.fixChecks', "Fix Failing Checks"), icon: Codicon.sparkle, data: () => this.toAgent(buildFixChecksPrompt(pr, pr.checkRuns.filter(check => check.state === 'failure'))) });
		}
		if (pr.mergeable === 'conflicting') {
			agent.push({ id: 'conflicts', label: localize('voltPr.resolveConflicts', "Resolve Conflicts"), icon: Codicon.sparkle, data: () => this.toAgent(buildResolveConflictsPrompt(pr)) });
		}
		const chat: IVoltMenuItem<Pick>[] = [];
		if (sessionId) {
			chat.push(link
				? { id: 'unlink', label: localize('voltPr.unlink', "Unlink from Chat"), icon: Codicon.close, data: () => this.pullRequests.unlink(sessionId, pr.key) }
				: { id: 'link', label: localize('voltPr.link', "Link to Chat"), icon: Codicon.link, data: () => this.run(localize('voltPr.linkBusy', "Linking…"), () => this.pullRequests.link(sessionId, { repo: pr.repo, number: pr.number }, 'manual'), false) });
		}
		const branch: IVoltMenuItem<Pick>[] = [];
		if (open) {
			if (pr.state === 'draft') {
				branch.push({ id: 'ready', label: localize('voltPr.ready', "Ready for Review"), icon: Codicon.eye, data: () => this.run(localize('voltPr.readyBusy', "Marking ready…"), () => this.pullRequests.api.setDraft({ repo: pr.repo, number: pr.number, draft: false })) });
			} else {
				branch.push({ id: 'draft', label: localize('voltPr.toDraft', "Convert to Draft"), icon: Codicon.gitPullRequestDraft, data: () => this.run(localize('voltPr.draftBusy', "Converting…"), () => this.pullRequests.api.setDraft({ repo: pr.repo, number: pr.number, draft: true })) });
			}
			branch.push(
				{ id: 'updateMerge', label: localize('voltPr.updateMerge', "Update Branch (Merge)"), icon: Codicon.gitMerge, disabled: pr.mergeState !== 'behind' && pr.mergeState !== 'unknown', data: () => this.updateBranch(pr, false) },
				{ id: 'updateRebase', label: localize('voltPr.updateRebase', "Update Branch (Rebase)"), icon: Codicon.sync, disabled: pr.mergeState !== 'behind' && pr.mergeState !== 'unknown', data: () => this.updateBranch(pr, true) },
			);
			if (pr.checks.failed) {
				branch.push({ id: 'rerun', label: localize('voltPr.rerun', "Re-run Failed Checks"), icon: Codicon.debugRerun, data: () => this.rerun(pr) });
			}
		}
		const general: IVoltMenuItem<Pick>[] = [
			{ id: 'refresh', label: localize('voltPr.refresh', "Refresh"), icon: Codicon.refresh, data: () => this.load(true) },
			{ id: 'openHost', label: localize('voltPr.openOnHost', "Open on GitHub"), icon: Codicon.linkExternal, data: () => this.openerService.open(pr.url) },
			{ id: 'copyLink', label: localize('voltPr.copyLink', "Copy Link"), icon: Codicon.copy, data: () => this.copy(pr.url, localize('voltPr.copiedLink', "Copied the link")) },
			{ id: 'copyCheckout', label: localize('voltPr.copyCheckout', "Copy Checkout Command"), icon: Codicon.terminal, data: () => this.copy(`gh pr checkout ${pr.number}`, localize('voltPr.copiedCheckout', "Copied gh pr checkout {0}", pr.number)) },
		];
		const state: IVoltMenuItem<Pick>[] = open
			? [{ id: 'close', label: localize('voltPr.close', "Close Pull Request"), icon: Codicon.gitPullRequestClosed, data: () => this.setState(pr, 'closed', false) }]
			: pr.state === 'closed' ? [{ id: 'reopen', label: localize('voltPr.reopen', "Reopen Pull Request"), icon: Codicon.issueReopened, data: () => this.setState(pr, 'open', false) }] : [];
		showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			align: 'right',
			ariaLabel: localize('voltPr.more', "More Actions"),
			width: 260,
			sections: [
				{ id: 'agent', title: localize('voltPr.withAgent', "With the agent"), items: agent },
				{ id: 'chat', items: chat },
				{ id: 'branch', items: branch },
				{ id: 'general', items: general },
				{ id: 'state', items: state },
			].filter(section => section.items.length),
			onPick: item => void item.data(),
		});
	}

	//#endregion

	//#region Overview

	private renderOverview(pr: IVoltPullRequestDetail): void {
		const body = this.body;
		this.renderMergeBox(append(body, $('.volt-pr-card.volt-pr-mergebox')), pr);

		const people = append(body, $('.volt-pr-section.volt-pr-people'));
		this.renderReviewers(people, pr);
		this.renderLabels(people, pr);

		const description = append(body, $('.volt-pr-section'));
		append(description, $('.volt-pr-section-title')).textContent = localize('voltPr.description', "Description");
		const text = append(description, $('.volt-pr-markdown'));
		if (pr.body.trim()) {
			this.markdown(text, pr.body);
		} else {
			text.classList.add('muted');
			text.textContent = localize('voltPr.noDescription', "No description.");
		}

		this.renderActivity(append(body, $('.volt-pr-section')), pr);
		this.renderCommentBox(append(body, $('.volt-pr-section.volt-pr-compose')), pr);
	}

	private renderMergeBox(card: HTMLElement, pr: IVoltPullRequestDetail): void {
		// Checks.
		const checks = this.statusRow(card, checkIcon(pr.checks.state), `check-${pr.checks.state}`, checksLabel(pr),
			pr.checks.state === 'failure' ? pr.checks.failing.slice(0, 3).join(', ') : pr.checks.total ? localize('voltPr.checksSummary', "{0} passed, {1} skipped", pr.checks.passed, pr.checks.skipped) : localize('voltPr.noChecksDetail', "This repository runs no checks on it."));
		if (pr.checks.state !== 'none') {
			this.linkButton(checks, localize('voltPr.view', "View"), () => {
				this.tab = 'checks';
				this.render();
			});
		}
		if (pr.checks.state === 'failure' && isOpenState(pr.state)) {
			this.button(checks, localize('voltPr.fixWithAgent', "Fix with Agent"), () => this.toAgent(buildFixChecksPrompt(pr, pr.checkRuns.filter(check => check.state === 'failure'))), 'secondary', Codicon.sparkle);
		}

		// Reviews.
		const approvals = pr.reviews.filter(review => review.state === 'approved').map(review => review.author);
		const changes = pr.reviews.filter(review => review.state === 'changesRequested').map(review => review.author);
		if (changes.length) {
			this.statusRow(card, Codicon.diffModified, 'review-changes', localize('voltPr.changesRequested', "Changes requested"), changes.join(', '));
		} else if (approvals.length) {
			this.statusRow(card, Codicon.passFilled, 'review-approved', localize('voltPr.approved', "Approved"), approvals.join(', '));
		} else if (pr.reviewDecision === 'reviewRequired' || pr.reviewRequests.length) {
			this.statusRow(card, Codicon.gitPullRequestReviewer, 'review-pending', localize('voltPr.reviewRequired', "Review required"), pr.reviewRequests.length ? localize('voltPr.waitingOn', "Waiting on {0}", pr.reviewRequests.join(', ')) : localize('voltPr.needsApproval', "At least one approval is needed."));
		} else {
			this.statusRow(card, Codicon.gitPullRequestReviewer, 'review-none', localize('voltPr.noReviews', "No reviews yet"), pr.unresolvedThreads ? localize('voltPr.unresolved', "{0} unresolved threads", pr.unresolvedThreads) : '');
		}

		// Mergeability.
		if (pr.state === 'merged') {
			this.statusRow(card, Codicon.gitMerge, 'state-merged', localize('voltPr.mergedAt', "Merged {0}", ago(pr.mergedAt ?? pr.updatedAt)), '');
			return;
		}
		if (pr.state === 'closed') {
			this.statusRow(card, Codicon.gitPullRequestClosed, 'state-closed', localize('voltPr.closedAt', "Closed {0}", ago(pr.closedAt ?? pr.updatedAt)), '');
			return;
		}
		if (pr.mergeable === 'conflicting') {
			const row = this.statusRow(card, Codicon.warning, 'merge-conflict', localize('voltPr.conflicts', "This branch has conflicts"), localize('voltPr.conflictsDetail', "They must be resolved before it can merge into {0}.", pr.baseRefName));
			this.button(row, localize('voltPr.resolve', "Resolve with Agent"), () => this.toAgent(buildResolveConflictsPrompt(pr)), 'secondary', Codicon.sparkle);
		} else if (pr.mergeState === 'behind') {
			const row = this.statusRow(card, Codicon.arrowDown, 'merge-behind', localize('voltPr.behind', "This branch is out of date"), localize('voltPr.behindDetail', "{0} has new commits.", pr.baseRefName));
			this.button(row, localize('voltPr.update', "Update Branch"), () => this.updateBranch(pr, false), 'secondary');
			this.iconButton(row, Codicon.chevronDown, localize('voltPr.updateOptions', "Update Options"), button => {
				showVoltMenu<boolean>(this.contextViewService, {
					anchor: button, align: 'right', ariaLabel: localize('voltPr.updateOptions', "Update Options"), width: 220,
					sections: [{ id: 'u', items: [{ id: 'merge', label: localize('voltPr.updateMerge', "Update Branch (Merge)"), data: false }, { id: 'rebase', label: localize('voltPr.updateRebase', "Update Branch (Rebase)"), data: true }] }],
					onPick: item => this.updateBranch(pr, item.data),
				});
			});
		} else if (pr.mergeable === 'mergeable') {
			this.statusRow(card, Codicon.check, 'merge-clean', localize('voltPr.noConflicts', "No conflicts with {0}", pr.baseRefName), pr.mergeState === 'blocked' ? localize('voltPr.blocked', "Merging is blocked by branch rules.") : '');
		} else {
			this.statusRow(card, Codicon.loading, 'merge-unknown', localize('voltPr.checkingMergeable', "Checking whether it merges cleanly…"), '');
		}
		if (pr.autoMerge) {
			this.statusRow(card, Codicon.clock, 'merge-auto', localize('voltPr.autoOn', "Auto-merge is on"), localize('voltPr.autoOnDetail', "It merges once checks pass and reviews allow."));
		}
	}

	private statusRow(parent: HTMLElement, icon: ThemeIcon, iconClass: string, title: string, detail: string): HTMLElement {
		const row = append(parent, $('.volt-pr-status-row'));
		iconSpan(row, icon, iconClass);
		const text = append(row, $('.volt-pr-status-text'));
		append(text, $('.volt-pr-status-title')).textContent = title;
		if (detail) {
			append(text, $('.volt-pr-status-detail')).textContent = detail;
		}
		return row;
	}

	private renderReviewers(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		const row = append(parent, $('.volt-pr-people-row'));
		append(row, $('.volt-pr-people-label')).textContent = localize('voltPr.reviewers', "Reviewers");
		const list = append(row, $('.volt-pr-people-list'));
		const seen = new Set<string>();
		for (const review of pr.reviews) {
			if (seen.has(review.author)) {
				continue;
			}
			seen.add(review.author);
			const chip = append(list, $(`span.volt-pr-person.review-${review.state}`));
			avatar(chip, review.author, `https://${pr.repo.host === 'github.com' ? 'github.com' : pr.repo.host}/${review.author}.png`, 18);
			append(chip, $('span')).textContent = review.author;
			setAgentTooltip(chip, `${review.author}: ${review.state === 'approved' ? localize('voltPr.r.approved', "approved") : review.state === 'changesRequested' ? localize('voltPr.r.changes', "requested changes") : localize('voltPr.r.commented', "commented")}`);
		}
		for (const name of pr.reviewRequests) {
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			const chip = append(list, $('span.volt-pr-person.review-requested'));
			chip.appendChild(renderIcon(name.includes('/') ? Codicon.organization : Codicon.person));
			append(chip, $('span')).textContent = name;
			setAgentTooltip(chip, localize('voltPr.r.pending', "{0}: review requested", name));
		}
		if (!seen.size) {
			append(list, $('span.muted')).textContent = localize('voltPr.noReviewers', "None");
		}
		if (isOpenState(pr.state) && pr.viewerCanUpdate) {
			this.iconButton(list, Codicon.add, localize('voltPr.requestReview', "Request Review"), button => {
				showVoltMenu<string>(this.contextViewService, {
					anchor: button,
					ariaLabel: localize('voltPr.requestReview', "Request Review"),
					width: 280,
					search: { placeholder: localize('voltPr.reviewerPlaceholder', "GitHub username or org/team") },
					sections: [{ id: 'r', items: [{ id: 'ask', label: localize('voltPr.requestByName', "Request a reviewer…"), icon: Codicon.person, data: '', prompt: { placeholder: localize('voltPr.reviewerPlaceholder', "GitHub username or org/team"), validate: value => /^[\w.-]+(\/[\w.-]+)?$/.test(value.trim()) ? undefined : localize('voltPr.badLogin', "Enter a username, or org/team"), onSubmit: async value => this.run(localize('voltPr.requestBusy', "Requesting review…"), () => this.pullRequests.api.requestReviewers({ repo: pr.repo, number: pr.number, logins: [value.trim()] })) } }] }],
					onPick: () => undefined,
				});
			}).classList.add('volt-pr-add');
		}
	}

	private renderLabels(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		const row = append(parent, $('.volt-pr-people-row'));
		append(row, $('.volt-pr-people-label')).textContent = localize('voltPr.labels', "Labels");
		const list = append(row, $('.volt-pr-people-list'));
		for (const label of pr.labels) {
			this.labelChip(list, label.name, label.color);
		}
		if (!pr.labels.length) {
			append(list, $('span.muted')).textContent = localize('voltPr.noLabels', "None");
		}
		if (pr.viewerCanUpdate && pr.repoLabels.length) {
			this.iconButton(list, Codicon.add, localize('voltPr.editLabels', "Edit Labels"), button => {
				const current = new Set(pr.labels.map(label => label.name));
				showVoltMenu<string>(this.contextViewService, {
					anchor: button,
					ariaLabel: localize('voltPr.editLabels', "Edit Labels"),
					width: 260,
					search: { placeholder: localize('voltPr.filterLabels', "Filter labels") },
					sections: [{ id: 'labels', items: pr.repoLabels.map(label => ({ id: label.name, label: label.name, checked: current.has(label.name), icon: () => colorDot(label.color), data: label.name })) }],
					onPick: item => {
						const name = item.data;
						const add = current.has(name) ? [] : [name];
						const remove = current.has(name) ? [name] : [];
						return this.run(localize('voltPr.labelBusy', "Updating labels…"), () => this.pullRequests.api.setLabels({ repo: pr.repo, number: pr.number, add, remove }));
					},
				});
			}).classList.add('volt-pr-add');
		}
	}

	private labelChip(parent: HTMLElement, name: string, color: string): void {
		const chip = append(parent, $('span.volt-pr-label'));
		const hex = /^[0-9a-f]{6}$/i.test(color) ? color : '888888';
		chip.style.setProperty('--volt-pr-label', `#${hex}`);
		chip.textContent = name;
	}

	/** Comments, reviews and review threads in time order. Bot comments and resolved threads start folded. */
	private renderActivity(section: HTMLElement, pr: IVoltPullRequestDetail): void {
		type Item = { at: number; kind: 'comment'; comment: IVoltPrComment } | { at: number; kind: 'review'; review: IVoltPrReview } | { at: number; kind: 'thread'; thread: IVoltPrReviewThread };
		const items: Item[] = [
			...pr.conversation.map(comment => ({ at: comment.createdAt, kind: 'comment' as const, comment })),
			...pr.reviewList.filter(review => review.body.trim() || review.state !== 'commented').map(review => ({ at: review.at, kind: 'review' as const, review })),
			...pr.threads.map(thread => ({ at: thread.comments[0]?.createdAt ?? 0, kind: 'thread' as const, thread })),
		].sort((a, b) => a.at - b.at);
		const title = append(section, $('.volt-pr-section-title'));
		title.textContent = items.length ? localize('voltPr.activityCount', "Activity ({0})", items.length) : localize('voltPr.activity', "Activity");
		if (!items.length) {
			append(section, $('.muted')).textContent = localize('voltPr.noActivity', "No comments yet.");
			return;
		}
		const list = append(section, $('.volt-pr-timeline'));
		for (const item of items) {
			switch (item.kind) {
				case 'comment':
					this.renderComment(list, item.comment, item.comment.author.bot);
					break;
				case 'review':
					this.renderReview(list, item.review);
					break;
				case 'thread':
					this.renderThread(list, pr, item.thread);
					break;
			}
		}
	}

	private renderComment(parent: HTMLElement, comment: IVoltPrComment, folded = false): HTMLElement {
		const card = append(parent, $('.volt-pr-comment'));
		const head = append(card, $('.volt-pr-comment-head'));
		avatar(head, comment.author.login, comment.author.avatarUrl);
		append(head, $('strong')).textContent = comment.author.login;
		if (comment.author.bot) {
			append(head, $('span.volt-pr-tag')).textContent = localize('voltPr.bot', "bot");
		}
		const time = append(head, $('a.volt-pr-time')) as HTMLAnchorElement;
		time.textContent = ago(comment.createdAt);
		time.href = comment.url;
		this.onClick(time, () => this.openerService.open(comment.url));
		const content = append(card, $('.volt-pr-markdown'));
		if (folded) {
			card.classList.add('folded');
			const show = this.linkButton(head, localize('voltPr.show', "Show"), () => {
				card.classList.remove('folded');
				show.remove();
				this.markdown(content, comment.body);
			});
		} else {
			this.markdown(content, comment.body);
		}
		return card;
	}

	private renderReview(parent: HTMLElement, review: IVoltPrReview): void {
		const card = append(parent, $(`.volt-pr-review.review-${review.state}`));
		const head = append(card, $('.volt-pr-comment-head'));
		iconSpan(head, review.state === 'approved' ? Codicon.passFilled : review.state === 'changesRequested' ? Codicon.diffModified : Codicon.eye, `review-${review.state}`);
		append(head, $('strong')).textContent = review.author.login;
		append(head, $('span')).textContent = review.state === 'approved' ? localize('voltPr.r.approvedThese', " approved these changes")
			: review.state === 'changesRequested' ? localize('voltPr.r.requestedChanges', " requested changes")
				: review.state === 'dismissed' ? localize('voltPr.r.dismissed', "'s review was dismissed") : localize('voltPr.r.reviewed', " reviewed");
		const time = append(head, $('a.volt-pr-time')) as HTMLAnchorElement;
		time.textContent = ago(review.at);
		time.href = review.url;
		this.onClick(time, () => this.openerService.open(review.url));
		if (review.body.trim()) {
			this.markdown(append(card, $('.volt-pr-markdown')), review.body);
		}
	}

	private renderThread(parent: HTMLElement, pr: IVoltPullRequestDetail, thread: IVoltPrReviewThread): void {
		const card = append(parent, $('.volt-pr-thread'));
		card.classList.toggle('resolved', thread.resolved);
		const head = append(card, $('.volt-pr-thread-head'));
		iconSpan(head, thread.resolved ? Codicon.passFilled : Codicon.commentUnresolved, thread.resolved ? 'thread-resolved' : 'thread-open');
		const file = append(head, $('button.volt-pr-thread-file')) as HTMLButtonElement;
		file.type = 'button';
		file.textContent = `${thread.path}${thread.line ? `:${thread.line}` : ''}`;
		setAgentTooltip(file, localize('voltPr.openInDiff', "Open in the diff"));
		this.onClick(file, () => this.openDiff(pr, thread.path));
		if (thread.outdated) {
			append(head, $('span.volt-pr-tag')).textContent = localize('voltPr.outdated', "outdated");
		}
		if (thread.resolved) {
			append(head, $('span.volt-pr-tag')).textContent = localize('voltPr.resolved', "resolved");
		}
		append(head, $('.volt-pr-spacer'));
		if (isOpenState(pr.state)) {
			this.button(head, localize('voltPr.fixThis', "Fix This"), () => this.toAgent(buildFixThreadPrompt(pr, { path: thread.path, line: thread.line, diffHunk: thread.comments[0]?.diffHunk, comments: thread.comments })), 'ghost', Codicon.sparkle);
		}
		if (thread.canResolve) {
			this.button(head, thread.resolved ? localize('voltPr.unresolve', "Unresolve") : localize('voltPr.resolveThread', "Resolve"), () => this.run(localize('voltPr.resolveBusy', "Updating thread…"), () => this.pullRequests.api.resolveThread({ repo: pr.repo, number: pr.number, threadId: thread.id, resolved: !thread.resolved })), 'ghost');
		}
		const contents = append(card, $('.volt-pr-thread-body'));
		const hunk = thread.comments[0]?.diffHunk;
		if (hunk) {
			this.renderHunk(contents, hunk);
		}
		for (const comment of thread.comments) {
			this.renderComment(contents, comment);
		}
		if (isOpenState(pr.state)) {
			this.renderReplyBox(contents, `thread:${thread.id}`, localize('voltPr.replyPlaceholder', "Reply…"), body => this.pullRequests.api.reply({ repo: pr.repo, number: pr.number, threadId: thread.id, body }));
		}
		if (thread.resolved) {
			// Folded until asked for, like GitHub.
			card.classList.add('folded');
			this.onClick(head, () => card.classList.toggle('folded'), true);
		}
	}

	/** The last lines of a review comment's hunk: where in the file it was left. */
	private renderHunk(parent: HTMLElement, hunk: string): void {
		const lines = hunk.split('\n').filter(line => !line.startsWith('@@')).slice(-6);
		const pre = append(parent, $('pre.volt-pr-hunk'));
		for (const line of lines) {
			const row = append(pre, $('span.volt-pr-hunk-line'));
			row.classList.toggle('add', line.startsWith('+'));
			row.classList.toggle('del', line.startsWith('-'));
			row.textContent = line || ' ';
		}
	}

	private renderReplyBox(parent: HTMLElement, key: string, placeholder: string, submit: (body: string) => Promise<void>): void {
		const box = append(parent, $('.volt-pr-reply'));
		const area = append(box, $('textarea.volt-pr-textarea')) as HTMLTextAreaElement;
		area.placeholder = placeholder;
		area.rows = 1;
		area.value = this.drafts.get(key) ?? '';
		const actions = append(box, $('.volt-pr-reply-actions'));
		const send = this.button(actions, localize('voltPr.reply', "Reply"), async () => {
			const body = area.value.trim();
			if (!body) {
				return;
			}
			// Out of the field, so the view can show the posted comment.
			area.blur();
			await this.run(localize('voltPr.replyBusy', "Posting…"), async () => {
				await submit(body);
				this.drafts.delete(key);
			});
		}, 'primary');
		const sync = () => {
			this.drafts.set(key, area.value);
			send.disabled = !area.value.trim() || !!this.busy;
			box.classList.toggle('active', !!area.value || this.element.ownerDocument.activeElement === area);
			area.style.height = 'auto';
			area.style.height = `${Math.min(240, area.scrollHeight)}px`;
		};
		this.renderStore.add(addDisposableListener(area, 'input', sync));
		this.renderStore.add(addDisposableListener(area, 'focus', sync));
		this.renderStore.add(addDisposableListener(area, 'blur', sync));
		this.renderStore.add(addDisposableListener(area, 'keydown', e => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				EventHelper.stop(e, true);
				send.click();
			}
		}));
		sync();
	}

	private renderCommentBox(section: HTMLElement, pr: IVoltPullRequestDetail): void {
		if (pr.state === 'merged') {
			return;
		}
		append(section, $('.volt-pr-section-title')).textContent = localize('voltPr.addComment', "Add a comment");
		this.renderReplyBox(section, 'conversation', localize('voltPr.commentPlaceholder', "Leave a comment (⌘Enter to post)"), body => this.pullRequests.api.comment({ repo: pr.repo, number: pr.number, body }));
		const viewer = pr.viewer.toLowerCase();
		if (isOpenState(pr.state) && pr.author.login.toLowerCase() !== viewer) {
			const review = append(section, $('.volt-pr-review-actions'));
			this.button(review, localize('voltPr.approve', "Approve"), () => this.submitReview(pr, 'approve'), 'secondary', Codicon.check);
			this.button(review, localize('voltPr.requestChanges', "Request Changes"), () => this.submitReview(pr, 'requestChanges'), 'secondary', Codicon.diffModified);
		}
	}

	private async submitReview(pr: IVoltPullRequestDetail, event: 'approve' | 'requestChanges'): Promise<void> {
		const body = (this.drafts.get('conversation') ?? '').trim();
		if (event === 'requestChanges' && !body) {
			this.notificationService.info(localize('voltPr.reviewNeedsBody', "Write what should change in the comment box first."));
			return;
		}
		await this.run(localize('voltPr.reviewBusy', "Submitting review…"), async () => {
			await this.pullRequests.api.review({ repo: pr.repo, number: pr.number, event, body });
			this.drafts.delete('conversation');
		});
	}

	//#endregion

	//#region Files, commits, checks

	private renderFiles(pr: IVoltPullRequestDetail): void {
		const viewed = pr.files.filter(file => file.viewed === 'viewed').length;
		const head = append(this.body, $('.volt-pr-files-head'));
		const progress = append(head, $('.volt-pr-progress'));
		const bar = append(progress, $('.volt-pr-progress-bar'));
		bar.style.width = pr.files.length ? `${Math.round(viewed / pr.files.length * 100)}%` : '0%';
		append(head, $('span.volt-pr-viewed-count')).textContent = localize('voltPr.viewedCount', "{0} / {1} viewed", viewed, pr.files.length);
		append(head, $('.volt-pr-spacer'));
		const asTree = this.filesAsTree;
		const mode = this.iconButton(head, asTree ? Codicon.listFlat : Codicon.listTree, asTree ? localize('voltPr.viewAsList', "View as List") : localize('voltPr.viewAsTree', "View as Tree"), () => {
			this.filesAsTree = !asTree;
			this.render();
		});
		mode.classList.add('volt-pr-files-mode');
		const folder = this.cloneFolder();
		const open = this.button(head, localize('voltPr.openDiff', "Open Diff"), () => this.openDiff(pr), 'secondary', Codicon.diffMultiple);
		open.disabled = !folder;
		if (!folder) {
			setAgentTooltip(open, localize('voltPr.needsClone', "Open a chat in a clone of {0}/{1} to read the diff here.", pr.repo.owner, pr.repo.name));
		}
		this.renderFilesTree(pr, !!folder);
	}

	private get filesAsTree(): boolean {
		return this.storageService.getBoolean(FILES_AS_TREE_KEY, StorageScope.PROFILE, true);
	}

	private set filesAsTree(value: boolean) {
		this.storageService.store(FILES_AS_TREE_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	/** The changed files as the workbench's own tree: directories fold, or a flat list with each file's folder. */
	private renderFilesTree(pr: IVoltPullRequestDetail, canOpen: boolean): void {
		const container = append(this.body, $('.volt-pr-files.volt-pr-files-tree'));
		const isViewed = (file: { path: string; viewed: string }) => this.pendingViewed.get(file.path) ?? file.viewed === 'viewed';
		const tree = this.renderStore.add(this.instantiationService.createInstance(
			WorkbenchObjectTree<PrFilesNode, void>,
			'VoltPrFiles',
			container,
			new PrFilesDelegate(),
			[new PrFileRenderer(!this.filesAsTree, isViewed, (path, viewed) => this.toggleViewed(path, viewed)), new PrDirRenderer()],
			{
				identityProvider: { getId: (node: PrFilesNode) => node.kind === 'dir' ? `dir:${node.dir}` : `file:${node.file.path}` },
				accessibilityProvider: {
					getAriaLabel: (node: PrFilesNode) => node.kind === 'dir' ? node.dir : node.file.path,
					getWidgetAriaLabel: () => localize('voltPr.filesAria', "Changed files"),
				},
				horizontalScrolling: false,
				expandOnlyOnTwistieClick: false,
			},
		)) as WorkbenchObjectTree<PrFilesNode, void>;

		const fileNode = (file: IVoltPullRequestDetail['files'][number]): IObjectTreeElement<PrFilesNode> => ({ element: { kind: 'file', file } });
		if (this.filesAsTree) {
			// One level, like the diff's own grouping: the directory, then its files.
			const groups = new Map<string, IObjectTreeElement<PrFilesNode>[]>();
			for (const file of pr.files) {
				const dir = dirname(file.path);
				const key = dir === '.' ? '' : dir;
				let bucket = groups.get(key);
				if (!bucket) {
					groups.set(key, bucket = []);
				}
				bucket.push(fileNode(file));
			}
			const roots: IObjectTreeElement<PrFilesNode>[] = [];
			for (const [dir, children] of groups) {
				if (!dir) {
					roots.push(...children);
				} else {
					roots.push({
						element: { kind: 'dir', dir, count: children.length },
						children,
						collapsible: true,
						collapsed: this.collapsedDirs.has(dir),
					});
				}
			}
			tree.setChildren(null, roots);
		} else {
			tree.setChildren(null, pr.files.map(fileNode));
		}

		this.renderStore.add(tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element?.kind === 'dir') {
				if (e.node.collapsed) {
					this.collapsedDirs.add(element.dir);
				} else {
					this.collapsedDirs.delete(element.dir);
				}
			}
		}));
		this.renderStore.add(tree.onDidOpen(e => {
			if (e.element?.kind === 'file' && canOpen) {
				this.openDiff(pr, e.element.file.path);
			}
		}));

		// The view's body does the scrolling; the tree always shows all of its rows.
		const relayout = () => {
			const height = tree.contentHeight;
			container.style.height = `${height}px`;
			tree.layout(height, container.clientWidth || undefined);
		};
		this.renderStore.add(tree.onDidChangeContentHeight(relayout));
		const resize = new ResizeObserver(relayout);
		resize.observe(container);
		this.renderStore.add({ dispose: () => resize.disconnect() });
		relayout();
	}

	private toggleViewed(path: string, viewed: boolean): void {
		this.pendingViewed.set(path, viewed);
		this.render();
		this.viewedFlush.schedule();
	}

	private async flushViewed(): Promise<void> {
		const target = this.target;
		const changes = [...this.pendingViewed];
		this.pendingViewed.clear();
		if (!target || !changes.length) {
			return;
		}
		const failed: string[] = [];
		await Promise.all(changes.map(([path, viewed]) => this.pullRequests.api.setViewed({ repo: target.repo, number: target.number, path, viewed }).catch(() => failed.push(path))));
		if (failed.length) {
			this.notificationService.warn(localize('voltPr.viewedFailedMany', "Could not mark {0} on GitHub.", failed.join(', ')));
		}
		await this.load(false);
	}

	private renderCommits(pr: IVoltPullRequestDetail): void {
		const list = append(this.body, $('.volt-pr-list'));
		if (!pr.commits.length) {
			append(list, $('.muted')).textContent = localize('voltPr.noCommits', "No commits.");
			return;
		}
		for (const commit of [...pr.commits].reverse()) {
			const row = append(list, $('.volt-pr-row'));
			if (commit.checks !== 'none') {
				iconSpan(row, checkIcon(commit.checks), `check-${commit.checks}`);
			} else {
				iconSpan(row, Codicon.gitCommit, 'muted');
			}
			append(row, $('span.volt-pr-row-title')).textContent = commit.headline;
			append(row, $('.volt-pr-spacer'));
			append(row, $('span.muted')).textContent = `${commit.author} · ${ago(commit.at)}`;
			const sha = append(row, $('button.volt-pr-sha')) as HTMLButtonElement;
			sha.type = 'button';
			sha.textContent = commit.oid.slice(0, 7);
			setAgentTooltip(sha, localize('voltPr.copySha', "Copy commit id"));
			this.onClick(sha, () => this.copy(commit.oid, localize('voltPr.copiedSha', "Copied {0}", commit.oid.slice(0, 7))));
		}
	}

	private renderChecks(pr: IVoltPullRequestDetail): void {
		const head = append(this.body, $('.volt-pr-files-head'));
		iconSpan(head, checkIcon(pr.checks.state), `check-${pr.checks.state}`);
		append(head, $('span')).textContent = checksLabel(pr);
		append(head, $('.volt-pr-spacer'));
		const failing = pr.checkRuns.filter(check => check.state === 'failure');
		if (failing.length && isOpenState(pr.state)) {
			this.button(head, localize('voltPr.rerunShort', "Re-run Failed"), () => this.rerun(pr), 'secondary', Codicon.debugRerun);
			this.button(head, localize('voltPr.fixWithAgent', "Fix with Agent"), () => this.toAgent(buildFixChecksPrompt(pr, failing)), 'primary', Codicon.sparkle);
		}
		const list = append(this.body, $('.volt-pr-list'));
		if (!pr.checkRuns.length) {
			append(list, $('.muted')).textContent = localize('voltPr.noChecksRun', "No checks ran on the latest commit.");
			return;
		}
		const order: Record<IVoltPrCheck['state'], number> = { failure: 0, cancelled: 1, pending: 2, success: 3, neutral: 4, skipped: 5 };
		for (const check of [...pr.checkRuns].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))) {
			const row = append(list, $('.volt-pr-row'));
			iconSpan(row, check.state === 'pending' ? Codicon.loading : checkIcon(check.state), `check-${check.state}`);
			const name = append(row, $('span.volt-pr-row-title'));
			name.textContent = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
			if (check.required) {
				append(row, $('span.volt-pr-tag')).textContent = localize('voltPr.required', "required");
			}
			if (check.summary) {
				append(row, $('span.muted.volt-pr-row-detail')).textContent = check.summary;
			}
			append(row, $('.volt-pr-spacer'));
			const duration = checkDuration(check);
			if (duration) {
				append(row, $('span.muted')).textContent = duration;
			}
			if (check.url) {
				this.linkButton(row, localize('voltPr.details', "Details"), () => this.openerService.open(check.url!));
			}
		}
	}

	//#endregion

	//#region Actions

	/** The local clone the diff and agent prompts use: the chat's folder when it is this repository. */
	private cloneFolder(): string | undefined {
		const sessionId = this.sessionId;
		const folder = sessionId ? this.pullRequests.folderFor(sessionId) : undefined;
		return folder;
	}

	private openDiff(pr: IVoltPullRequestDetail, path?: string): void {
		const folder = this.cloneFolder();
		if (!folder) {
			void this.openerService.open(`${pr.url}/files`);
			return;
		}
		void this.instantiationService.invokeFunction(accessor => openPullRequestDiff(accessor, { repo: pr.repo, number: pr.number, folder }, pr.title, path, this.sessionId))
			.catch(err => this.notificationService.error(localize('voltPr.diffFailed', "Could not open the diff: {0}", voltPrErrorMessage(err))));
	}

	private async toAgent(prompt: string): Promise<void> {
		const sessionId = this.sessionId ?? this.instantiationService.invokeFunction(visibleChatSession);
		if (!sessionId) {
			await this.copy(prompt, localize('voltPr.copiedPrompt', "No chat is linked to this pull request; the prompt was copied."));
			return;
		}
		const ok = await this.instantiationService.invokeFunction(accessor => composeInChat(accessor, sessionId, prompt));
		if (!ok) {
			await this.copy(prompt, localize('voltPr.copiedPromptFallback', "The chat could not be opened; the prompt was copied."));
		}
	}

	private async merge(pr: IVoltPullRequestDetail, method: VoltPrMergeMethod, auto: boolean, skipConfirm: boolean): Promise<void> {
		const deleteBranch = !pr.crossRepository && (this.deleteBranch ?? pr.mergeOptions.deleteBranchOnMerge);
		if (!skipConfirm) {
			const { confirmed } = await this.dialogService.confirm({
				message: auto
					? localize('voltPr.confirmAuto', "Merge #{0} automatically?", pr.number)
					: localize('voltPr.confirmMerge', "Merge #{0} into {1}?", pr.number, pr.baseRefName),
				detail: [
					auto ? localize('voltPr.confirmAutoDetail', "It merges with {0} once checks pass and reviews allow.", MERGE_LABELS[method].toLowerCase()) : MERGE_LABELS[method],
					deleteBranch ? localize('voltPr.confirmDelete', "{0} is deleted afterwards.", pr.headRefName) : undefined,
				].filter(Boolean).join('\n'),
				primaryButton: auto ? localize('voltPr.enableAuto', "Enable Auto-merge") : MERGE_LABELS[method],
			});
			if (!confirmed) {
				return;
			}
		}
		this.pullRequests.rememberMergeMethod(pr.repo, method);
		await this.run(auto ? localize('voltPr.autoBusy', "Enabling auto-merge…") : localize('voltPr.mergeBusy', "Merging…"), () => this.pullRequests.api.merge({
			repo: pr.repo,
			number: pr.number,
			method,
			auto,
			headOid: pr.headRefOid,
			deleteBranch,
		}));
	}

	private async updateBranch(pr: IVoltPullRequestDetail, rebase: boolean): Promise<void> {
		if (rebase) {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('voltPr.confirmRebase', "Rebase {0} on {1}?", pr.headRefName, pr.baseRefName),
				detail: localize('voltPr.confirmRebaseDetail', "This rewrites the branch on GitHub. Pull it again before pushing from a local checkout."),
				primaryButton: localize('voltPr.rebaseButton', "Rebase"),
			});
			if (!confirmed) {
				return;
			}
		}
		await this.run(localize('voltPr.updateBusy', "Updating branch…"), () => this.pullRequests.api.updateBranch({ repo: pr.repo, number: pr.number, rebase }));
	}

	private async setState(pr: IVoltPullRequestDetail, state: 'open' | 'closed', skipConfirm: boolean): Promise<void> {
		if (state === 'closed' && !skipConfirm) {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('voltPr.confirmClose', "Close #{0} without merging?", pr.number),
				primaryButton: localize('voltPr.closeButton', "Close Pull Request"),
			});
			if (!confirmed) {
				return;
			}
		}
		await this.run(state === 'closed' ? localize('voltPr.closeBusy', "Closing…") : localize('voltPr.reopenBusy', "Reopening…"), () => this.pullRequests.api.setState({ repo: pr.repo, number: pr.number, state }));
	}

	private async rerun(pr: IVoltPullRequestDetail): Promise<void> {
		await this.run(localize('voltPr.rerunBusy', "Re-running failed checks…"), async () => {
			const count = await this.pullRequests.api.rerunFailedChecks({ repo: pr.repo, number: pr.number });
			if (!count) {
				this.notificationService.info(localize('voltPr.rerunNone', "No failed GitHub Actions runs to re-run on the latest commit."));
			}
		});
	}

	/** Rebases each open layer on the one below, bottom first, stopping at the first that fails. */
	private async rebaseStack(layers: readonly IAgentPrLink[]): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltPr.confirmRebaseStack', "Rebase {0} layers of the stack?", layers.length),
			detail: localize('voltPr.confirmRebaseStackDetail', "Each branch is rebased on GitHub onto the one below it, bottom first. This rewrites them."),
			primaryButton: localize('voltPr.rebaseButton', "Rebase"),
		});
		if (!confirmed) {
			return;
		}
		await this.run(localize('voltPr.rebaseStackBusy', "Rebasing the stack…"), async () => {
			for (const layer of layers) {
				const [fresh] = await this.pullRequests.api.getMany([{ repo: layer.repo, number: layer.number }]);
				if (!fresh || !isOpenState(fresh.state) || fresh.mergeState !== 'behind') {
					continue;
				}
				await this.pullRequests.api.updateBranch({ repo: layer.repo, number: layer.number, rebase: true });
			}
		});
	}

	/**
	 * Merges the stack from the bottom up to `top`. Each layer is read again first: it must still be
	 * open, mergeable and on the head the user saw; the next layer is pointed at the trunk before it
	 * merges, so it never merges into a branch that is gone.
	 */
	private async mergeStack(layers: readonly IAgentPrLink[], top: IVoltPullRequestDetail): Promise<void> {
		const open = layers.filter(layer => isOpenState(layer.snapshot?.state));
		if (!open.length) {
			return;
		}
		const method = this.mergeMethod(top);
		const trunk = layers[0].snapshot?.baseRefName ?? top.baseRefName;
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltPr.confirmMergeStack', "Merge {0} pull requests into {1}?", open.length, trunk),
			detail: `${open.map(layer => `#${layer.number} ${layer.snapshot?.title ?? ''}`).join('\n')}\n\n${MERGE_LABELS[method]}`,
			primaryButton: localize('voltPr.mergeStackButton', "Merge Stack"),
		});
		if (!confirmed) {
			return;
		}
		await this.run(localize('voltPr.mergeStackBusy', "Merging the stack…"), async () => {
			for (const layer of open) {
				const request = { repo: layer.repo, number: layer.number };
				let [fresh] = await this.pullRequests.api.getMany([request]);
				if (!fresh || !isOpenState(fresh.state)) {
					continue;
				}
				if (fresh.state === 'draft') {
					throw new Error(localize('voltPr.stackDraft', "#{0} is a draft; mark it ready first.", fresh.number));
				}
				if (fresh.baseRefName !== trunk) {
					await this.pullRequests.api.setBase({ ...request, base: trunk });
					[fresh] = await this.pullRequests.api.getMany([request]);
				}
				// Only the commits the user saw in the stack go in: a push since then fails the merge.
				await this.pullRequests.api.merge({ ...request, method, headOid: layer.snapshot?.headRefOid ?? fresh.headRefOid, deleteBranch: false });
			}
		});
	}

	/** Runs an action with the header showing it is busy; errors become notifications; the pull request is read again after. */
	private async run(label: string, action: () => Promise<unknown>, reload = true): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = label;
		this.element.classList.add('busy');
		this.element.setAttribute('aria-busy', 'true');
		const status = append(this.header, $('.volt-pr-busy'));
		status.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
		append(status, $('span')).textContent = label;
		try {
			await action();
		} catch (err) {
			const code = voltPrErrorCode(err);
			const message = code === 'stale'
				? localize('voltPr.staleHead', "Someone pushed to the branch since you looked. Review the new commits and try again.")
				: voltPrErrorMessage(err);
			this.notificationService.error(message);
		} finally {
			this.busy = undefined;
			this.element.classList.remove('busy');
			this.element.removeAttribute('aria-busy');
			status.remove();
			if (reload) {
				await this.load(false);
				// Stack actions change the other layers too: read every linked pull request again.
				void this.pullRequests.refresh();
			} else {
				this.render();
			}
		}
	}

	private async copy(text: string, message: string): Promise<void> {
		await this.clipboardService.writeText(text);
		this.notificationService.info(message);
	}

	//#endregion

	//#region DOM helpers

	private markdown(parent: HTMLElement, text: string): void {
		renderMarkdownInto(parent, text, {
			markdownRenderer: this.markdownRenderer,
			store: this.renderStore,
			blockState: {},
			onToggle: () => undefined,
			onScroll: () => undefined,
			instantiationService: this.instantiationService,
			languageService: this.languageService,
			onOpenUrl: url => void this.openerService.open(url),
		});
	}

	private onClick(element: HTMLElement, handler: (e: MouseEvent) => unknown, onlySelf = false): void {
		this.renderStore.add(addDisposableListener(element, 'click', e => {
			if (onlySelf && (e.target as HTMLElement).closest('button')) {
				return;
			}
			EventHelper.stop(e, true);
			void handler(e);
		}));
	}

	private button(parent: HTMLElement, label: string, handler: (e?: MouseEvent) => unknown, kind: 'primary' | 'secondary' | 'ghost' = 'secondary', icon?: ThemeIcon): HTMLButtonElement {
		const button = append(parent, $(`button.volt-pr-button.${kind}`)) as HTMLButtonElement;
		button.type = 'button';
		if (icon) {
			button.appendChild(renderIcon(icon));
		}
		append(button, $('span')).textContent = label;
		button.disabled = !!this.busy;
		this.onClick(button, e => handler(e));
		return button;
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, handler: (button: HTMLButtonElement) => unknown): HTMLButtonElement {
		const button = append(parent, $('button.volt-pr-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(icon));
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label);
		this.onClick(button, () => handler(button));
		return button;
	}

	private linkButton(parent: HTMLElement, label: string, handler: () => unknown): HTMLButtonElement {
		const button = append(parent, $('button.volt-pr-link-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		this.onClick(button, () => handler());
		return button;
	}

	//#endregion

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}

//#region Files tree

type PrFilesNode =
	| { readonly kind: 'file'; readonly file: IVoltPrFile }
	| { readonly kind: 'dir'; readonly dir: string; readonly count: number };

class PrFilesDelegate implements IListVirtualDelegate<PrFilesNode> {
	getHeight(node: PrFilesNode): number {
		return node.kind === 'dir' ? 28 : 32;
	}
	getTemplateId(node: PrFilesNode): string {
		return node.kind;
	}
}

interface IPrFileTemplate {
	readonly check: HTMLButtonElement;
	readonly change: HTMLElement;
	readonly name: HTMLElement;
	readonly dir: HTMLElement;
	readonly renamed: HTMLElement;
	readonly tag: HTMLElement;
	readonly add: HTMLElement;
	readonly del: HTMLElement;
	readonly store: DisposableStore;
	current?: IVoltPrFile;
	viewed?: boolean;
}

class PrFileRenderer implements ITreeRenderer<PrFilesNode, void, IPrFileTemplate> {

	readonly templateId = 'file';

	constructor(
		private readonly showDir: boolean,
		private readonly isViewed: (file: IVoltPrFile) => boolean,
		private readonly toggleViewed: (path: string, viewed: boolean) => void,
	) { }

	renderTemplate(container: HTMLElement): IPrFileTemplate {
		const row = append(container, $('.volt-pr-file'));
		const store = new DisposableStore();
		const check = append(row, $('button.volt-pr-check')) as HTMLButtonElement;
		check.type = 'button';
		check.setAttribute('role', 'checkbox');
		const change = append(row, $('span.volt-pr-change'));
		const name = append(row, $('span.volt-pr-file-name'));
		const dir = append(row, $('span.muted.volt-pr-file-dir'));
		const renamed = append(row, $('span.muted.volt-pr-renamed'));
		const tag = append(row, $('span.volt-pr-tag.changed'));
		tag.textContent = localize('voltPr.changedSinceViewed', "changed");
		append(row, $('.volt-pr-spacer'));
		const stats = append(row, $('span.volt-pr-stats'));
		const add = append(stats, $('span.add'));
		const del = append(stats, $('span.del'));
		const template: IPrFileTemplate = { check, change, name, dir, renamed, tag, add, del, store };
		// The tick must not open the diff: the tree acts on mouse down, so stop that too.
		store.add(addDisposableListener(check, 'mousedown', e => EventHelper.stop(e, true)));
		store.add(addDisposableListener(check, 'click', e => {
			EventHelper.stop(e, true);
			if (template.current) {
				this.toggleViewed(template.current.path, !template.viewed);
			}
		}));
		return template;
	}

	renderElement(node: ITreeNode<PrFilesNode, void>, _index: number, template: IPrFileTemplate): void {
		const element = node.element;
		if (element.kind !== 'file') {
			return;
		}
		const file = element.file;
		const viewed = this.isViewed(file);
		template.current = file;
		template.viewed = viewed;
		const row = template.check.parentElement!;
		row.classList.toggle('viewed', viewed);
		template.check.setAttribute('aria-checked', String(viewed));
		template.check.replaceChildren(renderIcon(viewed ? Codicon.passFilled : Codicon.circleLarge));
		setAgentTooltip(template.check, viewed ? localize('voltPr.unmarkViewed', "Mark as not viewed") : localize('voltPr.markViewedTip', "Mark as viewed"));
		template.change.className = `volt-pr-change change-${file.change}`;
		template.change.textContent = changeLetter(file.change);
		template.name.textContent = basename(file.path);
		const dir = dirname(file.path);
		template.dir.textContent = this.showDir && dir && dir !== '.' ? dir : '';
		template.renamed.textContent = file.previousPath ? localize('voltPr.renamedFrom', "from {0}", file.previousPath) : '';
		template.tag.style.display = file.viewed === 'dismissed' ? '' : 'none';
		template.add.textContent = `+${file.additions}`;
		template.del.textContent = `−${file.deletions}`;
	}

	disposeTemplate(template: IPrFileTemplate): void {
		template.store.dispose();
	}
}

interface IPrDirTemplate {
	readonly name: HTMLElement;
	readonly count: HTMLElement;
}

class PrDirRenderer implements ITreeRenderer<PrFilesNode, void, IPrDirTemplate> {

	readonly templateId = 'dir';

	renderTemplate(container: HTMLElement): IPrDirTemplate {
		const row = append(container, $('.volt-pr-dir'));
		row.appendChild(renderIcon(Codicon.folder));
		const name = append(row, $('span.volt-pr-dir-name'));
		const count = append(row, $('span.muted.volt-pr-dir-count'));
		return { name, count };
	}

	renderElement(node: ITreeNode<PrFilesNode, void>, _index: number, template: IPrDirTemplate): void {
		const element = node.element;
		if (element.kind !== 'dir') {
			return;
		}
		template.name.textContent = element.dir;
		template.count.textContent = String(element.count);
	}

	disposeTemplate(): void { }
}

//#endregion

function changeLetter(change: string): string {
	switch (change) {
		case 'added': return 'A';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'copied': return 'C';
		default: return 'M';
	}
}

function colorDot(color: string): HTMLElement {
	const dot = $('span.volt-pr-color-dot');
	dot.style.background = /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : '#888';
	return dot;
}
