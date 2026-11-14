// Exploratory: one `replay:seed` turn in the current chat, then for `duration` s every `step` s: the renderer's and
// the GPU process's CPU (% of a core over the step, from ps cputime) and RSS, to see how long the window keeps
// drawing after a turn and when the GPU's memory goes.
//   node afterturn.mjs [duration s=120] [step s=5]
import { execSync } from 'child_process';
import { UD, cdp, focusComposer, paste, sleep } from './lib.mjs';

const duration = Number(process.argv[2] ?? 120);
const step = Number(process.argv[3] ?? 5);
const pids = () => {
	const rows = execSync('ps -axo pid=,command=').toString().split('\n').filter(l => l.includes('ud-after') || l.includes(UD));
	const pick = re => Number(rows.find(l => re.test(l))?.trim().split(/\s+/)[0]);
	return { renderer: pick(/--type=renderer/), gpu: pick(/--type=gpu-process/) };
};
const stat = pid => {
	const [cpu, rss] = execSync(`ps -o cputime=,rss= -p ${pid}`).toString().trim().split(/\s+/);
	const [h, m, s] = cpu.split(':').map(Number);
	return { cpuS: h * 3600 + m * 60 + s, rssMiB: Math.round(Number(rss) / 1024) };
};
const footprint = pid => Number(/Footprint:\s*(\d+)/.exec(execSync(`footprint -p ${pid} 2>/dev/null | head -5`).toString())?.[1]);
const p = pids();
const marker = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => (m.textContent.match(/unchanged/g) || []).length)[0] || 0`;
const c = await cdp();
const before = await c.evaluate(marker);
await focusComposer(c);
await paste(c, 'replay:seed');
await sleep(500);
await c.key('Enter', 'Enter', 13, 0, '\r');
const t0 = Date.now();
for (let t = 0; t < 150 && await c.evaluate(marker) <= before; t++) { await sleep(200); }
const turnEnd = Date.now();
console.log(`turn took ${turnEnd - t0} ms; t=0 is its end`);
let last = { r: stat(p.renderer), g: stat(p.gpu), at: Date.now() };
while (Date.now() - turnEnd < duration * 1000) {
	await sleep(step * 1000);
	const now = { r: stat(p.renderer), g: stat(p.gpu), at: Date.now() };
	const wall = (now.at - last.at) / 1000;
	const pct = (a, b) => Math.round((b.cpuS - a.cpuS) / wall * 1000) / 10;
	console.log(`t=${String(Math.round((now.at - turnEnd) / 1000)).padStart(3)}s renderer cpu ${pct(last.r, now.r)}% rss ${now.r.rssMiB}  gpu cpu ${pct(last.g, now.g)}% footprint ${footprint(p.gpu)} MiB`);
	last = now;
}
c.close();
