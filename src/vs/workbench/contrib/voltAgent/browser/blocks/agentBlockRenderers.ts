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
	ICodeBlock,
	IErrorBlock,
	IFileChangeBlock,
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
		out.textContent = block.output;
	}
	scanOutput.current = attachContainedScroll(clip, content, ctx, () => {
		wrap.classList.toggle('clamped', content.scrollHeight > clip.clientHeight + 2);
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
	attachTableScroll(wrap, ctx);
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
		}
		attachTableScroll(wrap, ctx);
	}
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
		for (const [index, cell] of [...row.cells].entries()) {
			cell.classList.add(classifyTableCell(cell.textContent ?? '', headers[index]));
		}
	}
}

function attachTableScroll(wrap: HTMLElement, ctx: IBlockRenderContext): void {
	const table = wrap.querySelector('table');
	if (!table || wrap.querySelector('.monaco-scrollable-element')) {
		return;
	}
	const content = $('.volt-agent-table-scroll');
	content.appendChild(table);
	attachContainedScroll(wrap, content, ctx);
}

function attachContainedScroll(wrap: HTMLElement, content: HTMLElement, ctx: IBlockRenderContext, afterScan?: () => void): () => void {
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
		afterScan?.();
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
