/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider status that arrives beside the assistant transcript: ACP notices,
 * session-failure titles, and rate-limit payloads. The chat shows these
 * instead of treating the turn as empty or as a dead process.
 */

import type { IVoltRateLimitReading } from './events.js';

export type AcpNoticeSeverity = 'info' | 'warning' | 'error';

export interface IAcpNotice {
	readonly severity: AcpNoticeSeverity;
	readonly title: string;
	readonly description?: string;
	/** When a usage limit resets (epoch ms), from the provider's rate-limit payload. */
	readonly resetAt?: number;
	/** The structured reading behind a usage-limit line. */
	readonly rateLimit?: IVoltRateLimitReading;
}

export interface IAcpNoticeOptions {
	readonly timeZone?: string;
	readonly locale?: string;
	/** For tests: a reset on another day names the day. */
	readonly now?: number;
}

const HANDLED_UPDATES = new Set([
	'agent_message_chunk',
	'agent_message',
	'agent_thought_chunk',
	'agent_thought',
	'user_message_chunk',
	'plan',
	'tool_call',
	'tool_call_update',
	'usage_update',
	'state_update',
	'notice',
	'available_commands_update',
	'current_mode_update',
	'config_option_update',
	'session_info_update',
	'compaction_update',
	'compaction_summary_chunk',
]);

const LIMIT_FAMILY = /\b(spend limit|usage limit|rate limit|quota|session limit|hit your)\b/i;

/** Text that says a usage, rate or spend limit stopped the run. */
export function isUsageLimitText(text: string | undefined): boolean {
	return !!text && LIMIT_FAMILY.test(text);
}

const RETRY_RE = /^(?:reconnecting|retrying)\b/i;

/** "Reconnecting to Claude, attempt 3 of 10.": progress of a retry, for the live status line, not a transcript row. */
export function isRetryNotice(title: string | undefined): boolean {
	return !!title && RETRY_RE.test(title.trim());
}

const SIGN_IN_RE = /\b(sign in|log in|authenticate|authentication|oauth)\b/i;

/** A provider notice that means the user has to sign in before the agent can continue. */
export function isSignInNotice(title: string, description?: string): boolean {
	return SIGN_IN_RE.test(`${title}\n${description ?? ''}`);
}

const MACHINE_TOKEN = /^(?:internal error|error_during_execution|error_max_budget_usd|error_max_turns|error_max_structured_output_retries|provider_error|unknown)\.?$/i;

const ERROR_KIND_LABEL: Record<string, string> = {
	rate_limit: 'Usage limit reached',
	billing_error: 'Usage limit reached',
	account_on_hold: 'Usage limit reached',
	quota_exhausted: 'Usage limit reached',
	budget_exhausted: 'Usage limit reached',
	overloaded: 'The model provider is temporarily overloaded',
	authentication_failed: 'Sign in to continue',
	oauth_org_not_allowed: 'Sign in to continue',
	auth_required: 'Sign in to continue',
};

/**
 * Codes agents put in a failed prompt's `error.data` when the account is out of quota: OpenCode 2's
 * `errorName`, codex-acp's `codexErrorInfo`, claude-agent-acp's `errorKind`.
 */
const QUOTA_CODES = new Set(['provider.quota', 'usageLimitExceeded', 'usage_limit_exceeded', 'rate_limit', 'billing_error', 'quota_exhausted']);

function isQuotaData(data: unknown): boolean {
	const record = asRecord(data);
	return !!record && [record.errorName, record.codexErrorInfo, record.errorKind].some(code => typeof code === 'string' && QUOTA_CODES.has(code));
}

/** JSON-RPC `error.message` is often "Internal error" while the sentence the CLI shows sits in the suffix or in `data`. */
export function acpRpcErrorMessage(error: { message?: string; data?: unknown } | undefined): string {
	const raw = typeof error?.message === 'string' ? error.message.trim() : '';
	const stripped = raw.replace(/^(?:internal error|authentication required|request cancelled):\s*/i, '').trim();
	const detail = humanDetail(error?.data, 0);
	let message = raw || 'ACP error';
	if (stripped && !MACHINE_TOKEN.test(stripped) && !/^internal error\.?$/i.test(stripped)) {
		message = stripped;
	} else if (detail) {
		message = detail;
	}
	// The agent said in its error code that the quota is out, in words the limit detector may not know
	// ("Insufficient balance"): say it, so the chat parks at the limit instead of failing.
	return isQuotaData(error?.data) && !LIMIT_FAMILY.test(message) ? `Usage limit reached: ${message}` : message;
}

export function noticesFromAcpPayload(payload: unknown, options?: IAcpNoticeOptions): IAcpNotice[] {
	const record = asRecord(payload);
	if (!record) {
		return [];
	}
	const update = asRecord(record.update) ?? record;
	return noticesFromAcpUpdate(update, options);
}

export function noticesFromAcpUpdate(update: Record<string, unknown>, options?: IAcpNoticeOptions): IAcpNotice[] {
	const notices: IAcpNotice[] = [];
	const kind = String(update.sessionUpdate ?? update.type ?? '');
	if (kind === 'notice') {
		const title = readString(update.title);
		if (title) {
			notices.push(notice(readSeverity(update.severity, title), title, readString(update.description)));
		}
	}
	const failure = sessionFailureNotice(update._meta);
	if (failure) {
		notices.push(failure);
	}
	const limit = rateLimitNotice(update._meta, options);
	if (limit) {
		notices.push(limit);
	}
	const retry = openCodeRetryNotice(update._meta, options);
	if (retry) {
		notices.push(retry);
	}
	if (!HANDLED_UPDATES.has(kind)) {
		const loose = looseStatusNotice(update);
		if (loose) {
			notices.push(loose);
		}
	}
	return dedupe(notices);
}

export function sameProviderNotice(a: string, b: string): boolean {
	const left = a.trim().toLowerCase();
	const right = b.trim().toLowerCase();
	if (!left || !right) {
		return false;
	}
	if (left === right || left.includes(right) || right.includes(left)) {
		return true;
	}
	return LIMIT_FAMILY.test(left) && LIMIT_FAMILY.test(right);
}

function sessionFailureNotice(meta: unknown): IAcpNotice | undefined {
	const jetbrains = asRecord(asRecord(meta)?.jetbrains);
	const air = asRecord(jetbrains?.air);
	const failure = asRecord(air?.sessionFailure);
	const title = failure ? readString(failure.title) : undefined;
	if (!failure || !title) {
		return undefined;
	}
	return notice(readSeverity(failure.severity, title), title, readString(failure.details) ?? readString(failure.description));
}

function rateLimitNotice(meta: unknown, options?: IAcpNoticeOptions): IAcpNotice | undefined {
	const record = asRecord(meta);
	if (!record) {
		return undefined;
	}
	const info = asRecord(record['_claude/rateLimit'])
		?? asRecord(record.rateLimit)
		?? asRecord(record.rate_limit)
		?? asRecord(record.rate_limit_info);
	if (!info) {
		return undefined;
	}
	const status = readString(info.status)?.toLowerCase();
	const message = readString(info.message) ?? readString(info.title);
	// The exact reset, for limit recovery; only a refusal parks the chat.
	const resetAt = status === 'rejected' ? resetEpoch(info.resetsAt ?? info.resets_at) : undefined;
	const reading = rateLimitReading(info, status);
	if (message) {
		if (status === 'allowed' && !LIMIT_FAMILY.test(message)) {
			return undefined;
		}
		const severity: AcpNoticeSeverity = status === 'rejected' || LIMIT_FAMILY.test(message) ? 'error' : 'warning';
		return withReading(withReset(notice(severity, message, readString(info.description)), resetAt), reading);
	}
	if (status !== 'rejected' && status !== 'allowed_warning') {
		return undefined;
	}
	const resets = formatReset(info.resetsAt ?? info.resets_at, options);
	// Claude's `utilization` is a share (0.82); the CLI floors it to a percent the same way.
	const used = reading?.utilization !== undefined ? `${Math.floor(reading.utilization * 100)}% used` : undefined;
	const head = status === 'rejected' ? 'Usage limit reached' : 'Usage limit warning';
	const title = [head, used, resets ? `resets ${resets}` : undefined].filter(Boolean).join(' · ');
	return withReading(withReset(notice(status === 'rejected' ? 'error' : 'warning', title), resetAt), reading);
}

/** Claude's `rate_limit_info`, kept beside the notice so the chat can show a warning once per window. */
function rateLimitReading(info: Record<string, unknown>, status: string | undefined): IVoltRateLimitReading | undefined {
	if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') {
		return undefined;
	}
	const window = readString(info.rateLimitType) ?? readString(info.rate_limit_type);
	const resetsAt = resetEpoch(info.resetsAt ?? info.resets_at);
	const utilization = readShare(info.utilization);
	const threshold = readShare(info.surpassedThreshold ?? info.surpassed_threshold);
	return {
		status,
		...(window ? { window } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
		...(utilization !== undefined ? { utilization } : {}),
		...(threshold !== undefined ? { threshold } : {}),
	};
}

/** A 0-1 share; a figure over 1.5 is taken as a percent already. */
function readShare(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	if (!Number.isFinite(n) || n < 0) {
		return undefined;
	}
	return n > 1.5 ? n / 100 : n;
}

function withReading(value: IAcpNotice, reading: IVoltRateLimitReading | undefined): IAcpNotice {
	return reading ? { ...value, rateLimit: reading } : value;
}

/**
 * OpenCode 2 waits between retries of a failed provider call and says so in
 * `_meta["opencode/retry"] = { attempt, nextRetryAt, error: { type, message } }` (null when it
 * retries). A warning: OpenCode retries by itself; a quota it gives up on fails the prompt.
 */
function openCodeRetryNotice(meta: unknown, options?: IAcpNoticeOptions): IAcpNotice | undefined {
	const retry = asRecord(asRecord(meta)?.['opencode/retry']);
	if (!retry) {
		return undefined;
	}
	const error = asRecord(retry.error);
	const type = readString(error?.type);
	const message = readString(error?.message);
	const next = typeof retry.nextRetryAt === 'string' ? Date.parse(retry.nextRetryAt) : NaN;
	const when = Number.isFinite(next) ? formatReset(next, options) : undefined;
	const title = type === 'provider.rate-limit' ? 'Rate limited by the provider' : 'The provider call failed';
	const attempt = typeof retry.attempt === 'number' ? ` (attempt ${retry.attempt})` : '';
	return notice('warning', `${title} · retrying${when ? ` at ${when}` : ''}${attempt}`, message);
}

function withReset(value: IAcpNotice, resetAt: number | undefined): IAcpNotice {
	return resetAt !== undefined ? { ...value, resetAt } : value;
}

function resetEpoch(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : undefined;
}

function looseStatusNotice(update: Record<string, unknown>): IAcpNotice | undefined {
	const title = readString(update.message) ?? readString(update.statusText);
	if (!title || title.length > 400 || title.startsWith('{') || title.startsWith('[')) {
		return undefined;
	}
	if (!LIMIT_FAMILY.test(title) && !/\b(overloaded|sign in to|retrying|reconnecting)\b/i.test(title) && (update.severity === undefined || update.severity === null)) {
		return undefined;
	}
	return notice(readSeverity(update.severity, title), title, readString(update.description) ?? readString(update.details));
}

function notice(severity: AcpNoticeSeverity, title: string, description?: string): IAcpNotice {
	const trimmed = description?.trim();
	return trimmed ? { severity, title, description: trimmed } : { severity, title };
}

function readSeverity(value: unknown, title: string): AcpNoticeSeverity {
	if (value === 'info' || value === 'warning' || value === 'error') {
		return value;
	}
	return LIMIT_FAMILY.test(title) ? 'error' : 'warning';
}

function formatReset(value: unknown, options?: IAcpNoticeOptions): string | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	if (!Number.isFinite(n) || n <= 0) {
		return undefined;
	}
	const ms = n > 1e12 ? n : n * 1000;
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) {
		return undefined;
	}
	// A weekly window can reset days from now: "resets 5:00 PM" alone would read as today.
	const day = (at: Date) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: options?.timeZone }).format(at);
	const otherDay = day(date) !== day(new Date(options?.now ?? Date.now()));
	return new Intl.DateTimeFormat(options?.locale, {
		...(otherDay ? { weekday: 'short' } : {}),
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
		timeZone: options?.timeZone,
	}).format(date);
}

function humanDetail(data: unknown, depth: number): string | undefined {
	if (depth > 3) {
		return undefined;
	}
	if (typeof data === 'string') {
		const text = data.trim();
		return text && !MACHINE_TOKEN.test(text) ? text : undefined;
	}
	const record = asRecord(data);
	if (!record) {
		return undefined;
	}
	for (const key of ['message', 'title', 'detail', 'details', 'result', 'error']) {
		const value = record[key];
		if (typeof value === 'string') {
			const text = value.trim();
			if (text && !MACHINE_TOKEN.test(text)) {
				return text;
			}
		} else if (value && typeof value === 'object') {
			const nested = humanDetail(value, depth + 1);
			if (nested) {
				return nested;
			}
		}
	}
	const kind = readString(record.errorKind);
	return kind ? ERROR_KIND_LABEL[kind] : undefined;
}

function dedupe(notices: readonly IAcpNotice[]): IAcpNotice[] {
	const kept: IAcpNotice[] = [];
	for (const item of notices) {
		const match = kept.findIndex(existing => sameProviderNotice(existing.title, item.title));
		if (match < 0) {
			kept.push(item);
			continue;
		}
		const longer = item.title.length > kept[match].title.length ? item : kept[match];
		// The wording comes from the longer notice; a reset time and a reading from either.
		kept[match] = withReading(withReset(longer, longer.resetAt ?? item.resetAt ?? kept[match].resetAt), longer.rateLimit ?? item.rateLimit ?? kept[match].rateLimit);
	}
	return kept;
}

function readString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
