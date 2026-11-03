/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds a standalone app (iOS simulator .app or Android .apk, JS embedded) without compiling
// native code when nothing native changed. A release binary already built for the same native
// fingerprint, by this checkout or any other (scripts/buildCache.js), is only repacked with the
// current JS bundle and assets (seconds, not minutes). When the fingerprint is new, it runs the
// native build with the shared compiler caches and files the result for every checkout.
//
//   node scripts/fastBuild.mjs ios|android [--native] [--install]
//
// --native forces a native build, with ios/ or android/ regenerated from scratch; --install puts
// the result on the booted simulator or the connected Android device.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import buildCache from './buildCache.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
const forceNative = process.argv.includes('--native');
const install = process.argv.includes('--install');
if (platform !== 'ios' && platform !== 'android') {
	console.error('usage: node scripts/fastBuild.mjs ios|android [--native] [--install]');
	process.exit(1);
}

const env = { ...buildCache.nativeBuildEnv(root), CI: '1' };
const artifact = platform === 'ios' ? 'Volt.app' : 'Volt.apk';
const dist = join(root, 'dist', platform);
const output = join(dist, artifact);
const started = Date.now();

// The project's own binaries, without npx's start-up (seconds per call).
function bin(name) {
	return join(root, 'node_modules/.bin', name);
}

function run(cmd, args, cwd = root) {
	const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
	if (result.status !== 0) {
		console.error(`\n${cmd} ${args.join(' ')} failed (${result.status ?? result.signal})`);
		process.exit(1);
	}
}

function debugKeystore() {
	const generated = join(root, 'android/app/debug.keystore');
	return existsSync(generated) ? generated : join(homedir(), '.android/debug.keystore');
}

function repack(source) {
	// The fingerprint already says the native config (manifest, Info.plist, resources) is the
	// cached binary's, so only the JS bundle and its assets are swapped.
	const args = ['--platform', platform, '--source-app', source, '--output', output, '--js-bundle-only'];
	if (platform === 'android') {
		args.push('--ks', debugKeystore(), '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--ks-key-pass', 'pass:android');
	}
	run(bin('repack-app'), args);
}

function place(source) {
	rmSync(output, { recursive: true, force: true });
	mkdirSync(dist, { recursive: true });
	if (platform === 'ios') {
		cpSync(source, output, { recursive: true });
	} else {
		copyFileSync(source, output);
	}
}

const hash = await buildCache.fingerprintHash(root, platform);
const cached = !forceNative && buildCache.lookup(platform, hash, 'Release');
let path;
if (cached) {
	console.log(`native fingerprint ${hash.slice(0, 12)} already built: repacking with the current JS`);
	mkdirSync(dist, { recursive: true });
	rmSync(output, { recursive: true, force: true });
	repack(cached);
	path = 'repack';
} else {
	console.log(`native fingerprint ${hash.slice(0, 12)} is new: building native code`);
	const built = buildCache.buildNative(root, platform, 'Release', env, { clean: forceNative });
	buildCache.store(platform, hash, 'Release', built);
	place(built);
	path = 'native';
}

if (install) {
	if (platform === 'ios') {
		run('xcrun', ['simctl', 'install', 'booted', output]);
	} else {
		run(join(env.ANDROID_HOME, 'platform-tools/adb'), ['install', '-r', output]);
	}
}

console.log(`\n${path} build: ${output} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
