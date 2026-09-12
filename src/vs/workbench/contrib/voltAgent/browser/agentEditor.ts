/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentEditor.css';
import { $, addDisposableListener, append, Dimension, DragAndDropObserver, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, isAbsolute } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { MarkdownRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EDITOR_FONT_DEFAULTS, IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { deepClone } from '../../../../base/common/objects.js';
import { isObject } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ACCESS_MODE_OPTIONS, accessModeOption } from '../../../services/voltRuntime/common/access/accessModes.js';
import { alwaysAllowPattern } from '../../../services/voltRuntime/common/access/wildcard.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../../services/voltRuntime/common/capabilities.js';
import { IVoltEventEnvelope } from '../../../services/voltRuntime/common/events.js';
import { pickNumber } from '../../../services/voltRuntime/common/modelMeta.js';
import { MODEL_OPTION_CONTEXT, optionValue } from '../../../services/voltRuntime/common/modelOptions.js';
import { normalizeVoltMode, VoltMode } from '../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createAccessIcon } from './accessIcons.js';
import { AgentModelPicker, formatTokens, IModelOption } from './agentModelPicker.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../voltSettings/browser/voltSettingsEditorInput.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { GroupsOrder, IEditorGroupsService, IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { searchFilesAndFolders } from '../../search/browser/searchChatContext.js';
import { AGENT_EDITOR_LINE_NUMBERS_SETTING, AgentEditorInput, NEW_AGENT_COMMAND_ID } from './agentEditorInput.js';
import { AgentComposerLists } from './agentComposerLists.js';
import { AgentFindWidget, IAgentFindHost } from './agentFindWidget.js';
import { AgentThreadView } from './agentThreadView.js';
import { AgentTooltip, formatAgentTooltipShortcut, setAgentTooltip } from './agentTooltip.js';
import { createModeIcon, ModeIconId } from './agentModeIcons.js';
import { AgentMentionController, IAgentDisplayMention, browserMentionColor } from './agentMentions.js';
import { appendAgentScrollableList } from './agentScrollable.js';
import { dayjs } from './dayjs.js';
import { renderAgentBlock, renderMarkdownInto, IBlockRenderContext } from './blocks/agentBlockRenderers.js';
import { AgentSegment, appendTextDelta, blocksPlainText, classifyToolActivity, collectBlocks, createApprovalBlock, createTerminalBlock, createToolBlock, findBlockByCallId, firstCommandName, isShellTool, looksLikeShell, parseFileTarget, parseShellToolInput, splitActivityLabel, stringifyToolResult } from './blocks/agentBlocks.js';

function createSvgIcon(viewBox: string, pathD: string, extraClass?: string, stroke = false, strokeWidth = '1.5'): HTMLElement {
	const el = extraClass ? $(`span.volt-agent-svg-icon.${extraClass}`) : $('span.volt-agent-svg-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', viewBox);
	const parts = viewBox.split(' ');
	svg.setAttribute('width', parts[2] || '24');
	svg.setAttribute('height', parts[3] || '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	if (stroke) {
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', strokeWidth);
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
	} else {
		path.setAttribute('fill', 'currentColor');
	}
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createStopIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.stop');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 384 512');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M0 128c0-35.3 28.7-64 64-64h256c35.3 0 64 28.7 64 64v256c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64z');
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createSendIcon(): HTMLElement {
	return createSvgIcon('0 0 24 24', 'M12 19V5M5 12l7-7 7 7', 'send', true, '2.4');
}

function createPlusIcon(): HTMLElement {
	return createSvgIcon('0 0 14 14', 'M7 2.5v9M2.5 7h9', 'plus', true, '1');
}

function createPaperclipIcon(): HTMLElement {
	return createStrokeIcon('paperclip', [
		'M16 6v9.5a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9',
	]);
}

function createCubeIcon(): HTMLElement {
	return createStrokeIcon('cube', [
		'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z',
		'M12 12l8-4.5M12 12v9M12 12L4 7.5',
	]);
}

function createPlugIcon(): HTMLElement {
	return createStrokeIcon('plug', [
		'M9 2v4M15 2v4M7 6h10v5a5 5 0 0 1-10 0V6Z',
		'M12 16v6',
	]);
}

function createMicIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.mic');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const mic = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
	mic.setAttribute('x', '9');
	mic.setAttribute('y', '3');
	mic.setAttribute('width', '6');
	mic.setAttribute('height', '11');
	mic.setAttribute('rx', '3');
	mic.setAttribute('fill', 'currentColor');
	const stem = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	stem.setAttribute('d', 'M7 11a5 5 0 0 0 10 0M12 16v3M9 19h6');
	stem.setAttribute('stroke', 'currentColor');
	stem.setAttribute('stroke-width', '1.8');
	stem.setAttribute('stroke-linecap', 'round');
	svg.appendChild(mic);
	svg.appendChild(stem);
	el.appendChild(svg);
	return el;
}

function createChevronIcon(): HTMLElement {
	return createSvgIcon(
		'0 0 16 7',
		'M8 6.5a.47.47 0 0 1-.35-.15l-4.5-4.5c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.15 4.15l4.14-4.14c.2-.2.51-.2.71 0s.2.51 0 .71l-4.5 4.5c-.1.1-.23.15-.35.15Z',
		'chevron'
	);
}

function createChevronRightIcon(): HTMLElement {
	return createSvgIcon('0 0 24 24', 'm9 18 6-6-6-6', 'chevron-right', true, '2');
}

function createExpandIcon(restored: boolean): HTMLElement {
	return createSvgIcon(
		'0 0 24 24',
		restored
			? 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'
			: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
		'expand',
		true,
		'2',
	);
}

function createStrokeIcon(extraClass: string, paths: readonly string[]): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	el.appendChild(svg);
	return el;
}

interface IAgentUserMessage {
	kind: 'user';
	text: string;
	agentText?: string;
	chips?: string[];
	mentions?: IAgentDisplayMention[];
}

export interface IAgentPromptDisplay {
	text: string;
	mentions?: IAgentDisplayMention[];
}

export interface IAgentDockTurn {
	kind: 'user' | 'agent';
	text: string;
	status?: string;
	streaming?: boolean;
}

export interface IAgentDockState {
	title: string;
	streaming: boolean;
	cancelled: boolean;
	status: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	turns: IAgentDockTurn[];
}

interface IAgentActivityItem {
	kind: 'thought' | 'read' | 'search' | 'note';
	label: string;
	detail?: string;
	path?: string;
	startLine?: number;
	endLine?: number;
}

interface IAgentActivity {
	status: string;
	expanded: boolean;
	streaming: boolean;
	items: IAgentActivityItem[];
	thinkingText?: string;
	shimmerStartedAt?: number;
}

interface IAgentAssistantMessage {
	kind: 'agent';
	title: string;
	steps: { label: string; state: 'done' | 'current' | 'pending' }[];
	changes?: string[];
	text?: string;
	segments: AgentSegment[];
	blockState: Record<string, { expanded: boolean }>;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	tokensCache?: number;
	tokensUsed?: number;
	tokensWindow?: number;
	cancelled?: boolean;
	activity?: IAgentActivity;
}

type IAgentMessage = IAgentUserMessage | IAgentAssistantMessage;

interface IModeOption {
	id: string;
	label: string;
	icon: ModeIconId;
	keybinding?: string;
	description?: string;
}

const MODE_OPTIONS: IModeOption[] = [
	{ id: 'Agent', label: 'Agent', icon: 'agent' },
	{ id: 'Plan', label: 'Plan', icon: 'plan', keybinding: 'Tab', description: 'Generate an implementation plan' },
	{ id: 'Debug', label: 'Debug', icon: 'debug', description: 'Pinpoint the root cause of an issue' },
	{ id: 'Multitask', label: 'Multitask', icon: 'multitask', description: 'Orchestrate multiple subagents in parallel' },
	{ id: 'Ask', label: 'Ask', icon: 'ask', description: 'Answer questions without making edits' },
];

interface IContextUsageItem {
	label: string;
	tokens: number;
	color: string;
}

const CONTEXT_COLORS = {
	conversation: '#9f1239',
	overhead: '#a78bfa',
	reply: '#4ade80',
	draft: '#7dd3fc',
};

interface IContextUsageView {
	used: number;
	limit: number;
	estimated: boolean;
	items: IContextUsageItem[];
}

function formatExploringSummary(items: readonly IAgentActivityItem[]): string | undefined {
	const files = items.filter(item => item.kind === 'read').length;
	const searches = items.filter(item => item.kind === 'search').length;
	if (!files && !searches) {
		return undefined;
	}
	const parts: string[] = [];
	if (files) {
		parts.push(files === 1
			? localize('voltAgent.oneFile', "1 file")
			: localize('voltAgent.manyFiles', "{0} files", files));
	}
	if (searches) {
		parts.push(searches === 1
			? localize('voltAgent.oneSearch', "1 search")
			: localize('voltAgent.manySearches', "{0} searches", searches));
	}
	return localize('voltAgent.exploring', "Exploring {0}", parts.join(', '));
}

function formatWorkedDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return localize('voltAgent.workedSeconds', "Worked for {0}s", Math.max(1, totalSeconds));
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds
		? localize('voltAgent.workedMinutesSeconds', "Worked for {0}m {1}s", minutes, seconds)
		: localize('voltAgent.workedMinutes', "Worked for {0}m", minutes);
}

function estimateTokensFromText(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) {
		return 0;
	}
	return Math.max(1, Math.round(trimmed.length / 4));
}

function estimateMessageTokens(message: IAgentAssistantMessage): number {
	return estimateTokensFromText([agentMessagePlainText(message), message.activity?.thinkingText ?? ''].join('\n'));
}

function agentMessagePlainText(message: IAgentAssistantMessage): string {
	const parts: string[] = [];
	const fromBlocks = blocksPlainText(collectBlocks(message.segments, message.text));
	if (fromBlocks) {
		parts.push(fromBlocks);
	}
	if (message.title) {
		parts.push(message.title);
	}
	for (const step of message.steps) {
		parts.push(step.label);
	}
	if (message.changes?.length) {
		parts.push(message.changes.join('\n'));
	}
	return parts.join('\n');
}


export class AgentEditor extends EditorPane implements IAgentFindHost {

	static readonly ID = AgentEditorInput.EditorID;

	private container!: HTMLElement;
	private threadView!: AgentThreadView;
	private threadEl!: HTMLElement;
	private threadInner!: HTMLElement;
	private threadScroll!: DomScrollableElement;
	private composerEl!: HTMLElement;
	private inputBox!: HTMLElement;
	private monacoHost!: HTMLElement;
	private placeholderEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private plusButton!: HTMLButtonElement;
	private accessButton!: HTMLButtonElement;
	private modeButton!: HTMLButtonElement;
	private modelButton!: HTMLButtonElement;
	private readonly tooltip = this._register(new AgentTooltip());
	private toolbarStartEl!: HTMLElement;
	private toolbarEndEl!: HTMLElement;
	private zoomButton!: HTMLButtonElement;
	private contextButton!: HTMLButtonElement;
	private attachButton!: HTMLButtonElement;
	private sendButton!: HTMLButtonElement;
	private suggestEl!: HTMLElement;
	private queueBarEl!: HTMLElement;
	private readonly suggestListeners = this._register(new DisposableStore());
	private sendKind: 'mic' | 'send' | 'stop' = 'mic';
	private promptQueue: { id: string; text: string; display?: IAgentPromptDisplay }[] = [];
	private queueExpanded = false;
	private readonly queueBarListeners = this._register(new DisposableStore());

	private inputEditor: ICodeEditor | undefined;
	private inputModel: ITextModel | undefined;
	private mentionController: AgentMentionController | undefined;
	private composerLists: AgentComposerLists | undefined;
	private readonly editorDisposables = this._register(new DisposableStore());

	private messages: IAgentMessage[] = [];
	private currentMode = MODE_OPTIONS[0].id;
	private readonly modelPicker: AgentModelPicker;
	private get currentModel(): string { return this.modelPicker.currentModel; }
	private get modelAuto(): boolean { return this.modelPicker.modelAuto; }
	private get catalog(): IModelOption[] { return this.modelPicker.catalog; }
	private plusMenuOpen = false;
	private plusMenuEl: HTMLElement | undefined;
	private readonly plusMenuStore = this._register(new DisposableStore());
	private eventDisposable: IDisposable | undefined;
	private renderHandle: number | undefined;
	private findWidget!: AgentFindWidget;
	private findMatches: HTMLElement[] = [];
	private currentFindIndex = 0;
	private composerZoomed = false;
	private composerHeight: number | undefined;
	private inputLayoutInProgress = false;
	private resizeStartHeight = 0;
	private sash!: Sash;
	private contextUsageOpen = false;
	private contextHoverTimer: number | undefined;
	private contextPopup: { percent: HTMLElement; tokens: HTMLElement; bar: HTMLElement; list: HTMLElement } | undefined;
	private sessionTokensUsed: number | undefined;
	private sessionTokensWindow: number | undefined;
	private toolbarLayoutHandle: number | undefined;
	private stickToBottom = true;
	private readonly threadListeners = this._register(new DisposableStore());
	private readonly thinkingStore = this._register(new DisposableStore());
	private readonly markdownRenderer: MarkdownRenderer;
	private clockTimer: IDisposable | undefined;
	private editingUserIndex: number | undefined;
	private editRestoreDraft = '';
	private editRestoreMentions: IAgentDisplayMention[] = [];
	private skipRunEvents = false;
	private activeRunId: string | undefined;
	private readonly _onDidChangeDock = this._register(new Emitter<void>());
	readonly onDidChangeDock: Event<void> = this._onDidChangeDock.event;
	private readonly _onDidComposerSend = this._register(new Emitter<void>());
	readonly onDidComposerSend: Event<void> = this._onDidComposerSend.event;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITextResourceConfigurationService private readonly textResourceConfigurationService: ITextResourceConfigurationService,
		@IModelService private readonly modelService: IModelService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
	) {
		super(AgentEditor.ID, group, telemetryService, themeService, storageService);
		this.markdownRenderer = this.instantiationService.createInstance(MarkdownRenderer, {});
		this.modelPicker = this._register(this.instantiationService.createInstance(AgentModelPicker, {
			onDidChange: () => {
				if (this.modelButton) {
					this.updateModelButton();
					this.renderContextRing();
				}
			},
		}));
		this._register(this.runtime.onDidChangeAccess(() => this.updateAccessButton()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-agent-editor'));
		this.container.dataset.mode = normalizeVoltMode(this.currentMode);
		this.applyCodeFont();
		this._register(new DragAndDropObserver(parent, {
			onDragEnter: e => this.blockWorkbenchFileDrop(e),
			onDragOver: e => this.blockWorkbenchFileDrop(e),
			onDrop: e => {
				this.blockWorkbenchFileDrop(e);
				this.ensureInputEditor();
				void this.mentionController?.handleExternalDrop(e);
			}
		}));
		this.threadView = this._register(new AgentThreadView());
		this.threadEl = this.threadView.element;
		this.threadInner = this.threadView.inner;
		this.threadScroll = this.threadView.scroll;
		append(this.container, this.threadEl);
		this.threadView.rememberHome();
		this._register(this.threadScroll.onScroll(e => {
			this.stickToBottom = e.scrollTop + e.height >= e.scrollHeight - 32;
		}));
		const threadWindow = getWindow(this.threadInner);
		const threadResizeObserver = new threadWindow.ResizeObserver(() => this.syncThreadScroll());
		threadResizeObserver.observe(this.threadEl);
		this._register(toDisposable(() => threadResizeObserver.disconnect()));
		this._register(addDisposableListener(getWindow(this.container), 'pointerdown', e => this.onEditPointerDown(e), true));
		this.composerEl = append(this.container, $('.volt-agent-composer'));
		this.inputBox = append(this.composerEl, $('.volt-agent-input-box'));
		this.queueBarEl = append(this.inputBox, $('.volt-agent-queue-bar'));
		this.queueBarEl.classList.add('hidden');
		this.monacoHost = append(this.inputBox, $('.volt-agent-monaco.show-file-icons'));
		this.placeholderEl = append(this.monacoHost, $('.volt-agent-placeholder'));
		this.placeholderEl.setAttribute('aria-hidden', 'true');
		this.updateInputPlaceholder();

		this.toolbarEl = append(this.inputBox, $('.volt-agent-toolbar'));
		this.toolbarStartEl = append(this.toolbarEl, $('.volt-agent-toolbar-start'));
		this.toolbarEndEl = append(this.toolbarEl, $('.volt-agent-toolbar-end'));
		this.plusButton = append(this.toolbarStartEl, $('button.volt-agent-plus')) as HTMLButtonElement;
		setAgentTooltip(this.plusButton, localize('voltAgent.add', "Add"));
		this.plusButton.appendChild(createPlusIcon());
		this.modeButton = append(this.toolbarStartEl, $('button.volt-agent-mode')) as HTMLButtonElement;
		this.accessButton = append(this.toolbarStartEl, $('button.volt-agent-access')) as HTMLButtonElement;
		this.modelButton = append(this.toolbarStartEl, $('button.volt-agent-model')) as HTMLButtonElement;
		this._register(this.tooltip.bind(this.modelButton, () => [
			{ label: localize('voltAgent.selectModel', "Select Model"), shortcut: formatAgentTooltipShortcut({ meta: true, key: '/' }) },
			{ label: localize('voltAgent.cycleEffort', "Cycle Effort"), shortcut: formatAgentTooltipShortcut({ meta: true, shift: true, key: '/' }) },
		], {
			fontSource: () => (this.monacoHost.querySelector('.view-lines')
				?? this.monacoHost.querySelector('textarea')
				?? this.placeholderEl
				?? this.monacoHost) as HTMLElement | null,
		}));

		this.updateAccessButton();
		this.updateModeButton();
		this.updateModelButton();

		this.zoomButton = append(this.toolbarEndEl, $('button.volt-agent-icon-btn.volt-agent-zoom-btn')) as HTMLButtonElement;
		this.updateZoomButton();
		const toolbarWindow = getWindow(this.toolbarEl);
		const toolbarResizeObserver = new toolbarWindow.ResizeObserver(() => this.scheduleToolbarLayout());
		toolbarResizeObserver.observe(this.toolbarEl);
		toolbarResizeObserver.observe(this.inputBox);
		this._register(toDisposable(() => {
			toolbarResizeObserver.disconnect();
			if (this.toolbarLayoutHandle !== undefined) {
				toolbarWindow.cancelAnimationFrame(this.toolbarLayoutHandle);
				this.toolbarLayoutHandle = undefined;
			}
		}));

		this.contextButton = append(this.toolbarEndEl, $('button.volt-agent-context-btn')) as HTMLButtonElement;
		setAgentTooltip(this.contextButton, localize('voltAgent.contextUsage', "Context usage"));
		this.renderContextRing();

		this.attachButton = append(this.toolbarEndEl, $('button.volt-agent-icon-btn.volt-agent-attach-btn')) as HTMLButtonElement;
		setAgentTooltip(this.attachButton, localize('voltAgent.attach', "Add context"));
		this.attachButton.appendChild(renderIcon(Codicon.attach));

		this.sendButton = append(this.toolbarEndEl, $('button.volt-agent-send')) as HTMLButtonElement;
		this.updateSendButton();

		this.suggestEl = append(this.composerEl, $('.volt-agent-suggest'));
		this.renderSuggestChips();

		this.sash = this._register(new Sash(this.container, {
			getHorizontalSashTop: () => this.composerEl.offsetTop + this.inputBox.offsetTop,
			getHorizontalSashWidth: () => this.container.clientWidth,
		}, { orientation: Orientation.HORIZONTAL, size: 3 }));
		this._register(this.sash.onDidStart(() => {
			this.resizeStartHeight = this.composerEl.offsetHeight;
		}));
		this._register(this.sash.onDidChange(e => {
			this.applyComposerHeight(this.resizeStartHeight + (e.startY - e.currentY));
		}));
		this._register(this.sash.onDidReset(() => {
			this.setComposerZoomed(false);
		}));

		this.bindRuntimeSession();
		this.renderThread(true);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_EDITOR_LINE_NUMBERS_SETTING) || e.affectsConfiguration('editor')) {
				this.applyCodeFont();
				this.updateComposerEditorOptions();
				this.layoutInputEditor();
			}
		}));

		this.findWidget = this._register(this.instantiationService.createInstance(AgentFindWidget, this));
		this.container.appendChild(this.findWidget.getDomNode());

		this._register(addDisposableListener(this.plusButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showPlusMenu();
		}));
		this._register(addDisposableListener(this.accessButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showAccessDropdown();
		}));
		this._register(addDisposableListener(this.modeButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if ((e.target as HTMLElement).closest('.volt-agent-mode-close')) {
				this.setMode('Agent');
				return;
			}
			this.showPlusMenu();
		}));
		this._register(addDisposableListener(this.modelButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.tooltip.hide();
			this.showModelDropdown();
		}));
		this._register(addDisposableListener(this.sendButton, 'click', () => this.send()));
		this._register(addDisposableListener(this.zoomButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleComposerZoom();
		}));
		this._register(addDisposableListener(this.contextButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.cancelHideContextUsage();
			this.showContextUsage();
		}));
		this._register(addDisposableListener(this.contextButton, 'mouseenter', () => {
			this.cancelHideContextUsage();
			this.showContextUsage();
		}));
		this._register(addDisposableListener(this.contextButton, 'mouseleave', () => this.scheduleHideContextUsage()));
		this._register(addDisposableListener(this.attachButton, 'click', () => {
			this.ensureInputEditor();
			this.mentionController?.openFilePicker();
			this.inputEditor?.focus();
		}));
	}

	private selectedModel(): IModelOption | undefined {
		return this.modelPicker.selectedModel();
	}

	private modelContextWindow(model = this.selectedModel()): number {
		if (!model) {
			return DEFAULT_MODEL_CAPABILITIES.contextWindow;
		}
		const context = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT);
		const option = context ? optionValue(context, this.runtime.getModelOptions(model.ref)) : undefined;
		return pickNumber(typeof option === 'string' ? option : undefined, model.contextLabel, model.contextWindow)
			?? DEFAULT_MODEL_CAPABILITIES.contextWindow;
	}

	private lastUsageMessage(): IAgentAssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.kind === 'agent' && (message.tokensUsed || message.tokensWindow || message.tokensIn || message.tokensOut)) {
				return message;
			}
		}
		return undefined;
	}

	private contextUsage(): IContextUsageView {
		const last = this.lastUsageMessage();
		const reportedUsed = last?.tokensUsed ?? this.sessionTokensUsed;
		const reportedLimit = last?.tokensWindow ?? this.sessionTokensWindow;
		const limit = reportedLimit && reportedLimit > 0 ? reportedLimit : this.modelContextWindow();
		const draft = estimateTokensFromText(this.inputModel?.getValue() ?? '');
		let conversation = 0;
		for (const message of this.messages) {
			if (last && message === last) {
				continue;
			}
			conversation += message.kind === 'user' ? estimateTokensFromText(message.text) : estimateMessageTokens(message);
		}

		const items: IContextUsageItem[] = [];
		const push = (label: string, tokens: number, color: string) => {
			if (tokens > 0) {
				items.push({ label, tokens, color });
			}
		};

		if (reportedUsed && reportedUsed > 0) {
			const used = reportedUsed + draft;
			const visible = Math.min(conversation, reportedUsed);
			push(localize('voltAgent.contextConversation', "Conversation"), visible, CONTEXT_COLORS.conversation);
			push(localize('voltAgent.contextOverhead', "Prompt & tools"), Math.max(0, reportedUsed - visible), CONTEXT_COLORS.overhead);
			push(localize('voltAgent.contextDraft', "Current prompt"), draft, CONTEXT_COLORS.draft);
			return { used, limit, estimated: false, items };
		}

		if (last?.tokensIn) {
			const prompt = last.tokensIn;
			const output = last.tokensOut ?? 0;
			const used = prompt + output + draft;
			const visible = Math.min(conversation, prompt);
			push(localize('voltAgent.contextConversation', "Conversation"), visible, CONTEXT_COLORS.conversation);
			push(localize('voltAgent.contextOverhead', "Prompt & tools"), Math.max(0, prompt - visible), CONTEXT_COLORS.overhead);
			push(localize('voltAgent.contextReply', "Last reply"), output, CONTEXT_COLORS.reply);
			push(localize('voltAgent.contextDraft', "Current prompt"), draft, CONTEXT_COLORS.draft);
			return { used, limit, estimated: false, items };
		}

		const lastReply = last ? estimateMessageTokens(last) : 0;
		const used = conversation + lastReply + draft;
		push(localize('voltAgent.contextConversation', "Conversation"), conversation + lastReply, CONTEXT_COLORS.conversation);
		push(localize('voltAgent.contextDraft', "Current prompt"), draft, CONTEXT_COLORS.draft);
		return { used, limit, estimated: true, items };
	}

	private renderContextRing(): void {
		if (!this.contextButton) {
			return;
		}
		const { used, limit } = this.contextUsage();
		const ratio = Math.min(1, used / Math.max(limit, 1));
		const radius = 8;
		const circumference = 2 * Math.PI * radius;
		const dash = circumference * ratio;
		this.contextButton.replaceChildren();
		setAgentTooltip(this.contextButton, localize('voltAgent.contextUsageDetail', "Context usage: {0} / {1}", formatTokens(used), formatTokens(limit)));
		const svg = this.contextButton.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '18');
		svg.setAttribute('height', '18');
		svg.setAttribute('aria-hidden', 'true');
		const track = this.contextButton.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		track.setAttribute('cx', '12');
		track.setAttribute('cy', '12');
		track.setAttribute('r', String(radius));
		track.setAttribute('fill', 'none');
		track.setAttribute('stroke', 'currentColor');
		track.setAttribute('stroke-width', '2');
		track.classList.add('track');
		const fill = this.contextButton.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		fill.setAttribute('cx', '12');
		fill.setAttribute('cy', '12');
		fill.setAttribute('r', String(radius));
		fill.setAttribute('fill', 'none');
		fill.setAttribute('stroke', 'currentColor');
		fill.setAttribute('stroke-width', '2');
		fill.setAttribute('stroke-linecap', 'round');
		fill.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
		fill.setAttribute('transform', 'rotate(-90 12 12)');
		fill.classList.add('fill');
		svg.appendChild(track);
		svg.appendChild(fill);
		this.contextButton.appendChild(svg);
		this.refreshContextUsagePopup();
	}

	private refreshContextUsagePopup(): void {
		const popup = this.contextPopup;
		if (!popup || !this.contextUsageOpen) {
			return;
		}
		this.fillContextUsage(popup);
	}

	private fillContextUsage(popup: { percent: HTMLElement; tokens: HTMLElement; bar: HTMLElement; list: HTMLElement }): void {
		const { used, limit, estimated, items } = this.contextUsage();
		const percent = Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
		popup.percent.textContent = localize('voltAgent.contextFull', "{0}% Full", percent);
		popup.tokens.textContent = estimated
			? localize('voltAgent.contextTokens', "~{0} / {1} Tokens", formatTokens(used), formatTokens(limit))
			: localize('voltAgent.contextTokensExact', "{0} / {1} Tokens", formatTokens(used), formatTokens(limit));

		popup.bar.replaceChildren();
		for (const item of items) {
			const segment = append(popup.bar, $('.segment'));
			segment.style.background = item.color;
			segment.style.flexGrow = String(item.tokens);
		}
		const unused = Math.max(0, limit - used);
		const rest = append(popup.bar, $('.segment.unused'));
		rest.style.flexGrow = String(Math.max(unused, used === 0 ? 1 : 0));

		popup.list.replaceChildren();
		for (const item of items) {
			const row = append(popup.list, $('.row'));
			const swatch = append(row, $('span.swatch'));
			swatch.style.background = item.color;
			append(row, $('span.label')).textContent = item.label;
			append(row, $('span.count')).textContent = formatTokens(item.tokens);
		}
	}

	private cancelHideContextUsage(): void {
		if (this.contextHoverTimer !== undefined) {
			getWindow(this.container).clearTimeout(this.contextHoverTimer);
			this.contextHoverTimer = undefined;
		}
	}

	private scheduleHideContextUsage(): void {
		this.cancelHideContextUsage();
		this.contextHoverTimer = getWindow(this.container).setTimeout(() => {
			this.contextHoverTimer = undefined;
			this.contextViewService.hideContextView();
		}, 200);
	}

	private showContextUsage(): void {
		this.cancelHideContextUsage();
		if (this.contextUsageOpen) {
			return;
		}
		this.contextUsageOpen = true;
		this.contextViewService.showContextView({
			getAnchor: () => this.contextButton,
			anchorAlignment: AnchorAlignment.RIGHT,
			anchorPosition: AnchorPosition.ABOVE,
			onDOMEvent: (e: globalThis.Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || this.contextButton.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			onHide: () => {
				this.contextUsageOpen = false;
				this.contextPopup = undefined;
				this.cancelHideContextUsage();
			},
			render: container => {
				const store = new DisposableStore();
				const popup = append(container, $('.volt-agent-context-popup'));
				store.add(addDisposableListener(popup, 'mouseenter', () => this.cancelHideContextUsage()));
				store.add(addDisposableListener(popup, 'mouseleave', () => this.scheduleHideContextUsage()));
				const header = append(popup, $('.volt-agent-context-header'));
				append(header, $('span.title')).textContent = localize('voltAgent.contextUsageTitle', "Context Usage");
				const close = append(header, $('button.close')) as HTMLButtonElement;
				close.appendChild(renderIcon(Codicon.close));
				store.add(addDisposableListener(close, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.contextViewService.hideContextView();
				}));

				const summary = append(popup, $('.volt-agent-context-summary'));
				this.contextPopup = {
					percent: append(summary, $('span')),
					tokens: append(summary, $('span.tokens')),
					bar: append(popup, $('.volt-agent-context-bar')),
					list: append(popup, $('.volt-agent-context-list')),
				};
				this.fillContextUsage(this.contextPopup);

				this.bindDropdownDismiss(store, popup, this.contextButton);
				store.add(toDisposable(() => {
					this.contextPopup = undefined;
					popup.remove();
				}));
				return store;
			}
		});
	}

	private updateAccessButton(): void {
		const fromWidth = this.accessButton.offsetWidth;
		this.accessButton.replaceChildren();
		const option = accessModeOption(this.runtime.getAccessMode());
		this.accessButton.appendChild(createAccessIcon(option.id));
		append(this.accessButton, $('span.volt-agent-access-label')).textContent = option.label;
		this.accessButton.appendChild(createChevronIcon());
		setAgentTooltip(this.accessButton, option.description);
		this.animateChipWidth(this.accessButton, fromWidth);
	}

	private showAccessDropdown(): void {
		this.contextViewService.showContextView({
			getAnchor: () => this.accessButton,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			onDOMEvent: (e: globalThis.Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || this.accessButton.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-agent-dropdown.access'));
				const { list, scroll } = appendAgentScrollableList(menu);
				store.add(scroll);
				const selected = this.runtime.getAccessMode();
				for (const option of ACCESS_MODE_OPTIONS) {
					const item = append(list, $('button.volt-agent-dropdown-item.access')) as HTMLButtonElement;
					if (option.id === selected) {
						item.classList.add('active');
					}
					const icon = append(item, $('span.icon'));
					icon.appendChild(createAccessIcon(option.id));
					const copy = append(item, $('span.copy'));
					append(copy, $('span.label')).textContent = option.label;
					append(copy, $('span.desc')).textContent = option.description;
					store.add(addDisposableListener(item, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						void this.runtime.setAccessMode(option.id);
						this.updateAccessButton();
						this.contextViewService.hideContextView();
					}));
				}
				this.bindDropdownDismiss(store, menu, this.accessButton);
				store.add(toDisposable(() => menu.remove()));
				scheduleAtNextAnimationFrame(getWindow(menu), () => scroll.scanDomNode());
				return store;
			}
		});
	}

	private updateModeButton(): void {
		const fromWidth = this.modeButton.offsetWidth;
		this.modeButton.replaceChildren();
		const option = MODE_OPTIONS.find(item => item.id === this.currentMode) ?? MODE_OPTIONS[0];
		const chip = option.id !== 'Agent';
		this.modeButton.classList.toggle('hidden', !chip);
		this.modeButton.classList.toggle('chip', chip);
		if (chip) {
			this.modeButton.appendChild(createModeIcon(option.icon));
			const label = append(this.modeButton, $('span.volt-agent-mode-label'));
			label.textContent = option.label;
			const close = append(this.modeButton, $('button.volt-agent-mode-close')) as HTMLButtonElement;
			setAgentTooltip(close, localize('voltAgent.clearMode', "Back to Agent"));
			close.appendChild(renderIcon(Codicon.close));
		}
		setAgentTooltip(this.modeButton, chip
			? localize('voltAgent.modeChipHint', "{0} - click x or press Tab to return", option.label)
			: localize('voltAgent.modeCycleHint', "{0} - Tab / Shift+Tab for Plan", this.currentMode));
		this.container.dataset.mode = normalizeVoltMode(this.currentMode);
		this.animateChipWidth(this.modeButton, fromWidth);
		this.renderSuggestChips();
	}

	private animateChipWidth(chip: HTMLElement, fromWidth: number): void {
		chip.style.width = '';
		chip.style.maxWidth = '';
		const toWidth = chip.offsetWidth;
		if (fromWidth > 0 && fromWidth !== toWidth) {
			chip.style.maxWidth = `${fromWidth}px`;
			chip.getBoundingClientRect();
			chip.style.maxWidth = `${toWidth}px`;
			const clear = (e: TransitionEvent) => {
				if (e.target !== chip || e.propertyName !== 'max-width') {
					return;
				}
				chip.style.maxWidth = '';
				chip.removeEventListener('transitionend', clear);
			};
			chip.addEventListener('transitionend', clear);
		}
		this.scheduleToolbarLayout();
	}

	private scheduleToolbarLayout(): void {
		if (!this.toolbarEl || this.toolbarLayoutHandle !== undefined) {
			return;
		}
		const win = getWindow(this.toolbarEl);
		this.toolbarLayoutHandle = win.requestAnimationFrame(() => {
			this.toolbarLayoutHandle = undefined;
			this.layoutToolbar();
		});
	}

	/**
	 * Collapse the composer toolbar as width shrinks. Mode text never truncates.
	 * Model title truncates as one string down to 80px, then goes icon-only.
	 */
	private layoutToolbar(): void {
		const toolbar = this.toolbarEl;
		if (!toolbar || !this.toolbarStartEl || !this.toolbarEndEl) {
			return;
		}
		const win = getWindow(toolbar);
		toolbar.classList.remove('compact-mode', 'compact-model', 'compact-model-truncate', 'compact-model-icon', 'compact-access', 'hide-zoom', 'hide-context', 'hide-attach', 'toolbar-wrap');
		this.modeButton.style.removeProperty('width');
		this.accessButton.style.removeProperty('width');
		this.modelButton.style.removeProperty('width');
		this.modeButton.style.removeProperty('max-width');
		this.accessButton.style.removeProperty('max-width');
		this.modelButton.style.removeProperty('max-width');
		const modelLabel = this.modelButton.querySelector('.volt-agent-model-label') as HTMLElement | null;
		modelLabel?.style.removeProperty('width');
		modelLabel?.style.removeProperty('max-width');

		const styles = win.getComputedStyle(toolbar);
		const available = toolbar.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
		if (available <= 0) {
			return;
		}

		const gap = parseFloat(styles.columnGap || styles.gap) || 8;
		this.modeButton.style.minWidth = 'max-content';
		this.accessButton.style.minWidth = 'max-content';
		this.modelButton.style.minWidth = 'max-content';
		const startNatural = this.groupUsedWidth(this.toolbarStartEl);
		const endNatural = this.groupUsedWidth(this.toolbarEndEl);
		const modelNatural = this.modelButton.offsetWidth;
		const accessNatural = this.accessButton.offsetWidth;
		this.modeButton.style.removeProperty('min-width');
		this.accessButton.style.removeProperty('min-width');
		this.modelButton.style.removeProperty('min-width');

		let deficit = startNatural + endNatural + gap - available;
		if (deficit <= 0) {
			this.syncAccessTooltip(false);
			this.syncModelTooltip();
			return;
		}

		toolbar.classList.add('compact-access');
		this.syncAccessTooltip(true);
		deficit -= Math.max(0, accessNatural - this.accessButton.offsetWidth);
		if (deficit <= 0) {
			this.syncModelTooltip();
			return;
		}

		const MODEL_LABEL_MIN = 80;
		if (modelLabel) {
			const labelNatural = modelLabel.scrollWidth;
			const chrome = Math.max(0, this.modelButton.offsetWidth - modelLabel.offsetWidth);
			const shrink = Math.min(deficit, Math.max(0, labelNatural - MODEL_LABEL_MIN));
			if (shrink > 0) {
				toolbar.classList.add('compact-model-truncate');
				const labelWidth = Math.max(MODEL_LABEL_MIN, labelNatural - shrink);
				modelLabel.style.width = `${labelWidth}px`;
				modelLabel.style.maxWidth = `${labelWidth}px`;
				this.modelButton.style.maxWidth = `${chrome + labelWidth}px`;
				deficit -= shrink;
			}
			if (deficit <= 0) {
				this.syncModelTooltip();
				return;
			}
		}

		toolbar.classList.add('compact-model-icon');
		this.syncModelTooltip();
		deficit -= Math.max(0, modelNatural - this.modelButton.offsetWidth);
		if (deficit <= 0) {
			return;
		}

		deficit -= this.zoomButton.offsetWidth + gap;
		toolbar.classList.add('hide-zoom');
		if (deficit <= 0) {
			return;
		}

		deficit -= this.contextButton.offsetWidth + gap;
		toolbar.classList.add('hide-context');
		if (deficit <= 0) {
			return;
		}

		toolbar.classList.add('toolbar-wrap');
	}

	private groupUsedWidth(group: HTMLElement): number {
		const kids = Array.from(group.children).filter(el => {
			return getWindow(el).getComputedStyle(el).display !== 'none';
		}) as HTMLElement[];
		if (!kids.length) {
			return 0;
		}
		const gap = parseFloat(getWindow(group).getComputedStyle(group).columnGap || getWindow(group).getComputedStyle(group).gap) || 8;
		return kids.reduce((sum, el) => sum + el.offsetWidth, 0) + gap * (kids.length - 1);
	}

	private syncAccessTooltip(iconOnly: boolean): void {
		const option = accessModeOption(this.runtime.getAccessMode());
		setAgentTooltip(this.accessButton, iconOnly ? option.label : option.description);
	}

	private syncModelTooltip(): void {
		this.modelButton.removeAttribute('title');
	}

	private updateZoomButton(): void {
		this.zoomButton.replaceChildren();
		this.zoomButton.appendChild(createExpandIcon(this.composerZoomed));
		setAgentTooltip(this.zoomButton, this.composerZoomed
			? localize('voltAgent.zoomOut', "Restore composer size")
			: localize('voltAgent.zoomIn', "Expand composer"));
	}

	private toggleComposerZoom(): void {
		this.setComposerZoomed(!this.composerZoomed);
		scheduleAtNextAnimationFrame(getWindow(this.container), () => this.layoutInputEditor());
		this.inputEditor?.focus();
	}

	private setComposerZoomed(zoomed: boolean): void {
		this.composerZoomed = zoomed;
		this.container.classList.toggle('zoomed', zoomed);
		if (!zoomed) {
			this.applyComposerHeight(undefined);
		} else {
			this.composerHeight = undefined;
			this.composerEl.style.height = '';
			this.composerEl.style.flex = '';
			this.container.classList.remove('resized');
			this.updateComposerEditorOptions();
			this.layoutInputEditor();
			this.sash?.layout();
		}
		const input = this.input;
		if (input instanceof AgentEditorInput) {
			input.composerZoomed = zoomed;
			if (zoomed) {
				input.composerHeight = undefined;
			}
		}
		this.updateZoomButton();
		this.updateComposerEditorOptions();
	}

	private applyComposerHeight(height: number | undefined): void {
		if (height !== undefined) {
			const min = 140;
			const max = Math.max(min, this.container.clientHeight - 72);
			height = Math.min(max, Math.max(min, height));
		}
		this.composerHeight = height;
		if (height === undefined) {
			this.composerEl.style.height = '';
			this.composerEl.style.flex = '';
			this.container.classList.remove('resized');
		} else {
			this.composerEl.style.height = `${height}px`;
			this.composerEl.style.flex = '0 0 auto';
			this.container.classList.add('resized');
		}
		const input = this.input;
		if (input instanceof AgentEditorInput) {
			input.composerHeight = height;
		}
		this.updateComposerEditorOptions();
		this.layoutInputEditor();
		this.sash?.layout();
	}

	private showAgentLineNumbers(): boolean {
		return this.configurationService.getValue<boolean>(AGENT_EDITOR_LINE_NUMBERS_SETTING) === true;
	}

	private codeFontFamily(): string {
		const configured = this.configurationService.getValue<string>('editor.fontFamily');
		return configured && configured !== 'default' ? configured : EDITOR_FONT_DEFAULTS.fontFamily;
	}

	private applyCodeFont(): void {
		this.container.style.setProperty('--volt-code-font', this.codeFontFamily());
	}

	private getWorkbenchEditorOptions(): ICodeEditorOptions {
		const value = this.textResourceConfigurationService.getValue<ICodeEditorOptions>(this.inputModel?.uri, 'editor');
		return isObject(value) ? deepClone(value) : Object.create(null);
	}

	private getAgentInputEditorOptions(): ICodeEditorOptions {
		const editorConfiguration = this.getWorkbenchEditorOptions();
		const expanded = this.composerZoomed || this.composerHeight !== undefined;
		const showLineNumbers = this.showAgentLineNumbers();
		this.monacoHost?.classList.toggle('has-line-numbers', showLineNumbers);
		return {
			...editorConfiguration,
			fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif',
			fontSize: 14,
			fontWeight: '300',
			lineHeight: 22,
			cursorStyle: 'line',
			cursorWidth: 1,
			renderLineHighlight: 'none',
			renderLineHighlightOnlyWhenFocus: false,
			guides: {
				indentation: false,
				highlightActiveIndentation: false,
				bracketPairs: false,
				bracketPairsHorizontal: false,
			},
			lineNumbers: showLineNumbers ? 'on' : 'off',
			lineNumbersMinChars: 1,
			lineDecorationsWidth: 0,
			glyphMargin: false,
			folding: false,
			overviewRulerLanes: expanded ? 3 : 0,
			fixedOverflowWidgets: true,
			automaticLayout: false,
			dropIntoEditor: { enabled: true },
			scrollBeyondLastLine: false,
			ariaLabel: localize('voltAgent.inputAria', "Agent input"),
			scrollbar: {
				vertical: 'auto',
				horizontal: 'hidden',
				verticalScrollbarSize: 10,
				useShadows: false,
				alwaysConsumeMouseWheel: false,
				handleMouseWheel: true,
			},
			...(expanded ? {} : { minimap: { enabled: false } }),
			stickyScroll: { enabled: false },
			editContext: false,
		};
	}

	private updateComposerEditorOptions(): void {
		this.inputEditor?.updateOptions(this.getAgentInputEditorOptions());
	}

	private persistInputState(): void {
		const input = this.input;
		if (!(input instanceof AgentEditorInput)) {
			return;
		}
		input.messages = this.messages;
		input.contextUsed = this.sessionTokensUsed;
		input.contextWindow = this.sessionTokensWindow;
		if (this.inputModel) {
			input.draft = this.inputModel.getValue();
			input.setHasUnsavedContent(!!input.draft.trim());
		}
		input.composerZoomed = this.composerZoomed;
		input.composerHeight = this.composerHeight;
		input.promptQueue = this.promptQueue;
		input.queueExpanded = this.queueExpanded;
	}

	private restoreInputState(input: AgentEditorInput): void {
		this.clearFindHighlights();
		this.thinkingStore.clear();
		this.messages = input.messages as IAgentMessage[];
		this.sessionTokensUsed = input.contextUsed;
		this.sessionTokensWindow = input.contextWindow;
		this.editingUserIndex = undefined;
		this.editRestoreDraft = '';
		this.editRestoreMentions = [];
		this.stickToBottom = true;
		this.syncComposerPlacement();
		this.renderThread(true);
		if (this.inputModel && this.inputModel.getValue() !== input.draft) {
			this.inputModel.setValue(input.draft);
		}
		this.setComposerZoomed(input.composerZoomed);
		if (!input.composerZoomed) {
			this.applyComposerHeight(input.composerHeight);
		}
		this.promptQueue = Array.isArray(input.promptQueue) ? input.promptQueue.slice() as typeof this.promptQueue : [];
		this.queueExpanded = !!input.queueExpanded;
		this.renderQueueBar();
		this.updateSendButton();
		input.setHasUnsavedContent(!!input.draft.trim());
		this.updateInputPlaceholder();
	}

	private inputPlaceholderText(): string {
		if (this.currentMode === 'Plan') {
			return localize('voltAgent.planPlaceholder', "Plan changes");
		}
		if (this.currentMode === 'Debug') {
			return localize('voltAgent.debugPlaceholder', "Debug issue");
		}
		if (this.currentMode === 'Ask') {
			return localize('voltAgent.askPlaceholder', "Ask a question");
		}
		if (this.currentMode === 'Multitask') {
			return localize('voltAgent.multitaskPlaceholder', "Run subagents");
		}
		if (this.editingUserIndex !== undefined) {
			return localize('voltAgent.editAndSendAgain', "Edit and send again");
		}
		return this.isFollowUpComposer()
			? localize('voltAgent.followUpPlaceholder', "Send follow-up")
			: localize('voltAgent.inputPlaceholder', "Plan, Build, / for skills, @ for context");
	}

	private updateInputPlaceholder(): void {
		if (!this.placeholderEl) {
			return;
		}
		this.placeholderEl.textContent = this.inputPlaceholderText();
		const empty = !(this.inputModel?.getValue());
		this.placeholderEl.classList.toggle('hidden', !empty);
	}

	private syncUnsavedState(): void {
		const input = this.input;
		if (!(input instanceof AgentEditorInput)) {
			return;
		}
		const draft = this.inputModel?.getValue() ?? '';
		input.draft = draft;
		input.setHasUnsavedContent(!!draft.trim());
	}

	private updateModelButton(): void {
		const fromWidth = this.modelButton.offsetWidth;
		this.modelButton.replaceChildren();
		const selected = this.currentModel ? this.catalog.find(option => option.ref === this.currentModel) : undefined;
		const label = append(this.modelButton, $('span.volt-agent-model-label'));
		if (this.modelAuto) {
			label.textContent = localize('voltAgent.auto', "Auto");
		} else if (selected) {
			label.textContent = this.modelPicker.modelOptionsLabel(selected) || selected.name;
		} else {
			label.textContent = localize('voltAgent.connectModel', "Connect a model");
		}
		this.modelButton.appendChild(createChevronIcon());
		this.animateChipWidth(this.modelButton, fromWidth);
		this.renderContextRing();
	}

	private showModelDropdown(): void {
		this.tooltip.hide();
		this.modelPicker.show(this.modelButton, () => this.inputEditor?.focus());
	}

	private cycleEffort(): void {
		this.modelPicker.cycleEffort();
	}

	private bindDropdownDismiss(store: DisposableStore, menu: HTMLElement, anchor: HTMLElement): void {
		const hideIfOutside = (target: EventTarget | null) => {
			if (!(target instanceof Node)) {
				return;
			}
			if (menu.contains(target) || anchor.contains(target)) {
				return;
			}
			this.contextViewService.hideContextView();
		};
		store.add(addDisposableListener(getWindow(menu).document, 'mousedown', e => hideIfOutside(e.target), true));
		store.add(addDisposableListener(getWindow(menu), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.contextViewService.hideContextView();
				this.inputEditor?.focus();
			}
		}));
	}

	setMode(id: string): void {
		if (this.currentMode === id) {
			return;
		}
		this.currentMode = id;
		this.updateModeButton();
		this.updateInputPlaceholder();
	}

	private togglePlan(): void {
		this.setMode(this.currentMode === 'Plan' ? 'Agent' : 'Plan');
	}

	private hidePlusMenu(): void {
		this.plusMenuStore.clear();
		this.plusMenuEl?.remove();
		this.plusMenuEl = undefined;
		this.plusMenuOpen = false;
	}

	private showPlusMenu(): void {
		if (this.plusMenuOpen) {
			this.hidePlusMenu();
			return;
		}
		this.tooltip.hide();
		this.plusMenuStore.clear();
		this.plusMenuEl?.remove();
		this.plusMenuOpen = true;
		const menu = $('.volt-agent-plus-menu');
		this.plusMenuEl = menu;
		this.composerEl.insertBefore(menu, this.inputBox);
		const search = append(menu, $('input.volt-agent-plus-search')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('voltAgent.plusSearch', "Search skills, context, chats...");
		const list = append(menu, $('.volt-agent-plus-list'));
		const itemsStore = this.plusMenuStore.add(new DisposableStore());

		const selectableModes = MODE_OPTIONS.filter(option => option.id !== 'Agent');
		const renderItems = (query: string) => {
			itemsStore.clear();
			list.replaceChildren();
			const q = query.trim().toLowerCase();
			const modes = selectableModes.filter(option =>
				!q
				|| option.label.toLowerCase().includes(q)
				|| (option.description ?? '').toLowerCase().includes(q)
			);
			for (const option of modes) {
				const item = append(list, $('button.volt-agent-dropdown-item.plus-mode')) as HTMLButtonElement;
				if (option.id === this.currentMode) {
					item.classList.add('active');
				}
				const icon = append(item, $('span.icon'));
				icon.appendChild(createModeIcon(option.icon));
				append(item, $('span.label')).textContent = option.label;
				if (option.description) {
					append(item, $('span.desc')).textContent = option.description;
				}
				itemsStore.add(addDisposableListener(item, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.setMode(option.id);
					this.hidePlusMenu();
				}));
			}

			const actions = ([
				{ id: 'files' as const, label: localize('voltAgent.plusFiles', "Files"), keys: ['files', 'file', 'attach'] },
				{ id: 'model' as const, label: localize('voltAgent.plusModel', "Model"), keys: ['model'] },
				{ id: 'mcp' as const, label: localize('voltAgent.plusMcp', "MCP"), keys: ['mcp'] },
			]).filter(action =>
				!q
				|| action.label.toLowerCase().includes(q)
				|| action.keys.some(key => key.includes(q) || q.includes(key))
			);

			if (modes.length && actions.length) {
				append(list, $('.volt-agent-dropdown-sep'));
			}

			for (const action of actions) {
				const item = append(list, $('button.volt-agent-dropdown-item.plus-action')) as HTMLButtonElement;
				const icon = append(item, $('span.icon'));
				icon.appendChild(action.id === 'files'
					? createPaperclipIcon()
					: action.id === 'model'
						? createCubeIcon()
						: createPlugIcon());
				append(item, $('span.label')).textContent = action.label;
				if (action.id === 'model') {
					const selected = this.selectedModel();
					const name = this.modelAuto
						? localize('voltAgent.auto', "Auto")
						: selected
							? [this.modelPicker.modelProviderLabel(selected), selected.name].filter(Boolean).join(' ')
							: '';
					if (name) {
						append(item, $('span.desc')).textContent = name;
					}
				}
				if (action.id === 'mcp') {
					const meta = append(item, $('span.meta'));
					meta.appendChild(createChevronRightIcon());
				}
				itemsStore.add(addDisposableListener(item, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.hidePlusMenu();
					if (action.id === 'files') {
						this.ensureInputEditor();
						this.mentionController?.openFilePicker();
						this.inputEditor?.focus();
						return;
					}
					if (action.id === 'model') {
						scheduleAtNextAnimationFrame(getWindow(this.plusButton), () => this.showModelDropdown());
						return;
					}
					void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
				}));
			}
		};

		renderItems('');
		this.plusMenuStore.add(addDisposableListener(search, 'input', () => renderItems(search.value)));
		this.plusMenuStore.add(addDisposableListener(getWindow(menu).document, 'mousedown', e => {
			if (!(e.target instanceof Node)) {
				return;
			}
			if (menu.contains(e.target) || this.plusButton.contains(e.target) || this.modeButton.contains(e.target)) {
				return;
			}
			this.hidePlusMenu();
		}, true));
		this.plusMenuStore.add(addDisposableListener(getWindow(menu), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hidePlusMenu();
				this.inputEditor?.focus();
			}
		}));
		this.plusMenuStore.add(toDisposable(() => {
			menu.remove();
			if (this.plusMenuEl === menu) {
				this.plusMenuEl = undefined;
				this.plusMenuOpen = false;
			}
		}));
		scheduleAtNextAnimationFrame(getWindow(menu), () => search.focus());
	}

	private renderSuggestChips(): void {
		if (!this.suggestEl) {
			return;
		}
		this.suggestListeners.clear();
		this.suggestEl.replaceChildren();
		this.suggestEl.classList.toggle('hidden', this.isFollowUpComposer() || this.editingUserIndex !== undefined);
		if (this.isFollowUpComposer() || this.editingUserIndex !== undefined) {
			return;
		}
		const addChip = (label: string, onClick: () => void, kb?: string) => {
			const chip = append(this.suggestEl, $('button.volt-agent-suggest-chip')) as HTMLButtonElement;
			append(chip, $('span.label')).textContent = label;
			if (kb) {
				append(chip, $('span.kb')).textContent = kb;
			}
			this.suggestListeners.add(addDisposableListener(chip, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				onClick();
			}));
		};
		if (this.currentMode !== 'Plan') {
			addChip(localize('voltAgent.planNewIdea', "Plan New Idea"), () => this.setMode('Plan'), localize('voltAgent.planKb', "⇧Tab"));
		}
		if (this.currentMode !== 'Multitask') {
			addChip(localize('voltAgent.multitaskChip', "Multitask"), () => this.setMode('Multitask'));
		}
		addChip(localize('voltAgent.runInCloud', "Run in Cloud"), () => { /* visual chip */ });
	}

	private setSearchableText(parent: HTMLElement, text: string): void {
		const span = append(parent, $('span.volt-agent-searchable'));
		span.textContent = text;
	}

	private renderUserMessageText(parent: HTMLElement, message: IAgentUserMessage): void {
		const mentions = message.mentions?.filter(mention => mention.label) ?? [];
		if (!mentions.length) {
			this.setSearchableText(parent, message.text);
			return;
		}
		let cursor = 0;
		const text = message.text;
		for (const mention of mentions) {
			const index = text.indexOf(mention.label, cursor);
			if (index < 0) {
				continue;
			}
			if (index > cursor) {
				this.setSearchableText(parent, text.slice(cursor, index));
			}
			const classes = ['volt-agent-inline-mention', mention.kind];
			if (mention.kind === 'browser') {
				classes.push(`c${mention.accent ?? 0}`);
			}
			const chip = append(parent, $(`.${classes.join('.')}`));
			if (mention.kind === 'browser') {
				chip.style.setProperty('--volt-mention-accent', browserMentionColor(mention.accent));
			}
			append(chip, $('span.volt-agent-inline-mention-icon'));
			this.setSearchableText(append(chip, $('span.volt-agent-inline-mention-label')), mention.label);
			cursor = index + mention.label.length;
		}
		if (cursor < text.length) {
			this.setSearchableText(parent, text.slice(cursor));
		} else if (cursor === 0) {
			this.setSearchableText(parent, text);
		}
	}

	private blockRenderContext(message: IAgentAssistantMessage): IBlockRenderContext {
		return {
			markdownRenderer: this.markdownRenderer,
			store: this.threadListeners,
			blockState: message.blockState,
			onToggle: id => this.toggleBlock(message, id),
			onScroll: () => this.syncThreadScroll(this.stickToBottom),
			onOpenPath: (path, startLine, endLine) => void this.openWorkspaceFile(path, startLine, endLine),
			onTerminalMenu: (anchor, command) => this.showTerminalBlockMenu(anchor, command),
			onAccessDecision: (requestId, effect, scope, pattern) => this.runtime.respondToAccessRequest(requestId, effect, scope, pattern),
		};
	}

	private showTerminalBlockMenu(anchor: HTMLElement, command: string): void {
		if (anchor.classList.contains('open')) {
			this.contextViewService.hideContextView();
			return;
		}
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorAlignment: AnchorAlignment.RIGHT,
			anchorPosition: AnchorPosition.BELOW,
			onDOMEvent: (e: globalThis.Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || anchor.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				anchor.classList.add('open');
				store.add(toDisposable(() => anchor.classList.remove('open')));
				const menu = append(container, $('.volt-agent-dropdown.terminal-menu'));
				const heading = append(menu, $('div.volt-agent-dropdown-item.heading'));
				heading.textContent = localize('voltAgent.access', "Access");
				const selected = this.runtime.getAccessMode();
				for (const option of ACCESS_MODE_OPTIONS) {
					const item = append(menu, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
					const icon = append(item, $('span.icon'));
					icon.appendChild(createAccessIcon(option.id));
					append(item, $('span.label')).textContent = option.label;
					if (option.id === selected) {
						const check = append(item, $('span.check'));
						check.appendChild(renderIcon(Codicon.check));
					}
					store.add(addDisposableListener(item, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						void this.runtime.setAccessMode(option.id);
						this.updateAccessButton();
						this.contextViewService.hideContextView();
					}));
				}
				append(menu, $('div.volt-agent-dropdown-sep'));
				const copy = append(menu, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
				append(copy, $('span.label')).textContent = localize('voltAgent.copyCommand', "Copy Command");
				copy.disabled = !command;
				store.add(addDisposableListener(copy, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					if (!command) {
						return;
					}
					this.contextViewService.hideContextView();
					void this.clipboardService.writeText(command);
				}));
				this.bindDropdownDismiss(store, menu, anchor);
				store.add(toDisposable(() => menu.remove()));
				return store;
			}
		});
	}

	private toggleBlock(message: IAgentAssistantMessage, blockId: string): void {
		const expanded = !(message.blockState[blockId]?.expanded);
		message.blockState[blockId] = { expanded };
		for (const segment of message.segments) {
			if (segment.kind === 'block' && segment.block.id === blockId && 'expanded' in segment.block) {
				segment.block.expanded = expanded;
			}
		}
		this.renderThread(this.stickToBottom);
	}

	private renderThread(scrollToEnd = false): void {
		this.threadListeners.clear();
		this.threadInner.replaceChildren();
		if (!this.messages.length) {
			this.editingUserIndex = undefined;
			this.editRestoreMentions = [];
			this.syncComposerPlacement();
			this.renderContextRing();
			this.updateInputPlaceholder();
			this.layoutInputEditor();
			this._onDidChangeDock.fire();
			return;
		}
		for (const [index, message] of this.messages.entries()) {
			const turn = append(this.threadInner, $(`.volt-agent-turn.${message.kind}`));

			if (message.kind === 'user') {
				if (this.editingUserIndex === index) {
					turn.classList.add('editing');
					append(turn, $('.volt-agent-edit-slot'));
				} else {
					this.renderUserTurn(turn, message, index);
				}
				const next = this.messages[index + 1];
				if (next?.kind === 'agent' && this.editingUserIndex !== index) {
					this.renderWorkedMeta(turn, next);
				}
			} else {
				this.renderActivity(turn, message);
				const blocks = collectBlocks(message.segments, message.text, !!message.activity?.streaming);
				const hasBody = !!(blocks.length || message.title || message.steps.length || message.changes?.length);
				if (hasBody) {
					const bubble = append(turn, $('.volt-agent-bubble'));
					if (blocks.length) {
						const stack = append(bubble, $('.volt-agent-blocks'));
						const ctx = this.blockRenderContext(message);
						for (const block of blocks) {
							renderAgentBlock(stack, block, ctx);
						}
					}
					if (message.title) {
						const title = append(bubble, $('.volt-agent-plan-title'));
						this.setSearchableText(title, message.title);
					}
					if (message.steps.length) {
						const list = append(bubble, $('ul.volt-agent-steps'));
						for (const step of message.steps) {
							const item = append(list, $('li'));
							const marker = append(item, $('span.volt-agent-step-marker'));
							if (step.state === 'done') {
								item.classList.add('done');
								// allow-any-unicode-next-line
								marker.textContent = '✓';
							} else if (step.state === 'current') {
								marker.textContent = '->';
							} else {
								// allow-any-unicode-next-line
								marker.textContent = '○';
							}
							this.setSearchableText(item, step.label);
						}
					}
					if (message.changes?.length) {
						const changes = append(bubble, $('.volt-agent-changes'));
						this.setSearchableText(append(changes, $('.volt-agent-changes-title')), localize('voltAgent.changes', "Changes"));
						for (const change of message.changes) {
							const row = append(changes, $('.volt-agent-change'));
							this.setSearchableText(row, change);
						}
					}
				}
				if (!message.activity?.streaming) {
					this.renderAgentFooter(turn, message);
				}
			}
		}
		this.syncComposerPlacement();
		this.syncThreadScroll(scrollToEnd);
		scheduleAtNextAnimationFrame(getWindow(this.threadInner), () => {
			if (this.editingUserIndex !== undefined) {
				this.syncComposerPlacement();
				this.layoutInputEditor();
			}
			this.syncThreadScroll(scrollToEnd);
		});
		if (this.findWidget?.isVisible()) {
			this.applyFindHighlights(false);
		}
		this.renderContextRing();
		this.updateInputPlaceholder();
		this.layoutInputEditor();
	}

	private renderUserTurn(turn: HTMLElement, message: IAgentUserMessage, index: number): void {
		const editable = this.canEditUser(index);
		if (this.canResendCancelledUser(index)) {
			turn.classList.add('cancelled');
		}
		if (editable) {
			turn.classList.add('editable');
		}
		const row = append(turn, $('.volt-agent-user-row'));
		const bubble = append(row, $('.volt-agent-bubble'));
		bubble.style.borderRadius = '8px';
		const main = append(bubble, $('.volt-agent-user-main'));
		const text = append(main, $('.volt-agent-text'));
		this.renderUserMessageText(text, message);
		if (message.chips?.length) {
			const chipRow = append(main, $('.volt-agent-chips'));
			for (const chip of message.chips) {
				const el = append(chipRow, $('.volt-agent-chip'));
				this.setSearchableText(el, chip);
			}
		}
		if (this.isStreaming() && this.isLatestUser(index)) {
			turn.classList.add('running');
			const stop = append(bubble, $('button.volt-agent-user-stop')) as HTMLButtonElement;
			setAgentTooltip(stop, localize('voltAgent.stop', "Stop"));
			stop.appendChild(createStopIcon());
			this.threadListeners.add(addDisposableListener(stop, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.stopAgent();
			}));
		}
		if (editable) {
			setAgentTooltip(turn, localize('voltAgent.editMessage', "Edit message"));
			this.threadListeners.add(addDisposableListener(turn, 'click', e => {
				if ((e.target as HTMLElement).closest('.volt-agent-user-stop')) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.startUserEdit(index);
			}));
		}
	}

	private isCancelledAgent(message: IAgentAssistantMessage): boolean {
		if (message.cancelled) {
			return true;
		}
		const status = message.activity?.status?.toLowerCase() ?? '';
		return /cancel|abort|stopp/.test(status);
	}

	private isLatestUser(index: number): boolean {
		return !this.messages.slice(index + 1).some(item => item.kind === 'user');
	}

	private canEditUser(index: number): boolean {
		const message = this.messages[index];
		return !!message && message.kind === 'user';
	}

	private canResendCancelledUser(index: number): boolean {
		const next = this.messages[index + 1];
		return !!next && next.kind === 'agent' && this.isCancelledAgent(next) && !this.isStreaming() && this.isLatestUser(index);
	}

	private startUserEdit(index: number): void {
		const message = this.messages[index];
		if (!message || message.kind !== 'user') {
			return;
		}
		this.ensureInputEditor();
		this.editRestoreDraft = this.inputModel?.getValue() ?? '';
		this.editRestoreMentions = this.mentionController?.displayMentions() ?? [];
		this.editingUserIndex = index;
		this.mentionController?.clear();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.setValue(message.text);
			this.mentionController?.restoreMentions(message.mentions ?? []);
			const lastLine = this.inputModel.getLineCount();
			this.inputEditor?.setPosition({ lineNumber: lastLine, column: this.inputModel.getLineMaxColumn(lastLine) });
		}
		this.renderThread(false);
		this.renderSuggestChips();
		this.updateSendButton();
		this.layoutInputEditor();
		this.threadInner.querySelector('.volt-agent-edit-slot')?.scrollIntoView({ block: 'nearest' });
		this.inputEditor?.focus();
	}

	private onEditPointerDown(e: PointerEvent): void {
		if (this.editingUserIndex === undefined || !isHTMLElement(e.target)) {
			return;
		}
		if (e.target.closest('.volt-agent-edit-slot')
			|| e.target.closest('.volt-agent-turn.user.editing')
			|| e.target.closest('.volt-agent-composer')
			|| e.target.closest('.volt-agent-dropdown')
			|| e.target.closest('.volt-agent-plus-menu')
			|| e.target.closest('.monaco-context-view')
			|| e.target.closest('.context-view')
			|| e.target.closest('.suggest-widget')
			|| e.target.closest('.monaco-hover')) {
			return;
		}
		const other = e.target.closest('.volt-agent-turn.user');
		if (other && this.threadInner.contains(other)) {
			const ordinal = Array.from(this.threadInner.querySelectorAll('.volt-agent-turn.user')).indexOf(other);
			let userOrdinal = -1;
			for (const [index, item] of this.messages.entries()) {
				if (item.kind !== 'user') {
					continue;
				}
				userOrdinal++;
				if (userOrdinal === ordinal) {
					this.cancelUserEdit(false);
					this.startUserEdit(index);
					return;
				}
			}
		}
		this.cancelUserEdit(false);
	}

	private cancelUserEdit(focusComposer = true): void {
		if (this.editingUserIndex === undefined) {
			return;
		}
		this.editingUserIndex = undefined;
		this.mentionController?.clear();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.setValue(this.editRestoreDraft);
			this.mentionController?.restoreMentions(this.editRestoreMentions);
		}
		this.editRestoreDraft = '';
		this.editRestoreMentions = [];
		this.syncComposerPlacement();
		this.renderThread(this.stickToBottom);
		this.renderSuggestChips();
		this.updateSendButton();
		this.layoutInputEditor();
		if (focusComposer) {
			this.inputEditor?.focus();
		}
	}

	private commitUserEdit(value: string, display?: IAgentPromptDisplay): void {
		const index = this.editingUserIndex;
		if (index === undefined) {
			this.dispatchPrompt(value, display);
			return;
		}
		if (this.isStreaming()) {
			this.skipRunEvents = true;
			this.stopAgent();
		}
		this.editingUserIndex = undefined;
		this.editRestoreDraft = '';
		this.editRestoreMentions = [];
		this.messages.splice(index);
		this.syncComposerPlacement();
		this.dispatchPrompt(value, display);
	}

	private syncComposerPlacement(): void {
		const slot = this.threadInner?.querySelector<HTMLElement>('.volt-agent-edit-slot');
		const editing = this.editingUserIndex !== undefined && !!slot;
		this.container.classList.toggle('editing-user', editing);
		if (editing && slot) {
			if (this.composerEl.parentElement !== slot) {
				slot.appendChild(this.composerEl);
			}
			return;
		}
		if (this.composerEl.parentElement !== this.container) {
			const find = this.findWidget?.getDomNode();
			if (find?.parentElement === this.container) {
				this.container.insertBefore(this.composerEl, find);
			} else {
				this.container.appendChild(this.composerEl);
			}
		}
	}

	private measureThreadContentHeight(): number {
		const styles = getWindow(this.threadInner).getComputedStyle(this.threadInner);
		const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
		const gap = parseFloat(styles.rowGap || styles.gap) || 0;
		let height = padding;
		const children = this.threadInner.children;
		for (let i = 0; i < children.length; i++) {
			height += (children[i] as HTMLElement).offsetHeight;
			if (i > 0) {
				height += gap;
			}
		}
		return Math.max(height, this.threadInner.scrollHeight);
	}

	private syncThreadScroll(scrollToEnd = false): void {
		if (!this.threadScroll) {
			return;
		}
		const viewport = this.threadScroll.getDomNode();
		const viewportHeight = viewport.clientHeight;
		const scrollHeight = Math.max(viewportHeight, this.measureThreadContentHeight());
		this.threadScroll.setScrollDimensions({
			width: viewport.clientWidth,
			height: viewportHeight,
			scrollWidth: this.threadInner.scrollWidth,
			scrollHeight,
		});
		if (scrollToEnd || this.stickToBottom) {
			this.threadScroll.setScrollPosition({ scrollTop: scrollHeight });
			this.stickToBottom = true;
		}
	}

	private scrollThreadToEnd(): void {
		this.stickToBottom = true;
		this.syncThreadScroll(true);
	}

	private renderActivity(turn: HTMLElement, message: IAgentAssistantMessage): void {
		const activity = message.activity;
		if (!activity) {
			return;
		}

		const section = append(turn, $('.volt-agent-activity'));
		if (activity.streaming) {
			const summary = formatExploringSummary(activity.items);
			if (summary) {
				const progress = append(section, $('div.volt-agent-activity-progress.shimmer'));
				activity.shimmerStartedAt ??= Date.now();
				progress.style.animationDelay = `${-((Date.now() - activity.shimmerStartedAt) % 2000)}ms`;
				this.setSearchableText(progress, summary);
			}
			const status = append(section, $('div.volt-agent-activity-progress.shimmer'));
			activity.shimmerStartedAt ??= Date.now();
			status.style.animationDelay = `${-((Date.now() - activity.shimmerStartedAt) % 2000)}ms`;
			this.setSearchableText(status, activity.status || localize('voltAgent.thinking', "Thinking"));
			return;
		}

		const toggle = append(section, $('button.volt-agent-activity-toggle')) as HTMLButtonElement;
		toggle.classList.toggle('expanded', activity.expanded);
		const label = append(toggle, $('span.volt-agent-activity-label'));
		this.setSearchableText(label, activity.status);
		const chevron = append(toggle, $('span.volt-agent-activity-chevron'));
		chevron.appendChild(renderIcon(activity.expanded ? Codicon.chevronDown : Codicon.chevronRight));
		this.threadListeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.isCancelledAgent(message) && !this.isStreaming()) {
				const agentIndex = this.messages.indexOf(message);
				for (let i = agentIndex - 1; i >= 0; i--) {
					if (this.messages[i].kind === 'user') {
						this.startUserEdit(i);
						return;
					}
				}
			}
			activity.expanded = !activity.expanded;
			this.renderThread(this.stickToBottom);
		}));

		if (!activity.expanded) {
			return;
		}

		const body = append(section, $('.volt-agent-activity-body'));
		for (const item of activity.items) {
			const row = append(body, $(`.volt-agent-activity-item.${item.kind}`));
			if (item.path) {
				const link = append(row, $('button.volt-agent-file-link')) as HTMLButtonElement;
				const action = append(link, $('span.action'));
				action.textContent = item.label;
				if (item.detail) {
					const detail = append(link, $('span.detail.volt-agent-searchable'));
					detail.textContent = item.detail;
				}
				this.threadListeners.add(addDisposableListener(link, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.openWorkspaceFile(item.path!, item.startLine, item.endLine);
				}));
			} else {
				const action = append(row, $('span.action'));
				action.textContent = item.label;
				if (item.detail) {
					const detail = append(row, $('span.detail'));
					detail.textContent = item.detail;
				}
			}
		}
		if (activity.thinkingText) {
			const thought = append(body, $('.volt-agent-thinking-text'));
			renderMarkdownInto(thought, activity.thinkingText, this.blockRenderContext(message));
		}
	}

	private renderWorkedMeta(turn: HTMLElement, message: IAgentAssistantMessage): void {
		if (!message.startedAt) {
			return;
		}
		const ended = message.endedAt ?? (message.activity?.streaming ? Date.now() : message.startedAt);
		const line = append(turn, $('div.volt-agent-worked'));
		line.dataset.startedAt = String(message.startedAt);
		if (message.endedAt) {
			line.dataset.endedAt = String(message.endedAt);
		}
		this.fillWorkedLine(line, ended - message.startedAt);
		this.ensureClock();
	}

	private fillWorkedLine(line: HTMLElement, ms: number): void {
		let duration = line.querySelector<HTMLElement>('.volt-agent-worked-duration');
		if (!duration) {
			duration = append(line, $('span.volt-agent-worked-duration.volt-agent-searchable'));
		}
		duration.textContent = formatWorkedDuration(ms);
		line.querySelector('.volt-agent-token-chip')?.remove();
	}

	private renderAgentFooter(turn: HTMLElement, message: IAgentAssistantMessage): void {
		const footer = append(turn, $('.volt-agent-footer'));
		const when = message.endedAt ?? message.startedAt;
		if (when) {
			const ago = append(footer, $('span.volt-agent-ago'));
			ago.dataset.endedAt = String(when);
			this.setSearchableText(ago, dayjs(when).fromNow());
			this.ensureClock();
		}

		const forkButton = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		setAgentTooltip(forkButton, localize('voltAgent.fork', "Fork"));
		forkButton.appendChild(renderIcon(Codicon.repoForked));
		this.threadListeners.add(addDisposableListener(forkButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(NEW_AGENT_COMMAND_ID, { asTab: true });
		}));

		const copyButton = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		setAgentTooltip(copyButton, localize('voltAgent.copy', "Copy"));
		copyButton.appendChild(renderIcon(Codicon.copy));
		this.threadListeners.add(addDisposableListener(copyButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.clipboardService.writeText(agentMessagePlainText(message)).then(() => {
				copyButton.replaceChildren(renderIcon(Codicon.check));
				setAgentTooltip(copyButton, localize('voltAgent.copied', "Copied"));
				copyButton.classList.add('copied');
				this.threadListeners.add(disposableTimeout(() => {
					if (!copyButton.isConnected) {
						return;
					}
					copyButton.replaceChildren(renderIcon(Codicon.copy));
					setAgentTooltip(copyButton, localize('voltAgent.copy', "Copy"));
					copyButton.classList.remove('copied');
				}, 1500));
			});
		}));
	}

	private ensureClock(): void {
		if (this.clockTimer) {
			return;
		}
		const win = getWindow(this.container);
		const id = win.setInterval(() => this.tickMeta(), 1000);
		this.clockTimer = toDisposable(() => win.clearInterval(id));
		this._register(this.clockTimer);
	}

	private tickMeta(): void {
		if (!this.threadInner) {
			return;
		}
		for (const el of this.threadInner.querySelectorAll<HTMLElement>('.volt-agent-worked')) {
			const started = Number(el.dataset.startedAt);
			if (!Number.isFinite(started)) {
				continue;
			}
			const ended = el.dataset.endedAt ? Number(el.dataset.endedAt) : Date.now();
			this.fillWorkedLine(el, ended - started);
		}
		for (const el of this.threadInner.querySelectorAll<HTMLElement>('.volt-agent-ago')) {
			const when = Number(el.dataset.endedAt);
			if (!Number.isFinite(when)) {
				continue;
			}
			const text = el.querySelector('.volt-agent-searchable') ?? el;
			text.textContent = dayjs(when).fromNow();
		}
	}

	private async openWorkspaceFile(path: string, startLine?: number, endLine?: number): Promise<void> {
		const resource = await this.resolveWorkspaceFile(path);
		if (!resource) {
			return;
		}
		const group = this.editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(g => g !== this.group) ?? this.group;
		await this.editorService.openEditor({
			resource,
			options: {
				pinned: true,
				revealIfOpened: true,
				selection: startLine ? {
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine ?? startLine,
					endColumn: 1,
				} : undefined,
			},
		}, group);
	}

	private async resolveWorkspaceFile(path: string): Promise<URI | undefined> {
		const trimmed = path.replace(/^["'`]+|["'`]+$/g, '').trim();
		if (!trimmed) {
			return undefined;
		}

		const candidates: URI[] = [];
		try {
			if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
				candidates.push(URI.parse(trimmed));
			}
		} catch {
			// ignore invalid URIs
		}
		if (isAbsolute(trimmed)) {
			candidates.push(URI.file(trimmed));
		}
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			candidates.push(joinPath(folder.uri, trimmed.replace(/^\.\//, '')));
		}

		const seen = new Set<string>();
		for (const uri of candidates) {
			const key = uri.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			if (await this.fileService.exists(uri)) {
				return uri;
			}
		}

		const name = basename(trimmed);
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder || !name) {
			return undefined;
		}
		try {
			const result = await searchFilesAndFolders(folder.uri, name, false, undefined, undefined, this.configurationService, this.searchService);
			return result.files.find(file => basename(file.path) === name) ?? result.files[0];
		} catch {
			return undefined;
		}
	}

	/** Replaces the composer draft. Used by the prediction one-shot when it escalates to the agent. */
	prefillDraft(text: string): void {
		this.ensureInputEditor();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.setValue(text);
			const lastLine = this.inputModel.getLineCount();
			this.inputEditor?.setPosition({ lineNumber: lastLine, column: this.inputModel.getLineMaxColumn(lastLine) });
		}
		this.inputEditor?.focus();
	}

	submitPrompt(text: string, display?: IAgentPromptDisplay): void {
		const value = text.trim();
		if (!value) {
			return;
		}
		this.ensureInputEditor();
		if (this.isStreaming()) {
			this.enqueuePrompt(value, display);
			return;
		}
		this.dispatchPrompt(value, display);
	}

	stopRun(): void {
		this.stopAgent();
	}

	getThreadView(): AgentThreadView | undefined {
		return this.threadView;
	}

	setBrowserHosted(hosted: boolean): void {
		this.container.classList.toggle('browser-hosted', hosted);
		this.syncFollowUpComposer((this.inputModel?.getLineCount() ?? 1) > 1);
		this.updateInputPlaceholder();
		this.layoutInputEditor();
		this.renderSuggestChips();
	}

	layoutThread(): void {
		this.syncThreadScroll(this.stickToBottom);
	}

	getDockState(): IAgentDockState {
		const firstUser = this.messages.find((message): message is IAgentUserMessage => message.kind === 'user');
		const lastAgent = [...this.messages].reverse().find((message): message is IAgentAssistantMessage => message.kind === 'agent');
		const streaming = this.isStreaming();
		const startedAt = lastAgent?.startedAt;
		const endedAt = lastAgent?.endedAt;
		const durationMs = lastAgent?.durationMs ?? (startedAt ? (endedAt ?? Date.now()) - startedAt : undefined);
		const status = streaming
			? (lastAgent?.activity?.status || localize('voltAgent.working', "Working"))
			: lastAgent?.cancelled
				? localize('voltAgent.cancelled', "Cancelled")
				: durationMs !== undefined
					? formatWorkedDuration(durationMs)
					: '';
		const title = (firstUser?.text ?? '').trim().split('\n')[0] || localize('voltAgent.chat', "Agent");
		return {
			title: title.length > 64 ? `${title.slice(0, 61)}...` : title,
			streaming,
			cancelled: !!lastAgent?.cancelled,
			status,
			startedAt,
			endedAt,
			durationMs,
			turns: this.messages.map(message => message.kind === 'user'
				? { kind: 'user', text: message.text }
				: {
					kind: 'agent',
					text: agentMessagePlainText(message),
					status: message.activity?.status,
					streaming: !!message.activity?.streaming,
				}),
		};
	}

	addSelectionMention(resource: URI, selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): void {
		this.ensureInputEditor();
		const startLineNumber = selection.startLineNumber;
		let endLineNumber = selection.endLineNumber;
		if (selection.endColumn === 1 && endLineNumber > startLineNumber) {
			endLineNumber -= 1;
		}
		if (endLineNumber < startLineNumber) {
			endLineNumber = startLineNumber;
		}
		this.mentionController?.addResourceMention(resource, { startLineNumber, endLineNumber });
		this.inputEditor?.focus();
	}

	async addResourceMentions(resources: readonly URI[]): Promise<void> {
		this.ensureInputEditor();
		await this.mentionController?.addResourceMentions(resources);
		this.inputEditor?.focus();
	}

	private ensureInputEditor(): void {
		if (this.inputEditor) {
			return;
		}

		this.inputEditor = this.editorDisposables.add(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.monacoHost,
			this.getAgentInputEditorOptions(),
			Object.create(null)
		));

		const modelUri = URI.from({ scheme: 'volt-agent-input', path: `input-${this.sessionKey}-${Date.now()}` });
		this.inputModel = this.modelService.createModel('', null, modelUri, true);
		this.inputEditor.setModel(this.inputModel);
		this.mentionController = this.editorDisposables.add(this.instantiationService.createInstance(AgentMentionController, this.inputEditor));
		this.composerLists = this.editorDisposables.add(new AgentComposerLists(this.inputEditor));
		this.mentionController.bindDropTarget(this.container);
		this.mentionController.bindDropTarget(this.inputBox);

		this.editorDisposables.add(this.inputEditor.onDidFocusEditorText(() => this.inputBox.classList.add('focused')));
		this.editorDisposables.add(this.inputEditor.onDidBlurEditorText(() => this.inputBox.classList.remove('focused')));
		this.editorDisposables.add(this.inputEditor.onDidChangeModelContent(() => {
			this.layoutInputEditor();
			this.updateInputPlaceholder();
			this.updateSendButton();
			this.syncUnsavedState();
			this.renderContextRing();
		}));
		this.editorDisposables.add(this.inputEditor.onDidContentSizeChange(e => {
			if (e.contentHeightChanged) {
				this.layoutInputEditor();
			}
		}));
		this.editorDisposables.add(this.inputEditor.onKeyDown(e => {
			if (e.keyCode === KeyCode.Enter && !e.altKey && !e.metaKey && !e.ctrlKey && this.composerLists?.tryHandleEnter()) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.keyCode === KeyCode.KeyF && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				this.revealFind();
				return;
			}
			if (e.keyCode === KeyCode.Tab && !e.altKey && !e.metaKey && !e.ctrlKey) {
				if (this.mentionController?.isMenuOpen) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.togglePlan();
				return;
			}
			if (e.keyCode === KeyCode.Slash && (e.metaKey || e.ctrlKey) && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) {
					this.cycleEffort();
				} else {
					this.tooltip.hide();
					this.showModelDropdown();
				}
				return;
			}
			if (e.keyCode === KeyCode.Escape && this.editingUserIndex !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				this.cancelUserEdit();
				return;
			}
			if (e.keyCode === KeyCode.Enter && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				this.send();
			}
		}));
		this.updateComposerEditorOptions();
		this.updateInputPlaceholder();
	}

	private send(): void {
		const displayText = this.inputModel?.getValue() ?? '';
		const mentions = this.mentionController?.displayMentions() ?? [];
		const agentText = (this.mentionController?.serialize() || displayText).trim();
		const display = mentions.length ? { text: displayText, mentions } : undefined;
		if (this.editingUserIndex !== undefined) {
			if (!agentText) {
				return;
			}
			this.commitUserEdit(agentText, display);
			return;
		}
		if (this.isStreaming()) {
			if (agentText) {
				this.enqueuePrompt(agentText, display);
				return;
			}
			this.stopAgent();
			return;
		}
		if (!agentText) {
			return;
		}
		this._onDidComposerSend.fire();
		this.dispatchPrompt(agentText, display);
	}

	private enqueuePrompt(text: string, display?: IAgentPromptDisplay): void {
		this.promptQueue.push({ id: `q-${Date.now()}-${this.promptQueue.length}`, text, display });
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.setValue('');
		}
		this.updateInputPlaceholder();
		this.updateSendButton();
		this.renderQueueBar();
		this.persistInputState();
		this.inputEditor?.focus();
	}

	private dispatchPrompt(value: string, display?: IAgentPromptDisplay): void {
		this.thinkingStore.clear();
		this.messages.push({
			kind: 'user',
			text: display?.text.trim() || value,
			agentText: display ? value : undefined,
			mentions: display?.mentions,
		});
		const reply: IAgentAssistantMessage = {
			kind: 'agent',
			title: '',
			steps: [],
			segments: [],
			blockState: {},
			startedAt: Date.now(),
			activity: {
				status: localize('voltAgent.planningMoves', "Planning next moves"),
				expanded: false,
				streaming: true,
				items: [],
			},
		};
		this.messages.push(reply);
		this._onDidChangeDock.fire();
		this.clearComposer();
		this.updateSendButton();
		this.stickToBottom = true;
		this.renderThread(true);
		this.scrollThreadToEnd();
		this.inputEditor?.focus();

		const session = this.runtime.getOrCreateSession(this.sessionKey);
		void this.runtime.send(session.sessionId, {
			text: value,
			mode: normalizeVoltMode(this.currentMode) as VoltMode,
			providerRef: this.modelAuto ? undefined : (this.currentModel || undefined),
			options: this.modelAuto || !this.currentModel ? undefined : this.runtime.getModelOptions(this.currentModel),
		}).catch(err => {
			reply.activity!.streaming = false;
			reply.endedAt = Date.now();
			reply.durationMs = reply.endedAt - (reply.startedAt ?? reply.endedAt);
			const errorText = err instanceof Error ? err.message : String(err);
			reply.text = errorText;
			reply.segments.push({ kind: 'text', text: errorText });
			this.renderThread(true);
			this.updateSendButton();
			this.drainPromptQueue();
		});
	}

	private stopAgent(): void {
		const last = this.messages.at(-1);
		if (last?.kind === 'agent' && last.activity?.streaming) {
			last.cancelled = true;
			last.activity.streaming = false;
			last.activity.expanded = !!last.activity.thinkingText || last.activity.items.length > 0;
			last.activity.status = localize('voltAgent.cancelled', "Cancelled");
			last.endedAt = Date.now();
			last.startedAt ??= last.endedAt;
			last.durationMs = Math.max(0, last.endedAt - last.startedAt);
			this.updateSendButton();
			this.renderThread(this.stickToBottom);
			this._onDidChangeDock.fire();
		}
		const session = this.runtime.getOrCreateSession(this.sessionKey);
		void this.runtime.cancel(session.sessionId);
	}

	private drainPromptQueue(): void {
		if (this.isStreaming()) {
			this.updateSendButton();
			return;
		}
		const next = this.promptQueue.shift();
		this.renderQueueBar();
		this.persistInputState();
		if (next) {
			this.dispatchPrompt(next.text, next.display);
			return;
		}
		this.updateSendButton();
	}

	private hasDraft(): boolean {
		return !!(this.inputModel?.getValue().trim());
	}

	private updateSendButton(): void {
		const stop = this.isStreaming() && (this.editingUserIndex !== undefined || !this.hasDraft());
		const kind: 'mic' | 'send' | 'stop' = stop ? 'stop' : this.hasDraft() ? 'send' : 'mic';
		if (this.sendKind === kind && this.sendButton.childElementCount) {
			this.sendButton.classList.toggle('stop', kind === 'stop');
			return;
		}
		this.sendKind = kind;
		this.sendButton.replaceChildren();
		this.sendButton.classList.toggle('stop', kind === 'stop');
		setAgentTooltip(this.sendButton, kind === 'stop'
			? localize('voltAgent.stop', "Stop")
			: kind === 'send'
				? localize('voltAgent.send', "Send (Cmd+Enter)")
				: localize('voltAgent.voice', "Voice"));
		this.sendButton.appendChild(kind === 'stop' ? createStopIcon() : kind === 'send' ? createSendIcon() : createMicIcon());
	}

	private renderQueueBar(): void {
		this.queueBarListeners.clear();
		this.queueBarEl.replaceChildren();
		const count = this.promptQueue.length;
		this.queueBarEl.classList.toggle('hidden', count === 0);
		this.queueBarEl.classList.toggle('expanded', this.queueExpanded && count > 0);
		if (!count) {
			this.queueExpanded = false;
			return;
		}
		const toggle = append(this.queueBarEl, $('button.volt-agent-queue-toggle')) as HTMLButtonElement;
		toggle.setAttribute('aria-expanded', String(this.queueExpanded));
		const chevron = append(toggle, $('span.volt-agent-queue-chevron'));
		chevron.appendChild(renderIcon(this.queueExpanded ? Codicon.chevronDown : Codicon.chevronRight));
		const label = append(toggle, $('span.volt-agent-queue-label'));
		label.textContent = localize('voltAgent.queuedCount', "{0} queued", count);
		this.queueBarListeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.queueExpanded = !this.queueExpanded;
			this.renderQueueBar();
		}));
		if (!this.queueExpanded) {
			return;
		}
		const list = append(this.queueBarEl, $('.volt-agent-queue-list'));
		for (const item of this.promptQueue) {
			const row = append(list, $('.volt-agent-queue-item'));
			const text = append(row, $('span.volt-agent-queue-text'));
			const preview = item.display?.text.trim() || item.text;
			text.textContent = preview;
			setAgentTooltip(text, preview);
			const remove = append(row, $('button.volt-agent-queue-remove')) as HTMLButtonElement;
			setAgentTooltip(remove, localize('voltAgent.removeQueued', "Remove from queue"));
			remove.appendChild(renderIcon(Codicon.close));
			this.queueBarListeners.add(addDisposableListener(remove, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.promptQueue = this.promptQueue.filter(queued => queued.id !== item.id);
				this.renderQueueBar();
				this.persistInputState();
			}));
		}
	}

	private clearComposer(): void {
		this.mentionController?.clear();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.setValue('');
		}
		this.inputEditor?.setPosition({ lineNumber: 1, column: 1 });
		this.inputEditor?.setScrollTop(0);
		this.composerHeight = undefined;
		this.composerEl.style.height = '';
		this.composerEl.style.flex = '';
		this.container.classList.remove('resized');
		const input = this.input;
		if (input instanceof AgentEditorInput) {
			input.draft = '';
			input.composerHeight = undefined;
			input.setHasUnsavedContent(false);
		}
		this.updateInputPlaceholder();
		this.updateComposerEditorOptions();
		this.layoutInputEditor();
	}

	private isStreaming(): boolean {
		const last = this.messages.at(-1);
		return last?.kind === 'agent' && !!last.activity?.streaming;
	}

	private bindRuntimeSession(): void {
		this.eventDisposable?.dispose();
		const session = this.runtime.getOrCreateSession(this.sessionKey);
		this.eventDisposable = this.runtime.onEvent(session.sessionId, envelope => this.applyEvent(envelope));
	}

	private applyUsage(event: Extract<IVoltEventEnvelope['event'], { type: 'usage' }>, last?: IAgentAssistantMessage): void {
		if (event.used !== undefined && Number.isFinite(event.used) && event.used >= 0) {
			this.sessionTokensUsed = event.used;
			if (last) {
				last.tokensUsed = event.used;
			}
		}
		if (event.size !== undefined && Number.isFinite(event.size) && event.size > 0) {
			this.sessionTokensWindow = event.size;
			if (last) {
				last.tokensWindow = event.size;
			}
		}
		if (!last) {
			return;
		}
		if (Number.isFinite(event.input) && event.input > 0) {
			last.tokensIn = event.input;
		}
		if (Number.isFinite(event.output) && event.output > 0) {
			last.tokensOut = event.output;
		}
		if (event.cache !== undefined && Number.isFinite(event.cache) && event.cache >= 0) {
			last.tokensCache = event.cache;
		}
	}

	private applyEvent(envelope: IVoltEventEnvelope): void {
		const event = envelope.event;
		if (this.skipRunEvents && event.type !== 'run.start') {
			return;
		}
		if (event.type === 'run.start') {
			this.skipRunEvents = false;
			this.activeRunId = envelope.runId;
		} else if (this.activeRunId && envelope.runId !== this.activeRunId) {
			return;
		}
		const last = this.messages.at(-1);
		if (event.type === 'usage') {
			this.applyUsage(event, last?.kind === 'agent' ? last : undefined);
			this.persistInputState();
			this.scheduleThreadRender();
			return;
		}
		if (!last || last.kind !== 'agent') {
			return;
		}
		if (last.cancelled && event.type !== 'run.end') {
			return;
		}
		const activity = last.activity ?? {
			status: localize('voltAgent.thinking', "Thinking"),
			expanded: false,
			streaming: true,
			items: [],
		};
		last.activity = activity;
		last.segments ??= [];
		last.blockState ??= {};

		switch (event.type) {
			case 'run.start':
				activity.streaming = true;
				activity.status = localize('voltAgent.planningMoves', "Planning next moves");
				break;
			case 'reasoning.delta':
				activity.expanded = true;
				activity.status = localize('voltAgent.thinking', "Thinking");
				activity.thinkingText = (activity.thinkingText ?? '') + (event.delta ?? '');
				break;
			case 'text.delta':
				last.text = (last.text ?? '') + (event.delta ?? '');
				appendTextDelta(last.segments, event.delta ?? '');
				activity.status = localize('voltAgent.writing', "Writing");
				break;
			case 'tool.start': {
				const parsed = parseShellToolInput(event.input);
				const shell = isShellTool(event.name, event.title, event.input) || looksLikeShell(parsed.command);
				if (shell) {
					const ran = firstCommandName(parsed.command);
					activity.items.push({
						kind: 'note',
						label: localize('voltAgent.ran', "Ran"),
						detail: ran || undefined,
					});
					activity.status = ran
						? localize('voltAgent.runningCommand', "Running {0}", ran)
						: localize('voltAgent.runningTerminal', "Running command");
				} else {
					const target = parseFileTarget(event.input, event.title, event.name);
					const { label, detail } = splitActivityLabel(event.name, event.title, target);
					activity.items.push({
						kind: classifyToolActivity(event.name, event.title),
						label,
						detail,
						path: target?.path,
						startLine: target?.startLine,
						endLine: target?.endLine,
					});
					activity.status = event.title || event.name;
				}
				const id = `tool-${event.callId}`;
				if (shell) {
					const cwd = event.cwd || parsed.cwd || this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
					last.segments.push({
						kind: 'block',
						block: createTerminalBlock({
							id,
							callId: event.callId,
							title: parsed.title || event.title,
							command: parsed.command,
							output: '',
							cwd,
							expanded: false,
						}),
					});
				} else {
					last.segments.push({
						kind: 'block',
						block: createToolBlock({
							id,
							callId: event.callId,
							name: event.name,
							title: event.title,
							input: event.input,
						}),
					});
				}
				last.blockState[id] = { expanded: false };
				break;
			}
			case 'tool.input.delta': {
				const block = findBlockByCallId(last.segments, event.callId);
				if (block?.type === 'terminal') {
					const parsed = parseShellToolInput(event.delta);
					const next = parsed.command || event.delta;
					block.command = block.command
						? (block.command.includes(next) ? block.command : block.command + next)
						: next;
					if (parsed.cwd && !block.cwd) {
						block.cwd = parsed.cwd;
					}
					if (parsed.title && !block.title) {
						block.title = parsed.title;
					}
					const ran = firstCommandName(block.command);
					if (ran) {
						activity.status = localize('voltAgent.runningCommand', "Running {0}", ran);
						const lastItem = activity.items.at(-1);
						if (lastItem && lastItem.label === localize('voltAgent.ran', "Ran") && !lastItem.detail) {
							lastItem.detail = ran;
						}
					}
				} else if (block?.type === 'tool') {
					block.input = block.input ? (block.input.includes(event.delta) ? block.input : block.input + event.delta) : event.delta;
					const lastItem = activity.items.at(-1);
					if (lastItem && !lastItem.path) {
						const target = parseFileTarget(event.delta, lastItem.detail, lastItem.label);
						if (target) {
							lastItem.path = target.path;
							lastItem.startLine = target.startLine;
							lastItem.endLine = target.endLine;
							if (!lastItem.detail) {
								const split = splitActivityLabel(lastItem.label, undefined, target);
								lastItem.label = split.label;
								lastItem.detail = split.detail;
							}
						}
					}
				}
				break;
			}
			case 'tool.end': {
				const block = findBlockByCallId(last.segments, event.callId);
				const output = stringifyToolResult(event.result);
				if (block?.type === 'terminal') {
					block.output = output;
					block.status = event.error ? 'error' : 'complete';
					block.exitCode = event.error ? 1 : 0;
				} else if (block?.type === 'tool') {
					block.output = output;
					block.status = event.error ? 'error' : 'complete';
				}
				break;
			}
			case 'plan':
				last.title = localize('voltAgent.planTitle', "Plan");
				last.steps = event.entries.map(entry => ({
					label: entry.content,
					state: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'current' : 'pending',
				}));
				break;
			case 'file.change': {
				const path = event.uri.path || event.uri.fsPath;
				activity.items.push({
					kind: 'read',
					label: event.kind === 'create' ? 'Created' : event.kind === 'delete' ? 'Deleted' : 'Edited',
					detail: basename(path),
					path,
				});
				break;
			}
			case 'access.ask': {
				const id = `access-${event.request.id}`;
				last.segments.push({
					kind: 'block',
					block: createApprovalBlock({
						id,
						requestId: event.request.id,
						action: event.request.action,
						resource: event.request.resource.value,
						risk: event.request.risk,
						reason: event.request.reason,
						pattern: alwaysAllowPattern(event.request.action, event.request.resource.value),
					}),
				});
				activity.status = localize('voltAgent.waitingApproval', "Waiting for approval");
				break;
			}
			case 'access.resolved': {
				for (const segment of last.segments) {
					if (segment.kind === 'block' && segment.block.type === 'approval' && segment.block.requestId === event.requestId) {
						segment.block.decision = event.effect;
						segment.block.scope = event.scope;
						segment.block.status = event.effect === 'deny' ? 'error' : 'complete';
					}
				}
				break;
			}
			case 'access.blocked': {
				const id = `access-${event.request.id}`;
				last.segments.push({
					kind: 'block',
					block: createApprovalBlock({
						id,
						requestId: event.request.id,
						action: event.request.action,
						resource: event.request.resource.value,
						risk: event.request.risk,
						reason: event.request.reason,
						blocked: true,
						policySource: event.policySource,
						status: 'error',
					}),
				});
				activity.status = localize('voltAgent.blocked', "Blocked");
				break;
			}
			case 'error':
				last.text = event.message;
				appendTextDelta(last.segments, event.message);
				activity.status = localize('voltAgent.error', "Error");
				break;
			case 'run.end':
				activity.streaming = false;
				activity.expanded = !!activity.thinkingText || activity.items.length > 0;
				last.cancelled = last.cancelled || event.reason === 'abort';
				activity.status = last.cancelled
					? localize('voltAgent.cancelled', "Cancelled")
					: localize('voltAgent.thoughtBriefly', "Thought briefly");
				last.endedAt = Date.now();
				last.startedAt ??= last.endedAt;
				last.durationMs = Math.max(0, last.endedAt - last.startedAt);
				this.scheduleThreadRender();
				if (event.reason === 'abort') {
					this.updateSendButton();
				} else {
					this.drainPromptQueue();
				}
				return;
		}
		this.scheduleThreadRender();
	}

	private scheduleThreadRender(): void {
		if (this.renderHandle !== undefined) {
			return;
		}
		const win = getWindow(this.threadInner);
		this.renderHandle = win.requestAnimationFrame(() => {
			this.renderHandle = undefined;
			this.renderThread(this.stickToBottom);
			this._onDidChangeDock.fire();
		});
	}

	private blockWorkbenchFileDrop(e: DragEvent): void {
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'copy';
		}
	}

	private layoutInputEditor(): void {
		this.syncThreadScroll();
		this.scheduleToolbarLayout();
		if (!this.inputEditor || this.inputLayoutInProgress) {
			return;
		}
		this.inputLayoutInProgress = true;
		try {
			this.doLayoutInputEditor();
		} finally {
			this.inputLayoutInProgress = false;
		}
	}

	private isFollowUpComposer(): boolean {
		if (this.container?.classList.contains('browser-hosted')) {
			return false;
		}
		return this.messages.length > 0;
	}

	private placeModelButton(onRight: boolean): void {
		if (onRight) {
			if (this.modelButton.parentElement !== this.toolbarEndEl) {
				this.toolbarEndEl.insertBefore(this.modelButton, this.toolbarEndEl.firstChild);
			}
			return;
		}
		if (this.modelButton.parentElement !== this.toolbarStartEl) {
			this.toolbarStartEl.appendChild(this.modelButton);
		}
	}

	private syncFollowUpComposer(multiline: boolean): void {
		const followUp = this.isFollowUpComposer();
		const editing = this.editingUserIndex !== undefined;
		const wasFollowUp = this.inputBox.classList.contains('follow-up');
		this.inputBox.classList.toggle('editing', editing);
		this.inputBox.classList.toggle('follow-up', followUp && !editing);
		this.container.classList.toggle('follow-up', followUp && !editing);
		this.inputBox.classList.toggle('multiline', followUp && multiline && !editing);
		this.placeModelButton(followUp && !multiline && !editing);
		if (wasFollowUp !== (followUp && !editing)) {
			this.renderSuggestChips();
		}
	}

	private doLayoutInputEditor(): void {
		if (!this.inputEditor) {
			return;
		}
		const empty = !(this.inputModel?.getValue().trim());
		if (empty && !this.composerZoomed && this.composerHeight !== undefined) {
			this.composerHeight = undefined;
			this.composerEl.style.height = '';
			this.composerEl.style.flex = '';
			this.container.classList.remove('resized');
			const input = this.input;
			if (input instanceof AgentEditorInput) {
				input.composerHeight = undefined;
			}
			this.updateComposerEditorOptions();
		}
		if (this.composerZoomed || this.composerHeight !== undefined) {
			this.syncFollowUpComposer(true);
			this.monacoHost.style.height = '';
			const nextStyles = getWindow(this.monacoHost).getComputedStyle(this.monacoHost);
			const nextPadX = parseFloat(nextStyles.paddingLeft) + parseFloat(nextStyles.paddingRight);
			const nextPadY = parseFloat(nextStyles.paddingTop) + parseFloat(nextStyles.paddingBottom);
			const height = Math.max(this.monacoHost.clientHeight - nextPadY, 48);
			this.inputEditor.layout({ width: Math.max(this.monacoHost.clientWidth - nextPadX, 0), height });
			return;
		}
		const lineHeight = 22;
		const value = this.inputModel?.getValue() ?? '';
		const hasNewline = value.includes('\n');
		const hasText = !!value.trim();
		const editing = this.editingUserIndex !== undefined;
		this.syncFollowUpComposer(hasNewline || editing);
		const measure = () => {
			const next = getWindow(this.monacoHost).getComputedStyle(this.monacoHost);
			const nextPadX = parseFloat(next.paddingLeft) + parseFloat(next.paddingRight);
			const nextWidth = Math.max(this.monacoHost.clientWidth - nextPadX, 0);
			this.inputEditor!.layout({ width: nextWidth, height: 0 });
			return { next, nextWidth, rawHeight: this.inputEditor!.getContentHeight() };
		};
		let measured = measure();
		const wrapped = hasText && !hasNewline && !editing && this.isFollowUpComposer() && measured.rawHeight > lineHeight + 4;
		if (wrapped) {
			this.syncFollowUpComposer(true);
			measured = measure();
		}
		const followUpSingle = !editing && this.isFollowUpComposer() && !hasNewline && !wrapped;
		const contentHeight = followUpSingle
			? lineHeight
			: Math.min(Math.max(measured.rawHeight, lineHeight), 180);
		const padBottomTop = parseFloat(measured.next.paddingTop) + parseFloat(measured.next.paddingBottom);
		this.monacoHost.style.height = `${contentHeight + padBottomTop}px`;
		this.inputEditor.layout({ width: measured.nextWidth, height: contentHeight });
	}

	override async setInput(input: AgentEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.persistInputState();
		await super.setInput(input, options, context, token);
		this.ensureInputEditor();
		this.restoreInputState(input);
		this.bindRuntimeSession();
		this.layoutInputEditor();
		this.inputEditor?.focus();
	}

	override clearInput(): void {
		this.persistInputState();
		this.setComposerZoomed(false);
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.layoutInputEditor();
		this.syncThreadScroll();
		this.sash?.layout();
		this.findWidget?.layout(dimension.width);
	}

	override focus(): void {
		this.inputEditor?.focus();
	}

	override getControl(): ICodeEditor | undefined {
		return this.inputEditor;
	}

	revealFind(): void {
		this.findWidget.reveal();
	}

	hideFind(): void {
		this.findWidget.hide();
	}

	findNext(): void {
		this.findWidget.show();
		this.findWidget.find(false);
	}

	findPrevious(): void {
		this.findWidget.show();
		this.findWidget.find(true);
	}

	get findState() {
		return this.findWidget.state;
	}

	findInThread(previous: boolean): void {
		this.applyFindHighlights(true, previous);
	}

	findFirstInThread(): void {
		this.currentFindIndex = 0;
		this.applyFindHighlights(false);
	}

	onFindQueryChanged(): boolean {
		this.currentFindIndex = 0;
		return this.applyFindHighlights(false);
	}

	getFindResultCount(): { resultIndex: number; resultCount: number } {
		return {
			resultIndex: this.findMatches.length ? this.currentFindIndex : 0,
			resultCount: this.findMatches.length,
		};
	}

	getSelectedThreadText(): string | undefined {
		const selection = getWindow(this.threadEl).getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) {
			return undefined;
		}
		const text = selection.toString();
		if (!text || text.includes('\n')) {
			return undefined;
		}
		const node = selection.anchorNode;
		if (!node || !this.threadEl.contains(node)) {
			return undefined;
		}
		return text;
	}

	focusAfterFindClosed(): void {
		this.clearFindHighlights();
		this.inputEditor?.focus();
	}

	private applyFindHighlights(move: boolean, previous = false): boolean {
		const query = this.findWidget?.getQuery() ?? '';
		this.clearFindHighlights();
		if (!query) {
			return false;
		}

		const regex = this.buildFindRegex(query);
		if (!regex) {
			return false;
		}

		const textNodes: Text[] = [];
		for (const root of this.threadInner.querySelectorAll('.volt-agent-searchable')) {
			const walker = this.threadInner.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let current: Node | null;
			while ((current = walker.nextNode())) {
				if (current.textContent) {
					textNodes.push(current as Text);
				}
			}
		}

		const matches: HTMLElement[] = [];
		for (const textNode of textNodes) {
			const text = textNode.data;
			regex.lastIndex = 0;
			const ranges: { start: number; end: number }[] = [];
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				if (!match[0].length) {
					regex.lastIndex++;
					continue;
				}
				ranges.push({ start: match.index, end: match.index + match[0].length });
			}
			if (!ranges.length || !textNode.parentNode) {
				continue;
			}

			const fragment = this.threadInner.ownerDocument.createDocumentFragment();
			let last = 0;
			for (const range of ranges) {
				if (range.start > last) {
					fragment.appendChild(this.threadInner.ownerDocument.createTextNode(text.slice(last, range.start)));
				}
				const mark = this.threadInner.ownerDocument.createElement('span');
				mark.className = 'volt-agent-find-match';
				mark.textContent = text.slice(range.start, range.end);
				matches.push(mark);
				fragment.appendChild(mark);
				last = range.end;
			}
			if (last < text.length) {
				fragment.appendChild(this.threadInner.ownerDocument.createTextNode(text.slice(last)));
			}
			textNode.parentNode.replaceChild(fragment, textNode);
		}

		this.findMatches = matches;
		if (!matches.length) {
			this.currentFindIndex = 0;
			return false;
		}

		if (move) {
			this.currentFindIndex = previous
				? (this.currentFindIndex - 1 + matches.length) % matches.length
				: (this.currentFindIndex + 1) % matches.length;
		} else {
			this.currentFindIndex = Math.min(this.currentFindIndex, matches.length - 1);
		}

		this.highlightCurrentMatch();
		return true;
	}

	private highlightCurrentMatch(): void {
		for (const [index, el] of this.findMatches.entries()) {
			el.classList.toggle('volt-agent-find-match-current', index === this.currentFindIndex);
		}
		this.findMatches[this.currentFindIndex]?.scrollIntoView({ block: 'center', inline: 'nearest' });
		this.syncThreadScroll();
	}

	private clearFindHighlights(): void {
		for (const match of this.findMatches) {
			const parent = match.parentNode;
			if (!parent) {
				continue;
			}
			parent.replaceChild(this.threadInner.ownerDocument.createTextNode(match.textContent ?? ''), match);
			parent.normalize();
		}
		this.findMatches = [];
	}

	private buildFindRegex(query: string): RegExp | undefined {
		try {
			const flags = this.findWidget.getCaseSensitive() ? 'g' : 'gi';
			let source = this.findWidget.getRegex() ? query : escapeRegExpCharacters(query);
			if (this.findWidget.getWholeWord()) {
				source = `\\b${source}\\b`;
			}
			return new RegExp(source, flags);
		} catch {
			return undefined;
		}
	}

	override dispose(): void {
		this.eventDisposable?.dispose();
		this.clockTimer?.dispose();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.dispose();
		}
		super.dispose();
	}

	private get sessionKey(): string {
		const path = (this.input as AgentEditorInput | undefined)?.resource.path ?? String(getWindow(this.container).vscodeWindowId);
		return path.replace(/\//g, '') || 'agent';
	}
}
