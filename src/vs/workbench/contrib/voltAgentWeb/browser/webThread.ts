/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, isSVGElement } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IBlockRenderContext, renderAgentBlock } from '../../voltAgent/browser/blocks/agentBlockRenderers.js';
import { preloadMarkdownExtras } from '../../voltAgent/browser/blocks/agentMarkdown.js';
import { buildTranscriptRows, hasSignInNotice, TranscriptRow, withoutFailureNotice } from '../../voltAgent/browser/chrome/agentTranscript.js';
import { fallbackSubagentView, ITranscriptHost, renderTranscript, tickElapsed } from '../../voltAgent/browser/chrome/agentTranscriptView.js';
import { dayjs } from '../../voltAgent/browser/chrome/dayjs.js';
import { IRunEndTray, ITurnFileChange, PLANNING_PHRASE, runEndTray, turnFileChanges, STATUS_ROTATE_MS, STATUS_SWAP_MS, streamingActivityLines, todoChecklist } from '../../voltAgent/browser/chrome/agentTimeline.js';
import { agentMessagePlainText } from '../../voltAgent/browser/context/agentContextUsage.js';
import type { IAgentAssistantMessage, IAgentMessage, IAgentUserMessage } from '../../voltAgent/browser/editor/agentEditor.js';
import { createCopyIcon, createForkIcon, createStopIcon } from '../../voltAgent/browser/editor/agentEditorIcons.js';
import { resumeTurnPrompt } from '../../voltAgent/browser/editor/agentEditorFormat.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IAgentSessionChange } from '../../voltAgent/browser/editor/agentSessionController.js';
import { shouldOfferScrollToBottom } from '../../voltAgent/browser/composer/agentThinkingDots.js';
import { subagentView } from '../../voltAgent/browser/chrome/agentSubagents.js';
import { agentRow } from '../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { AgentThreadView } from '../../voltAgent/browser/editor/agentThreadView.js';
import { RemoteAgentSessionControl } from '../../voltAgent/browser/editor/remoteAgentSessionControl.js';
import { CHANGES_ICON_PATH, createSurfaceStrokeIcon, FILES_ICON_SHAPES } from '../../voltAgent/browser/workspace/agentSurfaceMenu.js';
import { chooseFileChangeDiffStyle, formatChangeStats } from '../../voltAgent/browser/review/fileChangePreviewModel.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { WebAgentServices } from './webServices.js';

const noModels: Partial<IModelService> = { getModel: () => null };
const NO_MODELS = noModels as IModelService;

/** Streaming redraws at most this often (the agent window's STREAM_FRAME_MS). */
const STREAM_FRAME_MS = 50;
/** Quiet this long, the live phrase becomes "Taking longer than expected". */
const SLOW_TURN_MS = 90_000;

function startsExchange(message: IAgentMessage): boolean {
	return message.kind === 'user' && message.origin !== 'notification';
}

/**
 * One chat's transcript, drawn like the agent window draws it: the same thread element and row
 * model, the same transcript, block, markdown and code renderers, and the same CSS. The
 * messages are the agent server's (its session controller folds the run events).
 */
export class WebThread extends Disposable {

	readonly element: HTMLElement;
	readonly editor: HTMLElement;
	readonly main: HTMLElement;
	private readonly view: AgentThreadView;
	private readonly listeners = this._register(new DisposableStore());
	private readonly sessionStore = this._register(new DisposableStore());
	private control: RemoteAgentSessionControl | undefined;
	private host: { sessionId: string; messages: IAgentMessage[]; contextUsed?: number; contextWindow?: number; recordAssistant(): void } | undefined;
	private stickToBottom = true;
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private clock: number | undefined;
	private rotateTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly statusMotion = new Map<string, { text: string; from?: string; started?: number }>();
	private readonly liveTurns = new WeakSet<IAgentAssistantMessage>();

	private readonly _onDidChangeScrolledUp = this._register(new Emitter<boolean>());
	/** The reader scrolled away from the end (the composer offers the jump back). */
	readonly onDidChangeScrolledUp = this._onDidChangeScrolledUp.event;
	private scrolledUp = false;

	private readonly _onDidChange = this._register(new Emitter<IAgentSessionChange>());
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly services: WebAgentServices) {
		super();
		this.element = $('.editor-instance.volt-agent-editor-instance');
		this.editor = append(this.element, $('.volt-agent-editor'));
		this.editor.dataset.mode = 'agent';
		this.main = append(this.editor, $('.volt-agent-editor-main'));
		this.view = this._register(new AgentThreadView());
		this.main.appendChild(this.view.element);
		this.mountSideRail();
		this._register(this.view.scroll.onScroll(e => {
			const grewAtEnd = this.stickToBottom && !e.scrollTopChanged && e.scrollHeightChanged;
			this.stickToBottom = grewAtEnd || e.scrollTop + e.height >= e.scrollHeight - 32;
			const scrolledUp = !grewAtEnd && shouldOfferScrollToBottom(this.messages.length > 0, e.scrollHeight - (e.scrollTop + e.height));
			if (scrolledUp !== this.scrolledUp) {
				this.scrolledUp = scrolledUp;
				this._onDidChangeScrolledUp.fire(scrolledUp);
			}
		}));
		// KaTeX and Mermaid load lazily; redraw once they are in.
		void preloadMarkdownExtras(mainWindow).then(() => this.render());
		this._register({ dispose: () => this.stopTimers() });
	}

	/**
	 * The chat's side toolbar as the window shows it beside a transcript (collapsed to its icon
	 * rail). Its surfaces (changes, browser, terminal, files) live in the desktop window.
	 */
	private mountSideRail(): void {
		const quickOpen = $('.volt-agent-quick-open-actions.collapsed');
		quickOpen.setAttribute('aria-label', localize('voltAgent.chatSideToolbar', "Chat Side Toolbar"));
		const toggle = append(quickOpen, $('button.volt-agent-quick-open-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		append(toggle, $('span.volt-agent-dock-label'));
		const chevron = createSurfaceStrokeIcon(document, 'M6 7L11 12L6 17M13 7L18 12L13 17');
		chevron.setAttribute('viewBox', '4 5 16 14');
		chevron.setAttribute('width', '16');
		chevron.setAttribute('height', '16');
		chevron.setAttribute('stroke-width', '1');
		toggle.appendChild(chevron);
		const rail = append(quickOpen, $('.volt-agent-quick-open-rail'));
		const actions: [string, (() => Element)][] = [
			[localize('voltAgent.dock.changes', "Changes"), () => createSurfaceStrokeIcon(document, CHANGES_ICON_PATH)],
			[localize('voltAgent.dock.browser', "Browser"), () => renderIcon(Codicon.globe)],
			[localize('voltAgent.dock.terminal', "Terminal"), () => renderIcon(Codicon.terminal)],
			[localize('voltAgent.dock.files', "Files"), () => createSurfaceStrokeIcon(document, FILES_ICON_SHAPES)],
		];
		for (const [label, icon] of actions) {
			const button = append(rail, $('button.volt-agent-rail-btn')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			button.title = localize('voltWeb.inDesktop', "{0} opens in the Volt window", label);
			append(button, $('span.volt-agent-dock-label')).textContent = label;
			const iconEl = icon();
			if (isSVGElement(iconEl)) {
				iconEl.classList.add('volt-agent-stroke-icon');
			}
			button.appendChild(iconEl);
		}
		append(quickOpen, $('.volt-agent-quick-open-body'));
		// On the scroller, right before its vertical scrollbar (as the window mounts it).
		const host = this.view.scroll.getDomNode();
		const scrollbar = host.querySelector(':scope > .scrollbar.vertical');
		host.insertBefore(quickOpen, scrollbar);
		this.editor.classList.add('has-quick-open', 'quick-open-collapsed');
	}

	get sessionId(): string | undefined {
		return this.host?.sessionId;
	}

	get messages(): readonly IAgentMessage[] {
		return this.host?.messages ?? [];
	}

	get isStreaming(): boolean {
		const last = this.host?.messages.at(-1);
		return last?.kind === 'agent' && !!last.activity?.streaming;
	}

	/** Shows a chat: opens it on the server and follows its patches. */
	async open(sessionId: string): Promise<void> {
		this.sessionStore.clear();
		this.statusMotion.clear();
		const host = { sessionId, messages: [] as IAgentMessage[], contextUsed: undefined as number | undefined, contextWindow: undefined as number | undefined, recordAssistant: () => { } };
		this.host = host;
		const control = this.sessionStore.add(new RemoteAgentSessionControl(host as never, this.services.client));
		this.control = control;
		this.sessionStore.add(control.onDidChange(change => {
			if (change.kind === 'turnStart') {
				this.stickToBottom = true;
			}
			this.scheduleRender();
			this._onDidChange.fire(change);
		}));
		this.stickToBottom = true;
		this.render();
		await control.loadTranscript();
		if (this.host === host) {
			this.render(true);
			this._onDidChange.fire({ kind: 'render' });
		}
	}

	/** An empty chat (a new one not yet sent). */
	clear(sessionId: string): void {
		this.sessionStore.clear();
		this.control = undefined;
		this.host = { sessionId, messages: [], recordAssistant: () => { } };
		this.render();
	}

	stop(): void {
		if (this.control?.stopReply()) {
			this.render();
		}
		if (this.host) {
			void this.services.orchestrator.cancel(this.host.sessionId, { cascade: 'turn' });
		}
	}

	layout(): void {
		this.syncScroll(false);
	}

	/** Touch drags scroll the thread (the mobile app's embedded view). */
	enableTouchScrolling(): void {
		this._register(this.view.enableTouchScrolling());
	}

	scrollToEnd(): void {
		this.stickToBottom = true;
		this.syncScroll(true);
	}

	private scheduleRender(): void {
		if (this.renderTimer !== undefined) {
			return;
		}
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			mainWindow.requestAnimationFrame(() => this.render());
		}, STREAM_FRAME_MS);
	}

	render(scrollToEnd = false): void {
		this.listeners.clear();
		const inner = this.view.inner;
		inner.replaceChildren();
		const messages = this.host?.messages ?? [];
		this.editor.classList.toggle('has-turns', messages.length > 0);
		this.editor.classList.toggle('follow-up', messages.length > 0);
		let exchange: HTMLElement | undefined;
		for (const message of messages) {
			if (startsExchange(message) || !exchange) {
				exchange = append(inner, $('.volt-agent-exchange'));
			}
			const turn = append(exchange, $(`.volt-agent-turn.${message.kind}`));
			if (message.kind === 'user') {
				if (message.origin === 'notification') {
					this.renderNotificationTurn(turn, message);
				} else {
					this.renderUserTurn(turn, message, messages);
				}
			} else {
				this.renderAgentTurn(turn, message, message === messages.at(-1));
			}
		}
		this.syncScroll(scrollToEnd);
		mainWindow.requestAnimationFrame(() => this.syncScroll(scrollToEnd));
	}

	private syncScroll(scrollToEnd: boolean): void {
		const viewport = this.view.scroll.getDomNode();
		const height = viewport.clientHeight;
		const scrollHeight = Math.max(height, this.view.inner.scrollHeight);
		this.view.scroll.setScrollDimensions({ width: viewport.clientWidth, height, scrollWidth: this.view.inner.scrollWidth, scrollHeight });
		if (scrollToEnd || this.stickToBottom) {
			this.view.scroll.setScrollPosition({ scrollTop: scrollHeight });
			this.stickToBottom = true;
		}
		this.view.syncStuckTurns();
	}

	private setSearchableText(parent: HTMLElement, text: string): void {
		append(parent, $('span.volt-agent-searchable')).textContent = text;
	}

	//#region User turns

	private renderUserTurn(turn: HTMLElement, message: IAgentUserMessage, messages: readonly IAgentMessage[]): void {
		const row = append(turn, $('.volt-agent-user-row'));
		const bubble = append(row, $('.volt-agent-bubble'));
		if (/\n/.test(message.text) || !!message.chips?.length) {
			bubble.classList.add('multiline');
		}
		if (message.text.split('\n').length > 4 || message.text.length > 160) {
			bubble.classList.add('clamped');
		}
		const clip = append(bubble, $('.volt-agent-user-clip'));
		const main = append(clip, $('.volt-agent-user-main'));
		const text = append(main, $('.volt-agent-text'));
		this.renderUserMessageText(text, message);
		this.listeners.add(addDisposableListener(bubble, 'click', () => {
			message.promptExpanded = !message.promptExpanded;
			this.render();
		}));
		mainWindow.requestAnimationFrame(() => {
			if (message.promptExpanded) {
				bubble.classList.remove('clamped');
				bubble.classList.add('prompt-expanded');
				return;
			}
			const height = text.scrollHeight;
			if (height > 28) {
				bubble.classList.add('multiline');
			}
			bubble.classList.toggle('clamped', height > 22 * 4 + 1);
		});
		if (message.chips?.length) {
			const chipRow = append(main, $('.volt-agent-chips'));
			for (const chip of message.chips) {
				this.setSearchableText(append(chipRow, $('.volt-agent-chip')), chip);
			}
		}
		const latestUser = [...messages].reverse().find(m => m.kind === 'user');
		if (this.isStreaming && latestUser === message) {
			turn.classList.add('running');
			const stop = append(bubble, $('button.volt-agent-user-stop')) as HTMLButtonElement;
			stop.type = 'button';
			stop.setAttribute('aria-label', localize('voltAgent.stop', "Stop"));
			stop.appendChild(createStopIcon());
			this.listeners.add(addDisposableListener(stop, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.stop();
			}));
		} else if (message.id && !this.isStreaming && this.host) {
			const sessionId = this.host.sessionId;
			const turnId = message.id;
			const restore = append(bubble, $('button.volt-agent-user-restore')) as HTMLButtonElement;
			restore.type = 'button';
			restore.setAttribute('aria-label', localize('voltAgent.restoreCheckpoint', "Restore Checkpoint"));
			restore.title = localize('voltAgent.restoreCheckpoint', "Restore Checkpoint");
			restore.appendChild(renderIcon(Codicon.discard));
			this.listeners.add(addDisposableListener(restore, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.restoreCheckpoint(sessionId, turnId);
			}));
		}
	}

	/** Puts the files back as they were before this message (the server holds the checkpoints). */
	private async restoreCheckpoint(sessionId: string, turnId: string): Promise<void> {
		const preview = await this.services.client.call<{ files: { action: string }[] } | undefined>('checkpoints.previewRestore', sessionId, turnId).catch(() => undefined);
		if (!preview) {
			mainWindow.alert(localize('voltAgent.checkpoint.none', "There is no checkpoint for this message. Checkpoints need the project to be a folder on this computer."));
			return;
		}
		const changed = preview.files.filter(file => file.action !== 'none').length;
		if (!mainWindow.confirm(localize('voltWeb.restoreConfirm', "Restore {0} files to how they were before this message?", changed))) {
			return;
		}
		await this.services.client.call('checkpoints.restoreCheckpoint', sessionId, turnId, {});
	}

	private renderUserMessageText(parent: HTMLElement, message: IAgentUserMessage): void {
		const mentions = message.mentions?.filter(mention => mention.label) ?? [];
		if (!mentions.length) {
			this.setSearchableText(parent, message.text);
			return;
		}
		let cursor = 0;
		for (const mention of mentions) {
			const index = message.text.indexOf(mention.label, cursor);
			if (index < 0) {
				continue;
			}
			if (index > cursor) {
				this.setSearchableText(parent, message.text.slice(cursor, index));
			}
			const chip = append(parent, $(`.volt-agent-inline-mention.show-file-icons.${mention.kind}`));
			append(chip, $(`span.volt-agent-mention-icon.${mention.kind}`));
			const pill = append(chip, $(`span.volt-agent-mention-pill.${mention.kind}`));
			this.setSearchableText(pill, mention.label);
			cursor = index + mention.label.length;
		}
		if (cursor < message.text.length) {
			this.setSearchableText(parent, message.text.slice(cursor));
		}
	}

	private renderNotificationTurn(turn: HTMLElement, message: IAgentUserMessage): void {
		turn.classList.add('notification');
		const card = append(turn, $('.volt-agent-notification'));
		this.setSearchableText(card, message.text);
	}

	//#endregion

	//#region Assistant turns

	private blockRenderContext(message: IAgentAssistantMessage): IBlockRenderContext {
		const ctx: IBlockRenderContext = {
			markdownRenderer: this.services.markdownRenderer,
			store: this.listeners,
			blockState: message.blockState,
			onToggle: id => {
				const expanded = !message.blockState[id]?.expanded;
				message.blockState[id] = { expanded };
				for (const segment of message.segments) {
					if (segment.kind === 'block' && segment.block.id === id && 'expanded' in segment.block) {
						segment.block.expanded = expanded;
					}
				}
				this.render();
			},
			onScroll: () => this.syncScroll(false),
			instantiationService: this.services.instantiationService,
			diffStyle: chooseFileChangeDiffStyle({ surface: 'sidebar' }),
			onOpenUrl: url => mainWindow.open(url, '_blank', 'noopener'),
			onCopyText: text => void navigator.clipboard.writeText(text),
			onTableCopyMenu: (_anchor, _plain, markdown) => void navigator.clipboard.writeText(markdown),
			onAccessDecision: (requestId, effect, scope, pattern) => this.services.runtime.respondToAccessRequest(requestId, effect, scope, pattern),
			streaming: !!message.activity?.streaming,
			languageService: this.services.languageService,
		};
		return ctx;
	}

	private transcriptHost(message: IAgentAssistantMessage, ctx: IBlockRenderContext): ITranscriptHost {
		const host: ITranscriptHost = {
			store: this.listeners,
			ctx,
			isExpanded: id => message.blockState[`tr:${id}`]?.expanded,
			setExpanded: (id, expanded) => {
				message.blockState[`tr:${id}`] = { expanded };
				this.render();
			},
			openFile: () => { },
			openStepItem: () => { },
			renderStatus: (parent, key, text) => this.renderLiveStatus(parent, message, key, text),
			renderBlock: (parent, block) => renderAgentBlock(parent, block, ctx),
			renderNotice: (parent, row) => this.renderNotice(parent, row),
			setSearchableText: (el, text) => this.setSearchableText(el, text),
			subagentView: (tool, live) => {
				const sessionId = this.host?.sessionId;
				const task = sessionId ? this.services.orchestrator.taskForToolCall(sessionId, tool.callId) : undefined;
				return task ? subagentView(agentRow(task), ref => this.providerOf(sessionId!, ref)) : fallbackSubagentView(tool, live);
			},
		};
		return host;
	}

	private providerOf(sessionId: string, modelRef: string | undefined): string | undefined {
		const ref = modelRef ?? this.services.orchestrator.getThread(sessionId)?.modelRef;
		return ref ? this.services.runtime.listCatalog().find(item => item.ref === ref)?.providerId : undefined;
	}

	private renderAgentTurn(turn: HTMLElement, message: IAgentAssistantMessage, last: boolean): void {
		const streaming = !!message.activity?.streaming;
		const body = append(turn, $('.volt-agent-thread-body'));
		const ctx = this.blockRenderContext(message);
		if (streaming) {
			this.liveTurns.add(message);
		}
		const built = buildTranscriptRows(message.segments, message.text, streaming, message.steers);
		const rows = !streaming && message.outcome === 'failed' ? withoutFailureNotice(built, message.failure?.message) : built;
		renderTranscript(body, rows, this.transcriptHost(message, ctx), {
			streaming,
			status: streaming ? this.liveStatusPhrase(message) : undefined,
			workedMs: !streaming && message.startedAt && message.endedAt ? message.endedAt - message.startedAt : undefined,
			workedOpenByDefault: this.liveTurns.has(message),
			statusKey: String(message.startedAt ?? message.id ?? 'live'),
			todos: todoChecklist(message.steps, streaming),
			elapsedSince: streaming ? message.startedAt : undefined,
		});
		if (streaming) {
			this.ensureClock();
		}
		const tray = runEndTray(message, last);
		if (tray && !(tray.kind === 'failed' && hasSignInNotice(rows))) {
			this.renderRunEndTray(body, message, tray);
		}
		if (!streaming) {
			this.renderFooter(turn, message);
			const files = turnFileChanges(message.segments);
			if (files.length) {
				this.renderTurnFilesCard(turn, files);
			}
		}
	}

	/** "N Files Changed" under a finished reply: the window's card, with its rows as a flat list. */
	private renderTurnFilesCard(parent: HTMLElement, files: readonly ITurnFileChange[]): void {
		const card = append(parent, $('.volt-agent-turn-files.show-file-icons'));
		const header = append(card, $('.volt-agent-turn-files-header'));
		append(header, $('span.volt-agent-turn-files-title')).textContent = files.length === 1
			? localize('voltAgent.oneFileChanged', "1 File Changed")
			: localize('voltAgent.filesChanged', "{0} Files Changed", files.length);
		const view = append(header, $('button.volt-agent-turn-files-view')) as HTMLButtonElement;
		view.type = 'button';
		view.appendChild(renderIcon(Codicon.listTree));
		const review = append(header, $('button.volt-agent-turn-files-review')) as HTMLButtonElement;
		review.type = 'button';
		review.textContent = localize('voltAgent.review', "Review");
		const rowsHost = append(card, $('.volt-agent-turn-files-rows.flat'));
		rowsHost.style.height = `${files.length * 26}px`;
		const list = append(append(rowsHost, $('.monaco-list.mouse-support.always.selection-none')), $('.monaco-scrollable-element'));
		const rows = append(list, $('.monaco-list-rows'));
		files.forEach((file, index) => {
			const row = append(rows, $('.monaco-list-row'));
			row.style.top = `${index * 26}px`;
			row.style.height = '26px';
			const tl = append(row, $('.monaco-tl-row'));
			append(tl, $('.monaco-tl-indent')).style.width = '0px';
			append(tl, $('.monaco-tl-twistie')).style.paddingLeft = '8px';
			const item = append(append(tl, $('.monaco-tl-contents')), $('.volt-agent-turn-files-row'));
			const label = append(item, $('.monaco-icon-label.volt-agent-searchable'));
			label.classList.add(...getIconClasses(NO_MODELS, this.services.languageService, URI.file(file.path), FileKind.FILE));
			const name = append(append(append(label, $('.monaco-icon-label-container')), $('span.monaco-icon-name-container')), $('a.label-name'));
			name.textContent = basename(file.path);
			label.title = file.path;
			const stats = append(item, $('span.volt-agent-turn-files-stats'));
			const counts = formatChangeStats(file.additions, file.deletions);
			append(stats, $('span.add')).textContent = counts.added ?? '';
			append(stats, $('span.del')).textContent = counts.removed ?? '';
		});
	}

	/** The live phrase: the current action, or "Thinking" / "Planning next moves" in turn while the model is quiet. */
	private liveStatusPhrase(message: IAgentAssistantMessage): string {
		const activity = message.activity;
		if (activity) {
			activity.shimmerStartedAt ??= Date.now();
		}
		const anchor = activity?.shimmerStartedAt ?? Date.now();
		const now = Date.now();
		const lines = streamingActivityLines('', activity?.status, activity?.items ?? [], now, anchor, activity?.statusPinned === true);
		if (this.rotateTimer !== undefined) {
			clearTimeout(this.rotateTimer);
			this.rotateTimer = undefined;
		}
		if (lines.rotate) {
			const elapsed = (now - anchor) % STATUS_ROTATE_MS;
			this.rotateTimer = setTimeout(() => {
				this.rotateTimer = undefined;
				if (this.isStreaming) {
					this.render();
				}
			}, Math.max(32, STATUS_ROTATE_MS - elapsed + 24));
		}
		const quietFor = now - (activity?.lastEventAt ?? message.startedAt ?? now);
		if ((lines.rotate || lines.phrase === PLANNING_PHRASE) && quietFor >= SLOW_TURN_MS) {
			return localize('voltAgent.takingLonger', "Taking longer than expected…");
		}
		return lines.phrase;
	}

	private renderLiveStatus(parent: HTMLElement, message: IAgentAssistantMessage, key: string, text: string): void {
		const activity = message.activity;
		if (activity) {
			activity.shimmerStartedAt ??= Date.now();
		}
		const anchor = activity?.shimmerStartedAt ?? Date.now();
		const keyBase = String(message.startedAt ?? message.id ?? 'live');
		this.renderStatusLine(parent, `${keyBase}:${key}`, text, anchor);
	}

	private renderStatusLine(parent: HTMLElement, key: string, text: string, shimmerAnchor: number): void {
		const now = Date.now();
		const motion = this.statusMotion.get(key);
		let from: string | undefined;
		let started = 0;
		if (motion && motion.text !== text) {
			from = motion.text;
			started = now;
			this.statusMotion.set(key, { text, from, started });
		} else if (motion?.from && motion.started !== undefined && motion.text === text && now - motion.started < STATUS_SWAP_MS) {
			from = motion.from;
			started = motion.started;
		} else {
			this.statusMotion.set(key, { text });
		}
		const switching = !!from && from !== text;
		const swap = append(parent, $('.volt-agent-status-swap'));
		swap.classList.toggle('is-switching', switching);
		const paint = (value: string, role: 'out' | 'in' | 'still') => {
			const motionEl = append(swap, $(role === 'still' ? 'span.volt-agent-status-motion' : `span.volt-agent-status-motion.${role === 'out' ? 'phrase-out' : 'phrase-in'}`));
			if (switching) {
				motionEl.style.animationDelay = `${-(now - started)}ms`;
			}
			const status = append(motionEl, $('span.volt-agent-activity-progress.shimmer'));
			status.style.animationDelay = `${-((now - shimmerAnchor) % 900)}ms`;
			this.setSearchableText(status, value);
		};
		if (switching && from) {
			paint(from, 'out');
			paint(text, 'in');
		} else {
			paint(text, 'still');
		}
	}

	private renderNotice(parent: HTMLElement, part: Extract<TranscriptRow, { kind: 'notice' }>): void {
		const notice = append(parent, $(`.volt-agent-provider-notice.severity-${part.severity}`));
		this.setSearchableText(append(notice, $('div.volt-agent-provider-notice-title')), part.title);
		if (part.description) {
			this.setSearchableText(append(notice, $('div.volt-agent-provider-notice-detail')), part.description);
		}
	}

	private renderRunEndTray(parent: HTMLElement, message: IAgentAssistantMessage, tray: IRunEndTray): void {
		if (tray.kind !== 'failed') {
			const marker = append(parent, $(`.volt-agent-run-marker.${tray.kind}`));
			append(marker, $('span.volt-agent-run-marker-icon')).appendChild(renderIcon(tray.kind === 'stopped' ? Codicon.debugStop : Codicon.debugDisconnect));
			this.setSearchableText(append(marker, $('span.volt-agent-run-marker-label')), tray.title);
			if (tray.canResume) {
				this.trayButton(marker, localize('voltAgent.resume', "Resume"), 'text', () => this.resume(message));
			}
			if (tray.canRetry) {
				this.trayButton(marker, localize('voltAgent.tryAgain', "Try again"), 'text', () => this.retry());
			}
			return;
		}
		const card = append(parent, $('.volt-agent-run-tray.failed'));
		card.setAttribute('role', 'alert');
		const head = append(card, $('.volt-agent-run-tray-head'));
		this.setSearchableText(append(head, $('span.volt-agent-run-tray-title')), tray.title);
		this.setSearchableText(append(card, $('.volt-agent-run-tray-detail')), tray.detail ?? '');
		if (tray.requestId) {
			this.setSearchableText(append(card, $('.volt-agent-run-tray-request')), localize('voltAgent.requestId', "Request ID: {0}", tray.requestId));
		}
		const row = append(card, $('.volt-agent-run-tray-actions'));
		if (tray.canRetry) {
			this.trayButton(row, localize('voltAgent.tryAgain', "Try again"), tray.canResume ? 'secondary' : 'primary', () => this.retry());
		}
		if (tray.canResume) {
			this.trayButton(row, localize('voltAgent.resume', "Resume"), 'primary', () => this.resume(message));
		}
	}

	private trayButton(parent: HTMLElement, label: string, variant: 'primary' | 'secondary' | 'text', run: () => void): void {
		const button = append(parent, $(`button.volt-agent-run-tray-btn.${variant}`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		this.listeners.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
	}

	/** "Resume": the next turn picks up where the stopped one left off (as the window sends it). */
	private resume(message: IAgentAssistantMessage): void {
		const sessionId = this.host?.sessionId;
		if (sessionId) {
			void this.services.orchestrator.submit(sessionId, { text: resumeTurnPrompt(message), display: { text: localize('voltAgent.resume.display', "Resume") }, mode: 'Agent' }, 'now', generateUuid());
		}
	}

	/** "Try again": the newest prompt runs again in place of the turn that failed or stopped. */
	private retry(): void {
		const host = this.host;
		if (!host || this.isStreaming || !this.control) {
			return;
		}
		const index = host.messages.findLastIndex(message => message.kind === 'user');
		const user = host.messages[index];
		if (user?.kind !== 'user') {
			return;
		}
		const text = (user.agentText ?? user.text).trim();
		host.messages.splice(index);
		this.control.truncate(user, host.messages.filter(message => message.kind === 'user').length);
		this.render();
		void this.services.orchestrator.submit(host.sessionId, { text, ...(user.agentText ? { display: { text: user.text } } : {}), mode: user.mode ?? 'Agent' }, 'auto', generateUuid());
	}

	private renderFooter(turn: HTMLElement, message: IAgentAssistantMessage): void {
		const footer = append(turn, $('.volt-agent-footer'));
		const copy = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		copy.setAttribute('aria-label', localize('voltAgent.copyMessage', "Copy Message"));
		copy.appendChild(createCopyIcon());
		this.listeners.add(addDisposableListener(copy, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void navigator.clipboard.writeText(agentMessagePlainText(message)).then(() => {
				copy.replaceChildren(renderIcon(Codicon.check));
				copy.classList.add('copied');
				setTimeout(() => {
					copy.replaceChildren(createCopyIcon());
					copy.classList.remove('copied');
				}, 1500);
			});
		}));
		const fork = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		fork.setAttribute('aria-label', localize('voltAgent.forkChat', "Fork Chat"));
		fork.appendChild(createForkIcon());
		const when = message.endedAt ?? message.startedAt;
		if (when) {
			const ago = append(footer, $('span.volt-agent-ago'));
			ago.dataset.endedAt = String(when);
			this.setSearchableText(ago, dayjs(when).fromNow());
			this.ensureClock();
		}
	}

	//#endregion

	private ensureClock(): void {
		if (this.clock !== undefined) {
			return;
		}
		this.clock = mainWindow.setInterval(() => {
			tickElapsed(this.view.inner);
			for (const ago of this.view.inner.querySelectorAll<HTMLElement>('.volt-agent-ago[data-ended-at]')) {
				const span = ago.querySelector('.volt-agent-searchable');
				if (span) {
					span.textContent = dayjs(Number(ago.dataset.endedAt)).fromNow();
				}
			}
		}, 1000);
	}

	private stopTimers(): void {
		if (this.clock !== undefined) {
			mainWindow.clearInterval(this.clock);
		}
		if (this.renderTimer !== undefined) {
			clearTimeout(this.renderTimer);
		}
		if (this.rotateTimer !== undefined) {
			clearTimeout(this.rotateTimer);
		}
	}
}

