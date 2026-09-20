/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

/**
 * Durable agent history.
 *
 * Every agent session is an append-only JSONL log (one JSON record per line)
 * stored under the user data directory. The first line is the header; every
 * later line is an {@link AgentHistoryEntry}. Records are never rewritten in
 * place: superseding (a streaming assistant snapshot replacing an earlier one)
 * and branching (edit-and-resend) are expressed as new records that the reader
 * folds. A torn trailing line (crash mid-write) is dropped by the reader and
 * overwritten by the next append, so a log can lose at most the last partial
 * record and never becomes unreadable.
 *
 * A compact `index.json` projection lists every session (title, preview,
 * status, workspace) so history browsing and search never touch the logs.
 * The index is rebuilt from the logs when missing or unreadable.
 */

export const AGENT_HISTORY_FORMAT_VERSION = 1;

export type AgentSessionStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error' | 'interrupted';

export interface IAgentSessionWorkspace {
	/** Stable workspace identity (IWorkspace.id). */
	readonly id: string;
	/** Human label, usually the first folder name. */
	readonly label: string;
	/** File system paths of the workspace folders at creation time. */
	readonly folders: readonly string[];
}

export interface IAgentSessionHeader {
	readonly type: 'header';
	readonly version: number;
	readonly id: string;
	readonly createdAt: number;
	readonly workspace: IAgentSessionWorkspace;
}

/** A user prompt that opens a turn. */
export interface IAgentUserEntry {
	readonly type: 'user';
	/** Turn identity shared with the assistant reply. */
	readonly turn: string;
	readonly at: number;
	/** Plain prompt text (what the model receives). */
	readonly text: string;
	/** Opaque UI message payload owned by the editor. */
	readonly message: unknown;
}

/**
 * Assistant reply snapshot for a turn. Non-final snapshots are written while
 * streaming so a crash keeps partial output; the last record per turn wins.
 */
export interface IAgentAssistantEntry {
	readonly type: 'agent';
	readonly turn: string;
	readonly at: number;
	readonly final: boolean;
	readonly status: AgentSessionStatus;
	/** Plain reply text (what goes back into the model transcript). */
	readonly text: string;
	/** Short human summary for lists, e.g. "Edited a.ts, b.ts". */
	readonly summary?: string;
	readonly message: unknown;
}

/** Drop the turn `from` and everything after it (edit-and-resend). */
export interface IAgentTruncateEntry {
	readonly type: 'truncate';
	readonly at: number;
	readonly from: string;
}

/** Session-level metadata changes. */
export interface IAgentMetaEntry {
	readonly type: 'meta';
	readonly at: number;
	readonly title?: string;
	readonly mode?: string;
	readonly model?: string;
}

export type AgentHistoryEntry = IAgentUserEntry | IAgentAssistantEntry | IAgentTruncateEntry | IAgentMetaEntry;
export type AgentHistoryRecord = IAgentSessionHeader | AgentHistoryEntry;

export interface IAgentSessionTurn {
	readonly id: string;
	readonly user: IAgentUserEntry;
	readonly assistant?: IAgentAssistantEntry;
}

/** The folded, effective content of a session log. */
export interface IAgentSessionTranscript {
	readonly header: IAgentSessionHeader;
	readonly turns: readonly IAgentSessionTurn[];
	readonly title?: string;
	readonly mode?: string;
	readonly model?: string;
}

/** Composer state kept beside the log so unsent work survives restarts. */
export interface IAgentSessionDraft {
	readonly text: string;
	readonly mentions?: unknown[];
	readonly queue?: unknown[];
	readonly updatedAt: number;
}

/** Index projection of one session, enough to list and search without reading the log. */
export interface IAgentSessionMeta {
	readonly id: string;
	readonly title: string;
	/** True when the title was set by the user rather than derived. */
	readonly customTitle?: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly workspaceId: string;
	readonly workspaceLabel: string;
	readonly workspaceFolder?: string;
	readonly turnCount: number;
	/** First prompt, trimmed, for search and previews. */
	readonly preview: string;
	/** Latest activity summary, for the second line in lists. */
	readonly summary?: string;
	readonly status: AgentSessionStatus;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	readonly hasDraft?: boolean;
	readonly mode?: string;
	readonly model?: string;
}

export interface IAgentHistoryIndex {
	readonly version: number;
	readonly sessions: IAgentSessionMeta[];
}

export interface IAgentSessionSearchOptions {
	readonly matchCase?: boolean;
	readonly wholeWord?: boolean;
	readonly isRegex?: boolean;
}

export interface IAgentHistoryListOptions extends IAgentSessionSearchOptions {
	readonly workspaceId?: string;
	readonly includeArchived?: boolean;
	readonly limit?: number;
}

export interface IAgentSessionAppendAssistant {
	readonly turn: string;
	readonly final: boolean;
	readonly status: AgentSessionStatus;
	readonly text: string;
	readonly summary?: string;
	readonly message: unknown;
}

/**
 * One open channel onto a stored session. Every read and write of a log goes
 * through its handle; the service keeps one handle per session id.
 */
export interface IAgentSessionHandle {
	readonly id: string;
	readonly meta: IAgentSessionMeta | undefined;

	/** Load and fold the log. The file is read once; later calls return the current folded state. */
	load(): Promise<IAgentSessionTranscript>;
	loadDraft(): Promise<IAgentSessionDraft | undefined>;

	appendUser(turn: string, text: string, message: unknown): void;
	appendAssistant(entry: IAgentSessionAppendAssistant): void;
	truncate(fromTurn: string): void;
	setMeta(meta: { title?: string; mode?: string; model?: string }): void;
	saveDraft(draft: Omit<IAgentSessionDraft, 'updatedAt'> | undefined): void;

	/** Durability barrier: every accepted append is on disk when this resolves. */
	flush(): Promise<void>;
	/** Flush and, when worthwhile, rewrite the log without superseded records. */
	close(): Promise<void>;
}

export const IAgentHistoryService = createDecorator<IAgentHistoryService>('agentHistoryService');

export interface IAgentHistoryService {
	readonly _serviceBrand: undefined;

	/** Fires when the index changes (new session, status, title, pin, ...). */
	readonly onDidChange: Event<void>;
	/** Resolves once the index has been loaded from disk. */
	readonly whenReady: Promise<void>;
	/** Identity of the current workspace as recorded in new sessions. */
	readonly currentWorkspace: IAgentSessionWorkspace;

	list(options?: IAgentHistoryListOptions): IAgentSessionMeta[];
	search(query: string, options?: IAgentHistoryListOptions): IAgentSessionMeta[];
	get(id: string): IAgentSessionMeta | undefined;
	/** True when a session log exists on disk for the id. */
	has(id: string): boolean;

	/** Open (creating on first append) the handle for a session id. */
	open(id: string): IAgentSessionHandle;

	setPinned(id: string, pinned: boolean): Promise<void>;
	setArchived(id: string, archived: boolean): Promise<void>;
	rename(id: string, title: string | undefined): Promise<void>;
	delete(id: string): Promise<void>;

	/** Store binary content once and return a stable content-addressed reference. */
	putAttachment(bytes: Uint8Array, mime: string): Promise<string>;
	getAttachment(ref: string): Promise<{ bytes: Uint8Array; mime: string } | undefined>;

	/** Flush every open handle (used on shutdown). */
	flushAll(): Promise<void>;
}
