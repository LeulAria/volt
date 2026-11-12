/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the macOS sandbox helper (volt-sandbox-helper.c), thin for one architecture.
//
// Packaged builds get it from build/volt/helpers/buildHelpers.mjs (which calls buildSandboxHelper
// below): it ships at out/volt-helpers/volt-sandbox-helper, listed in out/volt-helpers-manifest.json,
// and signed builds check its code signature (src/vs/platform/voltHelpers/node/helperIntegrity.ts).
//
// Running from sources (scripts/code.sh, scripts/test.sh), this script builds it for this machine:
//
//   node build/volt/sandbox-helper/build.mjs                  .build/volt-helpers/volt-sandbox-helper, when the source is newer
//   node build/volt/sandbox-helper/build.mjs --force          always build
//   node build/volt/sandbox-helper/build.mjs --install out    also copy it into out/volt-helpers and list it in
//                                                             out/volt-helpers-manifest.json (other entries kept)
//
// A dev build (VSCODE_DEV) pins the `.build` copy for its session (the unsigned helpers developer
// mode); `--install` gives processes without VSCODE_DEV (unit tests, the bench) the bundled,
// manifest-checked helper instead. macOS only; elsewhere it does nothing.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
export const HELPER_SOURCE = join(here, 'volt-sandbox-helper.c');
export const HELPER_OUT_DIR = join(root, '.build', 'volt-helpers');
/** The helper's id in out/volt-helpers-manifest.json and its file name (SANDBOX_HELPER_ID in seatbeltBackend.ts). */
export const SANDBOX_HELPER_NAME = 'volt-sandbox-helper';
const MACOS_MINIMUM = '11.0';

/**
 * Builds the helper for `arch` (`arm64` or `x64`) into `outDir`. Returns its path, or undefined
 * when not on macOS.
 */
export function buildSandboxHelper({ force = false, outDir = HELPER_OUT_DIR, arch = process.arch } = {}) {
	if (process.platform !== 'darwin') {
		return undefined;
	}
	const target = join(outDir, SANDBOX_HELPER_NAME);
	if (!force && existsSync(target) && statSync(target).mtimeMs >= Math.max(statSync(HELPER_SOURCE).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs)) {
		return target;
	}
	mkdirSync(outDir, { recursive: true });
	// Built under its final name (the linker's signature takes its identifier from it), then moved in.
	const tempDir = join(outDir, `.tmp-${process.pid}`);
	mkdirSync(tempDir, { recursive: true });
	try {
		const temp = join(tempDir, SANDBOX_HELPER_NAME);
		execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Werror', '-arch', arch === 'arm64' ? 'arm64' : 'x86_64', `-mmacosx-version-min=${MACOS_MINIMUM}`, '-o', temp, HELPER_SOURCE], { stdio: 'inherit' });
		renameSync(temp, target);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
	return target;
}

/** Copies the built helper into `<out>/volt-helpers` and lists it in `<out>/volt-helpers-manifest.json`, keeping the other entries. */
export function installSandboxHelper(built, out) {
	const helpersDir = join(out, 'volt-helpers');
	mkdirSync(helpersDir, { recursive: true });
	const target = join(helpersDir, SANDBOX_HELPER_NAME);
	const temp = `${target}.tmp-${process.pid}`;
	copyFileSync(built, temp);
	renameSync(temp, target);
	const manifestPath = join(out, 'volt-helpers-manifest.json');
	let manifest = { version: 1, helpers: {} };
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (parsed && parsed.version === 1 && parsed.helpers && typeof parsed.helpers === 'object') {
			manifest = parsed;
		}
	} catch {
		// None yet.
	}
	const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
	manifest.helpers[SANDBOX_HELPER_NAME] = { files: [{ path: `volt-helpers/${SANDBOX_HELPER_NAME}`, sha256: { [`darwin-${process.arch}`]: sha256 } }] };
	writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const built = buildSandboxHelper({ force: process.argv.includes('--force') });
	const install = process.argv.indexOf('--install');
	if (built && install > 0 && process.argv[install + 1]) {
		const out = resolve(root, process.argv[install + 1]);
		if (existsSync(out)) {
			console.log(installSandboxHelper(built, out));
		}
	} else if (built) {
		console.log(built);
	}
}
