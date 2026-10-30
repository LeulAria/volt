/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltGitStatusFile } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';

/**
 * A commit plan: the agent splits the working tree's changes into commits (propose_commits), the
 * user reviews them above the composer (files, diffs, messages, what to leave out), and Volt
 * commits them in order.
 */

export const PROPOSE_COMMITS_TOOL_NAME = 'propose_commits';
export const AWAIT_COMMITS_TOOL_NAME = 'await_commits';
export const RENAME_BRANCH_TOOL_NAME = 'rename_branch';

export interface IAgentCommitPlanGroup {
	readonly message: string;
	/** Paths relative to the repository root, as `git status` names them (a rename by its new path). */
	readonly paths: readonly string[];
}

export interface IParsedCommitPlan {
	readonly commits: readonly IAgentCommitPlanGroup[];
	/** Changed files no commit took: they stay uncommitted unless the user adds them. */
	readonly leftover: readonly string[];
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** `./a/b.ts`, `a\b.ts` and `<root>/a/b.ts` are all `a/b.ts`. */
export function normalizePlanPath(path: string, root: string): string {
	let value = path.trim().replace(/\\/g, '/');
	const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
	if (base && (value === base || value.startsWith(`${base}/`))) {
		value = value.slice(base.length + 1);
	}
	return value.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/**
 * Checks a propose_commits call against the working tree: every commit has a message and at least
 * one changed file, no file is in two commits, and every file is one `git status` lists (a renamed
 * file may be named by either path). The error says what to fix and lists the changed files.
 */
export function parseCommitPlan(args: Record<string, unknown>, root: string, files: readonly IVoltGitStatusFile[]): IParsedCommitPlan | { readonly error: string } {
	const raw = Array.isArray(args.commits) ? args.commits : undefined;
	const changed = files.map(file => file.path);
	const listing = () => changed.length
		? `The changed files are: ${changed.slice(0, 60).join(', ')}${changed.length > 60 ? `, and ${changed.length - 60} more` : ''}.`
		: 'There are no uncommitted changes.';
	if (!files.length) {
		return { error: 'There is nothing to commit: the working tree has no changes.' };
	}
	if (!raw?.length) {
		return { error: `Pass \`commits\`: a list of { message, files }. ${listing()}` };
	}
	const byPath = new Map<string, string>();
	for (const file of files) {
		byPath.set(file.path, file.path);
		if (file.previousPath) {
			byPath.set(file.previousPath, file.path);
		}
	}
	const taken = new Map<string, number>();
	const commits: IAgentCommitPlanGroup[] = [];
	for (const [index, item] of raw.entries()) {
		const rec = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		const message = str(rec.message).trim();
		if (!message) {
			return { error: `Commit ${index + 1} has no \`message\`.` };
		}
		const list = Array.isArray(rec.files) ? rec.files : Array.isArray(rec.paths) ? rec.paths : [];
		const paths: string[] = [];
		const unknown: string[] = [];
		for (const entry of list) {
			const name = normalizePlanPath(str(entry), root);
			if (!name) {
				continue;
			}
			const path = byPath.get(name);
			if (!path) {
				unknown.push(name);
				continue;
			}
			const other = taken.get(path);
			if (other !== undefined && other !== index) {
				return { error: `${path} is in commit ${other + 1} and commit ${index + 1}; a file can be in one commit only.` };
			}
			if (other === undefined) {
				taken.set(path, index);
				paths.push(path);
			}
		}
		if (unknown.length) {
			return { error: `Commit ${index + 1} names files that have no uncommitted changes: ${unknown.slice(0, 10).join(', ')}. ${listing()}` };
		}
		if (!paths.length) {
			return { error: `Commit ${index + 1} ("${message.split('\n')[0]}") has no \`files\`. ${listing()}` };
		}
		commits.push({ message, paths });
	}
	return { commits, leftover: changed.filter(path => !taken.has(path)) };
}

/** A commit message's first line and the rest, the way the review shows them. */
export function splitCommitMessage(message: string): { readonly subject: string; readonly body: string } {
	const text = message.replace(/\r\n/g, '\n').trim();
	const newline = text.indexOf('\n');
	return newline < 0 ? { subject: text, body: '' } : { subject: text.slice(0, newline).trim(), body: text.slice(newline + 1).trim() };
}

/** A branch name the user typed or picked: spaces become dashes, and no leading `refs/heads/`. */
export function normalizeBranchName(name: string): string {
	return name.trim().replace(/^refs\/heads\//, '').replace(/\s+/g, '-');
}

/** The name a Volt worktree starts on: `volt/` and 8 hex characters. */
export function isPlaceholderBranch(branch: string | undefined): boolean {
	return !!branch && /^volt\/[0-9a-f]{8}$/.test(branch);
}

/** The reminder that goes back to the agent whenever its branch still has a placeholder name. */
export function placeholderBranchNote(branch: string): string {
	return `The branch ${branch} still has a placeholder name. Before you push it or open a pull request, ask the user what to call it with ask_question (one question, 4 names you suggest from the changes as type/short-kebab-summary with type feat, fix, refactor, perf, docs, test or chore, e.g. feat/cart-discounts; they can type their own), then call ${RENAME_BRANCH_TOOL_NAME} with their choice.`;
}

export interface ICommitPlanOutcome {
	readonly committed: readonly { readonly sha: string; readonly subject: string; readonly files: number }[];
	/** Changes that stayed in the working tree. */
	readonly uncommitted: readonly string[];
	readonly branch?: string;
	/** The user closed the review without committing (anything left of it). */
	readonly dismissed?: boolean;
	/** A commit failed: the ones before it are in. */
	readonly error?: string;
}

/** What the agent is told once the review ends. */
export function commitPlanOutcomeText(outcome: ICommitPlanOutcome): string {
	const lines: string[] = [];
	if (outcome.committed.length) {
		lines.push(`The user reviewed the commits and Volt made ${outcome.committed.length}${outcome.branch ? ` on ${outcome.branch}` : ''}:`);
		for (const commit of outcome.committed) {
			lines.push(`- ${commit.sha.slice(0, 7)} ${commit.subject} (${commit.files} file${commit.files === 1 ? '' : 's'})`);
		}
	} else if (outcome.dismissed) {
		lines.push('The user closed the commit review without committing. Nothing was committed; do not commit these changes unless they ask again.');
	} else {
		lines.push('Nothing was committed.');
	}
	if (outcome.error) {
		lines.push(`Committing stopped: ${outcome.error}`);
	}
	if (outcome.uncommitted.length) {
		lines.push(`Left uncommitted (the user left them out): ${outcome.uncommitted.slice(0, 30).join(', ')}${outcome.uncommitted.length > 30 ? `, and ${outcome.uncommitted.length - 30} more` : ''}.`);
	}
	if (outcome.committed.length && outcome.branch && isPlaceholderBranch(outcome.branch)) {
		lines.push(placeholderBranchNote(outcome.branch));
	}
	return lines.join('\n');
}
