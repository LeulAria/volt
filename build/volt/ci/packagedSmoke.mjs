/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Packaged-binary smoke (sandbox spec K.5, B-19, D-07, D-08, INV-30): checks a packaged Volt
// build before it is signed or published.
//   - fuses: the binary's Electron fuses read back as build/lib/fuses.ts sets them, and product.json
//     says the same (the app reads it to keep inspector features off);
//   - asar: every .asar archive's header parses, its packed files lie inside the archive, its unpacked
//     files exist with the recorded size, recorded per-file hashes match, and on macOS the
//     Info.plist ElectronAsarIntegrity hashes match the headers;
//   - RUN_AS_NODE (D-07): the binary still runs as Node, the way volt-server, the file watcher and the
//     CLI start;
//   - HOST-SIG-2: NODE_OPTIONS (--max-old-space-size here, --inspect alike) is ignored and removed;
//   - HOST-SIG-1 (macOS, Linux): with volt-server's --disable-sigusr1, SIGUSR1 opens no inspector;
//   - volt-server (--server): starts from the packaged out/ with a throwaway profile and answers /health.
// Usage: node build/volt/ci/packagedSmoke.mjs <Volt.app | folder with the executable> [--server]
// Exits 1 with a list of failures.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { voltElectronFuses, checkVoltFuses } = require('../../lib/fuses.js');

/**
 * Where a packaged build keeps its executable, resources and app.
 * @param {string} target the .app bundle (macOS) or the folder holding the executable
 */
export function packagedLayout(target) {
	const resolved = path.resolve(target);
	if (resolved.endsWith('.app')) {
		const plist = fs.readFileSync(path.join(resolved, 'Contents', 'Info.plist'), 'utf8');
		const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? 'Electron';
		const resources = path.join(resolved, 'Contents', 'Resources');
		return { platform: 'darwin', fuseTarget: resolved, executable: path.join(resolved, 'Contents', 'MacOS', executable), resources, appRoot: path.join(resources, 'app'), infoPlist: path.join(resolved, 'Contents', 'Info.plist') };
	}
	const product = JSON.parse(fs.readFileSync(path.join(resolved, 'resources', 'app', 'product.json'), 'utf8'));
	const windows = fs.existsSync(path.join(resolved, `${product.nameShort}.exe`));
	const executable = path.join(resolved, windows ? `${product.nameShort}.exe` : product.applicationName);
	const resources = path.join(resolved, 'resources');
	return { platform: windows ? 'win32' : 'linux', fuseTarget: executable, executable, resources, appRoot: path.join(resources, 'app'), infoPlist: undefined };
}

/**
 * Reads an asar archive's header.
 * @param {string} archive
 * @returns {{ header: any, headerString: string, dataOffset: number, size: number }}
 */
export function readAsarHeader(archive) {
	const fd = fs.openSync(archive, 'r');
	try {
		const sizeBuf = Buffer.alloc(8);
		fs.readSync(fd, sizeBuf, 0, 8, 0);
		const headerPickleSize = sizeBuf.readUInt32LE(4);
		const headerBuf = Buffer.alloc(headerPickleSize);
		fs.readSync(fd, headerBuf, 0, headerPickleSize, 8);
		const length = headerBuf.readInt32LE(4);
		const headerString = headerBuf.toString('utf8', 8, 8 + length);
		return { header: JSON.parse(headerString), headerString, dataOffset: 8 + headerPickleSize, size: fs.fstatSync(fd).size };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Checks one asar archive; returns its failures.
 * @param {string} archive
 * @param {Record<string, { algorithm: string, hash: string }> | undefined} plistIntegrity ElectronAsarIntegrity from Info.plist
 * @param {string} resources
 */
export function checkAsar(archive, plistIntegrity, resources) {
	const failures = [];
	const name = path.relative(resources, archive);
	const { header, headerString, dataOffset, size } = readAsarHeader(archive);
	const fd = fs.openSync(archive, 'r');
	let packed = 0, unpacked = 0, hashed = 0;
	try {
		/** @param {any} node @param {string} at */
		const walk = (node, at) => {
			for (const [entry, child] of Object.entries(node.files ?? {})) {
				const rel = at ? `${at}/${entry}` : entry;
				if (child.files) {
					walk(child, rel);
					continue;
				}
				if (child.link !== undefined) {
					continue;
				}
				let contents;
				if (child.unpacked) {
					unpacked++;
					const file = path.join(`${archive}.unpacked`, rel);
					if (!fs.existsSync(file)) {
						failures.push(`${name}: unpacked ${rel} is missing`);
						continue;
					}
					if (fs.statSync(file).size !== child.size) {
						failures.push(`${name}: unpacked ${rel} is ${fs.statSync(file).size} bytes, the header says ${child.size}`);
						continue;
					}
					contents = child.integrity ? fs.readFileSync(file) : undefined;
				} else {
					packed++;
					const start = dataOffset + Number(child.offset);
					if (!Number.isFinite(start) || start + child.size > size) {
						failures.push(`${name}: ${rel} lies outside the archive`);
						continue;
					}
					if (child.integrity) {
						contents = Buffer.alloc(child.size);
						fs.readSync(fd, contents, 0, child.size, start);
					}
				}
				if (child.integrity && contents) {
					hashed++;
					if (createHash('sha256').update(contents).digest('hex') !== child.integrity.hash) {
						failures.push(`${name}: ${rel} does not match its recorded hash`);
					}
				}
			}
		};
		walk(header, '');
	} finally {
		fs.closeSync(fd);
	}
	const key = path.relative(path.dirname(resources), archive).split(path.sep).join('/');
	const expected = plistIntegrity?.[key];
	if (expected) {
		const actual = createHash('sha256').update(headerString).digest('hex');
		if (expected.hash !== actual) {
			failures.push(`${name}: Info.plist ElectronAsarIntegrity hash ${expected.hash} does not match the header (${actual})`);
		}
	} else if (voltElectronFuses.EnableEmbeddedAsarIntegrityValidation && plistIntegrity) {
		failures.push(`${name}: no ElectronAsarIntegrity entry, Electron refuses to load it`);
	}
	console.log(`asar ${name}: ${packed} packed, ${unpacked} unpacked, ${hashed} hashed files${expected ? ', Info.plist hash ok' : ''}`);
	return failures;
}

/** @param {string} infoPlist */
function readPlistIntegrity(infoPlist) {
	const result = spawnSync('plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', infoPlist], { encoding: 'utf8' });
	return result.status === 0 ? JSON.parse(result.stdout) : undefined;
}

/** @param {string} dir @returns {string[]} */
function findAsars(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith('.asar')) {
			found.push(full);
		} else if (entry.isDirectory() && !entry.name.endsWith('.asar.unpacked') && entry.name !== 'extensions' && entry.name !== 'node_modules') {
			found.push(...findAsars(full));
		}
	}
	return found;
}

/**
 * Runs the packaged binary as Node.
 * @param {string} executable
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runAsNode(executable, args, env = {}) {
	const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|VSCODE_|NODE_OPTIONS$)/.test(key)));
	return spawnSync(executable, args, { env: { ...clean, ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
}

/**
 * HOST-SIG-1 for volt-server's flags: SIGUSR1 to a RUN_AS_NODE process started with
 * --disable-sigusr1 opens no inspector (and the process survives it).
 * @param {string} executable
 * @returns {Promise<string | undefined>} a failure
 */
function checkSigusr1(executable) {
	return new Promise(resolve => {
		const script = `process.stdout.write('up\\n'); setTimeout(() => { process.stdout.write('inspector=' + (require('inspector').url() ?? 'none') + '\\n'); process.exit(0); }, 2000);`;
		const child = spawn(executable, ['--disable-sigusr1', '--inspect-port=0', '-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
		let out = '';
		child.stdout.on('data', chunk => {
			out += chunk;
			if (out.startsWith('up\n') && !out.includes('sent')) {
				out += 'sent';
				child.kill('SIGUSR1');
			}
		});
		child.on('exit', (code, signal) => {
			const inspector = /inspector=(\S+)/.exec(out)?.[1];
			if (inspector !== 'none') {
				resolve(`HOST-SIG-1: SIGUSR1 with --disable-sigusr1 gave inspector=${inspector} (exit ${code ?? signal})`);
			} else {
				resolve(undefined);
			}
		});
	});
}

/**
 * Starts volt-server from the packaged build with a throwaway profile and waits for /health.
 * @param {ReturnType<typeof packagedLayout>} layout
 * @returns {Promise<string | undefined>} a failure
 */
async function checkServer(layout) {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-smoke-'));
	const entry = path.join(layout.appRoot, 'out', 'volt-agent-server-main.js');
	const server = spawn(layout.executable, ['--disable-sigusr1', entry, '--user-data-dir', userDataDir], {
		cwd: layout.appRoot,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VOLT_AGENT_SERVER_LAUNCHD: '0' },
		stdio: 'ignore',
	});
	const runtimeFile = path.join(userDataDir, 'agentServer', 'runtime.json');
	const tokenFile = path.join(userDataDir, 'agentServer', 'token');
	try {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (server.exitCode !== null) {
				return `volt-server exited with ${server.exitCode}; see ${path.join(userDataDir, 'logs', 'agent-server.log')}`;
			}
			if (fs.existsSync(runtimeFile) && fs.existsSync(tokenFile)) {
				const info = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
				const token = fs.readFileSync(tokenFile, 'utf8').trim();
				const status = await new Promise(resolve => {
					const req = http.get({ host: '127.0.0.1', port: info.port, path: '/health', headers: { Authorization: `Bearer ${token}` }, timeout: 2000 }, res => { res.resume(); resolve(res.statusCode); });
					req.on('error', () => resolve(0));
					req.on('timeout', () => { req.destroy(); resolve(0); });
				});
				if (status === 200) {
					console.log(`volt-server: pid ${info.pid} answered /health on port ${info.port}`);
					return undefined;
				}
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		return 'volt-server did not answer /health within 60s';
	} finally {
		server.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 1000));
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}
}

/**
 * @param {string} target
 * @param {{ server?: boolean }} options
 * @returns {Promise<string[]>} failures
 */
export async function smoke(target, options = {}) {
	const layout = packagedLayout(target);
	const failures = [];

	// Fuses, in the binary and in product.json.
	const fuseMismatches = await checkVoltFuses(layout.fuseTarget);
	failures.push(...fuseMismatches.map(m => `fuse: ${m}`));
	console.log(`fuses: ${fuseMismatches.length ? 'MISMATCH' : 'as configured'} (${Object.entries(voltElectronFuses).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(', ')})`);
	const product = JSON.parse(fs.readFileSync(path.join(layout.appRoot, 'product.json'), 'utf8'));
	if (JSON.stringify(product.electronFuses) !== JSON.stringify(voltElectronFuses)) {
		failures.push(`product.json electronFuses ${JSON.stringify(product.electronFuses)} differ from build/lib/fuses.ts`);
	}

	// Asar archives.
	const plistIntegrity = layout.infoPlist ? readPlistIntegrity(layout.infoPlist) : undefined;
	for (const archive of findAsars(layout.resources)) {
		failures.push(...checkAsar(archive, plistIntegrity, layout.resources));
	}

	// RUN_AS_NODE still works (D-07).
	const node = runAsNode(layout.executable, ['-p', 'process.versions.node']);
	if (node.status !== 0 || !/^\d+\.\d+\.\d+/.test(node.stdout.trim())) {
		failures.push(`RUN_AS_NODE: exit ${node.status}: ${node.stderr || node.error}`);
	} else {
		console.log(`RUN_AS_NODE: Node ${node.stdout.trim()}`);
	}

	// HOST-SIG-2: NODE_OPTIONS is dropped.
	const nodeOptions = runAsNode(layout.executable, ['-p', `JSON.stringify({ env: process.env.NODE_OPTIONS ?? null, heapMB: Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576) })`], { NODE_OPTIONS: '--max-old-space-size=123' });
	const seen = nodeOptions.status === 0 ? JSON.parse(nodeOptions.stdout) : undefined;
	if (!seen || seen.env !== null || seen.heapMB < 200) {
		failures.push(`HOST-SIG-2: NODE_OPTIONS reached the process: ${nodeOptions.stdout || nodeOptions.stderr}`);
	} else {
		console.log(`HOST-SIG-2: NODE_OPTIONS ignored (heap limit ${seen.heapMB} MB)`);
	}

	if (layout.platform !== 'win32') {
		const signal = await checkSigusr1(layout.executable);
		if (signal) {
			failures.push(signal);
		} else {
			console.log('HOST-SIG-1: SIGUSR1 opened no inspector with --disable-sigusr1');
		}
	}

	if (options.server) {
		const server = await checkServer(layout);
		if (server) {
			failures.push(server);
		}
	}
	return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const target = args.find(arg => !arg.startsWith('--'));
	if (!target) {
		console.error('Usage: node build/volt/ci/packagedSmoke.mjs <Volt.app | folder with the executable> [--server]');
		process.exit(2);
	}
	const failures = await smoke(target, { server: args.includes('--server') });
	if (failures.length) {
		console.error(`\n${failures.length} packaged smoke failure(s):\n${failures.map(f => `  - ${f}`).join('\n')}`);
		process.exit(1);
	}
	console.log('\npackaged smoke passed');
}
