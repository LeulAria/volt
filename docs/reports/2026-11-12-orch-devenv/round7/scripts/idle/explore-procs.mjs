// Exploration aid (no timed rows): relaunches an arm the way a5a6-batch.mjs does (shipped launchd agent server,
// composer focused, focus emulated), then lists the profile's processes by role with their age and footprint at the
// given offsets, so it shows what is still alive when ADEMark's 90 s settle ends.
//   node explore-procs.mjs <arm> [offsets s=30,60,95,150] [--keep]   (--keep leaves the instance running)
import { execFileSync } from 'child_process';
import { cdp, focusComposer, launch, profileProcesses, role, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';

const [arm = 'minr6', offsetsArg = '30,60,95,150'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const offsets = offsetsArg.split(',').map(Number);
writeSettings(arm);
launch(arm);
const t0 = Date.now();
await waitWorkbench();
await sleep(5000);
const c = await cdp();
console.log(`composer focused: ${await focusComposer(c)}`);
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
for (const at of offsets) {
	await sleep(Math.max(0, at * 1000 - (Date.now() - t0)));
	const procs = profileProcesses(arm);
	const ps = procs.length ? execFileSync('ps', ['-o', 'pid=,etime=,rss=', '-p', procs.map(p => p.pid).join(',')], { encoding: 'utf8' }) : '';
	const info = new Map(ps.trim().split('\n').map(l => l.trim().split(/\s+/)).map(([pid, etime, rss]) => [Number(pid), { etime, mib: Math.round(Number(rss) / 1024) }]));
	console.log(`== +${at} s: ${procs.length} processes`);
	for (const p of procs) {
		const i = info.get(p.pid) ?? {};
		console.log(`  ${String(p.pid).padEnd(6)} ${role(p.cmd).padEnd(18)} age ${String(i.etime).padEnd(9)} rss ${i.mib} MiB  ${p.cmd.slice(0, 90)}`);
	}
}
c.close();
if (!process.argv.includes('--keep')) {
	await stop(arm);
}
