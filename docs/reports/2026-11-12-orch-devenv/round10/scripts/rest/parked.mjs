// Exploratory: what the renderer keeps for chats that are not in front. Counts elements in the window's document
// and in live DocumentFragments (parked threads, agentEditor's stashThread), with their text length, plus the JS
// heap. Prints only.   node parked.mjs
import { cdp } from './lib.mjs';
const c = await cdp();
await c.send('HeapProfiler.collectGarbage');
const proto = await c.send('Runtime.evaluate', { expression: 'DocumentFragment.prototype' });
const q = await c.send('Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId });
const r = await c.send('Runtime.callFunctionOn', { objectId: q.result.objects.objectId, returnByValue: true, functionDeclaration: `function () { return this.filter(f => !f.isConnected && f.nodeType === 11 && !(f instanceof ShadowRoot)).map(f => ({ elements: f.querySelectorAll('*').length, text: f.textContent.length, turns: f.querySelectorAll('.volt-agent-turn').length })).filter(f => f.elements > 50); }` });
const frags = r.result.result.value ?? [];
const doc = await c.evaluate(`({ elements: document.querySelectorAll('*').length, threadElements: [...document.querySelectorAll('.volt-agent-thread-inner')].reduce((n, e) => n + e.querySelectorAll('*').length, 0), heapMiB: Math.round(performance.memory.usedJSHeapSize / 1048576) })`);
console.log(JSON.stringify({ document: doc, parked: frags, parkedElements: frags.reduce((n, f) => n + f.elements, 0) }));
c.close();
