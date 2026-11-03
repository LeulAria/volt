/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { homedir } from 'os';
import { delimiter, join } from '../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';

/**
 * On macOS /usr/bin/git is an xcrun shim that refuses to run until the Xcode license is accepted
 * (common right after an Xcode update), while the real binaries behind it run fine. When the shim
 * is broken this finds a directory holding a working git, so callers can put it first on PATH.
 * Spawning plain `git` then works, and so do tools that run git themselves, like gh.
 */
let fallbackDir: Promise<string | undefined> | undefined;

function runs(file: string, args: string[]): Promise<string | undefined> {
	return new Promise(resolve => execFile(file, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : String(stdout).trim())));
}

async function findFallbackDir(): Promise<string | undefined> {
	if (!isMacintosh || await runs('/usr/bin/git', ['--version']) !== undefined) {
		return undefined;
	}
	const dirs = ['/opt/homebrew/bin', '/usr/local/bin'];
	const developerDir = await runs('/usr/bin/xcode-select', ['-p']);
	if (developerDir) {
		dirs.push(join(developerDir, 'usr', 'bin'));
	}
	dirs.push('/Library/Developer/CommandLineTools/usr/bin');
	for (const dir of dirs) {
		if (await runs(join(dir, 'git'), ['--version']) !== undefined) {
			return dir;
		}
	}
	return undefined;
}

/**
 * `path` with the usual install folders for CLIs like gh appended. An app opened from the Dock gets
 * only the system PATH, and the user's shell environment (which has them) can fail to resolve in
 * time at startup; without these gh is never found and pull requests stop linking.
 */
export function withCliDirsOnPath(path: string | undefined): string | undefined {
	if (isWindows) {
		return path;
	}
	const home = homedir();
	const current = (path ?? '').split(delimiter).filter(Boolean);
	const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, 'bin')];
	return [...current, ...extra.filter(dir => !current.includes(dir))].join(delimiter);
}

/** `env` with a working git first on PATH when the macOS git shim is broken; otherwise `env` itself. */
export async function withWorkingGitOnPath(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
	fallbackDir ??= findFallbackDir();
	const dir = await fallbackDir;
	if (!dir) {
		return env;
	}
	const path = env.PATH ?? '';
	return path.split(delimiter)[0] === dir ? env : { ...env, PATH: path ? `${dir}${delimiter}${path}` : dir };
}
