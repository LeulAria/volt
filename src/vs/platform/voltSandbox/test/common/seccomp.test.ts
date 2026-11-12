/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AF_INET, AF_INET6, AF_NETLINK, AF_UNIX, AF_VSOCK, allowedSocketFamilies, NETLINK_ROUTE, buildSeccompFilter, CLONE_NAMESPACE_FLAGS, EAFNOSUPPORT, encodeSeccompProgram, ENOSYS, EPERM, SECCOMP_AUDIT_ARCH, SECCOMP_DENIED_SYSCALLS, SECCOMP_DENIED_SYSCALLS_X64, SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO, SECCOMP_RET_KILL_PROCESS, SECCOMP_SYSCALL_NUMBERS, SeccompArch, seccompArch, seccompInstructions, TIOCLINUX, TIOCSTI } from '../../common/seccomp.js';

/**
 * A classic-BPF interpreter for the instructions the builder emits, run against a synthetic
 * `struct seccomp_data`, so the tests check what the kernel would decide, not just bytes.
 */
function evaluate(program: Uint8Array, data: { nr: number; arch: number; args?: readonly bigint[] }): number {
	assert.strictEqual(program.length % 8, 0, 'whole sock_filter entries');
	const count = program.length / 8;
	const code = new DataView(program.buffer, program.byteOffset, program.byteLength);
	const mem = new DataView(new ArrayBuffer(64));
	mem.setInt32(0, data.nr, true);
	mem.setUint32(4, data.arch, true);
	(data.args ?? []).forEach((arg, index) => mem.setBigUint64(16 + 8 * index, BigInt.asUintN(64, arg), true));
	let a = 0;
	let pc = 0;
	for (let steps = 0; steps < 10_000; steps++) {
		assert.ok(pc < count, 'the program never runs off its end');
		const op = code.getUint16(pc * 8, true);
		const jt = code.getUint8(pc * 8 + 2);
		const jf = code.getUint8(pc * 8 + 3);
		const k = code.getUint32(pc * 8 + 4, true);
		switch (op) {
			case 0x20: a = mem.getUint32(k, true); pc++; break;
			case 0x15: pc += 1 + (a === k ? jt : jf); break;
			case 0x35: pc += 1 + (a >= k ? jt : jf); break;
			case 0x45: pc += 1 + ((a & k) !== 0 ? jt : jf); break;
			case 0x06: return k;
			default: throw new Error(`unexpected opcode 0x${op.toString(16)} at ${pc}`);
		}
	}
	throw new Error('no return');
}

const ARCHES: readonly SeccompArch[] = ['x64', 'arm64'];
const ERR_EPERM = (SECCOMP_RET_ERRNO | EPERM) >>> 0;
const ERR_ENOSYS = (SECCOMP_RET_ERRNO | ENOSYS) >>> 0;
const ERR_EAFNOSUPPORT = (SECCOMP_RET_ERRNO | EAFNOSUPPORT) >>> 0;
const SIGCHLD = 17n;

function decide(arch: SeccompArch, name: string, args: readonly bigint[] = [], blockUnixSockets = true): number {
	const program = buildSeccompFilter(arch, { blockUnixSockets });
	return evaluate(program, { nr: SECCOMP_SYSCALL_NUMBERS[arch][name], arch: SECCOMP_AUDIT_ARCH[arch], args });
}

suite('Volt sandbox seccomp filter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('serializes struct sock_filter little-endian, 8 bytes each', () => {
		const instructions = seccompInstructions('arm64', { blockUnixSockets: true });
		const bytes = buildSeccompFilter('arm64', { blockUnixSockets: true });
		assert.strictEqual(bytes.length, instructions.length * 8);
		assert.deepStrictEqual([...encodeSeccompProgram([{ code: 0x15, jt: 1, jf: 2, k: 0xC00000B7 }])], [0x15, 0x00, 0x01, 0x02, 0xB7, 0x00, 0x00, 0xC0]);
		assert.ok(instructions.length < 4096, 'within BPF_MAXINSNS');
	});

	test('checks the architecture first and kills on a mismatch', () => {
		for (const arch of ARCHES) {
			const [load, check, kill, loadNr] = seccompInstructions(arch, { blockUnixSockets: false });
			assert.deepStrictEqual(load, { code: 0x20, jt: 0, jf: 0, k: 4 }, 'ld [arch]');
			assert.deepStrictEqual(check, { code: 0x15, jt: 1, jf: 0, k: SECCOMP_AUDIT_ARCH[arch] });
			assert.deepStrictEqual(kill, { code: 0x06, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS });
			assert.deepStrictEqual(loadNr, { code: 0x20, jt: 0, jf: 0, k: 0 }, 'ld [nr]');
		}
		const program = buildSeccompFilter('x64', { blockUnixSockets: false });
		// i386 (int 0x80) and AArch32 calls carry another arch and their own syscall table.
		assert.strictEqual(evaluate(program, { nr: 0, arch: 0x40000003 }), SECCOMP_RET_KILL_PROCESS);
		assert.strictEqual(evaluate(buildSeccompFilter('arm64', { blockUnixSockets: false }), { nr: 0, arch: 0x40000028 }), SECCOMP_RET_KILL_PROCESS);
		assert.strictEqual(evaluate(program, { nr: 0, arch: SECCOMP_AUDIT_ARCH.arm64 }), SECCOMP_RET_KILL_PROCESS);
	});

	test('x86_64 refuses the x32 ABI', () => {
		const program = buildSeccompFilter('x64', { blockUnixSockets: false });
		assert.strictEqual(evaluate(program, { nr: 0x40000000, arch: SECCOMP_AUDIT_ARCH.x64 }), ERR_EPERM);
		assert.strictEqual(evaluate(program, { nr: 0x40000000 + 56, arch: SECCOMP_AUDIT_ARCH.x64 }), ERR_EPERM, 'x32 clone');
	});

	test('every denied syscall returns EPERM on both architectures', () => {
		for (const arch of ARCHES) {
			for (const name of SECCOMP_DENIED_SYSCALLS) {
				assert.strictEqual(decide(arch, name), ERR_EPERM, `${arch} ${name}`);
			}
		}
		for (const name of SECCOMP_DENIED_SYSCALLS_X64) {
			assert.strictEqual(decide('x64', name), ERR_EPERM, `x64 ${name}`);
		}
	});

	test('x86_64-only denials do not hit arm64 syscalls with the same numbers', () => {
		const program = buildSeccompFilter('arm64', { blockUnixSockets: true });
		// 172 is iopl on x86_64 and getpid on arm64; 173 ioperm / getppid; 134 uselib / rt_sigaction.
		for (const nr of [172, 173, 134]) {
			assert.strictEqual(evaluate(program, { nr, arch: SECCOMP_AUDIT_ARCH.arm64 }), SECCOMP_RET_ALLOW, `arm64 nr ${nr}`);
		}
	});

	test('ordinary syscalls are allowed', () => {
		const ordinary: Record<SeccompArch, Record<string, number>> = {
			x64: { read: 0, write: 1, openat: 257, execve: 59, futex: 202, socketpair: 53, connect: 42 },
			arm64: { read: 63, write: 64, openat: 56, execve: 221, futex: 98, socketpair: 199, connect: 203 },
		};
		for (const arch of ARCHES) {
			const program = buildSeccompFilter(arch, { blockUnixSockets: true });
			for (const [name, nr] of Object.entries(ordinary[arch])) {
				assert.strictEqual(evaluate(program, { nr, arch: SECCOMP_AUDIT_ARCH[arch] }), SECCOMP_RET_ALLOW, `${arch} ${name}`);
			}
		}
	});

	test('clone3 fails with ENOSYS so libc falls back to clone', () => {
		for (const arch of ARCHES) {
			assert.strictEqual(decide(arch, 'clone3'), ERR_ENOSYS);
		}
	});

	test('clone is refused with any namespace flag, allowed for fork and threads', () => {
		const flags = { NEWNS: 0x20000n, NEWCGROUP: 0x02000000n, NEWUTS: 0x04000000n, NEWIPC: 0x08000000n, NEWUSER: 0x10000000n, NEWPID: 0x20000000n, NEWNET: 0x40000000n, NEWTIME: 0x80n };
		assert.strictEqual(Number(Object.values(flags).reduce((a, b) => a | b, 0n)), CLONE_NAMESPACE_FLAGS);
		for (const arch of ARCHES) {
			for (const [name, flag] of Object.entries(flags)) {
				assert.strictEqual(decide(arch, 'clone', [flag | SIGCHLD]), ERR_EPERM, `${arch} CLONE_${name}`);
			}
			assert.strictEqual(decide(arch, 'clone', [SIGCHLD]), SECCOMP_RET_ALLOW, `${arch} fork`);
			assert.strictEqual(decide(arch, 'clone', [0x3d0f00n]), SECCOMP_RET_ALLOW, `${arch} pthread_create`);
			assert.strictEqual(decide(arch, 'clone', [0x4111n]), SECCOMP_RET_ALLOW, `${arch} vfork (CLONE_VM|CLONE_VFORK|SIGCHLD)`);
			// The kernel reads only the low 32 bits of clone's flags.
			assert.strictEqual(decide(arch, 'clone', [(1n << 40n) | SIGCHLD]), SECCOMP_RET_ALLOW, `${arch} high bits ignored`);
			assert.strictEqual(decide(arch, 'clone', [(1n << 40n) | 0x10000000n]), ERR_EPERM, `${arch} high bits cannot hide CLONE_NEWUSER`);
		}
	});

	test('ioctl refuses TIOCSTI and TIOCLINUX, including with high bits set', () => {
		for (const arch of ARCHES) {
			assert.strictEqual(decide(arch, 'ioctl', [0n, BigInt(TIOCSTI)]), ERR_EPERM);
			assert.strictEqual(decide(arch, 'ioctl', [0n, BigInt(TIOCLINUX)]), ERR_EPERM);
			assert.strictEqual(decide(arch, 'ioctl', [0n, (1n << 32n) | BigInt(TIOCSTI)]), ERR_EPERM, 'the kernel truncates cmd to 32 bits');
			assert.strictEqual(decide(arch, 'ioctl', [0n, 0x5401n]), SECCOMP_RET_ALLOW, 'TCGETS');
			assert.strictEqual(decide(arch, 'ioctl', [BigInt(TIOCSTI), 0x5413n]), SECCOMP_RET_ALLOW, 'TIOCGWINSZ (the fd is not the request)');
		}
	});

	test('socket(AF_UNIX) is refused only when asked', () => {
		for (const arch of ARCHES) {
			assert.strictEqual(decide(arch, 'socket', [BigInt(AF_UNIX), 1n, 0n], true), ERR_EPERM);
			assert.strictEqual(decide(arch, 'socket', [BigInt(AF_UNIX), 1n, 0n], false), SECCOMP_RET_ALLOW);
			assert.strictEqual(decide(arch, 'socket', [2n, 1n, 0n], true), SECCOMP_RET_ALLOW, 'AF_INET');
			assert.strictEqual(decide(arch, 'socket', [10n, 2n, 0n], true), SECCOMP_RET_ALLOW, 'AF_INET6');
		}
	});

	test('NET-LISTEN-1 (Linux, host network): listen is refused only when asked', () => {
		for (const arch of ARCHES) {
			const nr = SECCOMP_SYSCALL_NUMBERS[arch].listen;
			assert.strictEqual(evaluate(buildSeccompFilter(arch, { blockUnixSockets: true, blockListen: true }), { nr, arch: SECCOMP_AUDIT_ARCH[arch] }), ERR_EPERM, arch);
			assert.strictEqual(evaluate(buildSeccompFilter(arch, { blockUnixSockets: true }), { nr, arch: SECCOMP_AUDIT_ARCH[arch] }), SECCOMP_RET_ALLOW, `${arch}: its own namespace`);
			const program = seccompInstructions(arch, { blockUnixSockets: true, blockListen: true });
			program.forEach((instruction, index) => {
				if ((instruction.code & 0x07) === 0x05) {
					assert.ok(index + 1 + Math.max(instruction.jt, instruction.jf) < program.length, `${arch} target of ${index}`);
				}
			});
		}
		assert.strictEqual(SECCOMP_SYSCALL_NUMBERS.x64.listen, 50);
		assert.strictEqual(SECCOMP_SYSCALL_NUMBERS.arm64.listen, 201);
	});

	test('LNX-SECCOMP-1: socket families outside inet, inet6, granted unix and netlink route fail with EAFNOSUPPORT', () => {
		const families = { AF_KEY: 15, AF_PACKET: 17, AF_TIPC: 30, AF_BLUETOOTH: 31, AF_ALG: 38, AF_VSOCK: AF_VSOCK, AF_XDP: 44, AF_MAX_PLUS: 1000 };
		for (const arch of ARCHES) {
			for (const blockUnixSockets of [true, false]) {
				for (const [name, family] of Object.entries(families)) {
					assert.strictEqual(decide(arch, 'socket', [BigInt(family), 1n, 0n], blockUnixSockets), ERR_EAFNOSUPPORT, `${arch} ${name}`);
				}
				assert.strictEqual(decide(arch, 'socket', [BigInt(AF_INET), 1n, 0n], blockUnixSockets), SECCOMP_RET_ALLOW, `${arch} AF_INET`);
				assert.strictEqual(decide(arch, 'socket', [BigInt(AF_INET6), 2n, 0n], blockUnixSockets), SECCOMP_RET_ALLOW, `${arch} AF_INET6`);
				// The kernel takes `int domain`: high bits cannot smuggle AF_VSOCK past the check.
				assert.strictEqual(decide(arch, 'socket', [(1n << 32n) | BigInt(AF_VSOCK), 1n, 0n], blockUnixSockets), ERR_EAFNOSUPPORT, `${arch} high bits`);
				// Netlink: the routing protocol only (getifaddrs); audit, uevent, netfilter, generic are refused.
				assert.strictEqual(decide(arch, 'socket', [BigInt(AF_NETLINK), 3n, BigInt(NETLINK_ROUTE)], blockUnixSockets), SECCOMP_RET_ALLOW, `${arch} netlink route`);
				for (const protocol of [9n, 12n, 15n, 16n]) {
					assert.strictEqual(decide(arch, 'socket', [BigInt(AF_NETLINK), 3n, protocol], blockUnixSockets), ERR_EAFNOSUPPORT, `${arch} netlink ${protocol}`);
				}
				assert.strictEqual(decide(arch, 'socket', [BigInt(AF_NETLINK), 3n, (1n << 32n) | 9n], blockUnixSockets), ERR_EAFNOSUPPORT, `${arch} netlink protocol high bits`);
			}
			assert.deepStrictEqual(allowedSocketFamilies({ blockUnixSockets: true }), [AF_INET, AF_INET6]);
		}
	});

	test('LNX-SECCOMP-2: modify_ldt, kcmp, pidfd_getfd, process_madvise, vmsplice and the NUMA calls are refused', () => {
		const added = ['kcmp', 'pidfd_getfd', 'process_madvise', 'vmsplice', 'mbind', 'set_mempolicy', 'get_mempolicy', 'migrate_pages', 'move_pages', 'set_mempolicy_home_node'];
		for (const arch of ARCHES) {
			for (const name of added) {
				assert.ok(SECCOMP_DENIED_SYSCALLS.includes(name), name);
				assert.strictEqual(decide(arch, name), ERR_EPERM, `${arch} ${name}`);
			}
		}
		assert.strictEqual(decide('x64', 'modify_ldt'), ERR_EPERM);
		assert.strictEqual(SECCOMP_SYSCALL_NUMBERS.arm64.modify_ldt, undefined, 'modify_ldt does not exist on arm64');
	});

	test('jumps are forward, small, and land inside the program', () => {
		for (const arch of ARCHES) {
			for (const blockUnixSockets of [true, false]) {
				// With the listen block (NET-LISTEN-1) and the socket family allow list (LNX-SECCOMP-1) together too.
				for (const blockListen of [false, true]) {
					const program = seccompInstructions(arch, { blockUnixSockets, blockListen });
					program.forEach((instruction, index) => {
						if ((instruction.code & 0x07) === 0x05) {
							assert.ok(instruction.jt <= 5 && instruction.jf <= 5, `${arch} jump at ${index}`);
							assert.ok(index + 1 + Math.max(instruction.jt, instruction.jf) < program.length, `${arch} target of ${index}`);
						}
					});
					assert.deepStrictEqual(program[program.length - 1], { code: 0x06, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
					const filter = buildSeccompFilter(arch, { blockUnixSockets, blockListen });
					const run = (name: string, args: readonly bigint[] = []) => evaluate(filter, { nr: SECCOMP_SYSCALL_NUMBERS[arch][name], arch: SECCOMP_AUDIT_ARCH[arch], args });
					assert.strictEqual(run('listen'), blockListen ? ERR_EPERM : SECCOMP_RET_ALLOW, `${arch} listen`);
					assert.strictEqual(run('socket', [BigInt(AF_INET), 1n, 0n]), SECCOMP_RET_ALLOW, `${arch} AF_INET`);
					assert.strictEqual(run('socket', [BigInt(AF_UNIX), 1n, 0n]), blockUnixSockets ? ERR_EPERM : SECCOMP_RET_ALLOW, `${arch} AF_UNIX`);
					assert.strictEqual(run('socket', [BigInt(AF_VSOCK), 1n, 0n]), ERR_EAFNOSUPPORT, `${arch} AF_VSOCK`);
					assert.strictEqual(run('socket', [BigInt(AF_NETLINK), 3n, BigInt(NETLINK_ROUTE)]), SECCOMP_RET_ALLOW, `${arch} netlink route`);
				}
			}
		}
	});

	test('the syscall tables cover every denial with distinct numbers', () => {
		for (const arch of ARCHES) {
			const table = SECCOMP_SYSCALL_NUMBERS[arch];
			const names = [...SECCOMP_DENIED_SYSCALLS, 'clone', 'clone3', 'ioctl', 'socket', ...(arch === 'x64' ? SECCOMP_DENIED_SYSCALLS_X64 : [])];
			for (const name of names) {
				assert.ok(Number.isInteger(table[name]), `${arch} ${name}`);
			}
			const numbers = Object.values(table);
			assert.strictEqual(new Set(numbers).size, numbers.length, `${arch} numbers are distinct`);
		}
		assert.strictEqual(SECCOMP_SYSCALL_NUMBERS.arm64.iopl, undefined, 'iopl does not exist on arm64');
	});

	test('maps node architectures', () => {
		assert.strictEqual(seccompArch('x64'), 'x64');
		assert.strictEqual(seccompArch('arm64'), 'arm64');
		assert.strictEqual(seccompArch('ia32'), undefined);
		assert.strictEqual(seccompArch('riscv64'), undefined);
	});
});
