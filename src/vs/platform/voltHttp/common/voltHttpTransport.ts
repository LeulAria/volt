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
export interface IVoltHttpTransport {
	readonly _serviceBrand: undefined;
	/** `followRedirects: 0`: a redirect is the response (its status and `location`), never followed. */
	request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext>;
}
