/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSubagents.css';
import { $, addDisposableListener, append, getWindow, isHTMLButtonElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { buildTaskPrompt, modeForTaskRole, newTaskId } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import type { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { formatElapsed, IOrchAgentRow, OrchAgentRowState } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { AGENT_HOME_NEW_CHAT_ICON_PATH, createHomeStatusBadgeIcon } from '../home/agentHomeIcons.js';
import { AgentTooltip, IAgentTooltipRow } from './agentTooltip.js';

/**
 * Subagents as Volt draws them everywhere (the card above the composer, the transcript, the dock
 * beside the chat): an avatar with the harness's mark and a status dot, the title, the model in a
 * quieter tone, the step it is on, and a live clock. One look, whichever harness runs it.
 */

export interface ISubagentView {
	/** Task id (Volt or harness), or the tool call id when no task is known. */
	readonly key: string;
	readonly title: string;
	readonly modelLabel?: string;
	/** Provider id for the avatar's mark (claude, cursor, codex, ...). */
	readonly providerId?: string;
	/** Harness subagent type, as a label ("Explorer"). */
	readonly kindLabel?: string;
	readonly state: OrchAgentRowState;
	readonly stateLabel: string;
	readonly detail?: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly openable: boolean;
	readonly cancellable: boolean;
	/** A live harness subagent: its Stop stops the agent turn that runs it. */
	readonly stopsTurn?: boolean;
	/** A multitask agent: work the user asked to run in parallel; its chat takes follow-ups and edits. */
	readonly multitask?: boolean;
	/** Its chat is watched, not driven (a subagent): only the agent that delegated it sends its rounds. */
	readonly readOnly?: boolean;
	readonly source: 'volt' | 'harness';
}

/** A Volt agent that ended before finishing (failed, stopped, cut off): Resume continues its task. The harness's own cannot be. */
export function isResumableSubagent(view: Pick<ISubagentView, 'source' | 'state'>): boolean {
	return view.source === 'volt' && (view.state === 'failed' || view.state === 'cancelled' || view.state === 'interrupted');
}

const RESUME_PROMPT = '[Volt] The user resumed you. Your previous run ended before it finished (it failed, was stopped or was cut off). Continue where you left off: check what is already done (files, git status, command output) before redoing anything, then finish the work and end with your report as before.';

/**
 * Resume on a stopped agent: one more round of its task in its own chat, briefed to continue. The
 * task runs again and its new report goes to the parent. False when the orchestrator refused it.
 */
export async function resumeSubagentTask(orchestrator: IAgentOrchestratorService, taskId: string): Promise<boolean> {
	const task = orchestrator.getTask(taskId);
	if (!task?.childId) {
		return false;
	}
	await orchestrator.ensureThreadLoaded(task.childId);
	const events = await orchestrator.dispatch({
		type: 'task.message',
		taskId,
		turnId: generateUuid(),
		prompt: { text: RESUME_PROMPT, display: { text: localize('voltAgent.subagent.resumeDisplay', "Resume") } },
	});
	return events.length > 0;
}

/** A subagent that ended before finishing: its chat offers Retry. */
export function isRetryableSubagentState(state: string): boolean {
	return state === 'failed' || state === 'cancelled' || state === 'interrupted';
}

const RETRY_NOTE = '[Volt] This is a retry. An earlier attempt at this task ended before it finished. Check what is already done (files, git status, command output) before redoing anything, then finish the work and end with your report.';

/**
 * Retry on a harness subagent (Claude's or Codex's own, Cursor's Task) that failed. The harness
 * cannot run one again by itself, so the same brief goes to a new Volt subagent of the same parent,
 * on the parent's model; its report wakes the parent as any subagent's does. Returns the new task's
 * id (the earlier retry's, when this one was retried already), or undefined when it was refused.
 */
export async function retryHarnessSubagent(orchestrator: IAgentOrchestratorService, taskId: string): Promise<string | undefined> {
	const task = orchestrator.getTask(taskId);
	const brief = task?.brief.trim();
	if (!task || task.source !== 'harness' || !brief) {
		return undefined;
	}
	await orchestrator.ensureThreadLoaded(task.parentId);
	const parent = orchestrator.getThread(task.parentId);
	const mode = modeForTaskRole(task.role, undefined);
	const clientRequestId = `retry:${task.id}`;
	const retryId = newTaskId(id => !!orchestrator.getTask(id));
	await orchestrator.dispatch({
		type: 'task.spawn',
		spawn: {
			parentId: task.parentId,
			brief,
			title: task.title,
			role: task.role,
			origin: 'agent',
			isolation: task.isolation,
			taskId: retryId,
			childId: `agent-${generateUuid()}`,
			mode,
			...(parent?.modelRef ? { modelRef: parent.modelRef, modelLabel: parent.modelLabel ?? parent.modelRef } : {}),
			clientRequestId,
			childPrompt: {
				text: `${buildTaskPrompt(brief, { parentTitle: parent?.title, role: task.role, depth: (parent?.depth ?? 0) + 1, isolation: task.isolation })}\n\n${RETRY_NOTE}`,
				display: { text: brief, brief: true },
				mode,
				...(parent?.modelRef ? { modelRef: parent.modelRef } : {}),
			},
		},
	});
	if (orchestrator.getTask(retryId)) {
		return retryId;
	}
	return Object.values(orchestrator.getState().tasks).find(other => other.parentId === task.parentId && other.clientRequestId === clientRequestId)?.id;
}

/** How many agents of a list are live, by kind: the composer chip and the dock headings. */
export interface ISubagentCounts {
	/** Multitask agents queued, running or waiting. */
	readonly multitask: number;
	/** Subagents (Volt or the harness's own) queued, running or waiting. */
	readonly subagents: number;
	/** Of those, the ones blocked on an approval or an answer. */
	readonly waiting: number;
	readonly queued: number;
}

export function subagentCounts(views: readonly Pick<ISubagentView, 'state' | 'multitask'>[]): ISubagentCounts {
	let multitask = 0;
	let subagents = 0;
	let waiting = 0;
	let queued = 0;
	for (const view of views) {
		if (!isLiveSubagentState(view.state)) {
			continue;
		}
		if (view.multitask) {
			multitask++;
		} else {
			subagents++;
		}
		if (view.state === 'waiting') {
			waiting++;
		} else if (view.state === 'queued') {
			queued++;
		}
	}
	return { multitask, subagents, waiting, queued };
}

/** "3 multitasks running", "2 subagents running", "3 multitasks · 2 subagents": the chip's words. */
export function subagentCountsLabel(counts: ISubagentCounts): string {
	const { multitask, subagents } = counts;
	if (multitask && subagents) {
		return localize('voltAgent.agents.mixed', "{0} · {1}",
			multitask === 1 ? localize('voltAgent.agents.oneMultitask', "1 multitask") : localize('voltAgent.agents.multitasks', "{0} multitasks", multitask),
			subagents === 1 ? localize('voltAgent.agents.oneSubagent', "1 subagent") : localize('voltAgent.agents.subagents', "{0} subagents", subagents));
	}
	if (multitask) {
		return multitask === 1 ? localize('voltAgent.agents.oneMultitaskRunning', "1 multitask running") : localize('voltAgent.agents.multitasksRunning', "{0} multitasks running", multitask);
	}
	return subagents === 1 ? localize('voltAgent.agents.oneSubagentRunning', "1 subagent running") : localize('voltAgent.agents.subagentsRunning', "{0} subagents running", subagents);
}

export function isLiveSubagentState(state: OrchAgentRowState): boolean {
	return state === 'running' || state === 'waiting' || state === 'queued';
}

export function subagentKindLabel(kind: string | undefined): string | undefined {
	if (!kind || kind.startsWith('codex:')) {
		return undefined;
	}
	const known: Record<string, string> = { explore: 'Explorer', generalPurpose: 'General', 'general-purpose': 'General', plan: 'Planner', research: 'Research', review: 'Review' };
	return known[kind] ?? kind.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** "Review round 2": a task delegated again after changes, in the place of the harness kind. */
export function subagentRoundLabel(row: Pick<IOrchAgentRow, 'iteration' | 'role'>): string | undefined {
	if (!row.iteration || row.iteration < 2) {
		return undefined;
	}
	return row.role === 'review'
		? localize('voltAgent.subagent.reviewRound', "Review round {0}", row.iteration)
		: localize('voltAgent.subagent.round', "Round {0}", row.iteration);
}

export function subagentView(row: IOrchAgentRow, providerFor: (modelRef: string | undefined) => string | undefined): ISubagentView {
	const kindLabel = subagentRoundLabel(row) ?? subagentKindLabel(row.kind);
	return {
		key: row.taskId,
		title: row.title,
		...(row.modelLabel ? { modelLabel: row.modelLabel } : {}),
		...(providerFor(row.modelRef) ? { providerId: providerFor(row.modelRef) } : {}),
		...(kindLabel ? { kindLabel } : {}),
		state: row.state,
		stateLabel: row.stateLabel,
		...(row.detail ? { detail: row.detail } : {}),
		...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
		...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
		openable: row.openable,
		cancellable: row.cancellable,
		...(row.stopsTurn ? { stopsTurn: true } : {}),
		multitask: row.multitask,
		readOnly: row.readOnly,
		source: row.source,
	};
}

/** The clock beside a row: live rows tick (see `tickSubagentClocks`). */
function elapsedText(view: Pick<ISubagentView, 'startedAt' | 'endedAt'>, now: number): string {
	return view.startedAt === undefined ? '' : formatElapsed((view.endedAt ?? now) - view.startedAt);
}

/** The harness mark in a round avatar, with the status dot in its corner. */
export function renderSubagentAvatar(parent: HTMLElement, view: Pick<ISubagentView, 'providerId' | 'state' | 'source' | 'multitask'>, size = 28): HTMLElement {
	const avatar = append(parent, $('span.volt-subagent-avatar'));
	avatar.style.setProperty('--volt-subagent-avatar', `${size}px`);
	avatar.classList.add(`state-${view.state}`);
	if (view.providerId) {
		avatar.appendChild(createBrandIcon(view.providerId, Math.round(size * 0.58)));
	} else {
		avatar.appendChild(renderIcon(view.multitask ? Codicon.layers : Codicon.hubot));
	}
	append(avatar, $('span.volt-subagent-dot'));
	return avatar;
}

export interface ISubagentRowOptions {
	readonly store: DisposableStore;
	readonly now: number;
	readonly tooltip?: AgentTooltip;
	readonly onOpen?: (view: ISubagentView) => void;
	readonly onStop?: (view: ISubagentView) => void;
	/** Shown on a stopped Volt agent (see `isResumableSubagent`). */
	readonly onResume?: (view: ISubagentView) => void;
	/** Draws text that the chat's find widget can search. */
	readonly setText?: (el: HTMLElement, text: string) => void;
	/** Compact: one line (title and state), no step line. */
	readonly compact?: boolean;
	/** Drawn instead of the state mark (a report row shows the stack icon). */
	readonly mark?: () => Node;
}

/** One subagent row: avatar · title + state · model, the step under it, the clock and an open chevron. */
export function renderSubagentRow(parent: HTMLElement, view: ISubagentView, options: ISubagentRowOptions): HTMLElement {
	const row = append(parent, $(view.openable ? 'button.volt-subagent-row' : 'div.volt-subagent-row')) as HTMLElement;
	if (isHTMLButtonElement(row)) {
		row.type = 'button';
	}
	row.dataset.subagent = view.key;
	row.classList.add(`state-${view.state}`);
	row.classList.toggle('openable', view.openable);
	row.classList.toggle('compact', !!options.compact);
	renderSubagentAvatar(row, view, options.compact ? 20 : 28);
	const text = append(row, $('span.volt-subagent-text'));
	const head = append(text, $('span.volt-subagent-head'));
	const title = append(head, $('span.volt-subagent-title'));
	(options.setText ?? setText)(title, view.title);
	if (view.kindLabel) {
		append(head, $('span.volt-subagent-kind')).textContent = view.kindLabel;
	}
	const state = append(head, $('span.volt-subagent-state'));
	state.textContent = view.stateLabel;
	if (!options.compact) {
		const sub = append(text, $('span.volt-subagent-detail'));
		const detail = view.detail ?? (view.modelLabel ?? '');
		(options.setText ?? setText)(sub, detail);
		sub.classList.toggle('shimmer', view.state === 'running');
	}
	const tail = append(row, $('span.volt-subagent-tail'));
	const clock = append(tail, $('span.volt-subagent-clock'));
	if (view.startedAt !== undefined) {
		clock.dataset.startedAt = String(view.startedAt);
		if (view.endedAt !== undefined) {
			clock.dataset.endedAt = String(view.endedAt);
		}
	}
	clock.textContent = elapsedText(view, options.now);
	if (view.cancellable && options.onStop) {
		const stop = append(tail, $('span.volt-subagent-stop')) as HTMLElement;
		stop.setAttribute('role', 'button');
		stop.setAttribute('aria-label', localize('voltAgent.subagent.stop', "Stop subagent"));
		stop.appendChild(renderIcon(Codicon.debugStop));
		options.store.add(addDisposableListener(stop, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onStop!(view);
		}));
	}
	if (view.openable) {
		append(tail, $('span.volt-subagent-chevron')).appendChild(renderIcon(Codicon.chevronRight));
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onOpen?.(view);
		}));
	}
	bindSubagentHover(row, view, options);
	return row;
}

/** The hover card over a row; a click on the card opens the subagent like the row does. */
function bindSubagentHover(row: HTMLElement, view: ISubagentView, options: ISubagentRowOptions): void {
	if (!options.tooltip) {
		return;
	}
	const onOpen = view.openable ? options.onOpen : undefined;
	options.store.add(options.tooltip.bind(row, () => subagentHoverRows(view, Date.now()), { placement: 'above', variant: 'card', delay: 450, ...(onOpen ? { onClick: () => onOpen(view) } : {}) }));
}

/** The hover card: title, model with its mark, status with the clock, the current step. */
export function subagentHoverRows(view: ISubagentView, now: number): IAgentTooltipRow[] {
	const rows: IAgentTooltipRow[] = [{ label: view.title }];
	if (view.modelLabel) {
		rows.push({ label: view.modelLabel, ...(view.providerId ? { icon: () => createBrandIcon(view.providerId!, 14) } : { icon: Codicon.hubot }) });
	}
	const elapsed = elapsedText(view, now);
	// Running: the left sidebar's working ring (spun in agentHomePane.css), not the codicon arc.
	const stateIcon = view.state === 'running' ? () => createHomeStatusBadgeIcon('working') : subagentStateIcon(view.state);
	rows.push({ label: view.stateLabel, ...(elapsed ? { detail: elapsed } : {}), icon: stateIcon });
	if (view.detail) {
		rows.push({ label: view.detail, icon: Codicon.terminal, muted: true });
	}
	if (view.openable) {
		rows.push({
			label: view.readOnly
				? localize('voltAgent.subagent.watchHint', "Click to watch its chat beside this one (read only)")
				: localize('voltAgent.subagent.openFollowUpHint', "Click to open its chat beside this one and send follow-ups"),
			muted: true,
		});
	} else if (view.stopsTurn) {
		rows.push({ label: localize('voltAgent.subagent.harnessHint', "Runs inside the agent's turn; stopping it stops that turn"), muted: true });
	}
	return rows;
}

/** The state as a codicon: a spinner while it works, a bell when it needs the user, a check when done. */
export function subagentStateIcon(state: OrchAgentRowState) {
	switch (state) {
		case 'running': return Codicon.loading;
		case 'waiting': return Codicon.bellDot;
		case 'queued': return Codicon.clock;
		case 'completed': return Codicon.check;
		case 'failed': return Codicon.error;
		case 'cancelled': return Codicon.debugStop;
		case 'interrupted': return Codicon.debugDisconnect;
	}
}

/** Subagents started together fold into one header from this many on; fewer stay as plain rows. */
export const SUBAGENT_GROUP_MIN = 4;

/** Avatars in a group header, the last place taken by the "+N" bubble when there are more. */
const GROUP_STACK_MAX = 4;

export interface ISubagentGroupOptions extends ISubagentRowOptions {
	readonly id: string;
	readonly expanded: boolean;
	readonly onToggle: (expanded: boolean) => void;
}

/**
 * Several subagents started together: one header ("3 subagents · 2 working", their marks
 * stacked, the longest clock) and a card with one row each, open by default while they work.
 */
export function renderSubagentGroup(parent: HTMLElement, views: readonly ISubagentView[], options: ISubagentGroupOptions): HTMLElement {
	const group = append(parent, $('.volt-subagent-group'));
	const live = views.filter(view => isLiveSubagentState(view.state));
	group.classList.toggle('live', live.length > 0);
	group.classList.toggle('open', options.expanded);
	const head = append(group, $('button.volt-subagent-group-head')) as HTMLButtonElement;
	head.type = 'button';
	head.setAttribute('aria-expanded', String(options.expanded));
	const stack = append(head, $('span.volt-subagent-stack'));
	const shown = views.length > GROUP_STACK_MAX ? GROUP_STACK_MAX - 1 : views.length;
	for (const view of views.slice(0, shown)) {
		renderSubagentAvatar(stack, view, 28);
	}
	if (views.length > shown) {
		append(stack, $('span.volt-subagent-more')).textContent = `+${views.length - shown}`;
	}
	const text = append(head, $('span.volt-subagent-group-text'));
	append(text, $('span.volt-subagent-group-title')).textContent = views.length === 1
		? localize('voltAgent.subagents.one', "1 subagent")
		: localize('voltAgent.subagents.many', "{0} subagents", views.length);
	const summary = append(text, $('span.volt-subagent-group-summary'));
	summary.textContent = groupSummary(views);
	summary.classList.toggle('live', live.length > 0);
	const tail = append(head, $('span.volt-subagent-tail'));
	const clock = append(tail, $('span.volt-subagent-clock'));
	const started = views.map(view => view.startedAt).filter((at): at is number => at !== undefined);
	if (started.length) {
		const first = Math.min(...started);
		clock.dataset.startedAt = String(first);
		const ended = views.every(view => view.endedAt !== undefined) ? Math.max(...views.map(view => view.endedAt!)) : undefined;
		if (ended !== undefined) {
			clock.dataset.endedAt = String(ended);
		}
		clock.textContent = formatElapsed((ended ?? options.now) - first);
	}
	append(tail, $('span.volt-subagent-group-chevron')).appendChild(renderIcon(options.expanded ? Codicon.chevronUp : Codicon.chevronDown));
	options.store.add(addDisposableListener(head, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		options.onToggle(!options.expanded);
	}));
	if (options.expanded) {
		const card = append(group, $('.volt-subagent-card'));
		for (const view of views) {
			renderSubagentRow(card, view, options);
		}
	}
	return group;
}

/** "3 working", "2 working · 1 needs input", "3 done", "2 done · 1 failed". */
export function groupSummary(views: readonly Pick<ISubagentView, 'state'>[]): string {
	const count = (states: readonly OrchAgentRowState[]) => views.filter(view => states.includes(view.state)).length;
	const parts: string[] = [];
	const working = count(['running']);
	const waiting = count(['waiting']);
	const queued = count(['queued']);
	const done = count(['completed']);
	const failed = count(['failed']);
	const stopped = count(['cancelled', 'interrupted']);
	if (working) {
		parts.push(localize('voltAgent.subagents.working', "{0} working", working));
	}
	if (waiting) {
		parts.push(localize('voltAgent.subagents.waiting', "{0} needs input", waiting));
	}
	if (queued) {
		parts.push(localize('voltAgent.subagents.queued', "{0} queued", queued));
	}
	if (done) {
		parts.push(localize('voltAgent.subagents.done', "{0} done", done));
	}
	if (failed) {
		parts.push(localize('voltAgent.subagents.failed', "{0} failed", failed));
	}
	if (stopped) {
		parts.push(localize('voltAgent.subagents.stopped', "{0} stopped", stopped));
	}
	return parts.join(' · ');
}

/**
 * Ticks every live clock under `root` once a second (`data-started-at` without `data-ended-at`),
 * without redrawing the rows. Stops on its own when none is left.
 */
export function tickSubagentClocks(root: HTMLElement, store: DisposableStore): void {
	const win = getWindow(root);
	let handle: number | undefined;
	const tick = () => {
		handle = undefined;
		const clocks = root.querySelectorAll<HTMLElement>('.volt-subagent-clock[data-started-at]:not([data-ended-at])');
		if (!clocks.length) {
			return;
		}
		const now = Date.now();
		for (const clock of clocks) {
			const text = formatElapsed(now - Number(clock.dataset.startedAt));
			if (clock.textContent !== text) {
				clock.textContent = text;
			}
		}
		handle = win.setTimeout(tick, 1000);
	};
	handle = win.setTimeout(tick, 1000);
	store.add(toDisposable(() => {
		if (handle !== undefined) {
			win.clearTimeout(handle);
		}
	}));
}

function setText(el: HTMLElement, text: string): void {
	el.textContent = text;
}

//#region Cursor look

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The stack mark on a subagent report row: three layers, drawn with a 1px line. */
export function createReportStackIcon(owner: HTMLElement): SVGSVGElement {
	const svg = owner.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-subagent-report-icon');
	for (const d of ['M12 3 3 7.5 12 12l9-4.5L12 3Z', 'M3 12l9 4.5 9-4.5', 'M3 16.5 12 21l9-4.5']) {
		const path = owner.ownerDocument.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1');
		path.setAttribute('vector-effect', 'non-scaling-stroke');
		path.setAttribute('stroke-linejoin', 'round');
		path.setAttribute('stroke-linecap', 'round');
		svg.appendChild(path);
	}
	return svg;
}

/** The New Chat paper plane, before each running subagent in the card above the composer and in the agents menu. */
export function createPlaneIcon(owner: HTMLElement): SVGSVGElement {
	const svg = owner.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-subagent-plane');
	const path = owner.ownerDocument.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', AGENT_HOME_NEW_CHAT_ICON_PATH);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.25');
	path.setAttribute('stroke-linejoin', 'round');
	path.setAttribute('stroke-linecap', 'round');
	svg.appendChild(path);
	return svg;
}

/**
 * Cursor's running-subagent loader (DotGridLoader, "sine_3x3", xs): nine dots on a 4-unit grid in a
 * 10.5-unit box, drawn at 10px. agentSubagents.css steps them through Cursor's eight frames.
 */
export function createDotGridLoader(owner: HTMLElement): HTMLElement {
	const root = $('span.volt-dot-grid');
	root.setAttribute('aria-hidden', 'true');
	const svg = owner.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 10.5 10.5');
	for (let index = 0; index < 9; index++) {
		const dot = owner.ownerDocument.createElementNS(SVG_NS, 'circle');
		dot.setAttribute('cx', String(1.25 + (index % 3) * 4));
		dot.setAttribute('cy', String(1.25 + Math.floor(index / 3) * 4));
		dot.setAttribute('r', '1.125');
		svg.appendChild(dot);
	}
	root.appendChild(svg);
	return root;
}

/** Cursor's mark for a subagent's state: the dot grid while it works, else a dot (grey done, yellow needs you, red failed). */
export function subagentStateMark(owner: HTMLElement, view: Pick<ISubagentView, 'state'>): Node {
	if (view.state === 'running' || view.state === 'queued') {
		return createDotGridLoader(owner);
	}
	return $(`span.volt-subagent-state-dot.state-${view.state}`);
}

/**
 * A subagent in the transcript, as Cursor draws it: the dots, its title, its model or type in the
 * quieter tone, and under it the step it is on (shimmering while it works) or how it ended.
 */
export function renderCursorSubagentRow(parent: HTMLElement, view: ISubagentView, options: ISubagentRowOptions): HTMLElement {
	const live = isLiveSubagentState(view.state);
	const row = append(parent, $(view.openable ? 'button.volt-tr-subagent.volt-subagent-cursor' : 'div.volt-tr-subagent.volt-subagent-cursor')) as HTMLElement;
	if (isHTMLButtonElement(row)) {
		row.type = 'button';
	}
	row.dataset.subagent = view.key;
	row.classList.toggle('live', live);
	row.classList.add(`state-${view.state}`);
	const icon = append(row, $('span.volt-tr-subagent-icon'));
	icon.appendChild(options.mark?.() ?? subagentStateMark(row, view));
	const text = append(row, $('span.volt-tr-subagent-text'));
	const head = append(text, $('span.volt-tr-subagent-head'));
	const title = append(head, $('span.volt-tr-subagent-title'));
	title.classList.toggle('shimmer', view.state === 'running');
	(options.setText ?? setText)(title, view.title);
	const secondary = view.modelLabel ?? view.kindLabel;
	if (secondary) {
		(options.setText ?? setText)(append(head, $('span.volt-tr-subagent-type')), secondary);
	}
	const status = append(text, $('span.volt-tr-subagent-status'));
	status.classList.toggle('shimmer', view.state === 'running');
	const line = view.state === 'running' || view.state === 'waiting'
		? (view.state === 'waiting' ? view.stateLabel : view.detail ?? view.stateLabel)
		: view.state === 'completed' ? (view.detail ?? view.stateLabel) : `${view.stateLabel}${view.detail ? ` · ${view.detail}` : ''}`;
	(options.setText ?? setText)(status, line);
	// Cursor: "Stop" at the row's end while it works, shown on hover.
	if (view.cancellable && live && options.onStop) {
		const stop = append(row, $('span.volt-tr-subagent-stop'));
		stop.setAttribute('role', 'button');
		stop.setAttribute('tabindex', '0');
		stop.textContent = localize('voltAgent.subagent.stopShort', "Stop");
		stop.setAttribute('aria-label', localize('voltAgent.subagent.stop', "Stop subagent"));
		const run = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			options.onStop!(view);
		};
		options.store.add(addDisposableListener(stop, 'click', run));
		options.store.add(addDisposableListener(stop, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				run(e);
			}
		}));
	}
	// "Resume" at the row's end once it failed or was stopped: it continues where it ended.
	if (options.onResume && isResumableSubagent(view)) {
		const resume = append(row, $('span.volt-tr-subagent-stop.volt-tr-subagent-resume'));
		resume.setAttribute('role', 'button');
		resume.setAttribute('tabindex', '0');
		resume.textContent = localize('voltAgent.subagent.resume', "Resume");
		resume.setAttribute('aria-label', localize('voltAgent.subagent.resumeHint', "Resume: it continues where it stopped"));
		const run = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			options.onResume!(view);
		};
		options.store.add(addDisposableListener(resume, 'click', run));
		options.store.add(addDisposableListener(resume, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				run(e);
			}
		}));
	}
	if (view.openable) {
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onOpen?.(view);
		}));
	}
	bindSubagentHover(row, view, options);
	return row;
}

/** A subagent in the card above the composer (Cursor): the plane, its title, and a word when it needs you or failed. */
export function renderCursorCardRow(parent: HTMLElement, view: ISubagentView, options: ISubagentRowOptions): HTMLElement {
	const row = append(parent, $(view.openable ? 'button.volt-agent-work-agent' : 'div.volt-agent-work-agent')) as HTMLElement;
	if (isHTMLButtonElement(row)) {
		row.type = 'button';
	}
	row.dataset.subagent = view.key;
	row.classList.add(`state-${view.state}`);
	const icon = append(row, $('span.volt-agent-work-agent-icon'));
	icon.appendChild(view.state === 'running' || view.state === 'queued' ? createPlaneIcon(row) : subagentStateMark(row, view));
	(options.setText ?? setText)(append(row, $('span.volt-agent-work-agent-title')), view.title);
	if (view.state !== 'running') {
		append(row, $('span.volt-agent-work-agent-state')).textContent = view.stateLabel;
	}
	if (view.cancellable && options.onStop) {
		const stop = append(row, $('span.volt-agent-work-agent-stop')) as HTMLElement;
		stop.setAttribute('role', 'button');
		stop.setAttribute('aria-label', localize('voltAgent.subagent.stop', "Stop subagent"));
		stop.appendChild(renderIcon(Codicon.debugStop));
		options.store.add(addDisposableListener(stop, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onStop!(view);
		}));
	}
	if (options.onResume && isResumableSubagent(view)) {
		const resume = append(row, $('span.volt-agent-work-agent-resume')) as HTMLElement;
		resume.setAttribute('role', 'button');
		resume.setAttribute('aria-label', localize('voltAgent.subagent.resumeHint', "Resume: it continues where it stopped"));
		resume.appendChild(renderIcon(Codicon.play));
		append(resume, $('span')).textContent = localize('voltAgent.subagent.resume', "Resume");
		options.store.add(addDisposableListener(resume, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onResume!(view);
		}));
	}
	if (view.openable) {
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onOpen?.(view);
		}));
	}
	bindSubagentHover(row, view, options);
	return row;
}

//#endregion
