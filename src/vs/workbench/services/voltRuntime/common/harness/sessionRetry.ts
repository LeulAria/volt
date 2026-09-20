/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider-error classifier (OpenCode SessionRetry). Context overflow is never
 * retried - the next step has to compact. Rate limits, 5xx, and transient
 * network errors back off with jitter and honour Retry-After when present.
 */

export type RetryKind = 'retry' | 'overflow' | 'fail';

export interface IRetryPolicy {
	readonly maxAttempts: number;
	readonly classify?: (error: unknown) => RetryKind;
}

export const DEFAULT_RETRY_POLICY: IRetryPolicy = { maxAttempts: 5 };

const OVERFLOW = /context.?length|context.?window|maximum context|too many tokens|prompt is too long|token.?limit|reduce the length/i;
const TRANSIENT = /overloaded|rate.?limit|try again|temporar(?:y|ily)|timeout|timed out|econnreset|etimedout|socket hang up|eai_again|enotfound|429|502|503|529|unavailable/i;
const ACP_DEAD = /ACP process exited|ACP process is not writable|ACP session is not running|ACP client disposed|EPIPE/i;
const ACP_INTERNAL = /^internal error\.?$/i;
const ACP_STALL = /ACP agent produced no activity/i;

export function classifyProviderError(error: unknown): RetryKind {
	const message = errorMessage(error);
	const status = errorStatus(error);
	if (status === 413 || OVERFLOW.test(message)) {
		return 'overflow';
	}
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) {
		return 'retry';
	}
	if (TRANSIENT.test(message) || isAcpTurnRestartable(message)) {
		return 'retry';
	}
	if (errorFlag(error, 'retryable') === true) {
		return 'retry';
	}
	return 'fail';
}

/** Dead or poisoned ACP session - drop the process and retry the turn on a fresh one. */
export function isAcpTurnRestartable(message: string): boolean {
	const trimmed = message.trim();
	return ACP_DEAD.test(trimmed) || ACP_INTERNAL.test(trimmed) || ACP_STALL.test(trimmed);
}

export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs && retryAfterMs > 0) {
		return Math.min(30_000, retryAfterMs);
	}
	const exp = Math.min(30_000, 400 * (2 ** Math.max(0, attempt - 1)));
	const jitter = Math.floor(Math.random() * 200);
	return Math.min(30_000, exp + jitter);
}

export function parseRetryAfter(error: unknown): number | undefined {
	const record = asRecord(error);
	const headers = asRecord(record.headers);
	const raw = headers['retry-after-ms'] ?? headers['retry-after'] ?? record.retryAfterMs ?? record.retryAfter;
	if (typeof raw === 'number' && raw > 0) {
		return raw < 100 ? raw * 1000 : raw;
	}
	if (typeof raw === 'string' && raw.trim()) {
		const asNumber = Number(raw);
		if (Number.isFinite(asNumber) && asNumber > 0) {
			return asNumber < 100 ? asNumber * 1000 : asNumber;
		}
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	const record = asRecord(error);
	return typeof record.message === 'string' ? record.message : typeof record.body === 'string' ? record.body : '';
}

function errorStatus(error: unknown): number | undefined {
	const record = asRecord(error);
	const status = record.status ?? record.statusCode ?? record.code;
	return typeof status === 'number' ? status : undefined;
}

function errorFlag(error: unknown, key: string): unknown {
	return asRecord(error)[key];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
