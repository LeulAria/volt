// What the browser engine alone is worth for a key's time to the screen: the same bare page (engine-app/, no Volt
// code) in two or more Electron builds, the same probe as A8 (60 keys at 250 ms +-20 %, Chromium's EventLatency for
// KEY_PRESSED), in segments per frame load (idle, loop120, stream120, ...), engines interleaved.
//   node engine.mjs <rounds> <modes> <name=/path/to/Electron-binary> [name=/path ...]
//   rows appended to data/typing/engine.jsonl
import { spawn, execSync } from 'child_process';
import { appendFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { connect, DATA, HOME, load1, median, pct, PORT, sleep, targets, waitQuiet } from './lib.mjs';
import { keyLatencies, keyStages } from './a8.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const rounds = Number(process.argv[2] ?? 2);
const modes = (process.argv[3] ?? 'idle,loop120,stream120').split(',');
const engines = process.argv.slice(4).map(s => { const i = s.indexOf('='); return { name: s.slice(0, i), bin: s.slice(i + 1) }; });
const KEYS = Number(process.env.ENGINE_KEYS ?? 60);
const UD = `${HOME}/.volt-r9/typing/engine/ud`;
mkdirSync(DATA, { recursive: true });
const pooled = new Map();
for (let r = 0; r < rounds; r++) {
	for (const e of (r % 2 ? [...engines].reverse() : engines)) {
		await waitQuiet();
		rmSync(`${UD}-${e.name}`, { recursive: true, force: true });
		const env = { ...process.env };
		for (const k of Object.keys(env)) { if (/^(CLAUDE|VSCODE_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_)/.test(k)) { delete env[k]; } }
		const child = spawn(e.bin, [join(here, 'engine-app'), `--user-data-dir=${UD}-${e.name}`, `--remote-debugging-port=${PORT}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'], { env, detached: true, stdio: 'ignore' });
		child.unref();
		let page;
		for (let t = 0; t < 60 && !page; t++) { await sleep(500); try { page = (await targets()).find(p => p.type === 'page' && /page\.html/.test(p.url)); } catch { } }
		if (!page) { throw new Error(`${e.name}: no page`); }
		const c = await connect(page.webSocketDebuggerUrl, page.id);
		await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
		const ua = await c.evaluate('navigator.userAgent.match(/Chrome\\/[\\d.]+/)[0] + " " + navigator.userAgent.match(/Electron\\/[\\d.]+/)[0]');
		await sleep(3000);
		const traced = [];
		let mainFrames = 0;
		c.on('Tracing.dataCollected', p => { for (const ev of p.value) { if (ev.name === 'ProxyMain::BeginMainFrame' && ev.ph === 'X') { mainFrames++; } else if (ev.ph === 'b' || ev.ph === 'e' || ev.name === 'EventLatency') { traced.push(ev); } } });
		for (const mode of (r % 2 ? [...modes].reverse() : modes)) {
			await c.evaluate(`window.__mode(${JSON.stringify(mode)}); document.getElementById('box').value = ''; document.getElementById('box').focus()`);
			await sleep(1500);
			traced.length = 0; mainFrames = 0;
			const done = new Promise(res => { c.off('Tracing.tracingComplete'); c.on('Tracing.tracingComplete', res); });
			await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['latencyInfo', 'input', 'benchmark', 'cc'] } });
			const loadTyping = load1();
			const t0 = Date.now();
			for (let i = 0; i < KEYS; i++) {
				const ch = 'abcdefghijklmnopqrstuvwxyz'[i % 26];
				const code = ch.toUpperCase().charCodeAt(0);
				await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
				await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
				await sleep(250 * (0.8 + Math.random() * 0.4));
			}
			const fps = Math.round(mainFrames / ((Date.now() - t0) / 1000));
			await sleep(600);
			await c.send('Tracing.end');
			await done;
			const typed = (await c.evaluate(`document.getElementById('box').value.length`));
			const k2p = keyLatencies(traced).filter(v => v <= 2000);
			const mean = Math.round(k2p.reduce((a, b) => a + b, 0) / Math.max(1, k2p.length) * 100) / 100;
			const row = { engine: e.name, ua, mode, at: new Date().toISOString(), loadTyping, keys: KEYS, typed, missed: KEYS - typed, mainFps: fps, k2pN: k2p.length, k2pP50: median(k2p), k2pMean: mean, k2pP95: pct(k2p, 0.95), stages: keyStages(traced), k2p };
			appendFileSync(join(DATA, 'engine.jsonl'), JSON.stringify(row) + '\n');
			const key = `${e.name} ${mode}`;
			(pooled.get(key) ?? pooled.set(key, []).get(key)).push(...k2p);
			console.log(`${e.name.padEnd(6)} ${mode.padEnd(11)} ${ua} load ${String(loadTyping).padEnd(5)} mainFps ${String(fps).padStart(3)} typed ${typed} n ${k2p.length} p50 ${median(k2p)} mean ${mean} p95 ${pct(k2p, 0.95)}`);
		}
		c.close();
		try { execSync(`pkill -f -- '--user-data-dir=${UD}-${e.name}'`); } catch { }
		await sleep(1500);
	}
}
console.log('-- pooled');
for (const [k, v] of pooled) { console.log(`${k.padEnd(20)} n ${v.length} p50 ${median(v)} mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} p95 ${pct(v, 0.95)}`); }
