/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AGENT_HISTORY_FORMAT_VERSION,
	AgentHistoryEntry,
	AgentHistoryRecord,
	AgentSessionStatus,
	IAgentAssistantEntry,
	IAgentHistoryIndex,
	IAgentSessionHeader,
	IAgentSessionMeta,
	IAgentSessionTranscript,
	IAgentSessionTurn,
	IAgentUserEntry,
} from './agentHistory.js';

const NEWLINE = 0x0a;
const MAX_TITLE_LENGTH = 56;
const MAX_PREVIEW_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 96;

//#region Encoding

export function encodeRecord(record: AgentHistoryRecord): string {
	return JSON.stringify(record) + '\n';
}

export function encodeRecords(records: readonly AgentHistoryRecord[]): string {
	let out = '';
	for (const record of records) {
		out += encodeRecord(record);
	}
	return out;
}

export interface IDecodedLog {
	readonly header: IAgentSessionHeader | undefined;
	readonly entries: AgentHistoryEntry[];
	/** Byte length of the valid, newline-terminated prefix. Appends continue here. */
	readonly validBytes: number;
	/** True when trailing bytes were discarded (torn write) or a line failed to parse. */
	readonly damaged: boolean;
	/** Number of records read (including the header). */
	readonly recordCount: number;
}

/**
 * Decode a JSONL log. Complete lines that fail to parse are skipped; an
 * unterminated trailing line is treated as a torn write and discarded. The
 * returned `validBytes` marks where the next append must start so the torn
 * tail is overwritten rather than kept.
 */
export function decodeLog(bytes: Uint8Array): IDecodedLog {
	const decoder = new TextDecoder();
	const entries: AgentHistoryEntry[] = [];
	let header: IAgentSessionHeader | undefined;
	let validBytes = 0;
	let damaged = false;
	let recordCount = 0;
	let lineStart = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== NEWLINE) {
			continue;
		}
		const lineEnd = i;
		if (lineEnd > lineStart) {
			const line = decoder.decode(bytes.subarray(lineStart, lineEnd));
			const record = parseRecord(line);
			if (record) {
				recordCount++;
				if (record.type === 'header') {
					header ??= record;
				} else if (header) {
					entries.push(record);
				}
				validBytes = i + 1;
			} else {
				damaged = true;
				// Keep advancing so later valid lines are still read, but the
				// broken line stays inside the retained prefix; compaction removes it.
				validBytes = i + 1;
			}
		} else {
			validBytes = i + 1;
		}
		lineStart = i + 1;
	}
	if (lineStart < bytes.length) {
		damaged = true;
	}
	return { header, entries, validBytes, damaged, recordCount };
}

function parseRecord(line: string): AgentHistoryRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is AgentHistoryRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	switch (record.type) {
		case 'header':
			return typeof record.id === 'string' && typeof record.createdAt === 'number' && typeof record.version === 'number' && !!record.workspace && typeof record.workspace === 'object';
		case 'user':
			return typeof record.turn === 'string' && typeof record.at === 'number' && typeof record.text === 'string';
		case 'agent':
			return typeof record.turn === 'string' && typeof record.at === 'number' && typeof record.final === 'boolean' && typeof record.text === 'string';
		case 'truncate':
			return typeof record.from === 'string' && typeof record.at === 'number';
		case 'meta':
			return typeof record.at === 'number';
		default:
			return false;
	}
}

//#endregion

//#region Folding

export function foldTranscript(header: IAgentSessionHeader, entries: readonly AgentHistoryEntry[]): IAgentSessionTranscript {
	const order: string[] = [];
	const turns = new Map<string, { user: IAgentUserEntry; assistant?: IAgentAssistantEntry }>();
	let title: string | undefined;
	let mode: string | undefined;
	let model: string | undefined;
	for (const entry of entries) {
		switch (entry.type) {
			case 'user': {
				if (!turns.has(entry.turn)) {
					order.push(entry.turn);
				}
				turns.set(entry.turn, { user: entry, assistant: turns.get(entry.turn)?.assistant });
				break;
			}
			case 'agent': {
				const turn = turns.get(entry.turn);
				if (turn) {
					turn.assistant = entry;
				}
				break;
			}
			case 'truncate': {
				const index = order.indexOf(entry.from);
				if (index >= 0) {
					for (const id of order.splice(index)) {
						turns.delete(id);
					}
				}
				break;
			}
			case 'meta':
				if (entry.title !== undefined) {
					title = entry.title || undefined;
				}
				if (entry.mode !== undefined) {
					mode = entry.mode;
				}
				if (entry.model !== undefined) {
					model = entry.model;
				}
				break;
		}
	}
	const folded: IAgentSessionTurn[] = [];
	for (const id of order) {
		const turn = turns.get(id);
		if (turn) {
			folded.push({ id, user: turn.user, assistant: turn.assistant });
		}
	}
	return { header, turns: folded, title, mode, model };
}

/** Records needed to reproduce a transcript without superseded entries. */
export function compactRecords(transcript: IAgentSessionTranscript): AgentHistoryRecord[] {
	const records: AgentHistoryRecord[] = [transcript.header];
	if (transcript.title !== undefined || transcript.mode !== undefined || transcript.model !== undefined) {
		records.push({ type: 'meta', at: transcript.header.createdAt, title: transcript.title, mode: transcript.mode, model: transcript.model });
	}
	for (const turn of transcript.turns) {
		records.push(turn.user);
		if (turn.assistant) {
			records.push(turn.assistant);
		}
	}
	return records;
}

/** Whether rewriting the log would reclaim enough to be worth the IO. */
export function shouldCompact(recordCount: number, effectiveCount: number, damaged: boolean): boolean {
	if (damaged) {
		return true;
	}
	const stale = recordCount - effectiveCount;
	return stale >= 8 || (stale >= 3 && stale * 2 >= effectiveCount);
}

//#endregion

//#region Derivation

/** Deterministic session title from the first prompt (first line, mentions stripped). */
export function deriveTitle(text: string): string {
	const firstLine = text
		.replace(/<[^>\n]{1,80}>/g, ' ')
		.split('\n')
		.map(line => line.trim())
		.find(line => line.length > 0) ?? '';
	const cleaned = firstLine.replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').trim();
	if (!cleaned) {
		return '';
	}
	const capitalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return truncateAtWord(capitalized, MAX_TITLE_LENGTH);
}

export function truncateAtWord(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

export function derivePreview(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length > MAX_PREVIEW_LENGTH ? `${collapsed.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : collapsed;
}

export function deriveStatus(transcript: IAgentSessionTranscript): AgentSessionStatus {
	const last = transcript.turns.at(-1);
	if (!last) {
		return 'idle';
	}
	if (!last.assistant) {
		return 'interrupted';
	}
	if (!last.assistant.final) {
		return last.assistant.status === 'running' ? 'running' : last.assistant.status;
	}
	return last.assistant.status;
}

export function deriveMeta(transcript: IAgentSessionTranscript, previous?: Partial<IAgentSessionMeta>): IAgentSessionMeta {
	const first = transcript.turns[0];
	const last = transcript.turns.at(-1);
	const derived = first ? deriveTitle(first.user.text) : '';
	const custom = transcript.title?.trim();
	const summary = last?.assistant?.summary ? truncateAtWord(last.assistant.summary, MAX_SUMMARY_LENGTH) : undefined;
	const updatedAt = Math.max(
		transcript.header.createdAt,
		last?.assistant?.at ?? 0,
		last?.user.at ?? 0,
		previous?.updatedAt ?? 0,
	);
	return {
		id: transcript.header.id,
		title: custom || derived || previous?.title || '',
		customTitle: !!custom,
		createdAt: transcript.header.createdAt,
		updatedAt,
		workspaceId: transcript.header.workspace.id,
		workspaceLabel: transcript.header.workspace.label,
		workspaceFolder: transcript.header.workspace.folders[0],
		turnCount: transcript.turns.length,
		preview: first ? derivePreview(first.user.text) : '',
		summary,
		status: deriveStatus(transcript),
		pinned: previous?.pinned,
		archived: previous?.archived,
		hasDraft: previous?.hasDraft,
		mode: transcript.mode ?? previous?.mode,
		model: transcript.model ?? previous?.model,
	};
}

//#endregion

//#region Index

export function createEmptyIndex(): IAgentHistoryIndex {
	return { version: AGENT_HISTORY_FORMAT_VERSION, sessions: [] };
}

/** Validate an index read from disk; returns undefined when it is unusable. */
export function normalizeIndex(raw: unknown): IAgentHistoryIndex | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const value = raw as { version?: unknown; sessions?: unknown };
	if (typeof value.version !== 'number' || !Array.isArray(value.sessions)) {
		return undefined;
	}
	const sessions: IAgentSessionMeta[] = [];
	const seen = new Set<string>();
	for (const item of value.sessions) {
		if (!isMeta(item) || seen.has(item.id)) {
			continue;
		}
		seen.add(item.id);
		sessions.push(item);
	}
	return { version: AGENT_HISTORY_FORMAT_VERSION, sessions };
}

function isMeta(value: unknown): value is IAgentSessionMeta {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const meta = value as Record<string, unknown>;
	return typeof meta.id === 'string'
		&& typeof meta.title === 'string'
		&& typeof meta.createdAt === 'number'
		&& typeof meta.updatedAt === 'number'
		&& typeof meta.workspaceId === 'string'
		&& typeof meta.workspaceLabel === 'string'
		&& typeof meta.turnCount === 'number'
		&& typeof meta.preview === 'string'
		&& typeof meta.status === 'string';
}

/** Nothing can be running when the app starts; mark such sessions interrupted. */
export function settleIndexAfterRestart(index: IAgentHistoryIndex): IAgentHistoryIndex {
	let changed = false;
	const sessions = index.sessions.map(meta => {
		if (meta.status === 'running') {
			changed = true;
			return { ...meta, status: 'interrupted' as const };
		}
		return meta;
	});
	return changed ? { version: index.version, sessions } : index;
}

export function sortSessions(sessions: readonly IAgentSessionMeta[]): IAgentSessionMeta[] {
	return [...sessions].sort((a, b) => {
		if (!!a.pinned !== !!b.pinned) {
			return a.pinned ? -1 : 1;
		}
		return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
	});
}

//#endregion

//#region Search

interface IScored {
	readonly meta: IAgentSessionMeta;
	readonly score: number;
}

/**
 * Rank sessions for a query. Title matches dominate, then preview and
 * summary; prefix matches beat substring matches; every query token must hit.
 */
export function searchSessions(sessions: readonly IAgentSessionMeta[], query: string): IAgentSessionMeta[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) {
		return sortSessions(sessions);
	}
	const scored: IScored[] = [];
	for (const meta of sessions) {
		const title = meta.title.toLowerCase();
		const preview = meta.preview.toLowerCase();
		const summary = (meta.summary ?? '').toLowerCase();
		let score = 0;
		let matched = true;
		for (const token of tokens) {
			const inTitle = title.indexOf(token);
			const inPreview = preview.indexOf(token);
			const inSummary = summary.indexOf(token);
			if (inTitle < 0 && inPreview < 0 && inSummary < 0) {
				matched = false;
				break;
			}
			if (inTitle >= 0) {
				score += inTitle === 0 || title[inTitle - 1] === ' ' ? 40 : 20;
			}
			if (inPreview >= 0) {
				score += inPreview === 0 ? 12 : 6;
			}
			if (inSummary >= 0) {
				score += 4;
			}
		}
		if (matched) {
			score += meta.pinned ? 2 : 0;
			scored.push({ meta, score });
		}
	}
	scored.sort((a, b) => b.score - a.score || b.meta.updatedAt - a.meta.updatedAt);
	return scored.map(item => item.meta);
}

//#endregion

//#region Attachments

export const ATTACHMENT_REF_PREFIX = 'volt-attachment:';

export function attachmentFileName(hash: string, mime: string): string {
	return `${hash}.${extensionForMime(mime)}`;
}

export function attachmentRef(fileName: string): string {
	return ATTACHMENT_REF_PREFIX + fileName;
}

export function parseAttachmentRef(ref: string): { fileName: string; mime: string } | undefined {
	if (!ref.startsWith(ATTACHMENT_REF_PREFIX)) {
		return undefined;
	}
	const fileName = ref.slice(ATTACHMENT_REF_PREFIX.length);
	if (!/^[a-f0-9]{8,64}\.[a-z0-9]{1,8}$/i.test(fileName)) {
		return undefined;
	}
	return { fileName, mime: mimeForExtension(fileName.split('.').pop() ?? '') };
}

const MIME_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg',
	'text/plain': 'txt',
	'application/json': 'json',
	'application/pdf': 'pdf',
};

export function extensionForMime(mime: string): string {
	const known = MIME_EXTENSIONS[mime.toLowerCase()];
	if (known) {
		return known;
	}
	const subtype = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').toLowerCase();
	return subtype ? subtype.slice(0, 8) : 'bin';
}

export function mimeForExtension(ext: string): string {
	const lower = ext.toLowerCase();
	for (const [mime, extension] of Object.entries(MIME_EXTENSIONS)) {
		if (extension === lower) {
			return mime;
		}
	}
	return lower === 'jpeg' ? 'image/jpeg' : `application/${lower || 'octet-stream'}`;
}

//#endregion

//#region Export

/** Markdown rendering of a folded transcript for "Export Transcript". */
export function renderTranscriptMarkdown(title: string, transcript: IAgentSessionTranscript, formatDate: (at: number) => string = at => new Date(at).toISOString()): string {
	const lines: string[] = [`# ${title}`, ''];
	const details = [transcript.header.workspace.label, formatDate(transcript.header.createdAt), transcript.mode, transcript.model].filter((part): part is string => !!part);
	lines.push(`_${details.join(' · ')}_`, '');
	for (const turn of transcript.turns) {
		lines.push('## User', '', turn.user.text.trim(), '');
		if (turn.assistant) {
			const status = turn.assistant.status === 'done' ? '' : ` _(${turn.assistant.status})_`;
			lines.push(`## Agent${status}`, '', turn.assistant.text.trim() || '_(no reply)_', '');
		}
	}
	return lines.join('\n');
}

//#endregion
