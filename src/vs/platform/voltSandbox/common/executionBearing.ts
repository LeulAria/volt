/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Execution-bearing files (spec D.1 asset A3, INV-14, INV-15): files whose content something runs
 * later, outside the sandbox that wrote them. One list, used by the build-entry guard (I.6, which
 * records them before a sandboxed writer starts and shows what changed before Volt runs any of it
 * for the user) and by the files broker's floor (I.2, which never writes them for a sandboxed or
 * third-party principal).
 */

import { PROTECTED_ROOT_NAMES } from './sandboxProfiles.js';

/** Files at a workspace root that a build, a task, an install or worktree setup runs. */
export const BUILD_ENTRY_FILES: readonly string[] = [
	'.vscode/tasks.json', '.vscode/launch.json', 'package.json', 'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml',
	'.envrc', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'build.rs',
	'.cargo/config.toml', '.cargo/config', 'pyproject.toml', 'setup.py', '.devcontainer/devcontainer.json',
	't3.json', 'volt.json', '.volt/worktrees.json', '.cursor/worktrees.json', '.volt/hooks.json',
];

/** Folders at a workspace root whose every file runs (hook managers, Volt's own hooks and workflows). */
export const BUILD_ENTRY_DIRS: readonly string[] = ['.husky', '.githooks', '.volt/hooks', '.volt/workflows'];

/** Names in a git folder that run code or point git elsewhere. */
export const GIT_ENTRY_FILES: readonly string[] = ['config', 'config.worktree', 'commondir', 'gitdir', 'info/attributes', 'objects/info/alternates', 'objects/info/http-alternates'];

/**
 * What the OS sandbox keeps read-only inside a writable root (`PROTECTED_ROOT_NAMES`), plus git's
 * own folder, CI workflows, agent skills and Volt's workflows: never written by the files broker
 * for a principal that is not first party, at any depth (a nested project's are as live). Build
 * files the agent itself may edit (`package.json`, `Makefile`) are not here: the build-entry guard
 * shows their changes before Volt runs them.
 */
const ANY_DEPTH_ENTRIES: readonly string[] = [
	...PROTECTED_ROOT_NAMES.filter(name => name !== 'HEAD' && name !== 'objects' && name !== 'refs'),
	'.git', '.gitattributes', '.github/workflows', '.claude/skills', '.volt/workflows',
];

/** Under the home folder: shell startup files, login items and agent CLI state (B-05), relative to home. */
const HOME_ENTRIES: readonly string[] = [
	'.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.config/fish',
	'.gitconfig', '.config/git', 'Library/LaunchAgents', '.config/systemd', '.config/autostart',
	// Volt's own settings and hooks (not `~/.volt/worktrees`, where chats work).
	'.claude.json', '.claude', '.codex', '.cursor', '.config/opencode', '.agents', '.gemini', '.volt/hooks', '.volt/hooks.json', '.volt/mcp.json', '.volt/settings',
	'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',
];

/** `path` split into components, with `\` treated as a separator (Windows paths). */
function components(path: string): string[] {
	return path.replace(/\\/g, '/').split('/').filter(part => part.length > 0);
}

function fold(text: string, caseInsensitive: boolean): string {
	const nfc = text.normalize('NFC');
	return caseInsensitive ? nfc.toLowerCase() : nfc;
}

/** Whether the last components of `parts` are `suffix` (one or more components). */
function endsWithComponents(parts: readonly string[], suffix: readonly string[]): boolean {
	if (suffix.length > parts.length) {
		return false;
	}
	const offset = parts.length - suffix.length;
	return suffix.every((part, i) => parts[offset + i] === part);
}

/** Whether `suffix` (one or more components) appears as consecutive components of `parts` before its last one. */
function containsComponents(parts: readonly string[], dir: readonly string[]): boolean {
	for (let i = 0; i + dir.length < parts.length; i++) {
		if (dir.every((part, j) => parts[i + j] === part)) {
			return true;
		}
	}
	return false;
}

/**
 * Why `path` (absolute, a real path) is execution-bearing, or undefined when it is not. `home`: the
 * user's home, for shell startup files and agent state. `caseInsensitive`: the file system folds
 * case (APFS and NTFS by default), so `.GIT/config` is `.git/config`.
 */
export function executionBearingReason(path: string, home: string | undefined, caseInsensitive: boolean): string | undefined {
	const parts = components(fold(path, caseInsensitive));
	for (const name of ANY_DEPTH_ENTRIES) {
		const entry = components(fold(name, caseInsensitive));
		if (endsWithComponents(parts, entry) || containsComponents(parts, entry)) {
			return `${name} runs code or is trusted later (a hook, a task, an editor or agent setting)`;
		}
	}
	if (home) {
		const homeParts = components(fold(home, caseInsensitive));
		if (homeParts.length && homeParts.every((part, i) => parts[i] === part)) {
			const rest = parts.slice(homeParts.length);
			for (const entry of HOME_ENTRIES) {
				const entryParts = components(fold(entry, caseInsensitive));
				if (entryParts.length <= rest.length && entryParts.every((part, i) => rest[i] === part)) {
					return `~/${entry} runs code or holds agent settings`;
				}
			}
		}
	}
	return undefined;
}
