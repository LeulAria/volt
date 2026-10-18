/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import {
	IVoltGitStatus, IVoltPrRepo, IVoltPullRequest, IVoltPullRequestService, isVoltPrError, VoltPrMergeMethod, voltPrErrorCode, voltPrErrorMessage
} from '../../../platform/voltPullRequests/common/voltPullRequests.js';
import { isReadyToMerge } from '../../../workbench/contrib/voltAgent/common/agentPullRequests.js';

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

/** A failed host or git call as the protocol sends it: the `[code]` prefix becomes the error code. */
function rethrow(err: unknown): never {
	if (isVoltPrError(err)) {
		fail(voltPrErrorCode(err) ?? 'failed', voltPrErrorMessage(err));
	}
	throw err;
}

/** The repository behind a folder, as the phone shows it next to the branch. */
export interface IServerGitRemote {
	readonly provider: string;
	readonly host: string;
	readonly owner: string;
	readonly name: string;
	readonly webUrl: string;
	readonly remote: string;
}

export interface IServerGitRepoStatus extends Partial<Omit<IVoltGitStatus, 'root'>> {
	readonly root: string;
	/** False outside a git work tree (every other field is then left out). */
	readonly isRepo: boolean;
	/** The pull request host behind `origin` (or the first remote), when Volt knows it. */
	readonly repo?: IServerGitRemote;
	/** Who Volt reads the host as; `signedIn` false when `gh` (or the host's sign-in) is missing. */
	readonly auth?: { readonly signedIn: boolean; readonly login?: string };
}

/** A pull request, with whether nothing stands between it and a merge (the desktop's rule). */
export type IServerPullRequest = IVoltPullRequest & { readonly readyToMerge: boolean };

const MERGE_METHODS: readonly VoltPrMergeMethod[] = ['squash', 'merge', 'rebase'];

/**
 * Git and pull requests for paired clients (the phone's branch row, Commit / Push / Create PR and
 * the pull request screens): the desktop's own VoltPullRequestService (gh + git), behind the same
 * folder check as `files.*` (Volt's projects and chat worktrees only).
 */
export class ServerGit extends Disposable {

	constructor(
		protocol: AgentServerProtocol,
		private readonly allowed: (path: string) => Promise<string>,
		private readonly pullRequests: IVoltPullRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(protocol.registerMethods('git', {
			status: (_ctx, root) => this.status(String(root ?? '')),
			commit: (_ctx, root, message, options) => this.commit(String(root ?? ''), String(message ?? ''), (options ?? {}) as { paths?: string[]; newBranch?: string }),
			push: (_ctx, root) => this.withFolder(String(root ?? ''), folder => this.pullRequests.push({ folder })),
			pull: (_ctx, root) => this.withFolder(String(root ?? ''), folder => this.pullRequests.pull(folder)),
			createBranch: (_ctx, root, name) => this.createBranch(String(root ?? ''), String(name ?? '')),
		}));
		this._register(protocol.registerMethods('pullRequests', {
			forBranch: (_ctx, root, branch) => this.forBranch(String(root ?? ''), typeof branch === 'string' && branch ? branch : undefined),
			list: (_ctx, root, options) => this.list(String(root ?? ''), (options ?? {}) as { state?: 'open' | 'closed' | 'all'; limit?: number }),
			get: (_ctx, root, number) => this.withRepo(String(root ?? ''), async repo => {
				const detail = await this.pullRequests.detail({ repo, number: this.number(number) });
				return { ...detail, readyToMerge: isReadyToMerge(detail) };
			}),
			files: (_ctx, root, number) => this.withRepo(String(root ?? ''), (repo, folder) => this.pullRequests.filePatches({ repo, number: this.number(number), folder })),
			create: (_ctx, root, request) => this.create(String(root ?? ''), (request ?? {}) as { title?: string; body?: string; base?: string; draft?: boolean }),
			merge: (_ctx, root, number, options) => this.merge(String(root ?? ''), this.number(number), (options ?? {}) as { method?: string; deleteBranch?: boolean; headOid?: string; auto?: boolean }),
			markReady: (_ctx, root, number) => this.withRepo(String(root ?? ''), repo => this.pullRequests.setDraft({ repo, number: this.number(number), draft: false })),
			comment: (_ctx, root, number, body) => this.withRepo(String(root ?? ''), repo => {
				const text = String(body ?? '').trim();
				return text ? this.pullRequests.comment({ repo, number: this.number(number), body: text }) : fail('BadArgument', 'Write a comment first.');
			}),
			rerunFailedChecks: (_ctx, root, number) => this.withRepo(String(root ?? ''), repo => this.pullRequests.rerunFailedChecks({ repo, number: this.number(number) })),
		}));
	}

	private number(value: unknown): number {
		const number = Number(value);
		return Number.isInteger(number) && number > 0 ? number : fail('BadArgument', 'Give a pull request number.');
	}

	private async withFolder<T>(root: string, fn: (folder: string) => Promise<T>): Promise<T> {
		const folder = await this.allowed(root);
		try {
			return await fn(folder);
		} catch (err) {
			return rethrow(err);
		}
	}

	/** Runs `fn` with the folder's pull request host; fails `NoRemote` when it has none Volt knows. */
	private withRepo<T>(root: string, fn: (repo: IVoltPrRepo, folder: string) => Promise<T>): Promise<T> {
		return this.withFolder(root, async folder => {
			const repo = await this.pullRequests.resolveRepo(folder);
			return repo ? fn(repo, folder) : fail('NoRemote', 'This folder has no remote on GitHub or another host Volt knows.');
		});
	}

	private async status(root: string): Promise<IServerGitRepoStatus> {
		const folder = await this.allowed(root);
		const [status, repo] = await Promise.all([
			this.pullRequests.gitStatus(folder).catch(err => {
				this.logService.trace('[volt agent server] git status failed', err);
				return undefined;
			}),
			this.pullRequests.resolveRepo(folder).catch(() => undefined),
		]);
		if (!status) {
			return { root: folder, isRepo: false };
		}
		const accounts = repo ? await this.pullRequests.accounts(repo.host).catch(() => []) : [];
		const account = accounts.find(a => a.active && a.ok) ?? accounts.find(a => a.ok);
		const { root: repoRoot, ...rest } = status;
		return {
			...rest,
			root: repoRoot,
			isRepo: true,
			...(repo ? { repo: { provider: repo.provider, host: repo.host, owner: repo.owner, name: repo.name, webUrl: repo.webUrl, remote: repo.remote } } : {}),
			...(repo ? { auth: { signedIn: !!account, ...(account ? { login: account.login } : {}) } } : {}),
		};
	}

	private commit(root: string, message: string, options: { readonly paths?: readonly string[]; readonly newBranch?: string }) {
		if (!message.trim()) {
			fail('BadArgument', 'Write a commit message first.');
		}
		return this.withFolder(root, async folder => {
			const paths = Array.isArray(options.paths) ? await Promise.all(options.paths.map(path => this.allowed(String(path)))) : undefined;
			const newBranch = typeof options.newBranch === 'string' && options.newBranch.trim() ? options.newBranch.trim() : undefined;
			return this.pullRequests.commit({ folder, message: message.trim(), ...(paths?.length ? { paths } : {}), ...(newBranch ? { newBranch } : {}) });
		});
	}

	private createBranch(root: string, name: string) {
		const branch = name.trim();
		if (!branch || /[\s~^:?*[\\]|\.\.|^-|\/$|\.lock$/.test(branch)) {
			fail('BadArgument', 'That is not a valid branch name.');
		}
		return this.withFolder(root, async folder => {
			await this.pullRequests.checkoutNewBranch({ folder, name: branch });
			return { branch };
		});
	}

	/** The branch's pull request: the open one, else the newest. Undefined when it has none. */
	private forBranch(root: string, branch: string | undefined): Promise<IServerPullRequest | undefined> {
		return this.withRepo(root, async (repo, folder) => {
			const name = branch ?? repo.branch ?? (await this.pullRequests.gitStatus(folder))?.branch;
			if (!name) {
				return undefined;
			}
			const found = await this.pullRequests.forBranch({ repo, branch: name });
			const pr = found.find(candidate => candidate.state === 'open' || candidate.state === 'draft') ?? found[0];
			return pr ? { ...pr, readyToMerge: isReadyToMerge(pr) } : undefined;
		});
	}

	private list(root: string, options: { readonly state?: 'open' | 'closed' | 'all'; readonly limit?: number }): Promise<IServerPullRequest[]> {
		const state = options.state === 'closed' || options.state === 'all' ? options.state : 'open';
		const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100);
		return this.withRepo(root, async repo => (await this.pullRequests.list({ repo, state, limit })).map(pr => ({ ...pr, readyToMerge: isReadyToMerge(pr) })));
	}

	/**
	 * Opens a pull request for the checked out branch, as the desktop's "Create PR" does: the branch
	 * is pushed first when it has no upstream or holds unpushed commits.
	 */
	private create(root: string, request: { readonly title?: string; readonly body?: string; readonly base?: string; readonly draft?: boolean }): Promise<IServerPullRequest> {
		const title = String(request.title ?? '').trim();
		if (!title) {
			fail('BadArgument', 'Give the pull request a title.');
		}
		return this.withRepo(root, async (repo, folder) => {
			const status = await this.pullRequests.gitStatus(folder);
			if (!status?.branch) {
				fail('NoBranch', 'Check out a branch first.');
			}
			const base = String(request.base ?? '').trim() || status.defaultBranch;
			if (!base) {
				fail('BadArgument', 'Pick the branch to merge into.');
			}
			if (status.branch === base) {
				fail('OnBaseBranch', `You are on ${base}. Create a branch for the changes first.`);
			}
			if (!status.upstream || status.ahead > 0) {
				await this.pullRequests.push({ folder });
			}
			const pr = await this.pullRequests.create({ repo, head: status.branch, base, title, body: String(request.body ?? ''), draft: !!request.draft });
			return { ...pr, readyToMerge: isReadyToMerge(pr) };
		});
	}

	private merge(root: string, number: number, options: { readonly method?: string; readonly deleteBranch?: boolean; readonly headOid?: string; readonly auto?: boolean }): Promise<void> {
		const method = MERGE_METHODS.find(m => m === options.method);
		if (!method) {
			fail('BadArgument', 'Pick squash, merge or rebase.');
		}
		return this.withRepo(root, repo => this.pullRequests.merge({
			repo,
			number,
			method,
			deleteBranch: !!options.deleteBranch,
			...(typeof options.headOid === 'string' && options.headOid ? { headOid: options.headOid } : {}),
			...(options.auto ? { auto: true } : {}),
		}));
	}
}
