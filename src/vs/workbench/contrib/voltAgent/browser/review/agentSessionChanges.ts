/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentSegment, FileChangeVerb, IFileChangeBlock } from '../blocks/agentBlocks.js';
import { computeChangeStats, netFileEdit } from './fileChangePreviewModel.js';

export type AgentChangeKind = 'added' | 'modified' | 'deleted';

/** One turn's changes, by the turn id (the user message's id). */
export type AgentTurnScope = `turn:${string}`;

/** `pending` is what the agent changed that the user has not kept or undone yet. */
export type AgentChangesScope = 'pending' | 'uncommitted' | 'lastTurn' | 'staged' | 'unstaged' | AgentTurnScope;

export function agentTurnScope(turnId: string): AgentTurnScope {
	return `turn:${turnId}`;
}

/** The turn id of a `turn:` scope. */
export function agentScopeTurnId(scope: string): string | undefined {
	return scope.startsWith('turn:') && scope.length > 5 ? scope.slice(5) : undefined;
}

export interface IAgentChangeTranscriptMessage {
	readonly kind: string;
	readonly id?: string;
	/** A user message's prompt. */
	readonly text?: string;
	readonly segments?: readonly AgentSegment[];
}

/** A turn of a chat whose agent changed files, as its snapshots recorded it. */
export interface IAgentChangesTurn {
	readonly turnId: string;
	/** 1-based, counting every user message of the chat. */
	readonly number: number;
	readonly prompt?: string;
}

export interface IAgentSessionFileChange {
	readonly path: string;
	readonly kind: AgentChangeKind;
	readonly additions: number;
	readonly deletions: number;
	readonly original?: string;
	readonly modified?: string;
	readonly unifiedDiff?: string;
	readonly turnId?: string;
	/** Known only from the agent's snapshots (a shell command, a rename, a binary): content comes from these blobs. */
	readonly snapshot?: IAgentSnapshotSource;
}

export interface IAgentSnapshotSource {
	readonly repoRoot: string;
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly binary: boolean;
}

/** One file from the snapshot diff of a chat (see IAgentCheckpointService.getChanges). */
export interface IAgentSnapshotFileChange {
	/** Repo-relative, forward slashes. */
	readonly path: string;
	readonly oldPath?: string;
	/** The file's absolute path, to match transcript paths written either way. */
	readonly absolutePath: string;
	readonly oldAbsolutePath?: string;
	readonly kind: 'added' | 'modified' | 'deleted' | 'renamed';
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
	readonly repoRoot: string;
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly turnId?: string;
}

export interface IAgentSessionChangeStats {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

export function normalizeAgentChangePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function agentChangeKindFromVerb(verb?: FileChangeVerb | string): AgentChangeKind {
	if (verb === 'Created') {
		return 'added';
	}
	if (verb === 'Deleted') {
		return 'deleted';
	}
	return 'modified';
}

export function sumAgentChangeStats(changes: readonly IAgentSessionFileChange[]): IAgentSessionChangeStats {
	let additions = 0;
	let deletions = 0;
	for (const change of changes) {
		additions += change.additions;
		deletions += change.deletions;
	}
	return { files: changes.length, additions, deletions };
}

/**
 * What the change list is computed from: every file block's identity and content sizes, per turn.
 * A streaming reply updates the transcript many times a second with text only; when this is
 * unchanged the change list is too.
 */
export function fileChangesSignature(messages: readonly IAgentChangeTranscriptMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const turn = messageFileChangesSignature(message);
		if (turn) {
			parts.push(`${message.id ?? ''}:${turn}`);
		}
	}
	return parts.join('\n');
}

/** One reply's part of {@link fileChangesSignature}; empty for a user message or a reply that changed no file. */
export function messageFileChangesSignature(message: IAgentChangeTranscriptMessage): string {
	if (message.kind !== 'agent') {
		return '';
	}
	let turn = '';
	for (const segment of message.segments ?? []) {
		if (segment.kind !== 'block' || segment.block.type !== 'file') {
			continue;
		}
		const block = segment.block;
		turn += `${block.id}|${block.path}|${block.verb}|${block.status}|${block.original?.length ?? -1}|${block.modified?.length ?? -1}|${block.unifiedDiff?.length ?? -1}|${block.additions ?? ''}|${block.deletions ?? ''};`;
	}
	return turn;
}

/** Decides from the path as the agent wrote it (before normalizing) whether a change counts. */
export type AgentChangePathFilter = (rawPath: string) => boolean;

export function collectSessionFileChanges(messages: readonly IAgentChangeTranscriptMessage[], keep?: AgentChangePathFilter): IAgentSessionFileChange[] {
	const byPath = new Map<string, IAgentSessionFileChange>();
	for (const message of messages) {
		if (message.kind !== 'agent') {
			continue;
		}
		for (const change of collectFileChangesFromSegments(message.segments, message.id, keep)) {
			byPath.set(change.path, mergeAgentFileChange(byPath.get(change.path), change));
		}
	}
	return [...byPath.values()];
}

export function collectLastTurnFileChanges(messages: readonly IAgentChangeTranscriptMessage[], keep?: AgentChangePathFilter): IAgentSessionFileChange[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.kind !== 'agent') {
			continue;
		}
		const files = collectFileChangesFromSegments(message.segments, message.id, keep);
		if (files.length) {
			return files;
		}
	}
	return [];
}

export function collectFileChangesFromSegments(segments: readonly AgentSegment[] | undefined, turnId?: string, keep?: AgentChangePathFilter): IAgentSessionFileChange[] {
	const byPath = new Map<string, IAgentSessionFileChange>();
	for (const segment of segments ?? []) {
		if (segment.kind !== 'block' || segment.block.type !== 'file') {
			continue;
		}
		if (keep && !keep(segment.block.path)) {
			continue;
		}
		const change = fileChangeFromBlock(segment.block, turnId);
		if (!change) {
			continue;
		}
		byPath.set(change.path, mergeAgentFileChange(byPath.get(change.path), change));
	}
	return [...byPath.values()];
}

function fileChangeFromBlock(block: IFileChangeBlock, turnId?: string): IAgentSessionFileChange | undefined {
	const path = normalizeAgentChangePath(block.path);
	if (!path) {
		return undefined;
	}
	const stats = resolveChangeStats(block.original, block.modified, block.additions, block.deletions, block.unifiedDiff, true);
	return {
		path,
		kind: agentChangeKindFromVerb(block.verb),
		additions: stats.additions,
		deletions: stats.deletions,
		original: block.original,
		modified: block.modified,
		unifiedDiff: block.unifiedDiff,
		turnId,
	};
}

function mergeAgentFileChange(existing: IAgentSessionFileChange | undefined, incoming: IAgentSessionFileChange): IAgentSessionFileChange {
	if (!existing) {
		return incoming;
	}
	const original = existing.original ?? incoming.original;
	const modified = incoming.modified ?? existing.modified;
	const unifiedDiff = incoming.unifiedDiff ?? existing.unifiedDiff;
	// The net change when the edits replay into whole files; otherwise each edit's own stats add up.
	// The last edit's numbers alone undercount: a new 350-line file touched up by 2 lines is not "+2".
	const net = netFileEdit([
		{ original: existing.original, modified: existing.modified, created: existing.kind === 'added' },
		{ original: incoming.original, modified: incoming.modified, created: incoming.kind === 'added' },
	]);
	const stats = net
		? resolveChangeStats(net.original, net.modified, undefined, undefined)
		: { additions: existing.additions + incoming.additions, deletions: existing.deletions + incoming.deletions };
	return {
		path: existing.path,
		kind: mergeChangeKind(existing.kind, incoming.kind),
		additions: stats.additions,
		deletions: stats.deletions,
		original,
		modified,
		unifiedDiff,
		turnId: incoming.turnId ?? existing.turnId,
	};
}

function mergeChangeKind(existing: AgentChangeKind, incoming: AgentChangeKind): AgentChangeKind {
	if (incoming === 'deleted') {
		return existing === 'added' ? 'added' : 'deleted';
	}
	if (existing === 'added') {
		return 'added';
	}
	return incoming;
}

function resolveChangeStats(
	original: string | undefined,
	modified: string | undefined,
	additions: number | undefined,
	deletions: number | undefined,
	unifiedDiff?: string,
	preferProvided = false,
): { additions: number; deletions: number } {
	if (preferProvided && (additions !== undefined || deletions !== undefined)) {
		return { additions: additions ?? 0, deletions: deletions ?? 0 };
	}
	if (original !== undefined && modified !== undefined) {
		return computeChangeStats({ original, modified, unifiedDiff, additions, deletions });
	}
	return { additions: additions ?? 0, deletions: deletions ?? 0 };
}

/**
 * The transcript's change list plus what only the snapshots saw: files a shell command changed,
 * renames (the old path deleted, the new one added) and binaries. Files the transcript already
 * lists keep their transcript entry.
 */
export function mergeSnapshotChanges(transcript: readonly IAgentSessionFileChange[], snapshot: readonly IAgentSnapshotFileChange[]): IAgentSessionFileChange[] {
	const out = [...transcript];
	const listed = (path: string, absolute: string) => {
		const abs = normalizeAgentChangePath(absolute);
		return out.some(file => file.path === path || file.path === abs || file.path.endsWith(`/${path}`) || abs.endsWith(`/${file.path}`));
	};
	for (const change of snapshot) {
		const source = { repoRoot: change.repoRoot, binary: change.binary };
		if (change.kind === 'renamed' && change.oldPath && change.oldAbsolutePath && !listed(change.oldPath, change.oldAbsolutePath)) {
			out.push({ path: change.oldPath, kind: 'deleted', additions: 0, deletions: change.binary ? 0 : change.deletions, turnId: change.turnId, snapshot: { ...source, oldBlob: change.oldBlob } });
		}
		if (listed(change.path, change.absolutePath)) {
			continue;
		}
		const renamed = change.kind === 'renamed';
		out.push({
			path: change.path,
			kind: renamed ? 'added' : change.kind,
			additions: change.additions,
			deletions: renamed ? 0 : change.deletions,
			turnId: change.turnId,
			snapshot: { ...source, oldBlob: renamed ? undefined : change.oldBlob, newBlob: change.newBlob },
		});
	}
	return out;
}
