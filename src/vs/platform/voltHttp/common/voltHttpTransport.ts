/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestContext, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** The main process channel the desktop window's HTTP client sends through (VS Code's `RequestChannel` protocol). */
export const VOLT_HTTP_TRANSPORT_CHANNEL_NAME = 'voltHttpTransport';

export const IVoltHttpTransport = createDecorator<IVoltHttpTransport>('voltHttpTransport');

/**
 * How the HTTP client's requests (the user's from the request editor, agents' through `ide http`)
 * leave Volt. In the desktop app they go out from the main process, so no CORS check applies, every
 * response header comes back and no `Origin` is added; in the web workbench through the window's
 * request service. A sandboxed chat's request is judged before it gets here.
 */
/** `dataBase64`: the body as bytes (a multipart or file body), sent instead of `data`. */
export interface IVoltHttpRequestOptions extends IRequestOptions {
	readonly dataBase64?: string;
	/**
	 * A redirect is the response (its status and `location`) whatever `followRedirects` says: the
	 * client follows hop by hop itself. The web workbench's transport cannot do this (its fetch
	 * hides a redirect it does not follow) and follows as `followRedirects` says.
	 */
	readonly manualRedirects?: boolean;
	/** What the network stack answers a server's authentication challenge with (NTLM). Chromium's stack only. */
	readonly credentials?: IVoltHttpCredentials;
	/**
	 * Send through Node's own `http`/`https`/`http2` instead of Chromium's stack: what a request
	 * needs when it sets TLS or protocol options, which Chromium takes for the whole app only.
	 * A request sent this way does not use the user's proxy settings and never follows a redirect.
	 */
	readonly node?: IVoltHttpNodeOptions;
}

export interface IVoltHttpCredentials {
	readonly username: string;
	readonly password: string;
	readonly domain?: string;
}

export type VoltHttpTlsProtocol = 'TLSv1' | 'TLSv1_1' | 'TLSv1_2' | 'TLSv1_3';

export interface IVoltHttpNodeOptions {
	/** Verify the server's certificate; on when absent. */
	readonly rejectUnauthorized?: boolean;
	/** `auto` (absent): HTTP/2 when the server offers it over TLS, else HTTP/1.1. */
	readonly httpVersion?: 'http1' | 'http2';
	readonly disabledProtocols?: readonly VoltHttpTlsProtocol[];
	/** OpenSSL cipher names, in order. */
	readonly ciphers?: readonly string[];
	readonly honorCipherOrder?: boolean;
	/** Accept responses with invalid HTTP headers (HTTP/1.x only). */
	readonly insecureHTTPParser?: boolean;
}

/**
 * The key under which a response's headers carry the protocol version the stack negotiated
 * (`1.1`, `2`): no HTTP header can have this name, and `IRequestContext` has no field for it.
 */
export const VOLT_HTTP_VERSION_HEADER = ':volt-http-version';

export interface IVoltHttpTransport {
	readonly _serviceBrand: undefined;
	/** `followRedirects: 0` or `manualRedirects`: a redirect is the response (its status and `location`), never followed. */
	request(options: IVoltHttpRequestOptions, token: CancellationToken): Promise<IRequestContext>;
}
