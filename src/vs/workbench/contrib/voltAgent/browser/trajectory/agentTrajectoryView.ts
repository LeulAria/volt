/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { cacheHitRatio, contextBreakdown, diffRequests, exportTrajectory, IRequestDiff, ITrajectoryRequest, ITrajectoryToolRun, messageText, promptTokens, summarize } from '../../../../services/voltRuntime/common/harness/trajectory.js';
import { estimateTokens } from '../../../../services/voltRuntime/common/harness/contextEngine.js';
import { INativeLoopMessage } from '../../../../services/voltRuntime/common/harness/nativeLoop.js';
import { IVoltTrajectoryService } from '../../../../services/voltRuntime/common/trajectory.js';
import { voltButtonClasses } from '../chrome/voltButton.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { agentToolsSessionOnScreen } from '../workspace/agentSurfaceHost.js';
import '../media/agentTrajectory.css';

type DetailTab = 'overview' | 'prompt' | 'response' | 'tools' | 'context' | 'raw';

const TABS: readonly { readonly id: DetailTab; readonly label: string }[] = [
	{ id: 'overview', label: localize('voltTrajectory.tab.overview', "Overview") },
	{ id: 'prompt', label: localize('voltTrajectory.tab.prompt', "Prompt") },
	{ id: 'response', label: localize('voltTrajectory.tab.response', "Response") },
	{ id: 'tools', label: localize('voltTrajectory.tab.tools', "Tools") },
	{ id: 'context', label: localize('voltTrajectory.tab.context', "Context") },
	{ id: 'raw', label: localize('voltTrajectory.tab.raw', "Raw") },
];

/** The dropdown's id for "whichever chat is on screen". */
const FOLLOW = '__follow__';
/** Longer texts open folded at this length, with a button for the rest. */
const PREVIEW_CHARS = 4_000;
const DOT = ' · ';
const ARROW = ' → ';

export function formatTokens(value: number | undefined): string {
	if (value === undefined) {
		return '-';
	}
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	}
	return String(value);
}

export function formatMs(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return '-';
	}
	if (value < 1_000) {
		return `${Math.max(0, Math.round(value))}ms`;
	}
	if (value < 60_000) {
		return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
	}
	const minutes = Math.floor(value / 60_000);
	return `${minutes}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function formatCost(value: number | undefined): string {
	return value === undefined ? '-' : `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? '-' : `${Math.round(value * 100)}%`;
}

function pretty(value: unknown): string {
	if (typeof value === 'string') {
		try {
			return JSON.stringify(JSON.parse(value), undefined, 2);
		} catch {
			return value;
		}
	}
	try {
		return JSON.stringify(value, undefined, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function isLive(request: ITrajectoryRequest): boolean {
	return request.endedAt === undefined || request.toolRuns.some(run => run.endedAt === undefined);
}

function status(request: ITrajectoryRequest): { icon: ThemeIcon; className: string; label: string } {
	if (request.endedAt === undefined) {
		return { icon: Codicon.loading, className: 'live', label: localize('voltTrajectory.status.streaming', "Streaming") };
	}
	if (request.error || request.finish === 'error') {
		return { icon: Codicon.error, className: 'error', label: request.error ?? localize('voltTrajectory.status.error', "Failed") };
	}
	if (request.finish === 'aborted') {
		return { icon: Codicon.debugStop, className: 'muted', label: localize('voltTrajectory.status.aborted', "Stopped") };
	}
	if (request.finish === 'length') {
		return { icon: Codicon.warning, className: 'warning', label: localize('voltTrajectory.status.length', "Hit the output limit") };
	}
	if (request.finish === 'tool_calls') {
		return { icon: Codicon.tools, className: 'tools', label: localize('voltTrajectory.status.tools', "Asked for tools") };
	}
	return { icon: Codicon.check, className: 'ok', label: localize('voltTrajectory.status.stop', "Answered") };
}

/**
 * The API trajectory of the chat on screen, in the bottom panel next to the Terminal: each model
 * request on a timeline with the tool calls its answer started, and for the selected one what went
 * on the wire (system prompt, messages, tool schemas), what came back, usage and cache reuse, where
 * the context went, and what changed since the request before it.
 */
export class AgentTrajectoryViewPane extends ViewPane {

	static readonly ID = 'workbench.panel.voltTrajectory.view';

	private root!: HTMLElement;
	private head!: HTMLElement;
	private list!: HTMLElement;
	private detail!: HTMLElement;
	private readonly headStore = this._register(new DisposableStore());
	private readonly listStore = this._register(new DisposableStore());
	private readonly detailStore = this._register(new DisposableStore());
	/** A chat picked in the dropdown; otherwise the panel follows the chat on screen. */
	private pinned: string | undefined;
	private followed: string | undefined;
	/** A request picked in the list; otherwise the latest is shown (and followed as it streams). */
	private selected: string | undefined;
	private tab: DetailTab = 'overview';
	/** Message bodies opened past their preview, by request id and index. */
	private readonly expanded = new Set<string>();
	/** Folds the user opened or closed, so a redraw while a request streams keeps them. */
	private readonly folds = new Map<string, boolean>();
	private renderedDetail: { id?: string; tab?: DetailTab } = {};

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVoltTrajectoryService private readonly trajectory: IVoltTrajectoryService,
		@IEditorService private readonly editorService: IEditorService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.trajectory.onDidChange(sessionId => {
			if (sessionId === this.sessionId() || !this.sessionId()) {
				this.draw();
			}
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => {
			if (this.follow()) {
				this.draw();
			}
		}));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.draw();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.volt-traj'));
		this.head = append(this.root, $('.volt-traj-head'));
		const body = append(this.root, $('.volt-traj-body'));
		this.list = append(body, $('.volt-traj-list'));
		this.list.setAttribute('role', 'listbox');
		this.list.setAttribute('aria-label', localize('voltTrajectory.listAria', "Model requests"));
		this.detail = append(body, $('.volt-traj-detail'));
		this._register(addDisposableListener(this.list, EventType.KEY_DOWN, e => this.onListKey(e)));
		this.draw();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
		this.root.classList.toggle('narrow', width < 720);
	}

	// --- state ----------------------------------------------------------------------------

	/** The chat on screen, remembered while no chat is (a terminal or a file has focus). */
	private follow(): string | undefined {
		const active = this.editorService.activeEditor;
		const onScreen = active instanceof AgentEditorInput ? active.sessionId : agentToolsSessionOnScreen();
		if (onScreen && onScreen !== this.followed) {
			this.followed = onScreen;
			this.selected = undefined;
		}
		if (active instanceof AgentEditorInput && onScreen) {
			this.trajectory.setLabel(onScreen, active.getName());
		}
		return this.followed;
	}

	private sessionId(): string | undefined {
		return this.pinned ?? this.follow() ?? this.trajectory.chats()[0]?.sessionId;
	}

	private requests(): readonly ITrajectoryRequest[] {
		const sessionId = this.sessionId();
		return sessionId ? this.trajectory.requests(sessionId) : [];
	}

	private current(requests: readonly ITrajectoryRequest[]): ITrajectoryRequest | undefined {
		return (this.selected ? requests.find(request => request.id === this.selected) : undefined) ?? requests.at(-1);
	}

	// --- rendering --------------------------------------------------------------------------

	private draw(): void {
		if (!this.root || !this.isBodyVisible()) {
			return;
		}
		const requests = this.requests();
		this.renderHead(requests);
		this.renderList(requests);
		this.renderDetail(requests);
	}

	private renderHead(requests: readonly ITrajectoryRequest[]): void {
		this.headStore.clear();
		clearNode(this.head);
		const chats = this.trajectory.chats();
		const followed = this.follow();
		const followLabel = followed ? (chats.find(chat => chat.sessionId === followed)?.label ?? localize('voltTrajectory.thisChat', "This chat")) : localize('voltTrajectory.noChat', "No chat on screen");
		createVoltDropdown(this.head, this.contextViewService, {
			options: [
				{ id: FOLLOW, label: localize('voltTrajectory.follow', "Chat on screen: {0}", followLabel), description: localize('voltTrajectory.followDesc', "Follows the chat you switch to."), icon: Codicon.eye },
				...chats.filter(chat => chat.sessionId !== followed).map(chat => ({
					id: chat.sessionId,
					label: chat.label ?? chat.sessionId.slice(0, 8),
					description: localize('voltTrajectory.chatDesc', "{0} requests", chat.requests),
					icon: Codicon.commentDiscussion,
				})),
			],
			value: this.pinned && chats.some(chat => chat.sessionId === this.pinned) ? this.pinned : FOLLOW,
			ariaLabel: localize('voltTrajectory.chatAria', "Chat"),
			width: 300,
			onChange: id => {
				this.pinned = id === FOLLOW ? undefined : id;
				this.selected = undefined;
				this.draw();
			},
		}, this.headStore);

		const stats = append(this.head, $('.volt-traj-stats'));
		const summary = summarize(requests);
		const stat = (label: string, value: string, tooltip?: string, className?: string) => {
			const element = append(stats, $('span.volt-traj-stat'));
			if (className) {
				element.classList.add(className);
			}
			append(element, $('span.label')).textContent = label;
			append(element, $('span.value')).textContent = value;
			if (tooltip) {
				setAgentTooltip(element, tooltip);
			}
		};
		const prompt = summary.input + summary.cache + summary.cacheWrite;
		stat(localize('voltTrajectory.stat.requests', "Requests"), String(summary.requests));
		stat(localize('voltTrajectory.stat.in', "In"), formatTokens(prompt), localize('voltTrajectory.stat.inTip', "Prompt tokens over all requests: {0} uncached, {1} read from cache, {2} written to cache.", formatTokens(summary.input), formatTokens(summary.cache), formatTokens(summary.cacheWrite)));
		stat(localize('voltTrajectory.stat.out', "Out"), formatTokens(summary.output));
		stat(localize('voltTrajectory.stat.cache', "Cache"), formatPercent(prompt ? summary.cache / prompt : undefined), localize('voltTrajectory.stat.cacheTip', "Share of prompt tokens read from the provider's cache."));
		if (summary.costUsd !== undefined) {
			stat(localize('voltTrajectory.stat.cost', "Cost"), formatCost(summary.costUsd));
		}
		stat(localize('voltTrajectory.stat.model', "Model time"), formatMs(summary.modelMs));
		stat(localize('voltTrajectory.stat.tools', "Tools"), summary.toolErrors ? `${summary.toolCalls} (${summary.toolErrors} failed)` : String(summary.toolCalls), undefined, summary.toolErrors ? 'warning' : undefined);
		if (summary.errors || summary.retries) {
			stat(localize('voltTrajectory.stat.errors', "Errors"), `${summary.errors}${summary.retries ? ` / ${summary.retries} retries` : ''}`, undefined, 'error');
		}

		const actions = append(this.head, $('.volt-traj-actions'));
		const action = (icon: ThemeIcon, label: string, run: () => void, disabled = false) => {
			const button = append(actions, $<HTMLButtonElement>('button', { type: 'button' }));
			button.classList.add(...voltButtonClasses('ghost'), 'volt-traj-icon-button');
			button.disabled = disabled;
			button.setAttribute('aria-label', label);
			append(button, renderIcon(icon));
			setAgentTooltip(button, label);
			this.headStore.add(addDisposableListener(button, EventType.CLICK, run));
		};
		action(Codicon.copy, localize('voltTrajectory.copyAll', "Copy Trajectory as JSON"), () => void this.clipboardService.writeText(exportTrajectory(requests)), !requests.length);
		action(Codicon.clearAll, localize('voltTrajectory.clear', "Clear"), () => {
			const sessionId = this.sessionId();
			if (sessionId) {
				this.selected = undefined;
				this.trajectory.clear(sessionId);
			}
		}, !requests.length);
	}

	private renderList(requests: readonly ITrajectoryRequest[]): void {
		const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 8;
		const scrollTop = this.list.scrollTop;
		this.listStore.clear();
		clearNode(this.list);
		if (!requests.length) {
			const empty = append(this.list, $('.volt-traj-empty'));
			append(empty, renderIcon(Codicon.pulse));
			append(empty, $('.title')).textContent = this.trajectory.enabled
				? localize('voltTrajectory.empty', "No model requests recorded for this chat yet")
				: localize('voltTrajectory.off', "Trajectory recording is off");
			append(empty, $('.hint')).textContent = this.trajectory.enabled
				? localize('voltTrajectory.emptyHint', "Send a message to a model Volt runs itself (Claude, OpenAI, OpenRouter, Ollama and other API models). External agents such as Claude Code or Codex keep their own requests.")
				: localize('voltTrajectory.offHint', "Turn on volt.agent.trajectory.enabled to record model requests.");
			return;
		}
		const start = requests[0].startedAt;
		const end = Math.max(...requests.map(request => Math.max(request.endedAt ?? Date.now(), ...request.toolRuns.map(run => run.endedAt ?? Date.now()))));
		const span = Math.max(1, end - start);
		const current = this.current(requests);
		const bar = (row: HTMLElement, from: number, to: number | undefined, className: string, ttft?: number) => {
			const track = append(row, $('.volt-traj-track'));
			const fill = append(track, $(`.volt-traj-bar.${className}`));
			fill.style.left = `${((from - start) / span) * 100}%`;
			fill.style.width = `${Math.max(0.4, (((to ?? Date.now()) - from) / span) * 100)}%`;
			if (ttft !== undefined && to !== undefined && to > from) {
				// The wait before the first token, darker.
				const wait = append(fill, $('.volt-traj-wait'));
				wait.style.width = `${Math.min(100, ((ttft - from) / (to - from)) * 100)}%`;
			}
		};
		for (const request of requests) {
			const row = append(this.list, $('.volt-traj-row.request'));
			row.tabIndex = request === current ? 0 : -1;
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(request === current));
			row.classList.toggle('selected', request === current);
			row.dataset.id = request.id;
			const state = status(request);
			const icon = append(row, $(`span.volt-traj-status.${state.className}`));
			append(icon, renderIcon(state.icon.id === Codicon.loading.id ? ThemeIcon.modify(Codicon.loading, 'spin') : state.icon));
			setAgentTooltip(icon, state.label);
			append(row, $('span.volt-traj-index')).textContent = `#${request.index}`;
			const name = append(row, $('span.volt-traj-name'));
			name.textContent = request.agent ? `${request.agent}${DOT}${request.modelLabel ?? request.model}` : (request.modelLabel ?? request.model);
			if (request.agent) {
				row.classList.add('subagent');
			}
			const meta = append(row, $('span.volt-traj-meta'));
			const prompt = promptTokens(request.usage);
			const parts = [
				request.step !== undefined ? localize('voltTrajectory.step', "step {0}", request.step) : undefined,
				formatMs((request.endedAt ?? Date.now()) - request.startedAt),
				prompt !== undefined ? `${formatTokens(prompt)}${ARROW}${formatTokens(request.usage?.output)}` : undefined,
				cacheHitRatio(request.usage) !== undefined ? localize('voltTrajectory.cached', "{0} cached", formatPercent(cacheHitRatio(request.usage))) : undefined,
			].filter(Boolean);
			meta.textContent = parts.join(DOT);
			bar(row, request.startedAt, request.endedAt, `model.${state.className}`, request.firstChunkAt);
			this.listStore.add(addDisposableListener(row, EventType.CLICK, () => this.select(request.id)));
			for (const run of request.toolRuns) {
				const toolRow = append(this.list, $('.volt-traj-row.tool'));
				toolRow.classList.toggle('selected', request === current);
				const toolIcon = append(toolRow, $(`span.volt-traj-status.${run.endedAt === undefined ? 'live' : run.isError ? 'error' : run.cancelled ? 'muted' : 'ok'}`));
				append(toolIcon, renderIcon(run.endedAt === undefined ? ThemeIcon.modify(Codicon.loading, 'spin') : run.isError ? Codicon.error : Codicon.symbolMethod));
				append(toolRow, $('span.volt-traj-name')).textContent = run.name;
				append(toolRow, $('span.volt-traj-meta')).textContent = run.cancelled ? localize('voltTrajectory.noResult', "no result") : formatMs(run.durationMs ?? (run.endedAt ?? Date.now()) - run.startedAt);
				bar(toolRow, run.startedAt, run.endedAt, run.isError ? 'tool.error' : 'tool');
				this.listStore.add(addDisposableListener(toolRow, EventType.CLICK, () => {
					this.tab = 'tools';
					this.select(request.id);
				}));
			}
		}
		if (atBottom && !this.selected) {
			this.list.scrollTop = this.list.scrollHeight;
		} else {
			this.list.scrollTop = scrollTop;
		}
	}

	private select(id: string): void {
		const requests = this.requests();
		// Picking the latest goes back to following it.
		this.selected = requests.at(-1)?.id === id ? undefined : id;
		this.draw();
		(this.list.querySelector('.volt-traj-row.selected') as HTMLElement | null)?.focus();
	}

	private onListKey(e: KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
			return;
		}
		const requests = this.requests();
		const current = this.current(requests);
		const at = current ? requests.indexOf(current) : -1;
		const next = requests[Math.min(requests.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
		if (next) {
			e.preventDefault();
			this.select(next.id);
		}
	}

	private renderDetail(requests: readonly ITrajectoryRequest[]): void {
		const request = this.current(requests);
		// A finished request on the same tab draws the same thing; keep its scroll and open folds.
		if (request && this.renderedDetail.id === request.id && this.renderedDetail.tab === this.tab && !isLive(request) && this.detail.childElementCount) {
			return;
		}
		const scrollTop = this.renderedDetail.id === request?.id ? this.detail.querySelector('.volt-traj-pane')?.scrollTop ?? 0 : 0;
		this.renderedDetail = { id: request?.id, tab: this.tab };
		this.detailStore.clear();
		clearNode(this.detail);
		if (!request) {
			return;
		}
		const tabs = append(this.detail, $('.volt-traj-tabs'));
		tabs.setAttribute('role', 'tablist');
		for (const tab of TABS) {
			const button = append(tabs, $<HTMLButtonElement>('button.volt-traj-tab', { type: 'button' }));
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(tab.id === this.tab));
			button.classList.toggle('active', tab.id === this.tab);
			button.textContent = tab.id === 'tools' && request.toolRuns.length ? `${tab.label} ${request.toolRuns.length}` : tab.label;
			this.detailStore.add(addDisposableListener(button, EventType.CLICK, () => {
				this.tab = tab.id;
				this.renderDetail(this.requests());
			}));
		}
		const pane = append(this.detail, $('.volt-traj-pane'));
		const previous = requests.slice(0, requests.indexOf(request)).reverse().find(candidate => candidate.agent === request.agent);
		const diff = previous ? diffRequests(previous, request) : undefined;
		switch (this.tab) {
			case 'overview': this.renderOverview(pane, request, diff); break;
			case 'prompt': this.renderPrompt(pane, request, diff); break;
			case 'response': this.renderResponse(pane, request); break;
			case 'tools': this.renderTools(pane, request); break;
			case 'context': this.renderContext(pane, request); break;
			case 'raw': this.renderRaw(pane, request); break;
		}
		pane.scrollTop = scrollTop;
	}

	// --- detail tabs ------------------------------------------------------------------------

	private section(parent: HTMLElement, title: string): HTMLElement {
		const section = append(parent, $('.volt-traj-section'));
		append(section, $('.volt-traj-section-title')).textContent = title;
		return section;
	}

	private grid(parent: HTMLElement, rows: readonly (readonly [string, string, string?] | undefined)[]): void {
		const grid = append(parent, $('.volt-traj-grid'));
		for (const row of rows) {
			if (!row) {
				continue;
			}
			append(grid, $('span.key')).textContent = row[0];
			const value = append(grid, $('span.value'));
			value.textContent = row[1];
			if (row[2]) {
				value.classList.add(row[2]);
			}
		}
	}

	/** Text in a monospace block, folded past {@link PREVIEW_CHARS} with a button for the rest. */
	private code(parent: HTMLElement, text: string, key: string, className?: string): void {
		const block = append(parent, $('pre.volt-traj-code'));
		if (className) {
			block.classList.add(className);
		}
		const open = this.expanded.has(key) || text.length <= PREVIEW_CHARS;
		block.textContent = open ? text : text.slice(0, PREVIEW_CHARS);
		if (!open) {
			const more = append(parent, $<HTMLButtonElement>('button.volt-traj-more', { type: 'button' }));
			more.classList.add(...voltButtonClasses('ghost'));
			more.textContent = localize('voltTrajectory.showAll', "Show all {0} characters", text.length.toLocaleString());
			this.detailStore.add(addDisposableListener(more, EventType.CLICK, () => {
				this.expanded.add(key);
				block.textContent = text;
				more.remove();
			}));
		}
		const copy = append(parent, $<HTMLButtonElement>('button.volt-traj-copy', { type: 'button' }));
		copy.classList.add(...voltButtonClasses('ghost'), 'volt-traj-icon-button');
		copy.setAttribute('aria-label', localize('voltTrajectory.copy', "Copy"));
		append(copy, renderIcon(Codicon.copy));
		setAgentTooltip(copy, localize('voltTrajectory.copy', "Copy"));
		this.detailStore.add(addDisposableListener(copy, EventType.CLICK, () => void this.clipboardService.writeText(text)));
	}

	private renderOverview(pane: HTMLElement, request: ITrajectoryRequest, diff: IRequestDiff | undefined): void {
		const state = status(request);
		const timing = this.section(pane, localize('voltTrajectory.timing', "Request"));
		this.grid(timing, [
			[localize('voltTrajectory.model', "Model"), `${request.modelLabel ?? request.model} (${request.provider}${DOT}${request.model})`],
			request.agent ? [localize('voltTrajectory.agent', "Subagent"), request.agent] : undefined,
			request.step !== undefined ? [localize('voltTrajectory.stepKey', "Step"), String(request.step)] : undefined,
			[localize('voltTrajectory.started', "Started"), new Date(request.startedAt).toLocaleTimeString()],
			[localize('voltTrajectory.ttft', "First token"), request.firstChunkAt !== undefined ? formatMs(request.firstChunkAt - request.startedAt) : '-'],
			[localize('voltTrajectory.duration', "Duration"), formatMs((request.endedAt ?? Date.now()) - request.startedAt)],
			[localize('voltTrajectory.finish', "Finish"), request.finish ? `${state.label} (${request.finish})` : state.label, state.className],
			request.error ? [localize('voltTrajectory.error', "Error"), request.error, 'error'] : undefined,
			request.maxOutputTokens ? [localize('voltTrajectory.maxOutput', "Output limit"), formatTokens(request.maxOutputTokens)] : undefined,
		]);

		const usage = this.section(pane, localize('voltTrajectory.usage', "Usage"));
		const prompt = promptTokens(request.usage);
		this.grid(usage, [
			[localize('voltTrajectory.prompt', "Prompt"), prompt !== undefined ? prompt.toLocaleString() : localize('voltTrajectory.notReported', "not reported yet")],
			[localize('voltTrajectory.uncached', "Uncached input"), request.usage ? request.usage.input.toLocaleString() : '-'],
			[localize('voltTrajectory.cacheRead', "Cache read"), request.usage?.cache !== undefined ? `${request.usage.cache.toLocaleString()} (${formatPercent(cacheHitRatio(request.usage))})` : '-'],
			[localize('voltTrajectory.cacheWrite', "Cache write"), request.usage?.cacheWrite !== undefined ? request.usage.cacheWrite.toLocaleString() : '-'],
			[localize('voltTrajectory.output', "Output"), request.usage ? request.usage.output.toLocaleString() : '-'],
			request.costUsd !== undefined ? [localize('voltTrajectory.cost', "Cost"), formatCost(request.costUsd)] : undefined,
			request.endedAt !== undefined && request.firstChunkAt !== undefined && request.usage?.output
				? [localize('voltTrajectory.speed', "Speed"), localize('voltTrajectory.tokensPerSecond', "{0} tokens/s", Math.round(request.usage.output / Math.max(0.001, (request.endedAt - request.firstChunkAt) / 1_000)))]
				: undefined,
		]);

		const change = this.section(pane, localize('voltTrajectory.sincePrevious', "Since the previous request"));
		if (!diff) {
			append(change, $('.volt-traj-note')).textContent = localize('voltTrajectory.first', "The first request of this agent here: everything in the prompt is new.");
		} else {
			if (diff.cacheBreak) {
				const warn = append(change, $('.volt-traj-callout.warning'));
				append(warn, renderIcon(Codicon.warning));
				append(warn, $('span')).textContent = localize('voltTrajectory.cacheBreak', "The cached prefix could not be reused fully: {0}.", diff.cacheBreak);
			} else {
				const ok = append(change, $('.volt-traj-callout.ok'));
				append(ok, renderIcon(Codicon.check));
				append(ok, $('span')).textContent = localize('voltTrajectory.cacheKept', "Same system prompt, tools and history: only new messages were appended.");
			}
			this.grid(change, [
				[localize('voltTrajectory.shared', "Shared messages"), String(diff.sharedPrefix)],
				[localize('voltTrajectory.added', "New messages"), String(diff.added)],
				diff.rewritten ? [localize('voltTrajectory.rewritten', "Changed or dropped"), String(diff.rewritten), 'warning'] : undefined,
				diff.systemChanged ? [localize('voltTrajectory.system', "System prompt"), localize('voltTrajectory.changed', "changed"), 'warning'] : undefined,
				diff.toolsAdded.length ? [localize('voltTrajectory.toolsAdded', "Tools added"), diff.toolsAdded.join(', ')] : undefined,
				diff.toolsRemoved.length ? [localize('voltTrajectory.toolsRemoved', "Tools removed"), diff.toolsRemoved.join(', ')] : undefined,
				diff.toolsChanged.length ? [localize('voltTrajectory.toolsChanged', "Tools changed"), diff.toolsChanged.join(', ')] : undefined,
			]);
		}

		if (request.notes.length) {
			const notes = this.section(pane, localize('voltTrajectory.notes', "Retries and notices"));
			for (const note of request.notes) {
				const line = append(notes, $(`.volt-traj-callout.${note.kind === 'notice' ? 'info' : note.kind === 'retry' ? 'warning' : 'error'}`));
				append(line, renderIcon(note.kind === 'retry' ? Codicon.sync : note.kind === 'error' ? Codicon.error : Codicon.info));
				append(line, $('span')).textContent = `${formatMs(note.at - request.startedAt)}  ${note.text}`;
			}
		}

		if (request.toolRuns.length) {
			const tools = this.section(pane, localize('voltTrajectory.toolCalls', "Tool calls"));
			for (const run of request.toolRuns) {
				this.toolLine(tools, run);
			}
		}
	}

	private toolLine(parent: HTMLElement, run: ITrajectoryToolRun): HTMLElement {
		const line = append(parent, $('.volt-traj-tool-line'));
		append(line, renderIcon(run.endedAt === undefined ? ThemeIcon.modify(Codicon.loading, 'spin') : run.isError ? Codicon.error : run.cancelled ? Codicon.debugStop : Codicon.check)).classList.add(run.isError ? 'error' : 'ok');
		append(line, $('span.name')).textContent = run.name;
		append(line, $('span.meta')).textContent = run.cancelled ? localize('voltTrajectory.noResult', "no result") : formatMs(run.durationMs ?? (run.endedAt ?? Date.now()) - run.startedAt);
		return line;
	}

	private renderPrompt(pane: HTMLElement, request: ITrajectoryRequest, diff: IRequestDiff | undefined): void {
		const system = this.section(pane, localize('voltTrajectory.systemPrompt', "System prompt ({0} tokens)", formatTokens(estimateTokens(request.system))));
		this.fold(system, localize('voltTrajectory.systemFold', "System"), request.system, `${request.id}:system`, diff?.systemChanged ? 'changed' : undefined, !diff);
		const messages = this.section(pane, localize('voltTrajectory.messages', "Messages ({0})", request.messages.length));
		request.messages.forEach((message, i) => {
			const isNew = !diff || i >= diff.sharedPrefix;
			this.message(messages, request, message, i, isNew && !!diff, i >= request.messages.length - 2);
		});
	}

	/** A fold opens as the user left it, else as `open` says; `draw` fills it the first time it is open. */
	private details(parent: HTMLElement, className: string, key: string, open: boolean, draw: (details: HTMLDetailsElement) => void): { details: HTMLDetailsElement; summary: HTMLElement } {
		const details = append(parent, $<HTMLDetailsElement>(`details.volt-traj-fold${className}`));
		details.open = this.folds.get(key) ?? open;
		const summary = append(details, $('summary'));
		let drawn = false;
		const fill = () => {
			if (details.open && !drawn) {
				drawn = true;
				draw(details);
			}
		};
		this.detailStore.add(addDisposableListener(details, 'toggle', () => {
			this.folds.set(key, details.open);
			fill();
		}));
		fill();
		return { details, summary };
	}

	private fold(parent: HTMLElement, label: string, text: string, key: string, badge: string | undefined, open: boolean): void {
		const { summary } = this.details(parent, '', key, open, details => this.code(details, text, key));
		append(summary, $('span.role')).textContent = label;
		if (badge) {
			append(summary, $('span.badge.warning')).textContent = badge;
		}
		append(summary, $('span.preview')).textContent = text.slice(0, 160).replace(/\s+/g, ' ');
	}

	private message(parent: HTMLElement, request: ITrajectoryRequest, message: INativeLoopMessage, index: number, isNew: boolean, open: boolean): void {
		const key = `${request.id}:m${index}`;
		const { summary } = this.details(parent, `.role-${message.role}`, key, open, details => {
			if (message.content) {
				this.code(details, message.content, key);
			}
			for (const call of message.toolCalls ?? []) {
				append(details, $('.volt-traj-call-name')).textContent = `${call.name}  ${call.id}`;
				this.code(details, pretty(call.args), `${key}:${call.id}`, 'json');
			}
		});
		append(summary, $('span.index')).textContent = String(index + 1);
		append(summary, $('span.role')).textContent = message.role === 'tool' ? `tool${message.name ? `: ${message.name}` : ''}` : message.role;
		if (isNew) {
			append(summary, $('span.badge.new')).textContent = localize('voltTrajectory.new', "new");
		}
		if (message.isError) {
			append(summary, $('span.badge.error')).textContent = localize('voltTrajectory.failed', "error");
		}
		if (message.images?.length) {
			append(summary, $('span.badge')).textContent = localize('voltTrajectory.images', "{0} images", message.images.length);
		}
		const text = messageText(message);
		append(summary, $('span.tokens')).textContent = formatTokens(estimateTokens(text));
		append(summary, $('span.preview')).textContent = text.slice(0, 160).replace(/\s+/g, ' ');
	}

	private renderResponse(pane: HTMLElement, request: ITrajectoryRequest): void {
		const { reasoning, text, toolCalls } = request.response;
		if (!reasoning && !text && !toolCalls.length) {
			append(pane, $('.volt-traj-note')).textContent = request.endedAt === undefined
				? localize('voltTrajectory.waiting', "Waiting for the first token")
				: localize('voltTrajectory.emptyResponse', "The model returned nothing.");
			return;
		}
		if (reasoning) {
			const section = this.section(pane, localize('voltTrajectory.reasoning', "Reasoning ({0} tokens)", formatTokens(estimateTokens(reasoning))));
			this.code(section, reasoning, `${request.id}:reasoning`, 'reasoning');
		}
		if (text) {
			const section = this.section(pane, localize('voltTrajectory.text', "Text"));
			this.code(section, text, `${request.id}:text`);
		}
		if (toolCalls.length) {
			const section = this.section(pane, localize('voltTrajectory.calls', "Tool calls ({0})", toolCalls.length));
			for (const call of toolCalls) {
				append(section, $('.volt-traj-call-name')).textContent = `${call.name}  ${call.id}`;
				this.code(section, pretty(call.arguments), `${request.id}:${call.id}`, 'json');
			}
		}
	}

	private renderTools(pane: HTMLElement, request: ITrajectoryRequest): void {
		if (request.toolRuns.length) {
			const runs = this.section(pane, localize('voltTrajectory.ran', "Ran after this answer"));
			for (const run of request.toolRuns) {
				const key = `${request.id}:${run.callId}`;
				const { summary } = this.details(runs, '', key, request.toolRuns.length <= 3, details => {
					append(details, $('.volt-traj-call-name')).textContent = localize('voltTrajectory.args', "Arguments");
					this.code(details, pretty(run.args), `${request.id}:${run.callId}:args`, 'json');
					append(details, $('.volt-traj-call-name')).textContent = localize('voltTrajectory.result', "Result");
					this.code(details, run.result ?? (run.endedAt === undefined ? localize('voltTrajectory.running', "Running") : ''), `${request.id}:${run.callId}:result`, run.isError ? 'error' : undefined);
				});
				this.toolLine(summary, run);
			}
		}
		const schemas = this.section(pane, localize('voltTrajectory.schemas', "Tools offered ({0}, {1} tokens)", request.tools.length, formatTokens(estimateTokens(JSON.stringify(request.tools)))));
		const sorted = request.tools.slice().sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
		for (const tool of sorted) {
			const used = request.toolRuns.some(run => run.name === tool.name);
			this.fold(schemas, tool.name, `${tool.description}\n\n${pretty(tool.parameters)}`, `${request.id}:tool:${tool.name}`, used ? localize('voltTrajectory.used', "used") : undefined, false);
		}
	}

	private renderContext(pane: HTMLElement, request: ITrajectoryRequest): void {
		const breakdown = contextBreakdown(request);
		const prompt = promptTokens(request.usage);
		const section = this.section(pane, prompt !== undefined
			? localize('voltTrajectory.contextReported', "Where the prompt went ({0} tokens reported, {1} estimated)", prompt.toLocaleString(), breakdown.total.toLocaleString())
			: localize('voltTrajectory.contextEstimated', "Where the prompt went ({0} tokens estimated)", breakdown.total.toLocaleString()));
		const parts = [
			{ key: 'system', label: localize('voltTrajectory.ctx.system', "System prompt"), value: breakdown.system },
			{ key: 'tools', label: localize('voltTrajectory.ctx.tools', "Tool schemas"), value: breakdown.tools },
			{ key: 'user', label: localize('voltTrajectory.ctx.user', "User and harness messages"), value: breakdown.user },
			{ key: 'assistant', label: localize('voltTrajectory.ctx.assistant', "Assistant messages and calls"), value: breakdown.assistant },
			{ key: 'results', label: localize('voltTrajectory.ctx.results', "Tool results"), value: breakdown.toolResults },
			{ key: 'images', label: localize('voltTrajectory.ctx.images', "Images (about 1.5k each)"), value: breakdown.images },
		].filter(part => part.value > 0);
		const stack = append(section, $('.volt-traj-stack'));
		for (const part of parts) {
			const piece = append(stack, $(`span.piece.${part.key}`));
			piece.style.width = `${(part.value / Math.max(1, breakdown.total)) * 100}%`;
			setAgentTooltip(piece, `${part.label}: ${part.value.toLocaleString()}`);
		}
		const legend = append(section, $('.volt-traj-legend'));
		for (const part of parts) {
			const item = append(legend, $('.item'));
			append(item, $(`span.swatch.${part.key}`));
			append(item, $('span.label')).textContent = part.label;
			append(item, $('span.value')).textContent = `${formatTokens(part.value)} (${formatPercent(part.value / Math.max(1, breakdown.total))})`;
		}
		// The heaviest messages: what compaction or clearing would free first.
		const heavy = request.messages
			.map((message, index) => ({ message, index, tokens: estimateTokens(messageText(message)) }))
			.sort((a, b) => b.tokens - a.tokens)
			.slice(0, 8)
			.filter(entry => entry.tokens > 0);
		if (heavy.length) {
			const largest = this.section(pane, localize('voltTrajectory.largest', "Largest messages"));
			for (const entry of heavy) {
				const line = append(largest, $('.volt-traj-tool-line'));
				append(line, $('span.index')).textContent = `#${entry.index + 1}`;
				append(line, $('span.name')).textContent = entry.message.role === 'tool' ? `tool: ${entry.message.name ?? ''}` : entry.message.role;
				append(line, $('span.meta')).textContent = formatTokens(entry.tokens);
				append(line, $('span.preview')).textContent = messageText(entry.message).slice(0, 120).replace(/\s+/g, ' ');
			}
		}
	}

	private renderRaw(pane: HTMLElement, request: ITrajectoryRequest): void {
		const section = this.section(pane, localize('voltTrajectory.rawTitle', "Request and response as recorded"));
		this.code(section, exportTrajectory([request]), `${request.id}:raw`, 'json');
	}
}
