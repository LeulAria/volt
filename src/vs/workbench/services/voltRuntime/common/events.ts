/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IAccessRequest } from './access/accessTypes.js';
import type { HandoffReason } from './contextHandoff.js';
import type { VoltLane } from './harness/lanes.js';
import type { TaskPhase } from './harness/lifecycle.js';
import type { ToolKind } from './harness/workLog.js';
import type { IVoltVisualRef } from './hostTools.js';
import { VoltMode } from './modes.js';
import type { IAgentAnsweredQuestion, IAgentQuestionRequest, IAgentQuestionResponse } from './questions.js';

/** DeepSeek tool card. The editor picks a Volt block from this instead of the tool name. */
export type IVoltToolCard = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web';

export interface IVoltToolDiff {
	readonly path: string;
	readonly oldText: string | null;
	readonly newText: string;
}

export interface IVoltToolLocation {
	readonly path: string;
	readonly line?: number;
}

/** Completed search, read, or web card. The editor draws this instead of raw tool text. */
export type IVoltToolView =
	| { readonly card: 'search'; readonly shape: 'matches'; readonly files: readonly { readonly path: string; readonly matches: readonly { readonly lineNumber: number; readonly line: string }[] }[]; readonly total: number; readonly truncated?: boolean }
	| { readonly card: 'search'; readonly shape: 'paths'; readonly paths: readonly string[]; readonly total: number; readonly truncated?: boolean }
	| { readonly card: 'read'; readonly path: string; readonly lines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number }
	| { readonly card: 'web'; readonly kind: 'search'; readonly sources: readonly { readonly url: string; readonly title?: string }[]; readonly answer?: string }
	| { readonly card: 'web'; readonly kind: 'fetch'; readonly url: string; readonly statusCode: number };

/** Where a context compaction is: summarizing, or how it ended. */
export type VoltCompactionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type IVoltEvent =
	| { type: 'run.start'; runId: string; mode: VoltMode }
	/** Which lane the intent router chose and why. Emitted once per run right after run.start. */
	| { type: 'lane'; lane: VoltLane; signals: readonly string[]; wantsPreview: boolean; wantsWeb: boolean }
	| { type: 'lifecycle'; phase: TaskPhase }
	| { type: 'clarify'; question: string; reasons: readonly string[] }
	| { type: 'decision'; title: string; detail: string }
	| { type: 'outcome'; headline: string; markdown: string; status: 'completed' | 'partial' | 'failed' | 'cancelled' }
	| { type: 'step.start' | 'step.end'; step: number }
	| { type: 'text.start' | 'text.delta' | 'text.end'; id: string; delta?: string }
	| { type: 'reasoning.start' | 'reasoning.delta' | 'reasoning.end'; id: string; delta?: string }
	/**
	 * A finished reasoning block with its provider-native payload (Anthropic signature or
	 * redacted data). The loop replays it verbatim to the same model; the editor never sees it.
	 */
	| { type: 'reasoning.block'; provider: string; model: string; text: string; opaque?: unknown }
	/**
	 * `card` is how DeepSeek asked the call to be drawn. The editor uses it first.
	 * `kind` is the semantic class. ACP agents often omit both; the editor then falls back to the tool name.
	 */
	| { type: 'tool.start'; callId: string; name: string; title?: string; input?: string; cwd?: string; kind?: ToolKind; card?: 'generic' | 'terminal' | 'diff'; diffs?: readonly IVoltToolDiff[]; locations?: readonly IVoltToolLocation[] }
	/**
	 * `append` deltas are pure continuations (native providers). Without it the delta may be a
	 * snapshot of the whole input so far (ACP agents), and has to be merged instead of appended.
	 */
	| { type: 'tool.input.delta'; callId: string; delta: string; append?: boolean }
	/** The provider finished streaming this call's arguments. Read-only calls may start now. */
	| { type: 'tool.input.end'; callId: string }
	/**
	 * A started call learned more about itself before it finished: a specific title
	 * ("Read foo.ts" instead of "Read File"), the files it touches, or the edit it will make.
	 */
	| { type: 'tool.update'; callId: string; title?: string; kind?: ToolKind; locations?: readonly IVoltToolLocation[]; diffs?: readonly IVoltToolDiff[] }
	/** Live status from a running tool (a sub-agent step, a job line). Not persisted. */
	| { type: 'tool.progress'; callId: string; status: string }
	| { type: 'tool.end'; callId: string; result?: unknown; error?: string; durationMs?: number; card?: IVoltToolCard; title?: string; output?: string; exitCode?: number; diffs?: readonly IVoltToolDiff[]; view?: IVoltToolView }
	| { type: 'plan'; entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[] }
	| { type: 'file.change'; uri: URI; kind: 'edit' | 'create' | 'delete'; before?: string; existed?: boolean }
	| { type: 'access.ask'; request: IAccessRequest }
	| { type: 'access.resolved'; requestId: string; effect: 'allow' | 'deny'; scope: 'once' | 'always' }
	| { type: 'access.blocked'; request: IAccessRequest; policySource: string }
	/** The agent asked multiple-choice questions; the tray above the composer answers them. */
	| { type: 'question.ask'; request: IAgentQuestionRequest }
	/** `answers` is what the transcript's Answers card lists (empty when skipped or dismissed). */
	| { type: 'question.resolved'; requestId: string; outcome: IAgentQuestionResponse['outcome']; answers: readonly IAgentAnsweredQuestion[]; note?: string }
	/** One of Volt's own MCP tools ran for this chat; its full result, which some agents do not echo back. */
	| { type: 'host.tool'; name: string; args: Record<string, unknown>; text?: string; image?: string; error?: string; visual?: IVoltVisualRef }
	/**
	 * `input` is uncached prompt tokens, `cache` is prompt tokens read from the provider cache,
	 * and `cacheWrite` is prompt tokens written to it. `used` is the whole prompt the model saw.
	 * `costUsd` is the agent's own running total for its session (Claude's ACP `usage_update.cost`).
	 */
	| { type: 'usage'; input: number; output: number; used?: number; cache?: number; cacheWrite?: number; size?: number; costUsd?: number }
	/**
	 * The agent compacted the conversation (`/compact`, or on its own near the end of the window).
	 * Later events with the same `id` patch the first: an absent field keeps its value. `preTokens`
	 * and `postTokens` are the context before and after as the agent counts it (Claude's `postTokens`
	 * is the kept summary alone, without the system prompt and tools). `summary` replaces the kept
	 * text, `summaryDelta` appends to it.
	 */
	/**
	 * The conversation went to an agent session that had not seen it (a model or provider switch, a
	 * fork, a restarted session), sized to the receiving model's window. `reused`: a session the chat
	 * was on before resumed, and only the turns it missed went to it.
	 */
	| { type: 'context.handoff'; reason: HandoffReason; fromLabel?: string; toLabel: string; tokens: number; budget: number; reused: boolean; turns: number; verbatimTurns: number; condensedTurns: number; omittedTurns: number; toolCalls: number; files: number; text: string }
	| { type: 'context.compaction'; id: string; status?: VoltCompactionStatus; trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number; durationMs?: number; summary?: string; summaryDelta?: string; error?: string }
	| { type: 'error'; message: string; retryable?: boolean }
	/** Provider status that is not assistant prose: usage limits, retries, and other ACP notices. */
	/** `resetAt`: when a usage limit resets (epoch ms), from the provider's structured rate-limit data. */
	| { type: 'notice'; severity: 'info' | 'warning' | 'error'; title: string; description?: string; resetAt?: number }
	/** Provider stream is being retried. Live-only in spirit; persisted so the trace shows the stall. */
	| { type: 'retry'; attempt: number; delayMs: number; message: string }
	| { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'error' | 'abort' }
	| { type: 'run.end'; runId: string; reason: 'done' | 'abort' | 'fail' }
	| { type: 'envelope'; id: string; mode: VoltMode; permissions: readonly string[] }
	| { type: 'ooda'; phase: 'observe' | 'orient' | 'reason' | 'decide' | 'act' | 'reflect' | 'learn'; cycle: number }
	| { type: 'checkpoint'; id: string; label: string; kind: 'memory' | 'git' }
	| { type: 'compaction'; stages: readonly string[]; dropped: number }
	| { type: 'verify'; kind: string; pass: boolean; detail?: string }
	| { type: 'confidence'; score: number; sufficient: boolean; reasons: readonly string[] }
	| { type: 'mission'; phase: string; detail?: string }
	| { type: 'human'; action: string; detail?: string }
	| { type: 'replay'; runId: string }
	| { type: 'turn.start' | 'turn.end'; turn: number }
	| { type: 'inbox'; claimed: number }
	| { type: 'prefetch'; paths: readonly string[] }
	| { type: 'proof'; covered: number; total: number; ok: boolean }
	| { type: 'scheduler'; queued: number; running: number }
	| { type: 'eval'; score: number; successRate: number; steps: number; tokens: number; hints: readonly string[] }
	| { type: 'title'; text: string }
	/**
	 * The agent's harness started its own subagent (Claude/Codex native subagent sessions, Cursor's Task).
	 * `childId` is the harness's id for it (child session id, else the Task call id); `parentToolCallId`
	 * ties it to the spawning tool row when known.
	 */
	| { type: 'subagent.spawned'; childId: string; parentToolCallId?: string; title: string; prompt?: string; kind?: string; model?: string; source: 'claude' | 'codex' | 'cursor' | 'acp' }
	/** Something a harness subagent did (a tool call, text), kept out of the parent's own steps. */
	| { type: 'subagent.event'; childId: string; event: IVoltEvent }
	/** Facts that arrive later (Cursor names the model at the end; Claude resolves it after the spawn), or its current step. */
	| { type: 'subagent.update'; childId: string; title?: string; model?: string; activity?: string; parentToolCallId?: string }
	| { type: 'subagent.completed'; childId: string; status: 'completed' | 'failed' | 'cancelled'; result?: string; error?: string; durationMs?: number };

export interface IVoltEventEnvelope {
	seq: number;
	runId: string;
	sessionId: string;
	timestamp: number;
	event: IVoltEvent;
	provider?: {
		rawType: string;
		raw?: unknown;
	};
}

export function isLiveOnlyEvent(event: IVoltEvent): boolean {
	if (event.type === 'subagent.event') {
		return isLiveOnlyEvent(event.event);
	}
	return event.type === 'text.delta' || event.type === 'reasoning.delta' || event.type === 'tool.input.delta' || event.type === 'tool.progress';
}
