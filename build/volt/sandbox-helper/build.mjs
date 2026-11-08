/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the macOS sandbox helper (volt-sandbox-helper.c) into .build/volt-helpers, universal
// (arm64 + x86_64), and pins its SHA-256 in volt-helpers.json beside it. The desktop package
// copies that folder into the app (build/gulpfile.vscode.js), where the sandbox backend finds it
// and checks the pin before every launch (src/vs/platform/voltHelpers/node/helperIntegrity.ts).
//
//   node build/volt/sandbox-helper/build.mjs           build when the source is newer
//   node build/volt/sandbox-helper/build.mjs --force   always build
//
// macOS only; elsewhere it does nothing.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
export const HELPER_SOURCE = join(here, 'volt-sandbox-helper.c');
export const HELPER_OUT_DIR = join(root, '.build', 'volt-helpers');
const NAME = 'volt-sandbox-helper';

export function buildSandboxHelper({ force = false, outDir = HELPER_OUT_DIR } = {}) {
	if (process.platform !== 'darwin') {
		return undefined;
	}
	const target = join(outDir, NAME);
	const manifestPath = join(outDir, 'volt-helpers.json');
	if (!force && existsSync(target) && existsSync(manifestPath) && statSync(target).mtimeMs >= statSync(HELPER_SOURCE).mtimeMs) {
		return target;
	}
	mkdirSync(outDir, { recursive: true });
	// Built under its final name (the linker's signature takes its identifier from it), then moved in.
	const tempDir = join(outDir, `.tmp-${process.pid}`);
	mkdirSync(tempDir, { recursive: true });
	const temp = join(tempDir, NAME);
	execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Werror', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0', '-o', temp, HELPER_SOURCE], { stdio: 'inherit' });
	renameSync(temp, target);
	rmSync(tempDir, { recursive: true, force: true });
	const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
	let manifest = {};
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch {
		// A new folder.
	}
	manifest[NAME] = { file: NAME, sha256 };
	writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const built = buildSandboxHelper({ force: process.argv.includes('--force') });
	if (built) {
		console.log(built);
	}
}
