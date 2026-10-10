/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVoltTokenRates, IVoltUsageService } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { AgentCustomizationScanner } from '../customize/agentCustomize.js';
import {
	buildContextUsageSnapshot,
	defaultOverhead,
	formatContextFullLabel,
	formatContextPercent,
	formatContextTokens,
	formatContextWindowLabel,
	IContextOverhead,
	IContextUsageInput,
	IContextUsageSnapshot,
	overheadFromCustomizations,
} from './agentContextUsage.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { formatCost } from '../usage/agentUsageFormat.js';
import { buildSessionUsage, ISessionUsageMessage, ISessionUsageModelRef, ISessionUsageOptions, ISessionUsageSummary, sessionModelIds } from './agentSessionUsage.js';
import { AgentSessionUsagePanel, createSessionUsageIcon } from './agentSessionUsagePanel.js';

const RING_RADIUS = 7.25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The branch a chat runs on, and whether that is the project's checkout or its own worktree. */
export interface IAgentStatusBranch {
	readonly name?: string;
	readonly detached?: string;
	readonly worktree: boolean;
	/** The worktree's folder, for the tooltip. */
	readonly path?: string;
}

/** Whether the chat's agent can compact its context now; absent when it has no `/compact`. */
export interface IAgentCompactState {
	/** Why the button is disabled right now (a run is going), else undefined. */
	readonly blockedReason?: string;
	/** The agent is compacting right now. */
	readonly running?: boolean;
}

export interface IAgentContextUsageHost {
	getUsageInput(): Omit<IContextUsageInput, 'overhead'>;
	getCompactState?(): IAgentCompactState | undefined;
	/** A compaction is under way (asked for, or the agent's own): the ring turns while it runs. */
	isCompacting?(): boolean;
	compact?(): void;
	/** After every repaint, with how full the window is (0 without a chat). */
	onDidRefresh?(percent: number, used?: number): void;
	getPanelAnchor(): { parent: HTMLElement; before: HTMLElement };
	getBranch(): IAgentStatusBranch;
	/** The chevron on the branch: move the chat to another checkout. Absent: no chevron. */
	openMoveMenu?(anchor: HTMLElement): void;
	onWillOpenPanel?(): void;
	/** The transcript, for the Session Usage panel (each reply's model, tokens and cost). */
	getSessionMessages?(): readonly ISessionUsageMessage[];
	/** The chat's model: replies recorded before turns kept their model are counted under it. */
	getSessionModel?(): ISessionUsageModelRef | undefined;
	/** Today's catalog entry for a model ref. */
	describeModel?(ref: string): { readonly id?: string; readonly label?: string } | undefined;
	revealTurn?(turnId: string): void;
}

export class AgentContextUsageView extends Disposable {

	readonly element: HTMLElement;

	private readonly branchButton: HTMLButtonElement;
	private readonly branchIcon: HTMLElement;
	private readonly branchChevron: HTMLElement;
	private readonly branchLabel: HTMLElement;
	/** Text written to the clipboard. Absent when the chat has no branch. */
	private copyText: string | undefined;
	private branchHover = false;
	private branchCopied = false;
	private readonly branchCopiedTimer = this._register(new MutableDisposable());
	private readonly envChip: HTMLElement;
	private readonly envIcon: HTMLElement;
	private readonly envLabel: HTMLElement;
	private readonly sessionButton: HTMLButtonElement;
	private readonly sessionLabel: HTMLElement;
	private readonly contextButton: HTMLButtonElement;
	private readonly ringFill: SVGCircleElement;
	private readonly percentLabel: HTMLElement;
	private readonly tokensLabel: HTMLElement;
	private readonly scanner: AgentCustomizationScanner;
	private readonly panelStore = this._register(new DisposableStore());

	private open = false;
	private overhead: IContextOverhead | undefined;
	private overheadGen = 0;
	private popup: IContextPopupRefs | undefined;
	private panelEl: HTMLElement | undefined;
	private readonly sessionStore = this._register(new DisposableStore());
	private sessionPanel: AgentSessionUsagePanel | undefined;
	private sessionPanelEl: HTMLElement | undefined;
	/** List prices by model id, filled from the usage service; null when the price is unknown. */
	private readonly rates = new Map<string, IVoltTokenRates | null>();
	private readonly ratesPending = new Set<string>();

	constructor(
		private readonly host: IAgentContextUsageHost,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.scanner = new AgentCustomizationScanner(fileService);
		this.element = $('.volt-agent-composer-status');

		const start = append(this.element, $('.volt-agent-status-start'));
		this.branchButton = append(start, $('button.volt-agent-status-branch')) as HTMLButtonElement;
		this.branchButton.type = 'button';
		this.branchIcon = this.branchButton.appendChild(renderIcon(Codicon.gitBranch));
		this.branchLabel = append(this.branchButton, $('span.label'));
		this.branchChevron = this.branchButton.appendChild(renderIcon(Codicon.chevronDown));
		this.branchChevron.classList.add('chevron');
		this.branchChevron.classList.toggle('is-hidden', !host.openMoveMenu);
		this.envChip = append(start, $('span.volt-agent-status-env'));
		this.envIcon = append(this.envChip, $('span.icon'));
		this.envLabel = append(this.envChip, $('span.label'));

		this.sessionButton = append(this.element, $('button.volt-agent-session-usage')) as HTMLButtonElement;
		this.sessionButton.type = 'button';
		this.sessionButton.appendChild(createSessionUsageIcon(this.sessionButton.ownerDocument));
		this.sessionLabel = append(this.sessionButton, $('span.label'));

		this.contextButton = append(this.element, $('button.volt-agent-context-meter')) as HTMLButtonElement;
		this.contextButton.type = 'button';
		this.ringFill = this.createRing(this.contextButton);
		this.percentLabel = append(this.contextButton, $('span.percent'));
		this.tokensLabel = append(this.contextButton, $('span.tokens'));

		this._register(addDisposableListener(this.branchButton, 'mouseenter', () => {
			this.branchHover = true;
			this.paintBranchIcon();
		}));
		this._register(addDisposableListener(this.branchButton, 'mouseleave', () => {
			this.branchHover = false;
			this.paintBranchIcon();
		}));
		this._register(addDisposableListener(this.branchButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.copyBranchName();
		}));
		this._register(addDisposableListener(this.branchChevron, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.openMoveMenu?.(this.branchButton);
		}));
		this._register(addDisposableListener(this.sessionButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.sessionPanel) {
				this.hideSessionPanel();
			} else {
				this.showSessionPanel();
			}
			this.sessionButton.blur();
		}));
		this._register(addDisposableListener(this.contextButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.togglePanel();
			this.contextButton.blur();
		}));
		this._register(this.hostTools.onDidChangeMcp(() => void this.refreshOverhead()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refreshOverhead()));

		this.refreshBranch();
		this.refresh();
		void this.refreshOverhead();
	}

	refresh(): void {
		const hasChat = this.host.getUsageInput().messages.length > 0;
		this.contextButton.hidden = !hasChat;
		this.contextButton.classList.toggle('empty', !hasChat);
		this.refreshSession(hasChat);
		if (!hasChat) {
			this.hidePanel();
			this.host.onDidRefresh?.(0);
			return;
		}
		const snapshot = this.snapshot();
		const percent = formatContextPercent(snapshot.percent);
		const used = formatContextTokens(snapshot.used);
		const limit = formatContextTokens(snapshot.limit);
		const ratio = Math.min(1, snapshot.used / Math.max(snapshot.limit, 1));
		this.ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE}`);
		this.ringFill.setAttribute('stroke-dashoffset', `${RING_CIRCUMFERENCE * (1 - ratio)}`);
		const compacting = !!this.host.isCompacting?.();
		this.contextButton.classList.toggle('warn', snapshot.percent >= 80 && !compacting);
		this.contextButton.classList.toggle('critical', snapshot.percent >= 95 && !compacting);
		this.contextButton.classList.toggle('compacting', compacting);
		this.percentLabel.textContent = percent;
		this.tokensLabel.textContent = localize('voltAgent.contextUsedShort', "{0}/{1}", used, limit);
		const detail = compacting
			? localize('voltAgent.contextUsageCompacting', "Compacting context · {0} / {1}", used, limit)
			: localize('voltAgent.contextUsageDetail', "Context usage: {0} / {1}", used, limit);
		this.contextButton.setAttribute('aria-label', detail);
		this.contextButton.setAttribute('aria-expanded', String(this.open));
		setAgentTooltip(this.contextButton, detail);
		if (this.open && this.popup) {
			this.fillPopup(this.popup, snapshot);
		}
		this.host.onDidRefresh?.(snapshot.percent, snapshot.used);
	}

	private snapshot(): IContextUsageSnapshot {
		const input = this.host.getUsageInput();
		return buildContextUsageSnapshot({
			...input,
			overhead: this.overhead ?? defaultOverhead(input.nativeAgent),
		});
	}

	/** Reads the chat's branch and checkout again, as after a checkout or a new worktree. */
	refreshBranch(): void {
		const { name, detached, worktree, path } = this.host.getBranch();
		const copyText = name || detached;
		if (copyText !== this.copyText) {
			this.copyText = copyText;
			this.branchCopied = false;
			this.branchCopiedTimer.clear();
		}
		this.branchLabel.textContent = name
			|| (detached ? localize('voltAgent.detached', "{0} (detached)", detached) : localize('voltAgent.noBranch', "No branch"));
		this.branchButton.classList.toggle('empty', !name && !detached);
		this.paintBranchIcon();

		this.envChip.classList.toggle('worktree', worktree);
		const doc = this.envIcon.ownerDocument;
		this.envIcon.replaceChildren(worktree ? createWorktreeIcon(doc) : createLocalIcon(doc));
		this.envLabel.textContent = worktree ? localize('voltAgent.status.worktree', "Worktree") : localize('voltAgent.status.local', "Local");
		setAgentTooltip(this.envChip, worktree
			? path ? localize('voltAgent.status.worktreeAt', "Runs in a worktree: {0}", path) : localize('voltAgent.status.worktreeTooltip', "Runs in a worktree")
			: localize('voltAgent.env.localTooltip', "Runs in your checkout"));
	}

	/**
	 * Resting state keeps the git mark. Hover swaps it for copy, and a click confirms with a check.
	 * The click copies the branch name; it does not open a checkout menu.
	 */
	private paintBranchIcon(): void {
		const offeringCopy = !!this.copyText && this.branchHover && !this.branchCopied;
		const icon = this.branchCopied ? Codicon.check : offeringCopy ? Codicon.copy : Codicon.gitBranch;
		this.branchIcon.className = ThemeIcon.asClassName(icon);
		const { name, detached } = this.host.getBranch();
		const label = this.branchCopied
			? localize('voltAgent.copiedBranchName', "Copied branch name to clipboard")
			: offeringCopy
				? localize('voltAgent.copyBranchName', "Copy branch name")
				: name
					? localize('voltAgent.branchName', "Branch: {0}", name)
					: detached
						? localize('voltAgent.detachedTooltip', "Detached at {0}", detached)
						: localize('voltAgent.noRepository', "No git repository");
		this.branchButton.setAttribute('aria-label', label);
		setAgentTooltip(this.branchButton, label);
	}

	private async copyBranchName(): Promise<void> {
		const text = this.copyText;
		if (!text) {
			return;
		}
		try {
			await this.clipboardService.writeText(text);
		} catch {
			return;
		}
		if (this._store.isDisposed || this.copyText !== text) {
			return;
		}
		this.branchCopied = true;
		this.paintBranchIcon();
		this.notificationService.info(localize('voltAgent.copiedBranchName', "Copied branch name to clipboard"));
		this.branchCopiedTimer.value = disposableTimeout(() => {
			this.branchCopied = false;
			this.paintBranchIcon();
		}, 1200);
	}

	private async refreshOverhead(): Promise<void> {
		const gen = ++this.overheadGen;
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		let home;
		try {
			home = await this.pathService.userHome();
		} catch {
			home = undefined;
		}
		// Of what plugins ship, only their skills reach the agent's context.
		const items = (await this.scanner.scan(folders, home)).filter(item => !item.plugin || item.kind === 'skill');
		if (gen !== this.overheadGen) {
			return;
		}
		this.overhead = overheadFromCustomizations(items, this.hostTools.listTools(), this.host.getUsageInput().nativeAgent);
		this.refresh();
	}

	hidePanel(): void {
		if (!this.open) {
			return;
		}
		this.panelStore.clear();
		this.panelEl?.remove();
		this.panelEl = undefined;
		this.popup = undefined;
		this.open = false;
		this.contextButton.setAttribute('aria-expanded', 'false');
	}

	private togglePanel(): void {
		if (this.open) {
			this.hidePanel();
			return;
		}
		this.showPanel();
	}

	private showPanel(): void {
		if (this.open) {
			this.refresh();
			return;
		}
		this.host.onWillOpenPanel?.();
		this.hideSessionPanel();
		this.panelStore.clear();
		this.panelEl?.remove();
		this.open = true;
		void this.refreshOverhead();

		const panel = $('.volt-agent-context-panel');
		this.panelEl = panel;
		const { parent, before } = this.host.getPanelAnchor();
		parent.insertBefore(panel, before);

		const header = append(panel, $('.volt-agent-context-header'));
		append(header, $('span.title')).textContent = localize('voltAgent.contextUsageTitle', "Context Usage");
		const close = append(header, $('button.close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltAgent.contextClose', "Close"));
		close.appendChild(renderIcon(Codicon.close));
		this.panelStore.add(addDisposableListener(close, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.hidePanel();
		}));

		const summary = append(panel, $('.volt-agent-context-summary'));
		const bar = append(panel, $('.volt-agent-context-bar'));
		const list = append(panel, $('.volt-agent-context-list'));

		const compact = append(panel, $('button.volt-agent-context-compact')) as HTMLButtonElement;
		compact.type = 'button';
		compact.appendChild(createCompactIcon(compact.ownerDocument));
		const compactLabel = append(compact, $('span'));
		const compactNote = append(panel, $('.volt-agent-context-compact-note'));
		this.panelStore.add(addDisposableListener(compact, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (compact.disabled) {
				return;
			}
			this.host.compact?.();
			this.hidePanel();
		}));

		this.popup = {
			percent: append(summary, $('span.full')),
			tokens: append(summary, $('span.tokens')),
			bar,
			list,
			compact,
			compactLabel,
			compactNote,
		};
		this.fillPopup(this.popup, this.snapshot());

		this.panelStore.add(addDisposableListener(getWindow(panel).document, 'mousedown', e => {
			if (!(e.target instanceof Node)) {
				return;
			}
			if (panel.contains(e.target) || this.contextButton.contains(e.target)) {
				return;
			}
			this.hidePanel();
		}, true));
		this.panelStore.add(addDisposableListener(getWindow(panel), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hidePanel();
			}
		}));
		this.panelStore.add(toDisposable(() => {
			panel.remove();
			if (this.panelEl === panel) {
				this.panelEl = undefined;
				this.popup = undefined;
				this.open = false;
				this.contextButton.setAttribute('aria-expanded', 'false');
			}
		}));
		this.contextButton.setAttribute('aria-expanded', 'true');
	}

	private sessionOptions(): ISessionUsageOptions {
		return {
			rates: id => this.rates.get(id) ?? undefined,
			describe: ref => this.host.describeModel?.(ref),
			fallbackModel: this.host.getSessionModel?.(),
		};
	}

	private sessionSummary(): ISessionUsageSummary | undefined {
		const messages = this.host.getSessionMessages?.();
		if (!messages) {
			return undefined;
		}
		const options = this.sessionOptions();
		this.loadRates(sessionModelIds(messages, options));
		return buildSessionUsage(messages, options);
	}

	/** Asks the usage service (main process, LiteLLM's list) for prices not seen yet, then repaints. */
	private loadRates(ids: readonly string[]): void {
		const missing = ids.filter(id => !this.rates.has(id) && !this.ratesPending.has(id));
		if (!missing.length) {
			return;
		}
		const usage = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltUsageService));
		if (!usage) {
			missing.forEach(id => this.rates.set(id, null));
			return;
		}
		missing.forEach(id => this.ratesPending.add(id));
		usage.getModelRates(missing).then(rates => {
			for (const id of missing) {
				this.rates.set(id, rates[id] ?? null);
			}
		}, () => {
			missing.forEach(id => this.rates.set(id, null));
		}).finally(() => {
			missing.forEach(id => this.ratesPending.delete(id));
			if (!this._store.isDisposed) {
				this.refresh();
			}
		});
	}

	/** The chart button beside the meter: the session's cost when it has one. */
	private refreshSession(hasChat: boolean): void {
		const summary = hasChat ? this.sessionSummary() : undefined;
		const show = !!summary && summary.turns.length > 0;
		this.sessionButton.hidden = !show;
		if (!summary || !show) {
			this.hideSessionPanel();
			return;
		}
		const priced = summary.turns.length > summary.unpricedTurns;
		this.sessionLabel.textContent = priced ? formatCost(summary.costUsd) : '';
		this.sessionLabel.hidden = !priced;
		const tokens = formatContextTokens(summary.total);
		const detail = priced
			? localize('voltAgent.sessionUsage.button', "Session usage: {0} tokens · {1}", tokens, formatCost(summary.costUsd))
			: localize('voltAgent.sessionUsage.buttonTokens', "Session usage: {0} tokens", tokens);
		this.sessionButton.setAttribute('aria-label', detail);
		this.sessionButton.setAttribute('aria-expanded', String(!!this.sessionPanel));
		setAgentTooltip(this.sessionButton, detail);
		this.sessionPanel?.update(summary);
	}

	/** Closes whichever card is open: Context Usage or Session Usage. */
	hidePanels(): void {
		this.hidePanel();
		this.hideSessionPanel();
	}

	hideSessionPanel(): void {
		if (!this.sessionPanel) {
			return;
		}
		this.sessionStore.clear();
	}

	private showSessionPanel(): void {
		const summary = this.sessionSummary();
		if (!summary) {
			return;
		}
		this.host.onWillOpenPanel?.();
		this.hidePanel();
		this.sessionStore.clear();

		const panelEl = $('.volt-agent-context-panel');
		const { parent, before } = this.host.getPanelAnchor();
		parent.insertBefore(panelEl, before);
		const panel = this.sessionStore.add(new AgentSessionUsagePanel(panelEl, {
			close: () => this.hideSessionPanel(),
			revealTurn: turnId => this.host.revealTurn?.(turnId),
		}));
		this.sessionPanel = panel;
		this.sessionPanelEl = panelEl;
		panel.update(summary);

		this.sessionStore.add(addDisposableListener(getWindow(panelEl).document, 'mousedown', e => {
			if (!(e.target instanceof Node) || panelEl.contains(e.target) || this.sessionButton.contains(e.target)) {
				return;
			}
			this.hideSessionPanel();
		}, true));
		this.sessionStore.add(addDisposableListener(getWindow(panelEl), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hideSessionPanel();
			}
		}));
		this.sessionStore.add(toDisposable(() => {
			panelEl.remove();
			if (this.sessionPanelEl === panelEl) {
				this.sessionPanelEl = undefined;
				this.sessionPanel = undefined;
				this.sessionButton.setAttribute('aria-expanded', 'false');
			}
		}));
		this.sessionButton.setAttribute('aria-expanded', 'true');
	}

	private fillPopup(popup: IContextPopupRefs, snapshot: IContextUsageSnapshot): void {
		popup.percent.textContent = formatContextFullLabel(snapshot.percent);
		popup.tokens.textContent = formatContextWindowLabel(snapshot.used, snapshot.limit);

		popup.bar.replaceChildren();
		for (const item of snapshot.items) {
			const segment = append(popup.bar, $('.segment'));
			segment.style.background = item.color;
			segment.style.flexGrow = String(Math.max(item.tokens, 1));
			segment.title = `${item.label} · ${formatContextTokens(item.tokens)}`;
		}
		const unused = Math.max(0, snapshot.limit - snapshot.used);
		if (unused > 0 || snapshot.used === 0) {
			const rest = append(popup.bar, $('.segment.unused'));
			rest.style.flexGrow = String(Math.max(unused, 1));
		}

		popup.list.replaceChildren();
		for (const item of snapshot.items) {
			const row = append(popup.list, $('.row'));
			const swatch = append(row, $('span.swatch'));
			swatch.style.background = item.color;
			append(row, $('span.label')).textContent = item.label;
			append(row, $('span.count')).textContent = formatContextTokens(item.tokens);
		}

		const compactState = this.host.compact ? this.host.getCompactState?.() : undefined;
		popup.compact.hidden = !compactState;
		popup.compact.disabled = !!compactState?.blockedReason;
		popup.compact.classList.toggle('running', !!compactState?.running);
		popup.compactLabel.textContent = compactState?.running
			? localize('voltAgent.compaction.running', "Compacting context")
			: localize('voltAgent.compactContext', "Compact context");
		// While it runs the button says so; the note is for why it cannot start.
		const note = compactState?.running ? undefined : compactState?.blockedReason;
		popup.compactNote.hidden = !note;
		popup.compactNote.textContent = note ?? '';
	}

	private createRing(parent: HTMLElement): SVGCircleElement {
		const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('aria-hidden', 'true');
		const track = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		track.setAttribute('cx', '10');
		track.setAttribute('cy', '10');
		track.setAttribute('r', String(RING_RADIUS));
		track.setAttribute('fill', 'none');
		track.setAttribute('stroke-width', '2.4');
		track.classList.add('track');
		const fill = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		fill.setAttribute('cx', '10');
		fill.setAttribute('cy', '10');
		fill.setAttribute('r', String(RING_RADIUS));
		fill.setAttribute('fill', 'none');
		fill.setAttribute('stroke-width', '2.4');
		fill.setAttribute('stroke-linecap', 'round');
		fill.setAttribute('transform', 'rotate(-90 10 10)');
		fill.classList.add('fill');
		svg.appendChild(track);
		svg.appendChild(fill);
		parent.appendChild(svg);
		return fill;
	}

}

const SVG_NS = 'http://www.w3.org/2000/svg';

function statusIcon(doc: Document, paths: readonly string[], circles: readonly [number, number, number][] = []): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
		svg.setAttribute(key, value);
	}
	for (const d of paths) {
		const path = doc.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	for (const [cx, cy, r] of circles) {
		const circle = doc.createElementNS(SVG_NS, 'circle');
		circle.setAttribute('cx', String(cx));
		circle.setAttribute('cy', String(cy));
		circle.setAttribute('r', String(r));
		svg.appendChild(circle);
	}
	return svg;
}

/** Aria Icons `lucide:fold-vertical`: the conversation folding toward its middle. */
export function createCompactIcon(doc: Document): SVGSVGElement {
	const svg = statusIcon(doc, ['M12 22v-6', 'M12 8V2', 'M4 12H2', 'M10 12H8', 'M16 12h-2', 'M22 12h-2', 'm15 19-3-3-3 3', 'm15 5-3 3-3-3']);
	svg.setAttribute('stroke-width', '1.75');
	return svg;
}

/** A folder with a branch: the project's own checkout. */
function createLocalIcon(doc: Document): SVGSVGElement {
	const svg = statusIcon(doc, [
		'M18 19a5 5 0 0 1-5-5v8',
		'M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5',
	], [[13, 12, 2], [20, 19, 2]]);
	svg.setAttribute('stroke-width', '1.5');
	return svg;
}

/** Two tracks splitting off, mirrored so the branch leaves to the left. */
function createWorktreeIcon(doc: Document): SVGSVGElement {
	const svg = statusIcon(doc, ['M6 7C6 8.10457 5.10457 9 4 9C2.89543 9 2 8.10457 2 7C2 5.89543 2.89543 5 4 5C5.10457 5 6 5.89543 6 7ZM6 7H18M18 7C18 8.10457 18.8954 9 20 9C21.1046 9 22 8.10457 22 7C22 5.89543 21.1046 5 20 5C18.8954 5 18 5.89543 18 7ZM18 17C18 18.1046 18.8954 19 20 19C21.1046 19 22 18.1046 22 17C22 15.8954 21.1046 15 20 15C18.8954 15 18 15.8954 18 17ZM18 17H12C10.8954 17 10 16.1046 10 15V10C10 8.34315 8.65685 7 7 7']);
	svg.style.transform = 'scaleX(-1)';
	return svg;
}

interface IContextPopupRefs {
	percent: HTMLElement;
	tokens: HTMLElement;
	bar: HTMLElement;
	list: HTMLElement;
	compact: HTMLButtonElement;
	compactLabel: HTMLElement;
	compactNote: HTMLElement;
}
