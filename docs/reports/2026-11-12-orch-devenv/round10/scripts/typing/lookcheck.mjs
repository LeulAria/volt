// Check (not a timing): that a streaming reply looks the same per arm. One chat streams `replay:stream-1`; for 6 s a
// 2 ms timer (no frame loop of its own, which would ask for a frame at every refresh) samples
//   - every fade span's computed colour: the set of colours seen (the fade's palette), how long a span lives, how many
//     colour changes a second, and whether any span is left 1.5 s after it appeared (a fade that never ended);
//   - the thread's scrollTop: position changes a second and the time between two changes while the follow glide runs
//     (one step per refresh = 8.3 ms at 120 Hz), and the largest single step.
// Then stops the stream's view for 2 s and counts the spans left (expected 0 once the last fade is over).
//   node lookcheck.mjs <arm,arm,...>
import { freshProfile } from './a8.mjs';
import { arm as armOf, cdp, launch, load1, newChat, send, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';
const SAMPLE = `new Promise(resolve => {
	const inner = [...document.querySelectorAll('.volt-agent-thread-inner')].find(e => e.offsetParent);
	let scroller = inner; while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && scroller.scrollTop > 0)) { scroller = scroller.parentElement; }
	const palette = new Set(), born = new Map(), last = new Map(); let colourChanges = 0, maxLife = 0, stuck = 0, maxSpans = 0;
	let top = scroller?.scrollTop ?? 0, topAt = performance.now(); const gaps = []; let moves = 0, maxStep = 0;
	const t0 = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		const spans = document.querySelectorAll('.volt-agent-fresh-text');
		maxSpans = Math.max(maxSpans, spans.length);
		for (const s of spans) {
			if (!s.isConnected) { continue; }
			const col = getComputedStyle(s).color;
			palette.add(col);
			if (!born.has(s)) { born.set(s, now); }
			if (last.has(s) && last.get(s) !== col) { colourChanges++; }
			last.set(s, col);
			const life = now - born.get(s);
			maxLife = Math.max(maxLife, life);
		}
		if (scroller) { const t = scroller.scrollTop; if (t !== top) { moves++; maxStep = Math.max(maxStep, Math.abs(t - top)); gaps.push(now - topAt); top = t; topAt = now; } }
		if (now - t0 > 6000) {
			clearInterval(timer);
			for (const s of document.querySelectorAll('.volt-agent-fresh-text')) { if (born.has(s) && now - born.get(s) > 1500) { stuck++; } }
			const g = gaps.filter(x => x < 40).sort((a, b) => a - b);
			const paused = [...document.querySelectorAll('.volt-agent-fresh-text')].filter(s => getComputedStyle(s).animationPlayState === 'paused').length;
			resolve({ spansMax: maxSpans, palette: palette.size, paletteHash: [...palette].sort().join('|').length, paletteSample: [...palette].sort().slice(0, 3), colourChangesPerS: Math.round(colourChanges / 6), maxLifeMs: Math.round(maxLife), stuck, pausedNow: paused, scrollMovesPerS: Math.round(moves / 6), glideGapP50: g[g.length >> 1]?.toFixed(1), glideGapP90: g[Math.floor(g.length * 0.9)]?.toFixed(1), maxStepPx: Math.round(maxStep * 10) / 10, palettes: [...palette].sort() });
		}
	}, 2);
})`;
const out = {};
for (const arm of (process.argv[2] ?? 'r8,after').split(',').map(armOf)) {
	await freshProfile(arm);
	writeSettings(arm);
	launch(arm, { keepRendering: true });
	await waitWorkbench();
	await sleep(8000);
	const c = await cdp();
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	await newChat(c); await sleep(1500); await send(c, 'replay:stream-1'); await sleep(5000);
	const r = await c.evaluate(SAMPLE);
	out[arm] = r.palettes; delete r.palettes;
	console.log(arm.padEnd(8), 'load', load1(), JSON.stringify(r));
	c.close();
	await stop(arm);
}
const arms = Object.keys(out);
if (arms.length === 2) {
	const [a, b] = arms.map(k => new Set(out[k]));
	const onlyA = [...a].filter(x => !b.has(x)), onlyB = [...b].filter(x => !a.has(x));
	console.log(`palette: ${arms[0]} ${a.size} colours, ${arms[1]} ${b.size}; only in ${arms[0]}: ${onlyA.length}, only in ${arms[1]}: ${onlyB.length}`, onlyA.slice(0, 4), onlyB.slice(0, 4));
}
