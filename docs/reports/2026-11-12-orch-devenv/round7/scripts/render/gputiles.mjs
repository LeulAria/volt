// What the GPU process holds for the window, from a memory-infra dump (memdump.mjs's JSON or a fresh one): raster
// tiles by renderer (count, MiB, dimensions), render pass backings/overlays, display buffers.
//   node gputiles.mjs [dump.json]     (no file: takes a fresh dump of the test instance now)
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
let file = process.argv[2];
if (!file) {
	file = join(tmpdir(), `gputiles-${Date.now()}.json`);
	execFileSync('node', [join(here, 'memdump.mjs'), file], { stdio: 'ignore' });
}
const d = JSON.parse(readFileSync(file, 'utf8'));
const gpu = d.raw.filter(e => e.args?.dumps?.allocators && Object.keys(e.args.dumps.allocators).some(k => k.startsWith('gpu/shared_images')));
const mib = v => Math.round(parseInt(v.attrs?.effective_size?.value ?? v.attrs?.size?.value ?? '0', 16) / 1048576 * 10) / 10;
for (const e of gpu) {
	const groups = new Map();
	for (const [k, v] of Object.entries(e.args.dumps.allocators)) {
		if (!/^gpu\/shared_images\/client_[^/]+\/mailbox_[^/]+$/.test(k)) { continue; }
		const label = (v.attrs?.['debug label']?.value ?? '?').replace(/_Pid:\d+/, '');
		const dims = v.attrs?.dimensions?.value ?? '?';
		const key = `${label} ${dims}`;
		const g = groups.get(key) ?? { n: 0, mib: 0 };
		g.n++; g.mib += mib(v);
		groups.set(key, g);
	}
	const rows = [...groups.entries()].sort((a, b) => b[1].mib - a[1].mib);
	const total = rows.reduce((s, [, g]) => s + g.mib, 0);
	console.log(`GPU pid ${e.pid}: shared images ${Math.round(total)} MiB`);
	for (const [k, g] of rows.slice(0, 20)) { console.log(`  ${String(Math.round(g.mib)).padStart(5)} MiB  n=${String(g.n).padStart(3)}  ${k}`); }
	const tiles = rows.filter(([k]) => k.startsWith('GpuRasterTile')).reduce((s, [, g]) => ({ n: s.n + g.n, mib: s.mib + g.mib }), { n: 0, mib: 0 });
	console.log(`  raster tiles: ${tiles.n} (${Math.round(tiles.mib)} MiB)`);
}
