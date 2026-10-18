/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Structural subsets of the agent server's replicated state, read by the web and mobile apps.
// Every field a newer server may drop or add is optional; unknown values are tolerated.
// Sources (src/vs/...):
// - history: IAgentSessionMeta (voltRuntime/common/history/agentHistory.ts)
// - orch.threads / orch.tasks: IOrchThread / IOrchTask (voltRuntime/common/orchestration/orchestrator.ts)
// - sessions: AgentServerApi.publishSession (server/node/voltAgent/serverApi.ts)
// - runtime: AgentServerApi.publishRuntime
// - access / questions: IAccessRequest (access/accessTypes.ts) / IAgentQuestionRequest (questions.ts)
// - projects: IVoltProjectRecord (voltRuntime/common/sessionContext.ts)
// - transcript messages: IAgentMessage (voltAgent/browser/editor/agentEditor.ts) and AgentSegment
//   / AgentBlock (voltAgent/browser/blocks/agentBlocks.ts)

export type SessionStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error' | 'interrupted';

export interface IUriLike {
	readonly $mid?: number;
	readonly scheme?: string;
	readonly authority?: string;
	readonly path?: string;
	readonly fsPath?: string;
	readonly external?: string;
}

export interface ISessionMeta {
	readonly id: string;
	readonly title: string;
	readonly customTitle?: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly workspaceId?: string;
	readonly workspaceLabel?: string;
	readonly workspaceFolder?: string;
	readonly turnCount?: number;
	readonly preview?: string;
	readonly summary?: string;
	readonly status: SessionStatus;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	readonly settled?: boolean;
	readonly snoozed?: boolean;
	readonly snoozedUntil?: number;
	readonly wokeAt?: number;
	readonly lastPromptAt?: number;
	readonly lastUserPromptAt?: number;
	readonly hasDraft?: boolean;
	readonly unread?: boolean;
	readonly attention?: 'approval' | 'question';
	readonly mode?: string;
	readonly model?: string;
	readonly worktreePath?: string;
	readonly worktreeBranch?: string;
	readonly parentId?: string;
	readonly subagent?: boolean;
}

export type OrchTurnKind = 'prompt' | 'notification' | 'brief' | 'followup' | 'resume' | 'external';
export type OrchOutcome = 'done' | 'failed' | 'cancelled' | 'interrupted';
export type OrchPause = 'failed' | 'stopped' | 'interrupted' | 'wakeups' | 'limit';

export interface IOrchPrompt {
	readonly text: string;
	readonly display?: unknown;
	readonly mode?: string;
	readonly modelRef?: string;
	readonly options?: Record<string, string | boolean>;
	readonly host?: unknown;
}

export interface IOrchTurn {
	readonly id: string;
	readonly kind: OrchTurnKind;
	readonly prompt?: IOrchPrompt;
	readonly at: number;
	readonly phase: 'dispatching' | 'running' | 'cancelling';
	readonly runId?: string;
	readonly steerable?: boolean;
}

export interface IOrchQueueItem {
	readonly id: string;
	readonly prompt: IOrchPrompt;
	readonly at: number;
	readonly kind?: OrchTurnKind;
	readonly held?: boolean;
}

export interface IOrchThread {
	readonly id: string;
	readonly parentId?: string;
	readonly rootId?: string;
	readonly taskId?: string;
	readonly title?: string;
	readonly modelRef?: string;
	readonly modelLabel?: string;
	readonly active?: IOrchTurn;
	readonly queue: readonly IOrchQueueItem[];
	readonly pause?: OrchPause;
	readonly blocked?: string;
	readonly inputs: readonly { readonly id: string; readonly kind: 'approval' | 'question'; readonly at: number }[];
	readonly last?: { readonly turnId: string; readonly kind: OrchTurnKind; readonly outcome: OrchOutcome; readonly at: number; readonly error?: string };
	readonly turns?: number;
	readonly limit?: { readonly turnId: string; readonly at: number; readonly resetAt?: number; readonly message?: string; readonly auto?: boolean };
	readonly moving?: { readonly label: string };
	readonly pendingMove?: { readonly label: string };
}

export type OrchTaskState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface IOrchTask {
	readonly id: string;
	readonly source?: 'volt' | 'harness';
	readonly parentId: string;
	readonly childId?: string;
	readonly title: string;
	readonly kind?: string;
	readonly role?: string;
	readonly brief?: string;
	readonly modelLabel?: string;
	readonly state: OrchTaskState;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly createdAt?: number;
	readonly activity?: string;
	readonly steps?: number;
	readonly waitingOn?: 'approval' | 'question';
	readonly result?: string;
	readonly error?: string;
	readonly files?: readonly string[];
	readonly worktreeBranch?: string;
}

export interface ISessionSummary {
	readonly sessionId: string;
	readonly mode?: string;
	readonly providerRef?: string;
	readonly profileId?: string;
	readonly activeRun?: { readonly runId: string; readonly status: string; readonly startedAt: number; readonly providerRef?: string };
	readonly paused?: boolean;
	readonly worktreePath?: string;
	readonly worktreeBranch?: string;
	readonly workingFolder?: string;
	readonly accessMode?: AccessMode;
	readonly userTurns?: number;
	readonly canSteer?: boolean;
	readonly commands?: readonly string[];
	readonly compaction?: { readonly blockedReason?: string };
}

export type AccessMode = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access';

export const ACCESS_MODES: readonly { readonly id: AccessMode; readonly label: string; readonly description: string }[] = [
	{ id: 'supervised', label: 'Supervised', description: 'Ask before edits, commands and network access.' },
	{ id: 'auto-accept-edits', label: 'Auto-accept edits', description: 'Edit files freely; ask before commands.' },
	{ id: 'auto', label: 'Auto', description: 'Act freely; ask only for risky actions.' },
	{ id: 'full-access', label: 'Full access', description: 'Never ask. Use in trusted projects.' },
];

export type ComposerMode = 'Agent' | 'Plan' | 'Ask' | 'Debug' | 'Multitask';

export const COMPOSER_MODES: readonly { readonly id: ComposerMode; readonly description: string }[] = [
	{ id: 'Agent', description: 'Plans, edits and runs commands.' },
	{ id: 'Plan', description: 'Researches and writes a plan to approve first.' },
	{ id: 'Ask', description: 'Answers questions without changing files.' },
	{ id: 'Debug', description: 'Reproduces and fixes a bug step by step.' },
	{ id: 'Multitask', description: 'Splits the work across parallel subagents.' },
];

export interface IModelOptionDescriptor {
	readonly id: string;
	readonly label: string;
	readonly type: 'select' | 'boolean';
	readonly options?: readonly { readonly value: string; readonly label: string; readonly isDefault?: boolean }[];
	readonly defaultValue?: boolean;
}

export interface ICatalogItem {
	readonly ref: string;
	readonly kind: 'model' | 'agent';
	readonly providerId: string;
	readonly profileId: string;
	readonly id: string;
	readonly label: string;
	readonly qualifier?: string;
	readonly enabled: boolean;
	readonly optionDescriptors?: readonly IModelOptionDescriptor[];
	readonly detail?: string;
	readonly description?: string;
	readonly contextLabel?: string;
}

export type ProviderState = 'authenticated' | 'available' | 'disabled' | 'missing' | 'checking';

export interface IProviderStatus {
	readonly profileId: string;
	readonly providerId: string;
	readonly kind: 'model' | 'agent';
	readonly label: string;
	readonly state: ProviderState;
	readonly enabled: boolean;
	readonly version?: string;
	readonly account?: string;
	readonly plan?: string;
	readonly detail?: string;
	readonly checkedAt?: number;
	readonly models?: readonly ICatalogItem[];
}

export interface IRuntimeState {
	readonly catalog?: readonly ICatalogItem[];
	readonly catalogLoading?: boolean;
	readonly providerStatuses?: readonly IProviderStatus[];
	readonly modelOptions?: Readonly<Record<string, Record<string, string | boolean>>>;
	readonly enabledModels?: Readonly<Record<string, boolean>>;
	readonly accessMode?: AccessMode;
	readonly activeCatalogRef?: string;
	readonly autoResumeDefault?: boolean;
}

export interface IAccessRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly runId?: string;
	readonly providerId?: string;
	readonly action: string;
	readonly resource?: { readonly type?: string; readonly value?: string };
	readonly risk?: 'safe' | 'low' | 'medium' | 'high' | 'critical';
	readonly preview?: { readonly title?: string; readonly detail?: string };
	readonly reason?: string;
	readonly createdAt: number;
}

export interface IQuestion {
	readonly id: string;
	readonly prompt: string;
	readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
	readonly multiple: boolean;
	readonly allowOther: boolean;
}

export interface IQuestionRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly runId?: string;
	readonly title?: string;
	readonly questions: readonly IQuestion[];
}

export interface IQuestionResponse {
	readonly outcome: 'answered' | 'skipped' | 'cancelled';
	readonly answers: readonly { readonly questionId: string; readonly optionIds: readonly string[]; readonly other?: string }[];
	readonly note?: string;
	readonly dismissed?: boolean;
}

export interface IProjectRecord {
	readonly id: string;
	readonly root: IUriLike;
	readonly displayName: string;
	readonly authority?: string;
	readonly scratch?: boolean;
}

//#region Transcript

/** A prompt's mention as the transcript keeps it; images carry an attachment ref. */
export interface IMessageMention {
	readonly label?: string;
	readonly kind?: string;
	readonly name?: string;
	readonly image?: { readonly id?: string; readonly mime?: string; readonly ref?: string; readonly name?: string };
	readonly file?: { readonly path?: string; readonly mime?: string; readonly size?: number };
}

/** An image uploaded to the server's attachment store, ready to go out with a prompt. */
export interface IPromptAttachment {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	/** The server's attachment ref (`history.putAttachment`). */
	readonly ref: string;
	readonly size?: number;
}

export interface IUserMessage {
	readonly kind: 'user';
	readonly id?: string;
	readonly text: string;
	readonly chips?: readonly string[];
	readonly mentions?: readonly IMessageMention[];
	readonly mode?: string;
	readonly origin?: 'notification' | 'brief';
	readonly taskIds?: readonly string[];
	readonly handoff?: { readonly fromLabel?: string; readonly toLabel: string; readonly at: number; readonly by: 'agent' | 'user'; readonly reason?: string };
	readonly scheduled?: { readonly id: string; readonly title: string; readonly webhook?: boolean };
	readonly fromThread?: { readonly id: string; readonly title: string; readonly kind: 'message' | 'launch' | 'fork' | 'merge'; readonly external?: boolean };
	readonly steer?: boolean;
}

export type BlockStatus = 'streaming' | 'complete' | 'error';

interface IBaseBlock {
	readonly id: string;
	readonly status: BlockStatus;
}

export type AgentBlock =
	| (IBaseBlock & { readonly type: 'markdown'; readonly content: string })
	| (IBaseBlock & { readonly type: 'code'; readonly language?: string; readonly code: string; readonly path?: string })
	| (IBaseBlock & { readonly type: 'terminal'; readonly title?: string; readonly command: string; readonly output: string; readonly cwd?: string; readonly exitCode?: number; readonly callId?: string })
	| (IBaseBlock & { readonly type: 'table'; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly caption?: string })
	| (IBaseBlock & { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly string[] })
	| (IBaseBlock & { readonly type: 'cards'; readonly items: readonly { readonly title: string; readonly body: string; readonly meta?: string }[] })
	| (IBaseBlock & { readonly type: 'chart'; readonly labels: readonly string[]; readonly values: readonly number[]; readonly unit?: string; readonly title?: string })
	| (IBaseBlock & { readonly type: 'mermaid'; readonly source: string })
	| (IBaseBlock & { readonly type: 'tool'; readonly callId: string; readonly name: string; readonly title?: string; readonly input?: string; readonly output?: string; readonly stopped?: boolean })
	| (IBaseBlock & { readonly type: 'file'; readonly callId?: string; readonly path: string; readonly verb: 'Edited' | 'Created' | 'Deleted'; readonly unifiedDiff?: string; readonly additions?: number; readonly deletions?: number; readonly original?: string; readonly modified?: string })
	| (IBaseBlock & { readonly type: 'error'; readonly message: string })
	| (IBaseBlock & { readonly type: 'approval'; readonly requestId: string; readonly action: string; readonly resource: string; readonly risk: string; readonly reason?: string; readonly decision?: 'allow' | 'deny'; readonly scope?: 'once' | 'always'; readonly blocked?: boolean })
	| (IBaseBlock & { readonly type: 'answers'; readonly requestId: string; readonly outcome: 'answered' | 'skipped' | 'cancelled'; readonly items: readonly { readonly question: string; readonly answer: string }[]; readonly note?: string })
	| (IBaseBlock & { readonly type: 'plan'; readonly callId?: string; readonly name?: string; readonly markdown: string; readonly openQuestions?: readonly string[] })
	| (IBaseBlock & { readonly type: 'visual'; readonly kind: 'chart' | 'html'; readonly title: string; readonly ref: string });

export type ActivityKind = 'thought' | 'read' | 'search' | 'note' | 'wait' | 'browser';

export interface IActivityItem {
	readonly kind: ActivityKind;
	readonly label: string;
	readonly detail?: string;
	readonly text?: string;
	readonly path?: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly files?: readonly string[];
	readonly callId?: string;
	readonly toolName?: string;
	readonly toolTitle?: string;
	readonly result?: string;
	readonly error?: string;
	readonly hidden?: boolean;
}

export interface ICompaction {
	readonly id: string;
	readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
	readonly trigger?: 'manual' | 'auto';
	readonly preTokens?: number;
	readonly postTokens?: number;
	readonly summary?: string;
	readonly error?: string;
}

export type AgentSegment =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'block'; readonly block: AgentBlock }
	| { readonly kind: 'activity'; readonly item: IActivityItem }
	| { readonly kind: 'thought'; readonly text: string; readonly startedAt?: number; readonly updatedAt?: number }
	| { readonly kind: 'notice'; readonly severity: 'info' | 'warning' | 'error'; readonly title: string; readonly description?: string; readonly supervision?: string }
	| { readonly kind: 'compaction'; readonly compaction: ICompaction };

export interface ITodoStep {
	readonly label: string;
	readonly state: 'done' | 'current' | 'pending';
	readonly startedAt?: number;
	readonly endedAt?: number;
}

export interface IAssistantMessage {
	readonly kind: 'agent';
	readonly id?: string;
	readonly title?: string;
	readonly steps?: readonly ITodoStep[];
	readonly text?: string;
	readonly segments: readonly AgentSegment[];
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly tokensUsed?: number;
	readonly tokensWindow?: number;
	readonly model?: { readonly ref: string; readonly id?: string; readonly label?: string };
	readonly costUsd?: number;
	readonly cancelled?: boolean;
	readonly activity?: { readonly status: string; readonly statusPinned?: boolean; readonly streaming: boolean; readonly thinkingText?: string; readonly lastEventAt?: number };
	readonly runId?: string;
	readonly outcome?: 'done' | 'failed' | 'stopped';
	readonly failure?: { readonly message: string; readonly retryable?: boolean };
}

export type AgentMessage = IUserMessage | IAssistantMessage;

//#endregion

//#region Checkpoints and changes

/** A turn's file snapshot (IAgentCheckpoint, voltAgent/browser/review/agentCheckpointService.ts). */
export interface ICheckpoint {
	readonly sessionId: string;
	readonly turnId: string;
	readonly userTurn: number;
	readonly before: string;
	readonly after?: string;
	readonly running: boolean;
}

export interface ICheckpointState {
	readonly checkpoints: readonly ICheckpoint[];
	readonly canRedo: boolean;
}

/** One file an agent changed (IAgentSnapshotChange). Blobs are git object ids in `repoRoot`. */
export interface IAgentChange {
	readonly uri: IUriLike;
	readonly path: string;
	readonly oldPath?: string;
	readonly kind: 'added' | 'modified' | 'deleted' | 'renamed';
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
	readonly repoRoot: string;
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly turnId: string;
}

export interface IRestoreFile {
	readonly uri: IUriLike;
	/** Repo-relative. */
	readonly path: string;
	readonly action: string;
	readonly outcome: string;
	readonly binary: boolean;
	/** Changed after the agent's last write (by you or another chat). */
	readonly editedSince: boolean;
}

/** What restoring to before a turn does (IAgentRestorePreview); `applied`/`canRedo` once it ran. */
export interface IRestorePreview {
	readonly checkpoint: ICheckpoint;
	readonly files: readonly IRestoreFile[];
	readonly conflicts: readonly IRestoreFile[];
	readonly applied?: boolean;
	readonly canRedo?: boolean;
}

//#endregion

//#region Files (ServerFiles, src/vs/server/node/voltAgent/serverFiles.ts)

export interface IFileRoot {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly kind: 'project' | 'worktree';
	readonly scratch?: boolean;
	readonly sessionId?: string;
}

export interface IFileEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: 'file' | 'dir';
	readonly link?: boolean;
}

export type IFileContent =
	| { readonly path: string; readonly size: number; readonly mtime: number; readonly kind: 'text'; readonly text: string }
	| { readonly path: string; readonly size: number; readonly mtime: number; readonly kind: 'image'; readonly mime: string; readonly base64: string }
	| { readonly path: string; readonly size: number; readonly mtime: number; readonly kind: 'binary' | 'tooLarge' };

export interface IGrepOptions {
	readonly regex?: boolean;
	readonly caseSensitive?: boolean;
	readonly wholeWord?: boolean;
	/** Comma-separated globs. */
	readonly include?: string;
	readonly exclude?: string;
	readonly maxResults?: number;
}

export interface IGrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
	readonly ranges: readonly (readonly [number, number])[];
}

export type GitChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?';

export interface IGitChange {
	readonly path: string;
	readonly rel: string;
	readonly status: GitChangeStatus;
	readonly staged: boolean;
	readonly oldPath?: string;
	readonly additions?: number;
	readonly deletions?: number;
}

export interface IGitStatus {
	readonly repoRoot?: string;
	readonly branch?: string;
	readonly changes: readonly IGitChange[];
}

//#endregion

//#region Composer extras: mentions, attached files, MCP servers

/**
 * A mention a prompt carries for the transcript (IAgentDisplayMention in the desktop's
 * composer/agentMentions.ts): a project file (`resource`), a file attached from the device
 * (`file`, saved in the server's attachment store) or a `/` command (`skill`). `label` appears
 * in the prompt's display text, where the desktop draws it as a chip.
 */
export interface IPromptMention {
	readonly label: string;
	readonly kind: 'file' | 'folder' | 'skill' | 'mcp';
	readonly value?: string;
	readonly resource?: IUriLike;
	readonly file?: { readonly id: string; readonly name: string; readonly mime: string; readonly size: number; readonly path?: string };
}

/** A file from the device in the server's attachment store (not an image: those are IPromptAttachment). */
export interface IPromptFile {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly ref: string;
	/** The saved copy on the computer, which the agent's tools open. */
	readonly path?: string;
}

/** An MCP server the agents of a project get (IVoltMcpServerStatus, voltRuntime/common/runtime.ts). */
export interface IMcpServerStatus {
	readonly name: string;
	readonly scope: 'project' | 'user';
	readonly state: 'idle' | 'connecting' | 'ready' | 'error';
}

//#endregion
