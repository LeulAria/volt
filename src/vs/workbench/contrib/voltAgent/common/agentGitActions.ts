/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IVoltGitStatus } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { showsPullRequests } from './agentPullRequests.js';

/**
 * Commit, push and open a pull request in one step, like T3 Code's git actions control: the button
 * offers the next useful step for where the branch stands, the menu offers each step on its own.
 */
export type AgentGitAction = 'commit' | 'push' | 'createPr' | 'commitPush' | 'commitPushPr';

export interface IAgentGitQuickAction {
	readonly label: string;
	readonly disabled: boolean;
	readonly kind: 'run' | 'pull' | 'hint';
	readonly action?: AgentGitAction;
	/** Why nothing runs (disabled), shown as the tooltip. */
	readonly hint?: string;
}

export interface IAgentGitMenuItem {
	readonly id: 'commit' | 'push' | 'createPr';
	readonly label: string;
	readonly disabled: boolean;
	/** Why it is disabled. */
	readonly hint?: string;
}

/** What the controls need besides the work tree: whether the branch has an open pull request. */
export interface IAgentGitContext {
	readonly status: IVoltGitStatus | undefined;
	readonly hasOpenPr: boolean;
	readonly busy: boolean;
	/** The branch's pull request already merged or closed at the commit checked out: nothing new to open. */
	readonly landedPr?: { readonly number: number; readonly state: 'merged' | 'closed' };
}

function landedHint(landed: NonNullable<IAgentGitContext['landedPr']>): string {
	return landed.state === 'merged'
		? localize('voltGit.landedMerged', "#{0} merged this branch. Commit something new to open another pull request.", landed.number)
		: localize('voltGit.landedClosed', "#{0} was closed with this branch as it is. Commit something new, or reopen it.", landed.number);
}

function hasChanges(status: IVoltGitStatus): boolean {
	return status.files.length > 0;
}

function hasConflicts(status: IVoltGitStatus): boolean {
	return status.files.some(file => file.status === 'conflicted');
}

function aheadOfDefault(status: IVoltGitStatus): number {
	return status.aheadOfDefault ?? status.ahead;
}

export function resolveQuickAction({ status, hasOpenPr, busy, landedPr }: IAgentGitContext): IAgentGitQuickAction {
	const commit = localize('voltGit.commit', "Commit");
	if (busy) {
		return { label: commit, disabled: true, kind: 'hint', hint: localize('voltGit.busy', "A git action is running.") };
	}
	if (!status) {
		return { label: commit, disabled: true, kind: 'hint', hint: localize('voltGit.noStatus', "This folder is not a git repository.") };
	}
	if (!status.branch) {
		return { label: commit, disabled: true, kind: 'hint', hint: localize('voltGit.detached', "Check out a branch before committing or opening a pull request.") };
	}
	const hasRemote = !!status.remote;
	// Without an `origin` remote the steps stop at the push: no pull request to open.
	const noPr = hasOpenPr || status.isDefaultBranch || !showsPullRequests(status.remotes);
	const isAhead = status.ahead > 0;
	const isBehind = status.behind > 0;
	// Committing now would record the conflict markers as resolved.
	if (hasConflicts(status)) {
		return { label: commit, disabled: true, kind: 'hint', hint: localize('voltGit.conflicts', "Resolve the merge conflicts first.") };
	}
	if (hasChanges(status)) {
		if (!hasRemote) {
			return { label: commit, disabled: false, kind: 'run', action: 'commit' };
		}
		if (noPr) {
			return { label: localize('voltGit.commitPush', "Commit & Push"), disabled: false, kind: 'run', action: 'commitPush' };
		}
		return { label: localize('voltGit.commitPushPr', "Commit, Push & PR"), disabled: false, kind: 'run', action: 'commitPushPr' };
	}
	// The checked out commit is what a merged or closed pull request already had: nothing to push or open.
	if (landedPr && !isBehind) {
		return { label: commit, disabled: true, kind: 'hint', hint: landedHint(landedPr) };
	}
	if (!status.upstream) {
		if (!hasRemote) {
			return { label: commit, disabled: true, kind: 'hint', hint: localize('voltGit.noRemote', "This repository has no remote to push to.") };
		}
		const ahead = aheadOfDefault(status);
		if (!ahead) {
			return { label: localize('voltGit.push', "Push"), disabled: true, kind: 'hint', hint: localize('voltGit.nothingToPush', "No local commits to push.") };
		}
		if (noPr) {
			return { label: localize('voltGit.push', "Push"), disabled: false, kind: 'run', action: 'push' };
		}
		return { label: localize('voltGit.pushPr', "Push & Create PR"), disabled: false, kind: 'run', action: 'createPr' };
	}
	if (isAhead && isBehind) {
		return { label: localize('voltGit.sync', "Sync Branch"), disabled: true, kind: 'hint', hint: localize('voltGit.diverged', "The branch and its upstream have diverged. Rebase or merge first.") };
	}
	if (isBehind) {
		return { label: localize('voltGit.pull', "Pull"), disabled: false, kind: 'pull' };
	}
	if (isAhead) {
		if (noPr) {
			return { label: localize('voltGit.push', "Push"), disabled: false, kind: 'run', action: 'push' };
		}
		return { label: localize('voltGit.pushPr', "Push & Create PR"), disabled: false, kind: 'run', action: 'createPr' };
	}
	if (!noPr && aheadOfDefault(status) > 0) {
		return { label: localize('voltGit.createPr', "Create PR"), disabled: false, kind: 'run', action: 'createPr' };
	}
	return { label: commit, disabled: true, kind: 'hint', hint: localize('voltGit.upToDate', "The branch is up to date. Nothing to do.") };
}

export function buildMenuItems({ status, hasOpenPr, busy, landedPr }: IAgentGitContext): IAgentGitMenuItem[] {
	if (!status) {
		return [];
	}
	const changes = hasChanges(status);
	const hasRemote = !!status.remote;
	const isBehind = status.behind > 0;
	const canPushSomewhere = hasRemote && !!status.branch && !isBehind;
	const commitHint = busy ? localize('voltGit.busy', "A git action is running.")
		: !changes ? localize('voltGit.clean', "No changes to commit.")
			: hasConflicts(status) ? localize('voltGit.conflicts', "Resolve the merge conflicts first.")
				: undefined;
	const items: IAgentGitMenuItem[] = [{ id: 'commit', label: localize('voltGit.commitMenu', "Commit…"), disabled: !!commitHint, ...(commitHint ? { hint: commitHint } : {}) }];
	if (!hasRemote) {
		return items;
	}
	const pushHint = busy ? localize('voltGit.busy', "A git action is running.")
		: !status.branch ? localize('voltGit.detachedShort', "HEAD is detached.")
			: isBehind ? localize('voltGit.behind', "The branch is behind its upstream. Pull first.")
				: changes && !status.ahead && status.upstream ? localize('voltGit.commitFirst', "Commit the changes first.")
					: status.upstream && !status.ahead ? localize('voltGit.nothingToPush', "No local commits to push.")
						: !status.upstream && !aheadOfDefault(status) ? localize('voltGit.nothingToPush', "No local commits to push.")
							: undefined;
	items.push({ id: 'push', label: localize('voltGit.push', "Push"), disabled: !!pushHint, ...(pushHint ? { hint: pushHint } : {}) });
	if (hasOpenPr || !showsPullRequests(status.remotes)) {
		return items;
	}
	const prHint = busy ? localize('voltGit.busy', "A git action is running.")
		: !canPushSomewhere ? (isBehind ? localize('voltGit.behind', "The branch is behind its upstream. Pull first.") : localize('voltGit.detachedShort', "HEAD is detached."))
			: changes ? localize('voltGit.commitBeforePr', "Commit the changes first, or use Commit, Push & PR.")
				: status.isDefaultBranch ? localize('voltGit.prFromDefault', "Pull requests are opened from a feature branch.")
					: landedPr && !status.ahead ? landedHint(landedPr)
						: !aheadOfDefault(status) ? localize('voltGit.nothingForPr', "The branch has no commits that {0} does not.", status.defaultBranch ?? 'main')
							: undefined;
	items.push({ id: 'createPr', label: localize('voltGit.createPr', "Create PR"), disabled: !!prHint, ...(prHint ? { hint: prHint } : {}) });
	return items;
}

/** Pushing or opening a pull request from the default branch asks first, like T3 Code. */
export function requiresDefaultBranchConfirmation(action: AgentGitAction, status: IVoltGitStatus | undefined): boolean {
	return !!status?.isDefaultBranch && action !== 'commit';
}

export interface IDefaultBranchPromptCopy {
	readonly message: string;
	readonly detail: string;
	readonly continueLabel: string;
	readonly featureLabel: string;
}

export function defaultBranchPromptCopy(action: AgentGitAction, branch: string, includesCommit: boolean): IDefaultBranchPromptCopy {
	const detail = localize('voltGit.defaultDetail', "This runs on \"{0}\", the default branch. Continue on it, or check out a feature branch and run the same steps there.", branch);
	const featureLabel = localize('voltGit.featureContinue', "Check Out a Feature Branch");
	if (action === 'push' || action === 'commitPush') {
		return includesCommit
			? { message: localize('voltGit.defaultCommitPush', "Commit and push to {0}?", branch), detail, continueLabel: localize('voltGit.defaultCommitPushButton', "Commit and Push to {0}", branch), featureLabel }
			: { message: localize('voltGit.defaultPush', "Push to {0}?", branch), detail, continueLabel: localize('voltGit.defaultPushButton', "Push to {0}", branch), featureLabel };
	}
	return includesCommit
		? { message: localize('voltGit.defaultCommitPushPr', "Commit, push and open a pull request from {0}?", branch), detail, continueLabel: localize('voltGit.defaultCommitPushPrButton', "Commit, Push and Create PR"), featureLabel }
		: { message: localize('voltGit.defaultPushPr', "Push and open a pull request from {0}?", branch), detail, continueLabel: localize('voltGit.defaultPushPrButton', "Push and Create PR"), featureLabel };
}

export function actionIncludesCommit(action: AgentGitAction, status: IVoltGitStatus | undefined): boolean {
	return action === 'commit' || ((action === 'commitPush' || action === 'commitPushPr') && !!status && hasChanges(status));
}

export function actionIncludesPush(action: AgentGitAction): boolean {
	return action !== 'commit';
}

export function actionIncludesPr(action: AgentGitAction): boolean {
	return action === 'createPr' || action === 'commitPushPr';
}

/** A branch name for the work, from the commit subject: `volt/add-word-counts`, made unique against `existing`. */
export function featureBranchName(subject: string | undefined, existing: readonly string[]): string {
	const slug = (subject ?? '')
		.toLowerCase()
		.replace(/^(feat|fix|chore|docs|refactor|test|perf|build|ci|style)(\([^)]*\))?!?:\s*/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.split('-')
		.filter(Boolean)
		.slice(0, 6)
		.join('-');
	const base = `volt/${slug || 'changes'}`;
	const taken = new Set(existing.map(name => name.toLowerCase()));
	if (!taken.has(base)) {
		return base;
	}
	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) {
		suffix++;
	}
	return `${base}-${suffix}`;
}

export interface IAgentGitActionResult {
	readonly commit?: { readonly sha: string; readonly subject: string };
	readonly pushed?: { readonly branch: string; readonly remote: string };
	readonly pr?: { readonly number: number; readonly url: string; readonly existing: boolean };
	readonly branchCreated?: string;
}

/** The toast after an action: what happened, and the next step to offer. */
export function summarizeResult(result: IAgentGitActionResult): { readonly title: string; readonly detail?: string; readonly next?: 'push' | 'createPr' | 'viewPr' } {
	if (result.pr) {
		return {
			title: result.pr.existing ? localize('voltGit.done.openedPr', "Opened PR #{0}", result.pr.number) : localize('voltGit.done.createdPr', "Created PR #{0}", result.pr.number),
			...(result.commit ? { detail: result.commit.subject } : {}),
			next: 'viewPr',
		};
	}
	if (result.pushed) {
		return {
			title: result.commit
				? localize('voltGit.done.committedPushed', "Committed {0} and pushed to {1}", result.commit.sha.slice(0, 7), result.pushed.branch)
				: localize('voltGit.done.pushed', "Pushed {0}", result.pushed.branch),
			...(result.commit ? { detail: result.commit.subject } : {}),
			next: 'createPr',
		};
	}
	if (result.commit) {
		return { title: localize('voltGit.done.committed', "Committed {0}", result.commit.sha.slice(0, 7)), detail: result.commit.subject, next: 'push' };
	}
	return { title: localize('voltGit.done.nothing', "Nothing to do") };
}
