/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { formatBuildEntryDiff, IBuildEntryChange } from '../../../../../platform/voltGit/common/hostGit.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';

/** What Volt is about to run for the user: their commit or push hooks, worktree setup, or a Run target (script, task, launch). */
export type BuildEntryPurpose = 'commit' | 'push' | 'setup' | 'run';

/**
 * The build-entry review (I.6): files that run code (git hooks and config, package scripts, tasks,
 * setup files) changed while a sandboxed agent worked in a folder. Before Volt runs any of them for
 * the user (a commit with hooks, worktree setup, the Run button), the user sees what changed and
 * decides. Accepting makes the current files the new baseline; declining runs nothing. Without
 * dialogs (the agent server), changed files can't be reviewed, so the answer is no.
 */
export async function reviewBuildEntries(
	dialogs: IDialogService | undefined,
	stdio: IVoltStdioService,
	roots: readonly string[],
	purpose: BuildEntryPurpose,
	known?: readonly IBuildEntryChange[],
): Promise<boolean> {
	const unique = [...new Set(roots)];
	const changes = known ?? (await Promise.all(unique.map(root => stdio.buildEntryChanges?.(root).catch(() => []) ?? []))).flat();
	// Hooks are all a commit or push runs; setup and Run can start anything the project describes.
	const relevant = purpose === 'commit' || purpose === 'push' ? changes.filter(change => change.group === 'git') : changes;
	if (!relevant.length) {
		return true;
	}
	if (!dialogs) {
		return false;
	}
	const { confirmed } = await dialogs.confirm({
		type: 'warning',
		message: purpose === 'commit' || purpose === 'push'
			? localize('voltBuildEntry.hooksMessage', "Git hooks or config changed while an agent worked here")
			: localize('voltBuildEntry.setupMessage', "Files that run code changed while an agent worked here"),
		detail: [
			purpose === 'setup'
				? localize('voltBuildEntry.setupDetail', "Worktree setup runs these. Check the changes before Volt runs them outside the sandbox.")
				: purpose === 'run'
					? localize('voltBuildEntry.runDetail', "Run starts the project's scripts, tasks and launch configurations outside the sandbox. Check the changes first.")
					: localize('voltBuildEntry.hooksDetail', "Your {0} runs these hooks outside the sandbox. Check the changes first.", purpose === 'push' ? localize('voltBuildEntry.push', "push") : localize('voltBuildEntry.commit', "commit")),
			'',
			formatBuildEntryDiff(relevant),
		].join('\n'),
		primaryButton: purpose === 'setup'
			? localize({ key: 'voltBuildEntry.trustSetup', comment: ['&& denotes a mnemonic'] }, "&&Trust and Run Setup")
			: purpose === 'run'
				? localize({ key: 'voltBuildEntry.trustRun', comment: ['&& denotes a mnemonic'] }, "&&Trust and Run")
				: localize({ key: 'voltBuildEntry.trustHooks', comment: ['&& denotes a mnemonic'] }, "&&Trust and Run Hooks"),
	});
	if (!confirmed) {
		return false;
	}
	const paths = relevant.map(change => change.path);
	await Promise.all(unique.map(root => stdio.acceptBuildEntries?.(root, paths)));
	return true;
}
