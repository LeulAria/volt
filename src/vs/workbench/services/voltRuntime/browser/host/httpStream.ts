/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { listenStream } from '../../../../../base/common/stream.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';

export async function requestText(requestService: IRequestService, url: string, init: { type?: string; headers?: Record<string, string>; data?: string }, token: CancellationToken): Promise<{ status: number; text: string }> {
	const ctx = await requestService.request({
		type: init.type ?? 'GET',
		url,
		headers: init.headers,
		data: init.data,
	}, token);
	const text = (await streamToBuffer(ctx.stream)).toString();
	return { status: ctx.res.statusCode ?? 0, text };
}

export async function* requestSseLines(requestService: IRequestService, url: string, init: { type?: string; headers?: Record<string, string>; data?: string }, token: CancellationToken): AsyncIterable<string> {
	const ctx = await requestService.request({
		type: init.type ?? 'POST',
		url,
		headers: init.headers,
		data: init.data,
	}, token);
	const status = ctx.res.statusCode ?? 0;
	if (status < 200 || status >= 300) {
		const body = (await streamToBuffer(ctx.stream)).toString();
		throw new Error(body || `HTTP ${status}`);
	}

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
			if (failed) {
				throw failed;
			}
			continue;
		}
		yield queue.shift()!;
	}
	if (failed) {
		throw failed;
	}
}

export function parseSseData(line: string): string | undefined {
	if (!line.startsWith('data:')) {
		return undefined;
	}
	const data = line.slice(5).trim();
	return data && data !== '[DONE]' ? data : undefined;
}
