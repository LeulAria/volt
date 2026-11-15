// Which composited layers are repainted, how often and how much of them, over a few seconds (CDP LayerTree's
// layerPainted events: one per layer and frame, with the repainted rect). Exploratory: prints only.
//   node paintprobe.mjs [seconds=4]
import { cdp, sleep } from './lib.mjs';
const seconds = Number(process.argv[2] ?? 4);
const c = await cdp();
let layers = [];
const paints = new Map();
c.on('LayerTree.layerTreeDidChange', p => { if (p.layers) { layers = p.layers; } });
c.on('LayerTree.layerPainted', p => {
	const e = paints.get(p.layerId) ?? { n: 0, area: 0, maxW: 0, maxH: 0 };
	e.n++; e.area += p.clip.width * p.clip.height; e.maxW = Math.max(e.maxW, p.clip.width); e.maxH = Math.max(e.maxH, p.clip.height);
	paints.set(p.layerId, e);
});
await c.send('LayerTree.enable');
await sleep(seconds * 1000);
const byId = new Map(layers.map(l => [l.layerId, l]));
const rows = [];
for (const [id, e] of paints) {
	const l = byId.get(id);
	let node = '', reasons = '';
	if (l) {
		const r = await c.send('LayerTree.compositingReasons', { layerId: id });
		reasons = (r.result?.compositingReasonIds ?? []).join(',');
		if (l.backendNodeId) {
			const d = await c.send('DOM.describeNode', { backendNodeId: l.backendNodeId });
			const n = d.result?.node;
			node = n ? `${n.localName}${n.attributes ? '.' + (n.attributes[n.attributes.indexOf('class') + 1] ?? '').split(' ').slice(0, 3).join('.') : ''}` : '';
		}
	}
	rows.push({ layer: l ? `${Math.round(l.width)}x${Math.round(l.height)}` : '?', node, reasons, paintsPerS: Math.round(e.n / seconds * 10) / 10, meanAreaK: Math.round(e.area / e.n / 1000), max: `${Math.round(e.maxW)}x${Math.round(e.maxH)}`, MpxPerS: Math.round(e.area / seconds / 1e5) / 10 });
}
console.log(`window ${await c.evaluate('innerWidth+"x"+innerHeight')} css px, ${layers.filter(l => l.drawsContent).length} layers drawing, ${seconds} s`);
for (const r of rows.sort((a, b) => b.MpxPerS - a.MpxPerS).slice(0, 14)) {
	console.log(`${r.layer.padEnd(11)} ${String(r.paintsPerS).padStart(5)}/s  mean ${String(r.meanAreaK).padStart(5)}k px  max ${r.max.padEnd(10)} ${String(r.MpxPerS).padStart(6)} Mpx/s  ${r.node.slice(0, 60)}  ${r.reasons}`);
}
c.close();
