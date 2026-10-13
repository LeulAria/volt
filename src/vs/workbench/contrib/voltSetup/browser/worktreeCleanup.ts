/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVoltStorageContext, IVoltStorageService } from '../../../../platform/voltStorage/common/voltStorage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentEditorInput } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { readWorktreeLimits, WORKTREE_MAX_COUNT_SETTING, WORKTREE_MAX_SIZE_GB_SETTING } from '../common/worktreeLimits.js';

/** Checkouts pile up as chats start; this is how often the limits are looked at again. */
const PERIOD_MS = 2 * 60 * 60_000;
/** A stepper sends a value per click; the cleanup waits for the last one. */
const SETTLE_MS = 3_000;

/**
 * Settings > Worktrees > Cleanup: keeps `~/.volt/worktrees` within its count and size limits,
 * oldest checkouts first, on startup, every couple of hours and when a limit changes. The main
 * process does the removing, one window at a time, and never touches a dirty checkout.
 */
export class VoltWorktreeCleanupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWorktreeCleanup';

	private readonly scheduler = this._register(new RunOnceScheduler(() => void this.run(), SETTLE_MS));

	constructor(
		@IVoltStorageService private readonly storage: IVoltStorageService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(WORKTREE_MAX_COUNT_SETTING) || e.affectsConfiguration(WORKTREE_MAX_SIZE_GB_SETTING)) {
				this.scheduler.schedule();
			}
		}));
		this._register(new IntervalTimer()).cancelAndSet(() => this.scheduler.schedule(), PERIOD_MS);
		void history.whenReady.then(() => this.scheduler.schedule());
	}

	private async run(): Promise<void> {
		const sessions = this.history.list({ includeArchived: true });
		// A chat open here may be read in the tools pane; it counts as running.
		const busy = new Set(sessions.filter(session => session.status === 'running').map(session => session.id));
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput) {
					busy.add(editor.sessionId);
				}
			}
		}
		const context: IVoltStorageContext = {
			openWorkspaceIds: [],
			worktrees: sessions.filter(session => session.worktreePath).map(session => ({ path: session.worktreePath!, sessionId: session.id, archived: !!session.archived, updatedAt: session.updatedAt })),
			sessionIds: sessions.map(session => session.id),
			runningSessionIds: [...busy],
		};
		try {
			await this.storage.enforceWorktreeLimits(context, readWorktreeLimits(key => this.configurationService.getValue(key)));
		} catch (err) {
			this.logService.warn('[volt worktrees] cleanup failed', err);
		}
	}
}
