// The same A8 measure (EventLatency of each KEY_PRESSED, key event to presented frame) on T3 Code, so both apps are
// timed by one method on this Mac. T3 Code (Nightly) from /Applications with its own home (T3CODE_HOME) and Electron
// profile, ADEMark's server settings (adapters/t3code.ts), the Claude agent pointed at the replay server, 5 threads
// each sent `replay:stream-<n>` 2 s apart, then 60 probe characters at 250 ms +-20 %.
// Setup once: settings.json in <home>/userdata and `t3 project add --title arena <arena>` (see the report).
//   node t3a8.mjs [reps=1]      rows appended to data/typing/a8.jsonl with arm "t3code"
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { connect, DATA, HOME, load1, median, pct, PORT, REPLAY, sleep, waitQuiet } from './lib.mjs';
import { keyLatencies, keyStages } from './a8.mjs';

const APP = process.env.T3_APP ?? '/Applications/T3 Code (Nightly).app';
const T3 = `${HOME}/.volt-r8/typing/t3`;
const BIN = `${APP}/Contents/MacOS/${APP.replace(/^.*\//, '').replace(/\.app$/, '')}`;
const env = () => {
	const e = { ...process.env };
	for (const k of Object.keys(e)) { if (/^(CLAUDE|VSCODE_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_)/.test(k)) { delete e[k]; } }
	return { ...e, T3CODE_HOME: `${T3}/home`, T3CODE_TELEMETRY_ENABLED: 'false', ANTHROPIC_BASE_URL: `http://127.0.0.1:${REPLAY}` };
};
const page = async () => {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const p = list.find(t => t.type === 'page' && /^t3code:/.test(t.url));
	if (!p) { throw new Error('no T3 Code page'); }
	return connect(p.webSocketDebuggerUrl, p.id);
};
const pids = () => execSync(`pgrep -f '${T3}/' || true`).toString().trim().split('\n').filter(Boolean).map(Number);
async function stop() {
	for (const sig of ['SIGTERM', 'SIGKILL']) {
		for (const pid of pids()) { try { process.kill(pid, sig); } catch { } }
		await sleep(2500);
	}
}

async function rep() {
	const loadStart = await waitQuiet(14);
	console.log(`== t3code load ${loadStart} ${new Date().toISOString()}`);
	try { execSync(`git -C ${T3}/arena checkout -q -- . && git -C ${T3}/arena clean -qfd`); } catch { }
	const log = openSync(`${T3}/app.log`, 'a');
	spawn(BIN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${T3}/ud`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'], { cwd: HOME, env: env(), detached: true, stdio: ['ignore', log, log] }).unref();
	let c;
	for (let i = 0; i < 60 && !c; i++) { await sleep(1000); try { c = await page(); } catch { } }
	await sleep(8000);
	execSync(`'${T3}/home/bin/t3' app '${T3}/arena'`, { env: env(), cwd: HOME });
	await sleep(3000);
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	// The first-run "Set up T3 Code" dialog, when it shows.
	await c.evaluate(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => /^Close$/.test(b.innerText.trim() || b.getAttribute('aria-label') || '')); b?.click(); return !!b; })()`);
	await sleep(500);
	const sentAt = Date.now();
	for (let n = 1; n <= 5; n++) {
		await c.key('n', 'KeyN', 78, 4);
		await sleep(1500);
		await c.send('Input.insertText', { text: `replay:stream-${n}` });
		await sleep(400);
		await c.key('Enter', 'Enter', 13, 0, '\r');
		await sleep(2000);
	}
	await sleep(8000);
	const TEXT = `document.querySelector('main')?.innerText.length ?? document.body.innerText.length`;
	const COMPOSER = `(document.activeElement?.isContentEditable ? document.activeElement.innerText : '')`;
	const textBefore = await c.evaluate(TEXT);
	const focused = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[contenteditable=true]')].filter(e => e.offsetParent).at(-1); e?.focus(); return !!e && document.activeElement === e; })()`);
	const loadTyping = load1();
	const traced = [];
	c.on('Tracing.dataCollected', p => { for (const e of p.value) { if (e.ph === 'b' || e.ph === 'e' || e.name === 'EventLatency') { traced.push(e); } } });
	const traceDone = new Promise(r => c.on('Tracing.tracingComplete', r));
	await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['latencyInfo', 'input', 'benchmark'] } });
	await sleep(300);
	const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';
	for (let i = 0; i < 60; i++) {
		const ch = PROBE_CHARS[i % PROBE_CHARS.length];
		const code = ch.toUpperCase().charCodeAt(0);
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
		await sleep(250 * (0.8 + Math.random() * 0.4));
	}
	await sleep(2000);
	await c.send('Tracing.end');
	await traceDone;
	const typed = (await c.evaluate(COMPOSER) ?? '').replace(/\s/g, '').length;
	const textAfter = await c.evaluate(TEXT);
	const running = await c.evaluate(`document.body.innerText.match(/Working|Stop|Thinking/g)?.length ?? 0`);
	const loadEnd = load1();
	const k2p = keyLatencies(traced).filter(v => v <= 2000);
	// Analysis aid: SMOOTH_TRACE_OUT=<file> keeps the key spans (latencyInfo) for per-key stage tools.
	if (process.env.SMOOTH_TRACE_OUT) { writeFileSync(process.env.SMOOTH_TRACE_OUT, JSON.stringify({ traceEvents: traced })); }
	const row = {
		arm: 't3code', app: APP, at: new Date().toISOString(), loadStart, loadTyping, loadEnd, streamingS: Math.round((Date.now() - sentAt) / 1000), focused, textBefore, textAfter, streamed: textAfter > textBefore, running,
		keys: 60, typed, missed: 60 - typed, k2pN: k2p.length, k2pP50: median(k2p), k2pP95: pct(k2p, 0.95), k2pMax: k2p.length ? Math.max(...k2p) : null, stages: keyStages(traced), k2p,
	};
	mkdirSync(DATA, { recursive: true });
	appendFileSync(join(DATA, 'a8.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ ...row, k2p: undefined }));
	if (process.env.T3_KEEP !== '1') { c.close(); await stop(); await sleep(5000); } else { c.close(); }
}

const reps = Number(process.argv[2] ?? 1);
for (let i = 0; i < reps; i++) { await rep(); }
