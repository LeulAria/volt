/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the app in development (a debug build talking to Metro). When a debug build for the same
// native fingerprint is in the shared cache (scripts/buildCache.js), built by this checkout or any
// other, it installs that build, starts Metro and launches the app: no prebuild, CocoaPods or
// compile, so even a fresh worktree is up in seconds. Otherwise it builds once with the shared
// compiler caches and files the build for every later run and checkout.
//
//   node scripts/run.mjs ios|android [--rebuild] [expo run options]
//
// --rebuild drops the cached build first and regenerates ios/ or android/ from scratch. Other
// options (a device, a configuration) go to `expo run`, which still reuses a cached build when it
// can.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import buildCache from './buildCache.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [platform, ...rest] = process.argv.slice(2);
if (platform !== 'ios' && platform !== 'android') {
	console.error('usage: node scripts/run.mjs ios|android [--rebuild] [expo run options]');
	process.exit(1);
}
const rebuild = rest.includes('--rebuild');
const expoArgs = rest.filter(arg => arg !== '--rebuild');
const env = buildCache.nativeBuildEnv(root);
const adb = join(env.ANDROID_HOME, 'platform-tools/adb');
// The port a debug build loads its JS from.
const port = 8081;
const { expo: config } = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
const appId = platform === 'ios' ? config.ios.bundleIdentifier : config.android.package;
const started = Date.now();
let metro;

function bin(name) {
	return join(root, 'node_modules/.bin', name);
}

function fail(message) {
	console.error(message);
	metro?.kill();
	process.exit(1);
}

function capture(cmd, args) {
	const result = spawnSync(cmd, args, { env, encoding: 'utf8' });
	return result.status === 0 ? result.stdout : '';
}

function check(cmd, args) {
	const result = spawnSync(cmd, args, { env, stdio: ['ignore', 'ignore', 'inherit'] });
	if (result.status !== 0) {
		fail(`${cmd} ${args.join(' ')} failed (${result.status ?? result.signal})`);
	}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function expoRun() {
	const result = spawnSync(bin('expo'), [`run:${platform}`, ...expoArgs], { cwd: root, env, stdio: 'inherit' });
	process.exit(result.status ?? 1);
}

// The booted simulator, or the newest iPhone booted for the purpose.
function iosDevice() {
	const { devices } = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
	const all = Object.entries(devices).flatMap(([runtime, list]) => list.map(device => ({ ...device, runtime })));
	const booted = all.find(device => device.state === 'Booted');
	if (booted) {
		return booted.udid;
	}
	const iphone = all.filter(device => device.runtime.includes('iOS') && device.name.startsWith('iPhone')).sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0];
	if (!iphone) {
		fail('No iPhone simulator is available: add one in Xcode › Settings › Components.');
	}
	check('xcrun', ['simctl', 'boot', iphone.udid]);
	spawnSync('open', ['-a', 'Simulator']);
	return iphone.udid;
}

// The first connected device, or the first emulator started for the purpose.
async function androidDevice() {
	const connected = () => capture(adb, ['devices']).split('\n').slice(1).map(line => line.split('\t')).find(([, state]) => state === 'device')?.[0];
	if (connected()) {
		return connected();
	}
	const emulator = join(env.ANDROID_HOME, 'emulator/emulator');
	const avd = capture(emulator, ['-list-avds']).split('\n').find(Boolean);
	if (!avd) {
		fail('No Android device is connected and no emulator exists: create one in Android Studio › Device Manager.');
	}
	spawn(emulator, ['-avd', avd], { env, detached: true, stdio: 'ignore' }).unref();
	check(adb, ['wait-for-device']);
	while (capture(adb, ['shell', 'getprop', 'sys.boot_completed']).trim() !== '1') {
		await sleep(500);
	}
	return connected();
}

// The directory of the process serving the port, or undefined when nothing listens there.
function portOwner() {
	const pid = capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')[0];
	if (!pid) {
		return undefined;
	}
	return capture('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'))?.slice(1) ?? 'another process';
}

async function startMetro() {
	const owner = portOwner();
	if (owner === root) {
		console.log(`Metro is already running for this checkout on port ${port}`);
		return;
	}
	if (owner) {
		fail(`Port ${port} is taken by ${owner}. The debug build loads its JS from that port, so stop that server first.`);
	}
	// The scheme is given because without ios/ or android/ Expo cannot read it from the project.
	metro = spawn(bin('expo'), ['start', '--dev-client', '--scheme', config.scheme, '--port', String(port)], { cwd: root, env, stdio: 'inherit' });
	metro.on('exit', code => process.exit(code ?? 0));
	// Ctrl+C reaches Metro too; wait for it to exit instead of leaving it behind.
	process.on('SIGINT', () => { });
	for (;;) {
		const status = await fetch(`http://localhost:${port}/status`).then(response => response.text(), () => '');
		if (status.includes('packager-status:running')) {
			return;
		}
		await sleep(250);
	}
}

if (expoArgs.length) {
	expoRun();
}
const hash = await buildCache.fingerprintHash(root, platform);
if (rebuild) {
	buildCache.remove(platform, hash, 'Debug');
}
let cached = buildCache.lookup(platform, hash, 'Debug');
const source = cached ? 'the cached debug build' : 'a new debug build';
if (cached) {
	console.log(`Native fingerprint ${hash.slice(0, 12)} already built: installing it, no native build`);
} else {
	console.log(`No debug build for native fingerprint ${hash.slice(0, 12)} yet: building it once for every checkout`);
	cached = buildCache.store(platform, hash, 'Debug', buildCache.buildNative(root, platform, 'Debug', env, { clean: rebuild }));
}
const device = platform === 'ios' ? iosDevice() : await androidDevice();
const target = platform === 'ios' ? ['xcrun', ['simctl', 'install', device, cached]] : [adb, ['-s', device, 'install', '-r', cached]];
// Installing overlaps Metro's start-up.
const installing = new Promise(resolve => spawn(target[0], target[1], { env, stdio: ['ignore', 'ignore', 'inherit'] }).on('exit', resolve));
await startMetro();
if (await installing !== 0) {
	fail(`Installing ${cached} failed`);
}
if (platform === 'ios') {
	spawnSync('xcrun', ['simctl', 'terminate', device, appId], { stdio: 'ignore' });
	check('xcrun', ['simctl', 'launch', device, appId]);
} else {
	check(adb, ['-s', device, 'reverse', `tcp:${port}`, `tcp:${port}`]);
	// Android 16 cuts the network of an app that is not in front, and a sleeping screen pauses it
	// at once, so it would never reach Metro.
	spawnSync(adb, ['-s', device, 'shell', 'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; am force-stop', appId], { stdio: 'ignore' });
	if (spawnSync(adb, ['-s', device, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' }).status !== 0) {
		fail(`Launching ${appId} failed`);
	}
}
console.log(`\nLaunched ${appId} in ${((Date.now() - started) / 1000).toFixed(1)}s from ${source}`);
