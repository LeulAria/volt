/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Native builds kept once per machine and shared by every checkout and worktree. A binary is
// filed under its platform, its Expo fingerprint (a hash of everything native: native modules,
// config plugins, app.json) and its configuration, so a checkout whose native side matches reuses
// it instead of compiling. scripts/run.mjs and scripts/fastBuild.mjs build and file binaries;
// `expo run:ios|android` reads them through buildCacheProvider in app.json.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cacheRoot = process.env.VOLT_MOBILE_CACHE || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'volt-mobile');

async function fingerprintHash(projectRoot, platform) {
	const { createFingerprintAsync } = require(require.resolve('@expo/fingerprint', { paths: [projectRoot] }));
	return (await createFingerprintAsync(projectRoot, { platforms: [platform] })).hash;
}

// configuration: Debug or Release, in any case (Xcode capitalizes it, Gradle's variants do not).
// The .noindex suffix keeps Spotlight from indexing the cache and from listing its Volt.app
// bundles as apps.
function entryPath(platform, hash, configuration) {
	return path.join(cacheRoot, 'builds.noindex', `${platform}-${hash}-${configuration.toLowerCase()}${platform === 'ios' ? '.app' : '.apk'}`);
}

function lookup(platform, hash, configuration) {
	const entry = entryPath(platform, hash, configuration);
	return fs.existsSync(entry) ? entry : null;
}

function remove(platform, hash, configuration) {
	fs.rmSync(entryPath(platform, hash, configuration), { recursive: true, force: true });
}

// Copied (an APFS clone where possible) under a temporary name and renamed into place, so another
// checkout reading the cache never sees half a build.
function store(platform, hash, configuration, buildPath) {
	const entry = entryPath(platform, hash, configuration);
	const temp = `${entry}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.rmSync(temp, { recursive: true, force: true });
	fs.cpSync(buildPath, temp, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
	fs.rmSync(entry, { recursive: true, force: true });
	fs.renameSync(temp, entry);
	return entry;
}

// The environment for native builds. Their compiler caches live next to the binaries, and this
// checkout's path is mapped out of every cache key, so a worktree reuses what another compiled:
// Xcode's compilation cache for Swift and C/C++ (ccache never runs under Xcode's explicit
// modules), given to every target through XCODE_XCCONFIG_FILE, and ccache for Android's CMake.
function nativeBuildEnv(projectRoot) {
	const checkout = path.resolve(projectRoot, '../..');
	const androidHome = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
	const xcconfig = path.join(projectRoot, '.expo', 'compilation-cache.xcconfig');
	fs.mkdirSync(path.dirname(xcconfig), { recursive: true });
	fs.writeFileSync(xcconfig, [
		'COMPILATION_CACHE_ENABLE_CACHING = YES',
		`COMPILATION_CACHE_CAS_PATH = ${path.join(cacheRoot, 'CompilationCache.noindex')}`,
		'CLANG_ENABLE_PREFIX_MAPPING = YES',
		'SWIFT_ENABLE_PREFIX_MAPPING = YES',
		`CLANG_OTHER_PREFIX_MAPPINGS = ${checkout}=/^checkout`,
		`SWIFT_OTHER_PREFIX_MAPPINGS = ${checkout}=/^checkout`,
		'',
	].join('\n'));
	return {
		...process.env,
		ANDROID_HOME: androidHome,
		ANDROID_SDK_ROOT: androidHome,
		XCODE_XCCONFIG_FILE: xcconfig,
		CCACHE_BASEDIR: checkout,
		CCACHE_NOHASHDIR: 'true',
	};
}

function run(cmd, args, cwd, env) {
	const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
	if (result.status !== 0) {
		console.error(`\n${cmd} ${args.join(' ')} failed (${result.status ?? result.signal})`);
		process.exit(1);
	}
}

// Prebuild extracts the whole native template, so two at once in one checkout (an iOS and an
// Android build side by side) break each other's files; the second waits for the first. A lock
// left by a process that died is taken over.
//
// Without clean it updates ios/ and android/ in place (the config plugins are idempotent) instead
// of recreating them, Expo's default, which threw away the Pods, DerivedData in ios/build and
// Gradle's outputs on every native build. Clean is the way back from anything stale it leaves.
function prebuild(projectRoot, platform, env, clean) {
	const lock = path.join(projectRoot, '.expo', 'prebuild.lock');
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	for (;;) {
		try {
			fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
			break;
		} catch {
			const owner = Number(fs.readFileSync(lock, 'utf8'));
			try {
				process.kill(owner, 0);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
			} catch {
				fs.rmSync(lock, { force: true });
			}
		}
	}
	try {
		run(path.join(projectRoot, 'node_modules/.bin/expo'), ['prebuild', '--platform', platform, clean ? '--clean' : '--no-clean'], projectRoot, env);
	} finally {
		fs.rmSync(lock, { force: true });
	}
}

// Prebuilds and compiles the app, for the simulator's architecture on iOS (DerivedData stays in
// ios/build so rebuilds are incremental) and for arm64 on Android, and returns the .app or .apk.
function buildNative(projectRoot, platform, configuration, env, { clean = false } = {}) {
	prebuild(projectRoot, platform, env, clean);
	if (platform === 'ios') {
		run('xcodebuild', ['-workspace', 'Volt.xcworkspace', '-scheme', 'Volt', '-configuration', configuration, '-sdk', 'iphonesimulator', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', '-derivedDataPath', 'build', '-quiet', 'build'], path.join(projectRoot, 'ios'), env);
		return path.join(projectRoot, `ios/build/Build/Products/${configuration}-iphonesimulator/Volt.app`);
	}
	run('./gradlew', [`assemble${configuration}`, '--build-cache'], path.join(projectRoot, 'android'), env);
	const apks = path.join(projectRoot, 'android/app/build/outputs/apk', configuration.toLowerCase());
	return path.join(apks, fs.readdirSync(apks).find(name => name.endsWith('.apk')));
}

module.exports = {
	cacheRoot,
	fingerprintHash,
	lookup,
	remove,
	store,
	nativeBuildEnv,
	prebuild,
	buildNative,
	// The build cache provider interface that `expo run` calls.
	calculateFingerprintHash: ({ projectRoot, platform }) => fingerprintHash(projectRoot, platform),
	resolveBuildCache: async ({ platform, fingerprintHash: hash, runOptions }) => lookup(platform, hash, runOptions.configuration ?? runOptions.variant ?? 'debug'),
	uploadBuildCache: async ({ platform, fingerprintHash: hash, buildPath, runOptions }) => store(platform, hash, runOptions.configuration ?? runOptions.variant ?? 'debug', buildPath),
};
