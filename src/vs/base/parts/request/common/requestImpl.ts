/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bufferToStream, newWriteableBufferStream, VSBuffer, VSBufferWriteableStream } from '../../../common/buffer.js';
import { CancellationToken } from '../../../common/cancellation.js';
import { canceled } from '../../../common/errors.js';
import { IHeaders, IRequestContext, IRequestOptions, OfflineError } from './request.js';

export async function request(options: IRequestOptions, token: CancellationToken, isOnline?: () => boolean): Promise<IRequestContext> {
	if (token.isCancellationRequested) {
		throw canceled();
	}

	const cancellation = new AbortController();
	const disposable = token.onCancellationRequested(() => cancellation.abort());
	const signal = options.timeout ? AbortSignal.any([
		cancellation.signal,
		AbortSignal.timeout(options.timeout),
	]) : cancellation.signal;

	// Once the body streams, the pump owns the cancellation listener so a cancel still aborts mid-body.
	let streaming = false;
	try {
		const fetchInit: RequestInit = {
			method: options.type || 'GET',
			headers: getRequestHeaders(options),
			body: options.data,
			signal
		};
		if (options.disableCache) {
			fetchInit.cache = 'no-store';
		}
		const res = await fetch(options.url || '', fetchInit);
		const head = {
			statusCode: res.status,
			headers: getResponseHeaders(res),
		};
		if (!res.body) {
			return { res: head, stream: bufferToStream(VSBuffer.wrap(new Uint8Array(await res.arrayBuffer()))) };
		}
		// Hand each chunk on as it arrives: a streamed (SSE) answer must not wait for the whole body.
		const stream = newWriteableBufferStream();
		streaming = true;
		void pumpBody(res.body, stream, options, isOnline).finally(() => disposable.dispose());
		return { res: head, stream };
	} catch (err) {
		throw requestError(err, options, isOnline);
	} finally {
		if (!streaming) {
			disposable.dispose();
		}
	}
}

async function pumpBody(body: NonNullable<Response['body']>, stream: VSBufferWriteableStream, options: IRequestOptions, isOnline?: () => boolean): Promise<void> {
	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value?.byteLength) {
				await stream.write(VSBuffer.wrap(value));
			}
		}
	} catch (err) {
		const error = requestError(err, options, isOnline);
		stream.error(error instanceof Error ? error : new Error(String(error)));
	} finally {
		reader.releaseLock();
		stream.end();
	}
}

function requestError(err: unknown, options: IRequestOptions, isOnline?: () => boolean): unknown {
	if (isOnline && !isOnline()) {
		return new OfflineError();
	}
	const name = (err as { readonly name?: unknown } | null | undefined)?.name;
	if (name === 'AbortError') {
		return canceled();
	}
	if (name === 'TimeoutError') {
		return new Error(`Fetch timeout: ${options.timeout}ms`);
	}
	return err;
}

function getRequestHeaders(options: IRequestOptions) {
	if (options.headers || options.user || options.password || options.proxyAuthorization) {
		const headers = new Headers();
		outer: for (const k in options.headers) {
			switch (k.toLowerCase()) {
				case 'user-agent':
				case 'accept-encoding':
				case 'content-length':
					// unsafe headers
					continue outer;
			}
			const header = options.headers[k];
			if (typeof header === 'string') {
				headers.set(k, header);
			} else if (Array.isArray(header)) {
				for (const h of header) {
					headers.append(k, h);
				}
			}
		}
		if (options.user || options.password) {
			headers.set('Authorization', 'Basic ' + btoa(`${options.user || ''}:${options.password || ''}`));
		}
		if (options.proxyAuthorization) {
			headers.set('Proxy-Authorization', options.proxyAuthorization);
		}
		return headers;
	}
	return undefined;
}

function getResponseHeaders(res: Response): IHeaders {
	const headers: IHeaders = Object.create(null);
	res.headers.forEach((value, key) => {
		if (headers[key]) {
			if (Array.isArray(headers[key])) {
				headers[key].push(value);
			} else {
				headers[key] = [headers[key], value];
			}
		} else {
			headers[key] = value;
		}
	});
	return headers;
}
