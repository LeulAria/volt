/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The parts of the agent server's replicated state that the widgets and Live Activities read.
// Structural subsets of the real types, so this package needs neither the shared core nor src/vs:
// - `history` collection: IAgentSessionMeta (voltRuntime/common/history/agentHistory.ts)
// - `orch.threads` / `orch.tasks`: IOrchThread / IOrchTask (voltRuntime/common/orchestration/orchestrator.ts)
// - `sessions`: IRemoteSessionSummary (voltAgentServer/common/remoteAgentRuntimeService.ts)
// - `questions` / `access`: IAgentQuestionRequest / IAccessRequest
// - `edits`: AgentEditsJournalEntry (voltAgent/common/agentEditsJournal.ts)
// - `runtime.event` topic: IVoltEventEnvelope (voltRuntime/common/events.ts)
// - `GET /api/usage`: IVoltUsageMachineReport (platform/voltUsage/common/voltUsage.ts)

export type SessionStatusLike = 'idle' | 'running' | 'done' | 'cancelled' | 'error' | 'interrupted';

export interface ISessionMetaLike {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: number;
	readonly workspaceLabel?: string;
	readonly workspaceFolder?: string;
	readonly preview?: string;
	readonly summary?: string;
	readonly status: SessionStatusLike;
	readonly archived?: boolean;
	readonly lastPromptAt?: number;
	readonly attention?: 'approval' | 'question';
	readonly model?: string;
	readonly worktreeBranch?: string;
	readonly parentId?: string;
	readonly subagent?: boolean;
}

export interface IOrchTurnLike {
	readonly id: string;
	readonly kind: string;
	readonly at: number;
	readonly phase: 'dispatching' | 'running' | 'cancelling';
	readonly prompt?: { readonly modelRef?: string };
}

export interface IOrchThreadLike {
	readonly id: string;
	readonly taskId?: string;
	readonly parentId?: string;
	readonly title?: string;
	readonly modelRef?: string;
	readonly modelLabel?: string;
	readonly active?: IOrchTurnLike;
	readonly queue: readonly { readonly id: string; readonly kind?: string; readonly held?: boolean }[];
	readonly pause?: string;
	readonly blocked?: string;
	readonly inputs: readonly { readonly id: string; readonly kind: 'approval' | 'question'; readonly at: number }[];
	readonly last?: { readonly turnId: string; readonly kind: string; readonly outcome: 'done' | 'failed' | 'cancelled' | 'interrupted'; readonly at: number; readonly error?: string };
	readonly limit?: { readonly turnId: string; readonly at: number; readonly resetAt?: number; readonly message?: string };
}

export interface IOrchTaskLike {
	readonly id: string;
	readonly parentId: string;
	readonly state: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	readonly activity?: string;
	readonly files?: readonly string[];
}

export interface ISessionSummaryLike {
	readonly providerRef?: string;
	readonly activeRun?: { readonly runId: string; readonly status: string; readonly startedAt: number; readonly providerRef?: string };
	readonly worktreeBranch?: string;
}

export interface IQuestionRequestLike {
	readonly id: string;
	readonly sessionId: string;
	readonly title?: string;
	readonly questions: readonly { readonly prompt: string }[];
}

export interface IAccessRequestLike {
	readonly id: string;
	readonly sessionId: string;
	readonly action: string;
	readonly resource?: { readonly type?: string; readonly value?: string };
	readonly reason?: string;
	readonly preview?: { readonly title?: string; readonly detail?: string };
	readonly createdAt: number;
}

export type EditsEntryLike =
	| { readonly kind: 'file' | 'baseline' | 'binary'; readonly sessionId: string; readonly uri: { readonly path?: string; readonly fsPath?: string } | string }
	| { readonly kind: 'finished'; readonly sessionId: string };

/** The runtime events the step tracker reads. */
export type RuntimeEventLike =
	| { readonly type: 'run.start'; readonly runId?: string }
	| { readonly type: 'run.end'; readonly reason?: string }
	| { readonly type: 'tool.start'; readonly callId: string; readonly name: string; readonly title?: string; readonly input?: string; readonly card?: string; readonly diffs?: readonly { readonly path?: string }[]; readonly locations?: readonly { readonly path?: string }[] }
	| { readonly type: 'tool.update'; readonly callId: string; readonly title?: string }
	| { readonly type: 'tool.progress'; readonly callId: string; readonly status: string }
	| { readonly type: 'tool.end'; readonly callId: string; readonly error?: string }
	| { readonly type: 'file.change'; readonly uri: { readonly path?: string; readonly fsPath?: string } | string; readonly kind?: string }
	| { readonly type: 'lifecycle'; readonly phase: string }
	| { readonly type: 'clarify' }
	| { readonly type: 'decision'; readonly title: string }
	| { readonly type: 'notice'; readonly title: string }
	| { readonly type: 'context.compaction'; readonly status?: string; readonly trigger?: string }
	| { readonly type: 'reasoning.start' }
	| { readonly type: 'text.start' }
	| { readonly type: 'question.ask' }
	| { readonly type: 'access.ask' }
	| { readonly type: string };

export interface IRuntimeEnvelopeLike {
	readonly sessionId: string;
	readonly runId?: string;
	readonly event: RuntimeEventLike;
}

export interface IUsageLimitWindowLike {
	readonly id: string;
	readonly label: string;
	readonly scope?: string;
	readonly usedPercent: number;
	readonly resetsAt?: number;
	readonly windowMs?: number;
}

export interface IUsageLimitGroupLike {
	readonly provider: string;
	readonly account?: { readonly id: string; readonly label?: string };
	readonly plan?: string;
	readonly windows: readonly IUsageLimitWindowLike[];
	readonly resetCredits?: number;
	readonly error?: string;
	readonly checkedAt: number;
}

/** `GET /api/usage`. Only `limits` and the machine name are read. */
export interface IUsageReportLike {
	readonly machineName?: string;
	readonly limits: readonly IUsageLimitGroupLike[];
}
