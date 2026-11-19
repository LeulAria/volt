// Composited layers of the test window (CDP LayerTree): the big ones with their compositing reasons.
//   node layers.mjs [minArea px^2=100000]
import { cdp, sleep } from './lib.mjs';
const minArea = Number(process.argv[2] ?? 100000);
const c = await cdp();
let layers;
c.on('LayerTree.layerTreeDidChange', p => { if (p.layers) { layers = p.layers; } });
await c.send('LayerTree.enable');
// A window at rest commits no frame, and the layer tree arrives only with a commit: change a pixel for one frame.
for (let i = 0; i < 40 && !layers; i++) {
	if (i % 10 === 0) {
		await c.send('Runtime.evaluate', { expression: `document.body.style.opacity = '0.999'; requestAnimationFrame(() => requestAnimationFrame(() => document.body.style.opacity = ''))` });
	}
	await sleep(100);
}
const out = [];
let total = 0;
for (const l of layers ?? []) {
	if (!l.drawsContent) { continue; }
	const area = l.width * l.height;
	total += area;
	if (area < minArea) { continue; }
	const r = await c.send('LayerTree.compositingReasons', { layerId: l.layerId });
	let node = '';
	if (l.backendNodeId) {
		const d = await c.send('DOM.describeNode', { backendNodeId: l.backendNodeId });
		const n = d.result?.node;
		node = n ? `${n.localName}${n.attributes ? '.' + (n.attributes[n.attributes.indexOf('class') + 1] ?? '').split(' ').slice(0, 3).join('.') : ''}` : '';
	}
	out.push({ w: Math.round(l.width), h: Math.round(l.height), node, reasons: (r.result?.compositingReasonIds ?? r.result?.compositingReasons ?? []).join(',') });
}
console.log(`layers drawing: ${(layers ?? []).filter(l => l.drawsContent).length}, total CSS px area ${Math.round(total / 1e6 * 10) / 10} M (window ${await c.evaluate('innerWidth+"x"+innerHeight')})`);
for (const o of out.sort((a, b) => b.w * b.h - a.w * a.h)) { console.log(`${String(o.w).padStart(5)}x${String(o.h).padEnd(5)} ${o.node.slice(0, 70).padEnd(70)} ${o.reasons}`); }
c.close();
