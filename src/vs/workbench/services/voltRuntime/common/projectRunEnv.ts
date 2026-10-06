/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Per-project environment for agent processes. Project settings register a resolver; the
 * desktop stdio client asks it for every process it spawns, by working folder (a project folder
 * or one of its chats' worktrees). A process's own `env` wins over the project's.
 */
export type ProjectRunEnvResolver = (cwd: string) => Readonly<Record<string, string>> | undefined;

let resolver: ProjectRunEnvResolver | undefined;

export function setProjectRunEnvResolver(next: ProjectRunEnvResolver): IDisposable {
	resolver = next;
	return toDisposable(() => {
		if (resolver === next) {
			resolver = undefined;
		}
	});
}

export function projectRunEnv(cwd: string | undefined): Readonly<Record<string, string>> | undefined {
	if (!cwd || !resolver) {
		return undefined;
	}
	try {
		const env = resolver(cwd);
		return env && Object.keys(env).length ? env : undefined;
	} catch {
		return undefined;
	}
}
