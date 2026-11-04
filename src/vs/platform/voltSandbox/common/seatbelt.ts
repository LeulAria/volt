/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IResolvedPattern, IResolvedSandboxPolicy } from './sandboxResolved.js';

/**
 * Seatbelt (SBPL) profiles from a resolved policy. Every path reaches the profile through
 * `sbplString` or `sbplRegex`, never raw, and the profile text is the only input to
 * `sandbox-exec -p`. Rules are evaluated last-match-wins, so each section narrows the one before.
 *
 * Verified on macOS 26.6 (see docs/security/sandbox/03-security-findings.md):
 * - a deny-default process needs read access to `/` itself, or dyld aborts it (SIGABRT);
 * - `(deny signal (target others))` does not stop signals; `(deny signal)` then
 *   `(allow signal (target same-sandbox))` does;
 * - under `(allow default)`, `defaults write` lands through cfprefsd even when the preferences
 *   folder is write-denied, so the cfprefsd lookup is denied;
 * - denying the network also stops DNS (mDNSResponder is reached through a unix socket);
 * - hard links into a read-denied folder are refused; case variants of a denied path are denied.
 */

/** Codex hard-codes this path rather than searching PATH, in case a copy there was tampered with. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Every Volt denial carries this prefix plus the run's tag, so `log stream` can attribute it. */
export const SEATBELT_TAG_PREFIX = 'VOLTSBX-';

/** Device files every process reads or writes (terminals, /dev/null, the dtrace helper Node and git open). */
const DEVICE_FILES = '#"^/dev/(null|zero|tty|ttys[0-9]+|ptmx|dtracehelper|fd/[0-9]+|stdout|stderr|stdin|random|urandom)$"';

/** mDNSResponder: DNS for every process, reached as a unix socket. Only allowed with an open network. */
const MDNS_SOCKET = '/private/var/run/mDNSResponder';

/** Mach services that run code or act for us outside the sandbox. Denied even with system services on. */
const ESCAPE_SERVICES = [
	'com.apple.coreservices.appleevents',
	// Synthetic keyboard and mouse input to other apps (Volt itself may hold Accessibility).
	'com.apple.windowserver.active',
	'com.apple.pasteboard.1',
	// Writes preferences of any app for us, past the file write rules (Terminal startup commands).
	'com.apple.cfprefsd.agent',
];

/** A string literal for SBPL: backslashes and quotes escaped (string literals honour `\"`; regex literals do not). */
export function sbplString(value: string): string {
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error('A control character cannot be expressed in a Seatbelt profile');
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Regex source matching `value` literally; with `caseInsensitive`, letters match either case.
 * A `"` cannot be escaped inside an SBPL `#"…"` literal (it ends the literal: verified on macOS
 * 26.6), so a path containing one is refused rather than risk profile injection. The resolver
 * refuses such paths first; this is the second line.
 */
function regexBody(value: string, caseInsensitive: boolean): string {
	let out = '';
	for (const ch of value) {
		if (ch === '"' || ch.charCodeAt(0) < 0x20 || ch === '\u007f') {
			throw new Error('A path with a double quote or a control character cannot be expressed in a Seatbelt profile');
		}
		if (caseInsensitive && /[a-z]/i.test(ch) && ch.toLowerCase() !== ch.toUpperCase()) {
			out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
		} else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	return out;
}

/** A regex literal for SBPL matching `value` exactly (and, with `suffix`, what follows it). */
export function sbplRegex(value: string, suffix = '', caseInsensitive = false): string {
	return `#"^${regexBody(value, caseInsensitive)}${suffix}$"`;
}

/** `<root>/(…/)?a/b` and everything below it. */
function patternRegex(pattern: IResolvedPattern, caseInsensitive: boolean): string {
	const root = pattern.root === '/' ? '' : regexBody(pattern.root, caseInsensitive);
	const names = pattern.names.map(name => regexBody(name, caseInsensitive)).join('/');
	return `#"^${root}/(.*/)?${names}(/.*)?$"`;
}

/**
 * A path and everything below it. On a case-insensitive volume (the macOS default) a different
 * spelling reaches the same file, so denies match either case; allows stay exact, which can only
 * refuse more.
 */
function subpathFilter(path: string, caseInsensitive: boolean): string {
	if (!caseInsensitive || !/[a-z]/i.test(path)) {
		return `(subpath ${sbplString(path)})`;
	}
	return `(regex ${sbplRegex(path, '(/.*)?', true)})`;
}

export interface ISeatbeltProfileOptions {
	readonly tag: string;
	/** Volt's filtering proxy on the host loopback (network `proxy`). */
	readonly proxyPort?: number;
}

/** The SBPL profile for one run. */
export function buildSeatbeltProfile(policy: IResolvedSandboxPolicy, options: ISeatbeltProfileOptions): string {
	const message = `(with message ${sbplString(`${SEATBELT_TAG_PREFIX}${options.tag}`)})`;
	const ci = true;
	const out: string[] = ['(version 1)', `; Volt sandbox: ${policy.name.replace(/[^\w .-]/g, '')}${policy.systemServices ? ' (system services)' : ''}`];

	if (policy.systemServices) {
		// Agent CLIs need the Keychain, launchd lookups and much more: allow by default, then deny what matters.
		out.push('(allow default)');
	} else {
		out.push(
			`(deny default ${message})`,
			'(allow process-exec process-fork)',
			// dyld reads the root folder itself before anything runs.
			'(allow file-read* (literal "/"))',
			'(allow file-read-metadata)',
			'(allow sysctl-read)',
			// User and group lookups (whoami, git, ssh), the system logger, power assertions.
			'(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.logger") (global-name "com.apple.PowerManagement.control"))',
			// Python's multiprocessing semaphores.
			'(allow ipc-posix-sem)',
			'(allow pseudo-tty)',
			'(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
			`(allow file-read* file-write-data file-ioctl (regex ${DEVICE_FILES}))`,
		);
	}

	// Processes: only this sandbox's own may be signalled or inspected.
	out.push(`(deny signal ${message})`, '(allow signal (target same-sandbox))');
	if (!policy.systemServices) {
		out.push('(allow process-info* (target same-sandbox))');
	}

	// Reads.
	if (policy.readAll) {
		out.push('(allow file-read*)');
	} else {
		if (policy.systemServices) {
			out.push(`(deny file-read* ${message})`, '(allow file-read* (literal "/"))', '(allow file-read-metadata)');
		}
		const read = [...policy.read, ...policy.unixSockets].map(path => `(subpath ${sbplString(path)})`);
		if (read.length) {
			out.push(`(allow file-read*\n\t${read.join('\n\t')})`);
		}
	}

	// Writes: everything else is denied (by default, or explicitly with system services on).
	if (policy.systemServices) {
		out.push(`(deny file-write* ${message})`);
	}
	const write = [
		`(regex ${DEVICE_FILES})`,
		...policy.write.map(path => `(subpath ${sbplString(path)})`),
		...policy.writeFiles.flatMap(file => [`(literal ${sbplString(file)})`, `(regex ${sbplRegex(file, '\\.(lock|tmp|backup|bak|swp)[^/]*')})`]),
	];
	out.push(`(allow file-read* file-write*\n\t${write.join('\n\t')})`);

	// Protected: readable, never writable, even inside a writable folder.
	const protect = [
		...policy.protect.map(path => subpathFilter(path, ci)),
		...policy.protectPatterns.map(pattern => `(regex ${patternRegex(pattern, ci)})`),
	];
	if (protect.length) {
		out.push(`(deny file-write* ${message}\n\t${protect.join('\n\t')})`);
	}
	// A new repository brings its own config and hooks: no `.git` entry may be created below a workspace.
	if (policy.newRepositoryGuard.length) {
		const guards = policy.newRepositoryGuard.map(root => `(regex #"^${regexBody(root, ci)}/(.*/)?${regexBody('.git', ci)}$")`);
		out.push(`(deny file-write-create ${message}\n\t${guards.join('\n\t')})`);
	}

	// Denied: neither readable nor writable, last so nothing above re-allows it.
	const deny = [
		...policy.deny.map(path => subpathFilter(path, ci)),
		...policy.denyPatterns.map(pattern => `(regex ${patternRegex(pattern, ci)})`),
	];
	if (deny.length) {
		out.push(`(deny file-read* file-write* ${message}\n\t${deny.join('\n\t')})`);
	}

	// Network.
	if (policy.network.mode === 'host') {
		if (!policy.systemServices) {
			out.push(
				'(allow network* system-socket)',
				// DNS, certificate checks and proxy settings for an open network.
				'(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
			);
		}
	} else {
		if (policy.systemServices) {
			out.push(`(deny network* ${message})`);
		}
		const ports = [...(options.proxyPort ? [options.proxyPort] : []), ...policy.network.loopbackPorts];
		if (ports.length) {
			out.push('(allow system-socket)', `(allow network-outbound\n\t${[...new Set(ports)].map(port => `(remote ip ${sbplString(`localhost:${port}`)})`).join('\n\t')})`);
		}
		if (policy.network.listen) {
			// Listening only. Connecting to loopback stays limited to the ports above: an
			// unauthenticated local service (Redis `CONFIG SET dir`) is a way to write files outside.
			out.push('(allow system-socket)', '(allow network-bind network-inbound (local ip "localhost:*"))');
		}
	}

	// Unix sockets: none but the granted ones (and DNS with an open network), whatever the mode.
	out.push(`(deny network-outbound ${message} (remote unix-socket))`);
	const sockets = [...policy.unixSockets, ...(policy.network.mode === 'host' ? [MDNS_SOCKET] : [])];
	if (sockets.length) {
		out.push(`(allow network-outbound\n\t${sockets.map(socket => `(remote unix-socket (path-literal ${sbplString(socket)}))`).join('\n\t')})`);
	}

	// Escape hatches: these run code or act for us outside the sandbox.
	out.push(
		`(deny appleevent-send ${message})`,
		`(deny lsopen ${message})`,
		`(deny job-creation ${message})`,
		`(deny mach-lookup ${message}\n\t${ESCAPE_SERVICES.map(name => `(global-name ${sbplString(name)})`).join('\n\t')})`,
	);
	return out.join('\n') + '\n';
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

/**
 * The prologue that runs inside the sandbox before the workload: sets limits, proves the sandbox
 * is applied by writing to fd 3 (sandbox-exec only execs after `sandbox_init` succeeded), closes
 * fd 3 and execs. Constant text: values arrive as positional arguments only.
 * Arguments: <cpu seconds|-> <file size in 512-byte blocks|-> <open files|-> <command> <args...>
 */
export const SEATBELT_PROLOGUE = [
	'c=$1 f=$2 n=$3; shift 3',
	'[ "$c" = - ] || ulimit -t "$c" || exit 125',
	'[ "$f" = - ] || ulimit -f "$f" || exit 125',
	'[ "$n" = - ] || ulimit -n "$n" || exit 125',
	'printf "volt-sandbox-ready %s\\n" "$$" >&3 || exit 125',
	'exec 3>&-',
	'exec "$@"',
].join('\n');
