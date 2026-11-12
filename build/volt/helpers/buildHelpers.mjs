/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds Volt's native helpers for one platform and architecture, and writes the manifest Volt
// checks them against before every launch (src/vs/platform/voltHelpers/node/helperIntegrity.ts,
// spec B-14 / P0-4). Packaged builds never compile a helper at runtime; this is where they come from.
//
//   node build/volt/helpers/buildHelpers.mjs --platform darwin --arch arm64 --source out-vscode-min --out .build/volt-helpers/darwin-arm64
//
// --source is the `out` folder being packaged (its helper scripts are hashed as they ship).
// --out receives `volt-helpers/<binaries>` and `volt-helpers-manifest.json`; packaging copies both
// into the app's `out/`. Running from sources, `--source out --out out` gives a dev build the same
// bundled, verified helpers instead of the unsigned helpers developer mode.
//
// What it builds:
//   darwin: volt-helpers/volt-speech (speech, from voltSpeechHelper.ts), volt-helpers/volt-desktop
//           (desktop control, VoltDesktop.swift) and volt-helpers/volt-sandbox-helper (the sandbox's
//           TCC disclaim and external attestation, build/volt/sandbox-helper), thin for --arch; the
//           universal build lipo's them and merges the manifests (build/darwin/create-universal-app.ts).
//   win32:  volt-helpers/volt-desktop.dll (VoltDesktop.windows.cs, compiled by Windows PowerShell),
//           and the digest of VoltDesktop.windows.ps1 that loads it.
//   linux:  volt-helpers/volt-fsd (race-free file opens for sandboxed agents, build/volt/volt-fsd.c),
//           volt-helpers/volt-landlock (the sandbox's Landlock layer, build/volt/volt-landlock.c,
//           static) and the digest of volt_desktop_linux.py.
//
// Signing happens later with the rest of the app (build/darwin/sign.js, win32-sign.ps1). A signed
// build is checked by signature; an unsigned one by these digests, which signing would change.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { buildSandboxHelper, SANDBOX_HELPER_NAME } from '../sandbox-helper/build.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const HELPER_SOURCES = 'vs/platform/voltDesktop/node/helper';
const MACOS_MINIMUM = '11.0';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/** The speech helper's Swift source and Info.plist: one source of truth, the TypeScript module the dev build compiles from. */
async function speechHelperSources() {
	const ts = require('typescript');
	const file = path.join(root, 'src', 'vs', 'platform', 'voltSpeech', 'electron-main', 'voltSpeechHelper.ts');
	const js = ts.transpileModule(await fs.readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
	const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
	return { source: module.VOLT_SPEECH_HELPER_SOURCE, infoPlist: module.VOLT_SPEECH_HELPER_INFO_PLIST };
}

function swiftc(arch, args) {
	const target = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos${MACOS_MINIMUM}`;
	execFileSync('xcrun', ['swiftc', '-O', '-target', target, ...args], { stdio: 'inherit', timeout: 600_000 });
}

async function buildDarwin(arch, work, helpersDir) {
	const { source, infoPlist } = await speechHelperSources();
	const speechSource = path.join(work, 'volt-speech.swift');
	const plist = path.join(work, 'Info.plist');
	await fs.writeFile(speechSource, source);
	await fs.writeFile(plist, infoPlist);
	const speech = path.join(helpersDir, 'volt-speech');
	swiftc(arch, ['-swift-version', '5', speechSource, '-o', speech, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist]);
	const desktop = path.join(helpersDir, 'volt-desktop');
	swiftc(arch, [path.join(root, 'src', ...HELPER_SOURCES.split('/'), 'VoltDesktop.swift'), '-o', desktop]);
	const sandboxHelper = buildSandboxHelper({ force: true, outDir: helpersDir, arch });
	return { speech: [speech], desktop: [desktop], [SANDBOX_HELPER_NAME]: [sandboxHelper] };
}

async function buildWin32(work, helpersDir, source) {
	const dll = path.join(helpersDir, 'volt-desktop.dll');
	const code = path.join(root, 'src', ...HELPER_SOURCES.split('/'), 'VoltDesktop.windows.cs');
	// The same compiler and references the script uses in developer mode; only the output differs.
	const script = [
		'$ErrorActionPreference = \'Stop\'',
		`$code = [System.IO.File]::ReadAllText(${JSON.stringify(code).replace(/"/g, '\'')})`,
		`Add-Type -TypeDefinition $code -OutputAssembly ${JSON.stringify(dll).replace(/"/g, '\'')} -OutputType Library -ReferencedAssemblies @('System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions') | Out-Null`,
	].join('\n');
	const scriptFile = path.join(work, 'build-desktop.ps1');
	await fs.writeFile(scriptFile, script);
	const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { stdio: 'inherit', timeout: 600_000 });
	return { desktop: [dll], 'desktop-script': [path.join(source, ...HELPER_SOURCES.split('/'), 'VoltDesktop.windows.ps1')] };
}

function buildLinux(source, helpersDir) {
	const fsd = path.join(helpersDir, 'volt-fsd');
	execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-o', fsd, path.join(root, 'build', 'volt', 'volt-fsd.c')], { stdio: 'inherit', timeout: 600_000 });
	// Static: it runs inside the sandbox before anything else, whatever libraries the policy shows.
	const landlock = path.join(helpersDir, 'volt-landlock');
	execFileSync('cc', ['-O2', '-static', '-Wall', '-Wextra', '-Werror', '-o', landlock, path.join(root, 'build', 'volt', 'volt-landlock.c')], { stdio: 'inherit', timeout: 600_000 });
	return { 'volt-fsd': [fsd], 'volt-landlock': [landlock], 'desktop-script': [path.join(source, ...HELPER_SOURCES.split('/'), 'volt_desktop_linux.py')] };
}

/** The manifest path of a file: under `volt-helpers/` for built binaries, its place in `out/` for shipped scripts. */
function manifestPath(file, outDir, source) {
	const from = file.startsWith(outDir + path.sep) ? outDir : source;
	return path.relative(from, file).split(path.sep).join('/');
}

/**
 * The manifest's files as paths relative to the packaged app root (`resources/app`), the form
 * `BUILTIN_HELPERS` in build/volt/release/builtinManifest.mjs takes, so builtin-manifest.json can
 * list the same helpers. Its whole-file digests only hold for an unsigned, single-architecture
 * build: signing rewrites a binary and lipo merges two, which is why helperIntegrity.ts checks
 * signatures and per-architecture slices against this manifest instead.
 */
export function builtinHelperPaths(manifest) {
	return Object.values(manifest.helpers).flatMap(entry => entry.files.map(file => `out/${file.path}`));
}

export async function buildHelpers({ platform, arch, source, out }) {
	source = path.resolve(root, source);
	out = path.resolve(root, out);
	const helpersDir = path.join(out, 'volt-helpers');
	await fs.rm(helpersDir, { recursive: true, force: true });
	await fs.mkdir(helpersDir, { recursive: true });
	const work = await fs.mkdtemp(path.join(out, '.volt-helpers-work-'));
	try {
		const built = platform === 'darwin' ? await buildDarwin(arch, work, helpersDir)
			: platform === 'win32' ? await buildWin32(work, helpersDir, source)
				: buildLinux(source, helpersDir);
		const target = `${platform}-${arch}`;
		const helpers = {};
		for (const [id, files] of Object.entries(built)) {
			helpers[id] = {
				files: await Promise.all(files.map(async file => ({ path: manifestPath(file, out, source), sha256: { [target]: sha256(await fs.readFile(file)) } }))),
			};
		}
		const manifest = { version: 1, helpers };
		await fs.writeFile(path.join(out, 'volt-helpers-manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
		console.log(`[volt helpers] ${target}: ${Object.keys(helpers).join(', ') || 'none'} -> ${path.relative(root, out)}`);
		return manifest;
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
	const { values } = parseArgs({ options: { platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch }, source: { type: 'string', default: 'out' }, out: { type: 'string' } } });
	await buildHelpers({ platform: values.platform, arch: values.arch, source: values.source, out: values.out ?? path.join('.build', 'volt-helpers', `${values.platform}-${values.arch}`) });
}
