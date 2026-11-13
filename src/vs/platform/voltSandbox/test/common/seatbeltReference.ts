/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GIT_WRITABLE_REGEX } from '../../common/sandboxProfiles.js';
import { IResolvedPattern, IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { ISeatbeltProfileOptions, MDNS_SOCKET, SEATBELT_TAG_PREFIX, sbplString } from '../../common/seatbelt.js';

/**
 * The Seatbelt profile generator as it was at 7404e01ac8f, before PERF-SB merged path regexes:
 * one filter per rule entry, nothing deduplicated. Frozen as the reference SB-EQ-1 compares the
 * production profile with under real `sandbox-exec`. Do not change it to follow `seatbelt.ts`.
 */

/**
 * Device files every process reads or writes (its controlling terminal as `/dev/tty`, /dev/null,
 * the dtrace helper Node and git open). Never `/dev/ttys*`: those are the user's other terminals,
 * whose input a sandbox could read (a sudo password) or write to (B-26). A terminal the run was
 * given arrives as an inherited fd, which needs no path.
 */
const DEVICE_FILES = '#"^/dev/(null|zero|tty|ptmx|dtracehelper|fd/[0-9]+|stdout|stderr|stdin|random|urandom)$"';

/** Every terminal device by path: denied in every profile, the allow-default one included. */
const TERMINAL_DEVICES = '#"^/dev/ttys[0-9]+$"';

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
	// Persistence run at login outside the sandbox: SMAppService/SMJobBless, login items, launch agents.
	'com.apple.xpc.smd',
	'com.apple.xpc.loginitemregisterd',
	'com.apple.backgroundtaskmanagement',
	'com.apple.backgroundtaskmanagementagent',
	'com.apple.backgroundtaskmanagement.agent',
	'com.apple.coreservices.sharedfilelistd.xpc',
	// The LaunchServices database: making the agent's app a URL or document handler the host opens.
	'com.apple.lsd.modifydb',
	'com.apple.lsd.open',
	'com.apple.coreservices.launchservicesd',
];

/** DNS lookups outside the broker: denied unless the network is open (B-31, J.1 "DNS"). */
const DNS_SERVICES = ['com.apple.dnssd.service'];

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

function sbplRegex(value: string, suffix = '', caseInsensitive = false): string {
	return `#"^${regexBody(value, caseInsensitive)}${suffix}$"`;
}

function patternRegex(pattern: IResolvedPattern, caseInsensitive: boolean): string {
	const root = pattern.root === '/' ? '' : regexBody(pattern.root, caseInsensitive);
	const names = pattern.names.map(name => regexBody(name, caseInsensitive)).join('/');
	return `#"^${root}/(.*/)?${names}(/.*)?$"`;
}

function subpathFilter(path: string, caseInsensitive: boolean): string {
	if (!caseInsensitive || !/[a-z]/i.test(path)) {
		return `(subpath ${sbplString(path)})`;
	}
	return `(regex ${sbplRegex(path, '(/.*)?', true)})`;
}

export function buildReferenceSeatbeltProfile(policy: IResolvedSandboxPolicy, options: ISeatbeltProfileOptions): string {
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

	// `.git` as an allow list (B-03): read-only except what commits, merges, rebases and fetches
	// write. Name patterns, so a `commondir`, hook or config created later is covered as well, and
	// the `.git` entry itself cannot be replaced, moved or removed.
	if (policy.gitDirs.length) {
		const prefixes = policy.gitDirs.map(dir => dir.anyDepth
			? `${dir.root === '/' ? '' : regexBody(dir.root, ci)}/(.*/)?${regexBody('.git', ci)}`
			: regexBody(dir.root, ci));
		const worktree = '(worktrees/[^/]+/)?';
		out.push(
			`(deny file-write* ${message}\n\t${prefixes.map(p => `(regex #"^${p}(/.*)?$")`).join('\n\t')})`,
			`(allow file-write*\n\t${prefixes.flatMap(p => [`(regex #"^${p}/${worktree}${GIT_WRITABLE_REGEX.dirs}(/.*)?$")`, `(regex #"^${p}/${worktree}${GIT_WRITABLE_REGEX.files}$")`]).join('\n\t')})`,
			`(deny file-write* ${message}\n\t${prefixes.map(p => `(regex #"^${p}/${worktree}${GIT_WRITABLE_REGEX.readonlyObjects}$")`).join('\n\t')})`,
		);
	}

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
		// Other runs' folders and other principals' caches: everything below the root but our own.
		...(policy.isolated ?? []).map(({ root, keep }) => `(require-all ${subpathFilter(root, ci)} (require-not (subpath ${sbplString(keep)})))`),
	];
	if (deny.length) {
		out.push(`(deny file-read* file-write* ${message}\n\t${deny.join('\n\t')})`);
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
