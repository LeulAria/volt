// The renderer's V8 heap as it is (no forced GC), sampled at 4 Hz for N s: used and committed (total) MiB, median /
// p95 / max, and the lowest used value (about what is alive). Exploratory.   node heapwatch.mjs [seconds=60]
import { cdp, sleep } from './lib.mjs';
const secs = Number(process.argv[2] ?? 60);
const c = await cdp();
const used = [], total = [];
const end = Date.now() + secs * 1000;
while (Date.now() < end) {
	const u = (await c.send('Runtime.getHeapUsage')).result;
	used.push(u.usedSize / 1048576); total.push(u.totalSize / 1048576);
	await sleep(250);
}
c.close();
const q = (a, p) => Math.round([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))]);
console.log(`heap n=${used.length} used min ${q(used, 0)} med ${q(used, 0.5)} p95 ${q(used, 0.95)} max ${q(used, 1)} | committed med ${q(total, 0.5)} p95 ${q(total, 0.95)} max ${q(total, 1)} MiB`);
process.exit(0);
