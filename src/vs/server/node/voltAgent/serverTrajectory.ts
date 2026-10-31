/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { syncTrajectory } from '../../../workbench/services/voltRuntime/common/harness/trajectory.js';
import { IVoltTrajectoryService, IVoltTrajectorySyncResult } from '../../../workbench/services/voltRuntime/common/trajectory.js';

/**
 * The runs record their model requests here, in the server; a window's Trajectory panel reads them
 * through these methods and is told (`trajectory.changed` on the `server` topic) when a chat grew.
 */
export class ServerTrajectory extends Disposable {

	constructor(
		protocol: AgentServerProtocol,
		@IVoltTrajectoryService trajectory: IVoltTrajectoryService,
	) {
		super();
		this._register(trajectory.onDidChange(sessionId => protocol.publish('server', { kind: 'trajectory.changed', sessionId })));
		this._register(protocol.registerMethods('trajectory', {
			chats: () => toWire(trajectory.chats()),
			sync: (_ctx, sessionId, known) => {
				const result: IVoltTrajectorySyncResult = {
					...syncTrajectory(trajectory.requests(String(sessionId)), known && typeof known === 'object' && !Array.isArray(known) ? known as Record<string, string> : {}),
					chats: trajectory.chats(),
				};
				return toWire(result);
			},
			setLabel: (_ctx, sessionId, label) => {
				trajectory.setLabel(String(sessionId), typeof label === 'string' ? label : '');
				return true;
			},
			clear: (_ctx, sessionId) => {
				trajectory.clear(String(sessionId));
				return true;
			},
		}));
	}
}
