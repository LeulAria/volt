/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoltHostSessionResolver } from './hostTools.js';
import { VoltMode } from './modes.js';
import { IAgentRuntimeService } from './runtime.js';

/** Mode and folder per chat for the host tools, learned from the runs the runtime starts. */
export class RunModeTracker extends Disposable implements IVoltHostSessionResolver {

	private readonly modes = new Map<string, VoltMode>();

	constructor(private readonly runtime: IAgentRuntimeService) {
		super();
		this._register(runtime.onDidEmit(({ sessionId, event }) => {
			if (event.type === 'run.start') {
				this.modes.set(sessionId, event.mode);
			}
		}));
	}

	mode(sessionId: string): VoltMode | undefined {
		return this.modes.get(sessionId);
	}

	/**
	 * Where the chat's agent works: its worktree, or else its project's folder. Only the worktree
	 * was returned before, so a chat on the project itself had no folder in the agent server (which
	 * has no workspace to fall back on): its sandbox refused every relative path, and code_nav,
	 * instant_grep and find_symbol answered "this chat has no folder".
	 */
	cwd(sessionId: string): string | undefined {
		return this.modes.has(sessionId) ? this.runtime.getOrCreateSession(sessionId).worktreePath ?? this.runtime.workingFolder(sessionId) : undefined;
	}
}
