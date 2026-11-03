#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// `npx volt-run`: Volt in a browser tab. It opens the profile's agent server when one is running
// (Volt's desktop app starts the same one), or starts it from the installed Volt or a downloaded
// build, then opens the browser workbench the server serves. On loopback the browser signs in by
// itself; with --host, phones and other computers pair with a code.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseCli, USAGE } from './args.mjs';
import { openBrowser } from './browser.mjs';
import { agentServerPaths, channelProduct, runtimeCacheDir, tildify, userDataDir } from './paths.mjs';
import { MIN_RUNTIME_VERSION, targetId } from './release.mjs';
import { cachedRuntimes, locate, resolveRuntime } from './runtime.mjs';
import { browserSupport, createPairingCode, findServer, isAlive, isLoopbackHost, localBase, logTail, readNetworkAccess, readServerFiles, RESTART_EXIT_CODE, startServer, stopServer, waitForServer, writeNetworkAccess } from './server.mjs';
import { ARROW, bold, CHECK, cyan, dim, formatBytes, formatDuration, green, qrLines, red, Status, yellow } from './ui.mjs';

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

// scripts/build.mjs writes both in; run from source, the version is package.json's and there is no release.
// eslint-disable-next-line no-undef
const VERSION = typeof __VOLT_RUN_VERSION__ === 'string' ? __VOLT_RUN_VERSION__ : readJson(path.join(import.meta.dirname, '..', 'package.json'))?.version;
/** The release this package was published with: which build it downloads, with the checksums. */
// eslint-disable-next-line no-undef
const EMBEDDED_RELEASE = typeof __VOLT_RELEASE__ === 'object' && __VOLT_RELEASE__ ? __VOLT_RELEASE__ : undefined;

const status = new Status();
const out = (text = '') => process.stdout.write(`${text}\n`);
const row = (label, value) => out(`  ${dim(label.padEnd(9))} ${value}`);

/** The profile and its server files for the options. */
function context(o) {
	const channel = o.channel ?? EMBEDDED_RELEASE?.channel ?? 'stable';
	const app = o.app ? locate(path.resolve(o.app)) : undefined;
	// The desktop's own profile, so its chats and settings are the ones you see (a checkout's is code-oss-dev).
	const productName = app ? (app.dev ? 'code-oss-dev' : app.nameShort ?? channelProduct(channel).nameShort) : channelProduct(channel).nameShort;
	const profile = path.resolve(o.profile ?? userDataDir(productName));
	return { channel, profile, paths: agentServerPaths(profile) };
}

/** Volt's version for a running server, from the build it runs. */
function serverVersion(info) {
	const product = readJson(path.join(info.appRoot ?? '', 'product.json'));
	return product?.voltVersion ?? readJson(path.join(info.appRoot ?? '', 'package.json'))?.version;
}

/** Where a server's build is, as a person would name it (the .app, not its Resources/app). */
function buildLocation(appRoot) {
	const app = /^(.*\.app)[\\/]Contents[\\/]Resources[\\/]app$/.exec(appRoot ?? '');
	return tildify(app?.[1] ?? appRoot ?? 'unknown');
}

/** `ABCD-EFGH` */
function formatCode(code) {
	return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

const URL_LABELS = { lan: 'Network', tailnet: 'Tailscale', public: 'Tunnel' };

/** The pairing code, its links for other devices and a QR code of the first one. */
async function printPairing(pairing) {
	const links = pairing.urls.filter(link => link.kind !== 'loopback');
	for (const link of links) {
		out(`  ${cyan(ARROW)}  ${bold(`${URL_LABELS[link.kind] ?? 'Link'}:`.padEnd(11))}${cyan(link.url)}`);
	}
	const minutes = Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60_000));
	out(`     ${dim(`Pairing code ${bold(formatCode(pairing.code))}, valid for ${minutes} minutes ("npx volt-run pair" makes another)`)}`);
	if (links.length && process.stdout.isTTY) {
		out();
		for (const line of await qrLines(links[0].url)) {
			out(`     ${line}`);
		}
	}
}

async function start(o) {
	const started = performance.now();
	const { channel, profile, paths } = context(o);
	const notes = [];
	const abort = new AbortController();
	let child;
	const interrupt = () => {
		// Ctrl+C while starting: stop the download or the half-started server, then leave.
		abort.abort();
		if (child?.pid && isAlive(child.pid)) {
			void stopServer(child.pid).finally(() => process.exit(130));
		} else {
			status.done();
			process.exit(130);
		}
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);

	status.set('Looking for Volt');
	let running = await findServer(paths);
	const network = o.host ? !isLoopbackHost(o.host) : await readNetworkAccess(paths);
	const host = o.host ?? (network ? '0.0.0.0' : undefined);
	if (running && ((o.host && o.host !== running.info.host) || (o.port && o.port !== running.info.port))) {
		status.set(`Restarting Volt's agent server on ${o.host ?? running.info.host}:${o.port ?? 'its port'}`);
		await stopServer(running.info.pid);
		running = undefined;
		notes.push('Restarted the agent server that was running; Volt\'s windows reconnect by themselves.');
	}
	if (o.host && network !== await readNetworkAccess(paths)) {
		// Volt's windows start the server the way this says: they keep it listening where you asked.
		await writeNetworkAccess(paths, network);
	}
	if (running && (o.app || o.download || o.release)) {
		notes.push(`Volt was already running from ${buildLocation(running.info.appRoot)}; --app, --download and --release apply once it is stopped ("npx volt-run stop").`);
	}

	let owned = false;
	let logOffset = 0;
	let runtime;
	if (!running) {
		let label = '';
		let downloadStarted = 0;
		runtime = await resolveRuntime({
			app: o.app,
			download: o.download,
			channel,
			release: o.release,
			embedded: EMBEDDED_RELEASE,
			target: targetId(),
			cacheDir: runtimeCacheDir(),
			feedUrl: o.feed ?? process.env.VOLT_RUN_FEED,
			signal: abort.signal,
			note: text => notes.push(text),
			onDownload: (asset, manifest) => {
				downloadStarted = Date.now();
				label = `Downloading Volt ${manifest.version}`;
				status.set(`${label} (${formatBytes(asset.size)})`);
			},
			onProgress: (done, total) => status.progress(label, done, total, downloadStarted),
		});
		if (downloadStarted) {
			status.done(`${green(CHECK)} Downloaded Volt ${runtime.version} and checked its SHA-256 ${dim(`(${formatDuration(Date.now() - downloadStarted)})`)}`);
		}
		status.set(`Starting Volt${runtime.version ? ` ${runtime.version}` : ''}`);
		const previousPid = (await readServerFiles(paths))?.info.pid;
		logOffset = await fs.stat(paths.logFile).then(stat => stat.size, () => 0);
		child = await startServer({ runtime, paths, host, port: o.port, keepAlive: !o.detach });
		running = await waitForServer(paths, { child, previousPid });
		owned = true;
	}

	const base = localBase(running.info);
	const support = await browserSupport(base);
	if (!support.workbench || !support.signIn) {
		if (owned) {
			await stopServer(running.info.pid);
		}
		const version = serverVersion(running.info);
		throw new Error(!support.workbench
			? `The Volt build at ${buildLocation(running.info.appRoot)} doesn't include the browser workbench.`
			: `Volt${version ? ` ${version}` : ''} at ${buildLocation(running.info.appRoot)} can't sign a browser in (that needs Volt ${MIN_RUNTIME_VERSION} or newer). Update Volt, or quit it and run npx volt-run again.`);
	}
	const listensOnNetwork = !isLoopbackHost(running.info.host);
	const pairing = listensOnNetwork ? await createPairingCode(base, running.token) : undefined;
	status.done();

	const url = `${base}/`;
	const opened = o.open && await openBrowser(url);
	const version = serverVersion(running.info);
	out();
	out(`  ${bold(`Volt${version ? ` ${version}` : ''}`)}  ${owned ? dim(`ready in ${formatDuration(performance.now() - started)}`) : dim('already running')}`);
	out();
	out(`  ${cyan(ARROW)}  ${bold('Local:'.padEnd(11))}${cyan(url)}`);
	if (pairing) {
		await printPairing(pairing);
	} else if (listensOnNetwork) {
		out(`     ${dim('Pair a phone or another computer with "npx volt-run pair".')}`);
	}
	out();
	row('Runtime', buildLocation(running.info.appRoot));
	row('Profile', tildify(profile));
	row('Log', tildify(paths.logFile));
	for (const note of notes) {
		out(`\n  ${yellow(note)}`);
	}
	out();
	out(`  ${opened ? dim('Opened in your browser.') : 'Open the link above in your browser.'}`);
	process.removeListener('SIGINT', interrupt);
	process.removeListener('SIGTERM', interrupt);

	if (!owned || o.detach) {
		if (owned) {
			child.unref();
			out(`  ${dim(listensOnNetwork
				? 'Volt keeps running in the background. "npx volt-run stop" stops it.'
				: 'Volt keeps running in the background, and stops by itself after 15 minutes with no browser or window. "npx volt-run stop" stops it now.')}`);
		} else {
			out(`  ${dim('"npx volt-run stop" stops it.')}`);
		}
		out();
		return 0;
	}
	out(`  ${dim('Press Ctrl+C to stop Volt.')}`);
	out();
	if (o.verbose) {
		followLog(paths.logFile, logOffset);
	}
	// Same address, so the open tabs reconnect to the new server.
	const restart = () => startServer({ runtime, paths, host, port: running.info.port, keepAlive: true });
	return foreground(child, running, paths, restart);
}

/** Keeps the server this run started until Ctrl+C, or until it stops on its own. */
function foreground(child, running, paths, restart) {
	return new Promise(resolve => {
		let stopping = false;
		const stop = async () => {
			if (stopping) {
				// A second Ctrl+C: don't wait for it to save.
				try {
					process.kill(child.pid, 'SIGKILL');
				} catch {
					// gone
				}
				resolve(130);
				return;
			}
			stopping = true;
			status.set('Stopping Volt (saving your chats)');
			await stopServer(child.pid);
			status.done(`${green(CHECK)} Stopped Volt.`);
			resolve(0);
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
		process.on('SIGHUP', stop);
		const follow = server => server.once('exit', async (code, signal) => {
			if (stopping) {
				return;
			}
			if (code === RESTART_EXIT_CODE) {
				// A checkout's server reloading its recompiled code: start it again.
				try {
					child = await restart();
					if (stopping) {
						await stopServer(child.pid);
						return;
					}
					running = await waitForServer(paths, { child, previousPid: running.info.pid });
					out(`  ${dim(`${CHECK} Restarted Volt's agent server with its recompiled code.`)}`);
					follow(child);
				} catch (err) {
					process.stderr.write(`${red('volt-run:')} ${err.message}\n${err.log ? `${dim(indent(err.log))}\n` : ''}`);
					resolve(1);
				}
				return;
			}
			// Volt's desktop app replaces a server from another build with its own: find that one.
			await sleep(1500);
			const next = await findServer(paths);
			if (next && next.info.pid !== running.info.pid) {
				out(`${yellow('Another Volt took over the agent server')} (${buildLocation(next.info.appRoot)}). Your browser reconnects to it at ${cyan(`${localBase(next.info)}/`)}.`);
				resolve(0);
				return;
			}
			const tail = await logTail(paths.logFile);
			process.stderr.write(`${red('volt-run:')} Volt's agent server stopped (${signal ?? `exit code ${code}`}).\n${tail ? `${dim(indent(tail))}\n` : ''}`);
			resolve(code || 1);
		});
		follow(child);
	});
}

/** `--verbose`: the server's log as it is written. */
function followLog(file, offset) {
	let position = offset;
	let reading = false;
	const timer = setInterval(async () => {
		if (reading) {
			return;
		}
		reading = true;
		try {
			const handle = await fs.open(file, 'r');
			try {
				const { size } = await handle.stat();
				if (size > position) {
					const buffer = Buffer.alloc(size - position);
					await handle.read(buffer, 0, buffer.length, position);
					position = size;
					process.stdout.write(dim(buffer.toString('utf8')));
				}
			} finally {
				await handle.close();
			}
		} catch {
			// not written yet
		} finally {
			reading = false;
		}
	}, 250);
	timer.unref();
}

async function stopCommand(o) {
	const { profile, paths } = context(o);
	const files = await readServerFiles(paths);
	if (!files || !isAlive(files.info.pid)) {
		out(`Volt is not running for ${tildify(profile)}.`);
		return 0;
	}
	status.set('Stopping Volt (saving your chats)');
	await stopServer(files.info.pid);
	status.done(`${green(CHECK)} Stopped Volt's agent server (pid ${files.info.pid}). Volt's windows start it again when they need it.`);
	return 0;
}

async function statusCommand(o) {
	const { channel, profile, paths } = context(o);
	const running = await findServer(paths);
	if (!running) {
		out(`Volt is not running for ${tildify(profile)}.`);
	} else {
		const { info } = running;
		const base = localBase(info);
		const support = await browserSupport(base);
		const version = serverVersion(info);
		out(`${green('●')} ${bold(`Volt${version ? ` ${version}` : ''} is running`)}`);
		out();
		row('Open', cyan(`${base}/`));
		row('Listens', `${info.host}:${info.port}${isLoopbackHost(info.host) ? dim(' (this computer only)') : dim(' (phones and computers on your network can pair)')}`);
		row('Server', `pid ${info.pid}, up ${formatDuration(Date.now() - info.startedAt)}`);
		row('Runtime', buildLocation(info.appRoot));
		row('Browser', support.signIn ? 'signs in on this computer' : yellow(`can't sign in (needs Volt ${MIN_RUNTIME_VERSION})`));
		row('Profile', tildify(profile));
		row('Log', tildify(paths.logFile));
	}
	const builds = await cachedRuntimes(runtimeCacheDir(), channel, safeTarget());
	if (builds.length) {
		out();
		out(dim(`Downloaded: ${builds.map(build => `Volt ${build.version}`).join(', ')} in ${tildify(runtimeCacheDir())}`));
	}
	return running ? 0 : 1;
}

function safeTarget() {
	try {
		return targetId();
	} catch {
		return 'unknown';
	}
}

async function pairCommand(o) {
	const { paths } = context(o);
	const running = await findServer(paths);
	if (!running) {
		throw new Error('Volt is not running. Start it with "npx volt-run --host 0.0.0.0" so phones and other computers on your network can reach it.');
	}
	const pairing = await createPairingCode(localBase(running.info), running.token);
	if (!pairing) {
		throw new Error(`This Volt can't make pairing codes for volt-run (that needs Volt ${MIN_RUNTIME_VERSION}). Pair from Volt instead: Settings > Devices.`);
	}
	out();
	await printPairing(pairing);
	if (!pairing.urls.some(link => link.kind !== 'loopback')) {
		out();
		out(`  ${yellow('Volt only listens on this computer, so other devices can\'t reach it yet.')}`);
		out(`  ${dim('Restart it with "npx volt-run --host 0.0.0.0", or open a tunnel in Volt: Settings > Devices.')}`);
	}
	out();
	return 0;
}

async function cleanCommand(o) {
	const { paths } = context(o);
	const cacheDir = runtimeCacheDir();
	const running = await findServer(paths);
	let names = [];
	try {
		names = await fs.readdir(cacheDir);
	} catch {
		out(`Nothing to delete in ${tildify(cacheDir)}.`);
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const dir = path.join(cacheDir, name);
		if (running && (running.info.appRoot + path.sep).startsWith(dir + path.sep)) {
			out(dim(`Kept ${name}: Volt is running from it.`));
			continue;
		}
		await fs.rm(dir, { recursive: true, force: true });
		removed++;
	}
	out(`${green(CHECK)} Deleted ${removed} downloaded Volt build${removed === 1 ? '' : 's'} from ${tildify(cacheDir)}.`);
	return 0;
}

function indent(text) {
	return text.split('\n').map(line => `    ${line}`).join('\n');
}

/** What to do about errors people can fix. */
function hint(err) {
	const missing = /error while loading shared libraries: (\S+?):/.exec(err.log ?? '')?.[1];
	if (missing) {
		return `Volt's Electron needs ${missing} even without a window. On Debian or Ubuntu: sudo apt install libgtk-3-0 libnss3 libgbm1 libasound2 (libasound2t64 on Ubuntu 24.04); on Fedora: sudo dnf install gtk3 nss mesa-libgbm alsa-lib.`;
	}
	if (/EADDRINUSE/.test(err.log ?? '')) {
		return 'That port is taken. Pick another with --port, or leave --port out.';
	}
	return undefined;
}

async function main(argv) {
	let o;
	try {
		o = parseCli(argv);
	} catch (err) {
		process.stderr.write(`${red('volt-run:')} ${err.message}\nRun "npx volt-run --help" for the options.\n`);
		return 2;
	}
	if (o.help) {
		out(USAGE);
		return 0;
	}
	if (o.version) {
		out(`volt-run ${VERSION}${EMBEDDED_RELEASE ? ` (Volt ${EMBEDDED_RELEASE.version})` : ''}`);
		return 0;
	}
	try {
		switch (o.command) {
			case 'stop': return await stopCommand(o);
			case 'status': return await statusCommand(o);
			case 'pair': return await pairCommand(o);
			case 'clean': return await cleanCommand(o);
			default: return await start(o);
		}
	} catch (err) {
		status.done();
		if (err.name === 'AbortError') {
			return 130;
		}
		process.stderr.write(`${red('volt-run:')} ${err.message}\n`);
		if (err.log) {
			process.stderr.write(`${dim(indent(err.log))}\n`);
		}
		const advice = hint(err);
		if (advice) {
			process.stderr.write(`${yellow(advice)}\n`);
		}
		return 1;
	}
}

process.exitCode = await main(process.argv.slice(2));
