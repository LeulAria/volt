/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceCancellation, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { voltPrErrorCode, voltPrErrorMessage } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IVoltGitService } from '../../../../platform/voltGit/common/voltGit.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import {
	AWAIT_COMMITS_TOOL_NAME,
	commitPlanOutcomeText,
	hunkFilesOf,
	ICommitPlanOutcome,
	IPlanHunk,
	normalizeBranchName,
	normalizePlanPath,
	parseCommitPlan,
	parseHunks,
	PROPOSE_COMMITS_TOOL_NAME,
	RENAME_BRANCH_TOOL_NAME,
	spliceHunks,
} from '../common/agentCommitPlan.js';
import { AGENT_COMMIT_ATTRIBUTION_SETTING, withCommitAttribution } from '../../voltAgent/common/agentGitSettings.js';
import { IAgentPullRequestService } from '../../voltAgent/browser/pullRequests/agentPullRequestService.js';
import { followWorktreeBranch } from '../../voltAgent/browser/pullRequests/agentWorktreeBranch.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { reviewBuildEntries } from '../../voltAgent/browser/review/buildEntryReview.js';
import { ICapabilityRequest } from '../../../services/voltPlugins/common/capabilities.js';
import { COMMIT_PLAN_TOOLS, IAgentCommitPlan, IAgentCommitPlanService, IAgentPlannedCommit } from '../common/voltCommitReview.js';

/** Under the 60s default MCP request timeout of the agents' SDK clients (as ask_question). */
const PLAN_POLL_MS = 45_000;

export class AgentCommitPlanService extends Disposable implements IAgentCommitPlanService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly plans = new Map<string, IAgentCommitPlan>();
	/** The answer each plan's agent waits for, by plan id; settled once the review ends. */
	private readonly outcomes = new Map<string, DeferredPromise<string>>();
	/** How each chat's last review ended, for an agent that asks about it late. */
	private readonly lastOutcomes = new Map<string, string>();
	/** Chats waiting for their agent's draft commits, with the run that was asked once it starts. */
	private readonly drafts = new Map<string, { runId?: string }>();
	private readonly stoppedDrafts = new Set<string>();
	/** Checks a use of git against the module's manifest (report mode); set by the module. */
	private check: (request: ICapabilityRequest) => void = () => { };

	constructor(
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IVoltGitService private readonly git: IVoltGitService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IDialogService private readonly dialogService: IDialogService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: COMMIT_PLAN_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name, args, call),
		}));
		// The asked turn ended without proposing commits (it failed, was stopped, or the agent declined).
		this._register(runtime.onDidEmit(({ sessionId, event }) => {
			if (event.type !== 'run.start' && event.type !== 'run.end') {
				return;
			}
			const chat = runtime.chatFor(sessionId);
			const draft = this.drafts.get(chat);
			if (!draft) {
				return;
			}
			if (event.type === 'run.start') {
				draft.runId ??= event.runId;
			} else if (draft.runId === event.runId) {
				this.stopDrafting(chat);
			}
		}));
	}

	setCapabilityCheck(check: (request: ICapabilityRequest) => void): void {
		this.check = check;
	}

	drafting(sessionId: string): boolean {
		return this.drafts.has(sessionId);
	}

	startDrafting(sessionId: string): void {
		if (this.pending(sessionId)) {
			return;
		}
		this.drafts.set(sessionId, {});
		this._onDidChange.fire(sessionId);
	}

	stopDrafting(sessionId: string): void {
		if (this.drafts.delete(sessionId)) {
			this._onDidChange.fire(sessionId);
		}
	}

	cancelDrafting(sessionId: string): void {
		if (this.drafts.has(sessionId)) {
			this.stoppedDrafts.add(sessionId);
		}
		this.stopDrafting(sessionId);
	}

	takeStoppedDraft(sessionId: string): boolean {
		return this.stoppedDrafts.delete(sessionId);
	}

	pending(sessionId: string): IAgentCommitPlan | undefined {
		for (const plan of this.plans.values()) {
			if (plan.sessionId === sessionId) {
				return plan;
			}
		}
		return undefined;
	}

	private find(planId: string, commitId: string): { plan: IAgentCommitPlan; commit: IAgentPlannedCommit } | undefined {
		const plan = this.plans.get(planId);
		const commit = plan?.commits.find(candidate => candidate.id === commitId);
		return plan && commit && !plan.busy ? { plan, commit } : undefined;
	}

	hunkContent(planId: string, commitId: string, path: string, side: 'before' | 'after'): string | undefined {
		const plan = this.plans.get(planId);
		const index = plan?.commits.findIndex(commit => commit.id === commitId) ?? -1;
		const base = plan?.bases.get(path);
		if (!plan || index < 0 || base === undefined) {
			return undefined;
		}
		const taken = new Set(plan.applied.get(path));
		for (const commit of plan.commits.slice(0, index)) {
			if (!commit.excluded.has(path)) {
				commit.parts[path]?.forEach(start => taken.add(start));
			}
		}
		const current = plan.commits[index];
		if (side === 'after' && !current.excluded.has(path)) {
			current.parts[path]?.forEach(start => taken.add(start));
		}
		return spliceHunks(base, (plan.hunks.get(path) ?? []).filter(hunk => taken.has(hunk.start)));
	}

	setIncluded(planId: string, commitId: string, path: string | undefined, included: boolean): void {
		const found = this.find(planId, commitId);
		if (!found) {
			return;
		}
		for (const file of path ? [path] : found.commit.paths) {
			if (included) {
				found.commit.excluded.delete(file);
			} else {
				found.commit.excluded.add(file);
			}
		}
		this._onDidChange.fire(found.plan.sessionId);
	}

	setMessage(planId: string, commitId: string, message: string): void {
		const found = this.find(planId, commitId);
		if (found && message.trim() && message !== found.commit.message) {
			found.commit.message = message.trim();
			this._onDidChange.fire(found.plan.sessionId);
		}
	}

	async regenerate(planId: string, commitId: string): Promise<void> {
		const found = this.find(planId, commitId);
		if (!found || found.commit.generating) {
			return;
		}
		const { plan, commit } = found;
		commit.generating = true;
		plan.notice = undefined;
		this._onDidChange.fire(plan.sessionId);
		try {
			this.check({ api: 'commitReview.regenerate', capability: 'git.read', target: plan.root });
			const message = (await this.pullRequests.generateCommitMessage(plan.root, plan.sessionId, this.commitPaths(plan, commit, true), commit.message))?.trim();
			if (message && message !== commit.message) {
				commit.message = message;
			} else {
				plan.notice = localize('voltCommitPlan.sameMessage', "No new message came back; the current one stays.");
			}
		} catch (err) {
			this.logService.warn('[volt-git] could not write a commit message', err);
			plan.notice = localize('voltCommitPlan.regenerateFailed', "Could not write a new message: {0}", voltPrErrorMessage(err));
		} finally {
			commit.generating = false;
			this._onDidChange.fire(plan.sessionId);
		}
	}

	/** The files to commit: the ones left in (a rename with the path it left), or every file with `all`. */
	private commitPaths(plan: IAgentCommitPlan, commit: IAgentPlannedCommit, allWhenNone = false): string[] {
		let paths = commit.paths.filter(path => !commit.excluded.has(path));
		if (!paths.length && allWhenNone) {
			paths = [...commit.paths];
		}
		return paths.flatMap(path => {
			const previous = plan.files.get(path)?.previousPath;
			return previous ? [path, previous] : [path];
		});
	}

	async commit(planId: string, options?: { readonly skipHooks?: boolean }): Promise<void> {
		const plan = this.plans.get(planId);
		if (!plan || plan.busy) {
			return;
		}
		const todo = plan.commits.filter(commit => commit.paths.some(path => !commit.excluded.has(path)));
		if (!todo.length) {
			return;
		}
		plan.error = undefined;
		plan.hookFailed = undefined;
		plan.notice = undefined;
		// The user's commit runs their git hooks: hooks or config an agent changed are shown first (I.6).
		if (!options?.skipHooks && !await reviewBuildEntries(this.dialogService, this.stdio, [plan.root], 'commit')) {
			plan.error = localize('voltCommitPlan.reviewDeclined', "Not committed: the git hooks or config changed while an agent worked here were not trusted.");
			this._onDidChange.fire(plan.sessionId);
			return;
		}
		const attribute = this.configurationService.getValue<boolean>(AGENT_COMMIT_ATTRIBUTION_SETTING) !== false;
		try {
			for (const [index, commit] of todo.entries()) {
				plan.busy = todo.length > 1
					? localize('voltCommitPlan.committingOf', "Committing {0} of {1}…", index + 1, todo.length)
					: localize('voltCommitPlan.committing', "Committing…");
				this._onDidChange.fire(plan.sessionId);
				const paths = this.commitPaths(plan, commit);
				let message = commit.message.trim();
				if (!message) {
					message = (await this.pullRequests.generateCommitMessage(plan.root, plan.sessionId, paths).catch(() => undefined))?.trim()
						|| localize('voltCommitPlan.fallbackMessage', "Update {0}", paths.map(path => path.split('/').pop()).slice(0, 3).join(', '));
				}
				const contents = await this.hunkContents(plan, commit, paths);
				this.check({ api: 'commitReview.commit', capability: 'git.write', target: plan.root });
				if (!options?.skipHooks) {
					// The repository's commit hooks run on the host.
					this.check({ api: 'commitReview.commit', capability: 'spawn.unsandboxed', target: plan.root });
				}
				const result = await this.pullRequests.api.commit({ folder: plan.root, message: attribute ? withCommitAttribution(message) : message, paths, ...(contents.length ? { contents } : {}), ...(options?.skipHooks ? { skipHooks: true } : {}) });
				for (const path of paths) {
					if (commit.parts[path]) {
						plan.applied.set(path, new Set([...(plan.applied.get(path) ?? []), ...commit.parts[path]]));
					}
				}
				const files = commit.paths.filter(path => !commit.excluded.has(path)).length;
				plan.done.push({ sha: result.sha, subject: result.subject, files });
				// What it committed leaves the plan; files left out of it stay, as their own leftovers.
				const kept = commit.paths.filter(path => commit.excluded.has(path));
				plan.commits.splice(plan.commits.indexOf(commit), 1);
				if (kept.length) {
					this.addLeftovers(plan, kept);
				}
			}
		} catch (err) {
			plan.busy = undefined;
			plan.error = voltPrErrorMessage(err);
			plan.hookFailed = voltPrErrorCode(err) === 'hookFailed';
			this.logService.warn('[volt-git] commit review stopped', plan.error);
			this._onDidChange.fire(plan.sessionId);
			return;
		}
		plan.busy = undefined;
		this.finish(plan, false);
	}

	/**
	 * What a commit holds of each file split by hunks: the hunks already in HEAD from earlier commits
	 * plus its own. HEAD must still hold exactly the earlier ones, or the file moved and nothing is made.
	 */
	private async hunkContents(plan: IAgentCommitPlan, commit: IAgentPlannedCommit, paths: readonly string[]): Promise<{ path: string; content: string }[]> {
		const contents: { path: string; content: string }[] = [];
		for (const path of paths) {
			const parts = commit.parts[path];
			if (!parts) {
				continue;
			}
			const base = plan.bases.get(path);
			const hunks = plan.hunks.get(path) ?? [];
			const applied = plan.applied.get(path) ?? new Set<number>();
			const head = await this.git.readBlob({ repoRoot: plan.root, sha: `HEAD:${path}`, path }).then(text => text.toString(), () => undefined);
			if (base === undefined || head !== spliceHunks(base, hunks.filter(hunk => applied.has(hunk.start)))) {
				throw new Error(localize('voltCommitPlan.headMoved', "{0} changed since the commits were proposed; nothing of this commit was made.", path));
			}
			contents.push({ path, content: spliceHunks(base, hunks.filter(hunk => applied.has(hunk.start) || parts.includes(hunk.start))) });
		}
		return contents;
	}

	/** Adds files to the plan's leftover group (made when first needed), unticked: they stay uncommitted. */
	private addLeftovers(plan: IAgentCommitPlan, paths: readonly string[]): void {
		let group = plan.commits.find(commit => commit.leftover);
		if (!group) {
			group = { id: generateUuid(), message: '', paths: [], excluded: new Set(), parts: {}, generating: false, leftover: true };
			plan.commits.push(group);
		}
		const list = group.paths as string[];
		for (const path of paths) {
			if (!list.includes(path)) {
				list.push(path);
				group.excluded.add(path);
			}
		}
	}

	dismiss(planId: string): void {
		const plan = this.plans.get(planId);
		if (plan && !plan.busy) {
			this.finish(plan, true);
		}
	}

	private finish(plan: IAgentCommitPlan, dismissed: boolean): void {
		this.plans.delete(plan.id);
		const uncommitted = plan.commits.flatMap(commit => commit.paths);
		const outcome: ICommitPlanOutcome = {
			committed: plan.done,
			uncommitted,
			...(plan.branch ? { branch: plan.branch } : {}),
			...(dismissed && !plan.done.length ? { dismissed: true } : {}),
			...(plan.error ? { error: plan.error } : {}),
		};
		const text = commitPlanOutcomeText(outcome);
		this.lastOutcomes.set(plan.sessionId, text);
		this.outcomes.get(plan.id)?.complete(text);
		this._onDidChange.fire(plan.sessionId);
	}

	//#region Agent tools

	/** Its tools' calls (the provider it registered, and the call that loaded the module). */
	async invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const sessionId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		if (!sessionId) {
			return { error: 'This tool needs a Volt chat.' };
		}
		try {
			switch (name) {
				case PROPOSE_COMMITS_TOOL_NAME: return await this.propose(sessionId, args, call?.token);
				case AWAIT_COMMITS_TOOL_NAME: return await this.await(sessionId, typeof args.plan_id === 'string' ? args.plan_id : '', call?.token);
				case RENAME_BRANCH_TOOL_NAME: return await this.renameBranch(sessionId, typeof args.name === 'string' ? args.name : '');
				default: return { error: `Unknown tool ${name}` };
			}
		} catch (err) {
			return { error: voltPrErrorMessage(err) };
		}
	}

	private async propose(sessionId: string, args: Record<string, unknown>, token: CancellationToken | undefined): Promise<IVoltHostToolResult> {
		const folder = this.pullRequests.folderFor(sessionId);
		this.check({ api: 'commitReview.propose', capability: 'git.read', ...(folder ? { target: folder } : {}) });
		const status = folder ? await this.pullRequests.api.gitStatus(folder) : undefined;
		if (!status) {
			return { error: 'This chat is not in a git repository.' };
		}
		if (status.files.some(file => file.status === 'conflicted')) {
			return { error: 'Resolve the merge conflicts first; nothing can be committed while files conflict.' };
		}
		const hunkFiles = [...new Set(hunkFilesOf(args).map(name => normalizePlanPath(name, status.root)))];
		const { hunks, bases } = await this.readHunks(status.root, hunkFiles);
		const parsed = parseCommitPlan(args, status.root, status.files, hunks);
		if ('error' in parsed) {
			return { error: parsed.error };
		}
		// The same commits again (an agent retrying the call while the user reviews) keep the review
		// and what the user changed in it; other commits replace it (one review per chat).
		const previous = this.pending(sessionId);
		const proposal = JSON.stringify(parsed.commits);
		if (previous && previous.proposal === proposal) {
			return this.await(sessionId, previous.id, token);
		}
		if (previous && !previous.busy) {
			this.plans.delete(previous.id);
			this.outcomes.get(previous.id)?.complete('A newer propose_commits call replaced this plan; nothing of it was committed.');
		}
		const plan: IAgentCommitPlan = {
			id: generateUuid(),
			sessionId,
			root: status.root,
			branch: status.branch,
			files: new Map(status.files.map(file => [file.path, file])),
			proposal,
			commits: parsed.commits.map(commit => ({ id: generateUuid(), message: commit.message, paths: [...commit.paths], excluded: new Set<string>(), parts: commit.parts, generating: false, leftover: false })),
			hunks,
			bases,
			applied: new Map(),
			done: [],
		};
		if (parsed.leftover.length) {
			plan.commits.push({ id: generateUuid(), message: '', paths: [...parsed.leftover], excluded: new Set(parsed.leftover), parts: {}, generating: false, leftover: true });
		}
		this.drafts.delete(sessionId);
		this.plans.set(plan.id, plan);
		this.outcomes.set(plan.id, new DeferredPromise<string>());
		this._onDidChange.fire(sessionId);
		return this.await(sessionId, plan.id, token);
	}

	/** The hunks of the named files against HEAD, and each file's HEAD text; a file without text hunks is left out. */
	private async readHunks(root: string, names: readonly string[]): Promise<{ hunks: Map<string, IPlanHunk[]>; bases: Map<string, string> }> {
		const hunks = new Map<string, IPlanHunk[]>();
		const bases = new Map<string, string>();
		if (!names.length) {
			return { hunks, bases };
		}
		const summary = await this.pullRequests.api.describeChanges({ folder: root, paths: names });
		await Promise.all([...parseHunks(summary.patch)].map(async ([path, list]) => {
			const base = list.length ? await this.git.readBlob({ repoRoot: root, sha: `HEAD:${path}`, path }).then(text => text.toString(), () => undefined) : undefined;
			if (base !== undefined) {
				hunks.set(path, list);
				bases.set(path, base);
			}
		}));
		return { hunks, bases };
	}

	/** Waits a little under the agents' MCP timeout, then tells the agent to call again. */
	private async await(sessionId: string, requested: string, token: CancellationToken | undefined): Promise<IVoltHostToolResult> {
		// An id the agent kept from an earlier call: the chat's open review, or how its last one ended.
		let planId = requested;
		if (!this.outcomes.has(planId)) {
			const open = this.pending(sessionId);
			if (open) {
				planId = open.id;
			} else {
				const last = this.lastOutcomes.get(sessionId);
				return last ? { text: `That commit review has ended. ${last}` } : { error: `No commit review with plan_id ${requested}.` };
			}
		}
		const outcome = this.outcomes.get(planId)!;
		const text = await raceCancellation(Promise.race([outcome.p, timeout(PLAN_POLL_MS).then(() => undefined)]), token ?? CancellationToken.None);
		if (text === undefined) {
			return { text: `STILL WAITING: the user is reviewing the commits (plan_id: ${planId}). Call the \`${AWAIT_COMMITS_TOOL_NAME}\` tool with this plan_id now to keep waiting. Do not commit yourself, do not continue, and do not end your turn.` };
		}
		this.outcomes.delete(planId);
		return { text };
	}

	private async renameBranch(sessionId: string, requested: string): Promise<IVoltHostToolResult> {
		const name = normalizeBranchName(requested);
		if (!name) {
			return { error: 'Pass the new branch `name`.' };
		}
		const folder = this.pullRequests.folderFor(sessionId);
		const status = folder ? await this.pullRequests.api.gitStatus(folder) : undefined;
		if (!folder || !status) {
			return { error: 'This chat is not in a git repository.' };
		}
		// git branch -m runs the repository's hooks on the host.
		this.check({ api: 'commitReview.renameBranch', capability: 'git.write', target: folder });
		this.check({ api: 'commitReview.renameBranch', capability: 'spawn.unsandboxed', target: folder });
		const { previous, branch } = await this.pullRequests.api.renameBranch({ folder, name });
		// Chats working in this checkout follow the branch (the worktree pill, cleanup, forks).
		followWorktreeBranch(this.history, this.runtime, status.root, branch);
		const plan = this.pending(sessionId);
		if (plan) {
			(plan as { branch: string | undefined }).branch = branch;
		}
		return {
			text: previous === branch
				? `The branch is already called ${branch}.`
				: `Renamed ${previous} to ${branch}. It has no upstream yet: push it with \`git push -u ${status.remote ?? 'origin'} ${branch}\` (or open the pull request, which pushes it).`,
		};
	}

	//#endregion
}
