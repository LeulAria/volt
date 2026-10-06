/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/path.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { prKey } from '../../../../../platform/voltPullRequests/common/voltPullRequestParse.js';
import {
	IVoltPrCheck,
	IVoltPrComment,
	IVoltPrFilePatch,
	IVoltPrReview,
	IVoltPrReviewThread,
	IVoltPullRequestDetail,
	VoltPrFileChange,
	VoltPrMergeMethod,
	voltPrErrorCode,
	voltPrErrorMessage,
} from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IPrDiffLine, lineRange, parseUnifiedPatch } from '../../common/agentPrDiff.js';
import {
	buildExplainPrompt,
	buildFixChecksPrompt,
	buildFixThreadPrompt,
	buildResolveConflictsPrompt,
	buildReviewLinePrompt,
	IAgentPrLink,
	isOpenState,
	primaryAction,
	resolveChains,
	resolveMergeMethod,
} from '../../common/agentPullRequests.js';
import { renderMarkdownInto } from '../blocks/agentBlockRenderers.js';
import { highlight } from '../blocks/agentCodeBlock.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { createVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { openPullRequestDiff } from './agentPullRequestDiff.js';
import { AgentPullRequestEditorInput } from './agentPullRequestEditorInput.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { ago, avatar, checkDuration, checkIcon, composeInChat, iconSpan, openPullRequest, problemText, prStateIcon, signInWithGh, visibleChatSession } from './agentPullRequestUi.js';

type Tab = 'summary' | 'timeline' | 'code';
type Order = 'newest' | 'oldest';

/** While the view is on screen, it re-reads the pull request this often. */
const POLL_MS = 20_000;
/** Viewed ticks are sent together after this pause, like T3 Code. */
const VIEWED_FLUSH_MS = 400;
/** Files longer than this many diff lines start folded in the Code tab. */
const LARGE_FILE_LINES = 400;

const MERGE_LABELS: Record<VoltPrMergeMethod, string> = {
	squash: localize('voltPr.merge.squash', "Squash and Merge"),
	merge: localize('voltPr.merge.merge', "Merge"),
	rebase: localize('voltPr.merge.rebase', "Rebase and Merge"),
};

const MERGE_METHOD_NAMES: Record<VoltPrMergeMethod, string> = {
	squash: localize('voltPr.method.squash', "squash"),
	merge: localize('voltPr.method.merge', "merge"),
	rebase: localize('voltPr.method.rebase', "rebase"),
};

interface IPatchLoad {
	readonly files?: readonly IVoltPrFilePatch[];
	readonly error?: unknown;
}

/**
 * One pull request, laid out like T3 Code's pull request panel: the repository and number with the
 * main action, the title, who and when, base ← head, and Summary, Timeline and Code. Every action
 * reads the pull request again afterwards, so what is shown is GitHub's.
 */
export class AgentPullRequestView extends Disposable {

	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly body: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly composeStore = this._register(new DisposableStore());
	private readonly markdownRenderer: MarkdownRenderer;
	private readonly poll = this._register(new RunOnceScheduler(() => void this.load(false), POLL_MS));
	private readonly pendingViewed = new Map<string, boolean>();
	private readonly viewedFlush = this._register(new RunOnceScheduler(() => void this.flushViewed(), VIEWED_FLUSH_MS));

	private input: AgentPullRequestEditorInput | undefined;
	private detail: IVoltPullRequestDetail | undefined;
	/** The last read as JSON, to tell a re-read that changed nothing. */
	private detailSignature: string | undefined;
	private error: unknown;
	private tab: Tab = 'summary';
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
	/** Summary sections the user folded (Checks starts folded, like T3 Code). */
	private readonly folded = new Set<string>(['checks']);
	private commentOrder: Order = 'newest';
	private timelineOrder: Order = 'newest';
	/** Code tab: the commit shown (undefined: all of them), and the files opened. */
	private codeCommit: string | undefined;
	private readonly expanded = new Set<string>();
	private readonly collapsedByUser = new Set<string>();
	private readonly patches = new Map<string, IPatchLoad>();
	private readonly patchLoads = new Set<string>();
	/** The line a shift-click extends a selection from, per file. */
	private lineAnchor: { readonly path: string; readonly index: number } | undefined;
	private composeOpen = false;
	private composeMode: 'comment' | 'review' = 'comment';
	private reviewEvent: 'comment' | 'approve' | 'requestChanges' = 'comment';
	private readonly composeHost: HTMLElement;

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
	) {
		super();
		this.element = append(parent, $('.volt-pr-view'));
		this.element.tabIndex = -1;
		this.header = append(this.element, $('.volt-pr-header'));
		this.body = append(this.element, $('.volt-pr-body'));
		this.composeHost = append(this.element, $('.volt-pr-compose-host'));
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
				const signature = JSON.stringify(detail);
				const changed = signature !== this.detailSignature || !!this.error;
				this.detailSignature = signature;
				this.detail = detail;
				this.error = undefined;
				if (changed) {
					this.renderSoon();
				}
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
		// The header condenses to "#12 title" once the title scrolls away, like T3 Code.
		this._register(addDisposableListener(this.body, 'scroll', () => {
			this.element.classList.toggle('scrolled', this.body.scrollTop > 8);
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
		this.detailSignature = undefined;
		this.error = undefined;
		this.tab = 'summary';
		this.drafts.clear();
		this.deleteBranch = undefined;
		this.codeCommit = undefined;
		this.expanded.clear();
		this.collapsedByUser.clear();
		this.lineAnchor = undefined;
		this.composeOpen = false;
		this.element.classList.remove('scrolled');
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
		let unchanged = false;
		this.loading = true;
		if (force) {
			this.render();
		}
		try {
			const detail = await this.pullRequests.detail({ repo: target.repo, number: target.number }, true);
			if (seq !== this.loadSeq) {
				return;
			}
			// Nothing changed on GitHub: keep the page as it is (open diffs, a text selection, colours).
			const signature = JSON.stringify(detail);
			unchanged = !force && !this.error && signature === this.detailSignature;
			this.detailSignature = signature;
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
				} else if (!unchanged) {
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
		const scrollTop = this.body.scrollTop;
		this.renderStore.clear();
		clearNode(this.header);
		clearNode(this.body);
		const target = this.target;
		if (!target) {
			this.renderCompose(undefined);
			return;
		}
		const detail = this.detail;
		if (!detail) {
			if (this.error) {
				this.renderProblem(this.body, this.error, target.repo.host);
			} else {
				this.renderSkeleton();
			}
			this.renderCompose(undefined);
			return;
		}
		this.renderHeader(detail);
		if (this.error) {
			const stale = append(this.body, $('.volt-pr-banner.warning'));
			stale.appendChild(renderIcon(Codicon.warning));
			append(stale, $('span')).textContent = localize('voltPr.stale', "Showing the last copy: {0}", voltPrErrorMessage(this.error));
		}
		switch (this.tab) {
			case 'summary': this.renderSummary(detail); break;
			case 'timeline': this.renderTimeline(detail); break;
			case 'code': this.renderCode(detail); break;
		}
		this.renderCompose(detail);
		// A re-read keeps the reader where they were.
		this.body.scrollTop = scrollTop;
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

	//#endregion

	//#region Header

	private renderHeader(pr: IVoltPullRequestDetail): void {
		const top = append(this.header, $('.volt-pr-header-row'));
		const crumbs = append(top, $('.volt-pr-crumbs'));
		// Full row: owner/repo #12 ↗. Condensed (scrolled): #12 and the title.
		const full = append(crumbs, $('.volt-pr-crumbs-full'));
		const repo = append(full, $('a.volt-pr-repo')) as HTMLAnchorElement;
		repo.textContent = `${pr.repo.owner}/${pr.repo.name}`.toLowerCase();
		repo.href = `https://${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}`;
		this.onClick(repo, () => this.openerService.open(repo.href));
		const number = append(full, $(`a.volt-pr-number.state-${pr.state}`)) as HTMLAnchorElement;
		append(number, $('span')).textContent = `#${pr.number}`;
		number.appendChild(renderIcon(Codicon.linkExternal));
		number.href = pr.url;
		setAgentTooltip(number, localize('voltPr.openOnHost', "Open on GitHub"));
		this.onClick(number, () => this.openerService.open(pr.url));
		const condensed = append(crumbs, $('.volt-pr-crumbs-condensed'));
		append(condensed, $(`span.volt-pr-number.state-${pr.state}`)).textContent = `#${pr.number}`;
		append(condensed, $('span.volt-pr-condensed-title')).textContent = pr.title;

		const actions = append(top, $('.volt-pr-header-actions'));
		this.renderStackPill(actions, pr);
		this.renderWatchToggle(actions, pr);
		this.renderPrimary(actions, pr);
		const more = this.iconButton(actions, Codicon.ellipsis, localize('voltPr.more', "More Pull Request Actions"), button => this.showMoreMenu(button, pr));
		more.classList.add('volt-pr-more');

		const fold = append(this.header, $('.volt-pr-fold'));
		append(fold, $('h1.volt-pr-title')).textContent = pr.title;

		const byline = append(fold, $('.volt-pr-byline'));
		avatar(byline, pr.author.login, pr.author.avatarUrl, 18);
		append(byline, $('strong')).textContent = pr.author.login;
		append(byline, $('span.volt-pr-dot')).textContent = '·';
		append(byline, $('span.muted')).textContent = pr.state === 'merged' && pr.mergedAt
			? localize('voltPr.mergedAgo', "merged {0}", ago(pr.mergedAt))
			: pr.state === 'closed' && pr.closedAt ? localize('voltPr.closedAgo', "closed {0}", ago(pr.closedAt))
				: localize('voltPr.updatedAgo', "updated {0}", ago(pr.updatedAt));
		append(byline, $('.volt-pr-spacer'));
		const checkout = append(byline, $('button.volt-pr-checkout')) as HTMLButtonElement;
		checkout.type = 'button';
		checkout.textContent = `gh pr checkout ${pr.number}`;
		setAgentTooltip(checkout, localize('voltPr.copyCheckout', "Copy Checkout Command"));
		this.onClick(checkout, () => this.copy(`gh pr checkout ${pr.number}`, localize('voltPr.copiedCheckout', "Copied gh pr checkout {0}", pr.number)));

		const branches = append(fold, $('.volt-pr-branches'));
		this.branchName(branches, pr.baseRefName, pr.mergeState === 'behind' && isOpenState(pr.state) ? pr : undefined);
		append(branches, $('span.volt-pr-arrow')).appendChild(renderIcon(Codicon.arrowLeft));
		this.branchName(branches, pr.crossRepository && pr.headOwner ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName);
		append(branches, $('.volt-pr-spacer'));
		const files = append(branches, $('button.volt-pr-filestat')) as HTMLButtonElement;
		files.type = 'button';
		files.appendChild(renderIcon(Codicon.diffMultiple));
		const count = pr.files.length || pr.changedFiles;
		append(files, $('span')).textContent = count === 1 ? localize('voltPr.oneFile', "1 file") : localize('voltPr.files', "{0} files", count);
		append(files, $('span.add')).textContent = `+${pr.additions}`;
		append(files, $('span.del')).textContent = `−${pr.deletions}`;
		// With a local clone the changes open in a diff editor tab; without one, the Code tab shows them.
		const canDiff = !!this.cloneFolder();
		setAgentTooltip(files, canDiff ? localize('voltPr.openDiff', "Open in Diff Editor") : localize('voltPr.showCode', "Show the changes"));
		this.onClick(files, () => canDiff ? this.openDiff(pr) : this.showTab('code'));

		const tabbar = append(this.header, $('.volt-pr-tabbar'));
		createVoltSegmented<Tab>(tabbar, [
			{ id: 'summary', label: localize('voltPr.tab.summary', "Summary") },
			{ id: 'timeline', label: localize('voltPr.tab.timeline', "Timeline") },
			{ id: 'code', label: localize('voltPr.tab.code', "Code") },
		], this.tab, tab => this.showTab(tab), this.renderStore, 'small');
		append(tabbar, $('.volt-pr-spacer'));
		const aside = append(tabbar, $('.volt-pr-tabbar-aside'));
		if (this.tab === 'summary') {
			this.renderChecksSummary(aside, pr);
		} else if (this.tab === 'timeline') {
			const comments = pr.conversation.length + pr.threads.reduce((sum, thread) => sum + thread.comments.length, 0);
			const stat = append(aside, $('span.volt-pr-tabbar-stat'));
			stat.appendChild(renderIcon(Codicon.comment));
			append(stat, $('span')).textContent = String(comments);
			append(aside, $('span.volt-pr-dot')).textContent = '·';
			const commits = append(aside, $('span.volt-pr-tabbar-stat'));
			commits.appendChild(renderIcon(Codicon.gitCommit));
			append(commits, $('span')).textContent = String(pr.commits.length);
			this.orderToggle(aside, this.timelineOrder, order => {
				this.timelineOrder = order;
				this.render();
			});
		}
	}

	private showTab(tab: Tab): void {
		if (this.tab === tab) {
			return;
		}
		this.tab = tab;
		this.render();
		this.body.scrollTop = 0;
	}

	/** A branch name that copies itself; the base gets T3 Code's ⚠ when it moved on (Update Branch). */
	private branchName(parent: HTMLElement, name: string, behind?: IVoltPullRequestDetail): void {
		const chip = append(parent, $('button.volt-pr-branch')) as HTMLButtonElement;
		chip.type = 'button';
		append(chip, $('span')).textContent = name;
		setAgentTooltip(chip, localize('voltPr.copyBranch', "Copy branch name"));
		this.onClick(chip, () => this.copy(name, localize('voltPr.copiedBranch', "Copied {0}", name)));
		if (!behind) {
			return;
		}
		chip.classList.add('behind');
		const warn = append(parent, $('button.volt-pr-behind')) as HTMLButtonElement;
		warn.type = 'button';
		warn.appendChild(renderIcon(Codicon.warning));
		const tip = localize('voltPr.behindTip', "{0} has commits this branch does not. Update it.", name);
		warn.setAttribute('aria-label', tip);
		setAgentTooltip(warn, tip);
		this.onClick(warn, () => {
			showVoltMenu<boolean>(this.contextViewService, {
				anchor: warn,
				ariaLabel: localize('voltPr.updateOptions', "Update Branch"),
				width: 240,
				sections: [{
					id: 'update', title: localize('voltPr.behindTitle', "Out of date with {0}", name), items: [
						{ id: 'merge', label: localize('voltPr.updateMerge', "Update Branch"), icon: Codicon.gitMerge, data: false },
						{ id: 'rebase', label: localize('voltPr.updateRebase', "Update with Rebase"), icon: Codicon.sync, data: true },
					],
				}],
				onPick: item => this.updateBranch(behind, item.data),
			});
		});
	}

	/** "1 of 2 failing", "2 passing", "Running" or "No checks reported": opens the Checks section. */
	private renderChecksSummary(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		const checks = pr.checks;
		const button = append(parent, $(`button.volt-pr-checks-summary.check-${checks.state}`)) as HTMLButtonElement;
		button.type = 'button';
		iconSpan(button, checks.state === 'pending' ? ThemeIcon.modify(Codicon.loading, 'spin') : checks.state === 'none' ? Codicon.circleLarge : checkIcon(checks.state), `check-${checks.state}`);
		const counted = checks.passed + checks.failed + checks.pending;
		append(button, $('span')).textContent = checks.state === 'none' ? localize('voltPr.noChecksReported', "No checks reported")
			: checks.state === 'failure' ? localize('voltPr.checksFailing', "{0} of {1} failing", checks.failed, counted)
				: checks.state === 'pending' ? localize('voltPr.checksRunning', "{0} of {1} running", checks.pending, counted)
					: checks.passed === 1 ? localize('voltPr.checkPassing', "1 check passing") : localize('voltPr.checksPassing', "{0} checks passing", checks.passed);
		if (checks.state === 'none') {
			button.disabled = true;
			return;
		}
		this.onClick(button, () => {
			this.folded.delete('checks');
			this.tab = 'summary';
			this.render();
			this.body.querySelector('.volt-pr-fold-section.checks')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
		});
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
				description: link.snapshot ? `${link.snapshot.headRefName} → ${link.snapshot.baseRefName}` : undefined,
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

	/**
	 * T3 Code's one primary control: Merged / Closed badges, Resolve Conflicts, Ready for Review, the
	 * armed auto-merge badge, Auto-merge (method) while checks run, or Merge with the method.
	 */
	private renderPrimary(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		if (pr.state === 'merged' || pr.state === 'closed') {
			const badge = append(parent, $(`span.volt-pr-state-badge.state-${pr.state}`));
			badge.appendChild(renderIcon(prStateIcon(pr.state)));
			append(badge, $('span')).textContent = pr.state === 'merged' ? localize('voltPr.state.merged', "Merged") : localize('voltPr.state.closed', "Closed");
			return;
		}
		const action = primaryAction(pr);
		if (action === 'ready') {
			this.button(parent, localize('voltPr.ready', "Ready for Review"), () => this.run(localize('voltPr.readyBusy', "Marking ready…"), () => this.pullRequests.api.setDraft({ repo: pr.repo, number: pr.number, draft: false })), 'primary', Codicon.eye);
			return;
		}
		if (action === 'resolveConflicts') {
			const resolve = this.button(parent, localize('voltPr.resolveConflicts', "Resolve Conflicts"), () => this.toAgent(buildResolveConflictsPrompt(pr)), 'danger', Codicon.warning);
			setAgentTooltip(resolve, localize('voltPr.resolveTip', "Ask the chat's agent to merge {0} in and resolve the conflicts", pr.baseRefName));
			return;
		}
		if (action === 'autoMergeArmed') {
			const armed = this.button(parent, localize('voltPr.autoArmed', "Auto-merge On"), () => this.run(localize('voltPr.autoOffBusy', "Turning off auto-merge…"), () => this.pullRequests.api.cancelAutoMerge({ repo: pr.repo, number: pr.number })), 'armed', Codicon.clock);
			setAgentTooltip(armed, localize('voltPr.autoArmedTip', "It merges once checks pass and reviews allow. Click to turn auto-merge off."));
			return;
		}
		const method = this.mergeMethod(pr);
		const split = append(parent, $('.volt-pr-split'));
		const auto = action === 'autoMerge';
		const main = this.button(split, auto ? localize('voltPr.autoMergeMethod', "Auto-merge ({0})", MERGE_METHOD_NAMES[method]) : MERGE_LABELS[method], async e => {
			const quick = !!(e as MouseEvent | undefined)?.shiftKey;
			await this.merge(pr, method, auto, quick);
		}, 'primary', Codicon.gitMerge);
		main.disabled = !pr.viewerCanMerge || !!this.busy;
		setAgentTooltip(main, auto
			? localize('voltPr.autoTip', "Merge with {0} once checks pass and reviews allow", MERGE_METHOD_NAMES[method])
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
		if (pr.mergeOptions.autoMergeAllowed && !pr.autoMerge && primaryAction(pr) !== 'autoMerge') {
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

	/** T3 Code's ⋯ menu: the chat, the agent, the branch, the link, and close or reopen. */
	private showMoreMenu(anchor: HTMLElement, pr: IVoltPullRequestDetail): void {
		type Pick = () => unknown;
		const sessionId = this.sessionId;
		const link = this.link;
		const open = isOpenState(pr.state);
		const chat: IVoltMenuItem<Pick>[] = [];
		if (sessionId) {
			chat.push(link
				? { id: 'unlink', label: localize('voltPr.unlink', "Unlink from This Chat"), icon: Codicon.close, data: () => this.pullRequests.unlink(sessionId, pr.key) }
				: { id: 'link', label: localize('voltPr.link', "Link to This Chat"), icon: Codicon.link, data: () => this.run(localize('voltPr.linkBusy', "Linking…"), () => this.pullRequests.link(sessionId, { repo: pr.repo, number: pr.number }, 'manual'), false) });
		}
		chat.push({ id: 'refresh', label: localize('voltPr.refresh', "Refresh"), icon: Codicon.refresh, data: () => this.load(true) });
		const agent: IVoltMenuItem<Pick>[] = [
			{ id: 'ask', label: localize('voltPr.ask', "Ask a Question"), subtitle: localize('voltPr.askSubtitle', "Adds the pull request to the chat's composer."), icon: Codicon.commentDiscussion, data: () => this.toAgent(buildAskPrompt(pr)) },
			{ id: 'explain', label: localize('voltPr.explain', "Explain This PR"), subtitle: localize('voltPr.explainSubtitle', "A walk through the diff and what to read closely."), icon: Codicon.sparkle, data: () => this.toAgent(buildExplainPrompt(pr)) },
		];
		if (pr.checks.failed && open) {
			agent.push({ id: 'fixChecks', label: localize('voltPr.fixChecks', "Fix Failing Checks"), icon: Codicon.sparkle, data: () => this.toAgent(buildFixChecksPrompt(pr, pr.checkRuns.filter(check => check.state === 'failure'))) });
		}
		const unresolved = pr.threads.filter(thread => !thread.resolved);
		if (unresolved.length && open) {
			agent.push({ id: 'fixFindings', label: localize('voltPr.fixFindings', "Fix Review Findings ({0})", unresolved.length), icon: Codicon.sparkle, data: () => this.toAgent(unresolved.map(thread => buildFixThreadPrompt(pr, { path: thread.path, line: thread.line, diffHunk: thread.comments[0]?.diffHunk, comments: thread.comments })).join('\n\n---\n\n')) });
		}
		const branch: IVoltMenuItem<Pick>[] = [];
		if (open) {
			if (pr.state === 'draft') {
				branch.push({ id: 'ready', label: localize('voltPr.ready', "Ready for Review"), icon: Codicon.eye, data: () => this.run(localize('voltPr.readyBusy', "Marking ready…"), () => this.pullRequests.api.setDraft({ repo: pr.repo, number: pr.number, draft: false })) });
			} else {
				branch.push({ id: 'draft', label: localize('voltPr.toDraft', "Convert to Draft"), icon: Codicon.gitPullRequestDraft, data: () => this.run(localize('voltPr.draftBusy', "Converting…"), () => this.pullRequests.api.setDraft({ repo: pr.repo, number: pr.number, draft: true })) });
			}
			if (primaryAction(pr) !== 'autoMerge' && primaryAction(pr) !== 'resolveConflicts') {
				branch.push({ id: 'mergeNow', label: localize('voltPr.mergeNow', "Merge Now"), icon: Codicon.gitMerge, disabled: !pr.viewerCanMerge || pr.state === 'draft', data: () => this.merge(pr, this.mergeMethod(pr), false, false) });
			}
			if (pr.autoMerge) {
				branch.push({ id: 'autoOff', label: localize('voltPr.disableAuto', "Disable Auto-merge"), icon: Codicon.clock, data: () => this.run(localize('voltPr.autoOffBusy', "Turning off auto-merge…"), () => this.pullRequests.api.cancelAutoMerge({ repo: pr.repo, number: pr.number })) });
			} else if (pr.mergeOptions.autoMergeAllowed) {
				branch.push({ id: 'autoOn', label: localize('voltPr.enableAutoItem', "Enable Auto-merge"), icon: Codicon.clock, data: () => this.merge(pr, this.mergeMethod(pr), true, false) });
			}
			branch.push(
				{ id: 'updateMerge', label: localize('voltPr.updateMerge', "Update Branch"), icon: Codicon.gitMerge, disabled: pr.mergeState !== 'behind' && pr.mergeState !== 'unknown', data: () => this.updateBranch(pr, false) },
				{ id: 'updateRebase', label: localize('voltPr.updateRebase', "Update with Rebase"), icon: Codicon.sync, disabled: pr.mergeState !== 'behind' && pr.mergeState !== 'unknown', data: () => this.updateBranch(pr, true) },
			);
			if (pr.checks.failed) {
				branch.push({ id: 'rerun', label: localize('voltPr.rerun', "Re-run Failed Checks"), icon: Codicon.debugRerun, data: () => this.rerun(pr) });
			}
		}
		const general: IVoltMenuItem<Pick>[] = [
			{ id: 'openHost', label: localize('voltPr.openOnHost', "Open on GitHub"), icon: Codicon.linkExternal, data: () => this.openerService.open(pr.url) },
			{ id: 'copyLink', label: localize('voltPr.copyLink', "Copy Link"), icon: Codicon.copy, data: () => this.copy(pr.url, localize('voltPr.copiedLink', "Copied the link")) },
			{ id: 'copyNumber', label: localize('voltPr.copyNumber', "Copy PR Number"), icon: Codicon.symbolNumeric, data: () => this.copy(`#${pr.number}`, localize('voltPr.copiedNumber', "Copied #{0}", pr.number)) },
		];
		const state: IVoltMenuItem<Pick>[] = open
			? [{ id: 'close', label: localize('voltPr.close', "Close Pull Request"), icon: Codicon.gitPullRequestClosed, data: () => this.setState(pr, 'closed', false) }]
			: pr.state === 'closed' ? [{ id: 'reopen', label: localize('voltPr.reopen', "Reopen Pull Request"), icon: Codicon.issueReopened, data: () => this.setState(pr, 'open', false) }] : [];
		showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			align: 'right',
			ariaLabel: localize('voltPr.more', "More Pull Request Actions"),
			width: 280,
			sections: [
				{ id: 'chat', items: chat },
				{ id: 'agent', title: localize('voltPr.withAgent', "With the agent"), items: agent },
				{ id: 'branch', items: branch },
				{ id: 'general', items: general },
				{ id: 'state', items: state },
			].filter(section => section.items.length),
			onPick: item => void item.data(),
		});
	}

	//#endregion

	//#region Summary

	private renderSummary(pr: IVoltPullRequestDetail): void {
		const body = append(this.body, $('.volt-pr-summary'));
		const meta = append(body, $('.volt-pr-meta-rows'));
		this.renderReviewers(meta, pr);
		this.renderLabels(meta, pr);
		this.renderMergeNotice(body, pr);

		const description = this.foldSection(body, 'description', localize('voltPr.description', "Description"));
		if (description) {
			const text = append(description, $('.volt-pr-markdown'));
			if (pr.body.trim()) {
				this.markdown(text, pr.body);
			} else {
				text.classList.add('muted');
				text.textContent = localize('voltPr.noDescription', "No description.");
			}
		}

		const checksTitle = pr.checkRuns.length ? localize('voltPr.checksCount', "Checks ({0})", pr.checkRuns.length) : localize('voltPr.checksTitle', "Checks");
		const checks = this.foldSection(body, 'checks', checksTitle, header => {
			const failing = pr.checkRuns.filter(check => check.state === 'failure');
			if (failing.length && isOpenState(pr.state)) {
				this.button(header, localize('voltPr.rerunShort', "Re-run Failed"), () => this.rerun(pr), 'ghost', Codicon.debugRerun);
			}
		});
		if (checks) {
			this.renderChecks(checks, pr);
		}

		const items = this.commentItems(pr);
		const comments = this.foldSection(body, 'comments', localize('voltPr.commentsCount', "Comments ({0})", items.length), header => {
			this.orderToggle(header, this.commentOrder, order => {
				this.commentOrder = order;
				this.render();
			});
		});
		if (comments) {
			if (!items.length) {
				append(comments, $('.muted.volt-pr-empty')).textContent = localize('voltPr.noComments', "No comments yet.");
			}
			const ordered = this.commentOrder === 'newest' ? [...items].reverse() : items;
			for (const item of ordered) {
				switch (item.kind) {
					case 'comment': this.renderComment(comments, item.comment, item.comment.author.bot); break;
					case 'review': this.renderReview(comments, item.review); break;
					case 'thread': this.renderThread(comments, pr, item.thread); break;
				}
			}
		}
	}

	/** Conflicts and a base that moved on need someone to act: a line above the description says so. */
	private renderMergeNotice(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		if (!isOpenState(pr.state)) {
			return;
		}
		if (pr.mergeable === 'conflicting') {
			const notice = append(parent, $('.volt-pr-notice.danger'));
			notice.appendChild(renderIcon(Codicon.warning));
			append(notice, $('span')).textContent = localize('voltPr.conflictsNotice', "This branch has conflicts with {0} that must be resolved before it can merge.", pr.baseRefName);
		} else if (pr.mergeState === 'blocked' && pr.reviewDecision === 'reviewRequired') {
			const notice = append(parent, $('.volt-pr-notice'));
			notice.appendChild(renderIcon(Codicon.gitPullRequestReviewer));
			append(notice, $('span')).textContent = pr.reviewRequests.length
				? localize('voltPr.waitingOnNotice', "Waiting on a review from {0}.", pr.reviewRequests.join(', '))
				: localize('voltPr.needsApprovalNotice', "At least one approving review is required to merge.");
		} else if (pr.autoMerge) {
			const notice = append(parent, $('.volt-pr-notice.armed'));
			notice.appendChild(renderIcon(Codicon.clock));
			append(notice, $('span')).textContent = localize('voltPr.autoOnNotice', "Auto-merge is on: it merges once checks pass and reviews allow.");
		}
	}

	/** A collapsible section with a sticky header; returns its body, or undefined while folded. */
	private foldSection(parent: HTMLElement, id: string, title: string, extra?: (header: HTMLElement) => void): HTMLElement | undefined {
		const section = append(parent, $(`.volt-pr-fold-section.${id}`));
		const folded = this.folded.has(id);
		section.classList.toggle('folded', folded);
		const header = append(section, $('.volt-pr-fold-header'));
		const toggle = append(header, $('button.volt-pr-fold-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!folded));
		append(toggle, $('span')).textContent = title;
		toggle.appendChild(renderIcon(folded ? Codicon.chevronRight : Codicon.chevronDown));
		this.onClick(toggle, () => {
			if (this.folded.has(id)) {
				this.folded.delete(id);
			} else {
				this.folded.add(id);
			}
			this.render();
		});
		append(header, $('.volt-pr-spacer'));
		if (!folded) {
			extra?.(header);
		}
		return folded ? undefined : append(section, $('.volt-pr-fold-body'));
	}

	private orderToggle(parent: HTMLElement, order: Order, set: (order: Order) => void): void {
		const button = append(parent, $('button.volt-pr-order')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.arrowSwap));
		append(button, $('span')).textContent = order === 'newest' ? localize('voltPr.newestFirst', "Newest first") : localize('voltPr.oldestFirst', "Oldest first");
		this.onClick(button, () => set(order === 'newest' ? 'oldest' : 'newest'));
	}

	private renderChecks(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		if (!pr.checkRuns.length) {
			append(parent, $('.muted.volt-pr-empty')).textContent = localize('voltPr.noChecksRun', "No checks ran on the latest commit.");
			return;
		}
		const order: Record<IVoltPrCheck['state'], number> = { failure: 0, cancelled: 1, pending: 2, success: 3, neutral: 4, skipped: 5 };
		const list = append(parent, $('.volt-pr-checks'));
		for (const check of [...pr.checkRuns].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))) {
			const row = append(list, $('.volt-pr-check-row'));
			iconSpan(row, check.state === 'pending' ? ThemeIcon.modify(Codicon.loading, 'spin') : checkIcon(check.state), `check-${check.state}`);
			const name = append(row, $('span.volt-pr-check-name'));
			name.textContent = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
			if (check.summary) {
				name.title = check.summary;
			}
			if (check.required) {
				append(row, $('span.volt-pr-tag')).textContent = localize('voltPr.required', "required");
			}
			append(row, $('.volt-pr-spacer'));
			const duration = checkDuration(check);
			if (duration) {
				append(row, $('span.muted.volt-pr-check-time')).textContent = duration;
			}
			append(row, $(`span.volt-pr-check-state.check-${check.state}`)).textContent = checkStateLabel(check.state);
			if (check.state === 'failure' && isOpenState(pr.state)) {
				const fix = this.button(row, localize('voltPr.fix', "Fix"), () => this.toAgent(buildFixChecksPrompt(pr, [check])), 'ghost', Codicon.wrench);
				setAgentTooltip(fix, localize('voltPr.fixTip', "Ask the chat's agent to fix {0}", check.name));
			}
			if (check.url) {
				const details = this.iconButton(row, Codicon.linkExternal, localize('voltPr.details', "Details"), () => this.openerService.open(check.url!));
				details.classList.add('subtle');
			}
		}
	}

	private renderReviewers(parent: HTMLElement, pr: IVoltPullRequestDetail): void {
		const row = append(parent, $('.volt-pr-meta-row'));
		const label = append(row, $('.volt-pr-meta-label'));
		label.appendChild(renderIcon(Codicon.person));
		append(label, $('span')).textContent = localize('voltPr.reviewers', "Reviewers");
		const list = append(row, $('.volt-pr-meta-list'));
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
			this.iconButton(list, Codicon.personAdd, localize('voltPr.requestReview', "Request Review"), button => {
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
		const row = append(parent, $('.volt-pr-meta-row'));
		const label = append(row, $('.volt-pr-meta-label'));
		label.appendChild(renderIcon(Codicon.tag));
		append(label, $('span')).textContent = localize('voltPr.labels', "Labels");
		const list = append(row, $('.volt-pr-meta-list'));
		for (const item of pr.labels) {
			this.labelChip(list, item.name, item.color);
		}
		if (!pr.labels.length) {
			append(list, $('span.muted')).textContent = localize('voltPr.noLabels', "None");
		}
		if (pr.viewerCanUpdate && pr.repoLabels.length) {
			this.iconButton(list, Codicon.tag, localize('voltPr.editLabels', "Edit Labels"), button => {
				const current = new Set(pr.labels.map(item => item.name));
				showVoltMenu<string>(this.contextViewService, {
					anchor: button,
					ariaLabel: localize('voltPr.editLabels', "Edit Labels"),
					width: 260,
					search: { placeholder: localize('voltPr.filterLabels', "Filter labels") },
					sections: [{ id: 'labels', items: pr.repoLabels.map(repoLabel => ({ id: repoLabel.name, label: repoLabel.name, checked: current.has(repoLabel.name), icon: () => colorDot(repoLabel.color), data: repoLabel.name })) }],
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

	/** Conversation comments, reviews with something to say, and review threads, oldest first. */
	private commentItems(pr: IVoltPullRequestDetail) {
		type Item = { at: number; kind: 'comment'; comment: IVoltPrComment } | { at: number; kind: 'review'; review: IVoltPrReview } | { at: number; kind: 'thread'; thread: IVoltPrReviewThread };
		const items: Item[] = [
			...pr.conversation.map(comment => ({ at: comment.createdAt, kind: 'comment' as const, comment })),
			...pr.reviewList.filter(review => review.body.trim() || review.state === 'approved' || review.state === 'changesRequested').map(review => ({ at: review.at, kind: 'review' as const, review })),
			...pr.threads.map(thread => ({ at: thread.comments[0]?.createdAt ?? 0, kind: 'thread' as const, thread })),
		];
		return items.sort((a, b) => a.at - b.at);
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
		append(head, $('span')).textContent = reviewVerb(review.state);
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
		setAgentTooltip(file, localize('voltPr.showInCode', "Show in the code"));
		this.onClick(file, () => this.revealInCode(thread.path));
		if (thread.outdated) {
			append(head, $('span.volt-pr-tag')).textContent = localize('voltPr.outdated', "outdated");
		}
		if (thread.resolved) {
			append(head, $('span.volt-pr-tag')).textContent = localize('voltPr.resolved', "resolved");
		}
		append(head, $('.volt-pr-spacer'));
		if (isOpenState(pr.state) && !thread.resolved) {
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

	//#endregion

	//#region Timeline

	/** Commits, reviews, comments and state changes on one rail, like T3 Code's Timeline. */
	private renderTimeline(pr: IVoltPullRequestDetail): void {
		type Event =
			| { at: number; kind: 'commit'; commit: IVoltPullRequestDetail['commits'][number] }
			| { at: number; kind: 'opened' }
			| { at: number; kind: 'merged' | 'closed' }
			| { at: number; kind: 'comment'; comment: IVoltPrComment }
			| { at: number; kind: 'review'; review: IVoltPrReview }
			| { at: number; kind: 'thread'; thread: IVoltPrReviewThread };
		const events: Event[] = [
			{ at: pr.createdAt, kind: 'opened' },
			...pr.commits.map(commit => ({ at: commit.at, kind: 'commit' as const, commit })),
			...pr.conversation.map(comment => ({ at: comment.createdAt, kind: 'comment' as const, comment })),
			...pr.reviewList.filter(review => review.state !== 'pending').map(review => ({ at: review.at, kind: 'review' as const, review })),
			...pr.threads.map(thread => ({ at: thread.comments[0]?.createdAt ?? 0, kind: 'thread' as const, thread })),
		];
		if (pr.state === 'merged' && pr.mergedAt) {
			events.push({ at: pr.mergedAt, kind: 'merged' });
		} else if (pr.state === 'closed' && pr.closedAt) {
			events.push({ at: pr.closedAt, kind: 'closed' });
		}
		events.sort((a, b) => a.at - b.at);
		if (this.timelineOrder === 'newest') {
			events.reverse();
		}
		const rail = append(this.body, $('.volt-pr-rail'));
		for (const event of events) {
			const item = append(rail, $(`.volt-pr-rail-item.kind-${event.kind}`));
			const marker = append(item, $('.volt-pr-rail-marker'));
			const content = append(item, $('.volt-pr-rail-content'));
			const line = append(content, $('.volt-pr-rail-line'));
			const sub = append(content, $('.volt-pr-rail-sub'));
			switch (event.kind) {
				case 'commit': {
					avatar(marker, event.commit.author, /^[\w-]+$/.test(event.commit.author) ? `https://${pr.repo.host}/${event.commit.author}.png` : undefined, 24);
					append(line, $('strong')).textContent = event.commit.headline;
					append(line, $('.volt-pr-spacer'));
					const sha = append(sub, $('button.volt-pr-sha')) as HTMLButtonElement;
					sha.type = 'button';
					sha.textContent = event.commit.oid.slice(0, 7);
					setAgentTooltip(sha, localize('voltPr.copySha', "Copy commit id"));
					this.onClick(sha, () => this.copy(event.commit.oid, localize('voltPr.copiedSha', "Copied {0}", event.commit.oid.slice(0, 7))));
					append(sub, $('span')).textContent = `${event.commit.author} · ${ago(event.at)}`;
					if (event.commit.checks !== 'none') {
						iconSpan(line, checkIcon(event.commit.checks), `check-${event.commit.checks}`);
					}
					const show = this.iconButton(line, Codicon.diff, localize('voltPr.showCommit', "Show this commit's changes"), () => {
						this.codeCommit = event.commit.oid;
						this.showTab('code');
					});
					show.classList.add('subtle');
					break;
				}
				case 'opened':
					iconSpan(marker, Codicon.gitPullRequest, 'state-open');
					append(line, $('strong')).textContent = pr.author.login;
					append(line, $('span')).textContent = localize('voltPr.openedEvent', "Pull request opened");
					append(sub, $('span')).textContent = ago(event.at);
					break;
				case 'merged':
				case 'closed':
					iconSpan(marker, event.kind === 'merged' ? Codicon.gitMerge : Codicon.gitPullRequestClosed, `state-${event.kind}`);
					append(line, $('strong')).textContent = event.kind === 'merged' ? localize('voltPr.mergedEvent', "Merged into {0}", pr.baseRefName) : localize('voltPr.closedEvent', "Closed");
					append(sub, $('span')).textContent = ago(event.at);
					break;
				case 'comment':
					avatar(marker, event.comment.author.login, event.comment.author.avatarUrl, 24);
					append(line, $('strong')).textContent = event.comment.author.login;
					append(line, $('span')).textContent = localize('voltPr.commentedEvent', "commented");
					append(sub, $('span')).textContent = ago(event.at);
					this.markdown(append(content, $('.volt-pr-markdown.volt-pr-rail-body')), event.comment.body);
					break;
				case 'review':
					iconSpan(marker, event.review.state === 'approved' ? Codicon.passFilled : event.review.state === 'changesRequested' ? Codicon.diffModified : Codicon.eye, `review-${event.review.state}`);
					append(line, $('strong')).textContent = event.review.author.login;
					append(line, $('span')).textContent = reviewVerb(event.review.state);
					append(sub, $('span')).textContent = ago(event.at);
					if (event.review.body.trim()) {
						this.markdown(append(content, $('.volt-pr-markdown.volt-pr-rail-body')), event.review.body);
					}
					break;
				case 'thread': {
					const first = event.thread.comments[0];
					iconSpan(marker, event.thread.resolved ? Codicon.passFilled : Codicon.commentUnresolved, event.thread.resolved ? 'thread-resolved' : 'thread-open');
					append(line, $('strong')).textContent = first?.author.login ?? '';
					append(line, $('span')).textContent = localize('voltPr.reviewedLine', "commented on");
					const where = append(line, $('button.volt-pr-thread-file')) as HTMLButtonElement;
					where.type = 'button';
					where.textContent = `${event.thread.path}${event.thread.line ? `:${event.thread.line}` : ''}`;
					this.onClick(where, () => this.revealInCode(event.thread.path));
					append(sub, $('span')).textContent = event.thread.comments.length > 1
						? localize('voltPr.threadReplies', "{0} · {1} replies", ago(event.at), event.thread.comments.length - 1)
						: ago(event.at);
					if (first) {
						this.markdown(append(content, $('.volt-pr-markdown.volt-pr-rail-body')), first.body);
					}
					break;
				}
			}
		}
	}

	//#endregion

	//#region Code

	private patchKey(pr: IVoltPullRequestDetail): string {
		return `${pr.key}@${pr.headRefOid}@${this.codeCommit ?? 'all'}`;
	}

	private loadPatches(pr: IVoltPullRequestDetail): void {
		const key = this.patchKey(pr);
		if (this.patches.has(key) || this.patchLoads.has(key)) {
			return;
		}
		this.patchLoads.add(key);
		const commit = this.codeCommit;
		this.pullRequests.api.filePatches({ repo: pr.repo, number: pr.number, ...(commit ? { commit } : {}) }).then(
			files => this.patches.set(key, { files }),
			error => this.patches.set(key, { error }),
		).finally(() => {
			this.patchLoads.delete(key);
			if (this.tab === 'code' && this.detail && this.patchKey(this.detail) === key) {
				this.renderSoon();
			}
		});
	}

	/** T3 Code's Code tab: a commit picker, viewed progress, and each file's diff inline. */
	private renderCode(pr: IVoltPullRequestDetail): void {
		const commit = this.codeCommit ? pr.commits.find(candidate => candidate.oid === this.codeCommit) : undefined;
		if (this.codeCommit && !commit) {
			this.codeCommit = undefined;
		}
		const scopeAll = !this.codeCommit;
		this.loadPatches(pr);
		const load = this.patches.get(this.patchKey(pr));
		const files = load?.files ?? (scopeAll ? pr.files.map(file => ({ path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), change: file.change, additions: file.additions, deletions: file.deletions })) : []);
		const viewedState = new Map(pr.files.map(file => [file.path, this.pendingViewed.get(file.path) ?? file.viewed === 'viewed']));

		const toolbar = append(this.body, $('.volt-pr-code-toolbar'));
		const picker = append(toolbar, $('button.volt-pr-commit-picker')) as HTMLButtonElement;
		picker.type = 'button';
		append(picker, $('span')).textContent = commit ? `${commit.oid.slice(0, 7)} ${commit.headline}` : localize('voltPr.allCommits', "All commits");
		picker.appendChild(renderIcon(Codicon.chevronDown));
		this.onClick(picker, () => {
			showVoltMenu<string | undefined>(this.contextViewService, {
				anchor: picker,
				ariaLabel: localize('voltPr.commitScope', "Commits"),
				width: 360,
				sections: [
					{ id: 'all', items: [{ id: 'all', label: localize('voltPr.allCommits', "All commits"), checked: scopeAll, data: undefined }] },
					{ id: 'commits', title: localize('voltPr.commitsTitle', "Commits"), items: [...pr.commits].reverse().map(candidate => ({ id: candidate.oid, label: candidate.headline, description: candidate.oid.slice(0, 7), checked: candidate.oid === this.codeCommit, data: candidate.oid })) },
				],
				onPick: item => {
					this.codeCommit = item.data;
					this.expanded.clear();
					this.collapsedByUser.clear();
					this.render();
					this.body.scrollTop = 0;
				},
			});
		});
		const counts = append(toolbar, $('span.volt-pr-code-counts'));
		const viewedCount = files.filter(file => viewedState.get(file.path)).length;
		const fileCount = files.length === 1 ? localize('voltPr.oneFile', "1 file") : localize('voltPr.files', "{0} files", files.length);
		counts.textContent = scopeAll
			? localize('voltPr.filesViewedCount', "{0} · {1} / {2} viewed", fileCount, viewedCount, files.length)
			: localize('voltPr.filesInCommitCount', "{0} in this commit", fileCount);
		append(toolbar, $('.volt-pr-spacer'));
		const allOpen = files.length > 0 && files.every(file => this.isExpanded(file, viewedState));
		this.iconButton(toolbar, allOpen ? Codicon.foldUp : Codicon.foldDown, allOpen ? localize('voltPr.collapseAll', "Collapse All") : localize('voltPr.expandAll', "Expand All"), () => {
			for (const file of files) {
				if (allOpen) {
					this.expanded.delete(file.path);
					this.collapsedByUser.add(file.path);
				} else {
					this.expanded.add(file.path);
					this.collapsedByUser.delete(file.path);
				}
			}
			this.render();
		});
		const folder = this.cloneFolder();
		const openDiff = this.iconButton(toolbar, Codicon.diffMultiple, folder ? localize('voltPr.openDiff', "Open in Diff Editor") : localize('voltPr.openDiffHost', "Open the Diff on GitHub"), () => this.openDiff(pr));
		openDiff.classList.add('subtle');

		if (load?.error) {
			const notice = append(this.body, $('.volt-pr-notice.danger'));
			notice.appendChild(renderIcon(Codicon.warning));
			append(notice, $('span')).textContent = localize('voltPr.patchFailed', "Could not read the changes: {0}", voltPrErrorMessage(load.error));
			this.linkButton(notice, localize('voltPr.retry', "Retry"), () => {
				this.patches.delete(this.patchKey(pr));
				this.render();
			});
		}

		const list = append(this.body, $('.volt-pr-code-files'));
		if (!files.length && !load) {
			append(list, $('.muted.volt-pr-empty')).textContent = localize('voltPr.loadingChanges', "Reading the changes…");
			return;
		}
		for (const file of files) {
			this.renderCodeFile(list, pr, file, scopeAll ? viewedState.get(file.path) ?? false : undefined, !!load?.files);
		}
	}

	/** Small files open on their own; viewed files and large ones stay folded until asked. */
	private isExpanded(file: { readonly path: string; readonly additions: number; readonly deletions: number }, viewed: Map<string, boolean>): boolean {
		if (this.expanded.has(file.path)) {
			return true;
		}
		if (this.collapsedByUser.has(file.path) || viewed.get(file.path)) {
			return false;
		}
		return file.additions + file.deletions <= LARGE_FILE_LINES;
	}

	private renderCodeFile(parent: HTMLElement, pr: IVoltPullRequestDetail, file: Pick<IVoltPrFilePatch, 'path' | 'previousPath' | 'change' | 'additions' | 'deletions' | 'patch'>, viewed: boolean | undefined, loaded: boolean): void {
		const viewedMap = new Map(viewed === undefined ? [] : [[file.path, viewed]]);
		const open = this.isExpanded(file, viewedMap);
		const card = append(parent, $('.volt-pr-code-file'));
		card.dataset.path = file.path;
		card.classList.toggle('open', open);
		card.classList.toggle('viewed', !!viewed);
		const head = append(card, $('.volt-pr-code-file-head'));
		const toggle = append(head, $('button.volt-pr-code-file-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(open));
		toggle.appendChild(renderIcon(open ? Codicon.chevronDown : Codicon.chevronRight));
		iconSpan(toggle, changeIcon(file.change), `change-${file.change}`);
		const name = append(toggle, $('span.volt-pr-code-path'));
		const dir = dirname(file.path);
		if (dir && dir !== '.') {
			append(name, $('span.dir')).textContent = `${dir}/`;
		}
		append(name, $('span.base')).textContent = basename(file.path);
		if (file.previousPath) {
			append(toggle, $('span.muted.volt-pr-renamed')).textContent = localize('voltPr.renamedFrom', "from {0}", file.previousPath);
		}
		this.onClick(toggle, () => {
			if (open) {
				this.expanded.delete(file.path);
				this.collapsedByUser.add(file.path);
			} else {
				this.expanded.add(file.path);
				this.collapsedByUser.delete(file.path);
			}
			this.render();
		});
		append(head, $('.volt-pr-spacer'));
		const stats = append(head, $('span.volt-pr-stats'));
		append(stats, $('span.add')).textContent = `+${file.additions}`;
		append(stats, $('span.del')).textContent = `−${file.deletions}`;
		const folder = this.cloneFolder();
		if (folder) {
			const diff = this.iconButton(head, Codicon.goToFile, localize('voltPr.openFileDiff', "Open in Diff Editor"), () => this.openDiff(pr, file.path));
			diff.classList.add('subtle');
		}
		if (viewed !== undefined) {
			const box = append(head, $('button.volt-pr-viewed')) as HTMLButtonElement;
			box.type = 'button';
			box.setAttribute('role', 'checkbox');
			box.setAttribute('aria-checked', String(viewed));
			box.classList.toggle('checked', viewed);
			box.appendChild(renderIcon(viewed ? Codicon.check : Codicon.blank));
			append(box, $('span')).textContent = localize('voltPr.viewed', "Viewed");
			this.onClick(box, () => this.toggleViewed(file.path, !viewed));
		}
		if (!open) {
			return;
		}
		const diff = append(card, $('.volt-pr-diff'));
		if (!loaded) {
			append(diff, $('.muted.volt-pr-diff-note')).textContent = localize('voltPr.loadingDiff', "Reading the diff…");
			return;
		}
		if (!file.patch) {
			append(diff, $('.muted.volt-pr-diff-note')).textContent = file.change === 'renamed' && !file.additions && !file.deletions
				? localize('voltPr.renamedOnly', "Renamed without changes.")
				: localize('voltPr.noPatch', "No diff to show here (a binary file, or too large for GitHub to include).");
			return;
		}
		this.renderDiff(diff, pr, file.path, file.patch);
	}

	private renderDiff(parent: HTMLElement, pr: IVoltPullRequestDetail, path: string, patch: string): void {
		const hunks = parseUnifiedPatch(patch);
		const table = append(parent, $('.volt-pr-diff-lines'));
		const rows: { readonly row: HTMLElement; readonly code: HTMLElement; readonly line: IPrDiffLine }[] = [];
		const all: IPrDiffLine[] = [];
		for (const hunk of hunks) {
			if (hunk.skippedBefore > 0) {
				append(table, $('.volt-pr-diff-gap')).textContent = hunk.skippedBefore === 1 ? localize('voltPr.oneUnmodified', "1 unmodified line") : localize('voltPr.unmodified', "{0} unmodified lines", hunk.skippedBefore);
			}
			for (const line of hunk.lines) {
				const index = all.length;
				all.push(line);
				const row = append(table, $(`.volt-pr-diff-line.${line.kind}`));
				const ask = append(row, $('button.volt-pr-diff-ask')) as HTMLButtonElement;
				ask.type = 'button';
				ask.appendChild(renderIcon(Codicon.add));
				ask.setAttribute('aria-label', localize('voltPr.askLine', "Ask the agent about this line"));
				ask.title = localize('voltPr.askTip', "Ask the chat's agent about this line (Shift-click to take the lines since the last one)");
				append(row, $('span.volt-pr-diff-no.old')).textContent = line.oldLine !== undefined ? String(line.oldLine) : '';
				append(row, $('span.volt-pr-diff-no.new')).textContent = line.newLine !== undefined ? String(line.newLine) : '';
				append(row, $('span.volt-pr-diff-sign')).textContent = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
				const code = append(row, $('span.volt-pr-diff-code'));
				code.textContent = line.text || ' ';
				rows.push({ row, code, line });
				this.onClick(ask, e => this.askAboutLines(pr, path, all, index, e.shiftKey));
			}
		}
		append(table, $('.volt-pr-diff-gap.end')).textContent = localize('voltPr.moreContext', "More unchanged context may be available");
		// Colour after the lines show: tokenizing waits on the language's grammar.
		const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(path));
		if (!languageId || languageId === 'plaintext' || rows.length > 3000) {
			return;
		}
		void highlight(this.languageService, languageId, rows.map(entry => entry.line.text).join('\n')).then(lines => {
			if (!parent.isConnected) {
				return;
			}
			rows.forEach((entry, index) => {
				const tokens = lines[index];
				if (tokens?.length) {
					entry.code.replaceChildren(...tokens.map(node => node.cloneNode(true)));
				}
			});
		}, () => undefined);
	}

	/** Puts the line (or the lines since the last one picked in this file) in the chat's composer. */
	private askAboutLines(pr: IVoltPullRequestDetail, path: string, lines: readonly IPrDiffLine[], index: number, extend: boolean): void {
		let start = index;
		let end = index;
		if (extend && this.lineAnchor?.path === path) {
			start = Math.min(this.lineAnchor.index, index);
			end = Math.max(this.lineAnchor.index, index);
		}
		this.lineAnchor = { path, index };
		const picked = lines.slice(start, end + 1);
		// New-file numbers when the lines exist there; removed lines only have old-file numbers.
		const range = lineRange(picked) ?? { start: 1, end: 1, side: 'new' as const };
		const code = picked.map(line => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`).join('\n');
		const request = range.side === 'old'
			? localize('voltPr.askRemoved', "About the lines removed from {0} (old lines {1}-{2}):", path, range.start, range.end)
			: '';
		void this.toAgent(buildReviewLinePrompt(pr, path, range.start, range.end, code, request));
	}

	/** From a review thread: the Code tab with that file open. */
	private revealInCode(path: string): void {
		this.codeCommit = undefined;
		this.expanded.add(path);
		this.collapsedByUser.delete(path);
		this.tab = 'code';
		this.render();
		getWindow(this.element).requestAnimationFrame(() => {
			for (const node of this.body.querySelectorAll<HTMLElement>('.volt-pr-code-file')) {
				if (node.dataset.path === path) {
					node.scrollIntoView({ block: 'start' });
					break;
				}
			}
		});
	}

	private toggleViewed(path: string, viewed: boolean): void {
		this.pendingViewed.set(path, viewed);
		if (viewed) {
			// Marking a file viewed folds it, like GitHub; unmarking opens it again.
			this.expanded.delete(path);
		} else {
			this.collapsedByUser.delete(path);
		}
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

	//#endregion

	//#region Composer

	/**
	 * T3 Code's floating composer: a round button at the bottom right opens a card with Comment |
	 * Review. A review can comment, approve or request changes (not on your own pull request).
	 */
	private renderCompose(pr: IVoltPullRequestDetail | undefined): void {
		// Kept while typing: a background re-read must not take the field away.
		if (this.isTyping() && this.composeOpen && this.composeHost.contains(this.element.ownerDocument.activeElement)) {
			return;
		}
		this.composeStore.clear();
		clearNode(this.composeHost);
		if (!pr || pr.state === 'merged') {
			return;
		}
		if (!this.composeOpen) {
			const fab = append(this.composeHost, $('button.volt-pr-compose-fab')) as HTMLButtonElement;
			fab.type = 'button';
			fab.appendChild(renderIcon(Codicon.comment));
			const label = localize('voltPr.composeOpen', "Comment or Review");
			fab.setAttribute('aria-label', label);
			setAgentTooltip(fab, label);
			this.composeStore.add(addDisposableListener(fab, 'click', e => {
				EventHelper.stop(e, true);
				this.composeOpen = true;
				this.renderCompose(pr);
				this.composeHost.querySelector<HTMLTextAreaElement>('textarea')?.focus();
			}));
			return;
		}
		const card = append(this.composeHost, $('.volt-pr-compose-card'));
		const top = append(card, $('.volt-pr-compose-top'));
		const ownPr = pr.author.login.toLowerCase() === pr.viewer.toLowerCase();
		createVoltSegmented<'comment' | 'review'>(top, [
			{ id: 'comment', label: localize('voltPr.composeComment', "Comment") },
			{ id: 'review', label: localize('voltPr.composeReview', "Review") },
		], this.composeMode, mode => {
			this.composeMode = mode;
			this.renderCompose(pr);
			this.composeHost.querySelector<HTMLTextAreaElement>('textarea')?.focus();
		}, this.composeStore, 'small');
		append(top, $('.volt-pr-spacer'));
		const close = append(top, $('button.volt-pr-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		close.appendChild(renderIcon(Codicon.close));
		close.setAttribute('aria-label', localize('voltPr.composeClose', "Close"));
		const area = append(card, $('textarea.volt-pr-textarea')) as HTMLTextAreaElement;
		area.rows = 4;
		area.placeholder = this.composeMode === 'comment'
			? localize('voltPr.commentPlaceholder', "Leave a comment (⌘Enter to post)")
			: localize('voltPr.reviewPlaceholder', "Write a review summary (optional for approvals)");
		area.value = this.drafts.get('conversation') ?? '';
		if (this.composeMode === 'review') {
			const verdicts = append(card, $('.volt-pr-compose-verdicts'));
			const options: { id: 'comment' | 'approve' | 'requestChanges'; label: string; icon: ThemeIcon }[] = [
				{ id: 'comment', label: localize('voltPr.verdictComment', "Comment"), icon: Codicon.comment },
				{ id: 'approve', label: localize('voltPr.verdictApprove', "Approve"), icon: Codicon.check },
				{ id: 'requestChanges', label: localize('voltPr.verdictChanges', "Request Changes"), icon: Codicon.diffModified },
			];
			if (ownPr && this.reviewEvent !== 'comment') {
				this.reviewEvent = 'comment';
			}
			for (const option of options) {
				const radio = append(verdicts, $('button.volt-pr-verdict')) as HTMLButtonElement;
				radio.type = 'button';
				radio.setAttribute('role', 'radio');
				radio.setAttribute('aria-checked', String(this.reviewEvent === option.id));
				radio.classList.toggle('checked', this.reviewEvent === option.id);
				radio.disabled = ownPr && option.id !== 'comment';
				if (radio.disabled) {
					setAgentTooltip(radio, localize('voltPr.ownPr', "You can't approve or request changes on your own pull request."));
				}
				radio.appendChild(renderIcon(option.icon));
				append(radio, $('span')).textContent = option.label;
				this.composeStore.add(addDisposableListener(radio, 'click', e => {
					EventHelper.stop(e, true);
					this.reviewEvent = option.id;
					this.renderCompose(pr);
				}));
			}
		}
		const footer = append(card, $('.volt-pr-compose-footer'));
		append(footer, $('.volt-pr-spacer'));
		const submit = append(footer, $('button.volt-pr-button.primary')) as HTMLButtonElement;
		submit.type = 'button';
		append(submit, $('span')).textContent = this.composeMode === 'comment' ? localize('voltPr.postComment', "Comment") : localize('voltPr.submitReview', "Submit Review");
		const sync = () => {
			this.drafts.set('conversation', area.value);
			const text = area.value.trim();
			submit.disabled = !!this.busy || (this.composeMode === 'comment' || this.reviewEvent !== 'approve' ? !text : false);
		};
		sync();
		const doSubmit = async () => {
			const text = area.value.trim();
			if (submit.disabled) {
				return;
			}
			area.blur();
			if (this.composeMode === 'comment') {
				await this.run(localize('voltPr.commentBusy', "Posting comment…"), async () => {
					await this.pullRequests.api.comment({ repo: pr.repo, number: pr.number, body: text });
					this.drafts.delete('conversation');
					this.composeOpen = false;
				});
			} else {
				await this.run(localize('voltPr.reviewBusy', "Submitting review…"), async () => {
					await this.pullRequests.api.review({ repo: pr.repo, number: pr.number, event: this.reviewEvent, body: text });
					this.drafts.delete('conversation');
					this.composeOpen = false;
				});
			}
		};
		this.composeStore.add(addDisposableListener(area, 'input', sync));
		this.composeStore.add(addDisposableListener(submit, 'click', e => {
			EventHelper.stop(e, true);
			void doSubmit();
		}));
		this.composeStore.add(addDisposableListener(close, 'click', e => {
			EventHelper.stop(e, true);
			this.composeOpen = false;
			this.renderCompose(pr);
		}));
		this.composeStore.add(addDisposableListener(card, 'keydown', e => {
			if (e.key === 'Escape') {
				EventHelper.stop(e, true);
				this.composeOpen = false;
				this.renderCompose(pr);
				this.element.focus();
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				EventHelper.stop(e, true);
				void doSubmit();
			}
		}));
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
					? localize('voltPr.confirmAuto', "Enable auto-merge for #{0}?", pr.number)
					: localize('voltPr.confirmMerge', "Merge pull request #{0} into {1}?", pr.number, pr.baseRefName),
				detail: [
					auto ? localize('voltPr.confirmAutoDetail', "It merges with {0} once checks pass and reviews allow.", MERGE_METHOD_NAMES[method]) : localize('voltPr.confirmMethod', "Method: {0}", MERGE_LABELS[method]),
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
				message: localize('voltPr.confirmClose', "Close pull request #{0}?", pr.number),
				detail: localize('voltPr.confirmCloseDetail', "It is closed without merging. You can reopen it later."),
				primaryButton: localize('voltPr.closeButton', "Close"),
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
		const status = append(this.element, $('.volt-pr-busy'));
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

	private button(parent: HTMLElement, label: string, handler: (e?: MouseEvent) => unknown, kind: 'primary' | 'secondary' | 'ghost' | 'danger' | 'armed' = 'secondary', icon?: ThemeIcon): HTMLButtonElement {
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

function changeIcon(change: VoltPrFileChange): ThemeIcon {
	switch (change) {
		case 'added': return Codicon.diffAdded;
		case 'deleted': return Codicon.diffRemoved;
		case 'renamed':
		case 'copied': return Codicon.diffRenamed;
		default: return Codicon.diffModified;
	}
}

function checkStateLabel(state: IVoltPrCheck['state']): string {
	switch (state) {
		case 'success': return localize('voltPr.checkPassed', "Passed");
		case 'failure': return localize('voltPr.checkFailed', "Failed");
		case 'pending': return localize('voltPr.checkRunning', "Running");
		case 'cancelled': return localize('voltPr.checkCancelled', "Cancelled");
		case 'skipped': return localize('voltPr.checkSkipped', "Skipped");
		case 'neutral': return localize('voltPr.checkNeutral', "Neutral");
	}
}

function reviewVerb(state: IVoltPrReview['state']): string {
	switch (state) {
		case 'approved': return localize('voltPr.r.approvedThese', "approved these changes");
		case 'changesRequested': return localize('voltPr.r.requestedChanges', "requested changes");
		case 'dismissed': return localize('voltPr.r.dismissed', "review was dismissed");
		default: return localize('voltPr.r.reviewed', "reviewed");
	}
}

/** "Ask a question": the pull request in the composer, the question left to the user. */
function buildAskPrompt(pr: IVoltPullRequestDetail): string {
	return [
		`About pull request #${pr.number} (${pr.url}), ${pr.headRefName} -> ${pr.baseRefName}: `,
	].join('\n');
}

function colorDot(color: string): HTMLElement {
	const dot = $('span.volt-pr-color-dot');
	dot.style.background = /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : '#888';
	return dot;
}
