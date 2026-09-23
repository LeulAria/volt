/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DeepSeek harness contracts, held in-process.
 *
 * `@deepseek-ai/dsh-*` is a Cordis/Node plugin tree (published, and cloned under `.aInsp/`).
 * The workbench layer checker and the browser bundle cannot boot that runtime, so Volt keeps
 * the same wire: StreamChunk, tool presentation, pre-execute approval, and the turn loop.
 * Volt still owns HTTP to Claude and the editor components. No directory picker.
 */

export interface TokenUsage {
	readonly input: number;
	readonly output: number;
	readonly cache?: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted';

export type ContentBlockType = 'text' | 'reasoning' | 'tool-call';

export type ContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'reasoning'; readonly text: string }
	| { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string };

/** Adapter stream. Usage is emitted before finish, and nothing follows finish. Tool arguments stay raw JSON. */
export type StreamChunk =
	| { readonly type: 'block-start'; readonly index: number; readonly blockType: ContentBlockType }
	| { readonly type: 'text-delta'; readonly index: number; readonly text: string }
	| { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
	| { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
	| { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
	| { readonly type: 'usage'; readonly usage: TokenUsage }
	| { readonly type: 'finish'; readonly reason: FinishReason };

export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';

export interface FileLocation {
	readonly path: string;
	readonly line?: number;
}

export interface FileDiff {
	readonly path: string;
	readonly oldText: string | null;
	readonly newText: string;
}

export type ToolCallView =
	| { readonly card: 'generic'; readonly title: string; readonly kind?: ToolCallKind; readonly rawInput?: unknown; readonly locations?: readonly FileLocation[] }
	| { readonly card: 'terminal'; readonly title: string; readonly description?: string; readonly cwd?: string }
	| { readonly card: 'diff'; readonly title: string; readonly diffs: readonly FileDiff[]; readonly locations?: readonly FileLocation[] };

export type ToolResultView =
	| { readonly card: 'generic'; readonly title?: string }
	| { readonly card: 'terminal'; readonly title?: string; readonly output?: string; readonly exitCode?: number; readonly signal?: string }
	| { readonly card: 'diff'; readonly title?: string; readonly diffs: readonly FileDiff[] }
	| { readonly card: 'search'; readonly shape: 'matches'; readonly title?: string; readonly files: readonly { readonly path: string; readonly matches: readonly { readonly lineNumber: number; readonly line: string }[] }[]; readonly truncated: boolean; readonly total: number }
	| { readonly card: 'search'; readonly shape: 'paths'; readonly title?: string; readonly paths: readonly string[]; readonly truncated: boolean; readonly total: number }
	| { readonly card: 'read'; readonly title?: string; readonly path: string; readonly offset: number; readonly lines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number; readonly lang?: string }
	| { readonly card: 'web'; readonly kind: 'search'; readonly title?: string; readonly sources: readonly { readonly url: string; readonly title?: string; readonly snippet?: string }[]; readonly answer?: string; readonly truncated: boolean }
	| { readonly card: 'web'; readonly kind: 'fetch'; readonly title?: string; readonly url: string; readonly statusCode: number; readonly truncated: boolean };

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ApprovalPolicy = 'ask' | 'never';

/** Fail closed: only `allowed-once` runs the tool body. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
