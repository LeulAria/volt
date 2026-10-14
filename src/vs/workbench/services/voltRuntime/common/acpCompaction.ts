/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent, VoltCompactionStatus } from './events.js';
import { readTokenCount } from './tokenUsage.js';

/**
 * Context compaction from an ACP agent. claude-agent-acp and codex-acp send it in one of two shapes:
 * - `compaction_update` / `compaction_summary_chunk` once the client advertised `session.compaction`
 *   (status, the kept summary, and `_meta.contextCompaction` with the token counts);
 * - otherwise a "Compact conversation" `tool_call` marked by the same `_meta.contextCompaction`,
 *   with the counts in its `rawOutput`.
 * Both become `context.compaction` events. Undefined for any other update.
 */
export function compactionEventsFromAcpUpdate(update: Record<string, unknown>): IVoltEvent[] | undefined {
	const kind = String(update.sessionUpdate ?? update.type ?? '');
	if (kind === 'compaction_update') {
		const id = readId(update.compactionId);
		if (!id) {
			return [];
		}
		const summary = update.summary === null ? '' : Array.isArray(update.summary) ? contentText(update.summary) : undefined;
		const error = typeof update.error === 'string' && update.error.trim() ? update.error.trim() : undefined;
		return [{
			type: 'context.compaction',
			id,
			...withStatus(readStatus(update.status)),
			...compactionFacts(update._meta),
			...(summary !== undefined ? { summary } : {}),
			...(error ? { error } : {}),
		}];
	}
	if (kind === 'compaction_summary_chunk') {
		const id = readId(update.compactionId);
		const delta = contentText([update.content]);
		return id && delta ? [{ type: 'context.compaction', id, summaryDelta: delta }] : [];
	}
	if ((kind === 'tool_call' || kind === 'tool_call_update') && isCompactionMeta(update._meta)) {
		const id = readId(update.toolCallId);
		if (!id) {
			return [];
		}
		const status = readStatus(update.status);
		const raw = update.rawOutput && typeof update.rawOutput === 'object' ? update.rawOutput as Record<string, unknown> : undefined;
		const error = status === 'failed' ? (contentText(Array.isArray(update.content) ? update.content : []).replace(/^Compaction failed:\s*/i, '') || undefined) : undefined;
		return [{
			type: 'context.compaction',
			id,
			// The opening call carries no status on some agents; a first sighting is a running compaction.
			...withStatus(status ?? (kind === 'tool_call' ? 'running' : undefined)),
			...compactionFacts(update._meta),
			...(raw ? readFacts(raw) : {}),
			...(error ? { error } : {}),
		}];
	}
	return undefined;
}

type CompactionFacts = Pick<Extract<IVoltEvent, { type: 'context.compaction' }>, 'trigger' | 'preTokens' | 'postTokens' | 'durationMs'>;

function isCompactionMeta(meta: unknown): boolean {
	return !!meta && typeof meta === 'object' && !!(meta as Record<string, unknown>).contextCompaction;
}

function compactionFacts(meta: unknown): CompactionFacts {
	const facts = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).contextCompaction : undefined;
	return facts && typeof facts === 'object' ? readFacts(facts as Record<string, unknown>) : {};
}

function readFacts(raw: Record<string, unknown>): CompactionFacts {
	const trigger = raw.trigger === 'automatic' || raw.trigger === 'auto' ? 'auto' : raw.trigger === 'manual' ? 'manual' : undefined;
	const preTokens = readTokenCount(raw.preTokens ?? raw.pre_tokens);
	const postTokens = readTokenCount(raw.postTokens ?? raw.post_tokens);
	const durationMs = readTokenCount(raw.durationMs ?? raw.duration_ms);
	return {
		...(trigger ? { trigger } : {}),
		...(preTokens !== undefined ? { preTokens } : {}),
		...(postTokens !== undefined ? { postTokens } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

function readStatus(value: unknown): VoltCompactionStatus | undefined {
	switch (value) {
		case 'pending':
		case 'in_progress':
			return 'running';
		case 'completed':
		case 'failed':
		case 'cancelled':
			return value;
		default:
			return undefined;
	}
}

function withStatus(status: VoltCompactionStatus | undefined): { status?: VoltCompactionStatus } {
	return status ? { status } : {};
}

function readId(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

/** Text of ACP content blocks, also when wrapped as tool content (`{ type: 'content', content }`). */
function contentText(blocks: readonly unknown[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		const inner = block && typeof block === 'object' && (block as { type?: unknown }).type === 'content' ? (block as { content?: unknown }).content : block;
		if (inner && typeof inner === 'object' && typeof (inner as { text?: unknown }).text === 'string') {
			parts.push((inner as { text: string }).text);
		}
	}
	return parts.join('');
}
