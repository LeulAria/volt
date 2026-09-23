/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentEditor.css';
import { $, addDisposableListener, append, Dimension, DragAndDropObserver, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, isAbsolute } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { escapeRegExpCharacters } from '../../../../../base/common/strings.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { getCodeEditor, ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DropIntoEditorController } from '../../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { EDITOR_FONT_DEFAULTS, IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { deepClone } from '../../../../../base/common/objects.js';
import { isObject } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorOptions, ITextEditorOptions, TextEditorSelectionRevealType, TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ACCESS_MODE_OPTIONS, accessModeOption } from '../../../../services/voltRuntime/common/access/accessModes.js';
import { alwaysAllowPattern } from '../../../../services/voltRuntime/common/access/wildcard.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { runStatusLine } from '../../../../services/voltRuntime/common/harness/workLog.js';
import { normalizeVoltMode, VoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { AgentSessionStatus } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { createAccessIcon } from '../chrome/accessIcons.js';
import { agentMessagePlainText, IContextUsageInput, resolveModelContextWindow } from '../context/agentContextUsage.js';
import { AgentContextUsageView } from '../context/agentContextUsageView.js';
import { AgentModelPicker, type IModelOption } from '../picker/agentModelPicker.js';
import { providerFamilyLabel } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { Orientation, Sash } from '../../../../../base/browser/ui/sash/sash.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { GroupsOrder, IEditorGroupsService, IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { searchFilesAndFolders } from '../../../search/browser/searchChatContext.js';
import { AGENT_EDITOR_LINE_NUMBERS_SETTING, AgentEditorInput, NEW_AGENT_COMMAND_ID, OPEN_AGENT_SIDE_PANEL_COMMAND_ID } from './agentEditorInput.js';
import { createAgentTitleActionViewItem } from './agentTitleActions.js';
import { IAction } from '../../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getSimpleCodeEditorWidgetOptions } from '../../../codeEditor/browser/simpleEditorOptions.js';
import { OPEN_BROWSER_COMMAND_ID } from '../preview/browserEditorInput.js';
import { extractToolImage } from '../preview/browserSnapshot.js';
import { extractHttpUrl, extractLocalPreviewUrl, sanitizeBrowserUrl } from '../preview/localPreview.js';
import { openAgentChanges } from '../review/agentChangesEditor.js';
import { AgentComposerChips } from '../composer/agentComposerChips.js';
import { AgentComposerLists } from '../composer/agentComposerLists.js';
import { AgentComposerQueue } from '../composer/agentComposerQueue.js';
import { AgentLandingChrome } from '../home/agentLandingChrome.js';
import { IAgentSessionChangesService } from '../review/agentSessionChangesService.js';
import { AgentFindWidget, CONTEXT_IN_AGENT_INPUT, IAgentFindHost } from './agentFindWidget.js';
import { AgentThreadView } from './agentThreadView.js';
import { AgentTooltip, formatAgentTooltipShortcut, setAgentTooltip } from '../chrome/agentTooltip.js';
import { createModeIcon, ModeIconId } from '../chrome/agentModeIcons.js';
import { AgentMentionController, IAgentDisplayMention, browserMentionColor, cloneDisplayMentions, mentionIconClasses } from '../composer/agentMentions.js';
import { MentionCodePreview } from '../composer/mentionCodePreview.js';
import { appendAgentScrollableList } from './agentScrollable.js';
import { dayjs } from '../chrome/dayjs.js';
import { createTableCopyIcon, flashCopyIconSuccess, renderAgentBlock, renderFileChangesPart, renderMarkdownInto, IBlockRenderContext } from '../blocks/agentBlockRenderers.js';
import { AgentSegment, IAgentActivityItem, IFileChangeBlock, ITerminalBlock, IToolBlock, appendTextDelta, appendThoughtDelta, applyExploreInputToActivity, applyExploreResultToActivity, classifyToolActivity, createApprovalBlock, createFileChangeBlock, createTerminalBlock, createToolBlock, describeExploreActivity, findBlockByCallId, findFileBlockByPath, firstCommandName, isExploreItemClickable, isExploreTool, isFileChangeTool, isShellTool, looksLikeShell, parseFileTarget, parseShellToolInput, stringifyToolResult, workCountsForSegments } from '../blocks/agentBlocks.js';
import { mergeToolInput } from '../../../../services/voltRuntime/common/acpToolInput.js';
import { buildThreadParts, STATUS_ROTATE_MS, STATUS_SWAP_MS, streamingActivityLines, ThreadPart, visibleReplyParts } from '../chrome/agentTimeline.js';
import { chooseFileChangeDiffStyle, fileChangeVerb, parseToolFileChange } from '../review/fileChangePreviewModel.js';

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
	const el = $('span.volt-agent-svg-icon.send');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'm19.03 9.47l-6.145-6.145a1.26 1.26 0 0 0-1.77 0L4.97 9.47l1.06 1.06l5.22-5.22V21h1.5V5.31l5.22 5.22z');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.3');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function isUnmodifiedEnter(e: IKeyboardEvent): boolean {
	return e.keyCode === KeyCode.Enter && !e.altKey && !e.metaKey && !e.ctrlKey;
}

/** Max monaco content height while editing a prior prompt. Extra lines scroll. */
const USER_EDIT_MAX_HEIGHT = 132;

function createPlusIcon(): HTMLElement {
	return createSvgIcon('0 0 14 14', 'M7 2.5v9M2.5 7h9', 'plus', true, '1');
}

function createOpenNewAgentIcon(): HTMLElement {
	return createStrokeIcon('open-new', [
		'M15 3h6v6',
		'M14 10l7-7',
		'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
	]);
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

function createCopyIcon(): HTMLElement {
	return createSvgIcon(
		'1.25 1.25 13.5 13.5',
		'm11.25 4.25v-2.5h-9.5v9.5h2.5m.5-6.5v9.5h9.5v-9.5z',
		'copy',
		true,
		'1',
	);
}

function createForkIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.fork');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of [
		'M16 3h5v5',
		'M8 3h-5v5',
		'M21 3l-7.536 7.536a5 5 0 0 0 -1.464 3.534v6.93',
		'M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93',
	]) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	el.appendChild(svg);
	return el;
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

export interface IAgentUserMessage {
	kind: 'user';
	/** Turn id shared with the reply; also the key in durable history. */
	id?: string;
	text: string;
	agentText?: string;
	chips?: string[];
	mentions?: IAgentDisplayMention[];
	promptExpanded?: boolean;
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

interface IAgentActivity {
	status: string;
	expanded: boolean;
	streaming: boolean;
	items: IAgentActivityItem[];
	thinkingText?: string;
	shimmerStartedAt?: number;
}

export interface IAgentAssistantMessage {
	kind: 'agent';
	id?: string;
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

export type IAgentMessage = IAgentUserMessage | IAgentAssistantMessage;

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

function hasVisibleReply(message: IAgentAssistantMessage): boolean {
	if ((message.text ?? '').trim()) {
		return true;
	}
	return (message.segments ?? []).some(segment => segment.kind === 'text' && segment.text.trim());
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
	private openNewButton!: HTMLButtonElement;
	private readonly tooltip = this._register(new AgentTooltip());
	private toolbarStartEl!: HTMLElement;
	private toolbarEndEl!: HTMLElement;
	private zoomButton!: HTMLButtonElement;
	private contextUsageView!: AgentContextUsageView;
	private attachButton!: HTMLButtonElement;
	private sendButton!: HTMLButtonElement;
	private suggestEl!: HTMLElement;
	private composerQueue!: AgentComposerQueue;
	private composerChips!: AgentComposerChips;
	private readonly suggestListeners = this._register(new DisposableStore());
	private sendKind: 'mic' | 'send' = 'mic';
	private submitting = false;
	private promptQueue: { id: string; text: string; display?: IAgentPromptDisplay }[] = [];
	private readonly _onDidChangeQueue = this._register(new Emitter<void>());
	readonly onDidChangeQueue: Event<void> = this._onDidChangeQueue.event;

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
	private sessionTokensUsed: number | undefined;
	private sessionTokensWindow: number | undefined;
	private toolbarLayoutHandle: number | undefined;
	private stickToBottom = true;
	private readonly threadListeners = this._register(new DisposableStore());
	private readonly thinkingStore = this._register(new DisposableStore());
	private readonly exploreHitsTooltip = this._register(new AgentTooltip());
	private readonly markdownRenderer: MarkdownRenderer;
	private mentionPreview: MentionCodePreview | undefined;
	private clockTimer: IDisposable | undefined;
	private statusRotateTimer: IDisposable | undefined;
	private readonly statusMotion = new Map<string, { text: string; from?: string; started?: number }>();
	private editingUserIndex: number | undefined;
	private suppressEditDismiss = false;
	private suppressStartEdit = false;
	private threadScrollFrozen = false;
	private applyingEditPin = false;
	private editAnchorTop: number | undefined;
	private editAnchorScrollTop: number | undefined;
	private threadPinGeneration = 0;
	private editComposerEl: HTMLElement | undefined;
	private editInputBox: HTMLElement | undefined;
	private editMonacoHost: HTMLElement | undefined;
	private editEditor: ICodeEditor | undefined;
	private editModel: ITextModel | undefined;
	private editMentionController: AgentMentionController | undefined;
	private editLists: AgentComposerLists | undefined;
	private editPlusButton: HTMLButtonElement | undefined;
	private editOpenNewButton: HTMLButtonElement | undefined;
	private editModelButton: HTMLButtonElement | undefined;
	private editSendButton: HTMLButtonElement | undefined;
	private readonly editEditorDisposables = this._register(new DisposableStore());
	private skipRunEvents = false;
	private activeRunId: string | undefined;
	private openedPreviewUrl: string | undefined;
	private previewTimer: number | undefined;
	/** Set from the runtime `lane` event. Preview only opens when the user asked to see something running. */
	private runWantsPreview = false;
	private snapshotOverlay: HTMLElement | undefined;
	private readonly snapshotStore = this._register(new DisposableStore());
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
		@ILanguageService private readonly languageService: ILanguageService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@ILogService private readonly logService: ILogService,
		@IAgentSessionChangesService private readonly sessionChanges: IAgentSessionChangesService,
	) {
		super(AgentEditor.ID, group, telemetryService, themeService, storageService);
		this.markdownRenderer = this.instantiationService.createInstance(MarkdownRenderer, {});
		this.mentionPreview = this._register(this.instantiationService.createInstance(MentionCodePreview));
		this.modelPicker = this._register(this.instantiationService.createInstance(AgentModelPicker, {
			onDidChange: () => {
				if (this.modelButton) {
					this.updateModelButton();
					this.contextUsageView?.refresh();
				}
			},
		}));
		this._register(this.runtime.onDidChangeAccess(() => this.updateAccessButton()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-agent-editor'));
		this.container.dataset.mode = normalizeVoltMode(this.currentMode);
		this._register(new DragAndDropObserver(parent, {
			onDragEnter: e => this.blockWorkbenchFileDrop(e),
			onDragOver: e => this.blockWorkbenchFileDrop(e),
			onDrop: e => {
				this.blockWorkbenchFileDrop(e);
				if (this.editingUserIndex !== undefined && isHTMLElement(e.target) && e.target.closest('.volt-agent-edit-slot')) {
					void this.editMentionController?.handleExternalDrop(e);
					return;
				}
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
		this.applyCodeFont();
		this._register(this.threadScroll.onScroll(e => {
			if (!this.threadScrollFrozen && !this.applyingEditPin) {
				this.stickToBottom = e.scrollTop + e.height >= e.scrollHeight - 32;
				if (this.editingUserIndex !== undefined) {
					const editing = this.threadInner.querySelector<HTMLElement>('.volt-agent-turn.user.editing');
					if (editing) {
						this.editAnchorTop = editing.getBoundingClientRect().top;
						this.editAnchorScrollTop = e.scrollTop;
					}
				}
			}
			this.threadView.syncStuckTurns();
		}));
		const threadWindow = getWindow(this.threadInner);
		const threadResizeObserver = new threadWindow.ResizeObserver(() => {
			if (this.threadScrollFrozen) {
				return;
			}
			this.layoutEditEditor();
			this.syncThreadScroll();
		});
		threadResizeObserver.observe(this.threadEl);
		this._register(toDisposable(() => threadResizeObserver.disconnect()));
		this._register(addDisposableListener(getWindow(this.container), 'pointerdown', e => this.onEditPointerDown(e), true));
		this._register(addDisposableListener(this.threadInner, 'click', e => this.onUserMessageClick(e)));
		this._register(addDisposableListener(getWindow(this.container), 'keydown', e => {
			if (e.key === 'Escape' && this.editingUserIndex !== undefined) {
				e.preventDefault();
				this.cancelUserEdit();
			}
		}, true));
		this.composerEl = append(this.container, $('.volt-agent-composer'));
		this.composerChips = this._register(this.instantiationService.createInstance(AgentComposerChips, {
			onChangesClick: () => void this.openSessionChanges(),
		}));
		append(this.composerEl, this.composerChips.element);
		this.composerQueue = this._register(this.instantiationService.createInstance(AgentComposerQueue, {
			onRemove: id => this.removeQueuedPrompt(id),
			onClear: () => this.clearPromptQueue(),
			onMultitask: () => this.setMode('Multitask'),
			onReorder: ids => this.reorderQueuedPrompts(ids),
		}));
		append(this.composerEl, this.composerQueue.element);
		const landingChrome = this._register(this.instantiationService.createInstance(AgentLandingChrome));
		append(this.composerEl, landingChrome.element);
		this.inputBox = append(this.composerEl, $('.volt-agent-input-box'));
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
		this.openNewButton = append(this.toolbarStartEl, $('button.volt-agent-open-new')) as HTMLButtonElement;
		this.openNewButton.type = 'button';
		this.openNewButton.setAttribute('aria-label', localize('voltAgent.openInNewAgent', "Open in new agent"));
		this.openNewButton.appendChild(createOpenNewAgentIcon());
		append(this.openNewButton, $('span.volt-agent-open-new-label')).textContent = localize('voltAgent.openInNewAgentShort', "New agent");
		setAgentTooltip(this.openNewButton, localize('voltAgent.openInNewAgentHint', "Open this prompt in a new agent tab"));
		this._register(this.tooltip.bind(this.modelButton, () => {
			const effort = this.modelPicker.triggerEffort();
			return [
				{ label: localize('voltAgent.selectModel', "Select Model"), shortcut: formatAgentTooltipShortcut({ meta: true, key: '/' }) },
				{
					label: effort
						? localize('voltAgent.cycleEffortCurrent', "Cycle Effort · {0}", effort.full)
						: localize('voltAgent.cycleEffort', "Cycle Effort"),
					shortcut: formatAgentTooltipShortcut({ meta: true, shift: true, key: '/' }),
				},
			];
		}, {
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

		this.attachButton = append(this.toolbarEndEl, $('button.volt-agent-icon-btn.volt-agent-attach-btn')) as HTMLButtonElement;
		setAgentTooltip(this.attachButton, localize('voltAgent.attach', "Add context"));
		this.attachButton.appendChild(renderIcon(Codicon.attach));

		this.sendButton = append(this.toolbarEndEl, $('button.volt-agent-send')) as HTMLButtonElement;
		this.sendButton.type = 'button';
		this.updateSendButton();

		this.contextUsageView = this._register(this.instantiationService.createInstance(AgentContextUsageView, {
			getUsageInput: () => this.contextUsageInput(),
			getPanelAnchor: () => ({ parent: this.composerEl, before: this.inputBox }),
			onWillOpenPanel: () => this.hidePlusMenu(),
		}));
		append(this.composerEl, this.contextUsageView.element);
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
		this._register(addDisposableListener(this.openNewButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.openEditInNewAgent();
		}));
		this._register(addDisposableListener(this.sendButton, 'click', () => {
			this.send();
		}));
		this._register(addDisposableListener(this.zoomButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleComposerZoom();
		}));
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
		return resolveModelContextWindow(model, model ? this.runtime.getModelOptions(model.ref) : undefined);
	}

	private contextUsageInput(): Omit<IContextUsageInput, 'overhead'> {
		const selected = this.selectedModel();
		const catalog = this.runtime.listCatalog().filter(item => item.enabled);
		const nativeAgent = catalog.find(item => item.ref === this.currentModel)?.capabilities.nativeAgent;
		const hasTranscript = this.messages.length > 0;
		return {
			messages: this.messages,
			draft: this.inputModel?.getValue() ?? '',
			reportedUsed: hasTranscript ? this.sessionTokensUsed : undefined,
			reportedLimit: hasTranscript ? this.sessionTokensWindow : undefined,
			modelWindow: this.modelContextWindow(selected),
			modelName: selected?.name,
			nativeAgent,
			models: this.catalog.map(model => ({
				ref: model.ref,
				name: model.name,
				family: model.family,
				provider: providerFamilyLabel(model.providerId),
				window: this.modelContextWindow(model),
				active: model.ref === this.currentModel,
			})),
		};
	}

	private refreshContextUsage(): void {
		this.contextUsageView?.refresh();
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
		toolbar.classList.remove('compact-mode', 'compact-model', 'compact-model-truncate', 'compact-model-icon', 'compact-access', 'compact-open-new', 'hide-zoom', 'hide-attach', 'toolbar-wrap');
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

		if (this.openNewButton && getWindow(this.openNewButton).getComputedStyle(this.openNewButton).display !== 'none') {
			const openNatural = this.openNewButton.offsetWidth;
			toolbar.classList.add('compact-open-new');
			deficit -= Math.max(0, openNatural - this.openNewButton.offsetWidth);
			if (deficit <= 0) {
				return;
			}
		}

		deficit -= this.zoomButton.offsetWidth + gap;
		toolbar.classList.add('hide-zoom');
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
		const font = this.codeFontFamily();
		this.container?.style.setProperty('--volt-code-font', font);
		this.threadEl?.style.setProperty('--volt-code-font', font);
		this.threadInner?.style.setProperty('--volt-code-font', font);
	}

	private getWorkbenchEditorOptions(): ICodeEditorOptions {
		const value = this.textResourceConfigurationService.getValue<ICodeEditorOptions>(this.inputModel?.uri, 'editor');
		return isObject(value) ? deepClone(value) : Object.create(null);
	}

	private getAgentInputEditorOptions(forEdit = false): ICodeEditorOptions {
		const editorConfiguration = this.getWorkbenchEditorOptions();
		const expanded = !forEdit && (this.composerZoomed || this.composerHeight !== undefined);
		const showLineNumbers = this.showAgentLineNumbers();
		if (forEdit) {
			this.editMonacoHost?.classList.toggle('has-line-numbers', showLineNumbers);
		} else {
			this.monacoHost?.classList.toggle('has-line-numbers', showLineNumbers);
		}
		return {
			...editorConfiguration,
			fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif',
			fontSize: 14,
			fontWeight: '300',
			lineHeight: 22,
			wordWrap: 'on',
			wordWrapOverride2: 'on',
			wrappingStrategy: 'advanced',
			wrappingIndent: 'none',
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
			acceptSuggestionOnEnter: 'off',
			quickSuggestions: { other: 'off', comments: 'off', strings: 'off' },
			suggestOnTriggerCharacters: false,
			ariaLabel: forEdit
				? localize('voltAgent.editAria', "Edit message")
				: localize('voltAgent.inputAria', "Agent input"),
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
		this.editEditor?.updateOptions(this.getAgentInputEditorOptions(true));
	}

	private persistInputState(): void {
		const input = this.input;
		if (!(input instanceof AgentEditorInput)) {
			return;
		}
		input.messages = this.messages;
		input.contextUsed = this.messages.length ? this.sessionTokensUsed : undefined;
		input.contextWindow = this.messages.length ? this.sessionTokensWindow : undefined;
		if (this.inputModel) {
			input.draft = this.inputModel.getValue();
			input.draftMentions = this.mentionController?.displayMentions() ?? [];
			input.setHasUnsavedContent(!!input.draft.trim());
		}
		input.composerZoomed = this.composerZoomed;
		input.composerHeight = this.composerHeight;
		input.promptQueue = this.promptQueue;
		input.queueExpanded = this.promptQueue.length > 0;
		input.scheduleDraftSave();
	}

	private restoreInputState(input: AgentEditorInput): void {
		this.clearFindHighlights();
		this.thinkingStore.clear();
		this.messages = input.messages;
		this.sessionTokensUsed = input.contextUsed;
		this.sessionTokensWindow = input.contextWindow;
		this.editingUserIndex = undefined;
		this.clearEditComposer();
		this.stickToBottom = true;
		if (input.restoredMode && input.restoredMode !== this.currentMode) {
			const option = MODE_OPTIONS.find(item => item.id.toLowerCase() === input.restoredMode!.toLowerCase());
			if (option) {
				this.currentMode = option.id;
				this.updateModeButton();
			}
		}
		this.syncComposerPlacement();
		this.renderThread(true);
		if (this.inputModel && this.inputModel.getValue() !== input.draft) {
			this.inputModel.setValue(input.draft);
		}
		this.mentionController?.restoreMentions(input.draftMentions);
		this.setComposerZoomed(input.composerZoomed);
		if (!input.composerZoomed) {
			this.applyComposerHeight(input.composerHeight);
		}
		this.promptQueue = Array.isArray(input.promptQueue) ? input.promptQueue.slice() as typeof this.promptQueue : [];
		this.syncQueueStack();
		this.updateSendButton();
		input.setHasUnsavedContent(!!input.draft.trim());
		this.updateInputPlaceholder();
		this.refreshContextUsage();
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
		input.draftMentions = this.mentionController?.displayMentions() ?? [];
		input.setHasUnsavedContent(!!draft.trim());
		input.scheduleDraftSave();
	}

	private updateModelButton(): void {
		this.renderModelButton(this.modelButton, true);
		if (this.editModelButton) {
			this.renderModelButton(this.editModelButton, false);
		}
		this.refreshContextUsage();
	}

	private renderModelButton(button: HTMLButtonElement, animate: boolean): void {
		const fromWidth = animate ? button.offsetWidth : 0;
		button.replaceChildren();
		this.modelPicker.renderTrigger(button);
		button.appendChild(createChevronIcon());
		if (animate) {
			this.animateChipWidth(button, fromWidth);
		}
	}

	private showModelDropdown(anchor?: HTMLButtonElement): void {
		this.tooltip.hide();
		const target = anchor ?? this.modelButton;
		const focus = target === this.editModelButton
			? () => this.editEditor?.focus()
			: () => this.inputEditor?.focus();
		this.modelPicker.show(target, focus);
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
		this.composerQueue?.setMode(id);
		if (this.input instanceof AgentEditorInput) {
			this.input.recordMode(normalizeVoltMode(id));
		}
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

	private showPlusMenu(source: 'main' | 'edit' = 'main'): void {
		if (this.plusMenuOpen) {
			this.hidePlusMenu();
			return;
		}
		this.tooltip.hide();
		this.contextUsageView?.hidePanel();
		this.plusMenuStore.clear();
		this.plusMenuEl?.remove();
		this.plusMenuOpen = true;
		const menu = $('.volt-agent-plus-menu');
		this.plusMenuEl = menu;
		if (source === 'edit' && this.editComposerEl && this.editInputBox) {
			this.editComposerEl.insertBefore(menu, this.editInputBox);
		} else {
			this.composerEl.insertBefore(menu, this.inputBox);
		}
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
				item.appendChild(createModeIcon(option.icon));
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
				item.appendChild(action.id === 'files'
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
						if (source === 'edit') {
							this.ensureEditComposer();
							this.editMentionController?.openFilePicker();
							this.editEditor?.focus();
						} else {
							this.ensureInputEditor();
							this.mentionController?.openFilePicker();
							this.inputEditor?.focus();
						}
						return;
					}
					if (action.id === 'model') {
						const anchor = source === 'edit' && this.editModelButton ? this.editModelButton : this.plusButton;
						scheduleAtNextAnimationFrame(getWindow(anchor), () => this.showModelDropdown(source === 'edit' ? this.editModelButton : this.modelButton));
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
			if (menu.contains(e.target) || this.plusButton.contains(e.target) || this.modeButton.contains(e.target) || this.editPlusButton?.contains(e.target)) {
				return;
			}
			this.hidePlusMenu();
		}, true));
		this.plusMenuStore.add(addDisposableListener(getWindow(menu), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hidePlusMenu();
				if (source === 'edit') {
					this.editEditor?.focus();
				} else {
					this.inputEditor?.focus();
				}
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
		this.suggestEl.classList.toggle('hidden', this.isFollowUpComposer());
		if (this.isFollowUpComposer()) {
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
			const classes = ['volt-agent-inline-mention', 'show-file-icons', mention.kind];
			if (mention.kind === 'browser') {
				classes.push(`c${mention.accent ?? 0}`);
			}
			const chip = append(parent, $(`.${classes.join('.')}`));
			if (mention.kind === 'browser') {
				chip.style.setProperty('--volt-mention-accent', browserMentionColor(mention.accent));
			}
			const icon = append(chip, $('span.volt-agent-mention-icon'));
			icon.classList.add(mention.kind);
			const iconClasses = mentionIconClasses(mention, this.modelService, this.languageService);
			if (iconClasses.length) {
				icon.classList.add(...iconClasses);
			}
			if (mention.kind === 'browser') {
				icon.classList.add(`c${mention.accent ?? 0}`);
			}
			const pill = append(chip, $('span.volt-agent-mention-pill'));
			pill.classList.add(mention.kind);
			if (mention.kind === 'browser') {
				pill.classList.add(`c${mention.accent ?? 0}`);
			}
			this.setSearchableText(pill, mention.label);
			if (mention.resource && mention.range) {
				chip.setAttribute('data-preview', 'true');
				const comment = mentions.reduce((value, item) => value.split(item.label).join(''), text).replace(/\s+/g, ' ').trim();
				this.threadListeners.add(addDisposableListener(chip, 'mouseenter', () => {
					this.mentionPreview?.scheduleShow({ ...mention, comment }, { element: chip });
				}));
				this.threadListeners.add(addDisposableListener(chip, 'mouseleave', () => {
					this.mentionPreview?.scheduleHide();
				}));
				this.threadListeners.add(addDisposableListener(chip, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.mentionPreview?.reveal(mention);
				}));
			}
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
			instantiationService: this.instantiationService,
			diffStyle: chooseFileChangeDiffStyle({
				surface: this.container.classList.contains('browser-hosted') ? 'browser' : 'sidebar',
			}),
			onOpenPath: (path, startLine, endLine) => void this.openWorkspaceFile(path, startLine, endLine),
			onOpenUrl: url => void this.openLocalPreview(url, true),
			onTerminalMenu: (anchor, command) => this.showTerminalBlockMenu(anchor, command),
			onTableCopyMenu: (anchor, plain, markdown) => this.showTableCopyMenu(anchor, plain, markdown),
			onCopyText: text => void this.clipboardService.writeText(text),
			onAccessDecision: (requestId, effect, scope, pattern) => this.runtime.respondToAccessRequest(requestId, effect, scope, pattern),
			streaming: !!message.activity?.streaming,
		};
	}

	private flashTableCopyButton(anchor: HTMLElement): void {
		const slot = anchor.querySelector('.volt-agent-table-copy-icon');
		if (!slot) {
			return;
		}
		flashCopyIconSuccess(slot, getWindow(anchor), () => createTableCopyIcon(10, 12, 'copy-table'));
	}

	private showTableCopyMenu(anchor: HTMLElement, plain: string, markdown: string): void {
		if (anchor.classList.contains('open')) {
			this.contextViewService.hideContextView();
			return;
		}
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorAlignment: AnchorAlignment.RIGHT,
			anchorPosition: AnchorPosition.ABOVE,
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
				const menu = append(container, $('.volt-agent-dropdown.table-copy-menu'));
				const copyText = append(menu, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
				append(copyText, $('span.icon')).appendChild(createTableCopyIcon(10, 12, 'copy-table-menu'));
				append(copyText, $('span.label')).textContent = localize('voltAgent.tableCopyAsText', "Copy as text");
				copyText.disabled = !plain;
				store.add(addDisposableListener(copyText, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					if (plain) {
						void this.clipboardService.writeText(plain);
					}
					this.contextViewService.hideContextView();
					if (plain) {
						scheduleAtNextAnimationFrame(getWindow(anchor), () => this.flashTableCopyButton(anchor));
					}
				}));
				const copyMarkdown = append(menu, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
				append(copyMarkdown, $('span.icon')).appendChild(createTableCopyIcon(10, 12, 'copy-table-menu'));
				append(copyMarkdown, $('span.label')).textContent = localize('voltAgent.tableCopyAsMarkdown', "Copy as markdown");
				copyMarkdown.disabled = !markdown;
				store.add(addDisposableListener(copyMarkdown, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					if (markdown) {
						void this.clipboardService.writeText(markdown);
					}
					this.contextViewService.hideContextView();
					if (markdown) {
						scheduleAtNextAnimationFrame(getWindow(anchor), () => this.flashTableCopyButton(anchor));
					}
				}));
				this.bindDropdownDismiss(store, menu, anchor);
				store.add(toDisposable(() => menu.remove()));
				return store;
			}
		});
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
			this.clearEditComposer();
			this.sessionTokensUsed = undefined;
			this.sessionTokensWindow = undefined;
			this.syncComposerPlacement();
			this.refreshContextUsage();
			this.updateInputPlaceholder();
			this.layoutInputEditor();
			this.publishSessionChanges();
			this._onDidChangeDock.fire();
			return;
		}
		let exchange: HTMLElement | undefined;
		for (const [index, message] of this.messages.entries()) {
			if (message.kind === 'user' || !exchange) {
				exchange = append(this.threadInner, $('.volt-agent-exchange'));
			}
			const turn = append(exchange, $(`.volt-agent-turn.${message.kind}`));

			if (message.kind === 'user') {
				if (this.editingUserIndex === index) {
					turn.classList.add('editing');
					append(turn, $('.volt-agent-edit-slot'));
				} else {
					this.renderUserTurn(turn, message, index);
				}
				const next = this.messages[index + 1];
				if (next?.kind === 'agent' && this.editingUserIndex !== index) {
					this.renderWorkedMeta(exchange, next);
				}
			} else {
				this.renderAgentTurn(turn, message);
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
		this.refreshContextUsage();
		this.updateInputPlaceholder();
		this.layoutInputEditor();
		this.publishSessionChanges();
	}

	private publishSessionChanges(): void {
		this.sessionChanges.setSessionTranscript(this.sessionKey, this.messages);
	}

	openSessionChanges(): Promise<void> {
		return openAgentChanges(this.instantiationService, this.editorService, this.editorGroupsService, this.sessionKey);
	}

	get sessionId(): string {
		return this.sessionKey;
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
		if (/\n/.test(message.text) || !!message.chips?.length) {
			bubble.classList.add('multiline');
		}
		if (message.promptExpanded) {
			bubble.classList.add('prompt-expanded');
		} else if (message.text.split('\n').length > 4 || message.text.length > 160) {
			bubble.classList.add('clamped');
		}
		const clip = append(bubble, $('.volt-agent-user-clip'));
		const main = append(clip, $('.volt-agent-user-main'));
		const text = append(main, $('.volt-agent-text'));
		this.renderUserMessageText(text, message);
		const syncUserPromptClamp = () => {
			if (text.scrollHeight > 28) {
				bubble.classList.add('multiline');
			}
			if (message.promptExpanded) {
				bubble.classList.remove('clamped');
				bubble.classList.add('prompt-expanded');
				return;
			}
			const limit = 22 * 4;
			if (text.scrollHeight > limit + 1) {
				bubble.classList.add('clamped');
				if (!editable) {
					setAgentTooltip(bubble, localize('voltAgent.showFullPrompt', "Show full prompt"));
				}
			} else {
				bubble.classList.remove('clamped');
			}
		};
		this.threadListeners.add(scheduleAtNextAnimationFrame(getWindow(text), syncUserPromptClamp));
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
			stop.type = 'button';
			stop.setAttribute('aria-label', localize('voltAgent.stop', "Stop"));
			setAgentTooltip(stop, localize('voltAgent.stop', "Stop"));
			stop.appendChild(createStopIcon());
			this.threadListeners.add(addDisposableListener(stop, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.stopAgent();
			}));
		}
	}

	private onUserMessageClick(e: MouseEvent): void {
		if (this.suppressStartEdit || this.editingUserIndex !== undefined || !isHTMLElement(e.target)) {
			return;
		}
		if (e.target.closest('.volt-agent-edit-slot') || e.target.closest('.volt-agent-user-stop')) {
			return;
		}
		const turn = e.target.closest('.volt-agent-turn.user');
		if (!turn || !this.threadInner.contains(turn)) {
			return;
		}
		const index = this.indexOfUserTurn(turn);
		if (index === undefined) {
			return;
		}
		const message = this.messages[index];
		if (!message || message.kind !== 'user') {
			return;
		}
		if (!this.canEditUser(index)) {
			const bubble = turn.querySelector('.volt-agent-bubble');
			if (bubble?.classList.contains('clamped')) {
				message.promptExpanded = true;
				bubble.classList.remove('clamped');
				bubble.classList.add('prompt-expanded');
			}
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.startUserEdit(index);
	}

	private indexOfUserTurn(turn: Element): number | undefined {
		const ordinal = Array.from(this.threadInner.querySelectorAll('.volt-agent-turn.user')).indexOf(turn);
		if (ordinal < 0) {
			return undefined;
		}
		let userOrdinal = -1;
		for (const [index, item] of this.messages.entries()) {
			if (item.kind !== 'user') {
				continue;
			}
			userOrdinal++;
			if (userOrdinal === ordinal) {
				return index;
			}
		}
		return undefined;
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
		if (this.suppressStartEdit || this.editingUserIndex === index) {
			return;
		}
		const message = this.messages[index];
		if (!message || message.kind !== 'user') {
			return;
		}
		if (this.editingUserIndex !== undefined) {
			this.cancelUserEdit(false);
			this.suppressStartEdit = false;
		}
		const turn = this.userTurnAt(index);
		if (!turn) {
			return;
		}
		this.ensureEditComposer();
		this.contextUsageView?.hidePanel();
		this.hidePlusMenu();
		this.threadScrollFrozen = true;
		this.stickToBottom = false;
		this.suppressEditDismiss = true;
		this.captureEditAnchor(turn);
		this.editingUserIndex = index;
		this.editMentionController?.clear();
		if (this.editModel && !this.editModel.isDisposed()) {
			this.editModel.setValue(message.text);
			this.editMentionController?.restoreMentions(message.mentions ?? []);
			const lastLine = this.editModel.getLineCount();
			this.editEditor?.setPosition({ lineNumber: lastLine, column: this.editModel.getLineMaxColumn(lastLine) });
			this.editEditor?.setScrollTop(0);
		}
		turn.replaceChildren();
		turn.classList.add('editing');
		turn.classList.remove('editable', 'cancelled', 'running');
		append(turn, $('.volt-agent-edit-slot'));
		this.syncComposerPlacement();
		this.layoutEditEditor();
		this.applyEditAnchor(turn);
		this.focusEditEditor();
		this.scheduleThreadPinRelease(turn);
	}

	private onEditPointerDown(e: PointerEvent): void {
		if (this.suppressEditDismiss || this.editingUserIndex === undefined || !isHTMLElement(e.target)) {
			return;
		}
		if (e.target.closest('.volt-agent-edit-slot')
			|| e.target.closest('.volt-agent-edit-composer')
			|| e.target.closest('.volt-agent-input-box.editing')
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
					this.suppressStartEdit = false;
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
		const index = this.editingUserIndex;
		const turn = this.threadInner.querySelector<HTMLElement>('.volt-agent-turn.user.editing') ?? this.userTurnAt(index);
		const message = this.messages[index];
		this.threadScrollFrozen = true;
		this.stickToBottom = false;
		this.suppressStartEdit = true;
		if (turn) {
			this.captureEditAnchor(turn);
		}
		this.editingUserIndex = undefined;
		this.clearEditComposer();
		this.editComposerEl?.remove();
		this.container.classList.remove('editing-user');
		if (turn && message?.kind === 'user') {
			turn.replaceChildren();
			turn.classList.remove('editing');
			this.renderUserTurn(turn, message, index);
			this.applyEditAnchor(turn);
		} else {
			this.renderThread(false);
		}
		this.scheduleThreadPinRelease(turn);
		if (focusComposer) {
			this.monacoHost?.querySelector('textarea')?.focus({ preventScroll: true });
		}
	}

	private commitUserEdit(value: string, display?: IAgentPromptDisplay): void {
		const index = this.editingUserIndex;
		if (index === undefined) {
			return;
		}
		if (this.isStreaming()) {
			this.skipRunEvents = true;
			this.stopAgent();
		}
		this.editingUserIndex = undefined;
		this.clearEditComposer();
		const removed = this.messages[index];
		this.messages.splice(index);
		if (this.input instanceof AgentEditorInput) {
			this.input.recordTruncate(removed);
		}
		this.syncComposerPlacement();
		this.dispatchPrompt(value, display);
	}

	private syncComposerPlacement(): void {
		if (this.composerEl.parentElement !== this.container) {
			const find = this.findWidget?.getDomNode();
			if (find?.parentElement === this.container) {
				this.container.insertBefore(this.composerEl, find);
			} else {
				this.container.appendChild(this.composerEl);
			}
		}
		const slot = this.threadInner?.querySelector<HTMLElement>('.volt-agent-edit-slot');
		const editing = this.editingUserIndex !== undefined && !!slot;
		this.container.classList.toggle('editing-user', editing);
		if (editing && slot && this.editComposerEl) {
			if (this.editComposerEl.parentElement !== slot) {
				slot.appendChild(this.editComposerEl);
			}
			return;
		}
		this.editComposerEl?.remove();
	}

	private ensureEditComposer(): void {
		if (this.editEditor) {
			return;
		}

		this.editComposerEl = $('.volt-agent-composer.volt-agent-edit-composer');
		this.editInputBox = append(this.editComposerEl, $('.volt-agent-input-box.editing'));
		this.editMonacoHost = append(this.editInputBox, $('.volt-agent-monaco.show-file-icons'));
		const toolbar = append(this.editInputBox, $('.volt-agent-toolbar'));
		const start = append(toolbar, $('.volt-agent-toolbar-start'));
		const end = append(toolbar, $('.volt-agent-toolbar-end'));

		this.editPlusButton = append(start, $('button.volt-agent-plus')) as HTMLButtonElement;
		setAgentTooltip(this.editPlusButton, localize('voltAgent.add', "Add"));
		this.editPlusButton.appendChild(createPlusIcon());
		this.editEditorDisposables.add(addDisposableListener(this.editPlusButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showPlusMenu('edit');
		}));

		this.editOpenNewButton = append(start, $('button.volt-agent-open-new')) as HTMLButtonElement;
		this.editOpenNewButton.type = 'button';
		this.editOpenNewButton.setAttribute('aria-label', localize('voltAgent.openInNewAgent', "Open in new agent"));
		this.editOpenNewButton.appendChild(createOpenNewAgentIcon());
		append(this.editOpenNewButton, $('span.volt-agent-open-new-label')).textContent = localize('voltAgent.openInNewAgentShort', "New agent");
		setAgentTooltip(this.editOpenNewButton, localize('voltAgent.openInNewAgentHint', "Open this prompt in a new agent tab"));
		this.editEditorDisposables.add(addDisposableListener(this.editOpenNewButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.openEditInNewAgent();
		}));

		this.editModelButton = append(end, $('button.volt-agent-model')) as HTMLButtonElement;
		this.renderModelButton(this.editModelButton, false);
		this.editEditorDisposables.add(addDisposableListener(this.editModelButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.tooltip.hide();
			this.showModelDropdown(this.editModelButton);
		}));

		this.editSendButton = append(end, $('button.volt-agent-send')) as HTMLButtonElement;
		this.editSendButton.type = 'button';
		this.editSendButton.appendChild(createSendIcon());
		setAgentTooltip(this.editSendButton, localize('voltAgent.send', "Send"));
		this.editEditorDisposables.add(addDisposableListener(this.editSendButton, 'click', () => this.sendUserEdit()));

		const widgetOptions = getSimpleCodeEditorWidgetOptions();
		widgetOptions.contextKeyValues = { [CONTEXT_IN_AGENT_INPUT.key]: true };
		widgetOptions.contributions = [
			...(widgetOptions.contributions ?? []),
			...EditorExtensionsRegistry.getSomeEditorContributions([DropIntoEditorController.ID]),
		];
		this.editEditor = this.editEditorDisposables.add(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.editMonacoHost,
			this.getAgentInputEditorOptions(true),
			widgetOptions
		));

		const modelUri = URI.from({ scheme: 'volt-agent-input', path: `edit-${this.sessionKey}-${Date.now()}` });
		this.editModel = this.modelService.createModel('', null, modelUri, true);
		this.editEditorDisposables.add(toDisposable(() => this.editModel?.dispose()));
		this.editEditor.setModel(this.editModel);
		this.editMentionController = this.editEditorDisposables.add(this.instantiationService.createInstance(AgentMentionController, this.editEditor));
		this.editLists = this.editEditorDisposables.add(new AgentComposerLists(this.editEditor));
		this.editMentionController.bindDropTarget(this.editInputBox);
		const editWindow = getWindow(this.editMonacoHost);
		const editResize = new editWindow.ResizeObserver(() => this.layoutEditEditor());
		editResize.observe(this.editMonacoHost);
		this.editEditorDisposables.add(toDisposable(() => editResize.disconnect()));

		this.editEditorDisposables.add(this.editEditor.onDidChangeModelContent(() => this.layoutEditEditor()));
		this.editEditorDisposables.add(this.editEditor.onDidContentSizeChange(e => {
			if (e.contentHeightChanged) {
				this.layoutEditEditor();
			}
		}));
		this.editEditorDisposables.add(this.editEditor.onKeyDown(e => {
			if (isUnmodifiedEnter(e)) {
				if (e.shiftKey) {
					if (this.editLists?.tryHandleEnter()) {
						e.preventDefault();
						e.stopPropagation();
					}
					return;
				}
				if (this.editMentionController?.isMenuOpen) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.sendUserEdit();
				return;
			}
			if (e.keyCode === KeyCode.Escape) {
				e.preventDefault();
				e.stopPropagation();
				this.cancelUserEdit();
				return;
			}
			if (e.keyCode === KeyCode.Enter && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				this.sendUserEdit();
			}
		}));
	}

	private clearEditComposer(): void {
		this.hidePlusMenu();
		this.editMentionController?.clear();
		if (this.editModel && !this.editModel.isDisposed()) {
			this.editModel.setValue('');
		}
	}

	private sendUserEdit(): void {
		if (this.editMentionController?.isMenuOpen || this.editingUserIndex === undefined) {
			return;
		}
		const displayText = this.editModel?.getValue() ?? '';
		const mentions = this.editMentionController?.displayMentions() ?? [];
		const agentText = (this.editMentionController?.serialize() || displayText).trim();
		if (!agentText) {
			return;
		}
		const display = mentions.length ? { text: displayText, mentions } : undefined;
		this.commitUserEdit(agentText, display);
	}

	private layoutEditEditor(): void {
		if (!this.editEditor || !this.editMonacoHost || this.editingUserIndex === undefined) {
			return;
		}
		const lineHeight = 22;
		const next = getWindow(this.editMonacoHost).getComputedStyle(this.editMonacoHost);
		const padX = parseFloat(next.paddingLeft) + parseFloat(next.paddingRight);
		const padY = parseFloat(next.paddingTop) + parseFloat(next.paddingBottom);
		const width = Math.max(this.editMonacoHost.clientWidth - padX, 0);
		if (width <= 0) {
			scheduleAtNextAnimationFrame(getWindow(this.editMonacoHost), () => this.layoutEditEditor());
			return;
		}
		this.editEditor.layout({ width, height: 0 });
		const contentHeight = Math.min(Math.max(this.editEditor.getContentHeight(), lineHeight), USER_EDIT_MAX_HEIGHT);
		const nextHeight = `${contentHeight + padY}px`;
		if (this.editMonacoHost.style.height !== nextHeight) {
			this.editMonacoHost.style.height = nextHeight;
		}
		this.editEditor.layout({ width, height: contentHeight });
		this.applyEditAnchor();
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

	private userTurnAt(index: number): HTMLElement | undefined {
		let ordinal = -1;
		for (const [i, item] of this.messages.entries()) {
			if (item.kind !== 'user') {
				continue;
			}
			ordinal++;
			if (i === index) {
				return this.threadInner.querySelectorAll<HTMLElement>('.volt-agent-turn.user')[ordinal];
			}
		}
		return undefined;
	}

	private captureEditAnchor(turn: HTMLElement): void {
		this.editAnchorTop = turn.getBoundingClientRect().top;
		this.editAnchorScrollTop = this.threadScroll?.getScrollPosition().scrollTop;
	}

	private applyEditAnchor(turn?: HTMLElement | null): void {
		if (!this.threadScroll || (this.editAnchorTop === undefined && this.editAnchorScrollTop === undefined)) {
			return;
		}
		const target = turn
			?? this.threadInner.querySelector<HTMLElement>('.volt-agent-turn.user.editing')
			?? this.userTurnAt(this.editingUserIndex ?? -1);
		const viewport = this.threadScroll.getDomNode();
		this.threadScroll.setScrollDimensions({
			width: viewport.clientWidth,
			height: viewport.clientHeight,
			scrollWidth: this.threadInner.scrollWidth,
			scrollHeight: Math.max(viewport.clientHeight, this.measureThreadContentHeight()),
		});
		this.applyingEditPin = true;
		if (this.editAnchorScrollTop !== undefined) {
			this.threadScroll.setScrollPosition({ scrollTop: this.editAnchorScrollTop });
		}
		if (target?.isConnected && this.editAnchorTop !== undefined && !target.classList.contains('stuck')) {
			const delta = target.getBoundingClientRect().top - this.editAnchorTop;
			if (Math.abs(delta) > 0.5) {
				const next = Math.max(0, this.threadScroll.getScrollPosition().scrollTop + delta);
				this.threadScroll.setScrollPosition({ scrollTop: next });
				this.editAnchorScrollTop = next;
			}
		}
		this.applyingEditPin = false;
		this.threadView.syncStuckTurns();
	}

	private scheduleThreadPinRelease(turn?: HTMLElement | null): void {
		const generation = ++this.threadPinGeneration;
		scheduleAtNextAnimationFrame(getWindow(this.threadInner), () => {
			if (generation !== this.threadPinGeneration) {
				return;
			}
			this.layoutEditEditor();
			this.applyEditAnchor(turn);
			this.threadScrollFrozen = false;
			this.suppressEditDismiss = false;
			this.suppressStartEdit = false;
			if (this.editingUserIndex === undefined) {
				this.editAnchorTop = undefined;
				this.editAnchorScrollTop = undefined;
			}
		});
	}

	private focusEditEditor(): void {
		const textarea = this.editMonacoHost?.querySelector('textarea');
		if (textarea) {
			textarea.focus({ preventScroll: true });
			return;
		}
		this.editEditor?.focus();
	}

	private syncThreadScroll(scrollToEnd = false): void {
		if (!this.threadScroll || this.threadScrollFrozen) {
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
		if (this.editingUserIndex !== undefined) {
			this.applyEditAnchor();
			return;
		}
		if (scrollToEnd || this.stickToBottom) {
			this.threadScroll.setScrollPosition({ scrollTop: scrollHeight });
			this.stickToBottom = true;
		}
		this.threadView.syncStuckTurns();
	}

	private scrollThreadToEnd(): void {
		this.stickToBottom = true;
		this.syncThreadScroll(true);
	}

	private renderAgentTurn(turn: HTMLElement, message: IAgentAssistantMessage): void {
		const streaming = !!message.activity?.streaming;
		const parts = visibleReplyParts(buildThreadParts(message.segments, message.text, streaming), streaming);
		const body = append(turn, $('.volt-agent-thread-body'));
		const ctx = this.blockRenderContext(message);
		const lastGroup = [...parts].reverse().find(part => part.kind === 'group');
		for (const part of parts) {
			if (part.kind === 'group') {
				this.renderActivityGroup(body, message, part, streaming && part === lastGroup);
			} else if (part.kind === 'snapshot') {
				this.renderSnapshotPart(body, message, part.item, streaming && !part.item.image);
			} else if (part.kind === 'markdown') {
				const reply = append(body, $('.volt-agent-reply'));
				renderMarkdownInto(reply, part.content, ctx);
			} else if (part.kind === 'changes') {
				renderFileChangesPart(body, part, ctx, streaming);
			} else {
				renderAgentBlock(body, part.block, ctx);
			}
		}
		if (message.title) {
			const title = append(body, $('.volt-agent-plan-title'));
			this.setSearchableText(title, message.title);
		}
		if (message.steps.length) {
			const list = append(body, $('ul.volt-agent-steps'));
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
			const changes = append(body, $('.volt-agent-changes'));
			this.setSearchableText(append(changes, $('.volt-agent-changes-title')), localize('voltAgent.changes', "Changes"));
			for (const change of message.changes) {
				const row = append(changes, $('.volt-agent-change'));
				this.setSearchableText(row, change);
			}
		}
		if (!streaming) {
			this.renderAgentFooter(turn, message);
		}
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

	private renderStatusLine(parent: HTMLElement, key: string, text: string, shimmerAnchor: number, animate = true): void {
		const now = Date.now();
		const motion = animate ? this.statusMotion.get(key) : undefined;
		let from: string | undefined;
		let started = 0;
		if (animate && motion && motion.text !== text) {
			from = motion.text;
			started = now;
			this.statusMotion.set(key, { text, from, started });
		} else if (animate && motion?.from && motion.started !== undefined && motion.text === text && now - motion.started < STATUS_SWAP_MS) {
			from = motion.from;
			started = motion.started;
		} else if (animate) {
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
			if (role === 'out') {
				motionEl.setAttribute('aria-hidden', 'true');
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

	/** Redraws at the next phrase boundary when the model is quiet between tokens. */
	private armStatusRotation(anchor: number): void {
		const elapsed = (Date.now() - anchor) % STATUS_ROTATE_MS;
		const wait = Math.max(32, STATUS_ROTATE_MS - elapsed + 24);
		this.statusRotateTimer?.dispose();
		this.statusRotateTimer = disposableTimeout(() => {
			this.statusRotateTimer = undefined;
			if (this.isStreaming()) {
				this.renderThread(this.stickToBottom);
			}
		}, wait);
	}

	private renderActivityGroup(parent: HTMLElement, message: IAgentAssistantMessage, part: Extract<ThreadPart, { kind: 'group' }>, streaming: boolean): void {
		const section = append(parent, $('.volt-agent-activity'));
		if (streaming) {
			section.classList.add('live');
			const activity = message.activity;
			if (activity) {
				activity.shimmerStartedAt ??= Date.now();
			}
			const anchor = activity?.shimmerStartedAt ?? Date.now();
			const lines = streamingActivityLines(part.title, activity?.status, part.items, Date.now(), anchor);
			const keyBase = String(message.startedAt ?? message.id ?? 'live');
			if (lines.summary) {
				this.renderStatusLine(section, `${keyBase}:summary`, lines.summary, anchor, false);
			}
			this.renderStatusLine(section, `${keyBase}:phrase`, lines.phrase, anchor, true);
			if (lines.rotate) {
				this.armStatusRotation(anchor);
			} else {
				this.statusRotateTimer?.dispose();
				this.statusRotateTimer = undefined;
			}
			return;
		}

		const hasCard = part.items.some(item => !!item.view);
		const expanded = message.blockState[part.id]?.expanded ?? hasCard;
		const toggle = append(section, $('button.volt-agent-activity-toggle')) as HTMLButtonElement;
		toggle.classList.toggle('expanded', expanded);
		const label = append(toggle, $('span.volt-agent-activity-label'));
		this.setSearchableText(label, part.title);
		const chevron = append(toggle, $('span.volt-agent-activity-chevron'));
		chevron.appendChild(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight));
		this.threadListeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			message.blockState[part.id] = { expanded: !expanded };
			this.renderThread(this.stickToBottom);
		}));

		if (!expanded) {
			return;
		}

		const body = append(section, $('.volt-agent-activity-body'));
		const ctx = this.blockRenderContext(message);
		for (const [index, item] of part.items.entries()) {
			if (item.kind === 'thought') {
				this.renderThoughtItem(body, message, part.id, index, item, ctx);
				continue;
			}
			const clickable = isExploreItemClickable(item);
			const row = append(body, $(`.volt-agent-activity-item.${item.kind}${clickable ? '.clickable' : ''}`));
			const host = clickable
				? append(row, $(`button.${item.image ? 'volt-agent-snapshot-link' : 'volt-agent-file-link'}`)) as HTMLButtonElement
				: row;
			const action = append(host, $('span.action'));
			action.textContent = item.label;
			if (item.detail) {
				const detail = append(host, $('span.detail.volt-agent-searchable'));
				detail.textContent = item.detail;
			}
			if (item.kind === 'search' && item.files?.length) {
				this.threadListeners.add(this.exploreHitsTooltip.bind(host, () => item.files!.map(path => ({
					label: basename(path),
					detail: tooltipDir(path),
					onClick: () => void this.openWorkspaceFile(path),
				})), { variant: 'files', placement: 'below' }));
			} else {
				const tip = [item.label, item.detail].filter(Boolean).join(' ') || item.path;
				if (tip) {
					setAgentTooltip(host, tip);
				}
			}
			if (item.view) {
				this.renderToolView(body, item.view);
			}
			if (!clickable) {
				continue;
			}
			this.threadListeners.add(addDisposableListener(host, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				if (item.image) {
					this.showSnapshotPreview(item);
					return;
				}
				if (item.path) {
					void this.openWorkspaceFile(item.path, item.startLine, item.endLine);
				}
			}));
		}
	}

	private renderToolView(parent: HTMLElement, view: IAgentActivityItem['view']): void {
		if (!view) {
			return;
		}
		const card = append(parent, $(`.volt-agent-card.${view.card}`));
		if (view.card === 'read') {
			const head = append(card, $('div.volt-agent-card-head'));
			head.textContent = `${basename(view.path)}  ${view.lines.length ? `${view.lines[0].number}-${view.lines.at(-1)?.number}` : ''}`.trim();
			this.threadListeners.add(addDisposableListener(head, 'click', () => void this.openWorkspaceFile(view.path, view.lines[0]?.number)));
			const body = append(card, $('div.volt-agent-card-code'));
			for (const line of view.lines.slice(0, 12)) {
				const row = append(body, $('div.volt-agent-card-line'));
				append(row, $('span.num')).textContent = String(line.number);
				append(row, $('span.txt')).textContent = line.text;
			}
			if (view.totalLines > view.lines.length) {
				append(card, $('div.volt-agent-card-more')).textContent = `${view.totalLines} lines`;
			}
			return;
		}
		if (view.card === 'search' && view.shape === 'matches') {
			const shown = view.files.slice(0, 4);
			for (const file of shown) {
				const head = append(card, $('button.volt-agent-card-head'));
				head.textContent = file.path;
				this.threadListeners.add(addDisposableListener(head, 'click', () => void this.openWorkspaceFile(file.path, file.matches[0]?.lineNumber)));
				for (const match of file.matches.slice(0, 4)) {
					const row = append(card, $('div.volt-agent-card-line'));
					append(row, $('span.num')).textContent = String(match.lineNumber);
					append(row, $('span.txt')).textContent = match.line;
				}
			}
			if (view.total > shown.reduce((sum, file) => sum + file.matches.length, 0)) {
				append(card, $('div.volt-agent-card-more')).textContent = `${view.total} matches`;
			}
			return;
		}
		if (view.card === 'search' && view.shape === 'paths') {
			for (const path of view.paths.slice(0, 8)) {
				const head = append(card, $('button.volt-agent-card-head'));
				head.textContent = path;
				this.threadListeners.add(addDisposableListener(head, 'click', () => void this.openWorkspaceFile(path)));
			}
			if (view.total > 8) {
				append(card, $('div.volt-agent-card-more')).textContent = `${view.total} files`;
			}
			return;
		}
		if (view.card === 'web' && view.kind === 'search') {
			for (const source of view.sources.slice(0, 6)) {
				const link = append(card, $('button.volt-agent-card-link'));
				link.textContent = source.title || source.url;
				this.threadListeners.add(addDisposableListener(link, 'click', () => {
					void this.commandService.executeCommand(OPEN_BROWSER_COMMAND_ID, source.url, source.title);
				}));
			}
			return;
		}
		if (view.card === 'web' && view.kind === 'fetch') {
			const link = append(card, $('button.volt-agent-card-link'));
			link.textContent = view.statusCode === 200 ? view.url : `${view.statusCode}  ${view.url}`;
			this.threadListeners.add(addDisposableListener(link, 'click', () => {
				void this.commandService.executeCommand(OPEN_BROWSER_COMMAND_ID, view.url);
			}));
		}
	}

	private renderThoughtItem(
		parent: HTMLElement,
		message: IAgentAssistantMessage,
		groupId: string,
		index: number,
		item: IAgentActivityItem,
		ctx: IBlockRenderContext,
	): void {
		const thoughtId = `${groupId}-thought-${index}`;
		const expandable = !!item.text?.trim();
		const expanded = expandable && (message.blockState[thoughtId]?.expanded ?? false);
		const row = append(parent, $('.volt-agent-activity-item.thought'));
		if (!expandable) {
			const action = append(row, $('span.action'));
			action.textContent = item.label;
			return;
		}
		const toggle = append(row, $('button.volt-agent-thought-toggle')) as HTMLButtonElement;
		toggle.classList.toggle('expanded', expanded);
		append(toggle, $('span.action')).textContent = item.label;
		const chevron = append(toggle, $('span.volt-agent-activity-chevron'));
		chevron.appendChild(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight));
		this.threadListeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			message.blockState[thoughtId] = { expanded: !expanded };
			this.renderThread(this.stickToBottom);
		}));
		if (expanded && item.text) {
			const bubble = append(row, $('.volt-agent-thought-body.volt-agent-thinking-text'));
			renderMarkdownInto(bubble, item.text, ctx);
		}
	}

	private renderSnapshotPart(parent: HTMLElement, message: IAgentAssistantMessage, item: IAgentActivityItem, streaming: boolean): void {
		const section = append(parent, $('.volt-agent-snapshot'));
		if (streaming && !item.image) {
			this.renderLiveStatus(section, message, 'snapshot', localize('voltAgent.takingSnapshot', "Taking a screenshot snapshot."));
			return;
		}
		const button = append(section, $('button.volt-agent-snapshot-link')) as HTMLButtonElement;
		this.setSearchableText(button, item.label || localize('voltAgent.tookSnapshot', "Took snapshot"));
		if (!item.image) {
			button.disabled = true;
			return;
		}
		this.threadListeners.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showSnapshotPreview(item);
		}));
	}

	private showSnapshotPreview(item: IAgentActivityItem): void {
		if (!item.image) {
			return;
		}
		this.dismissSnapshotPreview();
		const win = getWindow(this.container);
		const overlay = append(win.document.body, $('.volt-agent-snapshot-overlay'));
		overlay.tabIndex = -1;
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		const dialog = append(overlay, $('.volt-agent-snapshot-dialog'));
		const head = append(dialog, $('.volt-agent-snapshot-head'));
		const title = append(head, $('span.volt-agent-snapshot-title'));
		title.textContent = item.label || localize('voltAgent.tookSnapshot', "Took snapshot");
		const close = append(head, $('button.volt-agent-snapshot-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltAgent.closeSnapshot', "Close"));
		close.appendChild(renderIcon(Codicon.close));
		const img = append(dialog, $('img.volt-agent-snapshot-image')) as HTMLImageElement;
		img.src = item.image;
		img.alt = title.textContent;
		const dismiss = () => this.dismissSnapshotPreview();
		this.snapshotStore.add(addDisposableListener(close, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			dismiss();
		}));
		this.snapshotStore.add(addDisposableListener(overlay, 'click', e => {
			if (e.target === overlay) {
				dismiss();
			}
		}));
		this.snapshotStore.add(addDisposableListener(overlay, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				dismiss();
			}
		}));
		this.snapshotOverlay = overlay;
		overlay.focus();
	}

	private dismissSnapshotPreview(): void {
		this.snapshotStore.clear();
		this.snapshotOverlay?.remove();
		this.snapshotOverlay = undefined;
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
		const copyLabel = localize('voltAgent.copyMessage', "Copy Message");
		const copiedLabel = localize('voltAgent.copied', "Copied");
		const forkLabel = localize('voltAgent.forkChat', "Fork Chat");

		const copyButton = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		copyButton.setAttribute('aria-label', copyLabel);
		setAgentTooltip(copyButton, copyLabel);
		copyButton.appendChild(createCopyIcon());
		this.threadListeners.add(addDisposableListener(copyButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.clipboardService.writeText(agentMessagePlainText(message)).then(() => {
				copyButton.replaceChildren(renderIcon(Codicon.check));
				setAgentTooltip(copyButton, copiedLabel);
				copyButton.classList.add('copied');
				this.threadListeners.add(disposableTimeout(() => {
					if (!copyButton.isConnected) {
						return;
					}
					copyButton.replaceChildren(createCopyIcon());
					setAgentTooltip(copyButton, copyLabel);
					copyButton.classList.remove('copied');
				}, 1500));
			});
		}));

		const forkButton = append(footer, $('button.volt-agent-footer-btn')) as HTMLButtonElement;
		forkButton.setAttribute('aria-label', forkLabel);
		setAgentTooltip(forkButton, forkLabel);
		forkButton.appendChild(createForkIcon());
		this.threadListeners.add(addDisposableListener(forkButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(NEW_AGENT_COMMAND_ID, { asTab: true });
		}));

		const when = message.endedAt ?? message.startedAt;
		if (when) {
			const ago = append(footer, $('span.volt-agent-ago'));
			ago.dataset.endedAt = String(when);
			this.setSearchableText(ago, dayjs(when).fromNow());
			this.ensureClock();
		}
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
		const preview = extractLocalPreviewUrl(path) ?? extractHttpUrl(path);
		if (preview) {
			await this.openLocalPreview(preview, true);
			return;
		}
		const resource = await this.resolveWorkspaceFile(path);
		if (!resource) {
			return;
		}
		const group = this.editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(g => g !== this.group) ?? this.group;
		const options: ITextEditorOptions = {
			pinned: true,
			revealIfOpened: true,
			revealIfVisible: true,
		};
		if (startLine) {
			options.selection = {
				startLineNumber: startLine,
				startColumn: 1,
				endLineNumber: endLine ?? startLine,
				endColumn: Number.MAX_SAFE_INTEGER,
			};
			options.selectionRevealType = TextEditorSelectionRevealType.NearTopIfOutsideViewport;
			options.selectionSource = TextEditorSelectionSource.NAVIGATION;
		}
		const pane = await this.editorService.openEditor({ resource, options }, group);
		if (!startLine) {
			return;
		}
		const editor = getCodeEditor(pane?.getControl());
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}
		const start = Math.min(startLine, model.getLineCount());
		const end = Math.min(endLine ?? startLine, model.getLineCount());
		const range = {
			startLineNumber: start,
			startColumn: 1,
			endLineNumber: end,
			endColumn: model.getLineMaxColumn(end),
		};
		editor.setSelection(range, TextEditorSelectionSource.NAVIGATION);
		editor.revealRangeNearTopIfOutsideViewport(range);
	}

	private async resolveWorkspaceFile(path: string): Promise<URI | undefined> {
		const trimmed = path.replace(/^["'`]+|["'`]+$/g, '').trim();
		if (!trimmed) {
			return undefined;
		}

		if (/^https?:\/\//i.test(trimmed)) {
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
	prefillDraft(text: string, mentions?: readonly IAgentDisplayMention[]): void {
		this.ensureInputEditor();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.mentionController?.clear();
			this.inputModel.setValue(text);
			if (mentions?.length) {
				this.mentionController?.restoreMentions(mentions);
			}
			const lastLine = this.inputModel.getLineCount();
			this.inputEditor?.setPosition({ lineNumber: lastLine, column: this.inputModel.getLineMaxColumn(lastLine) });
		}
		this.syncUnsavedState();
		this.updateSendButton();
		this.layoutInputEditor();
		this.inputEditor?.focus();
	}

	private async openEditInNewAgent(): Promise<void> {
		if (this.editingUserIndex === undefined) {
			return;
		}
		this.hidePlusMenu();
		const text = this.editModel?.getValue() ?? '';
		const mentions = cloneDisplayMentions(this.editMentionController?.displayMentions() ?? []);
		const next = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		next.draft = text;
		next.draftMentions = mentions;
		next.setHasUnsavedContent(!!text.trim() || mentions.length > 0);
		next.scheduleDraftSave();
		const pane = await this.group.openEditor(next, { pinned: true });
		if (pane instanceof AgentEditor) {
			pane.prefillDraft(text, mentions);
		}
		if (pane !== this && this.editingUserIndex !== undefined) {
			this.cancelUserEdit(false);
		}
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

	getPromptQueue(): readonly { id: string; text: string; display?: IAgentPromptDisplay }[] {
		return this.promptQueue;
	}

	stopRun(): void {
		this.stopAgent();
	}

	isEditingUser(): boolean {
		return this.editingUserIndex !== undefined;
	}

	getThreadView(): AgentThreadView | undefined {
		return this.threadView;
	}

	setBrowserHosted(hosted: boolean): void {
		if (this.container.classList.contains('browser-hosted') === hosted) {
			return;
		}
		this.container.classList.toggle('browser-hosted', hosted);
		this.syncFollowUpComposer((this.inputModel?.getLineCount() ?? 1) > 1);
		this.updateInputPlaceholder();
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
			turns: this.messages.length ? [{ kind: 'user', text: '' }] : [],
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

	sendSelectionToChat(resource: URI, selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }, comment?: string): void {
		this.addSelectionMention(resource, selection);
		const text = comment?.trim();
		if (text && this.inputEditor && this.inputModel && !this.inputModel.isDisposed()) {
			const pos = this.inputEditor.getPosition() ?? this.inputModel.getFullModelRange().getEndPosition();
			this.inputEditor.executeEdits('volt-inline-comment', [{
				range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
				text,
			}]);
		}
		this.send();
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

		const widgetOptions = getSimpleCodeEditorWidgetOptions();
		widgetOptions.contextKeyValues = { [CONTEXT_IN_AGENT_INPUT.key]: true };
		widgetOptions.contributions = [
			...(widgetOptions.contributions ?? []),
			...EditorExtensionsRegistry.getSomeEditorContributions([DropIntoEditorController.ID]),
		];
		this.inputEditor = this.editorDisposables.add(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.monacoHost,
			this.getAgentInputEditorOptions(),
			widgetOptions
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
			this.refreshContextUsage();
		}));
		this.editorDisposables.add(this.inputEditor.onDidContentSizeChange(e => {
			if (e.contentHeightChanged) {
				this.layoutInputEditor();
			}
		}));
		this.editorDisposables.add(this.inputEditor.onKeyDown(e => {
			if (isUnmodifiedEnter(e)) {
				if (e.shiftKey) {
					if (this.composerLists?.tryHandleEnter()) {
						e.preventDefault();
						e.stopPropagation();
					}
					return;
				}
				if (this.mentionController?.isMenuOpen) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.send();
				return;
			}
			if (e.keyCode === KeyCode.KeyF && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				this.revealFind();
				return;
			}
			if (e.keyCode === KeyCode.KeyL && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand(OPEN_AGENT_SIDE_PANEL_COMMAND_ID);
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
			if (e.keyCode === KeyCode.Enter && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				this.send();
			}
		}));
		this.updateComposerEditorOptions();
		this.updateInputPlaceholder();
	}

	submitComposer(): void {
		if (this.editingUserIndex !== undefined && this.editEditor?.hasTextFocus()) {
			if (this.editMentionController?.isMenuOpen) {
				return;
			}
			this.sendUserEdit();
			return;
		}
		if (this.mentionController?.isMenuOpen) {
			return;
		}
		this.send();
	}

	private send(): void {
		if (this.submitting) {
			return;
		}
		this.submitting = true;
		try {
			this.doSend();
		} finally {
			this.submitting = false;
		}
	}

	private doSend(): void {
		const displayText = this.inputModel?.getValue() ?? '';
		const mentions = this.mentionController?.displayMentions() ?? [];
		const agentText = (this.mentionController?.serialize() || displayText).trim();
		const display = mentions.length ? { text: displayText, mentions } : undefined;
		if (this.editingUserIndex !== undefined && agentText) {
			this.cancelUserEdit(false);
		}
		if (this.isStreaming()) {
			if (agentText) {
				this.enqueuePrompt(agentText, display);
			}
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
		this.syncQueueStack();
		this.persistInputState();
		this.inputEditor?.focus();
	}

	private dispatchPrompt(value: string, display?: IAgentPromptDisplay): void {
		this.thinkingStore.clear();
		const turn = generateUuid();
		const userMessage: IAgentUserMessage = {
			kind: 'user',
			id: turn,
			text: display?.text.trim() || value,
			agentText: display ? value : undefined,
			mentions: display?.mentions,
		};
		this.messages.push(userMessage);
		const reply: IAgentAssistantMessage = {
			kind: 'agent',
			id: turn,
			title: '',
			steps: [],
			segments: [],
			blockState: {},
			startedAt: Date.now(),
			activity: {
				status: localize('voltAgent.thinking', "Thinking"),
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

		const input = this.input instanceof AgentEditorInput ? this.input : undefined;
		if (input) {
			// The prompt is durable before the model is asked.
			input.recordUser(userMessage);
			input.recordMode(normalizeVoltMode(this.currentMode));
		}

		const session = this.runtime.getOrCreateSession(this.sessionKey);
		void this.runtime.send(session.sessionId, {
			text: value,
			mode: normalizeVoltMode(this.currentMode) as VoltMode,
			providerRef: this.modelAuto ? undefined : (this.currentModel || undefined),
			options: this.modelAuto || !this.currentModel ? undefined : this.runtime.getModelOptions(this.currentModel),
		}).catch(err => {
			reply.activity!.streaming = false;
			this.completeStreamingBlocks(reply);
			reply.endedAt = Date.now();
			reply.durationMs = reply.endedAt - (reply.startedAt ?? reply.endedAt);
			const errorText = err instanceof Error ? err.message : String(err);
			reply.text = errorText;
			reply.segments.push({ kind: 'text', text: errorText });
			this.renderThread(true);
			this.updateSendButton();
			this.recordReply(reply, true, 'error');
			this.drainPromptQueue();
		});
	}

	/** Snapshot a reply into durable history; partial snapshots are throttled by the input. */
	private recordReply(reply: IAgentAssistantMessage, final: boolean, status: AgentSessionStatus): void {
		const input = this.input;
		if (input instanceof AgentEditorInput) {
			input.recordAssistant(reply, final, status, agentMessagePlainText(reply));
		}
	}

	private stopAgent(): void {
		const last = this.messages.at(-1);
		if (last?.kind === 'agent' && last.activity?.streaming) {
			last.cancelled = true;
			last.activity.streaming = false;
			last.activity.expanded = false;
			last.activity.status = localize('voltAgent.cancelled', "Cancelled");
			last.endedAt = Date.now();
			last.startedAt ??= last.endedAt;
			last.durationMs = Math.max(0, last.endedAt - last.startedAt);
			this.completeStreamingBlocks(last);
			this.updateSendButton();
			this.renderThread(this.stickToBottom);
			this._onDidChangeDock.fire();
			this.recordReply(last, true, 'cancelled');
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
		this.syncQueueStack();
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
		const kind: 'mic' | 'send' = this.isFollowUpComposer() || this.hasDraft() ? 'send' : 'mic';
		if (this.sendKind === kind && this.sendButton.childElementCount) {
			this.sendButton.classList.remove('stop');
			return;
		}
		this.sendKind = kind;
		this.sendButton.replaceChildren();
		this.sendButton.classList.remove('stop');
		setAgentTooltip(this.sendButton, kind === 'send'
			? localize('voltAgent.send', "Send")
			: localize('voltAgent.voice', "Voice"));
		this.sendButton.appendChild(kind === 'send' ? createSendIcon() : createMicIcon());
	}

	removeQueuedPrompt(id: string): void {
		this.promptQueue = this.promptQueue.filter(queued => queued.id !== id);
		this.syncQueueStack();
		this.persistInputState();
	}

	reorderQueuedPrompts(ids: readonly string[]): void {
		const map = new Map(this.promptQueue.map(item => [item.id, item]));
		const next: typeof this.promptQueue = [];
		for (const id of ids) {
			const item = map.get(id);
			if (item) {
				next.push(item);
				map.delete(id);
			}
		}
		for (const leftover of map.values()) {
			next.push(leftover);
		}
		this.promptQueue = next;
		this.syncQueueStack();
		this.persistInputState();
	}

	clearPromptQueue(): void {
		this.promptQueue = [];
		this.syncQueueStack();
		this.persistInputState();
	}

	private syncQueueStack(): void {
		if (!this.composerQueue) {
			return;
		}
		this.composerQueue.setMode(this.currentMode);
		this.composerQueue.setQueue(this.promptQueue.map(item => ({
			id: item.id,
			text: item.text,
			preview: item.display?.text ?? item.text,
		})));
		this._onDidChangeQueue.fire();
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
		const live = session.activeRun;
		if (this.isStreaming() && live?.runId && (live.status === 'running' || live.status === 'waiting' || live.status === 'queued')) {
			this.activeRunId = live.runId;
			this.skipRunEvents = false;
		}
		this.eventDisposable = this.runtime.onEvent(session.sessionId, envelope => this.applyEvent(envelope));
	}

	private applyUsage(event: Extract<IVoltEventEnvelope['event'], { type: 'usage' }>, last?: IAgentAssistantMessage): void {
		const prompt = Number.isFinite(event.input) ? event.input : 0;
		const completion = Number.isFinite(event.output) ? event.output : 0;
		const measured = event.used !== undefined && Number.isFinite(event.used) && event.used >= 0
			? event.used
			: (prompt + completion > 0 ? prompt + completion : undefined);
		if (measured !== undefined) {
			this.sessionTokensUsed = measured;
			if (last) {
				last.tokensUsed = measured;
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

	/** DeepSeek `presentCall`. Card wins over the tool-name heuristics used for ACP. */
	private applyPresentedTool(last: IAgentAssistantMessage, event: Extract<IVoltEvent, { type: 'tool.start' }>, activity: IAgentActivity): void {
		const id = `tool-${event.callId}`;
		if (event.card === 'terminal') {
			const existing = findBlockByCallId(last.segments, event.callId);
			if (existing?.type === 'terminal') {
				existing.command = event.title || existing.command;
				existing.cwd = event.cwd || existing.cwd;
				existing.title = event.title || existing.title;
			} else {
				this.replaceCallBlock(last, event.callId, createTerminalBlock({
					id,
					callId: event.callId,
					title: event.title,
					command: event.title || event.input || '',
					output: '',
					cwd: event.cwd || this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
				}));
			}
			const ran = firstCommandName(event.title || event.input || '');
			activity.status = ran
				? localize('voltAgent.runningCommand', "Running {0}", ran)
				: localize('voltAgent.runningTerminal', "Running command");
			return;
		}
		if (event.card === 'diff') {
			const diff = event.diffs?.[0];
			const path = diff?.path || event.locations?.[0]?.path || event.title || event.name;
			const existing = findBlockByCallId(last.segments, event.callId);
			if (existing?.type === 'file') {
				existing.path = path;
				existing.original = diff?.oldText ?? existing.original;
				existing.modified = diff?.newText ?? existing.modified;
				existing.verb = diff?.oldText === null ? 'Created' : 'Edited';
				existing.input = event.input ?? existing.input;
			} else {
				this.replaceCallBlock(last, event.callId, createFileChangeBlock({
					id,
					callId: event.callId,
					path,
					verb: diff?.oldText === null ? 'Created' : 'Edited',
					input: event.input,
					original: diff?.oldText ?? undefined,
					modified: diff?.newText,
				}));
			}
			activity.status = event.title || event.name;
			return;
		}
		const existing = findBlockByCallId(last.segments, event.callId);
		const item = this.findActivityByCallId(last, event.callId);
		const explore = isExploreTool(event.name, event.title, event.kind);
		if (explore && !item) {
			const described = describeExploreActivity(event.name, event.title, event.input);
			const created: IAgentActivityItem = {
				kind: classifyToolActivity(event.name, event.title, event.kind),
				label: described.label,
				detail: described.detail,
				path: described.path,
				startLine: described.startLine,
				endLine: described.endLine,
				files: described.files,
				callId: event.callId,
				input: event.input,
				toolName: event.name,
				toolTitle: event.title,
			};
			activity.items.push(created);
			last.segments.push({ kind: 'activity', item: created });
		} else if (item && event.title) {
			item.toolTitle = event.title;
			item.label = event.title;
		}
		if (existing?.type === 'tool' && event.title) {
			existing.title = event.title;
		}
		if (!existing && !item && !explore) {
			this.replaceCallBlock(last, event.callId, createToolBlock({
				id,
				callId: event.callId,
				name: event.name,
				title: event.title,
				input: event.input,
			}));
		}
		activity.status = event.title || event.name;
	}

	private replaceCallBlock(last: IAgentAssistantMessage, callId: string, block: ITerminalBlock | IFileChangeBlock | IToolBlock): void {
		let replaced = false;
		for (let i = 0; i < last.segments.length; i++) {
			const segment = last.segments[i];
			if (segment.kind === 'block' && 'callId' in segment.block && segment.block.callId === callId) {
				last.segments[i] = { kind: 'block', block };
				replaced = true;
				break;
			}
		}
		if (!replaced) {
			last.segments.push({ kind: 'block', block });
		}
		last.blockState[block.id] = last.blockState[block.id] ?? { expanded: false };
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
			this.refreshContextUsage();
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
				activity.status = localize('voltAgent.thinking', "Thinking");
				this.runWantsPreview = false;
				break;
			case 'lane':
				this.runWantsPreview = event.wantsPreview;
				break;
			case 'lifecycle':
				if (event.phase === 'planning') {
					activity.status = localize('voltAgent.planning', "Planning");
				} else if (event.phase === 'verifying') {
					activity.status = localize('voltAgent.verifying', "Verifying");
				} else if (event.phase === 'waiting' || event.phase === 'paused') {
					activity.status = localize('voltAgent.waiting', "Waiting");
				}
				break;
			case 'clarify':
				last.text = (last.text ?? '') + event.question;
				appendTextDelta(last.segments, event.question);
				activity.status = localize('voltAgent.clarify', "Needs a decision");
				break;
			case 'decision':
				activity.status = event.title;
				activity.items.push({ kind: 'note', label: event.title, detail: event.detail });
				break;
			case 'outcome':
				if (event.markdown && !(last.text ?? '').includes(event.headline)) {
					const suffix = last.text?.trim() ? `\n\n${event.markdown}` : event.markdown;
					last.text = (last.text ?? '') + suffix;
					appendTextDelta(last.segments, suffix);
				}
				activity.status = event.headline;
				break;
			case 'step.start':
			case 'step.end':
			case 'text.start':
			case 'text.end':
			case 'reasoning.start':
			case 'reasoning.end':
				break;
			case 'reasoning.delta':
				activity.expanded = false;
				activity.status = localize('voltAgent.thinking', "Thinking");
				activity.thinkingText = (activity.thinkingText ?? '') + (event.delta ?? '');
				appendThoughtDelta(last.segments, event.delta ?? '');
				break;
			case 'text.delta':
				last.text = (last.text ?? '') + (event.delta ?? '');
				appendTextDelta(last.segments, event.delta ?? '');
				activity.status = localize('voltAgent.writing', "Writing");
				break;
			case 'tool.start': {
				if (event.card) {
					this.applyPresentedTool(last, event, activity);
					break;
				}
				const kind = event.kind;
				const parsed = parseShellToolInput(event.input);
				const shell = isShellTool(event.name, event.title, event.input, kind) || (!kind && looksLikeShell(parsed.command));
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
					const fileChange = isFileChangeTool(event.name, event.title, kind);
					if (!fileChange) {
						const described = describeExploreActivity(event.name, event.title, event.input);
						const item: IAgentActivityItem = {
							kind: classifyToolActivity(event.name, event.title, kind),
							label: described.label,
							detail: described.detail,
							path: described.path,
							startLine: described.startLine,
							endLine: described.endLine,
							files: described.files,
							callId: event.callId,
							input: event.input,
							toolName: event.name,
							toolTitle: event.title,
						};
						activity.items.push(item);
						last.segments.push({ kind: 'activity', item });
						activity.status = [described.label, described.detail].filter(Boolean).join(' ') || event.title || event.name;
					} else {
						activity.status = event.title || event.name;
					}
				}
				const id = `tool-${event.callId}`;
				const explore = !shell && isExploreTool(event.name, event.title, kind);
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
					this.maybeOpenLocalPreview(parsed.command, 700);
				} else if (isFileChangeTool(event.name, event.title, kind)) {
					last.segments.push({
						kind: 'block',
						block: this.createFileChangeFromTool(id, event.callId, event.name, event.title, event.input),
					});
				} else if (!explore) {
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
				if (!explore) {
					last.blockState[id] = { expanded: false };
				}
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
					this.maybeOpenLocalPreview(block.command, 700);
					const ran = firstCommandName(block.command);
					if (ran) {
						activity.status = localize('voltAgent.runningCommand', "Running {0}", ran);
						const lastItem = activity.items.at(-1);
						if (lastItem && lastItem.label === localize('voltAgent.ran', "Ran") && !lastItem.detail) {
							lastItem.detail = ran;
						}
					}
				} else {
					if (block?.type === 'tool') {
						block.input = block.input ? (block.input.includes(event.delta) ? block.input : block.input + event.delta) : event.delta;
					} else if (block?.type === 'file') {
						block.input = block.input ? (block.input.includes(event.delta) ? block.input : block.input + event.delta) : event.delta;
						this.mergeFileChange(block, event.delta);
					}
					const item = this.findActivityByCallId(last, event.callId);
					if (item) {
						const input = mergeToolInput(item.input, event.delta);
						applyExploreInputToActivity(item, item.toolName ?? item.label, item.toolTitle, input);
					}
				}
				break;
			}
			case 'tool.end': {
				const block = findBlockByCallId(last.segments, event.callId);
				const output = stringifyToolResult(event.result);
				const image = extractToolImage(event.result);
				if (image) {
					this.attachSnapshotImage(last, event.callId, image);
				}
				if (block?.type === 'terminal') {
					block.output = event.output || output;
					block.status = event.error ? 'error' : 'complete';
					block.exitCode = event.exitCode ?? (event.error ? 1 : 0);
					if (event.title) {
						block.title = event.title;
					}
					this.maybeOpenLocalPreview(block.output, block.command, 0);
				} else if (block?.type === 'tool') {
					block.output = event.output || output;
					block.status = event.error ? 'error' : 'complete';
				} else if (block?.type === 'file') {
					block.output = event.output || output;
					block.status = event.error ? 'error' : 'complete';
					const diff = event.diffs?.[0];
					if (diff) {
						block.path = diff.path || block.path;
						block.original = diff.oldText ?? block.original;
						block.modified = diff.newText;
						block.verb = diff.oldText === null ? 'Created' : block.verb;
					}
					this.mergeFileChange(block, block.input, block.output, event.result);
				}
				const item = this.findActivityByCallId(last, event.callId);
				if (item) {
					applyExploreResultToActivity(item, event.result, item.input);
					if (event.view) {
						item.view = event.view;
					}
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
				if (!findFileBlockByPath(last.segments, path)) {
					const id = `file-${path}-${last.segments.length}`;
					last.segments.push({
						kind: 'block',
						block: createFileChangeBlock({
							id,
							path,
							verb: event.kind === 'create' ? 'Created' : event.kind === 'delete' ? 'Deleted' : 'Edited',
							status: 'complete',
						}),
					});
					last.blockState[id] = { expanded: false };
				}
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
			case 'finish':
				break;
			case 'retry':
				activity.status = event.message;
				activity.items.push({ kind: 'note', label: event.message });
				break;
			case 'error':
				last.text = event.message;
				appendTextDelta(last.segments, event.message);
				activity.status = localize('voltAgent.error', "Error");
				break;
			case 'run.end':
				activity.streaming = false;
				activity.expanded = false;
				last.cancelled = last.cancelled || event.reason === 'abort';
				last.endedAt = Date.now();
				last.startedAt ??= last.endedAt;
				last.durationMs = Math.max(0, last.endedAt - last.startedAt);
				if (!last.cancelled && event.reason !== 'fail' && !hasVisibleReply(last)) {
					const empty = localize('voltAgent.emptyReply', "Stopped before a reply.");
					last.text = empty;
					appendTextDelta(last.segments, empty);
				}
				activity.status = last.cancelled
					? localize('voltAgent.cancelled', "Cancelled")
					: runStatusLine(workCountsForSegments(last.segments), last.durationMs);
				this.completeStreamingBlocks(last);
				this.scheduleThreadRender();
				this.recordReply(last, true, last.cancelled ? 'cancelled' : event.reason === 'fail' ? 'error' : 'done');
				if (event.reason === 'abort') {
					this.updateSendButton();
				} else {
					this.drainPromptQueue();
				}
				return;
		}
		this.scheduleThreadRender();
	}

	private maybeOpenLocalPreview(...parts: Array<string | number | undefined>): void {
		if (!this.runWantsPreview) {
			return;
		}
		let delay = 0;
		const texts: string[] = [];
		for (const part of parts) {
			if (typeof part === 'number') {
				delay = part;
			} else if (part) {
				texts.push(part);
			}
		}
		const url = extractLocalPreviewUrl(...texts);
		if (!url || url === this.openedPreviewUrl) {
			return;
		}
		const win = getWindow(this.container);
		if (this.previewTimer !== undefined) {
			win.clearTimeout(this.previewTimer);
		}
		this.previewTimer = win.setTimeout(() => {
			this.previewTimer = undefined;
			void this.openLocalPreview(url);
		}, delay);
	}

	private async openLocalPreview(url: string, force = false): Promise<void> {
		const clean = sanitizeBrowserUrl(url) ?? extractLocalPreviewUrl(url) ?? extractHttpUrl(url) ?? url;
		if (!force && this.openedPreviewUrl === clean) {
			return;
		}
		this.openedPreviewUrl = clean;
		url = clean;
		let title = localize('voltBrowser.local', "Local");
		try {
			title = new URL(url).hostname;
		} catch {
			// keep fallback
		}
		await this.commandService.executeCommand(OPEN_BROWSER_COMMAND_ID, url, title);
	}

	private completeStreamingBlocks(message: IAgentAssistantMessage): void {
		for (const segment of message.segments ?? []) {
			if (segment.kind === 'block' && segment.block.status === 'streaming') {
				segment.block.status = segment.block.type === 'approval' ? 'error' : 'complete';
			}
		}
	}

	private findActivityByCallId(message: IAgentAssistantMessage, callId: string): IAgentActivityItem | undefined {
		for (const segment of message.segments) {
			if (segment.kind === 'activity' && segment.item.callId === callId) {
				return segment.item;
			}
		}
		return message.activity?.items.find(item => item.callId === callId);
	}

	private createFileChangeFromTool(id: string, callId: string, name: string, title: string | undefined, input?: string): IFileChangeBlock {
		const parsed = parseToolFileChange({ name, title, input });
		const target = parseFileTarget(input, title, name, parsed?.path);
		return createFileChangeBlock({
			id,
			callId,
			path: parsed?.path || target?.path || title || name,
			verb: fileChangeVerb(name, title, parsed?.path),
			input,
			original: parsed?.original,
			modified: parsed?.modified,
			unifiedDiff: parsed?.unifiedDiff,
			additions: parsed?.additions,
			deletions: parsed?.deletions,
		});
	}

	private mergeFileChange(block: IFileChangeBlock, input?: string, output?: string, result?: unknown): void {
		const parsed = parseToolFileChange({
			name: block.verb,
			title: block.path,
			input: input ?? block.input,
			output,
			result,
			path: block.path,
		});
		if (!parsed) {
			return;
		}
		if (parsed.path) {
			block.path = parsed.path;
		}
		if (parsed.original !== undefined) {
			block.original = parsed.original;
		}
		if (parsed.modified !== undefined) {
			block.modified = parsed.modified;
		}
		if (parsed.unifiedDiff) {
			block.unifiedDiff = parsed.unifiedDiff;
		}
		if (parsed.additions !== undefined) {
			block.additions = parsed.additions;
		}
		if (parsed.deletions !== undefined) {
			block.deletions = parsed.deletions;
		}
		block.verb = fileChangeVerb(block.verb, parsed.path, block.path);
	}

	private attachSnapshotImage(message: IAgentAssistantMessage, callId: string, image: string): void {
		const item = this.findActivityByCallId(message, callId);
		if (!item) {
			return;
		}
		item.image = image;
	}

	private scheduleThreadRender(): void {
		if (this.renderHandle !== undefined) {
			return;
		}
		const win = getWindow(this.threadInner);
		this.renderHandle = win.requestAnimationFrame(() => {
			this.renderHandle = undefined;
			this.persistInputState();
			this.renderThread(this.stickToBottom);
			this._onDidChangeDock.fire();
			const last = this.messages.at(-1);
			if (last?.kind === 'agent' && last.activity?.streaming) {
				this.recordReply(last, false, 'running');
			}
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
		if (!this.threadScrollFrozen) {
			this.syncThreadScroll();
		}
		this.scheduleToolbarLayout();
		if (!this.inputEditor || this.inputLayoutInProgress) {
			this.layoutEditEditor();
			return;
		}
		this.inputLayoutInProgress = true;
		try {
			this.doLayoutInputEditor();
		} finally {
			this.inputLayoutInProgress = false;
		}
		this.layoutEditEditor();
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
		const wasFollowUp = this.inputBox.classList.contains('follow-up');
		this.inputBox.classList.remove('editing');
		this.composerQueue?.element.classList.remove('hidden');
		this.inputBox.classList.toggle('follow-up', followUp);
		this.container.classList.toggle('follow-up', followUp);
		this.inputBox.classList.toggle('multiline', followUp && multiline);
		this.placeModelButton(followUp && !multiline);
		if (wasFollowUp !== followUp) {
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
		const measure = () => {
			const next = getWindow(this.monacoHost).getComputedStyle(this.monacoHost);
			const nextPadX = parseFloat(next.paddingLeft) + parseFloat(next.paddingRight);
			const nextWidth = Math.max(this.monacoHost.clientWidth - nextPadX, 0);
			this.inputEditor!.layout({ width: nextWidth, height: 0 });
			return { next, nextWidth, rawHeight: this.inputEditor!.getContentHeight() };
		};
		const apply = (measured: { next: CSSStyleDeclaration; nextWidth: number; rawHeight: number }, maxHeight: number) => {
			const contentHeight = Math.min(Math.max(measured.rawHeight, lineHeight), maxHeight);
			const padBottomTop = parseFloat(measured.next.paddingTop) + parseFloat(measured.next.paddingBottom);
			this.monacoHost.style.height = `${contentHeight + padBottomTop}px`;
			this.inputEditor!.layout({ width: measured.nextWidth, height: contentHeight });
		};
		if (!this.isFollowUpComposer()) {
			this.syncFollowUpComposer(hasNewline);
			apply(measure(), 180);
			return;
		}
		// The compact pill holds a single line. Measuring in the pill layout keeps
		// the decision stable: text that wraps there grows into the full composer,
		// and deleting back to one line returns to the pill.
		if (!hasNewline) {
			this.syncFollowUpComposer(false);
			const compact = measure();
			if (compact.rawHeight <= lineHeight * 1.5) {
				apply(compact, lineHeight);
				return;
			}
		}
		this.syncFollowUpComposer(true);
		apply(measure(), 180);
	}

	/** The panel is narrow: let the tab bar shrink instead of overflowing. */
	override get minimumWidth(): number {
		return 120;
	}

	override getActionViewItem(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		return createAgentTitleActionViewItem(
			this.instantiationService,
			action,
			options,
			this.commandService,
			this.contextViewService,
			this.input instanceof AgentEditorInput ? this.input.sessionId : undefined,
		);
	}

	override async setInput(input: AgentEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.persistInputState();
		await super.setInput(input, options, context, token);
		try {
			await input.ensureLoaded();
		} catch (err) {
			// A broken history entry must never block opening the editor.
			this.logService.warn('[volt agent] failed to load session history', err);
		}
		if (token.isCancellationRequested || this.input !== input) {
			return;
		}
		this.ensureInputEditor();
		this.restoreInputState(input);
		this.composerChips.setSessionId(this.sessionKey);
		this.publishSessionChanges();
		this.bindRuntimeSession();
		this.layoutInputEditor();
		if (!options?.preserveFocus) {
			this.inputEditor?.focus();
		}
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
		if (this.editingUserIndex !== undefined) {
			this.editEditor?.focus();
			return;
		}
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
		this.statusRotateTimer?.dispose();
		this.dismissSnapshotPreview();
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

function tooltipDir(path: string): string | undefined {
	const folder = dirname(path.replace(/\\/g, '/'));
	return !folder || folder === '.' ? undefined : folder;
}
