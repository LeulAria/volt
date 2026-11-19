/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IVoltHttpLoad, VOLT_HTTP_LOAD_CHANNEL_NAME } from '../../../../platform/voltHttp/common/voltHttpLoad.js';
import { IVoltHttpOAuth, VOLT_HTTP_OAUTH_CHANNEL_NAME } from '../../../../platform/voltHttp/common/voltHttpOAuth.js';
import { IVoltHttpStreams, VOLT_HTTP_STREAMS_CHANNEL_NAME } from '../../../../platform/voltHttp/common/voltHttpStreams.js';
import { IVoltHttpTransport, VOLT_HTTP_TRANSPORT_CHANNEL_NAME } from '../../../../platform/voltHttp/common/voltHttpTransport.js';

/**
 * The desktop app's HTTP client sends from the main process: the window's own fetch would apply the
 * page's CORS check (a local API without CORS headers fails), hide all but the safelisted response
 * headers and add `Origin: vscode-file://vscode-app`.
 */
class MainProcessHttpTransport extends RequestChannelClient implements IVoltHttpTransport {
	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel(VOLT_HTTP_TRANSPORT_CHANNEL_NAME));
	}
}

// Registered after the window's default (voltHttpService.ts, in the common workbench), so this one wins.
registerSingleton(IVoltHttpTransport, MainProcessHttpTransport, InstantiationType.Delayed);

// WebSocket, SSE, Socket.IO, MQTT and gRPC connections are made in the main process too (desktop only).
registerMainProcessRemoteService(IVoltHttpStreams, VOLT_HTTP_STREAMS_CHANNEL_NAME);

// Performance tests generate their load in a worker thread of the main process (desktop only).
registerMainProcessRemoteService(IVoltHttpLoad, VOLT_HTTP_LOAD_CHANNEL_NAME);

// OAuth 2.0's in-app sign-in window is a main-process window (desktop only).
registerMainProcessRemoteService(IVoltHttpOAuth, VOLT_HTTP_OAUTH_CHANNEL_NAME);
