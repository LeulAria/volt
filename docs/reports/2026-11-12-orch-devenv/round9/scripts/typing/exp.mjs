// Analysis aid (not a result): which part of the streaming chat's frame holds a key back. One launch of an arm with 5
// streams, then segments of probe keys, each with one thing switched off from outside (CSS or a scroll), interleaved
// with plain segments. Prints key-to-presentation p50/p95 and the stage medians per segment.
//   node exp.mjs <arm> [keys=40] [variants=plain,nofade,plain,noglide,plain,nomask]
//   nofade  = the streamed text's colour fade off (.volt-agent-fresh-text animation none)
//   noglide = the reader scrolled up 300 px, so the follow glide does not run (the reply still paints, off screen end)
//   nomask  = the transcript's bottom fade mask off
//   noanim  = every CSS animation and transition in the window off
//   census  = no keys: print the running animations (anims.mjs)
//   oldfade = the fade's colour changing on every frame, as before round 8 (builds with the stepped fade)
import { arm as armOf, cdp, focusComposer, launch, load1, median, newChat, pct, send, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';
import { freshProfile, keyLatencies, keyStages } from './a8.mjs';
import { CENSUS } from './anims.mjs';
const arm = armOf(process.argv[2] ?? 'after');
const keys = Number(process.argv[3] ?? 40);
const variants = (process.argv[4] ?? 'plain,nofade,plain,noglide,plain,nomask').split(',');
const CSS = {
	nofade: '.volt-agent-fresh-text{animation:none !important}',
	nomask: '.volt-agent-thread > .monaco-scrollable-element{-webkit-mask-image:none !important;mask-image:none !important}',
	noanim: '*,*::before,*::after{animation:none !important;transition:none !important}',
	// The fade as before round 8's stepped fade: a new colour on every frame.
	oldfade: '.volt-agent-fresh-text{animation-timing-function:ease-out !important}',
	// Prototypes of a stepped fade: the colour changes 30 or 60 times a second, not on every frame.
	step30u: '.volt-agent-fresh-text{animation-timing-function:steps(33,end) !important}',
	step30: '.volt-agent-fresh-text{animation-timing-function:steps(33,end) !important}',
	step60: '.volt-agent-fresh-text{animation-timing-function:steps(66,end) !important}',
};
// step30 / step60 also line every span's steps up on one clock (the animation's start moved back to the grid).
const ALIGN = stepMs => `(() => { window.__align?.stop(); const st = { on: true, n: 0, stop() { this.on = false; } }; window.__align = st; const S = ${stepMs}; const tick = () => { if (!st.on) { return; } for (const span of document.querySelectorAll('.volt-agent-fresh-text:not([data-al])')) { const a = span.getAnimations()[0]; if (!a || a.startTime === null) { continue; } const d = parseFloat(span.style.animationDelay) || 0; a.startTime = a.startTime - (((a.startTime + d) % S) + S) % S; span.setAttribute('data-al', '1'); st.n++; } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`;
await freshProfile(arm);
writeSettings(arm);
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(8000);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
for (let n = 1; n <= 5; n++) { await newChat(c); await sleep(1500); await send(c, `replay:stream-${n}`); await sleep(2000); }
await sleep(8000);
const traced = [];
// Main frames are counted from the trace (BeginMainThreadFrame), not by a rAF loop: a loop of our own would ask for a
// main frame on every vsync and so hide what the variant changes (round 9).
let mainFrames = new Map();
c.on('Tracing.dataCollected', p => { for (const e of p.value) { if (e.name === 'ProxyMain::BeginMainFrame' && e.ph === 'X') { mainFrames.set(e.pid, (mainFrames.get(e.pid) ?? 0) + 1); } else if (e.ph === 'b' || e.ph === 'e' || e.name === 'EventLatency') { traced.push(e); } } });
for (const v of variants) {
	if (v === 'census') {
		// Not a segment: the running animations at this moment (anims.mjs).
		console.log((await c.evaluate(CENSUS)).join('\n'));
		continue;
	}
	const names = v.split('+');
	await c.evaluate(`(() => { document.getElementById('volt-exp')?.remove(); const s = document.createElement('style'); s.id = 'volt-exp'; s.textContent = ${JSON.stringify(names.map(n => CSS[n] ?? '').join('\n'))}; document.head.appendChild(s); })()`);
	// exp60 (round 9, dev builds with the experiment hook only): stream frames kept on the 60 Hz text clock.
	await c.evaluate(`globalThis.__voltExp60 = ${names.includes('exp60')}`);
	await c.evaluate(names.includes('step30') ? ALIGN(1100 / 33) : names.includes('step60') ? ALIGN(1100 / 66) : 'window.__align?.stop()');
	const box = await c.center(`[...document.querySelectorAll('.volt-agent-thread-inner')].find(e => e.offsetParent)`);
	if (names.includes('noglide')) {
		await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box[0], y: box[1], deltaX: 0, deltaY: -300 });
	} else {
		// Back to the end (pinned): End of the thread via the scrollable's own wheel.
		await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box[0], y: box[1], deltaX: 0, deltaY: 100000 });
	}
	await sleep(600);
	await focusComposer(c);
	traced.length = 0;
	const done = new Promise(r => { c.off('Tracing.tracingComplete'); c.on('Tracing.tracingComplete', r); });
	await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['latencyInfo', 'input', 'benchmark', 'cc'] } });
	mainFrames = new Map();
	const t0 = Date.now();
	for (let i = 0; i < keys; i++) {
		const ch = 'abcdefghijklmnopqrstuvwxyz'[i % 26];
		const code = ch.toUpperCase().charCodeAt(0);
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
		await sleep(250 * (0.8 + Math.random() * 0.4));
	}
	const fps = Math.round(Math.max(0, ...mainFrames.values()) / ((Date.now() - t0) / 1000));
	await sleep(500);
	await c.send('Tracing.end');
	await done;
	const k = keyLatencies(traced).filter(x => x <= 2000);
	const st = keyStages(traced);
	const pick = n => st[n]?.[0] ?? 0;
	console.log(`${v.padEnd(16)} load ${String(load1()).padEnd(5)} fps ${String(fps).padStart(3)} n ${k.length} p50 ${String(median(k)).padEnd(6)} p95 ${String(pct(k, 0.95)).padEnd(6)} max ${String(Math.max(...k)).padEnd(6)} | toMain ${pick('RendererCompositorToMain')} handler ${pick('RendererMainProcessing')} toCommit ${pick('RendererMainFinishedToCommit')}/${pick('SendBeginMainFrameToCommit')} activate>submit ${pick('EndActivateToSubmitCompositorFrame')} draw>swap ${pick('StartDrawToSwapStart')} submit>present ${pick('SubmitCompositorFrameToPresentationCompositorFrame')}`);
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
}
c.close();
await stop(arm);
