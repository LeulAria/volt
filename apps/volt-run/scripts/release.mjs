/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Publishes volt-run for a Volt release. The package takes Volt's version and carries that
// release's manifest; it is published only when every step passed: the release has a checked
// archive for each platform, the tests pass, and the built file runs. A dry run unless --publish.
//
//   npm run volt-run:release -- --version 0.0.6             (from the repo root) build, test, pack
//   npm run volt-run:release -- --version 0.0.6 --publish   and publish to npm
//
// Options: --channel stable|beta|nightly (stable), --tag <npm dist-tag> (latest, beta, nightly),
// --skip-tests, --feed <url> (read `latest` from another update feed). npm needs to be signed in
// (npm login), or NODE_AUTH_TOKEN set as in .github/workflows/volt-npm.yml.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareVersions, fetchManifest, MIN_RUNTIME_VERSION } from '../src/release.mjs';
import { build, PACKAGE_ROOT } from './build.mjs';

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-armhf', 'win32-x64', 'win32-arm64'];
const DIST_TAGS = { stable: 'latest', beta: 'beta', nightly: 'nightly' };

const { values } = parseArgs({
	options: {
		version: { type: 'string' },
		channel: { type: 'string', default: 'stable' },
		tag: { type: 'string' },
		feed: { type: 'string' },
		publish: { type: 'boolean', default: false },
		'skip-tests': { type: 'boolean', default: false },
	},
});

const step = text => console.log(`\n== ${text}`);
const fail = text => {
	console.error(`\nvolt-run release: ${text}`);
	process.exit(1);
};
// Output comes back unless the step prints straight to the terminal (stdio: 'inherit').
const run = (command, args, options = {}) => (execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }) ?? '').trim();
// npm is npm.cmd on Windows, which execFile only runs through a shell.
const npm = (args, options) => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: process.platform === 'win32', ...options });

if (!values.version) {
	fail('say which Volt release: --version 0.0.6 (or --version latest).');
}

step(`Volt ${values.channel} ${values.version}: its release manifest`);
const manifest = await fetchManifest({ channel: values.channel, version: values.version, feedUrl: values.feed, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN }).catch(err => fail(err.message));
if (compareVersions(manifest.version, MIN_RUNTIME_VERSION) < 0) {
	fail(`Volt ${manifest.version} can't open in a browser; volt-run is for Volt ${MIN_RUNTIME_VERSION} and newer.`);
}
for (const target of TARGETS) {
	const asset = manifest.assets[target];
	console.log(asset ? `  ${target.padEnd(13)} ${asset.name} (${(asset.size / 1e6).toFixed(0)} MB, sha256 ${asset.sha256.slice(0, 12)})` : `  ${target.padEnd(13)} missing: volt-run will say there is no build for it`);
}
if (!Object.keys(manifest.assets).length) {
	fail(`Volt ${manifest.version} has no runnable archive with a checksum.`);
}

const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const tag = values.tag ?? DIST_TAGS[manifest.channel] ?? 'latest';
const published = (() => {
	try {
		return npm(['view', `${pkg.name}@${manifest.version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }) === manifest.version;
	} catch {
		return false;
	}
})();
if (published) {
	console.log(`\n${pkg.name}@${manifest.version} is already on npm; nothing to do.`);
	process.exit(0);
}

if (!values['skip-tests']) {
	step('Tests');
	const tests = readdirSync(path.join(PACKAGE_ROOT, 'test')).filter(name => name.endsWith('.test.mjs')).map(name => path.join('test', name));
	run(process.execPath, ['--test', ...tests], { cwd: PACKAGE_ROOT, stdio: 'inherit' });
}

step('Package');
const stage = await mkdtemp(path.join(os.tmpdir(), 'volt-run-release-'));
// What npm installs: the one built file, the README, the license, and no scripts or dependencies.
const { devDependencies: _devDependencies, scripts: _scripts, ...packageFields } = pkg;
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ ...packageFields, version: manifest.version }, undefined, '\t') + '\n');
await copyFile(path.join(PACKAGE_ROOT, 'README.md'), path.join(stage, 'README.md'));
await copyFile(path.join(PACKAGE_ROOT, '..', '..', 'LICENSE.txt'), path.join(stage, 'LICENSE'));
const { outfile, bytes } = await build({ manifest, version: manifest.version, outfile: path.join(stage, 'dist', 'volt-run.mjs') });
console.log(`  ${path.relative(stage, outfile)}: ${(bytes / 1024).toFixed(0)} KB, Volt ${manifest.channel} ${manifest.version}`);

step('Smoke test');
const version = run(process.execPath, [outfile, '--version']);
if (version !== `volt-run ${manifest.version} (Volt ${manifest.version})`) {
	fail(`the built file says "${version}".`);
}
run(process.execPath, [outfile, '--help']);
console.log(`  ${version}`);

step(`npm pack (${pkg.name}@${manifest.version}, tag ${tag})`);
const [packed] = JSON.parse(npm(['pack', '--dry-run', '--json'], { cwd: stage }));
for (const file of packed.files) {
	console.log(`  ${file.path.padEnd(20)} ${(file.size / 1024).toFixed(1)} KB`);
}
console.log(`  ${packed.filename}: ${(packed.size / 1024).toFixed(0)} KB packed, ${(packed.unpackedSize / 1024).toFixed(0)} KB unpacked`);

if (!values.publish) {
	console.log(`\nDry run. The package is in ${stage}; try it with:\n\n  npx ${stage} --help\n\nPublish with --publish.`);
	process.exit(0);
}

step('Publish');
const provenance = process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [];
npm(['publish', '--access', 'public', '--tag', tag, ...provenance], { cwd: stage, stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
console.log(`\nPublished ${pkg.name}@${manifest.version} (${tag}). Try it: npx ${pkg.name}${tag === 'latest' ? '' : `@${tag}`}`);
