/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks the seccomp filter's syscall numbers (src/vs/platform/voltSandbox/common/seccomp.ts)
// against this machine's kernel headers: compiles a tiny C program that prints every `__NR_*` the
// table names, then compares. Linux only; needs gcc or cc and the libc headers. Uses out/.
// For the other architecture, scripts/volt-sandbox-linux-test.sh verify-syscalls runs both in Docker.

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

if (process.platform !== 'linux') {
	console.error('Syscall numbers can only be checked on Linux.');
	process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SECCOMP_SYSCALL_NUMBERS } = await import(pathToFileURL(join(root, 'out/vs/platform/voltSandbox/common/seccomp.js')).href);
const table = SECCOMP_SYSCALL_NUMBERS[process.arch];
if (!table) {
	console.error(`No seccomp table for ${process.arch}: the backend refuses to run here, as it should.`);
	process.exit(1);
}
const names = Object.keys(table).sort();
const source = ['#include <stdio.h>', '#include <sys/syscall.h>', 'int main(void) {',
	...names.map(name => `#ifdef __NR_${name}\n\tprintf("${name} %d\\n", __NR_${name});\n#else\n\tprintf("${name} missing\\n");\n#endif`),
	'\treturn 0;', '}'].join('\n');
const dir = mkdtempSync(join(tmpdir(), 'volt-nr-'));
try {
	writeFileSync(join(dir, 'nr.c'), source);
	const compiler = ['cc', 'gcc'].find(cc => { try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
	if (!compiler) {
		throw new Error('no C compiler');
	}
	execFileSync(compiler, ['-o', join(dir, 'nr'), join(dir, 'nr.c')]);
	const actual = new Map(execFileSync(join(dir, 'nr'), { encoding: 'utf8' }).trim().split('\n').map(line => line.split(' ')));
	const wrong = names.filter(name => String(table[name]) !== actual.get(name));
	for (const name of wrong) {
		console.error(`MISMATCH ${process.arch} ${name}: table ${table[name]}, kernel headers ${actual.get(name)}`);
	}
	if (wrong.length) {
		process.exit(1);
	}
	console.log(`PASS ${process.arch}: ${names.length} syscall numbers match the kernel headers`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
