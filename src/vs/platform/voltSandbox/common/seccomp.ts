/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The seccomp filter bubblewrap installs on a sandboxed workload (`bwrap --seccomp FD`).
 *
 * A classic-BPF program (an array of `struct sock_filter { u16 code; u8 jt; u8 jf; u32 k; }`,
 * little-endian, 8 bytes each) built here without libseccomp, so Volt ships no binary and every
 * instruction is visible in this file. It is a denylist on top of what the namespaces already
 * take away (the workload has no capabilities, so most of these would fail anyway): it closes the
 * kernel surfaces a sandbox escape usually starts from (new namespaces, mounts, ptrace, keyrings,
 * BPF, io_uring, userfaultfd) and the terminal injection ioctls.
 *
 * Layout, top to bottom (every jump is forward and at most 5, so no offset can overflow a u8):
 * 1. `arch` must be this program's architecture, else the process is killed: a 32-bit syscall
 *    (int 0x80 on x86_64, AArch32 on arm64) would otherwise be matched against the wrong table.
 * 2. x86_64: the x32 ABI (syscall numbers with bit 30 set) is refused.
 * 3. One `jeq nr; ret ERRNO(EPERM)` pair per denied syscall.
 * 4. `clone3` fails with ENOSYS (its flags live in a struct a filter cannot read), so libc falls
 *    back to `clone`, whose flags are checked: any namespace flag is refused.
 * 5. `ioctl(TIOCSTI)` and `ioctl(TIOCLINUX)` are refused (typing into the host terminal).
 * 6. `socket(domain, ...)` takes an allow list of families: `AF_INET` and `AF_INET6`, and
 *    `AF_UNIX` only when the policy grants a unix socket (else EPERM, so no host unix socket can
 *    be reached even if one is visible). `AF_NETLINK` only with protocol `NETLINK_ROUTE`: libc's
 *    `getifaddrs` reads the interface list through it (Node's `os.networkInterfaces()`, which dev
 *    servers call at startup, throws without it); it shows the sandbox's own network namespace and
 *    changes nothing without CAP_NET_ADMIN, which the sandbox lacks. Every other family or netlink
 *    protocol (`AF_VSOCK` reaches the hypervisor from an empty network namespace; `AF_PACKET`,
 *    `AF_ALG`, `AF_KEY`, `AF_TIPC`, netlink audit, uevent and netfilter load rarely used kernel
 *    code) fails with EAFNOSUPPORT, as if the kernel lacked it.
 *    `socketpair` stays allowed: it cannot reach anything and runtimes use it for child pipes.
 * 7. Everything else is allowed.
 */

export type SeccompArch = 'x64' | 'arm64';

/** `AUDIT_ARCH_X86_64` and `AUDIT_ARCH_AARCH64` from linux/audit.h. */
export const SECCOMP_AUDIT_ARCH: Readonly<Record<SeccompArch, number>> = { x64: 0xC000003E, arm64: 0xC00000B7 };

/** Bit 30 marks an x32-ABI syscall on x86_64 (`__X32_SYSCALL_BIT`). */
export const X32_SYSCALL_BIT = 0x40000000;

export const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_RET_ERRNO = 0x00050000;
export const SECCOMP_RET_ALLOW = 0x7fff0000;
export const EPERM = 1;
export const ENOSYS = 38;
export const EAFNOSUPPORT = 97;

/** `CLONE_NEWNS|CLONE_NEWCGROUP|CLONE_NEWUTS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWTIME`. */
export const CLONE_NAMESPACE_FLAGS = 0x7E020080;
export const TIOCSTI = 0x5412;
export const TIOCLINUX = 0x541C;
export const AF_UNIX = 1;
export const AF_INET = 2;
export const AF_INET6 = 10;
export const AF_NETLINK = 16;
export const NETLINK_ROUTE = 0;
export const AF_VSOCK = 40;

/** Refused with EPERM on every architecture. */
export const SECCOMP_DENIED_SYSCALLS: readonly string[] = [
	// Mounts and namespaces: the sandbox's view of the filesystem and its namespaces are final.
	'mount', 'umount2', 'pivot_root', 'move_mount', 'open_tree', 'fsopen', 'fsconfig', 'fsmount', 'fspick', 'mount_setattr',
	'unshare', 'setns',
	// Other processes' memory.
	'ptrace', 'process_vm_readv', 'process_vm_writev',
	// Kernel keyrings are shared per user across namespaces.
	'keyctl', 'add_key', 'request_key',
	// Large kernel attack surfaces with no use in a build or an agent.
	'bpf', 'perf_event_open', 'userfaultfd', 'io_uring_setup', 'io_uring_enter', 'io_uring_register',
	// The machine itself.
	'kexec_load', 'kexec_file_load', 'init_module', 'finit_module', 'delete_module', 'reboot', 'swapon', 'swapoff',
	'syslog', 'acct', 'quotactl', 'lookup_dcookie', 'vhangup',
	'settimeofday', 'clock_settime', 'clock_adjtime', 'adjtimex',
	// File handles bypass path-based access (the classic container escape) and fanotify watches the host.
	'open_by_handle_at', 'name_to_handle_at', 'fanotify_init',
	// Other processes' file descriptors and memory, and kernel-object comparisons across processes.
	'kcmp', 'pidfd_getfd', 'process_madvise',
	// Pipe page gifting, a recurring source of kernel memory bugs (Dirty Pipe's neighbourhood).
	'vmsplice',
	// NUMA placement: no use in a sandbox, and page migration acts on other processes.
	'mbind', 'set_mempolicy', 'get_mempolicy', 'migrate_pages', 'move_pages', 'set_mempolicy_home_node',
];

/** Refused with EPERM on x86_64 only (they do not exist on arm64). `modify_ldt`: 16-bit segments, a classic kernel attack surface. */
export const SECCOMP_DENIED_SYSCALLS_X64: readonly string[] = ['iopl', 'ioperm', 'uselib', 'modify_ldt'];

/**
 * Syscall numbers. x86_64 from arch/x86/entry/syscalls/syscall_64.tbl, arm64 from
 * include/uapi/asm-generic/unistd.h. Every number was verified on 2026-11-04 by compiling a
 * program that prints `__NR_<name>` against linux-libc-dev 6.8 (Ubuntu 24.04) natively on arm64
 * and under `docker run --platform linux/amd64`; `scripts/volt-sandbox-linux-test.sh
 * verify-syscalls` repeats that check.
 */
export const SECCOMP_SYSCALL_NUMBERS: Readonly<Record<SeccompArch, Readonly<Record<string, number>>>> = {
	x64: {
		ioctl: 16, socket: 41, listen: 50, clone: 56, clone3: 435,
		mount: 165, umount2: 166, pivot_root: 155, move_mount: 429, open_tree: 428, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
		unshare: 272, setns: 308,
		ptrace: 101, process_vm_readv: 310, process_vm_writev: 311,
		keyctl: 250, add_key: 248, request_key: 249,
		bpf: 321, perf_event_open: 298, userfaultfd: 323, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
		kexec_load: 246, kexec_file_load: 320, init_module: 175, finit_module: 313, delete_module: 176, reboot: 169, swapon: 167, swapoff: 168,
		syslog: 103, acct: 163, quotactl: 179, lookup_dcookie: 212, vhangup: 153,
		settimeofday: 164, clock_settime: 227, clock_adjtime: 305, adjtimex: 159,
		open_by_handle_at: 304, name_to_handle_at: 303, fanotify_init: 300,
		kcmp: 312, pidfd_getfd: 438, process_madvise: 440, vmsplice: 278,
		mbind: 237, set_mempolicy: 238, get_mempolicy: 239, migrate_pages: 256, move_pages: 279, set_mempolicy_home_node: 450,
		iopl: 172, ioperm: 173, uselib: 134, modify_ldt: 154,
	},
	arm64: {
		ioctl: 29, socket: 198, listen: 201, clone: 220, clone3: 435,
		mount: 40, umount2: 39, pivot_root: 41, move_mount: 429, open_tree: 428, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
		unshare: 97, setns: 268,
		ptrace: 117, process_vm_readv: 270, process_vm_writev: 271,
		keyctl: 219, add_key: 217, request_key: 218,
		bpf: 280, perf_event_open: 241, userfaultfd: 282, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
		kexec_load: 104, kexec_file_load: 294, init_module: 105, finit_module: 273, delete_module: 106, reboot: 142, swapon: 224, swapoff: 225,
		syslog: 116, acct: 89, quotactl: 60, lookup_dcookie: 18, vhangup: 58,
		settimeofday: 170, clock_settime: 112, clock_adjtime: 266, adjtimex: 171,
		open_by_handle_at: 265, name_to_handle_at: 264, fanotify_init: 262,
		kcmp: 272, pidfd_getfd: 438, process_madvise: 440, vmsplice: 75,
		mbind: 235, set_mempolicy: 237, get_mempolicy: 236, migrate_pages: 238, move_pages: 239, set_mempolicy_home_node: 450,
	},
};

// BPF opcodes (linux/bpf_common.h).
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

/** `struct seccomp_data` offsets. Both architectures are little-endian, so an argument's low 32 bits come first. */
const DATA_NR = 0;
const DATA_ARCH = 4;
const dataArgLow = (index: number) => 16 + 8 * index;

export interface ISeccompInstruction {
	readonly code: number;
	readonly jt: number;
	readonly jf: number;
	readonly k: number;
}

export interface ISeccompFilterOptions {
	/** Refuse `socket(AF_UNIX, ...)`: set when the policy grants no unix socket. */
	readonly blockUnixSockets: boolean;
	/**
	 * Refuse `listen` (B-30): set when the sandbox shares the host's network namespace and may
	 * listen on no port, so it cannot squat a port on the machine. In its own namespace a listener
	 * reaches nothing outside and stays allowed.
	 */
	readonly blockListen?: boolean;
}

/** Socket families a sandboxed process may create (`AF_UNIX` only when a socket is granted), besides `AF_NETLINK` with `NETLINK_ROUTE`. */
export function allowedSocketFamilies(options: ISeccompFilterOptions): number[] {
	return options.blockUnixSockets ? [AF_INET, AF_INET6] : [AF_UNIX, AF_INET, AF_INET6];
}

const load = (offset: number): ISeccompInstruction => ({ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: offset });
const jeq = (k: number, jt: number, jf: number): ISeccompInstruction => ({ code: BPF_JMP_JEQ_K, jt, jf, k: k >>> 0 });
const jge = (k: number, jt: number, jf: number): ISeccompInstruction => ({ code: BPF_JMP_JGE_K, jt, jf, k: k >>> 0 });
const jset = (k: number, jt: number, jf: number): ISeccompInstruction => ({ code: BPF_JMP_JSET_K, jt, jf, k: k >>> 0 });
const ret = (k: number): ISeccompInstruction => ({ code: BPF_RET_K, jt: 0, jf: 0, k: k >>> 0 });
const errno = (value: number) => ret(SECCOMP_RET_ERRNO | value);

/** The filter as instructions, for tests and diagnostics. */
export function seccompInstructions(arch: SeccompArch, options: ISeccompFilterOptions): ISeccompInstruction[] {
	const numbers = SECCOMP_SYSCALL_NUMBERS[arch];
	const nr = (name: string): number => {
		const value = numbers[name];
		if (value === undefined) {
			throw new Error(`No ${arch} syscall number for ${name}`);
		}
		return value;
	};
	const program: ISeccompInstruction[] = [
		load(DATA_ARCH),
		jeq(SECCOMP_AUDIT_ARCH[arch], 1, 0),
		ret(SECCOMP_RET_KILL_PROCESS),
		load(DATA_NR),
	];
	if (arch === 'x64') {
		program.push(jge(X32_SYSCALL_BIT, 0, 1), errno(EPERM));
	}
	const denied = arch === 'x64' ? [...SECCOMP_DENIED_SYSCALLS, ...SECCOMP_DENIED_SYSCALLS_X64] : SECCOMP_DENIED_SYSCALLS;
	for (const name of denied) {
		program.push(jeq(nr(name), 0, 1), errno(EPERM));
	}
	if (options.blockListen) {
		program.push(jeq(nr('listen'), 0, 1), errno(EPERM));
	}
	program.push(jeq(nr('clone3'), 0, 1), errno(ENOSYS));

	// clone(flags, ...): flags is the first argument on both architectures, and the kernel only
	// reads its low 32 bits. Both paths return, so the accumulator never reaches the next test.
	program.push(
		jeq(nr('clone'), 0, 4),
		load(dataArgLow(0)),
		jset(CLONE_NAMESPACE_FLAGS, 0, 1),
		errno(EPERM),
		ret(SECCOMP_RET_ALLOW),
	);

	// ioctl(fd, request, ...): the kernel takes `unsigned int cmd`, so the low 32 bits are the
	// whole request; high bits cannot smuggle TIOCSTI past this check.
	program.push(
		jeq(nr('ioctl'), 0, 5),
		load(dataArgLow(1)),
		jeq(TIOCSTI, 2, 0),
		jeq(TIOCLINUX, 1, 0),
		ret(SECCOMP_RET_ALLOW),
		errno(EPERM),
	);

	// socket(domain, type, protocol), last: anything else is allowed right away. An allow list of
	// families; `domain` and `protocol` are ints, so the low 32 bits are all of them. One
	// `jeq family -> allow` per allowed family (the last one inverted, so the allow sits right
	// after the list and every jump stays short), then AF_UNIX (EPERM when not granted), then
	// AF_NETLINK with NETLINK_ROUTE only, then EAFNOSUPPORT for everything else.
	const families = allowedSocketFamilies(options);
	program.push(jeq(nr('socket'), 1, 0), ret(SECCOMP_RET_ALLOW), load(dataArgLow(0)));
	families.forEach((family, index) => program.push(index < families.length - 1 ? jeq(family, families.length - 1 - index, 0) : jeq(family, 0, 1)));
	program.push(ret(SECCOMP_RET_ALLOW));
	if (options.blockUnixSockets) {
		program.push(jeq(AF_UNIX, 0, 1), errno(EPERM));
	}
	program.push(
		jeq(AF_NETLINK, 0, 2),
		load(dataArgLow(2)),
		jeq(NETLINK_ROUTE, 1, 0),
		errno(EAFNOSUPPORT),
		ret(SECCOMP_RET_ALLOW),
	);
	return program;
}

/** Serializes instructions as `struct sock_filter[]`, little-endian. */
export function encodeSeccompProgram(program: readonly ISeccompInstruction[]): Uint8Array {
	const bytes = new Uint8Array(program.length * 8);
	const view = new DataView(bytes.buffer);
	program.forEach((instruction, index) => {
		const at = index * 8;
		view.setUint16(at, instruction.code, true);
		view.setUint8(at + 2, instruction.jt);
		view.setUint8(at + 3, instruction.jf);
		view.setUint32(at + 4, instruction.k, true);
	});
	return bytes;
}

/** The program bubblewrap reads from `--seccomp FD`. */
export function buildSeccompFilter(arch: SeccompArch, options: ISeccompFilterOptions): Uint8Array {
	return encodeSeccompProgram(seccompInstructions(arch, options));
}

/** Node's `process.arch` as a seccomp architecture, or undefined when Volt has no filter for it. */
export function seccompArch(nodeArch: string): SeccompArch | undefined {
	return nodeArch === 'x64' || nodeArch === 'arm64' ? nodeArch : undefined;
}
