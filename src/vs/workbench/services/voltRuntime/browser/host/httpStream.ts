/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { listenStream } from '../../../../../base/common/stream.js';
import { IRequestContext } from '../../../../../base/parts/request/common/request.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ProviderError, providerErrorFromResponse, providerRetryDelay } from '../../common/providerError.js';

export interface IHttpInit {
	type?: string;
	headers?: Record<string, string>;
	data?: string;
}

/** A pause before another attempt. Providers turn it into a `retry` event so the stall is visible. */
export interface ISseRetry {
	readonly retry: { readonly attempt: number; readonly delayMs: number; readonly message: string };
}

export async function requestText(requestService: IRequestService, url: string, init: IHttpInit, token: CancellationToken): Promise<{ status: number; text: string }> {
	const ctx = await requestService.request({
		type: init.type ?? 'GET',
		url,
		headers: init.headers,
		data: init.data,
	}, token);
	const text = (await streamToBuffer(ctx.stream)).toString();
	return { status: ctx.res.statusCode ?? 0, text };
}

/** Lines of one SSE response. Throws `ProviderError` for a non-2xx status. */
export async function* requestSseLines(requestService: IRequestService, url: string, init: IHttpInit, token: CancellationToken): AsyncIterable<string> {
	const ctx = await openSse(requestService, url, init, token);
	yield* sseLines(ctx, token);
}

/**
 * Like `requestSseLines`, but a retryable failure before the first byte (429, 5xx, 529, a reset
 * socket) is retried with backoff that honours `retry-after`. Once lines flow, errors surface to
 * the caller: replaying a half-streamed answer is the loop's decision, not the transport's.
 */
export async function* requestSseStream(requestService: IRequestService, url: string, init: IHttpInit, token: CancellationToken, maxAttempts = 4): AsyncIterable<string | ISseRetry> {
	let ctx: IRequestContext | undefined;
	for (let attempt = 1; !ctx; attempt++) {
		try {
			ctx = await openSse(requestService, url, init, token);
		} catch (err) {
			const error = err instanceof ProviderError ? err : new ProviderError(err instanceof Error ? err.message : String(err));
			if (!error.retryable || attempt >= maxAttempts || token.isCancellationRequested) {
				throw error;
			}
			const delayMs = providerRetryDelay(attempt, error.retryAfterMs);
			yield { retry: { attempt: attempt + 1, delayMs, message: retryMessage(error, delayMs) } };
			if (!await sleep(delayMs, token)) {
				return;
			}
		}
	}
	yield* sseLines(ctx, token);
}

async function openSse(requestService: IRequestService, url: string, init: IHttpInit, token: CancellationToken): Promise<IRequestContext> {
	const ctx = await requestService.request({
		type: init.type ?? 'POST',
		url,
		headers: init.headers,
		data: init.data,
	}, token);
	const status = ctx.res.statusCode ?? 0;
	if (status < 200 || status >= 300) {
		const body = (await streamToBuffer(ctx.stream)).toString();
		throw providerErrorFromResponse(status, body, ctx.res.headers['retry-after']);
	}
	return ctx;
}

async function* sseLines(ctx: IRequestContext, token: CancellationToken): AsyncIterable<string> {
	let buffer = '';
	const queue: string[] = [];
	let done = false;
	let failed: Error | undefined;
	let notify: (() => void) | undefined;

	listenStream(ctx.stream, {
		onData: chunk => {
			buffer += chunk.toString();
			const parts = buffer.split(/\r?\n/);
			buffer = parts.pop() ?? '';
			for (const line of parts) {
				queue.push(line);
			}
			notify?.();
		},
		onError: err => {
			failed = err instanceof Error ? err : new Error(String(err));
			done = true;
			notify?.();
		},
		onEnd: () => {
			if (buffer) {
				queue.push(buffer);
				buffer = '';
			}
			done = true;
			notify?.();
		}
	}, token);

	while (!done || queue.length) {
		if (!queue.length) {
			await new Promise<void>(resolve => { notify = resolve; });
			notify = undefined;
			if (failed && !queue.length) {
				throw new ProviderError(failed.message);
			}
			continue;
		}
		yield queue.shift()!;
	}
	if (failed) {
		throw new ProviderError(failed.message);
	}
}

function retryMessage(error: ProviderError, delayMs: number): string {
	const seconds = Math.max(1, Math.round(delayMs / 1000));
	const reason = error.status === 429 ? 'Rate limited' : error.status === 529 || /overloaded/i.test(error.message) ? 'Provider overloaded' : 'Provider error';
	return `${reason}. Retrying in ${seconds}s.`;
}

function sleep(ms: number, token: CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		if (token.isCancellationRequested) {
			resolve(false);
			return;
		}
		const listener = token.onCancellationRequested(() => {
			clearTimeout(timer);
			listener.dispose();
			resolve(false);
		});
		const timer = setTimeout(() => {
			listener.dispose();
			resolve(true);
		}, ms);
	});
}

export function parseSseData(line: string): string | undefined {
	if (!line.startsWith('data:')) {
		return undefined;
	}
	const data = line.slice(5).trim();
	return data && data !== '[DONE]' ? data : undefined;
}
