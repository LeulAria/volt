// Exploratory: how much the renderer rasters while replies stream. Records cc's trace for a few seconds and sums
// raster tasks (count, CSS-px area of the tiles' content rects) per layer, plus frames drawn. Prints only.
//   node rastertrace.mjs [seconds=2]
import { cdp, sleep } from './lib.mjs';
const seconds = Number(process.argv[2] ?? 2);
const c = await cdp();
const events = [];
c.on('Tracing.dataCollected', p => events.push(...p.value));
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['cc', 'disabled-by-default-cc.debug', 'viz', 'gpu'] } });
await sleep(seconds * 1000);
await c.send('Tracing.end');
await done;
const names = new Map();
let rasterTasks = 0, rasterArea = 0;
const byLayer = new Map();
for (const e of events) {
	names.set(e.name, (names.get(e.name) ?? 0) + 1);
	if (e.name === 'RasterTask' && e.ph === 'X' || (e.name === 'RasterTask' && e.ph === 'B')) {
		rasterTasks++;
		const t = e.args?.tileData ?? e.args?.tile_data;
		const r = t?.contentRect ?? t?.content_rect;
		const layer = t?.layerId ?? t?.layer_id ?? '?';
		const area = r ? (r.width ?? r[2]) * (r.height ?? r[3]) : 0;
		rasterArea += area;
		const l = byLayer.get(layer) ?? { n: 0, area: 0 };
		l.n++; l.area += area; byLayer.set(layer, l);
	}
}
console.log(`${seconds} s: ${rasterTasks} raster tasks, ${Math.round(rasterArea / 1e6 * 10) / 10} M device px`);
for (const [l, v] of [...byLayer].sort((a, b) => b[1].area - a[1].area).slice(0, 8)) { console.log(`  layer ${l}: ${v.n} tasks ${Math.round(v.area / 1e5) / 10} M px`); }
for (const [n, k] of [...names].sort((a, b) => b[1] - a[1]).slice(0, 25)) { console.log(String(k).padStart(7), n); }
for (const [n, k] of [...names].filter(([n]) => /raster|tile|paint/i.test(n)).sort((a, b) => b[1] - a[1]).slice(0, 15)) { console.log('  raster-ish', String(k).padStart(6), n); }
const sample = events.find(e => /RasterTask|PlaybackToMemory|RasterSource/.test(e.name) && e.args && Object.keys(e.args).length);
if (sample) { console.log(JSON.stringify(sample).slice(0, 600)); }
c.close();
