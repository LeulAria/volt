// A2 Relaunch (and A1 Cold Start when `sudo -n purge` works) — ADEMark method, unofficial, in-app timing.
// Quit the test instance, wait for a quiet Mac, start it (t0 just before the spawn), and type probe letters into
// the restored chat's composer every 50 ms (+-20 %), clicking the composer when it has no focus, as ADEMark does.
// Ready = the first painted frame whose composer holds two probe letters. Also records when the window's page
// target exists (window) and when the workbench DOM is there (workbench).
//   node a1.mjs <arm> <runs> [relaunch|cold]   (rows appended to data/speed/a1.jsonl)
// SPEED_CHECKOUT picks the build. Interleave arms with ab.sh or by calling this per arm with runs=1.
import { execSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DATA, PORT, load, launchDev, median, sleep, stopInstance, writeSettings, CHECKOUT } from './lib.mjs';

const [arm = 'dev', runsArg = '3', tier = 'relaunch'] = process.argv.slice(2);
mkdirSync(DATA, { recursive: true });
const PROBE = 'ademarkqz';

const INSTALL = `(() => {
	if (window.__a1) { return true; }
	const now = () => Date.now(); // wall clock, the clock of t0 and the replay log (timeOrigin + now() drifts from it)
	const s = window.__a1 = { ready: 0, paint: 0 };
	const probe = ${JSON.stringify(PROBE)};
	const pairs = [...probe].map((c, i) => c + probe[(i + 1) % probe.length]);
	const check = () => {
		if (s.ready) { return; }
		for (const lines of document.querySelectorAll('.volt-agent-composer .view-lines')) {
			if (pairs.some(p => (lines.textContent || '').includes(p))) {
				s.ready = now();
				mo.disconnect();
				requestAnimationFrame(() => requestAnimationFrame(() => { s.paint = now(); }));
				return;
			}
		}
	};
	const mo = new MutationObserver(check);
	mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
	return true;
})()`;

const FOCUSED = `(() => { const t = [...document.querySelectorAll('.volt-agent-composer textarea.inputarea')].filter(e => e.offsetParent).at(-1); return !t ? 'none' : document.activeElement === t ? 'yes' : 'no'; })()`;
const COMPOSER = `[...document.querySelectorAll('.volt-agent-composer .monaco-editor')].filter(e => e.offsetParent).at(-1)`;

async function connect() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
	if (!page) {
		return undefined;
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let id = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	return { ws, send, evaluate };
}

async function once(rep) {
	await stopInstance();
	if (tier === 'cold') {
		execSync('sudo -n purge');
		await sleep(10_000);
	}
	// The quiet gate is suite.mjs's (before each arm); each row records the load it ran under.
	await sleep(3000);
	writeSettings();
	const loadAvg = load();
	const t0 = Date.now();
	launchDev();
	let c;
	let windowAt = 0;
	let workbenchAt = 0;
	let clicked = 0;
	let typed = 0;
	let s;
	const deadline = t0 + 120_000;
	while (Date.now() < deadline) {
		if (!c) {
			try { c = await connect(); } catch { c = undefined; }
			if (!c) { await sleep(25); continue; }
			windowAt = Date.now();
		}
		const state = await c.evaluate(`(() => { if (!document.querySelector('.monaco-workbench')) { return 'loading'; } ${INSTALL}; return ${FOCUSED}; })()`);
		if (state === undefined) {
			// The page navigated (workbench load); attach again.
			try { c.ws.close(); } catch { }
			c = undefined;
			continue;
		}
		if (state === 'loading' || state === 'none') {
			await sleep(25);
			continue;
		}
		workbenchAt ||= Date.now();
		if (state === 'no') {
			const at = await c.evaluate(`(() => { const e = ${COMPOSER}; if (!e) { return undefined; } const r = e.getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; })()`);
			if (at) {
				for (const type of ['mousePressed', 'mouseReleased']) {
					await c.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
				}
				clicked++;
			}
		}
		const ch = PROBE[typed++ % PROBE.length];
		const kc = ch.toUpperCase().charCodeAt(0);
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
		await sleep(50 * (0.8 + Math.random() * 0.4));
		s = await c.evaluate('window.__a1');
		if (s?.paint) {
			break;
		}
	}
	// The renderer's own marks split out the dev build's unbundled module load (thousands of ES modules; a
	// shipped build loads one bundle), so the part that is the same in a shipped build can be compared too.
	const marks = c ? await c.evaluate(`(() => { const o = performance.timeOrigin - (performance.timeOrigin + performance.now() - Date.now()); const m = n => { const e = performance.getEntriesByName(n)[0]; return e ? Math.round(o + e.startTime) : null; }; return { rendererStart: m('code/didStartRenderer'), willLoad: m('code/willLoadWorkbenchMain'), didLoad: m('code/didLoadWorkbenchMain'), restored: m('code/didRemovePartsSplash') }; })()`) : undefined;
	const rel = v => (typeof v === 'number' ? v - t0 : null);
	const row = {
		arm, tier, rep, checkout: CHECKOUT, at: new Date(t0).toISOString(), load: loadAvg,
		readyMs: s?.paint ? Math.round(s.paint - t0) : null, windowMs: windowAt ? windowAt - t0 : null, workbenchMs: workbenchAt ? workbenchAt - t0 : null,
		rendererStartMs: rel(marks?.rendererStart), moduleLoadMs: marks?.didLoad && marks?.willLoad ? marks.didLoad - marks.willLoad : null,
		afterModuleLoadMs: s?.paint && marks?.didLoad ? Math.round(s.paint - marks.didLoad) : null,
		probesTyped: typed, focusClicks: clicked,
	};
	// Clear the composer so the next launch restores an empty one.
	if (c) {
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
		await sleep(1500);
		c.ws.close();
	}
	appendFileSync(join(DATA, 'a1.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
	return row;
}

const rows = [];
for (let i = 0; i < Number(runsArg); i++) {
	rows.push(await once(i));
}
console.log(JSON.stringify({ arm, tier, n: rows.length, readyMs: median(rows.map(r => r.readyMs)) }));
