/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A provider refused a request or failed mid-stream. `retryable` is decided here once, from the
 * HTTP status and the provider's error type, so the transport and the loop agree on it.
 */
export class ProviderError extends Error {

	readonly retryable: boolean;
	/** The prompt no longer fits the model's window; compaction, not a retry, is the fix. */
	readonly overflow: boolean;

	constructor(
		message: string,
		readonly status?: number,
		readonly errorType?: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = 'ProviderError';
		this.overflow = isOverflow(status, errorType, message);
		this.retryable = !this.overflow && isRetryable(status, errorType, message);
	}
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const RETRY_TYPES = /^(?:overloaded_error|rate_limit_error|api_error|timeout_error|server_error|internal_server_error|service_unavailable)$/i;
const RETRY_TEXT = /overloaded|rate.?limit|try again|temporar(?:y|ily)|timed? ?out|econnreset|etimedout|socket hang up|eai_again|network|unavailable/i;
const OVERFLOW_TEXT = /prompt is too long|context.?(?:length|window)|maximum context|too many tokens|input is too long|exceeds? the (?:context|token)/i;

function isRetryable(status: number | undefined, errorType: string | undefined, message: string): boolean {
	if (status !== undefined && RETRY_STATUS.has(status)) {
		return true;
	}
	if (errorType && RETRY_TYPES.test(errorType)) {
		return true;
	}
	return status === undefined && RETRY_TEXT.test(message);
}

function isOverflow(status: number | undefined, errorType: string | undefined, message: string): boolean {
	return status === 413 || errorType === 'request_too_large' || OVERFLOW_TEXT.test(message);
}

/** Builds the error from a non-2xx response body, pulling the provider's own message out of JSON. */
export function providerErrorFromResponse(status: number, body: string, retryAfter?: string | string[]): ProviderError {
	let type: string | undefined;
	let message = body.trim();
	try {
		const parsed = JSON.parse(body) as { error?: { type?: string; message?: string; code?: string | number } | string; message?: string; type?: string };
		const error = typeof parsed.error === 'object' && parsed.error ? parsed.error : undefined;
		type = error?.type ?? (typeof error?.code === 'string' ? error.code : undefined) ?? parsed.type;
		message = error?.message ?? (typeof parsed.error === 'string' ? parsed.error : undefined) ?? parsed.message ?? message;
	} catch {
		// Plain text body.
	}
	const text = `${status}${type ? ` ${type}` : ''}: ${message || 'request failed'}`;
	return new ProviderError(text, status, type, parseRetryAfterHeader(retryAfter));
}

/** `retry-after` is seconds or an HTTP date. */
export function parseRetryAfterHeader(value: string | string[] | undefined): number | undefined {
	const raw = Array.isArray(value) ? value[0] : value;
	if (!raw) {
		return undefined;
	}
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}
	const date = Date.parse(raw);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Exponential backoff with jitter, honouring the server's hint, capped at 30 s. */
export function providerRetryDelay(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs !== undefined && retryAfterMs > 0) {
		return Math.min(30_000, retryAfterMs);
	}
	const base = Math.min(20_000, 500 * (2 ** Math.max(0, attempt - 1)));
	return base + Math.floor(Math.random() * 250);
}
