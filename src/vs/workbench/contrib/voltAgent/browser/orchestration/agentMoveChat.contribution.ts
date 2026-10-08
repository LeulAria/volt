/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { WorkspaceCarry, WorkspaceMoveTarget, workspaceTargetLabel } from '../../../../services/voltRuntime/common/git/workspaceMove.js';
import { parseWorktreeList } from '../../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';

export const AGENT_MOVE_CHAT_COMMAND_ID = 'volt.agent.moveChat';

interface IDestinationPick extends IQuickPickItem {
	readonly target: WorkspaceMoveTarget;
}

interface ICarryPick extends IQuickPickItem {
	readonly carry: WorkspaceCarry;
}

registerAction2(class MoveAgentChatAction extends Action2 {
	constructor() {
		super({
			id: AGENT_MOVE_CHAT_COMMAND_ID,
			title: localize2('voltAgent.moveChat', "Move Chat to Worktree…"),
			category: localize2('volt', "Volt"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const input = accessor.get(IEditorService).activeEditor;
		const notifications = accessor.get(INotificationService);
		const quickInput = accessor.get(IQuickInputService);
		const worktrees = accessor.get(IAgentWorktreeService);
		const orchestrator = accessor.get(IAgentOrchestratorService);
		if (!(input instanceof AgentEditorInput)) {
			notifications.info(localize('voltAgent.move.noChat', "Open a chat to move it."));
			return;
		}
		const threadId = input.sessionId;
		const root = accessor.get(IVoltSessionContextService).rootFor(threadId);
		if (!root) {
			notifications.info(localize('voltAgent.move.noProject', "This chat has no project folder."));
			return;
		}
		const listing = await worktrees.git(root.fsPath, ['worktree', 'list', '--porcelain']);
		if (listing.exitCode !== 0) {
			notifications.warn(listing.stderr.trim() || localize('voltAgent.move.noWorktrees', "Could not list this project's worktrees."));
			return;
		}
		const destinations: IDestinationPick[] = [{ label: localize('voltAgent.move.newWorktree', "New worktree"), description: localize('voltAgent.move.newWorktreeHint', "A new branch from HEAD"), target: { kind: 'newWorktree' } }];
		const [main, ...others] = parseWorktreeList(listing.stdout);
		if (main) {
			destinations.push({ label: localize('voltAgent.move.local', "Project checkout"), description: main.branch ?? main.path, target: { kind: 'local' } });
		}
		for (const worktree of others) {
			destinations.push({ label: worktree.branch ?? worktree.path, description: worktree.path, target: { kind: 'worktree', path: worktree.path } });
		}
		const destination = await quickInput.pick(destinations, { placeHolder: localize('voltAgent.move.pickDestination', "Move the chat to…") });
		if (!destination) {
			return;
		}
		const carries: ICarryPick[] = [
			{ label: localize('voltAgent.move.carryThread', "Only this chat's files"), carry: 'thread' },
			{ label: localize('voltAgent.move.carryAll', "All uncommitted changes"), carry: 'all' },
			{ label: localize('voltAgent.move.carryNone', "Nothing, just the chat"), carry: 'none' },
		];
		const carry = await quickInput.pick(carries, { placeHolder: localize('voltAgent.move.pickCarry', "Which uncommitted changes come along?") });
		if (!carry) {
			return;
		}
		const result = await orchestrator.move(threadId, { target: destination.target, carry: carry.carry }, { by: 'user' });
		if (result.outcome === 'rejected') {
			notifications.warn(result.reason ?? localize('voltAgent.move.rejected', "This chat cannot move now."));
		} else if (result.outcome === 'queued') {
			notifications.info(localize('voltAgent.move.queued', "The chat moves to {0} when its current turn ends.", workspaceTargetLabel(destination.target)));
		}
	}
});
