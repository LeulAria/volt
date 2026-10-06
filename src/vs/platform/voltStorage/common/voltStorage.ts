/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltStorageService = createDecorator<IVoltStorageService>('voltStorageService');
export const VOLT_STORAGE_CHANNEL_NAME = 'voltStorage';

/** What a machine-wide row measures. Labels live in the UI; the service only knows paths. */
export type VoltMachineStorageId =
	| 'logs'
	| 'crashDumps'
	| 'cachedData'
	| 'chromiumCache'
	| 'codeCache'
	| 'gpuCache'
	| 'workspaceStorage'
	| 'chatHistory'
	| 'agentTraces'
	| 'nativeTranscripts'
	| 'worktrees'
	| 'checkpoints'
	| 'runGroups'
	| 'browserCache'
	| 'browserData';

export type VoltProjectStorageId = 'project.worktrees' | 'project.chats' | 'project.workspaceStorage' | 'project.checkpoints' | 'project.traces';

export type VoltStorageId = VoltMachineStorageId | VoltProjectStorageId;

/**
 * Why an entry survives Clean.
 * - `current`: this session's logs, or this build's code cache.
 * - `open`: a window has it open (workspace storage, a chat that is running).
 * - `inUse`: an open chat runs in it, or the running app holds it (GPU caches).
 * - `dirty`: a worktree with uncommitted changes.
 * - `unknown`: its state could not be read (a worktree whose repository is gone).
 * - `exists`: it belongs to a folder that is still there; clean it from that project instead.
 * - `managed`: another feature owns its lifetime (run groups).
 */
export type VoltStorageKeep = 'current' | 'open' | 'inUse' | 'dirty' | 'unknown' | 'exists' | 'managed';

export interface IVoltStorageEntry {
	readonly path: string;
	readonly bytes: number;
	/** Set when Clean leaves this entry alone. */
	readonly keep?: VoltStorageKeep;
	/** For chats: the session id the entry belongs to. */
	readonly sessionId?: string;
}

export interface IVoltStorageItem {
	readonly id: VoltStorageId;
	/** The folders the row measures, for the tooltip and Reveal. */
	readonly roots: readonly string[];
	/** Everything on disk under {@link roots}. */
	readonly bytes: number;
	/** What Clean would free now. */
	readonly cleanableBytes: number;
	/** The units Clean works on; empty for rows that are cleaned as a whole. */
	readonly entries: readonly IVoltStorageEntry[];
	/** False for rows only shown for information. */
	readonly cleanable: boolean;
	/** The whole row is kept for this reason (GPU caches while running). */
	readonly keep?: VoltStorageKeep;
}

export interface IVoltStorageReport {
	readonly items: readonly IVoltStorageItem[];
	readonly measuredAt: number;
	readonly durationMs: number;
}

/** A worktree a chat points at. */
export interface IVoltStorageWorktreeRef {
	readonly path: string;
	readonly sessionId: string;
	/** Archived chats no longer hold their checkout. */
	readonly archived: boolean;
}

/** What only the window knows: which chats exist, which run, which workspace it has open. */
export interface IVoltStorageContext {
	/** Workspace storage folder names open in this window. */
	readonly openWorkspaceIds: readonly string[];
	readonly worktrees: readonly IVoltStorageWorktreeRef[];
	/** Every chat in the history, so files of deleted chats can be told apart. */
	readonly sessionIds: readonly string[];
	readonly runningSessionIds: readonly string[];
}

export interface IVoltProjectStorageRequest extends IVoltStorageContext {
	/** The project folder (fsPath). */
	readonly root: string;
	/** The project's chats; their worktrees are in {@link IVoltStorageContext.worktrees}. */
	readonly projectSessionIds: readonly string[];
}

export interface IVoltStorageCleanResult {
	readonly freedBytes: number;
	readonly removed: number;
	/** Entries left alone, with why. */
	readonly skipped: readonly { readonly path: string; readonly keep: VoltStorageKeep }[];
	readonly errors: readonly string[];
}

/**
 * Disk use of Volt's own data (machine-wide and per project), measured and cleaned in the main
 * process so a large cache never blocks a window. Clean re-measures first and never removes
 * what is in use; chats are deleted by the window through the history service, not here.
 */
export interface IVoltStorageService {
	readonly _serviceBrand: undefined;
	machineReport(context: IVoltStorageContext): Promise<IVoltStorageReport>;
	projectReport(request: IVoltProjectStorageRequest): Promise<IVoltStorageReport>;
	/** Cleans one row. `project` is required for project rows. */
	clean(id: VoltStorageId, context: IVoltStorageContext, project?: IVoltProjectStorageRequest): Promise<IVoltStorageCleanResult>;
}
