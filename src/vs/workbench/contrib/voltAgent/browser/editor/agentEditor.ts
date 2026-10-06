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
import { ThemeIcon } from '../../../../../base/common/themables.js';
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
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { preloadMarkdownExtras } from '../blocks/agentMarkdown.js';
import { buildTranscriptRows, hasSignInNotice, ITranscriptSteer, TranscriptRow, withoutFailureNotice } from '../chrome/agentTranscript.js';
import { fallbackSubagentView, ITranscriptHost, renderTranscript, tickElapsed } from '../chrome/agentTranscriptView.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DropIntoEditorController } from '../../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { EDITOR_FONT_DEFAULTS, IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { deepClone } from '../../../../../base/common/objects.js';
import { isObject } from '../../../../../base/common/types.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { Mimes } from '../../../../../base/common/mime.js';
import { localize } from '../../../../../nls.js';
import { CodeDataTransfers } from '../../../../../platform/dnd/browser/dnd.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ACCESS_MODE_OPTIONS, accessModeOption } from '../../../../services/voltRuntime/common/access/accessModes.js';
import { normalizeVoltMode, VoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IAgentOrchestratorService, IOrchPrompt, IOrchQueueItem, OrchDelivery } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentPromptHostOptions, stashTurnDisplay } from '../orchestration/agentTurnHost.js';
import { AgentHistoryCodec } from '../history/agentHistoryCodec.js';
import { agentRow, dockModel, formatElapsed as formatOrchElapsed } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { createReportStackIcon, isLiveSubagentState, renderCursorSubagentRow, renderSubagentAvatar, subagentView, tickSubagentClocks } from '../chrome/agentSubagents.js';
import type { IVoltSendRequest } from '../../../../services/voltRuntime/common/session.js';
import { type IAgentQuestionResponse, questionResponseText } from '../../../../services/voltRuntime/common/questions.js';
import { AgentSessionStatus, IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { agentRunOnStorageKey, normalizeAgentRunOn } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IVoltProject, IVoltProjectsService, VoltProjectCommands } from '../../../voltProjects/common/projects.js';
import { createAccessIcon } from '../chrome/accessIcons.js';
import { mountAgentQuickOpenActions } from '../chrome/agentViewSidebars.js';
import { agentMessagePlainText, IContextUsageInput, resolveModelContextWindow } from '../context/agentContextUsage.js';
import { AgentContextUsageView, type IAgentCompactState, type IAgentStatusBranch } from '../context/agentContextUsageView.js';
import { AgentModelPicker, type IModelOption } from '../picker/agentModelPicker.js';
import { cliLoginForNotice } from '../../../../services/voltRuntime/browser/agents/cliAgents.js';
import { createBrandIcon, providerFamilyLabel } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { searchFilesAndFolders } from '../../../search/browser/searchChatContext.js';
import { AGENT_EDITOR_LINE_NUMBERS_SETTING, AgentEditorInput, NEW_AGENT_COMMAND_ID, OPEN_AGENT_SIDE_PANEL_COMMAND_ID } from './agentEditorInput.js';
import { createAgentTitleActionViewItem } from './agentTitleActions.js';
import { IAction } from '../../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getSimpleCodeEditorWidgetOptions } from '../../../codeEditor/browser/simpleEditorOptions.js';
import { extractHttpUrl, extractLocalPreviewUrl, sanitizeBrowserUrl } from '../preview/localPreview.js';
import { completeStreamingBlocks } from './agentSessionController.js';
import { AgentSurfaceHost, agentSideChatParents, revealAgentSideChat } from '../workspace/agentSurfaceHost.js';
import { openAgentPanel } from '../workspace/agentPanels.js';
import { AgentComposerChips, shouldOfferScrollToBottom } from '../composer/agentComposerChips.js';
import { AgentPendingChanges, MINI_FILE_DIFF_VIEWER_ENABLED } from '../composer/agentPendingChanges.js';
import { FRESH_TEXT_CLASS, FreshTextTracker } from '../chrome/agentFreshText.js';
import { IAgentPendingFile } from '../review/agentEditsService.js';
import { AgentComposerLists } from '../composer/agentComposerLists.js';
import { AgentPromptHistoryNavigator, IAgentPromptHistoryEntry, readStoredPrompts, rememberPrompt } from '../composer/agentPromptHistory.js';
import { AGENT_PROMPT_HISTORY_SETTING } from '../../common/agentComposerSettings.js';
import { AgentComposerQueue, IAgentComposerQueueState, QueuePause } from '../composer/agentComposerQueue.js';
import { AgentQuestionTray } from '../composer/agentQuestionTray.js';
import { showHostToolDetail } from '../chrome/agentHostToolDetail.js';
import { agentEmptyComposerChips } from '../composer/agentSuggestChips.js';
import { AgentLandingChrome } from '../home/agentLandingChrome.js';
import { AgentThreadSelectionActions } from './agentThreadSelectionActions.js';
import { AgentTurnNav, IAgentTurnNavTurn, turnNavPreview } from './agentTurnNav.js';
import { IAgentSessionChangesService } from '../review/agentSessionChangesService.js';
import { adoptProjectForUnstartedSession, agentComposerCanSend, attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { AgentFindWidget, CONTEXT_IN_AGENT_INPUT, IAgentFindHost } from './agentFindWidget.js';
import { AgentThreadView } from './agentThreadView.js';
import { AgentTooltip, formatAgentTooltipShortcut, setAgentTooltip } from '../chrome/agentTooltip.js';
import { OPEN_PULL_REQUEST_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { NEW_AGENT_SCHEDULE_COMMAND_ID, OPEN_AGENT_SCHEDULES_COMMAND_ID } from '../schedules/agentScheduleCommands.js';
import { createModeIcon, ModeIconId } from '../chrome/agentModeIcons.js';
import { showAgentPlusMenu } from '../composer/agentPlusMenu.js';
import { IVoltMenuHandle } from '../ui/menu/voltMenu.js';
import { AgentMentionController, IAgentDisplayMention, IAgentImageAttachment, IAgentMentionHost, browserMentionColor, cloneDisplayMentions, imageAttachmentsFromMentions, mentionIconClasses, videoDetail } from '../composer/agentMentions.js';
import { AgentImageStrip, formatImageSize, IAgentImageStripItem, imageThumbClass } from '../composer/agentImageAttachments.js';
import { AgentImageViewer, showAgentImageViewer } from '../composer/agentImageViewer.js';
import { VIDEO_EXTENSIONS } from '../composer/agentVideoAttachments.js';
import { fileChipDetail, isTextAttachment } from '../composer/agentFileAttachments.js';
import { AgentAttachmentStore, IAgentPreparedAttachment } from '../composer/agentAttachmentStore.js';
import { AgentVideoViewer, showAgentVideoViewer } from '../composer/agentVideoViewer.js';
import { MentionCodePreview } from '../composer/mentionCodePreview.js';
import { appendAgentScrollableList } from './agentScrollable.js';
import { dayjs } from '../chrome/dayjs.js';
import { createTableCopyIcon, flashCopyIconSuccess, renderAgentBlock, IBlockRenderContext } from '../blocks/agentBlockRenderers.js';
import { AgentSegment, IAgentActivityItem, IPlanBlock, SupervisionKind } from '../blocks/agentBlocks.js';
import { createdPlanPrompt, IRunEndTray, ITurnFileChange, PLANNING_PHRASE, runEndTray, STATUS_ROTATE_MS, STATUS_SWAP_MS, streamingActivityLines, SupervisionAction, supervisionActions, supervisionTitle, todoChecklist, turnFileChanges } from '../chrome/agentTimeline.js';
import { AgentTurnFilesTree } from './agentTurnFilesTree.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../../browser/labels.js';
import { chooseFileChangeDiffStyle } from '../review/fileChangePreviewModel.js';

/** The Compact context chip shows once only this much of the window is left: 2%. */
const COMPACT_CHIP_PERCENT = 98;

/** A prompt the user sent opens an exchange (its card pins); a subagent report stays in the one above. */
function startsExchange(message: IAgentMessage): boolean {
	return message.kind === 'user' && message.origin !== 'notification';
}

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
/** Rendered threads kept for chats you switched away from, so switching back skips the rebuild. */
const MAX_STASHED_THREADS = 8;
/** Shows the pane even if the first chat's history never finishes loading. */
const RESTORE_REVEAL_TIMEOUT_MS = 1500;

/** A chat's rendered thread, parked while another chat has the pane. */
interface IStashedThread {
	readonly input: AgentEditorInput;
	readonly messages: IAgentMessage[];
	readonly nodes: DocumentFragment;
	readonly settled: DisposableStore;
	readonly tail: DisposableStore;
	readonly tailExchange: HTMLElement | undefined;
	readonly tailFrom: number;
	readonly renderedCount: number;
	/** The chat changed while parked (a run kept going); its last exchange needs a redraw. */
	stale: boolean;
	readonly watch: DisposableStore;
}

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
	const el = $('span.volt-agent-svg-icon.copy');
	const doc = el.ownerDocument;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
	rect.setAttribute('width', '14');
	rect.setAttribute('height', '14');
	rect.setAttribute('x', '8');
	rect.setAttribute('y', '8');
	rect.setAttribute('rx', '2');
	rect.setAttribute('ry', '2');
	const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
	svg.appendChild(rect);
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createForkIcon(): HTMLElement {
	return createSvgIcon(
		'0 0 24 24',
		'M3 3L10.6575 9.80663C11.5114 10.5657 12 11.6537 12 12.7963V22M3 3V9M3 3H9M21 3L15 9M21 3V9M21 3H15',
		'fork',
		true,
		'1',
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

export interface IAgentUserMessage {
	kind: 'user';
	/** Turn id shared with the reply; also the key in durable history. */
	id?: string;
	text: string;
	agentText?: string;
	chips?: string[];
	mentions?: IAgentDisplayMention[];
	promptExpanded?: boolean;
	/** The mode the prompt ran in, so Try again repeats it even after the composer's mode changed. */
	mode?: string;
	/**
	 * Not typed by the user: `notification` is Volt waking the chat with its subagents' reports,
	 * `brief` is the task another chat delegated to this one. Drawn as a card, not a bubble.
	 */
	origin?: 'notification' | 'brief';
	/** `notification`: the subagent tasks whose reports it carries. */
	taskIds?: string[];
	/** The chat moved to another model before this turn: drawn as a "Context handoff" divider above it. */
	handoff?: { fromLabel?: string; toLabel: string; at: number; by: 'agent' | 'user'; reason?: string };
	/** Sent by a scheduled task, not typed now: drawn with a "Scheduled" divider above it. */
	scheduled?: { id: string; title: string };
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
	/** While streaming: the step the agent is on ("Explored available tools") and how many came before it in its group. */
	activity?: { text: string; more: number };
}

/**
 * The browser dock's collapsed pill: the live step from the transcript ("Explored available
 * tools +2"), or the run's status when it is pinned ("Waiting for approval") or no step shows yet.
 */
function dockActivity(message: IAgentAssistantMessage, status: string): { text: string; more: number } {
	if (message.activity?.statusPinned) {
		return { text: status, more: 0 };
	}
	const rows = buildTranscriptRows(message.segments, message.text, true, message.steers);
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (row.kind === 'steps' && row.steps.length) {
			const step = row.steps[row.steps.length - 1];
			return { text: [step.action, step.detail].filter(Boolean).join(' '), more: row.steps.length - 1 };
		}
		if (row.kind === 'thought') {
			return { text: [row.step.action, row.step.detail].filter(Boolean).join(' '), more: 0 };
		}
		if (row.kind === 'markdown' && i === rows.length - 1) {
			break;
		}
	}
	return { text: status, more: 0 };
}

export interface IAgentActivity {
	status: string;
	/** When set, the live line keeps this status instead of rotating back to "Thinking". */
	statusPinned?: boolean;
	expanded: boolean;
	streaming: boolean;
	items: IAgentActivityItem[];
	thinkingText?: string;
	shimmerStartedAt?: number;
	/** When the run last reported anything; a long silence reads "Taking longer than expected". */
	lastEventAt?: number;
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
	/** The runtime run that produced this reply; Cursor's error tray calls it the request id. */
	runId?: string;
	/** How the run ended. Undefined while running and for replies recorded before it existed. */
	outcome?: 'done' | 'failed' | 'stopped';
	/** The run's last error, shown verbatim in the failed turn's tray. */
	failure?: { message: string; retryable?: boolean };
	/** Messages the user steered the running agent with, and where in the reply they landed. */
	steers?: ITranscriptSteer[];
}

/** A prompt waiting behind the running turn. It keeps the mode it was queued in. */
interface IQueuedAgentPrompt {
	id: string;
	text: string;
	display?: IAgentPromptDisplay;
	mode?: string;
}

/** Cursor's checkpoint dialogs remember "Don't ask again" per kind. */
const RESTORE_CHECKPOINT_NO_CONFIRM_KEY = 'voltAgent.checkpoint.restoreNoConfirm';
/** The end-of-turn "N Files Changed" card lists files as a tree instead of flat. */
const TURN_FILES_TREE_KEY = 'voltAgent.turnFiles.tree';
const REVERT_ON_EDIT_ALWAYS_KEY = 'voltAgent.checkpoint.revertOnEditAlways';

/** Checkpoint commands registered by the checkpoint service; the UI hides itself while they are missing. */
const CHECKPOINT_RESTORE_COMMAND = 'voltAgent.checkpoint.restore';
const CHECKPOINT_HAS_CHANGES_COMMAND = 'voltAgent.checkpoint.hasChangesSince';
const CHECKPOINT_REDO_COMMAND = 'voltAgent.checkpoint.redo';

/** A chat that stays open this long gets its agent started, so the first send skips the cold start. */
const PREWARM_ON_OPEN_MS = 400;

export type IAgentMessage = IAgentUserMessage | IAgentAssistantMessage;

interface IModeOption {
	id: string;
	label: string;
	icon: ModeIconId;
	keybinding?: string;
	description?: string;
}

/** Least time between two streaming redraws of the live exchange. */
const STREAM_FRAME_MS = 50;

/** Model silence (no tool running) after which the live line says the turn is taking longer than expected, as Cursor does. */
const SLOW_TURN_MS = 90_000;

/** Supervisor tray buttons. Cursor's looping tray has none; these give the user a way forward. */
const SUPERVISION_ACTION_LABELS: Record<SupervisionAction, { readonly label: () => string; readonly tooltip: () => string }> = {
	continueDifferently: {
		label: () => localize('voltAgent.continueDifferently', "Continue differently"),
		tooltip: () => localize('voltAgent.continueDifferently.hint', "Tell the agent to stop repeating itself and try another way"),
	},
	resume: {
		label: () => localize('voltAgent.resume', "Resume"),
		tooltip: () => localize('voltAgent.resume.stallHint', "Stop the quiet turn and ask the agent to continue"),
	},
	continue: {
		label: () => localize('voltAgent.continue', "Continue"),
		tooltip: () => localize('voltAgent.continue.hint', "Keep going from where the run paused"),
	},
	stop: {
		label: () => localize('voltAgent.stop', "Stop"),
		tooltip: () => localize('voltAgent.stop.hint', "Stop the agent"),
	},
};

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

export class AgentEditor extends EditorPane implements IAgentFindHost {

	static readonly ID = AgentEditorInput.EditorID;

	private container!: HTMLElement;
	private editorMainEl!: HTMLElement;
	private threadView!: AgentThreadView;
	private turnNav!: AgentTurnNav;
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
	private questionTray!: AgentQuestionTray;
	private composerChips!: AgentComposerChips;
	private pendingChanges!: AgentPendingChanges;
	private readonly freshText = new FreshTextTracker();
	private readonly suggestListeners = this._register(new DisposableStore());
	private sendKind: 'mic' | 'send' = 'mic';
	private submitting = false;
	private cloneBanner: HTMLElement | undefined;
	private waitingForClone: string | undefined;
	/** Prompts reach the orchestrator in the order they were sent, even when freezing one takes longer. */
	private submitChain: Promise<unknown> = Promise.resolve();
	private subagentBar!: HTMLElement;
	private readonly subagentBarStore = this._register(new DisposableStore());
	private subagentBarKey = '';
	/** The agent handoff the composer's model already followed. */
	private followedHandoffAt: number | undefined;
	private displayCodec: AgentHistoryCodec | undefined;
	/** A queued prompt loaded into the composer for editing, and the draft it replaced. */
	private queueEdit: { readonly id: string; readonly stash: { readonly text: string; readonly mentions: IAgentDisplayMention[] } } | undefined;
	/** Arrow Up/Down through earlier prompts. */
	private readonly promptHistory = new AgentPromptHistoryNavigator();
	/** The checkpoint the user just restored; its message offers "Redo checkpoint" until the next send. */
	private restoredCheckpoint: { readonly turnId: string } | undefined;
	private prewarmTimer: IDisposable | undefined;
	/** An edited prompt is waiting on the "Revert files to this message?" dialog. */
	private committingEdit = false;
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
	private plusMenu: IVoltMenuHandle | undefined;
	private eventDisposable: IDisposable | undefined;
	private renderHandle: number | undefined;
	/** The pane width at the last layout; a prompt's clamp is measured once per width. */
	private layoutWidth = 0;
	private readonly promptClamps = new WeakMap<IAgentUserMessage, { readonly width: number; readonly text: string; readonly multiline: boolean; readonly clamped: boolean }>();
	/** A streaming redraw waiting out {@link STREAM_FRAME_MS} since the last one. */
	private renderDelay: IDisposable | undefined;
	/** Redraws a quiet, non-rotating live line when it should start reading "Taking longer than expected". */
	private slowTurnTimer: IDisposable | undefined;
	private lastTailRenderAt = 0;
	private findWidget!: AgentFindWidget;
	private findMatches: HTMLElement[] = [];
	private currentFindIndex = 0;
	private composerZoomed = false;
	private composerHeight: number | undefined;
	private inputLayoutInProgress = false;
	private sessionTokensUsed: number | undefined;
	private sessionTokensWindow: number | undefined;
	private toolbarLayoutHandle: number | undefined;
	private stickToBottom = true;
	/** Listeners of the turn being rendered. Points at `tailListeners` while the last exchange renders. */
	// eslint-disable-next-line local/code-no-potentially-unsafe-disposables -- replaced when a thread is stashed
	private settledListeners = new DisposableStore();
	/** The last exchange (user turn and reply) owns its own listeners so it can be redrawn alone. */
	// eslint-disable-next-line local/code-no-potentially-unsafe-disposables -- replaced when a thread is stashed
	private tailListeners = new DisposableStore();
	/** clearInput ran and no setInput has followed yet. */
	private clearTeardownPending = false;
	/** The chat whose turns are in `threadInner`. */
	private threadInput: AgentEditorInput | undefined;
	/** Least recently shown first. */
	private readonly stashedThreads = new Map<string, IStashedThread>();
	private renderingTail = false;
	private get threadListeners(): DisposableStore {
		return this.renderingTail ? this.tailListeners : this.settledListeners;
	}
	private tailExchange: HTMLElement | undefined;
	private tailFrom = -1;
	private renderedCount = 0;
	private readonly thinkingStore = this._register(new DisposableStore());
	private readonly exploreHitsTooltip = this._register(new AgentTooltip());
	private readonly markdownRenderer: MarkdownRenderer;
	private mentionPreview: MentionCodePreview | undefined;
	private clockTimer: IDisposable | undefined;
	private statusRotateTimer: IDisposable | undefined;
	private readonly statusMotion = new Map<string, { text: string; from?: string; started?: number }>();
	/** Replies that streamed in this editor: their "Worked for" fold starts open, as Cursor's does right after a run. */
	private readonly liveTurns = new WeakSet<IAgentAssistantMessage>();
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
	private openedPreviewUrl: string | undefined;
	private surfaceHost!: AgentSurfaceHost;
	private landingChrome: AgentLandingChrome | undefined;
	private restoringChat = false;
	private chatSaveTimer: number | undefined;
	private snapshotOverlay: HTMLElement | undefined;
	/** Redraws each "N Files Changed" card on screen, after the list / tree toggle. */
	private readonly turnFilesCards = new Set<() => void>();
	private readonly turnFileLabels: ResourceLabels;
	private readonly snapshotStore = this._register(new DisposableStore());
	private readonly _onDidChangeDock = this._register(new Emitter<void>());
	readonly onDidChangeDock: Event<void> = this._onDidChangeDock.event;
	private readonly _onDidComposerSend = this._register(new Emitter<void>());
	readonly onDidComposerSend: Event<void> = this._onDidComposerSend.event;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITextResourceConfigurationService private readonly textResourceConfigurationService: ITextResourceConfigurationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@ILogService private readonly logService: ILogService,
		@IAgentSessionChangesService private readonly sessionChanges: IAgentSessionChangesService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltProjectsService private readonly voltProjects: IVoltProjectsService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
	) {
		super(AgentEditor.ID, group, telemetryService, themeService, storageService);
		this.markdownRenderer = this.instantiationService.createInstance(MarkdownRenderer, {});
		this.turnFileLabels = this._register(this.instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		// KaTeX and the diagram renderer load lazily; once math is ready, redraw replies written before it.
		void preloadMarkdownExtras(mainWindow).then(() => {
			if (this.container?.isConnected) {
				this.renderThread(this.stickToBottom);
			}
		});
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
		this._register(this.sessionContext.onDidChangeActiveProject(() => {
			this.renderSuggestChips();
			this.updateSendButton();
			this.renderCloneBanner();
		}));
		this._register(this.voltProjects.onDidChange(() => this.renderCloneBanner()));
		this._register(this.sessionContext.onDidChangeProjects(() => {
			this.renderSuggestChips();
			this.updateSendButton();
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.classList.add('volt-agent-editor-instance');
		this.container = append(parent, $('.volt-agent-editor'));
		this.container.dataset.mode = normalizeVoltMode(this.currentMode);
		// Until the first chat's history is read the thread is empty, which lays out the
		// new-chat landing for a few frames before the conversation replaces it.
		this.container.classList.add('restoring');
		this._register(disposableTimeout(() => this.container.classList.remove('restoring'), RESTORE_REVEAL_TIMEOUT_MS));
		this._register(new DragAndDropObserver(parent, {
			onDragEnter: e => {
				this.blockWorkbenchFileDrop(e);
				this.surfaceHost?.onDragOver(e);
			},
			onDragOver: e => {
				this.blockWorkbenchFileDrop(e);
				this.surfaceHost?.onDragOver(e);
			},
			onDragLeave: () => this.surfaceHost?.clearDropFeedback(),
			onDragEnd: () => this.surfaceHost?.clearDropFeedback(),
			onDrop: e => {
				this.blockWorkbenchFileDrop(e);
				// Tabs and terminals dropped beside the chat, or anything dropped on its tools, open as tools.
				if (this.surfaceHost?.handleDrop(e)) {
					return;
				}
				if (this.editingUserIndex !== undefined && isHTMLElement(e.target) && e.target.closest('.volt-agent-edit-slot')) {
					void this.editMentionController?.handleExternalDrop(e);
					return;
				}
				this.ensureInputEditor();
				void this.mentionController?.handleExternalDrop(e);
			}
		}));
		this.bindAttachDrop();
		this.threadView = this._register(new AgentThreadView());
		this.threadEl = this.threadView.element;
		this.threadInner = this.threadView.inner;
		// `has-turns` stands in for `.volt-agent-editor:has(.volt-agent-turn)`: a :has() on the chat restyles
		// all of it whenever the transcript adds a node, which made scrolling and streaming slow.
		// Exchanges are the thread's children and each gets its turn as it is added.
		const syncHasTurns = () => this.container.classList.toggle('has-turns', !!this.threadInner.querySelector('.volt-agent-turn'));
		const turnsObserver = new MutationObserver(syncHasTurns);
		turnsObserver.observe(this.threadInner, { childList: true });
		this._register(toDisposable(() => turnsObserver.disconnect()));
		syncHasTurns();
		this.threadScroll = this.threadView.scroll;
		this.turnNav = this._register(new AgentTurnNav(this.threadView));
		this._register(new AgentThreadSelectionActions(this.threadEl, {
			isVisible: () => this.isVisible(),
			onAddToChat: text => this.addChatSelection(text, this.sessionKey),
			onAddToSideChat: text => void this.addChatSelectionToSideChat(text),
		}));
		this.editorMainEl = append(this.container, $('.volt-agent-editor-main'));
		this.surfaceHost = this._register(this.instantiationService.createInstance(AgentSurfaceHost, this.container, this.editorMainEl));
		append(this.editorMainEl, this.threadEl);
		this.threadView.rememberHome();
		const quickOpen = getWindow(this.container).document.querySelector('.volt-agent-quick-open-actions');
		if (isHTMLElement(quickOpen)) {
			mountAgentQuickOpenActions(this.threadScroll.getDomNode(), quickOpen);
		}
		this.applyCodeFont();
		this._register(this.threadScroll.onScroll(e => {
			if (!this.threadScrollFrozen && !this.applyingEditPin) {
				// The reply grew under a reader at the end: the follow scroll lands next. Until then this is
				// not a scroll up, or the arrow blinks in and out with every streamed line.
				const grewAtEnd = this.stickToBottom && !e.scrollTopChanged && e.scrollHeightChanged;
				this.stickToBottom = grewAtEnd || e.scrollTop + e.height >= e.scrollHeight - 32;
				// Empty chats and a reader already at the end get no jump-back arrow.
				this.composerChips?.setScrolledUp(!grewAtEnd && shouldOfferScrollToBottom(this.messages.length > 0, e.scrollHeight - (e.scrollTop + e.height)));
				if (!this.restoringChat) {
					this.scheduleChatSave();
				}
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
		threadResizeObserver.observe(this.threadInner);
		this._register(toDisposable(() => threadResizeObserver.disconnect()));
		this._register(addDisposableListener(getWindow(this.container), 'pointerdown', e => this.onEditPointerDown(e), true));
		this._register(addDisposableListener(this.threadInner, 'click', e => this.onUserMessageClick(e)));
		this._register(addDisposableListener(getWindow(this.container), 'keydown', e => {
			if (e.key === 'Escape' && this.editingUserIndex !== undefined) {
				e.preventDefault();
				this.cancelUserEdit();
			}
		}, true));
		this.composerEl = append(this.editorMainEl, $('.volt-agent-composer'));
		this.composerQueue = this._register(this.instantiationService.createInstance(AgentComposerQueue, {
			onRemove: id => this.removeQueuedPrompt(id),
			onClear: () => this.clearPromptQueue(),
			onMultitask: () => this.setMode('Multitask'),
			onReorder: ids => this.reorderQueuedPrompts(ids),
			onEdit: id => this.editQueuedPrompt(id),
			onSendNow: id => this.sendQueuedNow(id),
			onResume: () => this.resumeQueue(),
			onCancelEdit: () => this.cancelQueueEdit(),
			onOpenAgent: view => this.openSubagent(view.key),
			onStopAgent: view => void this.orchestrator.dispatch({ type: 'task.cancel', taskId: view.key, reason: 'The user stopped it.' }),
			onStopAllAgents: () => this.stopAllSubagents(),
		}));
		// The dock beside a follow-up chat lists its finished agents while it is open; the card above
		// the composer then shows only the working ones. The dock puts its state on this chat as classes.
		const syncAgentsInDock = () => {
			const classes = this.container.classList;
			this.composerQueue?.setAgentsInDock(classes.contains('follow-up') && classes.contains('has-quick-open') && classes.contains('quick-open-expanded')
				&& !classes.contains('quick-open-user-hidden') && !classes.contains('has-surfaces'));
		};
		const dockObserver = new MutationObserver(syncAgentsInDock);
		dockObserver.observe(this.container, { attributes: true, attributeFilter: ['class'] });
		this._register(toDisposable(() => dockObserver.disconnect()));
		syncAgentsInDock();
		this._register(this.orchestrator.onDidChange(change => {
			if (change.threads.includes(this.sessionKey)) {
				this.followAgentHandoff();
				this.syncQueueStack();
				this.updateSendButton();
				// Subagent rows and report cards read live task state.
				if (change.tasks.length) {
					this.scheduleThreadRender();
				}
			}
		}));
		// "Open parent" shows only while the parent chat has no tab.
		this._register(this.editorService.onDidEditorsChange(() => this.renderSubagentBar()));
		this.composerChips = this._register(this.instantiationService.createInstance(AgentComposerChips, {
			onChangesClick: () => void this.openSessionChanges(),
			onTerminalClick: () => this.surfaceHost.openTerminal(),
			onScrollToBottom: () => this.scrollThreadToEnd(),
			onCompactClick: () => this.compactContext(),
			onStatusClick: () => this.scrollThreadToEnd(),
		}));
		append(this.composerEl, this.composerChips.element);
		// The same run status chip the browser's dock shows ("Waiting for approval", "Worked 2m").
		this._register(this.onDidChangeDock(() => this.syncStatusChip()));
		this.pendingChanges = this._register(this.instantiationService.createInstance(AgentPendingChanges, {
			onOpenFile: file => this.openPendingFile(file),
			onReview: () => this.surfaceHost.openChanges('pending'),
		}));
		if (MINI_FILE_DIFF_VIEWER_ENABLED) {
			append(this.composerEl, this.pendingChanges.element);
		}
		this.landingChrome = this._register(this.instantiationService.createInstance(AgentLandingChrome, (folder: URI) => this.openLandingProject(folder)));
		append(this.composerEl, this.landingChrome.element);
		const answerFiles = this.instantiationService.createInstance(AgentAttachmentStore);
		this.questionTray = this._register(new AgentQuestionTray({
			onSubmit: (requestId, response, media) => void this.answerQuestions(requestId, response, media),
			onLayout: () => this.layoutInputEditor(),
			attachments: {
				pickFiles: () => answerFiles.pickFiles(this.sessionContext.activeProject?.root),
				prepare: source => answerFiles.prepare(source),
			},
		}));
		append(this.composerEl, this.questionTray.element);
		this._register(this.runtime.onDidChangeQuestions(sessionId => {
			if (sessionId === this.sessionKey) {
				this.syncQuestionTray();
			}
		}));
		// While the agent waits on questions, a letter typed into the empty composer picks that option.
		this._register(addDisposableListener(getWindow(this.container), 'keydown', e => {
			if (!this.questionTray.active || this.inputModel?.getValue() || !this.isVisible()) {
				return;
			}
			const target = e.target as HTMLElement | null;
			const doc = this.container.ownerDocument;
			if (target && target !== doc.body && !this.monacoHost.contains(target)) {
				return;
			}
			if (this.questionTray.handleKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}, true));
		this.cloneBanner = append(this.composerEl, $('.volt-agent-clone-banner.hidden'));
		this.cloneBanner.setAttribute('role', 'status');
		this.renderCloneBanner();
		// A subagent's chat says whose it is and how it is doing, above everything else on the composer.
		this.subagentBar = append(this.composerEl, $('.volt-agent-subagent-bar.hidden'));
		// Subagents and queued prompts sit right on top of the text area, under the chips (Cursor).
		append(this.composerEl, this.composerQueue.element);
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
			delay: 4000,
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
			// Above the Changes / Commit & Push chips, which stay on the composer.
			getPanelAnchor: () => ({ parent: this.composerEl, before: this.composerChips.element }),
			getBranch: () => this.statusBranch(),
			onWillOpenPanel: () => this.hidePlusMenu(),
			getCompactState: () => this.compactState(),
			compact: () => this.compactContext(),
			// Nearly out of room: offer Compact context as a chip beside Changes.
			onDidRefresh: percent => {
				const state = percent >= COMPACT_CHIP_PERCENT ? this.compactState() : undefined;
				this.composerChips?.setCompactOffered(!!state && !state.blockedReason);
			},
		}));
		append(this.composerEl, this.contextUsageView.element);
		this._register(this.landingChrome.onDidChangeBranch(() => this.contextUsageView.refreshBranch()));
		// The first send in Worktree mode makes the checkout just before the run starts.
		this._register(this.runtime.onDidEmit(e => {
			if (e.sessionId === this.sessionKey && (e.event.type === 'run.start' || e.event.type === 'notice')) {
				this.contextUsageView.refreshBranch();
			}
		}));
		this.suggestEl = append(this.composerEl, $('.volt-agent-suggest'));
		this.renderSuggestChips();

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
			if (!this.composerCanSend()) {
				return;
			}
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

	private scheduleChatSave(): void {
		const sessionId = this.sessionKey;
		if (!sessionId || !this.surfaceHost) {
			return;
		}
		const scrollTop = this.threadScroll?.getScrollPosition().scrollTop;
		const win = getWindow(this.container);
		if (this.chatSaveTimer !== undefined) {
			win.clearTimeout(this.chatSaveTimer);
		}
		this.chatSaveTimer = win.setTimeout(() => {
			this.chatSaveTimer = undefined;
			this.surfaceHost.rememberChat(sessionId, { followTail: this.stickToBottom, scrollTop });
		}, 200);
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
		input.queueExpanded = this.queuedItems.length > 0;
		input.scheduleDraftSave();
	}

	private restoreInputState(input: AgentEditorInput): void {
		this.clearFindHighlights();
		this.stashThread();
		this.thinkingStore.clear();
		this.messages = input.messages;
		this.sessionTokensUsed = input.contextUsed;
		this.sessionTokensWindow = input.contextWindow;
		this.editingUserIndex = undefined;
		this.queueEdit = undefined;
		this.promptHistory.reset();
		this.restoredCheckpoint = undefined;
		this.clearEditComposer();
		const chat = this.surfaceHost.chatView(input.sessionId);
		const followTail = chat.followTail !== false;
		this.stickToBottom = followTail;
		this.restoringChat = true;
		// A chat keeps its own mode; a new one starts in Agent, as Cursor's do, not in the last chat's Debug or Plan.
		const savedMode = input.chosenMode ?? input.restoredMode;
		const mode = (savedMode && MODE_OPTIONS.find(item => item.id.toLowerCase() === savedMode.toLowerCase())?.id) || MODE_OPTIONS[0].id;
		if (mode !== this.currentMode) {
			this.currentMode = mode;
			this.updateModeButton();
			this.updateInputPlaceholder();
			this.composerQueue?.setMode(mode);
		}
		this.syncComposerPlacement();
		const stashed = this.adoptStashedThread(input);
		if (!stashed || (stashed.stale && !this.canRenderTail())) {
			this.renderThread(followTail);
		} else {
			if (stashed.stale) {
				this.renderThreadTail(followTail);
			}
			this.finishThreadRender(followTail);
			this.tickMeta();
		}
		this.threadInput = input;
		if (!followTail && chat.scrollTop !== undefined) {
			this.threadScroll.setScrollPosition({ scrollTop: chat.scrollTop });
		}
		this.restoringChat = false;
		if (this.inputModel && this.inputModel.getValue() !== input.draft) {
			this.inputModel.setValue(input.draft);
		}
		this.mentionController?.restoreMentions(input.draftMentions);
		this.setComposerZoomed(input.composerZoomed);
		this.migrateDraftQueue(input);
		this.syncQueueStack();
		this.updateSendButton();
		input.setHasUnsavedContent(!!input.draft.trim());
		this.updateInputPlaceholder();
		this.refreshContextUsage();
	}

	private inputPlaceholderText(): string {
		if (this.questionTray?.active) {
			return localize('voltAgent.questionDetailsPlaceholder', "Add more optional details...");
		}
		if (this.queueEdit) {
			return localize('voltAgent.queue.editingPlaceholder', "Editing queued message...");
		}
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
		this.plusMenu?.dispose();
		this.plusMenu = undefined;
	}

	private showPlusMenu(source: 'main' | 'edit' = 'main'): void {
		if (this.plusMenu) {
			this.hidePlusMenu();
			return;
		}
		this.tooltip.hide();
		this.contextUsageView?.hidePanel();
		const edit = source === 'edit' && !!this.editInputBox;
		const anchor = edit && this.editInputBox ? this.editInputBox : this.inputBox;
		const focusComposer = () => edit ? this.editEditor?.focus() : this.inputEditor?.focus();
		const selected = this.selectedModel();
		const handle: IVoltMenuHandle = showAgentPlusMenu(this.contextViewService, {
			anchor,
			modes: MODE_OPTIONS.filter(option => option.id !== 'Agent'),
			currentMode: this.currentMode,
			actions: edit ? ['files', 'attachFile', 'image', 'video', 'openFile', 'terminal', 'browser', 'model', 'mcp'] : ['files', 'attachFile', 'image', 'video', 'openFile', 'terminal', 'browser', 'model', 'mcp', 'schedule'],
			modelName: this.modelAuto
				? localize('voltAgent.auto', "Auto")
				: selected
					? [this.modelPicker.modelProviderLabel(selected), selected.name].filter(Boolean).join(' ') || undefined
					: undefined,
			onMode: id => {
				this.setMode(id);
				focusComposer();
			},
			onAction: action => {
				switch (action) {
					case 'files':
						if (edit) {
							this.ensureEditComposer();
							this.editMentionController?.openFilePicker();
						} else {
							this.ensureInputEditor();
							this.mentionController?.openFilePicker();
						}
						focusComposer();
						return;
					case 'image':
					case 'video':
					case 'attachFile':
						void this.pickMedia(edit, action);
						return;
					case 'openFile':
						void this.surfaceHost.openFileFromDialog();
						return;
					case 'terminal':
						this.surfaceHost.openTerminal();
						return;
					case 'browser':
						this.surfaceHost.openBrowser();
						return;
					case 'model':
						scheduleAtNextAnimationFrame(getWindow(anchor), () => this.showModelDropdown(edit ? this.editModelButton : this.modelButton));
						return;
					case 'mcp':
						void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
						return;
					case 'schedule':
						// The composer's text becomes the scheduled prompt; runs go to this chat by default.
						void this.commandService.executeCommand(NEW_AGENT_SCHEDULE_COMMAND_ID, {
							threadId: this.sessionKey,
							prompt: this.inputModel?.getValue().trim() || undefined,
							mode: this.currentMode,
						});
						return;
				}
			},
			onHide: () => {
				if (this.plusMenu === handle) {
					this.plusMenu = undefined;
				}
			},
		});
		this.plusMenu = handle;
	}

	/** "+" > Image / Video / File...: pick files from disk and attach them at the cursor. */
	private async pickMedia(edit: boolean, kind: 'image' | 'video' | 'attachFile'): Promise<void> {
		const resources = await this.fileDialogService.showOpenDialog({
			title: kind === 'video' ? localize('voltAgent.pickVideosTitle', "Attach Videos")
				: kind === 'image' ? localize('voltAgent.pickImagesTitle', "Attach Images")
					: localize('voltAgent.pickFilesTitle', "Attach Files"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			defaultUri: this.sessionContext.activeProject?.root ?? await this.fileDialogService.defaultFilePath(),
			filters: kind === 'video'
				? [{ name: localize('voltAgent.videoFilter', "Videos"), extensions: [...VIDEO_EXTENSIONS] }]
				: kind === 'image'
					// HEIC photos are converted to JPEG on the way in.
					? [{ name: localize('voltAgent.imageFilter', "Images"), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'] }]
					: undefined,
		});
		if (!resources?.length) {
			return;
		}
		if (edit) {
			this.ensureEditComposer();
			await this.editMentionController?.addAttachmentFiles(resources);
			this.editEditor?.focus();
		} else {
			this.ensureInputEditor();
			await this.mentionController?.addAttachmentFiles(resources);
			this.inputEditor?.focus();
		}
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
		const chips = agentEmptyComposerChips({
			mode: this.currentMode,
		});
		for (const chipSpec of chips) {
			const chip = append(this.suggestEl, $('button.volt-agent-suggest-chip')) as HTMLButtonElement;
			append(chip, $('span.label')).textContent = chipSpec.label;
			if (chipSpec.kb) {
				append(chip, $('span.kb')).textContent = chipSpec.kb;
			}
			this.suggestListeners.add(addDisposableListener(chip, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				switch (chipSpec.id) {
					case 'plan':
						this.setMode('Plan');
						return;
					case 'multitask':
						this.setMode('Multitask');
						return;
					default: {
						const unexpected: never = chipSpec.id;
						return unexpected;
					}
				}
			}));
		}
	}

	private composerCanSend(): boolean {
		return agentComposerCanSend(this.sessionContext, this.sessionKey, this.history.get(this.sessionKey));
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
			const iconClasses = mention.kind === 'image' && mention.image
				? ['volt-agent-mention-thumb', imageThumbClass(mention.image.bytes, mention.image.mime)]
				: mention.kind === 'video' && mention.video?.poster
					? ['volt-agent-mention-thumb', imageThumbClass(mention.video.poster, 'image/jpeg')]
					: mentionIconClasses(mention, this.modelService, this.languageService);
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
			if (mention.kind === 'image' && mention.image) {
				append(chip, $('span.volt-agent-mention-size')).textContent = formatImageSize(mention.image.bytes.byteLength);
			} else if (mention.kind === 'video' && mention.video) {
				append(chip, $('span.volt-agent-mention-size')).textContent = videoDetail(mention.video);
			} else if (mention.file) {
				append(chip, $('span.volt-agent-mention-size')).textContent = fileChipDetail(mention.file);
			}
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
			} else if ((mention.kind === 'image' && mention.image) || (mention.kind === 'video' && mention.video)) {
				const mediaIndex = userMessageMedia(message).indexOf(mention);
				chip.setAttribute('data-open', 'true');
				this.threadListeners.add(addDisposableListener(chip, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.openMessageMedia(message, mediaIndex);
				}));
			} else if (mention.resource && (mention.kind === 'file' || mention.kind === 'image')) {
				const resource = URI.revive(mention.resource);
				// An attached PDF or archive opens in its own app; text and project files beside the chat.
				const external = !!mention.file && !isTextAttachment(mention.file.name, mention.file.mime);
				chip.setAttribute('data-open', 'true');
				this.threadListeners.add(addDisposableListener(chip, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					if (external) {
						void this.instantiationService.invokeFunction(accessor => accessor.get(IOpenerService).open(resource, { openExternal: true }));
					} else {
						this.surfaceHost.openFile(resource);
					}
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

	/** A sent prompt's images and videos, large and read-only. */
	private openMessageMedia(message: IAgentUserMessage, mediaIndex: number): void {
		const target = userMessageMedia(message)[mediaIndex];
		const video = target?.kind === 'video' ? target.video : undefined;
		if (target && video) {
			const videos = userMessageMedia(message).filter(mention => mention.kind === 'video');
			showAgentVideoViewer(options => this.instantiationService.createInstance(AgentVideoViewer, options), {
				anchor: this.container,
				title: localize('voltAgent.attachedVideoTitle', "Attached video {0}", videos.indexOf(target) + 1),
				name: target.label,
				mime: video.mime,
				bytes: video.bytes,
				path: video.path,
			});
			return;
		}
		const images = userMessageMedia(message).filter(mention => mention.kind === 'image');
		const index = target ? images.indexOf(target) : -1;
		if (index < 0) {
			return;
		}
		showAgentImageViewer(options => this.instantiationService.createInstance(AgentImageViewer, options), {
			anchor: this.container,
			index,
			images: images.map((mention, i) => ({
				name: mention.label,
				title: localize('voltAgent.attachedImageTitle', "Attached image {0}", i + 1),
				bytes: mention.image!.bytes,
				mime: mention.image!.mime,
			})),
		});
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
			onBuildPlan: () => this.setMode('Agent'),
			onBuildCreatedPlan: plan => this.buildCreatedPlan(plan),
			streaming: !!message.activity?.streaming,
			languageService: this.languageService,
			onExpandDiagram: svg => this.showDiagramPreview(svg),
		};
	}

	private flashTableCopyButton(anchor: HTMLElement): void {
		const slot = anchor.querySelector<HTMLElement>('.volt-agent-table-copy-icon');
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
		this.settledListeners.clear();
		this.tailListeners.clear();
		this.renderingTail = false;
		this.tailExchange = undefined;
		this.tailFrom = -1;
		this.renderedCount = this.messages.length;
		this.threadInner.replaceChildren();
		if (!this.messages.length) {
			this.editingUserIndex = undefined;
			this.clearEditComposer();
			this.sessionTokensUsed = undefined;
			this.sessionTokensWindow = undefined;
			this.turnNav.setTurns([]);
			this.composerChips?.setScrolledUp(false);
			this.syncComposerPlacement();
			this.refreshContextUsage();
			this.updateInputPlaceholder();
			this.layoutInputEditor();
			this.publishSessionChanges();
			this._onDidChangeDock.fire();
			return;
		}
		const tailFrom = this.lastExchangeStart();
		let exchange: HTMLElement | undefined;
		for (const [index, message] of this.messages.entries()) {
			if (startsExchange(message) || !exchange) {
				if (index === tailFrom) {
					this.renderingTail = true;
				}
				exchange = append(this.threadInner, $('.volt-agent-exchange'));
				if (index === tailFrom) {
					this.tailExchange = exchange;
					this.tailFrom = tailFrom;
				}
			}
			this.renderThreadMessage(exchange, message, index);
		}
		this.renderingTail = false;
		this.finishThreadRender(scrollToEnd);
	}

	/** Layout and bookkeeping once `threadInner` holds the whole thread, freshly built or taken back from the stash. */
	private finishThreadRender(scrollToEnd: boolean): void {
		this.turnNav.setTurns(this.navTurns());
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

	private renderThreadMessage(exchange: HTMLElement, message: IAgentMessage, index: number): void {
		const turn = append(exchange, $(`.volt-agent-turn.${message.kind}`));
		if (message.kind === 'user') {
			if (this.editingUserIndex === index) {
				turn.classList.add('editing');
				this.renderRedoCheckpoint(append(turn, $('.volt-agent-edit-slot')), message);
			} else if (message.origin === 'notification') {
				if (message.handoff) {
					this.renderHandoffDivider(turn, message.handoff);
				}
				this.renderNotificationTurn(turn, message);
			} else {
				if (message.handoff) {
					this.renderHandoffDivider(turn, message.handoff);
				}
				if (message.origin === 'brief') {
					this.renderSubagentOfPill(turn);
				}
				if (message.scheduled) {
					this.renderScheduledPill(turn, message.scheduled);
				}
				this.renderUserTurn(turn, message, index);
			}
		} else {
			this.renderAgentTurn(turn, message);
		}
	}

	/**
	 * Volt woke this chat with its subagents' reports: a quiet system row listing them (each opens
	 * its chat), not a bubble the user did not write.
	 */
	private renderNotificationTurn(turn: HTMLElement, message: IAgentUserMessage): void {
		turn.classList.add('notification');
		const row = append(turn, $('.volt-agent-notification-row'));
		const tasks = (message.taskIds ?? []).map(id => this.orchestrator.getTask(id)).filter((task): task is NonNullable<typeof task> => !!task);
		if (!tasks.length) {
			const head = append(row, $('.volt-agent-notification-head'));
			// A watched pull request woke the chat: its icon, and a click opens it.
			const prUrl = /^\[Volt\] (?:Update on|Volt stopped watching) pull request #\d+ \((https?:\/\/[^\s)]+)\)/.exec(message.agentText ?? '')?.[1];
			const restarted = (message.agentText ?? '').startsWith('[Volt] Volt restarted');
			head.appendChild(renderIcon(prUrl ? Codicon.gitPullRequest : restarted ? Codicon.debugRestart : Codicon.layers));
			append(head, $('span.volt-agent-notification-text')).textContent = message.text;
			if (prUrl) {
				head.classList.add('pull-request');
				setAgentTooltip(head, localize('voltAgent.notification.openPr', "Open the pull request"));
				this.threadListeners.add(addDisposableListener(head, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, prUrl, this.sessionKey);
				}));
			}
			return;
		}
		const list = append(row, $('.volt-agent-notification-list'));
		const now = Date.now();
		for (const task of tasks) {
			renderCursorSubagentRow(list, subagentView(agentRow(task), ref => this.providerOf(ref)), {
				store: this.threadListeners,
				now,
				tooltip: this.tooltip,
				// A report: the stack icon, no heading; a click opens the subagent's chat.
				mark: () => createReportStackIcon(list),
				onOpen: view => this.openSubagent(view.key),
			});
		}
	}

	/** "⇄ Context handoff · Claude Opus 5.5 → GPT-6": the chat moved to another model before this turn. */
	private renderHandoffDivider(turn: HTMLElement, handoff: NonNullable<IAgentUserMessage['handoff']>): void {
		const divider = append(turn, $('.volt-agent-handoff'));
		const pill = append(divider, $('span.volt-agent-handoff-pill'));
		pill.appendChild(renderIcon(Codicon.arrowSwap));
		append(pill, $('span.label')).textContent = localize('voltAgent.handoff', "Context handoff");
		if (handoff.fromLabel) {
			append(pill, $('span.from')).textContent = handoff.fromLabel;
			pill.appendChild(renderIcon(Codicon.arrowRight));
		}
		append(pill, $('span.to')).textContent = handoff.toLabel;
		setAgentTooltip(pill, handoff.by === 'agent'
			? (handoff.reason ? localize('voltAgent.handoff.agentReason', "The agent handed the chat over: {0}", handoff.reason) : localize('voltAgent.handoff.agent', "The agent handed the chat over with a brief"))
			: localize('voltAgent.handoff.user', "You switched models; the conversation so far went with it"));
	}

	/** The top of a subagent's chat: whose subagent it is, a click away from the parent. */
	private renderSubagentOfPill(turn: HTMLElement): void {
		const thread = this.orchestrator.getThread(this.sessionKey);
		const parentId = thread?.parentId ?? this.history.sessionParent(this.sessionKey);
		if (!parentId) {
			return;
		}
		const parentTitle = this.history.get(parentId)?.title ?? this.orchestrator.getThread(parentId)?.title ?? localize('voltAgent.subagentOf.untitled', "its parent chat");
		const divider = append(turn, $('.volt-agent-subagent-of'));
		const pill = append(divider, $('span.volt-agent-subagent-of-pill'));
		pill.appendChild(renderIcon(Codicon.hubot));
		append(pill, $('span.label')).textContent = localize('voltAgent.subagentOf', "Subagent of");
		append(pill, $('span.parent')).textContent = `· ${parentTitle}`;
	}

	/** "Scheduled · Daily CI check" above a prompt a scheduled task sent; a click opens the task list. */
	private renderScheduledPill(turn: HTMLElement, scheduled: NonNullable<IAgentUserMessage['scheduled']>): void {
		const divider = append(turn, $('.volt-agent-subagent-of.scheduled'));
		const pill = append(divider, $('span.volt-agent-subagent-of-pill'));
		pill.appendChild(renderIcon(Codicon.history));
		append(pill, $('span.label')).textContent = localize('voltAgent.scheduledRun', "Scheduled");
		append(pill, $('span.parent')).textContent = `· ${scheduled.title}`;
		pill.setAttribute('role', 'button');
		pill.tabIndex = 0;
		setAgentTooltip(pill, localize('voltAgent.scheduledRun.open', "Sent by a scheduled task. Click to see your scheduled tasks."));
		this.threadListeners.add(addDisposableListener(pill, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(OPEN_AGENT_SCHEDULES_COMMAND_ID, scheduled.id);
		}));
	}

	/** The sent messages for the left rail; each reply is read only when its card opens. */
	private navTurns(): IAgentTurnNavTurn[] {
		const turns: IAgentTurnNavTurn[] = [];
		for (const [index, message] of this.messages.entries()) {
			if (message.kind !== 'user') {
				continue;
			}
			const next = this.messages[index + 1];
			turns.push({
				prompt: message.text.replace(/\s+/g, ' ').trim() || (message.chips ?? []).join(', '),
				reply: () => {
					if (next?.kind !== 'agent') {
						return undefined;
					}
					const markdown = next.segments.flatMap(segment => segment.kind === 'text' ? [segment.text] : []).join('\n\n') || next.text || '';
					return turnNavPreview(markdown) || undefined;
				},
			});
		}
		return turns;
	}

	/** Index of the message that starts the last exchange. */
	private lastExchangeStart(): number {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (startsExchange(this.messages[i])) {
				return i;
			}
		}
		return this.messages.length ? 0 : -1;
	}

	/**
	 * Streaming redraw: only the last exchange is rebuilt; everything above it keeps its DOM,
	 * its rendered markdown, and its highlighted code. Frame cost no longer grows with the
	 * length of the conversation. Anything structural falls back to a full render.
	 */
	private canRenderTail(): boolean {
		const exchange = this.tailExchange;
		return !!exchange && exchange.isConnected && this.renderedCount === this.messages.length && this.editingUserIndex === undefined && this.tailFrom === this.lastExchangeStart() && this.tailFrom >= 0;
	}

	private renderThreadTail(scrollToEnd: boolean): void {
		const exchange = this.tailExchange;
		if (!exchange || !this.canRenderTail()) {
			this.renderThread(scrollToEnd);
			return;
		}
		this.tailListeners.clear();
		this.renderingTail = true;
		const fresh = $('.volt-agent-exchange');
		try {
			for (let index = this.tailFrom; index < this.messages.length; index++) {
				this.renderThreadMessage(fresh, this.messages[index], index);
			}
		} finally {
			this.renderingTail = false;
		}
		exchange.replaceWith(fresh);
		this.tailExchange = fresh;
		this.syncThreadScroll(scrollToEnd);
		if (this.findWidget?.isVisible()) {
			this.applyFindHighlights(false);
		}
		this.refreshContextUsage();
		this.publishSessionChanges();
	}

	/** Parks the shown chat's thread (nodes and listeners) so showing it again is a DOM move, not a rebuild. */
	private stashThread(): void {
		const input = this.threadInput;
		this.threadInput = undefined;
		if (!input || input.isDisposed() || this.editingUserIndex !== undefined || !this.threadInner.firstChild || this.renderedCount !== this.messages.length) {
			return;
		}
		this.dropStashedThread(input.sessionId);
		const nodes = this.threadInner.ownerDocument.createDocumentFragment();
		nodes.append(...this.threadInner.childNodes);
		// Re-attached nodes restart their CSS animations; drop the fade so parked text does not fade in again.
		for (const span of nodes.querySelectorAll(`.${FRESH_TEXT_CLASS}`)) {
			span.replaceWith(...span.childNodes);
		}
		const entry: IStashedThread = {
			input,
			messages: this.messages,
			nodes,
			settled: this.settledListeners,
			tail: this.tailListeners,
			tailExchange: this.tailExchange,
			tailFrom: this.tailFrom,
			renderedCount: this.renderedCount,
			// A redraw still queued means the nodes are behind the messages.
			stale: this.renderHandle !== undefined || !!this.renderDelay,
			watch: new DisposableStore(),
		};
		entry.watch.add(input.controller.onDidChange(() => entry.stale = true));
		entry.watch.add(input.onWillDispose(() => this.dropStashedThread(input.sessionId)));
		this.stashedThreads.set(input.sessionId, entry);
		this.settledListeners = new DisposableStore();
		this.tailListeners = new DisposableStore();
		this.tailExchange = undefined;
		this.tailFrom = -1;
		this.renderedCount = 0;
		for (const sessionId of this.stashedThreads.keys()) {
			if (this.stashedThreads.size <= MAX_STASHED_THREADS) {
				break;
			}
			this.dropStashedThread(sessionId);
		}
	}

	/** Puts a parked thread back into `threadInner`. Undefined when there is none, or it no longer matches the chat. */
	private adoptStashedThread(input: AgentEditorInput): { readonly stale: boolean } | undefined {
		const entry = this.stashedThreads.get(input.sessionId);
		if (!entry) {
			return undefined;
		}
		this.stashedThreads.delete(input.sessionId);
		entry.watch.dispose();
		if (entry.input !== input || entry.messages !== input.messages || entry.renderedCount > input.messages.length) {
			entry.settled.dispose();
			entry.tail.dispose();
			return undefined;
		}
		this.settledListeners.dispose();
		this.tailListeners.dispose();
		this.settledListeners = entry.settled;
		this.tailListeners = entry.tail;
		this.threadInner.replaceChildren(entry.nodes);
		this.tailExchange = entry.tailExchange;
		this.tailFrom = entry.tailFrom;
		this.renderedCount = entry.renderedCount;
		return { stale: entry.stale };
	}

	private dropStashedThread(sessionId: string): void {
		const entry = this.stashedThreads.get(sessionId);
		if (!entry) {
			return;
		}
		this.stashedThreads.delete(sessionId);
		entry.watch.dispose();
		entry.settled.dispose();
		entry.tail.dispose();
	}

	private publishSessionChanges(): void {
		this.sessionChanges.setSessionTranscript(this.sessionKey, this.messages);
	}

	/** The chat's changes as a diff tab; its header switches scope and opens Source Control. */
	openSessionChanges(): Promise<void> {
		this.surfaceHost.openChanges('uncommitted');
		return Promise.resolve();
	}

	/** Opens a file with pending agent edits at its first change, where Keep / Undo are drawn. */
	private openPendingFile(file: IAgentPendingFile): void {
		const first = file.changes[0];
		this.surfaceHost.openFile(file.uri, first ? { startLine: Math.max(1, first.modified.startLineNumber) } : undefined);
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
		const media = userMessageMedia(message);
		if (media.length) {
			const strip = this.threadListeners.add(new AgentImageStrip({ onOpen: i => this.openMessageMedia(message, i) }, 'in-message'));
			main.appendChild(strip.element);
			strip.update(media.map((mention, i): IAgentImageStripItem => mention.video
				? { key: `${i}`, name: mention.label, bytes: mention.video.poster, mime: 'image/jpeg', size: mention.video.size, video: { duration: mention.video.duration } }
				: { key: `${i}`, name: mention.label, bytes: mention.image!.bytes, mime: mention.image!.mime, size: mention.image!.bytes.byteLength }));
		}
		const text = append(main, $('.volt-agent-text'));
		this.renderUserMessageText(text, message);
		const applyClamp = (multiline: boolean, clamped: boolean) => {
			if (multiline) {
				bubble.classList.add('multiline');
			}
			bubble.classList.toggle('clamped', clamped);
			// Only while part of the prompt is hidden; a prompt shown whole has nothing more to show.
			setAgentTooltip(bubble, clamped && !editable ? localize('voltAgent.showFullPrompt', "Show full prompt") : undefined);
		};
		const syncUserPromptClamp = () => {
			if (message.promptExpanded) {
				if (text.scrollHeight > 28) {
					bubble.classList.add('multiline');
				}
				bubble.classList.remove('clamped');
				bubble.classList.add('prompt-expanded');
				setAgentTooltip(bubble, undefined);
				return;
			}
			const height = text.scrollHeight;
			const measured = { width: this.layoutWidth, text: message.text, multiline: height > 28, clamped: height > 22 * 4 + 1 };
			this.promptClamps.set(message, measured);
			applyClamp(measured.multiline, measured.clamped);
		};
		// The live exchange redraws the prompt many times a second; measure it once per width.
		const known = this.promptClamps.get(message);
		if (!message.promptExpanded && known && known.width === this.layoutWidth && known.text === message.text) {
			applyClamp(known.multiline, known.clamped);
		} else {
			this.threadListeners.add(scheduleAtNextAnimationFrame(getWindow(text), syncUserPromptClamp));
		}
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
				this.stopAndEditPrompt();
			}));
		} else if (message.id && !this.isStreaming() && hasCommand(CHECKPOINT_RESTORE_COMMAND)) {
			const turnId = message.id;
			const restore = append(bubble, $('button.volt-agent-user-restore')) as HTMLButtonElement;
			restore.type = 'button';
			restore.setAttribute('aria-label', localize('voltAgent.restoreCheckpoint', "Restore Checkpoint"));
			setAgentTooltip(restore, localize('voltAgent.restoreCheckpoint', "Restore Checkpoint"));
			restore.appendChild(renderIcon(Codicon.discard));
			this.threadListeners.add(addDisposableListener(restore, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.restoreCheckpoint(turnId);
			}));
		}
	}

	/**
	 * Cursor's restore icon on a sent message: after "Discard all changes up to this checkpoint?"
	 * the files go back to how they were before that message, and the message opens for editing.
	 * "Redo checkpoint" under it undoes the restore until the next send.
	 */
	private async restoreCheckpoint(turnId: string): Promise<void> {
		if (this.isStreaming()) {
			return;
		}
		if (!this.storageService.getBoolean(RESTORE_CHECKPOINT_NO_CONFIRM_KEY, StorageScope.APPLICATION, false)) {
			const { confirmed, checkboxChecked } = await this.dialogService.confirm({
				message: localize('voltAgent.restoreCheckpoint.title', "Discard all changes up to this checkpoint?"),
				detail: localize('voltAgent.restoreCheckpoint.detail', "You can always undo this later."),
				primaryButton: localize({ key: 'voltAgent.restoreCheckpoint.continue', comment: ['&& denotes a mnemonic'] }, "&&Continue"),
				checkbox: { label: localize('voltAgent.dontAskAgain', "Don't ask again") },
			});
			if (!confirmed) {
				return;
			}
			if (checkboxChecked) {
				this.storageService.store(RESTORE_CHECKPOINT_NO_CONFIRM_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			}
		}
		const sessionId = this.sessionKey;
		const restored = await this.commandService.executeCommand<boolean>(CHECKPOINT_RESTORE_COMMAND, { sessionId, turnId, userTurn: this.userTurnOf(turnId) }).catch(err => {
			this.logService.warn('[volt agent] restore checkpoint failed', err);
			return false;
		});
		if (restored === false || this.sessionKey !== sessionId) {
			return;
		}
		this.restoredCheckpoint = { turnId };
		const index = this.messages.findIndex(message => message.kind === 'user' && message.id === turnId);
		if (index >= 0) {
			this.startUserEdit(index);
		}
	}

	/** "Redo checkpoint" under a message whose checkpoint was just restored. */
	private renderRedoCheckpoint(slot: HTMLElement, message: IAgentUserMessage): void {
		if (!message.id || this.restoredCheckpoint?.turnId !== message.id || !hasCommand(CHECKPOINT_REDO_COMMAND)) {
			return;
		}
		const redo = append(slot, $('button.volt-agent-redo-checkpoint')) as HTMLButtonElement;
		redo.type = 'button';
		redo.textContent = localize('voltAgent.redoCheckpoint', "Redo checkpoint");
		setAgentTooltip(redo, localize('voltAgent.redoCheckpoint.hint', "Restore edits to the latest checkpoint"));
		this.threadListeners.add(addDisposableListener(redo, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			const sessionId = this.sessionKey;
			void this.commandService.executeCommand<boolean>(CHECKPOINT_REDO_COMMAND, { sessionId }).then(done => {
				if (done !== false && this.sessionKey === sessionId) {
					this.restoredCheckpoint = undefined;
					this.cancelUserEdit();
				}
			}, err => this.logService.warn('[volt agent] redo checkpoint failed', err));
		}));
	}

	/**
	 * Cursor's "Revert files to this message?" before an earlier prompt is resubmitted: later turns
	 * are removed, and their file changes can be reverted to match or kept. Asked only when the
	 * checkpoint service says the files differ. Resolves false when the user cancels.
	 */
	private async confirmRevertForEdit(turnId: string | undefined): Promise<boolean> {
		if (!turnId || this.restoredCheckpoint?.turnId === turnId || !hasCommand(CHECKPOINT_RESTORE_COMMAND) || !hasCommand(CHECKPOINT_HAS_CHANGES_COMMAND)) {
			return true;
		}
		const sessionId = this.sessionKey;
		const userTurn = this.userTurnOf(turnId);
		const changed = await this.commandService.executeCommand<boolean>(CHECKPOINT_HAS_CHANGES_COMMAND, { sessionId, turnId, userTurn }).catch(() => false);
		if (!changed) {
			return true;
		}
		let revert = this.storageService.getBoolean(REVERT_ON_EDIT_ALWAYS_KEY, StorageScope.APPLICATION, false);
		if (!revert) {
			const { result, checkboxChecked } = await this.dialogService.prompt<'revert' | 'keep' | 'cancel'>({
				message: localize('voltAgent.revertOnEdit.title', "Revert files to this message?"),
				detail: localize('voltAgent.revertOnEdit.detail', "Later messages in this chat will be removed. File changes after this message can be reverted so they match, or kept as they are."),
				buttons: [
					{ label: localize({ key: 'voltAgent.revertOnEdit.revert', comment: ['&& denotes a mnemonic'] }, "&&Revert Files"), run: () => 'revert' },
					{ label: localize({ key: 'voltAgent.revertOnEdit.keep', comment: ['&& denotes a mnemonic'] }, "&&Keep Files"), run: () => 'keep' },
				],
				cancelButton: { label: localize('voltAgent.revertOnEdit.cancel', "Cancel"), run: () => 'cancel' },
				checkbox: { label: localize('voltAgent.revertOnEdit.always', "Always revert") },
			});
			if (result === 'cancel') {
				return false;
			}
			revert = result === 'revert';
			if (revert && checkboxChecked) {
				this.storageService.store(REVERT_ON_EDIT_ALWAYS_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			}
		}
		if (revert) {
			if (this.isStreaming()) {
				// The files must not change under the restore.
				if (this.input instanceof AgentEditorInput) {
					this.input.controller.skipCurrentRun();
				}
				this.stopAgent();
			}
			await this.commandService.executeCommand<boolean>(CHECKPOINT_RESTORE_COMMAND, { sessionId, turnId, userTurn }).catch(err => this.logService.warn('[volt agent] revert files failed', err));
		}
		return true;
	}

	private onUserMessageClick(e: MouseEvent): void {
		if (this.suppressStartEdit || this.editingUserIndex !== undefined || !isHTMLElement(e.target)) {
			return;
		}
		if (e.target.closest('.volt-agent-edit-slot') || e.target.closest('.volt-agent-user-stop') || e.target.closest('.volt-agent-user-restore') || e.target.closest('.volt-agent-image-tile')) {
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
			if (isHTMLElement(bubble) && bubble.classList.contains('clamped')) {
				message.promptExpanded = true;
				bubble.classList.remove('clamped');
				bubble.classList.add('prompt-expanded');
				setAgentTooltip(bubble, undefined);
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
		// A subagent's chat is the parent's task: only the parent sends into it.
		return !!message && message.kind === 'user' && !this.isSubagentChat();
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
		if (!message || message.kind !== 'user' || !this.canEditUser(index)) {
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
		this.renderRedoCheckpoint(append(turn, $('.volt-agent-edit-slot')), message);
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

	private async commitUserEdit(value: string, display?: IAgentPromptDisplay): Promise<void> {
		const index = this.editingUserIndex;
		if (index === undefined || this.committingEdit) {
			return;
		}
		const edited = this.messages[index];
		this.committingEdit = true;
		let proceed: boolean;
		try {
			proceed = await this.confirmRevertForEdit(edited?.kind === 'user' ? edited.id : undefined);
		} finally {
			this.committingEdit = false;
		}
		if (!proceed || this.editingUserIndex !== index || this.messages[index] !== edited) {
			return;
		}
		if (this.isStreaming()) {
			if (this.input instanceof AgentEditorInput) {
				this.input.controller.skipCurrentRun();
			}
			this.stopAgent();
		}
		this.editingUserIndex = undefined;
		this.clearEditComposer();
		const removed = this.messages[index];
		this.messages.splice(index);
		if (this.input instanceof AgentEditorInput) {
			this.input.recordTruncate(removed);
		}
		this.runtime.truncateSession(this.sessionKey, this.messages.filter(message => message.kind === 'user').length);
		this.syncComposerPlacement();
		this.dispatchPrompt(value, display, removed?.kind === 'user' ? removed.mode ?? this.currentMode : this.currentMode);
	}

	/** Keep the composer in the chat column so empty chats stay centered and threads pin it to the bottom. */
	private syncComposerPlacement(): void {
		const home = this.editorMainEl ?? this.container;
		if (this.composerEl.parentElement !== home) {
			const find = this.findWidget?.getDomNode();
			if (find?.parentElement === home) {
				home.insertBefore(this.composerEl, find);
			} else {
				home.appendChild(this.composerEl);
			}
		}
		const slot = this.threadInner?.querySelector<HTMLElement>('.volt-agent-edit-slot');
		const editing = this.editingUserIndex !== undefined && !!slot;
		this.container.classList.toggle('editing-user', editing);
		if (editing && slot && this.editComposerEl) {
			if (this.editComposerEl.parentElement !== slot) {
				// First in the slot: "Redo checkpoint" sits under the composer.
				slot.insertBefore(this.editComposerEl, slot.firstChild);
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
		this.editMentionController.setHost(this.mentionHost(this.editInputBox));
		this.editLists = this.editEditorDisposables.add(new AgentComposerLists(this.editEditor));
		this.editMentionController.bindImageStrip(this.editInputBox, this.editMonacoHost);
		this.editEditorDisposables.add(this.editMentionController.onDidChangeMedia(() => this.layoutEditEditor()));
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
			// The @ panel already used this key (picked a row, closed itself on Escape).
			if (e.browserEvent.defaultPrevented) {
				return;
			}
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
		const media = this.editMentionController?.whenMediaReady();
		if (media) {
			void media.finally(() => this.sendUserEdit());
			return;
		}
		const displayText = this.editModel?.getValue() ?? '';
		const mentions = this.editMentionController?.displayMentions() ?? [];
		const agentText = (this.editMentionController?.serialize() || displayText).trim();
		if (!agentText) {
			return;
		}
		const display = mentions.length ? { text: displayText, mentions } : undefined;
		void this.commitUserEdit(agentText, display);
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
			this.composerChips?.setScrolledUp(false);
		}
		this.threadView.syncStuckTurns();
	}

	private scrollThreadToEnd(): void {
		this.stickToBottom = true;
		this.syncThreadScroll(true);
	}

	private renderAgentTurn(turn: HTMLElement, message: IAgentAssistantMessage): void {
		const streaming = !!message.activity?.streaming;
		const body = append(turn, $('.volt-agent-thread-body'));
		const ctx = this.blockRenderContext(message);
		// A finished turn lists its files once, in the end card (Cursor's "1 File Changed"), not per edit.
		const changedFiles = streaming ? [] : turnFileChanges(message.segments);
		if (streaming) {
			this.liveTurns.add(message);
		}
		const built = buildTranscriptRows(message.segments, message.text, streaming, message.steers);
		// A failed turn shows its error once, in the tray at its end.
		const rows = !streaming && message.outcome === 'failed' ? withoutFailureNotice(built, message.failure?.message) : built;
		const replies = renderTranscript(body, rows, this.transcriptHost(message, ctx), {
			streaming,
			status: streaming ? this.liveStatusPhrase(message) : undefined,
			workedMs: !streaming && message.startedAt && message.endedAt ? message.endedAt - message.startedAt : undefined,
			workedOpenByDefault: this.liveTurns.has(message),
			statusKey: String(message.startedAt ?? message.id ?? 'live'),
			todos: todoChecklist(message.steps, streaming),
			elapsedSince: streaming ? message.startedAt : undefined,
		});
		if (streaming) {
			// Ticks the live elapsed time while the model is quiet between redraws.
			this.ensureClock();
		}
		this.freshText.apply(message, replies, streaming);
		const tray = runEndTray(message, message === this.messages.at(-1));
		// A login failure already has the sign-in card (and its login button). The generic tray repeats it.
		if (tray && !(tray.kind === 'failed' && hasSignInNotice(rows))) {
			this.renderRunEndTray(body, message, tray);
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
			if (changedFiles.length) {
				this.renderTurnFilesCard(turn, changedFiles);
			}
		}
	}

	/** The live tail's phrase: the current action, or "Thinking" / "Planning next moves" in turn while the model is quiet. */
	private liveStatusPhrase(message: IAgentAssistantMessage): string {
		const activity = message.activity;
		if (activity) {
			activity.shimmerStartedAt ??= Date.now();
		}
		const anchor = activity?.shimmerStartedAt ?? Date.now();
		const now = Date.now();
		const lines = streamingActivityLines('', activity?.status, activity?.items ?? [], now, anchor, activity?.statusPinned === true);
		if (lines.rotate) {
			this.armStatusRotation(anchor);
		} else {
			this.statusRotateTimer?.dispose();
			this.statusRotateTimer = undefined;
		}
		// Only a quiet model, never a running tool: a long build or test keeps its own line.
		const quietFor = now - (activity?.lastEventAt ?? message.startedAt ?? now);
		const modelQuiet = lines.rotate || lines.phrase === PLANNING_PHRASE;
		if (modelQuiet && quietFor >= SLOW_TURN_MS) {
			return localize('voltAgent.takingLonger', "Taking longer than expected\u2026");
		}
		this.slowTurnTimer?.dispose();
		this.slowTurnTimer = modelQuiet && !lines.rotate
			? disposableTimeout(() => this.renderThread(this.stickToBottom), SLOW_TURN_MS - quietFor + 50)
			: undefined;
		return lines.phrase;
	}

	private transcriptHost(message: IAgentAssistantMessage, ctx: IBlockRenderContext): ITranscriptHost {
		return {
			store: this.threadListeners,
			ctx,
			isExpanded: id => message.blockState[`tr:${id}`]?.expanded,
			setExpanded: (id, expanded) => {
				message.blockState[`tr:${id}`] = { expanded };
				this.renderThread(this.stickToBottom);
			},
			openFile: (path, startLine, endLine) => void this.openWorkspaceFile(path, startLine, endLine),
			openStepItem: item => {
				if (item.browserTool) {
					showHostToolDetail(this.container, item, ctx, url => this.surfaceHost.openBrowser(url, undefined, true));
				} else if (item.image) {
					this.showSnapshotPreview(item);
				} else if (item.path) {
					void this.openWorkspaceFile(item.path, item.startLine, item.endLine);
				}
			},
			renderStatus: (parent, key, text) => this.renderLiveStatus(parent, message, key, text),
			renderBlock: (parent, block) => renderAgentBlock(parent, block, ctx),
			renderNotice: (parent, row) => this.renderProviderNotice(parent, row, message),
			setSearchableText: (el, text) => this.setSearchableText(el, text),
			bindSearchHits: (el, files) => this.threadListeners.add(this.exploreHitsTooltip.bind(el, () => files.map(path => ({
				label: basename(path),
				detail: tooltipDir(path),
				onClick: () => void this.openWorkspaceFile(path),
			})), { variant: 'files', placement: 'below' })),
			subagentView: (tool, live) => {
				const task = this.orchestrator.taskForToolCall(this.sessionKey, tool.callId);
				return task ? subagentView(agentRow(task), ref => this.providerOf(ref)) : fallbackSubagentView(tool, live);
			},
			openSubagent: view => this.openSubagent(view.key),
			stopSubagent: view => void this.orchestrator.dispatch({ type: 'task.cancel', taskId: view.key, reason: 'The user stopped it.' }),
			subagentTooltip: this.tooltip,
		};
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

	private renderProviderNotice(parent: HTMLElement, part: Extract<TranscriptRow, { kind: 'notice' }>, message: IAgentAssistantMessage): void {
		if (part.supervision && !message.blockState[`tr:dismiss:${part.id}`]?.expanded) {
			this.renderSupervisionTray(parent, part, part.supervision, message);
			return;
		}
		const notice = append(parent, $(`.volt-agent-provider-notice.severity-${part.severity}`));
		const title = append(notice, $('div.volt-agent-provider-notice-title'));
		this.setSearchableText(title, part.title);
		if (part.description) {
			const detail = append(notice, $('div.volt-agent-provider-notice-detail'));
			this.setSearchableText(detail, part.description);
		}
		this.renderLoginChip(parent, part);
	}

	/** White pill under a sign-in card. Click opens a terminal and runs that CLI's login. */
	private renderLoginChip(parent: HTMLElement, part: Extract<TranscriptRow, { kind: 'notice' }>): void {
		const login = cliLoginForNotice(part.title, part.description, this.activeProviderId());
		if (!login) {
			return;
		}
		const button = append(parent, $('button.volt-agent-login-chip')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(createBrandIcon(login.providerId, 16));
		const label = localize('voltAgent.cliLogin', "{0} login", login.label);
		this.setSearchableText(button, label);
		setAgentTooltip(button, localize('voltAgent.cliLogin.hint', "Open a terminal and run {0}", login.command));
		this.threadListeners.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.surfaceHost?.runLogin(login.command);
		}));
	}

	private activeProviderId(): string | undefined {
		return this.runtime.listCatalog().find(item => item.ref === this.currentModel)?.providerId;
	}

	/**
	 * A run supervisor's finding as a tray: what it saw, in the runtime's words, and what the user
	 * can do about it while it still matters (Continue differently, Resume, Continue, Stop).
	 */
	private renderSupervisionTray(parent: HTMLElement, part: Extract<TranscriptRow, { kind: 'notice' }>, kind: SupervisionKind, message: IAgentAssistantMessage): void {
		const isLast = message === this.messages.at(-1);
		const running = isLast && !!message.activity?.streaming;
		const tray = append(parent, $(`.volt-agent-run-tray.supervision.kind-${kind}`));
		tray.setAttribute('role', 'status');
		const head = append(tray, $('.volt-agent-run-tray-head'));
		const icon = append(head, $('span.volt-agent-run-tray-icon'));
		icon.appendChild(renderIcon(kind === 'loop' ? Codicon.sync : kind === 'stall' ? Codicon.watch : Codicon.debugPause));
		const heading = supervisionTitle(kind);
		this.setSearchableText(append(head, $('span.volt-agent-run-tray-title')), heading);
		const dismiss = append(head, $('button.volt-agent-run-tray-dismiss')) as HTMLButtonElement;
		dismiss.type = 'button';
		dismiss.setAttribute('aria-label', localize('voltAgent.tray.dismiss', "Dismiss"));
		setAgentTooltip(dismiss, localize('voltAgent.tray.dismiss', "Dismiss"));
		dismiss.appendChild(renderIcon(Codicon.close));
		this.threadListeners.add(addDisposableListener(dismiss, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			message.blockState[`tr:dismiss:${part.id}`] = { expanded: true };
			this.renderThread(this.stickToBottom);
		}));
		const detail = append(tray, $('.volt-agent-run-tray-detail'));
		// The runtime's own words; its title is dropped when it only repeats the heading ("Agent looping detected").
		this.setSearchableText(detail, [part.title.trim() === heading ? undefined : part.title, part.description].filter(Boolean).join('\n'));
		const actions = supervisionActions(kind, { running, isLast, failed: message.outcome === 'failed' });
		if (!actions.length) {
			return;
		}
		const row = append(tray, $('.volt-agent-run-tray-actions'));
		for (const action of actions) {
			const spec = SUPERVISION_ACTION_LABELS[action];
			this.appendTrayButton(row, spec.label(), spec.tooltip(), action === 'stop' ? 'secondary' : 'primary', () => this.runSupervisionAction(action, message));
		}
	}

	private runSupervisionAction(action: SupervisionAction, message: IAgentAssistantMessage): void {
		switch (action) {
			case 'stop':
				this.stopAgent();
				return;
			case 'continueDifferently':
				this.continueTurn(
					localize('voltAgent.continueDifferently.prompt', "You are repeating the same steps without making progress. Stop repeating them. Say in one sentence why the last attempts did not work, then take a different approach. If something outside your control blocks you, say what it is and stop."),
					localize('voltAgent.continueDifferently.display', "Continue with a different approach"));
				return;
			case 'resume':
				this.continueTurn(this.resumePrompt(message), localize('voltAgent.resume.display', "Resume"));
				return;
			case 'continue':
				this.continueTurn(localize('voltAgent.continue.prompt', "Continue from where you paused."), localize('voltAgent.continue.display', "Continue"));
				return;
		}
	}

	/**
	 * The end of a turn that did not finish. Failed: Cursor's error tray (title, the exact error,
	 * "Request ID: ...", Copy Request ID) plus Try again and Resume on the newest turn. Stopped or
	 * interrupted: a quiet marker with the same two actions.
	 */
	private renderRunEndTray(parent: HTMLElement, message: IAgentAssistantMessage, tray: IRunEndTray): void {
		if (tray.kind !== 'failed') {
			const marker = append(parent, $(`.volt-agent-run-marker.${tray.kind}`));
			const icon = append(marker, $('span.volt-agent-run-marker-icon'));
			icon.appendChild(renderIcon(tray.kind === 'stopped' ? Codicon.debugStop : Codicon.debugDisconnect));
			this.setSearchableText(append(marker, $('span.volt-agent-run-marker-label')), tray.title);
			if (tray.canResume) {
				this.appendTrayButton(marker, localize('voltAgent.resume', "Resume"), localize('voltAgent.resume.hint', "Continue from what this turn already did"), 'text', () => this.continueTurn(this.resumePrompt(message), localize('voltAgent.resume.display', "Resume")));
			}
			if (tray.canRetry) {
				this.appendTrayButton(marker, localize('voltAgent.tryAgain', "Try again"), localize('voltAgent.tryAgain.hint', "Send this prompt again"), 'text', () => this.retryLastTurn());
			}
			return;
		}
		const card = append(parent, $('.volt-agent-run-tray.failed'));
		card.setAttribute('role', 'alert');
		const head = append(card, $('.volt-agent-run-tray-head'));
		this.setSearchableText(append(head, $('span.volt-agent-run-tray-title')), tray.title);
		const detail = append(card, $('.volt-agent-run-tray-detail'));
		this.setSearchableText(detail, tray.detail ?? '');
		if (tray.requestId) {
			const id = append(card, $('.volt-agent-run-tray-request'));
			this.setSearchableText(id, localize('voltAgent.requestId', "Request ID: {0}", tray.requestId));
		}
		const row = append(card, $('.volt-agent-run-tray-actions'));
		if (tray.requestId) {
			const requestId = tray.requestId;
			const copy = this.appendTrayButton(row, localize('voltAgent.copyRequestId', "Copy Request ID"), localize('voltAgent.copyRequestId.hint', "Copy the run id for a bug report"), 'text', () => {
				void this.clipboardService.writeText(requestId).then(() => {
					copy.textContent = localize('voltAgent.copied', "Copied");
					this.threadListeners.add(disposableTimeout(() => {
						if (copy.isConnected) {
							copy.textContent = localize('voltAgent.copyRequestId', "Copy Request ID");
						}
					}, 1500));
				});
			});
		}
		if (tray.canRetry) {
			this.appendTrayButton(row, localize('voltAgent.tryAgain', "Try again"), localize('voltAgent.tryAgain.hint', "Send this prompt again"), tray.canResume || tray.canContinueDifferently ? 'secondary' : 'primary', () => this.retryLastTurn());
		}
		if (tray.canContinueDifferently) {
			const spec = SUPERVISION_ACTION_LABELS.continueDifferently;
			this.appendTrayButton(row, spec.label(), spec.tooltip(), 'primary', () => this.runSupervisionAction('continueDifferently', message));
		}
		if (tray.canResume && tray.cause === 'budget') {
			const spec = SUPERVISION_ACTION_LABELS.continue;
			this.appendTrayButton(row, spec.label(), spec.tooltip(), 'primary', () => this.runSupervisionAction('continue', message));
		} else if (tray.canResume) {
			this.appendTrayButton(row, localize('voltAgent.resume', "Resume"), localize('voltAgent.resume.hint', "Continue from what this turn already did"), 'primary', () => this.continueTurn(this.resumePrompt(message), localize('voltAgent.resume.display', "Resume")));
		}
	}

	private appendTrayButton(parent: HTMLElement, label: string, tooltip: string, variant: 'primary' | 'secondary' | 'text', run: () => void): HTMLButtonElement {
		const button = append(parent, $(`button.volt-agent-run-tray-btn.${variant}`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		setAgentTooltip(button, tooltip);
		this.threadListeners.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
		return button;
	}

	private resumePrompt(message: IAgentAssistantMessage): string {
		const failure = message.outcome === 'failed' ? message.failure?.message.trim() : undefined;
		return failure
			? localize('voltAgent.resume.promptFailed', "Continue where you left off. The previous turn ended with this error: {0}. Do not redo work that is already done.", failure)
			: localize('voltAgent.resume.prompt', "Continue where you left off. The previous turn stopped before it finished. Do not redo work that is already done.");
	}

	/**
	 * Sends a follow-up the user chose from a tray. While the agent runs it steers it (native) or
	 * stops it and goes first (ACP); otherwise it is the next turn.
	 */
	private continueTurn(agentText: string, displayText: string): void {
		const item: IQueuedAgentPrompt = { id: this.nextQueueId(), text: agentText, display: { text: displayText }, mode: this.currentMode };
		if (this.editingUserIndex !== undefined) {
			this.cancelUserEdit(false);
		}
		this.deliverNow(item);
	}

	/** Cursor's "Try again": the newest prompt runs again in place of the turn that failed or stopped. */
	private retryLastTurn(): void {
		if (this.isStreaming()) {
			return;
		}
		const index = this.messages.findLastIndex(message => message.kind === 'user');
		const user = this.messages[index];
		if (user?.kind !== 'user') {
			return;
		}
		if (this.editingUserIndex !== undefined) {
			this.cancelUserEdit(false);
		}
		const value = (user.agentText ?? user.text).trim();
		if (!value) {
			return;
		}
		const display = user.mentions?.length || user.agentText ? { text: user.text, mentions: user.mentions } : undefined;
		this.messages.splice(index);
		if (this.input instanceof AgentEditorInput) {
			this.input.recordTruncate(user);
		}
		this.runtime.truncateSession(this.sessionKey, this.messages.filter(message => message.kind === 'user').length);
		this.dispatchPrompt(value, display, user.mode ?? this.currentMode);
	}

	private showSnapshotPreview(item: IAgentActivityItem): void {
		if (!item.image) {
			return;
		}
		const label = item.label || localize('voltAgent.tookSnapshot', "Took snapshot");
		const img = $('img.volt-agent-snapshot-image') as HTMLImageElement;
		img.src = item.image;
		img.alt = label;
		this.showPreviewOverlay(label, img);
	}

	/** Cursor's "Expand diagram": the same dialog as screenshots, with the diagram drawn larger. */
	private showDiagramPreview(svg: SVGSVGElement): void {
		const holder = $('.volt-agent-snapshot-diagram');
		svg.removeAttribute('width');
		svg.removeAttribute('height');
		holder.appendChild(svg);
		this.showPreviewOverlay(localize('voltAgent.diagram', "Diagram"), holder);
	}

	private showPreviewOverlay(label: string, content: HTMLElement): void {
		this.dismissSnapshotPreview();
		const win = getWindow(this.container);
		const overlay = append(win.document.body, $('.volt-agent-snapshot-overlay'));
		overlay.tabIndex = -1;
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		const dialog = append(overlay, $('.volt-agent-snapshot-dialog'));
		const head = append(dialog, $('.volt-agent-snapshot-head'));
		const title = append(head, $('span.volt-agent-snapshot-title'));
		title.textContent = label;
		const close = append(head, $('button.volt-agent-snapshot-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltAgent.closeSnapshot', "Close"));
		close.appendChild(renderIcon(Codicon.close));
		dialog.appendChild(content);
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

	private fillWorkedLine(line: HTMLElement, ms: number): void {
		let duration = line.querySelector<HTMLElement>('.volt-agent-worked-duration');
		if (!duration) {
			duration = append(line, $('span.volt-agent-worked-duration.volt-agent-searchable'));
		}
		duration.textContent = formatWorkedDuration(ms);
		line.querySelector('.volt-agent-token-chip')?.remove();
	}

	private renderTurnFilesCard(parent: HTMLElement, files: readonly ITurnFileChange[]): void {
		// show-file-icons: the file icon theme only draws inside it.
		const card = append(parent, $('.volt-agent-turn-files.show-file-icons'));
		const header = append(card, $('.volt-agent-turn-files-header'));
		append(header, $('span.volt-agent-turn-files-title')).textContent = files.length === 1
			? localize('voltAgent.oneFileChanged', "1 File Changed")
			: localize('voltAgent.filesChanged', "{0} Files Changed", files.length);
		const viewToggle = append(header, $('button.volt-agent-turn-files-view')) as HTMLButtonElement;
		viewToggle.type = 'button';
		const review = append(header, $('button.volt-agent-turn-files-review')) as HTMLButtonElement;
		review.type = 'button';
		review.textContent = localize('voltAgent.review', "Review");
		this.threadListeners.add(addDisposableListener(review, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.surfaceHost.openChanges('lastTurn');
		}));
		const rows = this.threadListeners.add(this.instantiationService.createInstance(
			AgentTurnFilesTree,
			append(card, $('.volt-agent-turn-files-rows')),
			this.turnFileLabels,
			(path: string) => void this.openWorkspaceFile(path),
		));
		const render = () => {
			const tree = this.storageService.getBoolean(TURN_FILES_TREE_KEY, StorageScope.APPLICATION, false);
			const label = tree
				? localize('voltAgent.turnFiles.viewList', "View as List")
				: localize('voltAgent.turnFiles.viewTree', "View as Tree");
			viewToggle.replaceChildren(renderIcon(tree ? Codicon.listFlat : Codicon.listTree));
			viewToggle.setAttribute('aria-label', label);
			viewToggle.setAttribute('aria-pressed', String(tree));
			setAgentTooltip(viewToggle, label);
			rows.setFiles(files, tree);
		};
		// Every card follows the same choice, so a toggle redraws the others too.
		this.turnFilesCards.add(render);
		this.threadListeners.add(toDisposable(() => this.turnFilesCards.delete(render)));
		this.threadListeners.add(addDisposableListener(viewToggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			const tree = !this.storageService.getBoolean(TURN_FILES_TREE_KEY, StorageScope.APPLICATION, false);
			this.storageService.store(TURN_FILES_TREE_KEY, tree, StorageScope.APPLICATION, StorageTarget.USER);
			for (const redraw of this.turnFilesCards) {
				redraw();
			}
		}));
		render();
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
		tickElapsed(this.threadInner);
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
		this.surfaceHost.openFile(resource, startLine ? { startLine, endLine } : undefined);
	}

	/** @ mentions search the chat's project and open clicked files as tools tabs. */
	private mentionHost(anchor: HTMLElement): IAgentMentionHost {
		return {
			anchor,
			root: () => this.surfaceHost.executionRoot(),
			openResource: (resource, range) => this.surfaceHost.openFile(resource, range ? { startLine: range.startLineNumber, endLine: range.endLineNumber } : undefined),
			sessionId: () => this.sessionKey,
		};
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
		const sessionRoot = this.surfaceHost.executionRoot();
		if (sessionRoot) {
			candidates.push(joinPath(sessionRoot, trimmed.replace(/^\.\//, '')));
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

	/**
	 * The new agent's project picker: a chat keeps the project it was bound to, so the folder
	 * gets a new chat in this panel, with what was typed so far, and the unsent one closes.
	 */
	private async openLandingProject(folder: URI): Promise<void> {
		const previous = this.input;
		if (!(previous instanceof AgentEditorInput)) {
			return;
		}
		const group = this.group;
		const text = this.inputModel?.getValue() ?? '';
		const mentions = cloneDisplayMentions(this.mentionController?.displayMentions() ?? []);
		const [workspace, labelService] = this.instantiationService.invokeFunction(accessor => [accessor.get(IAgentWorkspaceService), accessor.get(ILabelService)] as const);
		const project = this.sessionContext.registerProject(folder, labelService.getUriBasenameLabel(folder));
		this.sessionContext.selectProject(project.id);
		const next = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		next.draft = text;
		next.draftMentions = mentions;
		next.setHasUnsavedContent(!!text.trim() || mentions.length > 0);
		next.scheduleDraftSave();
		const pane = await group.openEditor(next, { pinned: true });
		attachSessionToProject(this.sessionContext, workspace, this.history, next.sessionId, project);
		if (pane instanceof AgentEditor) {
			pane.prefillDraft(text, mentions);
		}
		if (!previous.isDisposed() && !previous.messages.length && previous !== next) {
			// The draft moved to the new chat; closing must not ask to save it.
			await previous.revert(group.id);
			await group.closeEditor(previous, { preserveFocus: true });
		}
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
		return this.queuedItems.map(item => ({ id: item.id, text: item.prompt.text, display: { text: queuedPreview(item) } }));
	}

	stopRun(): void {
		this.stopAndEditPrompt();
	}

	/** A user's Stop hands the prompt back for editing, as Cursor turns it into a composer again. */
	private stopAndEditPrompt(): void {
		const wasStreaming = this.isStreaming();
		if (this.queuedItems.length) {
			this.interruptAndDrain();
			return;
		}
		this.stopAgent();
		if (!wasStreaming) {
			return;
		}
		const index = this.messages.findLastIndex(message => message.kind === 'user');
		if (index >= 0) {
			getWindow(this.container).requestAnimationFrame(() => this.startUserEdit(index));
		}
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

	private syncStatusChip(): void {
		const state = this.getDockState();
		this.composerChips?.setStatus({ label: state.status, working: state.streaming });
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
			activity: streaming && lastAgent ? dockActivity(lastAgent, status) : undefined,
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

	/** Text selected in a chat transcript (this one or another), added as a quoted chip. */
	addChatSelection(text: string, agentId: string): void {
		this.ensureInputEditor();
		this.mentionController?.addChatSelectionMention(text, agentId);
		this.inputEditor?.focus();
	}

	private async addChatSelectionToSideChat(text: string): Promise<void> {
		const agentId = this.sessionKey;
		const pane = await this.surfaceHost.openSideChat();
		if (pane instanceof AgentEditor) {
			pane.addChatSelection(text, agentId);
		}
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
		this.mentionController.setHost(this.mentionHost(this.inputBox));
		this.composerLists = this.editorDisposables.add(new AgentComposerLists(this.inputEditor));
		this.mentionController.bindImageStrip(this.inputBox, this.monacoHost);
		this.editorDisposables.add(this.mentionController.onDidChangeMedia(() => {
			this.layoutInputEditor();
			this.updateSendButton();
		}));

		this.editorDisposables.add(this.inputEditor.onDidFocusEditorText(() => {
			this.inputBox.classList.add('focused');
			// Focus means a message is coming: start a CLI agent now so the first send skips its cold start.
			this.prewarmAgent();
		}));
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
			// The @ panel already used this key (picked a row, moved the selection).
			if (e.browserEvent.defaultPrevented) {
				return;
			}
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
				if (this.composerCanSend()) {
					this.send();
				}
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
			if ((e.keyCode === KeyCode.UpArrow || e.keyCode === KeyCode.DownArrow) && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
				const recalled = this.promptToRecall(e.keyCode === KeyCode.UpArrow);
				if (recalled) {
					// Consume the key before the text changes: setting it re-delivers the key to later listeners.
					e.preventDefault();
					e.stopPropagation();
					this.setComposerContent(recalled.text, recalled.mentions);
				}
				return;
			}
			if (e.keyCode === KeyCode.Escape && this.editingUserIndex !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				this.cancelUserEdit();
				return;
			}
			if (e.keyCode === KeyCode.Escape && this.queueEdit) {
				e.preventDefault();
				e.stopPropagation();
				this.cancelQueueEdit();
				return;
			}
			if (e.keyCode === KeyCode.Enter && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				if (this.composerCanSend()) {
					// Enter queues behind a running agent; Cmd+Enter sends now (steers or interrupts it).
					this.sendComposerNow();
				}
			}
		}));
		this.updateComposerEditorOptions();
		this.updateInputPlaceholder();
	}

	/**
	 * The prompt Arrow Up/Down puts in the composer, or undefined to let the key move the caret. Up
	 * starts from an empty composer or the very start of the text; while a recalled prompt is untouched,
	 * Up on its first line goes older and Down on its last line goes newer, then back to the draft.
	 */
	private promptToRecall(up: boolean): IAgentPromptHistoryEntry | undefined {
		const editor = this.inputEditor;
		const model = this.inputModel;
		if (!editor || !model || this.queueEdit || this.mentionController?.isMenuOpen || !this.promptHistoryEnabled()) {
			return undefined;
		}
		const selection = editor.getSelection();
		if (!selection?.isEmpty()) {
			return undefined;
		}
		const text = model.getValue();
		const browsing = this.promptHistory.isBrowsing(text);
		if (!up) {
			return browsing && selection.startLineNumber === model.getLineCount() ? this.promptHistory.newer(text) : undefined;
		}
		if (selection.startLineNumber !== 1 || !(browsing || !text || selection.startColumn === 1)) {
			return undefined;
		}
		return this.promptHistory.older(
			{ text, mentions: cloneDisplayMentions(this.mentionController?.displayMentions() ?? []) },
			() => this.promptHistoryEntries(),
		);
	}

	/** This chat's prompts, newest first, then prompts sent from other chats. */
	private promptHistoryEntries(): IAgentPromptHistoryEntry[] {
		const own: IAgentPromptHistoryEntry[] = [];
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.kind === 'user') {
				own.push({ text: message.text, mentions: message.mentions });
			}
		}
		return [...own, ...readStoredPrompts(this.storageService)];
	}

	private promptHistoryEnabled(): boolean {
		return this.configurationService.getValue<boolean>(AGENT_PROMPT_HISTORY_SETTING) !== false;
	}

	private rememberSentPrompt(agentText: string, display: IAgentPromptDisplay | undefined): void {
		this.promptHistory.reset();
		if (this.promptHistoryEnabled()) {
			rememberPrompt(this.storageService, { text: display?.text.trim() || agentText, mentions: display?.mentions });
		}
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
		if (!this.composerCanSend()) {
			return;
		}
		this.send();
	}

	private send(): void {
		if (this.questionTray?.active) {
			// Enter answers the question on screen; the composer text rides along as extra details.
			this.questionTray.advance();
			return;
		}
		if (this.submitting || !this.composerCanSend() || this.isSubagentChat()) {
			return;
		}
		// A video just attached is still being cut into stills; send once they are ready.
		const media = this.mentionController?.whenMediaReady();
		if (media) {
			this.submitting = true;
			void media.finally(() => {
				this.submitting = false;
				this.send();
			});
			return;
		}
		this.submitting = true;
		try {
			this.doSend();
		} finally {
			this.submitting = false;
		}
	}

	/** What the composer holds: the text the agent reads, and what the bubble shows. */
	private readComposer(): { agentText: string; display: IAgentPromptDisplay | undefined } {
		const displayText = this.inputModel?.getValue() ?? '';
		const mentions = this.mentionController?.displayMentions() ?? [];
		const agentText = (this.mentionController?.serialize() || displayText).trim();
		return { agentText, display: mentions.length ? { text: displayText, mentions } : undefined };
	}

	private doSend(): void {
		const { agentText, display } = this.readComposer();
		if (this.queueEdit) {
			// The composer holds a queued prompt being edited: Enter saves it back into the queue.
			if (agentText) {
				this.commitQueueEdit(agentText, display);
			} else {
				this.cancelQueueEdit();
			}
			return;
		}
		if (this.editingUserIndex !== undefined && agentText) {
			this.cancelUserEdit(false);
		}
		if (agentText) {
			this.rememberSentPrompt(agentText, display);
		}
		const cloning = this.cloningProject();
		if (this.isStreaming() || cloning) {
			if (cloning) {
				// The prompt runs as soon as the files are there.
				void this.orchestrator.dispatch({ type: 'thread.block', threadId: this.sessionKey, reason: 'cloning' });
				this.waitForClone(cloning.id);
			}
			if (agentText) {
				this.enqueuePrompt(agentText, display);
			}
			return;
		}
		if (!agentText) {
			return;
		}
		if (!this.messages.length && this.landingChrome?.worktreeNeedsCommit()) {
			// The first send would fail to make the worktree: the prompt stays in the composer.
			void this.landingChrome.confirmWorktreeReady().then(ready => {
				if (ready) {
					this.send();
				}
			});
			return;
		}
		if (!this.messages.length) {
			this.adoptVisibleProject();
		}
		this._onDidComposerSend.fire();
		this.dispatchPrompt(agentText, display);
	}

	/**
	 * Cmd+Enter while the agent runs: Cursor's "Steer" when the agent takes messages between steps
	 * (native models read them from their inbox without stopping), else "Send now", which stops the
	 * agent and sends this prompt first. Idle, it is a normal send.
	 */
	private sendComposerNow(): void {
		if (!this.isStreaming() || this.queueEdit || this.questionTray?.active || this.cloningProject()) {
			this.send();
			return;
		}
		const { agentText, display } = this.readComposer();
		if (!agentText) {
			return;
		}
		if (this.editingUserIndex !== undefined) {
			this.cancelUserEdit(false);
		}
		this.rememberSentPrompt(agentText, display);
		this.clearComposer();
		this.updateSendButton();
		this.deliverNow({ id: this.nextQueueId(), text: agentText, display, mode: this.currentMode });
	}

	/** The first prompt runs in the project the composer shows, not one a restored chat was bound to before. */
	private adoptVisibleProject(): void {
		const project = this.sessionContext.activeProject;
		if (!project || !(this.input instanceof AgentEditorInput) || this.input.messages.length) {
			return;
		}
		const [workspace] = this.instantiationService.invokeFunction(accessor => [accessor.get(IAgentWorkspaceService)] as const);
		adoptProjectForUnstartedSession(this.sessionContext, workspace, this.history, this.input.sessionId, project);
	}

	/** Sends `text` as the next user message, or queues it behind the running turn. */
	private enqueueOrSendText(text: string, display?: IAgentPromptDisplay): void {
		if (this.isStreaming() || this.cloningProject()) {
			this.enqueuePrompt(text, display, false);
			return;
		}
		this.dispatchPrompt(text, display);
	}

	/** Build on a plan card: Agent mode, with the plan's text in the prompt (Cursor attaches the plan file). */
	private buildCreatedPlan(plan: IPlanBlock): void {
		this.setMode('Agent');
		const prompt = createdPlanPrompt(plan);
		this.enqueueOrSendText(prompt.text, { text: prompt.display });
	}

	private nextQueueId(): string {
		return `q-${Date.now()}-${generateUuid().slice(0, 8)}`;
	}

	/** `fromComposer`: the text came from the composer, which is cleared and keeps focus. */
	private enqueuePrompt(text: string, display?: IAgentPromptDisplay, fromComposer = true): void {
		this.submitToOrchestrator(text, display, this.currentMode, 'queue');
		if (fromComposer) {
			this.clearComposer();
		}
		this.updateInputPlaceholder();
		this.updateSendButton();
		this.syncQueueStack();
		this.persistInputState();
		if (fromComposer) {
			this.inputEditor?.focus();
		}
	}

	/** The run request for a prompt: the chosen model and options, the checkout, and the prompt's images. */
	private sendRequest(value: string, display: IAgentPromptDisplay | undefined, mode: string): IVoltSendRequest & { readonly images?: readonly IAgentImageAttachment[] } {
		const runOn = normalizeAgentRunOn(this.storageService.get(agentRunOnStorageKey(this.sessionContext.activeProject?.id), StorageScope.APPLICATION));
		const images = imageAttachmentsFromMentions(display?.mentions);
		return {
			text: value,
			mode: normalizeVoltMode(mode) as VoltMode,
			providerRef: this.modelAuto ? undefined : (this.currentModel || undefined),
			options: this.modelAuto || !this.currentModel ? undefined : this.runtime.getModelOptions(this.currentModel),
			runOn,
			worktreeTarget: runOn === 'worktree' ? this.landingChrome?.getWorktreeTarget() : undefined,
			...(images.length ? { images } : {}),
		};
	}

	/**
	 * Sends a prompt as the chat's next turn. The orchestrator owns the turn from here: it starts it
	 * now, or queues it behind the running one, and the session controller adds the messages when
	 * the turn starts (`turnStart`), whether or not this panel still shows the chat.
	 * `mode`: the mode the prompt was written in (a queued or retried prompt), else the composer's.
	 */
	private dispatchPrompt(value: string, display?: IAgentPromptDisplay, mode = this.currentMode): void {
		this.thinkingStore.clear();
		this.restoredCheckpoint = undefined;
		this.clearComposer();
		this.updateSendButton();
		this.stickToBottom = true;
		this.inputEditor?.focus();
		this.submitToOrchestrator(value, display, mode, 'auto');
	}

	/** Whether the chat's agent offers `/compact`, and why it cannot run right now. */
	private compactState(): IAgentCompactState | undefined {
		if (!this.runtime.supportsCommand(this.sessionKey, 'compact') || this.isSubagentChat()) {
			return undefined;
		}
		return this.isStreaming() || this.cloningProject()
			? { blockedReason: localize('voltAgent.compactBusy', "Compacting is unavailable while the agent is working") }
			: {};
	}

	/** Runs the agent's own `/compact` as the next turn. Unlike a send, the composer draft stays. */
	private compactContext(): void {
		const state = this.compactState();
		if (!state || state.blockedReason) {
			return;
		}
		this.composerChips?.setCompactOffered(false);
		this.thinkingStore.clear();
		this.restoredCheckpoint = undefined;
		this.stickToBottom = true;
		this.submitToOrchestrator('/compact', undefined, this.currentMode, 'auto');
	}

	/** Hands a prompt to the orchestrator with the composer's model, options and checkout choice. */
	private submitToOrchestrator(value: string, display: IAgentPromptDisplay | undefined, mode: string, delivery: OrchDelivery, turnId = generateUuid()): void {
		const input = this.input instanceof AgentEditorInput ? this.input : undefined;
		const threadId = this.sessionKey;
		input?.recordMode(normalizeVoltMode(this.currentMode));
		stashTurnDisplay(turnId, display);
		const request = this.sendRequest(value, display, mode);
		const host: IAgentPromptHostOptions = {
			...(request.runOn ? { runOn: request.runOn } : {}),
			...(request.worktreeTarget ? { worktreeTarget: request.worktreeTarget } : {}),
		};
		const frozen = this.freezeDisplay(display);
		this.submitChain = this.submitChain.then(async () => {
			const prompt: IOrchPrompt = {
				text: value,
				...(display ? { display: await frozen } : {}),
				mode,
				...(request.providerRef ? { modelRef: request.providerRef } : {}),
				...(request.options ? { options: request.options } : {}),
				...(Object.keys(host).length ? { host } : {}),
			};
			const result = await this.orchestrator.submit(threadId, prompt, delivery, turnId);
			if (result.outcome === 'rejected') {
				this.logService.warn(`[volt agent] the orchestrator did not take the prompt: ${result.reason ?? 'rejected'}`);
			}
		}).catch(err => this.logService.warn('[volt agent] sending the prompt failed', err));
	}

	/** The display as history stores it (attachments by reference), so a queued prompt survives a restart. */
	private freezeDisplay(display: IAgentPromptDisplay | undefined): Promise<unknown> {
		if (!display) {
			return Promise.resolve(undefined);
		}
		this.displayCodec ??= new AgentHistoryCodec(this.history);
		return this.displayCodec.freezeMentions(display.mentions).then(mentions => ({ text: display.text, ...(mentions?.length ? { mentions } : {}) }), () => ({ text: display.text }));
	}

	/** A queued prompt's display with live mentions, for editing it in the composer. */
	private async thawQueuedDisplay(item: IOrchQueueItem): Promise<IAgentPromptDisplay | undefined> {
		const stored = item.prompt.display as { text?: unknown; mentions?: unknown } | undefined;
		if (!stored || typeof stored.text !== 'string') {
			return undefined;
		}
		this.displayCodec ??= new AgentHistoryCodec(this.history);
		const mentions = await this.displayCodec.thawMentions(stored.mentions).catch(() => undefined);
		return { text: stored.text, ...(mentions?.length ? { mentions } : {}) };
	}

	/** Prompts queued before the orchestrator owned queues (saved with the draft) move into it once. */
	private migrateDraftQueue(input: AgentEditorInput): void {
		const legacy = Array.isArray(input.promptQueue) ? input.promptQueue.slice() : [];
		if (!legacy.length) {
			return;
		}
		input.promptQueue = [];
		input.scheduleDraftSave();
		for (const item of legacy) {
			this.submitToOrchestrator(item.text, item.display, item.mode ?? this.currentMode, 'queue', item.id);
		}
	}

	/**
	 * In a subagent's chat: "<model> · Working 5m 31s · Runs on its own · Open parent" (T3). It keeps
	 * the composer: a message here is another round of the task, and its report goes to the parent.
	 */
	private renderSubagentBar(): void {
		if (!this.subagentBar) {
			return;
		}
		const thread = this.orchestrator.getThread(this.sessionKey);
		// Read only: no composer, no edits. Its rounds come from the parent.
		this.container.classList.toggle('subagent-chat', !!thread?.taskId);
		const task = thread?.taskId ? this.orchestrator.getTask(thread.taskId) : undefined;
		const parentOpen = !!thread?.parentId && this.isChatOpen(thread.parentId);
		const key = task ? JSON.stringify([this.sessionKey, task.state, task.modelLabel, task.startedAt, task.endedAt, task.waitingOn, parentOpen]) : '';
		if (key === this.subagentBarKey) {
			return;
		}
		this.subagentBarKey = key;
		this.subagentBarStore.clear();
		this.subagentBar.classList.toggle('hidden', !task);
		this.subagentBar.replaceChildren();
		if (!task || !thread?.parentId) {
			return;
		}
		const view = subagentView(agentRow(task), ref => this.providerOf(ref));
		renderSubagentAvatar(this.subagentBar, view, 22);
		append(this.subagentBar, $('span.model')).textContent = view.modelLabel ?? localize('voltAgent.subagentBar.model', "Subagent");
		const state = append(this.subagentBar, $(`span.state.state-${view.state}`));
		state.textContent = view.stateLabel;
		const clock = append(this.subagentBar, $('span.volt-subagent-clock'));
		if (view.startedAt !== undefined) {
			clock.dataset.startedAt = String(view.startedAt);
			if (view.endedAt !== undefined) {
				clock.dataset.endedAt = String(view.endedAt);
			}
			clock.textContent = formatOrchElapsed((view.endedAt ?? Date.now()) - view.startedAt);
		}
		append(this.subagentBar, $('span.spacer'));
		append(this.subagentBar, $('span.note')).textContent = isLiveSubagentState(view.state)
			? localize('voltAgent.subagentBar.own', "Runs on its own")
			: localize('voltAgent.subagentBar.reported', "Reported to its parent");
		// Nested in the parent's right panel, or the parent has a tab already: nothing to open.
		if (!parentOpen) {
			const parentId = thread.parentId;
			const open = append(this.subagentBar, $('button.open-parent')) as HTMLButtonElement;
			open.type = 'button';
			open.appendChild(renderIcon(Codicon.arrowUp));
			append(open, $('span')).textContent = localize('voltAgent.subagentBar.openParent', "Open parent");
			this.subagentBarStore.add(addDisposableListener(open, 'click', () => void openAgentPanel(this.editorGroupsService, this.instantiationService, parentId)));
		}
		tickSubagentClocks(this.subagentBar, this.subagentBarStore);
	}

	/** A chat with a tab in the main panel, or the chat whose right panel holds this one. */
	private isChatOpen(sessionId: string): boolean {
		if (agentSideChatParents().get(this.sessionKey) === sessionId && this.container.closest('.volt-agent-tools-area')) {
			return true;
		}
		return this.editorGroupsService.mainPart.groups.some(group => group.editors.some(editor => editor instanceof AgentEditorInput && editor.sessionId === sessionId));
	}

	/** An agent handed this chat to another model: the composer follows, so the next prompt goes there too. */
	private followAgentHandoff(): void {
		const thread = this.orchestrator.getThread(this.sessionKey);
		const latest = thread?.handoffs.at(-1);
		if (!latest || latest.by !== 'agent' || this.followedHandoffAt === latest.at) {
			return;
		}
		this.followedHandoffAt = latest.at;
		if (this.modelPicker.selectRef(latest.to)) {
			this.updateModelButton();
		}
	}

	private syncHostedChrome(): void {
		if (this.container?.closest('.volt-agent-tools-area')) {
			this.setBrowserHosted(!this.isSubagentChat());
		}
	}

	/** This chat runs a task another chat delegated. */
	private isSubagentChat(): boolean {
		return !!this.orchestrator.getThread(this.sessionKey)?.taskId;
	}

	/** The harness behind a catalog ref, for its mark on a subagent's avatar. */
	private providerOf(modelRef: string | undefined): string | undefined {
		const ref = modelRef ?? this.orchestrator.getThread(this.sessionKey)?.modelRef;
		return ref ? this.runtime.listCatalog().find(item => item.ref === ref)?.providerId : undefined;
	}

	/** A subagent's chat opens in this chat's right panel, as a tab, streaming as it works. */
	private openSubagent(taskId: string): void {
		const task = this.orchestrator.getTask(taskId);
		if (!task?.childId) {
			return;
		}
		if (!revealAgentSideChat(this.sessionKey, task.childId)) {
			void openAgentPanel(this.editorGroupsService, this.instantiationService, task.childId);
		}
	}

	private stopAllSubagents(): void {
		for (const task of this.orchestrator.tasksOf(this.sessionKey)) {
			if (task.source === 'volt' && (task.state === 'queued' || task.state === 'running' || task.state === 'waiting')) {
				void this.orchestrator.dispatch({ type: 'task.cancel', taskId: task.id, reason: 'The user stopped all subagents.' });
			}
		}
	}

	private get queuedItems(): readonly IOrchQueueItem[] {
		return this.orchestrator.getThread(this.sessionKey)?.queue ?? [];
	}

	/** The 0-based position of a user message among the user messages: the checkpoint fallback key. */
	private userTurnOf(turnId: string): number | undefined {
		let ordinal = 0;
		for (const message of this.messages) {
			if (message.kind !== 'user') {
				continue;
			}
			if (message.id === turnId) {
				return ordinal;
			}
			ordinal++;
		}
		return undefined;
	}

	/**
	 * Hands a message to the running agent now: an agent that reads messages between steps takes
	 * it without stopping (the reply shows where it landed); any other is stopped and the prompt
	 * goes first. Idle, it is a normal send. The orchestrator decides which.
	 */
	private deliverNow(item: IQueuedAgentPrompt): void {
		if (!this.isStreaming()) {
			this.dispatchPrompt(item.text, item.display, item.mode);
			return;
		}
		this.submitToOrchestrator(item.text, item.display, item.mode ?? this.currentMode, 'now', item.id);
	}

	/** The running agent reads messages between steps (the native loop's inbox, or a run the orchestrator marked steerable). */
	private canSteer(): boolean {
		const thread = this.orchestrator.getThread(this.sessionKey);
		if (thread?.active?.steerable && thread.active.phase === 'running') {
			return true;
		}
		const session = this.runtime.getOrCreateSession(this.sessionKey);
		const run = session.activeRun;
		if (!run || (run.status !== 'running' && run.status !== 'waiting')) {
			return false;
		}
		return this.runtime.canSteer(this.sessionKey);
	}

	/** Stops the agent; the orchestrator sends the head of the queue once the stop has landed. */
	private interruptAndDrain(): void {
		this.stopAgent();
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
			last.outcome = 'stopped';
			last.activity.streaming = false;
			last.activity.expanded = false;
			last.activity.status = localize('voltAgent.cancelled', "Cancelled");
			last.endedAt = Date.now();
			last.startedAt ??= last.endedAt;
			last.durationMs = Math.max(0, last.endedAt - last.startedAt);
			completeStreamingBlocks(last, true);
			this.updateSendButton();
			this.renderThread(this.stickToBottom);
			this._onDidChangeDock.fire();
			this.recordReply(last, true, 'cancelled');
		}
		// Stopping a turn stops the subagents it started, as a harness's own subagents stop with it.
		void this.orchestrator.cancel(this.sessionKey, { cascade: 'turn' });
	}

	/**
	 * Lets the queue run again after it paused (an error, a restart). The orchestrator drains
	 * queues on its own otherwise: after every turn, whether or not a panel shows the chat.
	 */
	private drainPromptQueue(): void {
		if (this.orchestrator.getThread(this.sessionKey)?.pause) {
			void this.orchestrator.dispatch({ type: 'queue.resume', threadId: this.sessionKey });
		}
		this.syncQueueStack();
		this.updateSendButton();
	}

	/** Why queued prompts wait for the user while nothing runs. */
	private queuePause(): QueuePause | undefined {
		if (this.isStreaming()) {
			return undefined;
		}
		const thread = this.orchestrator.getThread(this.sessionKey);
		// Prompts, or subagent reports, are waiting on the user.
		const waiting = this.queuedItems.length || this.orchestrator.tasksOf(this.sessionKey).some(task => task.delivery === 'pending');
		if (!waiting) {
			return undefined;
		}
		const pause = thread?.pause;
		return pause === 'failed' ? 'failed' : pause === 'interrupted' ? 'interrupted' : pause === 'wakeups' ? 'wakeups' : pause ? 'stopped' : undefined;
	}

	private queueState(): IAgentComposerQueueState {
		const running = this.isStreaming();
		return {
			paused: running ? undefined : this.queuePause(),
			editingId: this.queueEdit?.id,
			running,
			steer: running && this.canSteer(),
		};
	}

	private resumeQueue(): void {
		this.drainPromptQueue();
	}

	private sendQueuedNow(id: string): void {
		if (!this.queuedItems.some(item => item.id === id) || this.queueEdit?.id === id) {
			return;
		}
		void this.orchestrator.dispatch({ type: 'queue.sendNow', threadId: this.sessionKey, itemId: id, canSteer: this.canSteer() });
	}

	/** Cursor's "Edit queued message": the prompt moves into the composer; Enter puts it back changed. */
	private editQueuedPrompt(id: string): void {
		const item = this.queuedItems.find(queued => queued.id === id);
		if (!item) {
			return;
		}
		this.ensureInputEditor();
		if (this.editingUserIndex !== undefined) {
			this.cancelUserEdit(false);
		}
		const stash = this.queueEdit?.stash ?? {
			text: this.inputModel?.getValue() ?? '',
			mentions: cloneDisplayMentions(this.mentionController?.displayMentions() ?? []),
		};
		const previous = this.queueEdit;
		this.queueEdit = { id, stash };
		const threadId = this.sessionKey;
		if (previous && previous.id !== id) {
			void this.orchestrator.dispatch({ type: 'queue.hold', threadId, itemId: previous.id, held: false });
		}
		// Held: the orchestrator skips it while it is open here.
		void this.orchestrator.dispatch({ type: 'queue.hold', threadId, itemId: id, held: true });
		void this.thawQueuedDisplay(item).then(display => {
			if (this.queueEdit?.id !== id) {
				return;
			}
			this.setComposerContent(display?.text ?? item.prompt.text, display?.mentions);
			this.syncQueueStack();
			this.inputEditor?.focus();
		});
	}

	private commitQueueEdit(agentText: string, display: IAgentPromptDisplay | undefined): void {
		const edit = this.queueEdit;
		if (!edit) {
			return;
		}
		this.queueEdit = undefined;
		const threadId = this.sessionKey;
		const item = this.queuedItems.find(queued => queued.id === edit.id);
		if (item) {
			stashTurnDisplay(item.id, display);
			const frozen = this.freezeDisplay(display);
			this.submitChain = this.submitChain.then(async () => {
				const prompt: IOrchPrompt = { ...item.prompt, text: agentText, display: display ? await frozen : undefined };
				await this.orchestrator.dispatch({ type: 'queue.update', threadId, itemId: item.id, prompt });
			}).catch(err => this.logService.warn('[volt agent] updating the queued prompt failed', err));
		} else {
			// It was sent or removed while being edited: keep the new text as a queued prompt.
			this.submitToOrchestrator(agentText, display, this.currentMode, 'queue');
		}
		this.setComposerContent(edit.stash.text, edit.stash.mentions);
		this.syncQueueStack();
		this.persistInputState();
	}

	private cancelQueueEdit(): void {
		const edit = this.queueEdit;
		if (!edit) {
			return;
		}
		this.queueEdit = undefined;
		void this.orchestrator.dispatch({ type: 'queue.hold', threadId: this.sessionKey, itemId: edit.id, held: false });
		this.setComposerContent(edit.stash.text, edit.stash.mentions);
		this.syncQueueStack();
	}

	private setComposerContent(text: string, mentions: readonly IAgentDisplayMention[] | undefined): void {
		this.ensureInputEditor();
		if (!this.inputModel || this.inputModel.isDisposed()) {
			return;
		}
		this.mentionController?.clear();
		this.inputModel.setValue(text);
		if (mentions?.length) {
			this.mentionController?.restoreMentions(mentions);
		}
		const lastLine = this.inputModel.getLineCount();
		this.inputEditor?.setPosition({ lineNumber: lastLine, column: this.inputModel.getLineMaxColumn(lastLine) });
		this.syncUnsavedState();
		this.updateInputPlaceholder();
		this.updateSendButton();
		this.layoutInputEditor();
	}

	private hasDraft(): boolean {
		return !!(this.inputModel?.getValue().trim());
	}

	private updateSendButton(): void {
		this.composerQueue?.setState(this.queueState());
		const canSend = this.composerCanSend();
		const kind: 'mic' | 'send' = this.isFollowUpComposer() || this.hasDraft() ? 'send' : 'mic';
		this.sendButton.disabled = !canSend;
		this.sendButton.classList.toggle('disabled', !canSend);
		if (this.sendKind === kind && this.sendButton.childElementCount) {
			this.sendButton.classList.remove('stop');
			return;
		}
		this.sendKind = kind;
		this.sendButton.replaceChildren();
		this.sendButton.classList.remove('stop');
		setAgentTooltip(this.sendButton, !canSend
			? localize('voltAgent.selectProjectFirst', "Select a project to send")
			: kind === 'send'
				? localize('voltAgent.send', "Send")
				: localize('voltAgent.voice', "Voice"));
		this.sendButton.appendChild(kind === 'send' ? createSendIcon() : createMicIcon());
	}

	removeQueuedPrompt(id: string): void {
		if (this.queueEdit?.id === id) {
			this.cancelQueueEdit();
		}
		void this.orchestrator.dispatch({ type: 'queue.remove', threadId: this.sessionKey, itemId: id });
	}

	reorderQueuedPrompts(ids: readonly string[]): void {
		void this.orchestrator.dispatch({ type: 'queue.reorder', threadId: this.sessionKey, ids });
	}

	clearPromptQueue(): void {
		this.cancelQueueEdit();
		void this.orchestrator.dispatch({ type: 'queue.clear', threadId: this.sessionKey });
	}

	/** The agent's oldest open questions for this chat, docked above the composer. */
	private syncQuestionTray(): void {
		if (!this.questionTray) {
			return;
		}
		const wasActive = this.questionTray.active;
		this.questionTray.setRequest(this.runtime.getPendingQuestions(this.sessionKey)[0]);
		if (wasActive !== this.questionTray.active) {
			this.updateInputPlaceholder();
			if (this.questionTray.active) {
				this.inputEditor?.focus();
			}
		}
	}

	private async answerQuestions(requestId: string, response: IAgentQuestionResponse, media: readonly IAgentPreparedAttachment[]): Promise<void> {
		if (response.outcome === 'cancelled') {
			// Dismissed: nothing is sent and the composer keeps its draft (T3 dismisses without restarting the agent).
			this.runtime.respondToQuestions(requestId, response);
			return;
		}
		// Files and videos just attached in the composer are still being saved; their paths go in the note.
		await this.mentionController?.whenMediaReady();
		if (!this.runtime.getPendingQuestions(this.sessionKey).some(item => item.id === requestId)) {
			return;
		}
		const note = (this.mentionController?.serialize() || this.inputModel?.getValue() || '').trim();
		const composerImages = cloneDisplayMentions(this.mentionController?.displayMentions() ?? []).filter(mention => mention.kind === 'image' || mention.kind === 'video');
		if (note) {
			this.clearComposer();
		}
		const request = this.runtime.getPendingQuestions(this.sessionKey).find(item => item.id === requestId);
		const answered = note ? { ...response, note } : response;
		if (!this.runtime.respondToQuestions(requestId, answered) && request) {
			// The agent stopped waiting (its turn ended): the answers go to it as the next message,
			// with the attached pictures as images.
			const text = questionResponseText(request, answered);
			const mentions: IAgentDisplayMention[] = [
				...composerImages,
				...media.filter(item => item.bytes).map((item): IAgentDisplayMention => ({ kind: 'image', label: item.name, image: { id: item.id, mime: item.mime, bytes: item.bytes!, name: item.name, path: item.path } })),
			];
			this.enqueueOrSendText(text, mentions.length ? { text, mentions } : undefined);
		}
	}

	private syncQueueStack(): void {
		this.syncQuestionTray();
		if (!this.composerQueue) {
			return;
		}
		this.composerQueue.setMode(this.currentMode);
		this.composerQueue.setQueue(this.queuedItems.map(item => ({
			id: item.id,
			text: item.prompt.text,
			preview: queuedPreview(item),
		})));
		this.renderSubagentBar();
		const dock = dockModel(this.orchestrator.getState(), this.sessionKey);
		this.composerQueue.setAgents({ views: dock.agents.map(row => subagentView(row, ref => this.providerOf(ref))), conflicts: dock.conflicts });
		this.composerQueue.setState(this.queueState());
		this.updateInputPlaceholder();
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

	/** A turn is live: its reply streams, or the orchestrator is starting one for this chat. */
	private isStreaming(): boolean {
		const last = this.messages.at(-1);
		if (last?.kind === 'agent' && !!last.activity?.streaming) {
			return true;
		}
		const active = this.orchestrator.getThread(this.sessionKey)?.active;
		return !!active && active.phase === 'dispatching';
	}

	/**
	 * Run events are reduced by the input's session controller even while this
	 * panel shows another chat. The panel only redraws and drives the composer.
	 */
	private bindRuntimeSession(): void {
		this.eventDisposable?.dispose();
		this.eventDisposable = undefined;
		const input = this.input;
		if (!(input instanceof AgentEditorInput)) {
			return;
		}
		const controller = input.controller;
		this.eventDisposable = controller.onDidChange(change => {
			if (this.input !== input) {
				return;
			}
			switch (change.kind) {
				case 'usage':
					this.sessionTokensUsed = input.contextUsed;
					this.sessionTokensWindow = input.contextWindow;
					this.refreshContextUsage();
					this.scheduleThreadRender();
					break;
				case 'render':
					this.scheduleThreadRender();
					break;
				case 'turnStart':
					// A turn this panel sent, or one the orchestrator started (queue, subagent report).
					this._onDidChangeDock.fire();
					this.stickToBottom = true;
					this.renderThread(true);
					this.scrollThreadToEnd();
					this.updateSendButton();
					this.syncQueueStack();
					break;
				case 'runEnd':
					// The orchestrator sends the next queued prompt itself; after an error the queue waits.
					this.scheduleThreadRender();
					this.updateSendButton();
					this.syncQueueStack();
					break;
			}
		});
		void this.orchestrator.ensureThreadLoaded(input.sessionId).then(() => {
			if (this.input === input) {
				this.syncHostedChrome();
				this.syncQueueStack();
				this.updateSendButton();
				// Rows of finished turns read their subagents from the chat's loaded orchestration.
				if (this.orchestrator.tasksOf(input.sessionId).length || this.orchestrator.getThread(input.sessionId)?.parentId) {
					this.renderThread(this.stickToBottom);
				}
			}
		});
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
		this.surfaceHost.openBrowser(url, title, true);
	}

	/**
	 * Streaming redraws rebuild the live exchange and force a layout, so they run at most every
	 * {@link STREAM_FRAME_MS} instead of every frame: tokens arrive in bursts, and 20 redraws a
	 * second read as smooth while costing a third of the work.
	 */
	private scheduleThreadRender(): void {
		if (this.renderHandle !== undefined || this.renderDelay) {
			return;
		}
		const win = getWindow(this.threadInner);
		const frame = () => {
			this.renderHandle = win.requestAnimationFrame(() => {
				this.renderHandle = undefined;
				this.lastTailRenderAt = Date.now();
				this.persistInputState();
				this.renderThreadTail(this.stickToBottom);
				this._onDidChangeDock.fire();
			});
		};
		const wait = this.isStreaming() ? STREAM_FRAME_MS - (Date.now() - this.lastTailRenderAt) : 0;
		if (wait <= 0) {
			frame();
			return;
		}
		this.renderDelay = disposableTimeout(() => {
			this.renderDelay = undefined;
			frame();
		}, wait);
	}

	/**
	 * Dragging files over the chat dims it under "Drop files to attach". The layer takes the drop
	 * (so the composer's own editor never sees it) and gives it to the composer being written in.
	 * Other drags (terminals, text) pass through to the tools drop zones.
	 */
	private bindAttachDrop(): void {
		const overlay = append(this.container, $('.volt-agent-drop-overlay'));
		const pill = append(overlay, $('.volt-agent-drop-overlay-pill'));
		pill.appendChild(createStrokeIcon('paperclip', ['M16 6v9.5a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9']));
		append(pill, $('span')).textContent = localize('voltAgent.dropToAttach', "Drop files to attach");
		const show = (on: boolean) => this.container.classList.toggle('drop-target', on);
		const hover = (e: DragEvent) => {
			if (!isAttachDrag(e)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}
			show(true);
		};
		this._register(new DragAndDropObserver(this.container, {
			onDragEnter: hover,
			onDragOver: hover,
			onDragLeave: () => show(false),
			onDragEnd: () => show(false),
			onDrop: e => {
				show(false);
				if (!isAttachDrag(e)) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				if (this.editingUserIndex !== undefined && this.editMentionController) {
					void this.editMentionController.handleExternalDrop(e);
					return;
				}
				this.ensureInputEditor();
				void this.mentionController?.handleExternalDrop(e);
			},
		}));
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
		// For the composer's own rules, without a :has() on it (typing would restyle the whole composer).
		this.composerEl.classList.toggle('follow-up', followUp);
		this.composerEl.classList.toggle('follow-up-single-line', followUp && !multiline);
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
		// Images sit above the text, so they need the full composer.
		if (!hasNewline && !this.mentionController?.hasMedia) {
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
		this.clearTeardownPending = false;
		// The dock beside the chat finds the chat it sits in by this.
		this.container.dataset.sessionId = input.sessionId;
		// A queued prompt open for editing goes back untouched; the composer keeps the chat's own draft.
		this.cancelQueueEdit();
		this.persistInputState();
		this.surfaceHost.present(input.sessionId);
		if (this.input !== input) {
			this.landingChrome?.resetWorktreeTarget();
		}
		await super.setInput(input, options, context, token);
		// One pane shows every agent tab: the banner follows the tab's project.
		this.renderCloneBanner();
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
		this.container.classList.remove('restoring');
		this.composerChips.setSessionId(this.sessionKey);
		this.syncStatusChip();
		this.pendingChanges.setSessionId(this.sessionKey);
		this.publishSessionChanges();
		this.bindRuntimeSession();
		this.contextUsageView.refreshBranch();
		this.renderSuggestChips();
		this.updateSendButton();
		this.layoutInputEditor();
		if (!options?.preserveFocus) {
			this.inputEditor?.focus();
		}
		this.schedulePrewarm();
	}

	/**
	 * Opening a chat starts its CLI agent shortly after, not only when the composer is focused, so a
	 * send from a driver or a quick click skips the cold start (spawn, initialize, session/new).
	 * No-op for native models; the runtime caps idle agents.
	 */
	private schedulePrewarm(): void {
		this.prewarmTimer?.dispose();
		this.prewarmTimer = disposableTimeout(() => {
			this.prewarmTimer = undefined;
			if (this.isVisible() && !this.isStreaming() && this.composerCanSend()) {
				this.prewarmAgent();
			}
		}, PREWARM_ON_OPEN_MS);
	}

	private prewarmAgent(): void {
		this.runtime.prewarmAgent(this.sessionKey, this.modelAuto ? undefined : (this.currentModel || undefined), normalizeVoltMode(this.currentMode) as VoltMode);
	}

	override clearInput(): void {
		this.cancelQueueEdit();
		this.prewarmTimer?.dispose();
		this.prewarmTimer = undefined;
		this.persistInputState();
		const input = this.input;
		if (input instanceof AgentEditorInput) {
			// The chat being left forgets its composer zoom and height, as it always has.
			input.composerZoomed = false;
			input.composerHeight = undefined;
		}
		super.clearInput();
		// Switching chats calls setInput straight after this. Hiding the tools and resetting the
		// composer first would lay the pane out twice, so only a pane left empty gets the teardown.
		this.clearTeardownPending = true;
		queueMicrotask(() => {
			if (!this.clearTeardownPending || this._store.isDisposed) {
				return;
			}
			this.clearTeardownPending = false;
			this.surfaceHost.present(undefined);
			this.setComposerZoomed(false);
		});
	}

	override layout(dimension: Dimension): void {
		// A side chat opened in another chat's tools uses the compact chat chrome; a subagent's chat
		// keeps its transcript there, since it is opened to watch the subagent work.
		this.syncHostedChrome();
		this.container.style.height = `${dimension.height}px`;
		this.layoutWidth = dimension.width;
		this.surfaceHost.layout(dimension);
		this.layoutInputEditor();
		this.syncThreadScroll();
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
		for (const sessionId of [...this.stashedThreads.keys()]) {
			this.dropStashedThread(sessionId);
		}
		this.settledListeners.dispose();
		this.tailListeners.dispose();
		this.eventDisposable?.dispose();
		this.clockTimer?.dispose();
		this.statusRotateTimer?.dispose();
		this.renderDelay?.dispose();
		this.slowTurnTimer?.dispose();
		this.prewarmTimer?.dispose();
		this.dismissSnapshotPreview();
		if (this.inputModel && !this.inputModel.isDisposed()) {
			this.inputModel.dispose();
		}
		super.dispose();
	}

	/** The project this agent runs in: its bound project, else the active one. */
	private boundProjectId(): string | undefined {
		const input = this.input instanceof AgentEditorInput ? this.input : undefined;
		return (input ? this.sessionContext.bindingFor(input.sessionId)?.projectId : undefined) ?? this.sessionContext.activeProject?.id;
	}

	private cloningProject(): IVoltProject | undefined {
		const id = this.boundProjectId();
		const project = id ? this.voltProjects.get(id) : undefined;
		return project?.state.kind === 'cloning' ? project : undefined;
	}

	private waitForClone(projectId: string): void {
		if (this.waitingForClone === projectId) {
			return;
		}
		this.waitingForClone = projectId;
		const threadId = this.sessionKey;
		void this.voltProjects.whenReady(projectId).then(ready => {
			this.waitingForClone = undefined;
			if (!ready) {
				// The files never came: what was queued waits for the user instead of failing at once.
				void this.orchestrator.dispatch({ type: 'queue.pause', threadId, reason: 'stopped' });
			}
			void this.orchestrator.dispatch({ type: 'thread.block', threadId, reason: undefined });
			if (this._store.isDisposed) {
				return;
			}
			this.renderCloneBanner();
			this.updateSendButton();
		});
	}

	/** "Cloning volt… 42%" above the composer while the project's files arrive. */
	private renderCloneBanner(): void {
		const banner = this.cloneBanner;
		if (!banner) {
			return;
		}
		const id = this.boundProjectId();
		const project = id ? this.voltProjects.get(id) : undefined;
		const state = project?.state;
		banner.replaceChildren();
		banner.classList.toggle('hidden', !project || !state || state.kind === 'ready');
		banner.classList.toggle('error', state?.kind === 'error');
		if (!project || !state || state.kind === 'ready') {
			return;
		}
		const icon = append(banner, $('span.icon'));
		icon.appendChild(renderIcon(state.kind === 'cloning' ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.warning));
		const text = append(banner, $('span.text'));
		const action = append(banner, $('button.action')) as HTMLButtonElement;
		action.type = 'button';
		if (state.kind === 'cloning') {
			text.textContent = this.queuedItems.length
				? localize('voltAgent.cloningQueued', "Cloning {0}... {1}% · your prompt runs when it finishes", project.name, state.percent)
				: localize('voltAgent.cloning', "Cloning {0}... {1}%", project.name, state.percent);
			text.title = state.message ?? '';
			action.textContent = localize('voltAgent.cancelClone', "Cancel");
			action.onclick = () => void this.commandService.executeCommand(VoltProjectCommands.cancelClone, project.id);
		} else {
			text.textContent = localize('voltAgent.cloneFailedBanner', "Could not clone {0}: {1}", project.name, state.message);
			text.title = state.message;
			action.textContent = localize('voltAgent.retryClone', "Retry");
			action.onclick = () => void this.commandService.executeCommand(VoltProjectCommands.retryClone, project.id);
		}
	}

	/** The chat's own worktree once it has one, else the project's checkout. */
	private statusBranch(): IAgentStatusBranch {
		const session = this.runtime.getOrCreateSession(this.sessionKey);
		if (session.worktreePath) {
			return { name: session.worktreeBranch, worktree: true, path: session.worktreePath };
		}
		const branch = this.landingChrome?.getBranch() ?? {};
		return { name: branch.name, detached: branch.detached, worktree: false };
	}

	private get sessionKey(): string {
		const path = (this.input as AgentEditorInput | undefined)?.resource.path ?? String(getWindow(this.container).vscodeWindowId);
		return path.replace(/\//g, '') || 'agent';
	}
}

const ATTACH_DRAG_TYPES: readonly string[] = [DataTransfers.FILES, DataTransfers.RESOURCES, CodeDataTransfers.EDITORS, CodeDataTransfers.FILES, Mimes.uriList];

/** Files from the OS, or files and tabs dragged inside the app; not text. */
function isAttachDrag(e: DragEvent): boolean {
	const types = e.dataTransfer?.types ?? [];
	return ATTACH_DRAG_TYPES.some(type => types.includes(type));
}

/** The pasted, dropped and picked images and videos of a sent prompt, in text order. */
function userMessageMedia(message: IAgentUserMessage): IAgentDisplayMention[] {
	return message.mentions?.filter(mention => (mention.kind === 'image' && !!mention.image?.bytes.byteLength) || (mention.kind === 'video' && !!mention.video)) ?? [];
}

/** What the queue row shows: the text the user typed, not the agent-facing serialization. */
function queuedPreview(item: IOrchQueueItem): string {
	const display = item.prompt.display as { text?: unknown } | undefined;
	return typeof display?.text === 'string' && display.text.trim() ? display.text : item.prompt.text;
}

/** The checkpoint service registers its commands when it loads; until then the checkpoint UI stays hidden. */
function hasCommand(id: string): boolean {
	return !!CommandsRegistry.getCommand(id);
}

function tooltipDir(path: string): string | undefined {
	const folder = dirname(path.replace(/\\/g, '/'));
	return !folder || folder === '.' ? undefined : folder;
}
