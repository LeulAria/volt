/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds volt-mxc-helper.exe (build/volt/mxc/voltMxcHelper.c) for Windows arm64 and x64 with
// `zig cc`, which cross-compiles from macOS, Linux or Windows with its bundled mingw-w64 headers.
// The output is reproducible for a given zig version: CI rebuilds it on Windows and checks the
// digests pinned in src/vs/platform/voltSandbox/common/mxc.ts (MXC_HELPER_DIGESTS).
//
//   node build/volt/mxc/buildHelper.mjs [--out <dir>] [--arch arm64|x64] [--print-digests]

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const option = name => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const out = option('--out') ?? join(root, '.build', 'volt', 'mxc');
const arches = option('--arch') ? [option('--arch')] : ['arm64', 'x64'];
const zig = process.env.ZIG ?? 'zig';
const targets = { arm64: 'aarch64-windows-gnu', x64: 'x86_64-windows-gnu' };

const version = execFileSync(zig, ['version'], { encoding: 'utf8' }).trim();
const digests = {};
for (const arch of arches) {
	const target = targets[arch];
	if (!target) {
		throw new Error(`unknown arch ${arch}`);
	}
	const dir = join(out, arch);
	mkdirSync(dir, { recursive: true });
	const exe = join(dir, 'volt-mxc-helper.exe');
	execFileSync(zig, [
		'cc', '-target', target, '-municode', '-O2', '-s', '-Wall', '-Werror',
		// Reproducible: zig's linker writes no timestamp; keep build paths out of the image.
		'-fno-ident', `-ffile-prefix-map=${root}=.`,
		'-o', exe, join(here, 'voltMxcHelper.c'), '-lws2_32', '-ladvapi32',
	], { stdio: 'inherit', cwd: root });
	digests[arch] = createHash('sha256').update(readFileSync(exe)).digest('hex');
	console.log(`${exe}\n  sha256 ${digests[arch]} (zig ${version})`);
}
if (args.includes('--print-digests')) {
	console.log(JSON.stringify({ zig: version, digests }, null, '\t'));
}
if (args.includes('--check-pinned')) {
	// The digests the backend accepts live in mxc.ts; a build that differs means the source
	// changed without updating them, or the build is not reproducible.
	const source = readFileSync(join(root, 'src', 'vs', 'platform', 'voltSandbox', 'common', 'mxc.ts'), 'utf8');
	const block = /MXC_HELPER_DIGESTS[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '';
	let failed = false;
	for (const arch of arches) {
		const pinned = new RegExp(`${arch}:\\s*'([0-9a-f]{64})'`).exec(block)?.[1];
		if (pinned !== digests[arch]) {
			console.error(`volt-mxc-helper ${arch}: built ${digests[arch]}, mxc.ts pins ${pinned ?? 'nothing'}`);
			failed = true;
		}
	}
	if (failed) {
		process.exit(1);
	}
	console.log('volt-mxc-helper digests match MXC_HELPER_DIGESTS');
}
