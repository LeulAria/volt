/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dirent, promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { VoltUsageProvider, VoltUsageSpeed } from '../common/voltUsage.js';

/** One billed model call. */
export interface IUsageRecord {
	readonly provider: VoltUsageProvider;
	readonly timestampMs: number;
	readonly model: string;
	readonly sessionId: string;
	readonly uncached: number;
	readonly cached: number;
	readonly cacheWrite: number;
	readonly output: number;
	/**
	 * Billing speed. Claude fast mode and Codex `priority` are `fast`, Codex `ultrafast` is
	 * `ultrafast`; Cursor reports none, so its records are `standard`.
	 */
	readonly speed: VoltUsageSpeed;
	/** Cost the provider reported itself (Cursor). Wins over the price table. */
	readonly reportedCostUsd?: number;
	/** Same call seen twice (Claude copies records into resumed or forked sessions). */
	readonly dedupeKey?: string;
}

/** Codex writes its rate limits into every `token_count` event; the newest one is a fallback for the live read. */
export interface ICodexRateLimitSample {
	readonly timestampMs: number;
	readonly raw: Record<string, unknown>;
}

export interface ITranscriptFile {
	readonly path: string;
	readonly provider: 'claude' | 'codex';
	readonly mtimeMs: number;
	readonly size: number;
}

/** When a transcript's sessions were active: every hour that has a line, billed or not. */
export interface ITranscriptActivity {
	readonly sessionIds: readonly string[];
	/** Hour starts, epoch ms. */
	readonly hours: readonly number[];
}

export interface IParsedTranscript {
	readonly records: IUsageRecord[];
	readonly rateLimits?: ICodexRateLimitSample;
	readonly activity?: ITranscriptActivity;
}

function int(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * One assistant line of a Claude Code transcript. Claude Code writes one line per content
 * block and repeats the message's full `usage` on each, so callers must drop repeats by
 * `dedupeKey` or the totals come out roughly 2.4x too high.
 */
export function parseClaudeLine(line: string): IUsageRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const entry = record(parsed);
	if (!entry || entry.type !== 'assistant') {
		return undefined;
	}
	const message = record(entry.message);
	const usage = record(message?.usage);
	if (!message || !usage) {
		return undefined;
	}
	const timestampMs = timestamp(entry.timestamp);
	const model = typeof message.model === 'string' ? message.model : '';
	if (timestampMs === undefined || !model || model === '<synthetic>') {
		return undefined;
	}
	const messageId = typeof message.id === 'string' ? message.id : undefined;
	const requestId = typeof entry.requestId === 'string' ? entry.requestId : undefined;
	const result: IUsageRecord = {
		provider: 'claude',
		timestampMs,
		model,
		sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
		uncached: int(usage.input_tokens),
		cached: int(usage.cache_read_input_tokens),
		cacheWrite: int(usage.cache_creation_input_tokens),
		output: int(usage.output_tokens),
		speed: usage.speed === 'fast' ? 'fast' : 'standard',
		...(messageId || requestId ? { dedupeKey: `${messageId ?? ''}:${requestId ?? ''}` } : {}),
	};
	return result.uncached + result.cached + result.cacheWrite + result.output > 0 ? result : undefined;
}

/**
 * Claude Code writes one API response as several lines (thinking, text, each tool call), each
 * repeating the response's usage, and copies lines into resumed sessions. Bill each response
 * once. Output grows while the response streams, so keep the largest copy: the first line can
 * say 8 output tokens where the response ended at 353. The first copy's time and session win.
 */
export function billOncePerResponse(records: Iterable<IUsageRecord>): IUsageRecord[] {
	const responses = new Map<string, IUsageRecord>();
	const loose: IUsageRecord[] = [];
	for (const item of records) {
		if (!item.dedupeKey) {
			loose.push(item);
			continue;
		}
		const held = responses.get(item.dedupeKey);
		responses.set(item.dedupeKey, held ? {
			...held,
			uncached: Math.max(held.uncached, item.uncached),
			cached: Math.max(held.cached, item.cached),
			cacheWrite: Math.max(held.cacheWrite, item.cacheWrite),
			output: Math.max(held.output, item.output),
		} : item);
	}
	return [...responses.values(), ...loose];
}

interface ICodexScanState {
	model: string;
	/** From the latest `thread_settings_applied`; `token_count` events carry no tier. */
	speed: VoltUsageSpeed;
	sessionId: string;
	lastSignature?: string;
	sawMeta: boolean;
	suppressingForkCopies: boolean;
	forkAnchorMs: number;
}

/**
 * A Codex `service_tier` as a billing speed. Codex leaves the field out when no tier was asked
 * for, which bills as standard, as do `default` and `standard`. `fast` is an alias of `priority`.
 */
function codexSpeed(serviceTier: unknown): VoltUsageSpeed {
	if (serviceTier === 'priority' || serviceTier === 'fast') {
		return 'fast';
	}
	return serviceTier === 'ultrafast' ? 'ultrafast' : 'standard';
}

/**
 * A forked or subagent rollout starts with the parent's history copied in, every line
 * stamped within a few ms of the fork. The child's own first usage lands seconds later.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSession(payload: Record<string, unknown>): boolean {
	if (typeof payload.forked_from_id === 'string') {
		return true;
	}
	const spawn = record(record(record(payload.source)?.subagent)?.thread_spawn);
	return typeof spawn?.parent_thread_id === 'string';
}

/**
 * One line of a Codex rollout. Usage comes from `last_token_usage` deltas; Codex repeats an
 * event when nothing changed, so a repeat of the previous delta is dropped.
 */
function parseCodexLine(line: string, state: ICodexScanState, out: { rateLimits?: ICodexRateLimitSample }): IUsageRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const entry = record(parsed);
	const payload = record(entry?.payload);
	if (!entry || !payload) {
		return undefined;
	}
	if (entry.type === 'session_meta') {
		if (!state.sawMeta) {
			state.sawMeta = true;
			const id = payload.id ?? payload.session_id;
			if (typeof id === 'string') {
				state.sessionId = id;
			}
			const metaMs = timestamp(entry.timestamp);
			if (metaMs !== undefined && isForkedSession(payload)) {
				state.suppressingForkCopies = true;
				state.forkAnchorMs = metaMs;
			}
		}
		return undefined;
	}
	if (entry.type === 'turn_context') {
		if (typeof payload.model === 'string') {
			state.model = payload.model;
		}
		return undefined;
	}
	if (payload.type === 'thread_settings_applied') {
		const settings = record(payload.thread_settings);
		if (settings) {
			state.speed = codexSpeed(settings.service_tier);
		}
		return undefined;
	}
	if (payload.type !== 'token_count') {
		return undefined;
	}
	const timestampMs = timestamp(entry.timestamp);
	if (timestampMs === undefined) {
		return undefined;
	}
	const limits = record(payload.rate_limits);
	if (limits && (!out.rateLimits || out.rateLimits.timestampMs <= timestampMs)) {
		out.rateLimits = { timestampMs, raw: limits };
	}
	const last = record(record(payload.info)?.last_token_usage);
	if (!last || !state.model) {
		return undefined;
	}
	const signature = JSON.stringify(last);
	if (signature === state.lastSignature) {
		return undefined;
	}
	state.lastSignature = signature;
	if (state.suppressingForkCopies) {
		if (timestampMs - state.forkAnchorMs < FORK_COPY_MAX_GAP_MS) {
			state.forkAnchorMs = timestampMs;
			return undefined;
		}
		state.suppressingForkCopies = false;
	}
	// Codex counts cached input inside `input_tokens`.
	const input = int(last.input_tokens);
	const cached = int(last.cached_input_tokens);
	const cacheWrite = int(last.cache_write_input_tokens);
	const result: IUsageRecord = {
		provider: 'codex',
		timestampMs,
		model: state.model,
		sessionId: state.sessionId,
		uncached: Math.max(0, input - cached - cacheWrite),
		cached,
		cacheWrite,
		output: int(last.output_tokens),
		speed: state.speed,
	};
	return result.uncached + result.cached + result.cacheWrite + result.output > 0 ? result : undefined;
}

/** Calls `onLine` for each line that contains `needle`, without splitting the whole file into an array. */
function forEachMatchingLine(text: string, needle: string, onLine: (line: string) => void): void {
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf('\n', start);
		if (end === -1) {
			end = text.length;
		}
		const hit = text.indexOf(needle, start);
		if (hit === -1) {
			return;
		}
		if (hit < end) {
			onLine(text.slice(start, end));
			start = end + 1;
		} else {
			// Jump to the line holding the next hit.
			const lineStart = text.lastIndexOf('\n', hit) + 1;
			start = Math.max(lineStart, end + 1);
		}
	}
}

const HOUR_MS = 60 * 60 * 1000;
/** Top-level fields only: an escaped quote (`\\"`) means the text sits inside a string value. */
const TIMESTAMP_FIELD = /(?<!\\)"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/g;
const SESSION_FIELD = /(?<!\\)"(?:sessionId|session_id)":"([^"]+)"/g;

/**
 * Sessions and the hours they were active, read with regexes rather than JSON.parse so every
 * line can be visited cheaply. A Codex rollout names its session in `session_meta` only.
 */
function readActivity(text: string, fallbackSessionId?: string): ITranscriptActivity | undefined {
	const sessionIds = new Set<string>();
	for (const match of text.matchAll(SESSION_FIELD)) {
		// A regex match is a slice that keeps the whole transcript's text alive; the parsed transcripts
		// are cached, so 2 GB of Claude transcripts ran the main process out of memory. Copy it out.
		sessionIds.add(Buffer.from(match[1], 'utf8').toString('utf8'));
	}
	if (!sessionIds.size && fallbackSessionId) {
		sessionIds.add(fallbackSessionId);
	}
	const hours = new Set<number>();
	for (const match of text.matchAll(TIMESTAMP_FIELD)) {
		const ms = Date.parse(match[1]);
		if (!Number.isNaN(ms)) {
			hours.add(Math.floor(ms / HOUR_MS) * HOUR_MS);
		}
	}
	return sessionIds.size && hours.size ? { sessionIds: [...sessionIds], hours: [...hours] } : undefined;
}

export async function parseTranscript(file: ITranscriptFile): Promise<IParsedTranscript> {
	const text = await fs.readFile(file.path, 'utf8');
	const records: IUsageRecord[] = [];
	if (file.provider === 'claude') {
		forEachMatchingLine(text, '"usage"', line => {
			const parsed = parseClaudeLine(line);
			if (parsed) {
				records.push(parsed);
			}
		});
		const activity = readActivity(text);
		return { records, ...(activity ? { activity } : {}) };
	}
	const state: ICodexScanState = { model: '', speed: 'standard', sessionId: '', sawMeta: false, suppressingForkCopies: false, forkAnchorMs: 0 };
	const out: { rateLimits?: ICodexRateLimitSample } = {};
	// Every line the parser needs carries one of these types; the rest are skipped unparsed.
	forEachMatchingLine(text, '"type":"', line => {
		if (line.includes('"token_count"') || line.includes('"turn_context"') || line.includes('"session_meta"') || line.includes('"thread_settings_applied"')) {
			const parsed = parseCodexLine(line, state, out);
			if (parsed) {
				records.push(parsed);
			}
		}
	});
	const activity = readActivity(text, state.sessionId || undefined);
	return { records, ...(out.rateLimits ? { rateLimits: out.rateLimits } : {}), ...(activity ? { activity } : {}) };
}

/** Every `.jsonl` under `root` changed since `sinceMs`. Missing roots are skipped. */
export async function listTranscripts(root: string, provider: 'claude' | 'codex', sinceMs: number, into: ITranscriptFile[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			await listTranscripts(path, provider, sinceMs, into);
		} else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
			try {
				const stat = await fs.stat(path);
				if (stat.mtimeMs >= sinceMs) {
					into.push({ path, provider, mtimeMs: stat.mtimeMs, size: stat.size });
				}
			} catch {
				// Deleted between readdir and stat.
			}
		}
	}
}
