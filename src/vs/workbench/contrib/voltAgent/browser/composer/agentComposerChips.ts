/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentPullRequests.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { createModeIcon } from '../chrome/agentModeIcons.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extUriIgnorePathCase } from '../../../../../base/common/resources.js';
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
import { isAgentChangesShown, isAgentScmShown, onDidChangeAgentToolEditors } from '../workspace/agentSurfaceHost.js';
import { AgentFilesSidebar } from '../workspace/agentFilesSidebar.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createCompactIcon } from '../context/agentContextUsageView.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';
import { AgentPullRequestHoverCard } from '../pullRequests/agentPullRequestHoverCard.js';
import { SHOW_PULL_REQUESTS_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { AgentGitActionsControl } from '../pullRequests/agentGitActionsControl.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { currentLink, IAgentPrLink, isOpenState } from '../../common/agentPullRequests.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IVoltBrowserComments } from '../preview/browserCommentStore.js';

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

/**
 * The "Compact first" chip: hidden, offered (the window is nearly full; a click arms it), armed (the
 * next send compacts first; a click disarms it), running (the dots stand in for its icon until the
 * agent is done), or done (a check and the token drop for a moment before it goes).
 */
export type AgentCompactChipState = 'hidden' | 'offered' | 'armed' | 'running' | 'done';

/** What the chip says besides its state: the live token count ("162K", "162K → 21K") and its hover. */
export interface IAgentCompactChipDetail {
	readonly count?: string;
	readonly tooltip?: string;
}

/** The chat's own agents that are live, for the agents chip ("3 multitasks running"). */
export interface IAgentComposerAgentsChip {
	/** "3 multitasks running", "2 subagents running", "3 multitasks · 2 subagents". */
	readonly label: string;
	readonly live: number;
	/** Agents blocked on an approval or an answer. */
	readonly waiting: number;
}

/** The chat's managed terminals as one chip of the row (agentTerminalChips.ts), owned by the chat. */
export interface IAgentComposerTerminalRuns {
	/** The chip; it shows and hides itself with the `hidden` class. */
	readonly element: HTMLElement;
	readonly visible: boolean;
	readonly onDidChange: Event<void>;
}

export interface IAgentComposerChipsOptions {
	onStatusClick?: () => void;
	/** The agents chip was clicked: list them (anchored to the chip). */
	onAgentsClick?: (anchor: HTMLElement) => void;
	onChangesClick?: () => void;
	onTerminalClick?: () => void;
	/** The Compact context chip, offered when the context window is nearly full. */
	onCompactClick?: () => void;
	/** The round arrow at the end of the row, shown while the thread is scrolled up. */
	onScrollToBottom?: () => void;
	/** The × on the "N to multitask" chip: Start Multitasking turns off and the messages stay queued. */
	onMultitaskPickCancel?: () => void;
	/** The chat's terminals ("2 terminals running" with its menu), after the agents chip. The dock has none. */
	terminalRuns?: IAgentComposerTerminalRuns;
	/** The chat's usage-limit park ("Claude limit · resets 5 PM" with Resume when Claude is back), first in the row. */
	limitRun?: IAgentComposerTerminalRuns;
	/** In a multitask agent's or subagent's chat: whose it is and how it runs ("Multitask · Running 50s", Stop), right after the limit. */
	agentRun?: IAgentComposerTerminalRuns;
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
	/** "| 20 Files", once the run is done: the count would flicker while the agent edits. */
	private readonly changesFilesEl: HTMLElement;
	private readonly terminalsChip: HTMLButtonElement;
	private readonly terminalsLabelEl: HTMLElement;
	/** The chat's live multitask agents and subagents, counted. */
	private readonly agentsChip: HTMLButtonElement;
	private readonly agentsLabelEl: HTMLElement;
	private readonly agentsWaitingEl: HTMLElement;
	private agents: IAgentComposerAgentsChip | undefined;
	/** Commit, Push & PR: T3 Code's git actions, the next step for the chat's branch. */
	private readonly gitControl: AgentGitActionsControl;
	private gitVisible = false;
	/** A new chat with no messages yet: Commit, Push & PR waits for the first prompt. */
	private newChat = false;
	/** The chat's pull request (state, number, checks), or Create PR on a feature branch without one. */
	private readonly prChip: HTMLButtonElement;
	private readonly prIcon: HTMLElement;
	private readonly prLabel: HTMLElement;
	private readonly prChecks: HTMLElement;
	private readonly prExit = this._register(new MutableDisposable());
	private readonly pullRequests: IAgentPullRequestService | undefined;
	/** State, checks and size of the chat's pull request, with Merge when it is ready, over the chip. */
	private readonly prHoverCard: AgentPullRequestHoverCard | undefined;
	private pr: { readonly kind: 'link'; readonly link: IAgentPrLink } | undefined;
	private prGen = 0;
	/** Comments left in the chat's browser tab, waiting to go with the next message. */
	private readonly commentsChip: HTMLButtonElement;
	private readonly commentsLabelEl: HTMLElement;
	private pendingComments = 0;
	private readonly compactChip: HTMLButtonElement;
	/** Start Multitasking is on: how many queued messages Send starts as agents (undefined when off). */
	private readonly multitaskChip: HTMLElement;
	private readonly multitaskLabelEl: HTMLElement;
	private multitaskPick: number | undefined;
	private readonly compactLabelEl: HTMLElement;
	private compactState: AgentCompactChipState = 'hidden';
	private compactDetail: IAgentCompactChipDetail = {};
	private readonly compactCountEl: HTMLElement;
	private readonly scrollChip: HTMLButtonElement;
	private scrolledUp = false;
	/** The "..." at the end of a row too narrow for its chips: it opens the ones that did not fit. */
	private readonly moreChip: HTMLButtonElement;
	private readonly overflowPanel: HTMLElement;
	private overflowOpen = false;
	private layoutHandle: number | undefined;
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
	private changedFiles = 0;
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
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IVoltBrowserComments private readonly browserComments: IVoltBrowserComments,
	) {
		super();
		this.element = $(options.dock ? '.volt-agent-composer-chips.volt-browser-dock-chips' : '.volt-agent-composer-chips');

		// A chat stopped at its usage limit says so before anything else.
		const limitRun = options.limitRun;
		if (limitRun) {
			this.element.appendChild(limitRun.element);
			this._register(limitRun.onDidChange(() => this.render()));
		}
		const agentRun = options.agentRun;
		if (agentRun) {
			this.element.appendChild(agentRun.element);
			this._register(agentRun.onDidChange(() => this.render()));
		}

		this.statusChip = append(this.element, $('button.volt-agent-composer-chip.status.volt-browser-dock-chip')) as HTMLButtonElement;
		this.statusChip.type = 'button';
		append(this.statusChip, createThinkingDots());
		this.chipLabelEl = append(this.statusChip, $('span.volt-agent-composer-chip-label.volt-browser-dock-chip-label'));

		// Right after the run's status: what runs in parallel with it.
		this.agentsChip = append(this.element, $('button.volt-agent-composer-chip.agents.volt-browser-dock-chip.hidden')) as HTMLButtonElement;
		this.agentsChip.type = 'button';
		this.agentsChip.setAttribute('aria-haspopup', 'menu');
		append(this.agentsChip, createThinkingDots());
		this.agentsLabelEl = append(this.agentsChip, $('span.volt-agent-composer-chip-label'));
		this.agentsWaitingEl = append(this.agentsChip, $('span.volt-agent-composer-chip-waiting'));

		// The chat's own terminals (dev servers, watchers) run beside it too.
		const terminalRuns = options.terminalRuns;
		if (terminalRuns) {
			this.element.appendChild(terminalRuns.element);
			this._register(terminalRuns.onDidChange(() => this.render()));
		}

		// The dock shows its tab's comments itself.
		this.commentsChip = append(this.element, $('button.volt-agent-composer-chip.comments.volt-browser-dock-chip.hidden')) as HTMLButtonElement;
		this.commentsChip.type = 'button';
		this.commentsChip.appendChild(renderIcon(Codicon.comment));
		this.commentsLabelEl = append(this.commentsChip, $('span.volt-agent-composer-chip-label'));
		setAgentTooltip(this.commentsChip, localize('voltAgent.commentsChip', "Browser comments that go with your next message"));
		if (!options.dock) {
			this._register(this.browserComments.onDidChange(() => this.syncComments()));
			this._register(addDisposableListener(this.commentsChip, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				if (this.sessionId) {
					this.browserComments.show({ sessionId: this.sessionId });
				}
			}));
		}

		this.multitaskChip = append(this.element, $('.volt-agent-composer-chip.multitask-pick.volt-browser-dock-chip.hidden'));
		this.multitaskChip.setAttribute('role', 'status');
		this.multitaskChip.appendChild(createModeIcon('multitask'));
		this.multitaskLabelEl = append(this.multitaskChip, $('span.volt-agent-composer-chip-label'));
		setAgentTooltip(this.multitaskLabelEl, localize('voltAgent.multitaskPickChip', "Press Send to start the ticked queued messages, each as its own agent in parallel"));
		const cancelPick = append(this.multitaskChip, $('button.volt-agent-composer-chip-close')) as HTMLButtonElement;
		cancelPick.type = 'button';
		cancelPick.appendChild(renderIcon(Codicon.close));
		setAgentTooltip(cancelPick, localize('voltAgent.multitaskPickCancel', "Keep them queued"));
		this._register(addDisposableListener(cancelPick, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onMultitaskPickCancel?.();
		}));

		this.compactChip = append(this.element, $('button.volt-agent-composer-chip.compact.volt-browser-dock-chip.hidden')) as HTMLButtonElement;
		this.compactChip.type = 'button';
		append(this.compactChip, createThinkingDots());
		this.compactChip.appendChild(createCompactIcon(this.compactChip.ownerDocument));
		append(this.compactChip, $('span.volt-agent-composer-chip-done')).appendChild(renderIcon(Codicon.check));
		this.compactLabelEl = append(this.compactChip, $('span.volt-agent-composer-chip-label'));
		this.compactLabelEl.textContent = localize('voltAgent.compactFirst', "Compact first");
		this.compactCountEl = append(this.compactChip, $('span.volt-agent-composer-chip-count'));
		this.renderCompactChip();

		this.changesChip = append(this.element, $('button.volt-agent-composer-chip.changes.volt-browser-dock-chip')) as HTMLButtonElement;
		this.changesChip.type = 'button';
		this.changesLabelEl = append(this.changesChip, $('span.volt-agent-composer-chip-label'));
		this.changesLabelEl.textContent = localize('voltAgent.changes', "Changes");
		this.changesAddEl = append(this.changesChip, $('span.volt-agent-composer-chip-add'));
		this.changesDelEl = append(this.changesChip, $('span.volt-agent-composer-chip-del'));
		this.changesFilesEl = append(this.changesChip, $('span.volt-agent-composer-chip-files'));

		this.terminalsChip = append(this.element, $('button.volt-agent-composer-chip.terminals.volt-browser-dock-chip')) as HTMLButtonElement;
		this.terminalsChip.type = 'button';
		append(this.terminalsChip, $('span.volt-agent-composer-chip-dot'));
		this.terminalsLabelEl = append(this.terminalsChip, $('span.volt-agent-composer-chip-label'));

		this.pullRequests = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentPullRequestService));
		this.gitControl = this._register(this.instantiationService.createInstance(AgentGitActionsControl, this.element, {
			look: 'chip',
			target: () => {
				const folder = this.gitFolder();
				return { ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(folder ? { folder } : {}) };
			},
			onDidChangeVisibility: visible => {
				this.gitVisible = visible;
				this.render();
			},
		}));

		this.prChip = append(this.element, $('button.volt-agent-composer-chip.pr.volt-browser-dock-chip.hidden')) as HTMLButtonElement;
		this.prChip.type = 'button';
		this.prIcon = append(this.prChip, $('span.volt-agent-composer-chip-pr-icon'));
		this.prLabel = append(this.prChip, $('span.volt-agent-composer-chip-label'));
		this.prChecks = append(this.prChip, $('span.volt-agent-composer-chip-pr-checks'));
		this.prHoverCard = this.pullRequests
			? this._register(this.instantiationService.createInstance(AgentPullRequestHoverCard, this.prChip, () => this.pr?.link))
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

		this.moreChip = append(this.element, $('button.volt-agent-composer-chip.more.hidden')) as HTMLButtonElement;
		this.moreChip.type = 'button';
		this.moreChip.setAttribute('aria-label', localize('voltAgent.moreChips', "More"));
		this.moreChip.setAttribute('aria-haspopup', 'true');
		this.moreChip.setAttribute('aria-expanded', 'false');
		setAgentTooltip(this.moreChip, localize('voltAgent.moreChips', "More"));
		this.moreChip.appendChild(renderIcon(Codicon.ellipsis));
		// `closed`, not `hidden`: the browser's dock hides `.hidden` outright, and the closed panel must stay laid out to be measured.
		this.overflowPanel = append(this.element, $('.volt-agent-composer-chips-overflow.closed'));
		this._register(addDisposableListener(this.moreChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.setOverflowOpen(!this.overflowOpen);
		}));
		const doc = this.element.ownerDocument;
		this._register(addDisposableListener(doc, 'mousedown', e => {
			const target = e.target as Node | null;
			if (this.overflowOpen && target && !this.moreChip.contains(target) && !this.overflowPanel.contains(target)) {
				this.setOverflowOpen(false);
			}
		}, true));
		this._register(addDisposableListener(doc, 'keydown', e => {
			if (this.overflowOpen && e.key === 'Escape') {
				this.setOverflowOpen(false);
				this.moreChip.focus();
			}
		}, true));
		// Chips grow in from nothing: measure again once they reach their width.
		this._register(addDisposableListener(this.element, 'animationend', () => this.scheduleLayout()));
		const resizeObserver = new (getWindow(this.element).ResizeObserver)(() => this.scheduleLayout());
		resizeObserver.observe(this.element);
		this._register({ dispose: () => resizeObserver.disconnect() });

		this._register(addDisposableListener(this.statusChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onStatusClick?.();
		}));
		this._register(addDisposableListener(this.agentsChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onAgentsClick?.(this.agentsChip);
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
			if (this.compactState === 'offered' || this.compactState === 'armed') {
				this.options.onCompactClick?.();
			}
		}));
		// The chat's pull request: the right sidebar's Pull Requests tab, where its row opens it.
		this._register(addDisposableListener(this.prChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.pr) {
				void this.commandService.executeCommand(SHOW_PULL_REQUESTS_COMMAND_ID, this.sessionId);
			}
		}));
		if (this.pullRequests) {
			this._register(this.pullRequests.onDidChange(sessionIds => {
				if (this.sessionId && sessionIds.includes(this.sessionId)) {
					void this.refreshPullRequest();
				}
			}));
			this._register(this.pullRequests.onDidChangeOrigin(folder => {
				if (folder === this.gitFolder()) {
					this.render();
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
		this.syncComments();
		// Now, not after the debounce: the last chat's chips would show on this one, then vanish.
		if (sessionId) {
			void this.refresh();
		} else {
			this.scheduleRefresh();
		}
	}

	/** Start Multitasking's live count: the chip reads "18 to multitask"; undefined hides it. */
	setMultitaskPick(count: number | undefined): void {
		if (this.multitaskPick === count) {
			return;
		}
		this.multitaskPick = count;
		this.render();
	}

	private syncComments(): void {
		const count = !this.options.dock && this.sessionId ? this.browserComments.pending({ sessionId: this.sessionId }).length : 0;
		if (count !== this.pendingComments) {
			this.pendingComments = count;
			this.render();
		}
	}

	/** A chat with no messages yet shows no chip row at all: the window's terminals, git and the rest belong to a chat underway. */
	setNewChat(newChat: boolean): void {
		if (this.newChat === newChat) {
			return;
		}
		this.newChat = newChat;
		this.render();
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

	/** The chat's live agents, or undefined to hide the chip. */
	setAgents(agents: IAgentComposerAgentsChip | undefined): void {
		const next = agents && agents.live > 0 ? agents : undefined;
		const current = this.agents;
		if (current?.label === next?.label && current?.waiting === next?.waiting && current?.live === next?.live) {
			return;
		}
		this.agents = next;
		this.render();
	}

	/** Shows the Compact first chip as an offer, armed, while the agent compacts, or just after; or hides it. */
	setCompactState(state: AgentCompactChipState, detail: IAgentCompactChipDetail = {}): void {
		const next = this.options.onCompactClick ? state : 'hidden';
		if (this.compactState === next && this.compactDetail.count === detail.count && this.compactDetail.tooltip === detail.tooltip) {
			return;
		}
		const changed = this.compactState !== next;
		this.compactState = next;
		this.compactDetail = detail;
		this.renderCompactChip();
		if (changed) {
			this.render();
		}
	}

	private renderCompactChip(): void {
		const state = this.compactState;
		this.compactChip.classList.toggle('working', state === 'running');
		this.compactChip.classList.toggle('done', state === 'done');
		this.compactChip.classList.toggle('armed', state === 'armed');
		this.compactChip.setAttribute('aria-disabled', String(state !== 'offered' && state !== 'armed'));
		if (state === 'offered' || state === 'armed') {
			this.compactChip.setAttribute('aria-pressed', String(state === 'armed'));
		} else {
			this.compactChip.removeAttribute('aria-pressed');
		}
		this.compactLabelEl.textContent = state === 'running'
			? localize('voltAgent.compaction.runningShort', "Compacting")
			: state === 'done'
				? localize('voltAgent.compaction.doneShort', "Compacted")
				: localize('voltAgent.compactFirst', "Compact first");
		this.compactCountEl.textContent = this.compactDetail.count ? `· ${this.compactDetail.count}` : '';
		setAgentTooltip(this.compactChip, this.compactDetail.tooltip ?? (state === 'running'
			? localize('voltAgent.compactingTooltip', "The agent is summarizing the conversation so far. The summary replaces it in the context window.")
			: state === 'done'
				? localize('voltAgent.compactedTooltip', "The conversation was summarized; the agent continues from the summary.")
				: localize('voltAgent.compactContextNearlyFull', "The context window is nearly full. Compact it to keep going.")));
	}

	hasVisibleChips(): boolean {
		return this.hostOpen && !this.newChat && (this.hasStatus() || !!this.options.agentRun?.visible || this.hasChanges || this.showsGit() || this.runningTerminals > 0 || this.hasTerminalRuns() || !!this.options.limitRun?.visible || this.compactState !== 'hidden' || !!this.pr || !!this.agents);
	}

	private showsGit(): boolean {
		return this.gitVisible && !this.newChat;
	}

	private hasStatus(): boolean {
		return !!this.status.label;
	}

	private hasTerminalRuns(): boolean {
		return !!this.options.terminalRuns?.visible;
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

	/** Changes in the window's folders' repositories, not every one Git opened (parents, nested checkouts). */
	private scmHasChanges(): boolean {
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		for (const repository of this.scmService.repositories) {
			const root = repository.provider.rootUri;
			if (!root || !folders.some(folder => extUriIgnorePathCase.isEqual(root, folder) || this.scmService.getRepository(folder) === repository)) {
				continue;
			}
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
		void this.gitControl.refresh();
		if (this.sessionId) {
			const stats = this.changesService.getStats(this.sessionId, 'uncommitted');
			if (gen !== this.refreshGen) {
				return;
			}
			// A chip without +/- counts says nothing: files the agent touched back to how they were, or only renames.
			this.hasChanges = stats.additions > 0 || stats.deletions > 0;
			this.insertions = stats.additions;
			this.deletions = stats.deletions;
			this.changedFiles = stats.files;
			this.runningTerminals = runningTerminals;
			this.render();
			return;
		}
		const hasChanges = this.scmHasChanges();
		let insertions = 0;
		let deletions = 0;
		let files = 0;
		if (hasChanges) {
			try {
				const stat = await this.commandService.executeCommand<IGitShortStat>('git.api.getWorkingTreeShortStat', this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri));
				if (gen !== this.refreshGen) {
					return;
				}
				if (stat) {
					insertions = stat.insertions;
					deletions = stat.deletions;
					files = stat.files;
				}
			} catch {
				insertions = this.insertions;
				deletions = this.deletions;
				files = this.changedFiles;
			}
		}
		if (gen !== this.refreshGen) {
			return;
		}
		this.hasChanges = insertions > 0 || deletions > 0;
		this.insertions = insertions;
		this.deletions = deletions;
		this.changedFiles = files;
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
			}
		}
		if (gen !== this.prGen) {
			return;
		}
		this.pr = next;
		this.render();
	}

	/** The folder the chat's agent works in (its worktree), else the window's. */
	private gitFolder(): string | undefined {
		return (this.sessionId ? this.pullRequests?.folderFor(this.sessionId) : undefined) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	private renderPullRequestChip(): boolean {
		const pr = this.pr;
		// A repository without an `origin` remote shows no pull request, even one linked before.
		const folder = this.gitFolder();
		if (!pr || !folder || !this.pullRequests?.hasOrigin(folder)) {
			this.prHoverCard?.hide();
			return false;
		}
		this.prIcon.replaceChildren();
		this.prChecks.className = 'volt-agent-composer-chip-pr-checks';
		this.prChip.classList.remove('state-open', 'state-draft', 'state-merged', 'state-closed');
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
		// While it compacts, the Compact chip carries the run's status: no second "Compacting context" beside it.
		const showStatus = this.hasStatus() && this.compactState !== 'running';
		const showCompact = this.compactState !== 'hidden';
		const showChanges = this.hasChanges && !(this.sessionId && isAgentChangesShown(this.sessionId));
		const showRuns = this.hasTerminalRuns();
		// The chat's own terminals say more than the window's count of busy ones: never both.
		const showTerminals = this.runningTerminals > 0 && !showRuns;
		const showAgents = !!this.agents;
		const showComments = this.pendingComments > 0;
		const showMultitask = this.multitaskPick !== undefined;
		// Steps aside while Source Control shows this chat's changes in the right panel, and while the
		// Changes chip is up: one git chip at a time, Changes first.
		const showCommit = !showChanges && this.gitVisible && !this.newChat && !(this.sessionId && isAgentScmShown(this.sessionId));
		const showScroll = this.scrolledUp && !!this.options.onScrollToBottom;
		this.updateScrollChip(showScroll);
		// Before the row's visibility: a chip starting its exit keeps the row up until it is gone.
		this.toggleChip(this.changesChip, showChanges, this.changesExit);
		this.toggleChip(this.gitControl.element, showCommit, this.commitExit);
		this.toggleChip(this.prChip, showPr, this.prExit);
		const showLimit = !!this.options.limitRun?.visible;
		const showAgentRun = !!this.options.agentRun?.visible;
		const visible = this.hostOpen && !this.newChat && (showLimit || showAgentRun || showStatus || showComments || showMultitask || showAgents || showRuns || showCompact || showChanges || showTerminals || showCommit || showPr || showScroll || !!this.scrollExit.value || !!this.changesExit.value || !!this.commitExit.value || !!this.prExit.value);
		this.element.classList.toggle('is-visible', visible);
		// A chat hosted in another chat's tools hides the row but keeps its terminals (agentEditor.css).
		this.element.classList.toggle('has-terminal-runs', showRuns);

		this.statusChip.classList.toggle('hidden', !showStatus);
		this.statusChip.classList.toggle('working', this.status.working);
		this.chipLabelEl.textContent = this.status.label;

		this.compactChip.classList.toggle('hidden', !showCompact);

		this.commentsChip.classList.toggle('hidden', !showComments);
		this.commentsLabelEl.textContent = this.pendingComments === 1
			? localize('voltAgent.oneComment', "1 comment")
			: localize('voltAgent.manyComments', "{0} comments", this.pendingComments);

		this.multitaskChip.classList.toggle('hidden', !showMultitask);
		this.multitaskChip.classList.toggle('empty', this.multitaskPick === 0);
		this.multitaskLabelEl.textContent = this.multitaskPick === 0
			? localize('voltAgent.multitaskPickNone', "None to multitask")
			: localize('voltAgent.multitaskPickCount', "{0} to multitask", this.multitaskPick ?? 0);

		this.agentsChip.classList.toggle('hidden', !showAgents);
		if (this.agents) {
			const agents = this.agents;
			this.agentsChip.classList.toggle('waiting', agents.waiting > 0);
			this.agentsChip.classList.toggle('working', agents.live > agents.waiting);
			this.agentsLabelEl.textContent = agents.label;
			this.agentsWaitingEl.textContent = agents.waiting ? localize('voltAgent.agentsChip.waiting', "\u00b7 {0} needs you", agents.waiting) : '';
			this.agentsChip.setAttribute('aria-label', agents.waiting ? `${agents.label}, ${localize('voltAgent.agentsChip.waitingAria', "{0} need you", agents.waiting)}` : agents.label);
		}

		this.changesAddEl.textContent = this.insertions > 0 ? `+${this.insertions}` : '';
		this.changesDelEl.textContent = this.deletions > 0 ? `-${this.deletions}` : '';
		this.changesAddEl.classList.toggle('hidden', this.insertions <= 0);
		this.changesDelEl.classList.toggle('hidden', this.deletions <= 0);
		const showFiles = this.changedFiles > 0 && !this.status.working;
		this.changesFilesEl.textContent = !showFiles ? '' : this.changedFiles === 1
			? localize('voltAgent.changes.oneFile', "1 File")
			: localize('voltAgent.changes.manyFiles', "{0} Files", this.changedFiles);
		this.changesFilesEl.classList.toggle('hidden', !showFiles);

		this.terminalsChip.classList.toggle('hidden', !showTerminals);
		this.terminalsLabelEl.textContent = this.runningTerminals === 1
			? localize('voltAgent.oneTerminal', "1 Terminal")
			: localize('voltAgent.manyTerminals', "{0} Terminals", this.runningTerminals);
		this.scheduleLayout();
	}

	/** The chips that fold into "..." when the row runs out of room, in row order. The arrow never does. */
	private overflowableChips(): HTMLElement[] {
		const runs = this.options.terminalRuns?.element;
		const limit = this.options.limitRun?.element;
		const agentRun = this.options.agentRun?.element;
		return [...(limit ? [limit] : []), ...(agentRun ? [agentRun] : []), this.statusChip, this.agentsChip, ...(runs ? [runs] : []), this.commentsChip, this.multitaskChip, this.compactChip, this.changesChip, this.terminalsChip, this.gitControl.element, this.prChip];
	}

	private scheduleLayout(): void {
		if (this.layoutHandle !== undefined) {
			return;
		}
		this.layoutHandle = getWindow(this.element).requestAnimationFrame(() => {
			this.layoutHandle = undefined;
			this.layoutOverflow();
		});
	}

	/**
	 * Keeps the row on one line: chips that do not fit before the arrow and "..." move into the
	 * "..." panel, from the end. Chips are measured where they sit (the closed panel still lays
	 * them out) and only moved when their place changes: re-inserting a chip restarts its grow-in
	 * animation, which measured it narrow and made the row flicker and overlap while resizing.
	 */
	private layoutOverflow(): void {
		const row = this.element;
		const chips = this.overflowableChips();
		// Not the ones CSS hides (a hosted chat shows only its terminals): they take no room.
		const shown = chips.filter(chip => !chip.classList.contains('hidden') && chip.offsetParent !== null);
		const available = row.clientWidth;
		let kept = shown.length;
		if (row.classList.contains('is-visible') && available) {
			const gap = parseFloat(getWindow(row).getComputedStyle(row).columnGap) || 0;
			// Each chip with the gap after it; the arrow (when shown) and "..." follow. A chip
			// still growing in reports its full width through scrollWidth.
			const widths = shown.map(chip => Math.max(chip.offsetWidth, chip.scrollWidth) + gap);
			const arrow = this.scrollChip.classList.contains('hidden') ? 0 : this.scrollChip.offsetWidth + gap;
			const total = widths.reduce((sum, width) => sum + width, 0) + arrow - gap;
			if (total > available) {
				// Measured while hidden it would be 0: the chip's round 30px.
				const room = available - arrow - 30;
				let used = 0;
				kept = 0;
				while (kept < widths.length && used + widths[kept] <= room) {
					used += widths[kept++];
				}
			}
		}
		const overflowed = new Set(shown.slice(kept));
		for (let index = 0; index < chips.length; index++) {
			const chip = chips[index];
			if (overflowed.has(chip)) {
				continue;
			}
			chip.classList.remove('overflowed');
			if (chip.parentElement !== row) {
				const next = chips.slice(index + 1).find(later => later.parentElement === row) ?? this.scrollChip;
				row.insertBefore(chip, next);
			}
		}
		// Same for the panel: a chip already in order stays put, so an open panel does not redraw.
		let previous: HTMLElement | null = null;
		for (const chip of overflowed) {
			chip.classList.add('overflowed');
			const first: Element | null = this.overflowPanel.firstElementChild;
			if (chip.parentElement !== this.overflowPanel || chip.previousElementSibling !== previous) {
				this.overflowPanel.insertBefore(chip, previous ? previous.nextElementSibling : first);
			}
			previous = chip;
		}
		this.showMoreChip(overflowed.size > 0);
	}

	private showMoreChip(show: boolean): void {
		this.moreChip.classList.toggle('hidden', !show);
		if (!show) {
			this.setOverflowOpen(false);
		} else if (this.overflowOpen) {
			this.positionOverflowPanel();
		}
	}

	private setOverflowOpen(open: boolean): void {
		if (open && this.moreChip.classList.contains('hidden')) {
			open = false;
		}
		this.overflowOpen = open;
		this.moreChip.setAttribute('aria-expanded', String(open));
		this.moreChip.classList.toggle('open', open);
		this.overflowPanel.classList.toggle('closed', !open);
		if (open) {
			this.positionOverflowPanel();
		}
	}

	/** Right edge on the "..." chip's right edge, just above the row. */
	private positionOverflowPanel(): void {
		this.overflowPanel.style.left = `${this.moreChip.offsetLeft + this.moreChip.offsetWidth}px`;
	}

	/** No status, changes, or terminal chip sits beside the arrow. */
	private scrollChipIsAlone(): boolean {
		return !this.hasStatus() && !this.hasChanges && !this.showsGit() && this.runningTerminals <= 0 && !this.hasTerminalRuns() && this.compactState === 'hidden' && !this.pr && !this.agents;
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
		if (this.layoutHandle !== undefined) {
			win.cancelAnimationFrame(this.layoutHandle);
			this.layoutHandle = undefined;
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
