/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentSegment, FileChangeVerb, IFileChangeBlock } from '../blocks/agentBlocks.js';
import { computeFileChangePreview } from './fileChangePreviewModel.js';

export type AgentChangeKind = 'added' | 'modified' | 'deleted';

export type AgentChangesScope = 'uncommitted' | 'lastTurn' | 'staged' | 'unstaged';

export interface IAgentChangeTranscriptMessage {
	readonly kind: string;
	readonly id?: string;
	readonly segments?: readonly AgentSegment[];
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

export function collectSessionFileChanges(messages: readonly IAgentChangeTranscriptMessage[]): IAgentSessionFileChange[] {
	const byPath = new Map<string, IAgentSessionFileChange>();
	for (const message of messages) {
		if (message.kind !== 'agent') {
			continue;
		}
		for (const change of collectFileChangesFromSegments(message.segments, message.id)) {
			byPath.set(change.path, mergeAgentFileChange(byPath.get(change.path), change));
		}
	}
	return [...byPath.values()];
}

export function collectLastTurnFileChanges(messages: readonly IAgentChangeTranscriptMessage[]): IAgentSessionFileChange[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.kind !== 'agent') {
			continue;
		}
		const files = collectFileChangesFromSegments(message.segments, message.id);
		if (files.length) {
			return files;
		}
	}
	return [];
}

export function collectFileChangesFromSegments(segments: readonly AgentSegment[] | undefined, turnId?: string): IAgentSessionFileChange[] {
	const byPath = new Map<string, IAgentSessionFileChange>();
	for (const segment of segments ?? []) {
		if (segment.kind !== 'block' || segment.block.type !== 'file') {
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
	const stats = resolveChangeStats(original, modified, incoming.additions, incoming.deletions, unifiedDiff);
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
		const preview = computeFileChangePreview({ original, modified, unifiedDiff, additions, deletions });
		return { additions: preview.additions, deletions: preview.deletions };
	}
	return { additions: additions ?? 0, deletions: deletions ?? 0 };
}
