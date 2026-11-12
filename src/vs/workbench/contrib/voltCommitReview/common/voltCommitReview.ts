/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltGitStatusFile } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IVoltHostToolInfo } from '../../../services/voltRuntime/common/hostTools.js';
import { AWAIT_COMMITS_TOOL_NAME, IPlanHunk, PROPOSE_COMMITS_TOOL_NAME, RENAME_BRANCH_TOOL_NAME } from './agentCommitPlan.js';

/**
 * The commit review's contract (the `volt.commit-review` built-in extension's module): what code
 * outside `contrib/voltCommitReview/` may use. Core loads the module through
 * `IVoltFeatureModuleService` (its first tool call, or a chat's Draft Commits) and reaches the
 * review only through `ICommitReviewModule`.
 */

/** `voltModule.feature` of `extensions/volt-commit-review`. */
export const COMMIT_REVIEW_FEATURE_ID = 'commitReview';

/** What the loaded module gives core. */
export interface ICommitReviewModule {
	/** The commit plans of every chat (the module's own service, alive while it is loaded). */
	readonly plans: IAgentCommitPlanService;
}

export const IAgentCommitPlanService = createDecorator<IAgentCommitPlanService>('agentCommitPlanService');

/** One proposed commit of a plan. The review edits it in place and fires a change. */
export interface IAgentPlannedCommit {
	readonly id: string;
	message: string;
	readonly paths: readonly string[];
	/** Files of this commit the user left out. */
	readonly excluded: Set<string>;
	/** For files split by hunks: the hunks (their `start`) this commit takes. */
	readonly parts: Readonly<Record<string, readonly number[]>>;
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
	/** The hunks of each file split by hunks, as the diff against HEAD showed them when proposed. */
	readonly hunks: ReadonlyMap<string, readonly IPlanHunk[]>;
	/** Each such file's HEAD text when proposed: the hunks apply to it. */
	readonly bases: ReadonlyMap<string, string>;
	/** The hunks (their `start`) of each file already committed by earlier commits of the plan. */
	readonly applied: Map<string, Set<number>>;
	/** Committing is under way: the review shows progress and takes no edits. */
	busy?: string;
	/** Why the last Commit stopped; the commits before it are in and gone from the plan. */
	error?: string;
	/** The last Commit was stopped by a commit hook: the review offers to commit without hooks. */
	hookFailed?: boolean;
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
	/** The chat asked its agent for draft commits and none have come yet: the review shows that it is coming. */
	drafting(sessionId: string): boolean;
	/** Shows the review in its "generating" state until the agent proposes commits or its turn ends. */
	startDrafting(sessionId: string): void;
	stopDrafting(sessionId: string): void;
	/** The user stopped the drafting: the chat's turn goes with it (see `takeStoppedDraft`). */
	cancelDrafting(sessionId: string): void;
	/** True once, when the user stopped a draft whose turn has now ended. */
	takeStoppedDraft(sessionId: string): boolean;
	setIncluded(planId: string, commitId: string, path: string | undefined, included: boolean): void;
	setMessage(planId: string, commitId: string, message: string): void;
	/** Writes a new message for the commit's files (the ones left in, or all when none are). */
	regenerate(planId: string, commitId: string): Promise<void>;
	/** Commits every commit with a file left in, in order, then tells the agent. `skipHooks` commits with `--no-verify`. */
	commit(planId: string, options?: { readonly skipHooks?: boolean }): Promise<void>;
	/** Closes the review without committing what is left. */
	dismiss(planId: string): void;
	/** The text of a file split by hunks before or after one commit of the plan (its diff in the review). */
	hunkContent(planId: string, commitId: string, path: string, side: 'before' | 'after'): string | undefined;
}

/** The tools the module serves; core lists them (stubs) until it is loaded. */
export const COMMIT_PLAN_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: PROPOSE_COMMITS_TOOL_NAME,
		title: 'Proposed commits',
		group: 'pullRequests',
		description: 'Commit the working tree as commits the user reviews first. Use it only when the user asks to review the commits before they are made: draft commits, /draft-commit, "split into commits for me to review", or a Volt commit button that names this tool. A plain "commit", "commit and push" or "commit and open a PR" does not: then run git commit yourself. Read `git status` and the diff, then group the changed files into commits that each do one thing, in the order they should land; when the changes are one change or belong together, propose a single commit, and split only where they really are separate changes. Each commit gets a Conventional Commits message: type(scope): summary, type one of feat, fix, refactor, perf, docs, test, style, build, ci, chore (e.g. feat(cart): apply discount at checkout), under 72 characters, with a body after a blank line when it helps. Volt shows the commits above the composer: the user opens each one\'s files and diffs, ticks commits or files out, edits or regenerates messages, and commits them. Volt makes the commits and the call returns what was committed. A file can be in one commit only (whole, or split by hunks as above); changed files you leave out of every commit are offered unticked. A file that holds changes for two commits can be split by hunks: list it under `hunks` in each commit with the hunk numbers (the N of each `@@ -a,b +N,c @@` header of `git diff HEAD -- file`). Every hunk of it must be listed in some commit or it stays uncommitted. Only tracked files with text changes can be split that way; new, untracked, renamed and deleted files go whole under `files`. The call waits for the user; if it returns STILL WAITING, call await_commits with the plan_id and keep calling it until the review ends. Never end your turn while the review is open.',
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
							hunks: {
								type: 'array',
								description: 'Files split by hunks: the hunks of each file this commit takes.',
								items: {
									type: 'object',
									properties: {
										file: { type: 'string', description: 'The file, relative to the repository root.' },
										lines: { type: 'array', items: { type: 'number' }, description: 'The N of each hunk header (`@@ -a,b +N,c @@`) of `git diff HEAD -- file` that this commit takes.' },
									},
									required: ['file', 'lines'],
								},
							},
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
