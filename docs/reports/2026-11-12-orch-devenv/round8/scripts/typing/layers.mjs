// Analysis aid: the compositor's layers of the test window (size, draws content, scroll rects, compositing reasons, paint count).
//   node layers.mjs [minArea=20000]
import { cdp, sleep } from './lib.mjs';
const minArea = Number(process.argv[2] ?? 20000);
const c = await cdp();
let layers = [];
c.on('LayerTree.layerTreeDidChange', p => { if (p.layers) { layers = p.layers; } });
await c.send('DOM.enable');
await c.send('LayerTree.enable');
await sleep(1500);
const first = new Map(layers.map(l => [l.layerId, l.paintCount]));
await sleep(2000);
console.log(`${layers.length} layers, ${layers.filter(l => l.drawsContent).length} draw content; total area ${(layers.filter(l => l.drawsContent).reduce((a, l) => a + l.width * l.height, 0) / 1e6).toFixed(1)} Mpx (CSS)`);
for (const l of layers.filter(l => l.drawsContent && l.width * l.height >= minArea).sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 40)) {
	const r = await c.send('LayerTree.compositingReasons', { layerId: l.layerId });
	let node = '';
	if (l.backendNodeId) {
		const d = await c.send('DOM.describeNode', { backendNodeId: l.backendNodeId });
		const n = d.result?.node; const a = n?.attributes ?? []; const cls = a[a.indexOf('class') + 1];
		node = n ? `${n.localName}.${String(a.includes('class') ? cls : '').split(' ').slice(0, 3).join('.')}` : '';
	}
	console.log(`${String(l.width).padStart(5)}x${String(l.height).padEnd(6)} paints/2s ${String(l.paintCount - (first.get(l.layerId) ?? l.paintCount)).padStart(4)} ${l.scrollRects ? 'scroll:' + l.scrollRects.map(s => s.type).join(',') : ''} ${node} | ${(r.result?.compositingReasonIds ?? r.result?.compositingReasons ?? []).join(',')}`);
}
c.close();
