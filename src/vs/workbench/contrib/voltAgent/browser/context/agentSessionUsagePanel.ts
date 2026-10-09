/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { formatCost } from '../usage/agentUsageFormat.js';
import { formatContextTokens } from './agentContextUsage.js';
import { ISessionUsageSummary, ISessionUsageTurn, SESSION_SPEND_KINDS, SessionSpend, SessionSpendKind } from './agentSessionUsage.js';

type SessionMetric = 'tokens' | 'cost';

const KIND_LABELS: Record<SessionSpendKind, string> = {
	input: localize('voltAgent.sessionUsage.input', "Input"),
	cacheRead: localize('voltAgent.sessionUsage.cacheRead', "Cache read"),
	cacheWrite: localize('voltAgent.sessionUsage.cacheWrite', "Cache write"),
	output: localize('voltAgent.sessionUsage.output', "Output"),
};

const KIND_CLASSES: Record<SessionSpendKind, string> = {
	input: 'kind-input',
	cacheRead: 'kind-cache-read',
	cacheWrite: 'kind-cache-write',
	output: 'kind-output',
};

export interface ISessionUsagePanelHost {
	close(): void;
	/** Scrolls the transcript to the turn a bar stands for. */
	revealTurn?(turnId: string): void;
}

/**
 * Session Usage: what the chat has cost so far. A column per turn, stacked by token kind, in
 * tokens or dollars. Hovering a column fills the readout and the breakdown with that turn;
 * hovering a token kind or a model lights its share of every column; a click jumps to the turn.
 */
export class AgentSessionUsagePanel extends Disposable {

	private readonly heroCost: HTMLElement;
	private readonly heroCostNote: HTMLElement;
	private readonly heroTokens: HTMLElement;
	private readonly heroTokensNote: HTMLElement;
	private readonly metricButtons = new Map<SessionMetric, HTMLButtonElement>();
	private readonly chart: HTMLElement;
	private readonly chartMax: HTMLElement;
	private readonly columns: HTMLElement;
	private readonly readout: HTMLElement;
	private readonly breakdownTitle: HTMLElement;
	private readonly breakdown: HTMLElement;
	private readonly modelsSection: HTMLElement;
	private readonly models: HTMLElement;
	private readonly footnote: HTMLElement;

	private summary: ISessionUsageSummary | undefined;
	private metric: SessionMetric = 'tokens';
	private hoveredTurn: number | undefined;
	private hoveredKind: SessionSpendKind | undefined;
	private hoveredModel: string | undefined;
	private columnEls: HTMLElement[] = [];
	private readonly chartStore = this._register(new DisposableStore());
	private readonly detailStore = this._register(new DisposableStore());
	private readonly modelStore = this._register(new DisposableStore());

	constructor(panel: HTMLElement, private readonly host: ISessionUsagePanelHost) {
		super();
		panel.classList.add('volt-session-usage');

		const header = append(panel, $('.volt-agent-context-header'));
		append(header, $('span.title')).textContent = localize('voltAgent.sessionUsage.title', "Session Usage");
		const close = append(header, $('button.close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltAgent.contextClose', "Close"));
		close.appendChild(renderIcon(Codicon.close));
		this._register(addDisposableListener(close, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.close();
		}));

		const hero = append(panel, $('.volt-session-usage-hero'));
		const costStat = append(hero, $('.stat'));
		this.heroCost = append(costStat, $('span.value'));
		this.heroCostNote = append(costStat, $('span.note'));
		const tokenStat = append(hero, $('.stat.end'));
		this.heroTokens = append(tokenStat, $('span.value'));
		this.heroTokensNote = append(tokenStat, $('span.note'));

		const toolbar = append(panel, $('.volt-session-usage-toolbar'));
		append(toolbar, $('span.caption')).textContent = localize('voltAgent.sessionUsage.perTurn', "Per turn");
		const segmented = append(toolbar, $('.volt-session-usage-metric'));
		segmented.setAttribute('role', 'radiogroup');
		for (const [metric, label] of [['tokens', localize('voltAgent.sessionUsage.tokens', "Tokens")], ['cost', localize('voltAgent.sessionUsage.cost', "Cost")]] as const) {
			const button = append(segmented, $('button')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.setAttribute('role', 'radio');
			this.metricButtons.set(metric, button);
			this._register(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.metric = metric;
				this.render();
			}));
		}

		this.chart = append(panel, $('.volt-session-usage-chart'));
		this.chartMax = append(this.chart, $('span.max'));
		append(this.chart, $('span.baseline'));
		this.columns = append(this.chart, $('.columns'));
		this._register(addDisposableListener(this.columns, 'mouseleave', () => this.setHoveredTurn(undefined)));

		this.readout = append(panel, $('.volt-session-usage-readout'));

		this.breakdownTitle = append(panel, $('.volt-session-usage-section'));
		this.breakdown = append(panel, $('.volt-agent-context-list.volt-session-usage-kinds'));

		this.modelsSection = append(panel, $('.volt-session-usage-section'));
		this.modelsSection.textContent = localize('voltAgent.sessionUsage.models', "Models");
		this.models = append(panel, $('.volt-session-usage-models'));

		this.footnote = append(panel, $('.volt-session-usage-footnote'));
	}

	update(summary: ISessionUsageSummary): void {
		this.summary = summary;
		if (this.hoveredTurn !== undefined && this.hoveredTurn >= summary.turns.length) {
			this.hoveredTurn = undefined;
		}
		this.render();
	}

	private render(): void {
		const summary = this.summary;
		if (!summary) {
			return;
		}
		const priced = summary.turns.length - summary.unpricedTurns;
		this.heroCost.textContent = priced ? formatCost(summary.costUsd) : '\u2014';
		this.heroCostNote.textContent = !priced
			? localize('voltAgent.sessionUsage.noPrice', "No price known")
			: summary.reportedTurns === summary.turns.length
				? localize('voltAgent.sessionUsage.reported', "Cost reported by the agent")
				: localize('voltAgent.sessionUsage.estimated', "Estimated cost");
		this.heroTokens.textContent = formatContextTokens(summary.total);
		this.heroTokensNote.textContent = summary.turns.length === 1
			? localize('voltAgent.sessionUsage.oneTurn', "Tokens · 1 turn")
			: localize('voltAgent.sessionUsage.turns', "Tokens · {0} turns", summary.turns.length);

		for (const [metric, button] of this.metricButtons) {
			button.classList.toggle('active', metric === this.metric);
			button.setAttribute('aria-checked', String(metric === this.metric));
		}

		this.renderChart(summary);
		this.renderDetail();
		this.renderModels(summary);

		const notes: string[] = [];
		if (summary.reportedTurns > 0 && summary.reportedTurns < summary.turns.length) {
			notes.push(localize('voltAgent.sessionUsage.mixed', "Agent-reported cost where given, list prices otherwise."));
		} else if (summary.reportedTurns === 0 && priced > 0) {
			notes.push(localize('voltAgent.sessionUsage.listPrices', "At public API list prices; subscriptions bill differently."));
		}
		if (summary.unpricedTurns > 0) {
			notes.push(summary.unpricedTurns === 1
				? localize('voltAgent.sessionUsage.unpricedOne', "1 turn has no known price.")
				: localize('voltAgent.sessionUsage.unpriced', "{0} turns have no known price.", summary.unpricedTurns));
		}
		this.footnote.textContent = notes.join(' ');
		this.footnote.hidden = notes.length === 0;
	}

	private value(turn: ISessionUsageTurn): number {
		return this.metric === 'cost' ? turn.costUsd ?? 0 : turn.total;
	}

	private format(value: number): string {
		return this.metric === 'cost' ? formatCost(value) : formatContextTokens(value);
	}

	private renderChart(summary: ISessionUsageSummary): void {
		const max = Math.max(0, ...summary.turns.map(turn => this.value(turn)));
		this.chartMax.textContent = max > 0 ? this.format(max) : '';
		this.chartStore.clear();
		this.columns.replaceChildren();
		this.columnEls = [];
		this.columns.classList.toggle('dense', summary.turns.length > 40);
		this.columns.classList.toggle('many', summary.turns.length > 16 && summary.turns.length <= 40);
		summary.turns.forEach((turn, at) => {
			const column = append(this.columns, $('.column'));
			column.classList.toggle('unpriced', this.metric === 'cost' && turn.costUsd === undefined);
			column.setAttribute('role', 'button');
			column.tabIndex = -1;
			column.setAttribute('aria-label', localize('voltAgent.sessionUsage.turnLabel', "Turn {0}, {1}, {2}", turn.index, turn.modelLabel, this.format(this.value(turn))));
			const stack = append(column, $('.stack'));
			const value = this.value(turn);
			stack.style.height = max > 0 ? `${Math.max(value > 0 ? 3 : 0, (value / max) * 100)}%` : '0%';
			const parts: SessionSpend | undefined = this.metric === 'cost' ? turn.costByKind : turn.tokens;
			if (parts) {
				for (const kind of SESSION_SPEND_KINDS) {
					if (parts[kind] > 0) {
						const segment = append(stack, $(`.segment.${KIND_CLASSES[kind]}`));
						segment.style.flexGrow = String(parts[kind]);
					}
				}
			} else if (value > 0) {
				// A reported cost with no list rates to split it.
				append(stack, $('.segment.kind-other')).style.flexGrow = '1';
			}
			column.dataset.model = turn.modelKey;
			this.columnEls.push(column);
			this.chartStore.add(addDisposableListener(column, 'mouseenter', () => this.setHoveredTurn(at)));
			this.chartStore.add(addDisposableListener(column, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				if (turn.turnId) {
					this.host.revealTurn?.(turn.turnId);
				}
			}));
		});
		this.paintHighlight();
	}

	private setHoveredTurn(at: number | undefined): void {
		if (this.hoveredTurn === at) {
			return;
		}
		this.hoveredTurn = at;
		this.paintHighlight();
		this.renderDetail();
	}

	/** Dims what the pointer is not on: other turns, other kinds, other models. */
	private paintHighlight(): void {
		this.columns.classList.toggle('focus-turn', this.hoveredTurn !== undefined);
		this.columns.classList.toggle('focus-kind', this.hoveredKind !== undefined);
		this.columns.classList.toggle('focus-model', this.hoveredModel !== undefined);
		for (const kind of SESSION_SPEND_KINDS) {
			this.columns.classList.toggle(`focus-${KIND_CLASSES[kind]}`, this.hoveredKind === kind);
		}
		this.columnEls.forEach((column, at) => {
			column.classList.toggle('hovered', at === this.hoveredTurn);
			column.classList.toggle('model-match', column.dataset.model === this.hoveredModel);
		});
	}

	/** The readout and the token-kind rows: the hovered turn, else the whole session. */
	private renderDetail(): void {
		const summary = this.summary;
		if (!summary) {
			return;
		}
		const turn = this.hoveredTurn !== undefined ? summary.turns[this.hoveredTurn] : undefined;
		this.readout.replaceChildren();
		if (turn) {
			const line = append(this.readout, $('.line'));
			append(line, $('span.turn')).textContent = localize('voltAgent.sessionUsage.turn', "Turn {0}", turn.index);
			append(line, $('span.model')).textContent = turn.modelLabel;
			append(line, $('span.figure')).textContent = turn.costUsd !== undefined
				? localize('voltAgent.sessionUsage.turnFigure', "{0} tokens · {1}", formatContextTokens(turn.total), formatCost(turn.costUsd))
				: localize('voltAgent.sessionUsage.turnTokens', "{0} tokens", formatContextTokens(turn.total));
			append(this.readout, $('.prompt')).textContent = turn.prompt || '\u00a0';
		} else {
			append(this.readout, $('.hint')).textContent = summary.turns.length
				? localize('voltAgent.sessionUsage.hint', "Hover a bar to see that turn. Click it to jump there.")
				: localize('voltAgent.sessionUsage.empty', "No usage reported yet.");
		}

		this.breakdownTitle.textContent = turn
			? localize('voltAgent.sessionUsage.turnBreakdown', "Turn {0} by token type", turn.index)
			: localize('voltAgent.sessionUsage.breakdown', "By token type");
		const tokens = turn ? turn.tokens : summary.tokens;
		const costs = turn ? turn.costByKind : summary.costByKind;
		this.detailStore.clear();
		this.breakdown.replaceChildren();
		for (const kind of SESSION_SPEND_KINDS) {
			const row = append(this.breakdown, $('.row.volt-session-usage-kind'));
			row.classList.toggle('active', this.hoveredKind === kind);
			append(row, $(`span.swatch.${KIND_CLASSES[kind]}`));
			append(row, $('span.label')).textContent = KIND_LABELS[kind];
			append(row, $('span.count')).textContent = formatContextTokens(tokens[kind]);
			append(row, $('span.cost')).textContent = costs && costs[kind] > 0 ? formatCost(costs[kind]) : '\u2014';
			this.detailStore.add(addDisposableListener(row, 'mouseenter', () => {
				this.hoveredKind = kind;
				row.classList.add('active');
				this.paintHighlight();
			}));
			this.detailStore.add(addDisposableListener(row, 'mouseleave', () => {
				this.hoveredKind = undefined;
				row.classList.remove('active');
				this.paintHighlight();
			}));
		}
	}

	private renderModels(summary: ISessionUsageSummary): void {
		this.modelStore.clear();
		this.models.replaceChildren();
		this.modelsSection.hidden = summary.models.length === 0;
		const whole = summary.models.reduce((sum, model) => sum + (this.metric === 'cost' ? model.costUsd : model.total), 0);
		for (const model of summary.models) {
			const row = append(this.models, $('.model'));
			const top = append(row, $('.top'));
			append(top, $('span.name')).textContent = model.label;
			append(top, $('span.meta')).textContent = model.turns === 1
				? localize('voltAgent.sessionUsage.modelOneTurn', "1 turn")
				: localize('voltAgent.sessionUsage.modelTurns', "{0} turns", model.turns);
			append(top, $('span.count')).textContent = formatContextTokens(model.total);
			append(top, $('span.cost')).textContent = model.unpricedTurns === model.turns ? '\u2014' : formatCost(model.costUsd);
			const track = append(row, $('.share'));
			const part = this.metric === 'cost' ? model.costUsd : model.total;
			const fill = append(track, $('.fill'));
			fill.style.width = whole > 0 ? `${Math.max(part > 0 ? 2 : 0, (part / whole) * 100)}%` : '0%';
			this.modelStore.add(addDisposableListener(row, 'mouseenter', () => {
				this.hoveredModel = model.key;
				this.paintHighlight();
			}));
			this.modelStore.add(addDisposableListener(row, 'mouseleave', () => {
				this.hoveredModel = undefined;
				this.paintHighlight();
			}));
		}
	}
}

/** Lucide `chart-column`: the Session Usage button beside the context meter. */
export function createSessionUsageIcon(doc: Document): SVGSVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = doc.createElementNS(ns, 'svg');
	for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
		svg.setAttribute(key, value);
	}
	for (const d of ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3']) {
		const path = doc.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}
