/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISandboxPlan } from './sandboxPolicy.js';

/** Codex hard-codes this path rather than searching PATH, in case a copy there was tampered with. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Every Volt denial carries this prefix plus the spawn's tag, so `log stream` can attribute it. */
export const SEATBELT_TAG_PREFIX = 'VOLTSBX-';

/** Device files every process writes (terminals, /dev/null, dtrace helpers Node and git open). */
const DEVICE_WRITES = '#"^/dev/(null|zero|tty|ttys[0-9]+|ptmx|dtracehelper|fd/[0-9]+|stdout|stderr|stdin|random|urandom)$"';

/** A string literal for SBPL: backslashes and quotes escaped. */
export function sbplString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A regex literal for SBPL matching `value` exactly (and, with `suffix`, what follows it). */
export function sbplRegex(value: string, suffix = ''): string {
	const escaped = value.replace(/[.*+?^${}()|[\]\\/]/g, ch => ch === '/' ? '/' : `\\${ch}`);
	return `#"^${escaped.replace(/"/g, '\\"')}${suffix}$"`;
}

/**
 * The Seatbelt profile for one agent process tree.
 *
 * The base is `(allow default)`, as Gemini CLI's original whole-process profiles were: an agent
 * CLI needs the Keychain, launchd, fonts and much more, and a deny-default profile written for
 * single shell commands (Codex, srt) breaks them. What it closes is what matters for an agent:
 * - every write outside the plan's folders, and writes to code that runs later outside the
 *   sandbox (git hooks and config, shell rc files, the CLI's own hook and MCP configs);
 * - reads of cloud and signing credentials;
 * - outbound network except loopback when the chat's network is off (the agent then reaches its
 *   API through Volt's filtering proxy);
 * - the escape hatches: Apple Events (Terminal / Finder `do shell script`), LaunchServices `open`,
 *   and launchd job submission run code outside the sandbox.
 * Each deny carries `(with message "<tag>")`, which lands in the unified log with the path.
 */
export function buildSeatbeltProfile(plan: ISandboxPlan, tag: string): string {
	const message = `(with message ${sbplString(`${SEATBELT_TAG_PREFIX}${tag}`)})`;
	const lines: string[] = [
		'(version 1)',
		`; Volt agent sandbox (${plan.level}, network ${plan.network === 'all' ? 'on' : 'via proxy'})`,
		'(allow default)',
		'',
		'; Writes: only the plan\'s folders and files.',
		`(deny file-write* ${message})`,
	];
	const allow: string[] = [`(regex ${DEVICE_WRITES})`];
	for (const path of plan.writableSubpaths) {
		allow.push(`(subpath ${sbplString(path)})`);
	}
	for (const file of plan.writableFiles) {
		allow.push(`(literal ${sbplString(file)})`);
		allow.push(`(regex ${sbplRegex(file, '\\.(lock|tmp|backup|bak|swp)[^/]*')})`);
	}
	lines.push(`(allow file-write*\n\t${allow.join('\n\t')})`);
	if (plan.denyWriteSubpaths.length || plan.denyWriteFiles.length) {
		const deny = [
			...plan.denyWriteSubpaths.map(path => `(subpath ${sbplString(path)})`),
			...plan.denyWriteFiles.map(path => `(literal ${sbplString(path)})`),
		];
		lines.push('', '; Never writable: runs later outside the sandbox.', `(deny file-write* ${message}\n\t${deny.join('\n\t')})`);
	}
	if (plan.denyReadSubpaths.length) {
		lines.push('', '; Credentials.', `(deny file-read* ${message}\n\t${plan.denyReadSubpaths.map(path => `(subpath ${sbplString(path)})`).join('\n\t')})`);
	}
	lines.push(
		'',
		'; Escape hatches: these run code outside the sandbox.',
		`(deny appleevent-send ${message})`,
		`(deny mach-lookup ${message} (global-name "com.apple.coreservices.appleevents"))`,
		`(deny lsopen ${message})`,
	);
	if (plan.network === 'proxy') {
		lines.push(
			'',
			'; Network off: loopback only (Volt\'s proxy, Volt\'s MCP server, local dev servers).',
			`(deny network-outbound ${message})`,
			'(allow network-outbound (remote ip "localhost:*"))',
			'(allow network-outbound (remote unix-socket))',
		);
	}
	return lines.join('\n') + '\n';
}

/** `sandbox-exec -p <profile> -- <command> <args>`. */
export function seatbeltCommand(profile: string, command: string, args: readonly string[]): { command: string; args: string[] } {
	return { command: SANDBOX_EXEC_PATH, args: ['-p', profile, '--', command, ...args] };
}

export interface ISeatbeltViolation {
	readonly tag: string;
	readonly process: string;
	readonly pid: number;
	/** `file-write-create`, `file-read-data`, `network-outbound`, ... */
	readonly operation: string;
	/** Path, or `ip:port` for network denials. */
	readonly target: string;
}

/**
 * One unified-log line from `log stream --style ndjson`. The kernel writes
 * `Sandbox: touch(123) deny(1) file-write-create /Users/me/x\nVOLTSBX-<tag>`.
 */
export function parseSeatbeltLogLine(line: string): ISeatbeltViolation | undefined {
	let message = line;
	const trimmed = line.trim();
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as { eventMessage?: unknown };
			if (typeof parsed.eventMessage !== 'string') {
				return undefined;
			}
			message = parsed.eventMessage;
		} catch {
			return undefined;
		}
	}
	const match = /Sandbox: (.+?)\((\d+)\) deny(?:\(\d+\))? (\S+)(?: (.*?))?\s*\n?\s*VOLTSBX-([\w-]+)/.exec(message);
	if (!match) {
		return undefined;
	}
	return {
		process: match[1],
		pid: Number(match[2]),
		operation: match[3],
		target: (match[4] ?? '').trim(),
		tag: match[5],
	};
}
