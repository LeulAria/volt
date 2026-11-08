/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GIT_WRITABLE_REGEX } from './sandboxProfiles.js';
import { IResolvedPattern, IResolvedSandboxPolicy } from './sandboxResolved.js';

/**
 * Seatbelt (SBPL) profiles from a resolved policy. Every path reaches the profile through
 * `sbplString` or `regexBody` (`sbplRegex`), never raw, and the profile text is the only input to
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

/**
 * Device files every process reads or writes (its controlling terminal as `/dev/tty`, /dev/null,
 * the dtrace helper Node and git open). Never `/dev/ttys*`: those are the user's other terminals,
 * whose input a sandbox could read (a sudo password) or write to (B-26). A terminal the run was
 * given arrives as an inherited fd, which needs no path.
 */
const DEVICE_FILES = '#"^/dev/(null|zero|tty|ptmx|dtracehelper|fd/[0-9]+|stdout|stderr|stdin|random|urandom)$"';

/** Every terminal device by path: denied in every profile, the allow-default one included. */
const TERMINAL_DEVICES = '#"^/dev/ttys[0-9]+$"';

/** mDNSResponder: DNS for every process, reached as a unix socket. Only allowed with an open network. */
export const MDNS_SOCKET = '/private/var/run/mDNSResponder';

/** Mach services that run code or act for us outside the sandbox. Denied even with system services on (J.1). */
const ESCAPE_SERVICES = [
	'com.apple.coreservices.appleevents',
	// LaunchServices: opens apps and documents for us (`lsopen` is denied as an operation too).
	'com.apple.CoreServices.coreservicesd',
	// Synthetic keyboard and mouse input to other apps (Volt itself may hold Accessibility).
	'com.apple.windowserver.active',
	'com.apple.pasteboard.1',
	// Write preferences of any app for us, past the file write rules (Terminal startup commands).
	'com.apple.cfprefsd.agent',
	'com.apple.cfprefsd.daemon',
];

/** DNS lookups outside the broker: denied unless the network is open (B-31, J.1 "DNS"). */
const DNS_SERVICES = ['com.apple.dnssd.service'];

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

/**
 * `sandbox-exec` rejects a string or regex literal longer than 1023 bytes (measured on macOS 26.6);
 * merged regexes stay under this.
 */
const MAX_LITERAL = 1000;

/**
 * A path regex `^<prefix><suffix>$`: `prefix` a literal path (matched in either case with
 * `caseInsensitive`), `suffix` regex source. Regexes of one rule with the same suffix are merged
 * into one alternation (`mergeFilters`): `sandbox-exec` spends about a millisecond compiling each
 * regex filter whatever its length, so an agent profile of a few hundred `.env`-style denies took
 * most of a second to start (04-performance.md).
 */
interface IPathRegex {
	readonly prefix: string;
	readonly suffix: string;
	readonly caseInsensitive: boolean;
}

/** A rule's filter: profile text as is, or a path regex to merge. */
type SeatbeltFilter = string | IPathRegex;

/**
 * Whether `<prefix><suffix>` already matches everything `<prefix>/<more><suffix>` does, so a
 * prefix below another one in the same group adds nothing: true when the suffix starts with
 * `(/.*)?` (the path and everything below it) or `/(.*` + `/)?` (a name at any depth below it).
 */
function coversBelow(suffix: string): boolean {
	return suffix.startsWith('(/.*)?') || suffix.startsWith('/(.*/)?');
}

/** ASCII letters fold to lower case when the regex matches either case (as `regexBody` does). */
function foldKey(ch: string, caseInsensitive: boolean): string {
	return caseInsensitive && /[a-z]/i.test(ch) ? ch.toLowerCase() : ch;
}

interface ITrieNode {
	end: boolean;
	readonly children: Map<string, ITrieNode>;
}

/**
 * Regex source matching exactly the given literal strings, as a prefix tree: `/a/bc` and `/a/bd`
 * become `/a/b(c|d)`. The same language as `(v1|v2|…)`, shorter, so more fit in one literal.
 */
function literalAlternation(values: readonly string[], caseInsensitive: boolean): string {
	const root: ITrieNode = { end: false, children: new Map() };
	for (const value of values) {
		let node = root;
		for (const ch of value) {
			const key = foldKey(ch, caseInsensitive);
			let next = node.children.get(key);
			if (!next) {
				next = { end: false, children: new Map() };
				node.children.set(key, next);
			}
			node = next;
		}
		node.end = true;
	}
	const emit = (node: ITrieNode): string => {
		const branches = [...node.children.keys()].sort().map(key => regexBody(key, caseInsensitive) + emit(node.children.get(key)!));
		if (!branches.length) {
			return '';
		}
		if (node.end) {
			return `(${branches.join('|')})?`;
		}
		return branches.length === 1 ? branches[0] : `(${branches.join('|')})`;
	};
	return emit(root);
}

/**
 * A rule's filters with duplicates dropped and path regexes merged: each group of regexes with
 * the same suffix becomes as few `(regex …)` filters as fit under the literal limit, at the place
 * of the group's first member. A rule's filters are alternatives, so the merged regex matches
 * exactly the paths one of its members did (SB-EQ-1 checks this under `sandbox-exec`).
 */
function mergeFilters(filters: readonly SeatbeltFilter[]): string[] {
	const out: (string | IPathRegex[])[] = [];
	const seen = new Set<string>();
	const groups = new Map<string, IPathRegex[]>();
	for (const filter of filters) {
		if (typeof filter === 'string') {
			if (!seen.has(filter)) {
				seen.add(filter);
				out.push(filter);
			}
			continue;
		}
		const key = `${filter.caseInsensitive ? 'i' : 's'}${filter.suffix}`;
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
			out.push(group);
		}
		group.push(filter);
	}
	return out.flatMap(item => typeof item === 'string' ? [item] : groupRegexes(item));
}

function groupRegexes(group: readonly IPathRegex[]): string[] {
	const { suffix, caseInsensitive } = group[0];
	const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
	// Shortest first, so a prefix is only dropped for one already kept.
	const sorted = [...new Set(group.map(filter => filter.prefix))]
		.map(prefix => ({ prefix, folded: [...prefix].map(ch => foldKey(ch, caseInsensitive)).join('') }))
		.sort((a, b) => a.prefix.length - b.prefix.length || compare(a.prefix, b.prefix));
	const kept: { readonly prefix: string; readonly folded: string }[] = [];
	for (const entry of sorted) {
		if (kept.some(other => entry.folded === other.folded || (coversBelow(suffix) && entry.folded.startsWith(`${other.folded}/`)))) {
			continue;
		}
		kept.push(entry);
	}
	// Neighbours in path order share the longest prefixes.
	const prefixes = kept.sort((a, b) => compare(a.folded, b.folded)).map(entry => entry.prefix);
	const literal = (from: number, to: number) => `^${to - from === 1 ? regexBody(prefixes[from], caseInsensitive) : literalAlternation(prefixes.slice(from, to), caseInsensitive)}${suffix}$`;
	// Each chunk takes as many prefixes as fit; a prefix tree only grows as strings are added, so
	// the largest fitting chunk is found by bisection. A single prefix that does not fit stays alone.
	const out: string[] = [];
	for (let from = 0; from < prefixes.length;) {
		let lo = from + 1;
		let hi = prefixes.length;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (literal(from, mid).length <= MAX_LITERAL) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		out.push(`(regex #"${literal(from, lo)}")`);
		from = lo;
	}
	return out;
}

/** `(rule\n\tfilter\n\tfilter)`, filters merged. */
function rule(head: string, filters: readonly SeatbeltFilter[]): string {
	return `(${head}\n\t${mergeFilters(filters).join('\n\t')})`;
}

/**
 * `<root>/(…/)?a/b` and everything below it. Patterns with the same root share one filter
 * (`<root>/(…/)?(a/b|c)(/.*)?`), whose roots then merge like any path regex.
 */
function patternFilters(patterns: readonly IResolvedPattern[], caseInsensitive: boolean): IPathRegex[] {
	const byRoot = new Map<string, Set<string>>();
	for (const pattern of patterns) {
		const names = byRoot.get(pattern.root) ?? new Set<string>();
		names.add(pattern.names.join('/'));
		byRoot.set(pattern.root, names);
	}
	return [...byRoot].map(([root, names]) => ({
		prefix: root === '/' ? '' : root,
		// Never empty, never optional as a whole: a plain concatenation or one group.
		suffix: `/(.*/)?${literalAlternation([...names], caseInsensitive)}(/.*)?`,
		caseInsensitive,
	}));
}

/**
 * A path and everything below it. On a case-insensitive volume (the macOS default) a different
 * spelling reaches the same file, so denies match either case; allows stay exact, which can only
 * refuse more.
 */
function subpathFilter(path: string, caseInsensitive: boolean): SeatbeltFilter {
	if (!caseInsensitive || !/[a-z]/i.test(path)) {
		return `(subpath ${sbplString(path)})`;
	}
	return { prefix: path, suffix: '(/.*)?', caseInsensitive: true };
}

/** One `subpathFilter` as profile text (for a filter nested in another). */
function subpathText(path: string, caseInsensitive: boolean): string {
	const filter = subpathFilter(path, caseInsensitive);
	return typeof filter === 'string' ? filter : mergeFilters([filter])[0];
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
			'(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (literal "/dev/tty"))',
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
			out.push(rule('allow file-read*', read));
		}
	}

	// Writes: everything else is denied (by default, or explicitly with system services on).
	if (policy.systemServices) {
		out.push(`(deny file-write* ${message})`);
	}
	const write: SeatbeltFilter[] = [
		`(regex ${DEVICE_FILES})`,
		...policy.write.map(path => `(subpath ${sbplString(path)})`),
		...policy.writeFiles.flatMap((file): SeatbeltFilter[] => [`(literal ${sbplString(file)})`, { prefix: file, suffix: '\\.(lock|tmp|backup|bak|swp)[^/]*', caseInsensitive: false }]),
	];
	out.push(rule('allow file-read* file-write*', write));

	// `.git` as an allow list (B-03): read-only except what commits, merges, rebases and fetches
	// write. Name patterns, so a `commondir`, hook or config created later is covered as well, and
	// the `.git` entry itself cannot be replaced, moved or removed.
	if (policy.gitDirs.length) {
		const git = (suffix: string): IPathRegex[] => policy.gitDirs.map(dir => dir.anyDepth
			? { prefix: dir.root === '/' ? '' : dir.root, suffix: `/(.*/)?${regexBody('.git', ci)}${suffix}`, caseInsensitive: ci }
			: { prefix: dir.root, suffix, caseInsensitive: ci });
		const worktree = '(worktrees/[^/]+/)?';
		out.push(
			rule(`deny file-write* ${message}`, git('(/.*)?')),
			rule('allow file-write*', [...git(`/${worktree}${GIT_WRITABLE_REGEX.dirs}(/.*)?`), ...git(`/${worktree}${GIT_WRITABLE_REGEX.files}`)]),
			rule(`deny file-write* ${message}`, git(`/${worktree}${GIT_WRITABLE_REGEX.readonlyObjects}`)),
		);
	}

	// Protected: readable, never writable, even inside a writable folder.
	const protect = [
		...policy.protect.map(path => subpathFilter(path, ci)),
		...patternFilters(policy.protectPatterns, ci),
	];
	if (protect.length) {
		out.push(rule(`deny file-write* ${message}`, protect));
	}
	// A new repository brings its own config and hooks: no `.git` entry may be created below a workspace.
	if (policy.newRepositoryGuard.length) {
		out.push(rule(`deny file-write-create ${message}`, policy.newRepositoryGuard.map(root => ({ prefix: root, suffix: `/(.*/)?${regexBody('.git', ci)}`, caseInsensitive: ci }))));
	}

	// Denied: neither readable nor writable, last so nothing above re-allows it.
	const deny = [
		...policy.deny.map(path => subpathFilter(path, ci)),
		...patternFilters(policy.denyPatterns, ci),
		// Other runs' folders and other principals' caches: everything below the root but our own.
		...(policy.isolated ?? []).map(({ root, keep }) => `(require-all ${subpathText(root, ci)} (require-not (subpath ${sbplString(keep)})))`),
	];
	if (deny.length) {
		out.push(rule(`deny file-read* file-write* ${message}`, deny));
	}
	// Other terminals, whatever the base: their input and output belong to the user (B-26).
	out.push(`(deny file-read* file-write* file-ioctl ${message} (regex ${TERMINAL_DEVICES}))`);

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

	// Listening (B-30): only the granted ports, so a sandbox cannot squat an OAuth callback or a dev
	// server's port, or serve pages for the in-app browser. With an open network everything else is
	// allowed, so TCP binds are denied explicitly; in the other modes the default already denies them.
	// Verified on macOS 26.6: only a `tcp` bind deny with an `ip` inbound deny can be re-allowed per
	// port; UDP sockets (Node's dgram binds before sending) stay usable through the udp inbound allow.
	if (!policy.network.listen) {
		if (policy.network.mode === 'host') {
			out.push(`(deny network-bind ${message} (local tcp "*:*"))`, `(deny network-inbound ${message} (local ip "*:*"))`, '(allow network-inbound (local udp "*:*"))');
		}
		const listenPorts = [...new Set(policy.network.listenPorts ?? [])].filter(port => Number.isInteger(port) && port > 0 && port < 65536);
		if (listenPorts.length) {
			out.push('(allow system-socket)', `(allow network-bind network-inbound\n\t${listenPorts.map(port => `(local ip ${sbplString(`localhost:${port}`)})`).join('\n\t')})`);
		}
	}

	// Unix sockets: none but the granted ones (and DNS with an open network), whatever the mode.
	out.push(`(deny network-outbound ${message} (remote unix-socket))`);
	const sockets = [...policy.unixSockets, ...(policy.network.mode === 'host' ? [MDNS_SOCKET] : [])];
	if (sockets.length) {
		out.push(`(allow network-outbound\n\t${sockets.map(socket => `(remote unix-socket (path-literal ${sbplString(socket)}))`).join('\n\t')})`);
	}
	if (policy.network.mode !== 'host') {
		// The system resolver is a DNS channel past the proxy (exfiltration in names): closed even
		// when a granted socket list or the allow-default base would reach it.
		out.push(`(deny network-outbound ${message} (remote unix-socket (path-literal ${sbplString(MDNS_SOCKET)})))`);
		if (policy.systemServices) {
			out.push(`(deny mach-lookup ${message}\n\t${DNS_SERVICES.map(name => `(global-name ${sbplString(name)})`).join('\n\t')})`);
		}
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

/** File descriptors of the launch protocol (F.5), in `extraStdio` order from fd 3. */
export const SEATBELT_FDS = { status: 3, go: 4 } as const;

/**
 * The prologue that runs inside the sandbox before the workload (F.5): sets limits, runs the
 * canary (the run's sentinel credential must be unreadable), writes `ready` with its pid and the
 * canary's result to fd 3, then blocks on fd 4 for the go byte. Volt sends `g` and a newline (and closes the
 * pipe) only after it attested this very process from outside with `sandbox_check`; any other
 * byte, EOF (Volt gone or refusing) or nothing at all means the workload never runs: exit 125.
 * The ready line is informational: an unsandboxed process can write the same text. Constant
 * text: values arrive as positional arguments only.
 * Arguments: <cpu seconds|-> <file size in 512-byte blocks|-> <open files|-> <sentinel> <command> <args...>
 */
export const SEATBELT_PROLOGUE = [
	'c=$1 f=$2 n=$3 s=$4; shift 4',
	'[ "$c" = - ] || ulimit -t "$c" || exit 125',
	'[ "$f" = - ] || ulimit -f "$f" || exit 125',
	'[ "$n" = - ] || ulimit -n "$n" || exit 125',
	'l=; { read -r l < "$s"; } 2>/dev/null; if [ -n "$l" ]; then k=open; else k=denied; fi',
	'printf "volt-sandbox-ready %s cred=%s\\n" "$$" "$k" >&3 || exit 125',
	'exec 3>&-',
	'g=; read -r g <&4; exec 4<&-; [ "$g" = g ] || exit 125',
	'exec "$@"',
].join('\n');
