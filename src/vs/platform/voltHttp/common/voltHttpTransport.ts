/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const VOLT_HTTP_TRANSPORT_CHANNEL_NAME = 'voltHttpTransport';

export const IVoltHttpTransport = createDecorator<IVoltHttpTransport>('voltHttpTransport');

export interface IVoltHttpTransportRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs: number;
	/** At most this many characters of the body come back; `size` is the whole body's bytes. */
	readonly maxBodyChars: number;
}

export interface IVoltHttpTransportResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly size: number;
	readonly error?: undefined;
}

export interface IVoltHttpTransportError {
	readonly error: string;
}

/**
 * Sends the HTTP client's requests. On the desktop the main process sends them: a window's own
 * fetch is a page's, and CORS refused every local API that sends no Access-Control-Allow-Origin
 * ("Failed to fetch" for a plain GET to a dev server, 2026-11-12 IDE round 2). Elsewhere the
 * window's request service does.
 */
export interface IVoltHttpTransport {
	readonly _serviceBrand: undefined;
	send(request: IVoltHttpTransportRequest): Promise<IVoltHttpTransportResponse | IVoltHttpTransportError>;
}
