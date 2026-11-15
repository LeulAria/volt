// Exploratory: the test instance's processes by role every `step` s for `duration` s (count, RSS MiB sum, pids of
// adapters/CLIs), to see what lives after seeding and when it goes.
//   node watch.mjs [duration s=90] [step s=5]
import { profileProcesses, sleep } from './lib.mjs';
import { role } from './roles.mjs';

const duration = Number(process.argv[2] ?? 90);
const step = Number(process.argv[3] ?? 5);
const t0 = Date.now();
while (Date.now() - t0 <= duration * 1000) {
	const byRole = new Map();
	for (const p of profileProcesses()) {
		const r = role(p.cmd);
		const e = byRole.get(r) ?? { n: 0, mib: 0, pids: [] };
		e.n++; e.mib += p.rssKiB / 1024; e.pids.push(p.pid);
		byRole.set(r, e);
	}
	const t = Math.round((Date.now() - t0) / 1000);
	const parts = [...byRole.entries()].sort((a, b) => b[1].mib - a[1].mib).map(([r, e]) => `${r.replace(/ \(.*/, '')}=${e.n}/${Math.round(e.mib)}`);
	console.log(`t=${String(t).padStart(3)}s ${parts.join('  ')}`);
	await sleep(step * 1000);
}
