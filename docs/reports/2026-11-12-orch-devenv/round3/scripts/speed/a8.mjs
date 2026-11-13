// A8 Typing Lag (ADEMark method, unofficial, in-app timing): open 5 new threads and send `replay:stream-1` to
// `replay:stream-5` 2 s apart (each a 3-minute stream at 80 tokens/s), then type 60 probe letters, one every
// 250 ms (+-20 %), into the front thread's composer while all five stream. Latency per key = the key event's own
// timestamp (set when CDP posts it, so a busy main thread counts) to the first frame after the composer's text
// changed (`frame`: rAF callback; `painted`: a task posted from that rAF, which runs after the frame is committed).
// A key with no echo in 2 s is missed. ADEMark types into thread 1; here the front thread is thread 5 (the last
// opened), which streams the same way. With `--sample`, ADEMark's sampler records the app's memory while typing
// (A7-style p95 over that window, not A7's 3-minute window).
//   node a8.mjs <arm> [--sample]   (one row per run appended to data/speed/a8.jsonl)
import { execFile } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, focusComposer, load, newChat, sleep, UD } from './lib.mjs';
import { execSync } from 'child_process';

const [arm = 'dev', ...flags] = process.argv.slice(2);
const PROBE = 'ademarkqz';
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
mkdirSync(join(DATA, 'raw'), { recursive: true });

const INSTALL = `(() => {
	const s = window.__a8 = { keys: [] };
	const editor = () => [...document.querySelectorAll('.volt-agent-composer .view-lines')].filter(e => e.offsetParent).at(-1);
	let pending;
	window.addEventListener('keydown', e => {
		if (e.key.length !== 1) { return; }
		pending = { t: e.timeStamp, text: editor()?.textContent ?? '' };
		s.keys.push(pending);
	}, { capture: true });
	const mo = new MutationObserver(() => {
		const k = pending;
		if (!k || k.dom) { return; }
		const text = editor()?.textContent ?? '';
		if (text === k.text) { return; }
		k.dom = performance.now();
		requestAnimationFrame(f => {
			k.frame = performance.now();
			const ch = new MessageChannel();
			ch.port1.onmessage = () => { k.painted = performance.now(); };
			ch.port2.postMessage(0);
		});
	});
	mo.observe(document.body, { subtree: true, childList: true, characterData: true });
	s.stop = () => mo.disconnect();
	return true;
})()`;

const streamingCount = `[...document.querySelectorAll('[aria-label]')].filter(e => /^(Stop|Cancel)/.test(e.getAttribute('aria-label') ?? '') && e.offsetParent).length`;

function pct(values, p) {
	const s = [...values].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : null;
}

const c = await cdp();
const loadStart = load();
const t0 = Date.now();
for (let i = 1; i <= 5; i++) {
	await newChat(c);
	await sleep(1500);
	if (!await focusComposer(c)) {
		throw new Error('no composer');
	}
	await c.send('Input.insertText', { text: `replay:stream-${i}` });
	await sleep(500);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	if (i < 5) {
		await sleep(2000);
	}
}
// Let the fifth stream's first turn (a Read) finish and its long answer start.
await sleep(6000);
await focusComposer(c);
await c.evaluate(INSTALL);
let sampler;
const csv = join(DATA, 'raw', `a8-${arm}-${Date.now()}.csv`);
if (flags.includes('--sample')) {
	const main = execSync('ps -axo pid=,command=').toString().split('\n').find(l => l.includes(`--user-data-dir ${UD}`) && /MacOS\/(Electron|VOLT)( |$)/.test(l) && !l.includes('--type='));
	const rules = join(DATA, 'raw', `a8-rules-${arm}.json`);
	writeFileSync(rules, JSON.stringify({ rootPids: [Number(main.trim().split(/\s+/)[0])], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
	sampler = new Promise(res => execFile(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', '18', '--csv', csv], { encoding: 'utf8' }, (err, out) => res(err ? undefined : JSON.parse(out))));
}
const loadTyping = load();
for (let i = 0; i < 60; i++) {
	const ch = PROBE[i % PROBE.length];
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await sleep(250 * (0.8 + Math.random() * 0.4));
}
await sleep(2000);
const streaming = await c.evaluate(streamingCount);
const s = await c.evaluate('(() => { window.__a8.stop(); return window.__a8.keys; })()');
const frame = s.filter(k => k.frame && k.frame - k.t <= 2000).map(k => k.frame - k.t);
const painted = s.filter(k => k.painted && k.painted - k.t <= 2000).map(k => k.painted - k.t);
const r = v => (v === null ? null : Math.round(v * 10) / 10);
const sample = sampler ? await sampler : undefined;
// Clear the composer.
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
const row = {
	arm, at: new Date(t0).toISOString(), load: loadStart, loadTyping, keys: s.length, missed: s.length - painted.length, stopButtonsAfter: streaming,
	frameP50: r(pct(frame, 50)), frameP95: r(pct(frame, 95)), frameMax: r(Math.max(...frame)),
	paintedP50: r(pct(painted, 50)), paintedP95: r(pct(painted, 95)), paintedMax: r(Math.max(...painted)),
	...(sample ? { appP95MiB: Math.round(sample.app_p95_b / 1048576) || undefined, appMedianMiB: Math.round(sample.app_median_b / 1048576), agentsMedianMiB: Math.round(sample.agents_median_b / 1048576), csv } : {}),
	painted: painted.map(v => Math.round(v)),
};
appendFileSync(join(DATA, 'a8.jsonl'), JSON.stringify(row) + '\n');
const { painted: _p, ...brief } = row;
console.log(JSON.stringify(brief));
