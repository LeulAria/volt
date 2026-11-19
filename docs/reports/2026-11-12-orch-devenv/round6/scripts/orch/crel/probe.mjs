// The C3 chat-lock probe on its own, for a C1 run driven by ../c1/runvolt.mjs (which lets go of CDP once the prompt
// is sent): one `z` typed as a key into the active chat's composer every 2 s, its echo timed on the DOM, deleted at
// once; a lock is a probe with no echo within 2 s (TESTS.md 4, C3). Runs until the stop file exists or `--seconds`.
//   VOLT_CDP=9971 node probe.mjs <id> [--seconds 900] [--stop <file>]
// Writes data/orch/crel/<id>.probes.json and one summary row to data/orch/crel/probe-runs.jsonl.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../../data/orch/crel');
const PORT = Number(process.env.VOLT_CDP ?? 9971);
const opt = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const [id] = process.argv.slice(2);
const seconds = Number(opt('--seconds', 900));
const stopFile = opt('--stop', join(process.env.HOME, `.volt-r6/orch/c1/probe-${id}.stop`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROBE_CHAR = 'z';

async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	if (!page) { throw new Error('no workbench target'); }
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let n = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	return { send, evaluate, close: () => ws.close() };
}

const COMPOSER = `[...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1)`;
const composerText = c => c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-composer .view-lines')].filter(e => e.offsetParent).at(-1)?.textContent ?? '')()`);
const composerFocused = c => c.evaluate(`(() => { const t = ${COMPOSER}; return !!t && document.activeElement === t; })()`);
const focusComposer = c => c.evaluate(`(() => { const t = ${COMPOSER}; if (!t) { return false; } t.focus(); return document.activeElement === t; })()`);

async function probeOnce(c) {
	let refocused = false;
	if (!await composerFocused(c)) { refocused = await focusComposer(c); }
	const t = Date.now();
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: PROBE_CHAR, code: 'KeyZ', windowsVirtualKeyCode: 90, text: PROBE_CHAR, unmodifiedText: PROBE_CHAR });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: PROBE_CHAR, code: 'KeyZ', windowsVirtualKeyCode: 90 });
	const ms = await c.evaluate(`new Promise(resolve => { const t0 = performance.now(); const tick = () => { const el = [...document.querySelectorAll('.volt-agent-composer .view-lines')].filter(e => e.offsetParent).at(-1); if (el && el.textContent.includes(${JSON.stringify(PROBE_CHAR)})) { resolve(Math.round(performance.now() - t0)); } else if (performance.now() - t0 > 2000) { resolve(null); } else { requestAnimationFrame(tick); } }; tick(); })`);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
	if ((await composerText(c)).includes(PROBE_CHAR)) {
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
	}
	return { at: t, ms: ms ?? null, ...(refocused ? { refocused: true } : {}) };
}

mkdirSync(DATA, { recursive: true });
const t0 = Date.now();
const probes = [];
let c = await cdp();
while (Date.now() - t0 < seconds * 1000 && !existsSync(stopFile)) {
	const next = Date.now() + 2000;
	try {
		const p = await probeOnce(c);
		probes.push({ at: p.at - t0, ms: p.ms, ...(p.refocused ? { refocused: true } : {}) });
		if (p.ms === null) { console.log(JSON.stringify({ at: p.at - t0, lost: true })); }
	} catch (err) {
		probes.push({ at: Date.now() - t0, ms: null, error: String(err).slice(0, 80) });
		try { c.close(); } catch { }
		try { c = await cdp(); } catch { }
	}
	await sleep(Math.max(0, next - Date.now()));
}
c.close();
const lost = probes.filter(p => p.ms === null);
const locks = [];
for (let i = 0; i < probes.length;) {
	if (probes[i].ms !== null) { i++; continue; }
	const first = i;
	while (i < probes.length && probes[i].ms === null) { i++; }
	const end = i < probes.length ? probes[i].at : probes[i - 1].at;
	locks.push({ from: probes[first].at, ms: Math.max(0, end - probes[first].at) });
}
const echoed = probes.filter(p => p.ms !== null).map(p => p.ms).sort((a, b) => a - b);
const row = { id, at: new Date(t0).toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(0), count: probes.length, lost: lost.length, locks: locks.length, longestLockMs: Math.max(0, ...locks.map(l => l.ms)), echoMedianMs: echoed[Math.floor(echoed.length / 2)] ?? null, echoP95Ms: echoed[Math.floor(echoed.length * 0.95)] ?? null, refocused: probes.filter(p => p.refocused).length };
writeFileSync(join(DATA, `${id}.probes.json`), JSON.stringify(probes));
appendFileSync(join(DATA, 'probe-runs.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
