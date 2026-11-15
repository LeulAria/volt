// DOM nodes the test window's renderer holds (CDP Memory.getDOMCounters, after a GC) against the nodes attached
// to its document: the difference is detached DOM (parked chat threads, caches, leaks).
//   node domcount.mjs
import { cdp } from './lib.mjs';

const c = await cdp();
await c.send('HeapProfiler.enable');
await c.send('HeapProfiler.collectGarbage');
const counters = (await c.send('Memory.getDOMCounters')).result;
const attached = await c.evaluate(`(() => { let n = 0; const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); while (w.nextNode()) { n++; } return { nodes: n + 1, elements: document.getElementsByTagName('*').length, heapMiB: Math.round(performance.memory.usedJSHeapSize / 1048576) }; })()`);
console.log(JSON.stringify({ ...counters, attached, detachedNodes: counters.nodes - attached.nodes }));
c.close();
