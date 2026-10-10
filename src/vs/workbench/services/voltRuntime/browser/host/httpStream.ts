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

/**
 * Lines of a body that arrives chunk by chunk. Only the new chunk is scanned for line breaks (the
 * unfinished tail is carried over), and bytes are decoded in stream mode so a multi-byte character
 * split across two chunks stays whole.
 */
async function* sseLines(ctx: IRequestContext, token: CancellationToken): AsyncIterable<string> {
	const decoder = new TextDecoder();
	let partial = '';
	const queue: string[] = [];
	let done = false;
	let failed: Error | undefined;
	let notify: (() => void) | undefined;

	const take = (text: string) => {
		let start = 0;
		let newline = text.indexOf('\n');
		while (newline !== -1) {
			let line = partial + text.slice(start, newline);
			partial = '';
			if (line.endsWith('\r')) {
				line = line.slice(0, -1);
			}
			queue.push(line);
			start = newline + 1;
			newline = text.indexOf('\n', start);
		}
		partial += start ? text.slice(start) : text;
	};

	// The stream stops reporting once cancelled; wake the reader so it does not wait forever.
	const cancelled = token.onCancellationRequested(() => {
		done = true;
		notify?.();
	});

	listenStream(ctx.stream, {
		onData: chunk => {
			take(decoder.decode(chunk.buffer, { stream: true }));
			notify?.();
		},
		onError: err => {
			failed = err instanceof Error ? err : new Error(String(err));
			done = true;
			notify?.();
		},
		onEnd: () => {
			take(decoder.decode());
			if (partial) {
				queue.push(partial.endsWith('\r') ? partial.slice(0, -1) : partial);
				partial = '';
			}
			done = true;
			notify?.();
		}
	}, token);

	try {
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
		if (token.isCancellationRequested) {
			// A blank line (an SSE event separator) lets the provider see the cancellation and finish as aborted.
			yield '';
			return;
		}
		if (failed) {
			throw new ProviderError(failed.message);
		}
	} finally {
		cancelled.dispose();
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
