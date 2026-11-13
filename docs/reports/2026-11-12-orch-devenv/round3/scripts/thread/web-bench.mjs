#!/usr/bin/env node
// T3's remote tests for Volt's web workbench (the /code/ page the phone app wraps), in headless
// Chrome on a phone-sized screen, through slowlink.mjs (a TCP proxy that slows HTTP and
// WebSockets alike) or straight to the server.
//
//   --mode launch:    load /code/ with an empty cache (`--warm`: cache kept) and time it until the
//                     composer is on screen; bytes on the wire (from the proxy) and requests.
//   --mode reconnect: with /code/ loaded, cut the link (`--outage` ms, default 5000), restore it,
//                     and time until the page has a new WebSocket that has received a message, and
//                     until no "reconnect" text is on screen.
//   --mode terminal:  open a new terminal (Ctrl+Shift+`) and time until its first line of output.
//
//   node web-bench.mjs --mode launch --url http://127.0.0.1:9959/code/ [--runs 3] [--control 9960] [--out f.json]
import fs from 'node:fs';
import { connect, sleep, load, stats } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9957'));
const mode = opt('mode', 'launch');
const url = opt('url', 'http://127.0.0.1:9959/code/');
const runs = Number(opt('runs', '3'));
const control = opt('control', '9960');
const outage = Number(opt('outage', '5000'));
const warm = args.includes('--warm');
const out = opt('out');
const proxied = !url.includes(':9958');

const ctl = async path => proxied ? (await fetch(`http://127.0.0.1:${control}/${path}`)).json() : {};

// Recorded from the first script on each page: when the composer first shows, and every WebSocket's life.
const PROBE = `(() => {
	window.__bench = { ws: [] };
	const Native = window.WebSocket;
	window.WebSocket = class extends Native {
		constructor(...a) {
			super(...a);
			const rec = { url: String(a[0]).replace(/[?#].*/, ''), created: Date.now() };
			window.__bench.ws.push(rec);
			this.addEventListener('open', () => rec.opened = Date.now());
			this.addEventListener('message', () => { rec.messages = (rec.messages || 0) + 1; rec.firstMessage ??= Date.now(); });
			this.addEventListener('close', () => rec.closed = Date.now());
		}
	};
	const poll = () => {
		const composer = document.querySelector('.volt-agent-editor .monaco-editor .view-lines');
		if (composer && composer.getBoundingClientRect().height > 0) { window.__bench.composer = performance.now(); return; }
		requestAnimationFrame(poll);
	};
	requestAnimationFrame(poll);
})();`;

const cdp = await connect(port, /.*/);
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 3, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
let requests = 0;
let encoded = 0;
const urls = new Map();
let largest = new Map();
cdp.on(m => {
	if (m.method === 'Network.requestWillBeSent') {
		requests++;
		urls.set(m.params.requestId, m.params.request.url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*/, ''));
	} else if (m.method === 'Network.loadingFinished') {
		encoded += m.params.encodedDataLength;
		const u = urls.get(m.params.requestId) ?? '?';
		largest.set(u, (largest.get(u) ?? 0) + m.params.encodedDataLength);
	}
});

async function loadPage() {
	if (!warm) {
		await cdp.send('Network.clearBrowserCache');
	}
	await cdp.send('Network.setCacheDisabled', { cacheDisabled: !warm });
	await ctl('reset');
	requests = 0;
	encoded = 0;
	largest = new Map();
	await cdp.send('Page.navigate', { url });
	for (let i = 0; i < 1800; i++) {
		await sleep(100);
		const t = await cdp.evaluate('window.__bench && window.__bench.composer').catch(() => undefined);
		if (t) {
			return t;
		}
	}
	return undefined;
}

const results = [];
for (let run = 0; run < runs; run++) {
	let result;
	if (mode === 'launch') {
		const ms = await loadPage();
		await sleep(3000);
		const link = await ctl('stats');
		const top = [...largest].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, b]) => [u, b]);
		result = { composerMs: ms === undefined ? null : Math.round(ms), requests, encodedBytes: encoded, largest: top, wireDownBytes: link.down ?? null, wireUpBytes: link.up ?? null, connections: link.connections ?? null };
		console.log(`run ${run + 1}: composer on screen ${result.composerMs} ms, ${requests} requests, ${(encoded / 1e6).toFixed(2)} MB encoded, wire down ${link.down === undefined ? '-' : (link.down / 1e6).toFixed(2) + ' MB'}  (load ${load()})`);
	} else if (mode === 'reconnect') {
		if (run === 0) {
			await loadPage();
			await sleep(8000);
		}
		const before = await cdp.evaluate('window.__bench.ws.length');
		await ctl('down');
		await sleep(outage);
		const upAt = Date.now();
		await ctl('up');
		let r;
		for (let i = 0; i < 1200 && !r; i++) {
			await sleep(100);
			r = await cdp.evaluate(`(() => { const s = window.__bench.ws.slice(${before}).filter(w => w.created >= ${upAt - outage}); const got = s.filter(w => w.firstMessage && w.firstMessage >= ${upAt}); if (!got.length) return null; const banner = [...document.querySelectorAll('.monaco-dialog-box, .notification-toast, .volt-agent-connection, .monaco-workbench')].some(e => /reconnect|connection lost|disconnected/i.test(e.innerText || '')); return { firstMessage: Math.min(...got.map(w => w.firstMessage)) - ${upAt}, sockets: s.length, opened: got.length, banner }; })()`);
		}
		// And until the page says nothing about a lost connection any more.
		let clearAt;
		for (let i = 0; i < 600 && r; i++) {
			const banner = await cdp.evaluate(`[...document.querySelectorAll('.monaco-dialog-box, .notification-toast, .volt-agent-connection, .statusbar')].some(e => /reconnect|connection lost|disconnected/i.test(e.innerText || ''))`);
			if (!banner) {
				clearAt = Date.now() - upAt;
				break;
			}
			await sleep(100);
		}
		result = r ? { ...r, uiClearMs: clearAt ?? null } : null;
		console.log(`run ${run + 1}: ${r ? `first message on a new socket ${r.firstMessage} ms after the link came back (${r.opened} of ${r.sockets} sockets), no lost-connection text after ${clearAt ?? '-'} ms` : 'no socket came back in 120 s'}  (load ${load()})`);
		await sleep(5000);
	} else if (mode === 'terminal') {
		if (run === 0) {
			await loadPage();
			await sleep(8000);
		}
		await cdp.evaluate('document.querySelectorAll(".xterm").forEach(x => x.dataset.benchSeen = "1"), true');
		const t0 = Date.now();
		await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2 | 8 });
		await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2 | 8 });
		let shown;
		let output;
		for (let i = 0; i < 1200 && output === undefined; i++) {
			await sleep(50);
			// The new terminal's xterm (one more than before), and the text its rows show.
			const s = await cdp.evaluate(`(() => { const xs = [...document.querySelectorAll('.xterm')].filter(x => !x.dataset.benchSeen && x.getBoundingClientRect().height > 0); const x = xs[xs.length - 1]; if (!x) return null; const rows = x.querySelector('.xterm-rows'); const text = (rows ? rows.innerText : x.querySelector('.xterm-accessibility-tree')?.innerText ?? '').trim(); return { text: text.slice(0, 80) }; })()`);
			if (s && shown === undefined) {
				shown = Date.now() - t0;
			}
			if (s && s.text) {
				output = Date.now() - t0;
				result = { terminalShownMs: shown, firstOutputMs: output, firstText: s.text };
			}
		}
		await cdp.evaluate('document.querySelectorAll(".xterm").forEach(x => x.dataset.benchSeen = "1"), true');
		console.log(`run ${run + 1}: ${result ? `terminal on screen ${result.terminalShownMs} ms, first output ${result.firstOutputMs} ms ("${result.firstText}")` : 'no terminal output in 60 s'}  (load ${load()})`);
	}
	results.push(result ?? null);
}
const ok = results.filter(Boolean);
const key = { launch: 'composerMs', reconnect: 'firstMessage', terminal: 'firstOutputMs' }[mode];
const summary = { mode, url, warm, proxied, runs, load: load(), [key]: ok.length ? stats(ok.map(r => r[key]).filter(v => v !== null)) : null, results };
console.log(JSON.stringify({ [key]: summary[key] }));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
