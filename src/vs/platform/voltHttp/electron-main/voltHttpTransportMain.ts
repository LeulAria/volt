/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as electron from 'electron';
import type * as http from 'http';
import { Readable } from 'stream';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestContext } from '../../../base/parts/request/common/request.js';
import { IVoltHttpCredentials, IVoltHttpRequestOptions, VOLT_HTTP_VERSION_HEADER } from '../common/voltHttpTransport.js';
import { voltHttpNodeRequest } from '../node/voltHttpNode.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import { IRawRequestFunction, RequestService as NodeRequestService } from '../../request/node/requestService.js';

/** The parts of Electron's `net.request` the transport relies on beyond Node's `http.request`. */
export interface INetClientRequest {
	on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string, responseHeaders: Record<string, string[]>) => void): unknown;
	/** The server (or a proxy) asks for credentials; `callback()` with none gives up, and the 401 is the response. */
	on(event: 'login', listener: (authInfo: { readonly isProxy: boolean }, callback: (username?: string, password?: string) => void) => void): unknown;
	abort(): void;
	write?(chunk: Buffer): unknown;
}

/** `net.request(options, onResponse)`, with Electron's `redirect` mode. */
export type NetRequestFunction = (options: http.RequestOptions & { readonly redirect?: 'follow' | 'error' | 'manual' }, callback?: (res: http.IncomingMessage) => void) => INetClientRequest;

/**
 * Electron's `net.request` follows redirects itself, so `nodeRequest`'s `followRedirects` never sees
 * one. A request that may not follow one (a sandboxed chat's send) asks for `redirect: 'manual'`,
 * and the redirect comes back as the response: its status and headers (`location`), no body.
 * Nothing is sent to the location.
 */
export function withoutRedirects(netRequest: NetRequestFunction): IRawRequestFunction {
	const raw = (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
		const request = netRequest({ ...options, redirect: 'manual' }, callback);
		request.on('redirect', (statusCode, _method, _redirectUrl, responseHeaders) => {
			const headers: Record<string, string | string[]> = {};
			for (const [key, values] of Object.entries(responseHeaders)) {
				headers[key.toLowerCase()] = values.length === 1 ? values[0] : values;
			}
			callback?.(Object.assign(Readable.from([]), { statusCode, headers }) as unknown as http.IncomingMessage);
			// Handled without `followRedirect()`: Electron cancels the redirect; this ends the request.
			request.abort();
		});
		return request;
	};
	return raw as unknown as IRawRequestFunction;
}

/**
 * Answers the server's authentication challenge (NTLM, Negotiate) with the request's credentials,
 * once: asked again, the credentials were refused, and the 401 is the response. A proxy's
 * challenge is not answered with them.
 */
export function withCredentials(netRequest: NetRequestFunction, credentials: IVoltHttpCredentials): NetRequestFunction {
	return (options, callback) => {
		const request = netRequest(options, callback);
		let answered = false;
		request.on('login', (authInfo, respond) => {
			if (authInfo.isProxy || answered) {
				respond();
				return;
			}
			answered = true;
			respond(credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username, credentials.password);
		});
		return request;
	};
}

/**
 * The HTTP client's transport in the main process (`VOLT_HTTP_TRANSPORT_CHANNEL_NAME`): Chromium's
 * network stack with the user's proxy settings and the system's certificates, like VS Code's own
 * requests from here, but outside any page, so no CORS check applies, every response header comes
 * back and no `Origin` is added. Only a request's own fields cross from the window.
 */
export class VoltHttpTransportMainService extends NodeRequestService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@ILogService logService: ILogService,
	) {
		super('local', configurationService, environmentService, logService);
	}

	/** Electron's `net.request` (a stand-in in tests: Electron's `net` is the main process's alone). */
	protected netRequest(): NetRequestFunction {
		return electron.net.request as unknown as NetRequestFunction;
	}

	override request(options: IVoltHttpRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		if (options.node) {
			// TLS and protocol options are Chromium's for the whole app: a request that sets its own goes through Node.
			return voltHttpNodeRequest(options, token);
		}
		const { type, url, user, password, headers, timeout, disableCache } = options;
		const net = options.credentials ? withCredentials(this.netRequest(), options.credentials) : this.netRequest();
		const followRedirects = options.manualRedirects ? 0 : options.followRedirects;
		let raw = followRedirects === 0 ? withoutRedirects(net) : net as unknown as IRawRequestFunction;
		let data = options.data;
		if (options.dataBase64 !== undefined) {
			// A body of bytes (multipart, a file): the request service writes strings only, so it is written here, as the request is made.
			const bytes = Buffer.from(options.dataBase64, 'base64');
			const inner = raw as unknown as NetRequestFunction;
			raw = ((requestOptions: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
				const request = inner(requestOptions, callback);
				request.write?.(bytes);
				return request;
			}) as unknown as IRawRequestFunction;
			data = undefined;
		}
		return super.request({ type, url, user, password, headers, timeout, data, followRedirects, disableCache, getRawRequest: () => raw, isChromiumNetwork: true }, token).then(context => {
			// Electron's response tells the version it came over; only headers and status cross to the window.
			const version = (context.res as { readonly httpVersion?: unknown }).httpVersion;
			return typeof version === 'string' && version ? { res: { statusCode: context.res.statusCode, headers: { ...context.res.headers, [VOLT_HTTP_VERSION_HEADER]: version.replace(/\.0$/, '') } }, stream: context.stream } : context;
		});
	}
}
