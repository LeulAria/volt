/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks the app's pinned TLS on a simulator or emulator against a running Volt server: opens the
// development-only screen app/dev/pinned-tls.tsx with the server's TLS address and pin, and reads
// its results from the device log. A debug build of this checkout must be running on the device.
//
//   node scripts/pinnedTlsCheck.mjs ios|android --device <udid|serial> --url https://<host>:<tls port>
//        --pin <pin> [--plain http://<network ip>:<port>]
//
// The pin is the `pin` of `POST /api/auth/code` (or the `fp=` of a pairing link). Exits 0 when
// every check passed: the API, a WebSocket and two WebView loads work with the pin; the API, a
// socket and a WebView page with another pin are refused; a plain HTTP network address is refused.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [platform, ...rest] = process.argv.slice(2);
const option = name => {
	const index = rest.indexOf(`--${name}`);
	return index >= 0 ? rest[index + 1] : undefined;
};
const device = option('device');
const url = option('url');
const pin = option('pin');
const plain = option('plain');
if ((platform !== 'ios' && platform !== 'android') || !device || !url || !pin) {
	console.error('usage: node scripts/pinnedTlsCheck.mjs ios|android --device <udid|serial> --url https://<host>:<port> --pin <pin> [--plain http://<ip>:<port>]');
	process.exit(2);
}
const adb = join(process.env.ANDROID_HOME || join(homedir(), 'Library/Android/sdk'), 'platform-tools/adb');
const link = `volt://dev/pinned-tls?${new URLSearchParams({ url, pin, ...(plain ? { plain } : {}) })}`;
const MARK = '[volt-pin-check]';
const EXPECTED = ['api', 'api-wrong-pin', 'socket', 'socket-wrong-pin', ...(plain ? ['plain-http'] : []), 'webview-wrong-pin', 'webview-page', 'webview-subresource'];

function run(cmd, args) {
	return new Promise((resolve, reject) => spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] }).on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed (${code})`))));
}

const logs = platform === 'ios'
	? spawn('xcrun', ['simctl', 'spawn', device, 'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', `eventMessage CONTAINS "${MARK}"`])
	: (await run(adb, ['-s', device, 'logcat', '-c']), spawn(adb, ['-s', device, 'logcat', '-v', 'raw', '-s', 'ReactNativeJS:*']));

const results = new Map();
const finished = new Promise(resolve => {
	let buffer = '';
	logs.stdout.on('data', chunk => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const at = line.indexOf(MARK);
			if (at < 0) {
				continue;
			}
			const text = line.slice(at + MARK.length).trim();
			console.log(`${MARK} ${text}`);
			const [name, verdict] = text.split(' ');
			if (name === 'done') {
				resolve();
			} else if (verdict === 'PASS' || verdict === 'FAIL') {
				results.set(name, verdict === 'PASS');
			}
		}
	});
});

// The log stream needs a moment before it sees new lines.
await new Promise(resolve => setTimeout(resolve, 1500));
if (platform === 'ios') {
	await run('xcrun', ['simctl', 'openurl', device, link]);
} else {
	await run(adb, ['-s', device, 'shell', 'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard']);
	await run(adb, ['-s', device, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${link}'`, 'com.voltadk.volt']);
}
const timedOut = await Promise.race([finished.then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 120_000))]);
logs.kill();

const missing = EXPECTED.filter(name => !results.has(name));
const failed = EXPECTED.filter(name => results.get(name) === false);
console.log(`\n${platform}: ${EXPECTED.length - missing.length - failed.length}/${EXPECTED.length} passed${timedOut ? ' (timed out)' : ''}${failed.length ? `; failed: ${failed.join(', ')}` : ''}${missing.length ? `; no result: ${missing.join(', ')}` : ''}`);
process.exit(missing.length || failed.length ? 1 : 0);
