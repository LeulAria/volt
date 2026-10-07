/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentPullRequests.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { openAgentChanges } from '../review/agentChangesEditor.js';
import { IAgentSessionChangesService } from '../review/agentSessionChangesService.js';
import { isAgentChangesShown, isAgentScmShown, onDidChangeAgentToolEditors, SHOW_AGENT_SCM_COMMAND_ID } from '../workspace/agentSurfaceHost.js';
import { AgentFilesSidebar } from '../workspace/agentFilesSidebar.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createCompactIcon } from '../context/agentContextUsageView.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';
import { AgentPullRequestHoverCard } from '../pullRequests/agentPullRequestHoverCard.js';
import { CREATE_PULL_REQUEST_COMMAND_ID, OPEN_PULL_REQUEST_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { currentLink, IAgentPrLink, isOpenState, isTrunkBranch } from '../../common/agentPullRequests.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

/** A reader this close to the last line is at the end, so the arrow stays hidden. */
export const SCROLL_END_SLACK_PX = 96;

/** Empty chats and a thread already at the end do not offer the scroll-down arrow. */
export function shouldOfferScrollToBottom(hasMessages: boolean, distanceFromBottom: number): boolean {
	return hasMessages && distanceFromBottom > SCROLL_END_SLACK_PX;
}

export interface IAgentComposerChipStatus {
	label: string;
	working: boolean;
}

export interface IAgentComposerChipsOptions {
	onStatusClick?: () => void;
	onChangesClick?: () => void;
	onTerminalClick?: () => void;
	/** The Compact context chip, offered when the context window is nearly full. */
	onCompactClick?: () => void;
	/** The round arrow at the end of the row, shown while the thread is scrolled up. */
	onScrollToBottom?: () => void;
	dock?: boolean;
}

interface IGitShortStat {
	files: number;
	insertions: number;
	deletions: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Cursor's in-progress loader for pills (DotGridLoader, sine_3x3): nine dots on a 3x3 grid, same
 * geometry (r 1.125 on a 4 pitch in a 10.5 box). The wave is CSS keyframes per dot (browserEditor.css).
 */
export function createThinkingDots(): HTMLElement {
	const root = $('span.volt-browser-dock-dots');
	root.setAttribute('aria-hidden', 'true');
	const svg = root.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 10.5 10.5');
	svg.setAttribute('focusable', 'false');
	for (let index = 0; index < 9; index++) {
		const dot = root.ownerDocument.createElementNS(SVG_NS, 'circle');
		dot.setAttribute('cx', String(1.25 + (index % 3) * 4));
		dot.setAttribute('cy', String(1.25 + Math.floor(index / 3) * 4));
		dot.setAttribute('r', '1.125');
		dot.setAttribute('class', `volt-browser-dock-dot d${index + 1}`);
		svg.appendChild(dot);
	}
	root.appendChild(svg);
	return root;
}

export class AgentComposerChips extends Disposable {

	readonly element: HTMLElement;

	private readonly statusChip: HTMLButtonElement;
	private readonly chipLabelEl: HTMLElement;
	private readonly changesChip: HTMLButtonElement;
	private readonly changesLabelEl: HTMLElement;
	private readonly changesAddEl: HTMLElement;
	private readonly changesDelEl: HTMLElement;
	private readonly terminalsChip: HTMLButtonElement;
	private readonly terminalsLabelEl: HTMLElement;
	private readonly commitChip: HTMLButtonElement;
	/** The chat's pull request (state, number, checks), or Create PR on a feature branch without one. */
	private readonly prChip: HTMLButtonElement;
	private readonly prIcon: HTMLElement;
	private readonly prLabel: HTMLElement;
	private readonly prChecks: HTMLElement;
	private readonly prExit = this._register(new MutableDisposable());
	private readonly pullRequests: IAgentPullRequestService | undefined;
	/** State, checks and size of the chat's pull request, with Merge when it is ready, over the chip. */
	private readonly prHoverCard: AgentPullRequestHoverCard | undefined;
	private pr: { readonly kind: 'link'; readonly link: IAgentPrLink } | { readonly kind: 'create' } | undefined;
	private prGen = 0;
	private readonly compactChip: HTMLButtonElement;
	private offerCompact = false;
	private readonly scrollChip: HTMLButtonElement;
	private scrolledUp = false;
	private readonly scrollExit = this._register(new MutableDisposable());
	private readonly changesExit = this._register(new MutableDisposable());
	private readonly commitExit = this._register(new MutableDisposable());
	private readonly repoListeners = this._register(new DisposableStore());
	private readonly terminalListeners = this._register(new DisposableStore());
	private hostOpen = true;
	private sessionId: string | undefined;
	private status: IAgentComposerChipStatus = { label: '', working: false };
	private insertions = 0;
	private deletions = 0;
	private hasChanges = false;
	private runningTerminals = 0;
	private refreshHandle: number | undefined;
	private refreshGen = 0;

	constructor(
		private readonly options: IAgentComposerChipsOptions,
		@ICommandService private readonly commandService: ICommandService,
		@ISCMService private readonly scmService: ISCMService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super();
		this.element = $(options.dock ? '.volt-agent-composer-chips.volt-browser-dock-chips' : '.volt-agent-composer-chips');

		this.statusChip = append(this.element, $('button.volt-agent-composer-chip.status.volt-browser-dock-chip')) as HTMLButtonElement;
		this.statusChip.type = 'button';
		append(this.statusChip, createThinkingDots());
		this.chipLabelEl = append(this.statusChip, $('span.volt-agent-composer-chip-label.volt-browser-dock-chip-label'));

		this.compactChip = append(this.element, $('button.volt-agent-composer-chip.compact.volt-browser-dock-chip.hidden')) as HTMLButtonElement;
		this.compactChip.type = 'button';
		this.compactChip.appendChild(createCompactIcon(this.compactChip.ownerDocument));
		append(this.compactChip, $('span.volt-agent-composer-chip-label')).textContent = localize('voltAgent.compactContext', "Compact context");
		setAgentTooltip(this.compactChip, localize('voltAgent.compactContextNearlyFull', "The context window is nearly full. Compact it to keep going."));

		this.changesChip = append(this.element, $('button.volt-agent-composer-chip.changes.volt-browser-dock-chip')) as HTMLButtonElement;
		this.changesChip.type = 'button';
		this.changesLabelEl = append(this.changesChip, $('span.volt-agent-composer-chip-label'));
		this.changesLabelEl.textContent = localize('voltAgent.changes', "Changes");
		this.changesAddEl = append(this.changesChip, $('span.volt-agent-composer-chip-add'));
		this.changesDelEl = append(this.changesChip, $('span.volt-agent-composer-chip-del'));

		this.terminalsChip = append(this.element, $('button.volt-agent-composer-chip.terminals.volt-browser-dock-chip')) as HTMLButtonElement;
		this.terminalsChip.type = 'button';
		append(this.terminalsChip, $('span.volt-agent-composer-chip-dot'));
		this.terminalsLabelEl = append(this.terminalsChip, $('span.volt-agent-composer-chip-label'));

		this.commitChip = append(this.element, $('button.volt-agent-composer-chip.commit.volt-browser-dock-chip')) as HTMLButtonElement;
		this.commitChip.type = 'button';
		append(this.commitChip, $('span.volt-agent-composer-chip-label')).textContent = localize('voltAgent.commitAndPush', "Commit & Push");

		this.prChip = append(this.element, $('button.volt-agent-composer-chip.pr.volt-browser-dock-chip.hidden')) as HTMLButtonElement;
		this.prChip.type = 'button';
		this.prIcon = append(this.prChip, $('span.volt-agent-composer-chip-pr-icon'));
		this.prLabel = append(this.prChip, $('span.volt-agent-composer-chip-label'));
		this.prChecks = append(this.prChip, $('span.volt-agent-composer-chip-pr-checks'));
		this.pullRequests = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentPullRequestService));
		this.prHoverCard = this.pullRequests
			? this._register(this.instantiationService.createInstance(AgentPullRequestHoverCard, this.prChip, () => this.pr?.kind === 'link' ? this.pr.link : undefined))
			: undefined;

		this.scrollChip = append(this.element, $('button.volt-agent-composer-chip.scroll-bottom.hidden')) as HTMLButtonElement;
		this.scrollChip.type = 'button';
		this.scrollChip.setAttribute('aria-label', localize('voltAgent.scrollToBottom', "Scroll to bottom"));
		setAgentTooltip(this.scrollChip, localize('voltAgent.scrollToBottom', "Scroll to bottom"));
		this.scrollChip.appendChild(renderIcon(Codicon.arrowDown));
		this._register(addDisposableListener(this.scrollChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onScrollToBottom?.();
		}));

		this._register(addDisposableListener(this.statusChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onStatusClick?.();
		}));
		this._register(addDisposableListener(this.changesChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.options.onChangesClick) {
				this.options.onChangesClick();
				return;
			}
			if (this.sessionId) {
				void openAgentChanges(this.instantiationService, this.editorService, this.editorGroupsService, this.sessionId);
				return;
			}
			void this.commandService.executeCommand('workbench.view.scm');
		}));
		this._register(addDisposableListener(this.terminalsChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.options.onTerminalClick) {
				this.options.onTerminalClick();
				return;
			}
			const running = this.terminalService.instances.find(instance => instance.hasChildProcesses);
			(running ?? this.terminalService.instances[0])?.focus(true);
			void this.commandService.executeCommand(TerminalCommandId.Focus);
		}));
		this._register(addDisposableListener(this.compactChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onCompactClick?.();
		}));
		this._register(addDisposableListener(this.commitChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			// Source Control in the tools commits and pushes; the chips step aside while it shows.
			void this.commandService.executeCommand(SHOW_AGENT_SCM_COMMAND_ID);
		}));

		this._register(addDisposableListener(this.prChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			const pr = this.pr;
			if (pr?.kind === 'link') {
				void this.commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, { host: pr.link.repo.host, owner: pr.link.repo.owner, name: pr.link.repo.name, number: pr.link.number }, this.sessionId);
			} else if (pr?.kind === 'create') {
				void this.commandService.executeCommand(CREATE_PULL_REQUEST_COMMAND_ID, this.sessionId);
			}
		}));
		if (this.pullRequests) {
			this._register(this.pullRequests.onDidChange(sessionIds => {
				if (this.sessionId && sessionIds.includes(this.sessionId)) {
					void this.refreshPullRequest();
				}
			}));
		}

		this._register(this.scmService.onDidAddRepository(() => {
			this.bindRepositories();
			this.scheduleRefresh();
		}));
		this._register(this.scmService.onDidRemoveRepository(() => {
			this.bindRepositories();
			this.scheduleRefresh();
		}));
		this._register(this.terminalService.onDidChangeInstances(() => {
			this.bindTerminals();
			this.scheduleRefresh();
		}));
		this._register(this.terminalService.onAnyInstancePrimaryStatusChange(() => this.scheduleRefresh()));
		// The Changes chip steps aside while the right panel shows this chat's Changes.
		this._register(onDidChangeAgentToolEditors(() => this.render()));
		this._register(AgentFilesSidebar.onDidChangeShownView(() => this.render()));
		this._register(addDisposableListener(layoutService.mainContainer, AGENT_TOOLS_VISIBILITY_EVENT, () => this.render()));
		this._register(this.changesService.onDidChange(sessionId => {
			if (!this.sessionId || !sessionId || sessionId === this.sessionId) {
				this.scheduleRefresh();
			}
		}));
		this.bindRepositories();
		this.bindTerminals();
		this.scheduleRefresh();
		this.render();
	}

	setSessionId(sessionId: string | undefined): void {
		if (this.sessionId === sessionId) {
			return;
		}
		this.sessionId = sessionId;
		// Now, not after the debounce: the last chat's chips would show on this one, then vanish.
		if (sessionId) {
			void this.refresh();
		} else {
			this.scheduleRefresh();
		}
	}

	setHostOpen(open: boolean): void {
		if (this.hostOpen === open) {
			return;
		}
		this.hostOpen = open;
		this.render();
	}

	setStatus(status: IAgentComposerChipStatus): void {
		if (this.status.label === status.label && this.status.working === status.working) {
			return;
		}
		this.status = status;
		this.render();
	}

	/** Shows or hides the Compact context chip. */
	setCompactOffered(offer: boolean): void {
		const next = offer && !!this.options.onCompactClick;
		if (this.offerCompact === next) {
			return;
		}
		this.offerCompact = next;
		this.render();
	}

	hasVisibleChips(): boolean {
		return this.hostOpen && (this.hasStatus() || this.hasChanges || this.runningTerminals > 0 || this.offerCompact || !!this.pr);
	}

	private hasStatus(): boolean {
		return !!this.status.label;
	}

	private bindRepositories(): void {
		this.repoListeners.clear();
		for (const repository of this.scmService.repositories) {
			this.bindRepository(repository);
		}
	}

	private bindRepository(repository: ISCMRepository): void {
		this.repoListeners.add(repository.provider.onDidChangeResources(() => this.scheduleRefresh()));
		this.repoListeners.add(repository.provider.onDidChangeResourceGroups(() => this.scheduleRefresh()));
		for (const group of repository.provider.groups) {
			this.repoListeners.add(group.onDidChangeResources(() => this.scheduleRefresh()));
		}
	}

	private bindTerminals(): void {
		this.terminalListeners.clear();
		for (const instance of this.terminalService.instances) {
			this.terminalListeners.add(instance.onDidChangeHasChildProcesses(() => this.scheduleRefresh()));
		}
	}

	private scmHasChanges(): boolean {
		for (const repository of this.scmService.repositories) {
			for (const group of repository.provider.groups) {
				if (group.resources.length) {
					return true;
				}
			}
		}
		return false;
	}

	private scheduleRefresh(): void {
		const win = getWindow(this.element);
		if (this.refreshHandle !== undefined) {
			win.clearTimeout(this.refreshHandle);
		}
		this.refreshHandle = win.setTimeout(() => {
			this.refreshHandle = undefined;
			void this.refresh();
		}, 250);
	}

	private async refresh(): Promise<void> {
		const gen = ++this.refreshGen;
		const runningTerminals = this.terminalService.instances.filter(instance => instance.hasChildProcesses).length;
		void this.refreshPullRequest();
		if (this.sessionId) {
			const stats = this.changesService.getStats(this.sessionId, 'uncommitted');
			if (gen !== this.refreshGen) {
				return;
			}
			this.hasChanges = stats.files > 0 || stats.additions > 0 || stats.deletions > 0;
			this.insertions = stats.additions;
			this.deletions = stats.deletions;
			this.runningTerminals = runningTerminals;
			this.render();
			return;
		}
		const hasChanges = this.scmHasChanges();
		let insertions = 0;
		let deletions = 0;
		if (hasChanges) {
			try {
				const stat = await this.commandService.executeCommand<IGitShortStat>('git.api.getWorkingTreeShortStat');
				if (gen !== this.refreshGen) {
					return;
				}
				if (stat) {
					insertions = stat.insertions;
					deletions = stat.deletions;
				}
			} catch {
				insertions = this.insertions;
				deletions = this.deletions;
			}
		}
		if (gen !== this.refreshGen) {
			return;
		}
		this.hasChanges = hasChanges || insertions > 0 || deletions > 0;
		this.insertions = insertions;
		this.deletions = deletions;
		this.runningTerminals = runningTerminals;
		this.render();
	}

	/**
	 * The chat's current pull request, or Create PR when its folder is on a feature branch of a
	 * GitHub repository with nothing linked. Repository facts are cached by the service.
	 */
	private async refreshPullRequest(): Promise<void> {
		const gen = ++this.prGen;
		const sessionId = this.sessionId;
		const service = this.pullRequests;
		let next: typeof this.pr;
		if (sessionId && service) {
			const link = currentLink(service.links(sessionId));
			if (link) {
				next = { kind: 'link', link };
			} else {
				const repo = await service.repoFor(sessionId);
				if (gen !== this.prGen) {
					return;
				}
				if (repo?.provider === 'github' && repo.branch && !isTrunkBranch(repo.branch)) {
					next = { kind: 'create' };
				}
			}
		}
		if (gen !== this.prGen) {
			return;
		}
		this.pr = next;
		this.render();
	}

	private renderPullRequestChip(): boolean {
		const pr = this.pr;
		if (pr?.kind !== 'link') {
			this.prHoverCard?.hide();
		}
		if (!pr) {
			return false;
		}
		this.prIcon.replaceChildren();
		this.prChecks.className = 'volt-agent-composer-chip-pr-checks';
		this.prChip.classList.remove('state-open', 'state-draft', 'state-merged', 'state-closed', 'create');
		if (pr.kind === 'create') {
			this.prChip.classList.add('create');
			this.prIcon.appendChild(renderIcon(Codicon.gitPullRequestCreate));
			this.prLabel.textContent = localize('voltAgent.createPr', "Create PR");
			setAgentTooltip(this.prChip, localize('voltAgent.createPrTip', "Open a pull request from this branch"));
			this.prChecks.classList.add('hidden');
			return true;
		}
		const snapshot = pr.link.snapshot;
		const state = snapshot?.state ?? 'open';
		this.prChip.classList.add(`state-${state}`);
		this.prIcon.appendChild(renderIcon(prChipIcon(state)));
		this.prLabel.textContent = `PR #${pr.link.number}`;
		const checks = snapshot && isOpenState(state) ? snapshot.checks.state : 'none';
		this.prChecks.classList.toggle('hidden', checks === 'none');
		if (checks !== 'none') {
			this.prChecks.classList.add(`check-${checks}`);
		}
		// With a snapshot the hover card tells the rest (state, checks, size, Merge).
		setAgentTooltip(this.prChip, snapshot && this.prHoverCard ? undefined : localize('voltAgent.prNumber', "Pull request #{0}", pr.link.number));
		this.prHoverCard?.update();
		return true;
	}

	private render(): void {
		const showPr = this.renderPullRequestChip();
		const showStatus = this.hasStatus();
		const showChanges = this.hasChanges && !(this.sessionId && isAgentChangesShown(this.sessionId));
		const showTerminals = this.runningTerminals > 0;
		const showCommit = this.hasChanges && !(this.sessionId && isAgentScmShown(this.sessionId));
		const showScroll = this.scrolledUp && !!this.options.onScrollToBottom;
		this.updateScrollChip(showScroll);
		// Before the row's visibility: a chip starting its exit keeps the row up until it is gone.
		this.toggleChip(this.changesChip, showChanges, this.changesExit);
		this.toggleChip(this.commitChip, showCommit, this.commitExit);
		this.toggleChip(this.prChip, showPr, this.prExit);
		const visible = this.hostOpen && (showStatus || this.offerCompact || showChanges || showTerminals || showCommit || showPr || showScroll || !!this.scrollExit.value || !!this.changesExit.value || !!this.commitExit.value || !!this.prExit.value);
		this.element.classList.toggle('is-visible', visible);

		this.statusChip.classList.toggle('hidden', !showStatus);
		this.statusChip.classList.toggle('working', this.status.working);
		this.chipLabelEl.textContent = this.status.label;

		this.compactChip.classList.toggle('hidden', !this.offerCompact);

		this.changesAddEl.textContent = this.insertions > 0 ? `+${this.insertions}` : '';
		this.changesDelEl.textContent = this.deletions > 0 ? `-${this.deletions}` : '';
		this.changesAddEl.classList.toggle('hidden', this.insertions <= 0);
		this.changesDelEl.classList.toggle('hidden', this.deletions <= 0);

		this.terminalsChip.classList.toggle('hidden', !showTerminals);
		this.terminalsLabelEl.textContent = this.runningTerminals === 1
			? localize('voltAgent.oneTerminal', "1 Terminal")
			: localize('voltAgent.manyTerminals', "{0} Terminals", this.runningTerminals);
	}

	/** No status, changes, or terminal chip sits beside the arrow. */
	private scrollChipIsAlone(): boolean {
		return !this.hasStatus() && !this.hasChanges && this.runningTerminals <= 0 && !this.offerCompact && !this.pr;
	}

	private updateScrollChip(show: boolean): void {
		const chip = this.scrollChip;
		chip.disabled = !show;
		if (show) {
			this.scrollExit.clear();
			if (chip.classList.contains('hidden') || chip.classList.contains('leaving')) {
				chip.classList.toggle('solo', this.scrollChipIsAlone());
			}
			chip.classList.remove('hidden', 'leaving');
			return;
		}
		const win = getWindow(chip);
		if (!this.hostOpen || win.matchMedia('(prefers-reduced-motion: reduce)').matches || chip.closest('.monaco-workbench.reduce-motion')) {
			this.scrollExit.clear();
			chip.classList.remove('leaving', 'solo');
			chip.classList.add('hidden');
			return;
		}
		if (chip.classList.contains('hidden') || this.scrollExit.value) {
			return;
		}
		chip.classList.toggle('solo', this.scrollChipIsAlone());
		chip.classList.add('leaving');
		this.scrollExit.value = disposableTimeout(() => {
			this.scrollExit.clear();
			chip.classList.remove('leaving');
			chip.classList.add('hidden');
			this.render();
		}, 180);
	}

	/** The thread is scrolled away from its latest message: offer the way back. */
	setScrolledUp(scrolledUp: boolean): void {
		if (this.scrolledUp === scrolledUp) {
			return;
		}
		this.scrolledUp = scrolledUp;
		this.render();
	}

	/**
	 * Shows or hides a chip with Changes / Commit & Push's motion: it grows in from nothing and
	 * shrinks back out, so its neighbors slide over instead of jumping.
	 */
	private toggleChip(chip: HTMLElement, show: boolean, exit: MutableDisposable<IDisposable>): void {
		if (show) {
			exit.clear();
			chip.classList.remove('hidden', 'leaving');
			return;
		}
		const win = getWindow(chip);
		if (!this.hostOpen || win.matchMedia('(prefers-reduced-motion: reduce)').matches || chip.closest('.monaco-workbench.reduce-motion')) {
			exit.clear();
			chip.classList.remove('leaving');
			chip.classList.add('hidden');
			return;
		}
		if (chip.classList.contains('hidden') || exit.value) {
			return;
		}
		// Collapse from the chip's own width, so it shrinks evenly instead of late.
		chip.style.setProperty('--volt-chip-width', `${chip.offsetWidth}px`);
		chip.classList.add('leaving');
		exit.value = disposableTimeout(() => {
			exit.clear();
			chip.classList.remove('leaving');
			chip.classList.add('hidden');
			this.render();
		}, 180);
	}

	override dispose(): void {
		const win = getWindow(this.element);
		if (this.refreshHandle !== undefined) {
			win.clearTimeout(this.refreshHandle);
			this.refreshHandle = undefined;
		}
		super.dispose();
	}
}

function prChipIcon(state: 'open' | 'draft' | 'merged' | 'closed'): ThemeIcon {
	switch (state) {
		case 'open': return Codicon.gitPullRequest;
		case 'draft': return Codicon.gitPullRequestDraft;
		case 'merged': return Codicon.gitMerge;
		case 'closed': return Codicon.gitPullRequestClosed;
	}
}
