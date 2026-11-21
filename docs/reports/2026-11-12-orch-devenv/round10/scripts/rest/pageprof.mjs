// Exploratory: what the window's renderer runs at rest. A CPU profile of the workbench page over CDP for `secs` s
// (100 us sampling), summed by function with idle apart, plus the DOM mutations, animation frames and timer fires
// counted in the page. Focus is emulated as rest.mjs does. No rows; analysis aid for A6.
//   node pageprof.mjs [secs=60]
import { cdp, sleep } from './lib.mjs';
const secs = Number(process.argv[2] ?? 60);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await c.evaluate(`(() => { const s = window.__rest = { mutations: 0, frames: 0, targets: {} }; s.mo = new MutationObserver(l => { s.mutations += l.length; for (const m of l) { const e = m.target.nodeType === 1 ? m.target : m.target.parentElement; const k = (e?.closest?.('[class]')?.className?.toString?.() ?? '?').split(' ').slice(0, 2).join('.'); s.targets[k] = (s.targets[k] ?? 0) + 1; } }); s.mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); return true; })()`);
await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 100 }); await c.send('Profiler.start');
await sleep(secs * 1000);
const { result: { profile } } = await c.send('Profiler.stop');
const page = await c.evaluate(`(() => { const s = window.__rest; s.mo.disconnect(); return JSON.stringify({ mutations: s.mutations, targets: Object.entries(s.targets).sort((a, b) => b[1] - a[1]).slice(0, 12), animations: document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName ?? a.transitionProperty ?? '?') + ' on ' + (a.effect?.target?.className ?? '')).slice(0, 12) }); })()`);
await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
c.close();
const byId = new Map(profile.nodes.map(n => [n.id, n])); const self = new Map();
profile.samples.forEach((s, i) => { const n = byId.get(s); const k = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.replace(/^.*\/(out|app)\//, '')}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
const total = (profile.endTime - profile.startTime) / 1000;
const rows = [...self].sort((a, b) => b[1] - a[1]);
const busy = rows.filter(([k]) => !/^\(idle\)/.test(k)).reduce((s, [, v]) => s + v, 0) / 1000;
console.log(`renderer main: profile ${total.toFixed(0)} ms, not idle ${busy.toFixed(1)} ms = ${(busy / total * 100).toFixed(3)} % of a core`);
for (const [k, v] of rows.slice(0, 30)) { console.log(`  ${(v / 1000).toFixed(2).padStart(9)} ms  ${k.slice(0, 160)}`); }
console.log('page', page);
