/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { AgentServerProtocol, IAgentServerCallContext } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IVoltCloudTaskInput } from '../../../platform/voltRelay/common/voltRelay.js';
import { VoltRelayService } from '../../../platform/voltRelay/node/voltRelayService.js';

/**
 * The relay connection lives here while agents run in the server: webhook deliveries (held by the
 * relay while nothing was connected, or posted to the local URL) run with no Volt window open. The
 * windows pair, read the state and make cloud tasks through these methods; only Volt on this
 * computer may, since they act with this device's relay token.
 */
export class ServerRelay extends Disposable {

	constructor(protocol: AgentServerProtocol, relay: VoltRelayService) {
		super();
		const ownerOnly = (ctx: IAgentServerCallContext) => {
			if (ctx.client.role !== 'owner') {
				throw Object.assign(new Error('Only Volt on this computer can use the relay.'), { code: 'Forbidden' });
			}
		};
		const text = (value: unknown) => typeof value === 'string' ? value : String(value ?? '');
		this._register(relay.onDidChangeState(state => protocol.publish('server', toWire({ kind: 'relay.state', state }))));
		this._register(relay.onDidEvent(event => protocol.publish('server', toWire({ kind: 'relay.event', event }))));
		this._register(protocol.registerMethods('relay', {
			getState: ctx => {
				ownerOnly(ctx);
				return relay.getState().then(toWire);
			},
			connect: (ctx, link, deviceName) => {
				ownerOnly(ctx);
				return relay.connect(text(link), typeof deviceName === 'string' ? deviceName : undefined).then(toWire);
			},
			disconnect: ctx => {
				ownerOnly(ctx);
				return relay.disconnect();
			},
			request: (ctx, method, path, body) => {
				ownerOnly(ctx);
				return relay.request(text(method), text(path), body).then(toWire);
			},
			createCloudTask: (ctx, input) => {
				ownerOnly(ctx);
				return relay.createCloudTask(input as IVoltCloudTaskInput).then(toWire);
			},
			fetchCloudResult: (ctx, taskId, repoRoot) => {
				ownerOnly(ctx);
				return relay.fetchCloudResult(text(taskId), text(repoRoot)).then(toWire);
			},
			readBlobText: (ctx, blobId, maxBytes) => {
				ownerOnly(ctx);
				return relay.readBlobText(text(blobId), typeof maxBytes === 'number' ? maxBytes : 1_000_000);
			},
		}));
	}
}
