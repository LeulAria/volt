// Exploratory: what keeps the window drawing after a turn. One `replay:seed` turn in the current chat, then for
// `duration` s: every CSS animation/transition that starts (name, duration, iterations, element), and every 5 s the
// renderer's LayoutCount / RecalcStyleCount deltas (CDP Performance.getMetrics) next to the GPU footprint.
//   node animprobe.mjs [duration s=80]
import { execSync } from 'child_process';
import { UD, cdp, focusComposer, paste, sleep } from './lib.mjs';

const duration = Number(process.argv[2] ?? 80);
const gpuPid = Number(execSync('ps -axo pid=,command=').toString().split('\n').find(l => l.includes(UD) && /--type=gpu-process/.test(l))?.trim().split(/\s+/)[0]);
const footprint = () => Number(/Footprint:\s*(\d+)/.exec(execSync(`footprint -p ${gpuPid} 2>/dev/null | head -5`).toString())?.[1]);
const c = await cdp();
await c.send('Animation.enable');
await c.send('Performance.enable');
await c.send('DOM.enable');
const started = [];
c.on('Animation.animationStarted', async ({ animation }) => {
	const a = animation;
	let el = '?';
	try {
		const node = await c.send('DOM.describeNode', { backendNodeId: a.source?.backendNodeId });
		const n = node.result?.node;
		el = n ? `${n.localName}${n.attributes ? '.' + (n.attributes[n.attributes.indexOf('class') + 1] ?? '').split(' ').slice(0, 3).join('.') : ''}` : '?';
	} catch { }
	started.push({ t: Date.now(), name: a.name || a.cssId || a.type, type: a.type, duration: a.source?.duration, iterations: a.source?.iterations, delay: a.source?.delay, el });
});
const metrics = async () => Object.fromEntries((await c.send('Performance.getMetrics')).result.metrics.filter(m => /LayoutCount|RecalcStyleCount|ScriptDuration|Nodes$/.test(m.name)).map(m => [m.name, m.value]));
const marker = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => (m.textContent.match(/unchanged/g) || []).length)[0] || 0`;
const before = await c.evaluate(marker);
await focusComposer(c);
await paste(c, 'replay:seed');
await sleep(500);
await c.key('Enter', 'Enter', 13, 0, '\r');
for (let t = 0; t < 150 && await c.evaluate(marker) <= before; t++) { await sleep(200); }
const turnEnd = Date.now();
let last = await metrics();
let shown = 0;
while (Date.now() - turnEnd < duration * 1000) {
	await sleep(5000);
	const now = await metrics();
	const t = Math.round((Date.now() - turnEnd) / 1000);
	console.log(`t=${String(t).padStart(3)}s layouts +${now.LayoutCount - last.LayoutCount} restyles +${now.RecalcStyleCount - last.RecalcStyleCount} script +${Math.round((now.ScriptDuration - last.ScriptDuration) * 1000)} ms  gpu ${footprint()} MiB`);
	for (const a of started.slice(shown)) {
		console.log(`      anim @${Math.round((a.t - turnEnd) / 1000)}s ${a.type} ${a.name} ${a.duration}ms x${a.iterations} delay ${a.delay} on ${a.el}`);
	}
	shown = started.length;
	last = now;
}
c.close();
