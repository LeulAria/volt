/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The environment of every git this extension starts, with `safe.bareRepository=explicit` added
 * as command-scope config (`GIT_CONFIG_COUNT`), after whatever the environment already carries.
 *
 * A folder holding `HEAD`, `objects`, `refs` and `config` is a bare repository to git, wherever it
 * sits in a project, and git reads that `config` when it is started in the folder or below it:
 * `core.worktree = .` makes `git status` work there and `core.fsmonitor` names a command it then
 * runs. This extension starts git in the folder of every file that is opened (to find its
 * repository), so such a folder, written by a sandboxed agent or checked out from a repository,
 * ran its command on this machine, outside any sandbox (measured with git 2.54). With `explicit`
 * git uses a bare repository only when it is named (`--git-dir`, `GIT_DIR`), which this extension
 * never does. Repositories with a `.git` folder or file, worktrees and submodules are unaffected.
 * Git older than 2.38 ignores the key.
 */
export function withSafeBareRepository(env: { [key: string]: string | undefined }): { [key: string]: string | undefined } {
	const given = env['GIT_CONFIG_COUNT'];
	const count = given !== undefined && /^\d+$/.test(given) ? Number(given) : 0;
	return {
		...env,
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: 'safe.bareRepository',
		[`GIT_CONFIG_VALUE_${count}`]: 'explicit',
	};
}
