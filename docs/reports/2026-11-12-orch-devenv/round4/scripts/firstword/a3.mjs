// A3 Thread Open (ADEMark method, unofficial, in-app timing): from a finished thread, click New Agent and
// type probe letters every 50 ms (+-20 %); Ready = the first painted frame where the new chat's composer
// holds two probe letters and the old thread's marker is gone. Then the new thread is seeded
// (`replay:seed`) so the next repetition starts from a seeded thread, as ADEMark does.
//   node a3.mjs <arm> <runs>   (rows appended to data/speed/a3.jsonl)
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, focusComposer, load, sleep, median } from './lib.mjs';

const [arm = 'dev', runsArg = '6'] = process.argv.slice(2);
mkdirSync(DATA, { recursive: true });
const PROBE = 'ademarkqz';
const MARKERS = ['unchanged', 'LEDGERMARK'];

const INSTALL = `(() => {
	const now = () => Date.now(); // wall clock, the clock of t0 and the replay log (timeOrigin + now() drifts from it)
	const s = window.__a3 = { ready: 0, paint: 0, firstKeyInNew: 0 };
	const probe = ${JSON.stringify(PROBE)};
	const pairs = [...probe].map((c, i) => c + probe[(i + 1) % probe.length]);
	const markers = ${JSON.stringify(MARKERS)};
	const check = () => {
		if (s.ready) { return; }
		const mains = [...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent);
		if (!mains.length || mains.some(m => markers.some(k => (m.querySelector('.volt-agent-transcript, .volt-agent-messages') ?? m).textContent.includes(k)))) { return; }
		for (const lines of mains.flatMap(m => [...m.querySelectorAll('.volt-agent-composer .view-lines')])) {
			const text = lines.textContent || '';
			if (pairs.some(p => text.includes(p))) {
				s.ready = now();
				s.readyText = text.slice(0, 40);
				mo.disconnect();
				requestAnimationFrame(() => requestAnimationFrame(() => { s.paint = now(); }));
				return;
			}
		}
	};
	const mo = new MutationObserver(check);
	mo.observe(document.body, { subtree: true, childList: true, characterData: true });
	return true;
})()`;

const markerShown = `(() => [...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).some(m => ${JSON.stringify(MARKERS)}.some(k => m.textContent.includes(k))))()`;

async function typeChar(c, ch) {
	const code = `Key${ch.toUpperCase()}`;
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
}

async function once(c, rep) {
	if (!await c.evaluate(markerShown)) {
		throw new Error('no seeded thread on screen');
	}
	const button = await c.center(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label')))`);
	if (!button) {
		throw new Error('no New Agent button');
	}
	await c.evaluate(INSTALL);
	const loadAvg = load();
	const t0 = Date.now();
	await c.click(...button);
	let s;
	let typed = 0;
	const deadline = t0 + 8000;
	while (Date.now() < deadline) {
		await typeChar(c, PROBE[typed++ % PROBE.length]);
		await sleep(50 * (0.8 + Math.random() * 0.4));
		s = await c.evaluate('window.__a3');
		if (s?.paint) {
			break;
		}
	}
	const row = { arm, rep, at: new Date(t0).toISOString(), load: loadAvg, readyMs: s?.paint ? Math.round(s.paint - t0) : null, domMs: s?.ready ? Math.round(s.ready - t0) : null, probesTyped: typed, readyText: s?.readyText };
	appendFileSync(join(DATA, 'a3.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
	// Clear the composer, then seed the new thread (untimed) so the next repetition starts from one.
	await focusComposer(c);
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
	await sleep(200);
	await c.send('Input.insertText', { text: 'replay:seed' });
	await sleep(400);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	for (let i = 0; i < 100 && !await c.evaluate(markerShown); i++) {
		await sleep(200);
	}
	await sleep(1500);
	return row;
}

const c = await cdp();
const rows = [];
for (let i = 0; i < Number(runsArg); i++) {
	try {
		rows.push(await once(c, i));
	} catch (err) {
		console.log('run failed', String(err));
	}
	await sleep(1000);
}
c.close();
console.log(JSON.stringify({ arm, n: rows.length, readyMs: median(rows.map(r => r.readyMs)), min: Math.min(...rows.map(r => r.readyMs ?? Infinity)), max: Math.max(...rows.map(r => r.readyMs ?? 0)) }));
