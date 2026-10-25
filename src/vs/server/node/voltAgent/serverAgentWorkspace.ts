/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/log.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { AgentWorkspaceService, IAgentSurface, IAgentSurfaceDraft } from '../../../workbench/contrib/voltAgent/browser/workspace/agentWorkspace.js';
import { toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IVoltWindowScopeService } from '../../../workbench/services/voltWindowScope/common/voltWindowScope.js';
import { IAgentServerClients } from './serverClients.js';

/**
 * The server's copy of the agent workspaces: it keeps the project bindings the turn host reads.
 * A run that asks to show something (a local preview) is shown by a connected Volt window.
 */
export class ServerAgentWorkspaceService extends AgentWorkspaceService {

	constructor(
		@IStorageService storageService: IStorageService,
		@IAgentServerClients private readonly clients: IAgentServerClients,
		@ILogService private readonly logService: ILogService,
		@IVoltWindowScopeService windowScope: IVoltWindowScopeService,
	) {
		super(storageService, windowScope);
	}

	override openSurface(sessionId: string, draft: IAgentSurfaceDraft, reuse: boolean): IAgentSurface {
		const surface = super.openSurface(sessionId, draft, reuse);
		if (this.clients.has('surface')) {
			this.clients.call('surface', 'surface.open', sessionId, toWire(draft), reuse)
				.catch(err => this.logService.trace('[volt agent server] no window opened the surface', err));
		}
		return surface;
	}
}
