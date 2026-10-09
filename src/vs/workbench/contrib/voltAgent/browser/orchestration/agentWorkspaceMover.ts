/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentOrchestratorService, IOrchMoveRequest, IOrchMoveResult, IOrchWorkspaceMover } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { cleanupPlan, describeMoveResult, entryPaths, ICarryPlan, IStatusEntry, IWorkspaceMoveSpec, moveRollback, parseIndexEntries, parseStatusZ, parseWorkspaceMoveSpec, planCarry, targetRollbackPlan, workspaceMoveNote, workspaceTargetLabel } from '../../../../services/voltRuntime/common/git/workspaceMove.js';
import { parseWorktreeList } from '../../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { IAgentCheckpointService } from '../review/agentCheckpointService.js';

type MoveOutcome = Omit<IOrchMoveResult, 'id' | 'at' | 'label' | 'by'> & { readonly label?: string };

interface IMoveState {
	createdWorktree?: { readonly path: string; readonly branch: string };
	appliedTo?: string;
	rebound?: boolean;
	plan?: ICarryPlan;
}

const IN_PROGRESS: readonly (readonly [string, string])[] = [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['REBASE_HEAD', 'rebase']];

/**
 * Moves a chat's files and binding to another checkout, for the orchestrator's `moveWorkspace`
 * effect. The staged state and the working files are copied (index entries by blob: worktrees
 * share one object store), checked against the copy, and only then does the chat re-bind. The old
 * checkout drops what moved after that. A failure before the re-bind undoes what the move made.
 */
export class AgentWorkspaceMover extends Disposable implements IWorkbenchContribution, IOrchWorkspaceMover {

	static readonly ID = 'workbench.contrib.voltAgentWorkspaceMover';

	constructor(
		@IAgentOrchestratorService orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IAgentCheckpointService private readonly checkpoints: IAgentCheckpointService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IFileService private readonly files: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(orchestrator.setWorkspaceMover(this));
	}

	async move({ threadId, move }: IOrchMoveRequest): Promise<MoveOutcome> {
		const spec = parseWorkspaceMoveSpec(move.target);
		const project = this.sessionContext.rootFor(threadId)?.fsPath;
		const from = this.runtime.workingFolder(threadId);
		if (!spec || !project || !from) {
			return { ok: false, error: 'This chat has no project folder to move between.' };
		}
		const state: IMoveState = {};
		try {
			return await this.carry(threadId, project, from, spec, state);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[volt] moving ${threadId} failed: ${message}`);
			await this.rollback(project, state);
			return { ok: false, error: message };
		}
	}

	private async carry(threadId: string, project: string, from: string, spec: IWorkspaceMoveSpec, state: IMoveState): Promise<MoveOutcome> {
		const fromBranch = await this.branchOf(from);
		let to: string;
		let toBranch: string | undefined;
		let targetStatus: readonly IStatusEntry[] = [];
		switch (spec.target.kind) {
			case 'newWorktree': {
				const created = await this.worktrees.create(project, spec.target.branch ? { kind: 'new', name: spec.target.branch } : undefined);
				state.createdWorktree = created;
				to = created.path;
				toBranch = created.branch;
				break;
			}
			case 'local':
				to = project;
				toBranch = await this.branchOf(project);
				targetStatus = await this.statusOf(project);
				break;
			case 'worktree': {
				const wanted = spec.target.path.replace(/\/+$/, '');
				const listing = await this.worktrees.git(project, ['worktree', 'list', '--porcelain']);
				const entry = parseWorktreeList(listing.stdout).find(candidate => candidate.path.replace(/\/+$/, '') === wanted);
				if (!entry) {
					throw new Error(`${spec.target.path} is not a worktree of this project.`);
				}
				to = entry.path;
				toBranch = entry.branch;
				targetStatus = await this.statusOf(to);
				break;
			}
		}
		if (to === from) {
			throw new Error('The chat already works in that checkout.');
		}
		const status = await this.statusOf(from);
		const threadPaths = (await this.checkpoints.getChanges(threadId, 'session')).flatMap(change => change.oldPath ? [change.path, change.oldPath] : [change.path]);
		const plan = planCarry({ status, threadPaths, carry: spec.carry, targetStatus, inProgress: await this.operationInProgress(from) });
		state.plan = plan;
		if (plan.blockers.length) {
			throw new Error(plan.blockers.join(' '));
		}
		if (plan.conflicts.length) {
			throw new Error(`${to} has its own changes to ${plan.conflicts.join(', ')}; clean that checkout first or move without them.`);
		}
		state.appliedTo = to;
		await this.copy(from, to, plan);
		await this.verify(to, plan);
		const worktree = spec.target.kind !== 'local';
		const note = workspaceMoveNote({ fromPath: from, toPath: to, branch: toBranch, worktree, files: plan.moved.length, left: plan.left.length });
		const announce = describeMoveResult({ ok: true, worktree, branch: toBranch, files: plan.moved.length });
		if (!this.runtime.relocate(threadId, worktree ? to : undefined, toBranch, { model: note, announce })) {
			throw new Error('The chat is busy; the move can run again when its turn ends.');
		}
		state.rebound = true;
		await this.dropFromSource(from, plan);
		this.logService.info(`[volt] ${threadId} now works in ${to}`);
		return {
			ok: true,
			label: workspaceTargetLabel(spec.target, toBranch),
			...(worktree ? { path: to } : {}),
			...(toBranch ? { branch: toBranch } : {}),
			...(fromBranch ? { fromBranch } : {}),
			fromPath: from,
			files: plan.moved.length,
		};
	}

	/** Index entries first (the exact staged state), then the working files, each checked after the write. */
	private async copy(from: string, to: string, plan: ICarryPlan): Promise<void> {
		const { tracked, untracked } = plan;
		if (tracked.length) {
			const sourceIndex = parseIndexEntries((await this.git(from, ['ls-files', '-s', '-z', '--', ...tracked])).stdout);
			for (const path of tracked) {
				const entry = sourceIndex.get(path);
				await this.git(to, entry
					? ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${path}`]
					: ['update-index', '--force-remove', '--', path]);
			}
		}
		for (const path of [...tracked, ...untracked]) {
			const source = joinPath(URI.file(from), path);
			const target = joinPath(URI.file(to), path);
			if (await this.files.exists(source)) {
				const content = (await this.files.readFile(source)).value;
				await this.files.createFolder(dirname(target));
				await this.files.writeFile(target, content);
				if (!sameBytes(content, (await this.files.readFile(target)).value)) {
					throw new Error(`The copy of ${path} did not match the original.`);
				}
			} else if (await this.files.exists(target)) {
				await this.files.del(target);
			}
		}
	}

	/** Every moved entry shows in the new checkout's status, so the copy reached git as well as the disk. */
	private async verify(to: string, plan: ICarryPlan): Promise<void> {
		const after = new Set(parseStatusZ((await this.git(to, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout).flatMap(entryPaths));
		const missing = plan.moved.flatMap(entryPaths).filter(path => !after.has(path));
		if (missing.length) {
			throw new Error(`The new checkout does not show ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' and more' : ''}.`);
		}
	}

	/** Once the chat is bound to the new place the old checkout drops what moved. A failure here leaves a duplicate, not a loss. */
	private async dropFromSource(from: string, plan: ICarryPlan): Promise<void> {
		const cleanup = cleanupPlan(plan.moved);
		try {
			if (cleanup.unstage.length) {
				await this.git(from, ['reset', '-q', '--', ...cleanup.unstage]);
			}
			if (cleanup.restore.length) {
				await this.git(from, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...cleanup.restore]);
			}
			await this.deleteAll(from, cleanup.remove);
		} catch (err) {
			this.logService.warn(`[volt] could not drop the moved changes from ${from}`, err);
		}
	}

	private async rollback(project: string, state: IMoveState): Promise<void> {
		for (const step of moveRollback(state)) {
			try {
				if (step.kind === 'removeWorktree') {
					await this.worktrees.remove(project, step.path, step.branch, { deleteBranch: true, force: true, ownsBranch: true });
				} else if (state.plan) {
					await this.restoreTarget(step.folder, state.plan);
				}
			} catch (err) {
				this.logService.warn('[volt] rolling back a failed move left something behind', err);
			}
		}
	}

	private async restoreTarget(to: string, plan: ICarryPlan): Promise<void> {
		const paths = [...plan.tracked, ...plan.untracked];
		if (paths.length) {
			await this.git(to, ['reset', '-q', '--', ...paths]);
		}
		const undo = targetRollbackPlan(plan);
		if (undo.restore.length) {
			await this.git(to, ['restore', '--source=HEAD', '--worktree', '--', ...undo.restore]);
		}
		await this.deleteAll(to, undo.remove);
	}

	private async deleteAll(folder: string, paths: readonly string[]): Promise<void> {
		for (const path of paths) {
			const file = joinPath(URI.file(folder), path);
			if (await this.files.exists(file)) {
				await this.files.del(file);
			}
		}
	}

	private async operationInProgress(folder: string): Promise<string | undefined> {
		for (const [name, label] of IN_PROGRESS) {
			const listed = (await this.worktrees.git(folder, ['rev-parse', '--git-path', name])).stdout.trim();
			if (!listed) {
				continue;
			}
			const file = /^([a-zA-Z]:)?[\\/]/.test(listed) ? URI.file(listed) : joinPath(URI.file(folder), listed);
			if (await this.files.exists(file)) {
				return label;
			}
		}
		return undefined;
	}

	private async statusOf(folder: string): Promise<readonly IStatusEntry[]> {
		const result = await this.worktrees.git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		if (result.exitCode !== 0) {
			throw new Error(`Could not read the changes in ${folder}: ${result.stderr.trim()}`);
		}
		return parseStatusZ(result.stdout);
	}

	private async branchOf(folder: string): Promise<string | undefined> {
		const branch = (await this.worktrees.git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
		return branch && branch !== 'HEAD' ? branch : undefined;
	}

	private async git(cwd: string, args: readonly string[]) {
		const result = await this.worktrees.git(cwd, args);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `git ${args[0]} failed in ${cwd}.`);
		}
		return result;
	}
}

function sameBytes(a: VSBuffer, b: VSBuffer): boolean {
	return a.byteLength === b.byteLength && a.buffer.every((byte, index) => byte === b.buffer[index]);
}

registerWorkbenchContribution2(AgentWorkspaceMover.ID, AgentWorkspaceMover, WorkbenchPhase.BlockRestore);
