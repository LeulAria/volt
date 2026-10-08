/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IWorkspaceMoveSpec, WorkspaceCarry, WorkspaceMoveTarget } from '../../../../services/voltRuntime/common/git/workspaceMove.js';
import type { IGitWorktreeEntry } from '../../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { IVoltMenuItem, IVoltSubmenu, showVoltMenu } from '../ui/menu/voltMenu.js';

export interface IAgentMoveMenuOptions {
	/** The checkout the chat works in now (left out of the list). */
	readonly current: string | undefined;
	readonly worktrees: readonly IGitWorktreeEntry[];
	readonly onPick: (spec: IWorkspaceMoveSpec) => void;
}

interface IMovePick {
	readonly target: WorkspaceMoveTarget;
	readonly carry?: WorkspaceCarry;
}

/**
 * The chat's branch menu: where the chat moves (a new worktree, the project's checkout, or a
 * worktree that exists), and then which uncommitted changes come along.
 */
export function showAgentMoveMenu(contextViewService: IContextViewService, anchor: HTMLElement, options: IAgentMoveMenuOptions): void {
	const sameFolder = (path: string) => !!options.current && path.replace(/\/+$/, '') === options.current.replace(/\/+$/, '');
	const destinations: IVoltMenuItem<IMovePick>[] = [
		{ id: 'new', label: localize('voltAgent.move.newWorktree', "New worktree"), description: localize('voltAgent.move.newWorktreeHint', "A new branch from HEAD"), icon: Codicon.gitBranch, data: { target: { kind: 'newWorktree' } }, submenu: carrySubmenu({ target: { kind: 'newWorktree' } }) },
	];
	const main = options.worktrees[0];
	if (main && !sameFolder(main.path)) {
		destinations.push({ id: 'local', label: localize('voltAgent.move.local', "Project checkout"), description: main.branch, icon: Codicon.home, data: { target: { kind: 'local' } }, submenu: carrySubmenu({ target: { kind: 'local' } }) });
	}
	for (const worktree of options.worktrees.slice(1)) {
		if (sameFolder(worktree.path)) {
			continue;
		}
		const target: WorkspaceMoveTarget = { kind: 'worktree', path: worktree.path };
		destinations.push({ id: worktree.path, label: worktree.branch ?? worktree.path.split(/[\\/]/).pop() ?? worktree.path, description: worktree.path, icon: Codicon.folder, data: { target }, submenu: carrySubmenu({ target }) });
	}
	showVoltMenu<IMovePick>(contextViewService, {
		anchor,
		align: 'right',
		gap: 4,
		width: 280,
		className: 'volt-agent-move-menu',
		ariaLabel: localize('voltAgent.move.menu', "Move chat to"),
		sections: [{ id: 'destinations', items: destinations }],
		onPick: item => options.onPick({ target: item.data.target, carry: item.data.carry ?? 'thread' }),
	});
}

function carrySubmenu(target: { readonly target: WorkspaceMoveTarget }): IVoltSubmenu<IMovePick> {
	const items: IVoltMenuItem<IMovePick>[] = [
		{ id: 'thread', label: localize('voltAgent.move.carryThread', "Only this chat's files"), description: localize('voltAgent.move.carryThreadHint', "Recommended"), data: { ...target, carry: 'thread' } },
		{ id: 'all', label: localize('voltAgent.move.carryAll', "All uncommitted changes"), data: { ...target, carry: 'all' } },
		{ id: 'none', label: localize('voltAgent.move.carryNone', "Nothing, just the chat"), data: { ...target, carry: 'none' } },
	];
	return { sections: [{ id: 'carry', items }] };
}
