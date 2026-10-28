/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../../base/browser/dom.js';
import { IManagedHoverTooltipMarkdownString } from '../../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ITableColumn, ITableRenderer } from '../../../../../base/browser/ui/table/table.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow, safeIntl } from '../../../../../base/common/date.js';
import { language } from '../../../../../base/common/platform.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { asCssVariable } from '../../../../../platform/theme/common/colorUtils.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { getHistoryItemIndex, historyItemRefColor, ISCMHistoryGraphGeometry, renderSCMHistoryItemGraph } from '../../../scm/browser/scmHistory.js';
import { getHistoryItemHoverContent } from '../../../scm/browser/util.js';
import { ISCMHistoryItem, ISCMHistoryItemRef } from '../../../scm/common/history.js';
import { IGitCodingAgent } from '../../common/gitAgentAttribution.js';
import { createAgentMark } from './gitGraphIcons.js';
import { GitGraphRow, IGitGraphCommitRow } from './gitGraphModel.js';

export const GIT_GRAPH_ROW_HEIGHT = 28;

/** The SCM view's graph, taller: 28px rows, 14px lanes. */
export const GIT_GRAPH_GEOMETRY: ISCMHistoryGraphGeometry = {
	rowHeight: GIT_GRAPH_ROW_HEIGHT,
	laneWidth: 14,
	curveRadius: 6,
	circleRadius: 4,
	circleStrokeWidth: 1,
	lineWidth: 1.5,
};

/** What the cells call back into: filters and the hover service, owned by the editor. */
export interface IGitGraphCellHost {
	readonly hoverService: IHoverService;
	readonly themeService: IThemeService;
	filterByAuthor(author: string): void;
	filterByRef(ref: ISCMHistoryItemRef): void;
	copy(text: string): void;
	/** False for commits outside the range selected on the activity strip. */
	inRange(row: GitGraphRow): boolean;
}

/** A ref's chip: its color as a CSS variable, tinted in gitGraph.css (no inline fills). */
export function paintRefChip(chip: HTMLElement, ref: ISCMHistoryItemRef): void {
	chip.style.setProperty('--vgg-ref', ref.color ? asCssVariable(ref.color) : 'var(--vscode-descriptionForeground)');
	if (ThemeIcon.isThemeIcon(ref.icon)) {
		chip.appendChild(renderIcon(ref.icon));
	}
	append(chip, $('span.vgg-ref-name')).textContent = ref.name;
}

interface ICellTemplate {
	readonly root: HTMLElement;
	readonly disposables: DisposableStore;
}

abstract class GitGraphCellRenderer<T extends ICellTemplate> implements ITableRenderer<GitGraphRow, T> {
	abstract readonly templateId: string;
	constructor(protected readonly host: IGitGraphCellHost) { }
	abstract renderTemplate(container: HTMLElement): T;
	protected abstract paint(row: GitGraphRow, template: T): void;
	renderElement(row: GitGraphRow, _index: number, template: T): void {
		this.paint(row, template);
		// Outside the timeline's selected range: dimmed, like GitLens dims rows a search doesn't match.
		template.root.classList.toggle('vgg-dim', !this.host.inRange(row));
	}
	disposeElement(_row: GitGraphRow, _index: number, template: T): void {
		template.disposables.clear();
	}
	disposeTemplate(template: T): void {
		template.disposables.dispose();
	}
}

function cell(container: HTMLElement, className: string): ICellTemplate {
	return { root: append(container, $(`.vgg-cell.${className}`)), disposables: new DisposableStore() };
}

//#region Branch / Tag

export class RefsRenderer extends GitGraphCellRenderer<ICellTemplate> {
	static readonly ID = 'refs';
	readonly templateId = RefsRenderer.ID;

	renderTemplate(container: HTMLElement): ICellTemplate {
		return cell(container, 'vgg-refs');
	}

	protected paint(row: GitGraphRow, template: ICellTemplate): void {
		template.root.replaceChildren();
		if (row.kind !== 'commit') {
			return;
		}
		const refs = row.vm.historyItem.references ?? [];
		if (!refs.length) {
			return;
		}
		const first = refs[0];
		const chip = append(template.root, $('button.vgg-ref-chip')) as HTMLButtonElement;
		chip.type = 'button';
		paintRefChip(chip, first);
		template.disposables.add(addDisposableListener(chip, EventType.CLICK, e => {
			e.stopPropagation();
			this.host.filterByRef(first);
		}));
		if (refs.length > 1) {
			append(template.root, $('span.vgg-ref-more')).textContent = `+${refs.length - 1}`;
		}
		const lines = refs.map(ref => `$(${ThemeIcon.isThemeIcon(ref.icon) ? ref.icon.id : 'tag'}) ${ref.name}`);
		const tooltip = new MarkdownString(lines.join('\n\n'), { supportThemeIcons: true });
		template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.root, { markdown: tooltip, markdownNotSupportedFallback: refs.map(ref => ref.name).join(', ') }));
	}
}

//#endregion

//#region Graph

interface IGraphTemplate extends ICellTemplate {
	readonly badge: HTMLElement;
}

export class GraphRenderer extends GitGraphCellRenderer<IGraphTemplate> {
	static readonly ID = 'graph';
	readonly templateId = GraphRenderer.ID;

	renderTemplate(container: HTMLElement): IGraphTemplate {
		const base = cell(container, 'vgg-graph');
		const badge = append(base.root, $('span.vgg-node-agent'));
		return { ...base, badge };
	}

	protected paint(row: GitGraphRow, template: IGraphTemplate): void {
		template.root.querySelector('svg.graph')?.remove();
		template.badge.replaceChildren();
		template.badge.style.display = 'none';
		const g = GIT_GRAPH_GEOMETRY;
		if (row.kind === 'wip') {
			template.root.prepend(workingTreeNode());
			return;
		}
		if (row.flat) {
			template.root.prepend(searchNode(row.vm.isCurrent));
			return;
		}
		const svg = renderSCMHistoryItemGraph(row.vm, g);
		template.root.prepend(svg);
		// An agent's commit wears its mark on the node (GitLens draws avatars there).
		const agent = row.agents[0];
		if (agent) {
			const lane = getHistoryItemIndex(row.vm);
			const color = row.vm.outputSwimlanes[lane]?.color ?? row.vm.inputSwimlanes[lane]?.color ?? historyItemRefColor;
			template.badge.style.display = '';
			template.badge.style.left = `${g.laneWidth * (lane + 1) - 9}px`;
			template.badge.style.borderColor = asCssVariable(color);
			template.badge.appendChild(createAgentMark(agent.id, 11));
		}
	}
}

function workingTreeNode(): SVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('graph', 'vgg-wip-node');
	const g = GIT_GRAPH_GEOMETRY;
	svg.style.width = `${g.laneWidth * 2}px`;
	svg.style.height = `${g.rowHeight}px`;
	const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	line.setAttribute('d', `M ${g.laneWidth} ${g.rowHeight / 2} V ${g.rowHeight}`);
	line.setAttribute('stroke-dasharray', '2 3');
	const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	circle.setAttribute('cx', `${g.laneWidth}`);
	circle.setAttribute('cy', `${g.rowHeight / 2}`);
	circle.setAttribute('r', '5');
	svg.append(line, circle);
	return svg;
}

function searchNode(current: boolean): SVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('graph', 'vgg-search-node');
	const g = GIT_GRAPH_GEOMETRY;
	svg.style.width = `${g.laneWidth * 2}px`;
	svg.style.height = `${g.rowHeight}px`;
	const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	circle.setAttribute('cx', `${g.laneWidth}`);
	circle.setAttribute('cy', `${g.rowHeight / 2}`);
	circle.setAttribute('r', current ? '5' : '4');
	svg.append(circle);
	return svg;
}

//#endregion

//#region Commit message

interface IMessageTemplate extends ICellTemplate {
	readonly subject: HTMLElement;
	readonly detail: HTMLElement;
}

export class MessageRenderer extends GitGraphCellRenderer<IMessageTemplate> {
	static readonly ID = 'message';
	readonly templateId = MessageRenderer.ID;

	renderTemplate(container: HTMLElement): IMessageTemplate {
		const base = cell(container, 'vgg-message');
		const subject = append(base.root, $('span.vgg-subject'));
		const detail = append(base.root, $('span.vgg-subject-detail'));
		return { ...base, subject, detail };
	}

	protected paint(row: GitGraphRow, template: IMessageTemplate): void {
		if (row.kind === 'wip') {
			template.root.classList.add('wip');
			template.root.classList.remove('current');
			template.subject.textContent = localize('voltGitGraph.wip', "Uncommitted changes");
			template.detail.textContent = row.files === 1 ? localize('voltGitGraph.wipOne', "1 file") : localize('voltGitGraph.wipMany', "{0} files", row.files);
			return;
		}
		const item = row.vm.historyItem;
		template.root.classList.remove('wip');
		template.root.classList.toggle('current', row.vm.isCurrent);
		template.subject.textContent = item.subject;
		template.detail.textContent = '';
		template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.root, () => commitHover(this.host.themeService, item, row.agents)));
	}
}

/** The SCM view's commit hover, with the agents its trailers name. */
export function commitHover(themeService: IThemeService, item: ISCMHistoryItem, agents: readonly IGitCodingAgent[]): IManagedHoverTooltipMarkdownString {
	const base = getHistoryItemHoverContent(themeService, item);
	if (!agents.length || typeof base.markdown === 'function') {
		return base;
	}
	const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true, supportHtml: true });
	markdown.appendMarkdown(`$(sparkle) ${localize('voltGitGraph.writtenWith', "Written with {0}", agents.map(agent => `**${agent.name}**`).join(', '))}\n\n`);
	markdown.appendMarkdown(typeof base.markdown === 'string' ? base.markdown : base.markdown?.value ?? '');
	return { markdown, markdownNotSupportedFallback: base.markdownNotSupportedFallback };
}

//#endregion

//#region Agent

export class AgentRenderer extends GitGraphCellRenderer<ICellTemplate> {
	static readonly ID = 'agent';
	readonly templateId = AgentRenderer.ID;

	renderTemplate(container: HTMLElement): ICellTemplate {
		return cell(container, 'vgg-agent');
	}

	protected paint(row: GitGraphRow, template: ICellTemplate): void {
		template.root.replaceChildren();
		if (row.kind !== 'commit' || !row.agents.length) {
			return;
		}
		for (const agent of row.agents.slice(0, 3)) {
			template.root.appendChild(createAgentMark(agent.id, 14));
		}
		append(template.root, $('span.vgg-agent-name')).textContent = row.agents.length === 1
			? row.agents[0].name
			: localize('voltGitGraph.agents', "{0} agents", row.agents.length);
		// allow-any-unicode-next-line
		const tooltip = row.agents.map(agent => `${agent.name} — ${agent.evidence}`).join('\n');
		template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.root, tooltip));
	}
}

//#endregion

//#region Changes

interface IChangesTemplate extends ICellTemplate {
	readonly blocks: readonly HTMLElement[];
	readonly added: HTMLElement;
	readonly removed: HTMLElement;
}

/** Blocks share one log scale, so a page loading never changes the blocks already drawn. */
const DIFFSTAT_MAX_LINES = 2000;
const DIFFSTAT_BLOCKS = 5;

/**
 * GitHub's diffstat: five blocks, as many filled as the change is big (log scale), split green /
 * red by the share of added and removed lines; at least one of each side that changed.
 */
export function diffstatBlocks(insertions: number, deletions: number): ('added' | 'removed' | 'empty')[] {
	const total = insertions + deletions;
	if (!total) {
		return new Array(DIFFSTAT_BLOCKS).fill('empty');
	}
	const scale = Math.min(1, Math.log10(1 + total) / Math.log10(1 + DIFFSTAT_MAX_LINES));
	const filled = Math.max(insertions && deletions ? 2 : 1, Math.round(scale * DIFFSTAT_BLOCKS));
	let added = Math.round(filled * insertions / total);
	if (insertions && !added) {
		added = 1;
	}
	if (deletions && added === filled) {
		added = filled - 1;
	}
	return Array.from({ length: DIFFSTAT_BLOCKS }, (_, i) => i < added ? 'added' : i < filled ? 'removed' : 'empty');
}

/** The diffstat blocks, then `+12 -3` (a minus sign) in the same colours; the file count is in the tooltip. Narrow columns keep the blocks. */
export class ChangesRenderer extends GitGraphCellRenderer<IChangesTemplate> {
	static readonly ID = 'changes';
	readonly templateId = ChangesRenderer.ID;

	renderTemplate(container: HTMLElement): IChangesTemplate {
		const base = cell(container, 'vgg-changes');
		const stat = append(base.root, $('span.vgg-diffstat'));
		const blocks = Array.from({ length: DIFFSTAT_BLOCKS }, () => append(stat, $('span.vgg-diffstat-block')));
		const numbers = append(base.root, $('span.vgg-diffstat-numbers'));
		const added = append(numbers, $('span.vgg-added'));
		const removed = append(numbers, $('span.vgg-removed'));
		return { ...base, blocks, added, removed };
	}

	protected paint(row: GitGraphRow, template: IChangesTemplate): void {
		const stats = row.kind === 'commit' ? row.vm.historyItem.statistics : undefined;
		const empty = !stats || (!stats.files && !stats.insertions && !stats.deletions);
		template.root.classList.toggle('empty', empty);
		if (!stats || empty) {
			template.added.textContent = template.removed.textContent = '';
			return;
		}
		diffstatBlocks(stats.insertions, stats.deletions).forEach((kind, i) => template.blocks[i].className = `vgg-diffstat-block ${kind}`);
		template.added.textContent = `+${formatCount(stats.insertions)}`;
		// allow-any-unicode-next-line
		template.removed.textContent = `−${formatCount(stats.deletions)}`;
		template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.root,
			localize('voltGitGraph.changesTooltip', "{0} files changed, {1} insertions(+), {2} deletions(-)", stats.files, stats.insertions, stats.deletions)));
	}
}

/** 1234 → 1.2k, so big commits keep the column narrow. */
export function formatCount(value: number): string {
	return value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(value);
}

//#endregion

//#region Author

interface IAuthorTemplate extends ICellTemplate {
	readonly avatar: HTMLElement;
	readonly name: HTMLElement;
}

export class AuthorRenderer extends GitGraphCellRenderer<IAuthorTemplate> {
	static readonly ID = 'author';
	readonly templateId = AuthorRenderer.ID;

	renderTemplate(container: HTMLElement): IAuthorTemplate {
		const base = cell(container, 'vgg-author');
		const avatar = append(base.root, $('span.vgg-avatar'));
		const name = append(base.root, $('span.vgg-author-name'));
		return { ...base, avatar, name };
	}

	protected paint(row: GitGraphRow, template: IAuthorTemplate): void {
		if (row.kind !== 'commit') {
			template.avatar.replaceChildren();
			template.avatar.style.display = 'none';
			template.name.textContent = '';
			return;
		}
		const item = row.vm.historyItem;
		const author = item.author ?? '';
		template.avatar.style.display = '';
		renderAvatar(template.avatar, author, item.authorEmail, item.authorIcon, 18);
		template.name.textContent = author;
		template.disposables.add(addDisposableListener(template.avatar, EventType.CLICK, e => {
			e.stopPropagation();
			this.host.filterByAuthor(author);
		}));
		template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.root,
			item.authorEmail ? `${author} <${item.authorEmail}>` : author));
	}
}

/**
 * The author's picture from the history provider (GitHub avatars), or initials on a color picked
 * from their email, so the same person always looks the same. Reuses the <img> between rows.
 */
export function renderAvatar(host: HTMLElement, author: string, email: string | undefined, icon: ISCMHistoryItem['authorIcon'], size: number): void {
	host.style.width = host.style.height = `${size}px`;
	const url = URI.isUri(icon) ? icon.toString(true) : undefined;
	const showInitials = () => {
		host.replaceChildren();
		host.classList.add('initials');
		host.textContent = initials(author);
		host.style.backgroundColor = `hsl(${hash(email || author) % 360} 42% 40%)`;
		host.style.fontSize = `${Math.round(size * 0.45)}px`;
	};
	if (!url) {
		showInitials();
		return;
	}
	let img = host.firstElementChild as HTMLImageElement | null;
	if (!isHTMLElement(img) || img.tagName !== 'IMG') {
		host.replaceChildren();
		img = append(host, $('img')) as HTMLImageElement;
		img.loading = 'lazy';
		img.decoding = 'async';
		img.alt = '';
	}
	host.classList.remove('initials');
	host.style.backgroundColor = '';
	img.width = img.height = size;
	img.onerror = showInitials;
	if (img.getAttribute('src') !== url) {
		img.src = url;
	}
}

function initials(name: string): string {
	const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
	if (!parts.length) {
		return '?';
	}
	return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

//#endregion

//#region Date and SHA

export class DateRenderer extends GitGraphCellRenderer<ICellTemplate> {
	static readonly ID = 'date';
	readonly templateId = DateRenderer.ID;
	private readonly format = safeIntl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

	renderTemplate(container: HTMLElement): ICellTemplate {
		return cell(container, 'vgg-date');
	}

	protected paint(row: GitGraphRow, template: ICellTemplate): void {
		const timestamp = row.kind === 'commit' ? row.vm.historyItem.timestamp : undefined;
		template.root.replaceChildren();
		if (timestamp) {
			// Both forms; a narrow column shows the short one (CSS container query).
			append(template.root, $('span.vgg-date-long')).textContent = fromNow(timestamp, true);
			append(template.root, $('span.vgg-date-short')).textContent = shortAgo(timestamp, Date.now());
			template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.root, this.format.value.format(timestamp)));
		}
	}
}

/** "now", "5m", "3h", "2d", "3w", "4mo", "2y": a date in a column a few characters wide. */
export function shortAgo(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (minutes < 1) {
		return localize('voltGitGraph.agoNow', "now");
	}
	if (hours < 1) {
		return localize('voltGitGraph.agoMinutes', "{0}m", minutes);
	}
	if (days < 1) {
		return localize('voltGitGraph.agoHours', "{0}h", hours);
	}
	if (days < 7) {
		return localize('voltGitGraph.agoDays', "{0}d", days);
	}
	if (days < 30) {
		return localize('voltGitGraph.agoWeeks', "{0}w", Math.floor(days / 7));
	}
	if (days < 365) {
		return localize('voltGitGraph.agoMonths', "{0}mo", Math.floor(days / 30));
	}
	return localize('voltGitGraph.agoYears', "{0}y", Math.floor(days / 365));
}

interface IShaTemplate extends ICellTemplate {
	readonly text: HTMLElement;
	readonly copy: HTMLButtonElement;
}

/** The short SHA, with a copy button that shows on row hover (copies the full SHA). */
export class ShaRenderer extends GitGraphCellRenderer<IShaTemplate> {
	static readonly ID = 'sha';
	readonly templateId = ShaRenderer.ID;

	renderTemplate(container: HTMLElement): IShaTemplate {
		const base = cell(container, 'vgg-sha');
		const text = append(base.root, $('span.vgg-sha-text'));
		const copy = append(base.root, $('button.vgg-sha-copy')) as HTMLButtonElement;
		copy.type = 'button';
		copy.tabIndex = -1;
		copy.setAttribute('aria-label', localize('voltGitGraph.copyShaAria', "Copy commit SHA"));
		copy.appendChild(renderIcon(Codicon.copy));
		return { ...base, text, copy };
	}

	protected paint(row: GitGraphRow, template: IShaTemplate): void {
		if (row.kind !== 'commit') {
			template.text.textContent = '';
			template.copy.style.display = 'none';
			return;
		}
		const item = row.vm.historyItem;
		template.text.textContent = item.displayId ?? item.id.slice(0, 7);
		template.copy.style.display = '';
		template.copy.classList.remove('copied');
		template.copy.replaceChildren(renderIcon(Codicon.copy));
		template.disposables.add(addDisposableListener(template.copy, EventType.MOUSE_DOWN, e => e.stopPropagation()));
		template.disposables.add(addDisposableListener(template.copy, EventType.CLICK, e => {
			e.stopPropagation();
			this.host.copy(item.id);
			template.copy.classList.add('copied');
			template.copy.replaceChildren(renderIcon(Codicon.check));
		}));
		template.disposables.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.copy, localize('voltGitGraph.copyShaHover', "Copy {0}", item.id)));
	}
}

//#endregion

/**
 * Columns in GitLens' order; every column projects the row itself. Minimums stay small (they sum to
 * GIT_GRAPH_COLUMNS_MIN): a column at its minimum can't give way, so a narrow tab would leave nothing
 * to drag. `compact` (a narrow table) keeps branch, graph, message, author and date; the graph's node
 * still carries the agent's badge.
 */
export function gitGraphColumns(compact = false): ITableColumn<GitGraphRow, GitGraphRow>[] {
	const column = (templateId: string, label: string, weight: number, minimumWidth: number, maximumWidth?: number): ITableColumn<GitGraphRow, GitGraphRow> =>
		({ label, templateId, weight, minimumWidth, maximumWidth, project: row => row });
	if (compact) {
		return [
			column(RefsRenderer.ID, localize('voltGitGraph.col.refs', "Branch / Tag"), 12, 40, 240),
			column(GraphRenderer.ID, localize('voltGitGraph.col.graph', "Graph"), 9, 28, 320),
			column(MessageRenderer.ID, localize('voltGitGraph.col.message', "Commit Message"), 44, 96),
			column(AuthorRenderer.ID, localize('voltGitGraph.col.author', "Author"), 6, 32, 200),
			column(DateRenderer.ID, localize('voltGitGraph.col.date', "Date"), 12, 56, 160),
		];
	}
	return [
		column(RefsRenderer.ID, localize('voltGitGraph.col.refs', "Branch / Tag"), 12, 40, 320),
		column(GraphRenderer.ID, localize('voltGitGraph.col.graph', "Graph"), 7, 28, 420),
		column(MessageRenderer.ID, localize('voltGitGraph.col.message', "Commit Message"), 34, 96),
		column(AgentRenderer.ID, localize('voltGitGraph.col.agent', "Agent"), 9, 28, 220),
		column(ChangesRenderer.ID, localize('voltGitGraph.col.changes', "Changes"), 10, 52, 220),
		column(AuthorRenderer.ID, localize('voltGitGraph.col.author', "Author"), 12, 32, 260),
		column(DateRenderer.ID, localize('voltGitGraph.col.date', "Date"), 9, 52, 200),
		column(ShaRenderer.ID, localize('voltGitGraph.col.sha', "SHA"), 8, 72, 140),
	];
}

/** The columns' minimum widths together: the table never needs more room than this. */
export const GIT_GRAPH_COLUMNS_MIN = 40 + 28 + 96 + 28 + 52 + 32 + 52 + 72;

export function isCommitRow(row: GitGraphRow | undefined): row is IGitGraphCommitRow {
	return row?.kind === 'commit';
}
