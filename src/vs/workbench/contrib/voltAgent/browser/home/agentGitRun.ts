/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js';
import { IVoltStdioService, runGitThrough } from '../../../../../platform/voltStdio/common/voltStdio.js';

// DOM-free, so the agent server (scratch folders for automation runs) can use it too.

export interface IGitRun {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/**
 * Runs git with the user's environment, so it is the git they use in a terminal, through HostGit:
 * the repository's fsmonitor, hooks and `ext::` remotes never run.
 */
export async function runGit(stdio: IVoltStdioService, cwd: string, args: readonly string[], timeoutMs: number): Promise<IGitRun> {
	const result = await runGitThrough(stdio, {
		id: `git-${generateUuid().slice(0, 8)}`,
		cwd,
		args,
		// No terminal to answer a credential prompt; fail instead of waiting for the timeout.
		env: { GIT_TERMINAL_PROMPT: '0' },
		timeoutMs,
	});
	return { exitCode: result.exitCode, stderr: result.error && !result.stderr.includes(result.error) ? `${result.stderr}\n${result.error}`.trim() : result.stderr, timedOut: !!result.timedOut };
}
