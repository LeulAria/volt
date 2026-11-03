/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';

// DOM-free, so the agent server (scratch folders for automation runs) can use it too.

export interface IGitRun {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/** Runs git in the user's shell, with their environment, so it is the git they use in a terminal. */
export async function runGit(stdio: IVoltStdioService, cwd: string, args: readonly string[], timeoutMs: number): Promise<IGitRun> {
	try {
		const result = await stdio.exec({
			id: `git-${generateUuid().slice(0, 8)}`,
			command: ['git', ...args].map(shellQuote).join(' '),
			cwd,
			// No terminal to answer a credential prompt; fail instead of waiting for the timeout.
			env: { GIT_TERMINAL_PROMPT: '0' },
			timeoutMs,
			inlineChars: 20_000,
		});
		return { exitCode: result.exitCode, stderr: result.stderr, timedOut: result.timedOut };
	} catch (err) {
		return { exitCode: 1, stderr: toErrorMessage(err), timedOut: false };
	}
}

function shellQuote(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}
