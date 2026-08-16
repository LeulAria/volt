/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentEditor.css';
import { $, addDisposableListener, append, Dimension, DragAndDropObserver, getWindow, isHTMLButtonElement, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, isAbsolute } from '../../../../base/common/path.js';
import { isMacintosh } from '../../../../base/common/platform.js';
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
import { describeModelOptions, IModelOptionDescriptor, MODEL_OPTION_CONTEXT, MODEL_OPTION_REASONING, optionValue } from '../../../services/voltRuntime/common/modelOptions.js';
import { normalizeVoltMode, VoltMode } from '../../../services/voltRuntime/common/modes.js';
import { IVoltCatalogItem } from '../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createAccessIcon } from './accessIcons.js';
import { createBrandIcon, providerFamily, providerFamilyLabel } from '../../../services/voltRuntime/browser/providerBrands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../voltSettings/browser/voltSettingsEditorInput.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { GroupsOrder, IEditorGroupsService, IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { searchFilesAndFolders } from '../../search/browser/searchChatContext.js';
import { AGENT_EDITOR_LINE_NUMBERS_SETTING, AgentEditorInput, NEW_AGENT_COMMAND_ID } from './agentEditorInput.js';
import { AgentFindWidget, IAgentFindHost } from './agentFindWidget.js';
import { AgentMentionController } from './agentMentions.js';
import { appendAgentScrollableList } from './agentScrollable.js';
import { dayjs } from './dayjs.js';
import { renderAgentBlock, renderMarkdownInto, IBlockRenderContext } from './blocks/agentBlockRenderers.js';
import { AgentSegment, appendTextDelta, blocksPlainText, classifyToolActivity, collectBlocks, createApprovalBlock, createTerminalBlock, createToolBlock, findBlockByCallId, firstCommandName, isShellTool, looksLikeShell, parseFileTarget, parseShellToolInput, splitActivityLabel, stringifyToolResult } from './blocks/agentBlocks.js';

function createSvgIcon(viewBox: string, pathD: string, extraClass?: string, stroke = false, strokeWidth = '1.5'): HTMLElement {
	const el = extraClass ? $(`span.volt-agent-svg-icon.${extraClass}`) : $('span.volt-agent-svg-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
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

function createChevronIcon(): HTMLElement {
	return createSvgIcon(
		'0 0 16 7',
		'M8 6.5a.47.47 0 0 1-.35-.15l-4.5-4.5c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.15 4.15l4.14-4.14c.2-.2.51-.2.71 0s.2.51 0 .71l-4.5 4.5c-.1.1-.23.15-.35.15Z',
		'chevron'
	);
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

type ModeIconId = 'agent' | 'plan' | 'debug' | 'multitask' | 'ask';

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

function createModeIcon(icon: ModeIconId): HTMLElement {
	switch (icon) {
		case 'plan':
			return createStrokeIcon('plan', [
				'M12 8h9m-9 4h5m-5 8h5m-5-4h9M3 4v7c0 1.87 0 2.804.402 3.5A3 3 0 0 0 4.5 15.598C5.196 16 6.13 16 8 16',
				'M8 8H7c-.93 0-1.395 0-1.776-.102a3 3 0 0 1-2.122-2.122C3 5.395 3 4.93 3 4',
			]);
		case 'debug':
			return createStrokeIcon('debug', [
				'M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1',
				'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6',
				'M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4',
			]);
		case 'multitask':
			return createStrokeIcon('multitask', [
				'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z',
				'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3',
			]);
		case 'ask':
			return createStrokeIcon('ask', [
				'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
			]);
		case 'agent':
		default:
			return createStrokeIcon('agent', [
				'M14 9L13.75 9.375M10 9C9.08779 7.78565 7.63574 7 6 7C3.23858 7 1 9.23858 1 12C1 14.7614 3.23858 17 6 17C7.63582 17 9.08816 16.2144 10.0004 15L10.3337 14.5',
				'M10 9L13.9996 15C14.9118 16.2144 16.3642 17 18 17C20.7614 17 23 14.7614 23 12C23 9.23858 20.7614 7 18 7C16.3642 7 14.9118 7.78555 13.9996 9',
			]);
	}
}

interface IAgentUserMessage {
	kind: 'user';
	text: string;
	chips?: string[];
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
	activity?: IAgentActivity;
}

type IAgentMessage = IAgentUserMessage | IAgentAssistantMessage;

interface IModeOption {
	id: string;
	label: string;
	icon: ModeIconId;
	keybinding?: string;
}

interface IModelOption {
	ref: string;
	name: string;
	qualifier?: string;
	providerId: string;
	family: string;
	optionDescriptors: IModelOptionDescriptor[];
	detail?: string;
	description?: string;
	contextLabel?: string;
	contextWindow: number;
}

interface IProviderGroup {
	family: string;
	label: string;
	models: IModelOption[];
}

const MODE_OPTIONS: IModeOption[] = [
	{ id: 'Agent', label: 'Agent', icon: 'agent', keybinding: 'Tab' },
	{ id: 'Plan', label: 'Plan', icon: 'plan' },
	{ id: 'Debug', label: 'Debug', icon: 'debug' },
	{ id: 'Multitask', label: 'Multitask', icon: 'multitask' },
	// allow-any-unicode-next-line
	{ id: 'Ask', label: 'Ask', icon: 'ask', keybinding: isMacintosh ? '⇧Tab' : 'Shift+Tab' },
];

function catalogToOption(item: IVoltCatalogItem): IModelOption {
	return {
		ref: item.ref,
		name: item.label,
		qualifier: item.qualifier,
		providerId: item.providerId,
		family: providerFamily(item.providerId),
		optionDescriptors: item.optionDescriptors ?? [],
		detail: item.detail,
		description: item.description,
		contextLabel: item.contextLabel,
		contextWindow: item.capabilities.contextWindow,
	};
}

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

function formatTokens(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
	}
	const k = n / 1000;
	return k >= 100 && Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
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

function formatWorkedLine(ms: number, tokensIn?: number, tokensOut?: number, estimatedOut?: number): string {
	const parts = [formatWorkedDuration(ms)];
	if (tokensIn !== undefined) {
		parts.push(localize('voltAgent.tokensInCount', "{0} tokens in", formatTokens(tokensIn)));
	}
	if (tokensOut !== undefined) {
		parts.push(localize('voltAgent.tokensOutCount', "{0} tokens out", formatTokens(tokensOut)));
	}
	if (tokensIn === undefined && tokensOut === undefined && estimatedOut && estimatedOut > 0) {
		parts.push(localize('voltAgent.approxTokens', "~{0} tokens", formatTokens(estimatedOut)));
	}
	return parts.join(' - ');
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
	private threadEl!: HTMLElement;
	private threadInner!: HTMLElement;
	private threadScroll!: DomScrollableElement;
	private composerEl!: HTMLElement;
	private inputBox!: HTMLElement;
	private monacoHost!: HTMLElement;
	private placeholderEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private accessButton!: HTMLButtonElement;
	private modeButton!: HTMLButtonElement;
	private modelButton!: HTMLButtonElement;
	private toolbarStartEl!: HTMLElement;
	private toolbarEndEl!: HTMLElement;
	private zoomButton!: HTMLButtonElement;
	private contextButton!: HTMLButtonElement;
	private attachButton!: HTMLButtonElement;
	private sendButton!: HTMLButtonElement;

	private inputEditor: ICodeEditor | undefined;
	private inputModel: ITextModel | undefined;
	private mentionController: AgentMentionController | undefined;
	private readonly editorDisposables = this._register(new DisposableStore());

	private messages: IAgentMessage[] = [];
	private currentMode = MODE_OPTIONS[0].id;
	private currentModel = '';
	private modelAuto = false;
	private catalog: IModelOption[] = [];
	private pickerProviderId: string | undefined;
	private pickerOptionsRef: string | undefined;
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
		this.syncCatalog();
		this._register(this.runtime.onDidChangeCatalog(() => {
			this.syncCatalog();
			this.updateModelButton();
			this.renderContextRing();
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
		this.threadEl = append(this.container, $('.volt-agent-thread'));
		this.threadInner = $('.volt-agent-thread-inner');
		this.threadScroll = this._register(new DomScrollableElement(this.threadInner, {
			className: 'volt-agent-thread-scroll',
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			verticalScrollbarSize: 14,
			useShadows: false,
			handleMouseWheel: true,
			alwaysConsumeMouseWheel: false,
		}));
		const threadScrollNode = this.threadScroll.getDomNode();
		threadScrollNode.style.width = '100%';
		threadScrollNode.style.height = '100%';
		this.threadEl.appendChild(threadScrollNode);
		this._register(this.threadScroll.onScroll(e => {
			this.stickToBottom = e.scrollTop + e.height >= e.scrollHeight - 32;
		}));
		const threadWindow = getWindow(this.threadInner);
		const threadResizeObserver = new threadWindow.ResizeObserver(() => this.syncThreadScroll());
		threadResizeObserver.observe(this.threadEl);
		this._register(toDisposable(() => threadResizeObserver.disconnect()));
		this.composerEl = append(this.container, $('.volt-agent-composer'));
		this.inputBox = append(this.composerEl, $('.volt-agent-input-box'));
		this.monacoHost = append(this.inputBox, $('.volt-agent-monaco.show-file-icons'));
		this.placeholderEl = append(this.monacoHost, $('.volt-agent-placeholder'));
		this.placeholderEl.setAttribute('aria-hidden', 'true');
		this.updateInputPlaceholder();

		this.toolbarEl = append(this.inputBox, $('.volt-agent-toolbar'));
		this.toolbarStartEl = append(this.toolbarEl, $('.volt-agent-toolbar-start'));
		this.toolbarEndEl = append(this.toolbarEl, $('.volt-agent-toolbar-end'));
		this.modeButton = append(this.toolbarStartEl, $('button.volt-agent-mode')) as HTMLButtonElement;
		this.accessButton = append(this.toolbarStartEl, $('button.volt-agent-access')) as HTMLButtonElement;
		this.modelButton = append(this.toolbarStartEl, $('button.volt-agent-model')) as HTMLButtonElement;

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
		this.contextButton.title = localize('voltAgent.contextUsage', "Context usage");
		this.renderContextRing();

		this.attachButton = append(this.toolbarEndEl, $('button.volt-agent-icon-btn.volt-agent-attach-btn')) as HTMLButtonElement;
		this.attachButton.title = localize('voltAgent.attach', "Add context");
		this.attachButton.appendChild(renderIcon(Codicon.attach));

		this.sendButton = append(this.toolbarEndEl, $('button.volt-agent-send')) as HTMLButtonElement;
		// allow-any-unicode-next-line
		this.sendButton.title = localize('voltAgent.send', "Send (⌘↵)");
		this.sendButton.appendChild(createSvgIcon('0 0 24 24', 'M12 19V5M5 12l7-7 7 7', 'send', true, '2.3'));

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

		this._register(addDisposableListener(this.accessButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showAccessDropdown();
		}));
		this._register(addDisposableListener(this.modeButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showModeDropdown();
		}));
		this._register(addDisposableListener(this.modelButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
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
		return this.currentModel ? this.catalog.find(option => option.ref === this.currentModel) : undefined;
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
		this.contextButton.title = localize('voltAgent.contextUsageDetail', "Context usage: {0} / {1}", formatTokens(used), formatTokens(limit));
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
			onDOMEvent: (e: Event) => {
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
		this.accessButton.title = option.description;
		this.animateChipWidth(this.accessButton, fromWidth);
	}

	private showAccessDropdown(): void {
		this.contextViewService.showContextView({
			getAnchor: () => this.accessButton,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			onDOMEvent: (e: Event) => {
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
		this.modeButton.appendChild(createModeIcon(option.icon));
		const label = append(this.modeButton, $('span.volt-agent-mode-label'));
		label.textContent = this.currentMode;
		this.modeButton.title = localize('voltAgent.modeCycleHint', "{0} - Tab / Shift+Tab to switch", this.currentMode);
		this.modeButton.appendChild(createChevronIcon());
		this.container.dataset.mode = normalizeVoltMode(this.currentMode);
		this.animateChipWidth(this.modeButton, fromWidth);
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
			this.syncModelTooltip(false);
			return;
		}

		toolbar.classList.add('compact-access');
		this.syncAccessTooltip(true);
		deficit -= Math.max(0, accessNatural - this.accessButton.offsetWidth);
		if (deficit <= 0) {
			this.syncModelTooltip(false);
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
				this.syncModelTooltip(shrink > 0);
				return;
			}
		}

		toolbar.classList.add('compact-model-icon');
		this.syncModelTooltip(true);
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
		this.accessButton.title = iconOnly ? option.label : option.description;
	}

	private syncModelTooltip(iconOnly: boolean): void {
		if (!iconOnly) {
			this.modelButton.removeAttribute('title');
			return;
		}
		const selected = this.currentModel ? this.catalog.find(option => option.ref === this.currentModel) : undefined;
		this.modelButton.title = this.modelAuto
			? localize('voltAgent.auto', "Auto")
			: (selected ? this.modelTitle(selected) : localize('voltAgent.connectModel', "Connect a model"));
	}

	private updateZoomButton(): void {
		this.zoomButton.replaceChildren();
		this.zoomButton.appendChild(createExpandIcon(this.composerZoomed));
		this.zoomButton.title = this.composerZoomed
			? localize('voltAgent.zoomOut', "Restore composer size")
			: localize('voltAgent.zoomIn', "Expand composer");
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

	private agentInputFontFamily(): string {
		const fromDom = this.container ? getWindow(this.container).getComputedStyle(this.container).fontFamily : '';
		return fromDom && fromDom !== 'monospace' ? fromDom : '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif';
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
			fontFamily: this.agentInputFontFamily(),
			fontSize: 13,
			fontWeight: '400',
			lineHeight: 18,
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
	}

	private restoreInputState(input: AgentEditorInput): void {
		this.clearFindHighlights();
		this.thinkingStore.clear();
		this.messages = input.messages as IAgentMessage[];
		this.sessionTokensUsed = input.contextUsed;
		this.sessionTokensWindow = input.contextWindow;
		this.stickToBottom = true;
		this.renderThread(true);
		if (this.inputModel && this.inputModel.getValue() !== input.draft) {
			this.inputModel.setValue(input.draft);
		}
		this.setComposerZoomed(input.composerZoomed);
		if (!input.composerZoomed) {
			this.applyComposerHeight(input.composerHeight);
		}
		input.setHasUnsavedContent(!!input.draft.trim());
		this.updateInputPlaceholder();
	}

	private inputPlaceholderText(): string {
		return this.messages.length
			? localize('voltAgent.followUpPlaceholder', "Add a follow-up")
			: localize('voltAgent.inputPlaceholder', "Plan, search, or build anything");
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

	private syncCatalog(): void {
		this.catalog = this.runtime.listCatalog()
			.filter(item => item.enabled)
			.map(catalogToOption)
			.filter(option => option.name.trim().toLowerCase() !== 'auto');
		// The runtime remembers the composer selection across restarts and shares it with the
		// Tab Prediction Runtime, so it - not this editor - is the source of truth.
		const persisted = this.runtime.getActiveCatalogRef();
		if (persisted && this.catalog.some(item => item.ref === persisted)) {
			this.currentModel = persisted;
		}
		if (!this.currentModel || !this.catalog.some(item => item.ref === this.currentModel)) {
			this.currentModel = this.catalog[0]?.ref ?? '';
		}
		if (this.currentModel && this.currentModel !== persisted) {
			void this.runtime.setActiveCatalogRef(this.currentModel);
		}
	}

	/**
	 * Groups the enabled catalog into the rail on the left of the picker. Providers that are two
	 * faces of the same vendor share a tab, so a Codex CLI connection and an OpenAI API key land
	 * together instead of as two identical icons.
	 */
	private providerGroups(): IProviderGroup[] {
		const groups = new Map<string, IProviderGroup>();
		for (const option of this.catalog) {
			let group = groups.get(option.family);
			if (!group) {
				group = { family: option.family, label: providerFamilyLabel(option.providerId), models: [] };
				groups.set(option.family, group);
			}
			group.models.push(option);
		}
		return [...groups.values()];
	}

	private modelProviderLabel(model: IModelOption): string | undefined {
		const label = model.qualifier?.trim() || providerFamilyLabel(model.providerId);
		if (!label || model.name.toLowerCase().includes(label.toLowerCase())) {
			return undefined;
		}
		return label;
	}

	private modelOptionsLabel(model: IModelOption): string | undefined {
		return describeModelOptions(model.optionDescriptors, this.runtime.getModelOptions(model.ref));
	}

	/** Display title: `Cursor Grok 4.6 High Fast`. */
	private modelTitle(model: IModelOption): string {
		return [this.modelProviderLabel(model), model.name, this.modelOptionsLabel(model)].filter(Boolean).join(' ');
	}

	private updateModelButton(): void {
		const fromWidth = this.modelButton.offsetWidth;
		this.modelButton.replaceChildren();
		const selected = this.currentModel ? this.catalog.find(option => option.ref === this.currentModel) : undefined;
		if (this.modelAuto) {
			this.modelButton.appendChild(renderIcon(Codicon.sparkle));
		} else if (selected) {
			this.modelButton.appendChild(createBrandIcon(selected.providerId, 13));
		}
		const label = append(this.modelButton, $('span.volt-agent-model-label'));
		if (this.modelAuto) {
			label.textContent = localize('voltAgent.auto', "Auto");
		} else if (selected) {
			label.textContent = this.modelTitle(selected);
		} else {
			label.textContent = localize('voltAgent.connectModel', "Connect a model");
		}
		this.modelButton.appendChild(createChevronIcon());
		this.animateChipWidth(this.modelButton, fromWidth);
		this.renderContextRing();
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

	private cycleMode(delta: number): void {
		const index = MODE_OPTIONS.findIndex(item => item.id === this.currentMode);
		const next = MODE_OPTIONS[(Math.max(index, 0) + delta + MODE_OPTIONS.length) % MODE_OPTIONS.length];
		if (next.id === this.currentMode) {
			return;
		}
		this.currentMode = next.id;
		this.updateModeButton();
	}

	private showModeDropdown(): void {
		this.contextViewService.showContextView({
			getAnchor: () => this.modeButton,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			onDOMEvent: (e: Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || this.modeButton.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-agent-dropdown.modes.models'));
				const { list, scroll } = appendAgentScrollableList(menu);
				store.add(scroll);
				for (const option of MODE_OPTIONS) {
					const item = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
					if (option.id === this.currentMode) {
						item.classList.add('active');
					}
					const icon = append(item, $('span.icon'));
					icon.appendChild(createModeIcon(option.icon));
					append(item, $('span.label')).textContent = option.label;
					const meta = append(item, $('span.meta'));
					if (option.keybinding) {
						append(meta, $('span.kb')).textContent = option.keybinding;
					}
					if (option.id === this.currentMode) {
						const check = append(meta, $('span.check'));
						check.appendChild(renderIcon(Codicon.check));
					}
					store.add(addDisposableListener(item, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						this.currentMode = option.id;
						this.updateModeButton();
						this.contextViewService.hideContextView();
					}));
				}
				this.bindDropdownDismiss(store, menu, this.modeButton);
				store.add(addDisposableListener(getWindow(menu), 'keydown', e => {
					if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) {
						return;
					}
					e.preventDefault();
					e.stopPropagation();
					this.cycleMode(e.shiftKey ? -1 : 1);
					for (const child of list.children) {
						if (!isHTMLButtonElement(child)) {
							continue;
						}
						const label = child.querySelector('.label')?.textContent;
						const active = MODE_OPTIONS.some(option => option.id === this.currentMode && option.label === label);
						child.classList.toggle('active', active);
						child.querySelector('.check')?.remove();
						if (active) {
							const check = append(child.querySelector('.meta') ?? child, $('span.check'));
							check.appendChild(renderIcon(Codicon.check));
						}
					}
				}, true));
				store.add(toDisposable(() => menu.remove()));
				scheduleAtNextAnimationFrame(getWindow(menu), () => scroll.scanDomNode());
				return store;
			}
		});
	}

	/**
	 * Three stage picker: a provider rail on the left, that provider's models in the middle, and
	 * an options column on the right for thinking, context window, and reasoning effort.
	 */
	private showModelDropdown(): void {
		this.syncCatalog();
		if (!this.catalog.length || this.runtime.isCatalogLoading()) {
			void this.runtime.refreshCatalog();
		}
		const selected = this.catalog.find(option => option.ref === this.currentModel);
		this.pickerProviderId = selected?.family ?? this.pickerProviderId;
		this.pickerOptionsRef = undefined;

		this.contextViewService.showContextView({
			getAnchor: () => this.modelButton,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			onDOMEvent: (e: Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || this.modelButton.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-agent-dropdown.models.picker'));
				const hover = append(container, $('.volt-agent-model-hover.hidden'));
				const rail = append(menu, $('.volt-agent-provider-rail'));
				const main = append(menu, $('.volt-agent-picker-main'));

				const searchRow = append(main, $('.volt-agent-dropdown-search-row'));
				append(searchRow, createSvgIcon('0 0 24 24', 'M17 17L22 22M19.5 10.75C19.5 15.5825 15.5825 19.5 10.75 19.5C5.91751 19.5 2 15.5825 2 10.75C2 5.91751 5.91751 2 10.75 2C15.5825 2 19.5 5.91751 19.5 10.75Z', 'search', true));
				const search = append(searchRow, $('input.volt-agent-dropdown-search')) as HTMLInputElement;
				search.placeholder = localize('voltAgent.searchModels', "Search models");
				search.type = 'text';

				const autoRow = append(main, $('.volt-agent-dropdown-auto'));
				append(autoRow, $('span')).textContent = localize('voltAgent.auto', "Auto");
				const autoToggle = append(autoRow, $('button.volt-agent-switch')) as HTMLButtonElement;
				autoToggle.setAttribute('role', 'switch');
				append(autoToggle, $('span.volt-agent-switch-thumb'));
				const { list, scroll } = appendAgentScrollableList(main);
				store.add(scroll);
				store.add(scroll.onScroll(() => hover.classList.add('hidden')));
				const optionsColumn = append(menu, $('.volt-agent-picker-options'));

				// Cleared on every re-render so listeners never pile up on replaced nodes.
				const renderStore = store.add(new DisposableStore());
				const renderAll = () => {
					renderStore.clear();
					autoToggle.classList.toggle('on', this.modelAuto);
					autoToggle.setAttribute('aria-checked', String(this.modelAuto));
					main.classList.toggle('auto', this.modelAuto);

					const groups = this.providerGroups();
					if (this.pickerProviderId && !groups.some(group => group.family === this.pickerProviderId)) {
						this.pickerProviderId = undefined;
					}
					this.pickerProviderId ??= groups[0]?.family;
					this.renderProviderRail(rail, groups, renderStore, renderAll);
					this.renderModelList(list, groups, search.value, renderStore, renderAll, hover, menu);
					this.renderOptionsColumn(optionsColumn, renderStore, renderAll);
					scroll.scanDomNode();
					this.contextViewService.layout();
				};
				renderAll();
				store.add(this.runtime.onDidChangeCatalog(() => {
					this.syncCatalog();
					this.updateModelButton();
					renderAll();
				}));

				store.add(addDisposableListener(autoToggle, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.modelAuto = !this.modelAuto;
					this.updateModelButton();
					renderAll();
				}));

				store.add(addDisposableListener(search, 'input', () => renderAll()));
				this.bindDropdownDismiss(store, menu, this.modelButton);
				store.add(toDisposable(() => menu.remove()));
				scheduleAtNextAnimationFrame(getWindow(search), () => {
					scroll.scanDomNode();
					search.focus();
				});
				return store;
			}
		});
	}

	private renderProviderRail(rail: HTMLElement, groups: IProviderGroup[], store: DisposableStore, refresh: () => void): void {
		rail.replaceChildren();
		if (!groups.length && this.runtime.isCatalogLoading()) {
			for (let i = 0; i < 4; i++) {
				append(rail, $('.volt-agent-provider-tab.skeleton'));
			}
		}
		for (const group of groups) {
			const tab = append(rail, $('button.volt-agent-provider-tab')) as HTMLButtonElement;
			tab.classList.toggle('active', group.family === this.pickerProviderId);
			tab.title = group.label;
			tab.setAttribute('aria-label', group.label);
			tab.appendChild(createBrandIcon(group.family, 18));
			store.add(addDisposableListener(tab, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.pickerProviderId = group.family;
				this.pickerOptionsRef = undefined;
				refresh();
			}));
		}
		const settings = append(rail, $('button.volt-agent-provider-tab.settings')) as HTMLButtonElement;
		settings.title = localize('voltAgent.openSettings', "Open Volt Settings");
		settings.appendChild(renderIcon(Codicon.settingsGear));
		store.add(addDisposableListener(settings, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.contextViewService.hideContextView();
			void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
		}));
	}

	private renderModelList(list: HTMLElement, groups: IProviderGroup[], query: string, store: DisposableStore, refresh: () => void, hover?: HTMLElement, menu?: HTMLElement): void {
		hover?.classList.add('hidden');
		list.replaceChildren();
		if (!groups.length) {
			if (this.runtime.isCatalogLoading()) {
				this.renderModelSkeleton(list);
				return;
			}
			const empty = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
			append(empty, $('span.name')).textContent = localize('voltAgent.openSettings', "Open Volt Settings");
			store.add(addDisposableListener(empty, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.contextViewService.hideContextView();
				void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
			}));
			return;
		}

		const needle = query.trim().toLowerCase();
		// A search spans every provider, otherwise the list is scoped to the selected rail tab.
		const models = needle
			? groups.flatMap(group => group.models).filter(model => this.modelTitle(model).toLowerCase().includes(needle))
			: groups.find(group => group.family === this.pickerProviderId)?.models ?? [];

		if (!models.length) {
			append(list, $('.volt-agent-picker-empty')).textContent = localize('voltAgent.noModels', "No models match.");
			return;
		}

		for (const model of models) {
			const item = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
			item.classList.toggle('active', model.ref === this.currentModel);
			const name = append(item, $('span.name'));
			append(name, $('span.label')).textContent = this.modelTitle(model);
			const meta = append(item, $('span.meta'));
			if (model.ref === this.currentModel) {
				append(meta, $('span.check')).appendChild(renderIcon(Codicon.check));
			}
			if (model.optionDescriptors.length) {
				const edit = append(meta, $('span.volt-agent-picker-edit'));
				edit.appendChild(renderIcon(Codicon.settingsGear));
				edit.title = localize('voltAgent.modelOptions', "Model options");
				store.add(addDisposableListener(edit, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.pickerOptionsRef = this.pickerOptionsRef === model.ref ? undefined : model.ref;
					refresh();
				}));
			}
			store.add(addDisposableListener(item, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.currentModel = model.ref;
				this.modelAuto = false;
				void this.runtime.setActiveCatalogRef(model.ref);
				this.pickerProviderId = model.family;
				this.updateModelButton();
				if (model.optionDescriptors.length) {
					this.pickerOptionsRef = model.ref;
					refresh();
				} else {
					this.contextViewService.hideContextView();
				}
			}));
			if (hover && menu) {
				this.bindModelHover(item, model, hover, menu, store);
			}
		}
	}

	private bindModelHover(item: HTMLElement, model: IModelOption, hover: HTMLElement, menu: HTMLElement, store: DisposableStore): void {
		const win = getWindow(item);
		let timer: number | undefined;
		const hide = () => {
			if (timer !== undefined) {
				win.clearTimeout(timer);
				timer = undefined;
			}
			hover.classList.add('hidden');
		};
		store.add(addDisposableListener(item, 'mouseenter', () => {
			if (timer !== undefined) {
				win.clearTimeout(timer);
			}
			timer = win.setTimeout(() => {
				timer = undefined;
				if (!this.fillModelHover(hover, model)) {
					hover.classList.add('hidden');
					return;
				}
				hover.classList.remove('hidden');
				this.positionModelHover(hover, item, menu);
			}, 220);
		}));
		store.add(addDisposableListener(item, 'mouseleave', hide));
		store.add(toDisposable(hide));
	}

	private fillModelHover(hover: HTMLElement, model: IModelOption): boolean {
		hover.replaceChildren();
		const description = model.description?.trim();
		const context = this.modelContextLabel(model);
		const version = this.modelVersionLabel(model);
		if (!description && !context && !version) {
			return false;
		}
		append(hover, $('div.title')).textContent = model.name;
		if (description) {
			append(hover, $('div.desc')).textContent = description;
		}
		if (context) {
			append(hover, $('div.context')).textContent = localize('voltAgent.contextWindow', "{0} context window", context);
		}
		if (version) {
			const line = append(hover, $('div.version'));
			line.append(localize('voltAgent.modelVersion', "Version: "));
			append(line, $('em')).textContent = version;
		}
		return true;
	}

	private modelContextLabel(model: IModelOption): string | undefined {
		const context = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT);
		if (context) {
			const value = optionValue(context, this.runtime.getModelOptions(model.ref));
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
		}
		return model.contextLabel ?? (model.contextWindow ? formatTokens(model.contextWindow) : undefined);
	}

	private modelVersionLabel(model: IModelOption): string | undefined {
		const reasoning = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
		if (reasoning) {
			const value = optionValue(reasoning, this.runtime.getModelOptions(model.ref));
			const choice = reasoning.options?.find(option => option.value === value);
			if (choice) {
				const effort = choice.label.toLowerCase();
				return effort.includes('effort') ? effort : localize('voltAgent.effortVersion', "{0} effort", effort);
			}
		}
		return model.detail?.trim() || undefined;
	}

	private positionModelHover(hover: HTMLElement, item: HTMLElement, menu: HTMLElement): void {
		const itemRect = item.getBoundingClientRect();
		const menuRect = menu.getBoundingClientRect();
		const gap = 8;
		const width = hover.offsetWidth;
		const height = hover.offsetHeight;
		const viewport = getWindow(item);
		let left = menuRect.right + gap;
		if (left + width > viewport.innerWidth - gap) {
			left = Math.max(gap, menuRect.left - width - gap);
		}
		let top = itemRect.top;
		if (top + height > viewport.innerHeight - gap) {
			top = Math.max(gap, viewport.innerHeight - height - gap);
		}
		hover.style.left = `${left}px`;
		hover.style.top = `${top}px`;
	}

	private renderModelSkeleton(list: HTMLElement): void {
		const skeleton = append(list, $('.volt-agent-picker-skeleton'));
		for (let i = 0; i < 8; i++) {
			const row = append(skeleton, $('.volt-agent-skeleton-row'));
			append(row, $('span.volt-agent-skeleton-bar'));
		}
	}

	/**
	 * Renders whatever options the provider declared for this model. Toggles share a single
	 * "Options" heading and each list of choices becomes its own titled group.
	 */
	private renderOptionsColumn(column: HTMLElement, store: DisposableStore, refresh: () => void): void {
		const model = this.catalog.find(option => option.ref === this.pickerOptionsRef);
		const open = !!model?.optionDescriptors.length;
		column.closest('.volt-agent-dropdown.picker')?.classList.toggle('has-options', open);
		column.classList.toggle('hidden', !open);
		if (!open || !model) {
			return;
		}
		column.replaceChildren();

		const options = this.runtime.getModelOptions(model.ref);
		const update = (id: string, value: string | boolean) => {
			void this.runtime.setModelOptions(model.ref, { ...options, [id]: value });
			this.updateModelButton();
			refresh();
		};

		const selects = model.optionDescriptors.filter(descriptor => descriptor.type === 'select' && descriptor.options?.length);
		const toggles = model.optionDescriptors.filter(descriptor => descriptor.type === 'boolean');

		for (const descriptor of selects) {
			append(column, $('.volt-agent-picker-group')).textContent = descriptor.label;
			const active = optionValue(descriptor, options);
			for (const choice of descriptor.options ?? []) {
				this.optionChoice(column, choice.label, choice.value === active, store, () => update(descriptor.id, choice.value));
			}
		}

		if (toggles.length) {
			if (selects.length) {
				append(column, $('.volt-agent-picker-divider'));
			}
			append(column, $('.volt-agent-picker-group')).textContent = localize('voltAgent.options', "Options");
			for (const descriptor of toggles) {
				const checked = optionValue(descriptor, options) === true;
				this.optionSwitch(column, descriptor.label, checked, store, value => update(descriptor.id, value));
			}
		}
	}

	private optionSwitch(parent: HTMLElement, label: string, checked: boolean, store: DisposableStore, onChange: (value: boolean) => void): void {
		const row = append(parent, $('.volt-agent-picker-row'));
		append(row, $('span.label')).textContent = label;
		const toggle = append(row, $('button.volt-agent-switch')) as HTMLButtonElement;
		toggle.classList.toggle('on', checked);
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(checked));
		append(toggle, $('span.volt-agent-switch-thumb'));
		store.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			onChange(!checked);
		}));
	}

	private optionChoice(parent: HTMLElement, label: string, checked: boolean, store: DisposableStore, onSelect: () => void): void {
		const row = append(parent, $('button.volt-agent-picker-row.choice')) as HTMLButtonElement;
		row.classList.toggle('active', checked);
		append(row, $('span.label')).textContent = label;
		if (checked) {
			append(row, $('span.check')).appendChild(renderIcon(Codicon.check));
		}
		store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			onSelect();
		}));
	}

	private setSearchableText(parent: HTMLElement, text: string): void {
		const span = append(parent, $('span.volt-agent-searchable'));
		span.textContent = text;
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
			onDOMEvent: (e: Event) => {
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
			this.renderContextRing();
			return;
		}
		for (const [index, message] of this.messages.entries()) {
			const turn = append(this.threadInner, $(`.volt-agent-turn.${message.kind}`));

			if (message.kind === 'user') {
				const bubble = append(turn, $('.volt-agent-bubble'));
				const text = append(bubble, $('.volt-agent-text'));
				this.setSearchableText(text, message.text);
				if (message.chips?.length) {
					const chips = append(bubble, $('.volt-agent-chips'));
					for (const chip of message.chips) {
						const el = append(chips, $('.volt-agent-chip'));
						this.setSearchableText(el, chip);
					}
				}
				const next = this.messages[index + 1];
				if (next?.kind === 'agent') {
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
		this.syncThreadScroll(scrollToEnd);
		scheduleAtNextAnimationFrame(getWindow(this.threadInner), () => this.syncThreadScroll(scrollToEnd));
		if (this.findWidget?.isVisible()) {
			this.applyFindHighlights(false);
		}
		this.renderContextRing();
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
		const toggle = append(section, $('button.volt-agent-activity-toggle')) as HTMLButtonElement;
		toggle.classList.toggle('expanded', activity.expanded);
		const label = append(toggle, $('span.volt-agent-activity-label'));
		if (activity.streaming) {
			label.classList.add('shimmer');
			activity.shimmerStartedAt ??= Date.now();
			const elapsed = (Date.now() - activity.shimmerStartedAt) % 2000;
			label.style.animationDelay = `${-elapsed}ms`;
		}
		this.setSearchableText(label, activity.status);
		const chevron = append(toggle, $('span.volt-agent-activity-chevron'));
		chevron.appendChild(renderIcon(activity.expanded ? Codicon.chevronDown : Codicon.chevronRight));
		this.threadListeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
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
		if (message.tokensIn !== undefined) {
			line.dataset.tokensIn = String(message.tokensIn);
		}
		if (message.tokensOut !== undefined) {
			line.dataset.tokensOut = String(message.tokensOut);
		}
		const estimatedOut = message.tokensIn === undefined && message.tokensOut === undefined
			? estimateMessageTokens(message)
			: 0;
		if (estimatedOut > 0) {
			line.dataset.tokensEst = String(estimatedOut);
		}
		this.setSearchableText(line, formatWorkedLine(ended - message.startedAt, message.tokensIn, message.tokensOut, estimatedOut));
		this.ensureClock();
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
		forkButton.title = localize('voltAgent.fork', "Fork");
		forkButton.appendChild(renderIcon(Codicon.repoForked));
		this.threadListeners.add(addDisposableListener(forkButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(NEW_AGENT_COMMAND_ID, { asTab: true });
		}));

		const copyButton = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		copyButton.title = localize('voltAgent.copy', "Copy");
		copyButton.appendChild(renderIcon(Codicon.copy));
		this.threadListeners.add(addDisposableListener(copyButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.clipboardService.writeText(agentMessagePlainText(message)).then(() => {
				copyButton.replaceChildren(renderIcon(Codicon.check));
				copyButton.title = localize('voltAgent.copied', "Copied");
				copyButton.classList.add('copied');
				this.threadListeners.add(disposableTimeout(() => {
					if (!copyButton.isConnected) {
						return;
					}
					copyButton.replaceChildren(renderIcon(Codicon.copy));
					copyButton.title = localize('voltAgent.copy', "Copy");
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
			const tokensIn = el.dataset.tokensIn !== undefined ? Number(el.dataset.tokensIn) : undefined;
			const tokensOut = el.dataset.tokensOut !== undefined ? Number(el.dataset.tokensOut) : undefined;
			const estimatedOut = el.dataset.tokensEst !== undefined ? Number(el.dataset.tokensEst) : undefined;
			const text = el.querySelector('.volt-agent-searchable') ?? el;
			text.textContent = formatWorkedLine(ended - started, tokensIn, tokensOut, estimatedOut);
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
		this.mentionController.bindDropTarget(this.container);
		this.mentionController.bindDropTarget(this.inputBox);

		this.editorDisposables.add(this.inputEditor.onDidFocusEditorText(() => this.inputBox.classList.add('focused')));
		this.editorDisposables.add(this.inputEditor.onDidBlurEditorText(() => this.inputBox.classList.remove('focused')));
		this.editorDisposables.add(this.inputEditor.onDidChangeModelContent(() => {
			this.layoutInputEditor();
			this.updateInputPlaceholder();
			this.syncUnsavedState();
			this.renderContextRing();
		}));
		this.editorDisposables.add(this.inputEditor.onDidContentSizeChange(e => {
			if (e.contentHeightChanged) {
				this.layoutInputEditor();
			}
		}));
		this.editorDisposables.add(this.inputEditor.onKeyDown(e => {
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
				this.cycleMode(e.shiftKey ? -1 : 1);
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
		const value = this.inputModel?.getValue().trim() ?? '';
		if (!value || this.isStreaming()) {
			return;
		}

		this.thinkingStore.clear();
		this.messages.push({ kind: 'user', text: value });
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
		this.clearComposer();
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
		});
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
				activity.status = event.reason === 'abort'
					? localize('voltAgent.cancelled', "Cancelled")
					: localize('voltAgent.thoughtBriefly', "Thought briefly");
				last.endedAt = Date.now();
				last.startedAt ??= last.endedAt;
				last.durationMs = Math.max(0, last.endedAt - last.startedAt);
				break;
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

	private doLayoutInputEditor(): void {
		if (!this.inputEditor) {
			return;
		}
		const styles = getWindow(this.monacoHost).getComputedStyle(this.monacoHost);
		const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
		const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
		const width = Math.max(this.monacoHost.clientWidth - padX, 0);
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
			this.monacoHost.style.height = '';
			const height = Math.max(this.monacoHost.clientHeight - padY, 48);
			this.inputEditor.layout({ width, height });
			return;
		}
		this.inputEditor.layout({ width, height: 0 });
		const contentHeight = Math.min(Math.max(this.inputEditor.getContentHeight(), 20), 180);
		this.monacoHost.style.height = `${contentHeight + padY}px`;
		this.inputEditor.layout({ width, height: contentHeight });
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
