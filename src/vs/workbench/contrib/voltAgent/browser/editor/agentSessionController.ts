/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { alwaysAllowPattern } from '../../../../services/voltRuntime/common/access/wildcard.js';
import { mergeToolInput } from '../../../../services/voltRuntime/common/acpToolInput.js';
import { IVoltEvent, IVoltEventEnvelope, IVoltToolDiff } from '../../../../services/voltRuntime/common/events.js';
import { runStatusLine } from '../../../../services/voltRuntime/common/harness/workLog.js';
import { AgentSessionAttention, AgentSessionStatus, IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { appendProviderNotice, appendTextDelta, appendThoughtDelta, applyExploreInputToActivity, applyExploreResultToActivity, classifyToolActivity, createApprovalBlock, createFileChangeBlock, createTerminalBlock, createToolBlock, describeExploreActivity, findBlockByCallId, findFileBlockByPath, firstCommandName, IAgentActivityItem, IFileChangeBlock, isExploreTool, isFileChangeTool, isShellTool, ITerminalBlock, IToolBlock, looksLikeShell, parseFileTarget, parseShellToolInput, stringifyToolResult, unwrapOutputFence, workCountsForSegments } from '../blocks/agentBlocks.js';
import { agentMessagePlainText } from '../context/agentContextUsage.js';
import { extractToolImage } from '../preview/browserSnapshot.js';
import { extractHttpUrl, extractLocalPreviewUrl, sanitizeBrowserUrl } from '../preview/localPreview.js';
import { computeFileChangePreview, fileChangeVerb, parseToolFileChange } from '../review/fileChangePreviewModel.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import type { IAgentActivity, IAgentAssistantMessage, IAgentMessage } from './agentEditor.js';

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
}

export interface IAgentSessionChange {
	readonly kind: 'render' | 'usage' | 'runEnd';
	readonly aborted?: boolean;
}

export function completeStreamingBlocks(message: IAgentAssistantMessage): void {
	for (const segment of message.segments ?? []) {
		if (segment.kind === 'block' && segment.block.status === 'streaming') {
			segment.block.status = segment.block.type === 'approval' ? 'error' : 'complete';
		}
	}
}

/** An approval card is still waiting on the user's decision. */
export function hasPendingApproval(message: IAgentAssistantMessage): boolean {
	return (message.segments ?? []).some(segment =>
		segment.kind === 'block' && segment.block.type === 'approval' && !segment.block.blocked && !segment.block.decision && segment.block.status === 'streaming');
}

export function hasVisibleReply(message: IAgentAssistantMessage): boolean {
	if ((message.text ?? '').trim()) {
		return true;
	}
	return (message.segments ?? []).some(segment =>
		(segment.kind === 'text' && segment.text.trim()) || (segment.kind === 'notice' && segment.title.trim()));
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
	/** A run finished with queued prompts waiting; the next panel to show this session sends them. */
	private pendingDrain = false;

	constructor(
		private host: IAgentSessionHost,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
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

	consumePendingDrain(): boolean {
		const pending = this.pendingDrain;
		this.pendingDrain = false;
		return pending;
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
		this.agentWorkspace.openSurface(this.host.sessionId, { kind: 'browser', url: clean, title }, true);
	}

	private applyUsage(event: Extract<IVoltEventEnvelope['event'], { type: 'usage' }>, last?: IAgentAssistantMessage): void {
		const prompt = Number.isFinite(event.input) ? event.input : 0;
		const completion = Number.isFinite(event.output) ? event.output : 0;
		const cache = event.cache !== undefined && Number.isFinite(event.cache) ? Math.max(0, event.cache) : 0;
		// Prefer provider/ACP `used`. Otherwise input+output+cache is one turn total
		// so the composer meter matches the Input / Output / Cached chips.
		const measured = event.used !== undefined && Number.isFinite(event.used) && event.used >= 0
			? event.used
			: (prompt + completion + cache > 0 ? prompt + completion + cache : undefined);
		if (measured !== undefined) {
			this.host.contextUsed = measured;
			if (last) {
				last.tokensUsed = measured;
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

	private showProviderNotice(message: IAgentAssistantMessage, activity: IAgentActivity, severity: 'info' | 'warning' | 'error', title: string, description?: string): void {
		const text = title.trim();
		if (!text) {
			return;
		}
		appendProviderNotice(message.segments, { severity, title: text, description });
		activity.status = text;
		activity.statusPinned = true;
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
		last.segments ??= [];
		last.blockState ??= {};

		switch (event.type) {
			case 'run.start':
				this.rawInputs.clear();
				this.rawParsedAt.clear();
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
			case 'text.delta':
				last.text = (last.text ?? '') + (event.delta ?? '');
				appendTextDelta(last.segments, event.delta ?? '');
				activity.statusPinned = false;
				activity.status = localize('voltAgent.writing', "Writing");
				break;
			case 'tool.start': {
				activity.statusPinned = false;
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
						this.mergeFileChange(block, block.input);
					}
					const item = this.findActivityByCallId(last, event.callId);
					if (item) {
						const input = mergeToolInput(item.input, event.delta);
						applyExploreInputToActivity(item, item.toolName ?? item.label, item.toolTitle, input);
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
				this.setAttention('approval');
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
			case 'notice':
				this.showProviderNotice(last, activity, event.severity, event.title, event.description);
				break;
			case 'retry':
				this.showProviderNotice(last, activity, 'warning', event.message);
				activity.items.push({ kind: 'note', label: event.message });
				break;
			case 'error':
				this.showProviderNotice(last, activity, 'error', event.message);
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
				completeStreamingBlocks(last);
				this.cancelPartialRecord();
				this.host.recordAssistant(last, true, last.cancelled ? 'cancelled' : event.reason === 'fail' ? 'error' : 'done', agentMessagePlainText(last));
				this.pendingDrain = event.reason !== 'abort';
				this.fire({ kind: 'runEnd', aborted: event.reason === 'abort' });
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
		const preview = computeFileChangePreview({ original: block.original, modified: block.modified });
		block.additions = preview.additions;
		block.deletions = preview.deletions;
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
