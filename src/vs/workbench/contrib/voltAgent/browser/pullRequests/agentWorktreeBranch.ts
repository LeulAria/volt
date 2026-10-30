/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';

/**
 * Chats working in the worktree at `root` follow the branch it has checked out now: a rename
 * (rename_branch, `git branch -m`) or a checkout shows in the sidebar row and the composer's
 * branch pill, and pull requests from the new branch count as the chat's own. A detached HEAD
 * (no branch) keeps the last name. Returns whether any chat changed.
 */
export function followWorktreeBranch(history: IAgentHistoryService, runtime: IAgentRuntimeService, root: string, branch: string | undefined): boolean {
	if (!branch) {
		return false;
	}
	let changed = false;
	for (const meta of history.list()) {
		if (meta.worktreePath && meta.worktreeBranch !== branch && samePath(meta.worktreePath, root)) {
			runtime.rememberWorktree(meta.id, meta.worktreePath, branch);
			history.open(meta.id).setMeta({ worktreeBranch: branch });
			changed = true;
		}
	}
	return changed;
}

export function samePath(a: string, b: string): boolean {
	const clean = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return clean(a) === clean(b);
}
