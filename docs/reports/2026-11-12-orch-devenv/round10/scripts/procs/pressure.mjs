// Exploratory: what a memory-pressure signal gives back in a running test instance. Footprint by role, then
// CDP Memory.simulatePressureNotification(level) on the workbench page, then footprint after 3 s and 20 s.
//   node pressure.mjs [critical|moderate] [purgeJs]
import { execSync } from 'child_process';
import { cdp, profileProcesses, sleep } from './lib.mjs';
import { role } from './roles.mjs';
const [level = 'critical', purge] = process.argv.slice(2);
function snap(label) {
	const by = {};
	for (const p of profileProcesses()) {
		let fp = 0;
		try { const m = /Footprint: ([\d.]+) ([KMG])B/.exec(execSync(`footprint ${p.pid} 2>/dev/null`).toString()); fp = m ? Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]] : 0; } catch { }
		const r = role(p.cmd);
		by[r] = (by[r] ?? 0) + fp;
	}
	const total = Object.values(by).reduce((a, b) => a + b, 0);
	console.log(`${label.padEnd(10)} total ${total.toFixed(0)}  ` + Object.entries(by).filter(([, v]) => v >= 5).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.split(' ')[0]} ${v.toFixed(0)}`).join('  '));
}
snap('before');
const c = await cdp();
if (purge) { console.log(JSON.stringify(await c.send('Memory.forciblyPurgeJavaScriptMemory').catch(e => String(e)))); }
console.log(JSON.stringify(await c.send('Memory.simulatePressureNotification', { level }).catch(e => String(e))));
c.close();
await sleep(3000); snap('+3s');
await sleep(17000); snap('+20s');
