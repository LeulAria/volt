/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IAccessRequest } from './access/accessTypes.js';
import type { VoltLane } from './harness/lanes.js';
import type { TaskPhase } from './harness/lifecycle.js';
import type { ToolKind } from './harness/workLog.js';
import { VoltMode } from './modes.js';

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
	 * `kind` is the semantic class of the tool (read/search/edit/execute/...). Native tools always
	 * set it; ACP agents set it when they report one. The UI renders from `kind` first and falls
	 * back to name heuristics only when it is missing.
	 */
	| { type: 'tool.start'; callId: string; name: string; title?: string; input?: string; cwd?: string; kind?: ToolKind }
	| { type: 'tool.input.delta'; callId: string; delta: string }
	| { type: 'tool.end'; callId: string; result?: unknown; error?: string; durationMs?: number }
	| { type: 'plan'; entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[] }
	| { type: 'file.change'; uri: URI; kind: 'edit' | 'create' | 'delete'; before?: string; existed?: boolean }
	| { type: 'access.ask'; request: IAccessRequest }
	| { type: 'access.resolved'; requestId: string; effect: 'allow' | 'deny'; scope: 'once' | 'always' }
	| { type: 'access.blocked'; request: IAccessRequest; policySource: string }
	| { type: 'usage'; input: number; output: number; used?: number; cache?: number; size?: number }
	| { type: 'error'; message: string; retryable?: boolean }
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
	| { type: 'title'; text: string };

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
	return event.type === 'text.delta' || event.type === 'reasoning.delta' || event.type === 'tool.input.delta';
}
