/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { IPathService } from '../../../path/common/pathService.js';
import { IAgentHistoryService } from '../../common/history/agentHistory.js';
import {
	AgentWorktreeTarget,
	IAgentWorktreeService,
	ICreatedAgentWorktree,
	IGitRunResult,
	IWorktreeFiles,
	archivedWorktreeCandidates,
	createAgentWorktree,
	ensureAgentWorktree,
	removeAgentWorktree,
	serializeForRepo,
	WorktreeRemoval,
} from '../../common/git/agentWorktree.js';

const GIT_TIMEOUT_MS = 180_000;

export class AgentWorktreeService implements IAgentWorktreeService {

	declare readonly _serviceBrand: undefined;

	private rootPath: string | undefined;

	constructor(
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@ILogService private readonly logService: ILogService,
	) { }

	async create(repoRoot: string, target?: AgentWorktreeTarget): Promise<ICreatedAgentWorktree> {
		return createAgentWorktree({
			run: (cwd, args) => this.git(cwd, args),
			files: this.files(),
			repoRoot,
			worktreesRoot: this.worktreesRoot(),
			target,
		});
	}

	async ensure(repoRoot: string, path: string, branch: string): Promise<boolean> {
		return ensureAgentWorktree({
			run: (cwd, args) => this.git(cwd, args),
			files: this.files(),
			repoRoot,
			worktreesRoot: this.worktreesRoot(),
			path,
			branch,
		});
	}

	async pruneArchived(): Promise<void> {
		await this.history.whenReady;
		const worktreesRoot = this.worktreesRoot();
		const owners = this.history.list({ includeArchived: true }).map(meta => ({
			sessionId: meta.id,
			path: meta.worktreePath,
			branch: meta.worktreeBranch,
			archived: meta.archived,
			updatedAt: meta.updatedAt,
			workspaceFolder: meta.workspaceFolder,
		}));
		const candidates = archivedWorktreeCandidates(owners, worktreesRoot);
		for (const candidate of candidates) {
			const repoRoot = candidate.workspaceFolder;
			const path = candidate.path;
			const branch = candidate.branch;
			if (!repoRoot || !path || !branch) {
				continue;
			}
			try {
				await removeAgentWorktree({
					run: (cwd, args) => this.git(cwd, args),
					files: this.files(),
					repoRoot,
					worktreesRoot,
					path,
					branch,
					deleteBranch: false,
					force: false,
				});
			} catch (err) {
				this.logService.warn(`[agent worktree] could not prune ${path}`, err);
			}
		}
	}

	async removeForDeletedChat(repoRoot: string | undefined, path: string | undefined, branch: string | undefined): Promise<void> {
		if (!repoRoot || !path || !branch) {
			return;
		}
		try {
			await removeAgentWorktree({
				run: (cwd, args) => this.git(cwd, args),
				files: this.files(),
				repoRoot,
				worktreesRoot: this.worktreesRoot(),
				path,
				branch,
				deleteBranch: true,
				force: true,
			});
		} catch (err) {
			this.logService.warn(`[agent worktree] could not remove ${path}`, err);
		}
	}

	async remove(repoRoot: string, path: string, branch: string, options: { readonly deleteBranch: boolean; readonly force: boolean; readonly ownsBranch?: boolean }): Promise<WorktreeRemoval> {
		return removeAgentWorktree({
			run: (cwd, args) => this.git(cwd, args),
			files: this.files(),
			repoRoot,
			worktreesRoot: this.worktreesRoot(),
			path,
			branch,
			...options,
		});
	}

	serialize<T>(repoRoot: string, work: () => Promise<T>): Promise<T> {
		return serializeForRepo((cwd, args) => this.git(cwd, args), repoRoot, work);
	}

	private worktreesRoot(): string {
		if (!this.rootPath) {
			const home = this.pathService.userHome({ preferLocal: true });
			this.rootPath = join(home.fsPath, '.volt', 'worktrees');
		}
		return this.rootPath;
	}

	private files(): IWorktreeFiles {
		return {
			exists: path => this.fileService.exists(URI.file(path)),
			ensureDir: async path => { await this.fileService.createFolder(URI.file(path)); },
			remove: async path => {
				try {
					await this.fileService.del(URI.file(path), { recursive: true });
				} catch (err) {
					if (!(err instanceof FileOperationError) || err.fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) {
						throw err;
					}
				}
			},
		};
	}

	async git(cwd: string, args: readonly string[]): Promise<IGitRunResult> {
		try {
			const result = await this.stdio.exec({
				id: `git-${generateUuid().slice(0, 8)}`,
				command: ['git', '--no-pager', ...args].map(quoteArg).join(' '),
				cwd,
				timeoutMs: GIT_TIMEOUT_MS,
				inlineChars: 20_000,
			});
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		} catch (err) {
			return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
		}
	}
}

function quoteArg(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

class AgentWorktreeRetentionContribution extends Disposable {
	static readonly ID = 'workbench.contrib.agentWorktreeRetention';

	constructor(
		@IAgentHistoryService history: IAgentHistoryService,
		@IAgentWorktreeService worktrees: IAgentWorktreeService,
	) {
		super();
		void history.whenReady.then(() => worktrees.pruneArchived());
	}
}

registerSingleton(IAgentWorktreeService, AgentWorktreeService, InstantiationType.Delayed);
registerWorkbenchContribution2(AgentWorktreeRetentionContribution.ID, AgentWorktreeRetentionContribution, WorkbenchPhase.Eventually);
