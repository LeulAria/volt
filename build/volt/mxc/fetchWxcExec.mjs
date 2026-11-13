/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fetches Microsoft's signed wxc-exec.exe (MXC, MIT) for Windows builds of Volt: the pinned
// @microsoft/mxc-sdk tarball, checked against its npm integrity, then each binary against the
// SHA-256 pinned in src/vs/platform/voltSandbox/common/mxc.ts. Only wxc-exec.exe is taken from
// the 100 MB package; Volt does not use the Node SDK (it needs Node 24).
//
//   node build/volt/mxc/fetchWxcExec.mjs --out <dir> [--arch arm64|x64]
//   -> <dir>/<arch>/wxc-exec.exe

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', '..', '..', 'src', 'vs', 'platform', 'voltSandbox', 'common', 'mxc.ts'), 'utf8');
const constant = name => {
	const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source);
	if (!match) {
		throw new Error(`${name} not found in mxc.ts`);
	}
	return match[1];
};
const version = constant('MXC_SDK_VERSION');
const integrity = constant('MXC_SDK_INTEGRITY');
const digests = Object.fromEntries([...(/WXC_EXEC_DIGESTS[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '').matchAll(/(\w+):\s*'([0-9a-f]{64})'/g)].map(m => [m[1], m[2]]));

const args = process.argv.slice(2);
const option = name => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const out = option('--out');
if (!out) {
	throw new Error('usage: fetchWxcExec.mjs --out <dir> [--arch arm64|x64]');
}
const arches = option('--arch') ? [option('--arch')] : Object.keys(digests);

const url = `https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-${version}.tgz`;
let tarball;
for (let attempt = 1; ; attempt++) {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		tarball = Buffer.from(await response.arrayBuffer());
		break;
	} catch (err) {
		if (attempt >= 4) {
			throw err;
		}
		await new Promise(resolve => setTimeout(resolve, attempt * 3000));
	}
}
const [algorithm, expected] = integrity.split('-');
const actual = createHash(algorithm).update(tarball).digest('base64');
if (actual !== expected) {
	throw new Error(`@microsoft/mxc-sdk ${version}: integrity ${algorithm}-${actual} does not match the pinned ${integrity}`);
}
const work = mkdtempSync(join(tmpdir(), 'volt-mxc-'));
try {
	const tgz = join(work, 'mxc.tgz');
	writeFileSync(tgz, tarball);
	execFileSync('tar', ['-xzf', tgz, '-C', work, ...arches.map(arch => `package/bin/${arch}/wxc-exec.exe`)], { stdio: 'inherit' });
	for (const arch of arches) {
		const exe = join(work, 'package', 'bin', arch, 'wxc-exec.exe');
		const digest = createHash('sha256').update(readFileSync(exe)).digest('hex');
		if (digest !== digests[arch]) {
			throw new Error(`wxc-exec.exe ${arch}: ${digest} does not match WXC_EXEC_DIGESTS (${digests[arch]})`);
		}
		mkdirSync(join(out, arch), { recursive: true });
		rmSync(join(out, arch, 'wxc-exec.exe'), { force: true });
		renameSync(exe, join(out, arch, 'wxc-exec.exe'));
		console.log(`${join(out, arch, 'wxc-exec.exe')} (MXC ${version}, sha256 ${digest})`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
