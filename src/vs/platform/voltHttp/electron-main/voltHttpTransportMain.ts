/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as electron from 'electron';
import type * as http from 'http';
import { Readable } from 'stream';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestContext, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import { IRawRequestFunction, RequestService as NodeRequestService } from '../../request/node/requestService.js';

/** The parts of Electron's `net.request` the transport relies on beyond Node's `http.request`. */
export interface INetClientRequest {
	on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string, responseHeaders: Record<string, string[]>) => void): unknown;
	abort(): void;
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

	override request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		const { type, url, user, password, headers, timeout, data, followRedirects, disableCache } = options;
		const raw = followRedirects === 0 ? withoutRedirects(this.netRequest()) : this.netRequest() as unknown as IRawRequestFunction;
		return super.request({ type, url, user, password, headers, timeout, data, followRedirects, disableCache, getRawRequest: () => raw, isChromiumNetwork: true }, token);
	}
}
