/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { alwaysAllowPattern } from '../../../../services/voltRuntime/common/access/wildcard.js';
import { mergeToolInput } from '../../../../services/voltRuntime/common/acpToolInput.js';
import { IVoltEvent, IVoltEventEnvelope, IVoltToolDiff } from '../../../../services/voltRuntime/common/events.js';
import type { IVoltVisualRef } from '../../../../services/voltRuntime/common/hostTools.js';
import { runStatusLine } from '../../../../services/voltRuntime/common/harness/workLog.js';
import { AgentSessionAttention, AgentSessionStatus, IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { appendProviderNotice, appendSandboxDenial, appendTextDelta, appendThoughtDelta, applyExploreInputToActivity, AgentSegment, applyExploreResultToActivity, classifyToolActivity, createApprovalBlock, createFileChangeBlock, createPlanBlock, createTerminalBlock, createToolBlock, describeExploreActivity, findBlockByCallId, findFileBlockByPath, firstCommandName, IAgentActivityItem, IAgentCompaction, IFileChangeBlock, IPlanBlock, isCompactCommand, isExploreTool, isFileChangeTool, isPlanTool, isShellTool, ITerminalBlock, IToolBlock, looksLikeShell, parseFileTarget, parsePlanToolInput, parseShellToolInput, stringifyToolResult, unwrapOutputFence, workCountsForSegments, isHiddenExploreToolBlock } from '../blocks/agentBlocks.js';
import { sameHostToolArgs } from '../blocks/agentHostToolActivity.js';
import { classifySupervisionNotice, stampTodoSteps } from '../chrome/agentTimeline.js';
import { agentMessagePlainText } from '../context/agentContextUsage.js';
import { extractToolImage } from '../preview/browserSnapshot.js';
import { extractHttpUrl, extractLocalPreviewUrl, sanitizeBrowserUrl } from '../preview/localPreview.js';
import { computeChangeStats, fileChangeVerb, parseToolFileChange } from '../review/fileChangePreviewModel.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import type { IAgentActivity, IAgentAssistantMessage, IAgentMessage, IAgentPromptDisplay, IAgentUserMessage } from './agentEditor.js';

/**
 * How often a streaming reply is snapshotted into history. Each snapshot rewrites the session log,
 * so this trades at most a second of reply text on a crash for far less disk work while streaming.
 */
const PARTIAL_RECORD_DELAY_MS = 1_000;

/** The part of an agent editor input the controller reads and writes. */
export interface IAgentSessionHost {
	readonly sessionId: string;
	messages: IAgentMessage[];
	contextUsed?: number;
	contextWindow?: number;
	recordAssistant(message: IAgentAssistantMessage, final: boolean, status: AgentSessionStatus, plainText: string): void;
	recordUser?(message: IAgentUserMessage): void;
	recordMode?(mode: string): void;
}

/** One turn the orchestrator starts: what the transcript shows and what the model reads. */
export interface IAgentTurnSpec {
	readonly turnId: string;
	/** Model-facing text. */
	readonly text: string;
	readonly display?: IAgentPromptDisplay;
	/** Composer mode label ("Agent", "Plan", ...). */
	readonly mode: string;
	readonly origin?: IAgentUserMessage['origin'];
	readonly taskIds?: readonly string[];
	readonly handoff?: IAgentUserMessage['handoff'];
	readonly scheduled?: IAgentUserMessage['scheduled'];
	readonly fromThread?: IAgentUserMessage['fromThread'];
}

export interface IAgentSessionChange {
	/** `turnStart`: a turn's messages were added (by this panel or by the orchestrator in the background). */
	readonly kind: 'render' | 'usage' | 'runEnd' | 'turnStart';
	readonly turnId?: string;
	readonly aborted?: boolean;
	/** The run ended in an error: queued prompts wait for the user instead of going to a failing provider. */
	readonly failed?: boolean;
}

/** Closes a reply's open cards. `stopped`: the user stopped the turn, so running calls read "Stopped". */
export function completeStreamingBlocks(message: IAgentAssistantMessage, stopped = false): void {
	for (const segment of message.segments ?? []) {
		if (segment.kind === 'block' && segment.block.status === 'streaming') {
			if (stopped && segment.block.type === 'tool') {
				segment.block.stopped = true;
			}
			segment.block.status = segment.block.type === 'approval' ? 'error' : 'complete';
		}
	}
}

/** An approval card is still waiting on the user's decision. */
export function hasPendingApproval(message: IAgentAssistantMessage): boolean {
	return (message.segments ?? []).some(segment =>
		segment.kind === 'block' && segment.block.type === 'approval' && !segment.block.blocked && !segment.block.decision && segment.block.status === 'streaming');
}

function applyCompactionUpdate(compaction: IAgentCompaction, event: Extract<IVoltEvent, { type: 'context.compaction' }>): void {
	if (event.status) {
		compaction.status = event.status;
	}
	if (event.trigger) {
		compaction.trigger = event.trigger;
	}
	if (event.preTokens !== undefined) {
		compaction.preTokens = event.preTokens;
	}
	if (event.postTokens !== undefined) {
		compaction.postTokens = event.postTokens;
	}
	if (event.durationMs !== undefined) {
		compaction.durationMs = event.durationMs;
	}
	if (event.summary !== undefined) {
		compaction.summary = event.summary || undefined;
	}
	if (event.summaryDelta) {
		compaction.summary = (compaction.summary ?? '') + event.summaryDelta;
	}
	if (event.error) {
		compaction.error = event.error;
	}
}

/**
 * When a turn ends, a compaction it left running ends the way the turn did. A `/compact` turn the
 * agent never reported a compaction for, and that answered in words instead, loses its placeholder.
 */
function settleCompactions(reply: IAgentAssistantMessage, outcome: IAgentCompaction['status']): void {
	const answered = reply.segments.some(segment => segment.kind === 'text' && segment.text.trim());
	for (let i = reply.segments.length - 1; i >= 0; i--) {
		const segment = reply.segments[i];
		if (segment.kind !== 'compaction' || segment.compaction.status !== 'running') {
			continue;
		}
		if (segment.compaction.provisional && outcome === 'completed' && answered) {
			reply.segments.splice(i, 1);
			continue;
		}
		segment.compaction.status = outcome;
		delete segment.compaction.provisional;
	}
}

export function hasVisibleReply(message: IAgentAssistantMessage): boolean {
	if ((message.text ?? '').trim()) {
		return true;
	}
	return (message.segments ?? []).some(segment =>
		(segment.kind === 'text' && segment.text.trim()) || (segment.kind === 'notice' && segment.title.trim()) || segment.kind === 'compaction');
}

/**
 * Owns one session's run events, whether or not a chat panel shows it.
 * Events are reduced into the host's transcript and recorded to history here,
 * so switching chats or closing a busy panel never drops tool cards, approvals,
 * or the final reply. A panel only listens to redraw.
 */
export class AgentSessionController extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IAgentSessionChange>());
	readonly onDidChange: Event<IAgentSessionChange> = this._onDidChange.event;

	private readonly _onDidBecomeIdle = this._register(new Emitter<void>());
	readonly onDidBecomeIdle: Event<void> = this._onDidBecomeIdle.event;

	private skipRunEvents = false;
	private activeRunId: string | undefined;
	/** Set from the runtime `lane` event. Preview only opens when the user asked to see something running. */
	private runWantsPreview = false;
	private openedPreviewUrl: string | undefined;
	private previewTimer: ReturnType<typeof setTimeout> | undefined;
	private partialTimer: ReturnType<typeof setTimeout> | undefined;
	/** Raw streamed arguments per call, for native providers that send true deltas. */
	private readonly rawInputs = new Map<string, string>();
	private readonly rawParsedAt = new Map<string, number>();
	/**
	 * Calls that started and have not ended, with the live line each one set. When the last one
	 * ends the line goes back to the model's own "Thinking", so a quiet model after a tool can
	 * read "Taking longer than expected".
	 */
	private readonly runningCalls = new Map<string, string>();
	/** The message the run's last text came from: text from another message starts a new paragraph. */
	private lastTextId: string | undefined;
	/** The run reported real context occupancy (`used`); its end-of-turn totals are not occupancy. */
	private runReportedUsed = false;
	/**
	 * The kept-summary size of the run's last compaction. Claude reports exactly that as `used` right
	 * after compacting, without the system prompt and tools that still come first.
	 */
	private compactedTo: number | undefined;

	constructor(
		private host: IAgentSessionHost,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._register(runtime.onEvent(host.sessionId, envelope => this.apply(envelope)));
		this._register({
			dispose: () => {
				this.cancelPartialRecord();
				if (this.previewTimer !== undefined) {
					clearTimeout(this.previewTimer);
				}
			},
		});
	}

	/** Hand the session to another input for the same chat, e.g. a reopened panel. */
	setHost(host: IAgentSessionHost): void {
		this.host = host;
	}

	/** The transcript shows a live reply and the runtime still has that run open. */
	get isRunning(): boolean {
		const last = this.host.messages.at(-1);
		if (last?.kind !== 'agent' || !last.activity?.streaming) {
			return false;
		}
		const status = this.runtime.getOrCreateSession(this.host.sessionId).activeRun?.status;
		return status === 'running' || status === 'waiting' || status === 'queued';
	}

	/** The user edited an earlier prompt: ignore the rest of the current run. */
	skipCurrentRun(): void {
		this.skipRunEvents = true;
	}

	/**
	 * Adds a turn to the transcript: the user message (or a notification / brief card) and the
	 * streaming reply the run's events land in, and records the prompt before the model is asked.
	 * Views redraw on `turnStart`; nothing here needs a panel.
	 */
	beginTurn(spec: IAgentTurnSpec): IAgentAssistantMessage {
		const existing = this.host.messages.findIndex(message => message.kind === 'user' && message.id === spec.turnId);
		if (existing >= 0) {
			// A retried start of the same turn reuses its messages.
			const reply = this.host.messages[existing + 1];
			if (reply?.kind === 'agent') {
				return reply;
			}
		}
		this.cancelPartialRecord();
		const user: IAgentUserMessage = {
			kind: 'user',
			id: spec.turnId,
			text: spec.display?.text.trim() || spec.text,
			agentText: spec.display ? spec.text : undefined,
			mentions: spec.display?.mentions,
			mode: spec.mode,
			...(spec.origin ? { origin: spec.origin } : {}),
			...(spec.taskIds?.length ? { taskIds: [...spec.taskIds] } : {}),
			...(spec.handoff ? { handoff: spec.handoff } : {}),
			...(spec.scheduled ? { scheduled: spec.scheduled } : {}),
			...(spec.fromThread ? { fromThread: spec.fromThread } : {}),
		};
		const reply: IAgentAssistantMessage = {
			kind: 'agent',
			id: spec.turnId,
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
		if (isCompactCommand(spec.text) && reply.activity) {
			// "Compacting context" from the first frame: the agent reports its compaction only once the
			// prompt reaches it, and the checkpoint before a turn can take a couple of seconds.
			reply.segments.push({ kind: 'compaction', compaction: { id: `pending-${spec.turnId}`, status: 'running', trigger: 'manual', startedAt: Date.now(), provisional: true } });
			reply.activity.status = localize('voltAgent.compaction.running', "Compacting context");
			reply.activity.statusPinned = true;
		}
		this.host.messages.push(user, reply);
		// The prompt is durable before the model is asked.
		this.host.recordUser?.(user);
		this.host.recordMode?.(spec.mode);
		this.fire({ kind: 'turnStart', turnId: spec.turnId });
		return reply;
	}

	/** The turn never reached the runtime (it failed or was stopped while starting): close its reply. */
	endUnstartedTurn(turnId: string, failure: string | undefined): void {
		const reply = this.host.messages.find((message): message is IAgentAssistantMessage => message.kind === 'agent' && message.id === turnId);
		if (!reply?.activity?.streaming) {
			return;
		}
		reply.activity.streaming = false;
		completeStreamingBlocks(reply, !failure);
		reply.endedAt = Date.now();
		reply.durationMs = reply.endedAt - (reply.startedAt ?? reply.endedAt);
		if (failure) {
			reply.outcome = 'failed';
			reply.failure = { message: failure };
		} else {
			reply.cancelled = true;
			reply.outcome = 'stopped';
			reply.activity.status = localize('voltAgent.cancelled', "Cancelled");
		}
		this.host.recordAssistant(reply, true, failure ? 'error' : 'cancelled', agentMessagePlainText(reply));
		this.fire({ kind: 'runEnd', aborted: !failure, failed: !!failure });
		this._onDidBecomeIdle.fire();
	}

	/** A message steered into the running turn: the reply shows where it landed. False when nothing runs. */
	recordSteer(text: string): boolean {
		const reply = this.host.messages.at(-1);
		if (reply?.kind !== 'agent' || !reply.activity?.streaming) {
			return false;
		}
		(reply.steers ??= []).push({ text, at: reply.segments.length });
		this.host.recordAssistant(reply, false, 'running', agentMessagePlainText(reply));
		this.fire({ kind: 'render' });
		return true;
	}

	private fire(change: IAgentSessionChange): void {
		this._onDidChange.fire(change);
	}

	private defaultCwd(): string | undefined {
		return this.sessionContext.rootFor(this.host.sessionId)?.fsPath
			?? this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	private schedulePartialRecord(message: IAgentAssistantMessage): void {
		if (this.partialTimer !== undefined || !message.activity?.streaming) {
			return;
		}
		this.partialTimer = setTimeout(() => {
			this.partialTimer = undefined;
			if (message.activity?.streaming) {
				this.host.recordAssistant(message, false, 'running', agentMessagePlainText(message));
			}
		}, PARTIAL_RECORD_DELAY_MS);
	}

	/** Tells the sidebar the harness is blocked on the user, or no longer is. */
	private setAttention(attention: AgentSessionAttention | undefined): void {
		void this.history.setAttention(this.host.sessionId, attention);
	}

	private cancelPartialRecord(): void {
		if (this.partialTimer !== undefined) {
			clearTimeout(this.partialTimer);
			this.partialTimer = undefined;
		}
	}

	/**
	 * Some agents (Cursor) report a Volt MCP call as `{ success: true }`, so the page state the
	 * host returned is attached here, to the newest row for the same tool and arguments.
	 */
	private attachHostToolResult(last: IAgentAssistantMessage, event: Extract<IVoltEventEnvelope['event'], { type: 'host.tool' }>): void {
		const rows = (last.segments ?? [])
			.filter((segment): segment is Extract<AgentSegment, { kind: 'activity' }> => segment.kind === 'activity')
			.map(segment => segment.item)
			.filter(item => item.browserTool === event.name && item.result === undefined && item.error === undefined);
		const item = rows.reverse().find(row => !row.hostArgs || sameHostToolArgs(row.hostArgs, event.args)) ?? rows[0];
		if (!item) {
			return;
		}
		item.result = event.text ?? '';
		if (event.error) {
			item.error = event.error;
		}
		if (event.image) {
			item.image = event.image;
		}
	}

	/**
	 * A chart or page from render_chart / render_html: a block in the reply (the transcript lifts it
	 * above the final text). The call's row keeps only the title, since the stored copy is the visual.
	 */
	private attachVisual(last: IAgentAssistantMessage, visual: IVoltVisualRef, tool: string): void {
		const id = `visual-${visual.ref.replace(/[^a-z0-9]/gi, '').slice(-24)}`;
		if (last.segments.some(segment => segment.kind === 'block' && segment.block.id === id)) {
			return;
		}
		last.segments.push({ kind: 'block', block: { id, type: 'visual', status: 'complete', kind: visual.kind, title: visual.title, ref: visual.ref, ...(visual.height ? { height: visual.height } : {}), ...(visual.heights?.length ? { heights: visual.heights } : {}), ...(visual.cap ? { cap: visual.cap } : {}) } });
		for (const segment of last.segments) {
			if (segment.kind === 'activity' && segment.item.browserTool === tool && segment.item.input && segment.item.input.length > 2000) {
				segment.item.input = JSON.stringify({ title: visual.title });
				segment.item.hostArgs = { title: visual.title };
			}
		}
	}

	/** Opens in the session that produced it, so a background run never takes over the visible chat. */
	private openPreview(url: string): void {
		const clean = sanitizeBrowserUrl(url) ?? extractLocalPreviewUrl(url) ?? extractHttpUrl(url) ?? url;
		if (this.openedPreviewUrl === clean) {
			return;
		}
		this.openedPreviewUrl = clean;
		let title = localize('voltBrowser.local', "Local");
		try {
			title = new URL(clean).hostname;
		} catch {
			// keep fallback
		}
		// The agent's preview floats over the chat unless the chat already has tools open beside it.
		this.agentWorkspace.openSurface(this.host.sessionId, { kind: 'browser', url: clean, title, floating: true }, true);
	}

	private applyUsage(event: Extract<IVoltEventEnvelope['event'], { type: 'usage' }>, last?: IAgentAssistantMessage): void {
		const prompt = Number.isFinite(event.input) ? event.input : 0;
		const completion = Number.isFinite(event.output) ? event.output : 0;
		const cache = event.cache !== undefined && Number.isFinite(event.cache) ? Math.max(0, event.cache) : 0;
		// Prefer provider/ACP `used`. Otherwise input+output+cache is one turn total
		// so the composer meter matches the Input / Output / Cached chips.
		const reported = event.used !== undefined && Number.isFinite(event.used) && event.used >= 0;
		this.runReportedUsed ||= reported;
		// Claude's end-of-turn usage sums cache reads over every model call of the turn (175k for a
		// 28k context): once the run reported `used`, totals like that only fill the chips.
		const measured = reported
			? event.used
			: (!this.runReportedUsed && prompt + completion + cache > 0 ? prompt + completion + cache : undefined);
		if (measured !== undefined) {
			this.host.contextUsed = measured;
			if (last) {
				last.tokensUsed = measured;
				// The context meter adds the system prompt and tools back onto Claude's post-compaction figure.
				if (reported && this.compactedTo !== undefined && event.used === this.compactedTo) {
					last.usageExcludesPrompt = true;
				} else if (last.usageExcludesPrompt) {
					last.usageExcludesPrompt = undefined;
				}
				// The chat's first prompt-side figure: system prompt, tools and the first message, the floor every later turn sits on.
				if (reported && last.tokensBase === undefined && this.host.messages.find(message => message.kind === 'agent') === last) {
					last.tokensBase = event.used;
				}
			}
		}
		if (event.size !== undefined && Number.isFinite(event.size) && event.size > 0) {
			this.host.contextWindow = event.size;
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

	/**
	 * A compaction the agent reported: one row per id, patched as its updates arrive. A `/compact`
	 * turn's provisional row becomes the agent's first one.
	 */
	private applyCompaction(last: IAgentAssistantMessage, activity: IAgentActivity, event: Extract<IVoltEvent, { type: 'context.compaction' }>): void {
		const rows = last.segments.flatMap(segment => segment.kind === 'compaction' ? [segment.compaction] : []);
		let compaction = rows.find(row => row.id === event.id);
		if (!compaction) {
			compaction = rows.find(row => row.provisional && row.status === 'running');
			if (compaction) {
				compaction.id = event.id;
				delete compaction.provisional;
			} else {
				compaction = { id: event.id, status: 'running', startedAt: Date.now() };
				last.segments.push({ kind: 'compaction', compaction });
			}
			// The agent may not say how big the context was: the meter's last reading is.
			compaction.preTokens ??= this.host.contextUsed;
		}
		applyCompactionUpdate(compaction, event);
		if (compaction.status === 'running') {
			activity.status = compaction.trigger === 'auto'
				? localize('voltAgent.compaction.autoRunning', "Auto-compacting context")
				: localize('voltAgent.compaction.running', "Compacting context");
			activity.statusPinned = true;
			return;
		}
		if (compaction.status === 'completed' && compaction.postTokens !== undefined) {
			this.compactedTo = compaction.postTokens;
		}
		activity.statusPinned = false;
		activity.status = localize('voltAgent.thinking', "Thinking");
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
					cwd: event.cwd || this.defaultCwd(),
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

	private replaceCallBlock(last: IAgentAssistantMessage, callId: string, block: ITerminalBlock | IFileChangeBlock | IToolBlock | IPlanBlock): void {
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

	private showProviderNotice(message: IAgentAssistantMessage, activity: IAgentActivity, severity: 'info' | 'warning' | 'error', title: string, description?: string): void {
		const text = title.trim();
		if (!text) {
			return;
		}
		// A run supervisor's finding (loop, stall, budget) becomes a tray with actions, not a red line.
		const supervision = classifySupervisionNotice(`${text}\n${description ?? ''}`);
		appendProviderNotice(message.segments, { severity, title: text, description, ...(supervision ? { supervision } : {}) });
		activity.status = text;
		activity.statusPinned = true;
	}

	/** A call ended: the live line falls back to the newest call still running, else to the model. */
	private settleCall(activity: IAgentActivity, callId: string): void {
		if (!this.runningCalls.delete(callId) || activity.statusPinned) {
			return;
		}
		const running = [...this.runningCalls.values()];
		activity.status = running.at(-1) ?? localize('voltAgent.thinking', "Thinking");
	}

	private apply(envelope: IVoltEventEnvelope): void {
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
		const last = this.host.messages.at(-1);
		if (event.type === 'usage') {
			this.applyUsage(event, last?.kind === 'agent' ? last : undefined);
			this.fire({ kind: 'usage' });
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
		activity.lastEventAt = Date.now();
		last.segments ??= [];
		last.blockState ??= {};

		switch (event.type) {
			case 'run.start':
				this.rawInputs.clear();
				this.rawParsedAt.clear();
				this.runningCalls.clear();
				this.lastTextId = undefined;
				this.runReportedUsed = false;
				this.compactedTo = undefined;
				last.runId = envelope.runId;
				last.outcome = undefined;
				last.failure = undefined;
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
				this.setAttention('question');
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
				activity.statusPinned = false;
				activity.status = localize('voltAgent.thinking', "Thinking");
				activity.thinkingText = (activity.thinkingText ?? '') + (event.delta ?? '');
				appendThoughtDelta(last.segments, event.delta ?? '');
				break;
			case 'text.delta': {
				// Claude speaks again after a subagent reports, with no tool between: without a break
				// "…to finish..." and "Both subagents completed" ran together into one line.
				const tail = last.segments.at(-1);
				let delta = event.delta ?? '';
				if (this.lastTextId !== undefined && event.id !== this.lastTextId && tail?.kind === 'text' && tail.text.trim() && !tail.text.endsWith('\n\n')) {
					delta = (tail.text.endsWith('\n') ? '\n' : '\n\n') + delta;
				}
				this.lastTextId = event.id;
				last.text = (last.text ?? '') + delta;
				appendTextDelta(last.segments, delta);
				activity.statusPinned = false;
				activity.status = localize('voltAgent.writing', "Writing");
				break;
			}
			case 'tool.start': {
				activity.statusPinned = false;
				if (isTodoTool(event.name, event.title, event.input)) {
					// The list itself arrives as a plan update and is drawn as "Added 4 to-dos" rows.
					activity.status = localize('voltAgent.todo.updating', "Updating to-dos");
					this.runningCalls.set(event.callId, activity.status);
					break;
				}
				// The native create_plan tool is presented as a generic card; it is drawn as the plan card.
				if (event.card && !isPlanTool(event.name, event.title, event.input)) {
					this.applyPresentedTool(last, event, activity);
					this.runningCalls.set(event.callId, activity.status);
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
					// A plan tool is drawn as the plan card below, not as an extra step row.
					if (!fileChange && !isPlanTool(event.name, event.title, event.input)) {
						const described = describeExploreActivity(event.name, event.title, event.input);
						const item: IAgentActivityItem = {
							kind: described.kind ?? classifyToolActivity(event.name, event.title, kind),
							...(described.browserTool ? { browserTool: described.browserTool, hostArgs: described.hostArgs } : {}),
							...(described.hidden ? { hidden: true } : {}),
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
					const cwd = event.cwd || parsed.cwd || this.defaultCwd();
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
				} else if (isPlanTool(event.name, event.title, event.input)) {
					const parsedPlan = parsePlanToolInput(event.input);
					last.segments.push({
						kind: 'block',
						block: createPlanBlock({ id, callId: event.callId, input: event.input, name: parsedPlan.name, markdown: parsedPlan.plan ?? '', openQuestions: parsedPlan.openQuestions }),
					});
					activity.status = localize('voltAgent.planning', "Planning");
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
				this.runningCalls.set(event.callId, activity.status);
				break;
			}
			case 'tool.input.delta': {
				if (event.append) {
					this.applyAppendedInput(last, activity, event.callId, event.delta);
					break;
				}
				const block = findBlockByCallId(last.segments, event.callId);
				if (block?.type === 'terminal') {
					const parsed = parseShellToolInput(event.delta);
					if (/^\s*[{[]/.test(event.delta)) {
						// A structured snapshot of the whole input so far: it replaces, never appends.
						if (parsed.command) {
							block.command = parsed.command;
						}
						if (parsed.title) {
							block.title = parsed.title;
						}
					} else {
						const next = parsed.command || event.delta;
						block.command = block.command
							? (block.command.includes(next) ? block.command : block.command + next)
							: next;
						if (parsed.title && !block.title) {
							block.title = parsed.title;
						}
					}
					if (parsed.cwd && !block.cwd) {
						block.cwd = parsed.cwd;
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
						block.input = mergeToolInput(block.input, event.delta);
						if (isPlanTool('', undefined, block.input)) {
							// The plan tool announces itself as an edit until its input arrives.
							this.replaceCallBlock(last, block.callId ?? event.callId, this.planFromInput(block.id, block.callId ?? event.callId, block.input));
						} else {
							this.mergeFileChange(block, block.input);
						}
					} else if (block?.type === 'plan') {
						block.input = mergeToolInput(block.input, event.delta);
						const parsedPlan = parsePlanToolInput(block.input);
						block.name = parsedPlan.name ?? block.name;
						block.markdown = parsedPlan.plan ?? block.markdown;
						block.openQuestions = parsedPlan.openQuestions ?? block.openQuestions;
					}
					const item = this.findActivityByCallId(last, event.callId);
					if (item) {
						const input = mergeToolInput(item.input, event.delta);
						applyExploreInputToActivity(item, item.toolName ?? item.label, item.toolTitle, input);
						this.promoteToPlanCard(last, event.callId, item.toolName ?? '', item.toolTitle, input);
					}
				}
				break;
			}
			case 'tool.update': {
				const block = findBlockByCallId(last.segments, event.callId);
				if (block?.type === 'file') {
					this.applyToolDiff(block, event.diffs?.[0], event.locations?.[0]?.path);
				}
				const item = this.findActivityByCallId(last, event.callId);
				if (item && event.title && event.title !== item.toolTitle) {
					item.toolTitle = event.title;
					applyExploreInputToActivity(item, item.toolName ?? item.label, event.title, item.input);
					this.promoteToPlanCard(last, event.callId, item.toolName ?? '', event.title, item.input);
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
				// Read and plan output is not kept in the transcript text, but the model read it: the context meter estimates it.
				const keptInText = block?.type === 'terminal' || (block?.type === 'tool' && !isHiddenExploreToolBlock(block));
				const outputChars = (event.output || output).length;
				if (!keptInText && outputChars > 0) {
					last.toolOutputChars = (last.toolOutputChars ?? 0) + outputChars;
				} else if (!keptInText) {
					// Cursor and Grok end a read without its content: the file on disk is what the model received.
					this.countReadFile(last, event.callId);
				}
				if (block?.type === 'terminal') {
					block.output = unwrapOutputFence(event.output || output);
					block.status = event.error ? 'error' : 'complete';
					block.exitCode = event.exitCode ?? (event.error ? 1 : 0);
					if (event.title) {
						block.title = event.title;
					}
					this.maybeOpenLocalPreview(block.output, block.command, 0);
				} else if (block?.type === 'tool') {
					block.output = event.output || output;
					block.status = event.error ? 'error' : 'complete';
				} else if (block?.type === 'plan') {
					block.status = event.error ? 'error' : 'complete';
				} else if (block?.type === 'file') {
					block.output = event.output || output;
					block.status = event.error ? 'error' : 'complete';
					if (event.diffs?.[0]) {
						this.applyToolDiff(block, event.diffs[0]);
					} else {
						this.mergeFileChange(block, block.input, block.output, event.result);
					}
				}
				const item = this.findActivityByCallId(last, event.callId);
				if (item) {
					applyExploreResultToActivity(item, event.result, item.input);
					if (event.view) {
						item.view = event.view;
					}
				}
				const done = this.findActivityByCallId(last, event.callId);
				if (done) {
					this.promoteToPlanCard(last, event.callId, done.toolName ?? '', event.title ?? done.toolTitle, done.input);
				}
				this.settleCall(activity, event.callId);
				break;
			}
			case 'plan': {
				// A turn's first update continues the chat's list: Claude's task tools and Cursor's to-dos outlive a turn.
				const previous = last.steps.length ? last.steps : this.host.messages.findLast((message): message is IAgentAssistantMessage => message !== last && message.kind === 'agent' && message.steps.length > 0)?.steps ?? [];
				last.title = localize('voltAgent.planTitle', "Plan");
				last.steps = stampTodoSteps(previous, event.entries.map(entry => ({
					label: entry.content,
					state: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'current' : 'pending',
				})), Date.now());
				// Cursor writes to-do changes into the timeline: "Added 4 to-dos", "Completed 2 of 6 Fix the bug".
				const todo = describeTodoUpdate(previous, last.steps);
				if (todo) {
					last.segments.push({ kind: 'activity', item: { kind: 'note', label: todo.label, ...(todo.detail ? { detail: todo.detail } : {}) } });
				}
				break;
			}
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
				this.setAttention('approval');
				break;
			}
			case 'question.ask':
				activity.status = localize('voltAgent.waitingAnswer', "Waiting for your answers");
				activity.statusPinned = true;
				this.setAttention('question');
				break;
			case 'question.resolved': {
				activity.statusPinned = false;
				if (event.outcome === 'answered' && event.answers.length) {
					last.segments.push({
						kind: 'block',
						block: {
							type: 'answers',
							id: `answers-${event.requestId}`,
							status: 'complete',
							requestId: event.requestId,
							outcome: event.outcome,
							items: event.answers.map(item => ({
								question: item.question,
								answer: item.answer,
								...(item.attachments?.length ? { attachments: item.attachments.map(file => ({ name: file.name, kind: file.kind, size: file.size, path: file.path })) } : {}),
							})),
							...(event.note ? { note: event.note } : {}),
						},
					});
				}
				if (this.history.get(this.host.sessionId)?.attention === 'question') {
					this.setAttention(undefined);
				}
				break;
			}
			case 'host.tool':
				this.attachHostToolResult(last, event);
				if (event.visual) {
					this.attachVisual(last, event.visual, event.name);
				}
				break;
			case 'access.resolved': {
				for (const segment of last.segments) {
					if (segment.kind === 'block' && segment.block.type === 'approval' && segment.block.requestId === event.requestId) {
						segment.block.decision = event.effect;
						segment.block.scope = event.scope;
						segment.block.status = event.effect === 'deny' ? 'error' : 'complete';
					}
				}
				if (!hasPendingApproval(last) && this.history.get(this.host.sessionId)?.attention === 'approval') {
					this.setAttention(undefined);
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
			case 'title':
				void this.history.setAgentTitle(this.host.sessionId, event.text);
				break;
			case 'tool.progress': {
				// A sub-agent or a long tool reports each step; the card shows the latest few.
				activity.status = event.status;
				activity.statusPinned = false;
				const block = findBlockByCallId(last.segments, event.callId);
				if (block?.type === 'tool') {
					const lines = (block.output ? block.output.split('\n') : []).concat(event.status).slice(-6);
					block.output = lines.join('\n');
				}
				break;
			}
			case 'subagent.spawned': {
				// Native subagents arrive without a Task call in the parent's stream: draw one row for them.
				if (!findBlockByCallId(last.segments, event.childId) && !(event.parentToolCallId && findBlockByCallId(last.segments, event.parentToolCallId))) {
					last.segments.push({
						kind: 'block',
						block: createToolBlock({
							id: `tool-${event.childId}`,
							callId: event.childId,
							name: 'Task',
							title: event.title,
							input: JSON.stringify({ description: event.title, ...(event.prompt ? { prompt: event.prompt } : {}), ...(event.kind ? { subagent_type: event.kind } : {}) }),
						}),
					});
				}
				activity.status = localize('voltAgent.subagentStarted', "Started {0}", event.title);
				break;
			}
			case 'subagent.update': {
				const block = findBlockByCallId(last.segments, event.childId) ?? (event.parentToolCallId ? findBlockByCallId(last.segments, event.parentToolCallId) : undefined);
				if (block?.type === 'tool' && event.activity) {
					block.output = (block.output ? block.output.split('\n') : []).concat(event.activity).slice(-6).join('\n');
				}
				break;
			}
			case 'subagent.event':
				// The child's own steps belong to its row (and its own chat), not to this reply's steps.
				break;
			case 'subagent.completed': {
				const block = findBlockByCallId(last.segments, event.childId);
				if (block?.type === 'tool' && block.status === 'streaming') {
					block.status = event.status === 'failed' ? 'error' : 'complete';
					block.stopped = event.status === 'cancelled';
					if (event.result) {
						block.output = event.result;
					}
				}
				break;
			}
			case 'model.reported':
				this.applyReportedModel(last, event);
				break;
			case 'context.compaction':
				this.applyCompaction(last, activity, event);
				break;
			case 'context.handoff': {
				// Kept on the prompt the handoff went out with: its divider shows what was sent.
				const index = this.host.messages.lastIndexOf(last);
				const user = this.host.messages[index - 1];
				if (user?.kind === 'user' && user.id === last.id) {
					const { type: _type, ...info } = event;
					user.contextHandoff = info;
					this.host.recordUser?.(user);
				}
				break;
			}
			case 'notice':
				this.showProviderNotice(last, activity, event.severity, event.title, event.description);
				break;
			case 'sandbox.denial':
				appendSandboxDenial(last.segments, event.denial);
				break;
			case 'retry':
				this.showProviderNotice(last, activity, 'warning', event.message);
				activity.items.push({ kind: 'note', label: event.message });
				break;
			case 'error':
				last.failure = { message: event.message, ...(event.retryable !== undefined ? { retryable: event.retryable } : {}) };
				this.showProviderNotice(last, activity, 'error', event.message);
				break;
			case 'run.end':
				activity.streaming = false;
				activity.expanded = false;
				this.runningCalls.clear();
				last.cancelled = last.cancelled || event.reason === 'abort';
				last.outcome = last.cancelled ? 'stopped' : event.reason === 'fail' ? 'failed' : 'done';
				last.endedAt = Date.now();
				last.startedAt ??= last.endedAt;
				last.durationMs = Math.max(0, last.endedAt - last.startedAt);
				settleCompactions(last, last.cancelled ? 'cancelled' : event.reason === 'fail' ? 'failed' : 'completed');
				if (!last.cancelled && event.reason !== 'fail' && !hasVisibleReply(last)) {
					const empty = localize('voltAgent.emptyReply', "Stopped before a reply.");
					last.text = empty;
					appendTextDelta(last.segments, empty);
				}
				activity.status = last.cancelled
					? localize('voltAgent.cancelled', "Cancelled")
					: runStatusLine(workCountsForSegments(last.segments), last.durationMs);
				completeStreamingBlocks(last, last.cancelled);
				this.cancelPartialRecord();
				this.host.recordAssistant(last, true, last.cancelled ? 'cancelled' : event.reason === 'fail' ? 'error' : 'done', agentMessagePlainText(last));
				// The orchestrator sends the next queued prompt; after an error its queue waits for the user.
				this.fire({ kind: 'runEnd', aborted: last.cancelled, failed: last.outcome === 'failed' });
				this._onDidBecomeIdle.fire();
				return;
		}
		this.schedulePartialRecord(last);
		this.fire({ kind: 'render' });
	}

	/**
	 * Native tool arguments stream as true deltas: append them to one raw buffer per call. The
	 * snapshot merge used for ACP drops any fragment it has already seen, which garbled previews.
	 * Parsing a large write on every delta is quadratic, so file previews re-parse in steps.
	 */
	private applyAppendedInput(last: IAgentAssistantMessage, activity: IAgentActivity, callId: string, delta: string): void {
		const raw = (this.rawInputs.get(callId) ?? '') + delta;
		this.rawInputs.set(callId, raw);
		const block = findBlockByCallId(last.segments, callId);
		if (block?.type === 'terminal') {
			const parsed = parseShellToolInput(raw);
			if (parsed.command) {
				block.command = parsed.command;
			}
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
			}
			return;
		}
		if (block?.type === 'tool') {
			block.input = raw;
		} else if (block?.type === 'plan') {
			// Native create_plan streams its arguments; the card fills in once they parse.
			block.input = raw;
			const parsedPlan = parsePlanToolInput(raw);
			block.name = parsedPlan.name ?? block.name;
			block.markdown = parsedPlan.plan ?? block.markdown;
			block.openQuestions = parsedPlan.openQuestions ?? block.openQuestions;
		} else if (block?.type === 'file') {
			block.input = raw;
			const parsedAt = this.rawParsedAt.get(callId) ?? 0;
			if (raw.length - parsedAt > 1_500 || raw.length < 1_500) {
				this.rawParsedAt.set(callId, raw.length);
				this.mergeFileChange(block, raw);
			}
		}
		const item = this.findActivityByCallId(last, callId);
		if (item) {
			item.input = raw;
			applyExploreInputToActivity(item, item.toolName ?? item.label, item.toolTitle, raw);
		}
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
		if (this.previewTimer !== undefined) {
			clearTimeout(this.previewTimer);
		}
		this.previewTimer = setTimeout(() => {
			this.previewTimer = undefined;
			this.openPreview(url);
		}, delay);
	}

	/**
	 * The divider names the model the provider reports running, not the one requested: Cursor can fall back
	 * to Composer 2.5 after a plan wall, and the handoff said Claude Haiku.
	 */
	private applyReportedModel(last: IAgentAssistantMessage, event: Extract<IVoltEvent, { type: 'model.reported' }>): void {
		const index = this.host.messages.lastIndexOf(last);
		const user = this.host.messages[index - 1];
		if (user?.kind !== 'user' || user.id !== last.id) {
			return;
		}
		const item = this.runtime.listCatalog().find(entry => entry.kind === 'model' && entry.providerId === event.provider && (entry.id === event.model || entry.id.replace(/\[.*\]$/, '') === event.model));
		const label = item?.label ?? event.model;
		let changed = false;
		if (user.contextHandoff && user.contextHandoff.toLabel !== label) {
			user.contextHandoff = { ...user.contextHandoff, toLabel: label };
			changed = true;
		}
		if (user.handoff && user.handoff.toLabel !== label) {
			user.handoff = { ...user.handoff, toLabel: label };
			changed = true;
		}
		if (changed) {
			this.host.recordUser?.(user);
		}
	}

	/** Sizes a finished read from disk into the reply's unkept tool output (the whole file: the runtime sends no range). */
	private countReadFile(message: IAgentAssistantMessage, callId: string): void {
		const item = this.findActivityByCallId(message, callId);
		const path = item?.kind === 'read' ? item.path ?? item.files?.[0] : undefined;
		if (!path) {
			return;
		}
		this.fileService.stat(URI.file(path)).then(stat => {
			if (stat.isFile && stat.size > 0) {
				message.toolOutputChars = (message.toolOutputChars ?? 0) + stat.size;
				this.fire({ kind: 'usage' });
			}
		}, () => { /* Not a local file: the estimate stays without it. */ });
	}

	private findActivityByCallId(message: IAgentAssistantMessage, callId: string): IAgentActivityItem | undefined {
		for (const segment of message.segments) {
			if (segment.kind === 'activity' && segment.item.callId === callId) {
				return segment.item;
			}
		}
		return message.activity?.items.find(item => item.callId === callId);
	}

	/**
	 * Cursor starts an MCP call as a generic row and names it only later, so a plan tool may first show
	 * as an activity row. Once its name or arguments say it is a plan, the row becomes the plan card.
	 */
	private promoteToPlanCard(last: IAgentAssistantMessage, callId: string, name: string, title: string | undefined, input: string | undefined): void {
		if (!isPlanTool(name, title, input) || findBlockByCallId(last.segments, callId)) {
			return;
		}
		const index = last.segments.findIndex(segment => segment.kind === 'activity' && segment.item.callId === callId);
		if (index === -1) {
			return;
		}
		const id = `tool-${callId}`;
		const parsed = parsePlanToolInput(input);
		last.segments[index] = { kind: 'block', block: createPlanBlock({ id, callId, input, name: parsed.name, markdown: parsed.plan ?? '', openQuestions: parsed.openQuestions }) };
		last.blockState[id] = last.blockState[id] ?? { expanded: false };
		const items = last.activity?.items;
		const at = items?.findIndex(item => item.callId === callId) ?? -1;
		if (items && at !== -1) {
			items.splice(at, 1);
		}
	}

	private planFromInput(id: string, callId: string, input: string | undefined): IPlanBlock {
		const parsed = parsePlanToolInput(input);
		return createPlanBlock({ id, callId, input, name: parsed.name, markdown: parsed.plan ?? '', openQuestions: parsed.openQuestions });
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

	/** An agent's own `{ path, oldText, newText }` for the call is better than anything parsed from its input. */
	private applyToolDiff(block: IFileChangeBlock, diff: IVoltToolDiff | undefined, location?: string): void {
		if (!diff) {
			if (location && !block.path.includes('/') && !block.path.includes('.')) {
				block.path = location;
			}
			return;
		}
		block.path = diff.path || block.path;
		block.original = diff.oldText ?? '';
		block.modified = diff.newText;
		block.unifiedDiff = undefined;
		const stats = computeChangeStats({ original: block.original, modified: block.modified });
		block.additions = stats.additions;
		block.deletions = stats.deletions;
		block.verb = diff.oldText === null ? 'Created' : fileChangeVerb(block.verb, block.path, block.path);
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
}

/** The timeline line for a to-do list change, or undefined when nothing worth a row changed. */
export function describeTodoUpdate(previous: readonly { label: string; state: string }[], next: readonly { label: string; state: string }[]): { label: string; detail?: string } | undefined {
	if (!next.length) {
		return undefined;
	}
	if (!previous.length) {
		return { label: next.length === 1 ? localize('voltAgent.todo.addedOne', "Added 1 to-do") : localize('voltAgent.todo.added', "Added {0} to-dos", next.length) };
	}
	const wasDone = new Set(previous.filter(step => step.state === 'done').map(step => step.label));
	const finished = next.filter(step => step.state === 'done' && !wasDone.has(step.label));
	const done = next.filter(step => step.state === 'done').length;
	if (finished.length === 1) {
		return { label: localize('voltAgent.todo.completedOf', "Completed {0} of {1}", done, next.length), detail: finished[0].label };
	}
	if (finished.length > 1) {
		return { label: localize('voltAgent.todo.completedMany', "Completed {0} of {1} to-dos", done, next.length) };
	}
	const known = new Set(previous.map(step => step.label));
	const added = next.filter(step => !known.has(step.label)).length;
	if (added) {
		return { label: added === 1 ? localize('voltAgent.todo.addedOne', "Added 1 to-do") : localize('voltAgent.todo.added', "Added {0} to-dos", added) };
	}
	return undefined;
}

/** Agents' to-do tools (Cursor's updateTodos, Claude's TodoWrite): drawn from the plan they publish. */
export function isTodoTool(name: string | undefined, title: string | undefined, input: string | undefined): boolean {
	return /^(todo_?write|update_?todos|todowrite|manage_?todo_?list)$/i.test(name ?? '')
		|| /^update todos\b/i.test(title ?? '')
		|| /"_toolName"\s*:\s*"updateTodos"/.test(input ?? '');
}
