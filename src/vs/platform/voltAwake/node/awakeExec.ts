/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';

export interface IExecResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** The command outlived its limit. */
	readonly timedOut: boolean;
	/** `terminateOnly` command that ignored SIGTERM: it may still be running, with this pid. */
	readonly stuckPid?: number;
}

export interface IExecOptions {
	readonly timeoutMs?: number;
	/**
	 * Never SIGKILL (for `sudo`): killing sudo can leave a root child changing power settings after
	 * the caller moved on. It gets SIGTERM, then the result reports it as stuck.
	 */
	readonly terminateOnly?: boolean;
	readonly env?: NodeJS.ProcessEnv;
}

/** Runs one command with an absolute path and argv (no shell). Injectable so tests never touch power settings. */
export type AwakeExec = (file: string, args: readonly string[], options?: IExecOptions) => Promise<IExecResult>;

const DEFAULT_TIMEOUT_MS = 20_000;
const TERM_GRACE_MS = 3_000;

export const realAwakeExec: AwakeExec = (file, args, options = {}) => new Promise(resolve => {
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	let settled = false;
	const child = spawn(file, [...args], { env: options.env ?? { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	const finish = (result: IExecResult) => {
		if (!settled) {
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			resolve(result);
		}
	};
	let grace: ReturnType<typeof setTimeout> | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGTERM');
		grace = setTimeout(() => {
			if (options.terminateOnly) {
				finish({ code: null, stdout, stderr, timedOut, stuckPid: child.pid });
			} else {
				child.kill('SIGKILL');
			}
		}, TERM_GRACE_MS);
	}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	child.stdout.on('data', chunk => stdout += chunk);
	child.stderr.on('data', chunk => stderr += chunk);
	child.on('error', err => finish({ code: null, stdout, stderr: stderr || String(err), timedOut }));
	child.on('close', code => finish({ code, stdout, stderr, timedOut }));
});
