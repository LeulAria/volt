/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import {
	AgentBlock,
	classifyTableCell,
	IApprovalBlock,
	ICardsBlock,
	IChartBlock,
	ICodeBlock,
	IErrorBlock,
	IFileChangeBlock,
	IListBlock,
	IMarkdownBlock,
	ITableBlock,
	ITerminalBlock,
	IToolBlock,
	humanTerminalTitle,
	isPathLike,
	parseFileTarget,
	stripCellMarkup,
	terminalCommandLabels,
} from './agentBlocks.js';
import { renderMermaidDiagram } from './agentMermaid.js';
import { tableFromListItems } from '../../../../services/voltRuntime/common/harness/adaptiveOutput.js';
import { extractHttpUrl, extractLocalPreviewUrl, linkifyPreviewUrls } from '../preview/localPreview.js';
import { AccessDecisionScope } from '../../../../services/voltRuntime/common/access/accessTypes.js';
import { FileChangePreview } from '../review/fileChangePreview.js';
import { chooseFileChangeDiffStyle, formatChangeStats, type FileChangeDiffStyle } from '../review/fileChangePreviewModel.js';
import { fileChangeGroupTitle, fileChangeSource, ThreadPart } from '../chrome/agentTimeline.js';

export interface IBlockRenderContext {
	readonly markdownRenderer: MarkdownRenderer;
	readonly store: DisposableStore;
	readonly blockState: Record<string, { expanded: boolean }>;
	readonly onToggle: (blockId: string) => void;
	readonly onScroll: () => void;
	readonly instantiationService: IInstantiationService;
	readonly diffStyle?: FileChangeDiffStyle;
	readonly onOpenPath?: (path: string, startLine?: number, endLine?: number) => void;
	readonly onOpenUrl?: (url: string) => void;
	readonly onTerminalMenu?: (anchor: HTMLElement, command: string) => void;
	readonly onTableCopyMenu?: (anchor: HTMLElement, plain: string, markdown: string) => void;
	readonly onCopyText?: (text: string) => void;
	readonly onAccessDecision?: (requestId: string, effect: 'allow' | 'deny', scope: AccessDecisionScope, pattern?: string) => void;
	/** When false, a still-running command must not keep the streaming shimmer. */
	readonly streaming?: boolean;
}

export function renderAgentBlock(parent: HTMLElement, block: AgentBlock, ctx: IBlockRenderContext): void {
	switch (block.type) {
		case 'markdown':
			renderMarkdownBlock(parent, block, ctx);
			return;
		case 'code':
			renderCodeBlock(parent, block);
			return;
		case 'terminal':
			renderTerminalBlock(parent, block, ctx);
			return;
		case 'table':
			renderTableBlock(parent, block, ctx);
			return;
		case 'list':
			renderListBlock(parent, block, ctx);
			return;
		case 'cards':
			renderCardsBlock(parent, block, ctx);
			return;
		case 'chart':
			renderChartBlock(parent, block);
			return;
		case 'mermaid':
			renderMermaidDiagram(parent, block.source);
			return;
		case 'tool':
			renderToolBlock(parent, block, ctx);
			return;
		case 'file':
			renderFileChangeBlock(parent, block, ctx);
			return;
		case 'error':
			renderErrorBlock(parent, block);
			return;
		case 'approval':
			renderApprovalBlock(parent, block, ctx);
	}
}

export function renderMarkdownInto(parent: HTMLElement, text: string, ctx: IBlockRenderContext, extraClass?: string): void {
	const result = ctx.markdownRenderer.render(new MarkdownString(linkifyPreviewUrls(text)), {
		fillInIncompleteTokens: true,
		asyncRenderCallback: ctx.onScroll,
		actionHandler: link => {
			const url = extractHttpUrl(link) ?? extractLocalPreviewUrl(link);
			if (url) {
				ctx.onOpenUrl?.(url);
			}
		},
	});
	result.element.classList.add('volt-agent-markdown', 'volt-agent-searchable');
	if (extraClass) {
		result.element.classList.add(extraClass);
	}
	decorateMarkdownPills(result.element, ctx);
	wrapMarkdownTables(result.element, ctx);
	wrapComparableLists(result.element, ctx);
	parent.appendChild(result.element);
	ctx.store.add(result);
}

function renderMarkdownBlock(parent: HTMLElement, block: IMarkdownBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.markdown'));
	renderMarkdownInto(wrap, block.content, ctx);
}

function renderCodeBlock(parent: HTMLElement, block: ICodeBlock): void {
	const wrap = append(parent, $('.volt-agent-block.code'));
	if (block.language) {
		const lang = append(wrap, $('span.volt-agent-code-lang.volt-agent-searchable'));
		lang.textContent = block.language;
	}
	const pre = append(wrap, $('pre.volt-agent-searchable'));
	pre.textContent = block.code;
}

function isExpanded(block: { id: string; expanded?: boolean }, ctx: IBlockRenderContext): boolean {
	return ctx.blockState[block.id]?.expanded ?? !!block.expanded;
}

function svgEl(host: HTMLElement, tag: string): SVGElement {
	return host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
}

function appendTerminalToggleIcon(parent: HTMLElement): void {
	const icon = append(parent, $('span.volt-agent-term-icon'));
	icon.setAttribute('aria-hidden', 'true');

	const prompt = svgEl(icon, 'svg');
	prompt.setAttribute('viewBox', '0 0 24 24');
	prompt.setAttribute('fill', 'none');
	prompt.setAttribute('class', 'volt-agent-term-icon-prompt');
	for (const d of ['m4 17 6-6-6-6', 'M12 19h8']) {
		const path = svgEl(icon, 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		prompt.appendChild(path);
	}
	icon.appendChild(prompt);

	const arrow = svgEl(icon, 'svg');
	arrow.setAttribute('viewBox', '0 0 7 16');
	arrow.setAttribute('class', 'volt-agent-term-icon-arrow');
	const arrowPath = svgEl(icon, 'path');
	arrowPath.setAttribute('fill', 'currentColor');
	arrowPath.setAttribute('d', 'M1.5 13a.47.47 0 0 1-.35-.15c-.2-.2-.2-.51 0-.71L5.3 7.99L1.15 3.85c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.49 4.51c.2.2.2.51 0 .71l-4.5 4.49c-.1.1-.23.15-.35.15');
	arrow.appendChild(arrowPath);
	icon.appendChild(arrow);
}

function renderTerminalBlock(parent: HTMLElement, block: ITerminalBlock, ctx: IBlockRenderContext): void {
	const expanded = isExpanded(block, ctx);
	const wrap = append(parent, $('.volt-agent-block.terminal'));
	const live = block.status === 'streaming' && ctx.streaming !== false;
	wrap.classList.toggle('expanded', expanded);
	wrap.classList.toggle('streaming', live);

	const bar = append(wrap, $('.volt-agent-term-bar'));
	const header = append(bar, $('button.volt-agent-term-header')) as HTMLButtonElement;
	header.setAttribute('aria-expanded', String(expanded));
	appendTerminalToggleIcon(header);
	const headline = append(header, $('span.volt-agent-term-headline'));
	const titleText = humanTerminalTitle(block.title, block.command);
	const labels = terminalCommandLabels(block.command);
	const labelText = labels.join(', ');
	const showLabels = !!labelText && !titleText.toLowerCase().includes(labelText.toLowerCase()) && titleText.toLowerCase() !== (labels[0] ?? '').toLowerCase();
	if (live) {
		headline.classList.add('shimmer');
		headline.textContent = showLabels ? `${titleText} ${labelText}` : titleText;
	} else {
		const title = append(headline, $('span.volt-agent-term-title.volt-agent-searchable'));
		title.textContent = titleText;
		if (showLabels) {
			const meta = append(headline, $('code.volt-agent-term-cmds.volt-agent-searchable'));
			meta.textContent = labelText;
		}
	}
	const scanOutput: { current?: () => void } = {};
	const setExpanded = (next: boolean) => {
		wrap.classList.toggle('expanded', next);
		header.setAttribute('aria-expanded', String(next));
		ctx.blockState[block.id] = { expanded: next };
		block.expanded = next;
		queueMicrotask(() => scanOutput.current?.());
		getWindow(wrap).requestAnimationFrame(() => scanOutput.current?.());
	};
	if (ctx.onTerminalMenu) {
		const menuBtn = append(bar, $('button.volt-agent-term-menu')) as HTMLButtonElement;
		setAgentTooltip(menuBtn, localize('voltAgent.terminalMenu', "Command options"));
		menuBtn.setAttribute('aria-label', menuBtn.title);
		menuBtn.setAttribute('aria-haspopup', 'menu');
		menuBtn.appendChild(renderIcon(Codicon.ellipsis));
		ctx.store.add(addDisposableListener(menuBtn, 'mousedown', e => e.stopPropagation()));
		ctx.store.add(addDisposableListener(menuBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			ctx.onTerminalMenu!(menuBtn, block.command);
		}));
	}
	if (live) {
		header.setAttribute('aria-busy', 'true');
	}

	ctx.store.add(addDisposableListener(header, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		setExpanded(!wrap.classList.contains('expanded'));
	}));

	if (!block.command && !block.output) {
		return;
	}

	const body = append(wrap, $('.volt-agent-term-body'));
	const clip = append(body, $('.volt-agent-term-output-clip'));
	const content = $('.volt-agent-term-output-scroll');
	if (block.command) {
		const cmd = append(content, $('div.volt-agent-term-command.volt-agent-searchable'));
		const dollar = append(cmd, $('span.prompt'));
		dollar.textContent = '$';
		appendHighlightedShell(cmd, block.command);
	}
	if (block.output) {
		const out = append(content, $('pre.volt-agent-term-output.volt-agent-searchable'));
		out.textContent = block.output.replace(/[\r\n]+$/, '');
	}
	scanOutput.current = attachContainedScroll(clip, content, ctx, scroll => {
		pinCollapsedTerminalTail(wrap, clip, content, scroll);
	});
}

function renderToolBlock(parent: HTMLElement, block: IToolBlock, ctx: IBlockRenderContext): void {
	const expanded = isExpanded(block, ctx);
	const wrap = append(parent, $('.volt-agent-block.tool'));
	wrap.classList.toggle('expanded', expanded);
	const header = append(wrap, $('button.volt-agent-term-header')) as HTMLButtonElement;
	const chevron = append(header, $('span.volt-agent-term-chevron'));
	chevron.appendChild(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight));
	const title = append(header, $('span.volt-agent-term-title.volt-agent-searchable'));
	title.textContent = block.title || block.name;
	bindPathOpen(title, parseFileTarget(block.input, block.title, block.name), ctx);
	ctx.store.add(addDisposableListener(header, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		ctx.onToggle(block.id);
	}));
	if (!expanded) {
		return;
	}
	const body = append(wrap, $('.volt-agent-term-body'));
	if (block.input) {
		const input = append(body, $('pre.volt-agent-term-command.volt-agent-searchable'));
		input.textContent = block.input;
	}
	if (block.output) {
		const out = append(body, $('pre.volt-agent-term-output.volt-agent-searchable'));
		out.textContent = block.output;
	}
}

export function renderFileChangesPart(parent: HTMLElement, part: Extract<ThreadPart, { kind: 'changes' }>, ctx: IBlockRenderContext, streaming: boolean): void {
	const style = resolveDiffStyle(ctx, part.files.length, part.additions, part.deletions);
	if (style === 'card') {
		renderFileChangeList(parent, part, ctx, style);
		return;
	}

	const section = append(parent, $('.volt-agent-changes-group'));
	if (streaming) {
		const status = append(section, $('div.volt-agent-activity-progress.shimmer'));
		status.textContent = fileChangeGroupTitle(part.files.length, part.commands.length, part.additions, part.deletions);
		renderFileChangeList(section, part, ctx, style);
		return;
	}

	const expanded = ctx.blockState[part.id]?.expanded ?? false;
	const stats = formatChangeStats(part.additions, part.deletions);
	const labelText = fileChangeGroupTitle(part.files.length, part.commands.length, 0, 0);

	const toggle = append(section, $('button.volt-agent-changes-toggle')) as HTMLButtonElement;
	toggle.classList.toggle('expanded', expanded);
	const label = append(toggle, $('span.volt-agent-activity-label'));
	label.textContent = labelText;
	const counts = append(toggle, $('span.volt-file-preview-stats'));
	if (stats.added) {
		append(counts, $('span.volt-file-preview-add')).textContent = stats.added;
	}
	if (stats.removed) {
		append(counts, $('span.volt-file-preview-del')).textContent = stats.removed;
	}
	const chevron = append(toggle, $('span.volt-agent-activity-chevron'));
	chevron.appendChild(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight));
	ctx.store.add(addDisposableListener(toggle, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		ctx.onToggle(part.id);
	}));
	if (!expanded) {
		return;
	}
	renderFileChangeList(section, part, ctx, style);
}

function renderFileChangeList(parent: HTMLElement, part: Extract<ThreadPart, { kind: 'changes' }>, ctx: IBlockRenderContext, style: FileChangeDiffStyle): void {
	const list = append(parent, $(style === 'card' ? '.volt-agent-changes-files.cards' : '.volt-agent-changes-files'));
	for (const file of part.files) {
		renderFileChangeBlock(list, file, ctx, style);
	}
	for (const command of part.commands) {
		renderTerminalBlock(parent, command, ctx);
	}
}

function renderFileChangeBlock(parent: HTMLElement, block: IFileChangeBlock, ctx: IBlockRenderContext, style = resolveDiffStyle(ctx)): void {
	const preview = ctx.instantiationService.createInstance(FileChangePreview);
	ctx.store.add(preview);
	parent.appendChild(preview.element);
	preview.setInput(fileChangeSource(block), {
		style,
		expanded: isExpanded(block, ctx),
		reviewExpanded: false,
		openOnClick: true,
		onToggle: () => ctx.onToggle(block.id),
		onOpen: (resource, startLine, endLine) => ctx.onOpenPath?.(block.path || resource.fsPath, startLine, endLine),
	});
}

function resolveDiffStyle(ctx: IBlockRenderContext, files?: number, additions?: number, deletions?: number): FileChangeDiffStyle {
	return ctx.diffStyle ?? chooseFileChangeDiffStyle({
		surface: 'sidebar',
		files,
		additions,
		deletions,
	});
}

function renderTableBlock(parent: HTMLElement, block: ITableBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.table.volt-agent-table-wrap'));
	if (block.caption) {
		const caption = append(wrap, $('div.volt-agent-table-caption.volt-agent-searchable'));
		caption.textContent = block.caption;
	}
	const table = append(wrap, $('table.volt-agent-table'));
	const thead = append(table, $('thead'));
	const headRow = append(thead, $('tr'));
	for (const header of block.headers) {
		const kind = classifyTableCell(header, header);
		const th = append(headRow, $(`th.${kind}`));
		const label = append(th, $('span.volt-agent-searchable'));
		label.textContent = stripCellMarkup(header);
	}
	const tbody = append(table, $('tbody'));
	for (const row of block.rows) {
		const tr = append(tbody, $('tr'));
		for (const [index, cell] of row.entries()) {
			const kind = classifyTableCell(cell, block.headers[index]);
			const td = append(tr, $(`td.${kind}`));
			const raw = stripCellMarkup(cell);
			if (kind === 'file') {
				const pill = append(td, $('span.volt-agent-path-pill.volt-agent-searchable'));
				pill.textContent = raw;
				setAgentTooltip(pill, raw);
				bindPathOpen(pill, parseFileTarget(raw), ctx);
			} else {
				const span = append(td, $('span.volt-agent-searchable'));
				span.textContent = raw;
			}
		}
	}
	balanceTableColumns(table);
	attachTableCopyControls(wrap, ctx);
}

function renderListBlock(parent: HTMLElement, block: IListBlock, ctx: IBlockRenderContext): void {
	const table = tableFromListItems(block.items, '', block.ordered);
	if (table) {
		renderTableBlock(parent, {
			id: block.id,
			type: 'table',
			status: block.status,
			headers: [...table.headers],
			rows: table.rows.map(row => [...row]),
		}, ctx);
		return;
	}
	const wrap = append(parent, $(`.volt-agent-block.list.volt-agent-list`));
	const list = append(wrap, $(block.ordered ? 'ol' : 'ul'));
	for (const item of block.items) {
		const li = append(list, $('li.volt-agent-searchable'));
		if (/[*_`\[]/.test(item)) {
			renderMarkdownInto(li, item, ctx, 'volt-agent-list-item');
		} else {
			li.textContent = item;
		}
	}
}

function renderCardsBlock(parent: HTMLElement, block: ICardsBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.cards.volt-agent-cards'));
	for (const item of block.items) {
		const card = append(wrap, $('.volt-agent-card'));
		const title = append(card, $('.volt-agent-card-title.volt-agent-searchable'));
		title.textContent = item.title;
		if (item.meta) {
			const meta = append(card, $('.volt-agent-card-meta.volt-agent-searchable'));
			meta.textContent = item.meta;
		}
		renderMarkdownInto(card, item.body, ctx, 'volt-agent-card-body');
	}
}

function renderChartBlock(parent: HTMLElement, block: IChartBlock): void {
	const wrap = append(parent, $('.volt-agent-block.chart.volt-agent-chart'));
	if (block.title) {
		const title = append(wrap, $('.volt-agent-chart-title.volt-agent-searchable'));
		title.textContent = block.title;
	}
	const max = Math.max(...block.values, 0.0001);
	for (const [index, label] of block.labels.entries()) {
		const row = append(wrap, $('.volt-agent-chart-row'));
		const name = append(row, $('span.volt-agent-chart-label.volt-agent-searchable'));
		name.textContent = label;
		const track = append(row, $('.volt-agent-chart-track'));
		const bar = append(track, $('.volt-agent-chart-bar'));
		bar.style.width = `${Math.max(4, (block.values[index] / max) * 100)}%`;
		const value = append(row, $('span.volt-agent-chart-value.volt-agent-searchable'));
		value.textContent = `${formatChartValue(block.values[index])}${block.unit ?? ''}`;
	}
}

function formatChartValue(value: number): string {
	if (Number.isInteger(value)) {
		return String(value);
	}
	return String(Math.round(value * 100) / 100);
}

function renderErrorBlock(parent: HTMLElement, block: IErrorBlock): void {
	const wrap = append(parent, $('.volt-agent-block.error.volt-agent-searchable'));
	wrap.textContent = block.message;
}

function renderApprovalBlock(parent: HTMLElement, block: IApprovalBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.approval'));
	if (block.blocked) {
		wrap.classList.add('blocked');
	}
	if (block.decision) {
		wrap.classList.add(block.decision);
	}
	const title = append(wrap, $('.volt-agent-approval-title'));
	title.textContent = block.blocked
		? localize('voltAgent.access.blocked', "Blocked")
		: actionTitle(block.action);
	const resource = append(wrap, $('pre.volt-agent-approval-resource.volt-agent-searchable'));
	resource.textContent = block.resource;
	const meta = append(wrap, $('.volt-agent-approval-meta'));
	append(meta, $('span.risk')).textContent = localize('voltAgent.access.risk', "Risk {0}", block.risk);
	if (block.reason || block.policySource) {
		append(meta, $('span.reason')).textContent = block.reason || block.policySource || '';
	}
	if (block.blocked) {
		append(wrap, $('.volt-agent-approval-status')).textContent = localize(
			'voltAgent.access.blockedBy',
			"Blocked by {0}",
			block.policySource ?? 'policy',
		);
		return;
	}
	if (block.decision) {
		append(wrap, $('.volt-agent-approval-status')).textContent = block.decision === 'allow'
			? localize('voltAgent.access.allowed', "Allowed {0}", block.scope === 'always' ? localize('voltAgent.access.always', "always") : localize('voltAgent.access.once', "once"))
			: localize('voltAgent.access.denied', "Denied");
		return;
	}
	const actions = append(wrap, $('.volt-agent-approval-actions'));
	const once = append(actions, $('button.volt-agent-approval-btn')) as HTMLButtonElement;
	once.textContent = localize('voltAgent.access.allowOnce', "Allow once");
	const always = append(actions, $('button.volt-agent-approval-btn')) as HTMLButtonElement;
	always.textContent = localize('voltAgent.access.allowAlways', "Always allow {0}", block.pattern || block.resource);
	const deny = append(actions, $('button.volt-agent-approval-btn.deny')) as HTMLButtonElement;
	deny.textContent = localize('voltAgent.access.deny', "Deny");
	const decide = (effect: 'allow' | 'deny', scope: AccessDecisionScope) => {
		ctx.onAccessDecision?.(block.requestId, effect, scope, block.pattern);
	};
	ctx.store.add(addDisposableListener(once, 'click', e => {
		e.preventDefault();
		decide('allow', 'once');
	}));
	ctx.store.add(addDisposableListener(always, 'click', e => {
		e.preventDefault();
		decide('allow', 'always');
	}));
	ctx.store.add(addDisposableListener(deny, 'click', e => {
		e.preventDefault();
		decide('deny', 'once');
	}));
}

function actionTitle(action: string): string {
	switch (action) {
		case 'edit':
			return localize('voltAgent.access.edit', "Edit");
		case 'read':
			return localize('voltAgent.access.read', "Read");
		case 'shell':
		case 'git':
			return localize('voltAgent.access.run', "Run command");
		case 'mcp':
			return localize('voltAgent.access.mcp', "MCP tool");
		default:
			return localize('voltAgent.access.action', "Permission");
	}
}

function wrapMarkdownTables(root: HTMLElement, ctx: IBlockRenderContext): void {
	for (const table of root.querySelectorAll('table')) {
		if (table.closest('.volt-agent-table-wrap')) {
			continue;
		}
		const wrap = document.createElement('div');
		wrap.className = 'volt-agent-table-wrap';
		table.replaceWith(wrap);
		wrap.appendChild(table);
		table.classList.add('volt-agent-table');
		if (isHTMLElement(table) && table.tagName === 'TABLE') {
			const htmlTable = table as HTMLTableElement;
			pruneEmptyTableColumns(htmlTable);
			decorateTableColumns(htmlTable);
			balanceTableColumns(htmlTable);
			attachTableCopyControls(wrap, ctx);
		}
	}
}

function wrapComparableLists(root: HTMLElement, ctx: IBlockRenderContext): void {
	for (const list of [...root.querySelectorAll('ol, ul')]) {
		if (list.closest('.volt-agent-table-wrap, .volt-agent-list, li')) {
			continue;
		}
		const lis = [...list.children].filter((child): child is HTMLLIElement => child.tagName === 'LI');
		const items = lis.map(child => (child.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
		if (lis.some(item => item.querySelector('ul, ol, table'))) {
			continue;
		}
		const table = tableFromListItems(items, root.textContent ?? '', list.tagName === 'OL');
		if (!table) {
			continue;
		}
		const wrap = list.ownerDocument.createElement('div');
		wrap.className = 'volt-agent-table-wrap';
		const htmlTable = list.ownerDocument.createElement('table');
		htmlTable.className = 'volt-agent-table';
		const thead = htmlTable.createTHead();
		const headRow = thead.insertRow();
		for (const header of table.headers) {
			const th = list.ownerDocument.createElement('th');
			th.className = classifyTableCell(header, header);
			const label = list.ownerDocument.createElement('span');
			label.className = 'volt-agent-searchable';
			label.textContent = stripCellMarkup(header);
			th.appendChild(label);
			headRow.appendChild(th);
		}
		const tbody = htmlTable.createTBody();
		for (const row of table.rows) {
			const tr = tbody.insertRow();
			for (const [index, cell] of row.entries()) {
				const kind = classifyTableCell(cell, table.headers[index]);
				const td = tr.insertCell();
				td.className = kind;
				const raw = stripCellMarkup(cell);
				if (kind === 'file') {
					const pill = list.ownerDocument.createElement('span');
					pill.className = 'volt-agent-path-pill volt-agent-searchable';
					pill.textContent = raw;
					td.appendChild(pill);
					bindPathOpen(pill, parseFileTarget(raw), ctx);
				} else {
					const span = list.ownerDocument.createElement('span');
					span.className = 'volt-agent-searchable';
					span.textContent = raw;
					td.appendChild(span);
				}
			}
		}
		list.replaceWith(wrap);
		wrap.appendChild(htmlTable);
		decorateTableColumns(htmlTable);
		balanceTableColumns(htmlTable);
		attachTableCopyControls(wrap, ctx);
	}
}

export function tableElementToPlainText(table: HTMLTableElement): string {
	return [...table.rows]
		.map(row => [...row.cells].map(cell => cellCopyText(cell)).join('\t'))
		.join('\n');
}

export function tableElementToMarkdown(table: HTMLTableElement): string {
	const rows = [...table.rows];
	if (!rows.length) {
		return '';
	}
	const escape = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
	const lines: string[] = [];
	for (let index = 0; index < rows.length; index++) {
		const cells = [...rows[index].cells].map(cell => escape(cellCopyText(cell)));
		lines.push(`| ${cells.join(' | ')} |`);
		if (index === 0 && table.tHead) {
			lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
		}
	}
	return lines.join('\n');
}

function cellCopyText(cell: HTMLTableCellElement): string {
	const content = cell.querySelector(':scope > .volt-agent-table-cell > .volt-agent-table-cell-content');
	return (content?.textContent ?? cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const TABLE_COPY_ICON_PATH = 'M16 5L16.0001 2L2 2L2 16.0001L5 16M8 8L22 8L22 22L8 22L8 8Z';
const TABLE_CHECK_ICON_PATH = 'M20 6 9 17l-5-5';

export function createTableCopyIcon(width = 10, height = 12, extraClass = 'copy-table'): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', TABLE_COPY_ICON_PATH);
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createTableCheckIcon(width = 10, height = 12, extraClass = 'copy-table-check'): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', TABLE_CHECK_ICON_PATH);
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function flashCopyIconSuccess(slot: HTMLElement, win: Window, restoreIcon: () => HTMLElement, durationMs = 1400): void {
	slot.classList.add('copied');
	slot.replaceChildren(createTableCheckIcon(10, 12, 'copy-table-check'));
	win.setTimeout(() => {
		slot.classList.remove('copied');
		slot.replaceChildren(restoreIcon());
	}, durationMs);
}

function ensureTableShell(wrap: HTMLElement): HTMLElement {
	const parent = wrap.parentElement;
	if (parent?.classList.contains('volt-agent-table-shell')) {
		return parent;
	}
	const shell = wrap.ownerDocument.createElement('div');
	shell.className = 'volt-agent-table-shell';
	wrap.parentNode?.insertBefore(shell, wrap);
	shell.appendChild(wrap);
	return shell;
}

function attachTableCopyControls(wrap: HTMLElement, ctx: IBlockRenderContext): void {
	if (wrap.dataset.tableCopyControls === '1') {
		return;
	}
	if (!ctx.onCopyText && !ctx.onTableCopyMenu) {
		return;
	}
	const table = wrap.querySelector('table');
	if (!isHTMLElement(table) || table.tagName !== 'TABLE') {
		return;
	}
	wrap.dataset.tableCopyControls = '1';
	if (ctx.onCopyText) {
		for (const cell of table.querySelectorAll('th, td')) {
			if (isHTMLElement(cell) && (cell.tagName === 'TD' || cell.tagName === 'TH')) {
				enhanceTableCell(cell as HTMLTableCellElement, ctx);
			}
		}
	}
	if (!ctx.onTableCopyMenu) {
		return;
	}
	const shell = ensureTableShell(wrap);
	const actions = append(shell, $('.volt-agent-table-actions'));
	const trigger = append(actions, $('button.volt-agent-table-copy-trigger')) as HTMLButtonElement;
	trigger.type = 'button';
	trigger.setAttribute('aria-haspopup', 'menu');
	trigger.title = localize('voltAgent.tableCopyMenu', "Copy Table");
	trigger.setAttribute('aria-label', trigger.title);
	const iconSlot = append(trigger, $('span.volt-agent-table-copy-icon'));
	iconSlot.appendChild(createTableCopyIcon(10, 12, 'copy-table'));
	append(trigger, $('span.volt-agent-table-copy-label')).textContent = localize('voltAgent.tableCopyTable', "Copy Table");
	ctx.store.add(addDisposableListener(trigger, 'mousedown', e => e.stopPropagation()));
	ctx.store.add(addDisposableListener(trigger, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		ctx.onTableCopyMenu!(trigger, tableElementToPlainText(table), tableElementToMarkdown(table));
	}));
}

function enhanceTableCell(cell: HTMLTableCellElement, ctx: IBlockRenderContext): void {
	if (cell.querySelector(':scope > .volt-agent-table-cell')) {
		return;
	}
	const shell = cell.ownerDocument.createElement('div');
	shell.className = 'volt-agent-table-cell';
	const content = cell.ownerDocument.createElement('div');
	content.className = 'volt-agent-table-cell-content';
	while (cell.firstChild) {
		content.appendChild(cell.firstChild);
	}
	shell.appendChild(content);
	cell.appendChild(shell);
	if (!ctx.onCopyText) {
		return;
	}
	const copyBtn = append(shell, $('button.volt-agent-table-cell-copy')) as HTMLButtonElement;
	copyBtn.type = 'button';
	copyBtn.title = localize('voltAgent.tableCopyCell', "Copy cell");
	copyBtn.setAttribute('aria-label', copyBtn.title);
	const iconSlot = append(copyBtn, $('span.volt-agent-table-cell-copy-icon'));
	iconSlot.appendChild(createTableCopyIcon(10, 11, 'copy-table-cell'));
	ctx.store.add(addDisposableListener(copyBtn, 'mousedown', e => e.stopPropagation()));
	ctx.store.add(addDisposableListener(copyBtn, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		const text = cellCopyText(cell);
		if (!text) {
			return;
		}
		ctx.onCopyText!(text);
		flashCopyIconSuccess(iconSlot, getWindow(cell), () => createTableCopyIcon(10, 11, 'copy-table-cell'));
	}));
}

function pruneEmptyTableColumns(table: HTMLTableElement): void {
	const rows = [...table.rows];
	if (!rows.length) {
		return;
	}
	const colCount = Math.max(...rows.map(row => row.cells.length));
	for (let col = colCount - 1; col >= 0; col--) {
		if (rows.every(row => !(row.cells[col]?.textContent ?? '').trim())) {
			for (const row of rows) {
				row.cells[col]?.remove();
			}
		}
	}
}

function decorateTableColumns(table: HTMLTableElement): void {
	const headerRow = table.tHead?.rows[0] ?? table.rows[0];
	const headers = headerRow ? [...headerRow.cells].map(cell => cell.textContent ?? '') : [];
	for (const row of table.rows) {
		const header = row.parentElement?.tagName === 'THEAD';
		for (const [index, cell] of [...row.cells].entries()) {
			cell.classList.add(classifyTableCell(cell.textContent ?? '', headers[index]));
			if (header) {
				cell.style.fontWeight = '500';
				for (const child of cell.querySelectorAll('.volt-agent-searchable')) {
					if (isHTMLElement(child)) {
						child.style.fontWeight = '500';
					}
				}
			}
		}
	}
}

/**
 * Short columns stay as wide as their text. The long column takes the leftover
 * width so a rank header cannot spill into the name beside it.
 */
function balanceTableColumns(table: HTMLTableElement): void {
	const rows = [...table.rows];
	if (!rows.length) {
		return;
	}
	const colCount = Math.max(...rows.map(row => row.cells.length));
	if (colCount < 1) {
		return;
	}
	const headerRow = table.tHead?.rows[0];
	const bodyRows = headerRow ? rows.filter(row => row !== headerRow) : rows;
	const stats = Array.from({ length: colCount }, (_, col) => {
		let max = 0;
		for (const row of bodyRows) {
			max = Math.max(max, (row.cells[col]?.textContent ?? '').trim().length);
		}
		const kind = `${headerRow?.cells[col]?.className ?? ''} ${bodyRows[0]?.cells[col]?.className ?? ''}`;
		return { max, rank: /\brank\b/.test(kind) };
	});
	const grow = stats.map(stat => !stat.rank && stat.max > 28);
	if (!grow.some(Boolean)) {
		let idx = stats.length - 1;
		let best = -1;
		stats.forEach((stat, i) => {
			if (!stat.rank && stat.max >= best) {
				best = stat.max;
				idx = i;
			}
		});
		grow[idx] = true;
	}
	const growCount = grow.filter(Boolean).length || 1;
	let colgroup = table.querySelector('colgroup');
	if (!colgroup) {
		colgroup = table.ownerDocument.createElement('colgroup');
		table.insertBefore(colgroup, table.firstChild);
	}
	colgroup.replaceChildren();
	for (let col = 0; col < colCount; col++) {
		const flexible = grow[col];
		const colEl = table.ownerDocument.createElement('col');
		colEl.className = flexible ? 'grow' : 'fit';
		colEl.style.width = flexible ? `${Math.floor(100 / growCount)}%` : '1%';
		colgroup.appendChild(colEl);
		for (const row of rows) {
			const cell = row.cells[col];
			if (!cell) {
				continue;
			}
			cell.classList.remove('fit', 'grow');
			cell.classList.add(flexible ? 'grow' : 'fit');
		}
	}
}

function pinCollapsedTerminalTail(wrap: HTMLElement, clip: HTMLElement, content: HTMLElement, scroll: { setScrollPosition(update: { scrollTop: number }): void }): void {
	const visible = clip.clientHeight;
	const full = content.scrollHeight;
	wrap.classList.toggle('clamped', visible > 0 && full > visible + 2);
	if (wrap.classList.contains('expanded') || visible < 8) {
		return;
	}
	const top = Math.max(0, content.scrollHeight - content.clientHeight);
	if (Math.abs(content.scrollTop - top) > 1) {
		scroll.setScrollPosition({ scrollTop: top });
	}
}

function attachContainedScroll(wrap: HTMLElement, content: HTMLElement, ctx: IBlockRenderContext, afterScan?: (scroll: { setScrollPosition(update: { scrollTop: number }): void }) => void): () => void {
	if (wrap.querySelector('.monaco-scrollable-element')) {
		return () => { };
	}
	const scroll = createAgentScrollable(content, {
		horizontal: ScrollbarVisibility.Auto,
		vertical: ScrollbarVisibility.Auto,
		horizontalScrollbarSize: 10,
		verticalScrollbarSize: 10,
		handleMouseWheel: true,
		alwaysConsumeMouseWheel: false,
		consumeMouseWheelIfScrollbarIsNeeded: true,
	});
	wrap.appendChild(scroll.getDomNode());
	ctx.store.add(scroll);
	const scan = () => {
		scroll.scanDomNode();
		afterScan?.(scroll);
		ctx.onScroll();
	};
	queueMicrotask(scan);
	const win = getWindow(wrap);
	win.requestAnimationFrame(scan);
	const observer = new win.ResizeObserver(scan);
	observer.observe(wrap);
	observer.observe(content);
	ctx.store.add(toDisposable(() => observer.disconnect()));
	return scan;
}

function decorateMarkdownPills(root: HTMLElement, ctx: IBlockRenderContext): void {
	for (const code of root.querySelectorAll('code')) {
		if (code.closest('pre, .code')) {
			continue;
		}
		const text = code.textContent ?? '';
		const url = extractHttpUrl(text);
		if (url) {
			code.classList.add('volt-agent-path-pill');
			if (text !== url) {
				code.textContent = url;
			}
			bindUrlOpen(code, url, ctx);
			continue;
		}
		if (isPathLike(text) || text.length > 18) {
			code.classList.add('volt-agent-path-pill');
			bindPathOpen(code, parseFileTarget(text), ctx);
		}
	}
	for (const link of root.querySelectorAll('a')) {
		if (link.querySelector('code')) {
			continue;
		}
		const text = (link.textContent ?? '').trim();
		const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
		const url = extractHttpUrl(text) || extractHttpUrl(href);
		if (url) {
			link.classList.add('volt-agent-path-pill');
			if (text !== url && /https?:\/\//i.test(text)) {
				link.textContent = url;
			}
			bindUrlOpen(link, url, ctx);
			continue;
		}
		if (isPathLike(text) || isPathLike(href)) {
			link.classList.add('volt-agent-path-pill');
			bindPathOpen(link, parseFileTarget(text) ?? parseFileTarget(href), ctx);
		}
	}
}

function bindUrlOpen(el: HTMLElement, url: string, ctx: IBlockRenderContext): void {
	if (!ctx.onOpenUrl) {
		return;
	}
	el.classList.add('clickable');
	setAgentTooltip(el, url);
	ctx.store.add(addDisposableListener(el, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		ctx.onOpenUrl?.(url);
	}));
}

function bindPathOpen(el: HTMLElement, target: ReturnType<typeof parseFileTarget>, ctx: IBlockRenderContext): void {
	if (!target || !ctx.onOpenPath) {
		return;
	}
	el.classList.add('clickable');
	setAgentTooltip(el, target.path);
	ctx.store.add(addDisposableListener(el, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		ctx.onOpenPath?.(target.path, target.startLine, target.endLine);
	}));
}

const SHELL_BUILTINS = new Set([
	'.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen',
	'complete', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit',
	'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let',
	'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly',
	'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type',
	'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);

const SHELL_KEYWORDS = new Set([
	'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in',
	'select', 'then', 'time', 'until', 'while',
]);

type ShellTokenKind = 'cmd' | 'builtin' | 'kw' | 'flag' | 'str' | 'var' | 'op' | 'num' | 'text';

function appendHighlightedShell(parent: HTMLElement, command: string): void {
	const doc = parent.ownerDocument;
	for (const token of tokenizeShell(command)) {
		if (token.kind === 'text') {
			parent.appendChild(doc.createTextNode(token.value));
			continue;
		}
		const span = doc.createElement('span');
		span.className = token.kind;
		span.textContent = token.value;
		parent.appendChild(span);
	}
}

function tokenizeShell(command: string): Array<{ kind: ShellTokenKind; value: string }> {
	const tokens: Array<{ kind: ShellTokenKind; value: string }> = [];
	let i = 0;
	let expectCommand = true;

	const push = (kind: ShellTokenKind, value: string) => {
		if (value) {
			tokens.push({ kind, value });
		}
	};

	while (i < command.length) {
		const ch = command[i];

		if (/\s/.test(ch)) {
			let end = i + 1;
			while (end < command.length && /\s/.test(command[end])) {
				end++;
			}
			push('text', command.slice(i, end));
			i = end;
			continue;
		}

		if (ch === '\'' || ch === '\"') {
			const quote = ch;
			let end = i + 1;
			while (end < command.length) {
				if (command[end] === '\\' && end + 1 < command.length) {
					end += 2;
					continue;
				}
				if (command[end] === quote) {
					end++;
					break;
				}
				end++;
			}
			push('str', command.slice(i, end));
			i = end;
			expectCommand = false;
			continue;
		}

		if (ch === '$' && command[i + 1] === '(') {
			push('op', '$(');
			i += 2;
			expectCommand = true;
			continue;
		}

		if (ch === '$') {
			let end = i + 1;
			if (command[end] === '{') {
				end++;
				while (end < command.length && command[end] !== '}') {
					end++;
				}
				if (command[end] === '}') {
					end++;
				}
			} else {
				while (end < command.length && /[\w?#!@*-]/.test(command[end])) {
					end++;
				}
			}
			push(end > i + 1 ? 'var' : 'text', command.slice(i, Math.max(end, i + 1)));
			i = Math.max(end, i + 1);
			expectCommand = false;
			continue;
		}

		const redir = command.slice(i).match(/^\d*>{1,2}&?(?:\d+|-)?|^\d*</);
		if (redir) {
			push('op', redir[0]);
			i += redir[0].length;
			expectCommand = false;
			continue;
		}

		if (command.startsWith('&&', i) || command.startsWith('||', i) || command.startsWith(';;', i)) {
			push('op', command.slice(i, i + 2));
			i += 2;
			expectCommand = true;
			continue;
		}

		if (ch === '|' || ch === ';' || ch === '&' || ch === '`' || ch === '(') {
			push('op', ch);
			i++;
			expectCommand = ch === '|' || ch === ';' || ch === '`' || ch === '(';
			continue;
		}

		if (ch === ')' || ch === '}' || ch === ']') {
			push('op', ch);
			i++;
			expectCommand = false;
			continue;
		}

		if (ch === '\\') {
			push('op', command.slice(i, Math.min(i + 2, command.length)));
			i = Math.min(i + 2, command.length);
			continue;
		}

		if (ch === '-' && i + 1 < command.length && /[\w-]/.test(command[i + 1])) {
			let end = i + 1;
			while (end < command.length && /[\w-]/.test(command[end])) {
				end++;
			}
			const flag = command.slice(i, end);
			push('flag', flag);
			i = end;
			expectCommand = flag === '-exec' || flag === '-execdir';
			continue;
		}

		if (/\d/.test(ch)) {
			let end = i + 1;
			while (end < command.length && /[\d.]/.test(command[end])) {
				end++;
			}
			push('num', command.slice(i, end));
			i = end;
			expectCommand = false;
			continue;
		}

		let end = i + 1;
		while (end < command.length && !/[\s|"'`;&(){}<>]/.test(command[end]) && command[end] !== '\\') {
			end++;
		}
		const word = command.slice(i, end);
		if (expectCommand) {
			if (SHELL_KEYWORDS.has(word)) {
				push('kw', word);
			} else if (SHELL_BUILTINS.has(word)) {
				push('builtin', word);
			} else {
				push('cmd', word);
			}
			expectCommand = word === 'sudo' || word === 'xargs' || word === 'nice' || word === 'nohup' || word === 'time' || word === 'env' || word === 'command';
		} else {
			push('text', word);
			expectCommand = word === 'xargs';
		}
		i = end;
	}

	return tokens;
}
