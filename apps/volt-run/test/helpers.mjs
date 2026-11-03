/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const FAKE_SERVER = path.join(import.meta.dirname, 'fixtures', 'fakeServer.mjs');

/** A temporary folder removed after the test. */
export async function tempDir(t, prefix = 'volt-run-test-') {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * A Linux-style Volt install whose "Electron" is this Node and whose agent server is the fake one.
 * @param {string} dir
 */
export async function fakeInstall(dir, { version = '0.0.6', applicationName = 'volt' } = {}) {
	const app = path.join(dir, 'resources', 'app');
	await fs.mkdir(path.join(app, 'out'), { recursive: true });
	await fs.copyFile(FAKE_SERVER, path.join(app, 'out', 'volt-agent-server-main.js'));
	await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'volt', version, type: 'module' }));
	await fs.writeFile(path.join(app, 'product.json'), JSON.stringify({ nameShort: 'Volt', nameLong: 'Volt', applicationName, voltVersion: version, commit: 'c0ffee' }));
	await fs.symlink(process.execPath, path.join(dir, applicationName));
	return dir;
}

/**
 * The same as a macOS app bundle (what Volt's disk images and zips hold).
 * @param {string} app the .app folder
 */
export async function fakeMacApp(app, { version = '0.0.6' } = {}) {
	const resources = path.join(app, 'Contents', 'Resources', 'app');
	await fs.mkdir(path.join(resources, 'out'), { recursive: true });
	await fs.mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
	await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key>\n\t<string>Electron</string></dict></plist>');
	await fs.symlink(process.execPath, path.join(app, 'Contents', 'MacOS', 'Electron'));
	await fs.copyFile(FAKE_SERVER, path.join(resources, 'out', 'volt-agent-server-main.js'));
	await fs.writeFile(path.join(resources, 'package.json'), JSON.stringify({ name: 'volt', version, type: 'module' }));
	await fs.writeFile(path.join(resources, 'product.json'), JSON.stringify({ nameShort: 'Volt', nameLong: 'Volt', applicationName: 'volt', voltVersion: version, commit: 'c0ffee' }));
	return app;
}

/** The format this platform downloads (the release's dmg/zip hold Volt.app; Linux's tarball one folder). */
export const NATIVE_FORMAT = process.platform === 'darwin' ? 'zip' : 'tar.gz';

/**
 * A fake release archive named like the real ones, packed as the release packs it.
 * @returns {Promise<{ name: string, data: Buffer }>}
 */
export async function packRelease(root, target, { version = '0.0.6', format = NATIVE_FORMAT } = {}) {
	const stage = path.join(root, `stage-${format}`);
	const name = `volt-stable-${version}-${target}.${format}`;
	const archive = path.join(root, name);
	let result;
	if (format === 'tar.gz') {
		await fakeInstall(path.join(stage, 'Volt-linux-x64'), { version });
		result = await exec('tar', ['-czf', archive, '-C', stage, 'Volt-linux-x64']);
	} else if (format === 'zip') {
		await fakeMacApp(path.join(stage, 'Volt.app'), { version });
		result = await exec('ditto', ['-c', '-k', '--keepParent', path.join(stage, 'Volt.app'), archive]);
	} else {
		await fakeMacApp(path.join(stage, 'Volt.app'), { version });
		result = await exec('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-format', 'UDZO', '-srcfolder', stage, '-volname', 'Volt', archive]);
	}
	if (result.code !== 0) {
		throw new Error(`Could not pack ${name}: ${result.output}`);
	}
	return { name, data: await fs.readFile(archive) };
}

/** Serves `files` (path to contents) on loopback; resolves the base URL. */
export async function serve(t, files) {
	const server = http.createServer((req, res) => {
		const body = files[new URL(req.url, 'http://x').pathname];
		if (body === undefined) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) }).end(body);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	return `http://127.0.0.1:${server.address().port}`;
}

export function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

/** Runs a command; resolves its exit code and output. */
export function exec(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
		let output = '';
		child.stdout.on('data', data => output += data);
		child.stderr.on('data', data => output += data);
		child.once('error', reject);
		child.once('close', code => resolve({ code, output }));
	});
}

/**
 * Starts the CLI from source with a test environment: no browser, no colors, its own build cache.
 * @returns {{ child: import('node:child_process').ChildProcess, output: () => string, waitFor: (text: string, timeout?: number) => Promise<void>, exited: Promise<number> }}
 */
export function cli(args, env = {}) {
	const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'src', 'cli.mjs'), ...args], {
		env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	const waiters = [];
	const onData = data => {
		output += data;
		for (const waiter of [...waiters]) {
			if (output.includes(waiter.text)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);
	const exited = new Promise(resolve => child.once('close', code => resolve(code)));
	return {
		child,
		output: () => output,
		exited,
		waitFor: (text, timeout = 15_000) => output.includes(text) ? Promise.resolve() : new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${text}". Output:\n${output}`)), timeout);
			waiters.push({ text, resolve: () => (clearTimeout(timer), resolve()) });
		}),
	};
}

/** Runs the CLI to the end. */
export async function cliRun(args, env) {
	const run = cli(args, env);
	const code = await run.exited;
	return { code, output: run.output() };
}

export async function readJson(file) {
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function exists(file) {
	return fs.access(file).then(() => true, () => false);
}
