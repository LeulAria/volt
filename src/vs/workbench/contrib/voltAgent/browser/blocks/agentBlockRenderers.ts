/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentMarkdown.css';
import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import * as marked from '../../../../../base/common/marked/marked.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { CodeWindow } from '../../../../../base/browser/window.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { bindTruncatedHoverTooltip, setAgentTooltip } from '../chrome/agentTooltip.js';
import {
	AgentBlock,
	classifyTableCell,
	IAnswersBlock,
	IApprovalBlock, IPlanBlock,
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
	isLikelyFilePath,
	isPathLike,
	parseFileTarget,
	stripCellMarkup,
	terminalCommandLabels,
} from './agentBlocks.js';
import { renderMermaidDiagram } from './agentMermaid.js';
import { mountChart, renderVisualBlock } from '../visuals/agentVisuals.js';
import { highlight, ICodeCardOptions, renderCodeCard } from './agentCodeBlock.js';
import { agentMarkdownRenderOptions, agentMarkedExtensions, decorateAgentMarkdown, fenceChartSpec, normalizeMathDelimiters, renderFenceChart } from './agentMarkdown.js';
import type { IFreshTextPart } from '../chrome/agentFreshText.js';
import { extractHttpUrl, extractLocalPreviewUrl, linkifyPreviewUrls } from '../preview/localPreview.js';
import { AccessDecisionScope } from '../../../../services/voltRuntime/common/access/accessTypes.js';
import { formatAttachmentSize } from '../../../../services/voltRuntime/common/fileAttachments.js';
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
	/** The user approved the agent's plan: later turns should run as Agent, not Plan. */
	readonly onBuildPlan?: () => void;
	/** Build a plan the agent wrote with its plan tool: switch to Agent and ask for it. */
	readonly onBuildCreatedPlan?: (plan: IPlanBlock) => void;
	/** Ask for changes to a plan: the composer takes the feedback, and the agent proposes again. */
	readonly onRevisePlan?: (plan: IPlanBlock) => void;
	/** Build a plan in a new chat on its own worktree: the chat forks from this reply and starts with the plan. */
	readonly onBuildPlanInWorktree?: (plan: IPlanBlock) => void;
	/** An inline edit of a plan was saved: the reply is recorded again so the edit survives a reload. */
	readonly onEditPlan?: (plan: IPlanBlock) => void;
	/** Save a plan under `.volt/plans` and resolve to its path. */
	readonly onSavePlan?: (plan: IPlanBlock) => Promise<string | undefined>;
	/** When false, a still-running command must not keep the streaming shimmer. */
	readonly streaming?: boolean;
	/** Highlights code cards. Without it they render as plain text. */
	readonly languageService?: ILanguageService;
	/** Opens a Mermaid diagram larger. */
	readonly onExpandDiagram?: (svg: SVGSVGElement, source: string) => void;
	/** A page under the pointer took a wheel event: scroll the transcript instead. */
	readonly onWheel?: (event: IMouseWheelEvent) => void;
	/** Shows a chart or page full size; `store` is disposed when it closes. */
	readonly onExpandVisual?: (title: string, content: HTMLElement, store: IDisposable) => void;
	/** The chat being drawn (pages keep the state they set for its next turn). */
	readonly sessionId?: string;
	/** A page asked to send a message as the user (`send`), or to put one in the composer. */
	readonly onPagePrompt?: (text: string, page: string, send: boolean) => void;
	/** Runs a reply's shell block in the chat's terminal. */
	readonly onRunInTerminal?: (command: string) => void;
}

export function renderAgentBlock(parent: HTMLElement, block: AgentBlock, ctx: IBlockRenderContext): void {
	switch (block.type) {
		case 'markdown':
			renderMarkdownBlock(parent, block, ctx);
			return;
		case 'code':
			renderCodeBlock(parent, block, ctx);
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
			renderChartBlock(parent, block, ctx);
			return;
		case 'mermaid':
			// A data chart written as mermaid (xychart-beta) draws as a native Volt chart.
			if (fenceChartSpec('mermaid', block.source, block.status === 'streaming')) {
				renderFenceChart(append(parent, $('.volt-agent-block.volt-agent-fence-chart')), 'mermaid', block.source, ctx, block.status === 'streaming');
				return;
			}
			renderMermaidDiagram(parent, block.source, { ...codeCardOptions(ctx), onExpand: ctx.onExpandDiagram, streaming: block.status === 'streaming' && ctx.streaming !== false });
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
			return;
		case 'answers':
			renderAnswersBlock(parent, block, ctx);
			return;
		case 'plan':
			renderPlanBlock(parent, block, ctx);
			return;
		case 'visual':
			renderVisualBlock(parent, block, ctx);
	}
}

/**
 * A plan for approval, as Cursor draws its plan card: title, the plan, then the actions. Volt's plans
 * also list their open questions and can be revised, edited in place, or saved as a document.
 */
function renderPlanBlock(parent: HTMLElement, block: IPlanBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.approval.question.plan'));
	append(wrap, $('.volt-agent-approval-title')).textContent = block.name
		? localize('voltAgent.plan.named', "Plan: {0}", block.name)
		: localize('voltAgent.plan.title', "Plan");
	const body = append(wrap, $('.volt-agent-approval-plan'));
	const savedLine = append(wrap, $('.volt-agent-plan-saved.hidden'));
	const actions = append(wrap, $('.volt-agent-approval-actions'));
	let editor: HTMLTextAreaElement | undefined;

	const renderBody = () => {
		clearNode(body);
		if (block.markdown) {
			renderMarkdownInto(body, block.markdown, ctx);
		} else {
			body.textContent = localize('voltAgent.plan.writing', "Writing the plan…");
		}
		if (block.openQuestions?.length) {
			const questions = append(body, $('.volt-agent-plan-questions'));
			append(questions, $('.volt-agent-plan-questions-title')).textContent = localize('voltAgent.plan.openQuestions', "Open questions");
			const list = append(questions, $('ul'));
			for (const question of block.openQuestions) {
				append(list, $('li')).textContent = question;
			}
		}
	};

	const button = (label: string, className: string, onClick: () => void) => {
		const element = append(actions, $(`button.volt-agent-approval-btn${className}`)) as HTMLButtonElement;
		element.textContent = label;
		ctx.store.add(addDisposableListener(element, 'click', e => {
			e.preventDefault();
			onClick();
		}));
		return element;
	};

	const renderActions = () => {
		clearNode(actions);
		if (block.status !== 'complete' || !ctx.onBuildCreatedPlan) {
			return;
		}
		if (editor) {
			button(localize('voltAgent.plan.saveEdit', "Save edit"), '.primary', () => {
				block.markdown = editor?.value.trim() ?? block.markdown;
				editor = undefined;
				renderBody();
				renderActions();
				ctx.onEditPlan?.(block);
			});
			button(localize('voltAgent.plan.cancelEdit', "Cancel"), '', () => {
				editor = undefined;
				renderBody();
				renderActions();
			});
			return;
		}
		button(localize('voltAgent.plan.approveImplement', "Approve & implement"), '.primary', () => ctx.onBuildCreatedPlan?.(block));
		if (ctx.onBuildPlanInWorktree) {
			button(localize('voltAgent.plan.approveWorktree', "Approve in a new worktree chat"), '', () => ctx.onBuildPlanInWorktree?.(block));
		}
		if (ctx.onRevisePlan) {
			button(localize('voltAgent.plan.revise', "Revise"), '', () => ctx.onRevisePlan?.(block));
		}
		button(localize('voltAgent.plan.edit', "Edit"), '', () => {
			clearNode(body);
			editor = append(body, $('textarea.volt-agent-plan-editor')) as HTMLTextAreaElement;
			editor.value = block.markdown;
			editor.rows = Math.min(24, Math.max(8, block.markdown.split('\n').length));
			renderActions();
			editor.focus();
		});
		if (ctx.onSavePlan) {
			button(localize('voltAgent.plan.save', "Save to .volt/plans"), '', async () => {
				const path = await ctx.onSavePlan?.(block);
				if (path) {
					savedLine.classList.remove('hidden');
					clearNode(savedLine);
					const link = append(savedLine, $('a.volt-agent-plan-saved-link')) as HTMLAnchorElement;
					link.textContent = path;
					link.href = '#';
					ctx.store.add(addDisposableListener(link, 'click', e => {
						e.preventDefault();
						ctx.onOpenPath?.(path);
					}));
				}
			});
		}
	};

	renderBody();
	renderActions();
}

/** Cursor's "Answers" card: each question in muted text over the user's answer, with hairlines between. */
function renderAnswersBlock(parent: HTMLElement, block: IAnswersBlock, ctx: IBlockRenderContext): void {
	const card = append(parent, $('.volt-agent-answers'));
	const header = append(card, $('.volt-agent-answers-header'));
	append(header, $('span.volt-agent-answers-icon')).appendChild(renderIcon(Codicon.commentDiscussion));
	append(header, $('span.volt-agent-answers-title')).textContent = localize('voltAgent.answers', "Answers");
	const body = append(card, $('.volt-agent-answers-body'));
	const pairs = [...block.items];
	if (block.note) {
		pairs.push({ question: localize('voltAgent.answers.details', "Additional details"), answer: block.note });
	}
	pairs.forEach((pair, index) => {
		if (index) {
			append(body, $('.volt-agent-answers-rule'));
		}
		const row = append(body, $('.volt-agent-answers-pair'));
		append(row, $('.volt-agent-answers-question.volt-agent-searchable')).textContent = pair.question;
		if (pair.answer) {
			append(row, $('.volt-agent-answers-answer.volt-agent-searchable')).textContent = pair.answer;
		}
		const files = pair.attachments;
		if (files?.length) {
			const list = append(row, $('.volt-agent-answers-files'));
			for (const file of files) {
				const chip = append(list, $('span.volt-agent-answers-file'));
				chip.appendChild(renderIcon(file.kind === 'image' ? Codicon.fileMedia : Codicon.file));
				append(chip, $('span.volt-agent-answers-file-name.volt-agent-searchable')).textContent = file.name;
				append(chip, $('span.volt-agent-answers-file-size')).textContent = formatAttachmentSize(file.size);
				const path = file.path;
				if (path && ctx.onOpenPath) {
					chip.classList.add('openable');
					chip.title = path;
					ctx.store.add(addDisposableListener(chip, 'click', e => {
						e.preventDefault();
						ctx.onOpenPath?.(path);
					}));
				}
			}
		}
	});
}

function codeCardOptions(ctx: IBlockRenderContext): ICodeCardOptions {
	return {
		store: ctx.store,
		languageService: ctx.languageService,
		instantiationService: ctx.instantiationService,
		onCopyText: ctx.onCopyText,
		onDidChangeSize: ctx.onScroll,
		onOpenPath: ctx.onOpenPath,
		// Only finished replies: a block still streaming may not be the whole command yet.
		...(ctx.onRunInTerminal && !ctx.streaming ? { onRunInTerminal: ctx.onRunInTerminal } : {}),
		fileIconClasses: path => ctx.instantiationService.invokeFunction(accessor => getIconClasses(accessor.get(IModelService), accessor.get(ILanguageService), URI.file(path), FileKind.FILE)),
	};
}

export function renderMarkdownInto(parent: HTMLElement, text: string, ctx: IBlockRenderContext, extraClass?: string): void {
	const element = renderMarkdownElement(getWindow(parent), linkifyPreviewUrls(normalizeMathDelimiters(text)), ctx);
	if (extraClass) {
		element.classList.add(extraClass);
	}
	parent.appendChild(element);
}

/** Renders normalized markdown into a detached, decorated `.volt-agent-markdown` root; its listeners go to `ctx.store`. */
function renderMarkdownElement(win: CodeWindow, source: string, ctx: IBlockRenderContext): HTMLElement {
	const result = ctx.markdownRenderer.render(new MarkdownString(source), {
		...agentMarkdownRenderOptions(win, { ...codeCardOptions(ctx), onExpandDiagram: ctx.onExpandDiagram, visualHost: ctx }),
		fillInIncompleteTokens: true,
		asyncRenderCallback: ctx.onScroll,
		actionHandler: link => openMarkdownLink(link, ctx),
	});
	result.element.classList.add('volt-agent-markdown', 'volt-agent-searchable');
	decorateMarkdownPills(result.element, ctx);
	decorateAgentMarkdown(result.element, ctx.store);
	wrapMarkdownTables(result.element, ctx);
	ctx.store.add(result);
	return result.element;
}

function openMarkdownLink(link: string, ctx: IBlockRenderContext): void {
	const url = extractHttpUrl(link) ?? extractLocalPreviewUrl(link);
	if (url) {
		ctx.onOpenUrl?.(url);
	}
}

/** One top-level markdown block of a {@link LiveMarkdown}, as drawn. */
interface ILiveMarkdownBlock {
	/** Its source, as marked's lexer cut it. */
	readonly raw: string;
	readonly nodes: readonly HTMLElement[];
	readonly store: DisposableStore;
	/** Its text, for the fresh-text fade. */
	readonly text: string;
	/** Drawn by the latest update. */
	fresh: boolean;
}

/**
 * A reply's markdown while it streams in, drawn one top-level block (paragraph, list, table, quote)
 * at a time. Every block but the last is final once the next one starts, so an update keeps their
 * DOM (with its selection, hover and running fades) and redraws only from the first block whose
 * source changed: normally just the last, open one. Only the text from the last block on is lexed
 * again. Footnote numbers and link references resolve within a block until the reply is drawn whole.
 */
export class LiveMarkdown extends Disposable {

	/** The reply's `.volt-agent-markdown` root; the blocks' elements are its children, as in a whole render. */
	readonly element: HTMLElement;
	private blocks: ILiveMarkdownBlock[] = [];
	private source: string | undefined;
	private ctx: IBlockRenderContext;
	private lexerFor: { readonly extensions: number; readonly instance: marked.Marked } | undefined;

	constructor(ctx: IBlockRenderContext) {
		super();
		this.ctx = ctx;
		this.element = $('div.rendered-markdown.volt-agent-markdown.volt-agent-searchable');
		// The renderer binds link clicks to each block's own root, which is not kept: one handler serves all.
		const activate = (e: UIEvent) => {
			const link = isHTMLElement(e.target) ? e.target.closest('a[data-href]') : null;
			if (!isHTMLElement(link) || !this.element.contains(link)) {
				return;
			}
			e.preventDefault();
			const href = link.dataset['href'];
			if (href) {
				openMarkdownLink(href, this.ctx);
			}
		};
		this._register(addDisposableListener(this.element, 'click', e => {
			if (e.button === 0 || e.button === 1) {
				activate(e);
			}
		}));
		this._register(addDisposableListener(this.element, 'auxclick', e => {
			if (e.button === 1) {
				activate(e);
			}
		}));
		this._register(addDisposableListener(this.element, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				activate(e);
			}
		}));
		this._register(toDisposable(() => {
			for (const block of this.blocks) {
				block.store.dispose();
			}
			this.blocks = [];
		}));
	}

	/** Draws `text`, keeping the blocks whose source did not change. */
	update(text: string, ctx: IBlockRenderContext): void {
		this.ctx = ctx;
		for (const block of this.blocks) {
			block.fresh = false;
		}
		if (text === this.source) {
			return;
		}
		this.source = text;
		const win = getWindow(this.element);
		const source = linkifyPreviewUrls(normalizeMathDelimiters(text));
		const raws = this.split(win, source);
		let keep = 0;
		while (keep < raws.length && keep < this.blocks.length && this.blocks[keep].raw === raws[keep]) {
			keep++;
		}
		for (const block of this.blocks.splice(keep)) {
			for (const node of block.nodes) {
				node.remove();
			}
			block.store.dispose();
		}
		for (let index = keep; index < raws.length; index++) {
			const store = new DisposableStore();
			const root = renderMarkdownElement(win, raws[index], { ...ctx, store });
			const nodes: HTMLElement[] = [];
			for (const node of [...root.childNodes]) {
				if (isHTMLElement(node)) {
					nodes.push(node);
				} else if (node.textContent?.trim()) {
					// Loose top-level text (raw HTML) goes in a span, so the fade can walk it like the rest.
					const span = $('span');
					span.textContent = node.textContent;
					nodes.push(span);
				}
				// Whitespace between blocks is dropped: it lays out as nothing between block elements.
			}
			this.element.append(...nodes);
			this.blocks.push({ raw: raws[index], nodes, store, text: nodes.map(node => node.textContent ?? '').join(''), fresh: true });
		}
	}

	/** The text in reading order; the blocks drawn by the latest update carry their elements. */
	parts(): IFreshTextPart[] {
		return this.blocks.map(block => block.fresh ? { text: block.text, roots: block.nodes } : { text: block.text });
	}

	/**
	 * Cuts the source into top-level blocks, as the renderer's lexer does. The blocks before the
	 * last one drawn are final, so lexing starts at the last one (at the last one with text, when
	 * blank lines follow it: a list item can still go on after one). Sources the lexer does not
	 * cover exactly (link definitions it sets aside) are drawn whole.
	 */
	private split(win: CodeWindow, source: string): string[] {
		const settled: string[] = [];
		let offset = 0;
		let open = this.blocks.length - 1;
		while (open > 0 && !this.blocks[open].raw.trim()) {
			open--;
		}
		for (const block of this.blocks.slice(0, Math.max(0, open))) {
			if (!source.startsWith(block.raw, offset)) {
				settled.length = 0;
				offset = 0;
				break;
			}
			settled.push(block.raw);
			offset += block.raw.length;
		}
		const rest = source.slice(offset);
		const lexer = this.lexer(win);
		const raws = lexer.lexer(rest, { ...lexer.defaults, gfm: true }).map(token => token.raw);
		let covered = 0;
		for (const raw of raws) {
			covered += raw.length;
		}
		if (covered !== rest.length) {
			return [source];
		}
		return [...settled, ...raws];
	}

	private lexer(win: CodeWindow): marked.Marked {
		const extensions = agentMarkedExtensions(win);
		// KaTeX loads lazily: once it is there, lex with it as the renderer does.
		if (this.lexerFor?.extensions !== extensions.length) {
			this.lexerFor = { extensions: extensions.length, instance: new marked.Marked(...extensions) };
		}
		return this.lexerFor.instance;
	}
}

function renderMarkdownBlock(parent: HTMLElement, block: IMarkdownBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.markdown'));
	renderMarkdownInto(wrap, block.content, ctx);
}

function renderCodeBlock(parent: HTMLElement, block: ICodeBlock, ctx: IBlockRenderContext): void {
	if (fenceChartSpec(block.language, block.code, block.status === 'streaming')) {
		// ```volt-chart: the chart itself (a skeleton while its JSON streams in).
		renderFenceChart(append(parent, $('.volt-agent-block.volt-agent-fence-chart')), block.language, block.code, ctx, block.status === 'streaming');
		return;
	}
	const wrap = append(parent, $('.volt-agent-block.code'));
	// A whole file the reply shows ("Grok created src/array.js:") reads as that file, the way an
	// edit is drawn. Streaming fences stay code cards: the file card is a diff editor per frame.
	if (block.path && block.status !== 'streaming') {
		wrap.classList.add('file');
		renderFileChangeBlock(wrap, {
			id: block.id,
			type: 'file',
			status: block.status,
			path: block.path,
			verb: 'Created',
			original: '',
			modified: block.code.replace(/\n$/, '') + '\n',
			expanded: true,
		}, ctx, 'card');
		return;
	}
	renderCodeCard(wrap, block.language, block.code, { ...codeCardOptions(ctx), streaming: block.status === 'streaming' });
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
		const text = showLabels ? `${titleText} ${labelText}` : titleText;
		headline.textContent = text;
		// The highlight is a copy of the text in a band that slides by transform alone (agentEditor.css),
		// so a running command repaints nothing per frame. The copy counter-slides to stay on the text.
		const sweep = append(headline, $('span.volt-agent-term-sweep'));
		sweep.setAttribute('aria-hidden', 'true');
		const copy = append(sweep, $('span.volt-agent-term-sweep-text'));
		copy.textContent = text;
		lockAnimationPhase(sweep, TERMINAL_SWEEP_MS);
		lockAnimationPhase(copy, TERMINAL_SWEEP_MS);
	} else {
		const title = append(headline, $('span.volt-agent-term-title.volt-agent-searchable'));
		title.textContent = titleText;
		if (showLabels) {
			const meta = append(headline, $('code.volt-agent-term-cmds.volt-agent-searchable'));
			meta.textContent = labelText;
		}
	}
	const setExpanded = (next: boolean) => {
		wrap.classList.toggle('expanded', next);
		header.setAttribute('aria-expanded', String(next));
		ctx.blockState[block.id] = { expanded: next };
		block.expanded = next;
		// The card changed height in place: the thread re-reads its scroll height this frame.
		ctx.onScroll();
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

	// For the bar's corners (agentEditor.css): a :has(.volt-agent-term-body) on the block restyled it as output streamed in.
	wrap.classList.add('has-term-body');
	const body = append(wrap, $('.volt-agent-term-body'));
	const clip = append(body, $('.volt-agent-term-output-clip'));
	// Terminal output never scrolls on its own: collapsed, the clip aligns the output to its bottom
	// edge, so the tail shows with nothing to measure or pin (agentEditor.css); expanded shows all of it.
	const content = append(clip, $('.volt-agent-term-output-scroll'));
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
	observeTerminalClamp(wrap, clip, content, ctx.store);
}

/** One period of the running command's headline sweep (agentEditor.css). */
const TERMINAL_SWEEP_MS = 900;

/**
 * Starts an infinite animation on a newly drawn element in phase with the page clock, so an element
 * redrawn mid-stream picks up where its predecessor was instead of restarting (spinners, shimmers).
 */
export function lockAnimationPhase(el: HTMLElement, durationMs: number): void {
	el.style.animationDelay = `${-Math.round(getWindow(el).performance.now() % durationMs)}ms`;
}

interface IClampTarget {
	readonly wrap: HTMLElement;
	readonly clip: HTMLElement;
	readonly content: HTMLElement;
}

const clampObservers = new WeakMap<Window, ResizeObserver>();
const clampTargets = new WeakMap<Element, IClampTarget>();
const clampHeights = new WeakMap<Element, number>();

/**
 * Marks a terminal card `clamped` while its output is taller than the collapsed clip (the fade at
 * the top). One observer serves every card in the window and reads sizes from its entries, so no
 * card forces a layout, and nothing runs while the sizes hold still.
 */
function observeTerminalClamp(wrap: HTMLElement, clip: HTMLElement, content: HTMLElement, store: DisposableStore): void {
	const win = getWindow(wrap);
	let observer = clampObservers.get(win);
	if (!observer) {
		observer = new win.ResizeObserver(entries => {
			const changed = new Set<IClampTarget>();
			for (const entry of entries) {
				clampHeights.set(entry.target, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
				const target = clampTargets.get(entry.target);
				if (target) {
					changed.add(target);
				}
			}
			for (const target of changed) {
				const visible = clampHeights.get(target.clip) ?? 0;
				const full = clampHeights.get(target.content) ?? 0;
				target.wrap.classList.toggle('clamped', visible > 0 && full > visible + 2);
			}
		});
		clampObservers.set(win, observer);
	}
	const target: IClampTarget = { wrap, clip, content };
	clampTargets.set(clip, target);
	clampTargets.set(content, target);
	observer.observe(clip);
	observer.observe(content);
	const watching = observer;
	store.add(toDisposable(() => {
		watching.unobserve(clip);
		watching.unobserve(content);
	}));
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
	balanceTableColumns(table as HTMLTableElement);
	attachTableCopyControls(wrap, ctx);
}

function renderListBlock(parent: HTMLElement, block: IListBlock, ctx: IBlockRenderContext): void {
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

/** The native loop's bar list, drawn by the chart engine as a ranked chart. */
function renderChartBlock(parent: HTMLElement, block: IChartBlock, ctx: IBlockRenderContext): void {
	const wrap = append(parent, $('.volt-agent-block.chart.volt-agent-chart.engine'));
	const spec = {
		type: 'ranked',
		title: block.title,
		unit: block.unit ? { suffix: block.unit } : undefined,
		limit: 20,
		data: block.labels.map((label, index) => ({ label, value: block.values[index] ?? 0 })),
	};
	mountChart(wrap, `${block.id}:${block.labels.length}:${block.values.join(',')}`, spec, ctx);
}

function renderErrorBlock(parent: HTMLElement, block: IErrorBlock): void {
	const wrap = append(parent, $('.volt-agent-block.error.volt-agent-searchable'));
	wrap.textContent = block.message;
}

/** Approval cards that already faded in, by block id (bounded). */
const shownApprovals = new Set<string>();
const SHOWN_APPROVALS_MAX = 500;

function renderApprovalBlock(parent: HTMLElement, block: IApprovalBlock, ctx: IBlockRenderContext): void {
	if (block.action === 'question' && !block.blocked) {
		renderQuestionBlock(parent, block, ctx);
		return;
	}
	const wrap = append(parent, $('.volt-agent-block.approval'));
	// The card fades in once; drawn again (a decision, a redraw of its exchange) it just appears.
	if (shownApprovals.has(block.id)) {
		wrap.classList.add('shown');
	} else {
		shownApprovals.add(block.id);
		if (shownApprovals.size > SHOWN_APPROVALS_MAX) {
			const oldest = shownApprovals.values().next().value;
			if (oldest !== undefined) {
				shownApprovals.delete(oldest);
			}
		}
	}
	if (block.blocked) {
		wrap.classList.add('blocked');
	}
	if (block.decision) {
		wrap.classList.add(block.decision);
	}
	const isCommand = block.action === 'shell' || block.action === 'git';
	// Cursor's ACP titles wrap the command in backticks (`node --test`).
	const unquote = (text: string) => text.trim().replace(/^`+([^`][\s\S]*?)`+$/, '$1').trim();
	const resource = isCommand ? unquote(block.resource) : block.resource.trim();
	const reason = block.reason?.trim() && !block.blocked && unquote(block.reason) !== resource ? block.reason.trim() : undefined;
	if (isCommand && resource) {
		// A command waiting to run reads as the terminal it will run in, highlighted, with
		// Skip / Always Run / Run under it.
		wrap.classList.add('command');
		renderTerminalBlock(wrap, { id: `${block.id}-command`, type: 'terminal', status: 'complete', command: resource, output: '', expanded: true }, ctx);
		if (block.blocked) {
			append(wrap, $('.volt-approval-reason')).textContent = localize('voltAgent.access.blockedCommand', "Blocked");
		} else if (reason) {
			append(wrap, $('.volt-approval-reason')).textContent = reason;
		}
	} else {
		// Cursor's approval card: one "Edit: src/a.ts" line, then Skip / Always Allow / Allow.
		// A long or multi-line resource moves into a mono block below instead of repeating in the line.
		const body = append(wrap, $('.volt-approval-body'));
		const line = append(body, $('.volt-approval-line'));
		const action = append(line, $('span.volt-approval-action'));
		const verb = block.blocked ? localize('voltAgent.access.blockedColon', "Blocked:") : approvalVerb(block.action);
		const expanded = resource.includes('\n') || resource.length > 72;
		const inline = expanded ? reason : resource;
		action.textContent = inline ? verb : verb.replace(/:\s*$/, '');
		if (inline) {
			const detail = append(line, $('span.volt-approval-detail.volt-agent-searchable'));
			detail.textContent = inline.split('\n')[0];
			setAgentTooltip(detail, inline);
		}
		if (expanded) {
			append(body, $('pre.volt-approval-resource.volt-agent-searchable')).textContent = resource;
		} else if (reason) {
			append(body, $('.volt-approval-reason')).textContent = reason;
		}
	}
	const footer = append(wrap, $('.volt-approval-footer'));
	if (block.blocked) {
		append(footer, $('span.volt-approval-status')).textContent = localize('voltAgent.access.blockedBy', "Blocked by {0}", block.policySource ?? 'policy');
		return;
	}
	if (block.decision) {
		append(footer, $('span.volt-approval-status')).textContent = block.decision === 'allow'
			? localize('voltAgent.access.allowed', "Allowed {0}", block.scope === 'always' ? localize('voltAgent.access.always', "always") : localize('voltAgent.access.once', "once"))
			: localize('voltAgent.access.denied', "Denied");
		return;
	}
	const shell = isCommand;
	const skip = append(footer, $('button.volt-approval-btn.text')) as HTMLButtonElement;
	skip.textContent = localize('voltAgent.access.skip', "Skip");
	const always = append(footer, $('button.volt-approval-btn.secondary')) as HTMLButtonElement;
	always.textContent = shell ? localize('voltAgent.access.alwaysRun', "Always Run") : localize('voltAgent.access.alwaysAllowShort', "Always Allow");
	setAgentTooltip(always, localize('voltAgent.access.allowAlways', "Always allow {0}", block.pattern || block.resource));
	const once = append(footer, $('button.volt-approval-btn.primary')) as HTMLButtonElement;
	append(once, $('span')).textContent = shell ? localize('voltAgent.access.run', "Run") : localize('voltAgent.access.allow', "Allow");
	// allow-any-unicode-next-line
	append(once, $('span.volt-approval-kbd')).textContent = '⏎';
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
	ctx.store.add(addDisposableListener(skip, 'click', e => {
		e.preventDefault();
		decide('deny', 'once');
	}));
	// Enter runs it, as in Cursor, while focus is in the card.
	wrap.tabIndex = -1;
	ctx.store.add(addDisposableListener(wrap, 'keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			decide('allow', 'once');
		}
	}));
}

function approvalVerb(action: string): string {
	switch (action) {
		case 'edit':
			return localize('voltAgent.access.editColon', "Edit:");
		case 'read':
			return localize('voltAgent.access.readColon', "Read:");
		case 'shell':
		case 'git':
			return localize('voltAgent.access.runColon', "Run command:");
		case 'mcp':
			return localize('voltAgent.access.mcpColon', "Use tool:");
		default:
			return localize('voltAgent.access.permissionColon', "Allow:");
	}
}

/**
 * An agent's plan waiting for approval, or a question for the user. It reads as the plan
 * itself with Build / Keep planning, not as a permission prompt.
 */
function renderQuestionBlock(parent: HTMLElement, block: IApprovalBlock, ctx: IBlockRenderContext): void {
	const plan = /plan/i.test(block.reason ?? '') || /^\s*#/.test(block.resource);
	const wrap = append(parent, $('.volt-agent-block.approval.question'));
	if (block.decision) {
		wrap.classList.add(block.decision);
	}
	append(wrap, $('.volt-agent-approval-title')).textContent = plan
		? localize('voltAgent.plan.ready', "Plan ready")
		: block.reason || localize('voltAgent.question', "Question");
	const body = append(wrap, $('.volt-agent-approval-plan'));
	renderMarkdownInto(body, block.resource, ctx);
	if (block.decision) {
		append(wrap, $('.volt-agent-approval-status')).textContent = block.decision === 'allow'
			? (plan ? localize('voltAgent.plan.building', "Building") : localize('voltAgent.question.yes', "Approved"))
			: (plan ? localize('voltAgent.plan.kept', "Kept planning") : localize('voltAgent.question.no', "Declined"));
		return;
	}
	const actions = append(wrap, $('.volt-agent-approval-actions'));
	const build = append(actions, $('button.volt-agent-approval-btn.primary')) as HTMLButtonElement;
	build.textContent = plan ? localize('voltAgent.plan.build', "Build") : localize('voltAgent.question.approve', "Approve");
	const keep = append(actions, $('button.volt-agent-approval-btn.deny')) as HTMLButtonElement;
	keep.textContent = plan ? localize('voltAgent.plan.keepPlanning', "Keep planning") : localize('voltAgent.question.decline', "Decline");
	ctx.store.add(addDisposableListener(build, 'click', e => {
		e.preventDefault();
		ctx.onAccessDecision?.(block.requestId, 'allow', 'once');
		if (plan) {
			ctx.onBuildPlan?.();
		}
	}));
	ctx.store.add(addDisposableListener(keep, 'click', e => {
		e.preventDefault();
		ctx.onAccessDecision?.(block.requestId, 'deny', 'once');
	}));
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
	// The visible label says it; a title would show "Copy Table" a second time on hover.
	trigger.setAttribute('aria-label', localize('voltAgent.tableCopyMenu', "Copy Table"));
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
		if (isLikelyFilePath(text)) {
			code.classList.add('volt-agent-path-pill');
			bindPathOpen(code, parseFileTarget(text), ctx);
			continue;
		}
		highlightInlineCode(code, text, ctx);
	}
	for (const link of root.querySelectorAll('a')) {
		// The renderer sets title=href; the agent tooltip below (or the chip inside) says it once.
		const title = link.getAttribute('title');
		link.removeAttribute('title');
		if (link.querySelector('code')) {
			continue;
		}
		const text = (link.textContent ?? '').trim();
		const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
		const url = extractHttpUrl(href) || extractHttpUrl(text);
		if (url) {
			bindUrlOpen(link, url, ctx);
		} else if (isPathLike(text) || isPathLike(href)) {
			link.classList.add('volt-agent-path-link');
			bindPathOpen(link, parseFileTarget(text) ?? parseFileTarget(href), ctx);
		}
		// An explicit markdown title (`[x](url "Title")`) still shows, styled; the default one is the href.
		if (title && title !== text && title !== href && !/^[a-z][\w+.-]*:/i.test(title) && !isPathLike(title)) {
			setAgentTooltip(link, title);
		}
	}
}

/**
 * The language inline code reads as, from its shape alone: `</body>` is HTML, `a => a.b` script,
 * `npm test` shell. Words, names and ids stay plain.
 */
export function guessInlineCodeLanguage(text: string): string | undefined {
	const code = text.trim();
	if (code.length < 2 || code.length > 240 || code.includes('\n')) {
		return undefined;
	}
	if (/^<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/.test(code) || /<\/[A-Za-z][\w-]*>$/.test(code)) {
		return 'html';
	}
	if (/^(\{[\s\S]*\}|\[[\s\S]*\])$/.test(code) && /["\d:]/.test(code)) {
		return 'json';
	}
	if (/^[.#]?[\w-]+(\s*[>+~]?\s*[.#]?[\w-]+)*\s*\{[^{}]*\}$/.test(code) || /^[a-z-]+:\s*[^;]+;$/.test(code)) {
		return 'css';
	}
	if (/^(npm|npx|pnpm|yarn|bun|git|cd|ls|cat|echo|mkdir|rm|cp|mv|curl|node|python3?|pip3?|brew|make|sleep|grep|chmod|export|sudo)\s/.test(code)) {
		return 'shellscript';
	}
	if (/=>|===|!==|&&|\|\||\b(const|let|var|function|return|import|export|await|async|new|class|interface|typeof)\b|\w\([^()]*\)|\w\.\w+\(/.test(code)) {
		return 'typescript';
	}
	return undefined;
}

/** Colours inline code that reads as code, with the editor theme's token colours. */
function highlightInlineCode(code: HTMLElement, text: string, ctx: IBlockRenderContext): void {
	const language = ctx.languageService && guessInlineCodeLanguage(text);
	if (!language) {
		return;
	}
	code.classList.add('volt-agent-inline-highlight');
	highlight(ctx.languageService!, language, text).then(lines => {
		// The reply may have re-rendered or the chip changed while the tokenizer loaded.
		if (code.textContent !== text) {
			return;
		}
		// The cache keeps its nodes for the next render, so this chip gets copies.
		code.replaceChildren(...lines.flat().map(node => node.cloneNode(true)));
	}, () => { /* no tokenizer: stays plain */ });
}

function bindUrlOpen(el: HTMLElement, url: string, ctx: IBlockRenderContext): void {
	if (!ctx.onOpenUrl) {
		return;
	}
	el.classList.add('clickable');
	// A link or chip that already reads as the URL needs no tooltip repeating it.
	const text = (el.textContent ?? '').trim();
	if (text !== url && text.replace(/\/$/, '') !== url.replace(/\/$/, '')) {
		setAgentTooltip(el, url);
	} else {
		// Unless the chip is cut off with an ellipsis.
		ctx.store.add(bindTruncatedHoverTooltip(el, url));
	}
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
	// A chip already shows its path; only a link with other words names where it goes.
	if (!(el.textContent ?? '').includes(target.path)) {
		setAgentTooltip(el, target.path);
	}
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

export function appendHighlightedShell(parent: HTMLElement, command: string): void {
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
