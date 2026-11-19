// Analysis aid (not a result): who asks for animation frames while 5 chats stream. One launch of an arm, then for 4 s
// every requestAnimationFrame call is counted by its caller's stack (top frames), with whether it was made inside a
// frame callback (a chain: a frame at every refresh) or from a timer/event; plus the running animations (anims.mjs).
//   node rafwho.mjs <arm>
import { arm as armOf, cdp, launch, load1, newChat, send, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';
import { freshProfile } from './a8.mjs';
import { CENSUS } from './anims.mjs';
const arm = armOf(process.argv[2] ?? 'after');
await freshProfile(arm);
writeSettings(arm);
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(8000);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
for (let n = 1; n <= 5; n++) { await newChat(c); await sleep(1500); await send(c, `replay:stream-${n}`); await sleep(2000); }
await sleep(8000);
console.log('load', load1());
console.log((await c.evaluate(CENSUS)).join('\n'));
const r = await c.evaluate(`new Promise(resolve => {
	const orig = window.requestAnimationFrame.bind(window);
	const counts = new Map(); let inFrame = false, total = 0, chained = 0, frames = 0;
	window.requestAnimationFrame = cb => {
		total++; if (inFrame) { chained++; }
		const stack = new Error().stack.split('\\n').slice(2, 9).map(l => l.trim().replace(/^at /, '').replace(/\\(?vscode-file:\\/\\/vscode-app.*\\/out\\//, '(').replace(/\\?.*?(:\\d+:\\d+)/, '$1')).join(' < ');
		const k = (inFrame ? '[in frame] ' : '[outside]  ') + stack;
		counts.set(k, (counts.get(k) ?? 0) + 1);
		return orig(t => { inFrame = true; frames++; try { cb(t); } finally { inFrame = false; } });
	};
	setTimeout(() => { window.requestAnimationFrame = orig; resolve({ total, chained, frames, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12) }); }, 4000);
})`);
console.log(`rAF calls in 4 s: ${r.total} (${r.chained} from inside a frame), callbacks run ${r.frames}`);
for (const [k, n] of r.top) { console.log(String(n).padStart(5), k.slice(0, 700)); }
c.close();
await stop(arm);
