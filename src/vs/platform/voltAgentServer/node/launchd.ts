/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { writeFileAtomic } from './agentServerFiles.js';

/** How the agent server runs as a macOS LaunchAgent. */
export interface ILaunchdJob {
	readonly label: string;
	/** argv[0] is the executable. */
	readonly program: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly workingDirectory: string;
	readonly logFile: string;
}

export function launchAgentPlistPath(label: string): string {
	return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The job definition. `KeepAlive.SuccessfulExit = false`: launchd restarts the server when it
 * crashes or is killed, but a server that exits cleanly (asked to stop) stays stopped.
 * `RunAtLoad` starts it on bootstrap and again at login.
 */
export function launchdPlist(job: ILaunchdJob): string {
	const strings = (values: readonly string[]) => values.map(value => `\t\t<string>${xmlEscape(value)}</string>`).join('\n');
	const env = Object.entries(job.env).map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(job.label)}</string>
	<key>ProgramArguments</key>
	<array>
${strings(job.program)}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(job.workingDirectory)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>3</integer>
	<key>ProcessType</key>
	<string>Standard</string>
	<key>StandardOutPath</key>
	<string>${xmlEscape(job.logFile)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(job.logFile)}</string>
</dict>
</plist>
`;
}

interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

function launchctl(args: readonly string[]): Promise<IRunResult> {
	return new Promise(resolve => {
		execFile('/bin/launchctl', [...args], { timeout: 15_000 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function domain(): string {
	return `gui/${process.getuid?.() ?? 0}`;
}

export async function isLaunchdJobLoaded(label: string): Promise<boolean> {
	return (await launchctl(['print', `${domain()}/${label}`])).code === 0;
}

/**
 * Installs the job (rewriting the plist when it changed) and makes sure it runs. Loading a
 * changed definition means booting the old one out first, which stops its process.
 */
export async function installLaunchdJob(job: ILaunchdJob): Promise<void> {
	const plistPath = launchAgentPlistPath(job.label);
	const content = launchdPlist(job);
	let previous: string | undefined;
	try {
		previous = await fs.readFile(plistPath, 'utf8');
	} catch {
		previous = undefined;
	}
	const loaded = await isLaunchdJobLoaded(job.label);
	if (previous !== content) {
		if (loaded) {
			await launchctl(['bootout', `${domain()}/${job.label}`]);
		}
		await fs.mkdir(dirname(plistPath), { recursive: true });
		await fs.mkdir(dirname(job.logFile), { recursive: true });
		await writeFileAtomic(plistPath, content, 0o644);
	} else if (loaded) {
		// Loaded and unchanged: start it if it is not running (a clean exit leaves it stopped).
		await launchctl(['kickstart', `${domain()}/${job.label}`]);
		return;
	}
	const result = await launchctl(['bootstrap', domain(), plistPath]);
	if (result.code !== 0 && !await isLaunchdJobLoaded(job.label)) {
		throw new Error(`launchctl bootstrap failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	}
}

/** Kills the running server; launchd starts it again right away. */
export async function restartLaunchdJob(label: string): Promise<void> {
	const result = await launchctl(['kickstart', '-k', `${domain()}/${label}`]);
	if (result.code !== 0) {
		throw new Error(`launchctl kickstart failed (${result.code}): ${result.stderr.trim()}`);
	}
}

/** Stops the server and removes the job so it doesn't come back at login. */
export async function uninstallLaunchdJob(label: string): Promise<void> {
	await launchctl(['bootout', `${domain()}/${label}`]);
	await fs.rm(launchAgentPlistPath(label), { force: true });
}
