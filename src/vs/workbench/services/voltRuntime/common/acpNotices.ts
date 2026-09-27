/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider status that arrives beside the assistant transcript: ACP notices,
 * session-failure titles, and rate-limit payloads. The chat shows these
 * instead of treating the turn as empty or as a dead process.
 */

export type AcpNoticeSeverity = 'info' | 'warning' | 'error';

export interface IAcpNotice {
	readonly severity: AcpNoticeSeverity;
	readonly title: string;
	readonly description?: string;
}

export interface IAcpNoticeOptions {
	readonly timeZone?: string;
	readonly locale?: string;
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
]);

const LIMIT_FAMILY = /\b(spend limit|usage limit|rate limit|quota|session limit|hit your)\b/i;

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

/** JSON-RPC `error.message` is often "Internal error" while the sentence the CLI shows sits in the suffix or in `data`. */
export function acpRpcErrorMessage(error: { message?: string; data?: unknown } | undefined): string {
	const raw = typeof error?.message === 'string' ? error.message.trim() : '';
	const stripped = raw.replace(/^(?:internal error|authentication required|request cancelled):\s*/i, '').trim();
	const detail = humanDetail(error?.data, 0);
	if (stripped && !MACHINE_TOKEN.test(stripped) && !/^internal error\.?$/i.test(stripped)) {
		return stripped;
	}
	if (detail) {
		return detail;
	}
	return raw || 'ACP error';
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
	if (message) {
		if (status === 'allowed' && !LIMIT_FAMILY.test(message)) {
			return undefined;
		}
		const severity: AcpNoticeSeverity = status === 'rejected' || LIMIT_FAMILY.test(message) ? 'error' : 'warning';
		return notice(severity, message, readString(info.description));
	}
	if (status !== 'rejected' && status !== 'allowed_warning') {
		return undefined;
	}
	const resets = formatReset(info.resetsAt ?? info.resets_at, options);
	const title = status === 'rejected'
		? (resets ? `Usage limit reached · resets ${resets}` : 'Usage limit reached')
		: (resets ? `Usage limit warning · resets ${resets}` : 'Usage limit warning');
	return notice(status === 'rejected' ? 'error' : 'warning', title);
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
	return new Intl.DateTimeFormat(options?.locale, {
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
		if (item.title.length > kept[match].title.length) {
			kept[match] = item;
		}
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
