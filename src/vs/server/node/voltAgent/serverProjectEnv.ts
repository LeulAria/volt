/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { isLinux } from '../../../base/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { normalizeProjectSettings, PROJECT_SETTINGS_STORAGE_KEY, projectForPath, ProjectSettingsMap } from '../../../workbench/contrib/voltSetup/common/projectSettings.js';
import { IAgentHistoryService } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { setProjectRunEnvResolver } from '../../../workbench/services/voltRuntime/common/projectRunEnv.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../workbench/services/voltRuntime/common/sessionContext.js';

/**
 * Project Settings > Environment for what the server runs: agent CLIs, the agents' commands and
 * terminals. The settings live with the windows (Project Settings is a window page); each window
 * sends its copy whenever it changes, and the server keeps the last one it got.
 */
export class ServerProjectEnv extends Disposable {

	private map: ProjectSettingsMap;

	constructor(
		protocol: AgentServerProtocol,
		@IStorageService private readonly storage: IStorageService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
	) {
		super();
		this.map = this.read();
		this._register(setProjectRunEnvResolver(cwd => this.envFor(cwd)));
		this._register(protocol.registerMethod('projectSettings.set', (ctx, text) => {
			// A paired phone must not change what runs on this computer.
			if (ctx.client.role !== 'owner') {
				throw Object.assign(new Error('Only Volt on this computer can change project settings.'), { code: 'Forbidden' });
			}
			if (typeof text !== 'string') {
				return false;
			}
			let parsed: ProjectSettingsMap;
			try {
				parsed = normalizeProjectSettings(JSON.parse(text));
			} catch {
				return false;
			}
			this.map = parsed;
			this.storage.store(PROJECT_SETTINGS_STORAGE_KEY, JSON.stringify(parsed), StorageScope.APPLICATION, StorageTarget.USER);
			return true;
		}));
	}

	private read(): ProjectSettingsMap {
		try {
			return normalizeProjectSettings(JSON.parse(this.storage.get(PROJECT_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION, '{}')));
		} catch {
			return {};
		}
	}

	/** A project folder, or a worktree one of the project's chats runs in (as a window resolves it). */
	private envFor(cwd: string): Readonly<Record<string, string>> | undefined {
		const withEnv = this.sessionContext.projects.filter(project => project.root.scheme === 'file' && this.map[project.id]?.env);
		if (!withEnv.length) {
			return undefined;
		}
		const caseInsensitive = !isLinux;
		const roots = withEnv.map(project => ({ id: project.id, root: project.root.fsPath }));
		const direct = projectForPath(cwd, roots, caseInsensitive);
		if (direct) {
			return this.map[direct.id]?.env;
		}
		const worktree = projectForPath(cwd, this.history.list({ includeArchived: true })
			.filter(session => session.worktreePath && session.workspaceFolder)
			.map(session => ({ root: session.worktreePath!, folder: session.workspaceFolder! })), caseInsensitive);
		if (!worktree) {
			return undefined;
		}
		const owner = projectForPath(uriFromStoredRoot(worktree.folder).fsPath, roots, caseInsensitive);
		return owner ? this.map[owner.id]?.env : undefined;
	}
}
