// Where a process's memory sits, from a memory-infra dump (memdump.mjs's JSON or a fresh one): the top-level
// allocators of the renderer and GPU processes (partition_alloc, blink_gc, v8, malloc, cc, skia, gpu, ...), and
// their largest children one level down. MiB of effective size (size when none).
//   node allocators.mjs [dump.json] [depth=2]
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
let file = process.argv[2];
const depth = Number(process.argv[3] ?? 2);
if (!file || file === "") {
	file = join(tmpdir(), `allocators-${Date.now()}.json`);
	execFileSync('node', [join(here, 'memdump.mjs'), file], { stdio: 'ignore' });
}
const d = JSON.parse(readFileSync(file, 'utf8'));
// memdump.mjs keys its per-process summary as "<name> <pid>".
const names = new Map(Object.keys(d.procs ?? {}).map(k => { const m = /^(.*) (\d+)$/.exec(k); return [Number(m?.[2]), m?.[1]]; }));
const labels = new Map();
const size = v => parseInt(v?.attrs?.effective_size?.value ?? v?.attrs?.size?.value ?? '0', 16) / 1048576;
const byPid = new Map();
for (const e of d.raw) {
	const a = e.args?.dumps?.allocators;
	if (a) {
		byPid.set(e.pid, { ...(byPid.get(e.pid) ?? {}), ...a });
	}
}
for (const [pid, a] of byPid) {
	const name = `${names.get(pid) ?? '?'} ${labels.get(pid) ?? ''}`.trim();
	if (!/Renderer|GPU/i.test(name) || /extension|plugin/i.test(name)) {
		continue;
	}
	const rows = Object.entries(a).filter(([k]) => k.split('/').length <= depth).map(([k, v]) => [k, size(v)]).filter(([, s]) => s >= 2).sort((x, y) => x[0].localeCompare(y[0]));
	const total = rows.filter(([k]) => !k.includes('/')).reduce((s, [, v]) => s + v, 0);
	console.log(`pid ${pid} ${name}: top-level allocators ${Math.round(total)} MiB`);
	for (const [k, s] of rows) {
		console.log(`  ${k.includes('/') ? '  ' : ''}${s.toFixed(1).padStart(7)}  ${k}`);
	}
}
