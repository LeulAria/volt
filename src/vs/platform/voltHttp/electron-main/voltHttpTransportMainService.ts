/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { IVoltHttpTransport, IVoltHttpTransportError, IVoltHttpTransportRequest, IVoltHttpTransportResponse } from '../common/voltHttpTransport.js';

/** The HTTP client's requests over Electron's network stack (the system proxy and certificates), with no CORS. */
export class VoltHttpTransportMainService implements IVoltHttpTransport {

	declare readonly _serviceBrand: undefined;

	async send(request: IVoltHttpTransportRequest): Promise<IVoltHttpTransportResponse | IVoltHttpTransportError> {
		try {
			const response = await net.fetch(request.url, {
				method: request.method,
				headers: { ...request.headers },
				...(request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD' ? { body: request.body } : {}),
				redirect: 'follow',
				cache: 'no-store',
				signal: AbortSignal.timeout(Math.max(1, request.timeoutMs)),
			});
			const bytes = new Uint8Array(await response.arrayBuffer());
			const text = new TextDecoder().decode(bytes);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => headers[key] = value);
			return {
				status: response.status,
				headers,
				body: text.length > request.maxBodyChars ? text.slice(0, request.maxBodyChars) : text,
				size: bytes.byteLength,
			};
		} catch (err) {
			const timedOut = err instanceof Error && err.name === 'TimeoutError';
			return { error: timedOut ? `Timed out after ${request.timeoutMs} ms.` : err instanceof Error ? err.message : String(err) };
		}
	}
}
