/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSubagents.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { formatElapsed, IOrchAgentRow, OrchAgentRowState } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
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
	/** Started from the Multitask composer, not by an agent. */
	readonly multitask?: boolean;
	readonly source: 'volt' | 'harness';
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
		multitask: row.multitask,
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
	if (row instanceof HTMLButtonElement) {
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
	if (options.tooltip) {
		options.store.add(options.tooltip.bind(row, () => subagentHoverRows(view, Date.now()), { placement: 'above', variant: 'card', delay: 450 }));
	}
	return row;
}

/** The hover card: title, model with its mark, status with the clock, the current step. */
export function subagentHoverRows(view: ISubagentView, now: number): IAgentTooltipRow[] {
	const rows: IAgentTooltipRow[] = [{ label: view.title }];
	if (view.modelLabel) {
		rows.push({ label: view.modelLabel, ...(view.providerId ? { icon: () => createBrandIcon(view.providerId!, 14) } : { icon: Codicon.hubot }) });
	}
	const elapsed = elapsedText(view, now);
	rows.push({ label: view.stateLabel, ...(elapsed ? { detail: elapsed } : {}), icon: stateIcon(view.state) });
	if (view.detail) {
		rows.push({ label: view.detail, icon: Codicon.terminal, muted: true });
	}
	if (view.openable) {
		rows.push({ label: localize('voltAgent.subagent.openHint', "Click to open its chat beside this one"), muted: true });
	}
	return rows;
}

function stateIcon(state: OrchAgentRowState) {
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
	for (const view of views.slice(0, 4)) {
		renderSubagentAvatar(stack, view, 28);
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

/** The outline paper plane Cursor puts before each running subagent in the card above the composer. */
export function createPlaneIcon(owner: HTMLElement): SVGSVGElement {
	const svg = owner.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-subagent-plane');
	const path = owner.ownerDocument.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', 'M3.5 4.5 20.5 12 3.5 19.5 6.5 12 3.5 4.5ZM6.5 12H12');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.4');
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
	if (row instanceof HTMLButtonElement) {
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
	if (view.openable) {
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onOpen?.(view);
		}));
	}
	if (options.tooltip) {
		options.store.add(options.tooltip.bind(row, () => subagentHoverRows(view, Date.now()), { placement: 'above', variant: 'card', delay: 450 }));
	}
	return row;
}

/** A subagent in the card above the composer (Cursor): the plane, its title, and a word when it needs you or failed. */
export function renderCursorCardRow(parent: HTMLElement, view: ISubagentView, options: ISubagentRowOptions): HTMLElement {
	const row = append(parent, $(view.openable ? 'button.volt-agent-work-agent' : 'div.volt-agent-work-agent')) as HTMLElement;
	if (row instanceof HTMLButtonElement) {
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
	if (view.openable) {
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onOpen?.(view);
		}));
	}
	if (options.tooltip) {
		options.store.add(options.tooltip.bind(row, () => subagentHoverRows(view, Date.now()), { placement: 'above', variant: 'card', delay: 450 }));
	}
	return row;
}

//#endregion
