/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the app for release, the way CI ships it (.github/workflows/volt-mobile-build.yml): native
// code compiled (never repacked from the build cache), the JS bundle embedded, and signed with the
// release keys when they are in the environment.
//
//   node scripts/releaseBuild.mjs android|ios [--out <dir>] [--name <prefix>] [--build-number <n>]
//
// Android writes <prefix>-android-arm64.apk, and <prefix>-android-arm64.aab for Google Play when
// ANDROID_KEYSTORE (base64 of the upload .jks), ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and
// ANDROID_KEY_PASSWORD (default: the keystore password) are set. Without them the APK is signed
// with the template's public debug key: it installs, but it can't go to Google Play.
//
// iOS writes <prefix>-ios-arm64-simulator.zip (the .app, for simulators on Apple silicon), and
// <prefix>-ios-arm64.ipa for devices when IOS_DISTRIBUTION_CERTIFICATE (base64 of an Apple
// Distribution .p12), IOS_DISTRIBUTION_CERTIFICATE_PASSWORD, IOS_PROVISIONING_PROFILE and
// IOS_WIDGETS_PROVISIONING_PROFILE (base64 of the app's and the widget extension's
// .mobileprovision) are set. The profiles give the team and the export method: ad hoc when they
// list devices, enterprise, or else App Store Connect. IOS_EXPORT_METHOD overrides the method.
//
// The build number (CFBundleVersion, versionCode) defaults to minutes since 1970, so each build
// is newer than the last one on every channel. app.json gets it for the build and is put back.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import buildCache from './buildCache.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const [platform, ...rest] = process.argv.slice(2);
if (platform !== 'ios' && platform !== 'android') {
	console.error('usage: node scripts/releaseBuild.mjs ios|android [--out <dir>] [--name <prefix>] [--build-number <n>]');
	process.exit(1);
}

function option(name, fallback) {
	const index = rest.indexOf(name);
	return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
}

const out = resolve(option('--out', join(root, 'dist/release')));
const name = option('--name', 'volt-mobile');
const buildNumber = Number(option('--build-number', String(Math.floor(Date.now() / 60_000))));
// Google Play's versionCode limit.
if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2_100_000_000) {
	console.error('--build-number must be a whole number from 1 to 2100000000');
	process.exit(1);
}

const env = { ...buildCache.nativeBuildEnv(root), CI: '1' };
const temp = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'volt-mobile-'));
const started = Date.now();
// Undone on every exit, also when a step fails (run() exits, which skips finally blocks).
const cleanups = [];
process.on('exit', () => {
	for (const cleanup of cleanups.reverse()) {
		try {
			cleanup();
		} catch (err) {
			console.error(`cleanup failed: ${err.message}`);
		}
	}
	rmSync(temp, { recursive: true, force: true });
});

function run(cmd, args, { cwd = root, runEnv = env, quiet = false } = {}) {
	const result = spawnSync(cmd, args, { cwd, env: runEnv, stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'] });
	if (result.status !== 0) {
		// Not the whole command line: some arguments are passwords.
		fail(`\n${cmd} ${args[0]} failed (${result.status ?? result.signal})`);
	}
}

function capture(cmd, args) {
	const result = spawnSync(cmd, args, { env, encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function warn(message) {
	console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
}

// Writes a base64 secret from the environment to a file in the temporary folder.
function decode(variable, file) {
	const path = join(temp, file);
	writeFileSync(path, Buffer.from(process.env[variable], 'base64'));
	return path;
}

const appJson = join(root, 'app.json');
const original = readFileSync(appJson, 'utf8');
const app = JSON.parse(original);
app.expo.ios = { ...app.expo.ios, buildNumber: String(buildNumber) };
app.expo.android = { ...app.expo.android, versionCode: buildNumber };
writeFileSync(appJson, JSON.stringify(app, null, '\t') + '\n');
cleanups.push(() => writeFileSync(appJson, original));

mkdirSync(out, { recursive: true });
console.log(`Volt ${app.expo.version} (${buildNumber}) for ${platform}`);
if (platform === 'android') {
	buildAndroid();
} else {
	buildIos();
}

for (const file of readdirSync(out).filter(file => file.startsWith(`${name}-${platform}-`))) {
	console.log(`${join(out, file)}  ${(statSync(join(out, file)).size / 1e6).toFixed(1)} MB`);
}
console.log(`built in ${((Date.now() - started) / 1000).toFixed(0)}s`);

function buildAndroid() {
	buildCache.prebuild(root, 'android', env, false);
	const signed = Boolean(process.env.ANDROID_KEYSTORE);
	// The app's tasks only: the root project's would also package and lint every library on its own.
	const args = [':app:assembleRelease', '--build-cache'];
	if (signed) {
		const password = process.env.ANDROID_KEYSTORE_PASSWORD;
		const alias = process.env.ANDROID_KEY_ALIAS;
		if (!password || !alias) {
			fail('ANDROID_KEYSTORE also needs ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS');
		}
		// Android Studio's signing properties replace every variant's signing config (the template
		// signs release with its debug key) without touching the generated build.gradle.
		args.unshift(':app:bundleRelease');
		args.push(
			`-Pandroid.injected.signing.store.file=${decode('ANDROID_KEYSTORE', 'upload.jks')}`,
			`-Pandroid.injected.signing.store.password=${password}`,
			`-Pandroid.injected.signing.key.alias=${alias}`,
			`-Pandroid.injected.signing.key.password=${process.env.ANDROID_KEY_PASSWORD || password}`,
		);
	} else {
		warn('ANDROID_KEYSTORE is not set: the APK is signed with the public debug key, and there is no .aab for Google Play.');
	}
	run('./gradlew', args, { cwd: join(root, 'android') });

	const outputs = join(root, 'android/app/build/outputs');
	const apks = join(outputs, 'apk/release');
	const apk = join(out, `${name}-android-arm64.apk`);
	copyFileSync(join(apks, readdirSync(apks).find(file => file.endsWith('.apk'))), apk);
	// The certificate in the log says which key signed it.
	const buildTools = join(env.ANDROID_HOME, 'build-tools');
	const latest = existsSync(buildTools) && readdirSync(buildTools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
	if (latest) {
		run(join(buildTools, latest, 'apksigner'), ['verify', '--print-certs', apk]);
	}
	if (signed) {
		const bundles = join(outputs, 'bundle/release');
		copyFileSync(join(bundles, readdirSync(bundles).find(file => file.endsWith('.aab'))), join(out, `${name}-android-arm64.aab`));
	}
}

function buildIos() {
	// The signing secrets are checked before the long simulator build.
	let signing;
	if (process.env.IOS_DISTRIBUTION_CERTIFICATE) {
		signing = { ...importCertificate(), profiles: new Map() };
		for (const variable of ['IOS_PROVISIONING_PROFILE', 'IOS_WIDGETS_PROVISIONING_PROFILE']) {
			const profile = installProfile(variable);
			signing.profiles.set(profile.bundleId, profile);
		}
	} else {
		warn('IOS_DISTRIBUTION_CERTIFICATE is not set: building the simulator app only, no .ipa for devices.');
	}
	const main = signing?.profiles.get(app.expo.ios.bundleIdentifier);
	if (signing && !main) {
		fail(`No provisioning profile for ${app.expo.ios.bundleIdentifier} (got ${[...signing.profiles.keys()].join(', ')})`);
	}

	const simulatorApp = buildCache.buildNative(root, 'ios', 'Release', env);
	run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', simulatorApp, join(out, `${name}-ios-arm64-simulator.zip`)]);
	if (!signing) {
		return;
	}

	const { identity, keychain, profiles } = signing;
	signTargets(profiles, identity);

	const ios = join(root, 'ios');
	const archive = join(ios, 'build/Volt.xcarchive');
	rmSync(archive, { recursive: true, force: true });
	// No compilation cache for the device build: a cold cache only slows a one-off build down.
	const { XCODE_XCCONFIG_FILE, ...archiveEnv } = env;
	run('xcodebuild', ['-workspace', 'Volt.xcworkspace', '-scheme', 'Volt', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', archive, '-derivedDataPath', 'build', '-quiet', 'archive', `OTHER_CODE_SIGN_FLAGS=--keychain "${keychain}"`], { cwd: ios, runEnv: archiveEnv });

	const method = process.env.IOS_EXPORT_METHOD || main.method;
	console.log(`Exporting for ${method} (team ${main.team})`);
	const options = join(temp, 'ExportOptions.json');
	writeFileSync(options, JSON.stringify({
		method,
		teamID: main.team,
		signingStyle: 'manual',
		signingCertificate: identity,
		provisioningProfiles: Object.fromEntries([...profiles].map(([bundleId, profile]) => [bundleId, profile.uuid])),
	}));
	run('plutil', ['-convert', 'xml1', '-o', join(temp, 'ExportOptions.plist'), options]);
	const exported = join(temp, 'export');
	run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', join(temp, 'ExportOptions.plist'), '-exportPath', exported], { cwd: ios, runEnv: archiveEnv });
	copyFileSync(join(exported, readdirSync(exported).find(file => file.endsWith('.ipa'))), join(out, `${name}-ios-arm64.ipa`));
}

// A keychain of its own, in the search list for the build and gone afterwards.
function importCertificate() {
	const keychain = join(temp, 'volt-signing.keychain-db');
	const password = randomBytes(16).toString('hex');
	const searchList = (capture('security', ['list-keychains', '-d', 'user']) ?? '').split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
	run('security', ['create-keychain', '-p', password, keychain]);
	cleanups.push(() => spawnSync('security', ['delete-keychain', keychain]));
	run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
	run('security', ['unlock-keychain', '-p', password, keychain]);
	run('security', ['import', decode('IOS_DISTRIBUTION_CERTIFICATE', 'distribution.p12'), '-k', keychain, '-P', process.env.IOS_DISTRIBUTION_CERTIFICATE_PASSWORD ?? '', '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'], { quiet: true });
	run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain], { quiet: true });
	run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);
	cleanups.push(() => spawnSync('security', ['list-keychains', '-d', 'user', '-s', ...searchList]));
	const identities = capture('security', ['find-identity', '-v', '-p', 'codesigning', keychain]) ?? '';
	const identity = /\b[0-9A-F]{40}\b/.exec(identities)?.[0];
	if (!identity) {
		fail('IOS_DISTRIBUTION_CERTIFICATE holds no code signing identity');
	}
	console.log(`Signing with ${identities.split('\n').find(line => line.includes(identity)).trim()}`);
	return { identity, keychain };
}

// Installs a profile where Xcode looks for it and reads what the export needs from it.
function installProfile(variable) {
	if (!process.env[variable]) {
		fail(`${variable} is not set (a device build needs a profile for the app and one for the widget extension)`);
	}
	const file = decode(variable, `${variable}.mobileprovision`);
	const plist = join(temp, `${variable}.plist`);
	run('security', ['cms', '-D', '-i', file, '-o', plist]);
	const read = keyPath => capture('plutil', ['-extract', keyPath, 'raw', '-o', '-', plist]);
	const uuid = read('UUID');
	const team = read('TeamIdentifier.0');
	const appId = read('Entitlements.application-identifier');
	if (!uuid || !team || !appId) {
		fail(`${variable} is not a provisioning profile`);
	}
	const listsDevices = spawnSync('plutil', ['-extract', 'ProvisionedDevices', 'xml1', '-o', '-', plist], { stdio: 'ignore' }).status === 0;
	for (const folder of ['Library/MobileDevice/Provisioning Profiles', 'Library/Developer/Xcode/UserData/Provisioning Profiles']) {
		mkdirSync(join(homedir(), folder), { recursive: true });
		copyFileSync(file, join(homedir(), folder, `${uuid}.mobileprovision`));
	}
	const method = read('ProvisionsAllDevices') === 'true' ? 'enterprise' : listsDevices ? 'release-testing' : 'app-store-connect';
	console.log(`${variable}: "${read('Name')}" for ${appId} (${method})`);
	return { uuid, team, bundleId: appId.slice(team.length + 1), method };
}

// Manual signing for the Release configuration of the app and every extension, each with the
// profile for its bundle id. Build settings on the xcodebuild command line would give every
// target (the Pods too) the same profile. The project is put back after the build.
function signTargets(profiles, identity) {
	const { IOSConfig } = require('expo/config-plugins');
	const project = IOSConfig.XcodeUtils.getPbxproj(root);
	const before = readFileSync(project.filepath, 'utf8');
	cleanups.push(() => writeFileSync(project.filepath, before));
	const configurations = project.pbxXCBuildConfigurationSection();
	const lists = project.pbxXCConfigurationList();
	for (const [key, target] of Object.entries(project.pbxNativeTargetSection())) {
		if (key.endsWith('_comment') || !/product-type\.(application|app-extension)"?$/.test(target.productType)) {
			continue;
		}
		for (const { value } of lists[target.buildConfigurationList].buildConfigurations) {
			const configuration = configurations[value];
			if (configuration.name !== 'Release') {
				continue;
			}
			const settings = configuration.buildSettings;
			const bundleId = String(settings.PRODUCT_BUNDLE_IDENTIFIER).replace(/^"|"$/g, '');
			const profile = profiles.get(bundleId);
			if (!profile) {
				fail(`No provisioning profile for ${bundleId}, target ${target.name} (got ${[...profiles.keys()].join(', ')})`);
			}
			Object.assign(settings, {
				CODE_SIGN_STYLE: 'Manual',
				DEVELOPMENT_TEAM: profile.team,
				CODE_SIGN_IDENTITY: identity,
				'"CODE_SIGN_IDENTITY[sdk=iphoneos*]"': identity,
				PROVISIONING_PROFILE_SPECIFIER: `"${profile.uuid}"`,
			});
		}
	}
	writeFileSync(project.filepath, project.writeSync());
}
