/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VoltGitRestoreOutcome } from '../../../../../platform/voltGit/common/voltGit.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { AgentTurnRef, IAgentCheckpoint, IAgentCheckpointService, IAgentRestorePreview, IAgentRestoreResult, IAgentSnapshotChange } from './agentCheckpointService.js';

/** Checkpoints are taken by the agent server around every turn; restores run there too. */
export class RemoteAgentCheckpointService extends Disposable implements IAgentCheckpointService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	constructor(@IAgentServerClientService private readonly client: IAgentServerClientService) {
		super();
		this._register(client.onDidChangeCollection(e => {
			if (e.col === 'checkpoints') {
				e.keys.forEach(key => this._onDidChange.fire(key));
			}
		}));
	}

	private state(sessionId: string): { checkpoints: readonly IAgentCheckpoint[]; canRedo: boolean } | undefined {
		return this.client.mirror.get('checkpoints', sessionId);
	}

	beginTurn(sessionId: string, turnId: string): Promise<void> {
		return this.client.call('checkpoints.beginTurn', sessionId, turnId);
	}

	getCheckpoints(sessionId: string): readonly IAgentCheckpoint[] {
		return this.state(sessionId)?.checkpoints ?? [];
	}

	loadCheckpoints(sessionId: string): Promise<readonly IAgentCheckpoint[]> {
		return this.client.call('checkpoints.loadCheckpoints', sessionId);
	}

	previewRestore(sessionId: string, turn: AgentTurnRef): Promise<IAgentRestorePreview | undefined> {
		return this.client.call('checkpoints.previewRestore', sessionId, turn);
	}

	restoreCheckpoint(sessionId: string, turn: AgentTurnRef, options?: { readonly overwrite?: boolean }): Promise<IAgentRestoreResult | undefined> {
		return this.client.call('checkpoints.restoreCheckpoint', sessionId, turn, options);
	}

	canRedo(sessionId: string): boolean {
		return !!this.state(sessionId)?.canRedo;
	}

	redo(sessionId: string, options?: { readonly overwrite?: boolean }): Promise<IAgentRestoreResult | undefined> {
		return this.client.call('checkpoints.redo', sessionId, options);
	}

	restoreFile(sessionId: string, uri: URI, options?: { readonly overwrite?: boolean }): Promise<VoltGitRestoreOutcome | 'unavailable'> {
		return this.client.call('checkpoints.restoreFile', sessionId, uri, options);
	}

	getChanges(sessionId: string, scope: 'session' | 'lastTurn' | { readonly turnId: string }): Promise<readonly IAgentSnapshotChange[]> {
		return this.client.call('checkpoints.getChanges', sessionId, scope);
	}

	deleteCheckpoints(sessionId: string): Promise<void> {
		return this.client.call('checkpoints.deleteCheckpoints', sessionId);
	}
}
