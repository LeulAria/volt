/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceCancellation, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltGitStatusFile, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import {
	AWAIT_COMMITS_TOOL_NAME,
	commitPlanOutcomeText,
	ICommitPlanOutcome,
	normalizeBranchName,
	parseCommitPlan,
	PROPOSE_COMMITS_TOOL_NAME,
	RENAME_BRANCH_TOOL_NAME,
} from '../../common/agentCommitPlan.js';
import { AGENT_COMMIT_ATTRIBUTION_SETTING, withCommitAttribution } from '../../common/agentGitSettings.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { followWorktreeBranch } from './agentWorktreeBranch.js';

export const IAgentCommitPlanService = createDecorator<IAgentCommitPlanService>('agentCommitPlanService');

/** One proposed commit of a plan. The review edits it in place and fires a change. */
export interface IAgentPlannedCommit {
	readonly id: string;
	message: string;
	readonly paths: readonly string[];
	/** Files of this commit the user left out. */
	readonly excluded: Set<string>;
	/** A new message is being written for it. */
	generating: boolean;
	/** The changed files no commit took: left out until the user ticks them. */
	readonly leftover: boolean;
}

export interface IAgentCommitPlan {
	readonly id: string;
	readonly sessionId: string;
	/** The repository's top folder; plan paths are relative to it. */
	readonly root: string;
	readonly branch: string | undefined;
	readonly files: ReadonlyMap<string, IVoltGitStatusFile>;
	/** The commits as the agent proposed them, to recognize the same call again. */
	readonly proposal: string;
	readonly commits: IAgentPlannedCommit[];
	/** Committing is under way: the review shows progress and takes no edits. */
	busy?: string;
	/** Why the last Commit stopped; the commits before it are in and gone from the plan. */
	error?: string;
	/** A passing note for the footer (a regenerate that brought nothing new). */
	notice?: string;
	/** What was committed so far, for the agent's answer. */
	readonly done: { sha: string; subject: string; files: number }[];
}

export interface IAgentCommitPlanService {
	readonly _serviceBrand: undefined;
	/** A chat's plan appeared, changed or ended. */
	readonly onDidChange: Event<string>;
	pending(sessionId: string): IAgentCommitPlan | undefined;
	setIncluded(planId: string, commitId: string, path: string | undefined, included: boolean): void;
	setMessage(planId: string, commitId: string, message: string): void;
	/** Writes a new message for the commit's files (the ones left in, or all when none are). */
	regenerate(planId: string, commitId: string): Promise<void>;
	/** Commits every commit with a file left in, in order, then tells the agent. */
	commit(planId: string): Promise<void>;
	/** Closes the review without committing what is left. */
	dismiss(planId: string): void;
}

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

	constructor(
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: COMMIT_PLAN_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name, args, call),
		}));
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

	async commit(planId: string): Promise<void> {
		const plan = this.plans.get(planId);
		if (!plan || plan.busy) {
			return;
		}
		const todo = plan.commits.filter(commit => commit.paths.some(path => !commit.excluded.has(path)));
		if (!todo.length) {
			return;
		}
		plan.error = undefined;
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
				const result = await this.pullRequests.api.commit({ folder: plan.root, message: attribute ? withCommitAttribution(message) : message, paths });
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
			this._onDidChange.fire(plan.sessionId);
			return;
		}
		plan.busy = undefined;
		this.finish(plan, false);
	}

	/** Adds files to the plan's leftover group (made when first needed), unticked: they stay uncommitted. */
	private addLeftovers(plan: IAgentCommitPlan, paths: readonly string[]): void {
		let group = plan.commits.find(commit => commit.leftover);
		if (!group) {
			group = { id: generateUuid(), message: '', paths: [], excluded: new Set(), generating: false, leftover: true };
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

	private async invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
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
		const status = folder ? await this.pullRequests.api.gitStatus(folder) : undefined;
		if (!status) {
			return { error: 'This chat is not in a git repository.' };
		}
		if (status.files.some(file => file.status === 'conflicted')) {
			return { error: 'Resolve the merge conflicts first; nothing can be committed while files conflict.' };
		}
		const parsed = parseCommitPlan(args, status.root, status.files);
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
			commits: parsed.commits.map(commit => ({ id: generateUuid(), message: commit.message, paths: [...commit.paths], excluded: new Set<string>(), generating: false, leftover: false })),
			done: [],
		};
		if (parsed.leftover.length) {
			plan.commits.push({ id: generateUuid(), message: '', paths: [...parsed.leftover], excluded: new Set(parsed.leftover), generating: false, leftover: true });
		}
		this.plans.set(plan.id, plan);
		this.outcomes.set(plan.id, new DeferredPromise<string>());
		this._onDidChange.fire(sessionId);
		return this.await(sessionId, plan.id, token);
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

export const COMMIT_PLAN_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: PROPOSE_COMMITS_TOOL_NAME,
		title: 'Proposed commits',
		group: 'pullRequests',
		description: 'Commit the working tree as a series of meaningful commits that the user reviews first. Use it whenever the user asks you to commit (instead of running git commit yourself). Read `git status` and the diff, then group the changed files into commits that each do one thing, in the order they should land, each with a Conventional Commits message: type(scope): summary, type one of feat, fix, refactor, perf, docs, test, style, build, ci, chore (e.g. feat(cart): apply discount at checkout), under 72 characters, with a body after a blank line when it helps. Volt shows the commits above the composer: the user opens each one\'s files and diffs, ticks commits or files out, edits or regenerates messages, and commits them. Volt makes the commits and the call returns what was committed. A file can be in one commit only; changed files you leave out of every commit are offered unticked. The call waits for the user; if it returns STILL WAITING, call await_commits with the plan_id and keep calling it until the review ends. Never end your turn while the review is open.',
		inputSchema: {
			type: 'object',
			properties: {
				commits: {
					type: 'array',
					description: 'The commits, in the order they should be made.',
					items: {
						type: 'object',
						properties: {
							message: { type: 'string', description: 'The commit message: a subject line, then optionally a blank line and a body.' },
							files: { type: 'array', items: { type: 'string' }, description: 'Changed files of this commit, relative to the repository root as `git status` lists them.' },
						},
						required: ['message', 'files'],
					},
				},
			},
			required: ['commits'],
		},
	},
	{
		name: AWAIT_COMMITS_TOOL_NAME,
		title: 'Waiting for commit review',
		group: 'pullRequests',
		description: 'Keep waiting for the user to finish reviewing the commits of a propose_commits call. Returns what was committed, or STILL WAITING (call it again).',
		inputSchema: { type: 'object', properties: { plan_id: { type: 'string', description: 'The plan_id from propose_commits.' } }, required: ['plan_id'] },
	},
	{
		name: RENAME_BRANCH_TOOL_NAME,
		title: 'Renamed branch',
		group: 'pullRequests',
		description: 'Rename the checked out branch. A worktree chat starts on a placeholder branch (volt/ and 8 hex characters, like volt/f7175242). Before you push it or open a pull request from it, ask the user what to call it with ask_question: one question offering 4 names you suggest from the changes, each type/short-kebab-summary with type feat, fix, refactor, perf, docs, test or chore (like feat/commit-review or fix/image-row-overflow; the user can also type their own), then call this with their answer. If the name is taken, ask again with others. Volt keeps the chat\'s worktree on the renamed branch and drops an upstream under the old name.',
		inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The new branch name, e.g. feat/commit-review.' } }, required: ['name'] },
	},
];
