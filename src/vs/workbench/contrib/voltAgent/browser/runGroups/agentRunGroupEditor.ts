/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentRunGroups.css';
import { $, addDisposableListener, append, clearNode, Dimension, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Action } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltGitDiffEntry, IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IAgentRunGroupService, IRunGroup, IRunGroupRun, isRunLive, RunStatus, RunWinnerAction, runWorkMs } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { formatRunCost, formatRunTime, formatRunTokens, runBadgeKind, runGroupSummary, runStatusLabel, winnerActionLabel } from './agentRunGroupLabels.js';
import { openRunDiff } from './agentRunGroupDiff.js';

export const AGENT_RUN_GROUP_EDITOR_ID = 'workbench.editor.voltRunGroup';
export const AGENT_RUN_GROUP_INPUT_ID = 'workbench.input.voltRunGroup';

const RunGroupTabIcon = registerIcon('volt-run-group-editor-label-icon', Codicon.layers, localize('voltRun.tabIcon', "Icon of a model comparison tab."));

export class AgentRunGroupEditorInput extends EditorInput {

	static readonly TypeID = AGENT_RUN_GROUP_INPUT_ID;
	static readonly EditorID = AGENT_RUN_GROUP_EDITOR_ID;

	readonly resource: URI;

	constructor(
		readonly runGroupId: string,
		@IAgentRunGroupService private readonly runGroups: IAgentRunGroupService,
	) {
		super();
		this.resource = URI.from({ scheme: Schemas.voltRunGroup, path: `/${runGroupId}` });
		this._register(runGroups.onDidChange(id => {
			if (id === runGroupId) {
				this._onDidChangeLabel.fire();
			}
		}));
	}

	override get typeId(): string {
		return AgentRunGroupEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentRunGroupEditorInput.EditorID;
	}

	override getName(): string {
		const group = this.runGroups.get(this.runGroupId);
		return group ? localize('voltRun.tab', "Compare · {0}", group.title) : localize('voltRun.tabMissing', "Compare models");
	}

	override getIcon(): ThemeIcon {
		return RunGroupTabIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof AgentRunGroupEditorInput && other.runGroupId === this.runGroupId);
	}
}

export class AgentRunGroupEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: AgentRunGroupEditorInput): string {
		return input.runGroupId;
	}
	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput {
		return instantiationService.createInstance(AgentRunGroupEditorInput, serialized);
	}
}

type Tab = 'overview' | string;

/**
 * The compare view of a run group (Cursor's per-model tabs): an overview with one column per run
 * (status, time, tokens, cost, files, lines, last message, setup progress), a tab per run with
 * its changed files, diffs against the base or between two runs, Pick winner, and a follow-up
 * box that sends to the selected run or to all of them.
 */
export class AgentRunGroupEditor extends EditorPane {

	static readonly ID = AGENT_RUN_GROUP_EDITOR_ID;

	private container!: HTMLElement;
	private header!: HTMLElement;
	private tabs!: HTMLElement;
	private body!: HTMLElement;
	private scroll!: DomScrollableElement;
	private composer!: HTMLElement;
	private textarea!: HTMLTextAreaElement;
	private targetSelect!: HTMLElement;
	private sendButton!: HTMLButtonElement;

	private groupId: string | undefined;
	private tab: Tab = 'overview';
	/** The run follow-ups go to in "selected" mode, and the one the run tab shows. */
	private selectedRun: string | undefined;
	/** Up to two runs ticked for a run-to-run diff. */
	private comparing: string[] = [];
	private readonly files = new Map<string, { readonly at: number; readonly entries: readonly IVoltGitDiffEntry[] }>();
	private busy: string | undefined;

	private readonly renderStore = this._register(new DisposableStore());
	private readonly groupStore = this._register(new DisposableStore());
	private readonly pendingRender = this._register(new MutableDisposable());
	private readonly visibleStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentRunGroupService private readonly runGroups: IAgentRunGroupService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltGitService private readonly git: IVoltGitService,
	) {
		super(AgentRunGroupEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-run-group'));
		this.header = append(this.container, $('.volt-run-header'));
		this.tabs = append(this.container, $('.volt-run-tabs'));
		this.tabs.setAttribute('role', 'tablist');
		const content = $('.volt-run-body');
		this.body = content;
		this.scroll = this._register(createAgentScrollable(content));
		append(this.container, this.scroll.getDomNode()).classList.add('volt-run-scroll');
		this.composer = append(this.container, $('.volt-run-composer'));
		this.buildComposer();
	}

	override async setInput(input: AgentRunGroupEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (this.groupId !== input.runGroupId) {
			this.groupId = input.runGroupId;
			this.tab = 'overview';
			this.comparing = [];
			this.files.clear();
			this.selectedRun = undefined;
		}
		this.groupStore.clear();
		this.groupStore.add(this.runGroups.onDidChange(id => {
			if (id === this.groupId) {
				this.scheduleRender();
			}
		}));
		await this.runGroups.whenReady;
		void this.runGroups.refreshStats(input.runGroupId);
		this.render();
	}

	override clearInput(): void {
		this.groupStore.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.visibleStore.clear();
		if (!visible || !this.container) {
			return;
		}
		// Live clocks move every second; nothing else re-renders on a timer.
		const window = getWindow(this.container);
		const tick = window.setInterval(() => this.tickClocks(), 1000);
		this.visibleStore.add(toDisposable(() => window.clearInterval(tick)));
		if (this.groupId) {
			void this.runGroups.refreshStats(this.groupId);
		}
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.scroll.scanDomNode();
	}

	override focus(): void {
		super.focus();
		this.textarea?.focus();
	}

	private get runGroup(): IRunGroup | undefined {
		return this.groupId ? this.runGroups.get(this.groupId) : undefined;
	}

	private status(run: IRunGroupRun): RunStatus {
		return this.runGroups.runStatus(this.groupId!, run.id);
	}

	private scheduleRender(): void {
		if (!this.container) {
			return;
		}
		this.pendingRender.value = scheduleAtNextAnimationFrame(getWindow(this.container), () => this.render());
	}

	//#region Render

	private render(): void {
		this.renderStore.clear();
		const group = this.runGroup;
		clearNode(this.header);
		clearNode(this.tabs);
		clearNode(this.body);
		if (!group) {
			append(this.body, $('.volt-run-empty')).textContent = localize('voltRun.missing', "This comparison no longer exists.");
			this.composer.classList.add('hidden');
			this.scroll.scanDomNode();
			return;
		}
		this.composer.classList.remove('hidden');
		const runs = group.runs;
		// An archived run takes no follow-ups and has nothing left to diff.
		if (!this.selectedRun || !runs.some(run => run.id === this.selectedRun && !run.discarded)) {
			this.selectedRun = group.winner?.runId ?? runs.find(run => !run.discarded)?.id ?? runs[0]?.id;
		}
		this.comparing = this.comparing.filter(id => runs.some(run => run.id === id && run.worktreePath && !run.worktreeRemoved));
		if (this.tab !== 'overview' && !runs.some(run => run.id === this.tab)) {
			this.tab = 'overview';
		}
		this.renderHeader(group);
		this.renderTabs(group);
		if (this.tab === 'overview') {
			this.renderOverview(group);
		} else {
			this.renderRunTab(group, runs.find(run => run.id === this.tab)!);
		}
		this.syncComposer(group);
		this.scroll.scanDomNode();
	}

	private renderHeader(group: IRunGroup): void {
		const rollup = this.runGroups.rollup(group.id);
		const titleRow = append(this.header, $('.volt-run-title-row'));
		const titles = append(titleRow, $('.volt-run-titles'));
		append(titles, $('h1.volt-run-title')).textContent = group.title;
		const meta = append(titles, $('.volt-run-meta'));
		append(meta, $('span')).textContent = runGroupSummary(group, rollup);
		append(meta, $('span.dot')).textContent = '·';
		const base = append(meta, $('span.base'));
		base.appendChild(renderIcon(Codicon.gitBranch));
		append(base, $('span')).textContent = localize('voltRun.from', "from {0}", group.base.ref ?? group.base.commit.slice(0, 7));
		append(meta, $('span.dot')).textContent = '·';
		append(meta, $('span')).textContent = fromNow(group.createdAt, true, true);

		const actions = append(titleRow, $('.volt-run-actions'));
		if (rollup.live) {
			this.button(actions, localize('voltRun.stopAll', "Stop all"), Codicon.debugStop, () => this.runGroups.stop(group.id), 'danger');
		}
		if (this.comparing.length === 2) {
			const [a, b] = this.comparing.map(id => group.runs.find(run => run.id === id)!);
			this.button(actions, localize('voltRun.diffPair', "Diff {0} ↔ {1}", a.model.label, b.model.label), Codicon.diff, () => this.openDiff(a.id, b.id), 'primary');
		}
		this.button(actions, '', Codicon.refresh, () => this.runGroups.refreshStats(group.id), 'icon', localize('voltRun.refresh', "Refresh changes"));
		if (!group.archived) {
			this.button(actions, '', Codicon.archive, () => this.runGroups.archive(group.id), 'icon', localize('voltRun.archive', "Archive this comparison"));
		}

		if (group.winner) {
			const winner = group.runs.find(run => run.id === group.winner!.runId);
			const banner = append(this.header, $('.volt-run-banner.winner'));
			banner.appendChild(renderIcon(Codicon.pass));
			append(banner, $('span')).textContent = localize('voltRun.winnerBanner', "{0} won · {1}", winner?.model.label ?? '', winnerActionLabel(group.winner.action, group.base.ref));
			const kept = group.runs.filter(run => run.id !== group.winner!.runId && run.worktreePath && !run.worktreeRemoved);
			if (kept.length) {
				const remove = append(banner, $('button.volt-run-link')) as HTMLButtonElement;
				remove.type = 'button';
				remove.textContent = localize('voltRun.removeOthers', "Delete {0} other worktree(s)", kept.length);
				this.renderStore.add(addDisposableListener(remove, 'click', () => void this.removeWorktrees(group, kept.map(run => run.id))));
			}
		} else if (this.comparing.length === 1) {
			const hint = append(this.header, $('.volt-run-banner'));
			hint.appendChild(renderIcon(Codicon.info));
			append(hint, $('span')).textContent = localize('voltRun.pickSecond', "Tick another run to diff the two.");
		}
	}

	private renderTabs(group: IRunGroup): void {
		const add = (id: Tab, label: string, family?: string, status?: RunStatus) => {
			const tab = append(this.tabs, $('button.volt-run-tab')) as HTMLButtonElement;
			tab.type = 'button';
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.tab === id));
			tab.classList.toggle('active', this.tab === id);
			if (family) {
				tab.appendChild(createBrandIcon(family, 13));
			}
			append(tab, $('span.label')).textContent = label;
			if (status) {
				const kind = runBadgeKind(status) ?? 'idle';
				append(tab, $(`span.volt-run-dot.kind-${kind}`));
			}
			this.renderStore.add(addDisposableListener(tab, 'click', () => {
				this.tab = id;
				if (id !== 'overview') {
					this.selectedRun = id;
					void this.loadFiles(group, id);
				}
				this.render();
			}));
		};
		add('overview', localize('voltRun.overview', "Overview"));
		for (const run of group.runs) {
			add(run.id, run.model.label, run.model.family, this.status(run));
		}
	}

	private renderOverview(group: IRunGroup): void {
		const grid = append(this.body, $('.volt-run-grid'));
		grid.style.setProperty('--volt-run-columns', String(Math.max(1, group.runs.length)));
		for (const run of group.runs) {
			this.renderCard(grid, group, run, false);
		}
	}

	private renderRunTab(group: IRunGroup, run: IRunGroupRun): void {
		const wrap = append(this.body, $('.volt-run-single'));
		this.renderCard(wrap, group, run, true);
		const files = append(wrap, $('.volt-run-files'));
		const head = append(files, $('.volt-run-section-title'));
		append(head, $('span')).textContent = localize('voltRun.filesChanged', "Files changed");
		const loaded = this.files.get(run.id);
		if (!loaded) {
			append(files, $('.volt-run-muted')).textContent = run.worktreePath ? localize('voltRun.loadingFiles', "Reading changes…") : localize('voltRun.noWorktree', "No worktree yet.");
			if (run.worktreePath) {
				void this.loadFiles(group, run.id);
			}
			return;
		}
		if (!loaded.entries.length) {
			append(files, $('.volt-run-muted')).textContent = localize('voltRun.noChanges', "No changes against {0}.", group.base.ref ?? group.base.commit.slice(0, 7));
			return;
		}
		for (const entry of loaded.entries) {
			const row = append(files, $('button.volt-run-file')) as HTMLButtonElement;
			row.type = 'button';
			append(row, $(`span.kind.kind-${entry.kind}`)).textContent = entry.kind === 'added' ? 'A' : entry.kind === 'deleted' ? 'D' : entry.kind === 'renamed' ? 'R' : 'M';
			append(row, $('span.path')).textContent = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
			const stat = append(row, $('span.stat'));
			append(stat, $('span.add')).textContent = entry.binary ? '' : `+${entry.additions}`;
			append(stat, $('span.del')).textContent = entry.binary ? localize('voltRun.binary', "binary") : `−${entry.deletions}`;
			this.renderStore.add(addDisposableListener(row, 'click', () => void this.openDiff('base', run.id)));
		}
	}

	private renderCard(parent: HTMLElement, group: IRunGroup, run: IRunGroupRun, large: boolean): void {
		const status = this.status(run);
		const now = Date.now();
		const card = append(parent, $('.volt-run-card'));
		card.classList.toggle('large', large);
		card.classList.toggle('selected', !large && run.id === this.selectedRun);
		card.classList.toggle('winner', group.winner?.runId === run.id);
		card.classList.toggle('discarded', !!run.discarded);
		card.dataset.runId = run.id;

		const head = append(card, $('.volt-run-card-head'));
		head.appendChild(createBrandIcon(run.model.family, 16));
		const name = append(head, $('.volt-run-card-name'));
		append(name, $('span.model')).textContent = run.model.label;
		const branch = append(name, $('span.branch'));
		branch.appendChild(renderIcon(Codicon.gitBranch));
		append(branch, $('span')).textContent = run.branch;
		setAgentTooltip(branch, run.worktreePath ?? run.branch);
		if (!large) {
			const tick = append(head, $('label.volt-run-tick')) as HTMLLabelElement;
			const box = append(tick, $('input')) as HTMLInputElement;
			box.type = 'checkbox';
			box.checked = this.comparing.includes(run.id);
			box.disabled = !run.worktreePath || run.worktreeRemoved === true;
			setAgentTooltip(tick, localize('voltRun.tickToDiff', "Tick two runs to diff them against each other"));
			this.renderStore.add(addDisposableListener(box, 'change', () => {
				this.comparing = box.checked ? [...this.comparing.filter(id => id !== run.id), run.id].slice(-2) : this.comparing.filter(id => id !== run.id);
				this.render();
			}));
			this.renderStore.add(addDisposableListener(card, 'click', e => {
				if ((e.target as HTMLElement).closest('button, input, label, a')) {
					return;
				}
				this.selectedRun = run.id;
				this.render();
			}));
		}

		const pill = append(card, $(`.volt-run-status.kind-${runBadgeKind(status) ?? 'idle'}`));
		append(pill, $('span.volt-run-dot'));
		const pillLabel = append(pill, $('span'));
		pillLabel.textContent = runStatusLabel(status, run, now);
		if (status === 'working') {
			pillLabel.dataset.runClock = run.id;
		}
		if (group.winner?.runId === run.id) {
			append(pill, $('span.volt-run-winner-tag')).textContent = localize('voltRun.winnerTag', "Winner");
		}

		const metrics = append(card, $('.volt-run-metrics'));
		const metric = (label: string, value: string, extra?: string) => {
			const cell = append(metrics, $('.volt-run-metric'));
			append(cell, $('span.label')).textContent = label;
			const valueEl = append(cell, $('span.value'));
			valueEl.textContent = value;
			if (extra) {
				valueEl.classList.add(extra);
			}
			return valueEl;
		};
		const time = metric(localize('voltRun.time', "Time"), run.firstStartedAt ? formatRunTime(runWorkMs(run, now)) : '—');
		if (run.activeSince !== undefined) {
			time.dataset.runTime = run.id;
		}
		metric(localize('voltRun.tokens', "Tokens"), formatRunTokens(run));
		metric(localize('voltRun.cost', "Cost"), formatRunCost(run));
		metric(localize('voltRun.files', "Files"), run.stats ? String(run.stats.files) : '—');
		const lines = metric(localize('voltRun.lines', "Lines"), '');
		if (run.stats) {
			append(lines, $('span.add')).textContent = `+${run.stats.additions}`;
			append(lines, $('span.del')).textContent = ` −${run.stats.deletions}`;
		} else {
			lines.textContent = '—';
		}

		if (run.setup.steps.length || run.setup.state === 'failed' || run.setup.state === 'cancelled' || run.setup.state === 'worktree') {
			this.renderSetup(card, group, run);
		}

		const message = append(card, $('.volt-run-message'));
		const text = run.stats?.lastMessage;
		if (text) {
			message.textContent = text;
			message.classList.toggle('clamped', !large);
		} else {
			message.classList.add('muted');
			message.textContent = isRunLive(status) ? localize('voltRun.noReplyYet', "No reply yet.") : localize('voltRun.noReply', "No reply.");
		}

		const actions = append(card, $('.volt-run-card-actions'));
		this.button(actions, localize('voltRun.openChat', "Open chat"), Codicon.commentDiscussion, () => this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, run.id));
		if (run.worktreePath && !run.worktreeRemoved) {
			this.button(actions, localize('voltRun.diffBase', "Diff vs {0}", group.base.ref ?? 'base'), Codicon.diff, () => this.openDiff('base', run.id));
		}
		if (!group.winner && run.worktreePath && run.setup.state === 'done') {
			const pick = this.button(actions, localize('voltRun.pickWinner', "Pick winner"), Codicon.check, () => undefined, 'primary');
			pick.disabled = isRunLive(status) || status === 'needsInput';
			if (pick.disabled) {
				setAgentTooltip(pick, localize('voltRun.pickWhenDone', "Available once this run stops working"));
			}
			this.renderStore.add(addDisposableListener(pick, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.showWinnerMenu(pick, group, run);
			}));
		}
	}

	private renderSetup(card: HTMLElement, group: IRunGroup, run: IRunGroupRun): void {
		const setup = append(card, $('.volt-run-setup'));
		const head = append(setup, $('.volt-run-setup-head'));
		append(head, $('span')).textContent = run.setup.source
			? localize('voltRun.setupFrom', "Setup · {0}", run.setup.source)
			: run.setup.state === 'worktree' ? localize('voltRun.creatingWorktree', "Creating worktree…") : localize('voltRun.setupTitle', "Setup");
		if (run.setup.state === 'failed' || run.setup.state === 'cancelled') {
			this.button(head, localize('voltRun.retry', "Retry"), Codicon.refresh, () => this.runGroups.retrySetup(group.id, run.id), 'small');
		}
		for (const step of run.setup.steps) {
			const row = append(setup, $(`.volt-run-step.state-${step.state}`));
			const icon = step.state === 'done' ? Codicon.check : step.state === 'failed' ? Codicon.error : step.state === 'running' ? Codicon.loading : step.state === 'cancelled' ? Codicon.circleSlash : Codicon.circleLargeOutline;
			const glyph = append(row, renderIcon(icon));
			if (step.state === 'running') {
				glyph.classList.add('codicon-modifier-spin');
			}
			append(row, $('code.command')).textContent = step.command;
			if (step.startedAt) {
				append(row, $('span.elapsed')).textContent = formatRunTime((step.endedAt ?? Date.now()) - step.startedAt);
			}
			if (step.tail && (step.state === 'running' || step.state === 'failed')) {
				append(setup, $('pre.volt-run-tail')).textContent = step.tail;
			}
		}
		if (run.setup.error) {
			append(setup, $('.volt-run-error')).textContent = run.setup.error;
		}
	}

	private tickClocks(): void {
		const group = this.runGroup;
		if (!group || !this.container) {
			return;
		}
		const now = Date.now();
		for (const run of group.runs) {
			if (run.activeSince === undefined) {
				continue;
			}
			for (const el of this.container.querySelectorAll<HTMLElement>(`[data-run-time="${run.id}"]`)) {
				el.textContent = formatRunTime(runWorkMs(run, now));
			}
			for (const el of this.container.querySelectorAll<HTMLElement>(`[data-run-clock="${run.id}"]`)) {
				el.textContent = runStatusLabel(this.status(run), run, now);
			}
		}
	}

	private button(parent: HTMLElement, label: string, icon: ThemeIcon, run: () => unknown, variant?: 'primary' | 'danger' | 'icon' | 'small', tooltip?: string): HTMLButtonElement {
		const button = append(parent, $('button.volt-run-button')) as HTMLButtonElement;
		button.type = 'button';
		if (variant) {
			button.classList.add(variant);
		}
		button.appendChild(renderIcon(icon));
		if (label) {
			append(button, $('span')).textContent = label;
		}
		if (tooltip) {
			button.setAttribute('aria-label', tooltip);
			setAgentTooltip(button, tooltip);
		}
		this.renderStore.add(addDisposableListener(button, 'click', e => {
			e.stopPropagation();
			void Promise.resolve(run()).catch(err => this.notificationService.error(err instanceof Error ? err.message : String(err)));
		}));
		return button;
	}

	//#endregion

	//#region Actions

	private async loadFiles(group: IRunGroup, runId: string): Promise<void> {
		const run = group.runs.find(candidate => candidate.id === runId);
		if (!run?.worktreePath || run.worktreeRemoved) {
			return;
		}
		const cached = this.files.get(runId);
		if (cached && run.stats && cached.at >= run.stats.at) {
			return;
		}
		try {
			const target = await this.runGroups.diffTarget(group.id, 'base', runId);
			const entries = await this.git.diffSummary({ repoRoot: target.repoRoot, from: target.from, to: target.to });
			this.files.set(runId, { at: Date.now(), entries: entries.slice().sort((a, b) => a.path.localeCompare(b.path)) });
			this.scheduleRender();
		} catch (err) {
			this.files.set(runId, { at: Date.now(), entries: [] });
			this.notificationService.warn(err instanceof Error ? err.message : String(err));
		}
	}

	private async openDiff(from: string | 'base', to: string): Promise<void> {
		if (!this.groupId) {
			return;
		}
		const target = await this.runGroups.diffTarget(this.groupId, from, to);
		await openRunDiff(this.instantiationService, this.editorService, target);
	}

	private showWinnerMenu(anchor: HTMLElement, group: IRunGroup, run: IRunGroupRun): void {
		const actions = (['merge', 'checkout', 'pr'] as const).map(action => new Action(
			`volt.runGroup.winner.${action}`,
			winnerActionLabel(action, group.base.ref),
			undefined,
			action !== 'merge' || !!group.base.ref,
			() => this.pickWinner(group, run, action),
		));
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	private async pickWinner(group: IRunGroup, run: IRunGroupRun, action: RunWinnerAction): Promise<void> {
		if (this.busy) {
			return;
		}
		const others = group.runs.filter(other => other.id !== run.id && !other.discarded);
		const withWorktrees = others.filter(other => other.worktreePath && !other.worktreeRemoved);
		const { confirmed, checkboxChecked } = await this.dialogService.confirm({
			message: localize('voltRun.confirmWinner', "Pick {0} as the winner?", run.model.label),
			detail: [
				action === 'merge' ? localize('voltRun.confirmMerge', "Its changes are committed on {0} and merged into {1}.", run.branch, group.base.ref ?? '')
					: action === 'checkout' ? localize('voltRun.confirmCheckout', "Its changes are committed on {0}, and the project checks that branch out.", run.branch)
						: localize('voltRun.confirmPr', "Its changes are committed on {0}, then the pull request form opens.", run.branch),
				others.length ? localize('voltRun.confirmArchive', "The other {0} run(s) are archived.", others.length) : '',
			].filter(Boolean).join('\n'),
			primaryButton: winnerActionLabel(action, group.base.ref),
			...(withWorktrees.length ? { checkbox: { label: localize('voltRun.confirmDelete', "Also delete their worktrees and branches ({0})", withWorktrees.length), checked: true } } : {}),
		});
		if (!confirmed) {
			return;
		}
		this.busy = run.id;
		try {
			const result = await this.runGroups.pickWinner(group.id, run.id, action, { removeOthers: !!checkboxChecked });
			if (!result.ok) {
				this.notificationService.error(result.error ?? localize('voltRun.winnerFailed', "Could not pick the winner."));
			} else if (result.kept?.length) {
				this.notificationService.warn(localize('voltRun.keptWorktrees', "Kept {0} worktree(s) that could not be removed.", result.kept.length));
			}
		} finally {
			this.busy = undefined;
			this.render();
		}
	}

	private async removeWorktrees(group: IRunGroup, runIds: readonly string[]): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltRun.confirmRemove', "Delete {0} worktree(s) and their branches?", runIds.length),
			detail: localize('voltRun.confirmRemoveDetail', "Uncommitted changes in them are lost."),
			primaryButton: localize('voltRun.delete', "Delete"),
		});
		if (!confirmed) {
			return;
		}
		const result = await this.runGroups.removeWorktrees(group.id, runIds);
		if (!result.ok && result.error) {
			this.notificationService.warn(result.error);
		}
	}

	//#endregion

	//#region Follow-up

	private buildComposer(): void {
		const box = append(this.composer, $('.volt-run-composer-box'));
		this.textarea = append(box, $('textarea.volt-run-input')) as HTMLTextAreaElement;
		this.textarea.rows = 2;
		const bar = append(box, $('.volt-run-composer-bar'));
		this.targetSelect = append(bar, $('.volt-run-target'));
		append(bar, $('span.spacer'));
		this.sendButton = append(bar, $('button.volt-run-send')) as HTMLButtonElement;
		this.sendButton.type = 'button';
		this.sendButton.appendChild(renderIcon(Codicon.arrowUp));
		this.sendButton.setAttribute('aria-label', localize('voltRun.send', "Send follow-up"));
		this._register(addDisposableListener(this.sendButton, 'click', () => void this.sendFollowUp()));
		this._register(addDisposableListener(this.textarea, 'input', () => this.syncSend()));
		this._register(addDisposableListener(this.textarea, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Enter && !event.shiftKey && !e.isComposing) {
				event.preventDefault();
				void this.sendFollowUp();
			}
		}));
	}

	private syncComposer(group: IRunGroup): void {
		clearNode(this.targetSelect);
		const selected = group.runs.find(run => run.id === this.selectedRun);
		const liveRuns = group.runs.filter(run => !run.discarded).length;
		const options: { id: 'selected' | 'all'; label: string }[] = [
			{ id: 'selected', label: selected ? localize('voltRun.toSelected', "To {0}", selected.model.label) : localize('voltRun.toSelectedNone', "To the selected run") },
			{ id: 'all', label: liveRuns === 1 ? localize('voltRun.toOnly', "To the remaining run") : localize('voltRun.toAll', "To all {0} runs", liveRuns) },
		];
		for (const option of options) {
			const button = append(this.targetSelect, $('button.volt-run-target-option')) as HTMLButtonElement;
			button.type = 'button';
			button.classList.toggle('active', group.followUp === option.id);
			button.setAttribute('aria-pressed', String(group.followUp === option.id));
			button.textContent = option.label;
			this.renderStore.add(addDisposableListener(button, 'click', () => {
				this.runGroups.setFollowUpTarget(group.id, option.id);
				this.textarea.focus();
			}));
		}
		this.textarea.placeholder = group.followUp === 'all'
			? localize('voltRun.placeholderAll', "Follow up with every run…")
			: localize('voltRun.placeholderOne', "Follow up with {0}…", selected?.model.label ?? '');
		this.syncSend();
	}

	private syncSend(): void {
		this.sendButton.disabled = !this.textarea.value.trim();
	}

	private async sendFollowUp(): Promise<void> {
		const group = this.runGroup;
		const text = this.textarea.value.trim();
		if (!group || !text) {
			return;
		}
		const target = group.followUp === 'all' ? 'all' : this.selectedRun;
		if (!target) {
			return;
		}
		this.textarea.value = '';
		this.syncSend();
		await this.runGroups.followUp(group.id, target, { text, mode: group.prompt.mode });
	}

	//#endregion
}
