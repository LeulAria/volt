// Analysis aid (not a result): does work inside the key's frame move its presentation? In a running arm, types
// segments of probe keys into the composer on screen with a busy wait injected (from outside, by CDP) either into
// the key's own handler (`key<ms>`) or into the next animation frame after the key (`raf<ms>`), interleaved with
// plain segments. Prints key-to-presentation p50 / mean / p95 per variant (pooled over its segments).
//   node inject.mjs [keys=40] [variants=plain,raf2,key2,plain,raf2,key2]
import { cdp, focusComposer, median, pct, sleep } from './lib.mjs';
import { keyLatencies } from './a8.mjs';
const keys = Number(process.argv[2] ?? 40);
const variants = (process.argv[3] ?? 'plain,raf2,key2,plain,raf2,key2').split(',');
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
const traced = [];
c.on('Tracing.dataCollected', p => { for (const e of p.value) { if (e.ph === 'b' || e.ph === 'e' || e.name === 'EventLatency') { traced.push(e); } } });
const pooled = new Map();
const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';
for (const v of variants) {
	const m = /^(raf|key)(\d+(?:\.\d+)?)$/.exec(v);
	const loop = /^loop(\d+)/.exec(v);
	// A trailing `c` (plainc, loop60c): a compositor-only animation runs too (a 1 px element's transform), so the
	// compositor draws every frame without the main thread, as a glide drawn by the compositor between main frames would.
	await c.evaluate(`(() => { document.getElementById('volt-inj-comp')?.remove(); if (!${JSON.stringify(v.endsWith('c'))}) { return; } const el = document.body.appendChild(document.createElement('div')); el.id = 'volt-inj-comp'; el.style.cssText = 'position:fixed;left:2px;top:0;width:2px;height:2px;background:#888;opacity:0.02;pointer-events:none;will-change:transform'; el.animate([{ transform: 'translateY(0px)' }, { transform: 'translateY(40px)' }], { duration: 2000, iterations: Infinity, direction: 'alternate' }); })()`);
	// loop<hz>: a page animation that needs a main frame <hz> times a second (a 1 px element's text changes), like a
	// stream's per-frame paint: loop120 every frame of this panel, loop60 every other frame (the rAF requested from a
	// timer), so the effect of stream frames on a key's wait for its frame shows without a stream.
	await c.evaluate(`(() => { window.__loop?.(); window.__loop = undefined; const hz = ${loop ? Number(loop[1]) : 0}; if (!hz) { return; } const el = document.body.appendChild(document.createElement('div')); el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;font-size:1px;opacity:0.01;pointer-events:none'; let on = true, n = 0; const tick = () => { if (!on) { return; } el.textContent = String(n++ % 10); if (hz >= 120) { requestAnimationFrame(tick); } else { setTimeout(() => requestAnimationFrame(tick), 1000 / hz - 8.4); } }; requestAnimationFrame(tick); window.__loop = () => { on = false; el.remove(); }; })()`);
	await c.evaluate(`(() => { window.__inj?.(); window.__inj = undefined; const kind = ${JSON.stringify(m?.[1] ?? '')}, ms = ${m ? Number(m[2]) : 0}; if (!kind) { return; } const busy = () => { const t = performance.now(); while (performance.now() - t < ms) { } }; const on = e => { if (kind === 'key') { busy(); } else { requestAnimationFrame(busy); } }; window.addEventListener('keydown', on, true); window.__inj = () => window.removeEventListener('keydown', on, true); })()`);
	await focusComposer(c);
	traced.length = 0;
	const done = new Promise(r => { c.off?.('Tracing.tracingComplete'); c.on('Tracing.tracingComplete', r); });
	await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['latencyInfo', 'input', 'benchmark'] } });
	await sleep(300);
	for (let i = 0; i < keys; i++) {
		const ch = PROBE_CHARS[i % PROBE_CHARS.length];
		const code = ch.toUpperCase().charCodeAt(0);
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
		await sleep(250 * (0.8 + Math.random() * 0.4));
	}
	await sleep(1200);
	await c.send('Tracing.end');
	await done;
	const k2p = keyLatencies(traced);
	(pooled.get(v) ?? pooled.set(v, []).get(v)).push(...k2p);
	console.log(`${v.padEnd(8)} n ${k2p.length} p50 ${median(k2p)} mean ${(k2p.reduce((a, b) => a + b, 0) / k2p.length).toFixed(2)} p95 ${pct(k2p, 0.95)}`);
	// Clear the probe text between segments (select all + delete) so the draft stays one line.
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
}
await c.evaluate(`window.__inj?.(); window.__loop?.(); document.getElementById('volt-inj-comp')?.remove()`);
console.log('-- pooled');
for (const [v, k2p] of pooled) { console.log(`${v.padEnd(8)} n ${k2p.length} p50 ${median(k2p)} mean ${(k2p.reduce((a, b) => a + b, 0) / k2p.length).toFixed(2)} p95 ${pct(k2p, 0.95)}`); }
c.close();
